/**
 * `npx @darwinium/portal-mcp doctor [--json]` — self-diagnostic.
 *
 * Runs nine checks in fixed order, produces a structured DoctorResult, and
 * emits either a human-readable stderr table OR a single JSON line on stdout
 * (the ONE explicit exception to the stdout-stays-clean discipline).
 *
 * Stable check IDs (must not change between releases; support tickets
 * reference these IDs verbatim):
 *
 *   binary.present              — the running program exists and is executable
 *   token.mode                  — TOKEN_PATH stat mode === 0o600
 *   token.parent.mode           — TOKEN_DIR stat mode === 0o700
 *   token.acl                   — Windows: inheritance broken; non-Win: skipped
 *   config.desktop.entry        — claude_desktop_config.json npx entry OR an
 *                                 installed `.mcpb` extension (macOS bundle)
 *   config.code.marketplace     — Claude Code marketplace plugin installed
 *   extension.reachable         — popup-bound extension answers WS handshake
 *   port.9224.bindable          — bind-test on 127.0.0.1:9224
 *   git.token-tree-warning      — TOKEN_DIR not inside a git work tree
 *
 * Exit codes:
 *   0 → no fails (warns and skips OK).
 *   1 → at least one non-warn fail.
 *
 * Stderr discipline:
 *   - default mode → stderr has the table; stdout is empty.
 *   - `--json` mode → stderr is empty; stdout has exactly one JSON line.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PROTOCOL_VERSION } from '../bridge/wireProtocol.js';
import { TOKEN_DIR, TOKEN_PATH, EXTENSION_DIR } from '../token/paths.js';
import { isPortInUse } from '../ws/killProcessOnPort.js';
import { probeBridgeHandshake } from '../ws/server.js';
import { selfPath } from './bundlePaths.js';
import * as winAcl from './winAcl.js';
import * as term from './term.js';

void EXTENSION_DIR; // referenced indirectly via doctor outputs; keep imported for stable surface.

/** Stable check IDs — support tickets reference these verbatim; do not rename. */
export type DoctorCheckId =
  | 'binary.present'
  | 'token.mode'
  | 'token.parent.mode'
  | 'token.acl'
  | 'config.desktop.entry'
  | 'config.code.marketplace'
  | 'extension.reachable'
  | 'port.9224.bindable'
  | 'git.token-tree-warning';

/** Per-check result. `ok: null` = skipped (e.g. token.acl on non-Windows). */
export interface DoctorCheck {
  id: DoctorCheckId;
  ok: boolean | null;
  /** Warns are `ok:false, level:'warn'` so they don't fail the run. */
  level?: 'warn';
  detail: string;
}

/** Full doctor result emitted as the `--json` stdout payload. */
export interface DoctorResult {
  version: string;
  platform: NodeJS.Platform;
  checks: DoctorCheck[];
  warnings: { id: string; detail: string }[];
  summary: { pass: number; fail: number; warn: number; skipped: number };
}

const CHECK_ID_PAD = 28;

// -- individual check implementations -------------------------------------

function checkBinaryPresent(): DoctorCheck {
  // selfPath(), not argv[1] — under a compiled binary argv[1] is a virtual
  // `/$bunfs/` path that never exists on disk.
  const argvPath = selfPath();
  if (!argvPath || !fs.existsSync(argvPath)) {
    return { id: 'binary.present', ok: false, detail: `not found: ${argvPath || '<undefined>'}` };
  }
  try {
    const stats = fs.statSync(argvPath);
    if ((stats.mode & 0o111) === 0) {
      return {
        id: 'binary.present',
        ok: false,
        detail: `${argvPath} (not executable; mode ${(stats.mode & 0o777).toString(8)})`,
      };
    }
    return { id: 'binary.present', ok: true, detail: argvPath };
  } catch (err) {
    return { id: 'binary.present', ok: false, detail: `${argvPath} (${(err as Error).message})` };
  }
}

