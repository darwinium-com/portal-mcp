/**
 * `npx @darwinium/portal-mcp rotate-token` — token rotation.
 *
 * Sequence:
 *   1. migrate.maybeMigrate()  — in case the customer is rotating from a
 *      stale legacy install they never ran `install` against.
 *   2. If TOKEN_PATH is absent: warn + delegate to runInstall.
 *   3. token.regenerate({silent:true})  — fresh 64-hex via TOCTOU-safe wx+0o600.
 *   4. winAcl.lockAcl(TOKEN_PATH)  — re-lock the new file on Windows.
 *   5. oobPair.run({mode:'rotate', expectedToken: newToken})  — same flow as
 *      install but with the "click Re-pair" prompt-copy variant.
 *   6. Success summary + process.exit(0).
 *
 * Security:
 *   - Never echoes the new token (silent mode).
 *   - The audit-line "generated new token at <path>" fires inside
 *     generateAndWrite() so log-aggregators see the rotation.
 *
 * Old-token rejection is enforced by the next `serve` start — the WS
 * hello-frame check fails for the old token because TOKEN_PATH now holds
 * the new one. The smoke test verifies this.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TOKEN_PATH, EXTENSION_DIR } from '../token/paths.js';
import { regenerate } from '../token/store.js';
import * as term from './term.js';
import * as migrate from './migrate.js';
import * as winAcl from './winAcl.js';
import * as oobPair from './oobPair.js';

export async function runRotateToken(): Promise<void> {
  term.info('rotate-token starting...');

  // 1. Idempotent legacy token-path migration (in case install was never run).
  migrate.maybeMigrate(TOKEN_PATH);

  // 2. No-existing-token early branch — delegate to install.
  if (!fs.existsSync(TOKEN_PATH)) {
    term.warn('no existing token to rotate. Running install instead.');
    const { runInstall } = await import('./install.js');
    return runInstall({});
  }

  // 3. Regenerate (silent — token is delivered via OOB pairing).
  const token = regenerate({ silent: true });
  const aclSuffix = process.platform === 'win32' ? ', ACL locked' : '';
  term.ok(`token (regenerated at ${TOKEN_PATH}, mode 0600${aclSuffix})`);

  // 4. Re-apply Windows ACL on the freshly created file. unlink + re-create
  // resets ACLs to inherited; we must re-lock.
  if (process.platform === 'win32') {
    const r = winAcl.lockAcl(TOKEN_PATH);
    if (!r.ok) {
      term.warn(`Could not restrict ACLs: ${r.error}. Run \`${r.cmd}\` manually.`);
    }
  }

  console.error('');

  // 5. OOB pair — `mode:'rotate'` picks the "click Re-pair" prompt copy.
  await oobPair.run({ mode: 'rotate', expectedToken: token });

  // 6. Success summary — include extension version when extension was previously extracted.
  let extVersion = '';
  const manifestPath = path.join(EXTENSION_DIR, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      extVersion = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version as string;
    } catch {
      /* versionless success line is fine */
    }
  }
  if (extVersion) {
    term.ok(`paired with extension (extension version ${extVersion})`);
  } else {
    term.ok('paired with extension');
  }
  term.info('rotate complete. The old token is no longer accepted.');
  process.exit(0);
}
