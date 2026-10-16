import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  EVAL_DIR,
  EVAL_LIMITS,
  type EvalCall,
  type EvalCheck,
  type EvalDefinition,
  type EvalGate,
  type EvalJudgedExpectation,
  type EvalJudgement,
  type EvalPressure,
  type EvalRunOutcome,
  type EvalRunRequest,
  type EvalRunSummary,
  type EvalSampleOutcome,
  type EvalVariant,
  type EvalVariantInfo,
  type FlowStage,
  type PermissionMode,
  type RunEvent,
  type TranscriptEntry,
  type ToolPolicy,
} from '@claudio/shared';
import { agentsDefinitionFile } from '../agents-file.js';
import type { ChatRuntime, NewChat, RunMeta, RunResult } from '../chats.js';
import type { CoreConfig } from '../paths.js';
import { cutToBytes, maskSecrets } from '../decisions/redact.js';
import type { ClaudioEventInput } from '../events.js';
import { gitRaw, headCommit, isGitRepo } from '../git.js';
import { rulesFor } from '../tool-policy.js';
import { allToolCalls, type SeenCall } from '../tool-calls.js';
import { runCommand, type CommandHandle, type CommandOutcome } from '../verification.js';
import { sha256, evalTargetPath, type EvalConsents, type EvalDefinitionStore } from './definition.js';
import {
  type Lane,
  LanesError,
  type Overlay,
  createLane,
  ensureLanesRoot,
  lanesRoot,
  removeRunLanes,
  resetLane,
  runDirName,
  startLaneSweep,
} from './lanes.js';
import { computeGate, gateApplies } from './gate.js';
import type { JudgeCalibration, JudgeCall } from './judge.js';
import { foldCalls } from './judge.js';
import { evaluateExpectations } from './matchers.js';
import { sampleEndCheck, sampleOutcomeOf } from './score.js';
import type { EvalStore } from './store.js';

/*
 * The runner of instruction evals (docs/plans/instruction-evals.md, "The runner"): start, queue,
 * sample, usage limit, ceiling, cancel and restart. A sample is a housekeeping chat of the chat
 * manager in a lane; the SQL is the store's, the git is the lanes', the scoring is pure.
 */

/** The part of the chat runtime a sample drives; the tests hand it a fake, the wrapper the real one. */
export interface EvalRuntime {
  start(opts: NewChat, meta?: RunMeta): Pick<ChatRuntime, 'id'>;
  waitForResult(id: string): Promise<RunResult>;
  messages(id: string): TranscriptEntry[] | null;
  events(id: string, sinceSeq?: number): RunEvent[];
  stop(id: string): unknown;
  exited(id: string): Promise<void>;
  remove(id: string): boolean;
  accountOf(id: string): string | null;
}

/** What a team member runs under for a stage, from the flow's `stagePolicy`; the wrapper supplies it. */
export interface MemberRun {
  permissionMode: PermissionMode;
  policy: ToolPolicy;
  model?: string | null;
  effort?: string | null;
}

export type EvalStartErrorCode =
  | 'not-git'
  | 'no-commit'
  | 'pin-missing'
  | 'consent-required'
  | 'cost-not-confirmed'
  | 'ceiling-raised'
  | 'eval-running'
  | 'target-missing'
  | 'user-scope-variant'
  | 'proposed-required'
  | 'proposed-too-large'
  | 'unknown-case'
  | 'no-variants'
  | 'lanes-root-contaminated';

/** Why a start was refused; the API maps `code` to its status (409, 412, 413, 422). */
export class EvalStartError extends Error {
  constructor(
    readonly code: EvalStartErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'EvalStartError';
  }
}

/** The part of the judge the runner drives; `EvalJudge` is one, the tests hand it a script. */
export interface JudgeLike {
  judge(expectation: Pick<EvalJudgedExpectation, 'statement' | 'model'>, input: { calls: JudgeCall[]; final: string | null }, idx: number, signal?: AbortSignal): Promise<EvalJudgement>;
  calibrate(expectation: Pick<EvalJudgedExpectation, 'statement' | 'model' | 'examples'>, signal?: AbortSignal): Promise<JudgeCalibration>;
}

export interface EvalRunnerDeps {
  store: EvalStore;
  runtime: EvalRuntime;
  config: CoreConfig;
  consents: Pick<EvalConsents, 'has'>;
  /** Tells a file Claudio wrote from one a person committed; without it only commands ask for consent */
  definitions?: Pick<EvalDefinitionStore, 'wroteSha'>;
  emit: (event: ClaudioEventInput) => void;
  /** The checkout of an imported project; null when it is not one */
  projectPath: (projectId: string) => string | null;
  /** `runs.defaults.maxConcurrentRuns` */
  maxConcurrentRuns: () => number;
  /** The policy and mode of a team member at a stage; null when `agent` is not one */
  memberRun?: (projectId: string, agent: string, stage: FlowStage) => MemberRun | null;
  /**
   * Whether an account can take a new sample on `model` (`account` pins one). Null when it can; else
   * the earliest reset when it is known. Without it no run ever waits for a limit.
   */
  availability?: (model: string | null, account: string | null) => { waitUntil: number | null } | null;
  /**
   * A judge capped at `maxCostUsd` per judgement (Phase 2). Without it a judged expectation gets no
   * verdict: its sample ends `unjudged`.
   */
  judgeFor?: (maxCostUsd: number) => JudgeLike;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** How long a refused sample waits before it tries again (3 s) */
  retryMs?: number;
  /** How long after a reset a waiting run looks again (5 s) */
  slackMs?: number;
  /** How often a wait with no known reset looks again (5 min) */
  pollMs?: number;
  /** How long a stopped chat gets to end before it is removed regardless (5 s) */
  graceMs?: number;
  /** Replaces the eval's own time limit per sample (the tests' clock) */
  timeoutMs?: number;
  pid?: number;
  /** When this process started, to tell its own rows from those of its earlier life */
  startedAt?: string;
  isAlive?: (pid: number) => boolean;
  runCommand?: (command: string, cwd: string, timeoutMs: number, onStart?: (handle: CommandHandle) => void) => Promise<CommandOutcome>;
}

