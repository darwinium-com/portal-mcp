/**
 * Tool-call history mirror — single source of truth for the popup History tab
 * and the in-page toast renderer.
 *
 * Owned by the SW. The mirror is held in module memory; on every mutation we
 * persist to chrome.storage.session.toolCallHistory so the popup (which reads
 * from storage on open and listens via storage.onChanged for live updates) can
 * always see the latest state. The SW also broadcasts `tool-call:start` and
 * `tool-call:end` runtime messages so:
 *
 *   1. The popup reacts instantly when open (no storage round-trip needed).
 *   2. The ISOLATED-world content script in the connected portal tab can
 *      render an in-page toast.
 *
 * Lifecycle:
 *   - SW spawn → `hydrateFromStorage()` rebuilds the mirror from the (session-
 *     scoped) storage entry. Session storage survives SW respawn within a
 *     browser session, dies on browser restart — exactly the right scope for
 *     "session-only debug history".
 *   - Mutations are synchronous-then-await: read mirror, write mirror, then
 *     await persist. SW is single-threaded async, so as long as no `await`
 *     sits between the in-memory read and write, two concurrent record* calls
 *     can't interleave on the mirror itself. They CAN interleave on the
 *     persist call, which is fine — the next persist always wins with the
 *     current mirror snapshot.
 *
 * Cap: HISTORY_CAP entries, FIFO. Older entries dropped to bound storage size.
 */

import type { ToolCallEntry, ToolCallStatus } from '../shared/messages.js';
import { getConnectedTabId } from './tab-state.js';

const STORAGE_KEY = 'toolCallHistory';
const HISTORY_CAP = 50;
const PREVIEW_MAX = 240;

/** In-memory mirror. Source of truth; storage is just for popup access. */
let mirror: ToolCallEntry[] = [];
let hydrated = false;

/**
 * Truncate a JSON-serializable value to a single short line (preview shape).
 * `JSON.stringify` is forgiving (returns undefined for unsupported values),
 * which we handle by falling through to String() — the result is always a
 * string under PREVIEW_MAX chars or undefined for null/undefined input.
 */
function preview(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  let raw: string;
  try {
    raw = JSON.stringify(value);
  } catch {
    raw = String(value);
  }
  if (raw === undefined) return undefined;
  if (raw.length <= PREVIEW_MAX) return raw;
  return raw.slice(0, PREVIEW_MAX) + '…';
}

async function persist(): Promise<void> {
  try {
    await chrome.storage.session.set({ [STORAGE_KEY]: mirror });
  } catch (err) {
    // Storage write failure is non-fatal — the popup will fall back to the
    // last successful snapshot, and the next mutation will retry.
    console.warn('[portal-extension] tool-call-history persist failed:', (err as Error).message);
  }
}

/**
 * Push a runtime message to extension surfaces (popup + ISOLATED content
 * script in the connected tab). Both are best-effort — if no popup is open
 * and no tab is connected, sendMessage rejects; we swallow the rejection.
 */
async function broadcast(msg: unknown): Promise<void> {
  // chrome.runtime.sendMessage broadcasts to the popup; the SW itself is also
  // a recipient but we filter on `type` so the SW handler ignores its own
  // tool-call frames. If no listener is registered, sendMessage rejects with
  // "Could not establish connection. Receiving end does not exist." — that's
  // expected and fine when the popup is closed.
  try {
    await chrome.runtime.sendMessage(msg);
  } catch {
    // popup closed, no extension surface listening — ignore.
  }
  try {
    const tabId = await getConnectedTabId();
    if (tabId !== undefined) {
      try {
        await chrome.tabs.sendMessage(tabId, msg);
      } catch {
        // No content script ready (tab navigated, was closed, or paused) — ignore.
      }
    }
  } catch {
    // getConnectedTabId failure — ignore.
  }
}

/** Rebuild the mirror from chrome.storage.session on SW spawn. */
export async function hydrateFromStorage(): Promise<void> {
  if (hydrated) return;
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEY);
    const value = stored[STORAGE_KEY];
    if (Array.isArray(value)) {
      // Trust the shape (we wrote it ourselves); cap defensively.
      mirror = (value as ToolCallEntry[]).slice(-HISTORY_CAP);
    }
  } catch {
    // ignore — start with empty mirror
  }
  hydrated = true;
}

/**
 * Record the start of a tool call. Adds an entry with status='pending' to
 * the mirror, persists, and broadcasts a `tool-call:start` message.
 *
 * `name` is the user-visible tool name — for `op === 'runCommand'`, this is
 * the inner page-command name; for infra ops (listCommands, pageId, etc.),
 * it's the op verb itself.
 *
 * `isCommand` lets the toast renderer filter to only user-visible tool calls
 * (runCommand) and skip infra noise.
 */
export async function recordStart(params: {
  id: string;
  name: string;
  isCommand: boolean;
  args?: unknown;
}): Promise<void> {
  const entry: ToolCallEntry = {
    id: params.id,
    name: params.name,
    isCommand: params.isCommand,
    argsPreview: preview(params.args),
    startedAt: Date.now(),
    status: 'pending',
  };
  mirror.push(entry);
  if (mirror.length > HISTORY_CAP) {
    mirror.splice(0, mirror.length - HISTORY_CAP); // FIFO drop
  }
  await persist();
  await broadcast({ type: 'tool-call:start', entry });
}

/**
 * Record the completion of a tool call. Mutates the matching entry in-place
 * (so the popup history's render order doesn't churn), persists, and
 * broadcasts a `tool-call:end` message with just the delta the toast and
 * popup need to update.
 *
 * Silently no-ops if the matching id is not in the mirror — that can happen
 * if a tool call started before a SW restart and ended after, which leaves
 * the start record in storage but the in-memory mirror was hydrated without
 * the matching pending entry. Acceptable — the start is still visible.
 */
export async function recordEnd(params: {
  id: string;
  status: ToolCallStatus;
  error?: string;
  result?: unknown;
}): Promise<void> {
  const idx = mirror.findIndex((e) => e.id === params.id);
  const endedAt = Date.now();
  const entry = idx >= 0 ? mirror[idx] : undefined;
  if (entry) {
    entry.endedAt = endedAt;
    entry.durationMs = endedAt - entry.startedAt;
    entry.status = params.status;
    entry.error = params.error;
    entry.resultPreview = params.status === 'success' ? preview(params.result) : undefined;
    await persist();
  }
  await broadcast({
    type: 'tool-call:end',
    id: params.id,
    endedAt,
    durationMs: entry?.durationMs ?? 0,
    status: params.status,
    error: params.error,
    resultPreview: params.status === 'success' ? preview(params.result) : undefined,
  });
}

/**
 * Wipe the mirror and persisted history. Called when the user clicks Clear in
 * the popup History tab.
 */
export async function clearHistory(): Promise<void> {
  mirror = [];
  try {
    await chrome.storage.session.remove(STORAGE_KEY);
  } catch {
    // ignore
  }
}
