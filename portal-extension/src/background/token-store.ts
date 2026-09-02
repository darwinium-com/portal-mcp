/**
 * Token persistence for the SW WS handshake.
 *
 * The token is the per-install secret that gates the binary's WS server. It's
 * pasted by the user into the popup, persisted to chrome.storage.local so it
 * survives browser restart (paste-once UX), and read by the SW WS client to
 * build the Sec-WebSocket-Protocol header on every connect.
 *
 * Atomic restart on token rotation: when setToken() updates the value,
 * chrome.storage.onChanged fires; the SW's listener in
 * `entrypoints/background.ts` calls `reconnectFromTokenChange()` to close the
 * current WS (1000 'token rotated') + reset backoff + reconnect. NEVER call
 * setToken() and expect the next user action to trigger reconnect — the change
 * listener handles it atomically.
 */

/**
 * Returns the persisted token, or `undefined` if the user has never paired
 * (pre-pair state — popup will show the paste field).
 */
export async function getToken(): Promise<string | undefined> {
  const stored = await chrome.storage.local.get('token');
  const value = stored.token;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Persists the token (trimmed). Triggers chrome.storage.onChanged → SW
 * atomic-restart of the WS.
 */
export async function setToken(token: string): Promise<void> {
  await chrome.storage.local.set({ token: token.trim() });
  // chrome.storage.onChanged listener in entrypoints/background.ts triggers
  // reconnectFromTokenChange().
}

/**
 * Removes the token (e.g. user clicked "Forget pairing"). The SW's storage
 * change listener will see the change and close the WS gracefully.
 */
export async function clearToken(): Promise<void> {
  await chrome.storage.local.remove('token');
}

/**
 * Re-export `clearLastError` from tab-state.ts so callers that already import
 * from token-store.ts can clear the lastError pair in the same import line.
 * The canonical implementation stays in tab-state.ts (which owns the
 * chrome.storage.session keys); this is a thin re-export, not a duplicate.
 */
export { clearLastError } from './tab-state.js';
