import { spawn } from 'node:child_process';
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bin = path.resolve(__dirname, '../dist/bin/portal-mcp.js');

const proc = spawn('node', [bin, 'serve'], { stdio: ['pipe', 'pipe', 'pipe'] });

const initReq = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'portal-mcp-smoke', version: '0' },
  },
});
const listReq = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

proc.stdin.write(initReq + '\n');
proc.stdin.write(listReq + '\n');

let stdoutBuf = '';
let initSeen = false;
let listSeen = false;
let firstFrameAsserted = false;

const TIMEOUT_MS = 5000;
const timeout = setTimeout(() => {
  console.error(`SMOKE TEST TIMEOUT: did not see tools/list response within ${TIMEOUT_MS}ms`);
  console.error(`stdoutBuf so far: ${stdoutBuf.slice(0, 1000)}`);
  proc.kill();
  process.exit(1);
}, TIMEOUT_MS);

proc.stdout.on('data', (chunk: Buffer) => {
  stdoutBuf += chunk.toString();
  const lines = stdoutBuf.split('\n').filter((l) => l.length > 0);

  for (const line of lines) {
    // ASSERTION 1: first stdout line parses as JSON-RPC (no banner, no junk)
    if (!firstFrameAsserted) {
      try {
        const parsed = JSON.parse(line);
        assert.equal(parsed.jsonrpc, '2.0', 'First stdout line is not jsonrpc 2.0');
        firstFrameAsserted = true;
      } catch (err) {
        console.error(`ASSERTION 1 FAILED: first stdout line did not parse as JSON-RPC.`);
        console.error(`Line: ${JSON.stringify(line)}`);
        console.error(`This usually means a transitive dependency is logging on import.`);
        proc.kill();
        clearTimeout(timeout);
        process.exit(1);
      }
    }

    // Find the responses by id
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed.id === 1 && parsed.result) initSeen = true;
    if (parsed.id === 2 && parsed.result?.tools && !listSeen) {
      const tools = parsed.result.tools;
      // ASSERTION 2 & 4: exactly 3 tools (ADR-001 gate).
      // install/doctor/rotate-token are BINARY SUBCOMMANDS, not new MCP tools.
      // The MCP tool surface stays exactly 3 forever (Claude Desktop/Code cache
      // tools/list and don't honor tools/list_changed).
      // Future maintainers: do NOT add a 4th tool. Pairing/doctor/rotate-token
      // are subcommand surfaces in src/install/, NOT entries in src/server/tools.ts.
      assert.equal(
        tools.length,
        3,
        `Expected 3 tools, got ${tools.length}: ${tools.map((t: any) => t.name).join(', ')}`,
      );
      // ASSERTION 3: exact names in exact order
      assert.deepEqual(
        tools.map((t: any) => t.name),
        ['get_page_commands', 'run_page_command', 'get_context'],
        'Tool names or order do not match the locked surface',
      );
      // ASSERTION 4: each tool has an inputSchema
      for (const tool of tools) {
        assert.ok(tool.inputSchema, `Tool ${tool.name} missing inputSchema`);
        assert.equal(tool.inputSchema.type, 'object');
      }
      listSeen = true;
      clearTimeout(timeout);
      console.error(
        `PHASE 1 ASSERTIONS PASSED: 3 tools, JSON-RPC stdout discipline, names match. Running ASSERTION 5...`,
      );
      runHandshakeAssertion()
        .then(() => runWireProtocolDriftAssertion())
        .then(async () => {
          // ASSERTIONs 7-9 require port 9224 free — kill the `serve` we spawned
          // for ASSERTIONs 1-6 before invoking install/rotate-token, which spin
          // up their own foreground OOB pairing-WS server on the same port.
          proc.kill();
          await delay(500);
          await runInstallAssertion();
          await runDoctorJsonAssertion();
          await runRotateTokenAssertion();
        })
        .then(() => {
          console.error(
            'SMOKE TEST PASSED: all assertions including token handshake (5a/5b/5c/5d), ' +
              'wire-protocol drift check (6), install (7), doctor --json (8), and rotate-token (9).',
          );
          process.exit(0);
        })
        .catch((err) => {
          console.error(err.message);
          try {
            proc.kill();
          } catch {
            /* already dead */
          }
          process.exit(1);
        });
      return; // exit the for-loop; promise chain handles exit
    }
  }
});

