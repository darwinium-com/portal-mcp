# @darwinium/portal-extension

Chrome MV3 extension for Darwinium Portal MCP. Two manifest content scripts at
`document_start`:

- `entrypoints/portal-isolated.content.ts` — ISOLATED-world (default). Owns
  `chrome.runtime.sendMessage`. Phase 1 exposes `bridgeRequest` on `window` for
  DevTools-driven testing.
- `entrypoints/portal-main.content.ts` — MAIN-world (`world: 'MAIN'`, Chromium
  only). Reads `window[Symbol.for('darwinium.pageCommands')]()` and answers
  `dwn-mcp-req` CustomEvents with `dwn-mcp-resp`.

## Phase 1 boundary

Service-worker WebSocket client is **NOT** in Phase 1. `entrypoints/background.ts`
is an empty stub. Phase 2 wires the SW (BRIDGE-03 / BRIDGE-04). Phase 1
verification path: dispatch `dwn-mcp-req` from the journey page's DevTools
console; observe `dwn-mcp-resp`. See `dwn_aphex/packages/portal-mcp/TESTING.md`.

## Build

```sh
yarn workspace @darwinium/portal-extension build
# produces .output/chrome-mv3/
```

Load via `chrome://extensions` → enable Developer Mode → Load Unpacked → point at
`.output/chrome-mv3/`.

## Manifest scope

- `host_permissions: ["https://*.darwinium.com/*", "https://*.int.darwinium.io/*"]` (NEVER `<all_urls>`).
  Defined once in `src/shared/hostPatterns.ts` and consumed by `wxt.config.ts`, both
  content-script `matches` arrays, and background.ts's re-injection tab filter, so the
  set cannot drift between them. `scripts/check-manifest.mjs --prod` asserts the built
  production manifest matches it exactly — a *missing* host is as breaking as an extra
  one, since the content scripts then never inject and the bridge silently never connects.
- `permissions: []` (Phase 1; Phase 2 adds `storage`, `tabs`, `alarms`)
- `minimum_chrome_version: 116` (forward-compat for MV3 SW WS keepalive)

## Wire format (locked by CONTEXT.md `<specifics>`)

- Request: `dwn-mcp-req` CustomEvent, detail `{ id (UUID), op, args? }`
- Response: `dwn-mcp-resp` CustomEvent, detail `{ id, result?, error? }`
- Symbol literal: `Symbol.for('darwinium.pageCommands')` — duplicated from
  aphex-frontend's `darwiniumPageCommandsSymbol.ts` (different bundle, can't import)

## Phase 1 testing

See `dwn_aphex/packages/portal-mcp/TESTING.md` Path A — page-side end-to-end via
DevTools console using `window.__darwiniumBridgeRequest`.
