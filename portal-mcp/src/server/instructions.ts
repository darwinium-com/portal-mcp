/**
 * `initialize.instructions` resolver — 5-second blocking window on the active tab's
 * `getDarwiniumInstructions` page command.
 *
 * Behavior matrix:
 *   - WS not ready in `timeoutMs` → return the pairing instructions (steps + token).
 *   - WS ready + page call OK → return `result.instructions ?? ''`.
 *   - WS ready + page call THROWS → return a structured-error prefix string
 *     (the bracket-tag prefix + explicit "Do not act as if this is portal
 *     guidance" makes the error visible to the LLM without confusing it for actual
 *     portal instructions).
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
import { buildPairingInstructions, buildPeerInstanceInstructions } from './pairingMessage.js';

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
  'Signal names, feature names and label lists may be out of date — once the extension',
  'is connected, call get_context to refresh them before relying on them.',
].join('\n');

/**
 * Static instructions plus the snapshot caveat. Wrapped so a defect in the vendored
 * data can never take down `initialize` — degrading to the old error string is bad,
 * but failing the handshake outright would leave the client with no server at all.
 */
function staticInstructionsBlock(reason: string): string {
  try {
    return getStaticInstructions() + STATIC_FALLBACK_NOTE;
  } catch (err) {
    return (
      `[portal-mcp ERROR initialize] Could not fetch Darwinium instructions: ${reason}, ` +
      `and the bundled fallback failed to load: ${(err as Error).message}. ` +
      `Call get_context to retrieve them on demand. Do not act as if this is portal guidance.`
    );
  }
}

export async function resolveInitializeInstructions(
  bridge: Bridge,
  token: string,
  opts: { timeoutMs: number },
): Promise<string> {
  // Another live instance owns the port, so no extension can ever reach THIS
  // process. Skip the blocking wait — it would burn the full timeout on every
  // launch — and say what is actually wrong instead of offering a token.
  if (!bridge.ownsPort()) return buildPeerInstanceInstructions();

  const wsReady = await bridge.waitForWs(opts.timeoutMs);
  // WS not ready = extension not paired yet. Instead of shipping an empty string
  // (which left the user with no way to discover the token), embed the pairing
  // steps + token so the LLM can hand it over when asked "what's my token?".
  // The static block follows, so the session is useful for query-writing help
  // even before the user has paired anything.
  if (!wsReady) {
    return `${buildPairingInstructions(token)}\n\n${staticInstructionsBlock('extension not connected')}`;
  }
  try {
    const result = await bridge.send<{ instructions: string }>(
      'runCommand',
      { name: 'getDarwiniumInstructions', args: {} },
      3000,
    );
    // An empty/absent payload is a reachable-but-unhelpful page (e.g. a portal
    // older than the command). Prefer the snapshot over nothing.
    return result.instructions || staticInstructionsBlock('page returned no instructions');
  } catch (err) {
    return staticInstructionsBlock((err as Error).message);
  }
}
