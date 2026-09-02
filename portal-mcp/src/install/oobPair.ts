/**
 * Foreground OOB pairing-WS server.
 *
 * `install` and `rotate-token` invoke this module to deliver the freshly
 * generated 64-hex token to the popup over an OOB-authenticated channel:
 *
 *   1. Generate a 6-digit code with crypto.randomInt (CSPRNG; never Math.random).
 *   2. Bind a short-lived WebSocketServer on 127.0.0.1:9224 that accepts ONLY
 *      the `pair.<6-digit>` subprotocol (parallel to production `serve`'s
 *      `tok.<hex>` lifecycle — separate WSS instance).
 *   3. Print the boxed pairing prompt on stderr.
 *   4. Wait up to 60s for a popup to upgrade with the matching code.
 *      - On match: send {type:'paired', token, version}; close 1000; resolve.
 *      - On mismatch: 4401 close + attempt counter (3-attempt lockout).
 *      - On expiry / lockout: print re-arm prompt; wait for stdin Enter to
 *        regenerate code + re-arm. Loop indefinitely until paired or SIGINT.
 *   5. SIGINT: print the Ctrl+C abort lines + exit 130.
 *
 * Security:
 *   - `handleProtocols` returns ONLY `VERSION_SUBPROTOCOL` — never echoes the
 *     offered `pair.<code>` slot.
 *   - 3-attempt lockout × 60s window × CSPRNG 6-digit space (≈3×10⁻⁶ success
 *     per window) bounds the brute-force attack surface.
 *   - Pre-pair handleProtocols rejection consumes no app-level resources
 *     (HTTP 401 at upgrade boundary). Post-upgrade attempts are bounded by
 *     the counter.
 *
 * Pair handling lives here only — production `src/ws/server.ts` rejects
 * `pair.*` shapes. The popup-side mirror lives in the portal-extension package.
 */
import { WebSocketServer, WebSocket } from 'ws';
import { randomInt } from 'node:crypto';
import { IncomingMessage } from 'node:http';
import { killProcessOnPort, isPortInUse, wait } from '../ws/killProcessOnPort.js';
import {
  PROTOCOL_VERSION,
  VERSION_SUBPROTOCOL,
  PAIRING_CODE_REGEX,
  WS_CLOSE_TOKEN_MISMATCH,
} from '../bridge/wireProtocol.js';
import * as term from './term.js';

const DEFAULT_PORT = 9224;
const DEFAULT_TTL_MS = 60_000; // 60-second pairing window
const DEFAULT_MAX_ATTEMPTS = 3; // 3-attempt lockout

// Same message as src/ws/server.ts. Duplicated here because we deliver
// the message in the foreground install flow (PORT_HELD on `serve`'s server is
// async; here it's synchronous to a customer staring at their terminal).
const PORT_HELD_MESSAGE =
  'Another MCP client is using the Darwinium bridge on port 9224. ' +
  'Close other Claude Desktop / Claude Code instances and retry, ' +
  'or run `lsof -i:9224` to find the holding process.';

/** Public API — caller picks the prompt-copy variant via `mode`. */
export interface OobPairOptions {
  /** Picks the prompt-verb copy: install ("Open ... popup") vs rotate ("click Re-pair"). */
  mode: 'install' | 'rotate';
  /** 64-hex token to deliver in the {type:'paired'} frame on successful pair. */
  expectedToken: string;
  /** Override the 9224 default — primarily for tests. */
  port?: number;
  /** Override the 60_000 default — primarily for tests. */
  ttlMs?: number;
  /** Override the 3 default — primarily for tests. */
  maxAttempts?: number;
}

/** Result returned on a successful pair (caller's promise resolves with this). */
export interface OobPairResult {
  paired: true;
}

/** 6-digit zero-padded random pairing code via CSPRNG. */
function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Print the boxed pairing prompt + waiting line. */
function printPairingPrompt(code: string, mode: 'install' | 'rotate'): void {
  if (mode === 'install') {
    term.info('pairing armed. Open the Darwinium Portal MCP extension popup');
    console.error('            and enter this 6-digit code within 60 seconds.');
  } else {
    term.info('pairing armed. Open the Darwinium Portal MCP extension popup,');
    console.error('            click "Re-pair", and enter this 6-digit code within 60 seconds.');
  }
  console.error('');
  // Box content — inner padding column 19.
  // "   Pairing code:  " is 3 + 14 + 2 = 19 chars; code follows; row right-padded.
  // "   Expires:       60s" — same column-19 left edge for vertical rhythm.
  term.box(['', `   Pairing code:  ${code}`, `   Expires:       60s`, '']);
  console.error('');
  term.info('waiting for popup... (Ctrl+C to abort)');
}

/** Print the re-arm prompt after code expiry or lockout. */
function printRearmPrompt(): void {
  // run() resolves on the first successful pair, so this prompt only fires
  // when no pair has happened in the current 60s window — a counter would
  // always print "0 successful pairings" and read like a bug to a customer.
  term.info('code expired.');
  term.info('press Enter to generate a new one, or Ctrl+C to abort.');
}