function checkTokenMode(): DoctorCheck {
  if (!fs.existsSync(TOKEN_PATH)) {
    return {
      id: 'token.mode',
      ok: false,
      detail: `file missing at ${TOKEN_PATH}; run \`npx @darwinium/portal-mcp install\``,
    };
  }
  const mode = fs.statSync(TOKEN_PATH).mode & 0o777;
  if (mode === 0o600) return { id: 'token.mode', ok: true, detail: '0600' };
  return {
    id: 'token.mode',
    ok: false,
    detail: `expected 0600, got ${mode.toString(8).padStart(4, '0')}`,
  };
}

function checkTokenParentMode(): DoctorCheck {
  if (!fs.existsSync(TOKEN_DIR)) {
    return {
      id: 'token.parent.mode',
      ok: false,
      detail: `directory missing at ${TOKEN_DIR}`,
    };
  }
  const mode = fs.statSync(TOKEN_DIR).mode & 0o777;
  if (mode === 0o700) return { id: 'token.parent.mode', ok: true, detail: '0700' };
  return {
    id: 'token.parent.mode',
    ok: false,
    detail: `expected 0700, got ${mode.toString(8).padStart(4, '0')}`,
  };
}

function checkTokenAcl(): DoctorCheck {
  if (process.platform !== 'win32') {
    return { id: 'token.acl', ok: null, detail: 'skipped (non-Windows)' };
  }
  if (!fs.existsSync(TOKEN_PATH)) {
    return {
      id: 'token.acl',
      ok: false,
      detail: `token file missing at ${TOKEN_PATH}`,
    };
  }
  const state = winAcl.readAclState(TOKEN_PATH);
  if (state.inheritanceBroken) {
    return { id: 'token.acl', ok: true, detail: 'inheritance:r' };
  }
  return {
    id: 'token.acl',
    ok: false,
    detail:
      state.raw
        .split('\n')
        .find((l) => /\(I\)/.test(l))
        ?.trim() ?? 'inherited ACEs present',
  };
}

function resolveClaudeDesktopConfigPath(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Claude', 'claude_desktop_config.json');
  }
  return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

/**
 * Manifest `name` values a `.mcpb` bundle of this server may carry. Claude
 * Desktop derives the install directory from author + name
 * (`local.mcpb.darwinium.portal-mcp`), so the directory name is not a stable
 * key — we read each manifest instead.
 */
const MCPB_MANIFEST_NAMES = new Set(['portal-mcp', 'darwinium-portal-mcp']);

/** Narrow an unknown JSON value to an object without widening to `any`. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Locate a `.mcpb` install of this server under Claude Desktop's extensions
 * directory. The macOS bundle installs that way, which writes nothing to
 * `claude_desktop_config.json` — so an mcpb install is a valid, complete
 * registration even though the npx entry is absent.
 */
function findMcpbInstallDir(): string | null {
  const extensionsDir = path.join(path.dirname(resolveClaudeDesktopConfigPath()), 'Claude Extensions');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(extensionsDir, entry.name);
    let manifest: Record<string, unknown> | null;
    try {
      manifest = asRecord(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')));
    } catch {
      continue;
    }
    const name = manifest?.name;
    if (typeof name === 'string' && MCPB_MANIFEST_NAMES.has(name)) return dir;
  }
  return null;
}

function checkConfigDesktopEntry(): DoctorCheck {
  const configPath = resolveClaudeDesktopConfigPath();
  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    return {
      id: 'config.desktop.entry',
      ok: false,
      level: 'warn',
      detail: 'Claude Desktop config dir not found; install Claude Desktop or use the Claude Code marketplace path',
    };
  }

  // An mcpb install satisfies this check on its own — check it first so the
  // macOS bundle passes without an npx entry.
  const mcpbDir = findMcpbInstallDir();

  if (!fs.existsSync(configPath)) {
    if (mcpbDir) return { id: 'config.desktop.entry', ok: true, detail: `mcpb extension at ${mcpbDir}` };
    return {
      id: 'config.desktop.entry',
      ok: false,
      level: 'warn',
      detail: 'absent — run install',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return { id: 'config.desktop.entry', ok: false, detail: 'not valid JSON' };
  }
  const entry = asRecord(asRecord(asRecord(parsed)?.mcpServers)?.['darwinium-portal-mcp']);
  if (!entry) {
    if (mcpbDir) return { id: 'config.desktop.entry', ok: true, detail: `mcpb extension at ${mcpbDir}` };
    return { id: 'config.desktop.entry', ok: false, detail: 'absent — run install' };
  }
  const args = entry.args;
  if (entry.command !== 'npx' || !Array.isArray(args) || !args.includes('@darwinium/portal-mcp')) {
    if (mcpbDir) return { id: 'config.desktop.entry', ok: true, detail: `mcpb extension at ${mcpbDir}` };
    return {
      id: 'config.desktop.entry',
      ok: false,
      detail: 'mismatch: command/args',
    };
  }
  return { id: 'config.desktop.entry', ok: true, detail: configPath };
}

