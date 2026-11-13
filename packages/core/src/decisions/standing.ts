import type {
  DecisionActivationIssue,
  DecisionDemotion,
  DecisionGateInForce,
  DecisionGateReading,
  DecisionGateSettings,
  DecisionGateShortfall,
  DecisionMode,
  DecisionPointEvidence,
  DecisionPointId,
  DecisionPointStanding,
  DecisionPromotion,
  DecisionProviderId,
  DecisionStanding,
  LocalizedParams,
} from '@claudio/shared';
import type { EvidenceScore } from './evidence.ts';
import type { DecisionPointDefinition } from './points.ts';

/*
 * The lifecycle of a point (docs/plans/decision-engine-v2.md §5): where it stands against its gate,
 * which settings writes the gate refuses, how much of an active point's acting is held out, and when
 * an active point goes back to shadow. Pure: the engine reads the rows and the settings and calls
 * these, so each rule is tested without a database or a clock.
 */

/**
 * A replay over the golden set, as the replay harness stores it. It counts only under the questions it
 * was run with, and only for the provider (and, for Jev, the model) the point runs on: a replay on the
 * CLI's model says nothing about how Jev answers.
 */
export interface ReplayEvidence {
  at: string;
  cases: number;
  provider: DecisionProviderId;
  model: string;
  /** `questionsHash(point)` when the replay ran; another value means the questions changed since */
  questionsHash: string;
  score: EvidenceScore;
}

/** The demotion's rate check compares windows of this length */
export const RATE_WINDOW_DAYS = 7;
/** Fewer answered rows than this in the rate window say nothing about a rate */
export const RATE_MIN_ROWS = 20;
/** A rate more than this many times the promoted one leaves the point's band */
export const RATE_FACTOR = 2;

/**
 * Whether acting without standing `proven` is refused: act points, and suggest points whose answer
 * starts a run (`lesson.mine` starts a miner). Other suggestions only prepare something a person
 * decides on, so they are warned about and allowed (D1).
 */
export function gateEnforced(def: Pick<DecisionPointDefinition, 'kind' | 'effect'>): boolean {
  return def.kind === 'act' || def.effect.causesRun;
}

export function gateInForce(def: Pick<DecisionPointDefinition, 'kind' | 'effect' | 'breakEven'>, gate: DecisionGateSettings): DecisionGateInForce {
  const act = def.kind === 'act';
  return {
    enforced: gateEnforced(def),
    minCases: gate.minCases,
    breakEven: act ? def.breakEven : null,
    minPrecision: act ? null : gate.suggestMinPrecision,
    maxFlagRate: act ? null : gate.suggestMaxFlagRate,
  };
}

/** What one source of evidence lacks against the gate; empty when it clears */
export function shortfallsOf(kind: DecisionPointDefinition['kind'], gate: DecisionGateInForce, cases: number, score: EvidenceScore): DecisionGateShortfall[] {
  const out: DecisionGateShortfall[] = [];
  if (cases < gate.minCases) out.push('cases');
  if (kind === 'act') {
    const lower = score.precision.lower90;
    if (lower === null || !(lower > (gate.breakEven ?? 0.5))) out.push('break-even');
    // Where rows carry the code rule's answer, the point has to beat it, not just be right often
    const base = score.baselinePrecision;
    if (base.n > 0 && base.value !== null && !(lower !== null && lower > base.value)) out.push('baseline');
  } else {
    const precision = score.precision.value;
    if (precision === null || precision < (gate.minPrecision ?? 0)) out.push('precision');
    const flags = score.actRate.value;
    if (flags === null || flags > (gate.maxFlagRate ?? 1)) out.push('flag-rate');
  }
  return out;
}

function reading(source: DecisionGateReading['source'], at: string | null, cases: number, score: EvidenceScore, kind: DecisionPointDefinition['kind'], gate: DecisionGateInForce): DecisionGateReading {
  return {
    source,
    at,
    cases,
    precision: score.precision,
    baselinePrecision: score.baselinePrecision,
    actRate: score.actRate,
    shortfalls: shortfallsOf(kind, gate, cases, score),
  };
}

/** What a point runs on now: a replay counts only when it ran on the same; the model matters only for Jev, whose version is pinned */
export interface RunsOn {
  provider: DecisionProviderId;
  /** The pinned Jev model; ignored for the CLI */
  model: string | null;
}

