---
title: Other MCP clients
description: Using the Darwinium Portal MCP server with ChatGPT desktop, Codex CLI, and other stdio MCP clients.
---

# Other MCP clients

`portal-mcp` is an ordinary stdio MCP server, so anything that can launch one can use it.
These paths are not covered by the installer and are not yet officially supported — they
work, but you configure them by hand.

<Callout>
**One host at a time.** The server binds `127.0.0.1:9224` and only one process can hold it.
If a Claude client is already running the bridge, another client will report that another
copy owns it. Quit the other one first. Concurrent hosts are planned, not shipped.
</Callout>

## ChatGPT desktop / Codex CLI

The ChatGPT desktop app, Codex CLI and the Codex IDE extension share one MCP configuration
at `~/.codex/config.toml`. Add:

```toml
[mcp_servers.darwinium-portal-mcp]
command = "npx"
args = ["-y", "@darwinium/portal-mcp", "serve"]
```

Restart the client. Then install the [Chrome extension](./chrome-extension) and pair — ask
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
