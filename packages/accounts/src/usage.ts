import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AccountCliUsage, AccountLimit, ProviderLimitState, RateLimitWindow, ScopedRateLimit } from '@claudio/shared';
import { isRecord, writeAtomic } from './fs.ts';
import { EXHAUSTED, NEAR } from './thresholds.ts';

/** What one source saw of one account, before it is folded into an {@link AccountLimit}. */
export interface Reading {
  source: AccountLimit['source'];
  /** `allowed`, `allowed_warning` or `rejected`, as the stream says; the cache has none */
  status: string | null;
  windows: Record<string, RateLimitWindow>;
  /** Epoch ms of the observation: the stream's arrival, or the cache's `fetchedAtMs` */
  at: number;
  /**
   * What a `rejected` event named: the window that is spent and its reset (unix seconds), as the CLI
   * sent them. Kept apart from `windows` because a rejection seldom says how much was used, and a
   * use the CLI did not report is not one to draw.
   */
  rejected?: { window: string; resetsAt: number };
  /**
   * Epoch ms until which the account is left alone after a rejection that named no window of its own
   * to wait for: one with no reset (for `cooldownSeconds`), or one of extra usage, which says the
   * account cannot run now without saying that one of its windows is spent
   */
  outUntil?: number;
  /**
   * The limits of one model the stream reported (`seven_day_opus`): laid over `cli.scoped` when
   * folded, never into `windows`, so a spent Opus week leaves the account free for Sonnet
   */
  scoped?: ScopedRateLimit[];
  /** What only `get_usage` states (plan, per-model limits, credits); carried over readings that lack it */
  cli?: AccountCliUsage;
}