/** Whether a stored replay speaks for the questions in force and for who answers them */
export function replayCounts(replay: ReplayEvidence, currentHash: string | null, runsOn: RunsOn | null): boolean {
  if (currentHash === null || replay.questionsHash !== currentHash) return false;
  if (!runsOn) return true;
  return replay.provider === runsOn.provider && (runsOn.provider !== 'jev' || replay.model === runsOn.model);
}

/**
 * A point's standing from its live evidence and its latest replay. The replay only bootstraps: once
 * the live history has the gate's cases it alone decides, so a point that proved itself on stored
 * states and then goes wrong live is `failing` (and can be demoted). Below that the replay may decide,
 * proving it or failing it. `unproven` when no source has the cases. A replay run under other
 * questions than `currentHash`, or on another provider than `runsOn`, is ignored. `decidedBy` names
 * the reading that settled it, null while unproven.
 */
export function standingOf(
  def: Pick<DecisionPointDefinition, 'id' | 'kind' | 'effect' | 'breakEven'>,
  settings: DecisionGateSettings,
  live: DecisionPointEvidence,
  replay: ReplayEvidence | null,
  currentHash: string | null,
  runsOn: RunsOn | null = null,
): DecisionPointStanding {
  const gate = gateInForce(def, settings);
  const liveReading = reading('live', null, live.resolvedDirect, live, def.kind, gate);
  const replayReading = replay && replayCounts(replay, currentHash, runsOn) ? reading('replay', replay.at, replay.cases, replay.score, def.kind, gate) : null;
  const hasCases = (r: DecisionGateReading | null): r is DecisionGateReading => r !== null && !r.shortfalls.includes('cases');
  const decider = hasCases(liveReading) ? liveReading : hasCases(replayReading) ? replayReading : null;
  const standing: DecisionStanding = decider === null ? 'unproven' : decider.shortfalls.length === 0 ? 'proven' : 'failing';
  return { point: def.id, standing, decidedBy: decider?.source ?? null, gate, live: liveReading, replay: replayReading };
}

/** The reading a promotion or a demotion is told by: the one that decided the standing, else the one with more cases */
export function bestReading(standing: DecisionPointStanding): DecisionGateReading {
  const { live, replay } = standing;
  if (standing.decidedBy === 'replay' && replay) return replay;
  if (standing.decidedBy === 'live') return live;
  if (!replay) return live;
  if (replay.shortfalls.length === 0 && live.shortfalls.length > 0) return replay;
  if (live.shortfalls.length === 0) return live;
  return replay.cases > live.cases ? replay : live;
}

/**
 * D3: the share of an active act point's acts that is held out at random, so that what it is judged
 * on is not only what it caused. 10 % of its first 100 acts in the window, 5 % after.
 */
export function holdoutShare(actsInWindow: number): number {
  return actsInWindow < 100 ? 0.1 : 0.05;
}

/**
 * The Supervisor's mode is two things at once: whether it may act on its own hints, which its owner
 * bounds by listing signal kinds (`supervisor.autoSignals`, empty by default), and whether its question
 * to the engine may decline a hint, which the run-time gate holds to standing like any act point. A
 * settings write only sets the first, and under the CLI the point asks the engine nothing, so it could
 * never earn evidence: refusing the write would leave the Supervisor with no way to be switched on.
 */
const WRITE_EXEMPT: ReadonlySet<DecisionPointId> = new Set<DecisionPointId>(['supervisor.intervene']);

/**
 * Whether the engine may move an active point back to shadow by itself. Not the Supervisor's: its
 * Active is its owner's switch for sending hints (above), which a demotion would turn off, while the
 * part that needs evidence (Jev declining a hint) is already held to standing at run time.
 */
export const demotable = (point: DecisionPointId): boolean => !WRITE_EXEMPT.has(point);

export interface ActivationVerdict {
  /** Set when the write must be refused, with the points that make it so */
  refusal: { code: 'decision-unproven' | 'decision-bulk-activation'; points: DecisionActivationIssue[] } | null;
  /** Suggest points the write activates without standing `proven`, which it is allowed to */
  warnings: DecisionActivationIssue[];
  /** Points the write newly activates and the gate lets through */
  activated: DecisionPointId[];
}

export interface ActivationChange {
  def: Pick<DecisionPointDefinition, 'id' | 'kind' | 'effect'>;
  /** The mode in force for the scope before and after the write */
  before: DecisionMode;
  after: DecisionMode;
  standing: DecisionPointStanding;
}

