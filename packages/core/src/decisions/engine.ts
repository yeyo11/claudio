import { randomUUID } from 'node:crypto';
import type {
  DecisionActivationRefusal,
  DecisionAnswer,
  DecisionBaseline,
  DecisionDemotion,
  DecisionGateSettings,
  DecisionLimitReason,
  DecisionMode,
  DecisionPointId,
  DecisionPointEvidence,
  DecisionPointInfo,
  DecisionPointStanding,
  DecisionProviderId,
  DecisionQuestion,
  DecisionRecord,
  DecisionResolution,
  DecisionRunEffect,
  DecisionSettings,
  DecisionSettingsSaveResult,
  DecisionStanding,
  DecisionStats,
  DecisionTestResult,
  DecisionUnavailableReason,
  ProjectDecisionSettings,
} from '@claudio/shared';
import type { Db, DecisionEvidenceRow } from '../db.ts';
import type { ClaudioEventInput } from '../events.ts';
import { decisionStats, pointEvidence, readPointEvidence, type EvidenceWindow } from './evidence.ts';
import { decisionPoint, DECISION_POINTS, type DecisionPointDefinition, type DecisionSubject } from './points.ts';
import { questionsHash } from './questions-hash.ts';
import { labelsFromOutcomes } from './replay.ts';
import { redactState, stateBytes } from './redact.ts';
import { DEFAULT_FLOOR, DEFAULT_GATE, DEFAULT_THRESHOLD, JEV_MODEL, SUPERVISOR_POINT, type DecisionSettingsStore } from './settings.ts';
import {
  demotionOf,
  demotionText,
  gateEnforced,
  holdoutShare,
  judgeActivation,
  promotionOf,
  RATE_MIN_ROWS,
  RATE_WINDOW_DAYS,
  standingOf,
  demotable,
  type ActivationChange,
  type ReplayEvidence,
  type RunsOn,
} from './standing.ts';
import { evidencePossible } from './resolve.ts';

/** What a provider is asked: the redacted state and the typed questions, one batch, one call */
export interface DecisionRequest {
  point: DecisionPointId;
  state: Record<string, unknown>;
  questions: ReadonlyArray<DecisionQuestion>;
}

export type ProviderResult =
  | { status: 'answered'; answers: Record<string, DecisionAnswer>; latencyMs: number; inputTokens: number | null; costUsd: number | null; model: string }
  | { status: 'unavailable'; reason: DecisionUnavailableReason; latencyMs: number };

export interface DecisionProvider {
  readonly id: DecisionProviderId;
  /** True when a call can be made now (the CLI is found and has quota; a Jev key is saved) */
  available(): boolean;
  /** Why `available()` is false; the engine falls back to a per-provider default when absent */
  whyUnavailable?(): DecisionUnavailableReason;
  ask(request: DecisionRequest, opts: { deadlineMs: number; signal: AbortSignal }): Promise<ProviderResult>;
}

export interface DecisionOutcome {
  /** Null when the point is off, or nothing was asked */
  decisionId: string | null;
  /** The mode in force after project, then global, then the default */
  mode: DecisionMode;
  /** True only when the caller should act on `answers` */
  act: boolean;
  /** Set only when `act` is true: a shadow answer never reaches a call site's behaviour */
  answers: Record<string, DecisionAnswer> | null;
}

export interface DecisionEngineDeps {
  settings: DecisionSettingsStore;
  db: Pick<Db, 'insertDecision' | 'resolveDecision' | 'lastDecisionOf' | 'pruneDecisions' | 'decisionStats' | 'decisionEvidenceRows' | 'listDecisions' | 'decisionLabels' | 'saveDecisionLabel'>;
  /** A project's own overrides, read from its settings document */
  projectDecisions: (projectId: string) => ProjectDecisionSettings | null;
  now?: () => Date;
  /** Where a demotion is told (the event bus, so the web and push both hear it); absent tells no one */
  emit?: (event: ClaudioEventInput) => void;
  /**
   * The latest replay of a point over the golden set under its questions in force, run on what the
   * point runs on (`runsOn`); absent, or null, when there is none
   */
  replayEvidence?: (point: DecisionPointId, runsOn: RunsOn) => ReplayEvidence | null;
  /** The holdout's coin, in [0, 1); tests fix it */
  random?: () => number;
  /**
   * A fixed standing in place of the computed one. For tests of what a call site does once its point
   * may act, which would otherwise need thirty resolved rows first; the gate's own tests leave it out.
   */
  standing?: (point: DecisionPointId) => DecisionStanding;
}

