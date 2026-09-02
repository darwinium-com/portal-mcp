/**
 * Token-file lifecycle for the binary↔extension WS handshake.
 *
 * The token lives at `<env-paths data dir>/token` (see src/token/paths.ts);
 * legacy-location migration is handled by src/install/migrate.ts.
 *
 * First-launch generation prints the paste-into-popup hint to stderr; existing-
 * token reads are SILENT — never re-print the token after first generation.
 * Production install / rotate-token use OOB pairing and never echo the raw
 * token — those callers pass `{silent:true}`. The dev-only `serve` path leaves
 * `silent` unset, and its token-print line carries a `[SENSITIVE — clear
 * scrollback after copy]` marker.
 *
 * Security: file mode 0o600 + dir mode 0o700; first-launch write uses
 * `fs.openSync(..., 'wx', 0o600)` ('wx' = create exclusive — fails if exists),
 * mitigating the TOCTOU race where mode is silently ignored on existing files.
 * All output via `console.error` — stdout stays pure JSON-RPC (the smoke test
 * asserts the first stdout line is JSON-RPC).
 */
import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { TOKEN_DIR, TOKEN_PATH } from './paths.js';

export function readToken(): string {
  ensureDir();
  if (fs.existsSync(TOKEN_PATH)) {
    // Existing-token path — SILENT; never re-print the token.
    return fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  }
  // First-launch from `serve` standalone path: dev-mode stderr print (with
  // [SENSITIVE] marker). Production install/rotate-token paths use
  // generateAndWrite({silent:true}) directly, never reaching this branch.
  return generateAndWrite();
}

function ensureDir(): void {
  fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
}

/**
 * Generate a fresh 64-hex token, write it with TOCTOU-safe wx+0o600 mode, and
 * (unless silent) print the dev-only paste-into-popup hint to stderr.
 *
 * `opts.silent === true` — production install / rotate-token. Suppresses the two
 * paste-hint lines but keeps the audit-trail "generated new token at ..." line.
 * The customer never sees the raw token; OOB pairing delivers it instead.
 *
 * `opts.silent !== true` — dev-mode `serve` standalone. Prints the paste hint,
 * with the [SENSITIVE] marker on the raw-token line.
 */
export function generateAndWrite(opts?: { silent?: boolean }): string {
  ensureDir();
  const token = randomBytes(32).toString('hex');
  // 'wx' = create exclusive — fails if file already exists. Mitigates TOCTOU on perms
  // (`fs.writeFileSync(..., {mode})` silently ignores mode on existing files).
  const fd = fs.openSync(TOKEN_PATH, 'wx', 0o600);
  try {
    fs.writeSync(fd, token);
  } finally {
    fs.closeSync(fd);
  }
  // Audit-trail line — printed in BOTH silent and non-silent modes so
  // operators can observe token regeneration timing in logs.
  console.error(`portal-mcp: generated new token at ${TOKEN_PATH}`);
  if (!opts?.silent) {
    // Dev-mode branch — the [SENSITIVE] marker prefixes the raw-token line so
    // dev-machine scrollback carries an explicit "clear after copy" reminder.
    console.error(`portal-mcp: [SENSITIVE — clear scrollback after copy] token: ${token}`);
    console.error(`portal-mcp: paste this into the Darwinium Portal MCP extension popup to pair`);
  }
  return token;
}

/**
 * Force-regenerate the token: unlinks the existing file (if present) and writes
 * a fresh one via `generateAndWrite`. Used by `rotate-token`.
 *
 * `opts.silent` is forwarded to `generateAndWrite`; production rotate-token
 * passes `{silent:true}` so the new token is never echoed to stderr (OOB
 * pairing delivers it).
 */
export function regenerate(opts?: { silent?: boolean }): string {
  if (fs.existsSync(TOKEN_PATH)) {
    fs.unlinkSync(TOKEN_PATH);
  }
  return generateAndWrite(opts);
}
