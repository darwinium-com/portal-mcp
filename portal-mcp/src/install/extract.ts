/**
 * Bundled-extension extractor.
 *
 * The npm-published binary ships with a copy of the WXT-built portal-extension
 * zip at `extension-bundle/extension.zip` (placed there by
 * `scripts/bundle-extension.ts` during prebuild). At install time we extract it
 * to `<env-paths data dir>/extension/` so customers can load it via Chrome's
 * "Load Unpacked" path on locked corporate machines that can't use the Web
 * Store.
 *
 * Idempotency: if the target directory already contains a manifest.json
 * with the same version as the bundled zip, we skip extraction so re-running
 * `install` doesn't churn the extracted dir. Drift (different version) is
 * handled by overwriting (with `extractAllTo(dir, true, false)`).
 *
 * Security: adm-zip's `extractAllTo(target, true, false)` does NOT preserve
 * original permissions and resolves entry paths relative to the extraction
 * target — no traversal beyond `targetDir`. A symlink pre-planted at the
 * target is risk-accepted.
 */
import AdmZip from 'adm-zip';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Outcome of `extractBundledExtension(zip, target)`. */
export interface ExtractResult {
  /** True if the target dir was actually written (false = idempotent skip). */
  extracted: boolean;
  /** Manifest version of the bundled extension (always populated). */
  version: string;
}

// Validate that `json` parses to an object whose `version` field is a non-empty
// string. Without this, an `as string` cast lets `version: undefined` flow into
// the idempotency check, where `undefined === undefined` is true and every
// re-install silently skips extraction.
function readManifestVersion(json: string, source: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`${source}: manifest.json is not valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${source}: manifest.json is not a JSON object`);
  }
  const v = (parsed as { version?: unknown }).version;
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`${source}: manifest.json missing version string`);
  }
  return v;
}

/**
 * Extract `zipPath` into `targetDir`, skipping when the existing manifest
 * version matches the incoming version.
 *
 * Throws if the bundled zip is missing `manifest.json` or its version field
 * is missing/non-string (catastrophic build-time mistake — caller maps to
 * the `extract failed: ...` line and exits 1).
 */
export function extractBundledExtension(zipPath: string, targetDir: string): ExtractResult {
  // Read the incoming zip's version BEFORE deciding to extract, so we can
  // implement the idempotency check without writing any bytes.
  const zip = new AdmZip(zipPath);
  const manifestEntry = zip.getEntry('manifest.json');
  if (!manifestEntry) {
    throw new Error(`bundled zip ${zipPath} missing manifest.json`);
  }
  const incomingVersion = readManifestVersion(manifestEntry.getData().toString('utf8'), `bundled zip ${zipPath}`);

  const existingManifest = path.join(targetDir, 'manifest.json');
  if (fs.existsSync(existingManifest)) {
    try {
      const existingVersion = readManifestVersion(
        fs.readFileSync(existingManifest, 'utf8'),
        `existing ${existingManifest}`,
      );
      if (existingVersion === incomingVersion) {
        return { extracted: false, version: incomingVersion };
      }
    } catch {
      // Existing manifest is malformed or missing version — fall through and overwrite.
    }
  }

  fs.mkdirSync(targetDir, { recursive: true });
  zip.extractAllTo(targetDir, /* overwrite */ true, /* keepOriginalPermission */ false);
  return { extracted: true, version: incomingVersion };
}
