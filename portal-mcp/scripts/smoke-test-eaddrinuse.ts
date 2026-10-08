import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { build } from 'tsdown';
import WebSocket from 'ws';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'portal-mcp-sharing-'));
const tokenPath = join(temporary, 'token');
const fixture = resolve(root, 'scripts/fixtures/serve.ts');
const compiled = process.argv.includes('--bun');
const binary = join(temporary, compiled ? 'serve' : 'serve.mjs');
const processes: Host[] = [];
const extensions = new Set<WebSocket>();
let reconnect = false;
let reconnectTimer: NodeJS.Timeout | undefined;
let currentExtension: WebSocket | undefined;
let connectionCount = 0;
const received: Array<{ id: string; op: string; args: any }> = [];
const wireIds = new Set<string>();
const foreign = createServer((_req, res) => {
  res.writeHead(426);
  res.end();
});
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function assertPortalGuidance(instructions: string) {
  assert.match(instructions, /exactly three MCP tools: get_page_commands, run_page_command, and get_context/);
  assert.match(instructions, /call get_page_commands to check the current connection/);
  assert.match(instructions, /get_documentation, get_attribute, or other tools do not expose those tools/);
  assert.match(instructions, /"name":"<returned command name>"/);
}

async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 15_000) {
  const start = Date.now();
  while (!(await check())) {
    assert.ok(Date.now() - start < timeout, `Timed out: ${label}`);
    await delay(50);
  }
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

class Host {
  proc: ChildProcessWithoutNullStreams;
  stderr = '';
  private id = 0;
  private pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>();
  constructor(port: number, path = tokenPath) {
    this.proc = spawn(
      compiled ? binary : process.execPath,
      compiled ? [String(port), path] : [binary, String(port), path],
      { stdio: 'pipe' },
    );
    processes.push(this);
    this.proc.stderr.on('data', (b) => {
      this.stderr += b.toString();
    });
    let buffer = '';
    this.proc.stdout.on('data', (b) => {
      buffer += b.toString();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const msg = JSON.parse(line); // Also verifies stdout contains only JSON-RPC.
        assert.equal(msg.jsonrpc, '2.0');
        const pending = this.pending.get(msg.id);
        if (!pending) continue;
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)));
        else pending.resolve(msg.result);
      }
    });
    this.proc.on('exit', () => {
      for (const p of this.pending.values()) p.reject(new Error('MCP process exited'));
      this.pending.clear();
    });
  }
  async ready() {
    await until(
      () => /master listening|subordinate sharing|does not support sharing|different pairing token/.test(this.stderr),
      'process ready',
    );
    assert.equal(this.proc.exitCode, null, 'bridge process exited during startup');
  }
  request(method: string, params: unknown = {}): Promise<any> {
    // Every host starts at id 1: overlapping ids must stay isolated by session.
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP timeout: ${method}`));
      }, 20_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  initialize() {
    return this.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'sharing-test', version: '1' },
    });
  }
  call(name: string, args: unknown = {}) {
    return this.request('tools/call', { name, arguments: args });
  }
  async stop(signal?: 'SIGKILL') {
    const exited = once(this.proc, 'exit');
    if (signal) this.proc.kill(signal);
    else this.proc.stdin.end();
    await Promise.race([
      exited,
      delay(3000).then(() => {
        throw new Error('Host did not exit after stdin EOF');
      }),
    ]);
  }
}

function connectExtension(port: number, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, ['darwinium.v1', `tok.${token}`]);
  extensions.add(ws);
  ws.on('open', () => {
    currentExtension = ws;
    connectionCount++;
    ws.send(JSON.stringify({ type: 'hello', token, version: '0.1.0' }));
    ws.send(JSON.stringify({ type: 'ping' }));
  });
  ws.on('error', () => {});
  ws.on('close', () => {
    extensions.delete(ws);
    if (currentExtension === ws) currentExtension = undefined;
    if (reconnect) reconnectTimer = setTimeout(() => connectExtension(port, token), 100);
  });
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type !== 'req') return;
    assert.ok(!wireIds.has(msg.id), 'duplicate request id on the extension socket');
    wireIds.add(msg.id);
    received.push(msg);
    if (msg.args?.name === 'hold') return;
    const result =
      msg.op === 'listCommands'
        ? [{ name: 'echo', _pageId: 'test-page' }]
        : msg.args.name === 'getDarwiniumInstructions'
          ? { instructions: 'Live test portal instructions' }
          : msg.args.name === 'getCurrentNodeContext'
            ? { node: 'test-node' }
            : msg.args.name === 'image'
              ? { __image: { mimeType: 'image/png', base64: 'aGVsbG8=' }, label: 'test' }
              : msg.args.args;
    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(
          JSON.stringify({
            id: msg.id,
            type: 'resp',
            ...(msg.args?.name === 'fail' ? { error: 'TAB_STALE' } : { result }),
          }),
        );
    }, msg.args?.args?.delay ?? 0);
  });
}

async function echo(host: Host, marker: string, delay = 0) {
  const result = await host.call('run_page_command', {
    name: 'echo',
    args: { marker, delay },
    expected_page_id: 'test-page',
  });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.content[0].text), { marker, delay });
}

try {
  if (compiled) {
    const result = spawnSync('bun', ['build', fixture, '--compile', '--outfile', binary], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  } else {
    await build({
      entry: [fixture],
      outDir: temporary,
      config: false,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      noExternal: [/^[^.]/],
      sourcemap: false,
      dts: false,
      logLevel: 'silent',
    });
  }
  const port = await unusedPort();
  const hosts = [new Host(port), new Host(port), new Host(port)];
  await Promise.all(hosts.map((h) => h.ready()));
  assert.equal(hosts.filter((h) => h.stderr.includes('master listening')).length, 1);
  const token = readFileSync(tokenPath, 'utf8').trim();
  assert.match(token, /^[a-f0-9]{64}$/);
  const master = hosts.find((h) => h.stderr.includes('master listening'))!;
  const followers = hosts.filter((h) => h !== master);
  const init = await Promise.all(hosts.map((h) => h.initialize()));
  for (const result of init) {
    assert.deepEqual(result.capabilities, { tools: {} });
    assert.ok(result.instructions.includes(token), 'unconnected sessions offer the same pairing token');
    assertPortalGuidance(result.instructions);
    assert.doesNotMatch(result.instructions, /will not work until the user pairs/);
    assert.match(result.instructions, /If a current tool response says/);
  }
  reconnect = true;
  connectExtension(port, token);
  await until(() => !!currentExtension, 'extension connects');
  await until(async () => !(await followers[0].call('get_page_commands')).isError, 'followers see extension');
  const startupConnections = connectionCount;

  // Deliberately complete calls out of order, with matching MCP ids across hosts.
  await Promise.all(hosts.flatMap((h, i) => [echo(h, `slow-${i}`, 100), echo(h, `fast-${i}`)]));
  for (const host of hosts) {
    assert.equal((await host.request('tools/list')).tools.length, 3);
    const context = await host.call('get_context');
    const instructions = JSON.parse(context.content[0].text).instructions;
    assert.ok(instructions.endsWith('Live test portal instructions'));
    assertPortalGuidance(instructions);
    const image = await host.call('run_page_command', { name: 'image' });
    assert.ok(image.content.some((c: any) => c.type === 'image' && c.data === 'aGVsbG8='));
    const error = await host.call('run_page_command', { name: 'fail' });
    assert.equal(error.isError, true);
    assert.match(error.content[0].text, /refresh the connected portal tab/);
  }
  assert.equal(connectionCount, startupConnections, 'subordinates must not displace the extension');
  console.error('PASS: simultaneous first launch, three MCP sessions, concurrent routing, context, images and errors');

  const relayUrl = `http://127.0.0.1:${port}/bridge/v1`;
  assert.equal((await fetch(`${relayUrl}/status`)).status, 401);
  assert.equal((await fetch(`${relayUrl}/status`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.equal(
    (await fetch(`${relayUrl}/status`, { headers: { ...headers, Origin: 'https://example.com' } })).status,
    401,
  );
  const before = received.length;
  for (const body of [
    '{',
    JSON.stringify({ op: 'invalid', timeoutMs: 100 }),
    JSON.stringify({ op: 'runCommand', timeoutMs: 60001 }),
  ]) {
    assert.equal((await fetch(`${relayUrl}/call`, { method: 'POST', headers, body })).status, 400);
  }
  assert.equal(received.length, before);
  const timedOut = await fetch(`${relayUrl}/call`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ op: 'runCommand', args: { name: 'hold' }, timeoutMs: 50 }),
  });
  assert.equal(((await timedOut.json()) as any).error, 'LOST_MID_CALL');

  // Refactoring the shared listener must preserve the extension's auth contract.
  for (const hello of [JSON.stringify({ type: 'hello', token: 'c'.repeat(64) }), '{', undefined]) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, ['darwinium.v1', `tok.${token}`]);
    extensions.add(ws);
    const closed = once(ws, 'close');
    await once(ws, 'open');
    if (hello !== undefined) ws.send(hello);
    const timeout = setTimeout(() => ws.terminate(), 3000);
    assert.equal((await closed)[0], 4401);
    clearTimeout(timeout);
    extensions.delete(ws);
  }
  assert.equal(connectionCount, startupConnections, 'rejected handshakes must leave the extension connected');

  const wrongPath = join(temporary, 'wrong-token');
  writeFileSync(wrongPath, 'b'.repeat(64));
  const wrong = new Host(port, wrongPath);
  await wrong.ready();
  const unavailable = await wrong.call('get_page_commands');
  assert.match(unavailable.content[0].text, /different pairing token/);
  assert.ok(!unavailable.content[0].text.includes('Save & Connect'));
  await wrong.stop();
  await echo(master, 'owner-survives-auth-failure');
  console.error('PASS: relay authentication, browser-origin rejection, malformed requests and deadlines');

  const disconnectHolds = received.filter((r) => r.args?.name === 'hold').length;
  const disconnectedCalls = Promise.all(
    [master, followers[0]].map((h) => h.call('run_page_command', { name: 'hold' })),
  );
  await until(
    () => received.filter((r) => r.args?.name === 'hold').length === disconnectHolds + 2,
    'pending calls reach extension',
  );
  reconnect = false;
  currentExtension!.terminate();
  for (const result of await disconnectedCalls) {
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Lost connection to portal mid-call/);
  }
  await until(async () => {
    const result = await followers[0].call('get_page_commands');
    return result.isError && result.content[0].text.includes(token);
  }, 'extension disconnect reaches followers');
  reconnect = true;
  connectExtension(port, token);
  await until(
    async () => !(await followers[0].call('get_page_commands')).isError,
    'extension reconnect reaches followers',
  );

  const abandonedCall = followers[1].call('run_page_command', { name: 'hold' }).catch(() => undefined);
  const abandonedHolds = received.filter((r) => r.args?.name === 'hold').length;
  await until(
    () => received.filter((r) => r.args?.name === 'hold').length > abandonedHolds,
    'call arrives before subordinate exits',
  );
  await followers[1].stop();
  await abandonedCall;
  await echo(master, 'owner-after-follower-exit');
  await echo(followers[0], 'follower-after-follower-exit');
  const replacement = new Host(port);
  await replacement.ready();
  const liveInit = await replacement.initialize();
  assert.ok(liveInit.instructions.endsWith('Live test portal instructions'));
  assertPortalGuidance(liveInit.instructions);
  await echo(replacement, 'replacement');
  const holdsBefore = received.filter((r) => r.args?.name === 'hold').length;
  const interrupted = followers[0].call('run_page_command', { name: 'hold' });
  await until(
    () => received.filter((r) => r.args?.name === 'hold').length === holdsBefore + 1,
    'call arrives before owner exit',
  );
  await master.stop();
  const failure = await interrupted;
  assert.equal(failure.isError, true);
  assert.match(failure.content[0].text, /Lost connection to portal mid-call/);
  const survivors = [followers[0], replacement];
  await until(
    async () => (await Promise.all(survivors.map((h) => h.call('get_page_commands')))).every((r) => !r.isError),
    'survivors recover after election',
  );
  assert.equal(survivors.filter((h) => h.stderr.includes('master listening')).length, 1);
  await Promise.all(survivors.map((h, i) => echo(h, `after-election-${i}`)));
  assert.equal(
    received.filter((r) => r.args?.name === 'hold').length,
    holdsBefore + 1,
    'interrupted calls must never replay',
  );
  const nextMaster = survivors.find((h) => h.stderr.includes('master listening'))!;
  const last = survivors.find((h) => h !== nextMaster)!;
  await nextMaster.stop('SIGKILL');
  await until(async () => !(await last.call('get_page_commands')).isError, 'survivor recovers after crash');
  await echo(last, 'after-crash');
  reconnect = false;
  clearTimeout(reconnectTimer);
  await last.stop();
  console.error('PASS: extension reconnect, independent shutdown, owner EOF/crash, election and no request replay');

  foreign.listen(0, '127.0.0.1');
  await once(foreign, 'listening');
  const foreignPort = (foreign.address() as { port: number }).port;
  const waiting = new Host(foreignPort);
  await waiting.ready();
  const waitingInit = await waiting.initialize();
  assertPortalGuidance(waitingInit.instructions);
  const conflict = await waiting.call('get_page_commands');
  assert.equal(conflict.isError, true);
  assert.match(conflict.content[0].text, /does not support sharing/);
  assert.equal((await fetch(`http://127.0.0.1:${foreignPort}`)).status, 426, 'foreign listener remains alive');
  await new Promise<void>((resolve) => foreign.close(() => resolve()));
  await until(() => waiting.stderr.includes('master listening'), 'takeover after incompatible listener closes');
  connectExtension(foreignPort, token);
  await until(async () => !(await waiting.call('get_page_commands')).isError, 'same initialized session recovers');
  const recoveredContext = await waiting.call('get_context');
  assert.equal(recoveredContext.isError, undefined);
  assert.equal(JSON.parse(recoveredContext.content[0].text).node, 'test-node');
  assertPortalGuidance(JSON.parse(recoveredContext.content[0].text).instructions);
  assert.doesNotMatch(
    waitingInit.instructions,
    /does not support sharing/,
    'cached initialize instructions must not retain a transient bridge failure after recovery',
  );
  console.error('PASS: startup conflict recovers in the same session without a cached failure diagnostic');
  await waiting.stop();
  console.error(`SMOKE TEST PASSED (${compiled ? 'compiled Bun' : 'Node'}): bridge sharing and failover`);
} finally {
  reconnect = false;
  clearTimeout(reconnectTimer);
  for (const ws of extensions) ws.terminate();
  for (const host of processes) if (host.proc.exitCode === null && host.proc.signalCode === null) host.proc.kill();
  foreign.closeAllConnections();
  foreign.close();
  rmSync(temporary, { recursive: true, force: true });
}
