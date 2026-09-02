/**
 * Vendor `getStaticInstructions()` from `darwinium-instructions` into
 * `src/vendor/darwinium-instructions/` so portal-mcp can serve the static
 * Darwinium instruction block without a workspace dependency.
 *
 * Why vendor rather than depend:
 *
 * portal-mcp publishes to public npm as `@darwinium/portal-mcp`. A
 * `workspace:*` dependency cannot resolve off-monorepo, and publishing
 * darwinium-instructions as a second public package would mean versioning and
 * releasing it in lockstep for ~26KB of pure string constants. Vendoring keeps
 * the published dependency tree at the six real runtime deps and lets the
 * extracted public repo build standalone, with no workspace siblings.
 *
 * Safe to vendor because the source is pure data: `promptBlocks.ts` reads from
 * the committed, auto-generated `__generated__/assets.ts`, which
 * darwinium-instructions' own `scripts/buildAssets.mjs` inlines from `assets/`
 * specifically so the package has "zero filesystem dependency at runtime". No
 * imports leave the three copied files.
 *
 * Usage:
 *   node scripts/vendor-instructions.mjs           # write the vendored copies
 *   node scripts/vendor-instructions.mjs --check   # fail if they have drifted
 *
 * The vendored files ARE committed, following the same reasoning
 * darwinium-instructions applies to its own generated assets: a consumer
 * without a fresh build still gets a working `getStaticInstructions()`. `build`
 * chains the writing mode, so a stale copy cannot survive a build. Yarn 3 does
 * not run `pre*` scripts, so this is chained into `build` explicitly rather
 * than relying on `prebuild`.
 *
 * stderr-only, matching scripts/bundle-extension.mjs.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORTAL_MCP_ROOT = path.resolve(__dirname, '..');
const INSTRUCTIONS_SRC = path.resolve(PORTAL_MCP_ROOT, '..', 'darwinium-instructions', 'src');
const VENDOR_DIR = path.join(PORTAL_MCP_ROOT, 'src', 'vendor', 'darwinium-instructions');

/**
 * Files to copy, as paths relative to darwinium-instructions/src. The relative
 * layout is preserved verbatim because promptBlocks.ts imports its siblings by
 * relative specifier (`./__generated__/assets.js`, `./labelList.js`).
 */
const FILES = ['promptBlocks.ts', 'labelList.ts', path.join('__generated__', 'assets.ts')];

const checkOnly = process.argv.includes('--check');

function fail(msg) {
  console.error(`portal-mcp: vendor-instructions — ${msg}`);
  process.exit(1);
}

function banner(relPath) {
  return [
    `// VENDORED from packages/darwinium-instructions/src/${relPath.split(path.sep).join('/')}`,
    '// DO NOT EDIT BY HAND. Regenerate with `node scripts/vendor-instructions.mjs`',
    '// after changing the source. `yarn build` rewrites this file and',
    '// `--check` fails CI on drift.',
    '',
    '',
  ].join('\n');
}

/**
 * Outside the monorepo — in the extracted public repo — there is no
 * darwinium-instructions sibling to copy from, and there does not need to be:
 * the vendored files are committed. Treat that as success so `yarn build` works
 * in both trees, but only when every vendored file is actually present. A
 * missing source AND a missing copy is a real failure.
 */
if (!fs.existsSync(INSTRUCTIONS_SRC)) {
  const missing = FILES.filter((rel) => !fs.existsSync(path.join(VENDOR_DIR, rel)));
  if (missing.length > 0) {
    fail(
      `darwinium-instructions source not found at ${INSTRUCTIONS_SRC}, and the committed ` +
        `vendored copies are incomplete (missing: ${missing.map((m) => m.split(path.sep).join('/')).join(', ')}). ` +
        'Re-run this inside the monorepo and commit the result.',
    );
  }
  console.error(
    'portal-mcp: vendor-instructions — no monorepo source present; using the committed vendored copies.',
  );
  process.exit(0);
}

const drifted = [];

for (const relPath of FILES) {
  const source = path.join(INSTRUCTIONS_SRC, relPath);
  if (!fs.existsSync(source)) {
    fail(
      `expected source file missing: ${source}. ` +
        'darwinium-instructions may have been restructured — update FILES in this script.',
    );
  }

  const contents = banner(relPath) + fs.readFileSync(source, 'utf8');
  const target = path.join(VENDOR_DIR, relPath);

  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  if (existing === contents) continue;

  if (checkOnly) {
    drifted.push(relPath.split(path.sep).join('/'));
    continue;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  console.error(`portal-mcp: vendor-instructions — wrote src/vendor/darwinium-instructions/${relPath}`);
}

if (checkOnly && drifted.length > 0) {
  fail(
    `vendored instructions are stale: ${drifted.join(', ')}. ` +
      'Run `node scripts/vendor-instructions.mjs` and commit the result.',
  );
}

console.error(
  checkOnly
    ? 'portal-mcp: vendor-instructions — ✓ vendored copies match darwinium-instructions'
    : 'portal-mcp: vendor-instructions — done',
);
