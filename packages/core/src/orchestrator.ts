import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type {
  ChatActivity,
  ToolPolicy,
  DecisionPointId,
  Health,
  LaunchOrchestrationTemplateRequest,
  Orchestration,
  OrchestrationEngine,
  OrchestrationIntegration,
  OrchestrationPullRequest,
  OrchestrationSpec,
  OrchestrationSummary,
  OrchestrationTaskSpec,
  OrchestrationTaskState,
  OrchestrationTemplate,
  PermissionMode,
  PlanDraftSummary,
  PlanRequest,
  ReviewFinding,
  ReviewGateSpec,
  ReviewGateState,
  RelaunchOrchestrationRequest,
  ResumeOrchestrationRequest,
  SaveOrchestrationTemplateRequest,
  SaveOrchestrationWorkflowRequest,
  VerificationCommand,
  VerificationFix,
  VerificationSpec,
  VerificationState,
  VerifyOrchestrationRequest,
  WorkflowDefinition,
} from '@claudio/shared';
import { EFFORT_LEVELS, errorMessage, isEffort, MODEL_RE, NotFoundError, PERMISSION_MODES, specOfOrchestration, type Effort, type FixStopKind } from '@claudio/shared';
import { effortOption, resolveEffort, usedEffort } from './effort.ts';
import type { WorkflowRun } from './cli-facts.ts';
import type { Db } from './db.ts';
import { OrchestrationEventTracker } from './event-sources.ts';
import type { EventBus } from './events.ts';
import { OrchestrationTemplates } from './orchestration-templates.ts';
import { REVIEW_CHAT_ROLE } from './orchestration-timings.ts';
import { ThrottledLog } from './throttled-log.ts';
import {
  abortMergeAsync,
  addWorktreeAsync,
  branchExists,
  branchExistsAsync,
  branchHeadAsync,
  commitAll,
  commitAllAsync,
  conflictedPaths,
  conflictedPathsAsync,
  containsAsync,
  deleteBranch,
  git,
  headCommit,
  headCommitAsync,
  isGitRepo,
  isIgnored,
  isIgnoredAsync,
  lockWorktreeAsync,
  mergeAsync,
  mergeHeadAsync,
  mergeInProgress,
  mergeInProgressAsync,
  removeWorktree,
  removeWorktreeAsync,
  mainTopLevel,
  mainTopLevelAsync,
  topLevel,
  topLevelAsync,
} from './git.ts';
import type { CoreConfig } from './paths.ts';
import type { ChatManager, ChatRuntime, RunResult } from './chats.ts';
import type { ChatWork } from './chat-service.ts';
import { LEGACY_PROVIDER } from './chat-records.ts';
import { SLOT_RETRY_MS, startWhenAdmitted } from './admission-queue.ts';
import { isTransientRefusal } from './chat-errors.ts';
import { effectiveLimits, elapsedMs, normalizeLimits, pastHardLimit, pastSoftLimit, remainingUsd, spentUsd, startClock, timeWarning } from './task-limits.ts';
import type { TaskContext } from './health-service.ts';
import {
  commitsSince,
  fixerPrompt,
  reviewFixerPrompt,
  REVIEW_DEFAULTS,
  installStep,
  LOCKFILES,
  errorCount,
  failureSignature,
  parseFixerReport,
  normalizeVerification,
  runCommand,
  tail,
  workerChecks,
  E2E_SPECS_TASK_ID,
  e2eSpecsChecks,
  e2eSpecsPrompt,
  DEFAULT_VERIFY_MINUTES,
  MAX_FAILED_SPECS,
  type CommandHandle,
  type InstallStep,
} from './verification.ts';
import { awaitReviewRun, estimateRoundUsd, runReviewRound, type ReviewHost, type RoundOutcome } from './review-gate.ts';
import { collectReviewDiff } from './review-diff.ts';
import { worseAfterFix } from './review-findings.ts';
import { REVIEW_TOOLS } from './review-roles.ts';
import { securityTriggered, type ScanFinding } from './review-scan.ts';
import { ReviewStore, ReviewStoreError } from './review-store.ts';
import { openWaitOf } from './rotation.ts';
import { compileWorkflow, readCompiledResult, workflowName } from './workflow-engine.ts';
import { isSynthesis, journalError, journalRefusal, type JournalRead, type JournalRefusal, type JournalTask } from './workflow-journal.ts';
import { continuationPrompt, delegatesOf, MAX_TOKENS_ERROR, OWES_WORK_ITEM, phraseItems, stoppedOnMaxTokens, structuralItems, tailOf } from './open-items.ts';
import type { DecisionOutcome } from './decisions/engine.ts';
import type { DecisionSubject } from './decisions/points.ts';
import { stanceOf, type DecisionAsker } from './decisions/stance.ts';
import { DELEGATION, designSources, frontend, pasted, PASTED_NOTE, REAL_VERIFICATION, RETRIEVAL, scopeAndCompletion, taskBlock, thinkThrough, timeSignal, UNATTENDED, unpasted, WORKFLOW_LEAD_WAIT } from './prompt-rules.ts';
import { MAX_CONTINUATIONS, type LimitWait, type ProviderMove } from '@claudio/shared';
import { rulesFor } from './tool-policy.ts';
import { GuardEventStore } from './guards/events.ts';
import type { OrchestrationPullRequestService } from './orchestration-pull-requests.ts';
import { parseGuardOverride } from './guards/settings.ts';
import type { GuardRunKind } from './guards/resolve.ts';
import { GuardSelfTestPending, GuardUnavailableError } from './guards/preflight.ts';
import type { GuardLauncher } from './guards/launch.ts';
import type { ChatGuardPlan } from './live-chat.ts';

const ID_RE = /^[\w-]{1,40}$/;
/** How the hint a person sends a worker begins; the lessons' signals recognise it by this */
export const ORCHESTRATION_HINT_PREFIX = 'A hint from the person following this orchestration:';

/** The planner's own name, which is how a past planner run is recognised later. */
export const PLANNER_RUN_NAME = 'orchestration-planner';
// The objective is read back out of the prompt when recovering a draft, so both halves are built
// from these constants: they cannot drift apart.
const PROMPT_HEAD = 'Plan a multi-agent orchestration for this objective:\n\n';
const PROMPT_TAIL = '\n\nSplit it into at most ';
const MAX_DEP_CONTEXT = 6000;
/** The `orchestrationTaskId` of a workflow's lead, the one session that runs every task; `chatRole()` links it with role `workflow` */
const WORKFLOW_LEAD = '__workflow__';
/** Bounds of a person's reason for accepting the gate (D8): enough to say why, not an essay */
const ACCEPT_REASON_MIN = 10;
const ACCEPT_REASON_MAX = 1000;
/** Paths shown to the `review.depth` decision: the first of a diff says what kind of change it is */
const REVIEW_DEPTH_PATHS = 60;
/** The largest delay a timer takes: the review fixer has no clock of its own, as the check fixer has none */
const NO_CLOCK_MS = 2 ** 31 - 1;
/** A failure whose signature survives this many fixer attempts is the same error: more attempts will not help */
const SAME_ERROR_ATTEMPTS = 3;
/** How every worker's prompt, and each message that sends it back to its chat, ends */
const WORKER_CLOSING = 'Finish with a concise report of what you did and found; it is handed to the next workers.';
const DEFAULT_ATTEMPTS = 2;
/** The words a decision's state counts attempts in: Jev is weak at numbers, so code keeps the arithmetic */
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth'];
/** What a decision's state carries of an error or a check's output: the end of it, where it says what failed */
const MAX_DECISION_TEXT = 1500;

/** What each model is for, as a decision reads it; a model outside this list is shown by its id */
const MODEL_LABELS: Readonly<Record<string, string>> = {
  haiku: 'haiku: the cheapest and fastest, for small mechanical work',
  sonnet: 'sonnet: balanced, for most implementation work',
  opus: 'opus: the most capable, for hard design or debugging',
};

/** What the decisions that stand before a task's result say about it; empty is today's behaviour */
interface SettleVerdict {
  /** `orchestration.retry` judged the error permanent: no retry */
  permanent?: boolean;
  /** `run.continuation`'s reading of the last paragraph, in place of the phrase list */
  phrases?: string[];
}
const MAX_ATTEMPTS = 10;
const MAX_ERROR_QUOTE = 2000;
/** How often running tasks are checked against their time limit; the limits are in minutes */
const LIMITS_CHECK_MS = Number(process.env.CLAUDIO_LIMITS_INTERVAL_MS ?? 10_000);
/** A workflow's lead still up this long after its workflow ended is stopped: it has nothing left to report (R15) */
const WORKFLOW_GRACE_MS = 60_000;
/** A running workflow in which nothing grew for this long is stopped, failed and resumable (R15) */
const WORKFLOW_IDLE_MS = 30 * 60_000;
/** The workflow watcher reads the run's record every this many ticks: the stream was seen to miss the end */
const RECORD_EVERY_TICKS = 10;
/** A watchdog bound as a person reads it */
const span = (ms: number): string => (ms >= 60_000 ? `${String(Math.round(ms / 60_000))} min` : `${String(Math.round(ms / 1000))} s`);
const now = () => new Date().toISOString();

const pendingCommand = (command: string, group?: number): VerificationCommand => ({
  command,
  ...(group !== undefined ? { group } : {}),
  status: 'pending',
  output: '',
  durationMs: 0,
  runs: [],
});

/** A spec's checks as the flat rows of its state, each one with the index of the entry it came from. */
const checkRows = (spec: VerificationSpec): VerificationCommand[] =>
  spec.commands.flatMap((entry, group) => (typeof entry === 'string' ? [pendingCommand(entry, group)] : entry.map((c) => pendingCommand(c, group))));

/**
 * The steps the checks run in, as indexes into the state's rows: the install step alone, then each
 * entry of the spec, the commands of one parallel group together. Rows written before groups have
 * none and are a step each.
 */
export function verificationSteps(rows: readonly VerificationCommand[]): number[][] {
  const steps: number[][] = [];
  rows.forEach((row, i) => {
    const last = steps.at(-1);
    const before = last === undefined ? undefined : rows[last[0] as number];
    if (last && before && !row.install && !before.install && row.group !== undefined && row.group === before.group) last.push(i);
    else steps.push([i]);
  });
  return steps;
}

/** What a list serves of a graph: everything but its long texts, which its own page reads. */
export function summarizeOrchestration(orch: Orchestration): OrchestrationSummary {
  const { tasks, finalResult, verification, ...rest } = orch;
  return {
    ...rest,
    tasks: tasks.map(({ prompt: _prompt, result: _result, ...task }) => task),
    hasFinalResult: Boolean(finalResult),
    ...(verification === undefined
      ? {}
      : { verification: verification && { ...verification, commands: verification.commands.map(({ output: _output, ...row }) => row) } }),
  };
}

/** The checks in the order they run, a parallel group as a list, for the fixer to read. */
const commandsInOrder = (rows: readonly VerificationCommand[]): Array<string | string[]> =>
  verificationSteps(rows).map((step) => {
    const commands = step.map((i) => (rows[i] as VerificationCommand).command);
    return commands.length === 1 ? (commands[0] as string) : commands;
  });

/** The head of a worktree, or null when it cannot be read. */
function headOrNull(root: string): string | null {
  try {
    return headCommit(root);
  } catch {
    return null;
  }
}

/**
 * Whether a fix changed what an install reads: a lockfile or a package.json anywhere in the tree.
 * When the diff cannot be read the answer is yes, since installing again is the safe side.
 */
function touchedDependencies(root: string, before: string | null, after: string | null): boolean {
  if (!before || !after) return true;
  if (before === after) return false;
  try {
    const names = new Set<string>(['package.json', ...LOCKFILES.map(([file]) => file)]);
    return git(root, ['diff', '--name-only', '-z', before, after])
      .split('\0')
      .some((path) => names.has(path.split('/').at(-1) ?? ''));
  } catch {
    return true;
  }
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** What a stop reaches while a graph's checks are running. */
interface VerificationControl {
  cancelled: boolean;
  /** Every command running now: the install step alone, or all of a parallel group */
  commands: Set<CommandHandle>;
  fixerRunId: string | null;
  /** The review gate's chats, which a stop reaches */
  reviewRunIds: Set<string>;
  /** Aborted by a stop: the review round stops its runs and ends incomplete */
  abort: AbortController;
}

/** Whether a finished graph has a task that did not get done: failed, stopped, or none completed at all. */
const tasksUndone = (orch: Orchestration): boolean =>
  orch.tasks.some((t) => t.status === 'failed' || t.status === 'stopped') || !orch.tasks.some((t) => t.status === 'completed');

/** Why the graph fails by its checks, when it was launched with `failGraph` and they failed; null otherwise. */
function checksFailGraph(orch: Orchestration): string | null {
  if (!orch.verificationSpec?.failGraph || orch.verification?.status !== 'failed') return null;
  if (orch.verification.gate === 'review') return `The review on the merged branch did not pass: ${orch.verification.report}`;
  return `The checks on the merged branch failed: ${orch.verification.report}`;
}

const attemptsOf = (requested: number | undefined) =>
  Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested as number), 1), MAX_ATTEMPTS) : DEFAULT_ATTEMPTS;

/** Unique per orchestration: two graphs sharing a task id would otherwise collide on one worktree. */
function worktreeName(orch: Orchestration, task: OrchestrationTaskState): string {
  return `${orch.id.slice(0, 8)}-${task.id}`.slice(0, 60);
}

/**
 * Where the CLI keeps the worktree of that name, so a pre-created one is the one it picks up. It
 * resolves them from the repository's top level, not from the directory it is started in.
 */
const worktreePath = (root: string, name: string) => join(root, '.claude', 'worktrees', name);

/** What each of the orchestrator's own runs may do, beside the native rules the person gave the graph */
const NO_PUSH = { network: 'omit', gitPush: 'deny' } as const;
/**
 * `git push` denied, as `--disallowedTools` rules. Telling a worker in its prompt not to push is a
 * request; this is the enforcement, and it holds in every permission mode. Claudio's own code pushes
 * the integration branch for a pull request, so nothing an agent does needs it.
 */
export const PUSH_DENIED: readonly string[] = rulesFor('claude-code', { read: { allow: true }, edit: { allow: 'none' }, commands: { allow: 'none' }, ...NO_PUSH }).disallowedTools;
/** The planner only looks */
const PLANNER_POLICY: ToolPolicy = { read: { allow: true }, edit: { allow: 'none' }, commands: { allow: 'none' }, ...NO_PUSH };
/** Merging is git work; without it the integrator could only describe the conflicts */
const INTEGRATION_POLICY: ToolPolicy = { read: { allow: true }, edit: { allow: 'any' }, commands: { allow: [{ command: 'git', args: 'prefix' }] }, ...NO_PUSH };
/** Building and running tests is the job, so it may run commands; the graph asked for a fixer */
const VERIFICATION_POLICY: ToolPolicy = { read: { allow: true }, edit: { allow: 'any' }, commands: { allow: 'any' }, ...NO_PUSH };
/** Asked for by the person who launched the graph: nothing to confirm again */
const WORKFLOW_POLICY: ToolPolicy = { read: { allow: false }, edit: { allow: 'none' }, commands: { allow: 'none' }, workflow: 'allow', ...NO_PUSH };

/**
 * A graph's repository: the top level of the checkout it runs in, the subdirectory of it the graph
 * works in ('' for the top), and where task worktrees live. The last is the main checkout's top
 * level even when the graph runs from a linked worktree, because that is where the CLI looks.
 */
interface Checkout {
  root: string;
  subdir: string;
  home: string;
}

function checkoutOf(cwd: string): Checkout {
  const root = topLevel(cwd);
  // git answers with the real path, so a symlinked cwd would otherwise look like it is outside
  const subdir = relative(root, realpathSync(cwd));
  // An ignored directory is missing from a fresh worktree, and whatever a worker writes there never
  // reaches its branch: in one of those, working at the top is the only way the work survives.
  return { root, subdir: subdir && !isIgnored(root, subdir) ? subdir : '', home: mainTopLevel(cwd) };
}

/** {@link checkoutOf} without blocking: the integration and a task's worktree are prepared off the event loop. */
async function checkoutOfAsync(cwd: string): Promise<Checkout> {
  const root = await topLevelAsync(cwd);
  const subdir = relative(root, await realpath(cwd));
  return { root, subdir: subdir && !(await isIgnoredAsync(root, subdir)) ? subdir : '', home: await mainTopLevelAsync(cwd) };
}

/**
 * Merges a task's other dependencies into its worktree, in order. A conflict between two of them is
 * the worker's to resolve, as the first thing it does: it has the context to, and starting it on half
 * the code would be worse. The merge is left in progress and what the worker owes is returned.
 */
async function mergeDependencies(path: string, branch: string, deps: readonly string[]): Promise<PendingMerge | null> {
  for (const [i, dep] of deps.entries()) {
    if (await containsAsync(path, dep)) continue;
    const paths = await mergeAsync(path, dep, `Merge ${dep} into ${branch}`);
    if (paths) return { branch: dep, paths, remaining: deps.slice(i + 1) };
  }
  return null;
}

/** The dependency merge a worktree holds in progress, as {@link mergeDependencies} left it; null when none is. */
async function mergeLeftInProgress(root: string, path: string, deps: readonly string[]): Promise<PendingMerge | null> {
  const head = await mergeHeadAsync(path);
  if (!head) return null;
  let merging: string | null = null;
  for (const dep of deps) {
    if ((await branchHeadAsync(root, dep)) === head) {
      merging = dep;
      break;
    }
  }
  const remaining: string[] = [];
  for (const dep of deps) if (dep !== merging && !(await containsAsync(path, dep))) remaining.push(dep);
  // A branch that moved since is named by the commit the merge brings in
  return { branch: merging ?? head, paths: await conflictedPathsAsync(path), remaining };
}

/** `claudio/<name>-<id>`: readable in a branch list, and never shared by two graphs. */
function integrationBranch(orch: Orchestration): string {
  const slug = orch.name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `claudio/${slug || 'orchestration'}-${orch.id.slice(0, 8)}`;
}

/** Worktrees branch from a commit, so an empty repository cannot have any. */
function baseOf(repo: string): string {
  try {
    return headCommit(repo);
  } catch {
    throw new Error(`per-task worktrees need a commit to start from, and ${repo} has none yet`);
  }
}

/** Tasks in an order where every dependency comes before what depends on it. */
function topological(tasks: OrchestrationTaskState[]): OrchestrationTaskState[] {
  const out: OrchestrationTaskState[] = [];
  const seen = new Set<string>();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visit = (t: OrchestrationTaskState) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    for (const dep of t.dependsOn ?? []) {
      const d = byId.get(dep);
      if (d) visit(d);
    }
    out.push(t);
  };
  tasks.forEach(visit);
  return out;
}

/** A merge a worker has to finish before starting its own task. */
interface PendingMerge {
  branch: string;
  paths: string[];
  remaining: string[];
}

/** A task's worktree, ready for the CLI. */
interface PreparedWorktree {
  /** Where the worker is started */
  cwd: string;
  /**
   * Whether the CLI is handed the worktree by name. It always works at a worktree's top, so a
   * graph in a subdirectory starts its worker inside the worktree instead.
   */
  adopt: boolean;
  pendingMerge: PendingMerge | null;
}

/**
 * How the planner should shape a graph. The task phase lasts as long as the longest chain of
 * dependencies, not the sum of the tasks, so these rules shorten that chain; docs/orchestrations.md
 * holds the same guidance, with the reasons, for people writing a graph by hand.
 */
export const PLANNER_GRAPH_GUIDANCE =
  'Shape the graph so it finishes early: the orchestration takes as long as its longest chain of dependencies. ' +
  'Keep the longest chain to four tasks or fewer. ' +
  'Do not add a task that only writes shared types or a contract: put the contract in the prompts of the tasks that need it, ' +
  'or in the first implementation task, so the others can start in parallel against it. ' +
  'A documentation task depends on the implementation tasks, never on a review task, so it runs in parallel with the review. ' +
  'A review task, when there is one, reviews the design and what automated checks cannot see, and does not re-run the whole test suite. ' +
  'A task that only writes prose (documentation) sets model to "sonnet"; leave model out for every other task. ' +
  'Every task prompt names the files, modules or routes it will touch, so its worker does not spend turns finding them. ' +
  'Every task prompt that adds or changes code also names, for each convention its worker must follow (naming, error handling, data access, tests), one real example as `path:line` that you read, or says that the code has none, so the worker copies a pattern instead of inventing one.';

/** Tasks listed in a worker's head, and the longest name shown: the head stays small in a graph of a hundred tasks */
const WORKER_HEAD_TASKS = 30;
const WORKER_HEAD_NAME = 80;

export const PLAN_SCHEMA = {
  type: 'object',
  required: ['name', 'engine', 'engineReason', 'tasks'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', description: 'Short name for the orchestration' },
    engine: {
      type: 'string',
      enum: ['graph', 'workflow'],
      description: 'graph (the default): one process per task, each able to get its own git worktree; workflow: every task a subagent of one session',
    },
    engineReason: { type: 'string', description: 'One sentence on why that engine fits' },
    tasks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'name', 'prompt', 'dependsOn'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'kebab-case unique id' },
          name: { type: 'string' },
          prompt: { type: 'string', description: 'Self-contained instructions for the worker agent' },
          dependsOn: { type: 'array', items: { type: 'string' }, description: 'ids of tasks that must finish first' },
          model: { type: 'string', description: 'Only "sonnet", and only for a task that only writes prose (documentation); leave it out otherwise' },
        },
      },
    },
  },
} as const;

export function validateTasks(tasks: OrchestrationTaskSpec[]): void {
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('at least one task is required');
  const ids = new Set<string>();
  for (const t of tasks) {
    if (!ID_RE.test(t.id ?? '')) throw new Error(`invalid task id '${t.id}' (letters, digits, _ and - only)`);
    if (ids.has(t.id)) throw new Error(`duplicate task id '${t.id}'`);
    if (!t.prompt?.trim()) throw new Error(`task '${t.id}' has an empty prompt`);
    ids.add(t.id);
  }
  for (const t of tasks) {
    for (const dep of t.dependsOn ?? []) {
      if (!ids.has(dep)) throw new Error(`task '${t.id}' depends on unknown task '${dep}'`);
      if (dep === t.id) throw new Error(`task '${t.id}' depends on itself`);
    }
  }
  // Kahn's algorithm: whatever is left over is part of a cycle
  const pending = new Map(tasks.map((t) => [t.id, new Set(t.dependsOn ?? [])]));
  while (pending.size > 0) {
    const ready = [...pending].filter(([, deps]) => deps.size === 0).map(([id]) => id);
    if (ready.length === 0) throw new Error(`dependency cycle between: ${[...pending.keys()].join(', ')}`);
    for (const id of ready) {
      pending.delete(id);
      for (const deps of pending.values()) deps.delete(id);
    }
  }
}

/**
 * `model` and `permissionMode` are never read here: they are handed to `claude` as flags. A value
 * the CLI does not know would first show itself as a worker dying in the middle of a graph, so the
 * spec is held to the same list the chat routes hold a chat to.
 */
export function validateModel(model: string | null | undefined, what = 'model'): void {
  if (model === undefined || model === null) return;
  if (typeof model !== 'string' || !MODEL_RE.test(model)) throw new Error(`${what} must be a model alias or id, such as haiku`);
}

/** An effort the CLI would refuse is refused at launch, not by a worker dying in the middle of a graph. */
export function validateEffort(effort: unknown, what = 'effort'): void {
  if (effort === undefined || effort === null) return;
  if (!isEffort(effort)) throw new Error(`${what} must be one of ${EFFORT_LEVELS.join(', ')}`);
}

export function validatePermissionMode(mode: PermissionMode | undefined): void {
  if (mode === undefined) return;
  if (!PERMISSION_MODES.includes(mode)) throw new Error(`permissionMode must be one of ${PERMISSION_MODES.join(', ')}`);
}

/** The settings of a whole spec, the per-task models included: every one of them becomes a flag. */
export function validateSpecSettings(spec: Pick<OrchestrationSpec, 'model' | 'effort' | 'permissionMode' | 'tasks'>): void {
  validateModel(spec.model);
  validateEffort(spec.effort);
  validatePermissionMode(spec.permissionMode);
  for (const task of spec.tasks ?? []) {
    validateModel(task.model, `task '${task.id}' model`);
    validateEffort(task.effort, `task '${task.id}' effort`);
  }
}

/**
 * Orchestration mode: a DAG of tasks, each executed by its own `claude -p` worker.
 * Independent tasks run in parallel (up to `concurrency`); a task receives the results of
 * its dependencies as context; an optional final worker synthesizes everything.
 */
