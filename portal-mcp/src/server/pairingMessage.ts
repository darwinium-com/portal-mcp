/**
 * Pairing-message builders — surface the per-machine pairing token to the LLM so
 * the user can connect the extension by simply *asking Claude for the token*.
 *
 * The binary (`serve`) reads/generates the token at startup, but the interactive
 * 6-digit OOB pairing flow runs ONLY during `install` / `rotate-token` — a plain
 * Claude Desktop / Claude Code launch (which runs `serve`) has no other delivery
 * path. So the token is embedded in the MCP `initialize.instructions` and in the
 * "not connected" tool responses, where the host LLM can read it out of its own
 * context and hand it to the user on request.
 *
 * Security note: the token is a LOCAL secret that only authorizes a WebSocket on
 * 127.0.0.1:9224. It already lives in the binary's process and the user's own MCP
 * session context — surfacing it to that same user's LLM does not widen the trust
 * boundary. It must NOT be sent anywhere off-machine.
 */

/**
 * Instruction block embedded in `initialize.instructions` when the extension is
 * not yet connected. Written so the LLM both (a) understands portal tools are
 * unavailable until pairing, and (b) can answer "what's my token / how do I
 * connect?" directly from context without any tool call.
 */
export function buildPairingInstructions(token: string): string {
  return [
    'The Darwinium Portal browser extension is not connected to this MCP server yet.',
    'Portal tools (get_page_commands, run_page_command, get_context) will not work until the user pairs the extension.',
    '',
    'To connect, the user should:',
    '  1. Open their Darwinium portal in Chrome (a *.darwinium.com or *.int.darwinium.io tab).',
    '  2. Click the "Darwinium Portal MCP" extension icon in the toolbar.',
    '  3. Paste the pairing token below into the popup and click "Save & Connect".',
    '',
    `Pairing token for this machine: ${token}`,
    '',
    'When the user asks how to connect, how to pair, or what their pairing token is,',
    'give them this token and these steps. The token is a local secret valid only on',
    '127.0.0.1 — it is safe to show to this user, but must never be sent anywhere else.',
  ].join('\n');
}

/**
 * Shared body for the "another instance owns the bridge" state.
 *
 * Distinct from the pairing state on purpose: the extension may be perfectly
 * paired, but THIS process lost the race for 127.0.0.1:9224. Handing over a
 * pairing token here would send the user round a loop that cannot succeed —
 * the browser is already talking to the other instance.
 */
const PEER_INSTANCE_BODY = [
  'Another copy of the Darwinium Portal bridge is already running on this machine',
  'and owns the local connection to the browser (127.0.0.1:9224). Only one copy can',
  'hold it at a time.',
  '',
  'Portal tools will not work in THIS session until that copy exits. To fix it:',
  '  - Use the portal tools from the Claude session that is already connected, OR',
  '  - Quit the other Claude client (Claude Desktop, or Claude Code in a terminal)',
  '    and this session will take over the bridge automatically within a few seconds.',
  '',
  'Do NOT tell the user to re-pair or paste a pairing token — the extension is not',
  'the problem here, and pairing again will not resolve it.',
];

/** `initialize.instructions` variant for the peer-owns-the-bridge state. */
export function buildPeerInstanceInstructions(): string {
  return [
    'The Darwinium Portal MCP server started, but could not claim the browser bridge.',
    '',
    ...PEER_INSTANCE_BODY,
  ].join('\n');
}

/** Tool-result variant for the peer-owns-the-bridge state. */
export function buildPeerInstanceMessage(): string {
  return ['The Darwinium Portal bridge is not available to this session.', '', ...PEER_INSTANCE_BODY].join('\n');
}

/**
 * Text returned in place of the NO_TAB error when a tool is called while the
 * extension is not connected. Same token + steps as the instructions block, kept
 * short for an inline tool result.
 */
export function buildPairingMessage(token: string): string {
  return [
    'The Darwinium Portal browser extension is not connected yet.',
    '',
    'To connect: open your Darwinium portal tab (*.darwinium.com or *.int.darwinium.io), click the',
    '"Darwinium Portal MCP" extension icon, paste this pairing token, and click',
    '"Save & Connect":',
    '',
    `    ${token}`,
    '',
    'Then retry your request. (This token is a local pairing secret for 127.0.0.1 —',
    'safe to share with the user, but not off-machine.)',
  ].join('\n');
}
