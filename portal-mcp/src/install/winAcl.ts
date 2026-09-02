/**
 * Windows ACL helpers.
 *
 * Windows file mode bits don't restrict group/other access the way POSIX
 * `0o600` does. To match POSIX semantics we shell out to `icacls`:
 *
 *   icacls <path> /inheritance:r /grant:r "<user>:F"
 *
 * `/inheritance:r` removes inherited ACEs (otherwise group/other rights flow
 * down from the parent dir); `/grant:r` replaces any existing ACEs for the
 * named principal with the given mask; `<user>:F` grants Full Control to
 * exactly the current user.
 *
 * The caller (`install.ts`) calls `lockAcl()` on BOTH the token file AND the
 * parent dir so directory enumeration is also restricted.
 *
 * SECURITY — `spawnSync` with array-form argv prevents shell
 * injection from domain-joined usernames containing backslashes (e.g.
 * `DOMAIN\User`). The `cmd` returned in the result is the user-runnable shell
 * form for the troubleshooting `Run \`<cmd>\` manually.` message — that string
 * is built with proper double-quoting but is NOT executed.
 *
 * Non-Windows: every export is a no-op shape-correct stub. Doctor's
 * `token.acl` check returns skipped on non-Windows; install/rotate's
 * `lockAcl` calls short-circuit before the child_process import so this
 * module is safe to lazy-import on macOS/Linux.
 */
import { spawnSync } from 'node:child_process';
import * as os from 'node:os';

/** Outcome of `lockAcl(path)`. */
export interface LockAclResult {
  /** True if ACL was locked (or platform is non-Windows — nothing to do). */
  ok: boolean;
  /** Stderr from icacls or `exit <N>` description if `ok === false`. */
  error?: string;
  /** User-runnable shell form for the troubleshooting message. Empty on no-op. */
  cmd: string;
}

/**
 * Lock `targetPath` so only the current user has Full Control.
 *
 * On non-Windows: returns `{ok:true, cmd:''}` — POSIX file mode 0600/0700
 * (set elsewhere) already provides equivalent restriction.
 */
export function lockAcl(targetPath: string): LockAclResult {
  if (process.platform !== 'win32') {
    return { ok: true, cmd: '' };
  }
  const username = os.userInfo().username;
  // User-runnable troubleshooting form — built with double-quoting because the
  // message will be copy-pasted into a Windows shell. Note the explicit
  // double-quotes around the username — domain-joined usernames may contain
  // backslashes which need quoting in cmd.exe.
  const cmd = `icacls "${targetPath}" /inheritance:r /grant:r "${username}:F"`;
  const res = spawnSync('icacls', [targetPath, '/inheritance:r', '/grant:r', `${username}:F`], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    return {
      ok: false,
      error: res.stderr?.toString().trim() || `exit ${res.status}`,
      cmd,
    };
  }
  return { ok: true, cmd };
}

/** Outcome of `readAclState(path)` — used by the doctor `token.acl` check. */
export interface ReadAclStateResult {
  /** True if no `(I)` (inherited) ACE was found in icacls output. */
  inheritanceBroken: boolean;
  /** Raw icacls stdout for diagnostic display in doctor `--json`. */
  raw: string;
}

/**
 * Inspect ACL state of `targetPath`. Doctor's `token.acl` check passes when
 * `inheritanceBroken === true` (i.e., `lockAcl` has been applied).
 *
 * Non-Windows: returns `{inheritanceBroken: true, raw: 'skipped'}`. The
 * caller surfaces this as a doctor `null` (skipped) result.
 */
export function readAclState(targetPath: string): ReadAclStateResult {
  if (process.platform !== 'win32') {
    return { inheritanceBroken: true, raw: 'skipped' };
  }
  const res = spawnSync('icacls', [targetPath], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  const raw = res.stdout?.toString() ?? '';
  // `(I)` flag in any line means at least one ACE is inherited from the parent.
  // A locked file should have NO line containing `(I)`.
  const inheritanceBroken = !raw.split('\n').some((l) => /\(I\)/.test(l));
  return { inheritanceBroken, raw };
}
