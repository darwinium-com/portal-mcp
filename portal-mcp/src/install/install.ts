/**
 * `npx @darwinium/portal-mcp install` — orchestrator.
 *
 * Sequence:
 *   1. migrate.maybeMigrate()       — legacy token-path move
 *   2. token: skip if exists, else generateAndWrite({silent:true})
 *   3. winAcl.lockAcl(TOKEN_PATH) AND winAcl.lockAcl(TOKEN_DIR)
 *   4. extract.extractBundledExtension(zip, EXTENSION_DIR)
 *   5. configMerge → write `.bak` then atomic temp+rename
 *   6. Print Claude Code marketplace + Chrome extension instructions
 *   7. oobPair.run({mode:'install', expectedToken: token})
 *   8. Success summary + process.exit(0)
 *
 * Security:
 *   - Token never echoed — generateAndWrite({silent:true}).
 *   - configMerge entry contains only `npx @darwinium/portal-mcp serve` —
 *     no token, no env.
 *   - `.bak` written via copyFileSync BEFORE temp-write; atomic fs.renameSync
 *     replaces target. Malformed pre-existing JSON → refusal.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TOKEN_DIR, TOKEN_PATH, EXTENSION_DIR } from '../token/paths.js';
import { generateAndWrite } from '../token/store.js';
import * as term from './term.js';
import * as migrate from './migrate.js';
import * as winAcl from './winAcl.js';
import * as extract from './extract.js';
import { bundledExtensionZipPath } from './bundlePaths.js';
import { mergeMcpServersEntry, type McpServerEntry } from './configMerge.js';
import * as oobPair from './oobPair.js';

/** Config entry — never includes the token; only the cli invocation. */
const MCP_ENTRY: McpServerEntry = {
  command: 'npx',
  args: ['-y', '@darwinium/portal-mcp', 'serve'],
};

const SERVER_NAME = 'darwinium-portal-mcp';

/** Resolve the platform-correct claude_desktop_config.json path. */
function resolveClaudeDesktopConfigPath(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Claude', 'claude_desktop_config.json');
  }
  // Linux fallback — Anthropic's documented location matches XDG_CONFIG_HOME default.
  return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

/** Read + parse claude_desktop_config.json. Returns null on ENOENT. */
function readConfigJson(configPath: string): unknown {
  if (!fs.existsSync(configPath)) return null;
  const raw = fs.readFileSync(configPath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    // Re-throw as a tagged error the caller can map to the user-facing fail line.
    throw new Error(`claude_desktop_config.json is not valid JSON: ${(err as Error).message}`);
  }
}

