import { defineConfig } from 'tsdown';

/**
 * `PORTAL_MCP_BUNDLE_DEPS=1` inlines the runtime dependencies into the output.
 *
 * The npm build leaves them external — a consumer's install resolves them
 * normally, and inlining would bloat the tarball and defeat dedupe. The `.mcpb`
 * build sets this, because Claude Desktop runs the extension with its own
 * bundled Node and there is no `npm install` step inside a bundle: anything not
 * inlined has to ship as a `node_modules` tree instead.
 */
const bundleDeps = process.env.PORTAL_MCP_BUNDLE_DEPS === '1';

export default defineConfig({
  entry: ['src/bin/portal-mcp.ts'],
  outDir: 'dist/bin',
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  noExternal: bundleDeps ? [/^[^.]/] : undefined,
  clean: false, // package.json `clean` script handles dist/
  // tsdown 0.21+ auto-detects the source shebang (#!/usr/bin/env node on src/bin/portal-mcp.ts:1)
  // and forwards it to the output. Adding a `banner.js` shebang here would duplicate it.
  // Force `.js` extension (tsdown 0.21 defaults to `.mjs`); package has `type: module` so .js is ESM.
  outExtensions: () => ({ js: '.js' }),
  dts: false,
  sourcemap: true,
  minify: false,
});
