/**
 * Terminal output helpers for the install/doctor/rotate-token CLI subcommands.
 *
 *   - All output goes to STDERR (stdout stays clean for MCP JSON-RPC). The ONE
 *     explicit exception is `doctor --json`, which writes its single JSON object
 *     to stdout via `process.stdout.write` directly (NOT via these helpers).
 *   - Glyph alphabet: `✓` for ok, `⚠` for warn, `✗` for fail. Color is added on
 *     TTY only (and never when `NO_COLOR` is set). Color is NEVER the
 *     load-bearing signal — every line carries a glyph in addition to color.
 *   - Every helper carries the `portal-mcp: ` prefix so screen readers get an
 *     unambiguous source on every line.
 *
 * No external dependencies (no chalk / ora / boxen).
 */

const ANSI = {
  RESET: '\x1b[0m',
  BOLD: '\x1b[1m',
  DIM: '\x1b[2m',
  GREEN: '\x1b[32m',
  YELLOW: '\x1b[33m',
  RED: '\x1b[31m',
};

/** True if stderr is a TTY AND the customer hasn't opted out via `NO_COLOR`. */
function shouldColor(): boolean {
  return process.stderr.isTTY === true && !process.env.NO_COLOR;
}

/** Plain `portal-mcp: <msg>` line — no glyph, no color. */
export function info(msg: string): void {
  console.error(`portal-mcp: ${msg}`);
}

/** Success line: `portal-mcp: ✓ <msg>`. Glyph green on TTY+!NO_COLOR. */
export function ok(msg: string): void {
  const g = shouldColor() ? `${ANSI.GREEN}✓${ANSI.RESET}` : '✓';
  console.error(`portal-mcp: ${g} ${msg}`);
}

/** Warning line: `portal-mcp: ⚠ <msg>`. Glyph yellow on TTY+!NO_COLOR. */
export function warn(msg: string): void {
  const w = shouldColor() ? `${ANSI.YELLOW}⚠${ANSI.RESET}` : '⚠';
  console.error(`portal-mcp: ${w} ${msg}`);
}

/** Failure line: `portal-mcp: ✗ <msg>`. Glyph red on TTY+!NO_COLOR. */
export function fail(msg: string): void {
  const f = shouldColor() ? `${ANSI.RED}✗${ANSI.RESET}` : '✗';
  console.error(`portal-mcp: ${f} ${msg}`);
}

/** Dim helper — used for "skipped" doctor rows; falls back to plain on no-color. */
export function dim(msg: string): string {
  return shouldColor() ? `${ANSI.DIM}${msg}${ANSI.RESET}` : msg;
}

/** Bold helper — reserved for the doctor "Summary:" heading. */
export function bold(msg: string): string {
  return shouldColor() ? `${ANSI.BOLD}${msg}${ANSI.RESET}` : msg;
}

/**
 * Render `lines` inside a 64-column Unicode box (60 inner content columns).
 * Box characters: `┌ ┐ └ ┘ ─ │`. Indented 2 spaces from line start.
 *
 * Each input line is padded (right) to 60 columns so the box's right border
 * aligns. Lines longer than 60 columns are truncated (callers should keep
 * lines short — the "Pairing code:  XXXXXX" content fits comfortably).
 */
export function box(lines: string[]): void {
  const INNER = 60;
  const INDENT = '  ';
  const top = `${INDENT}┌${'─'.repeat(INNER)}┐`;
  const bottom = `${INDENT}└${'─'.repeat(INNER)}┘`;
  console.error(top);
  for (const line of lines) {
    const padded = line.length >= INNER ? line.slice(0, INNER) : line + ' '.repeat(INNER - line.length);
    console.error(`${INDENT}│${padded}│`);
  }
  console.error(bottom);
}
