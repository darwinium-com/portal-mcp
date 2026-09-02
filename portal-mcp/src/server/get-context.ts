/**
 * 50KB cap + field-drop policy for `get_context` tool responses.
 *
 * The drop paths follow the actual `ConditionerResult` shape
 * (darwinium-node-context/src/types.ts): `featuresExplained` is one key with
 * `globalJourneyMetadata` / `journeyMetadata` sub-arrays.
 *
 * Drop order:
 *   featuresExplained.globalJourneyMetadata → featuresExplained.journeyMetadata →
 *   signals → contexts → stepNames
 * Always retain: viper, page, route, _pageId, instructions.
 * Last-resort: pop viper[] elements until under cap (preserves valid JSON).
 * NEVER byte-truncate JSON.stringify output (would produce invalid JSON).
 */

const MAX_BYTES = 50_000;

// Field-drop priority. One pass per attempt; iterate until under MAX_BYTES or
// DROP_ORDER exhausted.
const DROP_ORDER: Array<string[]> = [
  ['featuresExplained', 'globalJourneyMetadata'], // Drop the global journey metadata first
  ['featuresExplained', 'journeyMetadata'], // Then the journey side of featuresExplained
  ['signals'], // Then signals
  ['contexts'], // Then contexts
  ['stepNames'], // Then stepNames
];

// RETAINED documents the always-keep set; not enforced as a runtime check.
// Documented here so future maintainers know which fields the LLM relies on.
const RETAINED = ['viper', 'page', 'route', '_pageId', 'instructions'];
void RETAINED; // referenced for documentation; suppressed unused-warning

export function capContextResponse(
  input: Record<string, unknown>,
): Record<string, unknown> & { _truncated?: boolean; _truncatedFields?: string[] } {
  const work = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  const truncatedFields: string[] = [];
  let attempt = 0;
  while (Buffer.byteLength(JSON.stringify(work), 'utf8') > MAX_BYTES) {
    if (attempt >= DROP_ORDER.length) {
      // We've dropped all droppable fields and we're still over.
      // Truncate viper as last resort: pop elements until under cap.
      // (Don't byte-truncate JSON.stringify output — would produce invalid JSON.)
      const viper = (work as { viper?: unknown }).viper;
      if (Array.isArray(viper)) {
        while (viper.length > 0 && Buffer.byteLength(JSON.stringify(work), 'utf8') > MAX_BYTES) {
          viper.pop();
        }
        truncatedFields.push('viper[]');
      }
      break;
    }
    const path = DROP_ORDER[attempt];
    deletePath(work, path);
    truncatedFields.push(path.join('.'));
    attempt++;
  }
  if (truncatedFields.length === 0) return work;
  return { ...work, _truncated: true, _truncatedFields: truncatedFields };
}

function deletePath(obj: unknown, path: string[]): void {
  let cur: unknown = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (cur == null || typeof cur !== 'object') return;
    cur = (cur as Record<string, unknown>)[path[i]];
  }
  if (cur && typeof cur === 'object') {
    delete (cur as Record<string, unknown>)[path[path.length - 1]];
  }
}
