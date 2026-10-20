import { DECISION_POINT_IDS, pointSettingId } from '@claudio/shared';
import type { DecisionMode, DecisionPointId, DecisionPointInfo, DecisionPointSettings, DecisionPointStats, DecisionProviderId, DecisionRecord, DecisionSettings } from '@claudio/shared';

/** Rough size of a request in tokens: the consent dialog says "about", so four bytes a token is enough. */
export const approxTokens = (bytes: number) => Math.ceil(bytes / 4);

/**
 * A point asks for consent until the owner has seen the state it sends now (its version) and agreed
 * for the provider that will receive it: consent given on the CLI does not cover Jev.
 */
export function needsConsent(info: Pick<DecisionPointInfo, 'stateVersion'>, consent: DecisionPointSettings['consent'], provider: DecisionProviderId): boolean {
  return !consent || consent.stateVersion !== info.stateVersion || !consent.providers.includes(provider);
}

/** The providers a new consent covers: what was agreed before for this same state, plus this one. */
export function consentProviders(info: Pick<DecisionPointInfo, 'stateVersion'>, consent: DecisionPointSettings['consent'], provider: DecisionProviderId): DecisionProviderId[] {
  const before = consent && consent.stateVersion === info.stateVersion ? consent.providers : [];
  return before.includes(provider) ? [...before] : [...before, provider];
}

export const THRESHOLD_MIN = 0.5;
export const THRESHOLD_MAX = 0.99;
export const MODES: DecisionMode[] = ['off', 'shadow', 'active'];

/** The point the Supervisor is (docs/plans/settings-ia.md §7.2): its mode is the Supervisor's only switch. */
export const SUPERVISOR_POINT = 'supervisor.intervene' satisfies DecisionPointId;

/** The ids hold dots, which i18next reads as nesting, so each point has a flat camelCase key. */
export const POINT_KEY: Record<DecisionPointId, string> = {
  'flow.refine-needed': 'flowRefineNeeded',
  'flow.bounce': 'flowBounce',
  'flow.scope-drift': 'flowScopeDrift',
  'flow.criteria-precheck': 'flowCriteriaPrecheck',
  'flow.criteria-merge': 'flowCriteriaMerge',
  'flow.restart': 'flowRestart',
  'board.triage': 'boardTriage',
  'team.assign': 'teamAssign',
  'memory.triage': 'memoryTriage',
  'journal.relevance': 'journalRelevance',
  'lesson.mine': 'lessonMine',
  'assistant.rerank': 'assistantRerank',
  'assistant.sources': 'assistantSources',
  'orchestration.retry': 'orchestrationRetry',
  'orchestration.model': 'orchestrationModel',
  'orchestration.fixer': 'orchestrationFixer',
  'run.continuation': 'runContinuation',
  'supervisor.intervene': 'supervisorIntervene',
  'health.semantic-loop': 'healthSemanticLoop',
  'health.test-weakening': 'healthTestWeakening',
  'changes.unexplained-hunk': 'changesUnexplainedHunk',
  'checks.fix': 'checksFix',
  'review.triage': 'reviewTriage',
  'issue.triage': 'issueTriage',
  'account.model-fallback': 'accountModelFallback',
  'review.depth': 'reviewDepth',
  'notification.urgency': 'notificationUrgency',
  'palette.intent': 'paletteIntent',
  'context.compact': 'contextCompact',
};

export type AreaId = 'flow' | 'board' | 'memory' | 'assistant' | 'orchestrations' | 'health' | 'review' | 'hosts' | 'notifications' | 'palette';

/** `run.continuation` sits under Orchestrations although it also serves the flow (the plan's call). */
export const AREAS: ReadonlyArray<{ id: AreaId; points: readonly DecisionPointId[] }> = [
  { id: 'flow', points: ['flow.refine-needed', 'flow.bounce', 'flow.scope-drift', 'flow.criteria-precheck', 'flow.criteria-merge', 'flow.restart', 'context.compact'] },
  { id: 'board', points: ['board.triage', 'team.assign'] },
  { id: 'memory', points: ['memory.triage', 'journal.relevance', 'lesson.mine'] },
  { id: 'assistant', points: ['assistant.rerank', 'assistant.sources'] },
  { id: 'orchestrations', points: ['orchestration.retry', 'orchestration.model', 'orchestration.fixer', 'run.continuation', 'account.model-fallback', 'review.depth'] },
  { id: 'health', points: ['supervisor.intervene', 'health.semantic-loop', 'health.test-weakening'] },
  { id: 'review', points: ['changes.unexplained-hunk'] },
  { id: 'hosts', points: ['checks.fix', 'review.triage', 'issue.triage'] },
  { id: 'notifications', points: ['notification.urgency'] },
  { id: 'palette', points: ['palette.intent'] },
];

/** The area a point is listed under, or null for a point no area lists (a newer server). */
export const areaOf = (point: DecisionPointId): AreaId | null => AREAS.find((area) => area.points.includes(point))?.id ?? null;

