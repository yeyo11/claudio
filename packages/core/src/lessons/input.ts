import type { ContentBlock, Lesson, LessonSignalKind, TranscriptEntry } from '@claudio/shared';
import { cutToBytes, maskSecrets } from '../decisions/redact.ts';
import { pasted } from '../prompt-rules.ts';

/*
 * What the miner is shown (docs/plans/lessons.md, "Input assembly"). Deterministic and pure: the
 * same transcript and signals give the same bytes. Every string is masked, every block is marked
 * as material with `pasted()`, and nothing that was read, fetched or returned by a tool goes in:
 * only what the person wrote, what the agent said and a one-line name for each tool call.
 */

/** Entries from the end the window starts at when the last job's mark is gone (a compaction, a rewind, a rewritten transcript) */
export const FALLBACK_WINDOW_ENTRIES = 200;
export const MAX_SIGNALS = 20;
export const MAX_REPEATED_ERRORS = 3;
export const MAX_LESSONS = 40;
export const INPUT_MAX_BYTES = 24 * 1024;
export const QUOTE_BYTES = 1024;
export const BEFORE_BYTES = 500;
export const AFTER_BYTES = 300;
export const TOOL_LINE_BYTES = 200;
export const MAX_TOOL_LINES = 8;
export const REPEATED_ERROR_BYTES = 300;
export const INSTRUCTIONS_BYTES = 8 * 1024;

/** One signal as the pre-filter found it: the person's words and the entry they are in */
export interface SignalInput {
  kind: LessonSignalKind;
  /** The transcript entry of the person's message; null for one the transcript cannot place (a deny) */
  entryUuid: string | null;
  /** The person's words as written; empty for a repeated error and for a denial without a message */
  quote: string;
  /** What the agent had just done, when the signal row already carries it (a deny, a rewind) */
  context?: string;
}

/** One signal as the miner sees it */
export interface MinerSignal {
  id: string;
  kind: LessonSignalKind;
  quote: string;
  /** The assistant's text just before the signal */
  before: string;
  /** `Tool target` lines between that text and the signal */
  tools: string[];
  /** The assistant's first reply after the signal: whether the agent took the correction in */
  after: string;
  /** For a repeated error: the summary; otherwise what the signal row carried */
  context: string;
  /** Not shown to the model */
  entryUuid?: string | null;
}

export interface MinerInputSource {
  entries: readonly TranscriptEntry[];
  /** The last done job's `until_uuid` for the chat, when there is one */
  sinceUuid: string | null;
  /** Newest first or not: they are placed by their entry */
  signals: readonly SignalInput[];
  /** The project's active lessons in delivery order */
  lessons: readonly Pick<Lesson, 'key' | 'trigger' | 'action'>[];
  /** `CLAUDE.md` of the project directory, whole; cut here */
  instructions: string | null;
}

export interface MinerInput {
  signals: MinerSignal[];
  /** Every id the miner was shown, with its kind, for the validator */
  kinds: ReadonlyMap<string, LessonSignalKind>;
  signalsBlock: string;
  lessonsBlock: string;
  instructionsBlock: string;
  /** Signals left out to stay inside {@link INPUT_MAX_BYTES}, oldest first */
  droppedSignals: number;
  /** The last entry of the window: where the next job starts from */
  untilUuid: string | null;
  bytes: number;
}

const encoder = new TextEncoder();
const bytes = (text: string): number => encoder.encode(text).length;

const clean = (text: string, limit: number): string => cutToBytes(maskSecrets(text).trim(), limit);

const textOf = (blocks: readonly ContentBlock[]): string =>
  blocks
    .flatMap((b) => (b.type === 'text' ? [b.text] : []))
    .join('\n')
    .trim();

/** Where a tool call points: the path of a file tool, the command of Bash, else nothing */
function targetOf(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const fields = input as Record<string, unknown>;
  const pick = (key: string): string => (typeof fields[key] === 'string' ? (fields[key] as string) : '');
  if (name === 'Bash') return pick('command');
  return pick('file_path') || pick('path') || pick('notebook_path') || pick('pattern');
}

/** `Edit src/a.ts`, `Bash: npm install`; the target is masked, one line and cut */
export function toolLine(name: string, input: unknown): string {
  const target = targetOf(name, input).replace(/\s+/g, ' ').trim();
  const line = name === 'Bash' ? `Bash: ${target}` : target ? `${name} ${target}` : name;
  return cutToBytes(maskSecrets(line), TOOL_LINE_BYTES);
}

/** The window of entries the miner reads: after the last job's mark, or the recent ones when the mark is gone */
export function windowOf(entries: readonly TranscriptEntry[], sinceUuid: string | null): { entries: readonly TranscriptEntry[] } {
  let from = 0;
  if (sinceUuid) {
    const at = entries.findIndex((e) => e.uuid === sinceUuid);
    from = at >= 0 ? at + 1 : Math.max(0, entries.length - FALLBACK_WINDOW_ENTRIES);
  }
  return { entries: entries.slice(from) };
}