// ASSERTION 5 — token-handshake check.
// Runs after tools/list passes. Requires WS server bound on 127.0.0.1:9224 —
// runServer() in src/server/index.ts binds AFTER server.connect(), so by the
// time tools/list returns the WS server is up.
//
// Sub-tests:
//   5a — correct token + hello frame → 'open' event (no 4401 close).
//   5b — wrong token → close event with code 4401 within 2s.
//   5c — valid-shape token but no hello frame → 4401 close (HELLO_TIMEOUT_MS).
//   5d — malformed JSON first frame → 4401 close.
async function runHandshakeAssertion(): Promise<void> {
  const WebSocketLib = await import('ws'); // dynamic import to keep the test file dep-light
  const WS = WebSocketLib.default;
  const fs = await import('node:fs');
  const pathMod = await import('node:path');
  const os = await import('node:os');
  // The outer `serve` process at line 9 was spawned without HOME override, so
  // the binary writes its token to the developer's REAL env-paths data dir —
  // which is the same dir the platform-specific `envPathsDataDir(home)` helper
  // (used by ASSERTIONs 7-9 for fakeHome roots) resolves to. Reuse the same
  // helper here against `os.homedir()` so ASSERTION 5 mirrors the binary's
  // path resolution exactly.
  const TOKEN_PATH = pathMod.join(envPathsDataDir(os.homedir()), 'token');
  const expected = fs.readFileSync(TOKEN_PATH, 'utf8').trim();

  // Sub-test 5a: correct token → 'open' event.
  await new Promise<void>((resolve, reject) => {
    const ws = new WS('ws://127.0.0.1:9224', ['darwinium.v1', `tok.${expected}`]);
    const timer = setTimeout(
      () => reject(new Error('ASSERTION 5a FAILED: WS open never fired with correct token')),
      3000,
    );
    ws.on('open', () => {
      // Send hello frame, then close cleanly.
      ws.send(JSON.stringify({ type: 'hello', token: expected, version: '0.1.0' }));
      clearTimeout(timer);
      ws.close(1000, 'smoke-test done');
      resolve();
    });
    ws.on('close', (code: number) => {
      if (code === 4401) {
        clearTimeout(timer);
        reject(new Error('ASSERTION 5a FAILED: WS closed 4401 with the correct token'));
      }
    });
    ws.on('error', () => {
      /* swallow — close fires after */
    });
  });

  // Sub-test 5b: wrong token → close event with code 4401 within 2s.
  await new Promise<void>((resolve, reject) => {
    const wrongToken = '0'.repeat(64);
    if (wrongToken === expected) {
      reject(
        new Error(
          'ASSERTION 5b SETUP FAILED: wrong-token sentinel happens to equal the real token (extremely unlikely)',
        ),
      );
      return;
    }
    const ws = new WS('ws://127.0.0.1:9224', ['darwinium.v1', `tok.${wrongToken}`]);
    const timer = setTimeout(
      () => reject(new Error('ASSERTION 5b FAILED: WS did not close 4401 within 2s with wrong token')),
      2000,
    );
    ws.on('open', () => {
      // Server may accept the upgrade (handleProtocols only checks shape) and then close 4401
      // after the 1s hello timer. Send a wrong hello frame to trigger immediate 4401 close.
      ws.send(JSON.stringify({ type: 'hello', token: wrongToken, version: '0.1.0' }));
    });
    ws.on('close', (code: number) => {
      clearTimeout(timer);
      if (code === 4401) {
        resolve();
      } else {
        reject(new Error(`ASSERTION 5b FAILED: WS closed with code ${code} (expected 4401)`));
      }
    });
    ws.on('error', () => {
      /* close fires after */
    });
  });

  // Sub-test 5c: connect with valid-shape token but never send hello frame; assert 4401 within 1.5s.
  await new Promise<void>((resolve, reject) => {
    const ws = new WS('ws://127.0.0.1:9224', ['darwinium.v1', `tok.${expected}`]);
    let closeReceived = false;
    const timer = setTimeout(() => {
      if (!closeReceived) {
        ws.terminate();
        reject(new Error('ASSERTION 5c FAILED: no 4401 close within 1.5s after omitting hello frame'));
      }
    }, 1500);
    ws.on('open', () => {
      // Intentionally do NOT send {type:'hello'} — let server hello-timer fire
    });
    ws.on('close', (code: number) => {
      closeReceived = true;
      clearTimeout(timer);
      if (code === 4401) {
        resolve();
      } else {
        reject(new Error(`ASSERTION 5c FAILED: expected close 4401 on hello timeout, got ${code}`));
      }
    });
    ws.on('error', () => {
      /* close-after-error is fine */
    });
  });

  // Sub-test 5d: send malformed JSON as first frame; assert 4401 close.
  await new Promise<void>((resolve, reject) => {
    const ws = new WS('ws://127.0.0.1:9224', ['darwinium.v1', `tok.${expected}`]);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('ASSERTION 5d FAILED: no 4401 close within 2s after malformed JSON first frame'));
    }, 2000);
    ws.on('open', () => {
      ws.send('not json {{{');
    });
    ws.on('close', (code: number) => {
      clearTimeout(timer);
      if (code === 4401) {
        resolve();
      } else {
        reject(new Error(`ASSERTION 5d FAILED: expected close 4401 on malformed first frame, got ${code}`));
      }
    });
    ws.on('error', () => {
      /* close-after-error is fine */
    });
  });

  console.error('ASSERTION 5 PASSED: token handshake — 5a/5b/5c/5d all closed/opened as expected.');
}

