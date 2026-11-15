/*
 * The account choice exactly as it was before the project rules (T6 of
 * docs/plans/account-configuration-and-project-rules.md), frozen on 2026-11-15 from main at b234fa923 (after
 * the credits stop of #141). It is the oracle of choose-rules.test.ts: with no rule configured,
 * `choose` must answer what this answers. Never edit it to make that test pass.
 */
import type { AccountCreditsUse, AccountLimit, AccountSignInState, AccountsSettings, AccountSwitchReason, RotationPolicy } from '@claudio/shared';
import { creditsCapReached, EXHAUSTED, isOut, outUntil } from '../../src/thresholds.ts';

/** What `choose` needs of an account; the rest of it is not its business. */
export interface Candidate {
  id: string;
  enabled: boolean;
  signedIn: boolean;
  /** An expired or incomplete sign-in is never a candidate, whatever `signedIn` says; absent means usable */
  signInState?: AccountSignInState;
}

export interface ChooseOptions {
  /** The account new work is on now; null before there is one */
  current: string | null;
  /** Epoch ms */
  now: number;
  /** The policy governing the chat's project, when there is one; it overrides the global order and threshold */
  policy?: RotationPolicy | null;
  /** A chat pinned to an account keeps it while it can run, and otherwise rotates only within the policy */
  pinned?: string | null;
  /**
   * The model the chat asked for (an alias or an id), never the one the CLI resolved it to; absent or
   * `default` means whatever the account offers
   */
  model?: string | null;
  /**
   * Whether an account can run the model. An account that cannot is no candidate, so the work waits
   * for one that can instead of replaying a turn that would fail. Absent allows every account.
   */
  canRun?: (account: string, model: string) => boolean;
  /**
   * Accounts the work's turn has already died on at their limit. None is a candidate, whatever its
   * reading says, and none gives a reset to wait for: a failure says the account is out, not until
   * when, so nothing about it is written into the account's reading.
   */
  failedOn?: readonly string[];
}

export interface Choice {
  /** Null when no account can take the work now */
  account: string | null;
  /** Why it is not `current`; null when it is */
  reason: AccountSwitchReason | null;
  /** Epoch ms of the earliest reset among the accounts that are out, when none can take the work */
  waitUntil: number | null;
  /**
   * The account's plan is spent and the work runs on its usage credits, which its credits setting
   * allows; absent otherwise
   */
  credits?: true;
}

/** An unknown reading is allowed, but ranks behind any account known to have room. */
const UNKNOWN_RANK = 0.5;

const signInUsable = (a: Candidate): boolean => a.signInState === undefined || a.signInState === 'ok' || a.signInState === 'unknown';

/**
 * When the account is out of the weekly limit that applies to this model alone (`Fable`), the time
 * it comes back (epoch ms); null when the model has no spent scoped limit. The account-wide state
 * never carries it: another model runs on the account all the same.
 */
function scopedOutUntil(limit: AccountLimit | null, model: string | null, now: number): number | null {
  if (!limit?.cli || !model) return null;
  const wanted = model.toLowerCase();
  let until: number | null = null;
  for (const s of limit.cli.scoped) {
    const t = s.resetsAt * 1000;
    if (s.model && s.utilization >= EXHAUSTED && t > now && wanted.includes(s.model.toLowerCase())) until = until === null ? t : Math.max(until, t);
  }
  return until;
}

/**
 * The global order: `settings.order` as the person arranged it, then every account it does not name
 * (one added since) in the order they are listed.
 */
export function globalOrder(listed: readonly string[], order: readonly string[]): string[] {
  const known = new Set(listed);
  const arranged = order.filter((id) => known.has(id));
  return [...arranged, ...listed.filter((id) => !arranged.includes(id))];
}

/**
 * Pure: the account the next process should run on, in this order of precedence.
 *
 * 1. A pinned chat keeps its account while it can run.
 * 2. The preferred account (`settings.preferred`) while it has room and the chat's policy lists it:
 *    under the threshold to stay on it, `hysteresis` points under it to come back to it.
 * 3. The strategy. Staying put wins over the order: the current account is kept while its binding
 *    window is under the threshold; otherwise the first (`order`: the policy's, else the person's
 *    `settings.order`) or emptiest (`least-used`) enabled, signed-in, not-exhausted account at least
 *    `hysteresis` points under the threshold is taken.
 *
 * An account out until its reset (or for its cooldown, which the reading records as `outUntil`) is
 * skipped, and so is one the work's turn already failed on (`failedOn`); one with no reading is
 * allowed.
 *
 * An account whose plan is spent and whose credits cover it (the `overage` state) follows its
 * credits setting (`settings.credits`, D3 of docs/plans/limit-resume-and-credits.md): under `never`,
 * the default, it is out like any spent account; under `allow` it is taken as an account over the
 * threshold is, after those with room; under `last-resort` only once no account has plan quota left.
 * Either stops at Claudio's cap (`capMinor`). A choice that runs on credits says so (`credits`).
 */
