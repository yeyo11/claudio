import type { Effort, Orchestration, OrchestrationPullRequest, OrchestrationTaskState, ReviewGateSpec, ReviewGateState, VerificationSpec } from '@claudio/shared';

// The spec a graph is read back as, and the rules for starting one over, are the server's too: they
// live in @claudio/shared so a schedule filled here starts what a relaunch there would.
export { canRelaunch, canRerun, cleanTask, limitsOf, rerunBlockedByPullRequest, specOfOrchestration, specOfTask } from '@claudio/shared';

/** The tasks that start over with `taskId`: itself and everything that depends on it, directly or not. */
export function dependantsOf(tasks: OrchestrationTaskState[], taskId: string): string[] {
  const affected = new Set([taskId]);
  // A fixed point rather than an ordering, so a cycle cannot loop
  let grew = true;
  while (grew) {
    grew = false;
    for (const task of tasks) {
      if (!affected.has(task.id) && (task.dependsOn ?? []).some((d) => affected.has(d))) {
        affected.add(task.id);
        grew = true;
      }
    }
  }
  return tasks.filter((t) => affected.has(t.id)).map((t) => t.id);
}

/** The mark of a line that runs at the same time as the one above: no shell command starts with `&`. */
const PARALLEL = /^&\s+/;

/**
 * One command per line, blanks dropped: how the verification commands are typed. A line that starts
 * with `& ` runs at the same time as the line above it, and they make one parallel group.
 */
export function parseCommands(text: string): Array<string | string[]> {
  const entries: string[][] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const joins = PARALLEL.test(line);
    const command = line.replace(PARALLEL, '').trim();
    if (!command || command === '&') continue;
    const last = entries.at(-1);
    // A mark on the first command has nothing to join, so it starts the list
    if (joins && last) last.push(command);
    else entries.push([command]);
  }
  return entries.map((group) => (group.length === 1 ? (group[0] as string) : group));
}

/** The commands box's text for a spec's commands: `parseCommands` read backwards. */
export function commandsText(commands: ReadonlyArray<string | readonly string[]>): string {
  return commands.map((entry) => (typeof entry === 'string' ? entry : entry.join('\n& '))).join('\n');
}

/**
 * How the install step before the checks is picked: detected from the lockfile (the spec leaves
 * `install` out), a command of the person's own (a string), or none (`null`).
 */
export type InstallMode = 'detected' | 'command' | 'none';

/** What the launch form holds for the review gate (docs/plans/review-gate.md), before it is a spec. */
export interface ReviewDraft {
  enabled: boolean;
  /** `correctness` always runs, so it has no switch */
  tests: boolean;
  conventions: boolean;
  security: 'auto' | 'always' | 'off';
  depth: 'light' | 'full';
  fixer: boolean;
  maxFixRounds: number;
  maxCostUsd: number;
  maxRunCostUsd: number;
  reviewerModel: string;
  verifierModel: string;
  /** One glob per line */
  exclude: string;
}

/** The spec's own defaults, so a draft left alone writes no key */
export const EMPTY_REVIEW: ReviewDraft = {
  enabled: false,
  tests: true,
  conventions: true,
  security: 'auto',
  depth: 'full',
  fixer: true,
  maxFixRounds: 2,
  maxCostUsd: 5,
  maxRunCostUsd: 1,
  reviewerModel: '',
  verifierModel: '',
  exclude: '',
};

/** The review spec of a draft: off is no spec, and only what differs from the defaults is written. */
export function reviewOf(draft: ReviewDraft): ReviewGateSpec | undefined {
  if (!draft.enabled) return undefined;
  const d = EMPTY_REVIEW;
  const reviewer = draft.reviewerModel.trim();
  const verifier = draft.verifierModel.trim();
  const exclude = draft.exclude.split('\n').map((line) => line.trim()).filter(Boolean);
  const dimensions: NonNullable<ReviewGateSpec['dimensions']> = {
    ...(draft.tests !== d.tests ? { tests: draft.tests } : {}),
    ...(draft.security !== d.security ? { security: draft.security } : {}),
    ...(draft.conventions !== d.conventions ? { conventions: draft.conventions } : {}),
  };
  return {
    ...(Object.keys(dimensions).length > 0 ? { dimensions } : {}),
    ...(draft.depth !== d.depth ? { depth: draft.depth } : {}),
    ...(draft.fixer !== d.fixer ? { fixer: draft.fixer } : {}),
    ...(draft.maxFixRounds !== d.maxFixRounds ? { maxFixRounds: draft.maxFixRounds } : {}),
    ...(draft.maxCostUsd !== d.maxCostUsd && draft.maxCostUsd > 0 ? { maxCostUsd: draft.maxCostUsd } : {}),
    ...(draft.maxRunCostUsd !== d.maxRunCostUsd && draft.maxRunCostUsd > 0 ? { maxRunCostUsd: draft.maxRunCostUsd } : {}),
    ...(reviewer || verifier ? { models: { ...(reviewer ? { reviewer } : {}), ...(verifier ? { verifier } : {}) } } : {}),
    ...(exclude.length > 0 ? { exclude } : {}),
  };
}

