import type {
  AccountChoiceBasis,
  AccountChoicePass,
  AccountChoiceWhy,
  AccountCreditsUse,
  AccountLimit,
  AccountSignInState,
  AccountsSettings,
  AccountSwitchReason,
  RotationPolicy,
} from '@claudio/shared';
import { creditsCapReached, EXHAUSTED, isOut, outUntil } from './thresholds.ts';

/** What `choose` needs of an account; the rest of it is not its business. */
export interface Candidate {
  id: string;
  enabled: boolean;
  signedIn: boolean;
  /** An expired or incomplete sign-in is never a candidate, whatever `signedIn` says; absent means usable */
  signInState?: AccountSignInState;
  /**
   * The account's configuration group: every account that shares the default's configuration is one
   * group, and each independent account is a group of its own. Absent reads as the shared group, so a
   * caller that knows nothing of modes changes nothing.
   */
  configGroup?: string;
}

/** The group of every account that shares the default account's configuration. */
export const SHARED_CONFIG_GROUP = 'shared';

/** The most headroom a project may reserve on an account, in points (D12). */
export const RESERVE_CAP = 30;

/**
 * The account a rule's reserve sits on: its preferred account, else the first of its order. Absent
 * when it names neither, and then the reserve has nowhere to be.
 */
export function reserveAccountOf(policy: Pick<RotationPolicy, 'preferred' | 'order'>): string | undefined {
  return policy.preferred ?? policy.order?.[0];
}

/** Whether a project's rule lets work run on `account`: no rule, or a rule with no list, allows every account. */
export function allowsAccount(policy: Pick<RotationPolicy, 'order'> | null, account: string): boolean {
  return !policy?.order || policy.order.includes(account);
}

/**
 * A project's rule as the choice reads it: today's policy (`order` is the allow list and its order,
 * `threshold` the project's own), plus the rule fields the policy contract adds (T8). Every one is
 * optional, and a rule with none of them is today's policy.
 */
export interface ChoosePolicy extends Pick<RotationPolicy, 'threshold' | 'order'> {
  /** Within the rule's projects it replaces `settings.preferred`, with the same threshold and hysteresis */
  preferred?: string | null;
  /** Rotate only within the configuration group of the account the work is on, rather than preferring it */
  strictConfig?: boolean;
}

/**
 * Headroom a project with work in progress holds on one account: the work of every other project
 * treats the account as if its threshold were `percent` points lower. Core computes these from what
 * is running (T7); the choice only reads them.
 */
export interface AccountReserve {
  project: string;
  account: string;
  /** Points of the threshold, capped at {@link RESERVE_CAP} */
  percent: number;
}

