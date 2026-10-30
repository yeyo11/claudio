import type { AccountLimit, ProviderId, ProviderLimit } from '@claudio/shared';

/*
 * A provider's limit is no reading of its own. Claude's used to be the last `rate_limit_event` of any
 * chat on any account (`ProviderLimits`, the `provider_limits` row): the status bar's dot showed
 * whichever account ran last while its chip showed another, and a wait took another account's reset
 * (regression audit 2026-10-29, §2.4, §2.7, §2.11). Now every reading is an account's, and Claude's
 * limit is the one of the account in use (`Core.accountView()`), derived here.
 */

/** Where the detector reads each provider's limit; Core derives Claude's from the account view. */
export interface ProviderLimitSource {
  /** The provider's limit as it stands now; null when nothing was read */
  get(provider: ProviderId): ProviderLimit | null;
  /** Whether no account of the provider can take new work: what makes it `degraded` with `limit-reached` */
  atLimit(provider: ProviderId): boolean;
  /** Called when an account's reading or state changed; returns how to stop listening */
  onChange?(listener: () => void): () => void;
}

/** An account's reading as its provider's limit: the same windows, state and reset, nothing added. */
export function providerLimitOf(provider: ProviderId, limit: AccountLimit | null): ProviderLimit | null {
  if (!limit) return null;
  return {
    provider,
    state: limit.state,
    window: limit.window,
    utilization: limit.utilization,
    resetsAt: limit.resetsAt,
    windows: limit.windows,
    observedAt: limit.observedAt,
    // `get_usage` and the CLI's cache are reads that spend nothing
    source: limit.source === 'stream' || limit.source === 'failure' ? limit.source : 'probe',
  };
}
