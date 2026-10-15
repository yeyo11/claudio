import type { AccountLimit, AccountsSettings, AccountSwitchReason, RotationPolicy } from '@agentry/shared';

/** What `choose` needs of an account; the rest of it is not its business. */
export interface Candidate {
  id: string;
  enabled: boolean;
  signedIn: boolean;
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
  /** Epoch ms of the last switch, for the cooldown */
  lastSwitchAt?: number | null;
}

export interface Choice {
  /** Null when no account can take the work now */
  account: string | null;
  /** Why it is not `current`; null when it is */
  reason: AccountSwitchReason | null;
  /** Epoch ms of the earliest reset among the accounts that are out, when none can take the work */
  waitUntil: number | null;
}

/** An unknown reading is allowed, but ranks behind any account known to have room. */
const UNKNOWN_RANK = 0.5;

function exhaustedUntil(limit: AccountLimit | null, now: number): number | null {
  if (!limit || limit.state !== 'exhausted' || !limit.resetsAt) return null;
  const t = Date.parse(limit.resetsAt);
  return t > now ? t : null;
}

/**
 * Pure: the account the next process should run on.
 *
 * Staying put wins over the order. The current account is kept while its binding window is under
 * the threshold; otherwise the first (`order`) or emptiest (`least-used`) enabled, signed-in,
 * not-exhausted account at least `hysteresis` points under the threshold is taken. Between two
 * switches there are `cooldownSeconds` unless the current account is exhausted. An account out
 * until its reset is skipped; one with no reading is allowed.
 */
export function choose(
  accounts: readonly Candidate[],
  limits: Readonly<Record<string, AccountLimit | null | undefined>>,
  settings: AccountsSettings,
  opts: ChooseOptions,
): Choice {
  const { now, current } = opts;
  const threshold = (opts.policy?.threshold ?? settings.threshold) / 100;
  const margin = threshold - settings.hysteresis / 100;
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const order = (opts.policy?.order ?? accounts.map((a) => a.id)).filter((id) => byId.has(id));
  const ready = (id: string): boolean => {
    const a = byId.get(id);
    return !!a && a.enabled && a.signedIn && order.includes(id);
  };
  const util = (id: string): number | null => {
    const l = limits[id];
    return l && l.state !== 'unknown' ? l.utilization : null;
  };
  const out = (id: string): boolean => exhaustedUntil(limits[id] ?? null, now) !== null;
  const usable = (id: string): boolean => ready(id) && !out(id);

  const pinned = opts.pinned ?? null;
  if (pinned && usable(pinned)) return { account: pinned, reason: pinned === current ? null : 'person', waitUntil: null };

  const reasonFor = (): AccountSwitchReason => {
    const a = current ? byId.get(current) : undefined;
    if (!a || !a.enabled) return 'disabled';
    if (!a.signedIn) return 'signed-out';
    return out(a.id) ? 'limit' : 'threshold';
  };

  const currentUnder = current !== null && usable(current) && (util(current) ?? 0) < threshold;
  if (current !== null && currentUnder) return { account: current, reason: null, waitUntil: null };

  // Moving off an account that is merely over the threshold waits out the cooldown; one that is out does not
  const currentOut = current !== null && out(current);
  const cooling = !!opts.lastSwitchAt && now - opts.lastSwitchAt < settings.cooldownSeconds * 1000;
  if (current !== null && usable(current) && cooling && !currentOut) return { account: current, reason: null, waitUntil: null };

  const pool = order.filter((id) => id !== current && usable(id) && (util(id) ?? 0) <= margin);
  let pick: string | undefined;
  if (settings.strategy === 'least-used') {
    pick = [...pool].sort((a, b) => (util(a) ?? UNKNOWN_RANK) - (util(b) ?? UNKNOWN_RANK))[0];
  } else {
    pick = pool[0];
  }
  if (pick) return { account: pick, reason: current === null ? null : reasonFor(), waitUntil: null };

  // Nobody better: an account over the threshold but not out still beats stopping
  if (current !== null && usable(current)) return { account: current, reason: null, waitUntil: null };

  const resets = order.map((id) => exhaustedUntil(limits[id] ?? null, now)).filter((t): t is number => t !== null);
  return { account: null, reason: null, waitUntil: resets.length ? Math.min(...resets) : null };
}
