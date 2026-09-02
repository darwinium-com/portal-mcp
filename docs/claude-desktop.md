---
title: Claude Desktop
description: Install the Darwinium Portal MCP server in Claude Desktop.
---

# Claude Desktop

Two install paths. The bundle is the one to use unless you have a reason not to — it needs
no Node.js, no terminal, and no npm.

## Option A — the `.mcpb` bundle (recommended)

1. Download the latest `.mcpb` from
   [Releases](https://github.com/darwinium-com/portal-mcp/releases/latest). One file covers
   macOS, Windows and Linux.
2. Double-click it. Claude Desktop opens on its Extensions screen.
3. Click **Install**.

<Callout>
On macOS, files downloaded from the internet are quarantined and may refuse to open. If
double-clicking does nothing, run `xattr -dr com.apple.quarantine <path to the file>` and
try again.
</Callout>

Then install the [Chrome extension](./chrome-extension) and [pair](#pairing).

## Option B — `npx`

Requires Node.js 20 or newer.

```bash
npx -y @darwinium/portal-mcp install
```

The installer:

1. Writes a per-machine token to your app-data directory (`0600` on macOS/Linux, ACL-locked
   on Windows).
2. Adds a `darwinium-portal-mcp` entry to `claude_desktop_config.json`, preserving every
   other MCP server you have configured. A `.bak` is written first.
3. Extracts a copy of the Chrome extension for the Load Unpacked path.
4. Prints a 6-digit pairing code and waits for you to enter it in the extension popup.

Restart Claude Desktop afterwards.

## Pairing

The two halves have to be introduced to each other once. Which method you use depends on
how you installed.

### If you used the `.mcpb` bundle

There is no terminal step, so the token is delivered through Claude itself:

1. Open your Darwinium portal tab in Chrome and log in. Leave it in the foreground.
2. In Claude Desktop, start a **brand-new chat**.
3. Ask: *"What is my Darwinium pairing token?"*
4. Copy the token Claude gives you.
5. Click your portal tab first, then click the **Darwinium Portal MCP** toolbar icon.
6. Paste the token and click **Save & Connect**.

The popup should switch to **Connected**.

<Callout>
It must be a new chat. The token is delivered in the server's `initialize` handshake, which
only runs when a conversation opens — an existing chat will not have it.
</Callout>

### If you used `npx install`

The installer prints a 6-digit code and waits. Click the toolbar icon, type the six digits,
click **Save & Connect**. The code expires after 60 seconds and allows 3 attempts; press
**Enter** at the prompt for a fresh one.

## Verify

```bash
npx -y @darwinium/portal-mcp doctor
```

See [Troubleshooting](./troubleshooting) for how to read the output — two checks report a
cross on a perfectly healthy machine while Claude Desktop is running.

## Before you pair

Claude knows Darwinium query syntax and the standard label list from the moment the server
starts, even unpaired — that much is bundled in. But the portal tools stay unavailable, and
signal, feature and label names specific to *your* workspace only arrive once the extension
is connected.
