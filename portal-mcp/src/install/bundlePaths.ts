/**
 * Path resolution that survives single-file compilation.
 *
 * The npm distribution runs `dist/bin/*.js` under Node, where `import.meta.url`
 * points at a real file and bundled resources sit at `<package-root>/`. The
 * macOS distribution (`scripts/build-macos-bundle.mjs`) instead compiles this
 * source into one executable with `bun build --compile`, where every module is
 * served from a virtual filesystem:
 *
 *   import.meta.url   file:///$bunfs/root/portal-mcp     ← NOT on disk
 *   process.argv[1]   /$bunfs/root/portal-mcp            ← NOT on disk
 *   process.execPath  /path/to/portal-mcp                ← the real binary
 *
 * So anything that resolves a sibling file from `import.meta.url` silently
 * resolves inside `/$bunfs/` and fails `existsSync`. Both call sites that care
 * — the bundled extension zip in `install.ts` and `binary.present` in
 * `doctor.ts` — go through this module instead.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Prefix bun mounts compiled modules under. Not a real filesystem path. */
const COMPILED_VFS_PREFIX = '/$bunfs/';

/** True when running from a `bun build --compile` single-file executable. */
export function isCompiledBinary(): boolean {
  return fileURLToPath(import.meta.url).startsWith(COMPILED_VFS_PREFIX);
}

/**
 * On-disk path of the running program.
 *
 * Under a compiled binary `argv[1]` is a virtual path, so `doctor`'s
 * `binary.present` check must stat `process.execPath` instead. Under Node
 * `execPath` is the node runtime itself, so `argv[1]` remains correct there.
 */
export function selfPath(): string {
  return isCompiledBinary() ? process.execPath : (process.argv[1] ?? '');
}

/**
 * Directory containing bundled resources (currently just `extension-bundle/`).
 *
 * - Compiled binary: resources ship beside the executable, so this is the
 *   executable's own directory. In the `.mcpb` layout that is
 *   `<extension-dir>/server/`, holding `portal-mcp` and `extension-bundle/`.
 * - Node/npm: chunks land in `<package-root>/dist/bin/`, so the package root —
 *   holding `extension-bundle/` per package.json `files` — is two levels up.
 */
export function bundleResourceRoot(): string {
  if (isCompiledBinary()) {
    return path.dirname(process.execPath);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** Absolute path to the bundled Chrome extension zip. */
export function bundledExtensionZipPath(): string {
  return path.join(bundleResourceRoot(), 'extension-bundle', 'extension.zip');
}