export function chooseBeforeRules(
  accounts: readonly Candidate[],
  limits: Readonly<Record<string, AccountLimit | null | undefined>>,
  settings: AccountsSettings,
  opts: ChooseOptions,
): Choice {
  const { now, current } = opts;
  const threshold = (opts.policy?.threshold ?? settings.threshold) / 100;
  const margin = threshold - settings.hysteresis / 100;
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const order = (opts.policy?.order ?? globalOrder(accounts.map((a) => a.id), settings.order)).filter((id) => byId.has(id));
  const ready = (id: string): boolean => {
    const a = byId.get(id);
    return !!a && a.enabled && a.signedIn && signInUsable(a) && order.includes(id);
  };
  const util = (id: string): number | null => {
    const l = limits[id];
    return l && l.state !== 'unknown' ? l.utilization : null;
  };
  const failed = (id: string): boolean => !!opts.failedOn?.includes(id);
  /**
   * Whether the account's credits may pay for the work, past its spent plan, under `use`: they cover
   * its sends (`creditsCover`), and the month's spend is under Claudio's cap when one is set
   */
  const creditsFor = (id: string, use: AccountCreditsUse): boolean => {
    const limit = limits[id];
    const setting = settings.credits[id];
    if (setting?.use !== use || !limit?.creditsCover || !isOut(limit, now)) return false;
    return !creditsCapReached(limit, setting);
  };
  // Under `allow`, an account on its credits is not out; under `last-resort` it is, until the last step
  const out = (id: string): boolean => (isOut(limits[id], now) && !creditsFor(id, 'allow')) || failed(id);
  const model = opts.model && opts.model !== 'default' ? opts.model : null;
  const runs = (id: string): boolean => !model || !opts.canRun || opts.canRun(id, model);
  const usable = (id: string): boolean => ready(id) && !out(id) && runs(id) && scopedOutUntil(limits[id] ?? null, model, now) === null;

  /** The choice of `account`, marked when it runs on credits */
  const take = (account: string, reason: AccountSwitchReason | null): Choice => ({ account, reason, waitUntil: null, ...(isOut(limits[account], now) ? { credits: true as const } : {}) });

  const pinned = opts.pinned ?? null;
  if (pinned && usable(pinned)) return take(pinned, pinned === current ? null : 'person');

  const reasonFor = (): AccountSwitchReason => {
    const a = current ? byId.get(current) : undefined;
    if (!a || !a.enabled) return 'disabled';
    if (!a.signedIn || !signInUsable(a)) return 'signed-out';
    return out(a.id) || scopedOutUntil(limits[a.id] ?? null, model, now) !== null ? 'limit' : 'threshold';
  };
  const currentUnder = current !== null && usable(current) && (util(current) ?? 0) < threshold;

  const preferred = settings.preferred;
  if (preferred && usable(preferred)) {
    const room = util(preferred) ?? 0;
    if (preferred === current ? room < threshold : room <= margin) {
      const reason = preferred === current || current === null ? null : currentUnder ? 'person' : reasonFor();
      return take(preferred, reason);
    }
  }

  if (current !== null && currentUnder) return take(current, null);

  const pool = order.filter((id) => id !== current && usable(id) && (util(id) ?? 0) <= margin);
  const pick = settings.strategy === 'least-used' ? [...pool].sort((a, b) => (util(a) ?? UNKNOWN_RANK) - (util(b) ?? UNKNOWN_RANK))[0] : pool[0];
  if (pick) return take(pick, current === null ? null : reasonFor());

  // Nobody better: an account over the threshold but not out still beats stopping
  if (current !== null && usable(current)) return take(current, null);

  // The current account is out (or there is none): the margin keeps a chat from flapping between two
  // accounts near the threshold, it is not a reason to stop while another one still has room. Any
  // account that is not out beats waiting for a reset (2026-10-16: three tasks waited an hour while
  // two accounts at 83 % and 90 % could have gone on)
  const spare = order.filter((id) => id !== current && usable(id));
  const fallback = settings.strategy === 'least-used' ? [...spare].sort((a, b) => (util(a) ?? UNKNOWN_RANK) - (util(b) ?? UNKNOWN_RANK))[0] : spare[0];
  if (fallback) return take(fallback, current === null ? null : reasonFor());

  // No account has plan quota left: one whose credits the person allows as a last resort beats
  // waiting. The account the work is on, then the pin, keep it; else the order decides
  const resort = order.filter((id) => ready(id) && runs(id) && !failed(id) && scopedOutUntil(limits[id] ?? null, model, now) === null && creditsFor(id, 'last-resort'));
  const last = current !== null && resort.includes(current) ? current : pinned !== null && resort.includes(pinned) ? pinned : resort[0];
  if (last) return take(last, last === current || current === null ? null : last === pinned ? 'person' : reasonFor());

  // Only an account that can run the model is worth waiting for: another one coming back changes nothing
  const resets = order
    .filter((id) => ready(id) && runs(id))
    .map((id) => outUntil(limits[id], now) ?? scopedOutUntil(limits[id] ?? null, model, now))
    .filter((t): t is number => t !== null);
  return { account: null, reason: null, waitUntil: resets.length ? Math.min(...resets) : null };
}
