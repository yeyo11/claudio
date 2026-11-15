import type { CliCanary, CliCanaryCheck, CliCanaryCheckId, CliCanaryState } from './types.ts';

/** The checks every canary run holds, in the order they run */
export const CANARY_CHECKS: readonly CliCanaryCheckId[] = ['s1', 's2', 's3c'];

/** `fail` if any check failed, else the first that could not pass, else `pass` */
export function canaryState(checks: readonly CliCanaryCheck[]): CliCanaryState {
  if (checks.some((c) => c.state === 'fail')) return 'fail';
  return checks.find((c) => c.state !== 'pass')?.state ?? 'pass';
}

/**
 * Whether a result holds every check: a row stored by a Claudio with fewer checks than this one is
 * run again, because a pass of two checks says nothing of the third.
 */
export function isCompleteCanary(result: CliCanary): boolean {
  return CANARY_CHECKS.every((id) => result.checks.some((c) => c.id === id));
}
