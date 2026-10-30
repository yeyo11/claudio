/**
 * How a tool result fits what the CLI takes. The CLI refuses an MCP result over its token budget
 * (25 000 tokens by default) and spills it to a file, which a confined chat cannot read; a string
 * cut mid-value is no better, since it is no longer JSON. So a result over the budget is cut by its
 * structure: long strings lose their tail, deep objects are folded, lists lose their last entries,
 * until the compact JSON fits. What comes out always parses, and says what was cut and how to ask
 * for the rest.
 */

/** Longest compact JSON a tool answers with, well under the CLI's 25 000 tokens */
export const RESULT_BUDGET_CHARS = 24_000;

/** A string longer than this is cut first, whatever the budget */
export const STRING_MAX_CHARS = 2_000;

/** Objects nested deeper than this are folded into `{"…": true}` */
export const DEPTH_MAX = 6;

/** What the cut did, counted, so the model knows the answer is partial */
export interface Truncation {
  arrays: number;
  strings: number;
  /** Objects folded for depth; absent when none was */
  objects?: number;
}

/** What an answer that did not fit looks like: the cut value, what was cut, and how to page */
export interface Truncated {
  result: unknown;
  truncated: Truncation;
  hint: string;
}

export const DEFAULT_HINT = 'The result was cut to fit. Narrow the call: a smaller limit, one id, or a path.';

/** Room the wrapper (`result`, `truncated`, `hint`) takes beside the value */
const WRAPPER_CHARS = 600;
/** The shortest a string is cut to, and the shallowest depth kept, before the last resort */
const STRING_FLOOR = 40;
const FOLDED = Object.freeze({ '…': true });

const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

interface Counts {
  strings: number;
  objects: number;
}

/** A copy with every string at most `max` long and nothing below `depth`; counts what it changed */
function capped(value: unknown, max: number, depth: number, counts: Counts, level = 0): unknown {
  if (typeof value === 'string') {
    if (value.length <= max) return value;
    counts.strings++;
    return `${value.slice(0, max)}…`;
  }
  if (Array.isArray(value)) return value.map((entry) => capped(entry, max, depth, counts, level + 1));
  if (isPlain(value)) {
    if (level >= depth) {
      counts.objects++;
      return FOLDED;
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = capped(entry, max, depth, counts, level + 1);
    return out;
  }
  return value;
}

const size = (value: unknown): number => (JSON.stringify(value) ?? 'null').length;

/** The arrays of a tree with more than one entry, each with its serialized size */
function arraysOf(value: unknown, out: Array<{ list: unknown[]; size: number }> = []): Array<{ list: unknown[]; size: number }> {
  if (Array.isArray(value)) {
    if (value.length > 1) out.push({ list: value, size: size(value) });
    for (const entry of value) arraysOf(entry, out);
  } else if (isPlain(value)) {
    for (const entry of Object.values(value)) arraysOf(entry, out);
  }
  return out;
}

/**
 * The value cut until its compact JSON is at most `budget` long, or null when it already fits.
 * Lists are shortened from the end, the largest first and by about what is over; strings are cut
 * shorter and objects folded shallower only when no list is left to shorten.
 */
export function shrink(value: unknown, budget: number, hint = DEFAULT_HINT): Truncated | null {
  if (size(value) <= budget) return null;
  const room = Math.max(1, budget - WRAPPER_CHARS - hint.length);
  let max = STRING_MAX_CHARS;
  let depth = DEPTH_MAX;
  const counts: Counts = { strings: 0, objects: 0 };
  let current = capped(value, max, depth, counts);
  const cutLists = new Set<unknown[]>();
  for (;;) {
    const total = size(current);
    if (total <= room) break;
    const lists = arraysOf(current).sort((a, b) => b.size - a.size);
    const largest = lists[0];
    if (largest) {
      const { list } = largest;
      // About as many entries as carry the excess, never fewer than half of them, never none left
      const perEntry = largest.size / list.length;
      const drop = Math.min(list.length - 1, Math.max(Math.ceil((total - room) / perEntry), Math.ceil(list.length / 2)));
      list.length -= drop;
      cutLists.add(list);
      continue;
    }
    if (max > STRING_FLOOR) {
      max = Math.max(STRING_FLOOR, Math.floor(max / 2));
    } else if (depth > 1) {
      depth--;
    } else {
      // Nothing left to shorten: a single value too large even folded says only that it was cut
      current = FOLDED;
      break;
    }
    // Strings and depth are re-cut from the original, with the lists cut so far kept as they are
    const recount: Counts = { strings: 0, objects: 0 };
    current = capped(current, max, depth, recount);
    counts.strings = Math.max(counts.strings, recount.strings);
    counts.objects += recount.objects;
  }
  return {
    result: current,
    truncated: { arrays: cutLists.size, strings: counts.strings, ...(counts.objects ? { objects: counts.objects } : {}) },
    hint,
  };
}

/** Compact JSON of a tool's result, cut by its structure to the budget; always valid JSON */
export function render(value: unknown, budget = RESULT_BUDGET_CHARS, hint = DEFAULT_HINT): string {
  const cut = shrink(value === undefined ? null : value, budget, hint);
  return JSON.stringify(cut ?? (value === undefined ? null : value));
}
