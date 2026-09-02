/**
 * Service-worker WebSocket client for the SW↔binary bridge. Handles the pairing
 * (6-digit OOB code → `pair.<code>` subprotocol) and production (64-hex token →
 * `tok.<hex>` subprotocol) handshakes, keepalive, and reconnect with capped
 * backoff. Module-global `_ws` is intentional: it dies with the SW, and every
 * cold start re-evaluates from chrome.storage (the listeners in
 * entrypoints/background.ts run connectIfNeeded() on alarm/cold-start/popup
 * intents).
 */

import {
  VERSION_SUBPROTOCOL,
  TOKEN_SUBPROTOCOL_PREFIX,
  WS_CLOSE_TOKEN_MISMATCH,
  PAIR_SUBPROTOCOL_PREFIX,
} from '../shared/wireProtocol.js';
import { PROTOCOL_VERSION } from '../shared/version.js';
import { getToken } from './token-store.js';
import {
  getConnectedTabId,
  setConnectedTabId,
  setLastError,
  clearLastError,
  setConnectionState,
  bumpSocketEpoch,
  getCurrentSocketEpoch,
} from './tab-state.js';
import { pingIfOpen } from './keepalive.js';
import { scheduleReconnect, resetBackoff } from './reconnect.js';
import { routeFrame } from './command-router.js';

const WS_URL = 'ws://127.0.0.1:9224';

let _ws: WebSocket | undefined;
/**
 * Promise lock for in-flight connect attempts. Multiple callers (cold-start,
 * wake alarm, popup intent, storage.onChanged) can race into connectIfNeeded
 * while it `await`s storage reads — without this lock they each pass the
 * `_ws` guard and create overlapping WebSockets, and the binary closing the
 * replaced socket causes visible connect-cycling.
 *
 * Pattern: first caller sets _connecting; subsequent callers await the same
 * promise and exit. Cleared in finally so a failed attempt doesn't deadlock
 * future connects.
 */
let _connecting: Promise<void> | undefined;

/**
 * Open a WS to the binary if (a) we don't already have one, (b) a token is
 * persisted, and (c) a tab is connected. Idempotent.
 *
 * @param tabId — optional. If provided, persists as the connectedTabId before
 *   opening the WS. Used by the popup:connect intent.
 */
export async function connectIfNeeded(tabId?: number): Promise<void> {
  if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  // Serialize concurrent callers — see _connecting docstring for rationale.
  if (_connecting) return _connecting;
  _connecting = doConnect(tabId).finally(() => {
    _connecting = undefined;
  });
  return _connecting;
}

