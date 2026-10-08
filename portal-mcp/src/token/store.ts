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
 * Security: file mode 0o600 + dir mode 0o700; first-launch writes an exclusive
 * temporary file and atomically links it into place. Concurrent launches read
 * the winner, and can never observe a partially written token.
 * All output via `console.error` — stdout stays pure JSON-RPC (the smoke test
 * asserts the first stdout line is JSON-RPC).
 */
import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { TOKEN_PATH } from './paths.js';

export function readToken(tokenPath = TOKEN_PATH): string {
  ensureDir(tokenPath);
  if (fs.existsSync(tokenPath)) {
    // Existing-token path — SILENT; never re-print the token.
    return fs.readFileSync(tokenPath, 'utf8').trim();
  }
  // First-launch from `serve` standalone path: dev-mode stderr print (with
  // [SENSITIVE] marker). Production install/rotate-token paths use
  // generateAndWrite({silent:true}) directly, never reaching this branch.
  try {
    return generateAndWrite({ path: tokenPath });
  } catch (err) {
    // Simultaneous first launches must all use the token that won publication.
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return fs.readFileSync(tokenPath, 'utf8').trim();
  }
}

function ensureDir(tokenPath = TOKEN_PATH): void {
  fs.mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
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
export function generateAndWrite(opts?: { silent?: boolean; path?: string }): string {
  const tokenPath = opts?.path ?? TOKEN_PATH;
  ensureDir(tokenPath);
  const token = randomBytes(32).toString('hex');
  // Create a private temporary inode before publishing it at the final path.
  const temporaryPath = `${tokenPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = fs.openSync(temporaryPath, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, token);
    } finally {
      fs.closeSync(fd);
    }
    // Publish a complete file atomically without overwriting another launch's
    // token. Readers can never observe the empty file between open and write.
    fs.linkSync(temporaryPath, tokenPath);
  } finally {
    fs.unlinkSync(temporaryPath);
  }
  // Audit-trail line — printed in BOTH silent and non-silent modes so
  // operators can observe token regeneration timing in logs.
  console.error(`portal-mcp: generated new token at ${tokenPath}`);
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