export interface ChooseOptions {
  /** The account new work is on now; null before there is one */
  current: string | null;
  /** Epoch ms */
  now: number;
  /** The policy governing the chat's project, when there is one; it overrides the global order and threshold */
  policy?: ChoosePolicy | null;
  /** The project the work belongs to; null or absent for a chat with none. Its own reserves never apply to it */
  project?: string | null;
  /** The reserves of the projects that have work in progress now; none when absent */
  reserved?: readonly AccountReserve[];
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
  /** Why this account was chosen, and which accounts a project rule or reserve passed over */
  why: AccountChoiceWhy;
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
 * 2. The preferred account while it has room and the chat's policy lists it: the rule's own
 *    (`policy.preferred`), else the person's (`settings.preferred`); under the threshold to stay on
 *    it, `hysteresis` points under it to come back to it.
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
 *
 * The project rules (docs/plans/account-configuration-and-project-rules.md §7.2) refine this and never
 * cross it. An account the policy does not list is never a candidate, not for a pin and not on its
 * credits. A reserve another project holds on an account lowers that account's threshold and margin
 * for this work by its points, and when nothing is under its threshold the reserved account comes
 * after every other one that is not out: its headroom is used (`reserve-released`) only when the others
 * are out. Among accounts with room, those in the configuration group of the account the work is on
 * come first, before the strategy, never over room; `strictConfig` keeps rotation inside the group.
 *
 * With no rule fields, no reserves and every account in one configuration group, the choice is the one
 * Claudio made before the rules existed (test/choose-rules.test.ts pins it).
 */
export function choose(
  accounts: readonly Candidate[],
  limits: Readonly<Record<string, AccountLimit | null | undefined>>,
  settings: AccountsSettings,
  opts: ChooseOptions,
): Choice {
  const { now, current } = opts;
  const threshold = (opts.policy?.threshold ?? settings.threshold) / 100;
  const hysteresis = settings.hysteresis / 100;
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

  // Other projects' reserves: the largest on each account, within the cap. The work's own project
  // reserves headroom for itself, so its own reserves never hold it back
  const reserves = new Map<string, { share: number; project: string }>();
  for (const r of opts.reserved ?? []) {
    if (r.project === (opts.project ?? null)) continue;
    const share = Math.min(Math.max(r.percent, 0), RESERVE_CAP) / 100;
    if (share > 0 && share > (reserves.get(r.account)?.share ?? 0)) reserves.set(r.account, { share, project: r.project });
  }
  const reserved = (id: string): boolean => reserves.has(id);
  const thresholdOf = (id: string): number => threshold - (reserves.get(id)?.share ?? 0);
  const marginOf = (id: string): number => thresholdOf(id) - hysteresis;

  const groupOf = (id: string): string => byId.get(id)?.configGroup ?? SHARED_CONFIG_GROUP;
  const group = current !== null ? groupOf(current) : null;
  const strict = !!opts.policy?.strictConfig && group !== null;
  /** Whether rotation may move the work to the account; a pin is a person's choice, not a rotation */
  const rotatable = (id: string): boolean => !strict || groupOf(id) === group;
  /** 0 for the work's own configuration group, 1 for another: ranks before the strategy */
  const apart = (id: string): number => (group === null || groupOf(id) === group ? 0 : 1);

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
  const byUse = (a: string, b: string): number => (util(a) ?? UNKNOWN_RANK) - (util(b) ?? UNKNOWN_RANK);
  /** The strategy's pick among `ids`, the work's own configuration group first; the sort is stable */
  const rank = (ids: readonly string[]): string[] =>
    [...ids].sort((a, b) => apart(a) - apart(b) || (settings.strategy === 'least-used' ? byUse(a, b) : 0));
  const strategyPick = (ids: readonly string[]): string | undefined => (settings.strategy === 'least-used' ? [...ids].sort(byUse)[0] : ids[0]);

  /** The accounts the project's rule or another project's reserve kept the work off */
  const passedOver = (chosen: string | null): AccountChoicePass[] => {
    const project = opts.project ?? undefined;
    const passes: AccountChoicePass[] = [];
    for (const a of accounts) {
      if (a.id === chosen) continue;
      if (!order.includes(a.id)) passes.push({ account: a.id, because: 'not-allowed', ...(project ? { project } : {}) });
      else if (!usable(a.id)) continue;
      // A reserve kept the work off an account only where it took it out of the accounts with room
      else if (reserved(a.id)) {
        if ((util(a.id) ?? 0) > marginOf(a.id)) passes.push({ account: a.id, because: 'reserved', project: reserves.get(a.id)?.project ?? '' });
      }
      else if (!rotatable(a.id)) passes.push({ account: a.id, because: 'other-config', ...(project ? { project } : {}) });
    }
    return passes;
  };
  const whyOf = (chosen: string | null, basis: AccountChoiceBasis, project?: string): AccountChoiceWhy => {
    const passes = passedOver(chosen);
    return { basis, ...(project ? { project } : {}), ...(passes.length ? { passedOver: passes } : {}) };
  };

  /** The choice of `account`, marked when it runs on credits */
  const take = (account: string, reason: AccountSwitchReason | null, basis: AccountChoiceBasis, project?: string): Choice => ({
    account,
    reason,
    waitUntil: null,
    ...(isOut(limits[account], now) ? { credits: true as const } : {}),
    why: whyOf(account, basis, project),
  });

  const pinned = opts.pinned ?? null;
  if (pinned && usable(pinned)) return take(pinned, pinned === current ? null : 'person', 'pin');

  const reasonFor = (): AccountSwitchReason => {
    const a = current ? byId.get(current) : undefined;
    if (!a || !a.enabled) return 'disabled';
    if (!a.signedIn || !signInUsable(a)) return 'signed-out';
    if (out(a.id) || scopedOutUntil(limits[a.id] ?? null, model, now) !== null) return 'limit';
    // Under the work's own threshold, only another project's reserve moved it
    return reserved(a.id) && (util(a.id) ?? 0) < threshold ? 'reserve' : 'threshold';
  };
  const currentUnder = current !== null && usable(current) && (util(current) ?? 0) < thresholdOf(current);

  const ruled = opts.policy?.preferred ?? null;
  const preferred = ruled ?? settings.preferred;
  if (preferred && usable(preferred) && rotatable(preferred)) {
    const room = util(preferred) ?? 0;
    if (preferred === current ? room < thresholdOf(preferred) : room <= marginOf(preferred)) {
      const reason = preferred === current || current === null ? null : currentUnder ? 'person' : reasonFor();
      return ruled ? take(preferred, reason, 'project-preferred', opts.project ?? undefined) : take(preferred, reason, 'preferred');
    }
  }

  if (current !== null && currentUnder) return take(current, null, 'current');

  const pool = order.filter((id) => id !== current && usable(id) && rotatable(id) && (util(id) ?? 0) <= marginOf(id));
  const pick = rank(pool)[0];
  if (pick) {
    const basis: AccountChoiceBasis = pool.length === 1 ? 'only-one' : pick !== strategyPick(pool) ? 'same-config' : settings.strategy;
    return take(pick, current === null ? null : reasonFor(), basis);
  }

  // The current account is out (or there is none), or nobody has room: the margin keeps a chat from
  // flapping between two accounts near the threshold, it is not a reason to stop while another one
  // still has room. Any account that is not out beats waiting for a reset (2026-10-16: three tasks
  // waited an hour while two accounts at 83 % and 90 % could have gone on). A reserved account comes
  // after every other one: its headroom is released only when they are out
  const spare = order.filter((id) => id !== current && usable(id) && rotatable(id));
  const unreserved = spare.filter((id) => !reserved(id));

  // Nobody better: an account over the threshold but not out still beats stopping, unless another
  // project reserves headroom on it and an account it does not reserve can go on
  if (current !== null && usable(current) && !(reserved(current) && unreserved.length > 0)) {
    return reserved(current) ? take(current, null, 'reserve-released', reserves.get(current)?.project) : take(current, null, 'over-threshold');
  }

  const fallback = rank(unreserved)[0] ?? rank(spare)[0];
  if (fallback) {
    const reason = current === null ? null : reasonFor();
    return reserved(fallback) ? take(fallback, reason, 'reserve-released', reserves.get(fallback)?.project) : take(fallback, reason, 'over-threshold');
  }

  // No account has plan quota left: one whose credits the person allows as a last resort beats
  // waiting. The account the work is on, then the pin, keep it; else the order decides
  const resort = order.filter((id) => ready(id) && rotatable(id) && runs(id) && !failed(id) && scopedOutUntil(limits[id] ?? null, model, now) === null && creditsFor(id, 'last-resort'));
  const last = current !== null && resort.includes(current) ? current : pinned !== null && resort.includes(pinned) ? pinned : resort[0];
  if (last) return take(last, last === current || current === null ? null : last === pinned ? 'person' : reasonFor(), 'credits');

  // Only an account that can run the model is worth waiting for: another one coming back changes nothing
  const resets = order
    .filter((id) => ready(id) && rotatable(id) && runs(id))
    .map((id) => outUntil(limits[id], now) ?? scopedOutUntil(limits[id] ?? null, model, now))
    .filter((t): t is number => t !== null);
  return { account: null, reason: null, waitUntil: resets.length ? Math.min(...resets) : null, why: whyOf(null, 'none') };
}
