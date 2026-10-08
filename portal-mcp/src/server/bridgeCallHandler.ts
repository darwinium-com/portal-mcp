/**
 * MCP `tools/call` handler for the static three-tool surface (ADR-001):
 * get_page_commands, run_page_command, get_context. Tool-name strings MUST
 * match tools.ts exactly. The binary keeps no page-id cache — expected_page_id
 * is checked via a live listCommands probe (see run_page_command below).
 */
import { z } from 'zod';
import type { Bridge } from '../bridge/Context.js';
import { capContextResponse } from './get-context.js';
import { buildPairingMessage } from './pairingMessage.js';
import { buildPortalInstructions } from './portalInstructions.js';

type ToolCallReq = { params: { name: string; arguments?: Record<string, unknown> } };

/**
 * Zod arg schema for `run_page_command`. A malicious or buggy MCP host could
 * send ill-typed `name`/`expected_page_id` values that mis-route the call or
 * trigger stack-trace-eliciting code paths on the page side, so the schema
 * validates the trust-boundary fields we control. Page-command payload
 * (`args.args`) stays `unknown` — page-side commands have their own arg
 * shapes; the binary's job is to forward, not to validate the entire matrix.
 * `passthrough()` keeps unknown sibling fields rather than stripping them.
 */
const RunPageCommandArgsSchema = z
  .object({
    name: z.string(),
    args: z.unknown().optional(),
    expected_page_id: z.string().optional(),
  })
  .passthrough();

/**
 * Key a page command sets to return a picture rather than a description of one.
 * Must match IMAGE_ENVELOPE_KEY in aphex-frontend's common/mcp/screenshot.ts.
 */
const IMAGE_ENVELOPE_KEY = '__image';

/** Base64 above this is refused: it would blow the host's response budget for no gain. */
const MAX_IMAGE_BASE64_BYTES = 4 * 1024 * 1024;

type ImagePayload = { mimeType: string; base64: string };

const readImageEnvelope = (result: unknown): ImagePayload | null => {
  if (!result || typeof result !== 'object') return null;
  const envelope = (result as Record<string, unknown>)[IMAGE_ENVELOPE_KEY];
  if (!envelope || typeof envelope !== 'object') return null;
  const { mimeType, base64 } = envelope as Record<string, unknown>;
  if (typeof mimeType !== 'string' || !mimeType.startsWith('image/')) return null;
  if (typeof base64 !== 'string' || base64 === '') return null;
  return { mimeType, base64 };
};

/**
 * Splits an image-carrying result into an MCP image block plus the remaining
 * fields as text. The base64 is never repeated in the text half — that is the
 * whole point: as JSON it is unreadable bulk, as an image block it is something
 * the model can look at.
 */
const buildImageResponse = (result: unknown, image: ImagePayload) => {
  const { [IMAGE_ENVELOPE_KEY]: envelope, ...rest } = result as Record<string, unknown>;
  const { base64: _omitted, ...meta } = (envelope ?? {}) as Record<string, unknown>;

  if (image.base64.length > MAX_IMAGE_BASE64_BYTES) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ...rest,
              ...meta,
              error: `the capture is ${Math.round(image.base64.length / 1024)}KB, above the ${MAX_IMAGE_BASE64_BYTES / 1024 / 1024}MB limit`,
              hint: 'Re-run with a smaller maxWidth, format "jpeg", or a cardTitle to capture one card instead of the board.',
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      { type: 'text', text: JSON.stringify({ ...rest, ...meta }, null, 2) },
      { type: 'image', data: image.base64, mimeType: image.mimeType },
    ],
  };
};

export function makeBridgeCallHandler(bridge: Bridge, token: string) {
  return async (req: ToolCallReq) => {
    const { name, arguments: rawArgs } = req.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;

    const problem = bridge.connectionProblem();
    if (problem) {
      return { content: [{ type: 'text', text: problem }], isError: true };
    }

    // Not connected → return the pairing token + steps instead of a bare NO_TAB.
    // This is the "ask Claude to connect" path: any tool call while unpaired tells
    // the user exactly how to pair, with the real token to paste into the popup.
    if (!bridge.hasWs()) {
      return { content: [{ type: 'text', text: buildPairingMessage(token) }], isError: true };
    }

    try {
      switch (name) {
        case 'get_page_commands': {
          const result = await bridge.send('listCommands', {}, 10_000);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'run_page_command': {
          // safeParse before any forwarding. On invalid args, return a
          // structured error response without invoking the bridge. The error
          // surfaces the failing field path + zod issue message so the MCP
          // host can correct its call.
          const parsed = RunPageCommandArgsSchema.safeParse(args);
          if (!parsed.success) {
            const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
            return {
              content: [{ type: 'text', text: `Invalid run_page_command args: ${issues}` }],
              isError: true,
            };
          }
          const validated = parsed.data;

          // expected_page_id mismatch detection, stateless: resolve the
          // CURRENT page id with a live listCommands round-trip instead of a
          // server-side cache. The current page id is the first non-'global'
          // `_pageId` in the registry. If no per-page command is registered
          // (currentPageId null), proceed — the page response is authoritative.
          if (typeof validated.expected_page_id === 'string') {
            const commands = await bridge.send<Array<{ _pageId?: unknown }>>('listCommands', {}, 10_000);
            const currentPageId = Array.isArray(commands)
              ? (commands
                  .map((c) => c._pageId)
                  .find((pid): pid is string => typeof pid === 'string' && pid !== '' && pid !== 'global') ?? null)
              : null;
            if (currentPageId !== null && currentPageId !== validated.expected_page_id) {
              return bridge.errorResponse('PAGE_NAVIGATED', { newPageId: currentPageId });
            }
          }
          const result = await bridge.send('runCommand', { name: validated.name, args: validated.args }, 60_000);
          const image = readImageEnvelope(result);
          if (image) return buildImageResponse(result, image);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'get_context': {
          const [contextResult, instructionsResult] = await Promise.all([
            bridge.send<unknown>('runCommand', { name: 'getCurrentNodeContext', args: {} }, 10_000),
            bridge.send<{ instructions: string }>('runCommand', { name: 'getDarwiniumInstructions', args: {} }, 10_000),
          ]);
          const contextObj = (contextResult ?? {}) as Record<string, unknown>;
          const capped = capContextResponse({
            ...contextObj,
            instructions: buildPortalInstructions(instructionsResult?.instructions ?? ''),
          });
          return { content: [{ type: 'text', text: JSON.stringify(capped, null, 2) }] };
        }
      }
      throw new Error(`Unknown tool: ${name}`);
    } catch (err) {
      const msg = (err as Error).message;
      // Map known error modes to their structured responses.
      // PAGE_NAVIGATED is handled inline above (pre-call check); unreachable from this catch.
      if (msg === 'NO_TAB') return bridge.errorResponse('NO_TAB');
      if (msg === 'LOST_MID_CALL') return bridge.errorResponse('LOST_MID_CALL');
      // The SW's command-router emits 'TAB_STALE' on chrome.tabs.sendMessage
      // failures matching the extension-context-invalidation signature.
      // Bridge.onMessage rejects with new Error(String(msg.error)) so we
      // identity-match here just like the other modes.
      if (msg === 'TAB_STALE') return bridge.errorResponse('TAB_STALE');
      // Other errors (page command errors, schema errors) flow through as raw isError.
      return { content: [{ type: 'text', text: `Tool error: ${msg}` }], isError: true };
    }
  };
}
