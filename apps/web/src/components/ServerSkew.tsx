import { useQuery } from '@tanstack/react-query';
import { ArrowUpCircle, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ICON, ICON_SM } from '@claudio/ui/components/icons';
import { serversApi, serversKeys } from '../lib/api/servers';
import { BUILD_VERSION } from '../lib/reload';
import { isNewerVersion, readMeta } from '../lib/server-meta';
import { useServerScope } from '../lib/server-scope';
import { settingsHref } from '../pages/config/settingsGroups';

/**
 * The remote's version when it is newer than this page's own build, else null. Inside a remote the
 * page is the hub's build driving the remote's API (docs/servers.md): the routes may well fit (the
 * scope gate checks that), yet what the remote's newer release draws does not show here, which is
 * how a hub on 0.15.0 drew 0.16.0's subagent messages as the person's bubbles. A reload cannot fix
 * that; updating this Claudio does.
 */
export function remoteAhead(remote: boolean, remoteVersion: string | null | undefined, build: string): string | null {
  if (!remote || !build || !remoteVersion) return null;
  return isNewerVersion(remoteVersion, build) ? remoteVersion : null;
}

/** Versions already waved away in this tab, so a dismissal holds across the remote's pages */
const dismissed = new Set<string>();

/**
 * The notice inside another server's pages when that server runs a newer Claudio than the one this
 * page was built from. It blocks nothing and takes the reload banner's place, with the one action
 * that helps: this Claudio's own updates, outside the remote scope.
 */
export function ServerSkewBanner({ build = BUILD_VERSION }: { build?: string }) {
  const { t } = useTranslation('serversPage');
  const { remote, serverId } = useServerScope();
  // The same queries the scope gate makes: answered from its cache, never a second request
  const meta = useQuery({ queryKey: ['server-meta'], queryFn: ({ signal }) => readMeta(signal), enabled: remote, retry: 1, staleTime: 30_000 });
  const hub = useQuery({ queryKey: serversKeys.list, queryFn: ({ signal }) => serversApi.list({ signal }), enabled: remote, retry: false, staleTime: 30_000 });
  const ahead = remoteAhead(remote, meta.data?.version, build);
  const [, setTick] = useState(0);
  if (!ahead || dismissed.has(`${serverId}:${ahead}`)) return null;
  const name = hub.data?.find((server) => server.id === serverId)?.name ?? t('remote.fallbackName');
  return (
    <div className="alert alert-warn reload-banner" role="status" data-testid="server-skew-banner">
      <ArrowUpCircle className="alert-icon" {...ICON_SM} />
      <span className="alert-body reload-banner-text">{t('remote.behind.text', { name, remote: ahead, local: build })}</span>
      {/* A plain link: it leaves the remote's scope for this Claudio's own Settings */}
      <a className="btn btn-small" href={settingsHref('general', { section: 'updates' })}>
        {t('remote.behind.action')}
      </a>
      <button
        type="button"
        className="icon-btn"
        aria-label={t('remote.behind.dismiss')}
        onClick={() => {
          dismissed.add(`${serverId}:${ahead}`);
          setTick((n) => n + 1);
          // The button goes with the banner: focus goes on to the page, never to the body
          document.getElementById('main')?.focus();
        }}
      >
        <X {...ICON} />
      </button>
    </div>
  );
}
