import {
  EVAL_LIMITS,
  type EvalCellMetrics,
  type EvalDefinition,
  type EvalGate,
  type EvalPressure,
  type EvalSample,
  type EvalVariant,
} from '@claudio/shared';
import { runMetrics, wilsonInterval } from './metrics.ts';

// The promotion gate (docs/plans/instruction-evals.md, "Promotion gate"): a verdict on a run with
// `current` and `proposed`. It is pure and writes nothing; "Save proposed" is the person's Save.

export interface GateInput {
  runId: string;
  definition: EvalDefinition;
  variants: readonly EvalVariant[];
  samples: ReadonlyArray<Pick<EvalSample, 'caseId' | 'variant' | 'pressure' | 'outcome'>>;
  /** The run's pinned account; shown on the card, never part of the verdict */
  account?: string | null;
  /** Judged expectations whose judge disagreed with its calibration examples and were not accepted */
  unreliableJudges?: ReadonlyArray<{ caseId: string; idx: number }>;
}

/** Floating point noise in a product of ratios is not a fall */
const EPS = 1e-9;

/** The gate applies only to a run that holds both sides of the comparison. */
export const gateApplies = (variants: readonly EvalVariant[]): boolean => variants.includes('current') && variants.includes('proposed');

const rate = (cell: EvalCellMetrics): number => cell.c / cell.n;

/**
 * - `regressed`: a `mustHold` cell's pass^k fell, or the mean pass rate of `proposed` is under the
 *   interval around `current`'s. A regression found stands whatever else is missing.
 * - `incomplete`: a `mustHold` cell has unjudged samples, no scored sample, or fewer than the gate
 *   minimum; or a judge is unreliable. It fails closed.
 * - `promotable` otherwise.
 * The mean compares cells both variants scored, so a cell one side could not run does not tilt it.
 * Null when the run lacks `current` or `proposed`.
 */
export function computeGate(input: GateInput): EvalGate | null {
  if (!gateApplies(input.variants)) return null;
  const mustHold = new Set(input.definition.cases.filter((c) => c.mustHold).map((c) => c.id));
  const cells = runMetrics(
    input.samples.map((s) => ({ caseId: s.caseId, variant: s.variant, pressure: s.pressure, outcome: s.outcome })),
    { ...(input.definition.k !== undefined ? { k: input.definition.k } : {}), mustHold },
  );
  const cellOf = (caseId: string, variant: EvalVariant, pressure: EvalPressure) =>
    cells.find((x) => x.caseId === caseId && x.variant === variant && x.pressure === pressure);

  const regressed: EvalGate['regressed'] = [];
  const incomplete: EvalGate['incomplete'] = [];
  const seen = new Set<string>();
  for (const cell of cells) {
    if (!cell.mustHold || (cell.variant !== 'current' && cell.variant !== 'proposed')) continue;
    const id = `${cell.caseId}\u0000${cell.pressure}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const current = cellOf(cell.caseId, 'current', cell.pressure);
    const proposed = cellOf(cell.caseId, 'proposed', cell.pressure);
    const part = { caseId: cell.caseId, pressure: cell.pressure };
    if ((current?.unjudged ?? 0) > 0 || (proposed?.unjudged ?? 0) > 0) incomplete.push({ ...part, reason: 'unjudged' });
    if (!current || !proposed || current.n === 0 || proposed.n === 0) {
      incomplete.push({ ...part, reason: 'not-scored' });
      continue;
    }
    if (current.n < EVAL_LIMITS.gateMinSamples || proposed.n < EVAL_LIMITS.gateMinSamples) {
      incomplete.push({ ...part, reason: 'small-n' });
      continue;
    }
    if (current.passHatK !== null && proposed.passHatK !== null && proposed.passHatK < current.passHatK - EPS) {
      regressed.push({ ...part, from: current.passHatK, to: proposed.passHatK });
    }
  }
  for (const u of input.unreliableJudges ?? []) incomplete.push({ caseId: u.caseId, pressure: null, reason: 'judge-unreliable' });

  const paired = cells.flatMap((x) => {
    if (x.variant !== 'current' || x.n === 0) return [];
    const other = cellOf(x.caseId, 'proposed', x.pressure);
    return other && other.n > 0 ? [{ current: x, proposed: other }] : [];
  });
  const mean = (values: number[]): number | null => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);
  const meanRate = {
    current: mean(paired.map((p) => rate(p.current))),
    proposed: mean(paired.map((p) => rate(p.proposed))),
    interval: paired.length === 0 ? null : wilsonInterval(paired.reduce((s, p) => s + p.current.c, 0), paired.reduce((s, p) => s + p.current.n, 0)),
  };
  const fell = meanRate.proposed !== null && meanRate.interval !== null && meanRate.proposed < meanRate.interval.low - EPS;

  return {
    runId: input.runId,
    verdict: regressed.length > 0 || fell ? 'regressed' : incomplete.length > 0 ? 'incomplete' : 'promotable',
    regressed,
    incomplete,
    meanRate,
    unreliableJudges: [...(input.unreliableJudges ?? [])],
    account: input.account ?? null,
    cells,
  };
}
