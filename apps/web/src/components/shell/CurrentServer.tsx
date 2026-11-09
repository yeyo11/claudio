import type { ClaudioServer } from '@claudio/shared';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { activeServerId, LOCAL_SERVER_ID } from '@claudio/ui/lib/server-scope';
import { useServers } from '../../lib/api/servers';
import { addressOnServer } from '../../lib/server-routes';
import { serverStatus } from '../../lib/servers-model';
import { ServerMark, ServerStatusWord } from '../ServerMark';

/**
 * The server this page drives, when it is not the hub (docs/plans/claudio-servers.md §12.1: the
 * server's name and mark stay on screen, with no banner). The hub says who it is to the hub; the
 * status of a remote is the last reading the hub has of it, polled slowly because the hub probes
 * only the server in use.
 */
export function useCurrentServer(): ClaudioServer | null {
  // The scope is the address and never changes under a mounted page, so no context is needed
  const serverId = activeServerId();
  const remote = serverId !== LOCAL_SERVER_ID;
  const servers = useServers({ enabled: remote, poll: true });
  return remote ? (servers.data?.find((server) => server.id === serverId) ?? null) : null;
}

/** The way back to the hub on the page the person is on: a link, since switching is a full load */
function useBackHref(): string {
  const { pathname } = useLocation();
  return addressOnServer(pathname, LOCAL_SERVER_ID);
}

/** The status bar's first item inside a remote scope: its mark, its name, its status word, and the way back. */
export function StatusBarServer() {
  const { t } = useTranslation('shell');
  const server = useCurrentServer();
  const back = useBackHref();
  if (!server) return null;
  return (
    <>
      <span className="statusbar-item statusbar-server" data-testid="statusbar-server">
        <ServerMark server={server} size={16} />
        <span className="ellipsis">{server.name}</span>
        <ServerStatusWord server={server} />
      </span>
      <a href={back} className="statusbar-item">
        {t('serverScope.backToThis')}
      </a>
    </>
  );
}

/** The phone has no status bar: the More sheet carries the same, as the card it shows the connection in. */
export function MoreServer() {
  const { t } = useTranslation('shell');
  const server = useCurrentServer();
  const back = useBackHref();
  if (!server) return null;
  return (
    <a href={back} className="more-connection more-server" data-testid="more-server">
      <ServerMark server={server} size={28} />
      <span className="more-connection-text">
        <span className="more-connection-title ellipsis">{server.name}</span>
        <span className="more-connection-detail ellipsis">
          {serverStatus(server) && (
            <>
              <ServerStatusWord server={server} /> ·{' '}
            </>
          )}
          {t('serverScope.backToThis')}
        </span>
      </span>
    </a>
  );
}
