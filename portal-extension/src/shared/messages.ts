/**
 * SW↔popup and SW↔ISOLATED-content-script message-tag types.
 *
 * These describe the shapes of `chrome.runtime.sendMessage` and
 * `chrome.tabs.sendMessage` payloads — distinct from the WS wire-protocol
 * frames in `./wireProtocol.ts` (which describe the SW↔binary channel).
 *
 * Convention: `<source>:<verb>` for popup→SW intents; bare verbs for
 * SW→content and content→SW pushes (matching the existing dual-world
 * `dwn-mcp-req` / `dwn-mcp-resp` CustomEvent envelope precedent).
 */

// -- popup → SW intents ------------------------------------------------------

/** User clicked Connect in the popup; tabId is the popup-resolved active tab. */
export type PopupConnectMsg = { type: 'popup:connect'; tabId: number };

/** User clicked Disconnect in the popup. */
export type PopupDisconnectMsg = { type: 'popup:disconnect' };

/** User clicked Clear in the popup History tab — wipes the in-memory mirror + storage. */
export type PopupClearHistoryMsg = { type: 'popup:clearHistory' };

// -- tool-call observability (SW → popup + ISOLATED content script) ---------

/**
 * One observed MCP tool call. Stored in chrome.storage.session.toolCallHistory
 * (capped FIFO at 50, see src/background/tool-call-history.ts), broadcast on
 * every mutation so the popup history panel and the in-page toast renderer
 * can react live.
 *
 * Session-only by design — `chrome.storage.session` survives SW restart but
 * not browser restart, which matches the "for debugging the current session"
 * intent.
 */
export type ToolCallStatus = 'pending' | 'success' | 'error';

export type ToolCallEntry = {
  /** Matches the WS req.id so start/end can be correlated. */
  id: string;
  /** For runCommand ops, the inner page-command name; for infra ops, the op verb. */
  name: string;
  /** True for runCommand calls (the user-visible tool surface); false for infra ops. */
  isCommand: boolean;
  /** JSON.stringify(args) clamped to ~240 chars; ellipsis appended if truncated. */
  argsPreview?: string;
  /** epoch ms */
  startedAt: number;
  /** epoch ms; undefined while pending. */
  endedAt?: number;
  /** ms; undefined while pending. */
  durationMs?: number;
  status: ToolCallStatus;
  /** Set when status === 'error'. */
  error?: string;
  /** JSON.stringify(result) clamped to ~240 chars; only set when status === 'success'. */
  resultPreview?: string;
};

export type ToolCallStartMsg = { type: 'tool-call:start'; entry: ToolCallEntry };

export type ToolCallEndMsg = {
  type: 'tool-call:end';
  id: string;
  endedAt: number;
  durationMs: number;
  status: ToolCallStatus;
  error?: string;
  resultPreview?: string;
};

// -- SW → ISOLATED content script (forwarding inbound binary `req` frames) --

/** SW asks the ISOLATED-world content script to call `bridgeRequest(op, args)` and reply. */
export type SwBridgeReqMsg = {
  type: 'sw-bridge-req';
  op: string;
  args: unknown;
  /** Optional per-call timeout; defaults to 30s on the receiver side. */
  timeoutMs?: number;
};

// -- ISOLATED content script → SW (page-id push) -----------------------------

/** SPA route change observed in MAIN-world; ISOLATED forwards via runtime.sendMessage. */
export type PageIdChangedMsg = { type: 'pageIdChanged'; pageId: string };

// -- chrome.storage.session error tags --------------------------------------

/**
 * The set of error kinds the SW writes to chrome.storage.session.lastError so
 * the popup can render the appropriate UI state.
 *
 * When the WS close fires with code 1006 (abnormal — typically ECONNREFUSED)
 * WITHOUT a preceding open event, the SW writes one of two error kinds
 * depending on the token shape:
 *
 *   - `tok.<hex>` (production reconnect)     → BINARY_NOT_RUNNING
 *     The user previously paired and the long-running `serve` process is
 *     expected to be alive. Recovery: launch Claude Desktop or `npx ... serve`.
 *
 *   - `pair.<6-digit>` (OOB pairing attempt) → PAIRING_WINDOW_UNAVAILABLE
 *     The 60-second pairing window is opened by `install` / `rotate-token`,
 *     not by `serve`. Telling the user to start `serve` here would be wrong;
 *     they need to re-open the pairing window with `install` or `rotate-token`.
 *
 * Both are distinct from TOKEN_MISMATCH (server rejected hex token) and
 * PAIRING_FAILED (server rejected pair code) — those imply the server IS
 * listening and rejected the handshake; the `_NOT_RUNNING` / `_UNAVAILABLE`
 * pair imply nothing was listening at all.
 */
export type LastErrorKind =
  | 'TOKEN_MISMATCH'
  | 'NO_TAB'
  | 'LOST_MID_CALL'
  | 'PAIRING_FAILED'
  | 'BINARY_NOT_RUNNING'
  | 'PAIRING_WINDOW_UNAVAILABLE';

// -- chrome.storage.session connection-state enum -----------------------------

/**
 * Live WS connection lifecycle, distinct from `connectedTabId` (user intent).
 * The SW writes this on every WS lifecycle event; the popup reads it via
 * storage.onChanged and renders the corresponding pill state.
 *
 * - 'pre-pair'  : no token in storage; user hasn't pasted one yet (popup pre-pair UI)
 * - 'connecting': WS is mid-handshake (binary alive, hello frame in flight); popup shows `Connecting...`
 * - 'open'      : WS is OPEN and authenticated; popup shows `Connected: <url>`
 * - 'closed'    : WS is closed (binary dead, user disconnected, or transient drop); popup shows `Disconnected — paired`
 *
 * Epoch tagging: every socket captures an in-memory epoch counter at creation;
 * close handlers only write 'closed' if their captured epoch still matches the
 * current epoch. Stale-socket close handlers are no-ops.
 */
export type ConnectionState = 'pre-pair' | 'connecting' | 'open' | 'closed';

// -- connection-state push (SW → ISOLATED content script → page) -------------

/**
 * Live connection-state push to the connected tab. Sent on every
 * `setConnectionState` write AND on every 30s 'wake' alarm tick, so the page
 * gets both edge (state changed) and level (heartbeat) signals.
 *
 * `at` is the SW's `Date.now()` at push time. The page treats the bridge as up
 * only while `state === 'open'` AND `at` is recent, so a torn-down extension
 * (no more heartbeats) decays back to disconnected instead of latching on
 * forever — see `mcpServerConnection.ts` in aphex-frontend.
 */
export type McpConnectionStateMsg = {
  type: 'mcp-connection-state';
  state: ConnectionState;
  /** epoch ms of this push; doubles as the heartbeat freshness stamp. */
  at: number;
};

/**
 * Page (re)loaded and wants the current state without waiting up to 30s for the
 * next heartbeat. Sent by the ISOLATED content script on injection; the SW
 * replies by re-broadcasting to the connected tab (so a tab that isn't the
 * connected one learns nothing, which is the correct answer for it).
 */
export type PageRequestConnectionStateMsg = { type: 'page:requestConnectionState' };
