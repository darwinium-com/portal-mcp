# ADR-001: Static MCP Tool Surface

**Status:** Accepted
**Date:** 2026-05-01
**Deciders:** Darwinium engineering

## Context

The MCP TypeScript SDK supports `notifications/tools/list_changed` for dynamically
updating the tool surface advertised to MCP hosts. However, the two MCP hosts that
Darwinium customers will use (Claude Desktop and Claude Code) cache `tools/list`
responses across navigations and do not reliably honor `tools/list_changed`:

- claude-code#7519 — host caches tool list across navigations
- claude-code#13646 — list_changed notifications not refreshing the cached list
- claude-code#3095 — MCP server cache not refreshing after rebuild

Reference implementations confirm the same pattern:

- BrowserMCP (`github.com/BrowserMCP/mcp`) ships with a fixed three-tool surface
  (`browser_navigate`, `browser_click`, `browser_screenshot`) and routes dynamism
  through tool returns rather than schema mutation.
- Microsoft Playwright MCP (`github.com/microsoft/playwright-mcp`) — same shape,
  the original tool inspiration.

Furthermore, Darwinium's existing in-portal `ChatModal` (slack-nlp-backed) ALREADY
uses a static-tool-surface pattern (`getPageCommands` ≈ `tools/list`,
`runPageCommand` ≈ `tools/call`) — proving the pattern works in production with the
Darwinium portal's page-command registry.

## Decision

The portal-mcp binary advertises **EXACTLY THREE** MCP tools, forever:

1. `get_page_commands` — returns the active tab's currently-registered page commands
   (name, description, args schema, _pageId).
2. `run_page_command` — invokes a named page command with args; accepts an optional
   `expected_page_id` to reject stale calls (Phase 2).
3. `get_context` — returns combined static instructions + current page Viper context
   for the active tab (Phase 2).

Page commands are routed *through* `get_page_commands` (returns the dynamic list)
and `run_page_command` (invokes by name). The dynamic surface lives in the page,
not in the MCP `tools/list` schema.

## Consequences

**Positive:**
- No "restart your MCP host" UX when pages register/unregister commands.
- One stable surface across all portal releases — customers don't need to re-pair
  after a portal deploy.
- Mirrors the in-portal slack-nlp `get_page_commands`-first pattern that customers
  already rely on (`runMyNlpService.ts:231` tells the LLM to "ALWAYS call
  `get_page_commands` first").

**Negative:**
- One extra round-trip per session for the LLM to discover page commands.
  Mitigated by `initialize.instructions` (Phase 2) instructing the LLM to call
  `get_page_commands` first.

**Phase 1 security note (acknowledged, not a violation):**
The Phase 1 binary accepts any WebSocket connection on `127.0.0.1:9224` (no token
gate yet — that's BRIDGE-02 / Phase 2). Acceptable for Phase 1 because:
- Bind is loopback-only (`127.0.0.1`) — not LAN-reachable.
- Phase 1's only consumers are local processes (manual `wscat` test client; the
  extension SW WS client is Phase 2).
- Token handshake is the explicit Phase 2 deliverable.

**Symbol-keyed registry hardening note:**
The page-side `window[Symbol.for('darwinium.pageCommands')]` registry (Plan 04)
closes the **named-global hijack** vector (third-party scripts can no longer do
`window.getAvailableCommands = badFn`) but does NOT close the **symbol-known
hijack** vector — a script that knows the literal `Symbol.for('darwinium.pageCommands')`
can still overwrite. This is documented in PageContextProvider source comments and
in the Phase 1 RESEARCH.md (Finding 6). The symbol-keyed pattern raises the bar; it
is not a substitute for CSP discipline.

## Enforcement

1. **Smoke test gate (primary).** `dwn_aphex/packages/portal-mcp/scripts/smoke-test.ts`
   asserts `tools/list` response has exactly 3 entries with names
   `get_page_commands`, `run_page_command`, `get_context`. Runs as part of
   `yarn workspace @darwinium/portal-mcp test`. This is the REL-01 CI gate; deterministic,
   no false positives.
2. **PR template question (soft gate).** When adding a 4th tool, the PR description
   must reference this ADR. (Repo does not currently have a PR template; this is
   aspirational — implement when CI infrastructure is added.)
3. **No GitHub Actions workflow** (per CONTEXT.md `<canonical_refs>` Open Decision #2):
   the repo has no `.github/workflows/` directory. The smoke test inside
   `yarn workspace @darwinium/portal-mcp test` is the deterministic gate. A future CI
   workflow only needs to invoke `yarn workspace @darwinium/portal-mcp test`.

## References

- https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- https://github.com/anthropics/claude-code/issues/7519
- https://github.com/anthropics/claude-code/issues/13646
- https://github.com/anthropics/claude-code/issues/3095
- https://github.com/BrowserMCP/mcp (reference impl using the same pattern)
- PROJECT.md "Static MCP tool surface, exactly 3 tools forever" (load-bearing decision)
