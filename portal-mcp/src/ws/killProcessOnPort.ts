import { execSync } from 'node:child_process';
import * as net from 'node:net';

/**
 * Kill any process holding the given port. Cross-platform; safe to call when port is free.
 *
 * SECURITY: kills ONLY the PID returned by `lsof -ti:PORT` (or netstat equivalent).
 * Does NOT take a port-range; cannot kill unrelated processes. Caller-controlled
 * port number is the only risk surface.
 *
 * Pattern verbatim from BrowserMCP: github.com/BrowserMCP/mcp/blob/main/src/utils/port.ts
 */
export function killProcessOnPort(port: number): void {
  try {
    if (process.platform === 'win32') {
      execSync(`FOR /F "tokens=5" %a in ('netstat -ano ^| findstr :${port}') do taskkill /F /PID %a`, {
        stdio: 'pipe',
      });
      return;
    }
    // `lsof -ti` lists every process with ANY socket on the port, including
    // OUR OWN client connections to it (e.g. the peer probe in ws/server.ts).
    // Piping straight into `xargs kill -9` therefore makes the caller kill
    // itself along with the holder. Filter our own pid out and signal the rest
    // directly rather than shelling out a second time.
    const out = execSync(`lsof -ti:${port}`, { stdio: 'pipe' }).toString();
    const pids = out
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone, or not ours to kill — the isPortInUse poll decides. */
      }
    }
  } catch {
    /* port was free, lsof returned nonzero — fine. The subsequent isPortInUse poll is the source of truth. */
  }
}

/**
 * Check whether a port is currently bound. Returns true if held; false if free.
 * Polls by attempting to bind a tester server on the same host.
 */
export function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once('error', () => resolve(true))
      .once('listening', () => tester.close(() => resolve(false)))
      .listen(port, '127.0.0.1');
  });
}

/**
 * Sleep for `ms` milliseconds. Used by the bind-loop poll cap.
 */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
