import type { AccountCredits, AccountCliUsage, RateLimitWindow, ScopedRateLimit } from '@claudio/shared';
import { controlRequest, type ControlOptions } from './control.ts';
import type { AccountRef } from './env.ts';
import { isRecord } from './fs.ts';
import type { Reading } from './usage.ts';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** An ISO reset as the unix seconds every other reading uses; null when absent or not a date. */
function seconds(iso: unknown): number | null {
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** `{ utilization: 0..100, resets_at }`, the shape of every window of `rate_limits`, as a 0-1 window. */
function windowOf(raw: unknown): RateLimitWindow | null {
  if (!isRecord(raw)) return null;
  const pct = num(raw.utilization);
  const resetsAt = seconds(raw.resets_at);
  return pct !== null && resetsAt !== null ? { utilization: pct / 100, resetsAt } : null;
}

/** Minor units from either a bare number or the `{ amount_minor }` the CLI uses in `spend`. */
function minor(v: unknown): number | null {
  return num(v) ?? (isRecord(v) ? num(v.amount_minor) : null);
}

/**
 * The credits, from `spend` (amounts with their currency and exponent) with `extra_usage` filling
 * what it lacks (`credits_ever_enabled`, `spend_limit_reached`). Null when the CLI states neither.
 */
function creditsOf(spend: unknown, extra: unknown): AccountCredits | null {
  const s = isRecord(spend) ? spend : null;
  const e = isRecord(extra) ? extra : null;
  if (!s && !e) return null;
  const used = s && isRecord(s.used) ? s.used : null;
  const enabled = typeof s?.enabled === 'boolean' ? s.enabled : e?.is_enabled === true;
  const usedMinor = minor(s?.used) ?? num(e?.used_credits) ?? 0;
  const limitMinor = minor(s?.limit) ?? num(e?.monthly_limit);
  return {
    enabled,
    usedMinor,
    limitMinor,
    currency: str(used?.currency) ?? str(e?.currency),
    exponent: num(used?.exponent) ?? num(e?.decimal_places) ?? 2,
    limitReached: e?.spend_limit_reached === true || (limitMinor !== null && limitMinor > 0 && usedMinor >= limitMinor && enabled),
    disabledReason: str(s?.disabled_reason) ?? str(e?.disabled_reason),
    everEnabled: e?.credits_ever_enabled === true || enabled,
  };
}

/** The per-model weekly limits, from `limits[]`, else `model_scoped[]`, else the model-named windows. */
function scopedOf(rl: Record<string, unknown>): ScopedRateLimit[] {
  const out: ScopedRateLimit[] = [];
  const add = (model: string | null, w: RateLimitWindow | null): void => {
    if (model && w && !out.some((o) => o.model.toLowerCase() === model.toLowerCase())) out.push({ model, window: 'seven_day', ...w });
  };
  for (const l of Array.isArray(rl.limits) ? rl.limits : []) {
    if (!isRecord(l) || l.kind !== 'weekly_scoped' || !isRecord(l.scope) || !isRecord(l.scope.model)) continue;
    const pct = num(l.percent);
    const resetsAt = seconds(l.resets_at);
    add(str(l.scope.model.display_name), pct !== null && resetsAt !== null ? { utilization: pct / 100, resetsAt } : null);
  }
  for (const m of Array.isArray(rl.model_scoped) ? rl.model_scoped : []) if (isRecord(m)) add(str(m.display_name), windowOf(m));
  add('Opus', windowOf(rl.seven_day_opus));
  add('Sonnet', windowOf(rl.seven_day_sonnet));
  return out;
}

/**
 * The `response` of a `get_usage` control request, as a reading. `rate_limits_available: false`
 * (an API-key account, or a `setup-token` token, whose scope reaches inference only) is a reading with no windows that says so. Utilization comes as 0..100 and
 * is stored as 0..1, like the stream's.
 */
export function parseUsage(response: unknown, now: number = Date.now()): Reading {
  if (!isRecord(response)) throw new Error('get_usage answered with no object');
  const rl = isRecord(response.rate_limits) ? response.rate_limits : null;
  const available = response.rate_limits_available === true && rl !== null;
  const windows: Record<string, RateLimitWindow> = {};
  let scoped: ScopedRateLimit[] = [];
  let credits: AccountCredits | null = null;
  if (available) {
    const limits = Array.isArray(rl.limits) ? rl.limits.filter(isRecord) : [];
    const byKind = (kind: string): RateLimitWindow | null => {
      const l = limits.find((x) => x.kind === kind);
      const pct = l ? num(l.percent) : null;
      const resetsAt = l ? seconds(l.resets_at) : null;
      return pct !== null && resetsAt !== null ? { utilization: pct / 100, resetsAt } : null;
    };
    const five = windowOf(rl.five_hour) ?? byKind('session');
    const seven = windowOf(rl.seven_day) ?? byKind('weekly_all');
    if (five) windows.five_hour = five;
    if (seven) windows.seven_day = seven;
    scoped = scopedOf(rl);
    credits = creditsOf(rl.spend, rl.extra_usage);
  }
  const cli: AccountCliUsage = { observedAt: new Date(now).toISOString(), plan: str(response.subscription_type), available, scoped, credits };
  return { source: 'cli', status: null, windows, at: now, cli };
}

/**
 * Asks the CLI for the account's real usage (`get_usage`, a control request of its stream-json
 * protocol: no prompt, no turn, no tokens) in the account's own environment: a login account's
 * config dir, a token account's `CLAUDE_CODE_OAUTH_TOKEN`. Never an HTTP call of ours.
 */
export async function usageOf(account: AccountRef, opts: ControlOptions = {}): Promise<Reading> {
  // Measured at 11-15 s with four accounts read in a loaded machine: 20 s was too close
  return parseUsage(await controlRequest(account, 'get_usage', { timeoutMs: 30_000, ...opts }));
}