/** Wait for the user to press Enter (returns Promise<void>). */
function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.resume();
    // `once` instead of `on` so a duplicate invocation only attaches a
    // one-shot listener — the re-entrancy guard in handleExpiry already
    // prevents the duplicate, but defense-in-depth here means a future
    // caller cannot accidentally leak a stdin 'data' listener.
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
  });
}

/** Parse the offered subprotocol list from an upgrade request header. */
function offeredProtocols(req: IncomingMessage): string[] {
  const header = req.headers['sec-websocket-protocol'];
  if (!header) return [];
  // Header may be `string` (comma-joined) or `string[]` per Node ws semantics.
  const raw = Array.isArray(header) ? header.join(',') : header;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Reclaim port 9224 from any stale holder, then bail if still bound. */
async function reclaimPort(port: number): Promise<void> {
  killProcessOnPort(port);
  for (let i = 0; i < 50; i++) {
    if (!(await isPortInUse(port))) return;
    await wait(100);
  }
  console.error(PORT_HELD_MESSAGE);
  process.exit(1);
}

/**
 * Run the foreground OOB pairing flow until a successful pair, expiry-without-
 * Enter (treated as Ctrl+C), or SIGINT.
 *
 * Resolves with `{paired: true}` on success. Process-exits 130 on SIGINT.
 * Process-exits 1 on unrecoverable port-bind failure.
 */
export async function run(opts: OobPairOptions): Promise<OobPairResult> {
  const port = opts.port ?? DEFAULT_PORT;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  await reclaimPort(port);

  // SIGINT — abort cleanly with a clear "nothing was paired" message.
  const sigintHandler = () => {
    console.error('');
    term.info('aborted by user. No token was paired.');
    term.info('re-run `npx @darwinium/portal-mcp install` to try again.');
    process.exit(130);
  };
  process.on('SIGINT', sigintHandler);

  let armedCode: string | null = null;
  let attempts = 0;

  return new Promise<OobPairResult>((resolve, reject) => {
    const wss = new WebSocketServer({
      port,
      host: '127.0.0.1',
      handleProtocols: (offered: Set<string>, _req) => {
        const protocols = [...offered];
        const hasVersion = protocols.includes(VERSION_SUBPROTOCOL);
        const hasPairShape = protocols.some((p) => PAIRING_CODE_REGEX.test(p));
        if (!hasVersion || !hasPairShape) return false; // → HTTP 401
        // Return ONLY the version subprotocol; NEVER echo the code.
        return VERSION_SUBPROTOCOL;
      },
    });

    let expiryTimer: NodeJS.Timeout | null = null;
    // Re-entrancy guard. clearTimeout cannot un-queue an already-fired
    // setTimeout callback, so the lockout-driven handleExpiry can race
    // the timer-driven handleExpiry. Without this flag, both invocations
    // would call waitForEnter(), register two stdin listeners, and leak
    // the one whose promise never resolves.
    let expiryInProgress = false;

    const armCode = (): void => {
      armedCode = generateCode();
      attempts = 0;
      printPairingPrompt(armedCode, opts.mode);
      if (expiryTimer) clearTimeout(expiryTimer);
      expiryTimer = setTimeout(() => {
        void handleExpiry();
      }, ttlMs);
    };

    const handleExpiry = async (): Promise<void> => {
      if (expiryInProgress) return;
      expiryInProgress = true;
      armedCode = null;
      printRearmPrompt();
      try {
        await waitForEnter();
      } catch (err) {
        expiryInProgress = false;
        reject(err as Error);
        return;
      }
      expiryInProgress = false;
      armCode();
    };

    wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const protocols = offeredProtocols(req);
      const offeredPair = protocols.find((p) => PAIRING_CODE_REGEX.test(p));
      if (armedCode === null) {
        ws.close(WS_CLOSE_TOKEN_MISMATCH, 'pairing not armed');
        return;
      }
      if (offeredPair !== `pair.${armedCode}`) {
        attempts += 1;
        if (attempts >= maxAttempts) {
          ws.close(WS_CLOSE_TOKEN_MISMATCH, 'too many attempts');
          term.warn(`wrong code (attempt ${attempts} of ${maxAttempts}).`);
          // Trigger expiry path immediately — re-arm gates on Enter.
          if (expiryTimer) clearTimeout(expiryTimer);
          armedCode = null;
          void handleExpiry();
          return;
        }
        ws.close(WS_CLOSE_TOKEN_MISMATCH, 'wrong code');
        term.warn(`wrong code (attempt ${attempts} of ${maxAttempts}).`);
        return;
      }
      // Match — deliver token and close cleanly.
      const frame = JSON.stringify({
        type: 'paired',
        token: opts.expectedToken,
        version: PROTOCOL_VERSION,
      });
      ws.send(frame);
      ws.close(1000, 'paired');
      if (expiryTimer) clearTimeout(expiryTimer);
      armedCode = null;
      process.removeListener('SIGINT', sigintHandler);
      // Close the server BEFORE resolving so port 9224 is released for any
      // subsequent `serve` start that the customer may run.
      wss.close(() => {
        resolve({ paired: true });
      });
    });

    wss.on('error', (err: Error) => {
      reject(err);
    });

    wss.on('listening', () => {
      armCode();
    });
  });
}