/** Atomic write: `.bak` (if pre-existing) → temp → rename. */
function writeConfigJsonAtomic(configPath: string, merged: object, existed: boolean): void {
  if (existed) {
    fs.copyFileSync(configPath, `${configPath}.bak`);
  }
  const tmpPath = `${configPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2), { mode: 0o644 });
  fs.renameSync(tmpPath, configPath);
}

/**
 * Apply the configMerge to claude_desktop_config.json. Emits exactly one
 * summary-line variant for the config row.
 */
function applyClaudeDesktopMerge(): void {
  const configPath = resolveClaudeDesktopConfigPath();
  const configDir = path.dirname(configPath);

  if (!fs.existsSync(configDir)) {
    // Claude Desktop not installed — warn and continue.
    term.warn(
      `config (Claude Desktop config dir not found at ${configDir} — install Claude Desktop or use the Claude Code marketplace path).`,
    );
    return;
  }

  let current: unknown;
  try {
    current = readConfigJson(configPath);
  } catch {
    // Refuse to overwrite invalid JSON.
    term.fail(`config (refusing to write — ${configPath} is not valid JSON; please fix or delete and re-run)`);
    process.exit(1);
  }

  let result: ReturnType<typeof mergeMcpServersEntry>;
  try {
    result = mergeMcpServersEntry(current, SERVER_NAME, MCP_ENTRY);
  } catch (err) {
    // mergeMcpServersEntry throws on non-object top-level — same fail line.
    term.fail(`config (refusing to write — ${configPath} is not a JSON object: ${(err as Error).message})`);
    process.exit(1);
  }

  const fileExisted = current !== null;
  if (!result.changed) {
    term.ok('config (existing match)');
    return;
  }

  writeConfigJsonAtomic(configPath, result.merged, fileExisted);
  if (result.existed) {
    term.ok(`config (updated darwinium-portal-mcp entry; .bak written)`);
  } else if (fileExisted) {
    term.ok(`config (added darwinium-portal-mcp entry to ${configPath}; .bak written)`);
  } else {
    // First-ever config file — there's no pre-existing content to back up.
    term.ok(`config (added darwinium-portal-mcp entry to ${configPath}; new file)`);
  }
}

/** Print the Claude Code + Chrome extension instructions block. */
function printPostInstallInstructions(): void {
  console.error('');
  term.info('Claude Code: run `/plugin marketplace add darwinium-com/portal-mcp-marketplace`');
  console.error('             then `/plugin install portal-mcp` from inside Claude Code.');
  console.error('');
  term.info('Chrome extension — pick one:');
  console.error('  (a) Web Store:  https://chromewebstore.google.com/detail/<placeholder-listing-url>');
  console.error('  (b) Unpacked:   chrome://extensions → enable Developer Mode →');
  console.error(`                  Load Unpacked → point at ${EXTENSION_DIR}`);
  console.error('');
}

/** Public entry point — invoked from the lazy-loaded `install` action in bin. */
export async function runInstall(_opts: { json?: boolean; yes?: boolean } = {}): Promise<void> {
  term.info('install starting...');

  // 1. Legacy token-path migration (silent on no-op).
  migrate.maybeMigrate(TOKEN_PATH);

  // 2. Token — skip generation if existing, else write silently.
  let token: string;
  if (fs.existsSync(TOKEN_PATH)) {
    token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    const aclSuffix = process.platform === 'win32' ? ', ACL locked' : '';
    term.ok(`token (existing at ${TOKEN_PATH}, mode 0600${aclSuffix})`);
  } else {
    token = generateAndWrite({ silent: true });
    const aclSuffix = process.platform === 'win32' ? ', ACL locked' : '';
    term.ok(`token (added at ${TOKEN_PATH}, mode 0600${aclSuffix})`);
  }

  // 3. Windows ACL on token + parent dir. Non-Windows: no-op.
  for (const p of [TOKEN_PATH, TOKEN_DIR]) {
    const r = winAcl.lockAcl(p);
    if (!r.ok) {
      term.warn(`Could not restrict ACLs on ${p}: ${r.error}. Run \`${r.cmd}\` manually.`);
    }
  }

  // 4. Extract bundled extension (idempotent).
  const extZip = bundledExtensionZipPath();
  try {
    const extResult = extract.extractBundledExtension(extZip, EXTENSION_DIR);
    if (extResult.extracted) {
      term.ok(`extension (extracted v${extResult.version} to ${EXTENSION_DIR})`);
    } else {
      term.ok(`extension (existing v${extResult.version})`);
    }
  } catch (err) {
    term.fail(
      `extension (extract failed: ${(err as Error).message}; bundled extension at ${extZip} is intact — re-run install)`,
    );
    process.exit(1);
  }

  // 5. claude_desktop_config.json additive merge.
  applyClaudeDesktopMerge();

  // 6. Post-install instructions.
  printPostInstallInstructions();

  // 7. Foreground OOB pair — blocks until paired or SIGINT.
  await oobPair.run({ mode: 'install', expectedToken: token });

  // 8. Success summary. Read the manifest of the just-extracted extension to
  // get its version for the success line. If it's missing for any reason,
  // emit the version-less variant.
  let extVersionForSuccess = '';
  const manifestPath = path.join(EXTENSION_DIR, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      extVersionForSuccess = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version as string;
    } catch {
      /* fall through to versionless variant */
    }
  }
  if (extVersionForSuccess) {
    term.ok(`paired with extension (extension version ${extVersionForSuccess})`);
  } else {
    term.ok('paired with extension');
  }
  term.info('install complete. You can close this terminal.');
  process.exit(0);
}
