import { randomUUID } from 'node:crypto';
import type {
  DecisionAnswer,
  DecisionLabel,
  DecisionLabelOutcomesResult,
  DecisionProviderId,
  DecisionPointId,
  DecisionQuestion,
  DecisionReplay,
  DecisionReplayConfusion,
  DecisionReplayConsent,
  DecisionReplayFailure,
  DecisionReplayList,
  DecisionReplayRequest,
  DecisionReplayRunning,
  DecisionReplayStarted,
  DecisionSettings,
  DecisionUnavailableReason,
} from '@claudio/shared';
import type { Db } from '../db.ts';
import { lowestConfidence, type DecisionProvider, type DecisionEngine, type ProviderResult } from './engine.ts';
import { rate, scoreEvidence, type EvidenceCase, type EvidenceWindow } from './evidence.ts';
import { decisionPoint, type DecisionPointDefinition } from './points.ts';
import { redactState } from './redact.ts';
import { hashQuestions, questionsHash as pointQuestionsHash } from './questions-hash.ts';
import { JEV_MODEL } from './settings.ts';

/*
 * Replay (docs/plans/decision-engine-v2.md, M5): the golden set's stored states put to a provider
 * again, under the point's questions or reworded ones, scored against the labels. A replay is not a
 * decision: it writes no row to `decisions`, it has no caller to act for, and it never retries. What
 * it does share with a live request is the door to the provider (the same `ask`, under a deadline),
 * the redaction of the state, and the need for consent, because it sends states out all the same.
 */

/** Carries the HTTP status a route should answer with; Fastify reads `statusCode` off any thrown error */
export class ReplayError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Whether a replay may send states to `provider`: the point's own consent covers it (the current
 * state version and this provider, as a live request needs), or the owner said out of band, for this
 * one run, that it is consented. Null means no replay. A reworded question changes no state shape,
 * so it needs nothing more; a point whose state shape changed has a new `stateVersion`, and the
 * consent given for the old one does not count.
 */
export function replayConsent(
  point: DecisionPointId,
  provider: DecisionProviderId,
  settings: Pick<DecisionSettings, 'points'>,
  ownerFlag = false,
): DecisionReplayConsent | null {
  const def = decisionPoint(point);
  if (!def) return null;
  const consent = settings.points[point]?.consent;
  if (consent && consent.stateVersion === def.stateVersion && consent.providers.includes(provider)) return 'point';
  return ownerFlag ? 'owner-flag' : null;
}

