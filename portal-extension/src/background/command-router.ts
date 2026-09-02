/**
 * Inbound WS frame router for the SW.
 *
 * The binary sends `req` frames over the WS; this module routes them to the
 * connected tab's ISOLATED-world content script via chrome.tabs.sendMessage,
 * awaits the page-side reply, and returns a `resp` frame to the binary via
 * the supplied `sendBack` callback.
 */

import { getConnectedTabId } from './tab-state.js';
import { recordStart, recordEnd } from './tool-call-history.js';
import type { ReqFrame, RespFrame, OutboundFrame } from '../shared/wireProtocol.js';

/** Default per-call timeout for the page-side bridge round-trip. */
const DEFAULT_PAGE_TIMEOUT_MS = 30_000;

/**
 * In-flight tool-call count — drives the extension icon badge so the user has
 * cross-tab visual feedback that the LLM is actively invoking page commands.
 * Reset by the SW (`background.ts`) on each fresh spawn.
 */
let inFlight = 0;

const BADGE_COLOR_ACTIVE = '#2563eb'; // blue-600 — informational, not alarming

/**
 * chrome.alarms-based badge clearing. setTimeout is fragile under MV3 SW
 * termination: a SW that dies between request-end and the clear-tick leaves a
 * stuck badge until the next call drains the in-flight counter (or
 * `resetToolCallBadge()` runs at next SW spawn). chrome.alarms wakes a parked
 * SW, so the clear runs deterministically; the tradeoff is that the badge
 * sticks for ~1 minute (the chrome.alarms minimum delay) instead of ~0.6s.
 *
 * The actual `chrome.action.setBadgeText({text:''})` call lives in
 * `entrypoints/background.ts` `chrome.alarms.onAlarm` listener (alarm name
 * 'badge-clear'). This module only schedules the alarm.
 */
const BADGE_CLEAR_ALARM = 'badge-clear';

function applyBadge(text: string, opLabel?: string): void {
  void chrome.action.setBadgeText({ text });
  if (text) void chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR_ACTIVE });
  void chrome.action.setTitle({
    title: opLabel ? `Darwinium Portal MCP — ${opLabel}` : 'Darwinium Portal MCP',
  });
}

function refreshBadge(currentOp?: string): void {
  if (inFlight > 0) {
    // Cancel any pending clear alarm — fresh activity extends the visible window.
    void chrome.alarms.clear(BADGE_CLEAR_ALARM);
    applyBadge(String(inFlight), currentOp);
    return;
  }
  inFlight = 0;
  // chrome.alarms.create wakes a parked SW; setTimeout would die with the SW
  // and leave the badge stuck. delayInMinutes:1 is the chrome.alarms minimum
  // (Chrome 120+); the ~1-min badge-stick is the accepted tradeoff for
  // SW-termination resilience.
  chrome.alarms.create(BADGE_CLEAR_ALARM, { delayInMinutes: 1 });
}

/**
 * Apply a 'badge-clear' alarm tick. Wired from `entrypoints/background.ts`
 * `chrome.alarms.onAlarm` listener — runs only if the in-flight counter is
 * still drained (a fresh tool call between alarm-create and alarm-fire would
 * have called `chrome.alarms.clear(BADGE_CLEAR_ALARM)` in `refreshBadge`).
 */
export function clearBadgeFromAlarm(): void {
  if (inFlight <= 0) applyBadge('');
}

/**
 * Route one inbound frame from the binary.
 *
 * - `pong` → no-op (echo of our keepalive ping; SW currently doesn't track latency).
 * - `req`  → forward to the connected tab; reply with `resp`.
 * - any other shape → silently dropped (binary is the validating side).
 *
 * @param raw       — the parsed JSON frame (caller has already JSON.parsed and
 *                    null-checked the WS message).
 * @param sendBack  — function to send a response frame back to the binary.
 *                    Decoupled from ws-client.ts to keep this module pure.
 */
