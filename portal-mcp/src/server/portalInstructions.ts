/**
 * Durable guidance for this integration. Hosts retain initialize.instructions
 * across bridge recovery, so connection diagnostics belong in live tool results.
 * The shared Darwinium prompt also serves integrations with different tools.
 */
const PORTAL_TOOL_GUIDANCE = [
  'Darwinium Portal MCP usage:',
  'This server exposes exactly three MCP tools: get_page_commands, run_page_command, and get_context.',
  'Call get_page_commands first to discover the commands available on the connected portal tab.',
  'Before reporting a connection problem or recommending pairing, restarting, or stopping a process,',
  'call get_page_commands to check the current connection. Connection state can change after startup;',
  'the bridge reconnects and takes over automatically. Use the latest tool response as the source of truth.',
  'A successful tool response supersedes any earlier connection error. Do not replay interrupted edits automatically.',
  '',
  'The Darwinium reference guidance below is shared with other integrations. Its references to',
  'get_documentation, get_attribute, or other tools do not expose those tools in this server.',
  'Discover a corresponding page command with get_page_commands and invoke it only if it is listed.',
  'Use run_page_command with {"name":"<returned command name>","args":{}} and the returned argument schema.',
  'This server uses the name field, even where shared examples use commandName.',
  'If the page does not offer the capability, explain that it is unavailable; do not invent a tool or command.',
  'These tool names and schemas take precedence over examples in the shared guidance.',
].join('\n');

export function buildPortalInstructions(guidance: string): string {
  return `${PORTAL_TOOL_GUIDANCE}\n\n---\n\n${guidance}`;
}
