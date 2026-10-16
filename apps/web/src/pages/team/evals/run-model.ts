import {
  EVAL_LIMITS,
  EVAL_VARIANTS,
  type EvalDefinition,
  type EvalFileListItem,
  type EvalRun,
  type EvalRunRequest,
  type EvalRunSummary,
  type EvalSample,
  type EvalVariant,
} from '@claudio/shared';

/** The pure parts of the start dialog, the run view, the sample and the history. */

// ---------- the text handed over from a member's page ----------

/** The most a handed-over proposal may weigh: the API's own limit for `proposed`. */
export const PROPOSED_MAX_BYTES = 256 * 1024;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const proposedKey = (projectId: string, agent: string): string => `claudio.evals.proposed.${projectId}.${agent}`;

/** Keeps the unsaved text of an agent file for the start dialog; false when it is too large or storage refuses. */
export function stashProposed(store: Store, projectId: string, agent: string, text: string): boolean {
  if (new TextEncoder().encode(text).length > PROPOSED_MAX_BYTES) return false;
  try {
    store.setItem(proposedKey(projectId, agent), text);
    return true;
  } catch {
    return false;
  }
}

export function peekProposed(store: Store, projectId: string, agent: string): string | null {
  try {
    return store.getItem(proposedKey(projectId, agent));
  } catch {
    return null;
  }
}

/** Cleared once the dialog has used it, so a later visit does not offer text the person has since saved or dropped. */
export function clearProposed(store: Store, projectId: string, agent: string): void {
  try {
    store.removeItem(proposedKey(projectId, agent));
  } catch {
    /* storage unavailable: nothing was kept */
  }
}

/** The evals that measure one agent file, for the list a member's page opens. */
export function evalsForAgent(files: readonly EvalFileListItem[], agent: string): EvalFileListItem[] {
  return files.filter((file) => file.definition?.target.kind === 'agent' && file.definition.target.name === agent);
}

// ---------- the start dialog ----------

export interface StartForm {
  variants: ReadonlySet<EvalVariant>;
  /** The text of the proposed variant */
  proposed: string;
  /** Case ids left out of the run */
  skipped: ReadonlySet<string>;
  samples: number | undefined;
  account: string;
}

export type ProposedState = 'empty' | 'same' | 'different';

/** Whether the proposed text says anything new: identical to the current file, it would run the same thing twice. */
export function proposedState(proposed: string, current: string | null): ProposedState {
  if (proposed.trim() === '') return 'empty';
  return current !== null && proposed === current ? 'same' : 'different';
}

/**
 * The request a form makes. `proposed` identical to the current file keeps one variant; a case
 * subset is only sent when something is left out; the ceiling is the one the estimate showed.
 */
export function startRequest(form: StartForm, def: EvalDefinition, current: string | null, confirmMaxCostUsd: number): EvalRunRequest {
  const state = proposedState(form.proposed, current);
  const variants = EVAL_VARIANTS.filter((variant) => form.variants.has(variant) && !(variant === 'proposed' && state !== 'different'));
  const cases = def.cases.map((c) => c.id).filter((id) => !form.skipped.has(id));
  return {
    variants,
    confirmMaxCostUsd,
    ...(variants.includes('proposed') ? { proposed: form.proposed } : {}),
    ...(cases.length < def.cases.length ? { cases } : {}),
    ...(form.samples !== undefined && form.samples !== (def.samples ?? EVAL_LIMITS.samples.default) ? { samples: form.samples } : {}),
    ...(form.account ? { account: form.account } : {}),
  };
}

/** A request without the ceiling, to key an estimate: what the person is yet to confirm is not part of the question. */
export const estimateKey = (request: EvalRunRequest): string => JSON.stringify({ ...request, confirmMaxCostUsd: 0 });

/** A start can go ahead when it has something to run. */
export const canStart = (request: EvalRunRequest): boolean => request.variants.length > 0 && (request.cases === undefined || request.cases.length > 0);

export type RefusalFix = 'editor' | null;

/** The refusals of an estimate or a start that the dialog words itself, each with the fix that is in the person's hands. */
export type RefusalCode =
  | 'pin-missing'
  | 'target-missing'
  | 'not-git'
  | 'no-commit'
  | 'lanes-root-contaminated'
  | 'user-scope-proposal'
  | 'eval-running'
  | 'cost-not-confirmed'
  | 'consent-needed'
  | 'team-off';

