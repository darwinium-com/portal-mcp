/**
 * Capped exponential backoff reconnect scheduler: 500ms initial delay, 2x per
 * attempt, 30s cap, ±20% jitter (uniform on [0.8, 1.2]), indefinite retry,
 * reset on successful connect (caller invokes resetBackoff() from WS 'open').
 *
 * Single in-flight retry: if a setTimeout is already scheduled, scheduleReconnect
 * is a no-op. Belt-and-braces: the chrome.alarms 'wake' tick
 * (entrypoints/background.ts) calls connectIfNeeded() — so even if a setTimeout
 * is dropped (SW termination mid-wait), the alarm catches up.
 *
 * connectFn is parameterized rather than imported from ws-client.ts to avoid a
 * circular import (ws-client.ts imports scheduleReconnect, and would otherwise
 * be imported BY reconnect.ts). The math is deliberately inlined — a retry
 * library would add bundle weight for ~6 lines.
 */

const BASE_MS = 500;
const CAP_MS = 30_000;

let attempt = 0;
let timer: number | undefined;

/**
 * Schedule a reconnect attempt with capped exponential backoff + ±20% jitter.
 * No-op if a retry is already scheduled (single in-flight retry).
 *
 * @param connectFn — the connect function to invoke when the timer fires.
 *   Typically `connectIfNeeded` from ws-client.ts. Injected (not imported) to
 *   avoid a circular dependency.
 */
export function scheduleReconnect(connectFn: () => Promise<void>): void {
  if (timer !== undefined) return; // single in-flight retry
  const exp = Math.min(CAP_MS, BASE_MS * Math.pow(2, attempt));
  const jitter = exp * (0.8 + Math.random() * 0.4); // ±20%
  attempt++;
  timer = setTimeout(() => {
    timer = undefined;
    void connectFn();
  }, jitter) as unknown as number;
}

/**
 * Reset the backoff counter and cancel any pending retry. Called by the WS
 * 'open' handler after a successful connect, and by the token-rotation
 * atomic-restart path.
 */
export function resetBackoff(): void {
  attempt = 0;
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
}
