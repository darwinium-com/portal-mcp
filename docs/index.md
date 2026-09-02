---
title: Darwinium Portal MCP
description: Connect Claude to the Darwinium portal tab open in your browser.
---

# Darwinium Portal MCP

Ask Claude about the Darwinium portal page you are looking at, and let it drive the
portal in plain language — run queries, inspect journeys, read signals and features,
edit policies.

It works by bridging your **existing browser session**. There is no Darwinium API key,
no service account, and no backend connection: the server only ever sees what your own
portal tab already shows you.

## Choose your assistant

| | |
|---|---|
| **[Claude Desktop](./claude-desktop)** | One-click install with a `.mcpb` bundle, or `npx`. |
| **[Claude Code](./claude-code)** | Plugin install, or a one-line `claude mcp add`. |
| **[Other MCP clients](./other-clients)** | ChatGPT desktop, Codex CLI, and anything that speaks stdio MCP. |

Every path also needs the **[Chrome extension](./chrome-extension)** — it is the half that
can actually see your portal tab.

## How it fits together

```
Claude Desktop / Claude Code
        │  stdio (JSON-RPC)
        ▼
  portal-mcp  ──── binds 127.0.0.1:9224 (loopback only)
        ▲
        │  WebSocket, token-authenticated
  Chrome extension (service worker)
        ▲
        │  CustomEvents
  your *.darwinium.com tab
```

Two pieces, both local:

- **The Chrome extension** reads the page commands your portal tab publishes and relays
  them over a loopback WebSocket.
- **The MCP server** (`portal-mcp`) is a stdio server your LLM client launches. It exposes
  [three tools](./tools) and forwards them to the extension.

Nothing in the chain reaches a Darwinium server. See [Privacy](./privacy) for what that
does and does not protect.

## Requirements

- **Google Chrome 116 or newer.** Other Chromium browsers are not officially supported.
- **A logged-in Darwinium portal tab** — `*.darwinium.com` or `*.int.darwinium.io`.
- **Node.js 20+** *only* for the `npx` install path. The `.mcpb` bundle ships a
  self-contained binary and needs no runtime at all.

## One host at a time

The server binds `127.0.0.1:9224`, and only one process can hold it. If you run Claude
Desktop and Claude Code at once, the second one to start will report that another copy owns
the bridge, and will take over automatically when the first exits. Use the portal tools from
one client at a time.
