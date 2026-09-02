---
title: Tools
description: The three tools the Darwinium Portal MCP server exposes.
---

# Tools

The server exposes exactly three tools. The *capabilities* are not fixed — they come from
the page commands your portal tab publishes, which change per page. `get_page_commands` is
how you discover them.

## `get_page_commands`

Read-only. Lists the page commands available on the active portal tab.

Returns an array of `{ name, description, args, _pageId }`.

**Call this first in any session**, and again after navigating: the list is dynamic and a
command that existed on the previous page may not exist on this one.

## `run_page_command`

Invokes a named page command with arguments.

| Argument | Type | Notes |
|---|---|---|
| `name` | string, required | Exactly as returned by `get_page_commands`. |
| `args` | object | Shape per that command's own `args` schema. |
| `expected_page_id` | string | Optional guard. If the live page id no longer matches, the call is rejected with a navigation error instead of running against the wrong page. |

Not read-only, and annotated as potentially destructive: the command surface behind it
includes commands that edit policies, workflows and labels.

## `get_context`

Read-only. Returns the combined static Darwinium instructions plus the current page's Viper
context for the active tab.

Capped at 50KB server-side. If the payload would exceed that, lower-priority fields are
dropped and `_truncated` is set on the response.

## Why only three

The useful surface is the *page command* list, which is dynamic and per-page. Exposing it
as MCP tools would mean the tool list changing on every navigation — and Claude Desktop and
Claude Code both cache `tools/list` and do not honour `tools/list_changed`. A stable
three-tool surface with dynamic discovery underneath is the design that survives that.

## Errors you may see

| Error | Meaning | Fix |
|---|---|---|
| `No tab connected` | The extension popup shows Disconnected. | Open a portal tab and click Connect. |
| `Connection lost mid-call` | The extension dropped during the call. | Wait for auto-reconnect (≤30s) and retry. |
| `Page navigated mid-call, current page is X` | You navigated during the call. | Retry from the new page, or pass `expected_page_id`. |
| `Token mismatch` | Extension token ≠ server token. | `rotate-token`, then re-pair. |