// ASSERTION 6 — wire-protocol-drift check.
// Reads BOTH portal-mcp/src/bridge/wireProtocol.ts AND
// portal-extension/src/shared/{wireProtocol,version}.ts via node:fs (no cross-package
// import — keeps the smoke-test bundle graph independent of portal-extension) and
// asserts byte-equal values for the shared constants. PROTOCOL_VERSION lives in
// portal-extension/src/shared/version.ts on the extension side.
async function runWireProtocolDriftAssertion(): Promise<void> {
  const fs = await import('node:fs');
  const pathMod = await import('node:path');

  const binaryWire = fs.readFileSync(
    pathMod.resolve(__dirname, '../src/bridge/wireProtocol.ts'),
    'utf8',
  );
  const extWire = fs.readFileSync(
    pathMod.resolve(__dirname, '../../portal-extension/src/shared/wireProtocol.ts'),
    'utf8',
  );
  const extVersion = fs.readFileSync(
    pathMod.resolve(__dirname, '../../portal-extension/src/shared/version.ts'),
    'utf8',
  );

  const constants = [
    'VERSION_SUBPROTOCOL',
    'TOKEN_SUBPROTOCOL_PREFIX',
    'WS_CLOSE_TOKEN_MISMATCH',
    'PROTOCOL_VERSION',
    // NOTE: TOKEN_SUBPROTOCOL_REGEX and PAIRING_CODE_REGEX are NOT mirrored to
    // the extension copy — the extension uses its own equivalent regex check.
    'PAIR_SUBPROTOCOL_PREFIX',
  ];
  const extractFromSource = (source: string, name: string): string | null => {
    // Match: `export const NAME = 'value'` or `export const NAME = "value"` or `export const NAME = 4401`
    const re = new RegExp(`export\\s+const\\s+${name}\\s*(?::[^=]+)?=\\s*([^;\\n]+)`);
    const match = source.match(re);
    return match ? match[1].trim() : null;
  };

  for (const c of constants) {
    // PROTOCOL_VERSION lives in shared/version.ts on the extension side.
    const extSource = c === 'PROTOCOL_VERSION' ? extVersion : extWire;
    const binaryValue = extractFromSource(binaryWire, c);
    const extValue = extractFromSource(extSource, c);
    if (binaryValue === null) {
      throw new Error(`ASSERTION 6 FAILED: ${c} not found in portal-mcp/src/bridge/wireProtocol.ts`);
    }
    if (extValue === null) {
      throw new Error(
        `ASSERTION 6 FAILED: ${c} not found in portal-extension/src/shared/${c === 'PROTOCOL_VERSION' ? 'version' : 'wireProtocol'}.ts`,
      );
    }
    if (binaryValue !== extValue) {
      throw new Error(
        `ASSERTION 6 FAILED: ${c} drift — binary=${binaryValue}, extension=${extValue}. ` +
          `KEEP-IN-SYNC comment is the only contract; sync the values.`,
      );
    }
  }

  console.error('ASSERTION 6 PASSED: wire-protocol constants byte-equal across binary and extension.');
}

