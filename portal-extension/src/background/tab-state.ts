/**
 * Connected-tab state lives ONLY in chrome.storage.session, which survives SW
 * termination within a browser session but dies on browser restart / extension
 * disable / update / reload. That's the right lifetime for connectedTabId —
 * the user must re-Connect after a fresh browser launch.
 *
 * NEVER store connectedTabId in:
 *   - module globals (die with SW respawn — popup would lie about state)
 *   - chrome.storage.local (survives browser restart — but WS doesn't, so popup
 *     would lie the OTHER way)
 *
 * lastError is also session-scoped: it's a transient surfaced-to-popup signal
 * that should NOT survive a browser restart (a fresh launch starts clean).
 */

import type { LastErrorKind, ConnectionState, McpConnectionStateMsg } from '../shared/messages.js';

/**
 * Monotonically-increasing socket epoch. Each call to bumpSocketEpoch() returns the
 * next value; ws-client.ts captures the epoch when a socket is created and uses
 * it to detect stale-close races (a late close handler from a replaced socket
 * would otherwise overwrite the fresh socket's `setConnectionState('open')`).
 *
 * Lives in module memory — dies with the SW, which is correct: SW respawn means
 * fresh sockets and fresh epochs anyway. No persistence needed.
 */
let _socketEpoch = 0;

export function bumpSocketEpoch(): number {
  _socketEpoch += 1;
  return _socketEpoch;
}

export function getCurrentSocketEpoch(): number {
  return _socketEpoch;
}

/**
 * Returns the currently-connected tab id, or `undefined` if no tab is connected
 * (popup never clicked Connect in this browser session, or the user clicked
 * Disconnect, or the SW was reloaded mid-session).
 *
 * Reads from chrome.storage.session — survives SW respawn within a browser session.
 */
export async function getConnectedTabId(): Promise<number | undefined> {
  const stored = await chrome.storage.session.get('connectedTabId');
  const value = stored.connectedTabId;
  return typeof value === 'number' ? value : undefined;
}

/**
 * Persists the connected tab id, or clears it if `id === undefined`.
 *
 * Writes to chrome.storage.session — see file header for lifetime rationale.
 */
export async function setConnectedTabId(id: number | undefined): Promise<void> {
  if (id === undefined) await chrome.storage.session.remove('connectedTabId');
  else await chrome.storage.session.set({ connectedTabId: id });
}

/**
 * Clears the lastError + lastErrorAt pair. Called on successful WS open so the
 * popup's 60s last-error row collapses immediately on recovery.
 */
export async function clearLastError(): Promise<void> {
  await chrome.storage.session.remove(['lastError', 'lastErrorAt']);
}

/**
 * Sets lastError + lastErrorAt (epoch ms). Popup reads these via storage.onChanged
 * and renders the dismissible warning row if the timestamp is within the last 60s.
 *
 * Storage area is chrome.storage.session — see file header.
 */
export async function setLastError(kind: LastErrorKind): Promise<void> {
  await chrome.storage.session.set({ lastError: kind, lastErrorAt: Date.now() });
}

/**
 * Live WS health flag. Distinct from connectedTabId, which represents the user's
 * INTENT to be connected (set on Connect click, cleared on Disconnect click).
 * `wsOpen` reflects ACTUAL WS readyState — true while OPEN, false while
 * CONNECTING / CLOSED / unset. SW writes; popup reads.
 *
 * Without this, the popup confuses intent for health: when the binary dies
 * mid-session the WS closes but connectedTabId persists, leaving the popup
 * showing `Connected:` while every tool call would fail.
 */
export async function getWsOpen(): Promise<boolean> {
  const stored = await chrome.storage.session.get('wsOpen');
  return stored.wsOpen === true;
}

/**
 * @deprecated Use `setConnectionState` instead. Retained as a thin wrapper that
 * maps `true` -> 'open' and `false` -> 'closed'. Removed in a future cleanup.
 */
export async function setWsOpen(open: boolean): Promise<void> {
  await setConnectionState(open ? 'open' : 'closed');
}

/**
 * Live WS connection state. Replaces the boolean `wsOpen` semantically — the
 * old key is kept in storage for backward compat with any subscriber that
 * hasn't migrated, but the popup reads `connectionState` directly.
 *
 * SW writes; popup reads via chrome.storage.onChanged.
 */
export async function getConnectionState(): Promise<ConnectionState | undefined> {
  const stored = await chrome.storage.session.get('connectionState');
  const value = stored.connectionState;
  if (value === 'pre-pair' || value === 'connecting' || value === 'open' || value === 'closed') {
    return value;
  }
  return undefined;
}

export async function setConnectionState(state: ConnectionState): Promise<void> {
  await chrome.storage.session.set({ connectionState: state });
  // Maintain `wsOpen` boolean for backward compat with any code that hasn't
  // migrated yet (e.g., legacy popup builds during rollout). 'open' → true,
  // everything else → false.
  await chrome.storage.session.set({ wsOpen: state === 'open' });
  // Edge signal to the page. This is the single funnel for state changes, so
  // pushing from here means every lifecycle event reaches the portal tab.
  await pushConnectionState(state);
}

/**
 * Push the current connection state to the connected tab's ISOLATED content
 * script, which re-dispatches it into the page as a `dwn-mcp-connection-state`
 * CustomEvent. The portal's title-bar indicator and idle-logout suppression
 * read that channel.
 *
 * Only the connected tab is told — a tab the user never clicked Connect on has
 * no bridge and must not claim one.
 */
async function pushConnectionState(state: ConnectionState): Promise<void> {
  let tabId: number | undefined;
  try {
    tabId = await getConnectedTabId();
  } catch {
    return; // storage read failed — the next heartbeat retries
  }
  if (tabId === undefined) return;
  const msg: McpConnectionStateMsg = { type: 'mcp-connection-state', state, at: Date.now() };
  // Resolve the tab id before returning, but don't await the send itself: callers
  // are on the WS lifecycle path and shouldn't block on a cross-process message.
  // Capturing the id first is what keeps `disconnect()`'s 'closed' push from
  // racing the `setConnectedTabId(undefined)` that follows it.
  void chrome.tabs.sendMessage(tabId, msg).catch(() => {
    // No content script listening (tab closed, navigated away, or a non-portal
    // URL) — the next heartbeat retries.
  });
}

/**
 * Re-push the stored state without changing it. Two callers:
 *   - the 30s 'wake' alarm, making this a heartbeat the page can age out (a
 *     disabled/reloaded extension stops pushing, so the page decays back to
 *     disconnected rather than latching 'open' forever)
 *   - a freshly-injected content script asking for the current state, so a page
 *     reload doesn't sit stale until the next alarm tick
 */
export async function broadcastCurrentConnectionState(): Promise<void> {
  const state = await getConnectionState();
  if (state === undefined) return; // nothing ever written this session
  await pushConnectionState(state);
}