/** How a folded group's points stand, most engaged first, leaving out the modes no point is in. */
export function groupSummary(modes: readonly DecisionMode[], label: (mode: DecisionMode, count: number) => string): string {
  const order: DecisionMode[] = ['active', 'shadow', 'off'];
  return order
    .map((mode) => ({ mode, count: modes.filter((m) => m === mode).length }))
    .filter((entry) => entry.count > 0)
    .map((entry) => label(entry.mode, entry.count))
    .join(' · ');
}

/**
 * An act point changes what happens, so on the CLI (no calibrated confidence) it cannot be active.
 * The Supervisor is the exception: its Active means "send the hint on its own", which needs no
 * probability, so it works on the CLI too (§7.2).
 */
export const activeBlocked = (info: Pick<DecisionPointInfo, 'id' | 'kind'>, provider: DecisionProviderId) =>
  info.kind === 'act' && provider === 'cli' && info.id !== SUPERVISOR_POINT;

/**
 * Active in name only, as the engine's `effective().limited` says: an act point on the CLI never
 * clears a threshold, and a point without consent for what it sends to this provider asks nothing.
 * The Supervisor on the CLI asks the engine nothing, so it is Active in full there, consent or not.
 * A point without consent is off, not "shadow": see `offUntilConsent`.
 */
export function isLimited(
  info: Pick<DecisionPointInfo, 'id' | 'kind' | 'stateVersion'>,
  consent: DecisionPointSettings['consent'],
  mode: DecisionMode,
  provider: DecisionProviderId,
): boolean {
  if (mode !== 'active') return false;
  if (info.id === SUPERVISOR_POINT && provider === 'cli') return false;
  return needsConsent(info, consent, provider) || (info.kind === 'act' && provider === 'cli');
}

/**
 * A point that is not off but has no consent for this provider and state: the engine returns
 * "off" for it before it splits shadow from active (`engine.ts`), so the row says so and offers
 * the consent. The Supervisor's Active on the CLI never reaches the engine, so it is exempt.
 */
export function offUntilConsent(
  info: Pick<DecisionPointInfo, 'id' | 'stateVersion'>,
  consent: DecisionPointSettings['consent'],
  mode: DecisionMode,
  provider: DecisionProviderId,
): boolean {
  if (mode === 'off') return false;
  if (info.id === SUPERVISOR_POINT && provider === 'cli' && mode === 'active') return false;
  return needsConsent(info, consent, provider);
}

/** What the Supervisor does in each mode, on each provider: the line under its row. */
export function supervisorMeaning(mode: DecisionMode, provider: DecisionProviderId): 'off' | 'shadow' | 'activeCli' | 'activeJev' {
  if (mode === 'active') return provider === 'jev' ? 'activeJev' : 'activeCli';
  return mode;
}

/**
 * The point whose payload "See an example payload" shows: the first one consented to, in the order
 * of the screen, or the Supervisor's when none is.
 */
export function examplePoint(order: readonly DecisionPointId[], consented: (id: DecisionPointId) => boolean): DecisionPointId {
  return order.find(consented) ?? SUPERVISOR_POINT;
}

/** A point's evidence over the history window: how many it decided, how often it agreed with you, and where it did not. */
export interface Evidence {
  count: number;
  /** Whole percentage of the compared answers that matched; null before any was compared */
  agreement: number | null;
  disagreements: number;
}

export function evidenceOf(stats: Pick<DecisionPointStats, 'count' | 'resolved' | 'agreed'> | undefined): Evidence {
  if (!stats) return { count: 0, agreement: null, disagreements: 0 };
  return { count: stats.count, agreement: percent(stats.agreed, stats.resolved), disagreements: Math.max(0, stats.resolved - stats.agreed) };
}

/**
 * The cap's consequence (owner's decision 7): what the cap costs a day at the volume of the history
 * window, and how many decisions a day the daily spend cap leaves room for.
 */
export interface CapConsequence {
  /** null with no decisions in the window: then the line says the cap itself */
  perDayUsd: number | null;
  /** null with no daily spend cap set */
  withinDaily: number | null;
}

export function capConsequence(capUsd: number, decisions: number, days: number, dailyCapUsd: number | null): CapConsequence {
  const valid = Number.isFinite(capUsd) && capUsd > 0;
  return {
    perDayUsd: valid && decisions > 0 && days > 0 ? (capUsd * decisions) / days : null,
    withinDaily: valid && dailyCapUsd !== null && dailyCapUsd > 0 ? Math.floor(dailyCapUsd / capUsd) : null,
  };
}

export interface BulkPlan {
  /** The mode each point that changes ends up in */
  changes: Array<{ id: DecisionPointId; mode: DecisionMode }>;
  /** Points that already sit in the mode that would result: nothing to do */
  unchanged: DecisionPointId[];
  /** Points that keep a lower mode than the one asked for, because they cannot be active */
  capped: DecisionPointId[];
  /** Changes that leave `off` without consent for what they send now: they wait for the person to see it */
  needConsent: Array<{ id: DecisionPointId; mode: Exclude<DecisionMode, 'off'> }>;
}

/**
 * What setting many points to one mode does, point by point. A point that cannot be active keeps
 * shadow (its allowed maximum) instead of failing the whole batch, and only points that actually
 * change are asked for consent: one already in shadow is not asked again by a batch.
 */
