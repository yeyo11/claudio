import { LESSON_ACTION_MAX, LESSON_TRIGGER_MAX, type Lesson, type LessonSignalKind } from '@claudio/shared';
import { cutToBytes, maskSecrets } from '../decisions/redact.ts';
import { ENGLISH_STOPWORDS, SAME_AT, similarity } from './match.ts';

/*
 * The checks on what the miner wrote (docs/plans/lessons.md, "Checks on each candidate"). Pure, and
 * the security core of the feature: every string the model returns is hostile, because it was
 * written after reading a person's chat, and what survives is handed to every later run of the
 * project. The first failing rule drops the candidate and is counted, so nothing is dropped silently.
 */

export const DROP_REASONS = [
  'empty',
  'too-long',
  'no-signal',
  'secret',
  'url',
  'command-like',
  'suspicious',
  'not-english',
  'restates-instructions',
  'duplicate-rejected',
] as const;
export type DropReason = (typeof DROP_REASONS)[number];

/** A candidate that passed every check, in the shape the service stores */
export interface Candidate {
  trigger: string;
  action: string;
  /** Ids of the input's signals it rests on; only the ones that were in the input */
  signals: string[];
  /** The person's words, masked and cut; may be empty */
  quote: string;
  confidence: number;
  /** `L-<seq>` the model says it restates, or null */
  restates: string | null;
  contradicts: string | null;
  instructions: 'none' | 'restates' | 'contradicts';
  mechanical: boolean;
}

export interface ValidationContext {
  /** The signals the miner was shown, by id */
  signals: ReadonlyMap<string, LessonSignalKind>;
  /** The project's rejected lessons: a candidate that says one again is dropped */
  rejected: readonly Pick<Lesson, 'trigger' | 'action'>[];
}

export interface Validated {
  accepted: Candidate[];
  dropped: Partial<Record<DropReason, number>>;
}

/** The most candidates one run may bring; the rest are ignored */
export const MAX_CANDIDATES = 5;
export const CONFIDENCE_MIN = 0.3;
export const CONFIDENCE_MAX = 0.9;
/** A lesson that rests only on repeated errors is a guess about the person's wishes */
export const REPEATED_ERROR_CAP = 0.5;
const QUOTE_MAX_BYTES = 1024;

/** A span in backticks may hold one word: a command name, a package, a path, a flag */
const SIMPLE_SPAN = /^[A-Za-z0-9@._/:+=-]{1,40}$/;
const SPAN = /`([^`]*)`/g;
const SHELL_SYNTAX = /&&|\|\||;|\||\$\(|\$\{|>|</;
const RUN_A_SPAN = /^(?:run|execute|invoke|type|paste|curl)\s+(?:the\s+|a\s+|this\s+)?`/i;
const SUSPICIOUS =
  /ignore\s+(?:all|any|previous|prior|the)\s+(?:instructions|rules)|system\s+prompt|you\s+are\s+now|disregard|override\s+(?:the|your|these)\s+(?:rules|instructions)|exfiltrat|(?:send|post|upload)\b.*\b(?:to|at)\s+(?:http|an?\s+(?:server|url|address|e-?mail))/i;
const URL_LIKE = /:\/\/|\bwww\.|\bmailto:/i;

const SPANISH = new Set(['el', 'la', 'los', 'las', 'que', 'para', 'con', 'por', 'una', 'cuando', 'usar', 'nunca', 'siempre']);

/**
 * The text as it will be judged and stored: NFKC, so that full-width `；` or a ligature cannot hide
 * what a rule looks for, and without the invisible format characters (zero-width spaces, bidi
 * marks) a model could put inside a word to slip past a pattern.
 */
function normal(text: string): string {
  return text.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/[\u2028\u2029\u0085]/g, '\n');
}

function commandLike(text: string, isAction: boolean): boolean {
  if (text.includes('```')) return true;
  let outside = '';
  let last = 0;
  for (const match of text.matchAll(SPAN)) {
    if (!SIMPLE_SPAN.test(match[1] ?? '')) return true;
    outside += `${text.slice(last, match.index)} `;
    last = match.index + match[0].length;
  }
  outside += text.slice(last);
  // A backtick left over is an unclosed span
  if (outside.includes('`')) return true;
  if (SHELL_SYNTAX.test(outside)) return true;
  return isAction && RUN_A_SPAN.test(text.trim());
}

