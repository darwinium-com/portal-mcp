import { WebSocketServer } from 'ws';
import * as net from 'node:net';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { handleRelayRequest, RelayClient } from './relay.js';
import { Bridge } from '../bridge/Context.js';
import {
  VERSION_SUBPROTOCOL,
  TOKEN_SUBPROTOCOL_PREFIX,
  TOKEN_SUBPROTOCOL_REGEX,
  HELLO_TIMEOUT_MS,
} from '../bridge/wireProtocol.js';

export const WS_PORT = 9224;
export const WS_HOST = '127.0.0.1';

/** How long the peer probe waits for a WS upgrade before calling the holder foreign. */
const PEER_PROBE_TIMEOUT_MS = 1500;

/** Interval between health checks and owner elections. */
const TAKEOVER_POLL_MS = 1000;
type BridgeService = { close: () => void };

/**
 * Does the process holding WS_PORT speak the extension WebSocket protocol?
 *
 * Used only by doctor for compatibility with older bridge versions. This tests
 * the protocol shape, not token equality; it must never authorize a takeover.
 *
 * Speaks the upgrade by hand over a raw TCP socket rather than using the `ws`
 * client. Under `bun build --compile` the `ws` package's CLIENT is replaced by
 * Bun's native WebSocket, which cannot connect to our own server (immediate
 * 1006) — so a `ws`-based probe reports "not a peer" for every peer in the
 * shipped binary, while passing under plain node and JIT bun. `node:net` plus a
 * literal handshake behaves identically across all three. The `ws`
 * WebSocketServer used below is unaffected; only outbound clients are.
 *
 * Deliberately does NOT send the `hello` frame: hello is what makes the peer
 * call bridge.attach(), which would displace the browser extension's socket and
 * break the very session we are trying not to disturb. A 101 is the signal; the
 * peer drops the silent socket a second later, which is harmless.
 */
export function probeBridgeHandshake(token: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host: WS_HOST, port: WS_PORT });
    const done = (isPeer: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(isPeer);
    };
    const timer = setTimeout(() => done(false), PEER_PROBE_TIMEOUT_MS);

    socket.on('connect', () => {
      socket.write(
        'GET / HTTP/1.1\r\n' +
          `Host: ${WS_HOST}:${WS_PORT}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          // Any 16-byte base64 value is a valid key; we never read the frame
          // stream, so the accept hash does not need verifying.
          `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n` +
          'Sec-WebSocket-Version: 13\r\n' +
          `Sec-WebSocket-Protocol: ${VERSION_SUBPROTOCOL}, ${TOKEN_SUBPROTOCOL_PREFIX}${token}\r\n` +
          '\r\n',
      );
    });

    let head = '';
    socket.on('data', (chunk: Buffer) => {
      head += chunk.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) {
        // Bound the buffer: a chatty non-HTTP squatter must not grow it forever.
        if (head.length > 8192) done(false);
        return;
      }
      const status = head.slice(0, end).toLowerCase();
      // 101 + our subprotocol echoed back == a portal-mcp that accepted our
      // token shape. Anything else (401, a bare TCP listener, HTTP 404) is not
      // a peer we must protect.
      done(status.startsWith('http/1.1 101') && status.includes(VERSION_SUBPROTOCOL.toLowerCase()));
    });

    socket.on('error', () => done(false));
    socket.on('close', () => done(false));
  });
}

/**
 * The OS bind is the election: one process owns the extension listener; all
 * others relay through it. No lock files, background daemon, or PID killing.
 * A failed health check triggers another election, including after owner exit.
 */
export async function createWsServer(bridge: Bridge, expectedToken: string, port = WS_PORT): Promise<BridgeService> {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let owner: BridgeService | undefined;
  let relay: RelayClient | undefined;
  let lastProblem: string | undefined;
  bridge.setOwnsPort(false);

  const close = () => {
    stopped = true;
    clearTimeout(timer);
    relay?.close();
    owner?.close();
  };

  const schedule = () => {
    // Keep a subordinate alive until its MCP host closes stdin.
    if (!stopped)
      timer = setTimeout(() => {
        void check();
      }, TAKEOVER_POLL_MS);
  };

  const check = async () => {
    if (stopped) return;
    try {
      if (!relay) {
        owner = await bindWsServer(bridge, expectedToken, port);
        if (stopped) {
          close();
          return;
        }
        if (owner) {
          bridge.setOwnsPort(true);
          console.error(`portal-mcp: master listening on ws://${WS_HOST}:${port}`);
          return;
        }
        relay = new RelayClient(port, expectedToken);
      }
      await relay.refresh();
      if (stopped) {
        close();
        return;
      }
      const wasUnavailable = bridge.connectionProblem() !== undefined;
      bridge.setRelay(relay);
      if (wasUnavailable) console.error(`portal-mcp: subordinate sharing the bridge on ${WS_HOST}:${port}`);
      lastProblem = undefined;
    } catch (err) {
      relay?.close();
      relay = undefined;
      const reason =
        (err as Error).message === 'LOST_MID_CALL'
          ? 'The local browser bridge is unavailable or restarting. Retrying automatically; if this persists, check which application holds the bridge port.'
          : (err as Error).message;
      bridge.setRelay(undefined, reason);
      if (lastProblem !== reason) console.error(`portal-mcp: ${reason}`);
      lastProblem = reason;
    }
    schedule();
  };

  await check();
  return { close };
}

