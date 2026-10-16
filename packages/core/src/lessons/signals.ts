import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { normalizeMessage, type DecisionMode, type LessonSignalKind, type PermissionDecision, type PermissionRequest, type TranscriptEntry } from '@claudio/shared';
import { RESUME_PROMPT } from '../assistant-answer.ts';
import { CANCEL_NOTICE_PREFIX, CHAT_HINT_PREFIX } from '../chat-service.ts';
import type { Db } from '../db.ts';
import { cutToBytes, maskSecrets } from '../decisions/redact.ts';
import { FLOW_RESTART_PREFIX } from '../flow.ts';
import type { JsonlFold } from '../jsonl-cache.ts';
import { CONTINUATION_PREFIX } from '../open-items.ts';
import { ORCHESTRATION_HINT_PREFIX } from '../orchestrator.ts';
import { AUTOMATIC_DENY_MESSAGES } from '../permissions.ts';
import type { JsonLine } from '../transcript-index.ts';

/*
 * The free pre-filter of docs/plans/lessons.md, "Signals: what counts as a correction": a pure fold
 * over a transcript, plus the three signals a transcript cannot tell (a person's deny, a rewind, a
 * rejected proposal), which are written as rows. It only decides whether there is anything to ask
 * about; the gate, the miner and the person decide the rest.
 */

// ---------- Claudio's own words ----------

/**
 * Messages Claudio wrote into a chat, recognised by the prefixes their writers export: the fold and
 * the writers cannot drift apart. Hints and cancels are the person's by proxy; nudges are nobody's.
 */
// Functions, not constants: `SessionStore` imports this file and the writers import `SessionStore`, so
// their exports are not yet bound while this module loads
const hintPrefixes = (): readonly string[] => [CHAT_HINT_PREFIX, ORCHESTRATION_HINT_PREFIX];
const nudgePrefixes = (): readonly string[] => [CONTINUATION_PREFIX, FLOW_RESTART_PREFIX, RESUME_PROMPT];

/** The CLI's two interrupt markers (l0 F4), written as a user line with a one-item text array */
const INTERRUPT_MARKERS: readonly string[] = ['[Request interrupted by user for tool use]', '[Request interrupted by user]'];

/** What a declined tool call reads like; a person's "no" is not a failure of the tool */
const DECLINE_TEXT = "The user doesn't want to proceed";

// ---------- Lexicon ----------

const WORD_BEFORE = "(?<![\\p{L}\\p{N}_'’])";
const WORD_AFTER = '(?![\\p{L}\\p{N}_])';

