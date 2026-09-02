import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * STATIC THREE-TOOL SURFACE (ADR-001).
 *
 * Adding a 4th tool requires:
 * 1. Update ADR-001 with rationale.
 * 2. Update smoke-test.ts assertion `assert.equal(tools.length, 3)` to the new count.
 * 3. Justify in PR description why the dynamic surface (which lives in `get_page_commands` returns)
 *    cannot accommodate the new capability.
 *
 * Claude Desktop and Claude Code cache `tools/list` and do NOT honor `tools/list_changed`
 * (claude-code#7519, #13646). Adding tools without considering host cache behavior is unsafe.
 *
 * ANNOTATIONS ARE MANDATORY. Anthropic's directory review requires every tool to carry
 * a `title` plus the applicable `readOnlyHint` / `destructiveHint`; a tool without them
 * is rejected. `openWorldHint` is false throughout: this server has zero backend
 * connections and reaches nothing beyond the one browser tab it is paired with.
 */
export const TOOLS: Tool[] = [
  {
    name: 'get_page_commands',
    annotations: {
      title: 'List portal page commands',
      readOnlyHint: true,
      // Same page, same list — but the page can navigate between calls, so the
      // result is not stable over time and the tool is not idempotent.
      idempotentHint: false,
      openWorldHint: false,
    },
    description:
      'Lists page commands available on the active Darwinium portal tab. Returns an array of { name, description, args, _pageId }. Call this FIRST in any session to discover what the active tab can do. The list is dynamic — it changes per page; always call this before invoking run_page_command.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'run_page_command',
    annotations: {
      title: 'Run a portal page command',
      // The dynamic surface behind this tool includes commands that edit policies,
      // workflows and labels. The annotation must describe the worst case the tool
      // can reach, not the common case.
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    description:
      'Invokes a named page command on the active Darwinium portal tab with the given arguments. If `expected_page_id` is supplied, the binary checks the live page id first and returns a navigation-error on mismatch so the caller can retry against the new page. Use the exact `name` returned by get_page_commands.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The page-command name as returned by get_page_commands.' },
        args: {
          type: 'object',
          description: "Arguments to pass to the command (object; shape per the command's args schema).",
        },
        expected_page_id: {
          type: 'string',
          description: 'Optional: reject if the live page id no longer matches this value.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_context',
    annotations: {
      title: 'Get portal instructions and page context',
      readOnlyHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    description:
      'Returns combined static Darwinium instructions + current page Viper context for the active tab. Capped server-side at 50KB; if the payload would exceed the cap, lower-priority fields are dropped and a `_truncated` flag is set on the response.',
    inputSchema: { type: 'object', properties: {} },
  },
];
