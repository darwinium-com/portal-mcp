# @darwinium/portal-mcp

Connect Claude Desktop or Claude Code to your active `*.darwinium.com` portal tab. Three tools, zero backend connections, OOB-paired to your existing portal session.

For the full guide, visit **https://www.darwinium.com**. (A dedicated docs site at `darwinium.com/portal-mcp` is coming; until then this README is the reference.)

---

## What this is

`@darwinium/portal-mcp` is a stdio MCP server that bridges Claude Desktop and Claude Code to the active Darwinium portal tab in your browser. It does **not** connect to any Darwinium backend — your existing portal session handles all data access. The MCP server only sees what your portal tab sees.

The three tools exposed are:

- `get_page_commands` — list the page commands registered on the active tab
- `run_page_command` — invoke a named page command with args
- `get_context` — return the page's static instructions plus current node context

## Prerequisites

- macOS, Windows, or Linux with **Node.js 20 or newer** (`node --version`)
- **Google Chrome 116+** (Chromium-based browsers are not officially supported in v1)
- A logged-in Darwinium portal tab (`*.darwinium.com`)

## Install

The install is two short steps: register the MCP server with your LLM client, then run a one-time pairing command in your terminal so the MCP server can talk to your browser tab.

### Step 1 — Install the Chrome extension

Pick the path your environment allows:

- **Chrome Web Store** (recommended for unmanaged Chrome): listing pending review
- **Unpacked** (locked corporate Chrome): run the installer in Step 2 first; it extracts a versioned copy of the extension to your platform's app-data directory and prints the exact path. Then in Chrome:
  1. Visit `chrome://extensions`
  2. Enable **Developer Mode** (top right)
  3. Click **Load Unpacked**
  4. Point it at the path the installer printed (e.g. `~/Library/Application Support/darwinium-portal-mcp/extension/` on macOS)

### Step 2 — Install the MCP server

Pick the LLM client you use:

#### Claude Desktop

```
npx -y @darwinium/portal-mcp install
```

The installer:

1. Writes a per-install token to your platform's app-data directory (mode `0600` on macOS / Linux; ACL-locked on Windows)
2. Patches your `claude_desktop_config.json` (with a `.bak` companion for safety, additive merge — your other MCP entries are preserved)
3. Extracts the bundled extension to your app-data directory (for the Unpacked path above)
4. Prints a 6-digit pairing code in a box like:

   ```
   portal-mcp: pairing armed. Open the Darwinium Portal MCP extension popup
               and enter this 6-digit code within 60 seconds.

     ┌────────────────────────────────────────────────────────────┐
     │                                                            │
     │   Pairing code:  123456                                    │
     │   Expires:       60s                                       │
     │                                                            │
     └────────────────────────────────────────────────────────────┘

   portal-mcp: waiting for popup... (Ctrl+C to abort)
   ```

5. Waits for you to paste the code into the extension popup. Click the **Darwinium Portal MCP** icon in your Chrome toolbar, type the 6 digits, click **Save & Connect**. The installer prints `✓ paired with extension` and exits success.

If the code expires (60 seconds) or you mistype it three times, press **Enter** at the installer's prompt to generate a fresh code. Press **Ctrl+C** to abort.

#### Claude Code

In any Claude Code session:

```
/plugin marketplace add darwinium-com/portal-mcp
/plugin install portal-mcp@darwinium
```

Or register it in one line without the plugin:

```
claude mcp add darwinium-portal-mcp -- npx -y @darwinium/portal-mcp serve
```

Either way, then complete OOB pairing (one-time):

```
npx -y @darwinium/portal-mcp install
```

Same boxed pairing code, same paste-into-popup flow as the Claude Desktop track. The Claude Code marketplace install handles the config registration; the `install` subcommand handles the browser pairing — they are complementary, not redundant.

## Verify your install

Run the diagnostic:

```
npx -y @darwinium/portal-mcp doctor
```

You'll see nine checks. All should pass on a healthy install:

- `binary.present` — the npm-fetched binary is on disk and executable
- `token.mode` — token file is mode `0600` (macOS / Linux only)
- `token.parent.mode` — token's parent dir is mode `0700` (macOS / Linux only)
- `token.acl` — token file has inheritance broken (Windows only; skipped elsewhere)
- `config.desktop.entry` — `claude_desktop_config.json.mcpServers["darwinium-portal-mcp"]` exists and is well-formed
- `config.code.marketplace` — Claude Code plugin install is present at `~/.claude/plugins/...` (warn-only if missing — you may not be using Claude Code)
- `extension.reachable` — the extension's WebSocket bridge accepts the token within 5 seconds
- `port.9224.bindable` — `127.0.0.1:9224` is free for the MCP server to bind
- `git.token-tree-warning` — token file is **not** inside a git working tree (warn-by-default; move it out or add to `.gitignore` if it is)

For support tickets, attach the structured `--json` output:

```
npx -y @darwinium/portal-mcp doctor --json > doctor-output.json
```

## Rotate the token

If your token file is leaked or you simply want a fresh pairing:

```
npx -y @darwinium/portal-mcp rotate-token
```

This regenerates the token and prompts you to re-pair the extension. The old token stops working immediately — the extension's next bridge call gets a "Token mismatch" error, the popup auto-detects it and shows a **Re-pair** action. Click Re-pair, paste the new 6-digit code, paired.

## Common errors

The MCP server returns four user-actionable error responses:

| Error | What it means | What to do |
|-------|---------------|------------|
| `No tab connected` | The extension popup shows **Disconnected** | Open `*.darwinium.com`, click **Connect** in the popup |
| `Connection lost mid-call` | The extension disconnected during your command | Wait for auto-reconnect (≤30s), then retry |
| `Page navigated mid-call, current page is X` | You navigated away during the command | Retry from the new page, or include `expected_page_id` to gate the call |
| `Token mismatch` | Extension token doesn't match the binary | Run `npx -y @darwinium/portal-mcp rotate-token` and re-pair |

## Privacy Policy

Full policy: **https://www.darwinium.com/privacy-policy**. Summary below.

### What this software collects

**Darwinium collects nothing through this tool.** It has no analytics, no telemetry, no
crash reporting, and no backend of its own. The only network destination either component
ever opens is `ws://127.0.0.1:9224` — a loopback socket on your own machine.

### What data is handled, and where it goes

The extension reads the Darwinium portal page you have open and passes what it reads to
the local MCP server, which hands it to the LLM client that launched it (Claude Desktop or
Claude Code).

Be aware of what that means: **portal data you ask about does leave your machine — it is
sent to your AI provider by your own LLM client**, exactly as any other content in that
conversation is, under that provider's privacy policy (for Claude, Anthropic's). Darwinium
neither sees nor receives it. Do not ask the assistant about portal data you are not
willing to send to your AI provider.

The server reaches no Darwinium backend at any point. Your existing browser session performs
all data access, and the server only ever sees what your own portal tab already shows you.

### Storage and retention

- A 64-character hex pairing token is written to your platform's app-data directory
  (mode `0600` on macOS/Linux, ACL-locked on Windows). It authorises the loopback WebSocket
  and nothing else. It never appears in `claude_desktop_config.json` and never leaves the machine.
- The extension stores that token, plus a short in-memory tool-call history for the popup,
  in Chrome's local extension storage.
- No portal data is written to disk by either component, and nothing is retained after the
  process exits. Revoke at any time with `rotate-token`, or by removing the extension.

### Scope limits

- The extension's production `host_permissions` and content-script matches are exactly
  `https://*.darwinium.com/*` and `https://*.int.darwinium.io/*`. It cannot read any other
  site, and `scripts/check-manifest.mjs --prod` fails the build if that ever widens.
- The 6-digit pairing code is single-use, expires in 60 seconds, and is rate-limited to
  3 attempts.

### Third parties

None, other than the AI provider you have chosen to run this server under, as described above.

### Contact

Privacy questions: **privacy@darwinium.com**. Issues:
**https://github.com/darwinium-com/portal-mcp/issues**.

## Troubleshooting

- **"It worked yesterday, broken today"** — npm cache may be stale. Run `npx clear-npx-cache` or `npm cache clean --force`. Then re-run `doctor` and check the `binary.present` version.
- **"Load Unpacked fails on macOS because the path contains spaces"** — copy the extracted extension to a path without spaces, e.g. `cp -r '~/Library/Application Support/darwinium-portal-mcp/extension' ~/darwinium-mcp-extension` and load the latter.
- **"Pairing code expired"** — press **Enter** at the installer's prompt to re-arm with a fresh code (counter resets).
- **"`claude_desktop_config.json` is not valid JSON"** — fix the syntax (or delete the file) and re-run `install`. Your previous config is at `claude_desktop_config.json.bak`.
- **"`port 9224` is already in use"** (`port.9224.bindable` doctor check fails) — another `portal-mcp serve` instance is running, or another tool has bound the port. Quit the other instance, or `lsof -i :9224` (macOS / Linux) / `netstat -ano | findstr :9224` (Windows) to find the offender.

For more, contact us at **https://www.darwinium.com/contact-us**.

## Building the macOS hand-over bundle (internal)

Ahead of the npm and Chrome Web Store releases, `yarn package:macos` produces a folder that
installs with double-clicks only — no terminal, no Node.js, no npm. Intended for non-technical
users (sales, solutions engineering) on Apple Silicon.

```
yarn package:macos                       # defaults to bun-darwin-arm64
yarn package:macos --target=bun-darwin-x64   # Intel Macs
```

Requires [bun](https://bun.sh) on PATH. Output lands in `build/` (gitignored):

- `DarwiniumPortalMCP-<version>-macos-<arch>.zip` — the file you hand over
- `DarwiniumPortalMCP/1 - Darwinium Portal MCP.mcpb` — double-click installs the MCP server
  into Claude Desktop. The hand-over bundle carries a `bun build --compile` standalone binary
  so it is entirely self-contained for a non-technical recipient. The bundle published to the
  extension directory (`yarn package:mcpb`) uses `server.type: "node"` instead: Claude Desktop
  ships its own Node runtime, so one ~320KB file installs on macOS, Windows and Linux.
- `DarwiniumPortalMCP/2 - chrome-extension/` — the Load Unpacked target, at a space-free path
- `DarwiniumPortalMCP/START-HERE.html` — the end-user guide
- `Check-Setup.command` / `Fix-Permissions.command` — support escape hatches

The bundle skips the `install` subcommand entirely: `serve` generates the token on first launch
and surfaces it via `initialize.instructions`, so the user asks Claude for the pairing token and
pastes it into the popup. No terminal is involved at any point.

Anything resolving a bundled file must go through `src/install/bundlePaths.ts` — under a compiled
binary `import.meta.url` and `argv[1]` both point inside bun's virtual `/$bunfs/` filesystem and
never exist on disk.

## License

Apache-2.0 — see [LICENSE](./LICENSE).

## Source

`@darwinium/portal-mcp` source repository: https://github.com/darwinium-com/portal-mcp *(publishes with v1.0)*.