/**
 * D1, and no bulk activation. Only a point the write newly moves to `active` is judged, so a
 * document that already holds active unproven points loads and saves as it is. More than one such
 * point without standing `proven` is refused whatever their kind; one act point (or one suggest
 * point that starts a run) without it is refused; one other suggest point is allowed with a warning.
 */
export function judgeActivation(changes: readonly ActivationChange[]): ActivationVerdict {
  const newly = changes.filter((c) => c.after === 'active' && c.before !== 'active');
  const issue = (c: ActivationChange): DecisionActivationIssue => ({
    point: c.def.id,
    kind: c.def.kind,
    standing: c.standing.standing,
    decidedBy: c.standing.decidedBy,
    live: c.standing.live,
    replay: c.standing.replay,
    gate: c.standing.gate,
  });
  const unproven = newly.filter((c) => c.standing.standing !== 'proven' && !WRITE_EXEMPT.has(c.def.id));
  if (unproven.length > 1) return { refusal: { code: 'decision-bulk-activation', points: unproven.map(issue) }, warnings: [], activated: [] };
  const refused = unproven.filter((c) => gateEnforced(c.def));
  if (refused.length > 0) return { refusal: { code: 'decision-unproven', points: refused.map(issue) }, warnings: [], activated: [] };
  return { refusal: null, warnings: unproven.map(issue), activated: newly.map((c) => c.def.id) };
}

/** The promotion mark of a point a person activates on proven evidence, or that was active when it became proven */
export function promotionOf(standing: DecisionPointStanding, shadowRate: number | null, at: string): DecisionPromotion {
  // The rate of the rows it ran in shadow, when there are enough; else the rate of the evidence that proved it
  return { at, actRate: shadowRate ?? bestReading(standing).actRate.value };
}

/**
 * D2: whether an active point that was promoted goes back to shadow. It does when it has the cases
 * and no longer clears its gate, or when over the last seven days it acted (or flagged) more than
 * twice as often as on the evidence it was promoted on.
 */
export function demotionOf(
  def: Pick<DecisionPointDefinition, 'kind' | 'breakEven'>,
  standing: DecisionPointStanding,
  recent: Pick<DecisionPointEvidence, 'actRate'>,
  promotion: DecisionPromotion | null,
  at: string,
): DecisionDemotion | null {
  const best = bestReading(standing);
  const recentRate = recent.actRate.n >= RATE_MIN_ROWS ? recent.actRate.value : null;
  const promotedRate = promotion?.actRate ?? null;
  const evidence: DecisionDemotion['evidence'] = {
    cases: best.cases,
    precision: best.precision,
    breakEven: def.kind === 'act' ? def.breakEven : null,
    shortfalls: best.shortfalls,
    recentRows: recent.actRate.n,
    recentActs: recent.actRate.hits,
    recentRate,
    promotedRate,
  };
  if (standing.standing === 'failing') return { at, reason: 'failing', evidence };
  // A promoted rate of 0 cannot be doubled into a band: such a point could not have been proven anyway
  if (recentRate !== null && promotedRate !== null && promotedRate > 0 && recentRate > RATE_FACTOR * promotedRate) return { at, reason: 'rate', evidence };
  return null;
}

/** The codes a client translates a demotion by; part of the API, like the health codes */
export const DEMOTION_CODES = { title: 'decisions.demoted.title', failing: 'decisions.demoted.failing', rate: 'decisions.demoted.rate' } as const;

/** The English of a demotion's notification, with the figures a translation needs */
export function demotionText(point: DecisionPointId, demotion: DecisionDemotion): { title: string; titleCode: string; reason: string; reasonCode: string; params: LocalizedParams } {
  const { evidence } = demotion;
  const params: LocalizedParams = {
    point,
    hits: evidence.precision.hits,
    n: evidence.precision.n,
    acts: evidence.recentActs,
    rows: evidence.recentRows,
  };
  const back = "Today's behaviour runs again until you set it to Active.";
  const reason =
    demotion.reason === 'failing'
      ? `Its evidence no longer clears the gate: ${String(evidence.precision.hits)} of ${String(evidence.precision.n)} acting answers were right. ${back}`
      : `In the last 7 days it acted on ${String(evidence.recentActs)} of ${String(evidence.recentRows)} answers, more than twice as often as in Shadow. ${back}`;
  return {
    title: `${point} went back to Shadow`,
    titleCode: DEMOTION_CODES.title,
    reason,
    reasonCode: demotion.reason === 'failing' ? DEMOTION_CODES.failing : DEMOTION_CODES.rate,
    params,
  };
}
