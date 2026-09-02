/**
 * Popup — top-level component implementing the five-layout connection state
 * machine. Layout derives from chrome.storage.local.token (paired or not),
 * chrome.storage.session connectedTabId / connectionState / lastError(+At),
 * and a local `forcedRepair` flag (Re-pair forces the pre-pair UI without
 * erasing the token). State management is plain React useState/useEffect plus
 * a chrome.storage.onChanged listener — the tree is small enough that
 * re-rendering on every storage event is negligible.
 */
import { useEffect, useState, useCallback } from 'react';
import { StatusPill, type StatusKind } from './StatusPill';
import { PrimaryButton } from './PrimaryButton';
import { SecondaryButton } from './SecondaryButton';
import { TokenInput } from './TokenInput';
import { ErrorRow } from './ErrorRow';
import { ToolHistoryPanel } from './ToolHistoryPanel';
import type { ConnectionState } from '../../src/shared/messages';
import styles from './popup.module.css';

type PopupTab = 'connection' | 'history';

type LastErrorKind =
  | 'TOKEN_MISMATCH'
  | 'NO_TAB'
  | 'LOST_MID_CALL'
  | 'PAIRING_FAILED'
  | 'BINARY_NOT_RUNNING'
  | 'PAIRING_WINDOW_UNAVAILABLE';

interface StoredState {
  token: string | undefined;
  connectedTabId: number | undefined;
  wsOpen: boolean;                         // back-compat — derived from connectionState === 'open' on the SW side
  connectionState: ConnectionState | undefined;
  lastError: LastErrorKind | undefined;
  lastErrorAt: number | undefined;
  activeTabUrl: string | undefined;
  activeTabId: number | undefined;
  // Resolved from connectedTabId via chrome.tabs.get — the URL of the tab the
  // bridge is paired to. Differs from activeTabUrl when the user opens the
  // popup while a non-Darwinium tab is foregrounded but a paired session is
  // still alive on a different tab in the same window.
  connectedTabUrl: string | undefined;
}

/**
 * Error-row copy per error kind.
 *
 * NOTE: do not include `PAGE_NAVIGATED` here — that error never lands in the
 * popup; it's surfaced to the host LLM only.
 */
const ERROR_COPY: Record<LastErrorKind, string> = {
  TOKEN_MISMATCH: '⚠ Token mismatch. Click "Re-pair" and enter the OOB code from your installer.',
  NO_TAB: '⚠ No Darwinium tab. Open *.darwinium.com or *.int.darwinium.io and click Connect.',
  LOST_MID_CALL: '⚠ Lost connection. The extension is reconnecting...',
  PAIRING_FAILED: '⚠ Pairing failed. The code may have expired or been mistyped. Re-run `install` for a new code or try again.',
  // Fires when a `tok.<hex>` reconnect produces close 1006 with no open event.
  // Two indistinguishable wire-level causes:
  //   (a) `serve` not listening (ECONNREFUSED)
  //   (b) `install` / `rotate-token` is running an OOB pairing server on the
  //       same port, which rejects the hex-shape protocol at HTTP 401 (the
  //       browser surfaces both as close 1006 — the SW can't tell them apart).
  // The copy lists both recovery paths so the user picks the one that matches
  // what they were just doing.
  BINARY_NOT_RUNNING: '⚠ Cannot reach the MCP bridge. If you just ran `install` or `rotate-token`, click "Re-pair" and enter the new 6-digit code. Otherwise, start Claude Desktop or run `npx @darwinium/portal-mcp serve` in a terminal.',
  // Same wire-level cause (ECONNREFUSED, no open event), but the token shape
  // was `pair.<6-digit>`, so the user just pasted an OOB code. The 60-second
  // pairing window is opened by `install` / `rotate-token`, NOT by `serve` —
  // recovery action differs from BINARY_NOT_RUNNING.
  PAIRING_WINDOW_UNAVAILABLE: '⚠ No active pairing window. The 6-digit code is only valid during a 60s window opened by `npx @darwinium/portal-mcp install` (or `rotate-token`). Re-run the installer, then enter the new code.',
};