export interface EvalStartInput {
  projectId: string;
  evalName: string;
  definition: EvalDefinition;
  /** SHA-256 of the file's bytes on disk now */
  sha: string;
  request: EvalRunRequest;
  startedBy?: 'person' | 'desktop';
}

/** What a run may do when its eval says nothing: read anything, edit anything, any command, no network. */
export const DEFAULT_EVAL_POLICY: ToolPolicy = {
  read: { allow: true },
  edit: { allow: 'any' },
  commands: { allow: 'any' },
  network: 'omit',
  gitPush: 'deny',
};

const TRIES = EVAL_LIMITS.maxTries;
const INFRA_STREAK = 3;
const GIT_QUIET = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
const cents = (usd: number): number => Math.round(usd * 100) / 100;

/** The most a run can spend if every sample spends its cap, with the margin. */
export function worstCaseUsd(samples: number, capPerSample: number): number {
  return cents(samples * capPerSample * EVAL_LIMITS.costMargin);
}

/** What a sample may add on top of its own cap: one judge call per judged expectation of its case. */
export function judgeExtraUsd(def: EvalDefinition, cases: readonly EvalDefinition['cases'][number][]): number {
  const most = Math.max(0, ...cases.map((c) => c.expect.filter((e) => e.kind === 'judged').length));
  return most * (def.limits?.maxJudgeCostUsd ?? EVAL_LIMITS.maxJudgeCostUsd.default);
}

/**
 * The ceiling a start shows and must repeat: the worst case of the samples it will queue, held to
 * the eval's own `maxCostUsd` (the dialog may lower that, never raise it).
 */
export function ceilingUsd(
  def: EvalDefinition, request: Pick<EvalRunRequest, 'maxCostUsd'>, cases: number, variants: number, samplesPerCase: number, extraPerSample = 0,
): number {
  const cap = def.limits?.maxCostUsdPerSample ?? EVAL_LIMITS.maxCostUsdPerSample.default;
  const worst = worstCaseUsd(cases * variants * samplesPerCase, cap + extraPerSample);
  const limit = request.maxCostUsd ?? def.limits?.maxCostUsd;
  return limit === undefined ? worst : cents(Math.min(worst, limit));
}

/** Whether another sample's reservation still fits under the ceiling. */
export function fitsCeiling(maxCostUsd: number, spent: number, reserved: number, capPerSample: number): boolean {
  return spent + reserved + capPerSample * EVAL_LIMITS.costMargin <= maxCostUsd + 1e-9;
}

interface VariantPlan {
  info: EvalVariantInfo;
  /** The text the variant runs with; null for `pinned` (read at each sample's pin) and for an absent target */
  text: string | null;
  overlay: Overlay;
  /** The target must not exist in the lane */
  absent: boolean;
}

interface InFlight {
  reserve: number;
  chatId: string | null;
  done: Promise<void>;
}

interface Active {
  id: string;
  projectId: string;
  repo: string;
  evalName: string;
  def: EvalDefinition;
  sha: string;
  account: string | null;
  maxCostUsd: number;
  cap: number;
  /** What one sample reserves: its cap and its judges' */
  reservePerSample: number;
  concurrency: number;
  timeoutMs: number;
  plans: Map<EvalVariant, VariantPlan>;
  /** Project-relative path of the target (project scope only) */
  rel: string | null;
  abort: AbortController;
  free: Lane[];
  lanes: number;
  inflight: Map<string, InFlight>;
  infraStreak: number;
  timer: NodeJS.Timeout | null;
  pumping: boolean;
  again: boolean;
  ending: Promise<void> | null;
  /** Why the abort fired: a person's cancel or the run's own end */
  stopAs: 'cancelled' | 'skipped';
  pinned: Map<string, string | null>;
  judge: JudgeLike | null;
  /** Calibration runs once, before the first sample */
  calibrated: boolean;
}

function toolCallOf(call: SeenCall): EvalCall {
  return {
    seq: call.seq,
    message: call.message,
    toolUseId: call.id,
    name: call.name,
    scope: call.scope,
    outcome: call.outcome,
    input: cutToBytes(maskSecrets(JSON.stringify(call.input)), EVAL_LIMITS.callInputBytes),
    result: call.outcome === 'open' ? null : cutToBytes(maskSecrets(call.result), EVAL_LIMITS.callResultBytes),
    at: call.at ?? null,
  };
}

/** A scored sample passes when every check does; a judge that could not decide leaves it unjudged unless something else already failed it. */
export function outcomeOf(checks: EvalCheck[]): 'passed' | 'failed' | 'unjudged' {
  const failed = checks.some((c) => !c.passed && c.judgement?.status !== 'unjudged');
  if (failed) return 'failed';
  return checks.some((c) => c.judgement?.status === 'unjudged') ? 'unjudged' : sampleOutcomeOf(checks);
}

const maskCall = (c: JudgeCall): JudgeCall => ({ ...c, summary: maskSecrets(c.summary) });

/** A stored call as the judge folds it; its input was stored as masked JSON text. */
function storedCall(call: EvalCall): Pick<SeenCall, 'seq' | 'name' | 'scope' | 'outcome' | 'input'> {
  let input: unknown = call.input;
  try {
    input = JSON.parse(call.input);
  } catch {
    /* cut at the byte limit: the text is what there is */
  }
  return { seq: call.seq, name: call.name, scope: call.scope, outcome: call.outcome, input: input as SeenCall['input'] };
}

/** Paths `git status` lists: modified, added, deleted, untracked (every file, not folders), renames by their new name. */
export function touchedPaths(lane: string): string[] {
  const out = gitRaw(lane, [...GIT_QUIET, 'status', '--porcelain=v1', '-z', '-uall'], { timeout: 60_000 });
  const parts = out.split('\0').filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] ?? '';
    const code = entry.slice(0, 2);
    paths.push(entry.slice(3));
    // A rename or copy is followed by its old name
    if (code.includes('R') || code.includes('C')) i++;
  }
  return paths;
}

export class EvalRunner {
  private readonly active = new Map<string, Active>();
  private readonly pid: number;
  private readonly startedAt: string;
  private readonly now: () => number;
  private readonly root: string;
  private stopSweep: (() => void) | null = null;
  private readonly samples = new Set<string>();

