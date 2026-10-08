---
title: Claude Code
description: Add the Darwinium Portal MCP server to Claude Code.
---

# Claude Code

Requires Node.js 20 or newer.

## Option A — one-line install

```bash
claude mcp add darwinium-portal-mcp -- npx -y @darwinium/portal-mcp serve
```

Add `--scope user` to make it available in every project rather than just the current one.

## Option B — plugin

```
/plugin marketplace add darwinium-com/portal-mcp
/plugin install portal-mcp@darwinium
```

Both register the same server. Use whichever fits how you manage tooling.

## Then pair

Install the [Chrome extension](./chrome-extension), then introduce the two halves. Either:

- **Ask for the token.** Start a new Claude Code session and ask *"What is my Darwinium
  pairing token?"*, then paste it into the extension popup with your portal tab in the
  foreground.
- **Or run the pairing command**, which prints a 6-digit code instead:

  ```bash
  npx -y @darwinium/portal-mcp install
  ```

  The `install` subcommand also patches `claude_desktop_config.json`, which is harmless if
  you do not use Claude Desktop.

## Verify

```bash
claude mcp list
npx -y @darwinium/portal-mcp doctor
```

In a session, the three tools appear as `get_page_commands`, `run_page_command` and
`get_context`. See [Tools](./tools).

## Running alongside Claude Desktop

Claude Code and Claude Desktop can use the bridge concurrently. Later processes forward
their calls through the first process automatically. If that owner exits, a survivor takes
over and the extension reconnects. Both clients operate on the same connected tab, so
navigation and edits are visible to both. Update and restart older bridge versions first.
