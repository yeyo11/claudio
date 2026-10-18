import type { ChatOrigin, SpendPurpose } from '@claudio/shared';

/**
 * Who a start is for, which decides who gets a place that frees up first. A person's chat goes before
 * an orchestration's worker; everything else (housekeeping, a flow's run, an eval) neither waits for
 * a place nor makes anyone wait.
 */
export type StartClass = 'interactive' | 'worker' | 'other';

/**
 * The words of a worker's start that gave way to a person's. Like `RESOURCE_REFUSAL_PREFIX`, the
 * orchestrator matches this prefix to keep the task pending and look again, so the two change together.
 */
export const QUEUE_YIELD_PREFIX = 'Waiting for a chat a person asked to start first';

/** How long workers give way after a person's start was refused: long enough to retry, short enough that an abandoned one frees the place. */
export const INTERACTIVE_HOLD_MS = 20_000;

/**
 * The class of a start from what it carries. A worker is only a start that says it `queued`: the
 * orchestrator's task starts, which keep the task pending and look again when refused. Another
 * start of a graph (its reviewers, its workflow lead, a fixer) has no such handling, so a place kept
 * for a person would fail it instead of delaying it.
 */
export function classOfStart(opts: { purpose?: SpendPurpose | undefined; internal?: boolean | undefined; housekeeping?: boolean | undefined; queued?: boolean | undefined }): StartClass {
  if (opts.queued) return 'worker';
  if (opts.internal || opts.housekeeping) return 'other';
  return opts.purpose === 'person' ? 'interactive' : 'other';
}

/** The class of a chat that starts again on its own record, by a message or when its held messages drain: a person's own chat, or nothing. */
export function classOfChat(origin: ChatOrigin): StartClass {
  return origin === 'claudio' || origin === 'external' ? 'interactive' : 'other';
}

/**
 * The one fact a fair queue needs here: a person was refused a place and may be about to try again.
 * While it holds, a worker's start gives way instead of taking the place that freed up, so the person's
 * retry finds it. It ends when a person's start is admitted, or after `ttl`: a person who walked away
 * must not leave a place empty. Nothing about the person's own refusal changes: it is reported as before.
 */
export class InteractiveHold {
  private until = 0;

  constructor(private readonly ttlMs: number = INTERACTIVE_HOLD_MS) {}

  hold(now: number = Date.now()): void {
    this.until = now + this.ttlMs;
  }

  release(): void {
    this.until = 0;
  }

  active(now: number = Date.now()): boolean {
    return now < this.until;
  }
}
