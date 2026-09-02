/**
 * WS keepalive ping — fires from the chrome.alarms 'wake' tick in
 * entrypoints/background.ts (every 30s, the MV3 alarm minimum).
 *
 * MV3 PITFALL: setInterval/setTimeout do NOT keep MV3 service workers alive.
 * When the SW becomes idle, Chrome pauses the entire JS event loop including
 * timers — an interval keepalive can never fire after the SW dozes, so the 30s
 * idle timer kills the SW, closing the WS and triggering connect-cycling.
 *
 * chrome.alarms IS allowed to wake a parked SW — the only way to get periodic
 * work in MV3. So the alarm tick is the heartbeat: each tick wakes the SW and
 * runs this ping, which doubles as an idle-timer reset via the Chrome 116+
 * "any WS message resets idle timer" rule.
 *
 * Why JSON ping not RFC 6455 control-frame ping: the binary's frame router
 * parses JSON envelopes; a control frame would need a separate server branch.
 * The binary echoes pong for type:'ping'.
 */

/**
 * Send a {type:'ping'} envelope on the given WS if it's OPEN. No-op otherwise.
 * Called from (a) ws.open handler (immediate first ping so we don't wait up
 * to 30s for the first alarm tick) and (b) the chrome.alarms 'wake' handler.
 */
export function pingIfOpen(ws: WebSocket): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
  }
}
