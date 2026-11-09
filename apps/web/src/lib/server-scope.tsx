import { useQuery } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { Empty, Skeleton } from '@claudio/ui/components/ui';
import { activeBase, activeServerId, HUB_API, LOCAL_SERVER_ID } from '@claudio/ui/lib/server-scope';
import { requestAt } from '../api';
import { Unreachable } from '../components/Unreachable';
import { serversApi, serversKeys } from './api/servers';
import { useAuthChallenge, useAuthSettled, useHostRefusal } from './auth';
import { compatibility, readMeta } from './server-meta';
import { addressOnServer, isHubOnly } from './server-routes';

/*
 * The server the page drives: this one (`local`) or another Claudio reached through it, whose
 * pages live under `/s/<id>/…` (docs/plans/claudio-servers.md §4.3, §9.3).
 *
 * The scope is the address, fixed when the page loads: the API client, the event feed, the query
 * cache, the browser-storage keys and the router's basename are all derived from it, so nothing of
 * one server can be shown or written as another's. Switching is therefore a navigation to the
 * other address, not a state change. There is no selector yet; the scope is reached by URL.
 */

export interface ServerScope {
  /** `'local'`, or the id of the remote this page drives */
  serverId: string;
  /** The API base of the scope: `/api`, or `/api/servers/<id>/api` through the gateway */
  base: string;
  /** A remote scope: pages that belong to the hub alone are not drawn (plan D7) */
  remote: boolean;
  /**
   * Opens `serverId` on the same page when that page names no record and exists there, else on its
   * Home, after telling the hub it is being used. Rejects, and stays, when the hub refuses (the
   * feature is off, the server is unknown).
   */
  switchTo: (serverId: string) => Promise<void>;
}

const Context = createContext<ServerScope | null>(null);

export function ServerScopeProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const serverId = activeServerId();
  const switchTo = useCallback(
    async (to: string) => {
      // The hub's own gateway-less route: it records the use and probes the server
      if (to !== LOCAL_SERVER_ID) await requestAt(HUB_API, `/servers/${encodeURIComponent(to)}/use`, { method: 'POST' });
      // A full load, on purpose: module-level state (the feed, notifications, drafts in memory)
      // belongs to one server and is rebuilt from the new address
      window.location.assign(addressOnServer(pathname, to));
    },
    [pathname],
  );
  const value = useMemo<ServerScope>(() => ({ serverId, base: activeBase(), remote: serverId !== LOCAL_SERVER_ID, switchTo }), [serverId, switchTo]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useServerScope(): ServerScope {
  const value = useContext(Context);
  if (!value) throw new Error('useServerScope needs a ServerScopeProvider above it');
  return value;
}

/**
 * Whether the hub-only surface at `path` (an address, a Settings `#section`) is hidden here. The
 * desktop shell's actions use `''`: they are hub-only as a whole. One helper, so the rule is not
 * scattered as checks of the scope.
 */
export function useHubOnlyHidden(path: string = '/servers'): boolean {
  // The scope is the address and never changes under a mounted page, so no context is needed
  return activeServerId() !== LOCAL_SERVER_ID && isHubOnly(path);
}

/**
 * A state of the gate drawn with no shell around it, as `RouteError` is: its own landmark, on the page
 * the route error uses, and the tab named after the state. What it holds draws its own `Empty`.
 */
function ScopeState({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => {
    document.title = `${title} · Claudio`;
  }, [title]);
  return <main className="route-error">{children}</main>;
}

/**
 * In a remote scope, the pages wait for the server's `/meta`: one outside the range this web
 * understands gets a plain "needs an update" instead of screens that half work (plan D3), and one
 * that cannot be reached says so. The local scope renders its children at once, without a read.
 *
 * It sits above the chat package's provider, which reads the provider labels, so once the hub
 * has accepted this browser nothing is asked of a remote before its version is known to fit. The
 * hub's own sign-in and host screens come first, as they do everywhere (a refused hub could not
 * answer for the remote anyway), and while one of them shows the children render.
 */
export function ServerScopeGate({ children }: { children: ReactNode }) {
  const { remote, serverId } = useServerScope();
  const { t } = useTranslation(['shell', 'serversPage']);
  const challenge = useAuthChallenge();
  const refusal = useHostRefusal();
  const settled = useAuthSettled();
  const hubFirst = challenge !== null || refusal !== null || !settled;
  const meta = useQuery({ queryKey: ['server-meta'], queryFn: ({ signal }) => readMeta(signal), enabled: remote && !hubFirst, retry: 1, staleTime: 30_000 });
  // Only the hub knows a remote's name: asked beside /meta, and its absence never blocks the gate
  const hub = useQuery({ queryKey: serversKeys.list, queryFn: ({ signal }) => serversApi.list({ signal }), enabled: remote && !hubFirst, retry: false, staleTime: 30_000 });
  // A retry puts the query back to pending: the offline screen stays, with Retry saying it is trying
  const wasOffline = useRef(false);
  if (meta.isError) wasOffline.current = true;
  if (!remote) return <>{children}</>;
  // The app draws nothing until the first probe has answered, so there is nothing to mount yet: and
  // mounting the chat provider now would read the provider labels from a remote ahead of its version
  if (!settled) return null;
  if (hubFirst) return <>{children}</>;
  // The hub knows the server by name and address: the screens below speak of it, not of "this server"
  const known = hub.data?.find((server) => server.id === serverId);
  const name = known?.name ?? t('serversPage:remote.fallbackName');
  const back = (
    <a href="/" className="btn">
      {t('serversPage:remote.offline.back')}
    </a>
  );
  const all = (
    <a href="/servers" className="btn">
      {t('serversPage:remote.offline.servers')}
    </a>
  );
  if ((meta.isPending && !wasOffline.current) || hub.isLoading) return <Skeleton rows={4} />;
  if (meta.isError || (wasOffline.current && meta.isPending)) {
    return (
      <ScopeState title={t('serversPage:remote.offline.title', { name })}>
        <Unreachable
          remote={{
            name,
            address: known?.health?.address ?? known?.addresses[0]?.url ?? null,
            retrying: meta.isFetching,
            onRetry: () => void meta.refetch(),
            actions: (
              <>
                {back}
                {all}
              </>
            ),
          }}
        />
      </ScopeState>
    );
  }
  if (!meta.data) return <Skeleton rows={4} />;
  const fit = compatibility(meta.data);
  if (fit === 'ok') return <>{children}</>;
  const title = t('serversPage:remote.needsUpdate.title', { name });
  const remoteVersion = meta.data.version;
  return (
    <ScopeState title={title}>
      <Empty
        illustration="install"
        size="md"
        heading
        title={title}
        action={
          <span className="route-error-actions">
            {back}
            {all}
          </span>
        }
      >
        <span data-testid="needs-update-text">
          {fit === 'server-too-old' ? t('serversPage:remote.needsUpdate.remoteOld', { name, remote: remoteVersion }) : t('serversPage:remote.needsUpdate.localOld', { name, remote: remoteVersion })}
        </span>
      </Empty>
    </ScopeState>
  );
}