export class Orchestrator {
  private readonly items = new Map<string, Orchestration>();
  private readonly file: string;
  /**
   * Reads the workflows a session ran from the files beside its transcript, where the CLI records
   * each one's result. Set by Core, which owns the session store.
   */
  workflowRecords: ((sessionId: string) => Promise<WorkflowRun[]>) | null = null;
  /** Workflows the run already had before the current launch, so an old one is not taken for it */
  private readonly workflowBaseline = new Map<string, number>();
  /**
   * Reads a workflow run's journal beside its session's transcript, from line `from` on, with the
   * last message of each agent that failed. Set by Core, which owns the session store.
   */
  workflowJournal: ((sessionId: string, workflowRunId: string, from: number) => Promise<JournalRead | null>) | null = null;
  /** Journal lines a workflow run already had before the current launch: a resume reads only what it adds */
  private readonly journalFrom = new Map<string, number>();
  /** The tasks each workflow graph's journal last named: the stream's progress gives way to it for those */
  private readonly journalTasks = new Map<string, Set<string>>();
  /** Workflow graphs whose journal is being read, so a slow read is not stacked under the next tick */
  private readonly journalReading = new Set<string>();
  /** Workflow graphs being settled, so a slow settle is not started again by the next tick */
  private readonly finishing = new Set<string>();
  /** Each workflow graph's watcher: a launch into the same session after a limit replaces the one before */
  private readonly workflowWatchers = new Map<string, NodeJS.Timeout>();
  /**
   * Hands a workflow's lead to the rotation at a limit one of its agents met: the account is marked,
   * the lead stopped and `limit-hit` announced for it (`ChatManager.limitReached`). False when the
   * rotation cannot take it. Set by Core; none leaves a refused agent a failed task, as any other.
   */
  workflowLimit: ((chatId: string, refusal: JournalRefusal) => boolean) | null = null;
  /**
   * The watchdog's bounds: how long a workflow's lead may outlive its workflow, and how long a running
   * workflow may go with nothing growing (its journal, its agents' transcripts, the stream's progress)
   * before it is stopped. A test shortens them.
   */
  workflowGraceMs = WORKFLOW_GRACE_MS;
  workflowIdleMs = WORKFLOW_IDLE_MS;
  /** Each followed workflow graph's last measure of progress, and when it last changed */
  private readonly workflowGrowth = new Map<string, { sign: string; at: number }>();
  /** What each workflow graph's run directory held at the latest journal read */
  private readonly journalBytes = new Map<string, number>();
  /** When each workflow graph's run was last followed: a record that ended before then is an earlier attempt's */
  private readonly followedAt = new Map<string, number>();
  /** Workflow graphs whose run's record says it ended, though the stream did not */
  private readonly recordEnded = new Set<string>();
  /** Workflow graphs between a launch into their session and the turn that takes it: no watcher yet, and none missing */
  private readonly workflowLaunching = new Set<string>();
  /** Where status changes, task changes and merge conflicts are announced; set by Core */
  bus: EventBus | null = null;
  private readonly tracker = new OrchestrationEventTracker();
  /** Graphs a task result reached after their integration had started, which integrate again */
  private readonly lateArrivals = new Set<string>();
  /** Tasks between the decision to run their chat again and the process that does: they take no hint yet */
  private readonly relaunching = new Set<string>();
  /** Aborted by a stop or a close: the graph's last steps (its integrator, its synthesis) stop waiting for a place */
  private readonly placeWaits = new Map<string, AbortController>();
  /** Each task's running attempt, by `orchestrationId:taskId` (see `stampAttempt`) */
  private readonly attemptStamps = new Map<string, number>();
  private attemptSeq = 0;
  /** Reads a running task's health; set by Core, which owns what health is read from */
  health: ((task: OrchestrationTaskState) => Health | null) | null = null;
  /** Tasks whose worker was told it is nearly out of time, by the clock it was told on, so a retry is warned again */
  private readonly warned = new Set<string>();
  private limitsTimer: NodeJS.Timeout | null = null;
  /** Retries and workflow watchers still to fire: `close` cancels them, since each one reads and writes the database */
  private readonly timers = new Set<NodeJS.Timeout>();
  private closed = false;
  /** Graphs whose checks are running: what a stop has to reach, and what other decisions wait for */
  private readonly verifying = new Map<string, VerificationControl>();
  private reviews: ReviewStore | null = null;
  /** Names this process on the rounds it claims, so a restart frees only its own */
  private readonly processId = randomUUID();
  /** Graphs saved to be launched again on another objective */
  readonly templates: OrchestrationTemplates;
  /** The decision engine the points of docs/plans/decision-engine.md ask; set by Core. Absent, every point is off */
  decisions: DecisionAsker | null = null;
  /** The project a working directory belongs to, which a decision's project override is read for; set by Core */
  projectOf: ((cwd: string) => string | null) | null = null;
  /** Decisions being asked, so a test (and a shutdown) can wait for them */
  private readonly deciding = new Set<Promise<unknown>>();
  /** Opens and follows an integration branch's change request; set by Core, which owns the host service */
  pullRequests: OrchestrationPullRequestService | null = null;
  /** The rotation has the chat's usage limit: it is deciding, waiting for the reset or moving the task; set by Core */
  limitHeld: ((chatId: string) => boolean) | null = null;
  /** The open wait for a limit to reset that a task's chat is in; set by Core */
  waitOf: ((chatId: string) => LimitWait | null) | null = null;
  /** Ends the wait a chat is in, for a task that is stopped; set by Core */
  releaseWait: ((chatId: string) => void) | null = null;
  /**
   * Whether the daily spend cap lets this graph start new work: true below the cap and for a graph
   * that holds today's pass. Only the start of a pending task and of a workflow ask; what is in
   * flight (retries, integration, verification and its fixer, synthesis) never does. Set by Core.
   */
  spendOpen: ((orchestrationId: string) => boolean) | null = null;

  /** Guards the runs that can run commands or write files (docs/plans/guards.md). Set by Core; none leaves every run unguarded. */
  guards: GuardLauncher | null = null;

  constructor(
    private readonly config: CoreConfig,
    private readonly runs: ChatManager,
    private readonly db: Db,
  ) {
    this.file = join(config.dataDir, 'orchestrations.json');
    this.templates = new OrchestrationTemplates(join(config.dataDir, 'orchestration-templates.json'), (spec) => validateTasks(spec.tasks ?? []));
    this.load();
    try {
      this.reviewStore().interruptRunning(now());
    } catch {
      // a database without the review tables is an older one; nothing was running
    }
    this.tracker.baseline(this.list());
    this.runs.on('chat-result', this.onChatResult);
    this.limitsTimer = setInterval(() => this.enforceLimits(), LIMITS_CHECK_MS);
    this.limitsTimer.unref();
  }

