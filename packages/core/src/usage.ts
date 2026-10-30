import { isModelName, normalizeMessage, type ChatModelTokens, type TokenUsage, type TranscriptEntry } from '@claudio/shared';

import type { ModelUsage } from './providers/driver.ts';

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export const emptyTokenUsage = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 });

/** Adds `more` into `into`, keeping `total` consistent. */
export function addTokenUsage(into: TokenUsage, more: TokenUsage): void {
  into.input += more.input;
  into.output += more.output;
  into.cacheRead += more.cacheRead;
  into.cacheCreation += more.cacheCreation;
  into.total = into.input + into.output + into.cacheRead + into.cacheCreation;
}

/**
 * The tokens one turn used: the growth of the CLI's per-model counts since the previous `result` of
 * the same process. The CLI reports `modelUsage` cumulative over its process (as it does
 * `total_cost_usd`), so a long-lived or resumed chat would over-report every turn after its first
 * if the figure were read as the turn's own. A model whose count went down (a counter that started
 * again) counts from zero. Null when the result carried no counts at all: nothing is estimated.
 */
export function turnTokens(previous: readonly ModelUsage[], current: readonly ModelUsage[]): TokenUsage | null {
  if (current.length === 0) return null;
  const before = new Map(previous.map((m) => [m.model, m]));
  const grown = (now: number | undefined, then: number | undefined): number => {
    const n = num(now);
    const t = num(then);
    return n >= t ? n - t : n;
  };
  const turn = emptyTokenUsage();
  for (const m of current) {
    const p = before.get(m.model);
    addTokenUsage(turn, {
      input: grown(m.inputTokens, p?.inputTokens),
      output: grown(m.outputTokens, p?.outputTokens),
      cacheRead: grown(m.cacheReadInputTokens, p?.cacheReadInputTokens),
      cacheCreation: grown(m.cacheCreationInputTokens, p?.cacheCreationInputTokens),
      total: 0,
    });
  }
  return turn;
}

/** What the last response of the main conversation read, and the model that answered it. */
export interface ContextSnapshot {
  /** `input + cacheRead + cacheCreation` of that response */
  used: number;
  model: string | null;
  /** The newest compaction boundary, while it is later than the response above: the meter can drop before the next response */
  compactedSince?: { at: string; trigger: 'manual' | 'auto'; preTokens: number; postTokens: number | null };
}

interface MessageUsage {
  usage: TokenUsage;
  model: string | null;
  sidechain: boolean;
  /** When the response was written: the day it was spent on */
  at: string | null;
  /** Where the response stands among the lines folded, so a boundary is compared by order and not by clocks */
  order: number;
}

/** What was spent on one day with one model. */
export interface DayTokens extends ChatModelTokens {
  /** `YYYY-MM-DD`, in the server's time zone */
  day: string;
}

/** What a transcript says about how much was used, in one piece so it can be kept with the transcript's summary. */
export interface TranscriptUsage {
  context: ContextSnapshot | null;
  /** Everything spent, sidechains included, per model */
  tokens: ChatModelTokens[];
  total: TokenUsage;
  days: DayTokens[];
}

/** The calendar day of a timestamp where the server runs: what a person means by "today". */
export function localDay(iso: string): string | null {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(t.getFullYear())}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

/** The newest compaction boundary of the main conversation, as the context meter is told of it. */
interface Boundary {
  /** Where it stands among the lines folded */
  order: number;
  at: string;
  trigger: 'manual' | 'auto';
  preTokens: number;
  postTokens: number | null;
}

/** The last response of the main conversation that read any context, reduced to what the meter shows. */
interface LastResponse {
  used: number;
  model: string | null;
  order: number;
}

/**
 * How many of the newest messages are kept one by one. The CLI writes the blocks of one message one
 * after the other, so a later line only ever updates one of the last few; older messages are added
 * into the totals, which keeps the fold of a long transcript small enough to store with its summary.
 */
export const OPEN_MESSAGES = 64;

/** The totals of the messages no later line changes any more. */
interface Settled {
  /** Per model, in the order the models were first used */
  models: Map<string | null, ChatModelTokens>;
  /** Per day and model, keyed `${day}\0${model}`, in the order they first appeared */
  days: Map<string, DayTokens>;
  total: TokenUsage;
  /** The last of them that read any context; an open message that did comes after it */
  context: LastResponse | null;
}

