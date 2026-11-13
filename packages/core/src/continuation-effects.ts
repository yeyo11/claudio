import type { ContinuationEffect, RunEvent } from '@claudio/shared';
import { aheadCount, headCommit } from './git.ts';
import type { ContinuationCause } from './open-items.ts';
import { WRITING_TOOLS } from './tool-calls.ts';

/*
 * What a continuation changed (M3 of docs/plans/decision-engine-v2.md): the commits its turn added
 * and the file edits it made, read from what the runtime already has (the run's worktree, and the
 * chat's event buffer for the execution the turn ran in) rather than from the CLI's transcript
 * file. The `run.continuation` resolver judges a decision only by these facts.
 */

/** The tools that hand work to a subagent; a background one goes on after the turn has ended */
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['Task', 'Agent']);

/** What one turn did */
export interface TurnFacts {
  commits: number;
  edits: number;
  /** Background subagents it started, whose work lands after its result */
  delegated: number;
}

/**
 * The file edits and background delegations in a turn's events, a subagent's included: its calls
 * stream on its sidechain into the same buffer. An edit that failed or was refused changed nothing,
 * so it is not counted.
 */
export function callsOfTurn(events: readonly RunEvent[]): { edits: number; delegated: number } {
  const failed = new Set<string>();
  for (const event of events) {
    for (const block of event.entry?.blocks ?? []) if (block.type === 'tool_result' && block.isError) failed.add(block.toolUseId);
  }
  let edits = 0;
  let delegated = 0;
  for (const event of events) {
    for (const block of event.entry?.blocks ?? []) {
      if (block.type !== 'tool_use' || failed.has(block.id)) continue;
      if (WRITING_TOOLS.has(block.name)) edits += 1;
      else if (SUBAGENT_TOOLS.has(block.name) && typeof block.input === 'object' && block.input !== null && (block.input as Record<string, unknown>).run_in_background === true) delegated += 1;
    }
  }
  return { edits, delegated };
}

/** The commit a directory's HEAD is on; null outside a repository or when git fails */
export function headOf(dir: string | null | undefined): string | null {
  if (!dir) return null;
  try {
    return headCommit(dir);
  } catch {
    return null;
  }
}

/** Commits on the directory's HEAD since `base`; 0 when either is unknown or git fails */
export function commitCountSince(dir: string | null | undefined, base: string | null | undefined): number {
  if (!dir || !base) return 0;
  try {
    return aheadCount(dir, base);
  } catch {
    return 0;
  }
}

/** The record of continuation `n`, sent for `cause`, whose turn did `facts` */
export function continuationEffect(n: number, cause: ContinuationCause, facts: TurnFacts): ContinuationEffect {
  return { n, cause, changed: facts.commits > 0 || facts.edits > 0 || facts.delegated > 0, commits: facts.commits, edits: facts.edits };
}

/**
 * A continuation on its way: what is needed to record its effect when its turn ends. Kept in memory:
 * one a restart loses is never recorded, which `decisionMayContinue` reads as the cheap side.
 */
export interface PendingContinuation {
  n: number;
  cause: ContinuationCause;
  /** Where the run commits, and its HEAD when the continuation was sent; null when it has neither */
  dir: string | null;
  head: string | null;
}

/** Bytes a string takes in UTF-8, as the decision engine measures a state */
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/**
 * The `run.continuation` state of a turn that ended. `deliverable` is the head of what the run was
 * asked to do, cut so the whole state fits `maxBytes`: the engine's redaction would otherwise halve
 * the longest string, which may be the tail the question is about.
 */
export function continuationState(input: {
  title: string;
  deliverable: string;
  tail: string;
  continuations: string;
  phraseListMatched: boolean;
  turn: { commits: number; edits: number };
  maxBytes: number;
}): Record<string, unknown> {
  const rest = { title: input.title, tail: input.tail, continuations: input.continuations, phraseListMatched: input.phraseListMatched, turn: input.turn };
  // Room for the field's name, quotes and a cut mark, and for what redaction may add
  const room = input.maxBytes - bytes(JSON.stringify({ ...rest, deliverable: '' })) - 64;
  const text = input.deliverable.trim();
  let deliverable = text;
  if (bytes(JSON.stringify(text)) > room) {
    let end = Math.max(0, Math.min(text.length, room));
    while (end > 0 && bytes(JSON.stringify(text.slice(0, end))) > room) end = Math.floor(end * 0.9);
    deliverable = end > 0 ? `${text.slice(0, end).trimEnd()}…` : '';
  }
  return { ...rest, deliverable };
}