// ---------------------------------------------------------------------------
// ASSERTIONS 7-9 — install (7), doctor --json (8), rotate-token (9).
// All three run AFTER the `proc` (serve) has been killed; each
// install/rotate-token spawn binds its own foreground pairing-WS server on
// 127.0.0.1:9224.
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Locate the env-paths data dir for a given fake HOME root by computing the
 * platform-specific path env-paths would resolve to. We avoid importing
 * env-paths here so the test stays decoupled from the dep — the platform
 * mappings are short and stable.
 */
function envPathsDataDir(fakeHome: string): string {
  if (process.platform === 'darwin') {
    return path.join(
      fakeHome,
      'Library',
      'Application Support',
      'darwinium-portal-mcp',
    );
  }
  if (process.platform === 'win32') {
    // env-paths uses %LOCALAPPDATA% (or %APPDATA%) — for the test we drive
    // the LOCALAPPDATA env var directly via the spawn env.
    return path.join(fakeHome, 'AppData', 'Local', 'darwinium-portal-mcp', 'Data');
  }
  return path.join(fakeHome, '.local', 'share', 'darwinium-portal-mcp');
}

/**
 * Pre-stage `extension-bundle/extension.zip` if missing. The fake zip carries
 * a minimal `manifest.json` with version `0.0.0-smoke` so install.ts's
 * extract step has something to work with. Doesn't replace a real zip if one
 * is already present (e.g. a real WXT artifact from a prior `bundle-extension`
 * prebuild run).
 */
async function ensureFakeExtensionZip(): Promise<void> {
  const fs = await import('node:fs');
  const pathMod = await import('node:path');
  const zipPath = pathMod.resolve(__dirname, '..', 'extension-bundle', 'extension.zip');
  if (fs.existsSync(zipPath)) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const AdmZip: any = (await import('adm-zip')).default;
  const zip = new AdmZip();
  const manifest = {
    manifest_version: 3,
    name: 'Darwinium Portal MCP (smoke-test stub)',
    version: '0.0.0-smoke',
    description: 'Stub manifest used by smoke-test ASSERTION 7.',
  };
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  fs.mkdirSync(pathMod.dirname(zipPath), { recursive: true });
  zip.writeZip(zipPath);
}

interface InstallSpawnResult {
  proc: ReturnType<typeof spawn>;
  pairingCode: string;
  capturedToken: string;
  pairedFrame: { type: string; token: string; version: string };
  fakeHome: string;
}

/**
 * Spawn `install` with a fake HOME, capture the printed pairing code from
 * stderr, then connect a WS as the popup and complete the OOB pair. Returns
 * the spawned proc (still running, so the caller can let it exit cleanly),
 * the captured code, and the {type:'paired'} frame received from the binary.
 */