  /**
   * Stops every clock of its own: the one that enforces time limits, the retries of launches that
   * were refused and the workflow watchers. The database closes right after, and a retry that fired
   * then would read it (the spend gate) and launch a chat into a wrapper that is shutting down.
   */
  close(): void {
    this.closed = true;
    // The chat manager outlives this orchestrator in a test, and a result heard after the close would write to a closed database
    this.runs.off('chat-result', this.onChatResult);
    if (this.limitsTimer) clearInterval(this.limitsTimer);
    this.limitsTimer = null;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const timer of this.workflowWatchers.values()) clearInterval(timer);
    this.workflowWatchers.clear();
    this.scheduled.clear();
    for (const id of [...this.placeWaits.keys()]) this.endPlaceWaits(id);
  }

  private readonly onChatResult = (runId: string, result: RunResult): void => this.follow(runId, result);

  /** Each graph's pending `scheduleLater`, and when it fires: a graph waits on one timer, not one per refused task */
  private readonly scheduled = new Map<string, { timer: NodeJS.Timeout; at: number }>();

  /** `schedule` later, unless the orchestrator closes first. A graph already due sooner keeps its timer. */
  private scheduleLater(orch: Orchestration, ms: number): void {
    if (this.closed) return;
    const at = Date.now() + ms;
    const pending = this.scheduled.get(orch.id);
    if (pending && pending.at <= at) return;
    if (pending) {
      clearTimeout(pending.timer);
      this.timers.delete(pending.timer);
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.scheduled.delete(orch.id);
      this.schedule(orch);
    }, ms);
    timer.unref();
    this.timers.add(timer);
    this.scheduled.set(orch.id, { timer, at });
  }

  private load(): void {
    this.importLegacy();
    for (const o of this.db.loadOrchestrations()) {
      // Records written before a field existed come back without it; normalise on the way in so
      // the rest of the code never has to ask whether an orchestration is old.
      o.worktree ??= false;
      o.maxAttempts ??= DEFAULT_ATTEMPTS;
      for (const t of o.tasks) t.attempts ??= t.runId ? 1 : 0;
      o.allowedTools ??= [];
      o.permissionPrompts ??= 'none';
      o.integration ??= null;
      o.synthesisRunId ??= null;
      o.engine ??= 'graph';
      o.engineReason ??= null;
      o.workflow ??= null;
      if (o.verification) o.verification.costUsd ??= 0;
      if (o.verification && (o.verification.status === 'running' || o.verification.status === 'pending')) {
        o.verification.status = 'failed';
        o.verification.report = 'Interrupted by a wrapper restart before the checks finished; verify again to run them.';
        for (const c of o.verification.commands) if (c.status === 'running' || c.status === 'pending') c.status = 'pending';
        // The restart is the latest it can have stopped at; without an end the timings would count it up for ever
        if (o.verification.startedAt && !o.verification.endedAt) o.verification.endedAt = now();
        for (const f of o.verification.fixes ?? []) f.endedAt ??= now();
      }
      const gate = o.verification?.review;
      if (o.verification && gate && (gate.status === 'running' || gate.status === 'pending')) {
        const running = gate.status === 'running';
        o.verification.status = 'failed';
        o.verification.gate = running ? 'review' : 'checks';
        gate.status = running ? 'incomplete' : 'skipped';
        gate.phase = null;
        gate.waiting = null;
        gate.endedAt ??= now();
        gate.reason = running ? 'Interrupted by a wrapper restart before the review finished; verify again or retry the review' : 'Interrupted by a wrapper restart before the checks finished';
        if (running) o.verification.report = `The review did not finish: ${gate.reason}.`;
      }
      if (o.integration && ['merging', 'resolving'].includes(o.integration.status)) {
        o.integration.status = 'failed';
        o.integration.error = 'interrupted by a restart; integrate again to finish it';
        if (o.integration.startedAt && !o.integration.endedAt) o.integration.endedAt = now();
      }
      if (o.synthesisStartedAt && !o.synthesisEndedAt) o.synthesisEndedAt = now();
      if (o.status === 'running') this.interrupt(o);
      this.items.set(o.id, o);
    }
  }

  /**
   * Workers do not survive a wrapper restart, but a restart is not a decision to stop: what was
   * running is `interrupted`, at the moment its chat was last heard from and not when the wrapper
   * came back, and `stopped` stays for what a person stopped. A graph with work left stays running,
   * and `recover()` continues it once the chats are back; one that had already finished its tasks
   * (it was integrating or synthesising) and a workflow, which is one session the CLI replays from
   * its cache, wait for `resume()`.
   */
  private interrupt(orch: Orchestration): void {
    // A workflow whose lead waits for a limit to reset was not cut off: the wait outlives the restart,
    // and its end resumes the run from its cache (`replayWorkflow`) or ends the graph (`workflowWaitEnded`)
    if (orch.engine === 'workflow' && orch.workflow?.runId && openWaitOf(this.db, orch.workflow.runId)) return;
    let lastHeard = '';
    for (const task of orch.tasks) {
      if (task.status !== 'running') continue;
      task.status = 'interrupted';
      task.endedAt = (task.runId ? this.db.chatUpdatedAt(task.runId) : null) ?? task.startedAt ?? now();
      if (task.endedAt > lastHeard) lastHeard = task.endedAt;
    }
    const goesOn = orch.engine === 'graph' && !orch.endedAt && orch.tasks.some((t) => t.status === 'pending' || t.status === 'interrupted');
    if (goesOn) return;
    orch.status = 'stopped';
    orch.endedAt ??= lastHeard || (orch.workflow?.runId ? this.db.chatUpdatedAt(orch.workflow.runId) : null) || now();
  }

  /**
   * Puts back to work the graphs a restart cut off. The chats their tasks were working in are
   * restored asynchronously, so this waits for them: a task whose chat is not there yet would start
   * a new conversation instead of continuing its own.
   */
  recover(): void {
    for (const orch of this.items.values()) {
      // A workflow kept running through the restart waits for its limit: watched again, so it is never left unwatched
      if (orch.status === 'running' && orch.engine === 'workflow' && orch.workflow?.runId) this.followWorkflow(orch, orch.workflow.runId);
      if (orch.status !== 'running' || orch.engine !== 'graph') continue;
      // A task that waits for a limit to reset was not cut off: the rotation re-arms the wait and replays
      // its turn, so it stays running rather than go on in a second execution
      for (const t of orch.tasks) {
        if (t.status !== 'interrupted' || !t.runId || !this.waitOf?.(t.runId)) continue;
        t.status = 'running';
        t.endedAt = null;
      }
      this.schedule(orch);
    }
  }

  /**
   * Carries a pre-SQLite `orchestrations.json` into the store once, then renames it away: `.migrated`
   * once carried, `.corrupt` when it could not be read, so what was lost is said and kept to look at.
   */
  private importLegacy(): void {
    if (!existsSync(this.file)) return;
    let carried = true;
    try {
      this.db.saveOrchestrations(JSON.parse(readFileSync(this.file, 'utf8')) as Orchestration[]);
    } catch (err) {
      carried = false;
      console.warn(`orchestrations: ${this.file} could not be carried into the database and was set aside as .corrupt: ${errorMessage(err)}`);
    }
    try {
      renameSync(this.file, `${this.file}.${carried ? 'migrated' : 'corrupt'}`);
    } catch {
      // another process got there first
    }
  }

  /** Every state change ends in a save, so the save is where they are compared and announced. */
  private announce(): void {
    for (const event of this.tracker.observe([...this.items.values()])) this.bus?.emit(event);
  }

  private persist(): void {
    this.announce();
    try {
      this.db.saveOrchestrations([...this.items.values()]);
    } catch (err) {
      // A failed save must not abort the orchestration in flight; after a close it is only the shutdown
      if (!this.closed) this.saveFailures.failed(err);
    }
  }

  private readonly saveFailures = new ThrottledLog('orchestrations: saving the graphs');

  list(): Orchestration[] {
    return [...this.items.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Orchestration | null {
    return this.items.get(id) ?? null;
  }

  /**
   * The orchestration as a client reads it: each running task carries its health and what its
   * worker is doing right now, both facts of this moment and so worked out when it is read, never
   * stored. A copy, so nothing that is persisted grows a field that only means something for a moment.
   */
  view(orch: Orchestration): Orchestration {
    const read = this.health;
    const now = new Map<string, { health: Health | null; activity: ChatActivity | null; waiting?: LimitWait }>();
    for (const task of orch.tasks) {
      if (task.status !== 'running' || !task.runId) continue;
      const waiting = this.waitOf?.(task.runId) ?? null;
      now.set(task.id, { health: read ? read(task) : null, activity: this.runs.get(task.runId)?.activity ?? null, ...(waiting ? { waiting } : {}) });
    }
    // Nothing of this moment to say: the stored graph is already the answer, copies and all
    const pullRequest = this.pullRequests?.newest(orch.id) ?? null;
    const blocks = this.guardBlocks(orch.id);
    if (!pullRequest && !blocks.size && [...now.values()].every((of) => !of.health && !of.activity && !of.waiting)) return orch;
    return {
      ...orch,
      ...(pullRequest ? { pullRequest } : {}),
      tasks: orch.tasks.map((t) => {
        const guardBlocks = blocks.get(t.id);
        return now.has(t.id) || guardBlocks ? { ...t, ...now.get(t.id), ...(guardBlocks ? { guardBlocks } : {}) } : t;
      }),
    };
  }

  /** Blocks per task, read from the audit trail; a table that cannot be read says none */
  private guardBlocks(orchestrationId: string): Map<string, number> {
    try {
      return new GuardEventStore(this.db.connection).countByTask(orchestrationId);
    } catch {
      return new Map();
    }
  }

  /** The graph and task a chat works for, with the limits that apply to it; null for a chat that is not a running task. */
  taskContext(chatId: string, nowMs = Date.now()): TaskContext | null {
    for (const orch of this.items.values()) {
      const task = orch.tasks.find((t) => t.runId === chatId);
      if (!task || task.status !== 'running') continue;
      return { orchestrationId: orch.id, taskId: task.id, taskName: task.name, limits: effectiveLimits(orch.limits, task.limits), elapsedMs: elapsedMs(task, nowMs), spentUsd: spentUsd(task) };
    }
    return null;
  }

  /**
   * Holds running tasks to their time limit. Past most of it the worker is told to wrap up, once;
   * past all of it the task is stopped and fails with the reason, so a person decides what happens
   * to what it did. The clock is a parameter because a limit is a fact of it.
   */
  enforceLimits(nowMs = Date.now()): void {
    this.watchWorkflows();
    let changed = false;
    for (const orch of this.items.values()) {
      if (orch.status !== 'running' || orch.engine !== 'graph') continue;
      for (const task of orch.tasks) {
        if (task.status !== 'running' || !task.runId) continue;
        const limits = effectiveLimits(orch.limits, task.limits);
        if (limits?.maxMinutes === undefined) continue;
        // Waiting for a limit to reset is not working: the clock is given back when the wait ends (`waitEnded`)
        if (this.waitOf?.(task.runId)) continue;
        const elapsed = elapsedMs(task, nowMs);
        if (pastHardLimit(elapsed, limits)) {
          const runId = task.runId;
          task.status = 'failed';
          task.error = `stopped at its time limit of ${String(limits.maxMinutes)} min`;
          task.endedAt = now();
          this.runs.notice(runId, `Claudio stopped this task at its time limit of ${String(limits.maxMinutes)} min.`);
          if (this.runs.get(runId)?.pid) this.runs.stop(runId);
          this.schedule(orch);
          changed = true;
        } else if (pastSoftLimit(elapsed, limits)) {
          const key = this.warnedKey(orch, task);
          if (this.warned.has(key) || !this.runs.get(task.runId)?.pid || this.relaunching.has(`${orch.id}:${task.id}`)) continue;
          this.warned.add(key);
          try {
            this.runs.send(task.runId, `A note from Claudio:\n\n${timeWarning(elapsed, limits)}`);
          } catch {
            // the worker is between two processes: the health signal still tells the person
          }
        }
      }
    }
    // A warning belongs to one clock of one running task: once that task stopped running, or runs on a new clock, it is never asked about again
    if (this.warned.size) {
      const live = new Set<string>();
      for (const orch of this.items.values()) for (const task of orch.tasks) if (task.status === 'running') live.add(this.warnedKey(orch, task));
      for (const key of this.warned) if (!live.has(key)) this.warned.delete(key);
    }
    if (changed) this.persist();
  }

  private warnedKey(orch: Orchestration, task: OrchestrationTaskState): string {
    return `${orch.id}:${task.id}:${task.clockStartedAt ?? task.startedAt ?? ''}`;
  }

  runningCount(): number {
    return this.list().filter((o) => o.status === 'running').length;
  }

  create(spec: OrchestrationSpec, origin: { relaunchedFrom?: string; templateId?: string } = {}): Orchestration {
    validateTasks(spec.tasks);
    validateSpecSettings(spec);
    const root = resolve(spec.cwd ?? this.config.workspaceDir);
    // Fail here rather than per task: half a graph isolated and half of it not is worse than
    // refusing outright.
    const engine: OrchestrationEngine = spec.engine === 'workflow' ? 'workflow' : 'graph';
    if (engine === 'workflow' && spec.worktree === true) {
      throw new Error('a workflow runs every task in the project directory; use the graph engine for per-task worktrees');
    }
    if (spec.worktree === true && !isGitRepo(root)) {
      throw new Error(`per-task worktrees need a git repository, and ${root} is not one`);
    }
    const limits = normalizeLimits(spec.limits, 'limits');
    const taskLimits = spec.tasks.map((t) => normalizeLimits(t.limits, `task '${t.id}' limits`));
    // A workflow runs every task as a subagent of one session: there is no worker of its own to stop
    // at a time or to hold to a budget, and a limit that is silently not kept is worse than none
    if (engine === 'workflow' && (limits || taskLimits.some(Boolean))) {
      throw new Error('limits apply to the graph engine, where each task is a worker of its own; a workflow runs its tasks inside one session');
    }
    const verification = normalizeVerification(spec.verification);
    // The checks run on the integration branch, which only a graph with a worktree per task has
    if (verification && (engine === 'workflow' || spec.worktree !== true)) {
      throw new Error('verification runs on the integration branch, which needs the graph engine with a worktree per task');
    }
    const orch: Orchestration = {
      id: randomUUID(),
      name: spec.name?.trim() || 'orchestration',
      objective: spec.objective?.trim() || null,
      status: 'running',
      cwd: root,
      model: spec.model ?? null,
      effort: spec.effort ?? null,
      permissionMode: spec.permissionMode ?? this.runs.defaults.defaultPermissionMode,
      concurrency: Math.min(Math.max(spec.concurrency ?? 3, 1), this.runs.defaults.maxConcurrentRuns),
      synthesize: spec.synthesize ?? false,
      worktree: spec.worktree === true,
      maxAttempts: attemptsOf(spec.maxAttempts),
      allowedTools: (spec.allowedTools ?? []).map(String).filter(Boolean),
      permissionPrompts: spec.permissionPrompts === 'host' ? 'host' : 'none',
      ...(spec.guards !== undefined ? { guards: parseGuardOverride(spec.guards) } : {}),
      createdAt: now(),
      endedAt: null,
      finalResult: null,
      costUsd: 0,
      // Every worktree starts here, so work that lands on the checkout meanwhile does not leak in
      baseCommit: spec.worktree === true ? baseOf(root) : null,
      integration: null,
      synthesisRunId: null,
      engine,
      engineReason: spec.engineReason?.trim() || null,
      workflow: null,
      limits: limits ?? null,
      verificationSpec: verification,
      verification: null,
      relaunchedFrom: origin.relaunchedFrom ?? null,
      templateId: origin.templateId ?? null,
      // Only a launch from a planner's draft names it; a relaunch or a template never does
      plannerRunId: origin.relaunchedFrom || origin.templateId ? null : (spec.plannerRunId ?? null),
      tasks: spec.tasks.map<OrchestrationTaskState>((t, i) => ({
        ...(taskLimits[i] ? { limits: taskLimits[i] } : {}),
        id: t.id,
        name: t.name?.trim() || t.id,
        prompt: t.prompt,
        dependsOn: t.dependsOn ?? [],
        cwd: t.cwd,
        model: t.model,
        // A workflow's tasks are subagents of one session: only the graph's own effort applies there
        ...(t.effort && engine === 'graph' ? { effort: t.effort } : {}),
        // Kept on the node so a relaunch carries it: the link to the item is made from it
        ...(t.workItemId ? { workItemId: t.workItemId } : {}),
        status: 'pending',
        attempts: 0,
        runId: null,
        sessionId: null,
        result: null,
        error: null,
        startedAt: null,
        endedAt: null,
        costUsd: 0,
      })),
    };
    // The owner's answer to the plan's open question 1 (CW-15): workers run no browser spec, and one
    // task that depends on every other one runs the specs their combined work touches, before the
    // merge. Only where a verification phase exists, and not twice when the graph already names one
    if (verification && verification.e2eSpecs !== false && orch.tasks.length > 0 && !orch.tasks.some((t) => t.id === E2E_SPECS_TASK_ID)) {
      orch.tasks.push({
        id: E2E_SPECS_TASK_ID,
        name: 'Browser specs the changes touch',
        prompt: e2eSpecsPrompt(orch.baseCommit ?? null),
        dependsOn: orch.tasks.map((t) => t.id),
        builtIn: 'e2e-specs',
        status: 'pending',
        attempts: 0,
        runId: null,
        sessionId: null,
        result: null,
        error: null,
        startedAt: null,
        endedAt: null,
        costUsd: 0,
      });
    }
    this.items.set(orch.id, orch);
    if (engine === 'workflow') this.launchWorkflow(orch, null);
    else this.schedule(orch);
    return orch;
  }

  /**
   * The daily cap opened (raised, off, a new day) or a graph got its pass: starts what waited for
   * it, in every running graph.
   */
  spendChanged(): void {
    for (const orch of this.items.values()) {
      if (orch.status !== 'running') continue;
      if (orch.engine === 'workflow') {
        if (!orch.workflow?.runId) this.launchWorkflow(orch, null);
      } else this.schedule(orch);
    }
  }

  /** Lets a graph start new work past today's cap; kept in its document, for the local day it names. */
  grantSpendPass(id: string, day: string): Orchestration {
    const orch = this.items.get(id);
    if (!orch) throw new NotFoundError('orchestration not found');
    orch.spendPass = day;
    this.persist();
    return orch;
  }

  /** The day a graph was let past the cap; null when it was not. */
  spendPassOf(id: string): string | null {
    return this.items.get(id)?.spendPass ?? null;
  }

  /** Tasks ready to start that only the cap holds back: what the graph's wait line counts. */
  waitingForSpend(): number {
    if (!this.spendOpen) return 0;
    let n = 0;
    for (const orch of this.items.values()) {
      if (orch.status !== 'running' || this.spendOpen(orch.id)) continue;
      if (orch.engine === 'workflow') {
        if (!orch.workflow?.runId) n += orch.tasks.filter((t) => t.status === 'pending').length;
        continue;
      }
      const byId = new Map(orch.tasks.map((t) => [t.id, t]));
      n += orch.tasks.filter((t) => t.status === 'pending' && !t.runId && (t.dependsOn ?? []).every((d) => byId.get(d)?.status === 'completed')).length;
    }
    return n;
  }

  stop(id: string): Orchestration {
    const orch = this.items.get(id);
    if (!orch) throw new NotFoundError('orchestration not found');
    // Checks started by hand run on a graph that is already over, and stopping it has to reach them; so does an integration retried by hand
    this.cancelChecks(orch.id);
    this.endPlaceWaits(orch.id);
    if (orch.status !== 'running' && orch.status !== 'waiting') return orch;
    orch.status = 'stopped';
    orch.endedAt = now();
    // One process runs every task of a workflow, and a lead held at a limit waits for nobody now
    if (orch.workflow?.runId) {
      if (orch.engine === 'workflow') this.releaseWait?.(orch.workflow.runId);
      if (this.runs.get(orch.workflow.runId)?.pid) this.runs.stop(orch.workflow.runId);
    }
    for (const t of orch.tasks) {
      if (t.status === 'running' && t.runId && orch.engine !== 'workflow') {
        this.releaseWait?.(t.runId);
        this.runs.stop(t.runId);
      }
      if (t.status === 'pending' || t.status === 'running' || t.status === 'blocked' || t.status === 'interrupted') t.status = 'stopped';
    }
    // The last steps run agents too, and stopping the graph has to stop them
    for (const runId of [orch.integration?.integratorRunId, orch.synthesisRunId]) {
      if (runId && this.runs.get(runId)) this.runs.stop(runId);
    }
    if (orch.integration && ['merging', 'resolving'].includes(orch.integration.status)) {
      orch.integration.status = 'failed';
      orch.integration.error = 'stopped';
    }
    this.persist();
    return orch;
  }

  /**
   * Relaunches a graph that is no longer running. Workers do not survive a wrapper restart, and
   * until now that left the whole orchestration dead with no way back — a restart in the middle
   * threw away every task still in flight and every one waiting behind it.
   *
   * Completed tasks and their results are kept, so the work already paid for is not repeated and
   * dependants still receive their context. Everything else — stopped, failed, blocked or given up —
   * goes back to pending and is attempted again: a task that already has a chat continues it, in a
   * new execution, in the worktree it left, and keeps what it cost.
   *
   * A graph that waits for a decision resumes the same way: every task it waits on is decided to be
   * worth another go at once (R11: a task stopped while it waited for a reset left the graph with no
   * way out but a stop and a resume). Nothing of it runs while it waits, except a chat a person went
   * on in by hand, which is refused rather than sent a second turn.
   */
  resume(id: string, changes: ResumeOrchestrationRequest = {}): Orchestration {
    const orch = this.items.get(id);
    if (!orch) throw new NotFoundError('orchestration not found');
    if (orch.status === 'running') return orch;
    // Before anything of the graph is touched, so a mode the CLI would refuse leaves it as it was
    validatePermissionMode(changes.permissionMode);
    if (this.verifying.has(orch.id)) throw new Error('the checks are running on the integration branch: stop the orchestration first');
    const unfinished = orch.tasks.filter((t) => t.status !== 'completed');
    if (unfinished.length === 0) throw new Error('every task already completed');
    // Stopping a graph stops its tasks' chats; waiting stopped none of them, and one may be in use
    const working = orch.status === 'waiting' ? unfinished.find((t) => t.runId && ['busy', 'starting'].includes(this.runs.get(t.runId)?.status ?? '')) : undefined;
    if (working) throw new Error(`task ${working.id} is still working in its chat: wait for it, or stop it first`);
    // A graph that died for lack of permissions, or by editing the checkout the wrapper runs from,
    // would only die the same way again: correct those before relaunching what is left.
    if (changes.worktree === true && orch.engine === 'workflow') {
      throw new Error('a workflow runs every task in the project directory; per-task worktrees need the graph engine');
    }
    if (changes.worktree === true && !isGitRepo(orch.cwd)) {
      throw new Error(`per-task worktrees need a git repository, and ${orch.cwd} is not one`);
    }
    const base = changes.worktree === true && !orch.baseCommit ? baseOf(orch.cwd) : undefined;
    // Chats that worked in the shared checkout cannot move into a worktree: those tasks start over
    const isolating = changes.worktree === true && !orch.worktree;
    if (changes.worktree !== undefined) orch.worktree = changes.worktree;
    if (orch.worktree) orch.baseCommit ??= base ?? baseOf(orch.cwd);
    if (changes.permissionPrompts !== undefined) orch.permissionPrompts = changes.permissionPrompts === 'host' ? 'host' : 'none';
    if (changes.allowedTools !== undefined) orch.allowedTools = changes.allowedTools.map(String).filter(Boolean);
    if (changes.permissionMode !== undefined) orch.permissionMode = changes.permissionMode;
    // A ceiling is a guess made before the work started, and the graph is stopped when this runs:
    // correcting one here is what keeps a graph that ran out of budget from having to be relaunched
    // from nothing. A task's own limit wins over the graph's, so lifting the graph's while those
    // stand would free nothing — `null` therefore clears both, and an object leaves the deliberate
    // per-task choices where they are.
    if (changes.limits !== undefined) {
      orch.limits = normalizeLimits(changes.limits, 'limits') ?? null;
      if (changes.limits === null) for (const task of orch.tasks) delete task.limits;
    }
    if (changes.maxAttempts !== undefined) orch.maxAttempts = attemptsOf(changes.maxAttempts);
    for (const task of unfinished) {
      task.status = 'pending';
      task.result = null;
      task.startedAt = null;
      task.endedAt = null;
      if (isolating && orch.engine === 'graph') Object.assign(task, { runId: null, sessionId: null, attempts: 0, costUsd: 0 });
      // What failed is what the chat is told when it goes on; a task that never ran has nothing to say
      if (!task.runId || orch.engine === 'workflow') task.error = null;
    }
    orch.status = 'running';
    orch.endedAt = null;
    orch.finalResult = null;
    orch.synthesisRunId = null;
    // Integrated again once the resumed tasks finish. The branch name is derived from the graph, so
    // that reuses the same branch, which already holds the earlier merges.
    orch.integration = null;
    orch.verification = null;
    if (orch.error) orch.error = null;
    // A workflow picks up in its own session, where the CLI replays the agents that already finished
    // from its cache instead of running them again
    if (orch.engine === 'workflow') this.launchWorkflow(orch, orch.workflow?.workflowRunId ?? null);
    else this.schedule(orch); // persists
    return orch;
  }

  // ---------- relaunching and templates ----------

  /**
   * The spec that would launch this graph as it is: what a relaunch starts from and what a template
   * saves. The UI fills a schedule from the same function, over the orchestration it reads back.
   */
  specOf(id: string): OrchestrationSpec {
    const orch = this.items.get(id);
    if (!orch) throw new NotFoundError('orchestration not found');
    return specOfOrchestration(orch);
  }

  /**
   * Runs a graph that is no longer running again, with corrections, as a new orchestration that
   * records where it came from. It starts from nothing: new chats, new worktrees, its own branch. What
   * the first one produced stays exactly as it was, which is what makes "try it with a better prompt"
   * safe to do on a graph whose result someone may still want.
   */
  relaunch(id: string, changes: RelaunchOrchestrationRequest = {}): Orchestration {
    return this.create(this.relaunchSpec(id, changes), { relaunchedFrom: id });
  }

  /** What a relaunch would launch, for a caller that checks it first: the original with the corrections. */
  relaunchSpec(id: string, changes: RelaunchOrchestrationRequest = {}): OrchestrationSpec {
    const orch = this.items.get(id);
    if (!orch) throw new NotFoundError('orchestration not found');
    if (orch.status === 'running') throw new Error('the orchestration is still running: stop it first, or wait for it to finish');
    const original = this.specOf(id);
    const { tasks: replaced, ...overrides } = changes.spec ?? {};
    return {
      ...original,
      ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)),
      tasks: changes.tasks ?? replaced ?? original.tasks,
    };
  }

  /** Saves a graph as a template, from a spec (a draft plan) or from an orchestration's own. */
  saveTemplate(req: SaveOrchestrationTemplateRequest): OrchestrationTemplate {
    if (req.spec && req.fromOrchestration) throw new Error('give the graph as a spec or as an orchestration to take it from, not both');
    const spec = req.fromOrchestration ? this.specOf(req.fromOrchestration) : req.spec;
    if (!spec) throw new Error('spec or fromOrchestration is required');
    // A template is new work on another objective, never the work items the graph was saved from
    const tasks = Array.isArray(spec.tasks) ? spec.tasks.map(({ workItemId: _item, ...task }) => task) : spec.tasks;
    return this.templates.save(req.name, { ...spec, tasks }, req.description);
  }

  /** Launches a template on a new objective and directory; what is given here is for this run only. */
  launchTemplate(id: string, req: LaunchOrchestrationTemplateRequest = {}): Orchestration {
    const template = this.templates.get(id);
    if (!template) throw new NotFoundError('template not found');
    const spec: OrchestrationSpec = { ...template.spec };
    if (req.name?.trim()) spec.name = req.name.trim();
    if (req.objective !== undefined) spec.objective = req.objective;
    if (req.cwd) spec.cwd = req.cwd;
    if (req.model) spec.model = req.model;
    if (req.effort) {
      validateEffort(req.effort);
      spec.effort = req.effort;
    }
    return this.create(spec, { templateId: template.id });
  }

  /** What every worker is told first; shared by both engines, so a task reads the same either way. */
  private workerHead(orch: Orchestration, task: OrchestrationTaskState): string {
    const others = orch.tasks.filter((t) => t.id !== task.id);
    const listed = others.slice(0, WORKER_HEAD_TASKS).map((t) => {
      const name = t.name.length > WORKER_HEAD_NAME ? `${t.name.slice(0, WORKER_HEAD_NAME - 1)}…` : t.name;
      return `- \`${t.id}\` ${name}${t.dependsOn?.length ? ` (depends on: ${t.dependsOn.join(', ')})` : ''}`;
    });
    const more = others.length - listed.length;
    const count = orch.tasks.length;
    return [
      'You are one worker in a multi-agent orchestration.',
      orch.objective ? `Overall objective, as the person wrote it:\n${pasted(orch.objective)}` : `The graph is named ${pasted(orch.name)}.`,
      `The graph has ${String(count)} task${count === 1 ? '' : 's'}; yours is \`${task.id}\`.` +
        (listed.length ? ' The others, so you neither redo nor undo their work:' : ''),
      ...(listed.length ? [pasted([...listed, ...(more > 0 ? [`and ${String(more)} more`] : [])].join('\n'))] : []),
    ].join('\n');
  }

  private workerTask(orch: Orchestration, task: OrchestrationTaskState): string {
    // Said here, and not left to the objective: what each stage checks, and how an unattended run
    // ends, are Claudio's rules
    return [
      `Your task is named:\n${pasted(task.name)}\n\n${task.prompt}`,
      task.builtIn === 'e2e-specs' ? e2eSpecsChecks() : workerChecks(!!orch.verificationSpec),
      REAL_VERIFICATION,
      RETRIEVAL,
      frontend(designSources(orch.cwd)),
      scopeAndCompletion(),
      UNATTENDED,
      DELEGATION,
      PASTED_NOTE,
      WORKER_CLOSING,
    ].join('\n\n');
  }

  private buildPrompt(orch: Orchestration, task: OrchestrationTaskState, pendingMerge: PendingMerge | null = null): string {
    const parts: string[] = [];
    // A chat is listed by its first line: a node working on a task of the board opens with its name,
    // `KEY · title` in a draft, rather than with the same English sentence as every other node
    if (task.workItemId && task.name.trim()) parts.push(task.name.trim());
    parts.push(this.workerHead(orch, task));
    const deps = orch.tasks.filter((t) => task.dependsOn?.includes(t.id));
    if (deps.length > 0) {
      parts.push(
        'Results from the tasks you depend on:\n' +
          deps.map((d) => taskBlock(d, (d.result ?? '').slice(0, MAX_DEP_CONTEXT))).join('\n'),
      );
    }
    if (task.worktree && task.branch) {
      parts.push(
        `You are working in a git worktree of your own at ${task.worktree}, checked out on branch ${task.branch}. ` +
          'Every other worker has its own, so nothing you write there collides with theirs. Work only inside it, ' +
          'commit your work on that branch with clear messages, and do not push: once every task is done, all ' +
          'branches are merged into one automatically.' +
          (deps.length > 0 ? ' Your branch already contains the work of the tasks you depend on; build on it rather than redoing it.' : ''),
      );
    }
    if (pendingMerge) {
      parts.push(
        `Before your task: combining the work of your dependencies left a merge of ${pendingMerge.branch} unfinished, ` +
          `with conflicts in:\n${pendingMerge.paths.map((p) => `- ${p}`).join('\n')}\n` +
          'Resolve them keeping the intent of both sides, then commit the merge.' +
          (pendingMerge.remaining.length
            ? ` After that, merge these branches too, resolving any conflict the same way:\n${pendingMerge.remaining.map((b) => `- ${b}`).join('\n')}`
            : ''),
      );
    }
    parts.push(this.workerTask(orch, task));
    return parts.join('\n\n');
  }

  private schedule(orch: Orchestration): void {
    if (this.closed || orch.status !== 'running') return;
    const byId = new Map(orch.tasks.map((t) => [t.id, t]));

    // A restart cut a task off: it goes on while it has attempts left, as a failure would. A stopped
    // one never comes here, because someone chose that.
    for (const t of orch.tasks) {
      if (t.status !== 'interrupted' || t.attempts < orch.maxAttempts) continue;
      t.status = 'failed';
      t.error = `interrupted by a restart, with no attempts left (${t.attempts} of ${orch.maxAttempts})`;
    }

    // What waits behind a task decides its own state, until nothing changes: a branch given up takes
    // its dependants with it, and one that failed for good holds them for a person to decide. A
    // task that stops being held (its blocker was retried, or completed late) goes back to pending.
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of orch.tasks) {
        if (t.status !== 'pending' && t.status !== 'blocked') continue;
        const deps = (t.dependsOn ?? []).map((d) => byId.get(d)?.status);
        const held = deps.some((s) => s === 'failed' || s === 'blocked' || s === 'stopped');
        if (deps.includes('skipped')) {
          t.status = 'skipped';
          t.error = 'a task it depends on was given up';
        } else if (t.status === 'pending' && held) {
          t.status = 'blocked';
          t.error = 'waiting for a decision on a task it depends on';
        } else if (t.status === 'blocked' && !held) {
          t.status = 'pending';
          t.error = null;
        } else continue;
        changed = true;
      }
    }

    let running = orch.tasks.filter((t) => t.status === 'running').length;
    for (const t of orch.tasks) {
      if (running >= orch.concurrency) break;
      if (t.status !== 'pending' && t.status !== 'interrupted') continue;
      if (!(t.dependsOn ?? []).every((d) => byId.get(d)?.status === 'completed')) continue;
      // A task that never ran waits for the cap, and so does every one after it; one that has a chat goes on in it
      if (t.status === 'pending' && !t.runId && this.spendOpen?.(orch.id) === false) break;
      if (this.launch(orch, t)) running++;
      else break;
    }

    if (orch.tasks.every((t) => !['pending', 'running', 'interrupted'].includes(t.status))) {
      // A synthesis written over a graph that is missing a branch reads like the final report, so
      // nothing that summarises it runs until a person has decided about what failed
      if (orch.tasks.some((t) => t.status === 'failed' || t.status === 'blocked')) orch.status = 'waiting';
      else void this.finish(orch);
    }
    this.persist();
  }

  /**
   * Creates the task's worktree before the CLI runs, on a branch that already holds its
   * dependencies' work. Left to itself `claude --worktree` branches from HEAD, so a dependent task
   * started from nothing its dependencies had done and rebuilt it. The CLI adopts an existing
   * worktree of the name it is given, so it still locks it and records it as its own.
   */
  private async prepareWorktree(orch: Orchestration, task: OrchestrationTaskState, name: string): Promise<PreparedWorktree> {
    const { root, subdir, home } = await checkoutOfAsync(orch.cwd);
    const path = worktreePath(home, name);
    const branch = `worktree-${name}`;
    // Before worktrees were resolved from the top level, a graph in a subdirectory put them where
    // the CLI never looked, and every worker failed there before doing anything. Its branch cannot
    // be checked out twice, so that worktree goes; git refuses if it holds anything.
    const old = task.worktree;
    if (old && existsSync(old) && (!existsSync(path) || realpathSync(old) !== realpathSync(path))) await removeWorktreeAsync(root, old);
    task.worktree = path;
    task.branch = branch;
    // Handed a name, the CLI finds the worktree from the top level and works at the worktree's top
    const prepared: PreparedWorktree = subdir
      ? { cwd: join(path, subdir), adopt: false, pendingMerge: null }
      : { cwd: root, adopt: true, pendingMerge: null };
    const deps: string[] = [];
    for (const t of orch.tasks) {
      if (task.dependsOn?.includes(t.id) && t.branch && (await branchExistsAsync(root, t.branch))) deps.push(t.branch);
    }
    const rest = deps.slice(1);
    // A resumed task continues where its first attempt stopped
    if (!existsSync(path)) {
      // A branch that is already there was cut by an earlier attempt, and its base is that one's
      const cutNow = !(await branchExistsAsync(root, branch));
      await addWorktreeAsync(root, path, branch, deps[0] ?? orch.baseCommit ?? 'HEAD');
      prepared.pendingMerge = await mergeDependencies(path, branch, rest);
      // What "changed by this task" is measured from: its dependencies' work is not its own
      if (cutNow) task.baseCommit = await headCommitAsync(path);
    } else if (!task.runId) {
      // No worker has run here yet: an earlier launch prepared it and was refused a place. What the
      // worker is owed is read from the worktree again, never remembered, so a conflict that launch
      // left in it is not handed to a worker untold (it would work among conflict markers)
      prepared.pendingMerge = (await mergeLeftInProgress(root, path, rest)) ?? (await mergeDependencies(path, branch, rest));
    }
    if (!prepared.adopt) {
      // A directory holding only untracked files in the checkout does not exist in the worktree
      mkdirSync(prepared.cwd, { recursive: true });
      await lockWorktreeAsync(root, path, `claudio orchestration ${orch.id.slice(0, 8)}`);
    }
    return prepared;
  }

  /**
   * The guard plan of one of the graph's runs, or null when its kind is not guarded (the resolution
   * table, `resolveGuards`). A guard that cannot run throws `GuardUnavailableError`, so the caller
   * fails before the CLI spawns.
   */
  private guardPlan(orch: Orchestration, kind: GuardRunKind, cwd: string, worktree?: string | null, policy?: ToolPolicy): ChatGuardPlan | null {
    return (
      this.guards?.prepareNow({
        kind,
        cwd,
        worktree: worktree ?? null,
        mainCheckout: orch.cwd,
        graph: orch.guards,
        ...(policy ? { policy: { commands: policy.commands.allow !== 'none', edits: policy.edit.allow !== 'none' } } : {}),
      }) ?? null
    );
  }

  /** The task's, then the graph's, then the recommendation for the model it runs on. */
  private workerEffort(orch: Orchestration, task: OrchestrationTaskState): Effort | undefined {
    return resolveEffort('worker', task.model ?? orch.model, task.effort, orch.effort);
  }

  /**
   * Takes a place in the graph for the task and starts its worker. The task is `running` from here,
   * while its worktree is prepared off the event loop; what refuses it later hands it back
   * (`refuse`), and a stop in between leaves it stopped (the attempt's stamp is no longer current).
   */
  private launch(orch: Orchestration, task: OrchestrationTaskState): boolean {
    // A task that has a chat goes on in it: a new execution, never a new conversation
    if (task.runId && this.runs.get(task.runId)) return this.continueChat(orch, task, task.runId);
    const was = task.status;
    const stamp = this.stampAttempt(orch, task);
    task.status = 'running';
    void this.startWorker(orch, task, stamp, was);
    return true;
  }

  private async startWorker(orch: Orchestration, task: OrchestrationTaskState, stamp: number, was: OrchestrationTaskState['status']): Promise<void> {
    const isolated = orch.worktree && !task.cwd;
    try {
      const limits = effectiveLimits(orch.limits, task.limits);
      const name = worktreeName(orch, task);
      const prepared = isolated ? await this.prepareWorktree(orch, task, name) : null;
      if (!this.attemptCurrent(orch, task, stamp)) return; // stopped while its worktree was prepared
      const cwd = prepared?.cwd ?? task.cwd ?? orch.cwd;
      // A chat's start no longer creates its folder (D9): a task the plan placed in a folder that does
      // not exist yet gets it here, as it always did
      if (!prepared) mkdirSync(cwd, { recursive: true });
      // With `adopt` the CLI moves into the worktree itself, so the root is the worktree, not the cwd it is started in
      const guards = this.guardPlan(orch, 'worker', cwd, prepared ? task.worktree : null);
      const run = this.runs.start(
        {
          prompt: this.buildPrompt(orch, task, prepared?.pendingMerge ?? null),
          cwd,
          ...(guards ? { guards } : {}),
          // The CLI adopts the worktree prepared above, locks it and works in it
          ...(prepared?.adopt ? { worktree: name } : {}),
          provider: 'claude-code',
          ...effortOption(this.workerEffort(orch, task)),
          model: (task.model ?? orch.model) ?? undefined,
          permissionMode: orch.permissionMode,
          ...(orch.allowedTools?.length ? { allowedTools: orch.allowedTools } : {}),
          disallowedTools: [...PUSH_DENIED],
          ...(orch.permissionPrompts === 'host' ? { permissionPrompts: 'host' as const } : {}),
          name: `${orch.name}:${task.id}`.slice(0, 60),
          purpose: 'orchestration',
          keepAlive: false,
          // The CLI ends the turn itself when this is spent
          ...(limits?.maxCostUsd !== undefined ? { maxBudgetUsd: limits.maxCostUsd } : {}),
        },
        { orchestrationId: orch.id, orchestrationTaskId: task.id, queued: true },
      );
      task.runId = run.id;
      task.sessionId = run.id;
      task.provider = run.provider ?? LEGACY_PROVIDER;
      task.waiting = null;
      task.attempts = 1;
      // The cost of a chat that is gone (its record deleted) stays in the graph's total, not here
      task.costUsd = 0;
      task.startedAt = now();
      startClock(task, task.startedAt);
      void this.runs.waitForResult(run.id).then((result) => this.settle(orch, task, result, stamp));
    } catch (err) {
      if (!this.attemptCurrent(orch, task, stamp)) return;
      task.status = was;
      this.refuse(orch, task, err, 'start the worker');
    }
    // Without a worktree to prepare this ran within `schedule`, which saves once it has launched them all
    if (isolated) this.persist();
  }

  /**
   * Runs a task's chat again: a new execution of the same session, which keeps its worktree and
   * everything the previous execution did. What it is told comes from what happened to it (the
   * error, or the interruption), never from the objective.
   */
  private continueChat(orch: Orchestration, task: OrchestrationTaskState, chatId: string, nudge: string | null = null): boolean {
    const key = `${orch.id}:${task.id}`;
    const limits = effectiveLimits(orch.limits, task.limits);
    // The CLI's ceiling is per process, so an attempt gets what the allowance has left, not all of it again
    const remaining = remainingUsd(limits, task);
    if (remaining !== null && remaining <= 0) {
      return this.refuse(orch, task, new Error(`its cost limit of $${(limits?.maxCostUsd ?? 0).toFixed(2)} is spent`), 'run the task again');
    }
    const was = task.status;
    const stamp = this.stampAttempt(orch, task);
    task.status = 'running';
    // A continuation for work still owed is not a new attempt: nothing failed
    if (nudge === null) task.attempts += 1;
    task.startedAt ??= now();
    if (!task.clockStartedAt) startClock(task, now());
    task.endedAt = null;
    this.relaunching.add(key);
    // The previous process may still be on its way out, and a chat has one process at most
    void this.runs.exited(chatId).then(async () => {
      try {
        const prepared = orch.worktree && !task.cwd ? await this.prepareWorktree(orch, task, worktreeName(orch, task)) : null;
        if (!this.attemptCurrent(orch, task, stamp)) return; // stopped meanwhile
        // Planned before the process: a guard that cannot run fails the task without one
        const guards = this.guardPlan(orch, 'worker', this.runs.get(chatId)?.cwd ?? prepared?.cwd ?? task.cwd ?? orch.cwd, prepared ? task.worktree : null);
        const prompt = nudge ?? this.continuation(orch, task);
        this.runs.resume(chatId, { prompt, purpose: 'orchestration', queued: true, guards, ...(remaining !== null ? { maxBudgetUsd: remaining } : {}) });
        // The chat has answered before: only a result after this call is this attempt's
        void this.runs.nextResult(chatId).then((result) => this.settle(orch, task, result, stamp));
        task.error = null;
      } catch (err) {
        if (!this.attemptCurrent(orch, task, stamp)) return;
        task.status = was;
        if (nudge === null) task.attempts -= 1;
        this.refuse(orch, task, err, 'run the task again');
      } finally {
        this.relaunching.delete(key);
        this.persist();
      }
    });
    return true;
  }

  /**
   * Starts one of the graph's own runs (its integrator, its synthesis), waiting while the refusal is a
   * place that frees up by itself, as the review gate's runs do; a stop of the graph ends the wait.
   */
  private whenAdmitted<T>(orch: Orchestration, start: () => T): Promise<T> {
    let wait = this.placeWaits.get(orch.id);
    if (!wait || wait.signal.aborted) {
      wait = new AbortController();
      this.placeWaits.set(orch.id, wait);
    }
    return startWhenAdmitted(start, { signal: wait.signal });
  }

  /** Ends whatever of the graph waits for a place. */
  private endPlaceWaits(id: string): void {
    this.placeWaits.get(id)?.abort(new Error('stopped while it waited for a place to run'));
    this.placeWaits.delete(id);
  }

  /**
   * Starts a new attempt of the task and returns its stamp. A result, a refusal or a prepared worktree
   * that arrives for an older stamp belongs to an attempt that was stopped since: a Stop then a
   * Resume within seconds must not let the stopped process's last word settle the resumed task.
   */
  private stampAttempt(orch: Orchestration, task: OrchestrationTaskState): number {
    const stamp = ++this.attemptSeq;
    this.attemptStamps.set(`${orch.id}:${task.id}`, stamp);
    return stamp;
  }

  /** Whether the attempt of this stamp is still the task's running one. */
  private attemptCurrent(orch: Orchestration, task: OrchestrationTaskState, stamp: number): boolean {
    return task.status === 'running' && this.attemptStamps.get(`${orch.id}:${task.id}`) === stamp;
  }

  /** The stamp of the task's running attempt, which a turn that goes on within it (a limit's replay) carries on. */
  private currentStamp(orch: Orchestration, task: OrchestrationTaskState): number {
    return this.attemptStamps.get(`${orch.id}:${task.id}`) ?? this.stampAttempt(orch, task);
  }

  /** Ends the task's attempt: whatever it still had armed (a result, a prepared worktree) settles nothing. */
  private endAttempt(orch: Orchestration, task: OrchestrationTaskState): void {
    this.attemptStamps.delete(`${orch.id}:${task.id}`);
  }

  /**
   * What a failed launch does. A place that frees up by itself is the one transient failure: the task
   * stays pending and is tried again shortly. Everything else used to be swallowed and retried for ever,
   * which left a graph reporting itself as running with nothing running and no way to find out why;
   * it fails visibly, and a person decides.
   */
  private refuse(orch: Orchestration, task: OrchestrationTaskState, err: unknown, doing: string): false {
    const message = errorMessage(err);
    this.endAttempt(orch, task);
    // The count of chats, the memory the machine gets back, a place kept for a person's chat, or a guard self-test
    if (isTransientRefusal(err) || err instanceof GuardSelfTestPending) {
      this.scheduleLater(orch, SLOT_RETRY_MS);
      return false;
    }
    task.status = 'failed';
    // The code leads, so the failure reads as the guard's and not as the task's
    task.error = err instanceof GuardUnavailableError ? `guard-unavailable (${err.code}): could not ${doing}: ${message}` : `could not ${doing}: ${message}`;
    task.endedAt = now();
    this.scheduleLater(orch, 0);
    return false;
  }

  /** What a chat is told when its task goes on after an execution that did not finish it. */
  private continuation(orch: Orchestration, task: OrchestrationTaskState): string {
    const time = this.timeOf(orch, task);
    if (!task.error) {
      return (
        'This orchestration was interrupted before you finished your task. Everything you did is still in place, in the same ' +
        `working directory. Check where you stopped and carry on from there instead of starting over. ${WORKER_CLOSING}\n\n${time}`
      );
    }
    const quoted = task.error.length > MAX_ERROR_QUOTE ? `${task.error.slice(0, MAX_ERROR_QUOTE)}…` : task.error;
    return (
      `Your previous attempt at this task ended with an error:

${quoted}

` +
      'Everything you did is still in place, in the same working directory. Work out what went wrong, fix it, and carry on from ' +
      `where you stopped instead of starting over. ${WORKER_CLOSING}\n\n${time}`
    );
  }

  /** The time signal a worker is handed back with: its elapsed time against its limit, when it has one. */
  private timeOf(orch: Orchestration, task: OrchestrationTaskState): string {
    const limits = effectiveLimits(orch.limits, task.limits);
    return timeSignal(elapsedMs(task, Date.now()), limits?.maxMinutes !== undefined ? limits.maxMinutes * 60_000 : null);
  }

  /** Chats whose next result a task already listens for: a limit and the end of its wait both ask, and one result is settled once. */
  private readonly following = new Set<string>();

  private followNextResult(orch: Orchestration, task: OrchestrationTaskState, chatId: string, stamp: number): void {
    if (this.following.has(chatId)) return;
    this.following.add(chatId);
    void this.runs.nextResult(chatId).then(
      (result) => {
        this.following.delete(chatId);
        this.settle(orch, task, result, stamp);
      },
      () => void this.following.delete(chatId),
    );
  }

  /**
   * Takes what an execution of a task produced. A failure is tried again, in the same chat, until
   * the task has used its attempts; what a retry cannot mend (a budget that ran out, a task stopped
   * on purpose, a rate limit that account rotation handles) is not tried again at all.
   */
  private settle(orch: Orchestration, task: OrchestrationTaskState, result: RunResult, stamp: number): void {
    // Stopped meanwhile, or the last word of an attempt that was stopped and has been started again since
    if (!this.attemptCurrent(orch, task, stamp)) return;
    // The usage limit is the rotation's: it waits for the reset in this chat (`waitEnded` listens for
    // the replayed turn) or moves the task to a new chat (`moved`). Not a failure, not an attempt
    // The usage limit is the rotation's either way: it moves the chat to another account and replays the
    // turn in it (`replayLastTurn`, no wait and no `waitEnded`), or it waits for the reset and replays
    // then. The next result of the chat is this attempt's in both cases, so the task follows it. Before,
    // only a wait was followed, and a task whose turn went on with another account stayed running after
    // that turn had ended (2026-10-16: five finished tasks of a graph, each first refused by an account
    // at its weekly limit, held the graph for 50 minutes)
    if (result.isError && result.cause === 'rate-limit' && task.runId) {
      this.charge(orch, task, result);
      this.followNextResult(orch, task, task.runId, stamp);
      return this.persist();
    }
    const deciding = this.decide(orch, task, result);
    if (!deciding) return this.settleNow(orch, task, result, {});
    void deciding.then((verdict) => {
      // A decision that took its time may have been overtaken by a stop
      if (this.attemptCurrent(orch, task, stamp)) this.settleNow(orch, task, result, verdict);
    });
  }

  /**
   * Whether a failed attempt ended with the error the one before it did. A third attempt at an error
   * that came back unchanged is the loop around the chat being stuck, not the chat, so code ends it
   * (numbers, paths and times are washed out of the comparison, see `failureSignature`).
   */
  private repeatsError(task: OrchestrationTaskState, result: RunResult): boolean {
    if (!result.isError || result.cause) return false;
    const signature = failureSignature(result.result);
    return signature !== null && signature === task.lastErrorSignature;
  }

  private settleNow(orch: Orchestration, task: OrchestrationTaskState, result: RunResult, verdict: SettleVerdict): void {
    const repeated = this.repeatsError(task, result);
    if (result.isError && !result.cause) task.lastErrorSignature = failureSignature(result.result);
    if (result.isError && !result.cause && task.attempts < orch.maxAttempts && task.runId && !verdict.permanent && !repeated) {
      this.charge(orch, task, result);
      task.error = result.result;
      this.continueChat(orch, task, task.runId);
      return this.persist();
    }
    // A turn that ended as a report with work still owed goes back to its chat, naming what is open.
    // Claudio commits what a worker leaves uncommitted, so only its last message is read here
    const open =
      result.isError || !task.runId || (task.continuations ?? 0) >= MAX_CONTINUATIONS
        ? []
        : [...structuralItems({ schema: false, structured: true, uncommitted: [], delegates: delegatesOf(this.runs.get(task.runId)) }), ...(verdict.phrases ?? phraseItems(result.result))];
    if (open.length && task.runId) {
      this.charge(orch, task, result);
      const count = (task.continuations ?? 0) + 1;
      task.continuations = count;
      this.continueChat(orch, task, task.runId, continuationPrompt(open, count, [WORKER_CLOSING, this.timeOf(orch, task)]));
      return this.persist();
    }
    this.record(orch, task, result);
    if (repeated && task.status === 'failed') task.error = `${result.result}\n\nThe same error came back on two attempts in a row, so Claudio did not try again.`;
    this.schedule(orch);
  }

  // ---------- decision points ----------
  // Every point ships off. Shadow asks in the background and today's behaviour decides; active waits
  // for the answer only where the graph can act on it, and any other outcome (unavailable, below the
  // threshold, no consent, the CLI) is today's behaviour at once.

  private projectIdOf(cwd: string): string | null {
    try {
      return this.projectOf?.(cwd) ?? null;
    } catch {
      return null;
    }
  }

  /** Never rejects: an engine that fails is an answer that never came */
  private async ask(point: DecisionPointId, subject: DecisionSubject, projectId: string | null): Promise<DecisionOutcome | null> {
    try {
      return (await this.decisions?.ask(point, subject, { projectId })) ?? null;
    } catch {
      return null;
    }
  }

  private track<T>(promise: Promise<T>): void {
    const tracked = promise.catch(() => undefined).finally(() => this.deciding.delete(tracked));
    this.deciding.add(tracked);
  }

  /** Waits for the decisions asked so far; for tests and for shutting down cleanly */
  async decided(): Promise<void> {
    while (this.deciding.size) await Promise.all([...this.deciding]);
  }

  /**
   * The decisions that stand between a task's result and what happens to it: `orchestration.retry`
   * for an error, `run.continuation` for a report. Null when the result is taken now, as today. A
   * rate limit (it has a cause), a task out of attempts and a continuation are never asked about.
   */
  private decide(orch: Orchestration, task: OrchestrationTaskState, result: RunResult): Promise<SettleVerdict> | null {
    if (!task.runId) return null;
    const projectId = this.projectIdOf(orch.cwd);
    const id = `${orch.id}:${task.id}`;
    if (result.isError) {
      // A repeated error ends the retries in code: the point is not asked about a retry that will not happen
      if (result.cause || task.attempts >= orch.maxAttempts || this.repeatsError(task, result)) return null;
      const stance = stanceOf(this.decisions, 'orchestration.retry', projectId);
      if (stance === 'off') return null;
      const attempt = `${ORDINALS[task.attempts - 1] ?? 'a later'} attempt`;
      const asked = this.ask('orchestration.retry', { kind: 'task', id, data: { error: tail(result.result, MAX_DECISION_TEXT), task: task.name, attempt } }, projectId);
      if (stance === 'watch') {
        this.track(asked);
        return null;
      }
      // Only a permanent error stops the retry; anything else is today's behaviour
      return asked.then((outcome): SettleVerdict => {
        const answer = outcome?.answers?.retry;
        return answer?.kind === 'choice' && answer.value === 'permanent' ? { permanent: true } : {};
      });
    }
    const done = task.continuations ?? 0;
    const last = tailOf(result.result);
    if (done >= MAX_CONTINUATIONS || !last) return null;
    const stance = stanceOf(this.decisions, 'run.continuation', projectId);
    if (stance === 'off') return null;
    const words = ['no continuation yet', 'one continuation so far', 'two continuations so far'][done] ?? 'several continuations so far';
    const asked = this.ask('run.continuation', { kind: 'task', id, data: { title: task.name, tail: last, continuations: words } }, projectId);
    if (stance === 'watch') {
      this.track(asked);
      return null;
    }
    // Only the phrase part is the decision's; the structural items stay code's (see settleNow)
    return asked.then((outcome): SettleVerdict => {
      const answer = outcome?.answers?.report;
      if (answer?.kind !== 'choice') return {};
      if (answer.value === 'done') return { phrases: [] };
      const phrases = phraseItems(result.result);
      return { phrases: phrases.length ? phrases : [OWES_WORK_ITEM] };
    });
  }

  /** The chat's total, so the graph adds only what this execution cost on top of what it already counted. */
  private charge(orch: Orchestration, task: OrchestrationTaskState, result: RunResult): void {
    orch.costUsd += result.costUsd - task.costUsd;
    task.costUsd = result.costUsd;
  }

  // ---------- a limit: waiting ----------

  private taskOfChat(chatId: string): { orch: Orchestration; task: OrchestrationTaskState } | null {
    for (const orch of this.items.values()) {
      if (orch.engine !== 'graph') continue;
      const task = orch.tasks.find((t) => t.runId === chatId);
      if (task) return { orch, task };
    }
    return null;
  }

  /**
   * A running workflow graph always has a watcher, which settles it once its lead is gone, its run
   * ended or nothing grew for too long, unless a launch into its session is still on its way. One that
   * lost its watcher is followed again rather than left `running` with nothing behind it (R15).
   */
  private watchWorkflows(): void {
    for (const orch of this.items.values()) {
      if (orch.status !== 'running' || orch.engine !== 'workflow' || !orch.workflow?.runId) continue;
      if (this.workflowWatchers.has(orch.id) || this.workflowLaunching.has(orch.id)) continue;
      this.followWorkflow(orch, orch.workflow.runId);
    }
  }

  /** The running workflow graph a chat leads. */
  private workflowOfLead(chatId: string): Orchestration | null {
    for (const orch of this.items.values()) {
      if (orch.engine === 'workflow' && orch.status === 'running' && orch.workflow?.runId === chatId) return orch;
    }
    return null;
  }

  /**
   * What a running task's chat works for. A workflow's lead works for the whole graph: its one
   * process runs every task, so at a limit it is moved or waited for as a whole, and goes on by
   * resuming the run from its cache (`replayWorkflow`). Null for any other chat.
   */
  workOf(chatId: string): ChatWork | null {
    const workflow = this.workflowOfLead(chatId);
    if (workflow) return { subjectKind: 'task', subjectId: `${workflow.id}:${WORKFLOW_LEAD}` };
    const found = this.taskOfChat(chatId);
    if (!found || found.task.status !== 'running') return null;
    return { subjectKind: 'task', subjectId: `${found.orch.id}:${found.task.id}` };
  }

  /**
   * A wait for the limit to reset ended. Replayed, the task goes on in the same chat and its next
   * result is settled as any other. A person who stopped waiting stops the task; a wait that ran out
   * fails it, and a person decides.
   */
  waitEnded(move: Pick<ProviderMove, 'fromChat' | 'at'>, end: 'resumed' | 'failed' | 'cancelled', reason: string | null): void {
    const workflow = this.workflowOfLead(move.fromChat);
    if (workflow) return this.workflowWaitEnded(workflow, end, reason);
    const found = this.taskOfChat(move.fromChat);
    if (!found || found.task.status !== 'running') return;
    const { orch, task } = found;
    // The clock did not run while the task waited
    const from = task.clockStartedAt ?? task.startedAt;
    if (from) task.clockStartedAt = new Date(Date.parse(from) + Math.max(0, Date.now() - Date.parse(move.at))).toISOString();
    task.waiting = null;
    if (end === 'resumed') {
      // The turn was sent just before this: only a result after it is the task's next
      this.followNextResult(orch, task, move.fromChat, this.currentStamp(orch, task));
      return this.persist();
    }
    task.status = end === 'cancelled' ? 'stopped' : 'failed';
    task.error =
      end === 'cancelled'
        ? 'a person stopped waiting for the usage limit to reset'
        : reason === 'limit-wait-expired'
          ? 'the usage limit did not reset within the time Claudio waits for it'
          : `the usage limit reset, but the task could not go on${reason ? ` (${reason})` : ''}`;
    task.endedAt = now();
    this.schedule(orch);
  }

  /**
   * A workflow's wait for the limit to reset ended. Resumed, the run already went on from its cache
   * (`replayWorkflow` follows it); otherwise the graph ends with what is left undone, and can be
   * resumed by hand once an account has room.
   */
  private workflowWaitEnded(orch: Orchestration, end: 'resumed' | 'failed' | 'cancelled', reason: string | null): void {
    if (end === 'resumed') return this.persist();
    const error =
      end === 'cancelled'
        ? 'a person stopped waiting for the usage limit to reset'
        : reason === 'limit-wait-expired'
          ? 'the usage limit did not reset within the time Claudio waits for it'
          : `the usage limit reset, but the workflow could not go on${reason ? ` (${reason})` : ''}`;
    const status = end === 'cancelled' ? 'stopped' : 'failed';
    this.clearWorkflowWatcher(orch.id);
    for (const t of orch.tasks) {
      if (t.status !== 'pending' && t.status !== 'running') continue;
      t.status = status;
      t.error = error;
      t.endedAt = now();
    }
    orch.status = status;
    orch.error = error;
    orch.endedAt = now();
    this.journalTasks.delete(orch.id);
    this.persist();
  }

  /**
   * Puts a result of the task's chat on the task. The first one decides how the task ended; a later
   * one comes from someone continuing the chat by hand, and is the task's work all the same.
   */
  private record(orch: Orchestration, task: OrchestrationTaskState, result: RunResult): void {
    // A turn that fails after the work was delivered does not take the delivery back
    if (!result.isError || task.status !== 'completed') {
      task.status = result.isError ? 'failed' : 'completed';
      task.result = result.isError ? null : result.result;
      task.error = result.isError ? result.result : null;
    }
    this.charge(orch, task, result);
    task.endedAt = now();
    if (!result.isError) this.commitTask(orch, task);
  }

  /**
   * Keeps a task on its chat for as long as the chat lives. A stopped worker ends its task failed,
   * but it can be continued by hand, finish the work and commit it on the task's branch; a graph
   * that only heard the first result left that work out of its status, its cost and its branch.
   */
  private follow(chatId: string, result: RunResult): void {
    // A compaction or a note turn on a worker's chat is not the task's work
    if (result.purpose) return;
    const orch = [...this.items.values()].find((o) => o.engine === 'graph' && o.tasks.some((t) => t.runId === chatId));
    const task = orch?.tasks.find((t) => t.runId === chatId);
    // The result of a running task is settle's to record
    if (!orch || !task || task.status === 'running') return;
    // A branch given up stays given up, whatever the chat does; only its cost is still owed. So does a
    // task Claudio or a person ended by stopping its chat (its time limit, a stop): the stop's own result
    // says only that the process ended, and the reason the task carries is the one worth reading
    if (task.status === 'skipped' || (result.cause === 'stopped' && (task.status === 'failed' || task.status === 'stopped'))) {
      this.charge(orch, task, result);
      return this.persist();
    }
    // Waiting for a turn, or behind a task that failed: the chat is not producing this task's work
    if (task.status === 'pending' || task.status === 'blocked') return;
    this.record(orch, task, result);
    if (orch.status === 'running' && !orch.endedAt) return this.schedule(orch);
    if (orch.status === 'waiting') {
      // Work delivered by hand while a person had yet to decide: what waited behind it goes on
      if (task.status === 'completed') {
        orch.status = 'running';
        return this.schedule(orch);
      }
    } else if (orch.status === 'running') {
      // Finishing: the integration may already have passed this task by, so it runs again after
      this.lateArrivals.add(orch.id);
    } else {
      // Someone who stopped the graph is told so until nothing is left undone
      orch.status = orch.tasks.every((t) => t.status === 'completed') ? 'completed' : orch.status === 'stopped' ? 'stopped' : 'failed';
      orch.endedAt = now();
      if (orch.worktree && (orch.integration || orch.status === 'completed')) this.integrateLate(orch);
    }
    this.persist();
  }

  /** Integrates a finished graph again for work that arrived late, after any integration in flight. */
  private integrateLate(orch: Orchestration): void {
    if (orch.integration && ['merging', 'resolving'].includes(orch.integration.status)) this.lateArrivals.add(orch.id);
    else {
      // A graph still running checks its branch itself when it finishes
      void this.integrate(orch).then(() => (orch.status === 'running' ? undefined : this.runChecks(orch)));
    }
  }

  /**
   * Commits what a finished worker left uncommitted. Asked to commit, workers often do not, and
   * work stranded in a worktree is invisible to everything that comes after: its dependants, the
   * integration, a review.
   */
  private commitTask(orch: Orchestration, task: OrchestrationTaskState): void {
    if (!task.worktree || !existsSync(task.worktree)) return;
    try {
      // A worker told to resolve a merge that did not is not the wrapper's to paper over
      if (mergeInProgress(task.worktree) && conflictedPaths(task.worktree).length > 0) return;
      const commit = commitAll(task.worktree, `${task.name}\n\nOrchestration ${orch.name} (${orch.id.slice(0, 8)}), task ${task.id}.`);
      if (commit) task.commit = commit;
    } catch (err) {
      task.error = `the work was left uncommitted: ${(err as Error).message}`;
    }
  }

  /** {@link commitTask} off the event loop, for the integration, which a request (a retried integration) reaches. */
  private async commitTaskAsync(orch: Orchestration, task: OrchestrationTaskState): Promise<void> {
    if (!task.worktree || !existsSync(task.worktree)) return;
    try {
      if ((await mergeInProgressAsync(task.worktree)) && (await conflictedPathsAsync(task.worktree)).length > 0) return;
      const commit = await commitAllAsync(task.worktree, `${task.name}\n\nOrchestration ${orch.name} (${orch.id.slice(0, 8)}), task ${task.id}.`);
      if (commit) task.commit = commit;
    } catch (err) {
      task.error = `the work was left uncommitted: ${(err as Error).message}`;
    }
  }

  /**
   * Builds the one branch a worktree graph delivers: every completed task's branch merged, in
   * dependency order, into `claudio/<name>` from the commit the graph started on. A conflict is
   * handed to an integrator agent in that branch's worktree, and the result is checked rather than
   * trusted. Never throws: whatever happens is recorded on `orch.integration`.
   */
  private async integrate(orch: Orchestration): Promise<void> {
    const tasks = topological(orch.tasks).filter((t) => t.status === 'completed' && t.branch);
    if (tasks.length === 0) return;
    const branch = orch.integration?.branch ?? integrationBranch(orch);
    let root: string;
    let home: string;
    try {
      ({ root, home } = await checkoutOfAsync(orch.cwd));
    } catch {
      root = home = orch.cwd; // no longer a repository: adding the worktree below says so on the record
    }
    const path = worktreePath(home, `${orch.id.slice(0, 8)}-integration`);
    const state: OrchestrationIntegration = (orch.integration = {
      branch,
      worktree: path,
      status: 'merging',
      merged: [],
      conflicts: [],
      commit: null,
      error: null,
      integratorRunId: orch.integration?.integratorRunId ?? null,
      pullRequestUrl: orch.integration?.pullRequestUrl ?? null,
      // A re-integration overwrites both: the phase is the last integration
      startedAt: now(),
      endedAt: null,
    });
    this.persist();
    try {
      // Graphs from before tasks were committed on completion still have their work loose
      for (const task of tasks) await this.commitTaskAsync(orch, task);
      await addWorktreeAsync(root, path, branch, orch.baseCommit ?? 'HEAD');
      if (await mergeInProgressAsync(path)) await abortMergeAsync(path); // a previous attempt stopped half way

      const unmerged: OrchestrationTaskState[] = [];
      for (const task of tasks) {
        const taskBranch = task.branch as string;
        if (!(await branchExistsAsync(root, taskBranch))) continue; // the CLI removes a worktree that changed nothing
        if (await containsAsync(path, taskBranch)) {
          state.merged.push(task.id);
          continue;
        }
        const paths = await mergeAsync(path, taskBranch, `Merge task ${task.id}: ${task.name}`);
        if (!paths) {
          state.merged.push(task.id);
          continue;
        }
        await abortMergeAsync(path);
        state.conflicts.push({ taskId: task.id, paths });
        unmerged.push(task);
      }
      if (unmerged.length > 0) await this.resolveConflicts(orch, state, unmerged);

      const left: OrchestrationTaskState[] = [];
      const present: OrchestrationTaskState[] = [];
      for (const t of tasks) {
        if (!t.branch || !(await branchExistsAsync(root, t.branch))) continue;
        present.push(t);
        if (!(await containsAsync(path, t.branch))) left.push(t);
      }
      if (left.length > 0 || (await mergeInProgressAsync(path)) || (await conflictedPathsAsync(path)).length > 0) {
        state.status = 'conflicted';
        state.error = left.length
          ? `not merged: ${left.map((t) => t.id).join(', ')}`
          : 'the integration branch has an unfinished merge';
      } else {
        state.merged = present.map((t) => t.id);
        state.status = 'merged';
      }
      state.commit = await headCommitAsync(path);
    } catch (err) {
      state.status = 'failed';
      state.error = (err as Error).message;
    }
    state.endedAt = now();
    this.persist();
    // While the graph is finishing, finish() integrates again itself once it is done
    if (orch.status !== 'running' && this.lateArrivals.delete(orch.id)) await this.integrate(orch);
  }

  /** Runs an agent in the integration worktree to merge the branches git could not. */
  private async resolveConflicts(orch: Orchestration, state: OrchestrationIntegration, tasks: OrchestrationTaskState[]): Promise<void> {
    state.status = 'resolving';
    const integrationDir = state.worktree ?? orch.cwd;
    const guards = this.guardPlan(orch, 'integration', integrationDir, state.worktree);
    this.persist();
    // A slot taken now frees within moments: the integration waits for it rather than fail the graph's last step
    const run = await this.whenAdmitted(orch, () => this.runs.start(
      {
        prompt:
          `You are integrating the work of a multi-agent orchestration into one branch.\n` +
          `Objective, as the person wrote it:\n${pasted(orch.objective ?? orch.name)}\n\n` +
          `You are in a git worktree at ${state.worktree}, on branch ${state.branch}, which already contains the work of: ` +
          `${state.merged.join(', ') || 'no task yet'}. Merging these branches conflicted:\n` +
          state.conflicts.map((c) => `- ${orch.tasks.find((t) => t.id === c.taskId)?.branch}: ${c.paths.join(', ')}`).join('\n') +
          `\n\nMerge each of them into ${state.branch}, in this order, with \`git merge --no-ff\`:\n` +
          tasks.map((t) => `- ${t.branch}`).join('\n') +
          '\n\nResolve every conflict so that the intent of both sides survives; read the code on each branch to ' +
          'understand it. Commit each merge. Do not push, and do not change anything beyond what resolving needs. ' +
          'Finish with a short report of how each conflict was resolved.\n\n' +
          `${REAL_VERIFICATION}\n\n${UNATTENDED}\n\n${PASTED_NOTE}\n\n` +
          'What each task did:\n' +
          tasks.map((t) => taskBlock(t, (t.result ?? '').slice(0, MAX_DEP_CONTEXT))).join('\n'),
        cwd: integrationDir,
        ...(guards ? { guards } : {}),
        model: orch.model ?? undefined,
        ...effortOption(resolveEffort('worker', orch.model, orch.effort)),
        permissionMode: orch.permissionMode,
        // These rules are Claude Code's, so a default provider set to another one never receives them
        provider: 'claude-code',
        // Merging is git work; without it the integrator could only describe the conflicts
        allowedTools: rulesFor('claude-code', INTEGRATION_POLICY, { allowedTools: orch.allowedTools }).allowedTools,
        disallowedTools: [...PUSH_DENIED],
        ...(orch.permissionPrompts === 'host' ? { permissionPrompts: 'host' as const } : {}),
        name: `${orch.name}:integration`.slice(0, 60),
        purpose: 'integrator',
        keepAlive: false,
      },
      { orchestrationId: orch.id, orchestrationTaskId: '__integration__' },
    ));
    state.integratorRunId = run.id;
    this.persist();
    const result = await this.runs.waitForResult(run.id);
    orch.costUsd += result.costUsd;
    if (result.isError) state.error = `integrator: ${result.result}`;
  }

  private async finish(orch: Orchestration): Promise<void> {
    if (orch.status !== 'running' || orch.endedAt) return;
    orch.endedAt = now(); // guards against re-entry while integration and synthesis run

    if (orch.worktree) await this.integrate(orch);
    if (orch.status !== 'running') return; // stopped meanwhile
    await this.runChecks(orch);
    if (orch.status !== 'running') return;
    if (orch.synthesize && orch.tasks.some((t) => t.status === 'completed')) await this.synthesize(orch);
    // Read at the end: a task continued by hand can fail or complete while the graph is finishing. A
    // branch given up is a decision, not a failure, so the graph finishes without it.
    if (orch.status === 'running') {
      const byChecks = checksFailGraph(orch);
      orch.status = tasksUndone(orch) || byChecks ? 'failed' : 'completed';
      if (byChecks) orch.error = byChecks;
    }
    orch.endedAt = now();
    this.persist();
    if (this.lateArrivals.delete(orch.id) && orch.worktree) this.integrateLate(orch);
  }

  private async synthesize(orch: Orchestration): Promise<void> {
    const integration = orch.integration;
    const onBranch = integration?.status === 'merged' && integration.worktree && existsSync(integration.worktree);
    orch.synthesisStartedAt = now();
    orch.synthesisEndedAt = null;
    try {
      const synthesisDir = onBranch ? this.integratedDir(orch, integration.worktree as string) : orch.cwd;
      const guards = this.guardPlan(orch, 'synthesis', synthesisDir, onBranch ? synthesisDir : null);
      const run = await this.whenAdmitted(orch, () => this.runs.start(
        {
          prompt:
            `Synthesize the results of a multi-agent orchestration into one final report.\n` +
            `Objective, as the person wrote it:\n${pasted(orch.objective ?? orch.name)}\n\n` +
            (onBranch
              ? `All of the tasks' work has been merged into branch ${integration.branch}, checked out in your working ` +
                'directory. Describe what is actually there and anything still missing; do not merge, push or open pull requests.\n\n'
              : integration
                ? `Merging the tasks' branches into ${integration.branch} did not finish (${integration.error ?? integration.status}). Say so in the report.\n\n`
                : '') +
            (orch.verification && orch.verification.status !== 'pending'
              ? `Verification of the merged branch: ${orch.verification.status}.\n${pasted(orch.verification.report)}\n\n`
              : '') +
            (orch.tasks.some((t) => t.status === 'skipped')
              ? 'Tasks marked skipped were given up on purpose by a person: say what is missing because of them.\n\n'
              : '') +
            `${PASTED_NOTE}\n\n` +
            orch.tasks
              .map((t) => taskBlock(t, (t.result ?? t.error ?? '').slice(0, MAX_DEP_CONTEXT), t.status))
              .join('\n'),
          cwd: synthesisDir,
          ...(guards ? { guards } : {}),
          model: orch.model ?? undefined,
          ...effortOption(resolveEffort('worker', orch.model, orch.effort)),
          permissionMode: orch.permissionMode,
          name: `${orch.name}:synthesis`.slice(0, 60),
          purpose: 'synthesis',
          disallowedTools: [...PUSH_DENIED],
          keepAlive: false,
        },
        { orchestrationId: orch.id, orchestrationTaskId: '__synthesis__' },
      ));
      // Kept so the report can be answered: it is a conversation like any other
      orch.synthesisRunId = run.id;
      this.persist();
      const result = await this.runs.waitForResult(run.id);
      orch.finalResult = result.isError ? `Synthesis failed: ${result.result}` : result.result;
      orch.costUsd += result.costUsd;
    } catch (err) {
      orch.finalResult = `Synthesis failed: ${(err as Error).message}`;
    }
    orch.synthesisEndedAt = now();
  }

  /** The graph's subdirectory inside the integration worktree, where the workers worked too. */
  private integratedDir(orch: Orchestration, worktree: string): string {
    const dir = join(worktree, checkoutOf(orch.cwd).subdir);
    return existsSync(dir) ? dir : worktree;
  }

  // ---------- verification ----------

  /**
   * Runs the checks of a graph that is over on its integration branch, or runs them again: after a
   * fix made by hand, or on a graph launched without any. Returns at once, with the checks running;
   * their outcome lands on the orchestration.
   */
  verify(id: string, req: VerifyOrchestrationRequest = {}): Orchestration {
    const orch = this.items.get(id);
    if (!orch) throw new NotFoundError('orchestration not found');
    if (orch.status === 'running' || orch.status === 'waiting') throw new Error('the checks run when the graph finishes: wait for it, or stop it first');
    if (orch.engine !== 'graph' || !orch.worktree) throw new Error('verification runs on the integration branch, which needs the graph engine with a worktree per task');
    if (this.verifying.has(orch.id)) throw new Error('the checks are already running');
    if (orch.integration?.status !== 'merged') throw new Error('the orchestration has no integrated branch yet');
    const spec = req.verification !== undefined ? normalizeVerification(req.verification) : (orch.verificationSpec ?? null);
    if (!spec) throw new Error('there are no checks to run: give them as verification');
    orch.verificationSpec = spec;
    // Asked for by hand, so they run even where they passed before
    orch.verification = null;
    void this.runChecks(orch);
    return orch;
  }

  /** Stops the checks that are running, and the fixer if one is at work. */
  private cancelChecks(id: string): void {
    const control = this.verifying.get(id);
    if (!control) return;
    control.cancelled = true;
    for (const handle of control.commands) handle.cancel();
    if (control.fixerRunId && this.runs.get(control.fixerRunId)) this.runs.stop(control.fixerRunId);
    // The round stops its own runs when aborted; the ones already started are stopped here too
    control.abort.abort();
    for (const runId of control.reviewRunIds) if (this.runs.get(runId)) this.runs.stop(runId);
  }

  /**
   * The verification phase: the graph's checks, in order, on the integration branch, once every
   * task is merged. A failing check goes to a fixer agent if the graph asked for one. After a fix
   * the check that failed runs alone first, so a fix that did not work is known at once; once it
   * passes every check runs again from the first, because a fix for one can break another. What comes
   * out is recorded on `orch.verification` whatever happens; this never throws.
   */
  private async runChecks(orch: Orchestration): Promise<void> {
    await this.checkBranch(orch);
    this.settleByChecks(orch);
  }

  /**
   * What checks run again outside `finish()` (by hand, after a late integration) do to a graph
   * launched with `failGraph`: failing them fails a completed graph, and passing them gives back
   * the completion that only they had taken away. A running graph is `finish()`'s to decide.
   */
  private settleByChecks(orch: Orchestration): void {
    if (orch.status === 'running' || orch.status === 'waiting') return;
    const v = orch.verification;
    if (!v || v.status === 'running' || v.status === 'pending') return;
    const byChecks = checksFailGraph(orch);
    if (byChecks && (orch.status === 'completed' || orch.error)) {
      orch.status = 'failed';
      orch.error = byChecks;
    } else if (!byChecks && orch.error) {
      orch.error = null;
      if (orch.status === 'failed' && !tasksUndone(orch)) orch.status = 'completed';
    }
    this.persist();
  }

  private async checkBranch(orch: Orchestration): Promise<void> {
    const spec = orch.verificationSpec;
    if (!spec || orch.engine !== 'graph' || this.verifying.has(orch.id)) return;
    const integration = orch.integration;
    const before = orch.verification;
    if (!integration || integration.status !== 'merged' || !integration.worktree || !existsSync(integration.worktree)) {
      const why = integration ? `the work was not merged into ${integration.branch} (${integration.error ?? integration.status})` : 'no task left work to merge';
      const at = now();
      orch.verification = {
        status: 'failed',
        startedAt: at,
        endedAt: at,
        fixes: [],
        attempts: 0,
        // Only a given install is known here: detecting one needs the worktree that is not there
        commands: [...(typeof spec.install === 'string' ? [{ ...pendingCommand(spec.install), install: true }] : []), ...checkRows(spec)],
        commits: [],
        commit: null,
        report: `Not run: ${why}.`,
        costUsd: 0,
      };
      this.persist();
      return;
    }
    // What passed on this very head does not need to run again; with the gate on, the review must have too
    if (
      before &&
      (before.status === 'passed' || before.status === 'fixed') &&
      before.commit === integration.commit &&
      (!spec.review || ((before.review?.status === 'passed' || before.review?.status === 'accepted') && before.review.head === integration.commit))
    ) {
      return;
    }

    const root = integration.worktree;
    const control: VerificationControl = { cancelled: false, commands: new Set(), fixerRunId: null, reviewRunIds: new Set(), abort: new AbortController() };
    const state: VerificationState = (orch.verification = {
      status: 'running',
      startedAt: now(),
      endedAt: null,
      fixes: [],
      attempts: 0,
      commands: checkRows(spec),
      commits: [],
      commit: integration.commit,
      report: '',
      costUsd: 0,
      ...(spec.review ? { review: this.reviewState(spec.review) } : {}),
    });
    // Taken inside the try: a step that throws before the checks start (git reading the head, the
    // install's detection) must still let go of the graph, or it refuses verify, resume, remove and
    // retry with "checks are running" until a restart
    try {
      this.verifying.set(orch.id, control);
      const startHead = await headCommitAsync(root);
      state.commit = startHead;
      // A repository reviewed with no checks has nothing to install for
      const install = spec.commands.length === 0 ? null : installStep(spec, root, this.integratedDir(orch, root));
      if (install) state.commands = [{ ...pendingCommand(install.command), install: true }, ...state.commands];
      this.persist();
      await this.checkAll(orch, spec, state, root, startHead, install, control);
      if (spec.review && state.review) {
        if (state.status === 'passed' || state.status === 'fixed') {
          if (control.cancelled) {
            state.status = 'failed';
            state.gate = 'review';
            state.review = this.reviewState(spec.review, { status: 'incomplete', reason: 'stopped', endedAt: now() });
          } else await this.reviewLoop(orch, spec, state, root, startHead, install, control, { status: state.status, report: state.report });
        } else {
          state.gate = 'checks';
          state.review = this.reviewState(spec.review, { status: 'skipped', reason: 'the checks failed, so the review did not run' });
        }
      }
    } catch (err) {
      const rs = state.review;
      const reviewing = rs?.status === 'running';
      state.status = 'failed';
      state.report = `${reviewing ? 'The review' : 'The checks'} could not run: ${(err as Error).message}`;
      if (rs) {
        state.gate = reviewing ? 'review' : 'checks';
        rs.status = reviewing ? 'incomplete' : 'skipped';
        rs.phase = null;
        rs.reason = state.report;
      }
    } finally {
      this.verifying.delete(orch.id);
    }
    try {
      state.commit = await headCommitAsync(root);
      // What the fixer committed is part of the branch now
      integration.commit = state.commit;
    } catch {
      // the worktree is gone; the outcome stands without a commit
    }
    state.endedAt = now();
    this.persist();
  }

  private async checkAll(
    orch: Orchestration,
    spec: VerificationSpec,
    state: VerificationState,
    root: string,
    startHead: string,
    install: InstallStep | null,
    control: VerificationControl,
  ): Promise<void> {
    const minutes = spec.timeoutMinutes ?? DEFAULT_VERIFY_MINUTES;
    const dir = this.integratedDir(orch, root);
    const steps = verificationSteps(state.commands);
    const spent = state.commands.map(() => 0);
    // What each fixer attempt said, and which checks it was at: an attempt at a group is at each of them
    const notes: { covers: ReadonlySet<number>; note: string }[] = [];
    const mended = new Set<number>();
    // What each failed check looked like the last time it failed: its signature, its error count (null
    // when unknown) and how many failures in a row had that signature. A check that passes is forgotten
    const observed = new Map<number, { signature: string | null; count: number | null; streak: number }>();
    // A fixer's own `[STOP]` is kept until the checks have run again, since a fix that passed still counts
    let fixerStop: { kind: FixStopKind; note: string } | null = null;
    const conclude = (status: 'passed' | 'fixed' | 'failed', headline: string) => {
      state.status = status;
      const left = state.commands.filter((c) => c.status === 'pending').map((c) => c.command);
      state.report = [headline, left.length ? `Not run: ${left.map((c) => `\`${c}\``).join(', ')}.` : ''].filter(Boolean).join(' ');
    };

    const everyStep = steps.map((_, k) => k);
    // The steps this stretch runs, in order: all of them, or after a fix the probe (the step that
    // failed, and the install when the fix touched what it reads) ahead of the full pass
    let queue = everyStep;
    let probing = false;
    let q = 0;
    // Goes up each time a fix sends every check back to pending, so each run says which pass it was
    // A run after a review fix continues the numbering, so the history says which pass each run was
    let pass = Math.max(0, ...state.commands.flatMap((c) => (c.runs ?? []).map((r) => r.pass))) + 1;
    while (q < queue.length) {
      const s = queue[q] as number;
      const step = steps[s] as number[];
      for (const i of step) (state.commands[i] as VerificationCommand).status = 'running';
      this.persist();
      // A group runs at once and is waited for whole, so every failure in it is known before the fixer starts
      const outcomes = await Promise.all(
        step.map(async (i) => {
          const entry = state.commands[i] as VerificationCommand;
          let handle: CommandHandle | null = null;
          const startedAt = now();
          const outcome = await runCommand(entry.command, entry.install && install ? install.cwd : dir, minutes * 60_000, (h) => {
            handle = h;
            control.commands.add(h);
            // A stop that came while its siblings were starting finds this one too
            if (control.cancelled) h.cancel();
          }, orch.id);
          if (handle) control.commands.delete(handle);
          entry.output = outcome.output;
          entry.durationMs = outcome.durationMs;
          // History, not a replacement: a failing run a fix mended is what the timings are after
          (entry.runs ??= []).push({
            pass,
            ...(probing ? { probe: true as const } : {}),
            startedAt,
            durationMs: outcome.durationMs,
            status: outcome.ok && !control.cancelled ? 'passed' : 'failed',
            ...(outcome.timedOut ? { timedOut: true } : {}),
            ...(outcome.cancelled || control.cancelled ? { cancelled: true } : {}),
          });
          if (!control.cancelled) entry.status = outcome.ok ? (mended.has(i) ? 'fixed' : 'passed') : 'failed';
          this.persist();
          return { i, outcome };
        }),
      );
      if (control.cancelled) {
        for (const { i, outcome } of outcomes) if (!outcome.ok) (state.commands[i] as VerificationCommand).status = 'failed';
        return conclude('failed', 'Stopped before the checks finished.');
      }
      const failed = outcomes
        .filter(({ outcome }) => !outcome.ok)
        .map(({ i, outcome }) => ({
          i,
          outcome,
          why: outcome.timedOut ? `timed out after ${String(minutes)} min and was killed` : `exited with code ${String(outcome.exitCode ?? 'unknown')}`,
        }));
      if (failed.length === 0) {
        q += 1;
        if (probing && q >= queue.length) {
          // What failed passes now; the head still has to pass every check together, from the first
          probing = false;
          queue = everyStep;
          q = 0;
          for (const c of state.commands) c.status = 'pending';
        }
        continue;
      }

      const named = failed.map((f) => `\`${(state.commands[f.i] as VerificationCommand).command}\` ${f.why}`).join('; ');
      const seen = failed.map((f) => {
        const entry = state.commands[f.i] as VerificationCommand;
        const signature = failureSignature(entry.output);
        // A timeout prints no summary, so only the signature can be compared after one
        const count = f.outcome.timedOut ? null : errorCount(entry.command, entry.output);
        const before = observed.get(f.i);
        const streak = signature !== null && before?.signature === signature ? before.streak + 1 : 1;
        observed.set(f.i, { signature, count, streak });
        return { f, entry, count, before, streak };
      });
      for (const i of [...observed.keys()]) if (!failed.some((f) => f.i === i) && (state.commands[i] as VerificationCommand).status !== 'pending') observed.delete(i);
      if (!spec.fixer) return conclude('failed', `${named}. The fixer is off, so nothing was changed.`);
      const spentOut = failed.filter((f) => (spent[f.i] ?? 0) >= spec.maxAttempts);
      if (spentOut.length) {
        const last = notes.filter((n) => spentOut.some((f) => n.covers.has(f.i))).at(-1)?.note;
        const times = Math.max(...spentOut.map((f) => spent[f.i] ?? 0));
        return conclude(
          'failed',
          `${spentOut.map((f) => `\`${(state.commands[f.i] as VerificationCommand).command}\` ${f.why}`).join('; ')} again after ${String(times)} fixer attempt${times === 1 ? '' : 's'}, so Claudio stopped there.` +
            (last ? ` The last thing the fixer said: ${last}` : ''),
        );
      }
      // The CLI's ceiling is per process, so each attempt gets what the fixer has left, not all of it again
      const left = spec.maxCostUsd === undefined ? null : spec.maxCostUsd - state.costUsd;
      if (left !== null && left <= 0) {
        return conclude(
          'failed',
          `${named}, and the fixer's cost limit of ${usd(spec.maxCostUsd ?? 0)} is spent (${usd(state.costUsd)} over ${String(state.attempts)} attempt${state.attempts === 1 ? '' : 's'}), so Claudio stopped there.`,
        );
      }
      // Code's own stop rules, before the decision point is asked about the same thing
      const lastFix = state.fixes?.at(-1);
      const stopWith = (kind: FixStopKind, note: string, report: string) => {
        if (lastFix) lastFix.stop = { kind, note, by: 'claudio' };
        this.persist();
        return conclude('failed', report);
      };
      if (fixerStop) {
        return conclude('failed', `${named}. The fixer stopped: ${fixerStop.note}. Claudio made no further attempt.`);
      }
      const worse = seen.find((x) => x.before?.count != null && x.count !== null && x.count > x.before.count);
      if (worse && worse.before?.count != null && worse.count !== null) {
        const made = state.commits.length;
        return stopWith(
          'more-errors',
          `\`${worse.entry.command}\`: ${String(worse.count)} errors after attempt ${String(state.attempts)}, ${String(worse.before.count)} before`,
          `${named}. Attempt ${String(state.attempts)} left more errors in \`${worse.entry.command}\` (${String(worse.count)}) than before it (${String(worse.before.count)}), so Claudio stopped there.` +
            (made ? ` What the fixer committed stays on the branch, unreverted: ${state.commits.map((c) => c.subject).join('; ')}.` : ''),
        );
      }
      const same = seen.find((x) => x.streak > SAME_ERROR_ATTEMPTS);
      if (same) {
        const made = state.commits.length;
        return stopWith(
          'same-error',
          `\`${same.entry.command}\` failed with the same error after ${String(SAME_ERROR_ATTEMPTS)} attempts`,
          `${named}. The same error survived ${String(SAME_ERROR_ATTEMPTS)} fixer attempts in \`${same.entry.command}\`, so Claudio stopped there.` +
            (made ? ` What the fixer committed is on the branch: ${state.commits.map((c) => c.subject).join('; ')}.` : ''),
        );
      }
      // Asked once per failed step, with all of its failed checks; "stop" only ends the fixing, and the checks stay failed
      if (await this.fixerGivenUp(orch, state, failed, notes, spent)) {
        const last = notes.filter((n) => failed.some((f) => n.covers.has(f.i))).at(-1)?.note;
        return conclude(
          'failed',
          `${named}, and the decision engine judged another fixer attempt unlikely to help, so Claudio stopped there after ${String(state.attempts)} attempt${state.attempts === 1 ? '' : 's'}.` +
            (last ? ` The last thing the fixer said: ${last}` : ''),
        );
      }
      // One attempt for the whole group, counted against each check it is at
      for (const f of failed) spent[f.i] = (spent[f.i] ?? 0) + 1;
      state.attempts += 1;
      this.persist();
      const covers = new Set(failed.map((f) => f.i));
      const earlier = notes.filter((n) => [...covers].some((i) => n.covers.has(i))).map((n) => n.note);
      const headBeforeFix = headOrNull(root);
      const attempt = await this.fix(
        orch,
        spec,
        state,
        root,
        dir,
        failed.map((f) => ({ index: f.i, failure: f.why })),
        [...new Set(failed.flatMap((f) => f.outcome.failedSpecs))].slice(0, MAX_FAILED_SPECS),
        Math.max(...failed.map((f) => spent[f.i] ?? 0)),
        earlier,
        left,
        control,
      );
      if (attempt.notStarted !== null) {
        // A fixer that never started is not an attempt: what the checks are owed is said as it is
        for (const f of failed) spent[f.i] = Math.max(0, (spent[f.i] ?? 1) - 1);
        state.attempts -= 1;
        if (control.cancelled) return conclude('failed', 'Stopped before the checks finished.');
        return conclude('failed', `${named}, and the fixer could not start (${attempt.notStarted}), so Claudio stopped there.`);
      }
      notes.push({ covers, note: attempt.note });
      fixerStop = attempt.stop;
      state.commits = commitsSince(root, startHead);
      if (control.cancelled) return conclude('failed', 'Stopped before the checks finished.');
      if (attempt.budget) {
        const made = state.commits.length;
        return conclude(
          'failed',
          `${named}, and the fixer's cost limit of ${usd(spec.maxCostUsd ?? 0)} ran out during attempt ${String(state.attempts)} (${usd(state.costUsd)} spent), so Claudio stopped there without checking again.` +
            (made ? ` What the fixer committed is on the branch, unchecked: ${state.commits.map((c) => c.subject).join('; ')}.` : ''),
        );
      }
      for (const f of failed) mended.add(f.i);
      // A fix for one check can break another, so every check runs again from the first. Before that
      // the step that failed runs alone: if the fix did not mend it, the fixer hears so now and not
      // after a whole pass. Nothing is skipped; the probe is an extra run.
      for (const c of state.commands) c.status = 'pending';
      const reinstall = s !== 0 && state.commands[0]?.install === true && touchedDependencies(root, headBeforeFix, headOrNull(root));
      const probe = reinstall ? [0, s] : [s];
      // A probe of the first step is the first step of the full pass already
      probing = !(probe.length === 1 && s === 0);
      queue = probing ? probe : everyStep;
      q = 0;
      pass += 1;
    }

    if (state.commands.length === 0) return conclude('passed', 'No checks are set; the review gate decides.');
    if (mended.size === 0) return conclude('passed', `All ${String(state.commands.length)} checks passed on the merged branch.`);
    const made = state.commits.length;
    conclude(
      'fixed',
      `${String(mended.size)} check${mended.size === 1 ? '' : 's'} failed and ${mended.size === 1 ? 'was' : 'were'} fixed in ${String(state.attempts)} attempt${state.attempts === 1 ? '' : 's'}, ` +
        (made ? `with ${String(made)} commit${made === 1 ? '' : 's'} on the branch: ${state.commits.map((c) => c.subject).join('; ')}. ` : 'without a commit: the re-run passed on its own. ') +
        `All ${String(state.commands.length)} checks pass now.`,
    );
  }

  /**
   * `orchestration.fixer`: whether the decision, active and above its threshold, says another fixer
   * attempt will not make the failed checks of this step pass. Shadow and every other outcome leave
   * the fixer to run as today.
   */
  private async fixerGivenUp(
    orch: Orchestration,
    state: VerificationState,
    failed: ReadonlyArray<{ i: number; outcome: { failedSpecs: string[] }; why: string }>,
    notes: ReadonlyArray<{ covers: ReadonlySet<number>; note: string }>,
    spent: readonly number[],
  ): Promise<boolean> {
    const projectId = this.projectIdOf(orch.cwd);
    const stance = stanceOf(this.decisions, 'orchestration.fixer', projectId);
    if (stance === 'off') return false;
    const attempt = Math.max(...failed.map((f) => spent[f.i] ?? 0)) + 1;
    const checks = failed.map((f) => {
      const entry = state.commands[f.i] as VerificationCommand;
      return { id: String(f.i), command: entry.command, failure: `It ${f.why}.`, output: tail(entry.output, MAX_DECISION_TEXT) };
    });
    const earlier = notes.filter((n) => failed.some((f) => n.covers.has(f.i))).map((n) => tail(n.note, MAX_DECISION_TEXT));
    const asked = this.ask(
      'orchestration.fixer',
      {
        kind: 'task',
        id: `${orch.id}:__verification__`,
        data: {
          checks,
          failedSpecs: [...new Set(failed.flatMap((f) => f.outcome.failedSpecs))].slice(0, MAX_FAILED_SPECS),
          notes: earlier,
          attempt: `${ORDINALS[attempt - 1] ?? 'a later'} attempt`,
        },
      },
      projectId,
    );
    if (stance === 'watch') {
      this.track(asked);
      return false;
    }
    const answer = (await asked)?.answers?.['another-attempt'];
    return answer?.kind === 'noul' && !answer.value;
  }

  /**
   * One attempt of the fixer at the checks of one step that failed (one, or several of a parallel
   * group): what it reported, trimmed, and whether its cost limit ended it.
   */
  private async fix(
    orch: Orchestration,
    spec: VerificationSpec,
    state: VerificationState,
    root: string,
    dir: string,
    failures: { index: number; failure: string }[],
    failedSpecs: string[],
    attemptNumber: number,
    earlier: string[],
    budgetUsd: number | null,
    control: VerificationControl,
  ): Promise<{ note: string; budget: boolean; stop: { kind: FixStopKind; note: string } | null; notStarted: string | null }> {
    const checks = failures.map(({ index, failure }) => {
      const entry = state.commands[index] as VerificationCommand;
      return { command: entry.command, failure: `It ${failure}.`, output: entry.output };
    });
    let note: string;
    let budget = false;
    let stop: { kind: FixStopKind; note: string } | null = null;
    // One attempt can be at a parallel group's failed checks: the record names every one
    const record: VerificationFix = { runId: null, command: checks.map((c) => c.command).join('; '), attempt: state.attempts, startedAt: now(), endedAt: null, costUsd: 0 };
    (state.fixes ??= []).push(record);
    let run: ChatRuntime;
    try {
      const guards = this.guardPlan(orch, 'verification-fixer', dir, dir);
      // A slot taken now frees within moments; the wait is bounded by the checks' own time and ended by a stop
      run = await startWhenAdmitted(() => this.runs.start(
        {
          prompt: fixerPrompt({
            objective: orch.objective ?? orch.name,
            branch: orch.integration?.branch ?? '',
            worktree: root,
            commands: commandsInOrder(state.commands),
            failed: checks,
            ...(failedSpecs.length ? { failedSpecs } : {}),
            attempt: attemptNumber,
            maxAttempts: spec.maxAttempts,
            earlier,
            tasks: orch.tasks
              .filter((t) => t.status === 'completed')
              .map((t) => ({ id: t.id, name: t.name, result: (t.result ?? '').slice(0, MAX_DEP_CONTEXT) })),
            timeoutMinutes: spec.timeoutMinutes ?? DEFAULT_VERIFY_MINUTES,
          }),
          cwd: dir,
          ...(guards ? { guards } : {}),
          model: spec.model ?? orch.model ?? undefined,
          ...effortOption(resolveEffort('fixer', spec.model ?? orch.model, spec.effort)),
          permissionMode: orch.permissionMode,
          // These rules are Claude Code's, so a default provider set to another one never receives them
          provider: 'claude-code',
          // Building and running tests is the job, so it may run commands; the graph asked for a fixer
          allowedTools: rulesFor('claude-code', VERIFICATION_POLICY, { allowedTools: orch.allowedTools }).allowedTools,
          disallowedTools: [...PUSH_DENIED],
          ...(orch.permissionPrompts === 'host' ? { permissionPrompts: 'host' as const } : {}),
          name: `${orch.name}:verification`.slice(0, 60),
          purpose: 'fixer',
          keepAlive: false,
          // The CLI ends the turn itself when this is spent
          ...(budgetUsd !== null ? { maxBudgetUsd: budgetUsd } : {}),
        },
        { orchestrationId: orch.id, orchestrationTaskId: '__verification__' },
      ), { signal: control.abort.signal, deadline: Date.now() + (spec.timeoutMinutes ?? DEFAULT_VERIFY_MINUTES) * 60_000 });
    } catch (err) {
      // Never started: not an attempt, and nothing it could have left behind to commit
      state.fixes = state.fixes.filter((f) => f !== record);
      const why = control.cancelled ? 'stopped' : isTransientRefusal(err) ? `no place came free in time (${err.message})` : (err as Error).message;
      return { note: `the fixer could not start: ${why}`, budget: false, stop: null, notStarted: why };
    }
    try {
      control.fixerRunId = run.id;
      // Kept past the attempt, so the fixer's chat stays findable from the graph
      record.runId = run.id;
      record.effort = usedEffort(run);
      this.persist();
      const result = await this.runs.waitForResult(run.id);
      orch.costUsd += result.costUsd;
      state.costUsd += result.costUsd;
      record.costUsd = result.costUsd;
      budget = result.cause === 'budget';
      note = budget ? 'its cost limit ran out before it finished' : result.isError ? `the fixer ended with an error: ${result.result}` : result.result;
      // Read from the whole report: the rows are at its end, which `tail` below would keep but a long one could cut
      if (!result.isError) {
        const report = parseFixerReport(result.result);
        if (report.fixed.length) record.fixed = report.fixed;
        if (report.stop) {
          stop = report.stop;
          record.stop = { ...report.stop, by: 'fixer' };
        }
      }
    } catch (err) {
      note = `the fixer could not run: ${(err as Error).message}`;
    }
    record.endedAt = now();
    control.fixerRunId = null;
    try {
      // Asked to commit, agents often do not: what is left would be lost to the pull request
      const named = checks.map((c) => `\`${c.command}\``).join(', ');
      commitAll(root, `chore: keep what the verification fixer left uncommitted\n\nOrchestration ${orch.name} (${orch.id.slice(0, 8)}), check${checks.length === 1 ? '' : 's'} ${named}.`);
    } catch {
      // the fixer left the tree in a state git will not commit; the re-run says whether it matters
    }
    return { note: tail(note, 1500), budget, stop, notStarted: null };
  }


  // ---------- review gate ----------

  private reviewStore(): ReviewStore {
    return (this.reviews ??= new ReviewStore(this.db.connection));
  }

  /** The directory the review runs read: what the workers worked in, inside the integration worktree */
  private reviewHost(orch: Orchestration, control: VerificationControl): ReviewHost {
    return {
      start: (req) => {
        const run = this.runs.start(
          {
            prompt: req.prompt,
            cwd: req.cwd,
            model: req.model,
            ...effortOption(resolveEffort('reviewer', req.model, null)),
            provider: 'claude-code',
            // Never the graph's mode: `--restricted` refuses bypassPermissions
            permissionMode: 'dontAsk',
            permissionPrompts: 'none',
            confine: { tools: [...REVIEW_TOOLS], settingSources: [] },
            mcp: { servers: [] },
            // The reviewer holds no credential to call Claudio back with
            api: false,
            ...(req.agent ? { agent: req.agent } : {}),
            ...(req.agentsFile ? { agentsFile: req.agentsFile } : {}),
            ...(req.appendSystemPrompt ? { appendSystemPrompt: req.appendSystemPrompt } : {}),
            jsonSchema: req.jsonSchema,
            maxBudgetUsd: req.maxBudgetUsd,
            maxTurns: req.maxTurns,
            keepAlive: false,
            systemPromptSnapshot: 'off',
            purpose: 'orchestration',
            name: `${orch.name}:${req.name}`.slice(0, 60),
          },
          { orchestrationId: orch.id, orchestrationTaskId: REVIEW_CHAT_ROLE },
        );
        control.reviewRunIds.add(run.id);
        return run.id;
      },
      waitForResult: (id) => this.runs.waitForResult(id),
      nextResult: (id) => this.runs.nextResult(id),
      stop: (id) => {
        if (this.runs.get(id)) this.runs.stop(id);
      },
      limitHeld: (id) => this.limitHeld?.(id) ?? false,
      waitOf: (id) => this.waitOf?.(id) ?? null,
    };
  }

  /** The depth of a review the graph did not fix: `review.depth` decides, and off or shadow means full */
  private async reviewDepth(orch: Orchestration, spec: ReviewGateSpec, root: string, base: string, head: string): Promise<'light' | 'full'> {
    if (spec.depth) return spec.depth;
    const projectId = this.projectIdOf(orch.cwd);
    const stance = stanceOf(this.decisions, 'review.depth', projectId);
    if (stance === 'off') return 'full';
    let data: Record<string, unknown>;
    try {
      const diff = collectReviewDiff<ScanFinding>({ worktree: root, base, head, ...(spec.exclude ? { exclude: spec.exclude } : {}), depth: 'full' });
      const scan = diff.files.filter((f) => f.class !== 'excluded').map((f) => ({ path: f.path, added: f.added }));
      data = {
        files: diff.stats.files,
        added: diff.stats.additions,
        deleted: diff.stats.deletions,
        paths: diff.files.slice(0, REVIEW_DEPTH_PATHS).map((f) => f.path),
        securityHit: securityTriggered(scan),
        dimensions: ['correctness', 'tests', 'security', 'conventions'].filter((d) => d !== 'security' || spec.dimensions?.security !== 'off'),
        estimateUsd: Math.round(estimateRoundUsd(diff.chunks, 3) * 100) / 100,
      };
    } catch {
      return 'full';
    }
    const asked = this.ask('review.depth', { kind: 'task', id: `${orch.id}:${REVIEW_CHAT_ROLE}`, data }, projectId);
    if (stance === 'watch') {
      this.track(asked);
      return 'full';
    }
    const answer = (await asked)?.answers?.depth;
    return answer?.kind === 'choice' && answer.value === 'light' ? 'light' : 'full';
  }

  private reviewState(spec: ReviewGateSpec, patch: Partial<ReviewGateState> = {}): ReviewGateState {
    return {
      status: 'pending',
      phase: null,
      round: 0,
      maxFixRounds: spec.maxFixRounds ?? REVIEW_DEFAULTS.maxFixRounds,
      head: null,
      startedAt: null,
      endedAt: null,
      costUsd: 0,
      reason: null,
      counts: { blocking: 0, advisory: 0, refuted: 0, outside: 0 },
      runs: { total: 0, done: 0, running: 0, failed: 0 },
      depth: spec.depth ?? 'full',
      ...patch,
    };
  }

  /**
   * The review gate's rounds after the checks passed: review, and when it blocks, fix, run every check
   * again from the first, and review the whole branch again. The verification stays `running` while
   * this works; it ends `passed`/`fixed` only when the review passed, and `failed` with `gate:
   * 'review'` otherwise (D6).
   */
  private async reviewLoop(
    orch: Orchestration,
    spec: VerificationSpec,
    state: VerificationState,
    root: string,
    startHead: string,
    install: InstallStep | null,
    control: VerificationControl,
    checks: { status: 'passed' | 'fixed'; report: string },
  ): Promise<void> {
    const review = spec.review as ReviewGateSpec;
    const integration = orch.integration as OrchestrationIntegration;
    const store = this.reviewStore();
    const dir = this.integratedDir(orch, root);
    const maxFix = review.maxFixRounds ?? REVIEW_DEFAULTS.maxFixRounds;
    const budget = review.maxCostUsd ?? REVIEW_DEFAULTS.maxCostUsd;
    const rs = (state.review = this.reviewState(review, { status: 'running', phase: 'preparing', startedAt: now() }));
    state.status = 'running';
    delete state.gate;
    this.persist();
    const finish = (status: 'passed' | 'blocked' | 'incomplete', reason: string) => {
      rs.status = status;
      rs.phase = null;
      rs.waiting = null;
      rs.reason = reason;
      rs.endedAt = now();
      if (status === 'passed') {
        state.status = checks.status;
        state.report = `${checks.report} Review passed: ${reason}`;
      } else {
        state.status = 'failed';
        state.gate = 'review';
        state.report = `The review ${status === 'blocked' ? 'blocked the branch' : 'did not finish'}: ${reason}`;
      }
      this.persist();
    };
    let pass = 1;
    try {
      pass = Math.max(0, ...store.rounds(orch.id).map((r) => r.pass)) + 1;
    } catch {
      // the first pass
    }
    let base = orch.baseCommit;
    if (!base) {
      try {
        base = orch.baseCommit = this.forkPoint(orch);
      } catch {
        return finish('incomplete', 'no base commit');
      }
    }
    let carry: ReviewFinding[] = [];
    let fixerNote: string | null = null;
    let previousBlocking: ReviewFinding[] | null = null;
    let changedByFixer = new Set<string>();
    let depth: 'light' | 'full' = review.depth ?? 'full';
    for (let round = 1; round <= maxFix + 1; round += 1) {
      if (control.cancelled) return finish('incomplete', 'stopped');
      let head: string;
      try {
        head = headCommit(root);
      } catch {
        return finish('incomplete', 'the integration worktree is gone');
      }
      integration.commit = head;
      state.commit = head;
      if (round === 1) depth = await this.reviewDepth(orch, review, root, base, head);
      rs.depth = depth;
      rs.round = round;
      rs.head = head;
      rs.phase = 'preparing';
      const roundId = randomUUID();
      try {
        store.claimRound({ id: roundId, orchestrationId: orch.id, round, pass, base, head, depth, claimedBy: this.processId, startedAt: now() });
      } catch (err) {
        return finish('incomplete', (err as Error).message);
      }
      const costBefore = rs.costUsd;
      const outcome = await runReviewRound({
        roundId,
        round,
        dir,
        worktree: root,
        base,
        head,
        projectHome: checkoutOf(orch.cwd).home,
        dataDir: this.config.dataDir,
        spec: review,
        depth,
        objective: orch.objective ?? orch.name,
        tasks: orch.tasks.filter((t) => t.status === 'completed').map((t) => ({ name: t.name, result: t.result ?? '' })),
        host: this.reviewHost(orch, control),
        store,
        signal: control.abort.signal,
        budgetUsd: budget - rs.costUsd,
        carry,
        fixerNote,
        onProgress: (p) => {
          if (p.phase) rs.phase = p.phase;
          if (p.costUsd !== undefined) rs.costUsd = costBefore + p.costUsd;
          if (p.waiting !== undefined) rs.waiting = p.waiting;
          if (p.runs) rs.runs = p.runs;
          this.persist();
        },
      }).catch((err: unknown): RoundOutcome => ({
        status: 'incomplete',
        reason: `The review could not run: ${(err as Error).message}`,
        findings: [],
        blocking: [],
        resolved: [],
        costUsd: 0,
        estimateUsd: null,
        files: 0,
        added: 0,
        deleted: 0,
        chunks: 0,
        skippedFiles: [],
        incompleteReasons: [],
        runs: rs.runs,
      }));
      rs.costUsd = costBefore + outcome.costUsd;
      orch.costUsd += outcome.costUsd;
      rs.runs = outcome.runs;
      if (outcome.resolved.length) store.resolveFindings(outcome.resolved, round);
      try {
        store.endRound(roundId, {
          state: outcome.status,
          reason: outcome.reason,
          files: outcome.files,
          added: outcome.added,
          deleted: outcome.deleted,
          chunks: outcome.chunks,
          skippedFiles: outcome.skippedFiles,
          estimateUsd: outcome.estimateUsd,
          costUsd: outcome.costUsd,
          endedAt: now(),
        });
      } catch {
        // the row is gone with its graph
      }
      rs.counts = {
        blocking: outcome.blocking.length,
        advisory: outcome.findings.filter((f) => !f.blocking && f.verdict !== 'refuted' && f.anchor !== 'outside').length,
        refuted: outcome.findings.filter((f) => f.verdict === 'refuted').length,
        outside: outcome.findings.filter((f) => f.anchor === 'outside').length,
      };
      this.persist();
      if (control.cancelled) return finish('incomplete', 'stopped');
      if (outcome.status === 'passed') return finish('passed', outcome.reason);
      if (outcome.status === 'incomplete' && outcome.blocking.length === 0) return finish('incomplete', outcome.reason);
      // Blocked, or incomplete with blocking findings: the fixer takes the blocking ones
      if (previousBlocking && worseAfterFix(previousBlocking, outcome.blocking, changedByFixer)) {
        return finish('blocked', "the review fixer's change added blocking findings");
      }
      const left = budget - rs.costUsd;
      if (review.fixer === false) return finish('blocked', `${outcome.reason} The fixer is off.`);
      if (round > maxFix) return finish('blocked', `blocking findings remain after ${String(maxFix)} fix round${maxFix === 1 ? '' : 's'}`);
      if (left <= 0) return finish('blocked', `${outcome.reason} The review's cost limit of ${usd(budget)} is spent.`);
      // ---- fixing ----
      rs.phase = 'fixing';
      this.persist();
      const headBefore = head;
      const fixed = await this.reviewFix(orch, review, state, root, dir, outcome.blocking, round, maxFix, left, control);
      orch.costUsd += fixed.costUsd;
      rs.costUsd += fixed.costUsd;
      fixerNote = fixed.note;
      if (control.cancelled) return finish('incomplete', 'stopped');
      if (fixed.budget) return finish('blocked', `${outcome.reason} The fixer's cost limit ran out.`);
      state.commits = commitsSince(root, startHead);
      let headAfter = headBefore;
      try {
        headAfter = headCommit(root);
        changedByFixer = new Set(
          git(root, ['diff', '--name-only', '-z', headBefore, headAfter])
            .split('\0')
            .filter(Boolean),
        );
      } catch {
        changedByFixer = new Set();
      }
      previousBlocking = outcome.blocking;
      carry = outcome.blocking;
      // ---- rechecking: every check again from the first (a fix for one can break another) ----
      rs.phase = 'rechecking';
      for (const c of state.commands) c.status = 'pending';
      state.status = 'running';
      this.persist();
      await this.checkAll(orch, spec, state, root, startHead, install, control);
      if (control.cancelled) return finish('incomplete', 'stopped');
      if ((state.status as VerificationState['status']) === 'failed') {
        rs.status = 'skipped';
        rs.phase = null;
        rs.endedAt = now();
        rs.reason = 'the checks failed after a review fix';
        state.gate = 'checks';
        this.persist();
        return;
      }
      checks = { status: state.status as 'passed' | 'fixed', report: state.report };
    }
  }

  /** One attempt of the fixer at the blocking findings of a round; it commits what it leaves behind. */
  private async reviewFix(
    orch: Orchestration,
    spec: ReviewGateSpec,
    state: VerificationState,
    root: string,
    dir: string,
    findings: readonly ReviewFinding[],
    round: number,
    maxFix: number,
    budgetUsd: number,
    control: VerificationControl,
  ): Promise<{ note: string; budget: boolean; costUsd: number }> {
    const verification = orch.verificationSpec as VerificationSpec;
    const record: VerificationFix = { runId: null, command: `review round ${String(round)}`, attempt: (state.fixes?.length ?? 0) + 1, startedAt: now(), endedAt: null, costUsd: 0 };
    (state.fixes ??= []).push(record);
    let note: string;
    let budget = false;
    let costUsd = 0;
    try {
      const run = this.runs.start(
        {
          prompt: reviewFixerPrompt({
            objective: orch.objective ?? orch.name,
            branch: orch.integration?.branch ?? '',
            worktree: root,
            commands: commandsInOrder(state.commands),
            findings,
            round,
            maxFixRounds: maxFix,
            tasks: orch.tasks.filter((t) => t.status === 'completed').map((t) => ({ id: t.id, name: t.name, result: (t.result ?? '').slice(0, MAX_DEP_CONTEXT) })),
          }),
          cwd: dir,
          model: spec.models?.fixer ?? verification.model ?? orch.model ?? undefined,
          ...effortOption(resolveEffort('fixer', spec.models?.fixer ?? verification.model ?? orch.model, verification.effort)),
          permissionMode: orch.permissionMode,
          provider: 'claude-code',
          allowedTools: rulesFor('claude-code', VERIFICATION_POLICY, { allowedTools: orch.allowedTools }).allowedTools,
          disallowedTools: [...PUSH_DENIED],
          ...(orch.permissionPrompts === 'host' ? { permissionPrompts: 'host' as const } : {}),
          name: `${orch.name}:review-fix`.slice(0, 60),
          purpose: 'fixer',
          keepAlive: false,
          maxBudgetUsd: budgetUsd,
        },
        { orchestrationId: orch.id, orchestrationTaskId: REVIEW_CHAT_ROLE },
      );
      control.fixerRunId = run.id;
      record.runId = run.id;
      record.effort = usedEffort(run);
      this.persist();
      // A held usage limit is waited on, unlike `fix()`, through the same wait the reviewers use
      const waited = await awaitReviewRun(this.reviewHost(orch, control), run.id, NO_CLOCK_MS, control.abort.signal);
      if ('result' in waited) {
        const result = waited.result;
        costUsd = result.costUsd;
        record.costUsd = result.costUsd;
        budget = result.cause === 'budget';
        note = budget ? 'its cost limit ran out before it finished' : result.isError ? `the fixer ended with an error: ${result.result}` : result.result;
      } else note = 'the fixer was stopped';
    } catch (err) {
      note = `the fixer could not run: ${(err as Error).message}`;
    }
    record.endedAt = now();
    control.fixerRunId = null;
    try {
      commitAll(root, `chore: keep what the review fixer left uncommitted\n\nOrchestration ${orch.name} (${orch.id.slice(0, 8)}), review round ${String(round)}.`);
    } catch {
      // the re-run of the checks says whether it matters
    }
    return { note: tail(note, 1500), budget, costUsd };
  }

  /**
   * Runs the review again on a branch whose checks passed: a new round, no checks. Allowed only when
   * the checks passed on the current head and nothing is running.
   */
  retryReview(id: string): Orchestration {
    const orch = this.items.get(id);
    if (!orch) throw new ReviewStoreError('orchestration not found', 404, 'review-not-found');
    const spec = orch.verificationSpec;
    const v = orch.verification;
    if (!spec?.review) throw new ReviewStoreError('this graph has no review gate', 409, 'review-not-acceptable');
    if (this.verifying.has(orch.id) || v?.review?.status === 'running') throw new ReviewStoreError('The review is already running for this orchestration', 409, 'review-running');
    const integration = orch.integration;
    if (!v || !integration || integration.status !== 'merged' || !integration.worktree || !existsSync(integration.worktree)) {
      throw new ReviewStoreError('the checks have not passed on the integration branch', 409, 'checks-not-passed');
    }
    const checksPassed = v.gate !== 'checks' && v.commands.every((c) => c.status === 'passed' || c.status === 'fixed') && v.status !== 'running' && v.status !== 'pending';
    if (!checksPassed) throw new ReviewStoreError('the checks have not passed on the integration branch', 409, 'checks-not-passed');
    if (v.commit !== integration.commit) throw new ReviewStoreError('the integration branch moved since the checks passed: verify again', 409, 'head-moved');
    void this.reviewOnly(orch, spec, v, integration.worktree);
    return orch;
  }

  private async reviewOnly(orch: Orchestration, spec: VerificationSpec, state: VerificationState, root: string): Promise<void> {
    const control: VerificationControl = { cancelled: false, commands: new Set(), fixerRunId: null, reviewRunIds: new Set(), abort: new AbortController() };
    this.verifying.set(orch.id, control);
    try {
      const startHead = state.commits[0] ? `${state.commits[0].hash}^` : headCommit(root);
      const install = installStep(spec, root, this.integratedDir(orch, root));
      await this.reviewLoop(orch, spec, state, root, startHead, install, control, {
        status: state.fixes?.some((f) => f.command !== undefined && !f.command.startsWith('review round')) ? 'fixed' : 'passed',
        report: `All ${String(state.commands.length)} checks passed on the merged branch.`,
      });
    } catch (err) {
      const rs = state.review;
      state.status = 'failed';
      state.gate = 'review';
      state.report = `The review could not run: ${(err as Error).message}`;
      if (rs) {
        rs.status = 'incomplete';
        rs.phase = null;
        rs.reason = state.report;
      }
    } finally {
      this.verifying.delete(orch.id);
    }
    state.endedAt = now();
    this.persist();
    this.settleByChecks(orch);
  }

  /**
   * A person accepts a gate that is blocked or incomplete, with a written reason (D8). The acceptance
   * binds to the head it was given on; an incomplete gate is accepted only after a retry also ended
   * incomplete (owner decision, 2026-10-15).
   */
  acceptReview(id: string, reason: string, actor: string): Orchestration {
    const orch = this.items.get(id);
    if (!orch) throw new ReviewStoreError('orchestration not found', 404, 'review-not-found');
    const text = typeof reason === 'string' ? reason.trim() : '';
    if (text.length < ACCEPT_REASON_MIN || text.length > ACCEPT_REASON_MAX) {
      throw new ReviewStoreError(`reason must be ${String(ACCEPT_REASON_MIN)} to ${String(ACCEPT_REASON_MAX)} characters`, 400, 'bad-reason');
    }
    const v = orch.verification;
    const rs = v?.review;
    const integration = orch.integration;
    const refuse = (why: string): never => {
      throw new ReviewStoreError(why, 409, 'review-not-acceptable');
    };
    if (!v || !rs || !orch.verificationSpec?.review) return refuse('this graph has no review to accept');
    if (this.verifying.has(orch.id) || rs.status === 'running') throw new ReviewStoreError('The review is already running for this orchestration', 409, 'review-running');
    if (rs.status !== 'blocked' && rs.status !== 'incomplete') return refuse(`a review that is ${rs.status} cannot be accepted`);
    if (v.gate !== 'review' || !v.commands.every((c) => c.status === 'passed' || c.status === 'fixed')) return refuse('the checks did not pass on this head');
    if (!integration || v.commit !== integration.commit || rs.head !== integration.commit) return refuse('the integration branch moved since the review: it must run again');
    const store = this.reviewStore();
    const rounds = store.rounds(orch.id).filter((r) => r.head === integration.commit);
    const latest = rounds.at(-1);
    if (!latest) return refuse('there is no review round to accept');
    if (rs.status === 'incomplete' && rounds.filter((r) => r.state === 'incomplete').length < 2) {
      return refuse('an incomplete review is accepted only after a retry also ended incomplete');
    }
    const at = now();
    store.accept(latest.id, actor, text, at);
    const incomplete = latest.state === 'incomplete' ? 1 : 0;
    rs.status = 'accepted';
    rs.phase = null;
    rs.accepted = { by: actor, reason: text, at, head: integration.commit ?? '' };
    v.status = 'passed';
    delete v.gate;
    v.report = `Passed: a person accepted the review (${String(rs.counts.blocking)} blocking, ${String(incomplete)} incomplete): ${text}`;
    this.persist();
    this.settleByChecks(orch);
    return orch;
  }

  /**
   * The fixer's chat for the failing checks of an orchestration's change request: in the integration
   * worktree, with the verification's fixer model, never pushing. It commits what it leaves behind
   * and settles when the chat ends; the person's click on Push the fix is what publishes it.
   */
  async runChecksFix(req: { orchestrationId: string; cwd: string; branch: string; prompt: string }): Promise<{ ok: boolean }> {
    const orch = this.items.get(req.orchestrationId);
    if (!orch) return { ok: false };
    const spec = orch.verificationSpec;
    // A guard that cannot run fails the fix like any other launch that throws: the caller reports it
    const guards = this.guardPlan(orch, 'checks-fix', req.cwd, req.cwd);
    const run = this.runs.start(
      {
        prompt: req.prompt,
        cwd: req.cwd,
        ...(guards ? { guards } : {}),
        model: spec?.model ?? orch.model ?? undefined,
        permissionMode: orch.permissionMode,
        // These rules are Claude Code's, so a default provider set to another one never receives them
        provider: 'claude-code',
        allowedTools: rulesFor('claude-code', VERIFICATION_POLICY, { allowedTools: orch.allowedTools }).allowedTools,
        disallowedTools: [...PUSH_DENIED],
        ...(orch.permissionPrompts === 'host' ? { permissionPrompts: 'host' as const } : {}),
        name: `${orch.name}:checks-fix`.slice(0, 60),
        purpose: 'fixer',
        keepAlive: false,
        ...(spec?.maxCostUsd !== undefined ? { maxBudgetUsd: spec.maxCostUsd } : {}),
      },
      { orchestrationId: orch.id, orchestrationTaskId: '__checks-fix__' },
    );
    const result = await this.runs.waitForResult(run.id);
    orch.costUsd += result.costUsd;
    try {
      commitAll(req.cwd, `chore: keep what the checks fixer left uncommitted\n\nOrchestration ${orch.name} (${orch.id.slice(0, 8)}).`);
    } catch {
      // the push step commits again and says why it could not
    }
    return { ok: !result.isError && result.cause !== 'budget' };
  }

  /** Integrates a finished graph again: after resolving by hand, or one from before this existed. */
  retryIntegration(id: string): Orchestration {
    const orch = this.items.get(id);
    if (!orch) throw new NotFoundError('orchestration not found');
    if (orch.status === 'running') throw new Error('the orchestration is still running');
    if (orch.status === 'waiting') throw new Error('the orchestration is waiting for a decision on its tasks, and integrates once they are settled');
    if (orch.integration && ['merging', 'resolving'].includes(orch.integration.status)) return orch;
    if (!orch.tasks.some((t) => t.status === 'completed' && t.branch)) throw new Error('no task has a branch to integrate');
    if (!isGitRepo(orch.cwd)) throw new Error(`${orch.cwd} is not a git repository`);
    if (this.verifying.has(orch.id)) throw new Error('the checks are running on the integration branch: stop the orchestration first');
    orch.baseCommit ??= this.forkPoint(orch);
    // The checks skip themselves when the branch is where they last passed
    void this.integrate(orch).then(() => this.runChecks(orch));
    return orch;
  }

  /** Where the task branches of a graph started, for one recorded before the base commit was. */
  private forkPoint(orch: Orchestration): string {
    const branches = orch.tasks.map((t) => t.branch).filter((b): b is string => !!b && branchExists(orch.cwd, b));
    if (branches.length === 0) return headCommit(orch.cwd);
    try {
      return git(orch.cwd, ['merge-base', '--octopus', ...branches]);
    } catch {
      return headCommit(orch.cwd);
    }
  }

  /**
   * Publishes the integration branch and opens a pull request for it. Only ever on request: pushing
   * is the one step that leaves the machine.
   */
  async pullRequest(id: string): Promise<{ branch: string; url: string | null; detail: string; pullRequest: OrchestrationPullRequest | null }> {
    const orch = this.items.get(id);
    if (!orch) throw new NotFoundError('orchestration not found');
    const integration = orch.integration;
    if (integration?.status !== 'merged') throw new Error('the orchestration has no integrated branch yet');
    if (integration.pullRequestUrl) return { branch: integration.branch, url: integration.pullRequestUrl, detail: 'already open', pullRequest: this.pullRequests?.newest(orch.id) ?? null };
    // A branch being fixed is a moving one, and what is pushed must be what was checked
    if (this.verifying.has(orch.id)) throw new Error('the checks are still running on the integration branch: wait for their outcome before opening a pull request');
    if (checksFailGraph(orch)) throw new Error('the checks failed on the integration branch, and the graph was launched to fail with them: fix the branch and verify again before opening a pull request');
    // The gate fails closed where work leaves the machine (D7), whatever `failGraph` says
    if (orch.verificationSpec?.review) {
      const gate = orch.verification?.review;
      if (!gate || (gate.status !== 'passed' && gate.status !== 'accepted') || gate.head !== integration.commit) {
        throw new Error(`the review gate has not passed on this branch (${gate?.status ?? 'not run'}): fix the findings and verify again, or accept the review with a reason, before opening a pull request`);
      }
    }
    if (!this.pullRequests) throw new Error('pull requests are not available');
    const opened = await this.pullRequests.open(orch);
    if (opened.url && !integration.pullRequestUrl) {
      integration.pullRequestUrl = opened.url;
      this.persist();
    }
    return opened;
  }

  /**
   * Starts the planner agent and returns its run without waiting. The caller streams it like any
   * other run, which is what keeps a two-minute plan from living inside one HTTP request: a lost
   * connection no longer loses the plan, because {@link draftFrom} can read it back afterwards.
   */
  startPlan(req: PlanRequest): ChatRuntime {
    if (!req.objective?.trim()) throw new Error('objective is required');
    validateEffort(req.effort);
    const maxTasks = Math.min(Math.max(req.maxTasks ?? 6, 1), 12);
    const cwd = resolve(req.cwd ?? this.config.workspaceDir);
    return this.runs.start({
      prompt:
        `${PROMPT_HEAD}${pasted(req.objective)}${PROMPT_TAIL}` +
        `${maxTasks} tasks. Each task is executed by an independent Claude Code agent working in ${cwd}, ` +
        `so every prompt must be self-contained. Maximize parallelism: only add a dependency when a task truly needs another task's output ` +
        `(results of dependencies are passed along automatically). ${PLANNER_GRAPH_GUIDANCE} Before you plan, read the directory with the read-only tools, as much as the objective needs, ` +
        `so each task names the files and commands it concerns. Do not perform the work itself.\n\n` +
        `Also choose how it runs. "graph" is the default: every task is a separate Claude Code process that can get a git worktree ` +
        `and branch of its own, merged at the end; choose it whenever a task changes files. "workflow" runs every task as a subagent ` +
        `of one Claude Code session in ${cwd} itself: cheaper and resumable, but with no isolation, so choose it only when it is ` +
        `clearly better, meaning no task modifies the repository (analysis, review, research, audits). Say why in engineReason.\n\n` +
        [PASTED_NOTE, ...thinkThrough(req.model)].join('\n\n'),
      cwd,
      model: req.model,
      ...effortOption(resolveEffort('planner', req.model, req.effort)),
      permissionMode: 'manual',
      // These rules are Claude Code's, so a default provider set to another one never receives them
      provider: 'claude-code',
      allowedTools: rulesFor('claude-code', PLANNER_POLICY).allowedTools,
      disallowedTools: [...PUSH_DENIED],
      name: PLANNER_RUN_NAME,
      purpose: 'planner',
      keepAlive: false,
      internal: true,
      jsonSchema: PLAN_SCHEMA,
    });
  }

  /**
   * Starts the planner and records its draft as soon as it finishes, whether or not anyone is
   * still listening. This is what makes a plan survive a dropped response or a page reload.
   */
  startPlanAndRecord(req: PlanRequest): ChatRuntime {
    const run = this.startPlan(req);
    void this.draftFrom(run.id).catch(() => {
      // A failed plan has nothing worth recording; the run itself carries the error.
    });
    return run;
  }

  /**
   * The editable draft a planner run produced. Works on any finished planner run, so a plan whose
   * HTTP response was lost — or that was generated before a reload — is recoverable instead of paid
   * for twice.
   */
  private async draftFrom(runId: string): Promise<OrchestrationSpec> {
    const run = this.runs.get(runId);
    if (!run) throw new NotFoundError('run not found');
    if (run.name !== PLANNER_RUN_NAME) throw new Error('that run is not a planner run');
    const result = await this.runs.waitForResult(runId);
    if (result.isError) throw new Error(`planner failed: ${result.result}`);
    // A plan cut by the token limit can parse and still be missing tasks
    if (stoppedOnMaxTokens(result)) throw new Error(`planner failed: ${MAX_TOKENS_ERROR}`);

    let draft = result.structuredOutput as { name?: string; engine?: string; engineReason?: string; tasks?: OrchestrationTaskSpec[] } | undefined;
    if (!draft?.tasks) {
      // Older CLIs return the JSON as text
      const match = /\{[\s\S]*\}/.exec(result.result);
      draft = match ? (JSON.parse(match[0]) as typeof draft) : undefined;
    }
    if (!draft?.tasks) throw new Error('planner returned no tasks');
    validateTasks(draft.tasks);
    // A model the CLI would refuse is dropped rather than failing the draft: the plan is still worth
    // editing, and the task then runs on the graph's model.
    // The planner is not asked for an effort: whatever it sent is dropped, and the person chooses
    const tasks = draft.tasks.map(({ model, effort: _effort, ...task }) => (typeof model === 'string' && MODEL_RE.test(model.trim()) ? { ...task, model: model.trim() } : task));
    const head = run.prompt.indexOf(PROMPT_HEAD);
    const tail = run.prompt.indexOf(PROMPT_TAIL);
    // The planner only knows what a workflow is; whether this CLI can run one, its own init told us
    const engine: OrchestrationEngine = draft.engine === 'workflow' ? 'workflow' : 'graph';
    const canRunWorkflows = this.workflowsAvailable(run.cwd);
    const spec: OrchestrationSpec = {
      name: draft.name ?? 'orchestration',
      objective: head === 0 && tail > 0 ? unpasted(run.prompt.slice(PROMPT_HEAD.length, tail)) : undefined,
      engine: engine === 'workflow' && canRunWorkflows ? 'workflow' : 'graph',
      ...(draft.engineReason
        ? { engineReason: engine === 'workflow' && !canRunWorkflows ? `${draft.engineReason} (as a graph: this CLI has no Workflow tool)` : draft.engineReason }
        : {}),
      cwd: run.cwd,
      model: run.model ?? undefined,
      concurrency: 3,
      synthesize: true,
      tasks,
    };
    await this.suggestModels(spec, runId);
    this.db.savePlanDraft(runId, spec);
    return spec;
  }

  /**
   * `orchestration.model`, a suggestion: which model each task needs at least. Today every task
   * takes the plan's one model; active prefills a task's own model where the answer differs, and the
   * person edits it before launching. The effort per task waits for CW-25, which lets a task carry one.
   */
  private async suggestModels(spec: OrchestrationSpec, runId: string): Promise<void> {
    const projectId = this.projectIdOf(spec.cwd ?? this.config.workspaceDir);
    const stance = stanceOf(this.decisions, 'orchestration.model', projectId);
    if (stance === 'off') return;
    const models = [...new Set(['haiku', 'sonnet', 'opus', ...(spec.model ? [spec.model] : [])])].map((id) => ({ id, label: MODEL_LABELS[id] ?? id }));
    const tasks = spec.tasks.map((t) => ({ id: t.id, name: t.name, prompt: t.prompt.split('\n').slice(0, 3).join('\n'), dependsOn: t.dependsOn ?? [] }));
    const asked = this.ask('orchestration.model', { kind: 'task', id: runId, data: { tasks, models } }, projectId);
    if (stance === 'watch') return this.track(asked);
    const outcome = await asked;
    if (!outcome?.act || !outcome.answers) return;
    for (const task of spec.tasks) {
      const answer = outcome.answers[task.id];
      if (answer?.kind === 'choice' && answer.value !== spec.model && models.some((m) => m.id === answer.value)) task.model = answer.value;
    }
  }

  /** A draft this planner run produced, from the live run or from the store once it is gone. */
  async draft(runId: string): Promise<OrchestrationSpec> {
    const stored = this.db.planDraft(runId);
    if (stored) return stored;
    return this.draftFrom(runId);
  }

  /**
   * Removes the worktrees a graph created, once its branches have been reviewed. `claude rm` would
   * do this but only for background jobs, and these workers are --print runs.
   *
   * The branch is always kept, so anything committed survives. Without `force` a worktree holding
   * uncommitted changes is left alone and reported: losing a worker's unfinished work to a cleanup
   * is exactly what nobody asks for.
   */
  pruneWorktrees(id: string, opts: { force?: boolean } = {}): Array<{ task: string; removed: boolean; detail: string }> {
    const orch = this.items.get(id);
    if (!orch) throw new NotFoundError('orchestration not found');
    if (orch.status === 'running' || orch.status === 'waiting') throw new Error('stop the orchestration before removing its worktrees');
    const out: Array<{ task: string; removed: boolean; detail: string }> = [];
    const places: Array<{ id: string; path: string | null | undefined; branch: string | null | undefined; clear: () => void }> = [
      ...orch.tasks.map((t) => ({ id: t.id, path: t.worktree, branch: t.branch, clear: () => (t.worktree = null) })),
    ];
    const integration = orch.integration;
    if (integration) {
      places.push({ id: 'integration', path: integration.worktree, branch: integration.branch, clear: () => (integration.worktree = null) });
    }
    for (const place of places) {
      if (!place.path || !existsSync(place.path)) continue;
      try {
        removeWorktree(orch.cwd, place.path, opts.force);
        place.clear();
        out.push({ task: place.id, removed: true, detail: `branch ${place.branch ?? '?'} kept` });
      } catch (err) {
        const detail = err instanceof Error ? err.message.split('\n')[0] ?? err.message : String(err);
        out.push({ task: place.id, removed: false, detail });
      }
    }
    this.persist();
    return out;
  }

  /**
   * Forgets a graph that is not running. Its worktrees go with it, but their branches are kept:
   * deleting a record must not delete work that was committed there.
   */
  remove(id: string): void {
    const orch = this.items.get(id);
    if (!orch) throw new NotFoundError('orchestration not found');
    if (orch.status === 'running' || orch.status === 'waiting') throw new Error('stop the orchestration before deleting it');
    if (this.verifying.has(orch.id)) throw new Error('the checks are running on the integration branch: stop the orchestration first');
    const kept = this.pruneWorktrees(id, { force: false }).filter((r) => !r.removed);
    if (kept.length > 0) {
      throw new Error(
        `${kept.length} worktree(s) still hold uncommitted work (${kept.map((k) => k.task).join(', ')}); commit it or remove them with force first`,
      );
    }
    this.items.delete(id);
    this.forget(id);
    this.db.deleteOrchestration(id);
    this.announce();
  }

  /** Drops what the orchestrator keeps in memory about a graph that is gone, so a long-lived server does not grow with every one deleted. */
  private forget(id: string): void {
    this.clearWorkflowWatcher(id);
    this.endPlaceWaits(id);
    const scheduled = this.scheduled.get(id);
    if (scheduled) {
      clearTimeout(scheduled.timer);
      this.timers.delete(scheduled.timer);
      this.scheduled.delete(id);
    }
    for (const map of [this.workflowBaseline, this.journalFrom, this.journalTasks, this.workflowGrowth, this.journalBytes, this.followedAt]) map.delete(id);
    for (const set of [this.recordEnded, this.lateArrivals, this.journalReading, this.finishing, this.workflowLaunching]) set.delete(id);
    const prefix = `${id}:`;
    for (const key of [...this.warned]) if (key.startsWith(prefix)) this.warned.delete(key);
    for (const key of [...this.relaunching]) if (key.startsWith(prefix)) this.relaunching.delete(key);
    for (const key of [...this.attemptStamps.keys()]) if (key.startsWith(prefix)) this.attemptStamps.delete(key);
  }

  /** Plans that can still be launched, newest first. */
  drafts(limit?: number): PlanDraftSummary[] {
    return this.db.planDrafts(limit);
  }

  // ---------- decisions about a failed task ----------

  /** The task a decision is about, in a graph that can take one: only the graph engine has tasks to decide on. */
  private decidable(
    id: string,
    taskId: string,
    allowed: OrchestrationTaskState['status'][],
    refusal = (task: OrchestrationTaskState) => `task ${task.id} is ${task.status}, so there is nothing to decide about it`,
  ): { orch: Orchestration; task: OrchestrationTaskState } {
    const orch = this.items.get(id);
    if (!orch) throw new NotFoundError('orchestration not found');
    if (orch.engine !== 'graph') throw new Error('a workflow runs its tasks as one session: resume it instead');
    if (orch.status !== 'running' && orch.status !== 'waiting') throw new Error(`the orchestration is ${orch.status}: resume it instead`);
    const task = orch.tasks.find((t) => t.id === taskId);
    if (!task) throw new NotFoundError('task not found');
    if (!allowed.includes(task.status)) throw new Error(refusal(task));
    return { orch, task };
  }

  /** Puts the graph back to work after a decision: what waited behind the task goes on. */
  private reopen(orch: Orchestration): Orchestration {
    orch.status = 'running';
    orch.endedAt = null;
    // The graph finishes again, and what it checked was the branch before this
    if (!this.verifying.has(orch.id)) orch.verification = null;
    if (orch.error) orch.error = null;
    this.schedule(orch);
    return orch;
  }

  /**
   * Runs a failed or stopped task again in its own chat, with its worktree, once more than its
   * attempts allowed: this is the person deciding it is worth it. What waited behind it stops waiting.
   * A stopped task is one a person stopped waiting for a reset (R11), and has the same way back.
   */
  retryTask(id: string, taskId: string): Orchestration {
    const { orch, task } = this.decidable(id, taskId, ['failed', 'stopped']);
    task.status = 'pending';
    task.result = null;
    task.endedAt = null;
    // The person decided it is worth another go, and that is a new allowance of time and money.
    // Both markers, not just the clock: `continueChat` reads what is left of the budget before it
    // stamps a new start, so a task that died of its cost limit would refuse every retry for ever
    // on the spending of the attempt that killed it. The time is left for the launch to stamp, so
    // a task waiting its turn behind `concurrency` does not spend its minutes in the queue.
    task.clockStartedAt = null;
    task.clockCostUsd = task.costUsd;
    return this.reopen(orch);
  }

  /**
   * Starts a failed or stopped task over: a new chat, in a worktree rebuilt from the base. What the old chat did
   * is thrown away, its branch with it, and it stays listed as the record of what was tried.
   */
  retryTaskClean(id: string, taskId: string): Orchestration {
    const { orch, task } = this.decidable(id, taskId, ['failed', 'stopped']);
    if (task.runId && this.runs.get(task.runId)?.pid) throw new Error('the task still has a process running: stop it first');
    this.startOver(orch, task);
    return this.reopen(orch);
  }

  /**
   * Throws away what a task did (its worktree and branch, uncommitted work included) and puts it back
   * to pending with no chat, so the next execution is a new conversation from the base. The chat it
   * had stays listed as the record of what was tried.
   */
  private startOver(orch: Orchestration, task: OrchestrationTaskState): void {
    if (task.worktree || task.branch) {
      const { root } = checkoutOf(orch.cwd);
      if (task.worktree && existsSync(task.worktree)) removeWorktree(root, task.worktree, true);
      if (task.branch) deleteBranch(root, task.branch);
    }
    Object.assign(task, {
      status: 'pending',
      runId: null,
      sessionId: null,
      worktree: null,
      branch: null,
      baseCommit: null,
      commit: null,
      result: null,
      error: null,
      attempts: 0,
      // The chat that is left behind keeps its cost in the graph's total; the task counts its new one
      costUsd: 0,
      startedAt: null,
      endedAt: null,
      clockStartedAt: null,
      clockCostUsd: 0,
    });
  }

  /**
   * Runs a task of a finished graph again, and with it everything that depends on it: their results
   * were built on the old one, and their branches contain its merge. Each starts over in a new chat
   * and a worktree rebuilt from what it now depends on, and the graph integrates and synthesises
   * again once they are done. Tasks outside that set keep their work.
   *
   * The integration branch is rebuilt from the base too: it holds merges of branches that no longer
   * exist, and merging the new ones on top would conflict with their own earlier versions.
   */
  rerunTask(id: string, taskId: string): Orchestration {
    const orch = this.items.get(id);
    if (!orch) throw new NotFoundError('orchestration not found');
    if (orch.engine !== 'graph') throw new Error('a workflow runs its tasks as one session: resume it instead');
    if (orch.status === 'running') throw new Error('the orchestration is still running: stop it first, or wait for it to finish');
    if (orch.status === 'waiting') throw new Error('the orchestration is waiting for a decision on its tasks: retry or skip them instead');
    if (this.verifying.has(orch.id)) throw new Error('the checks are running on the integration branch: stop the orchestration first');
    const task = orch.tasks.find((t) => t.id === taskId);
    if (!task) throw new NotFoundError('task not found');
    const redo = this.withDependants(orch, task);
    const busy = redo.find((t) => t.runId && this.runs.get(t.runId)?.pid);
    if (busy) throw new Error(`task ${busy.id} still has a process running: stop it first`);
    if (orch.integration && ['merging', 'resolving'].includes(orch.integration.status)) {
      throw new Error('the graph is being integrated: wait for it to finish, or stop it');
    }
    if (orch.worktree && orch.integration?.pullRequestUrl) {
      throw new Error('the integration branch was already pushed for a pull request, and rebuilding it would leave that one behind: relaunch the graph instead');
    }

    if (orch.worktree) this.discardIntegration(orch);
    for (const t of redo) this.startOver(orch, t);
    orch.finalResult = null;
    orch.synthesisRunId = null;
    // What was checked belongs to the branch that was just thrown away
    if (orch.verification) orch.verification = null;
    this.lateArrivals.delete(orch.id);
    orch.integration = null;
    return this.reopen(orch);
  }

  /** The task and every task that depends on it, directly or not, in dependency order. */
  private withDependants(orch: Orchestration, task: OrchestrationTaskState): OrchestrationTaskState[] {
    const affected = new Set([task.id]);
    for (const t of topological(orch.tasks)) {
      if ((t.dependsOn ?? []).some((d) => affected.has(d))) affected.add(t.id);
    }
    return topological(orch.tasks).filter((t) => affected.has(t.id));
  }

  /** Removes the integration branch and its worktree, so the next integration builds it from the base. */
  private discardIntegration(orch: Orchestration): void {
    const { root } = checkoutOf(orch.cwd);
    const integration = orch.integration;
    if (integration?.worktree && existsSync(integration.worktree)) removeWorktree(root, integration.worktree, true);
    deleteBranch(root, integration?.branch ?? integrationBranch(orch));
  }

  /**
   * Gives a branch up so the graph can finish without it: the task and everything that depends on it
   * are skipped. The chat keeps whatever it did; nothing is deleted.
   */
  skipTask(id: string, taskId: string): Orchestration {
    const { orch, task } = this.decidable(id, taskId, ['failed', 'stopped', 'blocked']);
    task.status = 'skipped';
    task.endedAt ??= now();
    return this.reopen(orch);
  }

  /**
   * A nudge for a worker whose task is still running, sent from the orchestration board. A finished
   * task takes none: its result already fed the tasks that depend on it, so its way forward is a fork.
   */
  hintTask(id: string, taskId: string, text: string): Orchestration {
    const { orch, task } = this.decidable(id, taskId, ['running'], (t) =>
      `task ${t.id} is ${t.status}: a hint reaches a worker that is still running, and the way forward for a finished task is a fork of its chat`,
    );
    if (!text?.trim()) throw new Error('text is required');
    if (!task.runId || this.relaunching.has(`${orch.id}:${task.id}`)) throw new Error('the worker is between two executions: try again in a moment');
    this.runs.send(task.runId, `${ORCHESTRATION_HINT_PREFIX}\n\n${text.trim()}`);
    return orch;
  }

  /**
   * What the supervisor spent watching one of this graph's workers. It goes on the graph and not on
   * the task: a task's cost is its chat's own total, which each result replaces, and would drop it.
   */
  chargeSupervisor(id: string, costUsd: number): void {
    const orch = this.items.get(id);
    if (!orch || !(costUsd > 0)) return;
    orch.costUsd += costUsd;
    this.persist();
  }

  // ---------- the workflow engine ----------

  /** Whether the CLI in this directory can run workflows, from what the latest run there loaded. */
  private workflowsAvailable(cwd: string): boolean {
    const tools = this.runs.environments.ofDir(cwd)?.tools;
    // Unknown until a run has started there; the run that launches it will say so plainly if not
    return tools === undefined || tools.includes('Workflow');
  }

  private scriptPath(orch: Orchestration): string {
    return join(this.config.dataDir, 'workflows', `${orch.id}.js`);
  }

  /** The graph as a workflow script: the same prompts, dependencies, concurrency and synthesis. */
  private compile(orch: Orchestration): string {
    return compileWorkflow({
      name: orch.name,
      description: orch.objective ?? orch.name,
      concurrency: orch.concurrency,
      maxContext: MAX_DEP_CONTEXT,
      tasks: orch.tasks.map((t) => ({
        id: t.id,
        name: t.name,
        dependsOn: t.dependsOn ?? [],
        ...(t.model ? { model: t.model } : {}),
        before: this.workerHead(orch, t),
        after: this.workerTask(orch, t),
      })),
      synthesis: orch.synthesize
        ? `Synthesize the results of a multi-agent orchestration into one final report.\nObjective, as the person wrote it:\n${pasted(orch.objective ?? orch.name)}\n\n${PASTED_NOTE}`
        : null,
    });
  }

  /**
   * Runs the graph as one workflow, or resumes one that stopped. The CLI has no command to start a
   * workflow: the Workflow tool does it from inside a session, so a run is asked to call it with
   * the generated script. A resume goes back to that same session, which is where the CLI keeps
   * the cache that replays the agents that had already finished.
   */
  private launchWorkflow(orch: Orchestration, resumeFrom: string | null): void {
    // The first start of a workflow waits for the daily cap like a graph's first task; the tasks stay
    // pending and `spendChanged` launches it. A resume goes back to a session that already ran.
    if (!resumeFrom && !orch.workflow?.runId && this.spendOpen?.(orch.id) === false) {
      this.persist();
      return;
    }
    const scriptPath = this.scriptPath(orch);
    try {
      // A resume replays the script that ran: regenerating it could miss the cache
      if (!resumeFrom || !existsSync(scriptPath)) {
        mkdirSync(join(this.config.dataDir, 'workflows'), { recursive: true });
        writeFileSync(scriptPath, this.compile(orch));
      }
      const prompt = this.workflowPrompt(orch, scriptPath, resumeFrom);
      const previous = orch.workflow?.runId ? this.runs.get(orch.workflow.runId) : null;
      if (resumeFrom && previous) {
        orch.workflow = { scriptPath, runId: previous.id, workflowRunId: resumeFrom };
        // Back to the session that holds the cache. Its last process may still be on its way out
        // from the previous turn, and whatever is sent before it exits would be lost with it.
        this.workflowLaunching.add(orch.id);
        void this.runs
          .exited(previous.id)
          .then(async () => {
            if (orch.status !== 'running') return;
            await this.markJournal(orch, previous.id, resumeFrom);
            if (orch.status !== 'running') return;
            this.workflowBaseline.set(orch.id, this.runs.get(previous.id)?.workflows?.length ?? 0);
            this.runs.send(previous.id, prompt);
            this.followWorkflow(orch, previous.id);
          })
          .catch((err: unknown) => this.workflowRefused(orch, resumeFrom, err))
          .finally(() => this.workflowLaunching.delete(orch.id));
      } else {
        // No tool policy: the engine's own calls are none, but the subagents it spawns edit and run commands, and F10 shows their calls are hooked
        const guards = this.guardPlan(orch, 'workflow', orch.cwd);
        const run = this.runs.start(
          {
            prompt,
            cwd: orch.cwd,
            ...(guards ? { guards } : {}),
            model: orch.model ?? undefined,
            // Its tasks are subagents of this session: the graph's effort is the only one that applies
            ...effortOption(resolveEffort('worker', orch.model, orch.effort)),
            permissionMode: orch.permissionMode,
            // These rules are Claude Code's, so a default provider set to another one never receives them
            provider: 'claude-code',
            // Asked for by the person who launched the graph: nothing to confirm again
            allowedTools: rulesFor('claude-code', WORKFLOW_POLICY, { allowedTools: orch.allowedTools }).allowedTools,
            disallowedTools: [...PUSH_DENIED],
            ...(orch.permissionPrompts === 'host' ? { permissionPrompts: 'host' as const } : {}),
            name: `${orch.name}:workflow`.slice(0, 60),
            purpose: 'orchestration',
            keepAlive: false,
          },
          { orchestrationId: orch.id, orchestrationTaskId: WORKFLOW_LEAD },
        );
        orch.workflow = { scriptPath, runId: run.id, workflowRunId: null };
        this.workflowBaseline.set(orch.id, 0);
        this.journalFrom.set(orch.id, 0);
        this.journalTasks.delete(orch.id);
        this.followWorkflow(orch, run.id);
      }
    } catch (err) {
      return this.workflowRefused(orch, resumeFrom, err);
    }
    this.persist();
  }

  /**
   * A workflow's launch or resume was refused. A place that frees up by itself (a slot, memory, a
   * place kept for a person) is waited for, and the launch tried again; anything else fails the graph
   * with the reason, as a task's failed start does. Never throws: the resume runs detached, and a
   * rejection there used to end the server.
   */
  private workflowRefused(orch: Orchestration, resumeFrom: string | null, err: unknown): void {
    if (orch.status !== 'running') return;
    if (isTransientRefusal(err)) {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        if (orch.status === 'running' && !this.workflowWatchers.has(orch.id) && !this.workflowLaunching.has(orch.id)) this.launchWorkflow(orch, resumeFrom);
      }, SLOT_RETRY_MS);
      timer.unref();
      this.timers.add(timer);
      return this.persist();
    }
    orch.status = 'failed';
    orch.endedAt = now();
    for (const t of orch.tasks) {
      if (t.status === 'pending' || t.status === 'running') {
        t.status = 'failed';
        t.error = `could not start the workflow: ${errorMessage(err)}`;
      }
    }
    this.persist();
  }

  /** What the lead is asked: run the generated script, or resume its run from the cache. */
  private workflowPrompt(orch: Orchestration, scriptPath: string, resumeFrom: string | null): string {
    return (
      'Run the workflow Claudio generated for this orchestration: call the Workflow tool with ' +
      `scriptPath "${scriptPath}"${resumeFrom ? ` and resumeFromRunId "${resumeFrom}"` : ''}, exactly as given, without editing the script. ` +
      'I explicitly ask you to run this workflow.\n\n' +
      `${WORKFLOW_LEAD_WAIT}\n\n` +
      // No budget for a workflow today: the signal says time matters all the same
      timeSignal(Math.max(0, Date.now() - Date.parse(orch.createdAt)))
    );
  }

  /**
   * Goes on with a workflow whose lead the rotation took at a limit: back into the same session, on
   * the account the rotation moved it to or, once a wait ended, the same one, resuming the run from
   * its cache. Never by replaying the lead's turn, which would launch the workflow again from nothing.
   * Null for a chat that leads no workflow; false for one whose graph no longer runs.
   */
  replayWorkflow(chatId: string, account?: string): Promise<boolean> | null {
    const orch = [...this.items.values()].find((o) => o.engine === 'workflow' && o.workflow?.runId === chatId);
    if (!orch) return null;
    return (async () => {
      if (orch.status !== 'running' || !orch.workflow) return false;
      // The old process may still write to the journal on its way out: it is counted once it is gone
      if (this.runs.get(chatId)?.pid) {
        this.runs.stop(chatId);
        await this.runs.exited(chatId);
      }
      const resumeFrom = orch.workflow.workflowRunId;
      if (resumeFrom) await this.markJournal(orch, chatId, resumeFrom);
      if (orch.status !== 'running' || !orch.workflow) return false;
      this.workflowBaseline.set(orch.id, this.runs.get(chatId)?.workflows?.length ?? 0);
      if (!(await this.runs.replayWith(chatId, this.workflowPrompt(orch, orch.workflow.scriptPath, resumeFrom), account))) return false;
      this.followWorkflow(orch, chatId);
      return true;
    })();
  }

  private clearWorkflowWatcher(orchestrationId: string): void {
    const watcher = this.workflowWatchers.get(orchestrationId);
    if (!watcher) return;
    clearInterval(watcher);
    this.timers.delete(watcher);
    this.workflowWatchers.delete(orchestrationId);
  }

  /**
   * Tracks the workflow until it ends. Its end is its own: in a `-p` session the Workflow tool
   * runs in the background, so the turn that launched it ends at once ("Workflow is running…") and
   * the process stays up until the workflow reports back with a task notification. A process that
   * goes away before that took the workflow with it.
   */
  private followWorkflow(orch: Orchestration, runId: string): void {
    const run = this.runs.get(runId);
    for (const t of orch.tasks) {
      t.runId = runId;
      t.sessionId = run?.id ?? null;
    }
    this.clearWorkflowWatcher(orch.id);
    this.followedAt.set(orch.id, Date.now());
    this.recordEnded.delete(orch.id);
    this.workflowGrowth.delete(orch.id);
    let ticks = 0;
    const stop = () => {
      clearInterval(watcher);
      this.timers.delete(watcher);
      if (this.workflowWatchers.get(orch.id) === watcher) this.workflowWatchers.delete(orch.id);
    };
    const watcher = setInterval(() => {
      if (orch.status !== 'running') return stop();
      this.syncWorkflow(orch);
      void this.followJournal(orch);
      // The rotation has the lead at a limit: it moves the session or waits for the reset, and goes on
      // through `replayWorkflow`, which follows the run again. A lead it stopped has not ended the graph,
      // and the time it waits is not time the run went without progress
      if (this.limitHeld?.(runId)) return void this.grew(orch, true);
      if (++ticks % RECORD_EVERY_TICKS === 0) void this.readRecordEnd(orch, runId);
      const workflow = this.currentWorkflow(orch);
      const now = this.runs.get(runId);
      const ended = (workflow !== null && workflow.status !== 'running') || this.recordEnded.has(orch.id);
      const gone = !now || (now.pid === null && ['completed', 'failed', 'stopped'].includes(now.status));
      if (this.finishing.has(orch.id)) return;
      if (!ended && !gone) {
        // Up and running, yet nothing of it grew for too long: a lead looping on its own, or an agent stuck
        if (!this.grew(orch) && Date.now() - (this.workflowGrowth.get(orch.id)?.at ?? Date.now()) >= this.workflowIdleMs) {
          stop();
          this.abandonWorkflow(orch, runId, `nothing in the workflow moved for ${span(this.workflowIdleMs)} (its journal, its agents' transcripts and its progress stayed the same); resume it to go on from its cache`);
        }
        return;
      }
      // The last read of the journal may still find a limit, which the rotation then holds: the
      // watcher stays until the graph has really ended
      this.finishing.add(orch.id);
      void this.finishWorkflow(orch, runId).finally(() => {
        this.finishing.delete(orch.id);
        if (orch.status !== 'running') {
          stop();
          this.reapLead(orch, runId);
        }
      });
    }, 1000);
    watcher.unref();
    this.timers.add(watcher);
    this.workflowWatchers.set(orch.id, watcher);
    this.persist();
  }

  /**
   * Whether the run grew since the watcher last looked: its run directory (journal and agents'
   * transcripts), the agents the stream reports, or the tasks. The lead's own activity does not count:
   * a lead polling its journal in a loop is busy without the workflow getting anywhere. `held` restarts
   * the clock, for a run that waits for a limit rather than stalls.
   */
  private grew(orch: Orchestration, held = false): boolean {
    const agents = this.currentWorkflow(orch)?.agents ?? [];
    const sign = [
      this.journalBytes.get(orch.id) ?? 0,
      ...agents.map((a) => `${a.label}:${a.state}:${String(a.tokens)}:${String(a.toolCalls)}`),
      ...orch.tasks.map((t) => t.status),
      orch.synthesisStartedAt ?? '',
    ].join('|');
    const last = this.workflowGrowth.get(orch.id);
    if (!held && last?.sign === sign) return false;
    this.workflowGrowth.set(orch.id, { sign, at: Date.now() });
    return true;
  }

  /**
   * Whether the run's record says it ended since this launch: written as the workflow ends, it can say
   * so where the stream does not, with the lead still up. A record from an earlier attempt of the same
   * run, which a resume goes back into, ended before the launch.
   */
  private async readRecordEnd(orch: Orchestration, runId: string): Promise<void> {
    const workflowRunId = orch.workflow?.workflowRunId;
    if (!workflowRunId || !this.workflowRecords) return;
    const since = this.followedAt.get(orch.id) ?? Number.POSITIVE_INFINITY;
    const record = (await this.workflowRecords(runId).catch(() => [])).find((r) => r.id === workflowRunId);
    if (orch.status !== 'running' || orch.workflow?.runId !== runId || this.followedAt.get(orch.id) !== since) return;
    if (record && record.status !== 'running' && record.endedAt && Date.parse(record.endedAt) >= since) this.recordEnded.add(orch.id);
  }

  /**
   * A lead still up after its workflow ended has nothing left to report: one was seen looping over its
   * own journal for as long as nobody stopped it. It is given a moment to say its one line, then stopped.
   */
  private reapLead(orch: Orchestration, runId: string): void {
    const pid = this.runs.get(runId)?.pid;
    if (!pid) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      // Resumed meanwhile, or the session went on in another process: that one is not the leftover
      if (orch.status === 'running' || orch.workflow?.runId !== runId || this.runs.get(runId)?.pid !== pid) return;
      this.runs.notice(runId, `Claudio stopped this session: its workflow had ended ${span(this.workflowGraceMs)} before, and it was still running.`);
      this.runs.stop(runId);
    }, this.workflowGraceMs);
    timer.unref();
    this.timers.add(timer);
  }

  /**
   * Ends a running workflow the watchdog gave up on: the lead is stopped and what was left undone
   * fails with the reason, which the graph carries too. The run id stays, so a resume goes on from
   * the cache.
   */
  private abandonWorkflow(orch: Orchestration, runId: string, error: string): void {
    if (orch.status !== 'running') return;
    this.clearWorkflowWatcher(orch.id);
    orch.status = 'failed';
    orch.error = error;
    orch.endedAt = now();
    for (const t of orch.tasks) {
      if (t.status !== 'pending' && t.status !== 'running') continue;
      t.status = 'failed';
      t.error = error;
      t.endedAt = now();
    }
    if (orch.synthesisStartedAt && !orch.synthesisEndedAt) orch.synthesisEndedAt = now();
    this.journalTasks.delete(orch.id);
    this.workflowGrowth.delete(orch.id);
    if (this.runs.get(runId)?.pid) {
      this.runs.notice(runId, `Claudio stopped this workflow: ${error}.`);
      this.runs.stop(runId);
    }
    this.persist();
  }

  /** The workflow this launch started, once the run has reported it. */
  private currentWorkflow(orch: Orchestration): WorkflowRun | null {
    const run = orch.workflow?.runId ? this.runs.get(orch.workflow.runId) : null;
    const all = run?.workflows ?? [];
    return all.length > (this.workflowBaseline.get(orch.id) ?? 0) ? (all.at(-1) ?? null) : null;
  }

  /**
   * Mirrors the live progress the stream reports onto the tasks: one agent per task, labelled with
   * its id. The stream was seen to miss an agent the API refused, so a task the journal names is the
   * journal's (`applyJournal`).
   */
  private syncWorkflow(orch: Orchestration): void {
    if (orch.status !== 'running') return;
    const workflow = this.currentWorkflow(orch);
    if (!workflow) return;
    const byId = new Map(orch.tasks.map((t) => [t.id, t]));
    const journalled = this.journalTasks.get(orch.id);
    let changed = false;
    for (const agent of workflow.agents) {
      const task = byId.get(agent.label);
      if (!task || task.status === 'completed' || journalled?.has(task.id)) continue;
      const status = agent.state === 'done' ? 'completed' : agent.state === 'error' ? 'failed' : 'running';
      if (task.status === status) continue;
      task.status = status;
      task.startedAt ??= agent.startedAt ?? now();
      if (status !== 'running') task.endedAt = now();
      // The preview is cut short; the full result arrives with the workflow's record
      if (status === 'completed') task.result = agent.resultPreview;
      changed = true;
    }
    if (changed) this.persist();
  }

  /**
   * The CLI's id for the run (`wf_…`), which a resume needs. The live stream only carries the task
   * id; the files do from the start, since the journal is written before the record, so a graph
   * stopped half way can still be resumed from cache.
   */
  private async learnWorkflowRunId(orch: Orchestration): Promise<void> {
    const run = orch.workflow?.runId ? this.runs.get(orch.workflow.runId) : null;
    if (!run || !this.workflowRecords) return;
    const workflow = this.currentWorkflow(orch);
    const records = await this.workflowRecords(run.id).catch(() => []);
    // The stream may not have reported the run yet, or ever: a fresh session's only running `wf_`
    // directory is the one this launch started
    const match =
      (workflow?.taskId ? records.find((r) => r.taskId === workflow.taskId) : undefined) ?? records.find((r) => r.status === 'running' && r.id.startsWith('wf_'));
    if (match?.id.startsWith('wf_') && orch.workflow && !orch.workflow.workflowRunId) {
      orch.workflow.workflowRunId = match.id;
      this.persist();
    }
  }

  /**
   * Before a launch goes back into a run that already has a journal, notes how far it goes: its
   * failed lines belong to the attempt being resumed, and the tasks they name are pending again
   * until the resumed run starts them.
   */
  private async markJournal(orch: Orchestration, sessionId: string, workflowRunId: string): Promise<void> {
    const read = this.workflowJournal ? await this.workflowJournal(sessionId, workflowRunId, Number.MAX_SAFE_INTEGER).catch(() => null) : null;
    this.journalFrom.set(orch.id, read?.lines ?? 0);
    this.journalTasks.delete(orch.id);
  }

  /** One read of the journal per watcher tick at most: a read still going skips the tick. */
  private async followJournal(orch: Orchestration): Promise<void> {
    if (this.journalReading.has(orch.id)) return;
    this.journalReading.add(orch.id);
    try {
      await this.syncJournal(orch);
    } finally {
      this.journalReading.delete(orch.id);
    }
  }

  /**
   * Task states from the workflow's journal, which the CLI writes as each agent starts and ends:
   * what the script returns only exists once the workflow ends, and an agent the API refused was
   * seen to reach the journal and never the stream.
   */
  private async syncJournal(orch: Orchestration): Promise<void> {
    if (orch.status !== 'running' || !orch.workflow?.runId) return;
    if (!orch.workflow.workflowRunId) await this.learnWorkflowRunId(orch);
    const sessionId = orch.workflow?.runId;
    const workflowRunId = orch.workflow?.workflowRunId;
    if (!this.workflowJournal || !sessionId || !workflowRunId) return;
    const from = this.journalFrom.get(orch.id) ?? 0;
    const read = await this.workflowJournal(sessionId, workflowRunId, from).catch(() => null);
    // Stopped, relaunched, resumed after a limit or closed while the files were read: what was read belongs to what is gone
    if (!read || this.closed || orch.status !== 'running' || orch.workflow?.runId !== sessionId || orch.workflow.workflowRunId !== workflowRunId) return;
    if ((this.journalFrom.get(orch.id) ?? 0) !== from) return;
    this.journalBytes.set(orch.id, read.bytes);
    this.applyJournal(orch, read.tasks);
  }

  /**
   * Started → running, result → completed with the agent's whole answer, failed → failed with what
   * the agent last said. The synthesis agent's state is the graph's synthesis and final result.
   */
  private applyJournal(orch: Orchestration, entries: JournalTask[]): void {
    const byId = new Map(orch.tasks.map((t) => [t.id, t]));
    const journalled = new Set<string>();
    let changed = false;
    for (const read of entries) {
      // Refused at a limit the rotation takes: the agent runs again once the run resumes, so it is not a failure
      const entry = read.state === 'failed' && this.limitTaken(orch, read) ? { ...read, state: 'running' as const } : read;
      if (isSynthesis(entry)) {
        changed = this.applySynthesisJournal(orch, entry) || changed;
        continue;
      }
      const task = byId.get(entry.label);
      if (!task) continue;
      journalled.add(task.id);
      // A person's decision (skipped, stopped) is not undone by the journal, nor a finished task by an older line
      if (!['pending', 'running', 'failed', 'completed'].includes(task.status)) continue;
      if (task.status === 'completed' && entry.state !== 'completed') continue;
      const result = entry.state === 'completed' ? entry.result : null;
      const error = entry.state === 'failed' ? journalError(entry) : null;
      if (task.status === entry.state && task.result === result && task.error === error) continue;
      const wasRunning = task.status === 'running';
      task.status = entry.state;
      task.result = result;
      task.error = error;
      task.startedAt ??= now();
      if (entry.state === 'running') task.endedAt = null;
      else if (wasRunning || !task.endedAt) task.endedAt = now();
      // Work went on since a limit: the next limit is a new one, which may be waited for again
      if (entry.state === 'completed' && orch.workflow?.runId) this.runs.limitProgress(orch.workflow.runId);
      changed = true;
    }
    this.journalTasks.set(orch.id, journalled);
    if (changed) this.persist();
  }

  /**
   * Whether an agent's refusal is the rotation's: the lead is stopped and handed to it, and the run
   * resumes from its cache on another account or after the reset. Asked again for the same line until
   * the run resumes, which the lead being at its limit answers. A refusal the rotation cannot take (no
   * rotation, or a replay already spent with nothing done since) is the agent's failure.
   */
  private limitTaken(orch: Orchestration, entry: JournalTask): boolean {
    const refusal = journalRefusal(entry);
    const lead = orch.workflow?.runId;
    if (!refusal || !lead || !this.workflowLimit) return false;
    return this.runs.atLimit(lead) || this.workflowLimit(lead, refusal);
  }

  /** Whether the synthesis agent's journal entry changed the graph's synthesis. */
  private applySynthesisJournal(orch: Orchestration, entry: JournalTask): boolean {
    const before = [orch.synthesisStartedAt, orch.synthesisEndedAt, orch.finalResult].join('\0');
    orch.synthesisStartedAt ??= now();
    if (entry.state === 'running') {
      // Started again by a resume: what the failed attempt left is no longer the report
      orch.synthesisEndedAt = null;
      orch.finalResult = null;
    } else {
      orch.synthesisEndedAt ??= now();
      // The words the graph engine's synthesis gives a failure
      orch.finalResult = entry.state === 'completed' ? entry.result : `Synthesis failed: ${journalError(entry)}`;
    }
    return [orch.synthesisStartedAt, orch.synthesisEndedAt, orch.finalResult].join('\0') !== before;
  }

  private async finishWorkflow(orch: Orchestration, runId: string): Promise<void> {
    if (orch.status !== 'running') return; // stopped meanwhile
    this.syncWorkflow(orch);
    // The journal's last lines may have been written after the latest tick read it
    await this.syncJournal(orch);
    if (orch.status !== 'running') return;
    // An agent was refused at a limit the rotation took: the run goes on from its cache, not over
    if (this.limitHeld?.(runId)) return;
    const live = this.currentWorkflow(orch);
    const run = this.runs.get(runId);
    // The record is written as the workflow ends, around the notification: give it a moment
    let record: WorkflowRun | null = null;
    for (let attempt = 0; attempt < 10 && !record?.result; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 500));
      const records = run && this.workflowRecords ? await this.workflowRecords(run.id).catch(() => []) : [];
      record =
        (live?.taskId ? records.find((r) => r.taskId === live.taskId) : undefined) ??
        (orch.workflow?.workflowRunId ? records.find((r) => r.id === orch.workflow?.workflowRunId) : undefined) ??
        records[0] ??
        null;
      if (live?.status !== 'completed') break; // nothing more is coming
    }
    if (orch.status !== 'running') return;
    if (orch.workflow && record?.id.startsWith('wf_')) orch.workflow.workflowRunId = record.id;
    const compiled = readCompiledResult(record?.result);
    // No result: the session ended before its workflow did, which the graph says as well as its tasks
    const unfinished = compiled ? null : `the workflow did not finish: ${live?.summary ?? run?.error ?? run?.lastText ?? record?.status ?? 'no result'}`;

    for (const task of orch.tasks) {
      if (task.status !== 'pending' && task.status !== 'running' && !(compiled && task.status === 'completed')) continue;
      const result = compiled?.results[task.id];
      if (typeof result === 'string') {
        task.status = 'completed';
        task.result = result;
        task.error = null;
      } else if (compiled?.skipped.includes(task.id)) {
        task.status = 'skipped';
        task.error = 'a dependency did not complete';
      } else if (task.status !== 'completed') {
        task.status = 'failed';
        task.error = unfinished ?? 'the agent returned nothing';
      }
      task.endedAt ??= now();
    }
    if (compiled?.synthesis) orch.finalResult = compiled.synthesis;
    orch.costUsd = run?.costUsd ?? orch.costUsd;
    orch.status = orch.tasks.every((t) => t.status === 'completed') ? 'completed' : 'failed';
    if (unfinished) orch.error = unfinished;
    orch.endedAt = now();
    this.journalTasks.delete(orch.id);
    this.persist();
  }

  /** The script a workflow graph runs, as generated from it. */
  workflowScript(id: string): { path: string; script: string } {
    const orch = this.items.get(id);
    if (!orch) throw new NotFoundError('orchestration not found');
    const path = this.scriptPath(orch);
    // A graph edited or never launched as a workflow still has one: the graph compiles either way
    return { path, script: existsSync(path) ? readFileSync(path, 'utf8') : this.compile(orch) };
  }

  /** Keeps the graph as a workflow of the project, which the CLI can run by name from then on. */
  saveWorkflow(id: string, req: SaveOrchestrationWorkflowRequest = {}): WorkflowDefinition {
    const orch = this.items.get(id);
    if (!orch) throw new NotFoundError('orchestration not found');
    const name = req.name?.trim() || workflowName(orch.name);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error('name must be lower case letters, digits and dashes');
    const dir = join(orch.cwd, '.claude', 'workflows');
    const path = join(dir, `${name}.js`);
    if (existsSync(path) && !req.overwrite) throw new Error(`a workflow named ${name} already exists in ${dir}`);
    const script = this.workflowScript(id).script.replace(/(\bname:\s*)("[^"]*")/, `$1${JSON.stringify(name)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, script);
    return { name, description: orch.objective ?? orch.name, scope: 'project', path };
  }

  /** Plans and waits, for callers that want the draft in one call. */
  async plan(req: PlanRequest): Promise<OrchestrationSpec> {
    const run = this.startPlan(req);
    return this.draftFrom(run.id);
  }
}