function describe(entries: readonly TranscriptEntry[], at: number): Pick<MinerSignal, 'before' | 'tools' | 'after'> {
  let beforeAt = -1;
  for (let i = at - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.role === 'assistant' && !e.isSidechain && textOf(e.blocks)) {
      beforeAt = i;
      break;
    }
  }
  const tools: string[] = [];
  for (let i = Math.max(beforeAt, 0); i < at; i++) {
    const e = entries[i];
    if (e?.role !== 'assistant' || e.isSidechain) continue;
    for (const b of e.blocks) if (b.type === 'tool_use') tools.push(toolLine(b.name, b.input));
  }
  let after = '';
  for (let i = at + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e?.role === 'assistant' && !e.isSidechain && textOf(e.blocks)) {
      after = clean(textOf(e.blocks), AFTER_BYTES);
      break;
    }
  }
  return {
    before: beforeAt >= 0 ? clean(textOf(entries[beforeAt]?.blocks ?? []), BEFORE_BYTES) : '',
    // The calls nearest the signal are the ones it is about
    tools: tools.slice(-MAX_TOOL_LINES),
    after,
  };
}

/** The first `limit` bytes of a text, cut on a line, so a rule is never cut in the middle of a sentence */
function cutOnLine(text: string, limit: number): string {
  if (bytes(text) <= limit) return text;
  const head = cutToBytes(text, limit).replace(/…$/, '');
  const nl = head.lastIndexOf('\n');
  return (nl > 0 ? head.slice(0, nl) : head).trimEnd();
}

function render(signals: readonly MinerSignal[]): string {
  const shown = signals.map(({ entryUuid: _entry, ...rest }) => rest);
  return pasted(JSON.stringify(shown, null, 2));
}

/** Builds the miner's input; see the file header for what it holds and leaves out */
export function assembleMinerInput(source: MinerInputSource): MinerInput {
  const { entries } = windowOf(source.entries, source.sinceUuid);
  const indexOf = new Map(entries.map((e, i) => [e.uuid, i] as const));

  let repeated = 0;
  const found: Array<{ at: number; order: number; signal: Omit<MinerSignal, 'id'> }> = [];
  source.signals.forEach((s, order) => {
    if (s.kind === 'repeated-error') {
      if (repeated >= MAX_REPEATED_ERRORS) return;
      repeated += 1;
      found.push({ at: -1, order, signal: { kind: s.kind, quote: '', before: '', tools: [], after: '', context: clean(s.context ?? s.quote, REPEATED_ERROR_BYTES), entryUuid: s.entryUuid } });
      return;
    }
    const at = s.entryUuid === null ? undefined : indexOf.get(s.entryUuid);
    // A transcript signal outside the window was already handled by an earlier job; a row signal (no entry) stays
    if (s.entryUuid !== null && at === undefined) return;
    const around = at === undefined ? { before: '', tools: [], after: '' } : describe(entries, at);
    found.push({
      at: at ?? Number.MAX_SAFE_INTEGER - 1,
      order,
      signal: { kind: s.kind, quote: clean(s.quote, QUOTE_BYTES), ...around, context: clean(s.context ?? '', TOOL_LINE_BYTES * 2), entryUuid: s.entryUuid },
    });
  });
  // Newest first; signals the transcript cannot place count as the newest, in the order they came, and a repeated error, which is only context, as the oldest
  found.sort((a, b) => b.at - a.at || a.order - b.order);

  const lessonLines = source.lessons.slice(0, MAX_LESSONS).map((l) => maskSecrets(`${l.key}: ${l.trigger}, ${l.action}`));
  const lessonsBlock = pasted(lessonLines.length > 0 ? lessonLines.join('\n') : '(none yet)');
  const instructions = source.instructions ? cutOnLine(maskSecrets(source.instructions), INSTRUCTIONS_BYTES) : '';
  const instructionsBlock = pasted(instructions || '(none)');

  let kept = found.slice(0, MAX_SIGNALS);
  const withIds = (list: typeof kept): MinerSignal[] => list.map((f, i) => ({ id: `S${String(i + 1)}`, ...f.signal }));
  let signals = withIds(kept);
  const fixed = bytes(lessonsBlock) + bytes(instructionsBlock);
  // Over the cap the oldest signals go first, and the job says how many did
  while (kept.length > 0 && fixed + bytes(render(signals)) > INPUT_MAX_BYTES) {
    kept = kept.slice(0, -1);
    signals = withIds(kept);
  }
  const signalsBlock = render(signals);
  const last = entries[entries.length - 1];
  return {
    signals,
    kinds: new Map(signals.map((s) => [s.id, s.kind] as const)),
    signalsBlock,
    lessonsBlock,
    instructionsBlock,
    droppedSignals: found.length - signals.length,
    untilUuid: last?.uuid ?? source.sinceUuid,
    bytes: fixed + bytes(signalsBlock),
  };
}
