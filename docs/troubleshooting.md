---
title: Troubleshooting
description: Diagnosing and fixing Darwinium Portal MCP setup problems.
---

# Troubleshooting

## Start with `doctor`

```bash
npx -y @darwinium/portal-mcp doctor
```

Or, if you installed the `.mcpb` bundle and have no Node.js, run the `Check-Setup.command`
file included in the macOS hand-over folder.

Nine checks run:

| Check | What it means |
|---|---|
| `binary.present` | The binary is on disk and executable. |
| `token.mode` | Token file is mode `0600` (macOS/Linux). |
| `token.parent.mode` | Token's parent directory is mode `0700` (macOS/Linux). |
| `token.acl` | Token file has ACL inheritance broken (Windows only). |
| `config.desktop.entry` | Claude Desktop is registered — either an `mcpServers` entry or an installed `.mcpb`. |
| `config.code.marketplace` | Claude Code plugin present. Warn-only; ignore it if you don't use Claude Code. |
| `extension.reachable` | The extension's WebSocket accepted the token within 5 seconds. |
| `port.9224.bindable` | The port is free or a compatible shared bridge is available. |
| `git.token-tree-warning` | Warns if the token file sits inside a git working tree. |

<Callout>
A running bridge is expected when an MCP client is open. Compatible versions share it
and pass the port check. If the check fails, update and restart older MCP clients, check
for mismatched pairing tokens, or identify an unrelated listener on the port.
</Callout>

For a support ticket, attach the structured output:

```bash
npx -y @darwinium/portal-mcp doctor --json > doctor-output.json
```

## Common problems

### Claude says the extension isn't connected

Click the toolbar icon. If it shows Disconnected, click Connect with your portal tab in the
foreground. After a sleep/wake, auto-reconnect can take up to 30 seconds.

### Claude doesn't know what a pairing token is

Start a **brand-new chat**. The token arrives in the `initialize` handshake, which only runs
when a conversation opens — an older chat never received it. If a new chat still doesn't
know, the server isn't registered: check Claude Desktop's Settings → Extensions, or run
`doctor`.

### The tools vanish, or the server "disconnected"

Current bridge versions support multiple clients at once. Update and restart older copies
if the error says the running bridge does not support sharing. If the owner just exited,
allow the surviving bridge and extension to reconnect, then check the page state before
retrying an interrupted command.

### The assistant repeats an old bridge error, but tool calls work

A successful current tool call means the connection has recovered. Older builds
included connection errors in startup instructions, which the assistant can retain
after recovery. Ask it to call `get_page_commands` again and use that result. Update
the bridge and start a new MCP session to receive the corrected startup guidance.

### `port 9224 is already in use`

Compatible bridge instances share the port automatically. If sharing is unavailable,
identify whether an older bridge or an unrelated application holds it:

```bash
lsof -i :9224                  # macOS / Linux
netstat -ano | findstr :9224   # Windows
```

### "It worked yesterday, broken today"

A stale npm cache. `npx clear-npx-cache`, or `npm cache clean --force`, then re-run `doctor`
and check the version on `binary.present`.

### Load Unpacked fails on macOS

Usually a path containing spaces. Copy the extension folder somewhere plain:

```bash
cp -r ~/Library/Application\ Support/darwinium-portal-mcp/extension ~/darwinium-mcp-extension
```

and load that instead.

### Pairing code expired

Press **Enter** at the installer prompt for a fresh code. The attempt counter resets.

### `claude_desktop_config.json is not valid JSON`

Fix the syntax or delete the file, then re-run `install`. Your previous config was copied to
`claude_desktop_config.json.bak` before any change.

### Claude connects but says the page isn't ready

Reload the portal tab. If it persists, the portal environment may be older than this tool
expects — report it with `doctor --json` output.

## Rotating the token

If the token leaks, or you just want a fresh pairing:

```bash
npx -y @darwinium/portal-mcp rotate-token
```

The old token stops working immediately. The extension's next call fails with a token
mismatch, and the popup offers **Re-pair**.
