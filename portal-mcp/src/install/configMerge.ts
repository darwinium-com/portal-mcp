/**
 * Pure additive merge for `claude_desktop_config.json`.
 *
 * Customers may already have other MCP servers configured in their
 * `claude_desktop_config.json`. We must add or update ONLY our own
 * `mcpServers["darwinium-portal-mcp"]` entry, preserving everything else.
 *
 * To guard against config corruption, the caller (`install.ts`) writes a
 * `.bak` before any modification and uses temp+rename for atomicity. This
 * module is pure — no fs reads/writes, no side effects — so it's trivially
 * testable and cannot leak partial state.
 *
 * Pre-existing malformed JSON triggers a hard refusal: if we can't parse it,
 * we don't touch it. The caller maps the thrown error to the user-facing
 * fail line.
 */

/** Shape of the per-server entry written under `mcpServers[<name>]`. */
export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Result of a merge: the new full JSON object plus diff metadata. */
export interface MergeResult {
  /** Full top-level JSON object after merge. Caller serializes + writes. */
  merged: object;
  /** True if the merged JSON differs from `current` (warrants a write). */
  changed: boolean;
  /** True if `current` already had a `mcpServers[serverName]` entry. */
  existed: boolean;
}

/**
 * Returns a merged JSON object with `mcpServers[serverName]` set to `entry`,
 * preserving all other top-level keys and other `mcpServers.*` siblings.
 *
 * `current` semantics:
 *   - `null` → treated as empty starting point (file did not exist on disk).
 *   - non-null non-object (e.g. array, string, number) → throws.
 *
 * Idempotency: if the existing entry is byte-equal (via JSON.stringify of
 * `args` and `env`) to the proposed entry, returns `{changed: false}` so the
 * caller can skip the `.bak` write and the temp-rename.
 */
export function mergeMcpServersEntry(current: unknown, serverName: string, entry: McpServerEntry): MergeResult {
  // Treat null (file absent) as empty starting point. Any other non-object is
  // a malformed file and we refuse to write.
  if (current !== null && (typeof current !== 'object' || Array.isArray(current))) {
    throw new Error('claude_desktop_config.json is not a JSON object');
  }
  const base: Record<string, unknown> = (current ?? {}) as Record<string, unknown>;

  // `mcpServers` must be a plain object or absent. Anything else (a string, an
  // array) is malformed, and spreading it would scatter its indices across the
  // rewritten config — so it takes the same hard refusal as malformed JSON
  // rather than being silently coerced.
  const rawServers = base.mcpServers;
  if (
    rawServers !== undefined &&
    (typeof rawServers !== 'object' || rawServers === null || Array.isArray(rawServers))
  ) {
    throw new Error('claude_desktop_config.json has a malformed "mcpServers" value');
  }
  const mcpServers: Record<string, unknown> = (rawServers ?? {}) as Record<string, unknown>;

  const existing = mcpServers[serverName];
  const existed = existing !== undefined;

  // Narrow before reading fields: a non-object entry simply fails the match and
  // gets overwritten, which is what the old `any` did implicitly.
  const existingEntry =
    typeof existing === 'object' && existing !== null ? (existing as Partial<McpServerEntry>) : undefined;

  // Drift detection: compare command, args, env via stable JSON encoding. We
  // intentionally use JSON.stringify(args) instead of array equality so order
  // and nested structures are compared deeply.
  const isMatch =
    existingEntry !== undefined &&
    existingEntry.command === entry.command &&
    JSON.stringify(existingEntry.args) === JSON.stringify(entry.args) &&
    JSON.stringify(existingEntry.env ?? {}) === JSON.stringify(entry.env ?? {});

  if (isMatch) {
    return { merged: base, changed: false, existed: true };
  }

  return {
    merged: { ...base, mcpServers: { ...mcpServers, [serverName]: entry } },
    changed: true,
    existed,
  };
}
