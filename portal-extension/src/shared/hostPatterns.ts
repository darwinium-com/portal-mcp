/**
 * Single source of truth for the URL match patterns the extension operates on.
 *
 * These patterns previously lived inline in four places — wxt.config.ts
 * (host_permissions), both content-script `matches` arrays, and the
 * chrome.tabs.query filter in background.ts's onInstalled re-injection. Adding a
 * domain meant editing all four; missing one produces a silent failure where the
 * bridge simply never comes up on that host.
 *
 * Kept dependency-free: wxt.config.ts imports this at config-evaluation time in
 * Node, before any browser globals exist.
 */

/**
 * Hosts the extension is allowed to reach in a production (Web Store) build.
 *
 * - `*.darwinium.com` — customer-facing portals.
 * - `*.int.darwinium.io` — internal Darwinium environments. Scoped to the
 *   `int.` subdomain rather
 *   than all of `darwinium.io` to keep the grant as narrow as the .com entry.
 *
 * NEVER `<all_urls>` — this list is an explicit override of WXT's auto-derive
 * from entrypoint `matches`, which exists to prevent scope drift.
 */
export const PORTAL_HOST_PATTERNS = ['https://*.darwinium.com/*', 'https://*.int.darwinium.io/*'] as const;

/**
 * The aphex-frontend dev server. Dev-only in `host_permissions` — production
 * builds must not request localhost scope (a Web Store reviewer rejection vector
 * and unintended cross-origin scope); `scripts/check-manifest.mjs --prod` is the
 * tripwire.
 */
export const LOCALHOST_PATTERNS = ['https://localhost/*', 'https://localhost:*/*'] as const;

/**
 * Content-script `matches` and the re-injection tab filter.
 *
 * Dev-gated exactly like `host_permissions` in wxt.config.ts. Content scripts are
 * gated by `matches` rather than `host_permissions`, so an ungated list here does
 * NOT show up in the host_permissions tripwire — a production build shipped both
 * content scripts (one of them `world: 'MAIN'`) matching `https://localhost/*`,
 * injecting into any localhost page on the user's machine. Narrow store scope is
 * the entire security claim of this extension, so the gate belongs here too, and
 * `scripts/check-manifest.mjs --prod` now asserts `content_scripts[].matches`
 * alongside `host_permissions`.
 *
 * Kept as one constant rather than gated at each call site because
 * background.ts's `chrome.tabs.query` re-injection filter must match the same
 * set the content scripts were registered for.
 */
export const CONTENT_SCRIPT_MATCHES = import.meta.env.DEV
  ? [...PORTAL_HOST_PATTERNS, ...LOCALHOST_PATTERNS]
  : [...PORTAL_HOST_PATTERNS];
