import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AccountLimit, ProviderLimitState, RateLimitWindow } from '@claudio/shared';
import { isRecord, writeAtomic } from './fs.ts';

/** From here the account counts as near its limit; matches where the usage bars turn red. */
export const NEAR = 0.75;

/** What one source saw of one account, before it is folded into an {@link AccountLimit}. */
export interface Reading {
  source: AccountLimit['source'];
  /** `allowed`, `allowed_warning` or `rejected`, as the stream says; the cache has none */
  status: string | null;
  windows: Record<string, RateLimitWindow>;
  /** Epoch ms of the observation: the stream's arrival, or the cache's `fetchedAtMs` */
  at: number;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * A `rate_limit_event`'s `rate_limit_info`. Window keys are `five_hour` / `seven_day`, utilization
 * is 0..1 and `resetsAt` unix seconds (a0, section 7). An event with no `unifiedWindows` still says
 * something about the window it names.
 */
export function readingFromEvent(info: unknown, now: number): Reading | null {
  if (!isRecord(info)) return null;
  const windows: Record<string, RateLimitWindow> = {};
  if (isRecord(info.unifiedWindows)) {
    for (const [key, w] of Object.entries(info.unifiedWindows)) {
      if (!isRecord(w)) continue;
      const utilization = num(w.utilization);
      const resetsAt = num(w.resetsAt);
      if (utilization !== null && resetsAt !== null) windows[key] = { utilization, resetsAt };
    }
  }
  const type = typeof info.rateLimitType === 'string' ? info.rateLimitType : null;
  const resetsAt = num(info.resetsAt);
  const utilization = num(info.utilization);
  if (type && !windows[type] && resetsAt !== null && utilization !== null) windows[type] = { utilization, resetsAt };
  const status = typeof info.status === 'string' ? info.status : null;
  if (!Object.keys(windows).length && status !== 'rejected') return null;
  // A rejection without a utilization means the window it names is full
  if (status === 'rejected' && type && resetsAt !== null && !windows[type]) windows[type] = { utilization: 1, resetsAt };
  return { source: 'stream', status, windows, at: now };
}

/** A turn that died on a 429: the account is out until `resetsAt` (epoch seconds), when it is known. */
export function readingFromFailure(resetsAt: number | null, now: number): Reading {
  return { source: 'failure', status: 'rejected', windows: resetsAt === null ? {} : { five_hour: { utilization: 1, resetsAt } }, at: now };
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

/**
 * Folds a reading into what the account looks like at `now`. A window whose reset has passed says
 * nothing any more, so a reading with none left is `unknown`, never `ok`; a `rejected` status
 * keeps the account exhausted until its reset.
 */
export function fold(reading: Reading, now: number): AccountLimit {
  const live = Object.entries(reading.windows).filter(([, w]) => w.resetsAt * 1000 > now);
  const rejected = reading.status === 'rejected' && live.length > 0;
  let binding: [string, RateLimitWindow] | null = null;
  for (const entry of live) if (!binding || entry[1].utilization > binding[1].utilization) binding = entry;
  let state: ProviderLimitState = 'unknown';
  if (binding) {
    const u = rejected ? 1 : binding[1].utilization;
    state = u >= 1 ? 'exhausted' : u >= NEAR ? 'near' : 'ok';
  }
  return {
    state,
    window: binding?.[0] ?? null,
    utilization: binding ? (rejected ? Math.max(1, binding[1].utilization) : binding[1].utilization) : null,
    resetsAt: binding ? new Date(binding[1].resetsAt * 1000).toISOString() : null,
    windows: Object.fromEntries(live),
    observedAt: new Date(reading.at).toISOString(),
    source: reading.source,
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

  /** Records a reading; returns whether it replaced what was kept. */
  async observe(account: string, reading: Reading): Promise<boolean> {
    const old = this.kept.get(account);
    if (old && (old.at > reading.at || (old.at === reading.at && reading.source === 'cache' && old.source !== 'cache'))) return false;
    this.kept.set(account, reading);
    if (this.file) await writeAtomic(this.file, `${JSON.stringify({ accounts: Object.fromEntries(this.kept) }, null, 2)}\n`);
    return true;
  }

  limit(account: string, now: number = Date.now()): AccountLimit | null {
    const r = this.kept.get(account);
    return r ? fold(r, now) : null;
  }

  async forget(account: string): Promise<void> {
    if (this.kept.delete(account) && this.file) await writeAtomic(this.file, `${JSON.stringify({ accounts: Object.fromEntries(this.kept) }, null, 2)}\n`);
  }
}