/**
 * Detect a Claude Code registration by either supported route.
 *
 * Two routes exist and both are documented, so checking only one produces a
 * permanent warn on a perfectly healthy install:
 *   - the plugin, which unpacks under `~/.claude/plugins/`; and
 *   - `claude mcp add`, which writes an `mcpServers` entry to `~/.claude.json`.
 *
 * Marketplace name is `darwinium` and plugin name is `portal-mcp`, per
 * `.claude-plugin/marketplace.json`. The cache layout nests a version directory
 * below the plugin name, so this tests the plugin directory rather than a leaf.
 */
function checkConfigCodeMarketplace(): DoctorCheck {
  const claudeDir = path.join(os.homedir(), '.claude');
  const pluginCandidates = [
    path.join(claudeDir, 'plugins', 'cache', 'darwinium', 'portal-mcp'),
    path.join(claudeDir, 'plugins', 'marketplaces', 'darwinium'),
  ];
  for (const candidate of pluginCandidates) {
    if (fs.existsSync(candidate)) {
      return { id: 'config.code.marketplace', ok: true, detail: candidate };
    }
  }

  // `claude mcp add` route. The entry may sit at the top level or under a
  // per-project key, so accept it anywhere an `mcpServers` map mentions us.
  const claudeJson = path.join(os.homedir(), '.claude.json');
  if (fs.existsSync(claudeJson)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
      if (hasPortalMcpServerEntry(parsed)) {
        return { id: 'config.code.marketplace', ok: true, detail: `${claudeJson} (claude mcp add)` };
      }
    } catch {
      /* malformed ~/.claude.json is not this check's business — fall through to the warn. */
    }
  }

  return {
    id: 'config.code.marketplace',
    ok: false,
    level: 'warn',
    detail:
      'not found — run `claude mcp add darwinium-portal-mcp -- npx -y @darwinium/portal-mcp serve`, ' +
      'or `/plugin marketplace add darwinium-com/portal-mcp` then `/plugin install portal-mcp@darwinium`',
  };
}

/** True if any `mcpServers` map anywhere in the object graph names our server. */
function hasPortalMcpServerEntry(value: unknown, depth = 0): boolean {
  const record = asRecord(value);
  if (!record || depth > 3) return false;
  const servers = asRecord(record.mcpServers);
  if (servers && servers['darwinium-portal-mcp'] !== undefined) return true;
  return Object.values(record).some((child) => hasPortalMcpServerEntry(child, depth + 1));
}

async function checkExtensionReachable(): Promise<DoctorCheck> {
  if (!fs.existsSync(TOKEN_PATH)) {
    return {
      id: 'extension.reachable',
      ok: false,
      detail: 'token file missing — run install first',
    };
  }
  const token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  const start = Date.now();
  // Uses the shared raw-TCP handshake rather than a `ws` client: under
  // `bun build --compile` the ws CLIENT is Bun's native WebSocket, which cannot
  // connect to our own server, so a ws-based probe reported this check as
  // failing on every healthy machine in the shipped binary.
  const reachable = await probeBridgeHandshake(token);
  if (reachable) {
    return { id: 'extension.reachable', ok: true, detail: `${Date.now() - start}ms` };
  }
  return {
    id: 'extension.reachable',
    ok: false,
    detail: 'no portal-mcp bridge answered on 127.0.0.1:9224 — is Claude Desktop running?',
  };
}

