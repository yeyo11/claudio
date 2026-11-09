/**
 * The Servers routes (docs/plans/claudio-servers.md §9.2): the switch, the list of the other
 * Claudios this one drives, and the two halves of pairing. They are the hub's own: every call goes
 * to `HUB_API` whatever the page's scope, because a hub never forwards `/servers*` to a remote (D7)
 * and because the page that uses them is hidden in a remote scope anyway.
 *
 * Every query is keyed under `'servers'`, so a write marks the list, the switch and the connected
 * hubs stale together. No event announces a change here: the page's own writes invalidate, and a
 * health reading is taken only by a use, a test or gateway traffic (nothing polls).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AddServerRequest,
  ClaudioReleaseInfo,
  ClaudioServer,
  DesktopUpdateStatus,
  RemoveServerResult,
  ServerLink,
  ServerLinkCode,
  ServerPairing,
  ServersSettings,
  ServerTestResult,
  UpdateServerRequest,
} from '@claudio/shared';
import { HUB_API } from '@claudio/ui/lib/server-scope';
import { enc, requestAt, type ReadOptions } from '../../api';

/**
 * `POST /servers/:id/pair`'s answer (plan §12.2 E3): the server as it is now, and what became of
 * the token it replaced. Declared here, not in `@claudio/shared`, where the route's owner defines it.
 */
export type PairAgainResult = ClaudioServer & { previousToken: RemoveServerResult };

const hub = <T>(path: string, init: Parameters<typeof requestAt>[2] = {}) => requestAt<T>(HUB_API, path, init);

export const serversApi = {
  settings: (o: ReadOptions = {}) => hub<ServersSettings>('/servers/settings', o),
  setEnabled: (enabled: boolean) => hub<ServersSettings>('/servers/settings', { method: 'PUT', body: { enabled } }),
  list: (o: ReadOptions = {}) => hub<ClaudioServer[]>('/servers', o),
  add: (body: AddServerRequest) => hub<ClaudioServer>('/servers', { method: 'POST', body }),
  update: (id: string, body: UpdateServerRequest) => hub<ClaudioServer>(`/servers/${enc(id)}`, { method: 'PATCH', body }),
  remove: (id: string, force = false) => hub<RemoveServerResult>(`/servers/${enc(id)}${force ? '?force=true' : ''}`, { method: 'DELETE' }),
  test: (id: string) => hub<ServerTestResult>(`/servers/${enc(id)}/test`, { method: 'POST' }),
  /** Records the use and takes a health reading: what the page's Open does before it switches */
  use: (id: string) => hub<ClaudioServer>(`/servers/${enc(id)}/use`, { method: 'POST' }),
  pairAgain: (id: string, pairing: ServerPairing) => hub<PairAgainResult>(`/servers/${enc(id)}/pair`, { method: 'POST', body: pairing }),

  /** This Claudio as a remote: a one-time code for another Claudio, and the hubs holding a token of this one */
  linkCode: () => hub<ServerLinkCode>('/server-links/code', { method: 'POST' }),
  links: (o: ReadOptions = {}) => hub<ServerLink[]>('/server-links', o),
  revokeLink: (tokenId: string) => hub<null>(`/server-links/${enc(tokenId)}`, { method: 'DELETE' }),
};

/**
 * What the page asks of a remote through the gateway, for the Update action: the release check and
 * the desktop update unit of that server. They go to the gateway path of the server, owner only.
 */
export const remoteUpdateApi = {
  release: (id: string, o: ReadOptions = {}) => requestAt<ClaudioReleaseInfo>(`${HUB_API}/servers/${enc(id)}/api`, '/system/release', o),
  desktopUpdate: (id: string, o: ReadOptions = {}) => requestAt<DesktopUpdateStatus>(`${HUB_API}/servers/${enc(id)}/api`, '/system/desktop-update', o),
  startDesktopUpdate: (id: string) => requestAt<DesktopUpdateStatus>(`${HUB_API}/servers/${enc(id)}/api`, '/system/desktop-update', { method: 'POST' }),
};

export const serversKeys = {
  all: ['servers'] as const,
  settings: ['servers', 'settings'] as const,
  list: ['servers', 'list'] as const,
  links: ['servers', 'links'] as const,
  update: (id: string) => ['servers', 'update', id] as const,
};

export const useServersSettings = () => useQuery({ queryKey: serversKeys.settings, queryFn: ({ signal }) => serversApi.settings({ signal }) });
export const useServersList = (enabled = true) => useQuery({ queryKey: serversKeys.list, queryFn: ({ signal }) => serversApi.list({ signal }), enabled });
export const useServerLinks = (enabled = true) => useQuery({ queryKey: serversKeys.links, queryFn: ({ signal }) => serversApi.links({ signal }), enabled });

/**
 * One server's update state, read through its gateway: whether a newer release is out and where its
 * desktop update unit stands. Only asked for a server that is connected, since every other status
 * refuses the gateway; a refusal (an older Claudio without the route) simply means "no Update".
 */
export function useRemoteUpdate(id: string, enabled: boolean) {
  return useQuery({
    queryKey: serversKeys.update(id),
    enabled,
    retry: false,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const [release, unit] = await Promise.all([remoteUpdateApi.release(id, { signal }), remoteUpdateApi.desktopUpdate(id, { signal })]);
      return { release, unit };
    },
  });
}

/** A write to the hub's servers: runs `fn`, then marks everything under `'servers'` stale */
export function useServersMutation<TVars, TData>(fn: (vars: TVars) => Promise<TData>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => queryClient.invalidateQueries({ queryKey: serversKeys.all }),
  });
}
