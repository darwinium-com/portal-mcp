/**
 * Build MCP Bundles (`.mcpb`) of the Darwinium Portal MCP server — one per
 * platform — plus, on request, the zero-terminal macOS hand-over folder.
 *
 * Run via the portal-mcp scripts:
 *   yarn package:mcpb                    # host platform only
 *   yarn package:mcpb --all              # every supported target
 *   yarn package:mcpb --target=win32-x64 # one specific target
 *   yarn package:macos                   # darwin-arm64 + the hand-over folder/zip
 *
 * ONE BUNDLE PER PLATFORM. The MCPB spec offers `mcp_config.platform_overrides`
 * for per-OS command differences, but each bundle still has to carry its own
 * compiled binary, and a bun `--compile` binary is ~22MB. Shipping all four in a
 * single bundle would mean an ~88MB download of which 75% is dead weight, so
 * each target gets its own single-platform bundle and `compatibility.platforms`
 * names exactly the one it runs on.
 *
 * Why a compiled binary rather than `"server": {"type": "node"}`: Claude Desktop
 * does not ship a Node runtime for mcpb extensions — it PATH-sniffs for one
 * (`/usr/local/bin`, `/opt/homebrew/bin`, `~/.nvm/versions/node/*​/bin`). On the
 * machine this bundle targets — a laptop with no developer tooling — that search
 * finds nothing and the extension dies at launch. `bun build --compile` removes
 * the prerequisite entirely, which is also why the manifest declares no
 * `compatibility.runtimes`.
 *
 * This script is stderr-only for progress and never writes to stdout, matching
 * the discipline in bundle-extension.mjs.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORTAL_MCP_ROOT = path.resolve(__dirname, '..');
const PORTAL_EXTENSION_ROOT = path.resolve(PORTAL_MCP_ROOT, '..', 'portal-extension');
const WORKSPACE_ROOT = path.resolve(PORTAL_MCP_ROOT, '..', '..', '..');

const BUILD_DIR = path.join(PORTAL_MCP_ROOT, 'build');
const MCPB_OUT_DIR = path.join(BUILD_DIR, 'mcpb');
const PAYLOAD_DIR = path.join(BUILD_DIR, 'DarwiniumPortalMCP');
const EXTENSION_OUT_DIR = path.join(PAYLOAD_DIR, '2 - chrome-extension');

/**
 * Canonical public URLs. Both store submissions require these to resolve over
 * HTTPS before review: Anthropic rejects an MCPB with a missing or incomplete
 * privacy policy outright, and the Chrome listing needs the same policy URL.
 */
const DOCS_URL = 'https://www.darwinium.com';
const PRIVACY_URL = 'https://www.darwinium.com/privacy-policy';
const SUPPORT_URL = 'https://www.darwinium.com/contact-us';

/**
 * The portal the START-HERE guide tells the user to open. Guide copy only.
 *
 * Defaults to a placeholder, not a real host: this source is published, and
 * naming an internal environment here both leaks it and sends public users to a
 * portal that is not theirs. Override per-build, via flag or environment:
 *   PORTAL_URL=https://<env>.example.com yarn package:macos
 *   yarn package:macos --portal-url=https://<env>.example.com
 */
const portalArg = process.argv.find((a) => a.startsWith('--portal-url='));
const TARGET_PORTAL_URL =
  (portalArg ? portalArg.slice('--portal-url='.length) : process.env.PORTAL_URL) ??
  'https://your-company.darwinium.com';

/**
 * Supported build targets. `platform` is the MCPB/Node platform id that goes
 * into `compatibility.platforms`; `binary` is the on-disk name, which must carry
 * the `.exe` suffix on Windows or Claude Desktop cannot exec it.
 */