export async function routeFrame(raw: unknown, sendBack: (out: OutboundFrame) => void): Promise<void> {
  if (!raw || typeof raw !== 'object') return;
  const msg = raw as { type?: string };
  if (msg.type === 'pong') return;
  if (msg.type !== 'req') return;

  const req = raw as ReqFrame;
  const tabId = await getConnectedTabId();
  if (tabId === undefined) {
    sendBack({ type: 'resp', id: req.id, error: 'NO_TAB' } satisfies RespFrame);
    return;
  }

  // Display op name for tool calls; for the inner runCommand opcode include
  // the page-command name so the badge tooltip is informative.
  const opLabel =
    req.op === 'runCommand' && typeof req.args === 'object' && req.args && 'name' in req.args
      ? `runCommand: ${String((req.args as { name: unknown }).name)}`
      : req.op;
  inFlight += 1;
  refreshBadge(opLabel);

  // Tool-call observability — start record. For runCommand we surface the
  // inner page-command name (the user-visible tool); for infra ops (listCommands,
  // pageId) we use the op verb itself. The `isCommand` flag lets the in-page
  // toast renderer filter to user-visible calls only and skip infra noise.
  // Inner args (the actual command arguments) are passed for the preview;
  // for non-runCommand ops, req.args is the preview as-is.
  const isCommand = req.op === 'runCommand';
  const innerArgs = isCommand ? (req.args as { args?: unknown } | undefined)?.args : req.args;
  const toolName = isCommand ? String((req.args as { name: unknown } | undefined)?.name ?? '<unknown>') : req.op;
  // Fire-and-forget: persistence + broadcast can take a few ms each but we
  // don't want to delay the actual tool invocation.
  void recordStart({ id: req.id, name: toolName, isCommand, args: innerArgs });

  try {
    // chrome.tabs.sendMessage returns Promise<reply> where `reply` is what
    // the ISOLATED-world chrome.runtime.onMessage handler passed to
    // sendResponse.
    const reply = (await chrome.tabs.sendMessage(tabId, {
      type: 'sw-bridge-req',
      op: req.op,
      args: req.args,
      timeoutMs: DEFAULT_PAGE_TIMEOUT_MS,
    })) as { result?: unknown; error?: string } | undefined;

    if (reply?.error !== undefined) {
      sendBack({ type: 'resp', id: req.id, error: String(reply.error) });
      void recordEnd({ id: req.id, status: 'error', error: String(reply.error) });
    } else {
      sendBack({ type: 'resp', id: req.id, result: reply?.result });
      void recordEnd({ id: req.id, status: 'success', result: reply?.result });
    }
  } catch (err) {
    // Distinguish two failure shapes:
    //
    //   (a) TAB_STALE: extension was reloaded; the old content script in the
    //       connected tab can no longer reach the (new) SW. Recovery:
    //       chrome.runtime.onInstalled (background.ts) re-injects the content
    //       scripts; the user can also refresh the tab manually.
    //
    //   (b) NO_TAB: content scripts not injected at all — tab navigated to a
    //       non-portal page, or was closed mid-call.
    //
    // Substring matching is intentional — Chrome's wording for these errors has
    // varied across versions and there's no error.code field to key on. Any
    // "context invalidated", "message port closed", or "Receiving end does not
    // exist" wording → TAB_STALE ("Receiving end does not exist" is the
    // dominant Chrome 120+ wording right after extension reload); everything
    // else → NO_TAB, whose "Click Connect..." copy is still actionable. See
    // TESTING.md for the reload scenarios.
    const msg = (err as Error)?.message ?? '';
    const isStale =
      /Extension context invalidated/i.test(msg) ||
      /message port closed/i.test(msg) ||
      /Receiving end does not exist/i.test(msg);
    // KEEP IN SYNC with portal-mcp/src/bridge/errorMapper.ts ErrorMode union — the
    // string 'TAB_STALE' must match the binary's mode key for mapError to route it.
    const errorMode = isStale ? 'TAB_STALE' : 'NO_TAB';
    sendBack({
      type: 'resp',
      id: req.id,
      error: errorMode,
    });
    void recordEnd({ id: req.id, status: 'error', error: errorMode });
  } finally {
    inFlight -= 1;
    refreshBadge();
  }
}

/**
 * Clear any stale badge state on SW spawn — the in-flight counter lives in
 * SW module memory so it dies with the SW, but chrome.action.* state persists
 * across SW restarts. Without this, a SW that died mid-call would leave a
 * stuck badge until the next call drained the counter past zero.
 */
export function resetToolCallBadge(): void {
  inFlight = 0;
  refreshBadge();
}