const emptySettled = (): Settled => ({ models: new Map(), days: new Map(), total: emptyTokenUsage(), context: null });

/** A {@link UsageFold} as plain JSON: what `transcript_folds` keeps, so a restart goes on from it. */
export interface UsageFoldJson {
  lines: number;
  boundary: Boundary | null;
  /** The open messages, oldest first, as `[id, usage, model, sidechain, at, order]` */
  open: Array<[string, TokenUsage, string | null, boolean, string | null, number]>;
  models: ChatModelTokens[];
  days: DayTokens[];
  total: TokenUsage;
  context: LastResponse | null;
}

const usesContext = (u: TokenUsage): boolean => u.input + u.cacheRead + u.cacheCreation > 0;

/**
 * Folds a transcript into what was spent and how full the context is, in one pass.
 *
 * The CLI writes one line per content block of an assistant message, each carrying the whole
 * message's usage: summing lines would count a message once per block. Usage is therefore kept by
 * message id, and the last line of an id holds its final figures; a message that left the newest
 * {@link OPEN_MESSAGES} is final and goes into the totals.
 *
 * Sidechains (a subagent's messages, inside its parent's transcript) count towards what was spent,
 * because it was paid for, but not towards the context, because a subagent has a window of its own.
 */
export class UsageFold {
  // A Map keeps the order ids first appeared in, which is the order of the responses
  private readonly byMessage = new Map<string, MessageUsage>();
  /** Counts every line folded: the order a boundary and a response came in */
  private lines = 0;
  private boundary: Boundary | null = null;
  private settled: Settled = emptySettled();

  /** `line` is the raw transcript line and `entry` what `normalizeMessage` made of it. */
  add(line: Record<string, unknown>, entry: TranscriptEntry): void {
    const order = this.lines++;
    const compaction = entry.compaction;
    if (compaction?.part === 'boundary') {
      // A subagent's own compaction says nothing about the main window; one with no trigger or no
      // size before it is not one the meter can be told about
      if (!entry.isSidechain && compaction.trigger && compaction.preTokens !== null && entry.timestamp) {
        this.boundary = { order, at: entry.timestamp, trigger: compaction.trigger, preTokens: compaction.preTokens, postTokens: compaction.postTokens };
      }
      return;
    }
    if (entry.role !== 'assistant') return;
    const message = line.message as { id?: unknown; usage?: unknown } | undefined;
    const u = message?.usage;
    if (!u || typeof u !== 'object') return;
    const raw = u as Record<string, unknown>;
    const usage: TokenUsage = {
      input: num(raw.input_tokens),
      output: num(raw.output_tokens),
      cacheRead: num(raw.cache_read_input_tokens),
      cacheCreation: num(raw.cache_creation_input_tokens),
      total: 0,
    };
    usage.total = usage.input + usage.output + usage.cacheRead + usage.cacheCreation;
    this.byMessage.set(typeof message?.id === 'string' ? message.id : entry.uuid, {
      usage,
      model: isModelName(entry.model) ? entry.model : null,
      sidechain: entry.isSidechain,
      at: entry.timestamp,
      order,
    });
    if (this.byMessage.size > OPEN_MESSAGES) this.settleOldest();
  }

  private settleOldest(): void {
    const oldest = this.byMessage.entries().next();
    if (oldest.done) return;
    const [id, m] = oldest.value;
    this.byMessage.delete(id);
    const { settled } = this;
    let byModel = settled.models.get(m.model);
    if (!byModel) settled.models.set(m.model, (byModel = { model: m.model, ...emptyTokenUsage() }));
    addTokenUsage(byModel, m.usage);
    const day = m.at ? localDay(m.at) : null;
    if (day) {
      const key = `${day}\0${m.model ?? ''}`;
      let byDay = settled.days.get(key);
      if (!byDay) settled.days.set(key, (byDay = { day, model: m.model, ...emptyTokenUsage() }));
      addTokenUsage(byDay, m.usage);
    }
    addTokenUsage(settled.total, m.usage);
    if (!m.sidechain && usesContext(m.usage)) settled.context = { used: m.usage.input + m.usage.cacheRead + m.usage.cacheCreation, model: m.model, order: m.order };
  }

