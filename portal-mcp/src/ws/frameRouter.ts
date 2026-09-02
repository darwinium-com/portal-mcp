/**
 * Server-side frame routing extension point.
 *
 * Currently a placeholder: `Bridge.onMessage` handles all inbound frame types
 * (`resp`, `pageIdChanged`, `ping`→`pong`, `pong`). Kept as a separate module
 * so future expansion (e.g. rate-limit metering or strict wireProtocol
 * zod validation) does not require touching `Bridge` or `ws/server.ts`.
 */
import type { Bridge } from '../bridge/Context.js';

export function attachServerFrameRouter(_bridge: Bridge): void {
  // intentionally empty — Bridge.onMessage handles ping/pong/resp/pageIdChanged.
}
