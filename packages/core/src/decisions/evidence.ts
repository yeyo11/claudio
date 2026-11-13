import type {
  DecisionBaselineComparison,
  DecisionCalibrationBucket,
  DecisionPointEvidence,
  DecisionPointId,
  DecisionPointStats,
  DecisionRate,
  DecisionStats,
} from '@claudio/shared';
import type { Db, DecisionEvidenceRow } from '../db.ts';
import { decisionPoint } from './points.ts';

/*
 * What a point has proved (docs/plans/decision-engine-v2.md, M2 and M6). One pure scorer reads cases
 * (does the answer act, how sure was it, was acting right, would the code rule have acted) and
 * returns precision with a lower bound, the baseline comparison, calibration buckets and the act
 * rate. Live history rows become cases through `pointEvidence`, which counts only `direct` outcomes
 * and a person's word as truth; a replay over the golden set (`decision_labels`) builds its cases
 * from labels and gets the same structure, so the gate can read either.
 */

/** The z of a one-sided 90 % bound: the gate asks "is it above break-even with 90 % confidence" */
const Z90 = 1.2815515655446004;

/** Confidence buckets. Jev's confidence saturates at 1.00, so exactly 1 is a bucket of its own */
const EDGES = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1] as const;

/** One case to score: a live row with a `direct` outcome, or a labelled state replayed */
export interface EvidenceCase {
  /** Whether the answer is the one that acts (act points) or flags (suggest points) */
  acts: boolean;
  /** The provider's confidence; null for the CLI, which leaves the case out of calibration */
  confidence: number | null;
  /** Whether acting was the right call for this case; null while unknown (an unresolved or `proxy` row) */
  positive: boolean | null;
  /** Whether the code rule acted on the same input; null or absent when there is no baseline to read */
  baselineActs?: boolean | null;
}

/** What the scorer returns: everything of {@link DecisionPointEvidence} that does not need the history's counts */
export type EvidenceScore = Pick<DecisionPointEvidence, 'precision' | 'baselinePrecision' | 'baseline' | 'calibration' | 'actRate'>;

/** A proportion and its one-sided 90 % Wilson lower bound */
export function rate(hits: number, n: number): DecisionRate {
  if (n <= 0) return { n: 0, hits: 0, value: null, lower90: null };
  const p = hits / n;
  const z2 = Z90 * Z90;
  const centre = p + z2 / (2 * n);
  const spread = Z90 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const lower = (centre - spread) / (1 + z2 / n);
  return { n, hits, value: p, lower90: Math.max(0, lower) };
}

const bucketOf = (confidence: number): number => {
  if (confidence >= 1) return EDGES.length - 1;
  for (let i = EDGES.length - 2; i >= 0; i--) if (confidence >= (EDGES[i] ?? 0)) return i;
  return 0;
};

/** Pure: scores cases however they were labelled. Unknown cases count only towards the act rate and the baseline's `unresolved` */
export function scoreEvidence(cases: readonly EvidenceCase[]): EvidenceScore {
  let acting = 0;
  let actingRight = 0;
  let baselineActing = 0;
  let baselineRight = 0;
  let acts = 0;
  const comparison: DecisionBaselineComparison = { rows: 0, differs: 0, decisionRight: 0, baselineRight: 0, unresolved: 0 };
  const buckets = EDGES.map(() => ({ all: 0, allRight: 0, acting: 0, actingRight: 0 }));

  for (const c of cases) {
    if (c.acts) acts += 1;
    const known = c.positive !== null;
    const baselineKnown = c.baselineActs !== undefined && c.baselineActs !== null;
    if (baselineKnown) {
      comparison.rows += 1;
      if (c.acts !== c.baselineActs) {
        comparison.differs += 1;
        if (!known) comparison.unresolved += 1;
        else if (c.acts === c.positive) comparison.decisionRight += 1;
        else comparison.baselineRight += 1;
      }
    }
    if (!known) continue;
    if (c.acts) {
      acting += 1;
      if (c.positive) actingRight += 1;
    }
    if (baselineKnown && c.baselineActs) {
      baselineActing += 1;
      if (c.positive) baselineRight += 1;
    }
    if (c.confidence !== null && Number.isFinite(c.confidence)) {
      const b = buckets[bucketOf(c.confidence)];
      if (b) {
        b.all += 1;
        if (c.acts === c.positive) b.allRight += 1;
        if (c.acts) {
          b.acting += 1;
          if (c.positive) b.actingRight += 1;
        }
      }
    }
  }

  const calibration: DecisionCalibrationBucket[] = buckets.map((b, i) => {
    const last = i === EDGES.length - 1;
    const from = EDGES[i] ?? 1;
    return { from, to: last ? 1 : (EDGES[i + 1] ?? 1), all: rate(b.allRight, b.all), acting: rate(b.actingRight, b.acting) };
  });

  return {
    precision: rate(actingRight, acting),
    baselinePrecision: rate(baselineRight, baselineActing),
    baseline: comparison,
    calibration,
    actRate: rate(acts, cases.length),
  };
}

