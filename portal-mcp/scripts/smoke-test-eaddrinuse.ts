import { spawn, ChildProcess } from 'node:child_process';
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bin = path.resolve(__dirname, '../dist/bin/portal-mcp.js');

async function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function startInstance(): Promise<ChildProcess> {
  const proc = spawn('node', [bin, 'serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
  // Wait briefly for WS bind
  await delay(1500);
  return proc;
}

(async () => {
  console.error('Starting first portal-mcp instance...');
  const first = await startInstance();
  console.error(`First instance pid=${first.pid}`);

  console.error('Starting second portal-mcp instance...');
  const second = await startInstance();

  let secondStderr = '';
  second.stderr?.on('data', (b: Buffer) => {
    secondStderr += b.toString();
  });
  let secondExited = false;
  let secondCode: number | null = null;
  second.on('exit', (code) => {
    secondExited = true;
    secondCode = code;
  });

  // Wait up to 10s for the second instance to either:
  //   (a) take over (kill the first, bind successfully, keep running) — POSIX path
  //   (b) print PORT_HELD_MESSAGE and exit 1 — when poll exhausts
  await delay(10_000);

  // Either of the two graceful outcomes is acceptable.
  const tookOver = !secondExited && secondStderr.includes('WS server listening');
  const userMessageShown =
    secondExited &&
    secondCode === 1 &&
    secondStderr.includes('Another MCP client is using the Darwinium bridge on port 9224');

  // Stack trace is the failure mode we're testing AGAINST.
  const stackTraceShown = /at\s+\S+\s+\(/.test(secondStderr) && secondStderr.includes('Error');

  console.error(`tookOver=${tookOver} userMessageShown=${userMessageShown} stackTraceShown=${stackTraceShown}`);
  console.error(`secondStderr (first 500 chars): ${secondStderr.slice(0, 500)}`);

  assert.ok(
    tookOver || userMessageShown,
    `Second instance neither took over nor showed user-facing message. stderr: ${secondStderr.slice(0, 1000)}`,
  );
  assert.ok(
    !stackTraceShown,
    `Second instance printed a stack trace (forbidden — must be user-readable). stderr: ${secondStderr.slice(0, 1000)}`,
  );

  // Cleanup
  first.kill();
  if (!secondExited) second.kill();

  console.error('SMOKE TEST PASSED: second-instance handling is graceful.');
  process.exit(0);
})().catch((err) => {
  console.error(`SMOKE TEST FAILED: ${err.message}`);
  process.exit(1);
});
