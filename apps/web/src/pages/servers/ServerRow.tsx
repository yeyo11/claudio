import type { ClaudioReleaseInfo, ClaudioServer } from '@claudio/shared';
import { ArrowUpCircle, ExternalLink, KeyRound, Pencil, PlugZap, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { MoreActions } from '@claudio/ui/components/controls/MoreActions';
import type { MenuEntry } from '@claudio/ui/components/controls/Menu';
import { ICON_SM } from '@claudio/ui/components/icons';
import { formatNumber, timeAgo } from '@claudio/ui/lib/format';
import { NARROW, useMediaQuery } from '@claudio/ui/lib/media';
import { useRemoteUpdate } from '../../lib/api/servers';
import { BUILD_VERSION } from '../../lib/reload';
import { isNewerVersion } from '../../lib/server-meta';
import { canUpdateServer, needsPairingAgain, shownAddress } from '../../lib/servers-model';
import { ServerMark, ServerStatusWord } from '../../components/ServerMark';
import { codeWords } from './words';

export interface RowActions {
  onOpen: (server: ClaudioServer) => void;
  onTest: (server: ClaudioServer) => void;
  onEdit: (server: ClaudioServer) => void;
  onRemove: (server: ClaudioServer) => void;
  onPairAgain: (server: ClaudioServer) => void;
  onUpdate: (server: ClaudioServer, release: ClaudioReleaseInfo) => void;
}

/**
 * What a row says about a server besides its name: version, latency, the address in use, last use.
 * Mono only for the address. A server on a newer Claudio than this one says so beside its version:
 * its pages here are drawn by this Claudio's older build, so some of what it has does not show.
 */
export function ServerFacts({ server, build = BUILD_VERSION }: { server: ClaudioServer; build?: string }) {
  const { t } = useTranslation('serversPage');
  const health = server.health;
  const why = health && health.status !== 'connected' ? codeWords('reason', health.reason?.code) : null;
  return (
    <>
      <span className="small muted server-row-facts">
        {health?.version && <span>{t('row.version', { version: health.version })}</span>}
        {health?.version && build && isNewerVersion(health.version, build) && <span className="text-warn server-row-newer">{t('row.newer', { local: build })}</span>}
        {health?.latencyMs != null && <span className="tnum">{t('row.latency', { ms: formatNumber(health.latencyMs) })}</span>}
        <span>{server.lastUsedAt ? t('row.lastUsed', { when: timeAgo(server.lastUsedAt) }) : t('row.neverUsed')}</span>
      </span>
      {health?.address && (
        <span className="small muted server-row-address">
          {t('row.address')} <code className="mono server-row-url" title={health.address}>
            {shownAddress(health.address)}
          </code>
        </span>
      )}
      {why && <span className="small server-row-why">{why}</span>}
    </>
  );
}

/**
 * One server of the list: tile, name, status in a word, the facts, and the actions. On a phone every
 * action is in one "⋯" sheet; on a desktop Open (or Pair again) and Test connection are buttons, and
 * Update shows only when the server says a newer release is out and its update unit can install it.
 */
export function ServerRow({ server, busy, actions }: { server: ClaudioServer; busy: boolean; actions: RowActions }) {
  const { t } = useTranslation('serversPage');
  const narrow = useMediaQuery(NARROW);
  const status = server.health?.status ?? null;
  const again = needsPairingAgain(server);
  // Only a connected server answers through its gateway: any other status would be a refusal, not a "no"
  const update = useRemoteUpdate(server.id, status === 'connected');
  const release = update.data?.release;
  const canUpdate = canUpdateServer(release, update.data?.unit);

  const primary = again ? (
    <button type="button" className="btn" disabled={busy} aria-label={`${t('actions.pairAgain')} ${server.name}`} onClick={() => actions.onPairAgain(server)} data-testid="server-pair-again">
      <KeyRound {...ICON_SM} /> {t('actions.pairAgain')}
    </button>
  ) : (
    <button type="button" className="btn" disabled={busy} aria-label={`${t('actions.open')} ${server.name}`} onClick={() => actions.onOpen(server)} data-testid="server-open">
      <ExternalLink {...ICON_SM} /> {t('actions.open')}
    </button>
  );

  const entries: MenuEntry[] = [
    ...(narrow ? [{ id: again ? 'pair-again' : 'open', label: again ? t('actions.pairAgain') : t('actions.open'), icon: again ? KeyRound : ExternalLink, onSelect: () => (again ? actions.onPairAgain(server) : actions.onOpen(server)) }] : []),
    ...(narrow ? [{ id: 'test', label: t('actions.test'), icon: PlugZap, onSelect: () => actions.onTest(server) }] : []),
    ...(canUpdate && release && narrow ? [{ id: 'update', label: t('actions.update'), icon: ArrowUpCircle, onSelect: () => actions.onUpdate(server, release) }] : []),
    { id: 'edit', label: t('actions.edit'), icon: Pencil, onSelect: () => actions.onEdit(server) },
    { id: 'remove', label: t('actions.remove'), icon: Trash2, destructive: true, onSelect: () => actions.onRemove(server) },
  ];

  return (
    <li className="server-row" data-testid="server-row" data-server-id={server.id} data-status={status ?? 'unchecked'}>
      <ServerMark server={server} size={36} className="server-mark" />
      <div className="server-row-main">
        <div className="server-row-head">
          <span className="server-row-name">{server.name}</span>
          <ServerStatusWord status={status} unchecked />
        </div>
        <ServerFacts server={server} />
      </div>
      <div className="server-row-actions">
        {!narrow && (
          <>
            {primary}
            <button type="button" className="btn" disabled={busy} aria-label={`${t('actions.test')} ${server.name}`} onClick={() => actions.onTest(server)} data-testid="server-test-open">
              <PlugZap {...ICON_SM} /> {t('actions.test')}
            </button>
            {canUpdate && release && (
              <button type="button" className="btn" disabled={busy} aria-label={`${t('actions.update')} ${server.name}`} onClick={() => actions.onUpdate(server, release)} data-testid="server-update">
                <ArrowUpCircle {...ICON_SM} /> {t('actions.update')}
              </button>
            )}
          </>
        )}
        <MoreActions entries={entries} label={t('actions.more', { name: server.name })} title={t('actions.moreTitle', { name: server.name })} />
      </div>
    </li>
  );
}