/** A person's word, or an outcome its resolver called `direct`: the only truth the evidence takes from the history */
export function isDirect(row: Pick<DecisionEvidenceRow, 'feedback' | 'outcome'>): boolean {
  return row.feedback !== null || row.outcome?.quality === 'direct';
}

/**
 * Pure: a point's evidence from its answered history rows, which the caller has already cut to a
 * window. Rows whose answers say nothing about acting (a ranking) are counted but not scored.
 */
export function pointEvidence(point: DecisionPointId, rows: readonly DecisionEvidenceRow[]): DecisionPointEvidence {
  const effect = decisionPoint(point)?.effect;
  let resolvedDirect = 0;
  let resolvedProxy = 0;
  let unresolved = 0;
  const cases: EvidenceCase[] = [];
  for (const row of rows) {
    if (row.point !== point) continue;
    const direct = isDirect(row);
    if (direct) resolvedDirect += 1;
    else if (row.outcome) resolvedProxy += 1;
    else unresolved += 1;
    const acts = effect?.acts(row.answers, row.state) ?? null;
    if (acts === null) continue;
    // `agreed` says whether the answer matched what happened, so acting was right when an acting answer agreed or a holding one did not
    const positive = direct && row.agreed !== null ? (row.agreed ? acts : !acts) : null;
    cases.push({ acts, confidence: row.confidence, positive, baselineActs: effect?.baselineActs(row.baseline) ?? null });
  }
  return { point, answered: resolvedDirect + resolvedProxy + unresolved, resolvedDirect, resolvedProxy, unresolved, ...scoreEvidence(cases) };
}

export interface EvidenceWindow {
  /** ISO start, inclusive */
  since: string;
  /** ISO end, inclusive; absent reads as now */
  until?: string;
}

/** A point's evidence over a window of the stored history */
export function readPointEvidence(db: Pick<Db, 'decisionEvidenceRows'>, point: DecisionPointId, window: EvidenceWindow): DecisionPointEvidence {
  return pointEvidence(point, db.decisionEvidenceRows({ ...window, point }));
}

/** `GET /decisions/stats`: the summed counts, with each point's baseline comparison and evidence beside them */
export function decisionStats(db: Pick<Db, 'decisionStats' | 'decisionEvidenceRows'>, since: string): DecisionStats {
  const counts = db.decisionStats(since);
  const byPoint = new Map<DecisionPointId, DecisionEvidenceRow[]>();
  for (const row of db.decisionEvidenceRows({ since })) {
    const list = byPoint.get(row.point);
    if (list) list.push(row);
    else byPoint.set(row.point, [row]);
  }
  const points: DecisionPointStats[] = counts.points.map((p) => {
    const evidence = pointEvidence(p.point, byPoint.get(p.point) ?? []);
    return { ...p, resolvedDirect: evidence.resolvedDirect, resolvedProxy: evidence.resolvedProxy, baseline: evidence.baseline, evidence };
  });
  return { ...counts, points };
}