  /** An independent copy: a fold kept with a transcript is extended by later passes, and a half-written last line must not leak into it. */
  clone(): UsageFold {
    const copy = new UsageFold();
    for (const [id, m] of this.byMessage) copy.byMessage.set(id, m);
    copy.lines = this.lines;
    copy.boundary = this.boundary;
    copy.settled = {
      models: new Map([...this.settled.models].map(([model, row]) => [model, { ...row }])),
      days: new Map([...this.settled.days].map(([key, row]) => [key, { ...row }])),
      total: { ...this.settled.total },
      context: this.settled.context,
    };
    return copy;
  }

  /** Everything spent, sidechains included, per model. Models appear in the order they were first used. */
  tokens(): ChatModelTokens[] {
    const byModel = new Map<string | null, ChatModelTokens>();
    for (const [model, row] of this.settled.models) byModel.set(model, { ...row });
    for (const { usage, model } of this.byMessage.values()) {
      let row = byModel.get(model);
      if (!row) byModel.set(model, (row = { model, ...emptyTokenUsage() }));
      addTokenUsage(row, usage);
    }
    return [...byModel.values()];
  }

  /** What was spent on each day, per model, oldest day first. A response with no timestamp belongs to no day. */
  days(): DayTokens[] {
    const rows = new Map<string, DayTokens>();
    for (const [key, row] of this.settled.days) rows.set(key, { ...row });
    for (const { usage, model, at } of this.byMessage.values()) {
      const day = at ? localDay(at) : null;
      if (!day) continue;
      const key = `${day}\0${model ?? ''}`;
      let row = rows.get(key);
      if (!row) rows.set(key, (row = { day, model, ...emptyTokenUsage() }));
      addTokenUsage(row, usage);
    }
    return [...rows.values()].sort((a, b) => a.day.localeCompare(b.day));
  }

  snapshot(): TranscriptUsage {
    return { context: this.context(), tokens: this.tokens(), total: this.total(), days: this.days() };
  }

  total(): TokenUsage {
    const total = { ...this.settled.total };
    for (const { usage } of this.byMessage.values()) addTokenUsage(total, usage);
    return total;
  }

  /**
   * A snapshot of the last response of the main conversation, not a sum: when the CLI compacts,
   * the number drops. Null before there is one. A response with no tokens at all (the CLI's own
   * placeholders) says nothing about the context, so it is skipped.
   */
  context(): ContextSnapshot | null {
    let last = this.settled.context;
    for (const m of this.byMessage.values()) {
      if (!m.sidechain && usesContext(m.usage)) last = { used: m.usage.input + m.usage.cacheRead + m.usage.cacheCreation, model: m.model, order: m.order };
    }
    const since = this.boundary && (!last || this.boundary.order > last.order) ? this.boundary : null;
    if (!last) return null;
    return {
      used: last.used,
      model: last.model,
      ...(since ? { compactedSince: { at: since.at, trigger: since.trigger, preTokens: since.preTokens, postTokens: since.postTokens } } : {}),
    };
  }

  toJSON(): UsageFoldJson {
    return {
      lines: this.lines,
      boundary: this.boundary,
      open: [...this.byMessage].map(([id, m]) => [id, m.usage, m.model, m.sidechain, m.at, m.order]),
      models: [...this.settled.models.values()],
      days: [...this.settled.days.values()],
      total: this.settled.total,
      context: this.settled.context,
    };
  }

  /** The fold {@link toJSON} wrote, ready to take the lines after it. */
  static fromJSON(json: UsageFoldJson): UsageFold {
    const fold = new UsageFold();
    fold.lines = json.lines;
    fold.boundary = json.boundary;
    for (const [id, usage, model, sidechain, at, order] of json.open) fold.byMessage.set(id, { usage: { ...usage }, model, sidechain, at, order });
    fold.settled = {
      models: new Map(json.models.map((row) => [row.model, { ...row }])),
      days: new Map(json.days.map((row) => [`${row.day}\0${row.model ?? ''}`, { ...row }])),
      total: { ...json.total },
      context: json.context,
    };
    return fold;
  }
}

/** The fold over transcript lines already parsed. Lines that are not conversation are ignored. */
export function foldUsage(lines: Iterable<Record<string, unknown>>): UsageFold {
  const fold = new UsageFold();
  for (const line of lines) {
    const entry = normalizeMessage(line);
    if (entry) fold.add(line, entry);
  }
  return fold;
}
