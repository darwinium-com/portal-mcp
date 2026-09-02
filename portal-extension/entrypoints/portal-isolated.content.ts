import { defineContentScript } from 'wxt/utils/define-content-script';

import { CONTENT_SCRIPT_MATCHES } from '../src/shared/hostPatterns';

/**
 * ISOLATED-world content script (Chrome MV3 default). Owns the chrome.runtime
 * APIs but runs in a separate JS realm from the page, so it cannot read the
 * page-realm symbol-keyed registry — that's why the MAIN-world script exists.
 * Forwards SW bridge requests to MAIN via the 'dwn-mcp-req'/'dwn-mcp-resp'
 * CustomEvent channel and relays page-id pushes back to the SW.
 */
export default defineContentScript({
  matches: CONTENT_SCRIPT_MATCHES,
  runAt: 'document_start',
  // world: 'ISOLATED' is the Chrome MV3 default — no need to specify
  main(_ctx) {
    /**
     * Extension-context-invalidation guard. After the extension is reloaded or
     * auto-updated, OLD content scripts in already-open tabs hold references to
     * a now-dead chrome.runtime context; any chrome.* call from them throws
     * `Extension context invalidated.` The canonical detection is
     * `chrome.runtime?.id === undefined` — chrome.runtime may still exist as a
     * property reference, but its `id` getter throws or returns undefined when
     * the context is dead.
     *
     * Every chrome.* call in this file is wrapped with this guard. The
     * background's onInstalled re-injection attempts automatic recovery; if it
     * fails (or hasn't run yet), this guard ensures the page console gets ONE
     * actionable warning instead of throwing on every CustomEvent.
     */
    let _warnedUser = false;
    function isExtensionContextValid(): boolean {
      try {
        // chrome.runtime?.id is the canonical detection — undefined when context is dead.
        // The optional-chaining guards against chrome.runtime itself being undefined,
        // although in practice chrome.runtime survives invalidation; only its `id`
        // getter goes away.
        if (chrome.runtime?.id) return true;
      } catch {
        // Some Chrome versions throw on the `chrome.runtime.id` access when the context
        // is dead. Treat throw as invalidated.
      }
      if (!_warnedUser) {
        _warnedUser = true;
        // One-shot user-facing message in the page console. Background
        // re-injection may recover automatically — a NEW content script runs
        // alongside this dead one (the old one stays broken until the page is
        // refreshed). The message tells the user the safe recovery path:
        // refresh the tab.
        console.warn(
          'Darwinium extension was reloaded — refresh this tab to restore the MCP bridge.',
        );
      }
      return false;
    }

    function bridgeRequest(op: string, args?: unknown, timeoutMs = 30_000): Promise<unknown> {
      const id = crypto.randomUUID(); // Built-in Chromium 92+; no uuid npm dep
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          document.removeEventListener('dwn-mcp-resp', onResp);
          clearTimeout(timer);
        };
        const onResp = (rawEvent: Event) => {
          // Shape gate. A third-party page script could fire malformed
          // `dwn-mcp-resp` events to probe the bridge surface. The id-equality
          // check below already handles spoofed-but-wrong ids; this guard
          // prevents a `detail.error` access on a non-object detail (e.g.
          // detail = "string-payload") from throwing on the rejection path.
          const e = rawEvent as CustomEvent<{ id?: unknown; result?: unknown; error?: unknown }>;
          if (typeof e.detail?.id !== 'string') return;
          if (e.detail.id !== id) return;
          cleanup();
          if (typeof e.detail.error === 'string') reject(new Error(e.detail.error));
          else resolve(e.detail.result);
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Bridge timeout after ${timeoutMs}ms: ${op}`));
        }, timeoutMs);
        document.addEventListener('dwn-mcp-resp', onResp);
        document.dispatchEvent(new CustomEvent('dwn-mcp-req', { detail: { id, op, args } }));
      });
    }

    // SW-message → page-bridge forwarder. The SW's command-router calls
    // chrome.tabs.sendMessage(tabId, {type:'sw-bridge-req', op, args, timeoutMs?})
    // per src/shared/messages.ts SwBridgeReqMsg; we forward to the MAIN-world
    // bridge via the bridgeRequest helper and reply via sendResponse.
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      // If our extension context is dead (extension was reloaded), bail. In
      // practice the runtime severs the dispatcher → listener channel when the
      // context dies, so this branch rarely fires; defense-in-depth for the
      // edge case where a late dispatch reaches an old script before Chrome
      // cleans up.
      if (!isExtensionContextValid()) return false;
      if (msg?.type === 'sw-bridge-req') {
        const op = msg.op as string;
        const args = msg.args as unknown;
        const timeoutMs = (msg.timeoutMs as number | undefined) ?? 30_000;
        bridgeRequest(op, args, timeoutMs)
          .then((result) => {
            // Re-check before calling sendResponse — bridgeRequest is async (up to 30s)
            // and the context could be invalidated between dispatch and reply.
            if (isExtensionContextValid()) sendResponse({ result });
          })
          .catch((error) => {
            if (isExtensionContextValid()) sendResponse({ error: (error as Error).message });
          });
        return true; // async response — Chrome requires returning true to keep the message channel open
      }
      return false;
    });

    // -- Tool-call toast renderer ------------------------------------------
    // The SW's command-router broadcasts `tool-call:start` / `tool-call:end`
    // via chrome.tabs.sendMessage to the connected portal tab. We render a
    // small Shadow-DOM-isolated toast stack in the bottom-right corner of the
    // page so the user gets immediate visual confirmation that an MCP tool
    // was called (and whether it succeeded or failed).
    //
    // The Shadow DOM container is lazy-injected on the first start event —
    // most pages will never see one (only *.darwinium.com tabs that the user
    // has connected to via the popup). Toasts auto-fade after the call ends;
    // the host has `pointer-events: none` so clicks fall through to the page.
    //
    // Filter: only `entry.isCommand === true` (i.e. `op === 'runCommand'`)
    // is rendered as a toast. Infra ops (listCommands, pageId pushes) still
    // appear in the popup History panel but would be too chatty here.
    type ToolCallStartMsg = {
      type: 'tool-call:start';
      entry: {
        id: string;
        name: string;
        isCommand: boolean;
        argsPreview?: string;
        startedAt: number;
        status: 'pending' | 'success' | 'error';
      };
    };
    type ToolCallEndMsg = {
      type: 'tool-call:end';
      id: string;
      durationMs: number;
      status: 'pending' | 'success' | 'error';
      error?: string;
    };

    let toastShadow: ShadowRoot | undefined;
    let toastList: HTMLUListElement | undefined;

    function ensureToastHost(): { shadow: ShadowRoot; list: HTMLUListElement } | undefined {
      if (toastShadow && toastList && toastList.isConnected) {
        return { shadow: toastShadow, list: toastList };
      }
      // First-call lazy injection. document.body may not exist yet on
      // document_start; bail and let the next event re-attempt.
      if (!document.body) return undefined;
      const host = document.createElement('div');
      host.id = 'dwn-mcp-toast-host';
      // Inline styles on the host element — these can't be reached from inside
      // the Shadow DOM. pointer-events:none lets clicks fall through so the
      // toast doesn't block portal interactions.
      Object.assign(host.style, {
        position: 'fixed',
        bottom: '16px',
        right: '16px',
        zIndex: '2147483647',
        pointerEvents: 'none',
        // No background/border on the host — only the individual toasts paint.
      } satisfies Partial<CSSStyleDeclaration>);
      const shadow = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = `
        :host { all: initial; }
        ul { all: initial; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; list-style: none; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
        li {
          all: initial;
          display: flex; align-items: center; gap: 8px;
          background: #1f2937; color: #f9fafb;
          padding: 8px 12px; border-radius: 8px;
          font-size: 12px; line-height: 1.3;
          box-shadow: 0 4px 12px rgba(0,0,0,0.25);
          max-width: 320px;
          opacity: 0; transform: translateY(8px);
          transition: opacity 200ms ease, transform 200ms ease;
          pointer-events: auto;
          cursor: default;
        }
        li[data-state="visible"] { opacity: 1; transform: translateY(0); }
        li[data-state="leaving"] { opacity: 0; transform: translateY(8px); }
        .icon { display: inline-block; width: 14px; text-align: center; flex-shrink: 0; }
        .name { font-weight: 600; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .status { font-size: 11px; opacity: 0.75; }
        .dot {
          width: 8px; height: 8px; border-radius: 50%;
          background: #60a5fa;
          animation: pulse 1.2s ease-in-out infinite;
          flex-shrink: 0;
        }
        li[data-status="success"] .dot { background: #10b981; animation: none; }
        li[data-status="error"]   .dot { background: #ef4444; animation: none; }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50%      { opacity: 0.35; }
        }
      `;
      const list = document.createElement('ul');
      shadow.appendChild(style);
      shadow.appendChild(list);
      document.body.appendChild(host);
      toastShadow = shadow;
      toastList = list;
      return { shadow, list };
    }

    const TOAST_VISIBLE_CAP = 5;
    const TOAST_FADE_MS = 2500;

    function pruneToastList(list: HTMLUListElement): void {
      // Drop oldest toasts if we exceed the visible cap. Element order is
      // append-newest-last, so drop from the front.
      while (list.children.length > TOAST_VISIBLE_CAP) {
        list.firstChild?.remove();
      }
    }

    function fadeAndRemove(li: HTMLLIElement): void {
      li.dataset.state = 'leaving';
      // Match transition duration in CSS (200ms).
      window.setTimeout(() => li.remove(), 220);
    }

    function renderToastStart(msg: ToolCallStartMsg): void {
      if (!msg.entry.isCommand) return; // skip infra ops
      const host = ensureToastHost();
      if (!host) return;
      const li = document.createElement('li');
      li.dataset.id = msg.entry.id;
      li.dataset.status = 'pending';
      li.dataset.state = 'enter';

      const dot = document.createElement('span');
      dot.className = 'dot';

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = msg.entry.name;

      const status = document.createElement('span');
      status.className = 'status';
      status.textContent = '…';

      li.append(dot, name, status);
      host.list.appendChild(li);
      pruneToastList(host.list);

      // Defer one frame so the enter→visible transition actually animates
      // (otherwise the browser collapses the state change into one paint).
      requestAnimationFrame(() => {
        li.dataset.state = 'visible';
      });
    }

    function renderToastEnd(msg: ToolCallEndMsg): void {
      if (!toastList) return; // no toasts visible — nothing to do
      const li = toastList.querySelector<HTMLLIElement>(`li[data-id="${CSS.escape(msg.id)}"]`);
      if (!li) return;
      li.dataset.status = msg.status;
      const status = li.querySelector<HTMLSpanElement>('.status');
      if (status) {
        if (msg.status === 'success') status.textContent = `✓ ${msg.durationMs}ms`;
        else if (msg.status === 'error') status.textContent = `✖ ${msg.error ?? 'error'}`;
        else status.textContent = '…';
      }
      // Auto-fade after the stickiness window expires.
      window.setTimeout(() => fadeAndRemove(li), TOAST_FADE_MS);
    }

    chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
      if (!isExtensionContextValid()) return false;
      if (msg?.type === 'tool-call:start') {
        renderToastStart(msg as ToolCallStartMsg);
        return false;
      }
      if (msg?.type === 'tool-call:end') {
        renderToastEnd(msg as ToolCallEndMsg);
        return false;
      }
      return false;
    });

    // -- Connection-state push channel --------------------------------------
    // The SW pushes `mcp-connection-state` on every WS lifecycle event and on
    // every 30s 'wake' alarm (heartbeat). We re-dispatch it as a document
    // CustomEvent so both the MAIN-world latch and the portal's own React code
    // can read it — `document.dispatchEvent` crosses the realm boundary, and
    // the portal is the only thing on these hosts that listens for it.
    chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
      if (!isExtensionContextValid()) return false;
      if (msg?.type === 'mcp-connection-state') {
        const { state, at } = msg as { state: unknown; at: unknown };
        if (typeof state === 'string' && typeof at === 'number') {
          document.dispatchEvent(
            new CustomEvent('dwn-mcp-connection-state', { detail: { state, at } }),
          );
        }
        return false;
      }
      return false;
    });

    // Ask for the current state immediately. Without this, a page that reloads
    // while the bridge is already open would show nothing until the next
    // heartbeat (up to 30s).
    if (isExtensionContextValid()) {
      chrome.runtime.sendMessage({ type: 'page:requestConnectionState' }).catch(() => {
        // SW asleep or context torn down — the next heartbeat covers it.
      });
    }

    // -- Page-id push channel -----------------------------------------------
    // MAIN-world fires this CustomEvent on SPA route change; we forward to the
    // SW, which forwards to the binary as a {type:'pageIdChanged'} WS frame
    // (per src/shared/messages.ts PageIdChangedMsg).
    document.addEventListener('dwn-mcp-pageid-changed', (e) => {
      // Extension-context guard: PageContextProvider dispatches this
      // CustomEvent on every registry recomputation, so after an extension
      // reload chrome.runtime.sendMessage would throw here on every keystroke
      // into the query editor.
      if (!isExtensionContextValid()) return;
      const pageId = (e as CustomEvent<{ pageId: string }>).detail?.pageId;
      if (typeof pageId === 'string' && pageId.length > 0) {
        // Even with the early guard, sendMessage CAN reject (race: context dies between
        // the guard check and the call). Catch the rejection to avoid an unhandled
        // promise rejection in the page console.
        chrome.runtime.sendMessage({ type: 'pageIdChanged', pageId }).catch(() => {
          // Swallow — a future event will retry. The user-facing warn already fired.
        });
      }
    });
  },
});
