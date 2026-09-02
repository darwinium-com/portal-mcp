import { defineContentScript } from 'wxt/utils/define-content-script';

import { CONTENT_SCRIPT_MATCHES } from '../src/shared/hostPatterns';

/**
 * MAIN-world content script. Runs in the page's own JS realm so it can read
 * window[Symbol.for('darwinium.pageCommands')] — ISOLATED is a separate realm
 * that cannot see the symbol-keyed registry. Bridges 'dwn-mcp-req'/'dwn-mcp-resp'
 * CustomEvents (UUID-correlated) and pushes page-id changes on SPA navigation.
 * The bridge accepts requests from any caller in the same realm; the
 * SW → ISOLATED → MAIN chain is the trust boundary.
 */
export default defineContentScript({
  matches: CONTENT_SCRIPT_MATCHES,
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    // Idempotence guard for re-injection: chrome.scripting.executeScript on
    // extension reload re-runs this main() body in the page realm. Without this
    // guard, every reload registers a SECOND dwn-mcp-req listener and a SECOND
    // setupPageIdObserver (monkey-patching history.pushState again, doubling
    // emit() per nav) — mutation commands like selectEvents would fire twice
    // per call. The MAIN realm has no chrome.runtime to invalidate, so the OLD
    // listener stays alive forever across reloads.
    const SENTINEL_KEY = Symbol.for('darwinium.portalMain.installed');
    const w = window as unknown as Record<symbol, boolean>;
    if (w[SENTINEL_KEY]) {
      return; // already installed by a prior injection
    }
    w[SENTINEL_KEY] = true;

    // Wire-format literal — duplicated from aphex-frontend's darwiniumPageCommandsSymbol.ts
    // (different bundle; can't import at runtime). KEEP IN SYNC.
    const REGISTRY_SYMBOL_KEY = 'darwinium.pageCommands';

    // Announce this MCP client to the page so it mounts its command registrars
    // (they stay unmounted until a client attaches). Flag + event literals are
    // duplicated from aphex-frontend's mcpClientAttached.ts. KEEP IN SYNC.
    // Runs at document_start, so the flag is set before the React app mounts;
    // the event covers pages that mounted before a late (re-)injection.
    w[Symbol.for('darwinium.mcpClientAttached')] = true;
    document.dispatchEvent(new CustomEvent('darwinium:mcp-client-attached'));

    // Connection-state latch. The ISOLATED script re-dispatches the SW's
    // `mcp-connection-state` pushes as `dwn-mcp-connection-state` document
    // events, but the portal's React tree mounts long after document_start and
    // would miss every push that landed before it. Latching the newest push on
    // a page-realm window symbol gives it a synchronous snapshot to read at
    // mount. Symbol + event literals are duplicated from aphex-frontend's
    // mcpServerConnection.ts (different bundle). KEEP IN SYNC.
    const CONNECTION_SYMBOL_KEY = 'darwinium.mcpConnection';
    document.addEventListener('dwn-mcp-connection-state', (rawEvent: Event) => {
      const e = rawEvent as CustomEvent<{ state?: unknown; at?: unknown }>;
      const { state, at } = e.detail ?? {};
      if (typeof state !== 'string' || typeof at !== 'number') return;
      (window as unknown as Record<symbol, unknown>)[Symbol.for(CONNECTION_SYMBOL_KEY)] = {
        state,
        at,
      };
    });

    document.addEventListener('dwn-mcp-req', async (rawEvent: Event) => {
      // Shape gate: a third-party page script in the same MAIN realm could fire
      // malformed dwn-mcp-req events to probe the bridge surface. Reject anything
      // where `id` or `op` is not a string; legitimate callers always pass strings.
      const e = rawEvent as CustomEvent<{ id?: unknown; op?: unknown; args?: unknown }>;
      if (typeof e.detail?.id !== 'string' || typeof e.detail?.op !== 'string') return;
      const { id, op, args } = e.detail as { id: string; op: string; args?: unknown };
      let result: unknown;
      let error: string | undefined;
      try {
        const sym = Symbol.for(REGISTRY_SYMBOL_KEY);
        const getCmds = (window as unknown as Record<symbol, unknown>)[sym];
        if (typeof getCmds !== 'function') throw new Error('Page registry not initialized');
        const commands = (
          getCmds as () => Array<{
            name: string;
            description: string;
            args: unknown[];
            run: (a: unknown) => Promise<unknown>;
            _pageId: string;
          }>
        )();

        switch (op) {
          case 'listCommands':
            result = commands.map((c) => ({
              name: c.name,
              description: c.description,
              args: c.args,
              _pageId: c._pageId,
            }));
            break;
          case 'runCommand': {
            const runArgs = (args ?? {}) as { name?: string; args?: unknown };
            const cmd = commands.find((c) => c.name === runArgs.name);
            if (!cmd) throw new Error(`Unknown command: ${runArgs.name}`);
            result = await cmd.run(runArgs.args ?? {});
            break;
          }
          default:
            throw new Error(`Unknown op: ${op}`);
        }
      } catch (err) {
        error = (err as Error).message;
      }
      document.dispatchEvent(new CustomEvent('dwn-mcp-resp', { detail: { id, result, error } }));
    });

    // Page-id push channel. Library-agnostic monkey-patch of history.pushState/
    // replaceState + popstate/hashchange listeners fires `dwn-mcp-pageid-changed`
    // on every SPA navigation; the CustomEvent crosses realms via
    // document.dispatchEvent, ISOLATED forwards it to the SW, and the SW sends a
    // {type:'pageIdChanged'} WS frame to the binary.
    //
    // The pushed `_pageId` MUST match what `get_page_commands` returns (a
    // route+node id from the registry, NOT pathname+hash) — otherwise
    // `expected_page_id` checks after navigation diverge from the binary's
    // cached `lastKnownPageId`. The portal's PageContextProvider.tsx exposes
    // the registry as a function returning Array<{ name, description, args,
    // run, _pageId }>; per-page commands share a React-route-aware `_pageId`
    // and global commands carry `_pageId: 'global'`. We pick the first
    // non-'global' `_pageId`; if none exists yet, we skip the push (the binary
    // updates lastKnownPageId from the next runCommand response anyway).
    //
    // This observer is a safety net: the authoritative `_pageId` push fires
    // from PageContextProvider.tsx on every registry recomputation. The
    // window-event listeners below cover cold start (before PageContextProvider
    // mounts) and routing that bypasses React; the lastPageId === pageId
    // debounce makes redundant emits no-ops, and the binary's setPageId is
    // idempotent, so both producers can feed the same channel.
    function setupPageIdObserver(): void {
      let lastPageId: string | null = null;

      function derivePageId(): string | null {
        try {
          const sym = Symbol.for(REGISTRY_SYMBOL_KEY);
          const getCmds = (window as unknown as Record<symbol, unknown>)[sym];
          if (typeof getCmds !== 'function') return null; // registry not yet initialized
          const commands = (getCmds as () => Array<{ _pageId?: string }>)();
          // First non-'global' _pageId wins — that's the React-route-aware page
          // id that get_page_commands also returns.
          for (const cmd of commands) {
            if (typeof cmd._pageId === 'string' && cmd._pageId !== 'global') {
              return cmd._pageId;
            }
          }
          return null; // no per-page commands registered yet; skip push
        } catch {
          return null;
        }
      }

      function emit(): void {
        const pageId = derivePageId();
        if (pageId === null) return; // skip push when registry has no per-page commands yet
        if (pageId === lastPageId) return;
        lastPageId = pageId;
        document.dispatchEvent(new CustomEvent('dwn-mcp-pageid-changed', { detail: { pageId } }));
      }

      // Monkey-patch pushState
      const origPush = history.pushState;
      history.pushState = function (...args: Parameters<typeof origPush>) {
        const ret = origPush.apply(this, args);
        queueMicrotask(emit);
        return ret;
      };

      // Monkey-patch replaceState
      const origReplace = history.replaceState;
      history.replaceState = function (...args: Parameters<typeof origReplace>) {
        const ret = origReplace.apply(this, args);
        queueMicrotask(emit);
        return ret;
      };

      // Browser back/forward
      window.addEventListener('popstate', () => queueMicrotask(emit));

      // Hash routing (React Router HashRouter uses location.hash assignment which
      // fires hashchange but does NOT go through pushState/replaceState). Without
      // this listener, navigating from /#/dashboard to /#/investigations leaves
      // the binary's lastKnownPageId stuck on the dashboard.
      window.addEventListener('hashchange', () => queueMicrotask(emit));

      // Initial emit so the binary has a pageId before any nav happens
      queueMicrotask(emit);
    }
    setupPageIdObserver();
  },
});
