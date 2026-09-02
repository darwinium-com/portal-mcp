/**
 * Wire-protocol schemas for the binary↔extension WebSocket bridge.
 *
 * IMPORTANT — KEEP IN SYNC: this file MUST stay aligned with
 * `dwn_aphex/packages/portal-extension/src/shared/wireProtocol.ts`.
 * The binary bundle (Node, tsdown) and extension bundle (browser, WXT/Vite)
 * cannot share a workspace dep, so the schemas are duplicated. Do NOT change
 * one without updating the other; the smoke test checks the constants for drift.
 */
import { z } from 'zod';

// -- Wire literals ----------------------------------------------------------

/** Application-level wire protocol version. Bumped when frame shapes change. */
export const PROTOCOL_VERSION = '0.1.0';

/** WS subprotocol token returned in the response Sec-WebSocket-Protocol header. */
export const VERSION_SUBPROTOCOL = 'darwinium.v1';

/** Prefix for the per-connection token entry in the offered Sec-WebSocket-Protocol list. */
export const TOKEN_SUBPROTOCOL_PREFIX = 'tok.';

/**
 * Token subprotocol regex: exactly 64 lowercase hex characters after the
 * `tok.` prefix.
 *
 * Used by `src/ws/server.ts` `handleProtocols` to reject ill-shaped offers at
 * the upgrade boundary (HTTP 401 — distinct from post-upgrade WS 4401).
 */
export const TOKEN_SUBPROTOCOL_REGEX = /^tok\.[a-f0-9]{64}$/;

/**
 * Out-of-band pairing wire format. The installer's foreground pairing-WS
 * server in `src/install/oobPair.ts` accepts a parallel subprotocol shape
 * `pair.<6-digit>` (separate lifecycle from production `serve`). The pairing
 * server returns ONLY `VERSION_SUBPROTOCOL` — never echoes the code.
 *
 * KEEP IN SYNC: this constant ALSO lives in
 * `dwn_aphex/packages/portal-extension/src/shared/wireProtocol.ts`; the smoke
 * test enforces byte-equality.
 */
export const PAIR_SUBPROTOCOL_PREFIX = 'pair.';

/** Pairing-code subprotocol regex: `pair.<6-digit>`. */
export const PAIRING_CODE_REGEX = /^pair\.[0-9]{6}$/;

/** Maximum window for the post-upgrade `{type:'hello'}` first frame to arrive. */
export const HELLO_TIMEOUT_MS = 1000;

/** WS close code for token-handshake failure. */
export const WS_CLOSE_TOKEN_MISMATCH = 4401;

// -- Frame schemas ----------------------------------------------------------

export const HelloFrameSchema = z.object({
  type: z.literal('hello'),
  token: z.string().regex(/^[0-9a-f]{64}$/),
  version: z.string(),
});
export type HelloFrame = z.infer<typeof HelloFrameSchema>;

export const ReqFrameSchema = z.object({
  id: z.string(),
  type: z.literal('req'),
  op: z.string(),
  args: z.unknown(),
});
export type ReqFrame = z.infer<typeof ReqFrameSchema>;

export const RespFrameSchema = z.object({
  id: z.string(),
  type: z.literal('resp'),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
export type RespFrame = z.infer<typeof RespFrameSchema>;

export const PageIdChangedFrameSchema = z.object({
  type: z.literal('pageIdChanged'),
  pageId: z.string().nullable(),
});
export type PageIdChangedFrame = z.infer<typeof PageIdChangedFrameSchema>;

export const PingFrameSchema = z.object({ type: z.literal('ping') });
export type PingFrame = z.infer<typeof PingFrameSchema>;

export const PongFrameSchema = z.object({ type: z.literal('pong') });
export type PongFrame = z.infer<typeof PongFrameSchema>;

/**
 * Frame the OOB pairing-WS server sends to the popup once a `pair.<6-digit>`
 * upgrade matches the armed code. Delivers the 64-hex token across the
 * authenticated pairing channel.
 */
export const PairedFrameSchema = z.object({
  type: z.literal('paired'),
  token: z.string().regex(/^[0-9a-f]{64}$/),
  version: z.string(),
});
export type PairedFrame = z.infer<typeof PairedFrameSchema>;
