/**
 * The Servers routes (docs/plans/claudio-servers.md §9.2) that the shell reads: the switch and the
 * list. They are the hub's own, so every call names the hub's base: a page scoped to a remote asks
 * this one who the remote is and how it is doing, never the remote through the gateway.
 *
 * The queries live under `'servers'`, so one invalidation refreshes the switch and the list together.
 * The Servers page keeps its writes (add, edit, test, remove) in the same client.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClaudioServer, ServersSettings } from '@claudio/shared';
import { activeServerId, HUB_API, LOCAL_SERVER_ID } from '@claudio/ui/lib/server-scope';
import { requestAt, type ReadOptions } from '../../api';
import { FALLBACK_POLL_MS } from '../feed';

export const serversApi = {
  settings: (o: ReadOptions = {}) => requestAt<ServersSettings>(HUB_API, '/servers/settings', o),
  updateSettings: (enabled: boolean) => requestAt<ServersSettings>(HUB_API, '/servers/settings', { method: 'PUT', body: { enabled } satisfies ServersSettings }),
  list: (o: ReadOptions = {}) => requestAt<ClaudioServer[]>(HUB_API, '/servers', o),
};

export const serversKeys = {
  all: ['servers'] as const,
  settings: ['servers', 'settings'] as const,
  list: ['servers', 'list'] as const,
};

/**
 * Whether Servers is on. A hub that does not serve the routes (a headless Claudio is never a hub)
 * answers 404: that is "off", not an error to show, so it is not retried. `enabled` is false in a
 * remote scope, where the switch is the hub's and is not asked.
 */
export function useServersSettings(enabled = true) {
  return useQuery({ queryKey: serversKeys.settings, queryFn: ({ signal }) => serversApi.settings({ signal }), retry: false, staleTime: 60_000, enabled });
}

/** The switch, once the hub has answered: false while it is unknown, off, or this page is a remote's */
export function useServersOn(): boolean {
  const hub = activeServerId() === LOCAL_SERVER_ID;
  return useServersSettings(hub).data?.enabled === true && hub;
}

/**
 * The servers and what the hub last read of each. Health is kept in memory only and refreshed by the
 * hub while a server is in use, so a page that shows a status polls slowly (`poll`) instead of
 * trusting a reading from when it loaded.
 */
export function useServers({ enabled = true, poll = false }: { enabled?: boolean; poll?: boolean } = {}) {
  return useQuery({
    queryKey: serversKeys.list,
    queryFn: ({ signal }) => serversApi.list({ signal }),
    staleTime: 15_000,
    refetchInterval: poll ? FALLBACK_POLL_MS : false,
    enabled,
  });
}

/** The switch. Off keeps the servers and their tokens (plan D8); the list is read again either way. */
export function useUpdateServersSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => serversApi.updateSettings(enabled),
    onSuccess: (next) => {
      queryClient.setQueryData(serversKeys.settings, next);
      void queryClient.invalidateQueries({ queryKey: serversKeys.list });
    },
  });
}
