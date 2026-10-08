# Darwinium Portal MCP

Connect Claude — and other MCP clients — to the Darwinium portal tab already open in your
browser. Run queries, inspect journeys, read signals and features, and edit policies in
plain language.

There is no Darwinium API key and no backend connection: your existing browser session does
all the data access, and the server only ever sees what your own portal tab already shows.

**Documentation: https://darwinium.com/portal-mcp**

## Install

### Claude Desktop

Download the latest `.mcpb` from
[Releases](https://github.com/darwinium-com/portal-mcp/releases/latest) and double-click it.
One file covers macOS, Windows and Linux, and it runs on the Node runtime Claude Desktop
ships — nothing to install.

Or, with Node.js 20+:

```bash
npx -y @darwinium/portal-mcp install
```

### Claude Code

```bash
claude mcp add darwinium-portal-mcp -- npx -y @darwinium/portal-mcp serve
```

Or as a plugin:

```
/plugin marketplace add darwinium-com/portal-mcp
/plugin install portal-mcp@darwinium
```

### Codex

Add this to `~/.codex/config.toml` and restart Codex:

```toml
[mcp_servers.darwinium-portal-mcp]
command = "npx"
args = ["-y", "@darwinium/portal-mcp@latest", "serve"]
```

Requires Node.js 20+. Multiple Codex and Claude sessions can share the bridge;
update any entries pinned to an older version and restart those clients once.
All sessions operate on the same connected portal tab.

### Chrome extension

Both halves are required. Install from the
[Chrome Web Store](https://chromewebstore.google.com/detail/darwinium-portal-mcp), then pair
once — see [the setup guide](https://darwinium.com/portal-mcp/chrome-extension).

## Repository layout

| Path | What |
|---|---|
| `portal-mcp/` | The MCP server, published to npm as [`@darwinium/portal-mcp`](https://www.npmjs.com/package/@darwinium/portal-mcp). |
| `portal-extension/` | The Chrome MV3 extension. |
| `docs/` | Source for the documentation site. |
| `.claude-plugin/` | Claude Code marketplace and plugin manifests. |

This repository is generated from Darwinium's internal monorepo, which remains the source of
truth. Please raise issues here; pull requests may need to be re-applied upstream.

## Privacy

Darwinium collects nothing through this software — no analytics, no telemetry, no backend.
Note that portal data you ask an assistant about is sent by that assistant to its own AI
provider. Full policy: https://www.darwinium.com/privacy-policy

## License

Apache-2.0 — see [LICENSE](./LICENSE).
