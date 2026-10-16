import type { EvalCheck, EvalComparison, EvalSampleOutcome, EvalVariant } from '@claudio/shared';

// Scoring and reports (docs/plans/instruction-evals.md, "Scoring and reports (Phase 1)").

/** Only `passed` and `failed` are scored; the rest say why a sample says nothing about the target. */
export const isScored = (outcome: EvalSampleOutcome | null): outcome is 'passed' | 'failed' => outcome === 'passed' || outcome === 'failed';

/** How a sample ended, before its expectations are looked at. */
export interface SampleEnd {
  /** The result's `is_error` */
  isError: boolean;
  /** `error_max_budget_usd` */
  budgetExceeded?: boolean;
  /** Claudio's own clock ran out */
  timedOut?: boolean;
  /** The CLI's reason, when it gave one */
  detail?: string;
}

/** The check every sample starts with: it must end well. Its `idx` is -1 so it sorts before the expectations. */
export function sampleEndCheck(end: SampleEnd): EvalCheck {
  const failure = end.timedOut ? 'the sample ran past its time limit' : end.budgetExceeded ? 'the sample ran past its budget' : end.isError ? 'the sample ended with an error' : null;
  return {
    idx: -1,
    kind: 'sample',
    passed: failure === null,
    detail: failure ? `${failure}${end.detail ? `: ${end.detail}` : ''}` : 'the sample ended normally',
    evidenceSeq: null,
    output: null,
  };
}

/** A scored sample passes when every check passes. */
export const sampleOutcomeOf = (checks: EvalCheck[]): 'passed' | 'failed' => (checks.every((c) => c.passed) ? 'passed' : 'failed');

export interface Tally {
  passed: number;
  scored: number;
  /** 0 < passed < scored */
  flaky: boolean;
}

/** "n of k passed" over the scored samples of one case and variant. */
export function tally(outcomes: readonly (EvalSampleOutcome | null)[]): Tally {
  const scored = outcomes.filter(isScored);
  const passed = scored.filter((o) => o === 'passed').length;
  return { passed, scored: scored.length, flaky: passed > 0 && passed < scored.length };
}

export interface ScoredSample {
  caseId: string;
  variant: EvalVariant;
  outcome: EvalSampleOutcome | null;
  costUsd?: number | null;
  durationMs?: number | null;
}

/** Per variant: cases with every scored sample passing, out of the cases with at least one scored sample. */
export function scoreRun(samples: readonly ScoredSample[]): Partial<Record<EvalVariant, { passed: number; of: number }>> {
  const byVariant = new Map<EvalVariant, Map<string, EvalSampleOutcome[]>>();
  for (const s of samples) {
    if (!isScored(s.outcome)) continue;
    const cases = byVariant.get(s.variant) ?? new Map<string, EvalSampleOutcome[]>();
    cases.set(s.caseId, [...(cases.get(s.caseId) ?? []), s.outcome]);
    byVariant.set(s.variant, cases);
  }
  const out: Partial<Record<EvalVariant, { passed: number; of: number }>> = {};
  for (const [variant, cases] of byVariant) {
    const all = [...cases.values()];
    out[variant] = { passed: all.filter((o) => o.every((x) => x === 'passed')).length, of: all.length };
  }
  return out;
}

const mean = (values: number[]): number | null => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);

/**
 * Two variants of one run, per case. `regressed` when the base passed k of k and the other passed
 * fewer; `improved` when the reverse holds; `same` otherwise. It states facts and gives no verdict
 * on whether to promote.
 */
export function compareVariants(runId: string, base: EvalVariant, other: EvalVariant, samples: readonly ScoredSample[]): EvalComparison {
  const ids = [...new Set(samples.map((s) => s.caseId))];
  const cases = ids.map((caseId) => {
    const of = (variant: EvalVariant) => tally(samples.filter((s) => s.caseId === caseId && s.variant === variant).map((s) => s.outcome));
    const b = of(base);
    const o = of(other);
    const full = (t: Tally) => t.scored > 0 && t.passed === t.scored;
    const verdict: EvalComparison['cases'][number]['verdict'] = full(b) && o.scored > 0 && !full(o) ? 'regressed' : full(o) && b.scored > 0 && !full(b) ? 'improved' : 'same';
    return { caseId, base: b, other: o, verdict };
  });
  const meanOf = (variant: EvalVariant) => {
    const own = samples.filter((s) => s.variant === variant && isScored(s.outcome));
    return {
      costUsd: mean(own.flatMap((s) => (typeof s.costUsd === 'number' ? [s.costUsd] : []))),
      durationMs: mean(own.flatMap((s) => (typeof s.durationMs === 'number' ? [s.durationMs] : []))),
    };
  };
  return { runId, base, other, cases, mean: { [base]: meanOf(base), [other]: meanOf(other) } };
}