export function planBulk(
  catalogue: readonly DecisionPointInfo[],
  ids: readonly DecisionPointId[],
  mode: DecisionMode,
  current: (id: DecisionPointId) => DecisionMode,
  consentOf: (id: DecisionPointId) => DecisionPointSettings['consent'],
  provider: DecisionProviderId,
): BulkPlan {
  const plan: BulkPlan = { changes: [], unchanged: [], capped: [], needConsent: [] };
  for (const id of ids) {
    const info = catalogue.find((point) => point.id === id);
    if (!info) continue;
    const capped = mode === 'active' && activeBlocked(info, provider);
    const result: DecisionMode = capped ? 'shadow' : mode;
    if (capped) plan.capped.push(id);
    if (current(id) === result) {
      plan.unchanged.push(id);
      continue;
    }
    plan.changes.push({ id, mode: result });
    if (result !== 'off' && needsConsent(info, consentOf(id), provider)) plan.needConsent.push({ id, mode: result });
  }
  return plan;
}

/** A share as a whole percentage, or null while there is nothing to divide by. */
export function percent(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}

export type HistoryOutcome = 'match' | 'differs' | 'pending' | 'asUsual';

/** What the Result column says: an unavailable request changed nothing, and an answer waits to be compared. */
export function outcomeOf(record: Pick<DecisionRecord, 'status' | 'agreed'>): HistoryOutcome {
  if (record.status === 'unavailable') return 'asUsual';
  if (record.agreed === true) return 'match';
  if (record.agreed === false) return 'differs';
  return 'pending';
}

export interface AnswerLine {
  question: string;
  /** The option label, or the level id; a yes/no answer is a boolean the view words */
  value: string | boolean;
  /** Each option with its probability, most likely first; a yes/no answer uses the ids `yes` and `no` */
  bars: Array<{ id: string; label: string; probability: number }>;
}

/** One line per question that was answered, with the labels the question carried. */
export function answerLines(record: Pick<DecisionRecord, 'questions' | 'answers'>): AnswerLine[] {
  const lines: AnswerLine[] = [];
  for (const question of record.questions) {
    const answer = record.answers?.[question.id];
    if (!answer) continue;
    if (answer.kind === 'noul') {
      const yes = answer.probability;
      lines.push({
        question: question.question,
        value: answer.value,
        bars: yes === null ? [] : [{ id: 'yes', label: 'yes', probability: yes }, { id: 'no', label: 'no', probability: 1 - yes }],
      });
      continue;
    }
    const labels = new Map<string, string>(question.kind === 'choice' ? question.options.map((o) => [o.id, o.label]) : []);
    const label = (id: string) => labels.get(id) ?? id;
    const bars = Object.entries(answer.probabilities ?? {})
      .map(([id, probability]) => ({ id, label: label(id), probability }))
      .sort((a, b) => b.probability - a.probability);
    lines.push({ question: question.question, value: label(answer.value), bars });
  }
  return lines;
}

export interface PointDraft {
  mode: DecisionMode;
  threshold: number;
}

/** What the save bar sends together (§7.1): who answers, the cap, Advanced and every point's mode. */
export interface Draft {
  provider: DecisionProviderId;
  cli: DecisionSettings['cli'];
  historyDays: number;
  points: Partial<Record<DecisionPointId, PointDraft>>;
}

export const draftOf = (saved: DecisionSettings): Draft => ({
  provider: saved.provider,
  cli: saved.cli,
  historyDays: saved.historyDays,
  points: Object.fromEntries(Object.entries(saved.points).map(([id, point]) => [id, { mode: point.mode, threshold: point.threshold }])),
});

/**
 * The draft with one row's field taken from `source` (the draft of the saved document after a Reset),
 * so the row shows its default while every other unsaved edit stays. An unknown row changes nothing.
 */
export function withSettingFrom(draft: Draft, source: Draft, setting: string): Draft {
  switch (setting) {
    case 'engine.who-answers':
      return { ...draft, provider: source.provider };
    case 'engine.cap':
      return { ...draft, cli: { ...draft.cli, maxCostUsd: source.cli.maxCostUsd } };
    case 'engine.cli-model':
      return { ...draft, cli: { ...draft.cli, model: source.cli.model } };
    case 'engine.cli-effort':
      return { ...draft, cli: { ...draft.cli, effort: source.cli.effort } };
    case 'engine.history-days':
      return { ...draft, historyDays: source.historyDays };
  }
  const id = DECISION_POINT_IDS.find((point) => pointSettingId(point) === setting);
  if (!id) return draft;
  const points = { ...draft.points };
  const saved = source.points[id];
  if (saved) points[id] = saved;
  else delete points[id];
  return { ...draft, points };
}

export const sameDraft = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

export function pointOf(draft: Draft, catalogue: readonly DecisionPointInfo[], id: DecisionPointId): PointDraft {
  return draft.points[id] ?? { mode: 'off', threshold: catalogue.find((p) => p.id === id)?.defaultThreshold ?? THRESHOLD_MIN };
}
