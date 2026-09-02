#!/usr/bin/env node
/**
 * Post-build manifest assertion. Reads `.output/chrome-mv3/manifest.json` and,
 * with `--prod`, asserts `host_permissions` contains no `localhost` entries —
 * wxt.config.ts gates those on `import.meta.env.DEV`, and this is the tripwire
 * against a regressed gate shipping localhost scope to the Web Store (a
 * reviewer rejection vector and unintended cross-origin scope). Production
 * builds chain it via `package.json`: `wxt build && yarn check-manifest:prod`.
 * Dev mode (no `--prod`) is informational only — the dev manifest legitimately
 * includes `localhost` for the aphex-frontend dev server.
 *
 * Exit codes: 0 — assertion passes (or dev informational success);
 * 1 — manifest missing OR (in prod mode) any localhost entry present.
 * All output goes to stderr, keeping stdout free for pipe consumers.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProd = process.argv.includes('--prod');
const manifestPath = path.resolve(__dirname, '..', '.output', 'chrome-mv3', 'manifest.json');

if (!fs.existsSync(manifestPath)) {
  console.error(`check-manifest: manifest not found at ${manifestPath}. Run \`yarn build\` first.`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const hostPerms = Array.isArray(manifest.host_permissions) ? manifest.host_permissions : [];

if (isProd) {
  const localhostEntries = hostPerms.filter((p) => typeof p === 'string' && p.includes('localhost'));
  if (localhostEntries.length > 0) {
    console.error(
      `check-manifest: PRODUCTION BUILD has localhost host_permissions: ${JSON.stringify(localhostEntries)}`,
    );
    console.error(
      'check-manifest: production builds MUST NOT include localhost. Verify wxt.config.ts gates host_permissions on import.meta.env.DEV.',
    );
    process.exit(1);
  }
  // Beyond the localhost tripwire, assert the exact expected portal host set.
  // A *missing* host is as damaging as an extra one and far quieter: the content
  // scripts never inject on that domain and the bridge simply never comes up,
  // surfacing to the user only as a generic "refresh the connected portal tab".
  // Keep in sync with PORTAL_HOST_PATTERNS in src/shared/hostPatterns.ts.
  const EXPECTED_PROD_HOSTS = ['https://*.darwinium.com/*', 'https://*.int.darwinium.io/*'];
  const missing = EXPECTED_PROD_HOSTS.filter((p) => !hostPerms.includes(p));
  const unexpected = hostPerms.filter((p) => !EXPECTED_PROD_HOSTS.includes(p));
  if (missing.length > 0 || unexpected.length > 0) {
    if (missing.length > 0) {
      console.error(`check-manifest: PRODUCTION BUILD missing host_permissions: ${JSON.stringify(missing)}`);
    }
    if (unexpected.length > 0) {
      console.error(`check-manifest: PRODUCTION BUILD has unexpected host_permissions: ${JSON.stringify(unexpected)}`);
    }
    console.error(
      'check-manifest: production host_permissions must match PORTAL_HOST_PATTERNS in src/shared/hostPatterns.ts exactly.',
    );
    process.exit(1);
  }
  // Content scripts are gated by `matches`, NOT by host_permissions, so every
  // assertion above can pass while both content scripts still inject into
  // arbitrary origins. That is exactly how localhost shipped in a production
  // build. Assert each entrypoint's match set independently.
  const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  if (contentScripts.length === 0) {
    console.error('check-manifest: PRODUCTION BUILD has no content_scripts — the bridge cannot come up.');
    process.exit(1);
  }
  for (const [i, script] of contentScripts.entries()) {
    const matches = Array.isArray(script.matches) ? script.matches : [];
    const label = `content_scripts[${i}]${script.world ? ` (world: ${script.world})` : ''}`;
    const csMissing = EXPECTED_PROD_HOSTS.filter((p) => !matches.includes(p));
    const csUnexpected = matches.filter((p) => !EXPECTED_PROD_HOSTS.includes(p));
    if (csMissing.length > 0 || csUnexpected.length > 0) {
      if (csMissing.length > 0) {
        console.error(`check-manifest: PRODUCTION BUILD ${label} missing matches: ${JSON.stringify(csMissing)}`);
      }
      if (csUnexpected.length > 0) {
        console.error(`check-manifest: PRODUCTION BUILD ${label} has unexpected matches: ${JSON.stringify(csUnexpected)}`);
      }
      console.error(
        'check-manifest: production content_scripts matches must equal PORTAL_HOST_PATTERNS. Verify CONTENT_SCRIPT_MATCHES in src/shared/hostPatterns.ts is gated on import.meta.env.DEV.',
      );
      process.exit(1);
    }
  }

  console.error(
    `check-manifest: ✓ production manifest excludes localhost and matches the expected host set ` +
      `(host_permissions + ${contentScripts.length} content_scripts: ${JSON.stringify(hostPerms)})`,
  );
} else {
  const csMatches = (Array.isArray(manifest.content_scripts) ? manifest.content_scripts : []).map((s) => s.matches);
  console.error(`check-manifest: dev mode — host_permissions: ${JSON.stringify(hostPerms)}`);
  console.error(`check-manifest: dev mode — content_scripts matches: ${JSON.stringify(csMatches)}`);
}
