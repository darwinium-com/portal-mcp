import { WebSocketServer } from 'ws';
import * as net from 'node:net';
import { randomBytes } from 'node:crypto';
import { killProcessOnPort, isPortInUse, wait } from './killProcessOnPort.js';
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

/** Interval between takeover attempts while another instance owns the port. */
const TAKEOVER_POLL_MS = 1000;

/** Pending takeover timer, so shutdown can cancel it and let the process exit. */
let takeoverTimer: NodeJS.Timeout | undefined;

/** Cancel any pending takeover poll. Called on MCP transport close. */
export function stopTakeoverPolling(): void {
  if (takeoverTimer) {
    clearTimeout(takeoverTimer);
    takeoverTimer = undefined;
  }
}

/**
 * Is the process holding WS_PORT a live portal-mcp that would accept our token?
 *
 * Distinguishes "a peer instance is legitimately serving the bridge" from "a
 * zombie or unrelated process is squatting on the port". Only the latter may be
 * killed — see createWsServer. A false negative here is destructive: it routes a
 * healthy peer into the kill branch.
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
 * Bind the WS server on 127.0.0.1:9224, or degrade gracefully if we cannot.
 *
 * Port ownership is a race between instances, so the outcome is one of three:
 *   - port free           → bind, this process owns the bridge.
 *   - held by a live peer → do NOT kill it. Serve MCP without the bridge and
 *                           poll to take over when the peer exits.
 *   - held by a zombie /
 *     foreign process     → killProcessOnPort + poll, then bind.
 *
 * Returns null in the degraded case; the process keeps serving MCP over stdio
 * either way, and never exits on a port conflict.
 *
 * Two-phase token-gated handshake:
 *   1. `handleProtocols` SHAPE GATE — accepts only offered subprotocol arrays that
 *      include `darwinium.v1` AND a `tok.*` entry; returns ONLY `'darwinium.v1'` in
 *      the response Sec-WebSocket-Protocol header (NEVER echoes the token —
 *      subprotocol headers are logged by browsers/proxies).
 *      Mismatched shape → HTTP 401 on upgrade (distinct from post-upgrade WS 4401).
 *   2. POST-UPGRADE TOKEN CHECK — `wss.on('connection')` starts a 1s timer for the
 *      `{type:'hello', token, version}` first frame. Mismatch / no-hello / malformed
 *      JSON → `ws.close(4401, ...)` produces a real WS close event.
 *
 * The bridge takes ownership of `ws` only after a successful hello check.
 */
export async function createWsServer(bridge: Bridge, expectedToken: string): Promise<WebSocketServer | null> {
  // Only reclaim the port from a holder that is NOT a live peer. Blindly
  // kill -9-ing whatever holds 9224 makes two concurrent instances mutually
  // fatal: each kills the other on startup, so an MCP host that restarts a
  // server, or a second host on the same machine, produces a kill/respawn
  // ping-pong that surfaces to the user as "Server disconnected".
  if (await isPortInUse(WS_PORT)) {
    if (await probeBridgeHandshake(expectedToken)) {
      console.error(
        'portal-mcp: another portal-mcp instance owns ws://127.0.0.1:9224 — ' +
          'serving MCP without the browser bridge; will take over if it exits.',
      );
      bridge.setOwnsPort(false);
      scheduleTakeover(bridge, expectedToken);
      return null;
    }
    // Not a live peer: a zombie or an unrelated squatter. Reclaim it.
    killProcessOnPort(WS_PORT);
    for (let i = 0; i < 50; i++) {
      if (!(await isPortInUse(WS_PORT))) break;
      await wait(100);
    }
  }

  // `expectedToken` is read once by the caller (runServer) and shared with the
  // initialize.instructions pairing block + the "not connected" tool responses,
  // so the user can pair simply by asking Claude for the token.
  const wss = await bindWsServer(bridge, expectedToken);
  if (!wss) {
    // Lost a bind race (two instances both saw the port free). Treat exactly
    // like the peer case rather than exiting — MCP stays served either way.
    console.error(
      'portal-mcp: could not bind ws://127.0.0.1:9224 — serving MCP without the browser bridge; will retry.',
    );
    bridge.setOwnsPort(false);
    scheduleTakeover(bridge, expectedToken);
    return null;
  }
  bridge.setOwnsPort(true);
  return wss;
}

/**
 * Retry the bind every TAKEOVER_POLL_MS until it succeeds, then mark this
 * process the owner.
 *
 * Deliberately NOT unref'd. In the degraded path there is no WebSocketServer
 * holding the event loop open, so an unref'd timer lets the process fall out of
 * the loop the moment it finishes answering `initialize` — the MCP host sees
 * "Connection closed" a second after launch. Lifecycle is instead bound to the
 * MCP transport: runServer cancels this on close so the process still exits
 * promptly when the host goes away.
 */
function scheduleTakeover(bridge: Bridge, expectedToken: string): void {
  takeoverTimer = setTimeout(() => {
    void (async () => {
      if (await isPortInUse(WS_PORT)) {
        scheduleTakeover(bridge, expectedToken);
        return;
      }
      const wss = await bindWsServer(bridge, expectedToken);
      if (wss) {
        takeoverTimer = undefined;
        bridge.setOwnsPort(true);
        console.error('portal-mcp: took over ws://127.0.0.1:9224 from the previous instance.');
        return;
      }
      scheduleTakeover(bridge, expectedToken);
    })();
  }, TAKEOVER_POLL_MS);
}

/**
 * Bind the listener and wire the handshake handlers. Resolves null on a bind
 * failure (EADDRINUSE) so callers can degrade instead of crashing.
 */
function bindWsServer(bridge: Bridge, expectedToken: string): Promise<WebSocketServer | null> {
  return new Promise((resolve) => {
    let settled = false;
    const wss = new WebSocketServer({
      port: WS_PORT,
      host: WS_HOST,
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

    wss.on('listening', () => {
      // stderr only — stdout stays pure JSON-RPC.
      console.error(`portal-mcp: WS server listening on ws://${WS_HOST}:${WS_PORT}`);
      if (!settled) {
        settled = true;
        resolve(wss);
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

      ws.on('close', (code) => console.error(`portal-mcp: WS client disconnected (code=${code})`));
      ws.on('error', (err) => console.error(`portal-mcp: WS error: ${err.message}`));
    });

    wss.on('error', (err) => {
      console.error(`portal-mcp: WS server error: ${err.message}`);
      // A bind failure arrives here before 'listening'. Resolve null so the
      // caller degrades to a bridge-less MCP server instead of throwing out of
      // runServer and killing the process.
      if (!settled) {
        settled = true;
        try {
          wss.close();
        } catch {
          /* never bound */
        }
        resolve(null);
      }
    });
  });
}