/**
 * A settings write the promotion gate refuses (D1, and no bulk activation). Its `statusCode` and
 * `reason` make the API's answer a typed 409; `body` is that answer whole, with the evidence missing.
 */
export class DecisionActivationError extends Error {
  readonly statusCode = 409;
  readonly reason: DecisionActivationRefusal['code'];
  readonly body: DecisionActivationRefusal;
  constructor(code: DecisionActivationRefusal['code'], points: DecisionActivationRefusal['points']) {
    const names = points.map((p) => p.point).join(', ');
    const message =
      code === 'decision-bulk-activation'
        ? `only one decision point without proven evidence can be switched to active at a time: ${names}`
        : `${names} cannot be switched to active until it has proven evidence (standing ${points.map((p) => p.standing).join(', ')})`;
    super(message);
    this.reason = code;
    this.body = { error: message, code, points };
  }
}

/** A standing is read again after this long, or as soon as an outcome or a settings write lands */
const STANDING_TTL_MS = 60_000;
/** Rate checks that need no new outcome (an act rate drifting) still run this often */
const REVIEW_EVERY_MS = 60 * 60_000;
const DAY_MS = 86_400_000;
const GATED: ReadonlySet<DecisionLimitReason> = new Set(['unproven', 'failing', 'demoted']);

/** A provider that has not answered by then is unavailable; Jev is fast, the CLI is background work */
export const DEADLINE_MS: Readonly<Record<DecisionProviderId, number>> = { jev: 1_500, cli: 30_000 };

export interface EffectiveDecision {
  mode: DecisionMode;
  threshold: number;
  provider: DecisionProviderId;
  consent: NonNullable<DecisionSettings['points'][DecisionPointId]>['consent'];
  /** Active in name only: an act point on `cli` never clears a threshold (`supervisor.intervene` aside), a point without consent is off, not shadow (the engine gates on consent first), and a gated point without standing `proven` is shadow */
  limited: boolean;
  /** Why a point that is not off does not do what its mode says; null when it does */
  limitedBy: DecisionLimitReason | null;
  /** Suggest points: the confidence a suggestion needs to be shown; null for act points */
  floor: number | null;
}

const OUTCOME_OFF = (mode: DecisionMode = 'off'): DecisionOutcome => ({ decisionId: null, mode, act: false, answers: null });

/**
 * The one door every decision goes through. It resolves the settings, gates on consent, builds and
 * redacts the state, asks a provider under a deadline, records the row and says whether the caller
 * should act. It never throws into the caller: whatever goes wrong is today's behaviour.
 */
export class DecisionEngine {
  private readonly providers = new Map<DecisionProviderId, DecisionProvider>();
  private readonly deps: DecisionEngineDeps;
  private pruneTimer: NodeJS.Timeout | null = null;
  private reviewTimer: NodeJS.Timeout | null = null;
  private reviewSoon: NodeJS.Timeout | null = null;
  /** The reviews in flight, one after the other; shutdown waits for it */
  private reviews: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly standings = new Map<DecisionPointId, { until: number; value: DecisionPointStanding }>();

  constructor(deps: DecisionEngineDeps) {
    this.deps = deps;
  }

