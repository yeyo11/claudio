/**
 * Instruction-compliance evals (docs/plans/instruction-evals.md). The limits and patterns live here
 * so the parser, the API, the editor and the tests read one number, not four copies of it.
 */

/** What an eval can measure in Phase 1: the instruction files whose effect is a behaviour. */
export const EVAL_KINDS = ['agent', 'skill', 'rule', 'instructions'] as const;

/** User-scope files can be evaluated only as they are: a proposal is never written to the person's config dir. */
export const EVAL_SCOPES = ['project', 'user'] as const;

/** The stages a team member runs in; the one named picks the flow's `stagePolicy`. */
export const EVAL_STAGES = ['refine', 'work', 'verify'] as const;

/** Variants of the target in a run: committed at the pin, in the checkout now, or text sent with the start. */
export const EVAL_VARIANTS = ['pinned', 'current', 'proposed'] as const;

export const EXPECTATION_KINDS = [
  'called', 'not-called', 'before', 'after', 'sequence', 'text', 'file', 'touched', 'command',
] as const;

export const EVAL_OUTCOMES = ['any', 'ok', 'error', 'denied'] as const;
export const EVAL_CALL_SCOPES = ['any', 'main', 'sub'] as const;

/** The file format version; any other value is refused with `unsupported-version`. */
export const EVAL_FILE_VERSION = 1;

/** The folder under the project that holds the files, so they can be committed. */
export const EVAL_DIR = '.claude/claudio-evals';

/** An eval's id within the project, and the file name without `.json`. */
export const EVAL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const EVAL_CASE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
/** A full SHA only: a branch name moves. */
export const EVAL_PIN_PATTERN = /^[0-9a-f]{40}$/;

export const EVAL_LIMITS = {
  /** UTF-8 bytes of one file */
  fileBytes: 256 * 1024,
  titleChars: { min: 1, max: 120 },
  samples: { min: 1, max: 5, default: 2 },
  maxCostUsdPerSample: { min: 0.05, max: 5, default: 0.5 },
  timeoutMinutes: { min: 1, max: 60, default: 10 },
  maxCostUsd: { min: 0.05, max: 200 },
  cases: { min: 1, max: 20 },
  promptChars: { min: 1, max: 8000 },
  expectPerCase: { min: 1, max: 30 },
  sequenceCalls: { min: 2, max: 10 },
  commandTimeoutSeconds: { default: 120, max: 1800 },
  regexSourceChars: 512,
  /** The value is cut to this before a regex sees it */
  regexInputBytes: 16 * 1024,
  /** The most a `file` check reads */
  fileCheckBytes: 1024 * 1024,
  /** Calls kept per sample; the checks run on the full list before it is cut */
  callsPerSample: 500,
  callInputBytes: 4 * 1024,
  callResultBytes: 1024,
  resultTextBytes: 8 * 1024,
  checkOutputBytes: 4 * 1024,
  /** Ended runs kept per eval; older ones go in the transaction that inserts a new run */
  retainedRuns: 100,
  /** Runs of a history page */
  historyPage: 50,
  /** Samples that run at once is `min(this, runs.defaults.maxConcurrentRuns)` */
  concurrency: 2,
  /** A sample hit by a usage limit is run again, at most this many tries */
  maxTries: 3,
  /** Margin on a sample's cap when checking the ceiling (fact F10) */
  costMargin: 1.25,
} as const;

/** Flags a regex matcher may carry. */
export const EVAL_REGEX_FLAGS = 'imsu';
