/**
 * Application-level wire protocol version.
 *
 * IMPORTANT — KEEP IN SYNC: this constant MUST stay aligned with PROTOCOL_VERSION in
 * `dwn_aphex/packages/portal-mcp/src/bridge/wireProtocol.ts`.
 *
 * Used in the {type:'hello'} first-frame envelope sent by the SW WS client
 * immediately after the WS opens. Bumped only when frame shapes change.
 *
 * Lives in a separate file from `wireProtocol.ts` so SW modules that only need
 * to tag a frame can import a single constant without pulling in the entire
 * frame-type module graph.
 */
export const PROTOCOL_VERSION = '0.1.0';