const REFUSALS: Record<RefusalCode, RefusalFix> = {
  'pin-missing': 'editor',
  'target-missing': 'editor',
  'not-git': null,
  'no-commit': null,
  'lanes-root-contaminated': null,
  'user-scope-proposal': null,
  'eval-running': null,
  'cost-not-confirmed': null,
  'consent-needed': null,
  'team-off': null,
};

export function refusalOf(code: string | undefined): { code: RefusalCode; fix: RefusalFix } | null {
  return code !== undefined && code in REFUSALS ? { code: code as RefusalCode, fix: REFUSALS[code as RefusalCode] } : null;
}

// ---------- a run ----------

export type RunStage = 'queued' | 'running' | 'waiting' | 'capped' | 'interrupted' | 'cancelled' | 'completed' | 'failed';

/** The one state a run view is in. */
export function runStage(run: Pick<EvalRunSummary, 'state' | 'outcome'>): RunStage {
  if (run.state !== 'ended') return run.state;
  return run.outcome ?? 'completed';
}

export const runLive = (run: Pick<EvalRunSummary, 'state'>): boolean => run.state !== 'ended';
export const runResumable = (run: Pick<EvalRunSummary, 'state' | 'outcome'>): boolean => run.state === 'ended' && (run.outcome === 'capped' || run.outcome === 'interrupted');

/** The newest try of each attempt: an earlier try that hit a usage limit was run again from scratch. */
export function latestTries(samples: readonly EvalSample[]): EvalSample[] {
  const newest = new Map<string, EvalSample>();
  for (const sample of samples) {
    const key = `${sample.caseId}\u0000${sample.variant}\u0000${sample.attempt}`;
    const known = newest.get(key);
    if (!known || sample.try > known.try) newest.set(key, sample);
  }
  return [...newest.values()].sort((a, b) => a.seq - b.seq);
}

export type CellState = 'passed' | 'failed' | 'running' | 'queued' | 'notScored';

export function cellState(sample: Pick<EvalSample, 'state' | 'outcome'>): CellState {
  if (sample.state === 'running') return 'running';
  if (sample.state === 'queued') return 'queued';
  if (sample.outcome === 'passed') return 'passed';
  if (sample.outcome === 'failed') return 'failed';
  return 'notScored';
}

/** Samples by status for the segmented bar: every kind of "not scored" counts as skipped. */
export function runProgress(samples: readonly EvalSample[]): { done: number; failed: number; running: number; pending: number; skipped: number } {
  const counts = { done: 0, failed: 0, running: 0, pending: 0, skipped: 0 };
  for (const sample of latestTries(samples)) {
    const state = cellState(sample);
    if (state === 'passed') counts.done += 1;
    else if (state === 'failed') counts.failed += 1;
    else if (state === 'running') counts.running += 1;
    else if (state === 'queued') counts.pending += 1;
    else counts.skipped += 1;
  }
  return counts;
}

export interface MatrixRow {
  caseId: string;
  title: string;
  /** Per variant, in the run's order: its attempts, by attempt number */
  cells: { variant: EvalVariant; attempts: EvalSample[]; flaky: boolean }[];
}

/** Scored attempts that disagree: the case passes sometimes. */
export function isFlaky(attempts: readonly Pick<EvalSample, 'state' | 'outcome'>[]): boolean {
  const states = new Set(attempts.map(cellState).filter((state) => state === 'passed' || state === 'failed'));
  return states.size === 2;
}

/** A row per case of the file as run, a column per variant of the run. */
export function runMatrix(run: Pick<EvalRun, 'definition' | 'variants' | 'samples'>): MatrixRow[] {
  const tries = latestTries(run.samples);
  return run.definition.cases
    .filter((c) => tries.some((sample) => sample.caseId === c.id))
    .map((c) => ({
      caseId: c.id,
      title: c.title ?? '',
      cells: run.variants.map((variant) => {
        const attempts = tries.filter((sample) => sample.caseId === c.id && sample.variant === variant).sort((a, b) => a.attempt - b.attempt);
        return { variant, attempts, flaky: isFlaky(attempts) };
      }),
    }));
}