/**
 * Bind HTTP relay endpoints and the existing extension WebSocket handshake.
 * An occupied port is an election loss; it never terminates the existing owner.
 */
function bindWsServer(bridge: Bridge, expectedToken: string, port: number): Promise<BridgeService | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const server = createServer((req, res) => {
      void handleRelayRequest(bridge, expectedToken, req, res);
    });
    const wss = new WebSocketServer({
      server,
      handleProtocols: (offered: Set<string>, _req) => {
        // SUBPROTOCOL SHAPE GATE — not the auth check (handleProtocols returning
        // false produces HTTP 401, not WS close 4401). Real token equality
        // happens AFTER upgrade, in the 'connection' handler below.
        const protocols = [...offered];
        const hasVersion = protocols.includes(VERSION_SUBPROTOCOL);
        // Requires the full `^tok\.[a-f0-9]{64}$` shape, not just the prefix.
        // Production `serve` rejects `pair.*` shapes here; pair handling lives in
        // `src/install/oobPair.ts`'s short-lived parallel WebSocketServer.
        const hasTokenShape = protocols.some((p) => TOKEN_SUBPROTOCOL_REGEX.test(p));
        if (!hasVersion || !hasTokenShape) return false; // -> HTTP 401 to client
        // Server returns ONLY the version subprotocol — NEVER the token.
        return VERSION_SUBPROTOCOL;
      },
    });

    server.on('listening', () => {
      if (!settled) {
        settled = true;
        resolve({
          close: () => {
            for (const ws of wss.clients) ws.terminate();
            wss.close();
            server.close();
            server.closeAllConnections();
          },
        });
      }
    });

    wss.on('connection', (ws, _req) => {
      // POST-UPGRADE TOKEN CHECK + 1s hello deadline.
      // Use the literal `4401` close code (also exported as WS_CLOSE_TOKEN_MISMATCH from
      // bridge/wireProtocol.ts) so the wire-protocol contract is greppable from this
      // file alone.
      let helloOk = false;
      const helloTimer = setTimeout(() => {
        if (!helloOk) ws.close(4401, 'no hello frame');
      }, HELLO_TIMEOUT_MS);

      ws.once('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type !== 'hello' || msg.token !== expectedToken) {
            clearTimeout(helloTimer);
            ws.close(4401, 'invalid token');
            console.error('portal-mcp: WS rejected — hello mismatch');
            return;
          }
          helloOk = true;
          clearTimeout(helloTimer);
          console.error('portal-mcp: WS client authenticated');
          bridge.attach(ws);
        } catch {
          clearTimeout(helloTimer);
          ws.close(4401, 'malformed hello');
        }
      });

      ws.on('close', (code) => {
        clearTimeout(helloTimer);
        console.error(`portal-mcp: WS client disconnected (code=${code})`);
      });
      ws.on('error', (err) => console.error(`portal-mcp: WS error: ${err.message}`));
    });

    wss.on('error', () => {
      /* the HTTP server owns listener errors */
    });
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (!settled) {
        settled = true;
        wss.close();
        if (err.code !== 'EADDRINUSE') console.error(`portal-mcp: listener error: ${err.message}`);
        resolve(undefined);
      }
    });
    server.listen(port, WS_HOST);
  });
}
