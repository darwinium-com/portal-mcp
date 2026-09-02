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
import { createWsServer, stopTakeoverPolling } from '../ws/server.js';
import { readToken } from '../token/store.js';
import { VERSION } from '../version.js';

export async function runServer(): Promise<void> {
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
  const expectedToken = readToken();

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

  // Resolve WS port ownership BEFORE connecting stdio. `initialize` branches on
  // bridge.ownsPort(), so if the host's initialize lands first it reads the
  // default (true) and hands out a pairing token even though another instance
  // owns the bridge — advice that cannot work. Ownership resolution is bounded
  // (a ~1.5s peer probe, or a ~5s reclaim poll) and MCP hosts tolerate far
  // longer startup windows, so ordering it first costs nothing.
  //
  // createWsServer never exits and never rejects on a port conflict — it
  // degrades to a bridge-less MCP server and polls to take over. The catch is
  // belt-and-braces: an unexpected throw must not stop stdio coming up, or the
  // host sees a dead server with no explanation.
  try {
    await createWsServer(bridge, expectedToken);
  } catch (err) {
    bridge.setOwnsPort(false);
    console.error(`portal-mcp: WS bridge unavailable: ${(err as Error).message}`);
  }

  // Bridge is attached on a successful post-upgrade hello-frame check.
  await server.connect(new StdioServerTransport());

  // Exit when the MCP host disconnects. Without this the process outlives its
  // host and keeps holding 127.0.0.1:9224 — and because only one instance can
  // own the bridge, that orphan starves every subsequent launch: the live
  // server sees a healthy peer, degrades, and never recovers. Tying the
  // lifecycle to stdio means a relaunched host reclaims the bridge within one
  // takeover poll, with no need to kill anything.
  //
  // stdin EOF is handled explicitly because StdioServerTransport only listens
  // for 'data' and 'error' — it never closes on end-of-input, so `onclose`
  // alone would not fire when the host simply closes the pipe.
  const shutdown = () => {
    stopTakeoverPolling();
    process.exit(0);
  };
  server.onclose = shutdown;
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
}