/** The same rules `engine.ts` holds a live point's questions to */
export function questionsFit(questions: ReadonlyArray<DecisionQuestion>): boolean {
  if (questions.length === 0) return false;
  const seen = new Set<string>();
  for (const q of questions) {
    if (!q.id || seen.has(q.id)) return false;
    seen.add(q.id);
    if (q.kind === 'choice' && (q.options.length < 2 || q.options.length > 255)) return false;
    if (q.kind === 'score' && (q.levels.length < 2 || q.levels.length > 10)) return false;
  }
  return true;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** Reads questions from JSON a person wrote (a reworded set, an imported label); null when anything is off */
export function parseQuestions(raw: unknown): DecisionQuestion[] | null {
  if (!Array.isArray(raw)) return null;
  const out: DecisionQuestion[] = [];
  for (const q of raw as unknown[]) {
    if (!isObject(q) || !text(q.id, 100) || !text(q.question, 4_000)) return null;
    if (q.kind === 'noul') {
      out.push({ kind: 'noul', id: q.id, question: q.question });
    } else if (q.kind === 'choice' && Array.isArray(q.options)) {
      const options: Array<{ id: string; label: string }> = [];
      for (const o of q.options as unknown[]) {
        if (!isObject(o) || !text(o.id, 100) || !text(o.label, 1_000)) return null;
        options.push({ id: o.id, label: o.label });
      }
      out.push({ kind: 'choice', id: q.id, question: q.question, options });
    } else if (q.kind === 'score' && Array.isArray(q.levels)) {
      const levels: Array<{ id: string; description: string }> = [];
      for (const l of q.levels as unknown[]) {
        if (!isObject(l) || !text(l.id, 100) || !text(l.description, 1_000)) return null;
        levels.push({ id: l.id, description: l.description });
      }
      out.push({ kind: 'score', id: q.id, question: q.question, levels });
    } else {
      return null;
    }
  }
  return questionsFit(out) ? out : null;
}

/** Every question answered with its own kind and one of its options; a model off its schema is no answer */
function answersFit(questions: ReadonlyArray<DecisionQuestion>, answers: Record<string, DecisionAnswer>): boolean {
  for (const q of questions) {
    const a = answers[q.id];
    if (!a || a.kind !== q.kind) return false;
    if (a.confidence !== null && !(a.confidence >= 0 && a.confidence <= 1)) return false;
    if (q.kind === 'choice' && !q.options.some((o) => o.id === a.value)) return false;
    if (q.kind === 'score' && !q.levels.some((l) => l.id === a.value)) return false;
    if (q.kind === 'noul' && typeof a.value !== 'boolean') return false;
  }
  return true;
}

/** What a provider says when it cannot answer at all: asking again for the next case would say it again */
const HARD_STOPS: ReadonlySet<DecisionUnavailableReason> = new Set(['no-key', 'no-quota', 'rate-limited', 'spend-cap']);

/** One labelled state to put to the provider again */
export interface ReplayCase {
  /** The label's id; null for a case read from a file */
  id: string | null;
  /** As stored (already redacted); it is redacted again so a set built outside is held to the same rules */
  state: Record<string, unknown>;
  /** What was asked then; the fallback when the point's current questions cannot be built from the state */
  questions: ReadonlyArray<DecisionQuestion>;
  /** True when the answer that acts (or flags) was the right one */
  positive: boolean;
}

export const caseOfLabel = (label: DecisionLabel): ReplayCase => ({ id: label.id, state: label.state, questions: label.questions, positive: label.positive });

export interface ReplayCaseResult {
  id: string | null;
  positive: boolean;
  status: 'answered' | 'unavailable';
  unavailable: DecisionUnavailableReason | null;
  /** Whether the answers act; null when unavailable or when they say neither */
  acts: boolean | null;
  confidence: number | null;
  answers: Record<string, DecisionAnswer> | null;
  costUsd: number | null;
  latencyMs: number;
}

export interface ReplayInput {
  point: DecisionPointId;
  cases: ReadonlyArray<ReplayCase>;
  /** Reworded questions to try; absent asks the point's own, built from each state */
  questions?: ReadonlyArray<DecisionQuestion>;
  provider: DecisionProvider;
  concurrency: number;
  /** Per call: a provider that has not answered by then is unavailable for that case */
  deadlineMs: number;
  signal: AbortSignal;
  /** The settings the consent is read from, and the owner's word for this one run */
  consent: { settings: Pick<DecisionSettings, 'points'>; ownerFlag?: boolean };
  /** The model to record when no case was answered, so the stored row still says what was tried */
  model?: string;
  /** Stop starting calls once this much is spent; the rest count as unavailable (`spend-cap`) */
  maxCostUsd?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface ReplayRun extends Omit<DecisionReplay, 'id' | 'at' | 'note'> {
  results: ReplayCaseResult[];
  /** The signal ended the run: the result is partial and must not be stored */
  aborted: boolean;
}

/** Current questions come from the point, built from the state it stores; a state it cannot rebuild them from keeps what it was asked then */
function currentQuestions(def: DecisionPointDefinition, c: ReplayCase): ReadonlyArray<DecisionQuestion> {
  try {
    const current = def.questions({ kind: 'palette', id: null, data: c.state });
    if (questionsFit(current)) return current;
  } catch {
    // keep the stored questions
  }
  return c.questions;
}

const MAX_CONCURRENCY = 8;

/**
 * Puts each labelled case to the provider and scores what comes back. Unavailable answers are
 * counted and left out of the score; a provider that reports it cannot answer at all ends the
 * calls, and the remaining cases are counted with that reason rather than asked.
 */
export async function replayDecisions(input: ReplayInput): Promise<ReplayRun> {
  const def = decisionPoint(input.point);
  if (!def) throw new ReplayError(404, `decision point ${input.point} not found`);
  const consent = replayConsent(input.point, input.provider.id, input.consent.settings, input.consent.ownerFlag === true);
  if (!consent) {
    throw new ReplayError(409, `${input.point} has no consent for ${input.provider.id} at state version ${def.stateVersion}: a replay sends states out exactly as a live request does`);
  }
  if (input.cases.length === 0) throw new ReplayError(409, `${input.point} has no labelled cases to replay`);
  if (input.questions && !questionsFit(input.questions)) throw new ReplayError(400, 'questions must be 1 or more valid questions with unique ids');

  const { provider, signal, cases } = input;
  const concurrency = Math.min(Math.max(Math.trunc(input.concurrency) || 1, 1), MAX_CONCURRENCY);
  const results: Array<ReplayCaseResult | undefined> = new Array<ReplayCaseResult | undefined>(cases.length).fill(undefined);
  const askedQuestions: Array<ReadonlyArray<DecisionQuestion> | undefined> = new Array<ReadonlyArray<DecisionQuestion> | undefined>(cases.length).fill(undefined);
  let next = 0;
  let done = 0;
  let spent = 0;
  let stopped: DecisionUnavailableReason | null = null;
  let answeredModel: string | null = null;

  const unavailable = (c: ReplayCase, reason: DecisionUnavailableReason, latencyMs = 0): ReplayCaseResult => ({
    id: c.id,
    positive: c.positive,
    status: 'unavailable',
    unavailable: reason,
    acts: null,
    confidence: null,
    answers: null,
    costUsd: null,
    latencyMs,
  });

  const one = async (c: ReplayCase, at: number): Promise<ReplayCaseResult> => {
    if (signal.aborted) return unavailable(c, 'timeout');
    if (stopped) return unavailable(c, stopped);
    if (input.maxCostUsd !== undefined && spent >= input.maxCostUsd) return unavailable(c, 'spend-cap');
    if (!provider.available()) {
      stopped = provider.whyUnavailable?.() ?? (provider.id === 'jev' ? 'no-key' : 'server-error');
      return unavailable(c, stopped);
    }
    const questions = input.questions ?? currentQuestions(def, c);
    if (!questionsFit(questions)) return unavailable(c, 'invalid-answer');
    askedQuestions[at] = questions;
    const state = redactState(c.state, def.maxStateBytes);
    const result = await askBounded(provider, { point: input.point, state, questions }, input.deadlineMs, signal);
    if (result.status === 'unavailable') {
      if (HARD_STOPS.has(result.reason)) stopped = result.reason;
      return unavailable(c, result.reason, result.latencyMs);
    }
    spent += result.costUsd ?? 0;
    if (!answersFit(questions, result.answers)) return unavailable(c, 'invalid-answer', result.latencyMs);
    answeredModel ??= result.model;
    return {
      id: c.id,
      positive: c.positive,
      status: 'answered',
      unavailable: null,
      acts: def.effect.acts(result.answers, state),
      confidence: lowestConfidence(result.answers),
      answers: result.answers,
      costUsd: result.costUsd,
      latencyMs: Math.round(result.latencyMs),
    };
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const at = next++;
      const c = cases[at];
      if (!c) return;
      results[at] = await one(c, at);
      done += 1;
      input.onProgress?.(done, cases.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, () => worker()));

  const settled = results.filter((r): r is ReplayCaseResult => r !== undefined);
  const scored: EvidenceCase[] = [];
  const confusion: Omit<DecisionReplayConfusion, 'recall'> = { actedRight: 0, actedWrong: 0, heldRight: 0, heldWrong: 0, unreadable: 0 };
  let unavailableCount = 0;
  let costUsd = 0;
  for (const r of settled) {
    if (r.status === 'unavailable') {
      unavailableCount += 1;
      continue;
    }
    costUsd += r.costUsd ?? 0;
    if (r.acts === null) {
      confusion.unreadable += 1;
      continue;
    }
    scored.push({ acts: r.acts, confidence: r.confidence, positive: r.positive, baselineActs: null });
    if (r.acts) confusion[r.positive ? 'actedRight' : 'actedWrong'] += 1;
    else confusion[r.positive ? 'heldWrong' : 'heldRight'] += 1;
  }

  // The questions asked: the reworded ones, or the first case's own (a point whose questions vary with the state records the first)
  const asked = input.questions ?? askedQuestions.find((q) => q !== undefined) ?? [];
  const questions = asked.map((q) => structuredClone(q));
  return {
    point: input.point,
    provider: provider.id,
    model: answeredModel ?? input.model ?? '',
    questions,
    // The point's own wording is hashed the way the gate hashes it (from a fixed probe), so a replay of a
    // point whose questions vary with the state still counts; reworded questions hash as themselves
    questionsHash: input.questions ? hashQuestions(questions) : (pointQuestionsHash(input.point) ?? hashQuestions(questions)),
    cases: cases.length,
    unavailable: unavailableCount,
    score: scoreEvidence(scored),
    confusion: { ...confusion, recall: rate(confusion.actedRight, confusion.actedRight + confusion.heldWrong) },
    costUsd,
    consent,
    results: settled,
    aborted: signal.aborted,
  };
}

/** One call under a deadline; whatever it does short of answering is unavailable, like the engine's own */
async function askBounded(provider: DecisionProvider, request: Parameters<DecisionProvider['ask']>[0], deadlineMs: number, parent: AbortSignal): Promise<ProviderResult> {
  const started = Date.now();
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  parent.addEventListener('abort', stop, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<ProviderResult>((resolve) => {
    const give = (): void => resolve({ status: 'unavailable', reason: 'timeout', latencyMs: Date.now() - started });
    timer = setTimeout(() => {
      controller.abort();
      give();
    }, deadlineMs);
    controller.signal.addEventListener('abort', give, { once: true });
  });
  try {
    const asked = provider.ask(request, { deadlineMs, signal: controller.signal }).catch(
      (): ProviderResult => ({ status: 'unavailable', reason: 'server-error', latencyMs: Date.now() - started }),
    );
    return await Promise.race([asked, late]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', stop);
  }
}

/** The stored form of a run: the aggregate, never the per-case answers (rows, not blobs) */
export function replayRecord(run: ReplayRun, meta: { id?: string; at: Date; note?: string | null }): DecisionReplay {
  return {
    id: meta.id ?? randomUUID(),
    point: run.point,
    at: meta.at.toISOString(),
    provider: run.provider,
    model: run.model,
    questions: run.questions,
    questionsHash: run.questionsHash,
    cases: run.cases,
    unavailable: run.unavailable,
    score: run.score,
    confusion: run.confusion,
    costUsd: run.costUsd,
    consent: run.consent,
    note: meta.note ?? null,
  };
}

/**
 * Saves a label for each answered row of the window whose outcome is `direct`, source `outcome`.
 * A label a person wrote for the same row stands: an outcome never overrules a person. Labels are
 * not pruned with the history, so this is what keeps a row's state past `historyDays`.
 */
export function labelsFromOutcomes(
  db: Pick<Db, 'listDecisions' | 'decisionLabels' | 'saveDecisionLabel'>,
  point: DecisionPointId,
  window: EvidenceWindow,
  now: () => Date = () => new Date(),
): DecisionLabelOutcomesResult {
  const effect = decisionPoint(point)?.effect;
  const result: DecisionLabelOutcomesResult = { saved: 0, keptPerson: 0, unreadable: 0 };
  if (!effect) return result;
  const person = new Set(db.decisionLabels(point).filter((l) => l.source === 'person' && l.decisionId !== null).map((l) => l.decisionId));
  let cursor: string | undefined;
  do {
    const page = db.listDecisions({ point, status: 'answered', since: window.since, ...(window.until ? { until: window.until } : {}), limit: 500, ...(cursor ? { cursor } : {}) });
    for (const row of page.items) {
      if (!row.answers || row.outcome?.quality !== 'direct' || row.agreed === null) continue;
      const acts = effect.acts(row.answers, row.state);
      if (acts === null) {
        result.unreadable += 1;
        continue;
      }
      if (person.has(row.id)) {
        result.keptPerson += 1;
        continue;
      }
      db.saveDecisionLabel({
        id: randomUUID(),
        point,
        decisionId: row.id,
        state: row.state,
        questions: row.questions,
        // `agreed` says whether the answer matched what happened: acting was right when an acting answer agreed or a holding one did not
        positive: row.agreed ? acts : !acts,
        answers: null,
        source: 'outcome',
        note: row.outcome.summary.slice(0, 300),
        at: now().toISOString(),
      });
      result.saved += 1;
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return result;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DEFAULT_CONCURRENCY = 2;
/** A replay a person started and forgot ends by itself */
const MAX_RUN_MS = 30 * 60_000;
/** One replay's spend: a reworded question tried over the whole golden set should cost cents */
const MAX_RUN_COST_USD = 1;
/** Per call; Jev is fast, the CLI takes a turn */
const CALL_DEADLINE_MS: Readonly<Record<DecisionProviderId, number>> = { jev: 5_000, cli: 60_000 };

export interface ReplayRunnerDeps {
  db: Pick<Db, 'decisionLabels' | 'saveDecisionReplay'>;
  engine: Pick<DecisionEngine, 'provider' | 'effective'>;
  settings: { get(): Pick<DecisionSettings, 'points' | 'cli'> };
  now?: () => Date;
}

/**
 * Starts replays for the API: one at a time per point, in the background, bounded in time and in
 * spend, the result stored when it ends. The owner's out-of-band flag is not reachable from here:
 * through the API a replay needs the point's own consent.
 */
export class ReplayRunner {
  private readonly active = new Map<DecisionPointId, DecisionReplayRunning & { controller: AbortController }>();
  private readonly failures = new Map<DecisionPointId, DecisionReplayFailure>();

  constructor(private readonly deps: ReplayRunnerDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /** Validates, then runs in the background; every refusal is thrown here, before anything is sent */
  start(request: DecisionReplayRequest): DecisionReplayStarted {
    const def = decisionPoint(request.point);
    if (!def) throw new ReplayError(404, `decision point ${request.point} not found`);
    if (this.active.has(request.point)) throw new ReplayError(409, `a replay of ${request.point} is already running`);
    const limit = request.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new ReplayError(400, `limit must be a whole number from 1 to ${MAX_LIMIT}`);
    const concurrency = request.concurrency ?? DEFAULT_CONCURRENCY;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) throw new ReplayError(400, `concurrency must be a whole number from 1 to ${MAX_CONCURRENCY}`);
    if (request.questions && !questionsFit(request.questions)) throw new ReplayError(400, 'questions must be 1 or more valid questions with unique ids');
    const settings = this.deps.settings.get();
    const providerId = request.provider ?? this.deps.engine.effective(request.point, null).provider;
    if (replayConsent(request.point, providerId, settings) === null) {
      throw new ReplayError(409, `${request.point} has no consent for ${providerId} at state version ${def.stateVersion}: grant it from the point's row first`);
    }
    const provider = this.deps.engine.provider(providerId);
    if (!provider || !provider.available()) {
      throw new ReplayError(409, `${providerId} is not available: ${provider?.whyUnavailable?.() ?? (providerId === 'jev' ? 'no-key' : 'server-error')}`);
    }
    // The newest labels are the ones nearest to how the point asks today
    const labels = this.deps.db.decisionLabels(request.point).slice(-limit).map(caseOfLabel);
    if (labels.length === 0) throw new ReplayError(409, `${request.point} has no labels: label history rows or import a set first`);

    const model = providerId === 'jev' ? JEV_MODEL : settings.cli.model;
    const controller = new AbortController();
    const running = { point: request.point, provider: providerId, startedAt: this.now().toISOString(), cases: labels.length, done: 0, controller };
    this.active.set(request.point, running);
    this.failures.delete(request.point);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(MAX_RUN_MS)]);
    const started = replayDecisions({
      point: request.point,
      cases: labels,
      ...(request.questions ? { questions: request.questions } : {}),
      provider,
      concurrency,
      deadlineMs: CALL_DEADLINE_MS[providerId],
      signal,
      consent: { settings },
      model,
      maxCostUsd: MAX_RUN_COST_USD,
      onProgress: (n) => {
        running.done = n;
      },
    });
    const first = labels[0];
    const hash = request.questions ? hashQuestions(request.questions) : (pointQuestionsHash(request.point) ?? hashQuestions(first ? currentQuestions(def, first) : []));
    started
      .then((run) => {
        if (run.aborted) throw new Error('the replay was stopped before it finished, so nothing was stored');
        this.deps.db.saveDecisionReplay(replayRecord(run, { at: this.now(), note: request.note ?? null }));
      })
      .catch((err: unknown) => {
        this.failures.set(request.point, { point: request.point, at: this.now().toISOString(), message: err instanceof Error ? err.message : 'the replay failed' });
      })
      .finally(() => {
        this.active.delete(request.point);
      });
    return { point: request.point, provider: providerId, cases: labels.length, questionsHash: hash };
  }

  /** What is running now and what the last run of each point ended with when it stored nothing */
  state(): Pick<DecisionReplayList, 'running' | 'failed'> {
    return {
      running: [...this.active.values()].map((r) => ({ point: r.point, provider: r.provider, startedAt: r.startedAt, cases: r.cases, done: r.done })),
      failed: [...this.failures.values()],
    };
  }

  /** Ends what is running (a shutdown) */
  stop(): void {
    for (const r of this.active.values()) r.controller.abort();
  }
}
