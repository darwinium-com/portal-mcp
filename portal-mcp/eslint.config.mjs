import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

/**
 * Flat config (ESLint 9+). Replaces the former `.eslintrc.cjs`, which the pinned
 * ESLint 10 no longer reads at all — `yarn lint` failed to start rather than
 * failing on findings, so the stdout rule below was silently unenforced.
 */
export default defineConfig([
  { ignores: ['dist/**', 'build/**', 'extension-bundle/**'] },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: { console: 'readonly', process: 'readonly' },
    },
    rules: {
      // STDOUT DISCIPLINE — bans console.log / .info / .debug / .warn, allows
      // console.error only. The binary speaks newline-delimited JSON-RPC over
      // stdout, so a rogue console.log corrupts the MCP host's parser. The
      // entry-point redirect in src/bin/portal-mcp.ts is belt-and-braces
      // against dependencies we don't control; this rule catches our own code
      // at lint time.
      'no-console': ['error', { allow: ['error'] }],
    },
  },
  {
    // The entry point IS the stdout-discipline redirect: it assigns
    // console.error over console.log/.info/.debug/.warn before any import can
    // log. Those four assignments are the rule's implementation, so the rule
    // cannot apply to the file that implements it. Scoped to this one file, and
    // expressed as config rather than an inline disable comment so the carve-out
    // is visible in one place.
    files: ['src/bin/portal-mcp.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Vendored data (scripts/vendor-instructions.mjs) is copied verbatim from
    // darwinium-instructions. Lint findings here must be fixed at the source,
    // not in the copy — a fix applied here is overwritten by the next build.
    files: ['src/vendor/**'],
    rules: { 'no-console': 'off' },
  },
]);