export function draftOfReview(spec: ReviewGateSpec | undefined): ReviewDraft {
  if (!spec) return EMPTY_REVIEW;
  const d = EMPTY_REVIEW;
  return {
    enabled: true,
    tests: spec.dimensions?.tests ?? d.tests,
    conventions: spec.dimensions?.conventions ?? d.conventions,
    security: spec.dimensions?.security ?? d.security,
    depth: spec.depth ?? d.depth,
    fixer: spec.fixer ?? d.fixer,
    maxFixRounds: spec.maxFixRounds ?? d.maxFixRounds,
    maxCostUsd: spec.maxCostUsd ?? d.maxCostUsd,
    maxRunCostUsd: spec.maxRunCostUsd ?? d.maxRunCostUsd,
    reviewerModel: spec.models?.reviewer ?? '',
    verifierModel: spec.models?.verifier ?? '',
    exclude: (spec.exclude ?? []).join('\n'),
  };
}

/** What the launch form holds for the verification phase, before it is a spec. */
export interface VerificationDraft {
  enabled: boolean;
  commands: string;
  fixer: boolean;
  maxAttempts: number;
  model: string;
  /** The fixer's effort; unset takes the recommendation for its model */
  effort?: Effort;
  /** What the fixer may spend over all its attempts; no ceiling when absent */
  maxCostUsd?: number;
  install: InstallMode;
  installCommand: string;
  failGraph: boolean;
  /** The browser specs the changes touch, run by a task of the graph before the merge (on unless turned off) */
  e2eSpecs: boolean;
  /** The review of the merged branch, after the checks pass */
  review: ReviewDraft;
}

export const EMPTY_VERIFICATION: VerificationDraft = {
  enabled: false,
  commands: '',
  fixer: true,
  maxAttempts: 2,
  model: '',
  install: 'detected',
  installCommand: '',
  failGraph: false,
  e2eSpecs: true,
  review: EMPTY_REVIEW,
};

/**
 * A draft with no command is no verification: checks of nothing would only add a phase that always
 * passes. With the review on, the commands may be empty: a repository with no checks can still be reviewed.
 */
export function verificationOf(draft: VerificationDraft): VerificationSpec | undefined {
  const commands = parseCommands(draft.commands);
  const review = reviewOf(draft.review);
  if (!draft.enabled || (commands.length === 0 && !review)) return undefined;
  const installCommand = draft.installCommand.trim();
  return {
    commands,
    fixer: draft.fixer,
    maxAttempts: Math.max(1, draft.maxAttempts),
    ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
    ...(draft.effort ? { effort: draft.effort } : {}),
    // Only the fixer spends, so a ceiling without one would be a field nothing reads
    ...(draft.fixer && draft.maxCostUsd !== undefined && draft.maxCostUsd > 0 ? { maxCostUsd: draft.maxCostUsd } : {}),
    // The server refuses an empty command; an empty box falls back to detection instead
    ...(draft.install === 'none' ? { install: null } : draft.install === 'command' && installCommand ? { install: installCommand } : {}),
    ...(draft.failGraph ? { failGraph: true } : {}),
    ...(draft.e2eSpecs ? {} : { e2eSpecs: false }),
    ...(review ? { review } : {}),
  };
}

export function draftOfVerification(spec: VerificationSpec | undefined): VerificationDraft {
  if (!spec) return EMPTY_VERIFICATION;
  return {
    enabled: true,
    commands: commandsText(spec.commands),
    fixer: spec.fixer,
    maxAttempts: spec.maxAttempts,
    model: spec.model ?? '',
    ...(spec.effort ? { effort: spec.effort } : {}),
    ...(spec.maxCostUsd !== undefined ? { maxCostUsd: spec.maxCostUsd } : {}),
    install: spec.install === null ? 'none' : spec.install === undefined ? 'detected' : 'command',
    installCommand: typeof spec.install === 'string' ? spec.install : '',
    failGraph: spec.failGraph ?? false,
    e2eSpecs: spec.e2eSpecs !== false,
    review: draftOfReview(spec.review),
  };
}

/** The server refuses a pull request for a graph its own failed checks failed, so none is offered. */
export function pullRequestHeld(orch: Pick<Orchestration, 'verificationSpec' | 'verification'>): boolean {
  if (reviewHolds(orch.verification?.review)) return true;
  return orch.verificationSpec?.failGraph === true && orch.verification?.status === 'failed';
}

/**
 * The review gate holds the pull request whatever `failGraph` says (D7): until it has passed or a
 * person accepted it. A graph with no review has no gate.
 */
export function reviewHolds(gate: ReviewGateState | null | undefined): boolean {
  return !!gate && gate.status !== 'passed' && gate.status !== 'accepted' && gate.status !== 'skipped';
}

type WithRow = Pick<OrchestrationPullRequest, 'id' | 'phase'> & { id: string };

/** The checks are listed while the change request is open and the server named its row. */
export function checksShown(pr: Pick<OrchestrationPullRequest, 'id' | 'phase'> | null | undefined): pr is WithRow {
  return Boolean(pr?.id) && pr?.phase === 'open';
}

/**
 * An orchestration has no QA stage, so its fix is `fixing` and then waits for the person: `push`
 * is where **Push the fix** is the zone's one action, `fixing` where an agent is on it.
 */
export function orchestrationFix(pr: Pick<OrchestrationPullRequest, 'fixState'> | null | undefined): 'fixing' | 'push' | null {
  if (pr?.fixState === 'fixing') return 'fixing';
  return pr?.fixState === 'awaiting-push' ? 'push' : null;
}

/** The lines of a log tail that say why it failed: GitHub's `##[error]`, GitLab's `ERROR:` and a non-zero exit code. */
const ERROR_LINE = /##\[error\]|^\s*ERROR:|exit code [1-9]\d*/;

export const isErrorLine = (line: string): boolean => ERROR_LINE.test(line);