function lexicon(phrases: readonly string[]): RegExp {
  const body = phrases.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['’]").replace(/ /g, '\\s+')).join('|');
  return new RegExp(`${WORD_BEFORE}(?:${body})${WORD_AFTER}`, 'iu');
}

/** English: a refusal, a stop, an "instead", an undo, a reproach */
const ENGLISH = lexicon([
  'no', 'not', "don't", 'do not', 'never', 'stop', 'instead', 'wrong', 'revert', 'undo', 'roll back', 'I said', 'I told you', "that's not",
  'why did you', 'should have', "shouldn't", "please don't", 'not what I asked',
]);

/** Spanish: the same groups, as a person types them */
const SPANISH = lexicon([
  'no', 'nunca', 'deja', 'para', 'en vez de', 'en lugar de', 'mal', 'incorrecto', 'deshaz', 'revierte', 'vuelve atrás', 'te dije', 'ya te dije',
  'no uses', 'no toques', 'no hagas', 'por qué has', 'debiste', 'no era eso', 'así no',
]);

/** A message that opens with a negation counts whatever follows ("No, …" in both languages) */
const NEGATION_START = new RegExp(`^\\s*(?:no|not|never|nunca|don['’]t|do\\s+not|stop|para|deja)${WORD_AFTER}`, 'iu');

export function matchesLexicon(text: string): boolean {
  return ENGLISH.test(text) || SPANISH.test(text);
}

export function startsWithNegation(text: string): boolean {
  return NEGATION_START.test(text);
}

// ---------- The fold ----------

/** The most of a person's message the fold keeps; the signal is cut again to 1 KiB when recorded */
const MESSAGE_KEPT = 2_000;
const MESSAGES_MAX = 200;
const EDITS_PER_PATH = 5;
const PATHS_MAX = 64;
const PENDING_CALLS_MAX = 256;
const ERROR_KEPT = 300;
const REPEATED_ERROR_AT = 3;

/** git commands that put back what the agent changed */
const GIT_UNDO = /\bgit\s+(?:restore\b|checkout\s+--(?:\s|$)|revert\b|reset\s+--hard\b|stash\b)/;

export type PersonMessageKind = 'plain' | 'hint' | 'cancelled';

/** A user line that is not a tool result and is not one of Claudio's nudges */
export interface PersonMessage {
  uuid: string;
  at: string | null;
  kind: PersonMessageKind;
  text: string;
  /** What the agent had just done, in English: "Edit src/cart.ts", "Bash: npm install" */
  context: string | null;
  /** The assistant did something (a tool call, or text after one) before this message */
  acted: boolean;
  /** An interrupt marker came right before it */
  afterInterrupt: boolean;
}

export interface RevertMark {
  uuid: string;
  at: string | null;
  context: string;
  /** How many messages had been read when it happened: it counts only after a person message */
  after: number;
}

export interface RepeatedError {
  uuid: string;
  at: string | null;
  tool: string;
  context: string;
  count: number;
}

interface EditSeen {
  old: string;
  new: string;
}

interface PendingCall {
  tool: string;
  command: string | null;
  context: string;
}

export interface CorrectionState {
  entries: number;
  /** An assistant action (a tool call) has happened since the last person message */
  acted: boolean;
  /** A text sentence seen after a tool call counts as acting too; this remembers a call was made at all */
  sawCall: boolean;
  lastAction: string | null;
  interrupted: boolean;
  messages: PersonMessage[];
  reverts: RevertMark[];
  edits: Map<string, EditSeen[]>;
  calls: Map<string, PendingCall>;
  errors: Map<string, number>;
  repeated: RepeatedError[];
  /** The last Bash command and whether it failed, for "failing twice in a row" */
  lastBash: { command: string; failed: boolean } | null;
}

export function emptyCorrections(): CorrectionState {
  return {
    entries: 0,
    acted: false,
    sawCall: false,
    lastAction: null,
    interrupted: false,
    messages: [],
    reverts: [],
    edits: new Map(),
    calls: new Map(),
    errors: new Map(),
    repeated: [],
    lastBash: null,
  };
}

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * The first `n` characters of a text, masked before they are cut: a secret that straddles the cut
 * would otherwise leave a prefix the masks no longer recognise.
 */
const keep = (text: string, n: number): string => maskSecrets(text).slice(0, n);

/** "Edit src/cart.ts", "Bash: npm install": what a call did, short and without its output */
export function actionOf(tool: string, input: unknown): string {
  const r = asRecord(input);
  const path = asText(r.file_path) || asText(r.notebook_path) || asText(r.path);
  if (tool === 'Bash') return `Bash: ${keep(asText(r.command).replace(/\s+/g, ' ').trim(), 120)}`;
  return path ? `${tool} ${path}` : tool;
}

/** Numbers, hex, paths and quotes stripped, so two failures of one kind read the same */
export function normalizeError(text: string): string {
  return text
    .replace(/(["'`]).*?\1/g, '')
    .replace(/0x[0-9a-f]+/gi, '#')
    .replace(/\b[0-9a-f]{7,}\b/gi, '#')
    .replace(/(?:[A-Za-z]:\\|\/)[^\s:]+/g, '<path>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function startsWithAny(text: string, prefixes: readonly string[]): string | null {
  return prefixes.find((p) => text.startsWith(p)) ?? null;
}

/**
 * Folds one entry in. A subagent's entries are out of it: the person talks to the main thread.
 * Tool output is never kept except the first 300 characters of an error, and only inside a
 * `RepeatedError`'s context.
 */
export function addCorrectionEntry(state: CorrectionState, entry: TranscriptEntry | null): void {
  if (!entry || entry.isSidechain || entry.compaction) return;
  state.entries += 1;
  if (entry.role === 'assistant') {
    for (const block of entry.blocks) {
      if (block.type === 'text' && state.sawCall && block.text.trim()) {
        state.acted = true;
      } else if (block.type === 'tool_use') {
        state.acted = true;
        state.sawCall = true;
        const input = asRecord(block.input);
        const context = actionOf(block.name, input);
        state.lastAction = context;
        if (state.calls.size >= PENDING_CALLS_MAX) state.calls.delete(state.calls.keys().next().value as string);
        state.calls.set(block.id, { tool: block.name, command: block.name === 'Bash' ? asText(input.command) : null, context });
        noteRevert(state, entry, block.name, input, context);
      }
    }
    return;
  }
  for (const block of entry.blocks) {
    if (block.type === 'tool_result') noteResult(state, entry, block.toolUseId, block.content, block.isError);
  }
  if (entry.blocks.some((b) => b.type === 'tool_result')) return;
  const text = entry.blocks.filter((b) => b.type === 'text').map((b) => (b.type === 'text' ? b.text : '')).join('\n').trim();
  if (!text) return;
  if (INTERRUPT_MARKERS.includes(text)) {
    state.interrupted = true;
    return;
  }
  if (startsWithAny(text, nudgePrefixes())) return;
  const hint = startsWithAny(text, hintPrefixes());
  const cancel = startsWithAny(text, [CANCEL_NOTICE_PREFIX]);
  const kind: PersonMessageKind = hint ? 'hint' : cancel ? 'cancelled' : 'plain';
  const body = hint ? text.slice(hint.length).trim() : text;
  state.messages.push({
    uuid: entry.uuid,
    at: entry.timestamp,
    kind,
    text: body.slice(0, MESSAGE_KEPT),
    context: state.lastAction,
    acted: state.acted,
    afterInterrupt: state.interrupted,
  });
  if (state.messages.length > MESSAGES_MAX) {
    state.messages.shift();
    // Marks hold an index into `messages`; the dropped message moves every one of them down by one
    for (const mark of state.reverts) mark.after = Math.max(0, mark.after - 1);
  }
  state.interrupted = false;
  // A new prompt: what the agent did before it is no longer "just now"
  state.acted = false;
  state.sawCall = false;
}

function noteRevert(state: CorrectionState, entry: TranscriptEntry, tool: string, input: Record<string, unknown>, context: string): void {
  let reverted = false;
  if (tool === 'Edit') {
    const path = asText(input.file_path);
    const edit: EditSeen = { old: asText(input.old_string), new: asText(input.new_string) };
    const earlier = state.edits.get(path) ?? [];
    // The edit undoes an earlier one when it swaps the same two texts back
    reverted = path !== '' && edit.old !== '' && earlier.some((e) => e.new === edit.old && e.old === edit.new);
    if (path) {
      if (!state.edits.has(path) && state.edits.size >= PATHS_MAX) state.edits.delete(state.edits.keys().next().value as string);
      state.edits.set(path, [...earlier, edit].slice(-EDITS_PER_PATH));
    }
  } else if (tool === 'Bash') {
    reverted = GIT_UNDO.test(asText(input.command));
  }
  if (reverted) state.reverts.push({ uuid: entry.uuid, at: entry.timestamp, context, after: state.messages.length });
}

function noteResult(state: CorrectionState, entry: TranscriptEntry, toolUseId: string, content: string, isError: boolean): void {
  const call = state.calls.get(toolUseId);
  if (!call) return;
  state.calls.delete(toolUseId);
  // A person's decline or interrupt is not the tool failing
  const failed = isError && !content.startsWith(DECLINE_TEXT) && !INTERRUPT_MARKERS.some((m) => content.includes(m));
  if (call.tool === 'Bash' && call.command !== null) {
    if (failed && state.lastBash?.failed && state.lastBash.command === call.command) {
      state.repeated.push({ uuid: entry.uuid, at: entry.timestamp, tool: 'Bash', context: `${call.context} failed twice in a row: ${keep(content, ERROR_KEPT)}`, count: 2 });
    }
    state.lastBash = { command: call.command, failed };
  }
  if (!failed) return;
  const key = `${call.tool}\u0000${normalizeError(content)}`;
  const count = (state.errors.get(key) ?? 0) + 1;
  state.errors.set(key, count);
  if (count === REPEATED_ERROR_AT) {
    state.repeated.push({ uuid: entry.uuid, at: entry.timestamp, tool: call.tool, context: `${call.tool} failed the same way ${String(count)} times: ${keep(content, ERROR_KEPT)}`, count });
  }
}

/** Read like `editSteps`: once, streaming, then only what the transcript appended */
export const CORRECTION_FOLD: JsonlFold<CorrectionState> = {
  init: emptyCorrections,
  clone: (s) => ({
    ...s,
    messages: s.messages.map((m) => ({ ...m })),
    reverts: s.reverts.map((r) => ({ ...r })),
    edits: new Map([...s.edits].map(([k, v]) => [k, [...v]])),
    calls: new Map(s.calls),
    errors: new Map(s.errors),
    repeated: [...s.repeated],
    lastBash: s.lastBash ? { ...s.lastBash } : null,
  }),
  add: (state, line: JsonLine) => addCorrectionEntry(state, normalizeMessage(line)),
};

export function correctionsFromEntries(entries: Iterable<TranscriptEntry>): CorrectionState {
  const state = emptyCorrections();
  for (const entry of entries) addCorrectionEntry(state, entry);
  return state;
}

// ---------- What the fold says ----------

export interface CorrectionContext {
  /**
   * The chat is one Claudio drives (a flow run, an orchestration worker): its first prompt and its
   * nudges are Claudio's, so a plain message is the person's only once they continued the chat.
   */
  driven: boolean;
  /** For a driven chat, when the person took it back; plain messages before that are Claudio's */
  handedBackAt?: string | null;
  /** `signals.repeatedErrorsTrigger` */
  repeatedErrorsTrigger?: boolean;
}

export interface CorrectionSignal {
  kind: LessonSignalKind;
  uuid: string;
  at: string | null;
  /** The person's own words; empty for a signal that rests on what the agent did */
  quote: string;
  context: string;
  /** Whether it asks the gate a question on its own */
  triggers: boolean;
  /** The message came right after an interrupt, which weighs more */
  afterInterrupt?: boolean;
}

function isPersons(message: PersonMessage, ctx: CorrectionContext): boolean {
  if (message.kind !== 'plain') return true;
  if (!ctx.driven) return true;
  return !!ctx.handedBackAt && !!message.at && message.at >= ctx.handedBackAt;
}

/** The signals a transcript's fold shows, oldest first */
export function signalsOf(state: CorrectionState, ctx: CorrectionContext): CorrectionSignal[] {
  const out: CorrectionSignal[] = [];
  const persons: number[] = [];
  state.messages.forEach((m, index) => {
    if (!isPersons(m, ctx)) return;
    persons.push(index);
    const context = m.context ?? '';
    if (m.kind === 'hint') out.push({ kind: 'hint', uuid: m.uuid, at: m.at, quote: m.text, context, triggers: true });
    else if (m.kind === 'cancelled') out.push({ kind: 'cancelled', uuid: m.uuid, at: m.at, quote: m.text, context, triggers: true });
    else if (m.acted && (m.afterInterrupt || startsWithNegation(m.text) || matchesLexicon(m.text))) {
      out.push({ kind: 'correction', uuid: m.uuid, at: m.at, quote: m.text, context, triggers: true, ...(m.afterInterrupt ? { afterInterrupt: true } : {}) });
    }
  });
  for (const r of state.reverts) {
    if (persons.some((index) => index < r.after)) out.push({ kind: 'reverted', uuid: r.uuid, at: r.at, quote: '', context: r.context, triggers: true });
  }
  for (const e of state.repeated) {
    out.push({ kind: 'repeated-error', uuid: e.uuid, at: e.at, quote: '', context: e.context, triggers: ctx.repeatedErrorsTrigger === true });
  }
  return out.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
}

// ---------- Rows ----------

/** A deny message is the person's only when Claudio did not write it */
export function isPersonDeny(decision: PermissionDecision | null): boolean {
  return decision !== null && decision.behavior === 'deny' && !AUTOMATIC_DENY_MESSAGES.has(decision.message ?? '');
}

const DETAIL_BYTES = 1024;

function detailOf(quote: string, context: string): string {
  return JSON.stringify({ quote: cutToBytes(maskSecrets(quote), DETAIL_BYTES), context: cutToBytes(maskSecrets(context), DETAIL_BYTES) });
}

export interface RecordedSignal {
  id: string;
  projectId: string;
  chatId: string | null;
  kind: LessonSignalKind;
  entryUuid: string | null;
  quote: string;
  context: string;
  jobId: string | null;
  at: string;
}

interface SignalRow {
  id: string;
  project_id: string;
  chat_id: string | null;
  kind: string;
  entry_uuid: string | null;
  detail: string;
  job_id: string | null;
  at: string;
}

export interface SignalRecorderDeps {
  db: Db;
  /** The mode of `lesson.mine` for a project; nothing is stored while it is `off` (A14) */
  mode: (projectId: string) => DecisionMode;
  clock?: () => Date;
}

/** The three signals a transcript cannot tell, written as `lesson_signals` rows, redacted */
export class SignalRecorder {
  private readonly sql: DatabaseSync;
  private readonly clock: () => Date;

  constructor(private readonly deps: SignalRecorderDeps) {
    this.sql = deps.db.connection;
    this.clock = deps.clock ?? (() => new Date());
  }

  /** S-denied: the broker resolved a request with a deny that a person wrote */
  denied(request: PermissionRequest, decision: PermissionDecision | null, chat: { chatId: string; projectId: string | null }): RecordedSignal | null {
    if (!decision || !isPersonDeny(decision)) return null;
    const message = decision.message ?? '';
    return this.write(chat.projectId, chat.chatId, 'denied', request.toolUseId || null, message, actionOf(request.toolName, request.input));
  }

  /** S-rewound: a resume carried `resumeSessionAt`; the next person message becomes the quote */
  rewound(chat: { chatId: string; projectId: string | null }, resumeSessionAt: string, abandoned: string | null = null): RecordedSignal | null {
    return this.write(chat.projectId, chat.chatId, 'rewound', resumeSessionAt, '', abandoned ? cutToBytes(maskSecrets(abandoned), 500) : '');
  }

  /** S-rejected-proposal: a rejection with a reason, for the chat the proposal came from */
  rejectedProposal(source: { chatId: string | null; projectId: string | null }, reason: string | null | undefined, context: string): RecordedSignal | null {
    const quote = reason?.trim();
    if (!quote) return null;
    return this.write(source.projectId, source.chatId, 'rejected-proposal', null, quote, context);
  }

  /** The rows of a chat, oldest first */
  forChat(chatId: string): RecordedSignal[] {
    const rows = this.sql.prepare('SELECT id, project_id, chat_id, kind, entry_uuid, detail, job_id, at FROM lesson_signals WHERE chat_id = ? ORDER BY seq').all(chatId) as unknown as SignalRow[];
    return rows.map((row) => {
      const detail = JSON.parse(row.detail) as { quote?: string; context?: string };
      return {
        id: row.id,
        projectId: row.project_id,
        chatId: row.chat_id,
        kind: row.kind as LessonSignalKind,
        entryUuid: row.entry_uuid,
        quote: detail.quote ?? '',
        context: detail.context ?? '',
        jobId: row.job_id,
        at: row.at,
      };
    });
  }

  private write(projectId: string | null, chatId: string | null, kind: LessonSignalKind, entryUuid: string | null, quote: string, context: string): RecordedSignal | null {
    // A chat under no project is never mined (A9), and a project with the point off stores nothing (A14)
    if (!projectId || this.deps.mode(projectId) === 'off') return null;
    const id = randomUUID();
    const at = this.clock().toISOString();
    const detail = detailOf(quote, context);
    this.sql
      .prepare('INSERT INTO lesson_signals (id, project_id, chat_id, kind, entry_uuid, detail, job_id, at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)')
      .run(id, projectId, chatId, kind, entryUuid, detail, at);
    const parsed = JSON.parse(detail) as { quote: string; context: string };
    return { id, projectId, chatId, kind, entryUuid, quote: parsed.quote, context: parsed.context, jobId: null, at };
  }
}
