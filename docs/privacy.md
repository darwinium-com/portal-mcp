---
title: Privacy
description: What the Darwinium Portal MCP collects, where your data goes, and what is stored.
---

# Privacy

**Last updated:** 8 October 2026

The governing privacy policy for all Darwinium products is
**[darwinium.com/privacy-policy](https://www.darwinium.com/privacy-policy)**. This page adds
the product-specific detail for the Darwinium Portal MCP server (`@darwinium/portal-mcp`)
and its companion Chrome extension — together, "the software" — and does not replace or
override that policy.

## Summary

Darwinium collects nothing through this software. It has no analytics, no telemetry, no
crash reporting, and no backend of its own.

It does, however, put portal data in front of an AI assistant — and that assistant sends it
to its own provider. That is the disclosure that matters most here, and it is covered in
full below.

## What Darwinium collects

**Nothing.** The software makes no network connection to any Darwinium server, or to any
other remote host. The only network destination either component ever opens is
`127.0.0.1:9224`: WebSocket for the extension and authenticated HTTP between local
bridge processes sharing that connection. Both stay on your own machine.

There is no account, no registration, no usage reporting and no error reporting.

## What data the software handles

The Chrome extension reads the Darwinium portal page you have open — the page commands it
publishes, their results, and the page context — and relays them over the loopback socket to
the MCP server. The MCP server passes them to the LLM client that launched it.

The software accesses only what your own authenticated browser session already displays. It
holds no credentials for Darwinium, performs no data access of its own, and cannot see
anything you could not see yourself.

## Where your data goes

**Portal data you ask about leaves your machine.** Not to Darwinium — to your AI provider.

The LLM client that launched the server (Claude Desktop, Claude Code, or another MCP client
you configured) sends tool results to its provider as part of the conversation, exactly as it
does with any other content you put in a chat. For Claude clients that provider is Anthropic,
and Anthropic's privacy policy governs what happens to it.

Darwinium neither receives nor sees any of it, and has no ability to.

**Treat this as you would pasting portal data into a chat window, because that is what it
is.** Do not ask the assistant about data you are not willing to send to your AI provider.

## What is stored, and for how long

| Data | Where | Lifetime |
|---|---|---|
| Pairing token (64-char hex) | Your platform's app-data directory. Mode `0600` on macOS/Linux; ACL-locked on Windows. | Until rotated or removed. |
| Pairing token (extension copy) | Chrome extension local storage. | Until re-paired or the extension is removed. |
| Tool-call history | Chrome extension local storage, for the popup display. | Short, capped list; cleared with the extension. |

No portal data is written to disk by either component, and nothing is retained after the
process exits.

The pairing token authorises the local extension connection and communication between
bridge processes. It is not a Darwinium
credential, grants no access to any Darwinium system, never appears in
`claude_desktop_config.json`, and never leaves your machine.

## Permissions and scope

Production builds of the extension are restricted to exactly:

- `https://*.darwinium.com/*`
- `https://*.int.darwinium.io/*`

Both the requested host permissions and the content-script injection patterns are locked to
that set, and the release build fails if either widens. The extension cannot read any other
website.

Other permissions: `storage` (the token and popup history), `tabs` (identifying the active
portal tab), `alarms` (service-worker keepalive and reconnect backoff), and `scripting`
(re-injecting content scripts into open portal tabs after an extension update).

## Third parties

None, other than the AI provider you chose to run the server under, as described in
[Where your data goes](#where-your-data-goes). No data is sold, shared or transferred to
anyone else.

## Your controls

- **Revoke the pairing** at any time: `npx -y @darwinium/portal-mcp rotate-token`, which
  invalidates the old token immediately.
- **Disconnect** from the extension popup, which stops the bridge without uninstalling.
- **Remove the extension** from `chrome://extensions`, which deletes its stored token and
  history.
- **Remove the server** by deleting its Claude Desktop extension entry or its
  `mcpServers` entry, and deleting the app-data directory.

## Children

The software is a professional fraud-analysis tool and is not directed at children.

## Changes

Material changes to this page are reflected here with an updated date, and in the release
notes for the version that introduces them. Changes to the governing policy are published at
[darwinium.com/privacy-policy](https://www.darwinium.com/privacy-policy).

## Contact

- **Privacy questions:** privacy@darwinium.com
- **Security reports:** security@darwinium.com
- **Issues:** https://github.com/darwinium-com/portal-mcp/issues
