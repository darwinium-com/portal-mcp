---
title: Chrome extension
description: Install and pair the Darwinium Portal MCP Chrome extension.
---

# Chrome extension

The extension is the half that can see your portal tab. Without it, the MCP server starts
but has nothing to talk to.

Requires **Google Chrome 116 or newer** — the service worker keeps its WebSocket alive using
behaviour introduced in 116.

## Install from the Chrome Web Store

[Add to Chrome](https://chromewebstore.google.com/detail/darwinium-portal-mcp) *(unlisted —
reachable by direct link only)*.

## Install unpacked

Use this if your organisation blocks Web Store installs, or you are running a local build.

1. Get the extension folder. Either:
   - run `npx -y @darwinium/portal-mcp install`, which extracts a copy and prints the path; or
   - use the `2 - chrome-extension` folder from the macOS hand-over bundle.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** (top left) and select the folder.

<Callout>
Chrome warns about developer-mode extensions on every start. That is expected on this path.

If Load Unpacked fails, check the path for spaces — copying the folder somewhere like
`~/darwinium-mcp-extension` is a reliable workaround.
</Callout>

Pin it: click the puzzle-piece icon in the toolbar and pin **Darwinium Portal MCP**.

## Pair it

1. Open your Darwinium portal tab and log in. **Click on that tab** so it is the active one.
2. Click the Darwinium Portal MCP toolbar icon.
3. Paste your pairing token (see [Claude Desktop](./claude-desktop#pairing) or
   [Claude Code](./claude-code#then-pair) for how to get it).
4. Click **Save & Connect**.

The popup switches to **Connected**.

<Callout>
The extension binds to whichever tab is in front when you click **Save & Connect**. If you
pair while looking at a different tab, it connects to that one instead.
</Callout>

## What it can access

Production builds request exactly two host patterns:

- `https://*.darwinium.com/*`
- `https://*.int.darwinium.io/*`

Both the permissions and the content-script match patterns are locked to that set, and the
build fails if either widens. The extension cannot read any other site.

The other permissions it requests:

| Permission | Why |
|---|---|
| `storage` | Holds the pairing token and the popup's tool-call history. |
| `tabs` | Identifies which portal tab is active, so calls go to the right page. |
| `alarms` | Keeps the service worker alive and drives reconnect backoff. |
| `scripting` | Re-injects content scripts into already-open portal tabs after the extension updates or reloads. |

## Re-pairing

If you rotate the token (`npx -y @darwinium/portal-mcp rotate-token`), the extension's next
call fails with a token mismatch. The popup detects this and offers **Re-pair** — click it
and paste the new token.