async function spawnInstallAndPair(
  fakeHome: string,
  binPath: string,
  extraEnv: Record<string, string> = {},
): Promise<InstallSpawnResult> {
  const fs = await import('node:fs');
  const pathMod = await import('node:path');
  const WS = (await import('ws')).default;
  const installProc = spawn('node', [binPath, 'install'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: fakeHome,
      // Windows uses APPDATA / LOCALAPPDATA — set both to the fake-home tree
      // so env-paths resolves under it.
      APPDATA: pathMod.join(fakeHome, 'AppData', 'Roaming'),
      LOCALAPPDATA: pathMod.join(fakeHome, 'AppData', 'Local'),
      ...extraEnv,
    },
  });

  let stderrBuf = '';
  let resolved = false;
  return new Promise<InstallSpawnResult>((resolve, reject) => {
    const overallTimer = setTimeout(() => {
      if (resolved) return;
      installProc.kill();
      reject(
        new Error(
          `ASSERTION 7 FAILED: install did not print pairing prompt within 10s. stderr so far: ${stderrBuf.slice(0, 500)}`,
        ),
      );
    }, 10_000);

    installProc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      // Wait for the boxed pairing code to appear. The "waiting for popup..."
      // line comes after the box, which is our cue that the pairing-WS server
      // is listening.
      if (resolved) return;
      const codeMatch = stderrBuf.match(/Pairing code:\s+(\d{6})/);
      const waitingMatch = stderrBuf.includes('waiting for popup');
      if (codeMatch && waitingMatch) {
        resolved = true;
        clearTimeout(overallTimer);
        const code = codeMatch[1];
        // Connect as the popup with the matching `pair.<code>` subprotocol.
        const ws = new WS('ws://127.0.0.1:9224', ['darwinium.v1', `pair.${code}`]);
        const wsTimer = setTimeout(() => {
          ws.terminate();
          reject(new Error('ASSERTION 7 FAILED: pairing-WS open never fired within 5s'));
        }, 5000);
        let pairedFrame: { type: string; token: string; version: string } | null = null;
        ws.on('message', (data: Buffer) => {
          try {
            const parsed = JSON.parse(data.toString()) as { type: string; token: string; version: string };
            if (parsed.type === 'paired') {
              pairedFrame = parsed;
            }
          } catch (err) {
            clearTimeout(wsTimer);
            reject(new Error(`ASSERTION 7 FAILED: paired frame parse failed: ${(err as Error).message}`));
          }
        });
        ws.on('close', () => {
          clearTimeout(wsTimer);
          if (!pairedFrame) {
            reject(new Error('ASSERTION 7 FAILED: WS closed without {type:"paired"} frame'));
            return;
          }
          // Read the on-disk token to verify the paired frame's token matches.
          const dataDir = envPathsDataDir(fakeHome);
          const tokenPath = pathMod.join(dataDir, 'token');
          let onDiskToken = '';
          try {
            onDiskToken = fs.readFileSync(tokenPath, 'utf8').trim();
          } catch (err) {
            reject(new Error(`ASSERTION 7 FAILED: could not read token at ${tokenPath}: ${(err as Error).message}`));
            return;
          }
          if (!/^[a-f0-9]{64}$/.test(onDiskToken)) {
            reject(new Error(`ASSERTION 7 FAILED: on-disk token is not 64-hex: ${onDiskToken.slice(0, 16)}...`));
            return;
          }
          if (pairedFrame.token !== onDiskToken) {
            reject(new Error('ASSERTION 7 FAILED: paired-frame token differs from on-disk token'));
            return;
          }
          resolve({
            proc: installProc,
            pairingCode: code,
            capturedToken: onDiskToken,
            pairedFrame,
            fakeHome,
          });
        });
        ws.on('error', () => {
          /* close-after-error fires next */
        });
      }
    });

    installProc.on('exit', (code) => {
      if (resolved) return;
      clearTimeout(overallTimer);
      reject(new Error(`ASSERTION 7 FAILED: install exited (code=${code}) before printing pairing code. stderr: ${stderrBuf.slice(0, 500)}`));
    });
  });
}

/** ASSERTION 7 — install subcommand smoke. */
async function runInstallAssertion(): Promise<void> {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const pathMod = await import('node:path');
  await ensureFakeExtensionZip();
  const fakeHome = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'portal-mcp-smoke-'));
  // The test's bin path is the same one used for ASSERTIONs 1-6.
  const result = await spawnInstallAndPair(fakeHome, bin);
  // Wait for install to exit cleanly (it process.exit(0)s after the pair).
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        result.proc.kill();
      } catch {
        /* already exited */
      }
      reject(new Error('ASSERTION 7 FAILED: install did not exit within 5s after pair'));
    }, 5000);
    result.proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`ASSERTION 7 FAILED: install exited with code ${code} (expected 0)`));
        return;
      }
      resolve();
    });
  });
  // Stash the fake home for ASSERTIONs 8 + 9 to reuse.
  installAssertionState.fakeHome = fakeHome;
  installAssertionState.token = result.capturedToken;
  console.error('ASSERTION 7 PASSED: install printed pairing code, OOB pair completed, exit 0.');
}

