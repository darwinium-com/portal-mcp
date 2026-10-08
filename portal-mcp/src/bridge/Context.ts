/**
 * Bridge — reaches the extension directly as master, or through a relay as a
 * subordinate. Owns per-request correlation and the error-mapper surface.
 *
 * The bridge holds NO page-derived state: page ids, command lists, and context
 * all come back per-request from the page (see bridgeCallHandler's live
 * `listCommands` probe for the `expected_page_id` check). The only state here
 * is connection plumbing — socket handle, in-flight request correlation.
 */
import type WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { mapError, type ErrorMode } from './errorMapper.js';

type PendingEntry = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  // Owning socket. When a replaced socket's close handler fires, only its own
  // pending entries should reject; the new socket's in-flight requests are
  // healthy and must NOT be cleared as LOST_MID_CALL.
  ws: WebSocket;
  cleanup: () => void;
};

/** A subordinate forwards operations to the process that owns the extension. */
export interface Relay {
  connected: boolean;
  send<T>(op: string, args: unknown, timeoutMs: number): Promise<T>;
}

export class Bridge {
  private _ws: WebSocket | undefined;
  private pending = new Map<string, PendingEntry>();
  private wsReadyResolvers: Array<() => void> = [];
  private relay: Relay | undefined;
  private unavailableReason = 'The local browser bridge is reconnecting. Retry in a few seconds.';
  private _ownsPort = true;

  hasWs(): boolean {
    return this.relay ? this.relay.connected : this._ws?.readyState === 1;
  }

  setOwnsPort(owns: boolean): void {
    this._ownsPort = owns;
    if (owns) this.relay = undefined;
  }

  /** Undefined means the bridge is reachable, even if the extension is offline. */
  connectionProblem(): string | undefined {
    return this._ownsPort || this.relay ? undefined : this.unavailableReason;
  }

  setRelay(relay: Relay | undefined, reason?: string): void {
    this.relay = relay;
    if (reason) this.unavailableReason = reason;
    if (this.hasWs()) this.notifyReady();
  }

  /** Wait up to timeoutMs for an extension WS to be attached. Resolves true on attach, false on timeout. */
  waitForWs(timeoutMs: number): Promise<boolean> {
    if (this.hasWs()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const resolveOnce = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.wsReadyResolvers = this.wsReadyResolvers.filter((r) => r !== resolveOnce);
        resolve(false);
      }, timeoutMs);
      this.wsReadyResolvers.push(resolveOnce);
    });
  }

  attach(ws: WebSocket): void {
    if (this._ws) {
      try {
        this._ws.close(1000, 'replaced');
      } catch {
        /* ignore close failure on replaced socket */
      }
    }
    this._ws = ws;
    ws.on('message', (raw) => this.onMessage(ws, raw as Buffer | string));
    ws.on('close', () => {
      // Only reject pending entries OWNED by this socket. Without the
      // ws-tagged filter, a replaced socket's close async-fires AFTER the new
      // socket has registered its own pending entries, and rejectAllPending
      // would clear the new socket's healthy in-flight requests as
      // LOST_MID_CALL. With per-socket ownership, the replaced socket's close
      // only rejects its own (typically empty by then) entries.
      this.rejectPendingFor(ws, new Error('LOST_MID_CALL'));
      if (this._ws === ws) this._ws = undefined;
    });
    ws.on('error', () => {
      // The 'close' handler will fire; nothing to do here beyond avoiding an unhandled-error throw.
    });
    this.notifyReady();
  }

  private notifyReady(): void {
    const resolvers = this.wsReadyResolvers;
    this.wsReadyResolvers = [];
    for (const r of resolvers) r();
  }

  send<T = unknown>(op: string, args: unknown, timeoutMs = 30_000, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new Error('LOST_MID_CALL'));
    if (this.relay) return this.relay.send<T>(op, args, timeoutMs);
    if (!this.hasWs()) {
      return Promise.reject(new Error('NO_TAB'));
    }
    // Capture the owning socket NOW: a subsequent attach() that replaces
    // _ws must not orphan this entry — its close handler will rejectPendingFor(this ws).
    const owner = this._ws!;
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        const p = this.pending.get(id);
        if (!p) return;
        p.cleanup();
        this.pending.delete(id);
        reject(new Error('LOST_MID_CALL'));
      };
      const timer = setTimeout(() => {
        cleanup();
        this.pending.delete(id);
        reject(new Error('LOST_MID_CALL'));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        ws: owner,
        cleanup,
      });
      signal?.addEventListener('abort', abort, { once: true });
      // If the WS is in CLOSING/CLOSED state, `ws.send` synchronously throws;
      // without this guard the pending entry would never resolve and the MCP
      // host would hang until its outer timeout. On synchronous throw, reject
      // and clean up the pending Map entry + timer so the caller gets a fast,
      // descriptive error instead of an indefinite wait.
      try {
        owner.send(JSON.stringify({ id, type: 'req', op, args }), (err) => {
          if (err) abort();
        });
      } catch (err) {
        const pending = this.pending.get(id);
        if (pending) {
          pending.cleanup();
          this.pending.delete(id);
        }
        reject(new Error(`Bridge.send failed: ${(err as Error).message}`));
      }
    });
  }

  /** Map an internal error mode to a user-facing structured tool response. */
  errorResponse(mode: ErrorMode, ctx?: { newPageId?: string }) {
    return mapError(mode, ctx);
  }

  private onMessage(owner: WebSocket, raw: Buffer | string): void {
    try {
      const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString()) as Record<string, unknown>;
      if (msg.type === 'resp') {
        const id = msg.id as string;
        const p = this.pending.get(id);
        if (p && p.ws === owner) {
          p.cleanup();
          this.pending.delete(id);
          if (msg.error) {
            p.reject(new Error(String(msg.error)));
          } else {
            p.resolve(msg.result);
          }
        }
      } else if (msg.type === 'pageIdChanged') {
        // Intentionally ignored — the bridge keeps no page-derived state. The
        // extension still emits these push frames (wire-protocol compat); page
        // identity is resolved per-request via a live listCommands probe in
        // bridgeCallHandler instead.
      } else if (msg.type === 'ping') {
        // Echo pong so the extension's keepalive sees a reply.
        try {
          owner.send(JSON.stringify({ type: 'pong' }));
        } catch {
          /* ignore send failure on closing socket */
        }
      } else if (msg.type === 'pong') {
        // no-op — the binary doesn't currently track outbound pings.
      }
    } catch {
      /* malformed frame — ignore */
    }
  }

  // Reject only pending entries owned by `owner`. Used by the close handler
  // so a replaced socket cannot wipe the new socket's in-flight work.
  private rejectPendingFor(owner: WebSocket, err: Error): void {
    for (const [id, p] of this.pending.entries()) {
      if (p.ws !== owner) continue;
      p.cleanup();
      this.pending.delete(id);
      p.reject(err);
    }
  }
}
