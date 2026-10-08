import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  InitializeRequestSchema,
  LATEST_PROTOCOL_VERSION,
  ListToolsRequestSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOLS } from './tools.js';
import { Bridge } from '../bridge/Context.js';
import { makeBridgeCallHandler } from './bridgeCallHandler.js';
import { resolveInitializeInstructions } from './instructions.js';
import { createWsServer } from '../ws/server.js';
import { readToken } from '../token/store.js';
import { VERSION } from '../version.js';

export async function runServer(options: { port?: number; token?: string } = {}): Promise<void> {
  // Instructions intentionally undefined at construction; the InitializeRequestSchema
  // override below populates `instructions` dynamically from the active-tab
  // `getDarwiniumInstructions` (5s blocking window).
  const server = new Server(
    { name: 'darwinium-portal-mcp', version: VERSION },
    { capabilities: { tools: {} } }, // declare 'tools' capability ONLY — adding 'resources' would expand surface
  );

  // CRITICAL: declare ONLY the tools capability. Do NOT call setRequestHandler for
  // ListResourcesRequestSchema, ListPromptsRequestSchema, etc. — that auto-advertises
  // those capabilities and breaks the static-three-tool-surface guarantee (ADR-001).

  // Bridge owns the single _ws ref + pending Map — connection plumbing only,
  // no page-derived state. Constructed early so it can be passed to the call
  // handler, the InitializeRequestSchema handler, and the WS server.
  const bridge = new Bridge();

  // Read (or first-launch generate) the token up front — it's the single source
  // shared by the WS handshake, the initialize.instructions pairing block, and the
  // "not connected" tool responses so the user can connect by asking Claude for it.
  const expectedToken = options.token ?? readToken();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  // Override InitializeRequestSchema for the 5s blocking window on
  // `getDarwiniumInstructions`. Mutating `server._instructions` post-construction
  // is unreliable; the request-handler override is the SDK's supported
  // dynamic-instructions path.
  server.setRequestHandler(InitializeRequestSchema, async (request) => {
    const requestedVersion = request.params.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
      ? requestedVersion
      : LATEST_PROTOCOL_VERSION;
    const instructions = await resolveInitializeInstructions(bridge, expectedToken, { timeoutMs: 5000 });
    return {
      protocolVersion,
      capabilities: { tools: {} }, // mirror what we declared at construction
      serverInfo: { name: 'darwinium-portal-mcp', version: VERSION },
      ...(instructions && { instructions }),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, makeBridgeCallHandler(bridge, expectedToken));

  // Establish either a direct bridge or an authenticated relay before initialize.
  const service = await createWsServer(bridge, expectedToken, options.port);

  // Bridge is attached on a successful post-upgrade hello-frame check.
  await server.connect(new StdioServerTransport());

  // Each process belongs to its own MCP host. If the master exits, surviving
  // subordinates elect a replacement and the extension reconnects to that owner.
  //
  // stdin EOF is handled explicitly because StdioServerTransport only listens
  // for 'data' and 'error' — it never closes on end-of-input, so `onclose`
  // alone would not fire when the host simply closes the pipe.
  const shutdown = () => {
    service.close();
    process.exit(0);
  };
  server.onclose = shutdown;
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  if (process.stdin.readableEnded || process.stdin.destroyed) shutdown();
}
