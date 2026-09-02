/**
 * Pre-build script: copy the WXT-built portal-extension zip artifact into
 * `dwn_aphex/packages/portal-mcp/extension-bundle/extension.zip` so the npm
 * package's `files` array picks it up.
 *
 * Extension/binary version drift would let us ship a binary with a stale
 * extension. We hard-fail here when the two `package.json` `version` fields
 * disagree, so a release engineer cannot accidentally bundle the wrong
 * artifact.
 *
 * Run explicitly, never as a lifecycle hook:
 *   yarn bundle-extension
 *
 * It used to be wired as `prebuild`, which was the worst of both worlds: Yarn 3
 * does not run `pre*` scripts so it never fired here, while npm DOES run them,
 * so a plain `npm install && npm run build` in the extracted public repo failed
 * on the missing wxt artifact before it could compile anything. `build-mcpb.mjs`
 * invokes this directly when it needs a fresh zip.
 *
 * This script is stderr-only (no stdout writes — keeps stdout clean in case
 * prebuild is ever piped into a parent's stdout chain).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORTAL_MCP_ROOT = path.resolve(__dirname, '..');
const PORTAL_EXTENSION_ROOT = path.resolve(__dirname, '..', '..', 'portal-extension');

function readVersion(packageJsonPath) {
  const raw = fs.readFileSync(packageJsonPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (typeof parsed.version !== 'string') {
    throw new Error(`portal-mcp: bundle-extension — ${packageJsonPath} has no version field`);
  }
  return parsed.version;
}

function fail(msg) {
  console.error(`portal-mcp: bundle-extension — ${msg}`);
  process.exit(1);
}

const extensionVersion = readVersion(path.join(PORTAL_EXTENSION_ROOT, 'package.json'));
const binaryVersion = readVersion(path.join(PORTAL_MCP_ROOT, 'package.json'));

if (extensionVersion !== binaryVersion) {
  fail(
    `version drift — portal-extension@${extensionVersion} but portal-mcp@${binaryVersion}. ` +
      'Bump both to the same value before bundling.',
  );
}

// Locate the wxt zip artifact. WXT names the zip
// `<package-name>-<version>-chrome.zip` under `.output/`. Match by the version
// suffix to avoid coupling to the package name.
const wxtOutputDir = path.join(PORTAL_EXTENSION_ROOT, '.output');
if (!fs.existsSync(wxtOutputDir)) {
  fail(
    `wxt zip artifact not found. Run \`yarn workspace @darwinium/portal-extension zip\` first ` +
      `(no .output/ at ${wxtOutputDir}).`,
  );
}

const versionSuffixRe = new RegExp(
  `-${extensionVersion.replace(/\./g, '\\.')}-chrome\\.zip$`,
);
const candidates = fs
  .readdirSync(wxtOutputDir)
  .filter((entry) => versionSuffixRe.test(entry));

if (candidates.length === 0) {
  fail(
    `wxt zip artifact not found. Run \`yarn workspace @darwinium/portal-extension zip\` first ` +
      `(no file matching -${extensionVersion}-chrome.zip in ${wxtOutputDir}).`,
  );
}

const sourceZip = path.join(wxtOutputDir, candidates[0]);
const targetDir = path.join(PORTAL_MCP_ROOT, 'extension-bundle');
const targetZip = path.join(targetDir, 'extension.zip');

fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(sourceZip, targetZip);

console.error(
  `portal-mcp: bundle-extension — copied portal-extension v${extensionVersion} zip to extension-bundle/extension.zip`,
);