  constructor(private readonly deps: EvalRunnerDeps) {
    this.pid = deps.pid ?? process.pid;
    this.startedAt = deps.startedAt ?? new Date().toISOString();
    this.now = deps.now ?? Date.now;
    this.root = lanesRoot(deps.config.dataDir, deps.env ?? process.env);
  }

  /** Whether a chat is a sample of a live run: what the rotation asks before it moves or replays a chat. */
  isSample(chatId: string): boolean {
    return this.samples.has(chatId);
  }

  // ---------- start ----------

  async start(input: EvalStartInput): Promise<EvalRunSummary> {
    const { deps } = this;
    const { definition: def, request, evalName, projectId } = input;
    const repo = deps.projectPath(projectId);
    if (!repo || !existsSync(repo) || !isGitRepo(repo)) throw new EvalStartError('not-git', 'the project is not a git repository');
    try {
      headCommit(repo);
    } catch {
      throw new EvalStartError('no-commit', 'the repository has no commit yet');
    }
    if (deps.store.liveRun(projectId)) throw new EvalStartError('eval-running', 'this project already has an eval run in progress');

    // Consent: the commands the file runs, and any file Claudio did not write itself
    const hasCommands = !!def.setup || def.cases.some((c) => c.expect.some((e) => e.kind === 'command'));
    const written = deps.definitions?.wroteSha(join(repo, EVAL_DIR, `${evalName}.json`), input.sha) ?? true;
    if ((hasCommands || !written) && !(await deps.consents.has(repo, evalName, input.sha))) {
      throw new EvalStartError('consent-required', 'the eval file has not been accepted: review what it runs first');
    }

    const cases = request.cases ? def.cases.filter((c) => request.cases?.includes(c.id)) : def.cases;
    for (const id of request.cases ?? []) if (!def.cases.some((c) => c.id === id)) throw new EvalStartError('unknown-case', `the eval has no case ${id}`, id);
    if (cases.length === 0 || request.variants.length === 0) throw new EvalStartError('no-variants', 'nothing to run');
    const variants = [...new Set(request.variants)];

    for (const pin of new Set([def.pin, ...cases.map((c) => c.pin ?? def.pin)])) {
      try {
        gitRaw(repo, [...GIT_QUIET, 'cat-file', '-e', `${pin}^{commit}`], { timeout: 10_000 });
      } catch {
        throw new EvalStartError('pin-missing', `the commit ${pin.slice(0, 12)} is not in this repository (shallow clone, collected or rewritten history)`, pin);
      }
    }

    const plans = await this.plansFor(def, repo, variants, request.proposed);

    const samplesPerCase = request.samples ?? def.samples ?? EVAL_LIMITS.samples.default;
    // A level a case has no prompt for is not run for it; `neutral` is every case's prompt
    const levels = new Map(cases.map((c) => [c.id, (request.pressures ?? ['neutral']).filter((p) => p === 'neutral' || c.prompts?.[p] !== undefined)] as const));
    const cells = [...levels.values()].reduce((sum, l) => sum + l.length, 0);
    const extra = judgeExtraUsd(def, cases);
    const ceiling = ceilingUsd(def, request, cells, variants.length, samplesPerCase, extra);
    const limit = def.limits?.maxCostUsd;
    if (request.maxCostUsd !== undefined && limit !== undefined && request.maxCostUsd > limit) {
      throw new EvalStartError('ceiling-raised', `the run's ceiling cannot be raised above the eval's ${limit} USD`);
    }
    if (cents(request.confirmMaxCostUsd) !== ceiling) {
      throw new EvalStartError('cost-not-confirmed', `the start must confirm the ceiling of ${ceiling} USD that was shown`, String(ceiling));
    }

    try {
      ensureLanesRoot(this.root);
    } catch (err) {
      if (err instanceof LanesError && err.code === 'lanes-root-contaminated') throw new EvalStartError('lanes-root-contaminated', err.message, err.path);
      throw err;
    }

    const runId = randomUUID();
    const queue: Array<{ id: string; caseId: string; variant: EvalVariant; pressure: EvalPressure; attempt: number; seq: number; pin: string }> = [];
    let seq = 0;
    for (const c of cases) {
      for (const pressure of levels.get(c.id) ?? []) {
        for (let attempt = 1; attempt <= samplesPerCase; attempt++) {
          for (const variant of variants) queue.push({ id: randomUUID(), caseId: c.id, variant, pressure, attempt, seq: ++seq, pin: c.pin ?? def.pin });
        }
      }
    }
    try {
      deps.store.insertRun(
        {
          id: runId, projectId, evalName, definitionSha: input.sha, definition: def, variants, samplesPerCase,
          account: request.account ?? null, maxCostUsd: ceiling, startedBy: input.startedBy ?? 'person', createdAt: new Date(this.now()).toISOString(),
        },
        variants.map((v) => plans.get(v)?.info).filter((i): i is EvalVariantInfo => !!i),
        queue,
        { pid: this.pid, startedAt: this.startedAt },
      );
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'eval-running') throw new EvalStartError('eval-running', err.message);
      throw err;
    }
    const run: Active = {
      id: runId, projectId, repo, evalName, def, sha: input.sha, account: request.account ?? null, maxCostUsd: ceiling,
      cap: def.limits?.maxCostUsdPerSample ?? EVAL_LIMITS.maxCostUsdPerSample.default,
      concurrency: Math.max(1, Math.min(EVAL_LIMITS.concurrency, deps.maxConcurrentRuns())),
      timeoutMs: deps.timeoutMs ?? (def.limits?.timeoutMinutes ?? EVAL_LIMITS.timeoutMinutes.default) * 60_000,
      plans, rel: this.relativeTarget(def, repo), abort: new AbortController(), free: [], lanes: 0, inflight: new Map(), infraStreak: 0,
      timer: null, pumping: false, again: false, ending: null, stopAs: 'skipped', pinned: new Map(),
      reservePerSample: (def.limits?.maxCostUsdPerSample ?? EVAL_LIMITS.maxCostUsdPerSample.default) + extra,
      judge: extra > 0 ? (deps.judgeFor?.(def.limits?.maxJudgeCostUsd ?? EVAL_LIMITS.maxJudgeCostUsd.default) ?? null) : null,
      calibrated: false,
    };
    this.active.set(runId, run);
    this.emitRun(runId);
    void this.pump(run);
    const summary = deps.store.summary(runId);
    if (!summary) throw new Error('the run was not stored');
    return summary;
  }

  private relativeTarget(def: EvalDefinition, repo: string): string | null {
    if (def.target.scope !== 'project') return null;
    return relative(repo, evalTargetPath(def.target, repo, this.deps.config)).split(sep).join('/');
  }

  /** The three variants of the target as this run will use them; refuses what the plan refuses. */
  private async plansFor(def: EvalDefinition, repo: string, variants: EvalVariant[], proposed: string | undefined): Promise<Map<EvalVariant, VariantPlan>> {
    const abs = evalTargetPath(def.target, repo, this.deps.config);
    const user = def.target.scope === 'user';
    const rel = this.relativeTarget(def, repo);
    const names = def.runAs?.agent ?? (def.target.kind === 'agent' ? def.target.name : null);
    const plans = new Map<EvalVariant, VariantPlan>();
    for (const variant of variants) {
      if (user && variant !== 'current') throw new EvalStartError('user-scope-variant', `a user-scope target runs only as it is: ${variant} would need a copy in the person's config`);
      let text: string | null = null;
      let present = false;
      if (variant === 'pinned') {
        text = rel ? this.showAt(repo, def.pin, rel) : null;
        present = text !== null;
      } else if (variant === 'current') {
        text = await readFile(abs, 'utf8').catch(() => null);
        present = text !== null;
      } else {
        if (proposed === undefined) throw new EvalStartError('proposed-required', 'the proposed variant needs the text to run');
        if (Buffer.byteLength(proposed) > EVAL_LIMITS.fileBytes) throw new EvalStartError('proposed-too-large', 'the proposed text is over 256 KiB');
        text = proposed;
        present = true;
      }
      if (!present && def.target.kind === 'agent' && names === def.target.name) {
        throw new EvalStartError('target-missing', `the agent ${def.target.name} does not exist in the ${variant} variant`, variant);
      }
      const overlay: Overlay = variant !== 'pinned' && !user && rel && text !== null ? { [rel]: text } : {};
      plans.set(variant, {
        info: {
          variant, targetPath: abs, present, contentSha: text === null ? null : sha256(text),
          content: text !== null && Buffer.byteLength(text) <= EVAL_LIMITS.fileBytes ? text : null,
        },
        text: variant === 'pinned' ? null : text,
        overlay,
        absent: variant !== 'pinned' && !user && !present,
      });
    }
    return plans;
  }

  private showAt(repo: string, pin: string, rel: string): string | null {
    try {
      return gitRaw(repo, [...GIT_QUIET, 'show', `${pin}:${rel}`], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    } catch {
      return null;
    }
  }

  // ---------- queue ----------

  /** Starts as many queued samples as the cap, the account and the ceiling allow; ends the run when none is left. */
  private async pump(run: Active): Promise<void> {
    if (run.pumping) {
      run.again = true;
      return;
    }
    run.pumping = true;
    try {
      if (!run.calibrated) {
        run.calibrated = true;
        await this.calibrate(run);
      }
      do {
        run.again = false;
        await this.fill(run);
      } while (run.again);
    } catch (err) {
      await this.finish(run, 'failed', `the runner failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      run.pumping = false;
    }
  }

  private async fill(run: Active): Promise<void> {
    const { store } = this.deps;
    for (;;) {
      if (run.ending || run.abort.signal.aborted) return;
      if (run.inflight.size >= run.concurrency) return;
      const next = store.nextQueued(run.id);
      if (!next) {
        if (run.inflight.size === 0) await this.finish(run, 'completed', null);
        return;
      }
      const blocked = this.deps.availability?.(run.def.runAs?.model ?? null, run.account) ?? null;
      if (blocked) {
        // Samples already running go on; the run waits only when it has nothing in flight to spend
        if (run.inflight.size === 0) this.waitForReset(run, blocked.waitUntil);
        return;
      }
      const summary = store.summary(run.id);
      if (!summary) return;
      const reserved = [...run.inflight.values()].reduce((sum, f) => sum + f.reserve, 0);
      if (!fitsCeiling(run.maxCostUsd, summary.costUsd, reserved, run.reservePerSample)) {
        // In-flight samples are reserved at their cap: what they really cost may make room
        if (run.inflight.size === 0) await this.finish(run, 'capped', 'cap');
        return;
      }
      if (summary.state !== 'running') {
        if (run.timer) clearTimeout(run.timer);
        run.timer = null;
        store.setRunState(run.id, 'running', { startedAt: new Date(this.now()).toISOString() });
        this.emitRun(run.id);
      }
      if (!store.claimSample(next, this.pid, run.concurrency, new Date(this.now()).toISOString())) return;
      const entry: InFlight = { reserve: run.reservePerSample * EVAL_LIMITS.costMargin, chatId: null, done: Promise.resolve() };
      run.inflight.set(next, entry);
      entry.done = this.runSample(run, next, entry)
        .catch((err: unknown) => console.warn(`[evals] sample ${next} failed: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => {
          run.inflight.delete(next);
          void this.pump(run);
        });
    }
  }

  private waitForReset(run: Active, waitUntil: number | null): void {
    const resetsAt = waitUntil !== null ? new Date(waitUntil).toISOString() : null;
    this.deps.store.setRunState(run.id, 'waiting', { resetsAt });
    this.emitRun(run.id);
    if (run.timer) clearTimeout(run.timer);
    const delay = waitUntil !== null ? Math.max(0, waitUntil - this.now()) + (this.deps.slackMs ?? 5_000) : (this.deps.pollMs ?? 300_000);
    run.timer = setTimeout(() => {
      run.timer = null;
      void this.pump(run);
    }, delay);
    run.timer.unref();
  }

  // ---------- a sample ----------

  private async runSample(run: Active, sampleId: string, entry: InFlight): Promise<void> {
    const { store, runtime } = this.deps;
    const sample = store.sample(sampleId);
    if (!sample) return;
    const c = run.def.cases.find((x) => x.id === sample.caseId);
    const plan = run.plans.get(sample.variant);
    if (!c || !plan) {
      this.endSample(run, sampleId, { outcome: 'infra', reason: 'the case or variant is no longer in the run' });
      return;
    }
    this.emitSample(run, sampleId);
    const started = this.now();
    let lane: Lane | null = null;
    let laneOk = true;
    let chatId: string | null = null;
    try {
      // The commands were consented to for this content at the start; a revoked consent stops them here
      const hasCommands = !!run.def.setup || c.expect.some((e) => e.kind === 'command');
      if (hasCommands && !(await this.deps.consents.has(run.repo, run.evalName, run.sha))) {
        this.endSample(run, sampleId, { outcome: 'infra', reason: 'consent-revoked: the eval file is no longer accepted' });
        return;
      }
      try {
        lane = run.free.pop() ?? (await createLane(run.repo, this.root, run.id, ++run.lanes, sample.pin));
        await resetLane(lane, sample.pin, plan.overlay);
        if (plan.absent && run.rel) rmSync(join(lane.path, run.rel), { force: true });
      } catch (err) {
        laneOk = false;
        this.endSample(run, sampleId, { outcome: 'infra', reason: `lane-failed: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }
      if (run.abort.signal.aborted) return void this.endSample(run, sampleId, { outcome: run.stopAs, reason: run.stopAs });

      if (run.def.setup) {
        const setup = await this.command(run, run.def.setup, lane.path, EVAL_LIMITS.commandTimeoutSeconds.default * 1000);
        if (setup.cancelled) return void this.endSample(run, sampleId, { outcome: run.stopAs, reason: run.stopAs });
        if (!setup.ok) {
          this.endSample(run, sampleId, { outcome: 'infra', reason: `setup failed (exit ${setup.exitCode ?? 'none'}): ${maskSecrets(setup.output.slice(-1000))}` });
          return;
        }
      }

      const start = await this.startChat(run, sampleId, (sample.pressure === 'neutral' ? undefined : c.prompts?.[sample.pressure]) ?? c.prompt, lane, sample.variant, plan, sample.pin, c.id);
      if ('refused' in start) {
        // Not a verdict on the target: back in the queue, to try again when a slot is free
        store.requeueSample(sampleId);
        this.emitSample(run, sampleId);
        const timer = setTimeout(() => void this.pump(run), this.deps.retryMs ?? 3_000);
        timer.unref();
        return;
      }
      chatId = start.id;
      entry.chatId = chatId;
      this.samples.add(chatId);
      const init = runtime.events(chatId).find((e) => e.kind === 'init')?.init;
      store.bindChat(sampleId, chatId, { account: runtime.accountOf(chatId), model: init?.model ?? run.def.runAs?.model ?? null, cliVersion: null });

      const outcome = await this.await(run, chatId);
      if (outcome.kind === 'cancelled') {
        this.endSample(run, sampleId, { outcome: run.stopAs, reason: run.stopAs, chatId, costUsd: this.costOf(chatId), durationMs: this.now() - started });
        return;
      }
      const result = outcome.kind === 'result' ? outcome.result : null;
      const model = runtime.events(chatId).find((e) => e.kind === 'init')?.init?.model ?? null;
      const base = { chatId, account: runtime.accountOf(chatId), model, costUsd: result?.costUsd ?? this.costOf(chatId), durationMs: this.now() - started };
      if (result?.cause === 'rate-limit') {
        this.endSample(run, sampleId, { ...base, outcome: 'limit', reason: 'usage limit' });
        if (sample.try < TRIES) store.addTry(sampleId, randomUUID());
        return;
      }
      if (result && (result.cause === 'stopped' || (result.isError && result.cause !== 'budget'))) {
        this.endSample(run, sampleId, { ...base, outcome: 'infra', reason: cutToBytes(maskSecrets(result.result || (result.cause ?? 'the CLI failed')), 1024) });
        return;
      }
      await this.score(run, sampleId, c.expect, lane, plan, base, {
        timedOut: outcome.kind === 'timeout',
        budgetExceeded: result?.cause === 'budget',
        resultText: result?.result ?? null,
        chatId,
      });
    } catch (err) {
      // Whatever broke is the runner's or the environment's, not a verdict on the target
      this.endSample(run, sampleId, { outcome: 'infra', reason: cutToBytes(maskSecrets(err instanceof Error ? err.message : String(err)), 1024), chatId });
    } finally {
      if (chatId) {
        await this.dispose(chatId);
        this.samples.delete(chatId);
      }
      if (lane && laneOk) run.free.push(lane);
      // A failed lane is dropped: the next sample makes a new one, and the run's end removes the directory
    }
  }

  private async command(run: Active, command: string, cwd: string, timeoutMs: number): Promise<CommandOutcome> {
    const runIt = this.deps.runCommand ?? runCommand;
    let handle: CommandHandle | null = null;
    const onAbort = () => handle?.cancel();
    run.abort.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const done = runIt(command, cwd, timeoutMs, (h) => {
        handle = h;
        if (run.abort.signal.aborted) h.cancel();
      });
      return await done;
    } finally {
      run.abort.signal.removeEventListener('abort', onAbort);
    }
  }

  private async startChat(
    run: Active, sampleId: string, prompt: string, lane: Lane, variant: EvalVariant, plan: VariantPlan, pin: string, caseId: string,
  ): Promise<{ id: string } | { refused: true }> {
    const { def } = run;
    const agent = def.runAs?.agent ?? (def.target.kind === 'agent' ? def.target.name : null);
    const member = agent ? (this.deps.memberRun?.(run.projectId, agent, def.runAs?.stage ?? 'work') ?? null) : null;
    const policy = member ? member.policy : (def.policy ?? DEFAULT_EVAL_POLICY);
    const permissionMode: PermissionMode = member ? member.permissionMode : 'dontAsk';
    const rules = rulesFor('claude-code', policy);
    const model = def.runAs?.model ?? member?.model ?? undefined;
    const effort = def.runAs?.effort ?? member?.effort ?? undefined;
    let agentsFile: string | undefined;
    if (agent && def.target.kind === 'agent' && agent === def.target.name) {
      const text = variant === 'pinned' ? this.pinnedText(run, pin) : plan.text;
      if (text !== null) agentsFile = await agentsDefinitionFile(text, agent, model, join(this.deps.config.dataDir, 'eval-agents'));
    }
    const opts: NewChat = {
      prompt,
      name: `eval ${run.evalName}/${caseId}`,
      cwd: lane.path,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(run.account ? { account: run.account } : {}),
      keepAlive: false,
      internal: true,
      api: false,
      uploads: false,
      permissionMode,
      permissionPrompts: 'none',
      allowedTools: rules.allowedTools,
      disallowedTools: rules.disallowedTools,
      ...(rules.tools ? { confine: { tools: rules.tools, settingSources: ['user', 'project', 'local'] as Array<'user' | 'project' | 'local'> } } : {}),
      maxBudgetUsd: run.cap,
      ...(agentsFile && agent ? { agent, agentsFile } : {}),
      systemPromptSnapshot: 'off',
    };
    try {
      return this.deps.runtime.start(opts, { evalSampleId: sampleId });
    } catch (err) {
      if (err instanceof Error && /Concurrent run limit/.test(err.message)) return { refused: true };
      throw err;
    }
  }

  private pinnedText(run: Active, pin: string): string | null {
    if (!run.rel) return null;
    if (!run.pinned.has(pin)) run.pinned.set(pin, this.showAt(run.repo, pin, run.rel));
    return run.pinned.get(pin) ?? null;
  }

  /** Races the result against the sample's clock and the run's abort; stops the chat when either wins. */
  private async await(run: Active, chatId: string): Promise<{ kind: 'result'; result: RunResult } | { kind: 'timeout' } | { kind: 'cancelled' }> {
    const { runtime } = this.deps;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const cut = new Promise<'timeout' | 'cancelled'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), run.timeoutMs);
      onAbort = () => resolve('cancelled');
      if (run.abort.signal.aborted) resolve('cancelled');
      else run.abort.signal.addEventListener('abort', onAbort, { once: true });
    });
    const result = runtime.waitForResult(chatId).then((r) => ({ kind: 'result' as const, result: r }));
    result.catch(() => undefined);
    try {
      const won = await Promise.race([result, cut]);
      if (typeof won !== 'string') return won;
      try {
        runtime.stop(chatId);
      } catch {
        /* already over */
      }
      return won === 'timeout' ? { kind: 'timeout' } : { kind: 'cancelled' };
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) run.abort.signal.removeEventListener('abort', onAbort);
    }
  }

  private costOf(chatId: string): number {
    const last = [...this.deps.runtime.events(chatId)].reverse().find((e) => e.kind === 'result');
    return last?.outcome?.costUsd ?? 0;
  }

  private async score(
    run: Active, sampleId: string, expect: EvalDefinition['cases'][number]['expect'], lane: Lane, plan: VariantPlan,
    base: { chatId: string; account: string | null; model: string | null; costUsd: number; durationMs: number },
    end: { timedOut: boolean; budgetExceeded: boolean; resultText: string | null; chatId: string },
  ): Promise<void> {
    const { runtime } = this.deps;
    const events = runtime.events(end.chatId);
    const outcome = [...events].reverse().find((e) => e.kind === 'result')?.outcome;
    const denied = new Set((outcome?.permissionDenials ?? []).map((d) => d.toolUseId));
    const calls = allToolCalls(runtime.messages(end.chatId) ?? [], denied);
    const laneRoot = realpathSync(lane.path);
    let touched: string[] = [];
    try {
      touched = touchedPaths(lane.path).filter((p) => !this.isOverlay(lane.path, p, plan, run.rel));
    } catch {
      /* a lane git cannot read has nothing to say about what was touched */
    }
    const checks: EvalCheck[] = [sampleEndCheck({ isError: false, budgetExceeded: end.budgetExceeded, timedOut: end.timedOut })];
    const rest = await evaluateExpectations(expect, {
      calls, resultText: end.resultText, laneRoot, touched,
      runCommand: (command, cwd, ms) => this.command(run, command, cwd, ms),
    });
    checks.push(...rest.map((k) => ({ ...k, detail: maskSecrets(k.detail), output: k.output === null ? null : cutToBytes(maskSecrets(k.output), EVAL_LIMITS.checkOutputBytes) })));
    // A judged expectation is decided by the judge, not by the matcher that could only fail it
    const final = end.resultText === null ? null : cutToBytes(maskSecrets(end.resultText), EVAL_LIMITS.resultTextBytes);
    const judged = await this.judgeChecks(run, run.judge, expect, checks, foldCalls(calls).map(maskCall), final);
    if (run.abort.signal.aborted) {
      this.endSample(run, sampleId, { ...base, outcome: run.stopAs, reason: run.stopAs });
      return;
    }
    const stored = calls.slice(0, EVAL_LIMITS.callsPerSample).map(toolCallOf);
    this.deps.store.addCalls(sampleId, stored);
    this.deps.store.addChecks(sampleId, judged.checks);
    if (judged.judgements.length) this.deps.store.putJudgements(sampleId, judged.judgements);
    this.endSample(run, sampleId, {
      ...base,
      outcome: outcomeOf(judged.checks),
      reason: end.timedOut ? 'timeout' : end.budgetExceeded ? 'budget' : null,
      turns: outcome?.turns ?? null,
      durationMs: outcome?.durationMs ?? base.durationMs,
      callsTruncated: calls.length > stored.length,
      resultText: end.resultText === null ? null : cutToBytes(maskSecrets(end.resultText), EVAL_LIMITS.resultTextBytes),
    });
  }

  /**
   * Replaces each judged check with its judge's verdict. `only` limits it to those expectations
   * (a re-judge leaves the verdicts it already has). A judge that fails, or is absent, leaves the
   * check failed with its `unjudged` judgement, which {@link outcomeOf} reads as "no verdict".
   */
  private async judgeChecks(
    run: Pick<Active, 'id' | 'abort'>, judge: JudgeLike | null, expect: EvalDefinition['cases'][number]['expect'], checks: EvalCheck[],
    calls: JudgeCall[], final: string | null, only?: ReadonlySet<number>,
  ): Promise<{ checks: EvalCheck[]; judgements: EvalJudgement[] }> {
    const judgements: EvalJudgement[] = [];
    const out: EvalCheck[] = [];
    for (const check of checks) {
      const e = expect[check.idx];
      if (check.kind !== 'judged' || e?.kind !== 'judged' || (only && !only.has(check.idx))) {
        out.push(check);
        continue;
      }
      const j: EvalJudgement = judge
        ? await judge.judge(e, { calls, final }, check.idx, run.abort.signal)
        : { idx: check.idx, pass: null, reason: 'No judge is available.', evidence: [], costUsd: null, model: e.model ?? null, status: 'unjudged' };
      const verdict = { ...j, reason: maskSecrets(j.reason) };
      if (verdict.costUsd) this.deps.store.addRunCost(run.id, verdict.costUsd);
      judgements.push(verdict);
      out.push({
        ...check, passed: verdict.pass === true, evidenceSeq: verdict.evidence[0] ?? null, judgement: verdict,
        detail: verdict.status === 'judged' ? verdict.reason : `not judged: ${verdict.reason}`,
      });
    }
    return { checks: out, judgements };
  }

  // ---------- judge: calibration, re-judging, gate ----------

  /** Runs the judge on each calibration example once, before the first sample; a disagreeing judge is recorded as unreliable. */
  private async calibrate(run: Active): Promise<void> {
    if (!run.judge) return;
    const used = new Set(this.deps.store.samples(run.id).map((s) => s.caseId));
    const unreliable: Array<{ caseId: string; idx: number }> = [];
    for (const c of run.def.cases) {
      if (!used.has(c.id)) continue;
      for (const [idx, e] of c.expect.entries()) {
        if (e.kind !== 'judged' || !e.examples?.length || run.abort.signal.aborted) continue;
        const result = await run.judge.calibrate(e, run.abort.signal);
        if (result.costUsd) this.deps.store.addRunCost(run.id, result.costUsd);
        if (!result.reliable) unreliable.push({ caseId: c.id, idx });
      }
    }
    if (unreliable.length) this.refreshGate(run.id, unreliable);
  }

  /** Computes the gate from what the store holds now and keeps it; null (and nothing stored) for a run without both sides. */
  private refreshGate(runId: string, unreliable?: Array<{ caseId: string; idx: number }>): EvalGate | null {
    const { store } = this.deps;
    const def = store.definition(runId);
    const summary = store.summary(runId);
    if (!def || !summary) return null;
    const variants = store.variants(runId).map((v) => v.variant);
    if (!gateApplies(variants)) return null;
    const gate = computeGate({
      runId, definition: def, variants, samples: store.samples(runId), account: summary.account,
      unreliableJudges: unreliable ?? store.gate(runId)?.unreliableJudges ?? [],
    });
    store.setGate(runId, gate);
    return gate;
  }

  /** The stored gate; null until the run ended (or began calibrating), and for a run without `current` and `proposed`. */
  gate(runId: string): EvalGate | null {
    return this.deps.store.gate(runId);
  }

  /** The person accepts an unreliable judge as it is: the gate stops waiting for it. */
  acceptJudge(runId: string, caseId: string, idx: number): EvalGate | null {
    const kept = (this.deps.store.gate(runId)?.unreliableJudges ?? []).filter((u) => !(u.caseId === caseId && u.idx === idx));
    return this.refreshGate(runId, kept);
  }

  private readonly rejudging = new Set<string>();

  /**
   * Judges again what a judge could not decide, from the calls the samples stored: no sample runs
   * again. Null when the run does not exist or is already being re-judged.
   */
  async rejudge(runId: string): Promise<{ rejudged: number; unjudged: number } | null> {
    const { store } = this.deps;
    const def = store.definition(runId);
    if (!def || !store.summary(runId) || this.rejudging.has(runId)) return null;
    const judge = this.deps.judgeFor?.(def.limits?.maxJudgeCostUsd ?? EVAL_LIMITS.maxJudgeCostUsd.default) ?? null;
    this.rejudging.add(runId);
    const abort = new AbortController();
    let rejudged = 0;
    try {
      for (const id of store.unjudgedSamples(runId)) {
        const sample = store.sample(id);
        const c = def.cases.find((x) => x.id === sample?.caseId);
        if (!sample || !c) continue;
        const only = new Set(sample.checks.filter((k) => k.kind === 'judged' && k.judgement?.status !== 'judged').map((k) => k.idx));
        const calls = foldCalls(store.calls(id).map(storedCall)).map(maskCall);
        const judged = await this.judgeChecks({ id: runId, abort }, judge, c.expect, sample.checks, calls, sample.resultText, only);
        if (judged.judgements.length === 0) continue;
        store.putJudgements(id, judged.judgements);
        if (store.rescoreSample(id, outcomeOf(judged.checks), judged.checks) && judged.judgements.every((j) => j.status === 'judged')) rejudged++;
      }
    } finally {
      this.rejudging.delete(runId);
    }
    this.refreshGate(runId);
    this.emitRun(runId);
    return { rejudged, unjudged: store.unjudgedSamples(runId).length };
  }

  /** The overlay is the lane's starting point: a path still holding what the overlay wrote was not touched by the agent. */
  private isOverlay(lane: string, path: string, plan: VariantPlan, rel: string | null): boolean {
    if (plan.absent && path === rel) return true;
    const text = plan.overlay[path];
    if (text === undefined) return false;
    try {
      return readFileSync(join(lane, path), 'utf8') === text;
    } catch {
      return false;
    }
  }

  private endSample(
    run: Active, sampleId: string,
    end: { outcome: EvalSampleOutcome; reason?: string | null; chatId?: string | null; account?: string | null; model?: string | null; costUsd?: number | null; durationMs?: number | null; turns?: number | null; callsTruncated?: boolean; resultText?: string | null },
  ): void {
    const ended = this.deps.store.endSample(sampleId, { ...end, endedAt: new Date(this.now()).toISOString() });
    if (!ended) return;
    run.infraStreak = end.outcome === 'infra' ? run.infraStreak + 1 : end.outcome === 'limit' ? run.infraStreak : 0;
    this.emitSample(run, sampleId);
    this.emitRun(run.id);
    if (run.infraStreak >= INFRA_STREAK && !run.ending) {
      void this.finish(run, 'failed', `${INFRA_STREAK} samples in a row could not run: ${end.reason ?? 'infrastructure failure'}`);
    }
  }

  /** Stop, then wait for the process (grace), then remove: the sample is the rows, the chat leaves nothing behind. */
  private async dispose(id: string): Promise<void> {
    const { runtime } = this.deps;
    try {
      runtime.stop(id);
    } catch {
      /* already over */
    }
    let grace: NodeJS.Timeout | undefined;
    await Promise.race([runtime.exited(id), new Promise((r) => (grace = setTimeout(r, this.deps.graceMs ?? 5_000)))]).catch(() => undefined);
    if (grace) clearTimeout(grace);
    runtime.remove(id);
  }

  // ---------- end, cancel ----------

  private finish(run: Active, outcome: EvalRunOutcome, reason: string | null, user = false): Promise<void> {
    if (run.ending) return run.ending;
    run.stopAs = user ? 'cancelled' : 'skipped';
    run.ending = (async () => {
      if (run.timer) clearTimeout(run.timer);
      run.timer = null;
      run.abort.abort();
      for (const f of run.inflight.values()) {
        if (f.chatId) {
          try {
            this.deps.runtime.stop(f.chatId);
          } catch {
            /* already over */
          }
        }
      }
      // Each sample settles into its own row, with the cost it reported, before the run closes
      await Promise.all([...run.inflight.values()].map((f) => f.done));
      await removeRunLanes(run.repo, this.root, run.id).catch((err: unknown) => console.warn(`[evals] lanes of ${run.id} not removed: ${err instanceof Error ? err.message : String(err)}`));
      this.deps.store.endRun(run.id, { outcome, reason, endedAt: new Date(this.now()).toISOString() });
      try {
        this.refreshGate(run.id);
      } catch (err) {
        console.warn(`[evals] gate of ${run.id} not computed: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.active.delete(run.id);
      this.emitRun(run.id);
    })();
    return run.ending;
  }

  /** Aborts the signal, stops the running chats and ends the run `cancelled`. A second call is a no-op. */
  async cancel(runId: string): Promise<EvalRunSummary | null> {
    const run = this.active.get(runId);
    if (run) {
      await this.finish(run, 'cancelled', 'cancelled', true);
    } else {
      const summary = this.deps.store.summary(runId);
      const owner = this.deps.store.liveRuns().find((r) => r.id === runId);
      // A live row nobody here holds belongs to a process that is gone, or to another one: only the first is ours to end
      if (summary && owner && this.ownerGone(owner.ownerPid, owner.ownerStartedAt)) {
        await this.recoverRun(owner.id, owner.projectId, 'cancelled');
      }
    }
    return this.deps.store.summary(runId);
  }

  // ---------- restart ----------

  private ownerGone(pid: number | null, startedAt: string | null): boolean {
    if (pid === null) return true;
    if (pid === this.pid) return startedAt !== this.startedAt;
    return !(this.deps.isAlive ?? defaultAlive)(pid);
  }

  private async recoverRun(runId: string, projectId: string, outcome: 'interrupted' | 'cancelled'): Promise<void> {
    const { store } = this.deps;
    const now = new Date(this.now()).toISOString();
    for (const s of store.runningSamples(runId)) {
      store.endSample(s.id, { outcome: outcome === 'cancelled' ? 'cancelled' : 'interrupted', reason: outcome, chatId: s.chatId, endedAt: now });
    }
    const repo = this.deps.projectPath(projectId);
    if (repo) await removeRunLanes(repo, this.root, runId).catch(() => undefined);
    store.endRun(runId, { outcome, reason: outcome === 'cancelled' ? 'cancelled' : 'the server restarted', endedAt: now });
    this.emitRun(runId);
  }

  /**
   * After the chats are restored: runs whose owner is gone end `interrupted` (their running samples
   * too, unscored), then the lane sweep starts. Rows of another live process are left alone.
   */
  async load(): Promise<void> {
    for (const row of this.deps.store.liveRuns()) {
      if (this.active.has(row.id) || !this.ownerGone(row.ownerPid, row.ownerStartedAt)) continue;
      await this.recoverRun(row.id, row.projectId, 'interrupted');
    }
    this.stopSweep?.();
    this.stopSweep = startLaneSweep(
      this.root,
      (dir) => this.deps.store.liveRuns().some((r) => runDirName(r.id) === dir),
      (err) => console.warn(`[evals] lane sweep failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  /** Stops the sweep and the timers; runs in flight are cancelled so no chat outlives the wrapper. */
  async close(): Promise<void> {
    this.stopSweep?.();
    this.stopSweep = null;
    await Promise.all([...this.active.values()].map((r) => this.finish(r, 'interrupted', 'the server stopped')));
  }

  // ---------- events ----------

  private emitRun(runId: string): void {
    const s = this.deps.store.summary(runId);
    if (!s) return;
    this.deps.emit({
      type: 'eval.run',
      title: `Eval ${s.evalName} ${s.state === 'ended' ? (s.outcome ?? 'ended') : s.state}`,
      runId: s.id, projectId: s.projectId, evalName: s.evalName, state: s.state, outcome: s.outcome, counts: s.counts, costUsd: s.costUsd, resetsAt: s.resetsAt,
    });
  }

  private emitSample(run: Active, sampleId: string): void {
    const s = this.deps.store.sample(sampleId);
    if (!s) return;
    this.deps.emit({
      type: 'eval.sample',
      title: `Eval ${run.evalName}/${s.caseId} ${s.state === 'ended' ? (s.outcome ?? 'ended') : s.state}`,
      runId: run.id, projectId: run.projectId, sampleId, caseId: s.caseId, variant: s.variant, attempt: s.attempt, state: s.state, outcome: s.outcome,
    });
  }
}

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
