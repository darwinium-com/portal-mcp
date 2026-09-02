/**
 * Legacy token-path migration.
 *
 * Earlier builds unconditionally placed the token at
 * `~/.config/darwinium-portal-mcp/token` on every platform. Current builds use
 * `env-paths` for platform-conventional paths (macOS `~/Library/Application
 * Support/...`, Windows `%APPDATA%/.../Data`, Linux `~/.local/share/...`).
 * On macOS/Windows the path changes; on Linux we silently skip migration.
 *
 * The migration runs once per `install` / `rotate-token` invocation (idempotent
 * — no-op if old path absent OR new path already populated).
 *
 * Output lines:
 *   - Success: `✓ migrated token from <old path> to <new path>`
 *   - Partial: `⚠ migration partial — old token at <old path> still present; please remove manually.`
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as term from './term.js';

/** Legacy token path — hand-coded XDG-style. */
export const LEGACY_TOKEN_PATH = path.join(os.homedir(), '.config', 'darwinium-portal-mcp', 'token');

/**
 * Move the legacy token file to `newTokenPath` if appropriate.
 *
 * Idempotent: no-op when the old path is absent. When BOTH paths exist, log a
 * warn line so the customer can resolve the partial-migration state manually
 * (we never silently overwrite the new file).
 *
 * Linux: silently no-op — env-paths default places the data dir at
 * `~/.local/share/darwinium-portal-mcp/`, distinct from the legacy
 * `~/.config/darwinium-portal-mcp/`. The legacy layout only ever shipped to
 * dev machines (macOS/Windows), so Linux deployments cannot have a stale
 * legacy token to migrate.
 */
export function maybeMigrate(newTokenPath: string): void {
  if (process.platform === 'linux') return;
  if (!fs.existsSync(LEGACY_TOKEN_PATH)) return;
  if (fs.existsSync(newTokenPath)) {
    term.warn(`migration partial — old token at ${LEGACY_TOKEN_PATH} still present; please remove manually.`);
    return;
  }
  // Ensure parent dir exists with secure mode before the rename. mkdirSync is
  // idempotent on a present dir; mode is applied on creation only.
  fs.mkdirSync(path.dirname(newTokenPath), { recursive: true, mode: 0o700 });
  fs.renameSync(LEGACY_TOKEN_PATH, newTokenPath);
  term.ok(`migrated token from ${LEGACY_TOKEN_PATH} to ${newTokenPath}`);
}
