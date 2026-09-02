import { defineBackground } from 'wxt/utils/define-background';
import {
  connectIfNeeded,
  disconnect,
  reconnectFromTokenChange,
  sendPageIdChanged,
  wakeOrPing,
} from '../src/background/ws-client.js';
import { resetToolCallBadge, clearBadgeFromAlarm } from '../src/background/command-router.js';
import { broadcastCurrentConnectionState } from '../src/background/tab-state.js';
import { hydrateFromStorage as hydrateToolCallHistory, clearHistory as clearToolCallHistory } from '../src/background/tool-call-history.js';
import { CONTENT_SCRIPT_MATCHES } from '../src/shared/hostPatterns.js';

/**
 * Service-worker entrypoint. This body re-runs on every SW spawn (cold start,
 * alarm wake, message wake), so handler registration must be top-level — never
 * inside chrome.runtime.onInstalled, which fires only once per install/update.
 * Module globals (WS, timers, backoff) die with the SW by design; every spawn
 * re-evaluates from chrome.storage.
 */
export default defineBackground(() => {
  // Single 30s alarm carries keepalive + reconnect. setInterval is paused when
  // the SW dozes, so chrome.alarms is the only periodic mechanism that wakes a
  // parked SW. Every 30s (the Chrome 120+ minimum periodInMinutes), wakeOrPing()
  // pings an open WS (resets the SW idle timer) or attempts reconnect.
  // Also clear the legacy 'reconnect' alarm name (alarms persist across
  // extension reloads) so older installs don't double-fire.
  void chrome.alarms.clear('reconnect');
  chrome.alarms.create('wake', { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'wake') {
      void wakeOrPing();
      // Heartbeat to the connected tab. The portal treats the bridge as up only
      // while these keep arriving, so a disabled/reloaded extension decays the
      // page's indicator (and its idle-logout suppression) back off on its own.
      void broadcastCurrentConnectionState();
    }
    // Badge clearing uses chrome.alarms rather than setTimeout so a SW that
    // terminates between request-end and the clear-tick still drains the badge
    // on the next alarm-driven SW wake. command-router.ts schedules
    // `badge-clear`; clearBadgeFromAlarm re-checks inFlight before applying.
    if (alarm.name === 'badge-clear') clearBadgeFromAlarm();
  });

  // Programmatic re-injection on extension reload/update. When the extension is
  // reloaded at chrome://extensions or auto-updated, the OLD content scripts in
  // open *.darwinium.com tabs hold references to the now-dead extension context
  // and their chrome.* calls throw `Extension context invalidated.` Chrome does
  // NOT re-inject declared content scripts on reload — only fresh navigations do.
  //
  // So when the fresh SW spawns post-install/update, re-inject both content
  // scripts into open matching tabs via chrome.scripting.executeScript. The new
  // scripts coexist with the dead old ones — dead listeners bail silently, new
  // listeners serve traffic; old scripts clean up on next navigation/refresh.
  //
  // Requires the 'scripting' permission (wxt.config.ts); without it,
  // executeScript rejects with "Cannot access contents of url" even though
  // host_permissions covers the URL set.
  //
  // The `reason` filter accepts 'install', 'update' (the common Web Store
  // auto-update case), and 'chrome_update' (also invalidates the context).
  // 'shared_module_update' is not relevant for a single-extension package.
  chrome.runtime.onInstalled.addListener(async (details) => {
    if (
      details.reason !== 'install' &&
      details.reason !== 'update' &&
      details.reason !== 'chrome_update'
    ) {
      return;
    }
    try {
      const tabs = await chrome.tabs.query({
        url: [...CONTENT_SCRIPT_MATCHES],
      });
      for (const tab of tabs) {
        if (typeof tab.id !== 'number') continue;
        // Inject the ISOLATED-world content script first (it owns the chrome.runtime
        // listeners that the MAIN-world script's CustomEvents need to forward to the SW).
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content-scripts/portal-isolated.js'],
            // 'world' defaults to 'ISOLATED' — same realm as the manifest declaration.
          });
        } catch (err) {
          console.warn(
            `[portal-extension] re-injection of portal-isolated.js into tab ${tab.id} failed:`,
            (err as Error).message,
          );
        }
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content-scripts/portal-main.js'],
            world: 'MAIN', // Same realm as the manifest declaration.
          });
        } catch (err) {
          console.warn(
            `[portal-extension] re-injection of portal-main.js into tab ${tab.id} failed:`,
            (err as Error).message,
          );
        }
      }
      if (tabs.length > 0) {
        console.log(
          `[portal-extension] re-injected content scripts into ${tabs.length} open Darwinium tab(s) (reason: ${details.reason})`,
        );
      }
    } catch (err) {
      console.warn(
        '[portal-extension] chrome.runtime.onInstalled re-injection failed:',
        (err as Error).message,
      );
    }
  });

  // Atomic WS restart on token rotation.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.token) {
      void reconnectFromTokenChange();
    }
  });

  // Popup commands.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (
      msg &&
      typeof msg === 'object' &&
      (msg as { type?: string }).type === 'popup:connect' &&
      typeof (msg as { tabId?: unknown }).tabId === 'number'
    ) {
      void connectIfNeeded((msg as { tabId: number }).tabId).then(() =>
        sendResponse({ ok: true }),
      );
      return true; // async response
    }
    if (
      msg &&
      typeof msg === 'object' &&
      (msg as { type?: string }).type === 'popup:disconnect'
    ) {
      void disconnect().then(() => sendResponse({ ok: true }));
      return true;
    }
    // Page-id push channel — the ISOLATED content script forwards
    // dwn-mcp-pageid-changed CustomEvents from MAIN as
    // chrome.runtime.sendMessage({type:'pageIdChanged', pageId}). We forward to
    // the binary as a {type:'pageIdChanged'} WS frame.
    if (
      msg?.type === 'pageIdChanged' &&
      typeof msg.pageId === 'string'
    ) {
      sendPageIdChanged(msg.pageId);
      return false; // synchronous, no response needed
    }
    // Freshly-injected content script asking for the current connection state,
    // so a page reload doesn't sit stale until the next 30s heartbeat.
    if (msg?.type === 'page:requestConnectionState') {
      void broadcastCurrentConnectionState();
      return false; // push-based reply; nothing to send back on this channel
    }
    // Tool-call observability — popup History tab Clear button.
    if (msg?.type === 'popup:clearHistory') {
      void clearToolCallHistory().then(() => sendResponse({ ok: true }));
      return true; // async response
    }
    return false;
  });

  // Clear any stale badge state from a SW that died mid-call.
  resetToolCallBadge();

  // Tool-call history — rebuild the in-memory mirror from session storage so
  // pending entries / completed entries from the previous SW instance are
  // visible to the popup. Session storage survives SW respawn, dies on
  // browser restart — exactly the right scope for "session-only debug".
  void hydrateToolCallHistory();

  // Cold start: try to connect immediately if both token + connectedTabId are already set.
  void connectIfNeeded();
});
