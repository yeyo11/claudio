import type { ProviderId, ProviderSettingsEntry, ProviderStatus, ProvidersSettings } from '@claudio/shared';

// Pure edits of `providers.json`: the page builds the next document with these and sends it whole,
// so a test can read every rule (what a missing entry means, what an order does with strangers)
// without a page.

const DEFAULT_ENTRY: ProviderSettingsEntry = {
  enabled: true,
  binaryPath: null,
};

/** What is chosen for one provider; a provider nobody has touched is on and searched for. */
export const entryOf = (settings: ProvidersSettings, id: ProviderId): ProviderSettingsEntry => settings.providers[id] ?? DEFAULT_ENTRY;

/**
 * The ids in the order the list shows: the settings' order first, then any provider the settings do
 * not mention yet (a new manifest), and never an id the detector does not know.
 */
export function orderedIds(statuses: readonly ProviderStatus[], settings: ProvidersSettings): ProviderId[] {
  const known = new Set(statuses.map((s) => s.id));
  const ids = settings.order.filter((id, at) => known.has(id) && settings.order.indexOf(id) === at);
  for (const { id } of statuses) if (!ids.includes(id)) ids.push(id);
  return ids;
}

/** The document with one provider's entry changed and the order made explicit. */
export function withEntry(
  settings: ProvidersSettings,
  order: readonly ProviderId[],
  id: ProviderId,
  patch: Partial<ProviderSettingsEntry>,
): ProvidersSettings {
  return {
    ...settings,
    order: [...order],
    providers: {
      ...settings.providers,
      [id]: { ...entryOf(settings, id), ...patch },
    },
  };
}

/** The newest detection among the statuses, as an ISO timestamp; null before the first one. */
export function latestCheck(statuses: readonly ProviderStatus[]): string | null {
  return statuses.reduce<string | null>((latest, s) => (latest === null || s.checkedAt > latest ? s.checkedAt : latest), null);
}
