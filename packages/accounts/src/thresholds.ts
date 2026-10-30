import type { AccountLimit } from '@claudio/shared';

/*
 * The one place the account thresholds live. Before 2026-10-29 an account was `near` at 0.75 by its
 * own reading, at 0.6 by the provider-wide one, and the bars turned at 0.6 and 0.75: the status bar
 * said "near the limit" for an account its own card drew as fine. The rotation threshold is not here:
 * it is the person's setting (`AccountsSettings.threshold`, or a policy's).
 *
 * No Node import: the web reads this module too (`@claudio/accounts/thresholds`).
 */

/** From this use of the binding window an account is `near` its limit: where the bars turn warn. */
export const NEAR = 0.6;
/** At this use the window is spent. */
export const EXHAUSTED = 1;
/** A usage bar is neutral below this share, warn from it. */
export const BAR_WARN = 0.6;
/** A usage bar is bad from this share, and when the account is exhausted. */
export const BAR_BAD = 0.75;

/** The tone of a usage bar for a share of 0..1. */
export function barTone(utilization: number, exhausted = false): 'neutral' | 'warn' | 'bad' {
  if (exhausted || utilization >= BAR_BAD) return 'bad';
  return utilization >= BAR_WARN ? 'warn' : 'neutral';
}

/**
 * Whether an account's reading says it is out at `now`: exhausted, with its reset still ahead or not
 * known. The one definition of "out" the choice, the account view and the decision route share.
 */
export function isOut(limit: Pick<AccountLimit, 'state' | 'resetsAt'> | null | undefined, now: number): boolean {
  if (!limit || limit.state !== 'exhausted') return false;
  return limit.resetsAt === null || Date.parse(limit.resetsAt) > now;
}

/** When an out account comes back (epoch ms); null when it is not out or its reset is unknown. */
export function outUntil(limit: Pick<AccountLimit, 'state' | 'resetsAt'> | null | undefined, now: number): number | null {
  if (!isOut(limit, now) || !limit?.resetsAt) return null;
  return Date.parse(limit.resetsAt);
}