async function readStorage(): Promise<Pick<StoredState, 'token' | 'connectedTabId' | 'wsOpen' | 'connectionState' | 'lastError' | 'lastErrorAt'>> {
  const local = await chrome.storage.local.get('token');
  const session = await chrome.storage.session.get(['connectedTabId', 'wsOpen', 'connectionState', 'lastError', 'lastErrorAt']);
  const cs = session.connectionState;
  const validCs: ConnectionState | undefined =
    cs === 'pre-pair' || cs === 'connecting' || cs === 'open' || cs === 'closed' ? cs : undefined;
  return {
    token: typeof local.token === 'string' ? local.token : undefined,
    connectedTabId: typeof session.connectedTabId === 'number' ? session.connectedTabId : undefined,
    wsOpen: session.wsOpen === true,
    connectionState: validCs,
    lastError: session.lastError as LastErrorKind | undefined,
    lastErrorAt: typeof session.lastErrorAt === 'number' ? session.lastErrorAt : undefined,
  };
}

async function readActiveTab(): Promise<{ id?: number; url?: string }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return { id: tab?.id, url: tab?.url };
}

export function Popup() {
  const [state, setState] = useState<StoredState>({
    token: undefined,
    connectedTabId: undefined,
    wsOpen: false,
    connectionState: undefined,
    lastError: undefined,
    lastErrorAt: undefined,
    activeTabUrl: undefined,
    activeTabId: undefined,
    connectedTabUrl: undefined,
  });
  /**
   * Local override: when user clicks Re-pair (post-pair OR token-mismatch),
   * force the pre-pair UI until they save a new token or close the popup.
   * Does NOT call chrome.storage.local.remove('token') — the old token
   * persists until overwritten by Save.
   */
  const [forcedRepair, setForcedRepair] = useState(false);
  const [errorDismissed, setErrorDismissed] = useState(false);
  const [saving, setSaving] = useState(false);
  // Active popup tab — resets to "connection" each time the popup re-mounts
  // (which is on every open, so no persistence needed).
  const [activeTab, setActiveTab] = useState<PopupTab>('connection');

  /**
   * Flap debounce — never flash 'Disconnected' if the WS was 'open' within the
   * last 2s. We track the last time we saw `connectionState === 'open'`; the
   * derivation below treats a closed-after-open transition as 'connected' until
   * 2s have passed without recovery. After 2s, the real 'closed' state renders.
   */
  const [lastOpenAt, setLastOpenAt] = useState<number | undefined>(undefined);

  // Bump lastOpenAt whenever connectionState transitions to 'open'.
  useEffect(() => {
    if (state.connectionState === 'open') {
      setLastOpenAt(Date.now());
    }
  }, [state.connectionState]);

  // Force a re-render after 2s when in the debounce window so the layout
  // collapses to disconnected-paired automatically.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (state.connectionState !== 'closed') return;
    if (lastOpenAt === undefined) return;
    const elapsed = Date.now() - lastOpenAt;
    if (elapsed >= 2000) return;
    const timer = setTimeout(() => forceTick((n) => n + 1), 2000 - elapsed + 50);
    return () => clearTimeout(timer);
  }, [state.connectionState, lastOpenAt]);

  // Resolve the URL of the PAIRED tab (state.connectedTabId), not the
  // popup-opener's currently-active tab. Without this, opening the popup
  // while focused on a non-Darwinium tab makes the Connected pill display the
  // wrong URL (e.g. "Connected: https://example.com" while the bridge is in
  // fact still attached to a Darwinium tab in the same window).
  useEffect(() => {
    if (state.connectedTabId === undefined) {
      // Clear stale URL so the disconnected-paired layout doesn't carry over
      // a previous pair's URL into a fresh disconnect render.
      if (state.connectedTabUrl !== undefined) {
        setState((prev) => ({ ...prev, connectedTabUrl: undefined }));
      }
      return;
    }
    let cancelled = false;
    void chrome.tabs.get(state.connectedTabId).then((tab) => {
      if (cancelled) return;
      setState((prev) => ({ ...prev, connectedTabUrl: tab.url }));
    }).catch(() => {
      // Tab gone (closed or no permission) — leave as-is. The layout selector
      // already collapses to disconnected-paired when wsOpen flips to false.
    });
    return () => { cancelled = true; };
  }, [state.connectedTabId]);

  // The token-mismatch row self-collapses 60s after lastErrorAt. The
  // `isTokenMismatch` derivation below treats an error older than 60s as
  // collapsed, but the popup never re-renders at the 60s mark on its own, so
  // the layout would stay sticky on `token-mismatch` after the window expires.
  // This effect schedules a single setTimeout to force-tick at the boundary;
  // the 50ms buffer ensures we render strictly AFTER it so `isTokenMismatch`
  // flips to false. Cleanup-safe via the returned clearTimeout.
  useEffect(() => {
    if (state.lastError !== 'TOKEN_MISMATCH') return;
    if (!state.lastErrorAt) return;
    const elapsed = Date.now() - state.lastErrorAt;
    const remaining = Math.max(0, 60_000 - elapsed);
    const timer = setTimeout(() => forceTick((n) => n + 1), remaining + 50);
    return () => clearTimeout(timer);
  }, [state.lastError, state.lastErrorAt]);

  // Initial state derivation + chrome.storage subscription
  useEffect(() => {
    let mounted = true;
    void Promise.all([readStorage(), readActiveTab()]).then(([stored, tab]) => {
      if (!mounted) return;
      setState({ ...stored, activeTabId: tab.id, activeTabUrl: tab.url, connectedTabUrl: undefined });
    });
    const onChange = (
      changes: { [k: string]: chrome.storage.StorageChange },
      area: chrome.storage.AreaName,
    ) => {
      if (area === 'local' && 'token' in changes) {
        const newToken = changes.token?.newValue;
        setState((prev) => ({ ...prev, token: typeof newToken === 'string' ? newToken : undefined }));
        // Stale-error reset: a fresh token write is the user's recovery action.
        setErrorDismissed(false);
      }
      if (area === 'session') {
        if ('connectedTabId' in changes) {
          const newTabId = changes.connectedTabId?.newValue;
          setState((prev) => ({ ...prev, connectedTabId: typeof newTabId === 'number' ? newTabId : undefined }));
        }
        if ('wsOpen' in changes) {
          setState((prev) => ({ ...prev, wsOpen: changes.wsOpen?.newValue === true }));
        }
        if ('connectionState' in changes) {
          const newCs = changes.connectionState?.newValue;
          const validCs: ConnectionState | undefined =
            newCs === 'pre-pair' || newCs === 'connecting' || newCs === 'open' || newCs === 'closed' ? newCs : undefined;
          setState((prev) => ({ ...prev, connectionState: validCs }));
        }
        if ('lastError' in changes) {
          const newError = changes.lastError?.newValue as LastErrorKind | undefined;
          setState((prev) => ({ ...prev, lastError: newError, lastErrorAt: Date.now() }));
          // A new error overrides any prior manual dismiss — re-show the row.
          setErrorDismissed(false);
        }
        if ('lastErrorAt' in changes) {
          const newAt = changes.lastErrorAt?.newValue;
          setState((prev) => ({ ...prev, lastErrorAt: typeof newAt === 'number' ? newAt : undefined }));
        }
      }
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => {
      mounted = false;
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, []);

  // Derive the visual layout.
  // `connectedTabId` = user intent (set on Connect, cleared on Disconnect).
  // `connectionState` = live WS lifecycle (SW writes 'pre-pair'|'connecting'|'open'|'closed').
  // `wsOpen` = back-compat boolean still maintained by the SW for legacy popup builds.
  // Both connectionState='open' (or wsOpen=true on legacy SW) AND a connectedTabId
  // must hold to display Connected — otherwise the popup would lie about
  // connection state when the binary dies (e.g., MCP host quits) but the user
  // hasn't clicked Disconnect.

  // Backward-compat fallback: if the SW hasn't written connectionState yet
  // (older SW build, or first paint after extension reload), fall back to the
  // legacy wsOpen boolean. New SW builds always write connectionState.
  const csOpen = state.connectionState === 'open' || (state.connectionState === undefined && state.wsOpen);
  const csConnecting = state.connectionState === 'connecting';
  const csClosed = state.connectionState === 'closed' || (state.connectionState === undefined && !state.wsOpen);

  const wsConnected = state.connectedTabId !== undefined && csOpen;
  const isPaired = !!state.token;
  // Token mismatch is "live" only within the 60s error window.
  const isTokenMismatch =
    state.lastError === 'TOKEN_MISMATCH' &&
    !!state.lastErrorAt &&
    Date.now() - state.lastErrorAt < 60_000;

  // Flap debounce: if we recently saw 'open' (within 2s), keep showing connected
  // even though the live state is 'closed'.
  const inDebounceWindow =
    lastOpenAt !== undefined && Date.now() - lastOpenAt < 2000;
  const debouncedWsConnected =
    wsConnected || (csClosed && state.connectedTabId !== undefined && inDebounceWindow);

  let layout: 'pre-pair' | 'connecting' | 'connected' | 'disconnected-paired' | 'token-mismatch' = 'pre-pair';
  let pillState: StatusKind = 'disconnected-unpaired';

  if (forcedRepair || !isPaired) {
    layout = 'pre-pair';
    pillState = 'disconnected-unpaired';
  } else if (isTokenMismatch) {
    layout = 'token-mismatch';
    pillState = 'token-mismatch';
  } else if (debouncedWsConnected) {
    layout = 'connected';
    pillState = 'connected';
  } else if (csConnecting && state.connectedTabId !== undefined) {
    layout = 'connecting';
    pillState = 'connecting';
  } else {
    // chrome.storage.session is cleared on browser restart while local persists:
    // token still in storage, no connectedTabId. Show paired-but-disconnected.
    layout = 'disconnected-paired';
    pillState = 'disconnected';
  }

  // Last-error display gate: 60s window AND not manually dismissed
  const showError =
    state.lastError &&
    state.lastErrorAt &&
    !errorDismissed &&
    Date.now() - state.lastErrorAt < 60_000;
  const errorMsg = state.lastError ? ERROR_COPY[state.lastError] : '';

  const onSave = useCallback(async (token: string) => {
    setSaving(true);
    try {
      await chrome.storage.local.set({ token });
      // Single Connect gesture: pair the token with the popup-resolved active tab.
      const tab = await readActiveTab();
      if (tab.id !== undefined) {
        await chrome.runtime.sendMessage({ type: 'popup:connect', tabId: tab.id });
        setState((prev) => ({ ...prev, activeTabId: tab.id, activeTabUrl: tab.url }));
      }
      setForcedRepair(false);
    } finally {
      setSaving(false);
    }
  }, []);

  const onConnect = useCallback(async () => {
    const tab = await readActiveTab();
    if (tab.id !== undefined) {
      await chrome.runtime.sendMessage({ type: 'popup:connect', tabId: tab.id });
      setState((prev) => ({ ...prev, activeTabUrl: tab.url, activeTabId: tab.id }));
    }
  }, []);

  const onDisconnect = useCallback(async () => {
    await chrome.runtime.sendMessage({ type: 'popup:disconnect' });
  }, []);

  const onRepair = useCallback(() => {
    setForcedRepair(true);
    setErrorDismissed(true);
  }, []);

  const onDismissError = useCallback(() => setErrorDismissed(true), []);

  // Connected URL: prefer the URL of the PAIRED tab (resolved via
  // chrome.tabs.get above). Falls back to the active tab's URL only when no
  // pair exists yet (pre-pair / connecting layouts where connectedTabId is
  // either undefined or freshly set and the chrome.tabs.get round-trip
  // hasn't resolved yet).
  const connectedUrl = state.connectedTabUrl ?? state.activeTabUrl;

  return (
    <div className={styles.root}>
      <div className={styles.tabs} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'connection'}
          className={`${styles.tab} ${activeTab === 'connection' ? styles['tab--active'] : ''}`}
          onClick={() => setActiveTab('connection')}
        >
          Connection
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'history'}
          className={`${styles.tab} ${activeTab === 'history' ? styles['tab--active'] : ''}`}
          onClick={() => setActiveTab('history')}
        >
          History
        </button>
      </div>

      {activeTab === 'connection' && (
        <>
          <StatusPill state={pillState} url={connectedUrl} />

          {layout === 'pre-pair' && <TokenInput onSave={onSave} saving={saving} />}

          {layout === 'connecting' && (
            <>
              {/* Mid-handshake: pill says "Connecting...". Cancel maps to disconnect()
                  which bumps epoch + writes 'closed', collapsing to disconnected-paired. */}
              <SecondaryButton label="Cancel" onClick={onDisconnect} />
            </>
          )}

          {layout === 'connected' && (
            <>
              <SecondaryButton label="Disconnect" onClick={onDisconnect} />
              {/* Tertiary Re-pair link */}
              <button type="button" className={styles.link} onClick={onRepair}>Re-pair</button>
            </>
          )}

          {layout === 'disconnected-paired' && (
            <>
              <SecondaryButton label="Connect" onClick={onConnect} />
              <button type="button" className={styles.link} onClick={onRepair}>Re-pair</button>
            </>
          )}

          {layout === 'token-mismatch' && (
            <PrimaryButton label="Re-pair" onClick={onRepair} />
          )}

          {showError && state.lastError && state.lastErrorAt && (
            <ErrorRow
              message={errorMsg}
              showAt={state.lastErrorAt}
              onDismiss={onDismissError}
            />
          )}
        </>
      )}

      {activeTab === 'history' && <ToolHistoryPanel />}
    </div>
  );
}
