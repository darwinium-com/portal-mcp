---
title: Other MCP clients
description: Using the Darwinium Portal MCP server with Codex and other stdio MCP clients.
---

# Other MCP clients

`portal-mcp` is an ordinary stdio MCP server, so anything that can launch one can use it.
These paths are not covered by the installer and are not yet officially supported — they
work, but you configure them by hand.

<Callout>
Multiple MCP hosts can share the browser connection automatically. Each keeps its own
session and replies, while all operate on the same connected portal tab. Update and
restart older bridge versions before using concurrent sessions.
</Callout>

## Codex

The Codex app, Codex CLI and the Codex IDE extension use MCP configuration in
`~/.codex/config.toml`. Add:

```toml
[mcp_servers.darwinium-portal-mcp]
command = "npx"
args = ["-y", "@darwinium/portal-mcp@latest", "serve"]
```

Restart the client. If an existing entry pins an older package version, update it first.
Then install the [Chrome extension](./chrome-extension) and pair — ask
the assistant *"What is my Darwinium pairing token?"* in a new conversation, exactly as on
the Claude path.

Requires Node.js 20+ on `PATH`. Note that ChatGPT on the **web** cannot use this at all:
hosted ChatGPT accepts only remote HTTPS MCP servers, and this one is deliberately local.

## Anything else

Any client that can spawn a stdio MCP server works. The invocation is:

```
npx -y @darwinium/portal-mcp serve
```

Or point it at the absolute path of an installed binary. The server speaks MCP over
stdin/stdout and keeps stdout free of everything except JSON-RPC, so it will not corrupt a
strict host parser.