/** Samples a capped or interrupted run did not get to. */
export const unrunSamples = (samples: readonly EvalSample[]): number => latestTries(samples).filter((s) => s.state === 'ended' && (s.outcome === 'skipped' || s.outcome === 'interrupted')).length;

const cents = (usd: number): number => Math.round(usd * 100) / 100;

/** The ceiling a resume must repeat: what was spent plus the worst case of what is left, held to the eval's own limit (as the runner computes it). */
export function resumeCeiling(run: Pick<EvalRun, 'costUsd' | 'definition' | 'samples'>): number {
  const cap = run.definition.limits?.maxCostUsdPerSample ?? EVAL_LIMITS.maxCostUsdPerSample.default;
  const worst = cents(run.costUsd + cents(unrunSamples(run.samples) * cap * EVAL_LIMITS.costMargin));
  const limit = run.definition.limits?.maxCostUsd;
  return limit === undefined ? worst : cents(Math.min(worst, limit));
}

// ---------- a sample ----------

/** One line of a call's input as a person reads it: the command, the path or the skill, never the raw JSON. */
export function callSummary(name: string, input: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return input.slice(0, 160);
  }
  if (typeof parsed !== 'object' || parsed === null) return String(parsed).slice(0, 160);
  const fields = parsed as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'skill', 'pattern', 'url', 'description', 'prompt', 'query']) {
    const value = fields[key];
    if (typeof value === 'string' && value) return value.split('\n')[0]?.slice(0, 160) ?? '';
  }
  return name === 'Task' ? '' : input.slice(0, 160);
}

// ---------- the history ----------

export interface RunPairRow {
  caseId: string;
  a: { passed: number; scored: number } | null;
  b: { passed: number; scored: number } | null;
  verdict: 'regressed' | 'improved' | 'same' | null;
}

/** The variant two runs both have, `current` first: the one their numbers can be set side by side on. */
export function sharedVariant(a: { variants: readonly EvalVariant[] }, b: { variants: readonly EvalVariant[] }): EvalVariant | null {
  const shared = EVAL_VARIANTS.filter((variant) => a.variants.includes(variant) && b.variants.includes(variant));
  return shared.includes('current') ? 'current' : (shared[0] ?? null);
}

const score = (run: Pick<EvalRun, 'samples'>, caseId: string, variant: EvalVariant): { passed: number; scored: number } | null => {
  const states = latestTries(run.samples)
    .filter((sample) => sample.caseId === caseId && sample.variant === variant)
    .map(cellState)
    .filter((state) => state === 'passed' || state === 'failed');
  return states.length === 0 ? null : { passed: states.filter((state) => state === 'passed').length, scored: states.length };
};

/** Two runs of an eval, case by case on the variant they share: facts only, `b` being the newer. */
export function compareRuns(a: Pick<EvalRun, 'samples' | 'definition'>, b: Pick<EvalRun, 'samples' | 'definition'>, variant: EvalVariant): RunPairRow[] {
  const ids = [...new Set([...a.definition.cases, ...b.definition.cases].map((c) => c.id))];
  return ids.map((caseId) => {
    const first = score(a, caseId, variant);
    const second = score(b, caseId, variant);
    const rate = (s: { passed: number; scored: number } | null) => (s ? s.passed / s.scored : null);
    const [x, y] = [rate(first), rate(second)];
    const verdict = x === null || y === null ? null : y < x ? 'regressed' : y > x ? 'improved' : 'same';
    return { caseId, a: first, b: second, verdict };
  });
}

/** What makes two runs less comparable than they look. */
export type ComparisonWarning = 'definition' | 'model' | 'cli' | 'account';

export function comparisonWarnings(a: EvalRun, b: EvalRun): ComparisonWarning[] {
  const distinct = (run: EvalRun, pick: (s: EvalSample) => string | null) => [...new Set(run.samples.map(pick).filter(Boolean))].sort().join(',');
  const warnings: ComparisonWarning[] = [];
  if (a.definitionSha !== b.definitionSha) warnings.push('definition');
  if (distinct(a, (s) => s.model) !== distinct(b, (s) => s.model)) warnings.push('model');
  if (distinct(a, (s) => s.cliVersion) !== distinct(b, (s) => s.cliVersion)) warnings.push('cli');
  if ((a.account ?? '') !== (b.account ?? '')) warnings.push('account');
  return warnings;
}