async function doConnect(tabId?: number): Promise<void> {
  // Re-check guard inside the locked path: _ws state could have changed
  // between the outer check and acquiring this lock.
  if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  // Bump epoch eagerly so we have a stable id even if doConnect bails (no token / no tab).
  // Each socket captures its epoch; close handlers compare against
  // getCurrentSocketEpoch() and skip the 'closed' write if a newer socket has bumped past us.
  const myEpoch = bumpSocketEpoch();
  await setConnectionState('connecting');

  const token = await getToken();
  if (!token) {
    console.debug('portal-extension: no token in storage; skipping connect (popup paste required)');
    await setConnectionState('pre-pair');
    return; // pre-pair state
  }

  if (tabId !== undefined) await setConnectedTabId(tabId);
  if ((await getConnectedTabId()) === undefined) {
    console.debug('portal-extension: no connectedTabId; skipping connect (Connect click required)');
    await setConnectionState('closed');
    return;
  }

  // Branch on token shape: `pair.<6-digit>` for OOB pairing codes, `tok.<hex>`
  // for the persisted hex token. The binary's foreground pairing server replies
  // with `{type:"paired", token, version}` and closes 1000; the {type:'paired'}
  // handler below overwrites storage.local.token with the hex value, then
  // chrome.storage.onChanged → reconnectFromTokenChange() opens the production
  // `tok.<hex>` socket atomically.
  const isPair = /^\d{6}$/.test(token);
  const subprotocols = isPair
    ? [VERSION_SUBPROTOCOL, `${PAIR_SUBPROTOCOL_PREFIX}${token}`]
    : [VERSION_SUBPROTOCOL, `${TOKEN_SUBPROTOCOL_PREFIX}${token}`];
  const ws = new WebSocket(WS_URL, subprotocols);
  _ws = ws;

  // Track whether the open event ever fired. If close fires without a
  // preceding open, the WS never reached the server (typically ECONNREFUSED
  // because `serve` isn't running) and we surface BINARY_NOT_RUNNING. A close
  // that follows an open is either a graceful 1000, a server-side reject
  // (4401), or a mid-session drop — handled by the branches below.
  let everOpened = false;

  ws.addEventListener('open', () => {
    everOpened = true;
    if (isPair) {
      // Pair handshake — the binary validates the 6-digit code against its
      // in-memory armed-code slot, sends `{type:"paired"}`, and closes 1000.
      // Do NOT send the production `{type:"hello"}` envelope on a pair socket;
      // the binary's pair branch is one-shot and read-only.
      void setConnectionState('connecting');
      return;
    }
    // First WS frame (belt-and-braces in case a proxy strips
    // Sec-WebSocket-Protocol). Binary's ws/server.ts validates within
    // HELLO_TIMEOUT_MS (1s); past that it sends ws.close(4401, 'no hello frame').
    ws.send(JSON.stringify({ type: 'hello', token, version: PROTOCOL_VERSION }));
    void clearLastError();
    void setConnectionState('open');
    // Immediate first keepalive ping so the SW idle timer resets without
    // waiting up to 30s for the first chrome.alarms 'wake' tick.
    pingIfOpen(ws);
    resetBackoff();
  });

  ws.addEventListener('message', (ev) => {
    if (typeof ev.data !== 'string') return;
    let msg: unknown;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return; // drop malformed
    }

    // Paired-frame handler (pair shape only). Strict shape validation: type
    // literal 'paired' AND token is a 64-char lowercase hex string AND version
    // is a string. On match, overwrite chrome.storage.local.token with the hex
    // value; chrome.storage.onChanged → reconnectFromTokenChange() reopens the
    // socket with the production `tok.<hex>` subprotocol atomically. The binary
    // closes the pair socket 1000 immediately after sending; the code-1000
    // short-circuit in the close handler keeps that close from scheduling a
    // reconnect that would race the storage.onChanged reconnect.
    if (
      isPair &&
      typeof msg === 'object' &&
      msg !== null &&
      (msg as { type?: unknown }).type === 'paired' &&
      typeof (msg as { token?: unknown }).token === 'string' &&
      /^[0-9a-f]{64}$/.test((msg as { token: string }).token) &&
      typeof (msg as { version?: unknown }).version === 'string'
    ) {
      const hexToken = (msg as { token: string }).token;
      void chrome.storage.local.set({ token: hexToken });
      void clearLastError();
      return;
    }

    void routeFrame(msg, (out) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(out));
    });
  });

  ws.addEventListener('close', (ev) => {
    if (_ws === ws) _ws = undefined;
    // Epoch guard: only write 'closed' if THIS socket is still the current one.
    // A stale close handler from a replaced socket would otherwise overwrite a
    // fresh socket's setConnectionState('open') with 'closed', causing a visible flap.
    if (myEpoch === getCurrentSocketEpoch()) {
      void setConnectionState('closed');
    }
    if (ev.code === WS_CLOSE_TOKEN_MISMATCH) {
      // Branch on the token shape that just got rejected:
      //   pair shape → PAIRING_FAILED (popup shows "code expired or mistyped")
      //   tok  shape → TOKEN_MISMATCH
      void setLastError(isPair ? 'PAIRING_FAILED' : 'TOKEN_MISMATCH');
      // Invalidate the rejected token from storage so no other reconnect path
      // (chrome.alarms keepalive, scheduleReconnect, manual popup re-trigger)
      // reuses it — alarms-driven retries would otherwise burn through the
      // binary's 3-attempt pairing lockout in a few ticks. Clearing also
      // triggers chrome.storage.onChanged → reconnectFromTokenChange(), which
      // converges on a clean pre-pair state. The user's recovery gesture
      // (paste a new code or new token) writes a fresh value back.
      void chrome.storage.local.remove('token');
    } else if (!everOpened) {
      // No preceding open event AND no 4401 means the WS never reached a
      // listening server. Browser WebSocket spec uses code 1006 (abnormal) for
      // ECONNREFUSED / DNS failure / TLS failure / dropped TCP handshake. Branch
      // the error message on token shape so the recovery action matches the user's
      // intent:
      //   pair shape → PAIRING_WINDOW_UNAVAILABLE (re-run install/rotate-token)
      //   tok  shape → BINARY_NOT_RUNNING        (start Claude Desktop / serve)
      void setLastError(isPair ? 'PAIRING_WINDOW_UNAVAILABLE' : 'BINARY_NOT_RUNNING');
    }
    // Graceful 1000 closes do NOT schedule a reconnect. The legitimate
    // reconnect path is chrome.storage.onChanged triggered by the post-pair
    // token rewrite (atomic restart). Without this short-circuit, a 1000 close
    // races the storage.onChanged reconnect and can cause spurious
    // connect-cycling in the SW.
    if (ev.code === 1000) return;
    // A 4401 with `pair.<6-digit>` shape means the OOB pairing server rejected
    // this specific code. Retrying the same code is guaranteed to fail and
    // burns another attempt against the binary's 3-attempt lockout counter —
    // three SW backoff ticks ≈ instant silent lockout. The legitimate recovery
    // path is the user pasting a fresh code into the popup, which triggers
    // chrome.storage.onChanged → reconnectFromTokenChange() with the new code.
    // The PAIRING_FAILED error row (set above) prompts that action.
    if (ev.code === WS_CLOSE_TOKEN_MISMATCH && isPair) return;
    // Schedule next attempt — chrome.alarms belt-and-braces also catches up.
    // For intentional disconnect, the popup's disconnect() path clears
    // connectedTabId so the retry will bail at the getConnectedTabId() check
    // above.
    scheduleReconnect(connectIfNeeded);
  });

  ws.addEventListener('error', () => {
    // 'close' fires after 'error' for connection errors; close handler does
    // the unified bookkeeping above.
  });
}