/** What a stream event needs to know beyond itself. */
export interface EventReadingOptions {
  /** How long an account is left alone after a rejection with no reset (`cooldownSeconds`, in ms); 0 records nothing */
  cooldownMs?: number;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Extra usage past the plan: not a window of the account's own */
const OVERAGE = 'overage';

/** The model a `seven_day_<model>` window counts for, by the display name `get_usage` states (`Opus`); null for an account-wide window. */
function scopedModel(window: string): string | null {
  const name = /^seven_day_(.+)$/.exec(window)?.[1];
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : null;
}

/**
 * A `rate_limit_event`'s `rate_limit_info`. Window keys are `five_hour` / `seven_day`, utilization
 * is 0..1 and `resetsAt` unix seconds (a0, section 7). An event with no `unifiedWindows` still says
 * something about the window it names.
 *
 * Only the account-wide windows go into `windows`. A window scoped to one model goes to `scoped`; a
 * rejection of extra usage (`overage`, or any rejection while `isUsingOverage`) or one with no reset
 * leaves the account out for a while (`outUntil`) without saying a window is spent. Before
 * 2026-10-29 such an event marked the account exhausted on a window it never named.
 */
export function readingFromEvent(info: unknown, now: number, opts: EventReadingOptions = {}): Reading | null {
  if (!isRecord(info)) return null;
  const windows: Record<string, RateLimitWindow> = {};
  const scoped: ScopedRateLimit[] = [];
  const addScoped = (model: string, w: RateLimitWindow): void => {
    const entry: ScopedRateLimit = { model, window: 'seven_day', ...w };
    const i = scoped.findIndex((s) => s.model === model);
    if (i === -1) scoped.push(entry);
    else scoped[i] = entry;
  };
  if (isRecord(info.unifiedWindows)) {
    for (const [key, w] of Object.entries(info.unifiedWindows)) {
      if (!isRecord(w) || key === OVERAGE) continue;
      const utilization = num(w.utilization);
      const resetsAt = num(w.resetsAt);
      if (utilization === null || resetsAt === null) continue;
      const model = scopedModel(key);
      if (model) addScoped(model, { utilization, resetsAt });
      else windows[key] = { utilization, resetsAt };
    }
  }
  const type = typeof info.rateLimitType === 'string' ? info.rateLimitType : null;
  const resetsAt = num(info.resetsAt);
  const utilization = num(info.utilization);
  const status = typeof info.status === 'string' ? info.status : null;
  const model = type ? scopedModel(type) : null;
  if (model && resetsAt !== null) {
    // A rejection says the model's week is spent, whatever use it reported
    const used = status === 'rejected' ? Math.max(utilization ?? EXHAUSTED, EXHAUSTED) : utilization;
    if (used !== null) addScoped(model, { utilization: used, resetsAt });
  } else if (type && !model && type !== OVERAGE && !windows[type] && resetsAt !== null && utilization !== null) {
    windows[type] = { utilization, resetsAt };
  }
  const cooldownMs = opts.cooldownMs ?? 0;
  let rejected: Reading['rejected'] | null = null;
  let outUntil: number | null = null;
  if (status === 'rejected' && !model) {
    const until = resetsAt !== null && resetsAt * 1000 > now ? resetsAt * 1000 : null;
    if (type && type !== OVERAGE && info.isUsingOverage !== true && resetsAt !== null) rejected = { window: type, resetsAt };
    else if (until !== null) outUntil = until;
    // The turn failed and the CLI did not say until when: the account is left alone for the cooldown
    else if (cooldownMs > 0) outUntil = now + cooldownMs;
  }
  if (!Object.keys(windows).length && !rejected && outUntil === null && !scoped.length) return null;
  return {
    source: 'stream',
    status,
    windows,
    at: now,
    ...(rejected ? { rejected } : {}),
    ...(outUntil !== null ? { outUntil } : {}),
    ...(scoped.length ? { scoped } : {}),
  };
}

/** Where the CLI keeps its config for a config dir: `~/.claude.json` for the stock `~/.claude`, else inside the dir. */
export function cliConfigFile(dir: string, home: string = homedir()): string {
  return dir === join(home, '.claude') ? join(home, '.claude.json') : join(dir, '.claude.json');
}

/**
 * Who the CLI is signed in as in a config dir: the `oauthAccount` it writes into its config file
 * (`emailAddress`, `organizationName`). Read from the file, with no process started; null when the
 * dir has no login (a token or key account, a signed-out dir, a file that does not parse).
 */
export function cliLogin(dir: string, home: string = homedir()): { email: string; organization: string | null } | null {
  try {
    const doc = JSON.parse(readFileSync(cliConfigFile(dir, home), 'utf8')) as { oauthAccount?: { emailAddress?: unknown; organizationName?: unknown } };
    const email = doc.oauthAccount?.emailAddress;
    if (typeof email !== 'string' || !email) return null;
    const org = doc.oauthAccount?.organizationName;
    return { email, organization: typeof org === 'string' && org ? org : null };
  } catch {
    return null;
  }
}

/**
 * The CLI's own `cachedUsageUtilization` (`fetchedAtMs` plus `utilization.five_hour|seven_day`,
 * each `{ utilization: 0..100, resets_at: ISO }`). Undocumented and best-effort: only the usage
 * block is read, never the rest of the file, and a malformed one is no reading.
 */
export function readCache(dir: string, home?: string): Reading | null {
  const file = cliConfigFile(dir, home);
  if (!existsSync(file)) return null;
  let cache: unknown;
  try {
    const doc: unknown = JSON.parse(readFileSync(file, 'utf8'));
    cache = isRecord(doc) ? doc.cachedUsageUtilization : null;
  } catch {
    return null;
  }
  if (!isRecord(cache) || !isRecord(cache.utilization)) return null;
  const at = num(cache.fetchedAtMs);
  if (at === null) return null;
  const windows: Record<string, RateLimitWindow> = {};
  for (const key of ['five_hour', 'seven_day']) {
    const w = cache.utilization[key];
    if (!isRecord(w)) continue;
    const pct = num(w.utilization);
    const reset = typeof w.resets_at === 'string' ? Date.parse(w.resets_at) : NaN;
    if (pct !== null && Number.isFinite(reset)) windows[key] = { utilization: pct / 100, resetsAt: Math.floor(reset / 1000) };
  }
  return Object.keys(windows).length ? { source: 'cache', status: null, windows, at } : null;
}

/** The scoped limits of a reading: `get_usage`'s list, with what the stream reported since laid over it. */
function scopedOf(reading: Reading, now: number): ScopedRateLimit[] {
  const merged = [...(reading.cli?.scoped ?? [])];
  for (const s of reading.scoped ?? []) {
    if (s.resetsAt * 1000 <= now) continue;
    const i = merged.findIndex((m) => m.model === s.model && m.window === s.window);
    if (i === -1) merged.push(s);
    else merged[i] = s;
  }
  return merged;
}

/**
 * Folds a reading into what the account looks like at `now`. A window whose reset has passed says
 * nothing any more, so a reading with none left is `unknown`, never `ok`; a `rejected` event keeps
 * the account exhausted on the window it named until the reset it gave, with the use the CLI
 * reported for that window, or none when it reported none. A rejection that named no window of its
 * own keeps it exhausted until `outUntil`, on no window.
 */
export function fold(reading: Reading, now: number): AccountLimit {
  const live = Object.entries(reading.windows).filter(([, w]) => w.resetsAt * 1000 > now);
  const spent = reading.status === 'rejected' && reading.rejected && reading.rejected.resetsAt * 1000 > now ? reading.rejected : null;
  const out = !spent && reading.outUntil !== undefined && reading.outUntil > now ? reading.outUntil : null;
  let binding: [string, RateLimitWindow] | null = null;
  for (const entry of live) if (!binding || entry[1].utilization > binding[1].utilization) binding = entry;
  let state: ProviderLimitState = 'unknown';
  if (spent || out !== null) state = 'exhausted';
  else if (binding) state = binding[1].utilization >= EXHAUSTED ? 'exhausted' : binding[1].utilization >= NEAR ? 'near' : 'ok';
  const resetsAt = spent ? spent.resetsAt * 1000 : (out ?? (binding ? binding[1].resetsAt * 1000 : null));
  const scoped = scopedOf(reading, now);
  const cli: AccountCliUsage | null = reading.cli
    ? { ...reading.cli, scoped }
    : scoped.length
      ? // The stream told of a model's own limit before `get_usage` was ever asked
        { observedAt: new Date(reading.at).toISOString(), plan: null, available: true, scoped, credits: null }
      : null;
  return {
    state,
    window: spent ? spent.window : out !== null ? null : (binding?.[0] ?? null),
    utilization: spent ? (reading.windows[spent.window]?.utilization ?? null) : out !== null ? null : (binding?.[1].utilization ?? null),
    resetsAt: resetsAt === null ? null : new Date(resetsAt).toISOString(),
    windows: Object.fromEntries(live),
    observedAt: new Date(reading.at).toISOString(),
    source: reading.source,
    ...(cli ? { cli } : {}),
  };
}

/**
 * The latest reading per account: current state in `limits.json`, written atomically. An older
 * reading (by its stamp) never replaces a newer one; at the same stamp the stream wins over the
 * cache.
 */
export class Readings {
  private kept = new Map<string, Reading>();

