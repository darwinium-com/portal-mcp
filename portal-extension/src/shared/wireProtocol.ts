/**
 * Wire-protocol types + locked literals for the binary↔extension WebSocket bridge.
 *
 * IMPORTANT — KEEP IN SYNC: this file MUST stay aligned with
 * `dwn_aphex/packages/portal-mcp/src/bridge/wireProtocol.ts`. The binary bundle
 * (Node, tsdown) and extension bundle (browser, WXT/Vite) cannot share a
 * workspace dep without bundler-graph complexity, so the schemas are duplicated.
 * Do NOT change one without updating the other.
 *
 * NOTE: extension side uses TS types only (no zod runtime validation). The binary
 * validates inbound frames with zod. Adding zod here would cost ~20KB in the SW
 * bundle for marginal benefit — the SW reads structured frames the binary already
 * validated, and writes frames the binary validates on receive.
 */

// -- Locked literals ---------------------------------------------------------

/**
 * Application-level wire protocol version. Bumped when frame shapes change.
 *
 * Mirrored from `dwn_aphex/packages/portal-mcp/src/bridge/wireProtocol.ts`.
 * `src/shared/version.ts` carries the same value so SW modules that only need
 * to tag a frame can keep their narrow import path.
 */
export const PROTOCOL_VERSION = '0.1.0';

/** WS subprotocol token returned in the response Sec-WebSocket-Protocol header. */
export const VERSION_SUBPROTOCOL = 'darwinium.v1';

/** Prefix for the per-connection token entry in the offered Sec-WebSocket-Protocol list. */
export const TOKEN_SUBPROTOCOL_PREFIX = 'tok.';

/** Maximum window for the post-upgrade `{type:'hello'}` first frame to arrive. */
export const HELLO_TIMEOUT_MS = 1000;

/** WS close code for token-handshake failure. */
export const WS_CLOSE_TOKEN_MISMATCH = 4401;

// -- OOB pairing wire format --------------------------------------------------

/**
 * Prefix for the OOB pairing-code entry in the offered Sec-WebSocket-Protocol
 * list. The popup pastes a 6-digit code; the SW opens with subprotocols
 * `[VERSION_SUBPROTOCOL, "pair.<6-digit>"]`. The binary's foreground pairing
 * server matches against its currently-armed code, replies with
 * `{type:"paired", token, version}` over the socket, and closes 1000.
 *
 * KEEP IN SYNC: byte-equal RHS with
 * `dwn_aphex/packages/portal-mcp/src/bridge/wireProtocol.ts`.
 */
export const PAIR_SUBPROTOCOL_PREFIX = 'pair.';

/**
 * Validation regex for the full `pair.<6-digit>` subprotocol entry.
 *
 * KEEP IN SYNC: byte-equal RHS with
 * `dwn_aphex/packages/portal-mcp/src/bridge/wireProtocol.ts`.
 */
export const PAIRING_CODE_REGEX = /^pair\.[0-9]{6}$/;

/**
 * Validation regex for the full `tok.<64-hex>` subprotocol entry — lowercase
 * hex only, exact 64 chars.
 *
 * KEEP IN SYNC: byte-equal RHS with
 * `dwn_aphex/packages/portal-mcp/src/bridge/wireProtocol.ts`.
 */
export const TOKEN_SUBPROTOCOL_REGEX = /^tok\.[a-f0-9]{64}$/;

// -- Frame types (extension-side; pure TypeScript, no runtime validation) ----

/** First frame the SW sends after WS open. Belt-and-braces for proxies that strip Sec-WebSocket-Protocol. */
export type HelloFrame = { type: 'hello'; token: string; version: string };

/** Inbound from binary: a tool call to forward to the connected tab. */
export type ReqFrame = { type: 'req'; id: string; op: string; args: unknown };

/** Outbound to binary: reply to a `req`. Either `result` or `error` is set. */
export type RespFrame = { type: 'resp'; id: string; result?: unknown; error?: string };

/** Outbound to binary: SPA route change pushed from the MAIN content script. */
export type PageIdChangedFrame = { type: 'pageIdChanged'; pageId: string | null };

/** Outbound to binary: 20s keepalive (Chrome 116+ idle-timer reset). */
export type PingFrame = { type: 'ping' };

/** Inbound from binary: echo of `ping`. SW currently treats as no-op. */
export type PongFrame = { type: 'pong' };

/** All frames the SW WS client can RECEIVE from the binary. */
export type InboundFrame = ReqFrame | PongFrame;

/** All frames the SW WS client can SEND to the binary. */
export type OutboundFrame = HelloFrame | RespFrame | PingFrame | PageIdChangedFrame;
