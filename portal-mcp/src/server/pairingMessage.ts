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
 * not yet connected. Conditional wording stays valid if the extension connects
 * after initialization; the token remains available for explicit pairing help.
 */
export function buildPairingInstructions(token: string): string {
  return [
    'If a current tool response says the Darwinium Portal extension is not connected, use these pairing steps.',
    'Check get_page_commands before recommending pairing; the extension may already have reconnected.',
    '',
    'To pair when needed, the user should:',
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
