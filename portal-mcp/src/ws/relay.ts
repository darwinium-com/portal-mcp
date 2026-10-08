import { request, type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import type { Bridge, Relay } from '../bridge/Context.js';

// Private process-to-process protocol. The extension wire protocol stays unchanged.
const STATUS_PATH = '/bridge/v1/status';
const CALL_PATH = '/bridge/v1/call';
const PROTOCOL = 'darwinium-relay.v1';
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const CallSchema = z.object({
  op: z.enum(['listCommands', 'runCommand']),
  args: z.unknown(),
  timeoutMs: z.number().int().min(1).max(60_000),
});
const StatusSchema = z.object({ protocol: z.literal(PROTOCOL), connected: z.boolean() });
const ResultSchema = z.object({ result: z.unknown().optional(), error: z.string().optional() });

function reply(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

/** Authenticated HTTP shares the extension's loopback listener, never its socket. */
export async function handleRelayRequest(
  bridge: Bridge,
  token: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // These endpoints are for local processes, not browser pages. No CORS support.
  if (req.headers.origin || req.headers.authorization !== `Bearer ${token}`) {
    reply(res, 401, { error: 'Unauthorized' });
    return;
  }
  if (req.method === 'GET' && req.url === STATUS_PATH) {
    reply(res, 200, { protocol: PROTOCOL, connected: bridge.hasWs() });
    return;
  }
  if (req.method !== 'POST' || req.url !== CALL_PATH) {
    reply(res, 404, { error: 'Unknown relay endpoint' });
    return;
  }
  const abort = new AbortController();
  // A subordinate exiting must release its pending request in the master.
  res.on('close', () => abort.abort());
  req.setTimeout(5000, () => req.destroy());
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reply(res, 413, { error: 'Relay request too large' });
        return;
      }
      chunks.push(chunk);
    }
    req.setTimeout(0);
    const parsed = CallSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (!parsed.success) {
      reply(res, 400, { error: 'Invalid relay request' });
      return;
    }
    const { op, args, timeoutMs } = parsed.data;
    try {
      // Bridge.send assigns a fresh UUID; MCP ids from different hosts never mix.
      const result = await bridge.send(op, args, timeoutMs, abort.signal);
      reply(res, 200, { result });
    } catch (err) {
      reply(res, 200, { error: (err as Error).message });
    }
  } catch {
    reply(res, 400, { error: 'Invalid relay request' });
  }
}

/** Uses node:http because outbound WebSockets fail in the compiled Bun binary. */
export class RelayClient implements Relay {
  connected = false;
  private requests = new Set<ClientRequest>();

  constructor(
    private port: number,
    private token: string,
  ) {}

  async refresh(): Promise<void> {
    const status = StatusSchema.safeParse(await this.exchange(STATUS_PATH, undefined, 1500));
    if (!status.success)
      throw new Error(
        'The process on the bridge port uses an incompatible relay protocol. Update and restart the other MCP clients.',
      );
    this.connected = status.data.connected;
  }

  async send<T>(op: string, args: unknown, timeoutMs: number): Promise<T> {
    // Allow the master's operation deadline to fire before the HTTP deadline.
    const result = ResultSchema.parse(await this.exchange(CALL_PATH, { op, args, timeoutMs }, timeoutMs + 1000));
    if (result.error !== undefined) throw new Error(result.error);
    return result.result as T;
  }

  close(): void {
    this.connected = false;
    for (const req of this.requests) req.destroy(new Error('LOST_MID_CALL'));
  }

  private exchange(path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = request({
        host: '127.0.0.1',
        port: this.port,
        path,
        method: data ? 'POST' : 'GET',
        // One attempt per call, with no proxy, connection pool, or automatic replay.
        agent: false,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      });
      this.requests.add(req);
      const timer = setTimeout(() => req.destroy(new Error('LOST_MID_CALL')), timeoutMs);
      const finish = (err?: Error, value?: unknown) => {
        clearTimeout(timer);
        this.requests.delete(req);
        if (err) reject(err);
        else resolve(value);
      };
      req.on('error', () => finish(new Error('LOST_MID_CALL')));
      req.on('response', (res) => {
        if (res.statusCode !== 200) {
          finish(
            new Error(
              res.statusCode === 401
                ? 'The running bridge uses a different pairing token. Restart the other MCP clients so they load the current token.'
                : 'The process on the bridge port does not support sharing. Update and restart older MCP clients, or release the port if another application owns it.',
            ),
          );
          res.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_BODY_BYTES) {
            finish(new Error('Relay response too large'));
            res.destroy();
          } else chunks.push(chunk);
        });
        res.on('error', () => finish(new Error('LOST_MID_CALL')));
        res.on('end', () => {
          try {
            finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            finish(new Error('Invalid response from the local bridge. Update and restart the other MCP clients.'));
          }
        });
      });
      req.end(data);
    });
  }
}