/** Shared state across ASSERTIONs 7/8/9 (same fake-home tree). */
const installAssertionState: { fakeHome: string; token: string } = {
  fakeHome: '',
  token: '',
};

/** ASSERTION 8 — `doctor --json` shape against the post-install state. */
async function runDoctorJsonAssertion(): Promise<void> {
  const pathMod = await import('node:path');
  const fakeHome = installAssertionState.fakeHome;
  if (!fakeHome) throw new Error('ASSERTION 8 FAILED: ASSERTION 7 did not populate fakeHome');
  return new Promise<void>((resolve, reject) => {
    const doctorProc = spawn('node', [bin, 'doctor', '--json'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: fakeHome,
        APPDATA: pathMod.join(fakeHome, 'AppData', 'Roaming'),
        LOCALAPPDATA: pathMod.join(fakeHome, 'AppData', 'Local'),
      },
    });
    let stdoutBuf = '';
    let stderrBuf = '';
    const timer = setTimeout(() => {
      doctorProc.kill();
      reject(new Error(`ASSERTION 8 FAILED: doctor --json did not exit within 10s. stdout: ${stdoutBuf.slice(0, 200)}`));
    }, 10_000);
    doctorProc.stdout?.on('data', (chunk: Buffer) => { stdoutBuf += chunk.toString(); });
    doctorProc.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString(); });
    doctorProc.on('exit', (exitCode) => {
      clearTimeout(timer);
      // Stderr MUST be empty in --json mode.
      if (stderrBuf.length > 0) {
        reject(new Error(`ASSERTION 8 FAILED: doctor --json wrote to stderr: ${stderrBuf.slice(0, 300)}`));
        return;
      }
      // Stdout MUST be a single JSON line.
      const lines = stdoutBuf.split('\n').filter((l) => l.length > 0);
      if (lines.length !== 1) {
        reject(new Error(`ASSERTION 8 FAILED: expected 1 stdout line, got ${lines.length}`));
        return;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(lines[0]);
      } catch (err) {
        reject(new Error(`ASSERTION 8 FAILED: stdout is not valid JSON: ${(err as Error).message}`));
        return;
      }
      // Verify the expected shape.
      const expectedIds = [
        'binary.present',
        'token.mode',
        'token.parent.mode',
        'token.acl',
        'config.desktop.entry',
        'config.code.marketplace',
        'extension.reachable',
        'port.9224.bindable',
        'git.token-tree-warning',
      ];
      assert.equal(parsed.checks.length, 9, `Expected 9 checks, got ${parsed.checks.length}`);
      const actualIds = parsed.checks.map((c: any) => c.id);
      for (const id of expectedIds) {
        assert.ok(actualIds.includes(id), `Missing check id: ${id}; got: ${actualIds.join(',')}`);
      }
      const summed =
        parsed.summary.pass +
        parsed.summary.fail +
        parsed.summary.warn +
        parsed.summary.skipped;
      assert.equal(summed, 9, `summary counts must sum to 9, got ${summed}`);
      assert.equal(parsed.platform, process.platform, `platform mismatch`);
      // Exit code: 0 if no fails (warns OK).
      const expectedExit = parsed.summary.fail > 0 ? 1 : 0;
      assert.equal(exitCode, expectedExit, `exit code mismatch: expected ${expectedExit}, got ${exitCode}`);
      console.error('ASSERTION 8 PASSED: doctor --json shape correct, stderr empty, 9 checks present.');
      resolve();
    });
  });
}

