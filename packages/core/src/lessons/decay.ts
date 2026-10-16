import type { LessonSettings, LessonStatus } from '@claudio/shared';

/*
 * Confidence decay (docs/plans/lessons.md, "Confidence and decay"). Pure: the store and the sweep
 * hand it the clock, so a test can walk a lesson through its whole life.
 */

const DAY_MS = 86_400_000;

type DecaySettings = Pick<LessonSettings, 'confidence' | 'decay'>;

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Whole days since the last confirmation; a clock that went backwards counts as none */
export function daysSince(lastConfirmedAt: string, now: Date): number {
  const then = Date.parse(lastConfirmedAt);
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((now.getTime() - then) / DAY_MS));
}

/** The base confidence after decay, as of `now`; a pinned lesson does not decay */
export function effective(base: number, pinned: boolean, lastConfirmedAt: string, now: Date, settings: DecaySettings): number {
  const capped = Math.min(base, settings.confidence.max);
  if (pinned) return round2(capped);
  const { graceDays, periodDays, step } = settings.decay;
  const steps = Math.max(0, Math.floor((daysSince(lastConfirmedAt, now) - graceDays) / periodDays));
  return round2(Math.max(0, capped - step * steps));
}

/** Whether runs are handed the lesson now */
export function delivered(status: LessonStatus, effectiveConfidence: number, settings: DecaySettings): boolean {
  return status === 'active' && effectiveConfidence >= settings.confidence.deliverAt;
}

/** What the hourly sweep retires: an active, unpinned lesson that decayed below `retireBelow` */
export function shouldRetire(status: LessonStatus, pinned: boolean, effectiveConfidence: number, settings: DecaySettings): boolean {
  return status === 'active' && !pinned && effectiveConfidence < settings.decay.retireBelow;
}
