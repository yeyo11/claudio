import type { ProviderLimit } from '@agentry/shared';

/** One bar of a provider's limit: the window, how much of it is used and when it resets. */
export interface LimitRow {
  name: string;
  percent: number;
  /** ISO time, or null when the provider did not say */
  resetsAt: string | null;
}

/** The windows a limit reports, the five-hour and seven-day ones first, then the rest by name. */
export function limitRows(limit: ProviderLimit): LimitRow[] {
  const rank = (name: string) => (name === '5h' ? 0 : name === '7d' ? 1 : 2);
  const rows = Object.entries(limit.windows).map(([name, w]) => ({
    name,
    percent: Math.max(0, Math.min(100, Math.round(w.utilization * 100))),
    resetsAt: w.resetsAt > 0 ? new Date(w.resetsAt * 1000).toISOString() : null,
  }));
  rows.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  // A provider that reports one figure and no windows still shows it
  if (rows.length === 0 && limit.utilization !== null) {
    return [{ name: limit.window ?? 'primary', percent: Math.max(0, Math.min(100, Math.round(limit.utilization * 100))), resetsAt: limit.resetsAt }];
  }
  return rows;
}
