import { defineConfig } from 'wxt';

import { LOCALHOST_PATTERNS, PORTAL_HOST_PATTERNS } from './src/shared/hostPatterns';

/**
 * WXT MV3 manifest for the Darwinium Portal MCP extension. host_permissions is
 * explicitly overridden (never <all_urls>) — WXT would otherwise auto-derive it
 * from entrypoint `matches` arrays, and the explicit lock prevents scope drift.
 * scripts/check-manifest.mjs asserts the production manifest post-build.
 */
export default defineConfig({
  // WXT derives the zip name from the package name by stripping non-alphanumerics,
  // which turns `@darwinium/portal-extension` into `darwiniumportal-extension`.
  // Set it explicitly: this artifact is uploaded by hand to the Chrome Web Store,
  // so its filename should be unambiguous to whoever is holding it.
  // scripts/bundle-extension.mjs matches on the `-<version>-chrome.zip` suffix
  // rather than the name, so it is unaffected by this.
  zip: { name: 'darwinium-portal-extension' },
  manifest: {
    name: 'Darwinium Portal MCP',
    description:
      'Bridges the active *.darwinium.com tab to a local MCP server for external LLM clients (Claude Desktop, Claude Code).',
    permissions: ['storage', 'tabs', 'alarms', 'scripting'],
    // 'scripting' is required by chrome.scripting.executeScript in background.ts's
    // chrome.runtime.onInstalled re-injection of content scripts into already-open
    // *.darwinium.com tabs after an extension reload/update. Without this permission,
    // the API throws "Cannot access contents of url" even though host_permissions
    // covers the URL set. Re-injection is the standard MV3 pattern for surviving
    // extension updates; see
    // https://developer.chrome.com/docs/extensions/reference/api/scripting#executeScript.
    // NEVER <all_urls> — explicit override of WXT auto-derive. The pattern set
    // lives in src/shared/hostPatterns.ts so it cannot drift between here, the
    // two content-script `matches` arrays, and background.ts's re-injection filter.
    // localhost entries are gated on `import.meta.env.DEV` so production `wxt build`
    // ships ONLY PORTAL_HOST_PATTERNS. The localhost glob pair is needed in
    // dev so the SW can reach the aphex-frontend dev server at https://localhost:8000.
    // Enforced post-build by `scripts/check-manifest.mjs --prod` (chained from
    // `yarn build`), which exits 1 if any localhost entry survives a production build.
    host_permissions: import.meta.env.DEV
      ? [...PORTAL_HOST_PATTERNS, ...LOCALHOST_PATTERNS]
      : [...PORTAL_HOST_PATTERNS],
    // Chrome 116+ is required for the MV3 SW WS keepalive (any WS message
    // resets the SW idle timer from 116 on).
    minimum_chrome_version: '116',
  },
});
