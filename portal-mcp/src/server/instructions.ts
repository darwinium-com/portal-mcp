/**
 * `initialize.instructions` resolver — 5-second blocking window on the active tab's
 * `getDarwiniumInstructions` page command.
 *
 * Behavior matrix:
 *   - Bridge unavailable → static reference guidance; tool calls report live errors.
 *   - WS not ready in `timeoutMs` → conditional pairing guidance (steps + token).
 *   - WS ready + page call OK → live guidance, or static guidance if empty.
 *   - WS ready + page call THROWS → static guidance.
 * Every path includes durable usage guidance for this bridge. Startup instructions
 * must not assert a current connection failure: hosts retain them after recovery.
 *
 * The 5-second host-blocking wait is intentional — MCP hosts tolerate long
 * initialize windows (Claude Desktop empirically tolerates 30+s).
 *
 * STATIC FALLBACK. When the tab cannot be reached, the static instruction block is
 * served instead of an error string. Without it, a freshly-installed but not-yet-paired
 * client has no Darwinium knowledge at all — it does not know the query syntax, the
 * feature schema or the label list — which is the first thing a new user hits. The
 * vendored copy is pure string constants with no filesystem or network access at
 * runtime (see scripts/vendor-instructions.mjs), so the cold-start concern that
 * originally kept it out no longer applies: nothing is read, only a string is built.
 *
 * The live `getDarwiniumInstructions` page command stays authoritative whenever the
 * tab IS reachable — it reflects the actual deployed portal version, which the
 * vendored snapshot cannot.
 */
import type { Bridge } from '../bridge/Context.js';
import { getStaticInstructions } from '../vendor/darwinium-instructions/promptBlocks.js';
import { buildPairingInstructions } from './pairingMessage.js';
import { buildPortalInstructions } from './portalInstructions.js';

/**
 * Marks the static block as a snapshot rather than live portal state, so the model
 * does not report stale signal or label names as authoritative.
 */
const STATIC_FALLBACK_NOTE = [
  '',
  '---',
  '',
  'NOTE: the Darwinium guidance above is a static snapshot bundled with this server,',
  'not live state read from the portal. Query syntax and general guidance are reliable.',
  'Signal names, feature names and label lists may be out of date. Call get_context',
  'to read current portal guidance before relying on them.',
].join('\n');

/**
 * Static instructions plus the snapshot caveat. Wrapped so a defect in the vendored
 * data can never take down `initialize` — degrading to the old error string is bad,
 * but failing the handshake outright would leave the client with no server at all.
 */
function staticInstructionsBlock(): string {
  try {
    return getStaticInstructions() + STATIC_FALLBACK_NOTE;
  } catch (err) {
    console.error(`portal-mcp: bundled guidance unavailable: ${(err as Error).message}`);
    return 'Darwinium reference guidance was unavailable at startup. Call get_context to retrieve current guidance.';
  }
}

export async function resolveInitializeInstructions(
  bridge: Bridge,
  token: string,
  opts: { timeoutMs: number },
): Promise<string> {
  if (bridge.connectionProblem()) return buildPortalInstructions(staticInstructionsBlock());

  const wsReady = await bridge.waitForWs(opts.timeoutMs);
  // Preserve token discovery, but make pairing advice conditional on a current
  // tool response. The extension may reconnect after this snapshot is captured.
  if (!wsReady) {
    const pairing = bridge.connectionProblem() ? '' : `${buildPairingInstructions(token)}\n\n`;
    return buildPortalInstructions(pairing + staticInstructionsBlock());
  }
  try {
    const result = await bridge.send<{ instructions: string }>(
      'runCommand',
      { name: 'getDarwiniumInstructions', args: {} },
      3000,
    );
    // An empty/absent payload is a reachable-but-unhelpful page (e.g. a portal
    // older than the command). Prefer the snapshot over nothing.
    return buildPortalInstructions(result.instructions || staticInstructionsBlock());
  } catch {
    return buildPortalInstructions(staticInstructionsBlock());
  }
}