const TARGETS = {
  'darwin-arm64': { bun: 'bun-darwin-arm64', platform: 'darwin', binary: 'portal-mcp', label: 'macos-arm64' },
  'darwin-x64': { bun: 'bun-darwin-x64', platform: 'darwin', binary: 'portal-mcp', label: 'macos-x64' },
  'win32-x64': { bun: 'bun-windows-x64', platform: 'win32', binary: 'portal-mcp.exe', label: 'windows-x64' },
  'linux-x64': { bun: 'bun-linux-x64', platform: 'linux', binary: 'portal-mcp', label: 'linux-x64' },
};

function log(msg) {
  console.error(`portal-mcp: package — ${msg}`);
}

function fail(msg) {
  console.error(`portal-mcp: package — ${msg}`);
  process.exit(1);
}

/** Run a command, streaming output; hard-fail on non-zero exit. */
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.error) fail(`${cmd} failed to start: ${res.error.message}`);
  if (res.status !== 0) fail(`${cmd} ${args.join(' ')} exited ${res.status}`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// -- argument parsing ------------------------------------------------------

const argv = process.argv.slice(2);
const wantsHandover = argv.includes('--handover');

/**
 * `node` (default) produces ONE cross-platform bundle; `bun` produces one
 * compiled binary per platform.
 *
 * Claude Desktop ships a Node runtime for extensions — Anthropic's docs state
 * "We ship Node.js with Claude Desktop" — so the compiled binary buys nothing
 * and costs a great deal: four uploads where the submission form takes one,
 * ~22-40MB each instead of ~1MB, an Apple Developer ID for notarisation, and a
 * bun toolchain to build at all. (Python is the runtime Claude Desktop does NOT
 * bundle; that is the case the compiled-binary advice actually applies to.)
 *
 * The bun path is kept for the zero-terminal sales hand-over bundle, which is
 * handed to people directly rather than installed from the directory.
 */
const runtimeArg = argv.find((a) => a.startsWith('--runtime='));
const RUNTIME = runtimeArg ? runtimeArg.slice('--runtime='.length) : 'node';
if (!['node', 'bun'].includes(RUNTIME)) {
  console.error(`portal-mcp: package — unknown --runtime=${RUNTIME}. Use "node" or "bun".`);
  process.exit(1);
}

/** Default to the host platform so a bare invocation produces something runnable here. */
function hostTargetKey() {
  const key = `${process.platform}-${process.arch}`;
  return TARGETS[key] ? key : 'darwin-arm64';
}

let selected;
if (argv.includes('--all')) {
  selected = Object.keys(TARGETS);
} else {
  const explicit = argv.filter((a) => a.startsWith('--target=')).map((a) => a.slice('--target='.length));
  // Accept the legacy `--target=bun-darwin-arm64` spelling the macOS script used.
  const normalised = explicit.map((t) => {
    if (TARGETS[t]) return t;
    const byBun = Object.keys(TARGETS).find((k) => TARGETS[k].bun === t);
    if (byBun) return byBun;
    return fail(`unknown --target=${t}. Supported: ${Object.keys(TARGETS).join(', ')}, or --all`);
  });
  selected = normalised.length > 0 ? normalised : [hostTargetKey()];
}

if (wantsHandover && selected.some((t) => TARGETS[t].platform !== 'darwin')) {
  fail('--handover produces the macOS double-click folder and only applies to a darwin target.');
}

// -- preflight -------------------------------------------------------------

const mcpPkg = readJson(path.join(PORTAL_MCP_ROOT, 'package.json'));
const extPkg = readJson(path.join(PORTAL_EXTENSION_ROOT, 'package.json'));
const VERSION = mcpPkg.version;

if (extPkg.version !== VERSION) {
  fail(
    `version drift — portal-extension@${extPkg.version} but portal-mcp@${VERSION}. ` +
      'Bump both to the same value before packaging.',
  );
}

if (RUNTIME === 'bun' && spawnSync('bun', ['--version'], { stdio: 'ignore' }).status !== 0) {
  fail('`bun` not found on PATH. Install it from https://bun.sh — it compiles the standalone binary.');
}

log(`building v${VERSION} for: ${selected.join(', ')}`);

fs.rmSync(BUILD_DIR, { recursive: true, force: true });
fs.mkdirSync(MCPB_OUT_DIR, { recursive: true });

// -- build the extension once (check-manifest:prod is chained by its build) --

log('building portal-extension (production manifest)...');
run('yarn', ['workspace', '@darwinium/portal-extension', 'build'], { cwd: WORKSPACE_ROOT });

log('zipping portal-extension...');
run('yarn', ['workspace', '@darwinium/portal-extension', 'zip'], { cwd: WORKSPACE_ROOT });

// Not a lifecycle hook (see bundle-extension.mjs) — invoke it explicitly, or
// extension-bundle/extension.zip stays the small smoke-test stub checked into
// git rather than the extension just built above.
log('bundling extension zip into extension-bundle/...');
run('node', [path.join(PORTAL_MCP_ROOT, 'scripts', 'bundle-extension.mjs')], { cwd: PORTAL_MCP_ROOT });

// Vendored instructions must be current before the binary is compiled — the
// static fallback is baked into it.
log('refreshing vendored instructions...');
run('node', [path.join(PORTAL_MCP_ROOT, 'scripts', 'vendor-instructions.mjs')], { cwd: PORTAL_MCP_ROOT });

// -- per-target bundle -----------------------------------------------------

const built = [];

if (RUNTIME === 'node') {
  // One bundle, every platform. Dependencies are inlined by tsdown
  // (PORTAL_MCP_BUNDLE_DEPS), so the bundle carries no node_modules tree.
  const stagingDir = path.join(BUILD_DIR, '.mcpb-staging-node');
  const serverDir = path.join(stagingDir, 'server');
  fs.mkdirSync(serverDir, { recursive: true });

  log('[node] building with dependencies inlined...');
  run('node', ['-e', "process.exit(0)"], { cwd: PORTAL_MCP_ROOT });
  run('npx', ['tsdown'], {
    cwd: PORTAL_MCP_ROOT,
    env: { ...process.env, PORTAL_MCP_BUNDLE_DEPS: '1' },
  });

  // Layout matters: bundleResourceRoot() resolves two levels up from the chunk
  // directory, so dist/bin must sit under server/ for server/extension-bundle
  // to be found. Keep it as dist/bin, not a flattened index.js.
  fs.cpSync(path.join(PORTAL_MCP_ROOT, 'dist', 'bin'), path.join(serverDir, 'dist', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(serverDir, 'extension-bundle'), { recursive: true });
  fs.copyFileSync(
    path.join(PORTAL_MCP_ROOT, 'extension-bundle', 'extension.zip'),
    path.join(serverDir, 'extension-bundle', 'extension.zip'),
  );
  fs.copyFileSync(path.join(PORTAL_EXTENSION_ROOT, 'public', 'icon', '128.png'), path.join(stagingDir, 'icon.png'));

  fs.writeFileSync(path.join(stagingDir, 'manifest.json'), JSON.stringify(buildNodeManifest(), null, 2) + '\n');

  const mcpbPath = path.join(MCPB_OUT_DIR, `DarwiniumPortalMCP-${VERSION}.mcpb`);
  log('[node] packing .mcpb...');
  run('npx', ['-y', '@anthropic-ai/mcpb', 'pack', stagingDir, mcpbPath], { cwd: PORTAL_MCP_ROOT });

  built.push({ key: 'node', mcpbPath, stagingDir, target: { platform: 'all' } });
}

for (const key of RUNTIME === 'bun' ? selected : []) {
  const target = TARGETS[key];
  const stagingDir = path.join(BUILD_DIR, `.mcpb-staging-${key}`);
  const serverDir = path.join(stagingDir, 'server');
  fs.mkdirSync(serverDir, { recursive: true });

  const binaryPath = path.join(serverDir, target.binary);
  log(`[${key}] compiling standalone binary...`);
  run(
    'bun',
    ['build', 'src/bin/portal-mcp.ts', '--compile', '--minify', `--target=${target.bun}`, '--outfile', binaryPath],
    { cwd: PORTAL_MCP_ROOT },
  );
  fs.chmodSync(binaryPath, 0o755);

  // bun emits a linker-signed ad-hoc signature, which arm64 macOS requires to
  // exec at all. Verify rather than re-sign: `codesign --force` would replace a
  // valid signature and any failure here means the binary will not launch.
  // Only meaningful for a darwin target built on a darwin host — `codesign` does
  // not exist elsewhere.
  if (target.platform === 'darwin' && process.platform === 'darwin') {
    const signCheck = spawnSync('codesign', ['-dv', binaryPath], { encoding: 'utf8' });
    if (signCheck.status !== 0) {
      fail(`[${key}] compiled binary is unsigned; macOS will refuse to exec it.\n${signCheck.stderr ?? ''}`);
    }
    log(`[${key}] binary signed (${/adhoc/.test(signCheck.stderr ?? '') ? 'adhoc' : 'signed'})`);
  }

  // Ship the extension zip beside the binary so the in-binary `install` command
  // still resolves it — bundlePaths.bundleResourceRoot() anchors on the
  // executable's directory when running compiled.
  fs.mkdirSync(path.join(serverDir, 'extension-bundle'), { recursive: true });
  fs.copyFileSync(
    path.join(PORTAL_MCP_ROOT, 'extension-bundle', 'extension.zip'),
    path.join(serverDir, 'extension-bundle', 'extension.zip'),
  );

  fs.copyFileSync(path.join(PORTAL_EXTENSION_ROOT, 'public', 'icon', '128.png'), path.join(stagingDir, 'icon.png'));

  fs.writeFileSync(
    path.join(stagingDir, 'manifest.json'),
    JSON.stringify(buildManifest(target), null, 2) + '\n',
  );

  const mcpbPath = path.join(MCPB_OUT_DIR, `DarwiniumPortalMCP-${VERSION}-${target.label}.mcpb`);
  log(`[${key}] packing .mcpb...`);
  run('npx', ['-y', '@anthropic-ai/mcpb', 'pack', stagingDir, mcpbPath], { cwd: PORTAL_MCP_ROOT });

  built.push({ key, mcpbPath, stagingDir, target });
}

/**
 * Shared manifest fields. Everything except the `server` block and
 * `compatibility` is identical across runtimes.
 */
function baseManifest() {
  return {
    manifest_version: '0.3',
    name: 'portal-mcp',
    display_name: 'Darwinium Portal MCP',
    version: VERSION,
    description: 'Connects Claude to your open Darwinium portal tab.',
    long_description:
      'Bridges Claude Desktop to the Darwinium portal tab open in your Chrome browser, so you can ask ' +
      'questions about what is on screen and drive the portal in plain language. It makes no connection ' +
      'to any Darwinium backend — your existing browser session does all the data access, and this ' +
      'server only ever sees what your own portal tab sees. Requires the companion Chrome extension.',
    author: { name: 'Darwinium', url: 'https://darwinium.com' },
    homepage: DOCS_URL,
    documentation: DOCS_URL,
    support: SUPPORT_URL,
    license: 'Apache-2.0',
    // Required for directory review. A missing or incomplete privacy policy is
    // an immediate rejection, and the README carries the matching section.
    privacy_policies: [PRIVACY_URL],
    keywords: ['darwinium', 'portal', 'fraud', 'browser'],
    icon: 'icon.png',
    // Mirrors src/server/tools.ts. Annotations live on the live tools/list
    // response; this array is the static listing shown before install.
    tools: [
      { name: 'get_page_commands', description: 'List the page commands available on the active portal tab' },
      { name: 'run_page_command', description: 'Invoke a named page command on the active portal tab' },
      { name: 'get_context', description: "Return the active portal page's instructions and current context" },
    ],
  };
}

/**
 * The cross-platform node bundle. `command: 'node'` resolves to the runtime
 * Claude Desktop ships, so this one file installs on macOS, Windows and Linux
 * with nothing preinstalled.
 */
function buildNodeManifest() {
  return {
    ...baseManifest(),
    server: {
      type: 'node',
      entry_point: 'server/dist/bin/portal-mcp.js',
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/server/dist/bin/portal-mcp.js', 'serve'],
        env: {},
      },
    },
    // No `runtimes` key: Claude Desktop's bundled Node runs this, so the user
    // needs nothing installed. Declaring a node range would gate installs on a
    // system Node that is never consulted.
    compatibility: { platforms: ['darwin', 'win32', 'linux'] },
  };
}

/** The mcpb manifest for one single-platform bundle. */
function buildManifest(target) {
  return {
    ...baseManifest(),
    server: {
      type: 'binary',
      entry_point: `server/${target.binary}`,
      mcp_config: {
        command: `\${__dirname}/server/${target.binary}`,
        args: ['serve'],
        env: {},
      },
    },
    // No `runtimes` key: the server is a self-contained compiled binary and
    // needs neither Node nor Python on the user's machine.
    compatibility: { platforms: [target.platform] },
  };
}

// -- support escape hatches ------------------------------------------------

// Two of doctor's checks report a cross on a perfectly healthy machine while
// Claude Desktop is running: it holds port 9224 itself, and the probe cannot
// complete a handshake against its own live server. Rather than have a
// non-technical user read that as a fault, the wrapper says which lines
// actually matter.
const CHECK_SETUP = `#!/bin/bash
# Prints a diagnostic report for the Darwinium Portal MCP. Send the output to
# whoever gave you this folder.
EXT_DIR="$HOME/Library/Application Support/Claude/Claude Extensions"
FOUND=$(find "$EXT_DIR" -maxdepth 3 -type f -name portal-mcp 2>/dev/null | head -1)
echo "Darwinium Portal MCP — setup check"
echo "=================================="
echo
if [ -z "$FOUND" ]; then
  echo "RESULT: the Claude Desktop extension is NOT installed."
  echo
  echo "Go back to START-HERE.html and do Step 1 — double-click the file"
  echo "named '1 - Darwinium Portal MCP.mcpb'."
else
  echo "Extension binary: $FOUND"
  echo
  "$FOUND" doctor
  echo
  echo "------------------------------------------------------------"
  echo "How to read this:"
  echo
  echo "  These should all have a tick:"
  echo "    binary.present, token.mode, token.parent.mode,"
  echo "    config.desktop.entry"
  echo
  echo "  These normally show a cross while Claude Desktop is open,"
  echo "  which is expected and not a fault:"
  echo "    port.9224.bindable, extension.reachable,"
  echo "    config.code.marketplace"
fi
echo
echo "Copy everything above and send it to whoever gave you this folder."
echo
echo "Press return to close this window."
read -r _
`;

const FIX_PERMISSIONS = `#!/bin/bash
# macOS marks files downloaded from the internet as "quarantined" and may refuse
# to open them. This clears that mark for this folder only.
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
xattr -dr com.apple.quarantine "$DIR"
echo "Done. Try opening the .mcpb file again."
echo
echo "Press return to close this window."
read -r _
`;

// -- macOS hand-over folder ------------------------------------------------

if (wantsHandover) {
  const darwin = built.find((b) => b.target.platform === 'darwin');
  fs.mkdirSync(EXTENSION_OUT_DIR, { recursive: true });

  // Named with a leading digit so the folder sorts into install order in Finder.
  fs.copyFileSync(darwin.mcpbPath, path.join(PAYLOAD_DIR, '1 - Darwinium Portal MCP.mcpb'));

  // A space-free destination: Chrome's Load Unpacked has been observed to fail on
  // the `~/Library/Application Support/...` path that `install` extracts to.
  log('copying unpacked extension...');
  fs.cpSync(path.join(PORTAL_EXTENSION_ROOT, '.output', 'chrome-mv3'), EXTENSION_OUT_DIR, { recursive: true });

  fs.writeFileSync(path.join(PAYLOAD_DIR, 'START-HERE.html'), renderGuide());
  fs.writeFileSync(path.join(PAYLOAD_DIR, 'Check-Setup.command'), CHECK_SETUP, { mode: 0o755 });
  fs.writeFileSync(path.join(PAYLOAD_DIR, 'Fix-Permissions.command'), FIX_PERMISSIONS, { mode: 0o755 });

  const zipPath = path.join(BUILD_DIR, `DarwiniumPortalMCP-${VERSION}-${darwin.target.label}.zip`);
  log('zipping hand-over archive...');
  // ditto, not `zip` — it preserves the executable bit and macOS metadata.
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', PAYLOAD_DIR, zipPath]);

  const sizeMb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
  console.error('');
  console.error(`  Hand this file over:  ${zipPath}  (${sizeMb} MB)`);
  console.error(`  Unzipped preview:     ${PAYLOAD_DIR}`);
}

// -- cleanup + summary -----------------------------------------------------

for (const { stagingDir } of built) {
  fs.rmSync(stagingDir, { recursive: true, force: true });
}

log('done.');
console.error('');
for (const { key, mcpbPath } of built) {
  const sizeMb = (fs.statSync(mcpbPath).size / 1024 / 1024).toFixed(1);
  console.error(`  ${key.padEnd(13)} ${mcpbPath}  (${sizeMb} MB)`);
}
console.error('');

// -- guide -----------------------------------------------------------------

function renderGuide() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Darwinium Portal MCP — Setup</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    max-width: 46rem; margin: 0 auto; padding: 2.5rem 1.5rem 5rem;
    color: #1a1a1a; background: #fff;
  }
  @media (prefers-color-scheme: dark) { body { color: #e8e8e8; background: #161616; } }
  h1 { font-size: 1.9rem; line-height: 1.2; margin: 0 0 .3rem; }
  .sub { color: #666; margin: 0 0 2.5rem; }
  @media (prefers-color-scheme: dark) { .sub { color: #999; } }
  h2 { font-size: 1.15rem; margin: 2.5rem 0 .75rem; display: flex; gap: .6rem; align-items: baseline; }
  .n {
    flex: none; width: 1.7rem; height: 1.7rem; border-radius: 50%;
    background: #2f6fdb; color: #fff; font-size: .9rem;
    display: inline-flex; align-items: center; justify-content: center;
  }
  ol, ul { padding-left: 1.3rem; }
  li { margin: .4rem 0; }
  code {
    font: .88em ui-monospace, SFMono-Regular, Menlo, monospace;
    background: rgba(127,127,127,.16); padding: .12em .4em; border-radius: 4px;
  }
  .callout {
    border-left: 3px solid #e0a030; background: rgba(224,160,48,.1);
    padding: .8rem 1rem; margin: 1.2rem 0; border-radius: 0 6px 6px 0;
  }
  .callout.blue { border-left-color: #2f6fdb; background: rgba(47,111,219,.1); }
  details { margin: .5rem 0; border-top: 1px solid rgba(127,127,127,.25); padding-top: .5rem; }
  summary { cursor: pointer; font-weight: 600; }
  footer { margin-top: 4rem; color: #666; font-size: .875rem; }
</style>
</head>
<body>

<h1>Darwinium Portal MCP</h1>
<p class="sub">Lets Claude see and drive your Darwinium portal. About five minutes to set up, once.</p>

<div class="callout blue">
  <strong>Before you start, check you have:</strong>
  <ul style="margin:.4rem 0 0">
    <li><strong>Google Chrome</strong> (version 116 or newer)</li>
    <li><strong>Claude Desktop</strong> — the Claude app, not the website</li>
    <li>A working login for <code>${TARGET_PORTAL_URL}</code></li>
  </ul>
</div>

<h2><span class="n">0</span> Move this folder somewhere permanent</h2>
<p>
  Drag the whole <strong>DarwiniumPortalMCP</strong> folder out of Downloads and into your
  <strong>Home</strong> folder now, before doing anything else.
</p>
<div class="callout">
  Chrome remembers the extension by its folder location. If you move or delete this folder
  later, the extension stops working — so put it somewhere you won't tidy it away.
</div>

<h2><span class="n">1</span> Install the Claude extension</h2>
<ol>
  <li>Double-click <strong>1 - Darwinium Portal MCP.mcpb</strong> in this folder.</li>
  <li>Claude Desktop opens to its Extensions screen. Click <strong>Install</strong>.</li>
</ol>
<p>That's the Claude half done. If nothing happens when you double-click, run
   <strong>Fix-Permissions.command</strong> in this folder and try again.</p>

<h2><span class="n">2</span> Install the Chrome extension</h2>
<ol>
  <li>Open Chrome and go to <code>chrome://extensions</code> (type it into the address bar).</li>
  <li>Turn on <strong>Developer mode</strong> — the switch in the top-right corner.</li>
  <li>Click <strong>Load unpacked</strong> — a button that appears in the top-left.</li>
  <li>Select the folder <strong>2 - chrome-extension</strong> from this folder, and click Select.</li>
</ol>
<p>You should now see <strong>Darwinium Portal MCP</strong> in your extensions list. Click the
   puzzle-piece icon in Chrome's toolbar and pin it so you can find it easily.</p>
<div class="callout">
  Chrome will warn you about developer-mode extensions each time it starts. That's expected
  here — click <strong>Keep</strong> or dismiss it.
</div>

<h2><span class="n">3</span> Connect the two</h2>
<ol>
  <li>In Chrome, open <a href="${TARGET_PORTAL_URL}">${TARGET_PORTAL_URL}</a> and log in.
      Leave that tab open and in front.</li>
  <li>Switch to Claude Desktop and start a <strong>brand-new chat</strong>.</li>
  <li>Ask it: <em>"What is my Darwinium pairing token?"</em></li>
  <li>Claude replies with a long string of letters and numbers. Copy it.</li>
  <li>Go back to Chrome, <strong>click on your portal tab first</strong>, then click the
      Darwinium Portal MCP icon in the toolbar.</li>
  <li>Paste the token into the box and click <strong>Save &amp; Connect</strong>.</li>
</ol>
<p>The popup should switch to <strong>Connected</strong>. You're done — ask Claude something
   about the page you're looking at.</p>
<div class="callout">
  Step 5 matters: the extension connects to whichever tab is in front when you click
  Save &amp; Connect. Make sure that's your portal tab.
</div>

<h2>If something isn't working</h2>

<details>
<summary>Claude says the extension isn't connected</summary>
<p>Click the extension icon in Chrome and check it says Connected. If it says Disconnected,
   click Connect while your portal tab is in front. If your Mac went to sleep, it can take
   up to 30 seconds to reconnect on its own.</p>
</details>

<details>
<summary>Claude doesn't know what a pairing token is</summary>
<p>Start a brand-new chat and ask again. Claude only receives the token when a conversation
   first opens, so an older chat won't have it. If it still doesn't, the extension from Step 1
   didn't install — check Claude Desktop's Settings &rarr; Extensions.</p>
</details>

<details>
<summary>Claude connects, but says the page isn't ready</summary>
<p>Reload the portal tab and try again. If it keeps happening, the portal environment may be
   running an older version than this tool expects — report it with the output of
   <strong>Check-Setup.command</strong>.</p>
</details>

<details>
<summary>The Darwinium tools vanish, or Claude says the server disconnected</summary>
<p>Only one copy of this tool can run at a time. Quit any other Claude app you have open —
   including Claude Code in a terminal — then quit Claude Desktop completely
   (<strong>Claude &rarr; Quit</strong>, not just closing the window) and reopen it.</p>
</details>

<details>
<summary>Anything else</summary>
<p>Double-click <strong>Check-Setup.command</strong> in this folder. It prints a diagnostic
   report — copy the whole thing and send it on.</p>
</details>

<footer>
  Version ${VERSION}. This tool talks only to the Darwinium tab already open in your browser —
  it makes no connection to any Darwinium server of its own, and the pairing token never leaves
  your Mac. Privacy policy: <a href="${PRIVACY_URL}">${PRIVACY_URL}</a>
</footer>

</body>
</html>
`;
}