/**
 * User-initiated disconnect (popup:disconnect intent). Closes the WS with
 * code 1000 'user disconnect', resets backoff, and clears connectedTabId so
 * subsequent connectIfNeeded() calls bail until the user re-Connects.
 */
export async function disconnect(): Promise<void> {
  resetBackoff();
  if (_ws) _ws.close(1000, 'user disconnect');
  _ws = undefined;
  // Bump epoch so the prior socket's in-flight close handler (with the OLD epoch)
  // sees myEpoch !== currentEpoch and skips its 'closed' write — disconnect() then
  // writes 'closed' itself unconditionally so the popup transitions correctly.
  bumpSocketEpoch();
  await setConnectionState('closed');
  await setConnectedTabId(undefined);
}

/**
 * Atomic WS restart on token rotation. Called from chrome.storage.onChanged
 * when local.token changes (popup paste or post-pair rewrite).
 *
 * Closes the current WS with code 1000 'token rotated', resets backoff so the
 * new connect attempt fires immediately, and triggers connectIfNeeded() which
 * picks up the new token from storage.
 */
export async function reconnectFromTokenChange(): Promise<void> {
  if (_ws) _ws.close(1000, 'token rotated');
  _ws = undefined;
  resetBackoff();
  await connectIfNeeded();
}

/**
 * Forward a page-id push frame to the binary. Used by the
 * entrypoints/background.ts onMessage handler to translate
 * `chrome.runtime.sendMessage({type:'pageIdChanged', pageId})` from the
 * ISOLATED content script into a `{type:'pageIdChanged', pageId}` WS frame.
 *
 * If the WS is closed the push is dropped — the binary receives the next
 * pageIdChanged after reconnect via the content script's initial emit. This is
 * push-only state; no persistence needed.
 */
export function sendPageIdChanged(pageId: string): void {
  if (_ws && _ws.readyState === WebSocket.OPEN) {
    _ws.send(JSON.stringify({ type: 'pageIdChanged', pageId }));
  }
}

/**
 * chrome.alarms 'wake' tick handler — fired every 30s by the alarm registered
 * in entrypoints/background.ts. Doubles as keepalive (when WS is open) AND
 * reconnect-after-failure (when WS is closed).
 *
 * MV3 alarms are the only periodic mechanism that wakes a parked SW
 * (setInterval is paused with the SW). Each tick: if we have an open WS, send
 * a ping (resets SW idle timer per Chrome 116+); otherwise, retry connect.
 */
export async function wakeOrPing(): Promise<void> {
  if (_ws && _ws.readyState === WebSocket.OPEN) {
    pingIfOpen(_ws);
    return;
  }
  await connectIfNeeded();
}