  register(provider: DecisionProvider): void {
    this.providers.set(provider.id, provider);
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /** Project override, then global, then the point's own default (D8); consent is always global */
  effective(point: DecisionPointId, projectId: string | null, settings: DecisionSettings = this.deps.settings.get()): EffectiveDecision {
    const def = decisionPoint(point);
    const global = settings.points[point];
    const project = def?.scope === 'project' && projectId ? this.deps.projectDecisions(projectId) : null;
    const override = project?.points?.[point];
    const provider = project?.provider && project.provider !== 'inherit' ? project.provider : settings.provider;
    const mode = override?.mode ?? global?.mode ?? 'off';
    const threshold = override?.threshold ?? global?.threshold ?? def?.defaultThreshold ?? DEFAULT_THRESHOLD;
    const consent = global?.consent ?? null;
    const consented = !!def && !!consent && consent.stateVersion === def.stateVersion && consent.providers.includes(provider);
    // The CLI has no calibrated confidence, and the palette needs a provider that answers in a blink.
    // The Supervisor's Active is sending its hints on its own, which needs no probability and asks
    // the engine nothing under the CLI, so it is Active in full there (docs/plans/settings-ia.md §7.2)
    // and, asking nothing, has nothing to prove either
    const selfActing = point === SUPERVISOR_POINT && provider === 'cli';
    let limitedBy: DecisionLimitReason | null = null;
    if (def && mode !== 'off' && !selfActing) {
      if (!consented) limitedBy = 'no-consent';
      else if (def.needsLowLatency && provider !== 'jev') limitedBy = 'cli';
      else if (mode === 'active') {
        if (def.kind === 'act' && provider === 'cli') limitedBy = 'cli';
        // Only a project override can hold active what the engine moved back to shadow
        else if (global?.demoted) limitedBy = 'demoted';
        else if (gateEnforced(def)) {
          const standing = this.standingNow(point, settings);
          if (standing !== 'proven') limitedBy = standing;
        }
      }
    }
    const limited = mode === 'active' && limitedBy !== null;
    const floor = def?.kind === 'suggest' ? (global?.floor ?? DEFAULT_FLOOR) : null;
    return { mode, threshold, provider, consent, limited, limitedBy, floor };
  }

  private gateSettings(settings: DecisionSettings): DecisionGateSettings {
    // A settings double in a test may carry no gate; the defaults stand in
    return (settings as Partial<DecisionSettings>).gate ?? DEFAULT_GATE;
  }

  private window(): EvidenceWindow {
    const days = this.deps.settings.get().historyDays;
    return { since: new Date(this.now().getTime() - days * DAY_MS).toISOString() };
  }

  /**
   * Where a point stands against its gate, from the window's `direct` outcomes and its latest replay
   * under the questions in force. Cached for a minute, and dropped when an outcome or a settings
   * write lands: `effective` is read on every call site's path.
   */
  pointStanding(point: DecisionPointId, settings: DecisionSettings = this.deps.settings.get(), fresh = false): DecisionPointStanding | null {
    const def = decisionPoint(point);
    return def ? this.standingOfDef(def, settings, fresh) : null;
  }

  private standingOfDef(def: DecisionPointDefinition, settings: DecisionSettings, fresh = false): DecisionPointStanding {
    const point = def.id;
    const cached = this.standings.get(point);
    if (!fresh && cached && cached.until > Date.now()) return cached.value;
    const live = readPointEvidence(this.deps.db, point, this.window());
    // The provider the point runs on install-wide; a project's own provider does not change its standing
    const runsOn: RunsOn = { provider: settings.provider, model: settings.provider === 'jev' ? JEV_MODEL : null };
    const replay = this.deps.replayEvidence?.(point, runsOn) ?? null;
    const computed = standingOf(def, this.gateSettings(settings), live, replay, questionsHash(point), runsOn);
    const value = this.deps.standing ? { ...computed, standing: this.deps.standing(point) } : computed;
    this.standings.set(point, { until: Date.now() + STANDING_TTL_MS, value });
    return value;
  }

  private standingNow(point: DecisionPointId, settings: DecisionSettings): DecisionStanding {
    return this.pointStanding(point, settings)?.standing ?? 'unproven';
  }

  /** The act (or flag) rate of the point's shadow rows in the window; null with too few to read */
  private shadowRate(point: DecisionPointId): number | null {
    const rows = this.deps.db.decisionEvidenceRows({ ...this.window(), point }).filter((r) => r.mode === 'shadow');
    const rate = pointEvidence(point, rows).actRate;
    return rate.n >= RATE_MIN_ROWS ? rate.value : null;
  }

  /**
   * How many times an active point acted, or would have and was held out, since it was promoted (or,
   * with no promotion mark, over the window): what the holdout share reads. D3's "first 100 acts" are
   * those of its current time in Active, not of an earlier one it was demoted from.
   */
  private actsInWindow(point: DecisionPointId, settings: DecisionSettings): number {
    const window = this.window();
    const promoted = settings.points[point]?.promotion?.at;
    const since = promoted && promoted > window.since ? promoted : window.since;
    const rows: DecisionEvidenceRow[] = this.deps.db.decisionEvidenceRows({ ...window, since, point });
    return rows.filter((r) => r.mode === 'active' && (r.acted || r.heldOut)).length;
  }

  /** The catalogue with the settings in force for a scope (`GET /decisions/points`) */
  catalogue(projectId: string | null): DecisionPointInfo[] {
    const settings = this.deps.settings.get();
    return DECISION_POINTS.map((def) => {
      const { standing, decidedBy, gate, live, replay } = this.standingOfDef(def, settings);
      return {
        id: def.id,
        kind: def.kind,
        scope: def.scope,
        primitives: [...def.primitives],
        defaultThreshold: def.defaultThreshold,
        savesRun: def.effect.savesRun,
        causesRun: def.effect.causesRun,
        needsLowLatency: def.needsLowLatency,
        stateVersion: def.stateVersion,
        effective: this.effective(def.id, projectId, settings),
        standing,
        decidedBy,
        evidencePossible: evidencePossible(def.id),
        gate,
        live,
        replay,
        demoted: settings.points[def.id]?.demoted ?? null,
      };
    });
  }

  /**
   * `PUT /decisions/settings`: the promotion gate, then the write. A write that newly activates a
   * point without standing `proven` is refused when the point is gated, or when it activates more
   * than one such point; a suggestion that only prepares something is let through with a warning.
   * A point it activates loses its demotion, and gets its promotion mark when it is proven.
   */
  async saveSettings(input: unknown): Promise<DecisionSettingsSaveResult> {
    const before = this.deps.settings.get();
    const next = this.deps.settings.parse(input);
    const changes: ActivationChange[] = [];
    for (const def of DECISION_POINTS) {
      const was = before.points[def.id]?.mode ?? 'off';
      const will = next.points[def.id]?.mode ?? 'off';
      if (will !== 'active' || was === 'active') continue;
      // Judged on the gate already in force: a write cannot loosen the gate and use it at once
      changes.push({ def, before: was, after: will, standing: this.standingOfDef(def, before, true) });
    }
    const verdict = judgeActivation(changes);
    if (verdict.refusal) throw new DecisionActivationError(verdict.refusal.code, verdict.refusal.points);
    const at = this.now().toISOString();
    const activated: Parameters<DecisionSettingsStore['set']>[1] = {};
    for (const id of verdict.activated) {
      const standing = changes.find((c) => c.def.id === id)?.standing;
      activated[id] = standing?.standing === 'proven' ? promotionOf(standing, this.shadowRate(id), at) : null;
    }
    const saved = await this.deps.settings.set(input, activated);
    this.standings.clear();
    return { ...saved, warnings: verdict.warnings };
  }

  /**
   * The same gate for a project's override, before its settings document is written: what the
   * override newly makes active in that project, against what was in force there before. Warnings
   * have no answer to travel in and are dropped; the point's row shows its standing.
   */
  checkProjectActivation(before: ProjectDecisionSettings | null, after: ProjectDecisionSettings | null): void {
    const settings = this.deps.settings.get();
    const changes: ActivationChange[] = [];
    for (const def of DECISION_POINTS) {
      if (def.scope !== 'project') continue;
      const global = settings.points[def.id]?.mode ?? 'off';
      const was = before?.points?.[def.id]?.mode ?? global;
      const will = after?.points?.[def.id]?.mode ?? global;
      if (will !== 'active' || was === 'active') continue;
      changes.push({ def, before: was, after: will, standing: this.standingOfDef(def, settings, true) });
    }
    const verdict = judgeActivation(changes);
    if (verdict.refusal) throw new DecisionActivationError(verdict.refusal.code, verdict.refusal.points);
  }

  /** The state a subject would send, built and redacted locally and never sent (D12) */
  async previewState(point: DecisionPointId, subject: DecisionSubject): Promise<{ state: Record<string, unknown>; bytes: number } | null> {
    const def = decisionPoint(point);
    if (!def) return null;
    const state = redactState(await def.buildState(subject), def.maxStateBytes);
    return { state, bytes: stateBytes(state) };
  }

  /** The state of the point's latest request, exactly as it was sent */
  lastState(point: DecisionPointId): { state: Record<string, unknown>; bytes: number; provider: DecisionProviderId } | null {
    const last = this.deps.db.lastDecisionOf(point);
    return last ? { state: last.state, bytes: stateBytes(last.state), provider: last.provider } : null;
  }

  /**
   * `scope.baseline` is what the call site's own code rule answered for the same input; it is stored
   * with the row so the answer can be compared with the behaviour it would replace (M2).
   */
  async ask(point: DecisionPointId, subject: DecisionSubject, scope: { projectId: string | null; baseline?: DecisionBaseline }): Promise<DecisionOutcome> {
    try {
      return await this.run(point, subject, scope.projectId, scope.baseline ?? null);
    } catch {
      // A decision is an aid: a bug in one must leave the caller on today's behaviour
      return OUTCOME_OFF();
    }
  }

  private async run(point: DecisionPointId, subject: DecisionSubject, projectId: string | null, baseline: DecisionBaseline | null): Promise<DecisionOutcome> {
    const def = decisionPoint(point);
    if (!def) return OUTCOME_OFF();
    const settings = this.deps.settings.get();
    const eff = this.effective(point, projectId, settings);
    if (eff.mode === 'off') return OUTCOME_OFF();
    // No consent for this state shape and provider: nothing is built, nothing is asked (D12)
    const consent = eff.consent;
    if (!consent || consent.stateVersion !== def.stateVersion || !consent.providers.includes(eff.provider)) return OUTCOME_OFF();
    if (def.needsLowLatency && eff.provider !== 'jev') return OUTCOME_OFF();

    // A gated point without standing `proven` asks and records as shadow (D1): its rows are evidence like any shadow row
    const gated = eff.limitedBy !== null && GATED.has(eff.limitedBy);
    const inForce: DecisionMode = gated ? 'shadow' : eff.mode;
    const questions = def.questions(subject);
    if (questions.length === 0 || !questionsValid(questions)) return OUTCOME_OFF(inForce);
    const state = redactState(await def.buildState(subject), def.maxStateBytes);
    const mode: 'shadow' | 'active' = inForce === 'active' ? 'active' : 'shadow';

    const provider = this.providers.get(eff.provider);
    const model = eff.provider === 'jev' ? JEV_MODEL : settings.cli.model;
    let result: ProviderResult;
    if (!provider || !provider.available()) {
      result = { status: 'unavailable', reason: provider?.whyUnavailable?.() ?? (eff.provider === 'jev' ? 'no-key' : 'server-error'), latencyMs: 0 };
    } else {
      result = await this.call(provider, { point, state, questions }, DEADLINE_MS[eff.provider]);
      if (result.status === 'answered' && !answersValid(questions, result.answers)) {
        result = { status: 'unavailable', reason: 'invalid-answer', latencyMs: result.latencyMs };
      }
    }

    const answered = result.status === 'answered';
    const answers = result.status === 'answered' ? result.answers : null;
    const confidence = answers ? lowestConfidence(answers) : null;
    // An act point acts above its threshold, and a null confidence never clears one. A suggestion
    // is prepared for a person to decide, at or above its floor; the CLI gives no confidence, and
    // its suggestions are not held to one
    let act =
      answered &&
      mode === 'active' &&
      (def.kind === 'suggest' ? confidence === null || confidence >= (eff.floor ?? DEFAULT_FLOOR) : confidence !== null && confidence >= eff.threshold);
    // D3: a share of what an active act point would act on runs today's behaviour instead, so the
    // point is judged on cases it did not itself shape
    let heldOut = false;
    if (act && def.kind === 'act' && this.random() < holdoutShare(this.actsInWindow(point, settings))) {
      act = false;
      heldOut = true;
    }
    const runEffect: DecisionRunEffect = act && answers ? def.effect.runs(answers, baseline) : 0;

    const id = randomUUID();
    const row: DecisionRecord = {
      id,
      point,
      kind: def.kind,
      projectId: def.scope === 'project' ? projectId : null,
      subjectKind: subject.kind,
      subjectId: subject.id,
      provider: eff.provider,
      model: result.status === 'answered' ? result.model : model,
      mode,
      status: result.status,
      unavailable: result.status === 'unavailable' ? result.reason : null,
      state,
      questions: [...questions],
      answers,
      confidence,
      threshold: def.kind === 'act' ? eff.threshold : null,
      acted: act,
      visible: act && def.visible,
      savedRun: runEffect > 0,
      runEffect,
      baseline,
      heldOut,
      latencyMs: Math.round(result.latencyMs),
      inputTokens: result.status === 'answered' ? result.inputTokens : null,
      costUsd: result.status === 'answered' ? result.costUsd : null,
      outcome: null,
      agreed: null,
      resolvedAt: null,
      feedback: null,
      feedbackAt: null,
      openedAt: null,
      paletteAction: null,
      at: this.now().toISOString(),
    };
    try {
      this.deps.db.insertDecision(row);
    } catch {
      // A history row that cannot be written is not a reason to change what happens
      return { decisionId: null, mode: inForce, act, answers: act ? answers : null };
    }
    return { decisionId: id, mode: inForce, act, answers: act ? answers : null };
  }

  /** Runs the provider under the deadline; whatever it does short of answering is unavailable */
  private async call(provider: DecisionProvider, request: DecisionRequest, deadlineMs: number): Promise<ProviderResult> {
    const started = Date.now();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<ProviderResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ status: 'unavailable', reason: 'timeout', latencyMs: Date.now() - started });
      }, deadlineMs);
    });
    try {
      const asked = provider.ask(request, { deadlineMs, signal: controller.signal }).catch(
        (): ProviderResult => ({ status: 'unavailable', reason: 'server-error', latencyMs: Date.now() - started }),
      );
      return await Promise.race([asked, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One small fixed question to a provider, for `POST /decisions/test`. No row is written and no
   * consent is needed: the state is a constant and carries nothing of the person's.
   */
  async test(id: DecisionProviderId): Promise<DecisionTestResult> {
    const provider = this.providers.get(id);
    const model = id === 'jev' ? JEV_MODEL : this.deps.settings.get().cli.model;
    if (!provider?.available()) {
      return { provider: id, ok: false, latencyMs: 0, model, reason: provider?.whyUnavailable?.() ?? (id === 'jev' ? 'no-key' : 'server-error') };
    }
    const questions: DecisionQuestion[] = [
      { kind: 'choice', id: 'reply', question: 'Which of the two options is the word "yes"?', options: [{ id: 'yes', label: 'yes' }, { id: 'no', label: 'no' }] },
    ];
    const result = await this.call(provider, { point: 'palette.intent', state: { query: 'connection test' }, questions }, DEADLINE_MS[id]);
    return result.status === 'answered'
      ? { provider: id, ok: true, latencyMs: Math.round(result.latencyMs), model: result.model, reason: null }
      : { provider: id, ok: false, latencyMs: Math.round(result.latencyMs), model, reason: result.reason };
  }

  /** Called by the point when what happened becomes known (shadow accuracy) */
  resolve(decisionId: string, outcome: DecisionResolution): void {
    try {
      this.deps.db.resolveDecision(decisionId, outcome, this.now().toISOString());
    } catch {
      // The database may be closed at shutdown
      return;
    }
    this.standings.clear();
    // The resolvers' sweep resolves its rows in one synchronous pass: a review queued on the next
    // turn of the loop runs once, after the sweep, on everything it resolved
    if (this.reviewTimer && !this.stopped && !this.reviewSoon) {
      this.reviewSoon = setTimeout(() => {
        this.reviewSoon = null;
        this.queueReview();
      }, 0);
      this.reviewSoon.unref();
    }
  }

  private random(): number {
    return this.deps.random ? this.deps.random() : Math.random();
  }

  /** One review at a time: a demotion writes `decisions.json`, and two at once would race on it */
  private queueReview(): void {
    if (this.stopped) return;
    this.reviews = this.reviews.then(() => this.review()).then(
      () => undefined,
      () => undefined,
    );
  }

  /**
   * D2: re-checks every active point. One whose standing is `failing` (the reading that decides it has
   * the gate's cases and does not clear it) goes back to shadow with the reason, and the person is
   * told, whether or not it carries a promotion mark: an install whose points were switched on before
   * the gate existed has none, and a failing point there must not keep acting or flagging. One that
   * was promoted is also demoted when over the last seven days it acted (or flagged) more than twice as
   * often as on the evidence that promoted it. A point that is active and proven without a mark gets
   * it here, so its rate has something to be compared with. The Supervisor's point is never demoted
   * ({@link demotable}). Nothing is ever promoted. Returns the demotions it made.
   */
  async review(): Promise<Array<{ point: DecisionPointId; demotion: DecisionDemotion }>> {
    const made: Array<{ point: DecisionPointId; demotion: DecisionDemotion }> = [];
    const settings = this.deps.settings.get();
    const now = this.now();
    const at = now.toISOString();
    for (const def of DECISION_POINTS) {
      if (this.stopped) break;
      const stored = settings.points[def.id];
      if (stored?.mode !== 'active') continue;
      const standing = this.standingOfDef(def, settings, true);
      if (!stored.promotion && standing.standing === 'proven') {
        await this.deps.settings.markPromotion(def.id, promotionOf(standing, this.shadowRate(def.id), at));
        continue;
      }
      if (!demotable(def.id)) continue;
      const recentRows = this.deps.db.decisionEvidenceRows({ since: new Date(now.getTime() - RATE_WINDOW_DAYS * DAY_MS).toISOString(), point: def.id });
      // Without a mark there is no promoted rate to compare with: only `failing` can demote it
      const demotion = demotionOf(def, standing, pointEvidence(def.id, recentRows), stored.promotion ?? null, at);
      if (!demotion) continue;
      await this.deps.settings.demote(def.id, demotion);
      this.standings.clear();
      made.push({ point: def.id, demotion });
      const text = demotionText(def.id, demotion);
      this.deps.emit?.({ type: 'decision.demoted', title: text.title, titleCode: text.titleCode, point: def.id, demotion, reason: text.reason, reasonCode: text.reasonCode, params: text.params });
    }
    return made;
  }

  /** Reviews every hour, and right after each sweep of the resolvers that resolved something */
  startReviewing(): void {
    if (this.reviewTimer || this.stopped) return;
    this.reviewTimer = setInterval(() => this.queueReview(), REVIEW_EVERY_MS);
    this.reviewTimer.unref();
    this.queueReview();
  }

  /** Resolves once the review in flight, if any, has written what it writes; shutdown awaits it before the database closes */
  settled(): Promise<void> {
    return this.reviews;
  }

  /** What a point has proved over a window, from `direct` outcomes only: what the promotion gate reads (M6) */
  evidence(point: DecisionPointId, window: EvidenceWindow): DecisionPointEvidence {
    return readPointEvidence(this.deps.db, point, window);
  }

  /** `GET /decisions/stats`: the per-point metrics with each point's baseline comparison and evidence */
  stats(since: string): DecisionStats {
    return decisionStats(this.deps.db, since);
  }

  /**
   * Drops the rows older than `historyDays`; returns how many went. A row whose outcome was `direct`
   * becomes a label first, so the golden set grows by itself and outlives the history (a person's own
   * label for a row is never overwritten, see `labelsFromOutcomes`).
   */
  prune(): number {
    const days = this.deps.settings.get().historyDays;
    const before = new Date(this.now().getTime() - days * 86_400_000).toISOString();
    for (const point of DECISION_POINTS) labelsFromOutcomes(this.deps.db, point.id, { since: '', until: before }, () => this.now());
    return this.deps.db.pruneDecisions(before);
  }

  /** Prunes now and once a day (D9) */
  startPruning(): void {
    if (this.pruneTimer) return;
    const tick = (): void => {
      try {
        this.prune();
      } catch {
        // Closed database: the next start prunes
      }
    };
    tick();
    this.pruneTimer = setInterval(tick, 86_400_000);
    this.pruneTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    if (this.reviewTimer) clearInterval(this.reviewTimer);
    if (this.reviewSoon) clearTimeout(this.reviewSoon);
    this.pruneTimer = null;
    this.reviewTimer = null;
    this.reviewSoon = null;
  }

  /** A registered provider, read only: the replay harness asks through it exactly as a live request would (M5) */
  provider(id: DecisionProviderId): DecisionProvider | undefined {
    return this.providers.get(id);
  }
}

/** The lowest confidence of the batch; null when any answer has none (the CLI) */
export function lowestConfidence(answers: Record<string, DecisionAnswer>): number | null {
  let lowest: number | null = null;
  for (const answer of Object.values(answers)) {
    if (answer.confidence === null) return null;
    lowest = lowest === null ? answer.confidence : Math.min(lowest, answer.confidence);
  }
  return lowest;
}

function questionsValid(questions: ReadonlyArray<DecisionQuestion>): boolean {
  const seen = new Set<string>();
  for (const q of questions) {
    if (!q.id || seen.has(q.id)) return false;
    seen.add(q.id);
    if (q.kind === 'choice' && (q.options.length < 2 || q.options.length > 255)) return false;
    if (q.kind === 'score' && (q.levels.length < 2 || q.levels.length > 10)) return false;
  }
  return true;
}

/** Every question answered, with the right kind, a value that is one of its options or levels, and a confidence in range */
function answersValid(questions: ReadonlyArray<DecisionQuestion>, answers: Record<string, DecisionAnswer>): boolean {
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

export type { DecisionPointDefinition, DecisionSubject };
