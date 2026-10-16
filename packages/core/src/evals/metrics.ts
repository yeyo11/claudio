import { EVAL_LIMITS, type EvalCellMetrics, type EvalPressure, type EvalSampleOutcome, type EvalVariant } from '@claudio/shared';
import { isScored } from './score.ts';

// Phase 2 metrics (docs/plans/instruction-evals.md, "Metrics"): one cell is a case, a variant and a
// pressure level, and its n samples are the scored ones. Judge failures (`unjudged`) are not scored.

/** 95 % */
const Z = 1.96;

/**
 * pass@k, the unbiased estimator of "at least one of k passes": 1 − C(n−c, k) / C(n, k). Computed as
 * a product of ratios, so a large n never builds a huge binomial. Needs 1 ≤ k ≤ n.
 */
export function passAtK(n: number, c: number, k: number): number {
  if (n - c < k) return 1;
  let none = 1;
  for (let i = 0; i < k; i++) none *= (n - c - i) / (n - i);
  return 1 - none;
}

/** pass^k, "all k pass": C(c, k) / C(n, k). Needs 1 ≤ k ≤ n. */
export function passHatK(n: number, c: number, k: number): number {
  if (c < k) return 0;
  let all = 1;
  for (let i = 0; i < k; i++) all *= (c - i) / (n - i);
  return all;
}

/** Wilson 95 % interval around c / n; the whole range when there is no sample. */
export function wilsonInterval(c: number, n: number): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const p = c / n;
  const z2 = Z * Z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const margin = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}

interface CellKey {
  caseId: string;
  variant: EvalVariant;
  pressure: EvalPressure;
}

export interface MetricSample extends CellKey {
  outcome: EvalSampleOutcome | null;
}

export interface MetricOptions {
  /** The file's k; default {@link EVAL_LIMITS.metricK} */
  k?: number;
  /** Cases marked `mustHold`, the regression guards the gate reads */
  mustHold?: ReadonlySet<string>;
}

/** One cell's numbers. `k` is clamped to n, and the two rates are null only when no sample was scored. */
export function cellMetrics(key: CellKey, outcomes: readonly (EvalSampleOutcome | null)[], options: MetricOptions = {}): EvalCellMetrics {
  const scored = outcomes.filter(isScored);
  const n = scored.length;
  const c = scored.filter((o) => o === 'passed').length;
  const k = Math.min(Math.max(1, Math.floor(options.k ?? EVAL_LIMITS.metricK.default)), n);
  return {
    ...key,
    n,
    c,
    k,
    passAtK: n === 0 ? null : passAtK(n, c, k),
    passHatK: n === 0 ? null : passHatK(n, c, k),
    interval: wilsonInterval(c, n),
    unjudged: outcomes.filter((o) => o === 'unjudged').length,
    mustHold: options.mustHold?.has(key.caseId) ?? false,
  };
}

/** Every cell of a run, in the order its first sample appeared. */
export function runMetrics(samples: readonly MetricSample[], options: MetricOptions = {}): EvalCellMetrics[] {
  const cells = new Map<string, { key: CellKey; outcomes: (EvalSampleOutcome | null)[] }>();
  for (const s of samples) {
    const id = `${s.caseId}\u0000${s.variant}\u0000${s.pressure}`;
    const cell = cells.get(id) ?? { key: { caseId: s.caseId, variant: s.variant, pressure: s.pressure }, outcomes: [] };
    cell.outcomes.push(s.outcome);
    cells.set(id, cell);
  }
  return [...cells.values()].map((cell) => cellMetrics(cell.key, cell.outcomes, options));
}

/**
 * How much pressure it takes to break a rule: the pass rate at `supportive` minus the one at
 * `competing`, per case and variant. Null when either level has no scored sample.
 */
export function pressureDrop(cells: readonly EvalCellMetrics[], caseId: string, variant: EvalVariant): number | null {
  const rate = (pressure: EvalPressure) => {
    const cell = cells.find((x) => x.caseId === caseId && x.variant === variant && x.pressure === pressure);
    return cell && cell.n > 0 ? cell.c / cell.n : null;
  };
  const high = rate('supportive');
  const low = rate('competing');
  return high === null || low === null ? null : high - low;
}