function spanish(text: string): boolean {
  const prose = text.replace(SPAN, ' ').toLowerCase();
  let es = 0;
  let en = 0;
  for (const word of prose.split(/[^\p{L}']+/u)) {
    if (SPANISH.has(word)) es += 1;
    else if (ENGLISH_STOPWORDS.has(word)) en += 1;
  }
  return es >= 3 && es > en;
}

const length = (text: string): number => [...text].length;

const LESSON_KEY = /^L-\d{1,9}$/;

function ref(value: unknown): string | null {
  return typeof value === 'string' && LESSON_KEY.test(value.trim()) ? value.trim() : null;
}

/** Checks one raw candidate; returns the candidate or the reason it was dropped */
export function checkCandidate(raw: unknown, ctx: ValidationContext): Candidate | DropReason {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'empty';
  const given = raw as Record<string, unknown>;
  if (typeof given.trigger !== 'string' || typeof given.action !== 'string') return 'empty';
  const untrimmed = [normal(given.trigger), normal(given.action)];
  const trigger = untrimmed[0]?.trim() ?? '';
  const action = untrimmed[1]?.trim() ?? '';
  if (!trigger || !action) return 'empty';
  if (length(trigger) > LESSON_TRIGGER_MAX || length(action) > LESSON_ACTION_MAX) return 'too-long';

  const ids = Array.isArray(given.signals) ? given.signals.filter((s): s is string => typeof s === 'string').map((s) => s.trim()) : [];
  const signals = [...new Set(ids.filter((id) => ctx.signals.has(id)))];
  if (signals.length === 0) return 'no-signal';

  if (maskSecrets(trigger) !== trigger || maskSecrets(action) !== action) return 'secret';
  // The quote is the person's: kept, cut and masked, never a reason to drop
  const quote = typeof given.quote === 'string' ? maskSecrets(cutToBytes(normal(given.quote).trim(), QUOTE_MAX_BYTES)) : '';
  if (URL_LIKE.test(trigger) || URL_LIKE.test(action)) return 'url';
  // A newline, a tab or any other control character, even at an end: a lesson is one line of prose
  if (untrimmed.some((t) => /\p{Cc}/u.test(t))) return 'command-like';
  if (commandLike(trigger, false) || commandLike(action, true)) return 'command-like';
  if (SUSPICIOUS.test(trigger) || SUSPICIOUS.test(action)) return 'suspicious';
  if (spanish(trigger) || spanish(action)) return 'not-english';
  if (given.instructions === 'restates') return 'restates-instructions';
  if (ctx.rejected.some((r) => similarity({ trigger, action }, r) >= SAME_AT)) return 'duplicate-rejected';

  const stated = typeof given.confidence === 'number' && Number.isFinite(given.confidence) ? given.confidence : CONFIDENCE_MIN;
  let confidence = Math.min(CONFIDENCE_MAX, Math.max(CONFIDENCE_MIN, stated));
  if (signals.every((id) => ctx.signals.get(id) === 'repeated-error')) confidence = Math.min(confidence, REPEATED_ERROR_CAP);
  return {
    trigger,
    action,
    signals,
    quote,
    confidence,
    restates: ref(given.restates),
    contradicts: ref(given.contradicts),
    instructions: given.instructions === 'contradicts' ? 'contradicts' : 'none',
    mechanical: given.mechanical === true,
  };
}

/** Reads the miner's structured result: the list of raw candidates, or null when it is not the schema's shape */
export function parseMinerOutput(raw: unknown): unknown[] | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const lessons = (raw as Record<string, unknown>).lessons;
  return Array.isArray(lessons) ? lessons : null;
}

/** Checks the first five candidates in order; the rest are ignored */
export function validateCandidates(raw: readonly unknown[], ctx: ValidationContext): Validated {
  const accepted: Candidate[] = [];
  const dropped: Partial<Record<DropReason, number>> = {};
  for (const item of raw.slice(0, MAX_CANDIDATES)) {
    const out = checkCandidate(item, ctx);
    if (typeof out === 'string') dropped[out] = (dropped[out] ?? 0) + 1;
    else accepted.push(out);
  }
  return { accepted, dropped };
}
