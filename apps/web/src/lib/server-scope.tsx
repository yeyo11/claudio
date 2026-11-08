import { useQuery } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { Empty, Skeleton } from '@claudio/ui/components/ui';
import { activeBase, activeServerId, HUB_API, LOCAL_SERVER_ID } from '@claudio/ui/lib/server-scope';
import { requestAt } from '../api';
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
 * In a remote scope, the pages wait for the server's `/meta`: one outside the range this web
 * understands gets a plain "needs an update" instead of screens that half work (plan D3), and one
 * that cannot be reached says so. The local scope renders its children at once, without a read.
 */
export function ServerScopeGate({ children }: { children: ReactNode }) {
  const { remote } = useServerScope();
  const { t } = useTranslation('shell');
  const meta = useQuery({ queryKey: ['server-meta'], queryFn: ({ signal }) => readMeta(signal), enabled: remote, retry: 1, staleTime: 30_000 });
  if (!remote) return <>{children}</>;
  const back = (
    <a href="/" className="btn">
      {t('serverScope.backToThis')}
    </a>
  );
  if (meta.isPending) {
    return (
      <div aria-label={t('serverScope.loading')}>
        <Skeleton rows={4} />
      </div>
    );
  }
  if (meta.isError) {
    return (
      <Empty
        illustration="offline"
        size="md"
        title={t('serverScope.unreachable.title')}
        action={
          <>
            <button type="button" className="btn btn-primary" onClick={() => void meta.refetch()}>
              {t('serverScope.retry')}
            </button>
            {back}
          </>
        }
      >
        {t('serverScope.unreachable.body')}
      </Empty>
    );
  }
  const fit = compatibility(meta.data);
  if (fit === 'ok') return <>{children}</>;
  return (
    <Empty illustration="install" size="md" title={t('serverScope.needsUpdate.title')} action={back}>
      {fit === 'server-too-old' ? t('serverScope.needsUpdate.remote') : t('serverScope.needsUpdate.local')}
    </Empty>
  );
}