async function checkPortBindable(): Promise<DoctorCheck> {
  const inUse = await isPortInUse(9224);
  if (!inUse) return { id: 'port.9224.bindable', ok: true, detail: 'available' };
  return {
    id: 'port.9224.bindable',
    ok: false,
    detail:
      'EADDRINUSE — another process holds 127.0.0.1:9224. Run `lsof -i :9224` (mac/linux) or `netstat -ano | findstr 9224` (Windows) to identify it.',
  };
}

function checkGitTokenTreeWarning(): DoctorCheck {
  // Bare repos return exit 0 + stdout 'false'. We require stdout to be
  // exactly 'true' before warning.
  const res = spawnSync('git', ['-C', TOKEN_DIR, 'rev-parse', '--is-inside-work-tree'], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (res.status !== 0 || (res.stdout?.toString().trim() ?? '') !== 'true') {
    return { id: 'git.token-tree-warning', ok: true, detail: 'not in git tree' };
  }
  const topRes = spawnSync('git', ['-C', TOKEN_DIR, 'rev-parse', '--show-toplevel'], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  const top = topRes.stdout?.toString().trim() ?? '<unknown>';
  return {
    id: 'git.token-tree-warning',
    ok: false,
    level: 'warn',
    detail: `token file is inside a git work tree at ${top}; .gitignore recommended`,
  };
}

/** Run all 9 checks in order. */
async function runAllChecks(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  checks.push(checkBinaryPresent());
  checks.push(checkTokenMode());
  checks.push(checkTokenParentMode());
  checks.push(checkTokenAcl());
  checks.push(checkConfigDesktopEntry());
  checks.push(checkConfigCodeMarketplace());
  checks.push(await checkExtensionReachable());
  checks.push(await checkPortBindable());
  checks.push(checkGitTokenTreeWarning());
  return checks;
}

/** Compute summary counts from the check list. */
function summarize(checks: DoctorCheck[]): DoctorResult['summary'] {
  let pass = 0;
  let fail = 0;
  let warn = 0;
  let skipped = 0;
  for (const c of checks) {
    if (c.ok === null) skipped += 1;
    else if (c.ok === true) pass += 1;
    else if (c.level === 'warn') warn += 1;
    else fail += 1;
  }
  return { pass, fail, warn, skipped };
}

/** Print the human-readable table to stderr. */
function printTable(result: DoctorResult): void {
  term.info(`doctor v${PROTOCOL_VERSION}`);
  term.info(`platform: ${result.platform}`);
  console.error('');
  for (const c of result.checks) {
    const id = c.id.padEnd(CHECK_ID_PAD, ' ');
    if (c.ok === null) {
      console.error(`  ${term.dim('-')}  ${id} (${c.detail})`);
    } else if (c.ok === true) {
      term.ok(`${id} ${c.detail}`);
    } else if (c.level === 'warn') {
      term.warn(`${id} ${c.detail}`);
    } else {
      term.fail(`${id} ${c.detail}`);
    }
  }
  console.error('');
  term.info(
    `${term.bold('Summary:')} ${result.summary.pass} pass, ${result.summary.fail} fail, ${result.summary.warn} warn`,
  );
}

/** Public entry — invoked from the lazy-loaded `doctor` action in bin. */
export async function runDoctor(opts: { json?: boolean } = {}): Promise<void> {
  const checks = await runAllChecks();
  const summary = summarize(checks);
  const warnings = checks
    .filter((c) => c.level === 'warn' && c.ok === false)
    .map((c) => ({ id: c.id, detail: c.detail }));
  const result: DoctorResult = {
    version: PROTOCOL_VERSION,
    platform: process.platform,
    checks,
    warnings,
    summary,
  };

  if (opts.json) {
    // The ONE place we intentionally write to stdout. Stderr stays empty.
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    printTable(result);
  }

  // Exit 1 only on non-warn fails. Warns + skips don't fail the run.
  process.exit(summary.fail > 0 ? 1 : 0);
}