/** ASSERTION 9 — rotate-token regenerates token + pair flow + new token differs. */
async function runRotateTokenAssertion(): Promise<void> {
  const fs = await import('node:fs');
  const pathMod = await import('node:path');
  const fakeHome = installAssertionState.fakeHome;
  const oldToken = installAssertionState.token;
  if (!fakeHome || !oldToken) throw new Error('ASSERTION 9 FAILED: prior assertions did not populate state');

  // Spawn rotate-token; flow is identical to install except no extension extract.
  const rotateProc = spawn('node', [bin, 'rotate-token'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: fakeHome,
      APPDATA: pathMod.join(fakeHome, 'AppData', 'Roaming'),
      LOCALAPPDATA: pathMod.join(fakeHome, 'AppData', 'Local'),
    },
  });

  let stderrBuf = '';
  let pairResolved = false;
  let newPairedFrame: { type: string; token: string; version: string } | null = null;

  await new Promise<void>((resolve, reject) => {
    const overallTimer = setTimeout(() => {
      if (pairResolved) return;
      rotateProc.kill();
      reject(new Error(`ASSERTION 9 FAILED: rotate-token did not print pairing prompt within 10s. stderr: ${stderrBuf.slice(0, 500)}`));
    }, 10_000);

    rotateProc.stderr?.on('data', async (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      if (pairResolved) return;
      const codeMatch = stderrBuf.match(/Pairing code:\s+(\d{6})/);
      const waitingMatch = stderrBuf.includes('waiting for popup');
      if (codeMatch && waitingMatch) {
        pairResolved = true;
        clearTimeout(overallTimer);
        const code = codeMatch[1];
        const WS = (await import('ws')).default;
        const ws = new WS('ws://127.0.0.1:9224', ['darwinium.v1', `pair.${code}`]);
        const wsTimer = setTimeout(() => {
          ws.terminate();
          reject(new Error('ASSERTION 9 FAILED: pairing-WS open never fired within 5s'));
        }, 5000);
        ws.on('message', (data: Buffer) => {
          try {
            const parsed = JSON.parse(data.toString()) as { type: string; token: string; version: string };
            if (parsed.type === 'paired') {
              newPairedFrame = parsed;
            }
          } catch (err) {
            clearTimeout(wsTimer);
            reject(new Error(`ASSERTION 9 FAILED: paired frame parse failed: ${(err as Error).message}`));
          }
        });
        ws.on('close', () => {
          clearTimeout(wsTimer);
          if (!newPairedFrame) {
            reject(new Error('ASSERTION 9 FAILED: WS closed without {type:"paired"} frame'));
            return;
          }
          resolve();
        });
        ws.on('error', () => {
          /* close-after-error fires next */
        });
      }
    });

    rotateProc.on('exit', (code) => {
      if (pairResolved) return;
      clearTimeout(overallTimer);
      reject(new Error(`ASSERTION 9 FAILED: rotate-token exited (code=${code}) before printing pairing code`));
    });
  });

  // Wait for rotate-token to exit 0 after the pair.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        rotateProc.kill();
      } catch {
        /* already exited */
      }
      reject(new Error('ASSERTION 9 FAILED: rotate-token did not exit within 5s after pair'));
    }, 5000);
    rotateProc.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`ASSERTION 9 FAILED: rotate-token exited with code ${code} (expected 0)`));
        return;
      }
      resolve();
    });
  });

  // Verify new token differs from old AND is on disk under the env-paths location.
  const dataDir = envPathsDataDir(fakeHome);
  const tokenPath = pathMod.join(dataDir, 'token');
  const newOnDisk = fs.readFileSync(tokenPath, 'utf8').trim();
  assert.ok(/^[a-f0-9]{64}$/.test(newOnDisk), `new on-disk token is not 64-hex: ${newOnDisk.slice(0, 16)}...`);
  assert.notEqual(newOnDisk, oldToken, 'rotate-token did not produce a new token');
  assert.ok(newPairedFrame, 'paired frame missing');
  assert.equal((newPairedFrame as { token: string }).token, newOnDisk, 'paired-frame token differs from on-disk token');

  installAssertionState.token = newOnDisk;
  console.error('ASSERTION 9 PASSED: rotate-token regenerated token, OOB pair completed, exit 0.');
}

proc.stderr.on('data', (_chunk: Buffer) => {
  // Stderr is fine — the binary redirects all logs there. Just observe.
  // Don't fail on stderr content.
});

proc.on('exit', (code) => {
  if (!listSeen) {
    console.error(`SMOKE TEST FAILED: process exited (code=${code}) before tools/list response`);
    console.error(`initSeen=${initSeen}, listSeen=${listSeen}`);
    clearTimeout(timeout);
    process.exit(1);
  }
});
