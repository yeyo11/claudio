import {
  EVAL_LIMITS,
  EVAL_PRESSURES,
  EVAL_VARIANTS,
  type EvalDefinition,
  type EvalFileListItem,
  type EvalRun,
  type EvalRunRequest,
  type EvalRunSummary,
  type EvalCellMetrics,
  type EvalGate,
  type EvalPressure,
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

/** The proposed text a gate hands to the member's editor, whose Save the person still presses. */
export const saveKey = (projectId: string, agent: string): string => `claudio.evals.save.${projectId}.${agent}`;

export function stashSave(store: Store, projectId: string, agent: string, text: string): boolean {
  try {
    store.setItem(saveKey(projectId, agent), text);
    return true;
  } catch {
    return false;
  }
}

export function peekSave(store: Store, projectId: string, agent: string): string | null {
  try {
    return store.getItem(saveKey(projectId, agent));
  } catch {
    return null;
  }
}

export function clearSave(store: Store, projectId: string, agent: string): void {
  try {
    store.removeItem(saveKey(projectId, agent));
  } catch {
    /* storage unavailable: nothing was kept */
  }
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
  /** Phase 2: the pressure levels to run; `neutral` alone is the Phase 1 run */
  pressures: ReadonlySet<EvalPressure>;
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
    ...(levelsOf(form.pressures).length > 0 && !(form.pressures.size === 1 && form.pressures.has('neutral')) ? { pressures: levelsOf(form.pressures) } : {}),
  };
}

/** The levels of a set, in the order a person reads them. */
export const levelsOf = (set: ReadonlySet<EvalPressure>): EvalPressure[] => EVAL_PRESSURES.filter((p) => set.has(p));

/** The levels the file has prompts for; `neutral` always. Only these can be asked of a run. */
export function levelsAvailable(def: Pick<EvalDefinition, 'cases'>): EvalPressure[] {
  return EVAL_PRESSURES.filter((level) => level === 'neutral' || def.cases.some((c) => (level === 'supportive' ? c.prompts?.supportive : c.prompts?.competing)));
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
    const key = `${sample.caseId}\u0000${sample.variant}\u0000${sample.pressure ?? 'neutral'}\u0000${sample.attempt}`;
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
export function runMatrix(run: Pick<EvalRun, 'definition' | 'variants' | 'samples'>, pressure?: EvalPressure): MatrixRow[] {
  const tries = latestTries(run.samples).filter((sample) => pressure === undefined || (sample.pressure ?? 'neutral') === pressure);
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
    .filter((sample) => sample.caseId === caseId && sample.variant === variant && (sample.pressure ?? 'neutral') === 'neutral')
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

// ---------- Phase 2: metrics, trend, gate ----------

/** Wilson 95 % interval around c / n (the same one the server reads); the whole range with no sample. */
export function wilson(c: number, n: number): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const z2 = 1.96 * 1.96;
  const p = c / n;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const margin = (1.96 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}

/** pass@k, at least one of k passes: 1 − C(n−c, k) / C(n, k). */
export function passAtK(n: number, c: number, k: number): number {
  if (n - c < k) return 1;
  let none = 1;
  for (let i = 0; i < k; i++) none *= (n - c - i) / (n - i);
  return 1 - none;
}

/** pass^k, all k pass: C(c, k) / C(n, k). */
export function passHatK(n: number, c: number, k: number): number {
  if (c < k) return 0;
  let all = 1;
  for (let i = 0; i < k; i++) all *= (c - i) / (n - i);
  return all;
}

/** A rate as a percentage, rounded: "62 %". */
export const percent = (rate: number): string => `${Math.round(rate * 100)} %`;

/**
 * The cells of a run read as metrics: a case, a variant and a pressure level, over the newest try
 * of each attempt. Only passed and failed samples count toward n; a judge that failed is counted apart.
 */
export function runCells(run: Pick<EvalRun, 'definition' | 'samples'>): EvalCellMetrics[] {
  const mustHold = new Set(run.definition.cases.filter((c) => c.mustHold).map((c) => c.id));
  const cells = new Map<string, { caseId: string; variant: EvalVariant; pressure: EvalPressure; outcomes: (EvalSample['outcome'])[] }>();
  for (const sample of latestTries(run.samples)) {
    const pressure = sample.pressure ?? 'neutral';
    const id = `${sample.caseId}\u0000${sample.variant}\u0000${pressure}`;
    const cell = cells.get(id) ?? { caseId: sample.caseId, variant: sample.variant, pressure, outcomes: [] };
    cell.outcomes.push(sample.state === 'ended' ? sample.outcome : null);
    cells.set(id, cell);
  }
  return [...cells.values()].map((cell) => {
    const scored = cell.outcomes.filter((o) => o === 'passed' || o === 'failed');
    const n = scored.length;
    const c = scored.filter((o) => o === 'passed').length;
    const k = Math.min(Math.max(1, Math.floor(run.definition.k ?? EVAL_LIMITS.metricK.default)), n);
    return {
      caseId: cell.caseId,
      variant: cell.variant,
      pressure: cell.pressure,
      n,
      c,
      k,
      passAtK: n === 0 ? null : passAtK(n, c, k),
      passHatK: n === 0 ? null : passHatK(n, c, k),
      interval: wilson(c, n),
      unjudged: cell.outcomes.filter((o) => o === 'unjudged').length,
      mustHold: mustHold.has(cell.caseId),
    };
  });
}

/** Whether the metrics are worth their own section: a version 2 file, another pressure level, or enough samples to read a rate. */
export const showsMetrics = (run: Pick<EvalRun, 'definition' | 'pressures'>): boolean =>
  run.definition.version === 2 || run.pressures.some((p) => p !== 'neutral');

/** The supportive rate minus the competing rate: "how much pressure it takes to break the rule". Null unless both were scored. */
export function pressureDrop(cells: readonly EvalCellMetrics[], caseId: string, variant: EvalVariant): number | null {
  const rate = (pressure: EvalPressure) => {
    const cell = cells.find((x) => x.caseId === caseId && x.variant === variant && x.pressure === pressure);
    return cell && cell.n > 0 ? cell.c / cell.n : null;
  };
  const high = rate('supportive');
  const low = rate('competing');
  return high === null || low === null ? null : high - low;
}

export interface TrendPoint {
  runId: string;
  at: string;
  passed: number;
  of: number;
  rate: number;
  interval: { low: number; high: number };
}

/**
 * The pass-rate trend of an eval: cases with every scored sample passing, over the cases with one,
 * per run, oldest first. It reads the variant asked for, else the one a person most likely cares
 * about. A run that scored nothing is left out rather than drawn as zero.
 */
export function trendPoints(runs: readonly EvalRunSummary[], variant: EvalVariant | 'all'): TrendPoint[] {
  return [...runs]
    .reverse()
    .flatMap((run) => {
      const scored = variant === 'all' ? (run.scored.current ?? run.scored.proposed ?? run.scored.pinned) : run.scored[variant];
      return scored && scored.of > 0 ? [{ runId: run.id, at: run.createdAt, passed: scored.passed, of: scored.of, rate: scored.passed / scored.of, interval: wilson(scored.passed, scored.of) }] : [];
    });
}

/** The proposed text of a run, from its variant info; null when it was not kept (above 256 KiB) or there is none. */
export const proposedTextOf = (run: Pick<EvalRun, 'variantInfo'>): string | null => run.variantInfo.find((v) => v.variant === 'proposed')?.content ?? null;