  constructor(private readonly file: string | null = null) {
    if (file && existsSync(file)) {
      try {
        const doc: unknown = JSON.parse(readFileSync(file, 'utf8'));
        if (isRecord(doc) && isRecord(doc.accounts)) {
          for (const [id, r] of Object.entries(doc.accounts)) {
            if (isRecord(r) && isRecord(r.windows) && typeof r.at === 'number') this.kept.set(id, r as unknown as Reading);
          }
        }
      } catch {
        // A damaged file is only a lost cache: the next reading rewrites it
      }
    }
  }

  /**
   * Records a reading; returns whether it replaced what was kept. The windows follow the newest
   * reading, so a `get_usage` answer is the truth only while it is newer than the stream's. What
   * only `get_usage` states (plan, per-model limits, credits) is kept apart from that: a newer
   * stream reading inherits it, and an older `get_usage` answer still updates it.
   *
   * A `get_usage` answer with `rate_limits_available: false` updates only that part: the CLI gives it
   * for a network that is down as well as for a key, and before 2026-10-29 it erased a known
   * exhausted state (the account read `unknown` and work moved onto it).
   */
  async observe(account: string, reading: Reading): Promise<boolean> {
    const old = this.kept.get(account);
    let next: Reading | null = reading;
    if (old && reading.cli && !reading.cli.available) {
      next = { ...old, cli: reading.cli };
    } else if (old && (old.at > reading.at || (old.at === reading.at && reading.source === 'cache' && old.source !== 'cache'))) {
      // Older windows lose, but fresher CLI extras are still worth keeping
      next = reading.cli && (!old.cli || old.cli.observedAt < reading.cli.observedAt) ? { ...old, cli: reading.cli } : null;
    } else if (old) {
      next = { ...reading };
      if (old.cli && !reading.cli) next.cli = old.cli;
      // A fresh `get_usage` lists every scoped limit; until one comes, what the stream said of them stands
      const kept = reading.cli ? [] : (old.scoped ?? []).filter((s) => !reading.scoped?.some((r) => r.model === s.model && r.window === s.window));
      const scoped = [...kept, ...(reading.scoped ?? [])];
      if (scoped.length) next.scoped = scoped;
      else delete next.scoped;
      // The CLI's cache knows nothing of a rejection; the stream and `get_usage` do
      if (reading.source === 'cache' && old.outUntil !== undefined && next.outUntil === undefined) next.outUntil = old.outUntil;
    }
    if (!next) return false;
    this.kept.set(account, next);
    await this.persist();
    return true;
  }

  private async persist(): Promise<void> {
    if (this.file) await writeAtomic(this.file, `${JSON.stringify({ accounts: Object.fromEntries(this.kept) }, null, 2)}\n`);
  }

  /** When the CLI last answered `get_usage` for the account (epoch ms), or null. */
  cliReadAt(account: string): number | null {
    const at = this.kept.get(account)?.cli?.observedAt;
    const ms = at ? Date.parse(at) : NaN;
    return Number.isFinite(ms) ? ms : null;
  }

  limit(account: string, now: number = Date.now()): AccountLimit | null {
    const r = this.kept.get(account);
    return r ? fold(r, now) : null;
  }

  async forget(account: string): Promise<void> {
    if (this.kept.delete(account)) await this.persist();
  }
}
