/**
 * Five-mode error response mapper for `tools/call` failure paths.
 *
 * The message strings are user-facing: short, action-first, no error codes,
 * no doctor references.
 */
export type ErrorMode = 'NO_TAB' | 'LOST_MID_CALL' | 'PAGE_NAVIGATED' | 'TOKEN_MISMATCH' | 'TAB_STALE';

const MESSAGES: Record<ErrorMode, (ctx?: { newPageId?: string }) => string> = {
  NO_TAB: () => 'Not connected. Click Connect in the Darwinium extension popup.',
  LOST_MID_CALL: () => 'Lost connection to portal mid-call. Retry; the extension auto-reconnects within a few seconds.',
  // PAGE_NAVIGATED is templated with the now-known pageId.
  PAGE_NAVIGATED: (ctx) =>
    `Page navigated. Current page is ${ctx?.newPageId ?? '<unknown>'}. Re-call get_page_commands and retry against the new page.`,
  // TOKEN_MISMATCH — host string only; the popup-side wording is in the extension package.
  TOKEN_MISMATCH: () => "Extension token does not match the binary's token. Re-run install or rotate-token.",
  // TAB_STALE: the extension was reloaded/auto-updated, so the old content script
  // in the connected tab can no longer reach the (new) SW. Background re-injection
  // (chrome.scripting.executeScript on chrome.runtime.onInstalled) is attempted
  // automatically; user-facing recovery is to refresh the tab.
  TAB_STALE: () =>
    'Extension was reloaded; refresh the connected portal tab to restore the bridge. Re-injection is being attempted automatically.',
};

export function mapError(
  mode: ErrorMode,
  ctx?: { newPageId?: string },
): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return {
    content: [{ type: 'text' as const, text: MESSAGES[mode](ctx) }],
    isError: true,
  };
}
