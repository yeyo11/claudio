import type { AgentReadEntry, SharedProject } from '@claudio/shared';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Card, Empty, ErrorBox, Skeleton } from '@claudio/ui/components/ui';
import { formatDateTime } from '@claudio/ui/lib/format';
import { teammateLabel } from '../../../components/TeammateName';
import { collaboratorsApi, collaboratorsKeys, useSharedProjects, type AgentReadQuery } from '../../../lib/api/collaborators';
import { Tooltip } from '@claudio/ui/components/controls/Tooltip';

/** The newest reads the card lists: the route keeps 20,000, a person reads the recent ones */
export const AGENT_READS_SHOWN = 50;
const QUERY: AgentReadQuery = { limit: AGENT_READS_SHOWN };

/**
 * Settings → Security → Read by agents (docs/plans/collaborators-agent-access.md): every read an
 * agent of this install made of what teammates share, newest first, with the chat that read it, the
 * tool, whose copy and what of it. Agents' tools send no event, so it is read again while open.
 */
export function AgentReadsCard() {
  const reads = useQuery({
    queryKey: collaboratorsKeys.agentReads(QUERY),
    queryFn: ({ signal }) => collaboratorsApi.agentReads(QUERY, { signal }),
    refetchInterval: 15_000,
  });
  const shared = useSharedProjects();

  // An old `#agent-reads` link lands on the card once the screen has drawn it
  useEffect(() => {
    if (window.location.hash === '#agent-reads') document.getElementById('agent-reads')?.scrollIntoView?.({ block: 'start' });
  }, [reads.isSuccess]);

  return (
    <div id="agent-reads">
      <AgentReadsView
        reads={reads.data?.reads}
        error={reads.error}
        shared={shared.data ?? []}
        refreshing={reads.isFetching}
        onRefresh={() => void reads.refetch()}
      />
    </div>
  );
}

/** The card from its data, so a test draws each state without a server. */
export function AgentReadsView({
  reads,
  error,
  shared,
  refreshing = false,
  onRefresh,
}: {
  reads: readonly AgentReadEntry[] | undefined;
  error?: unknown;
  shared: readonly SharedProject[];
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  const { t } = useTranslation('collaborators');
  return (
    <Card
      title={t('agentReads.audit.title')}
      actions={
        onRefresh && (
          <button type="button" className="icon-btn" aria-label={t('agentReads.audit.refresh')} disabled={refreshing} onClick={onRefresh}>
            <RefreshCw {...ICON_SM} />
          </button>
        )
      }
    >
      <p className="small muted">{t('agentReads.audit.intro')}</p>
      <ErrorBox error={error} />
      {!reads ? (
        !error && <Skeleton rows={4} />
      ) : reads.length === 0 ? (
        <Empty title={t('agentReads.audit.none')}>{t('agentReads.audit.noneHint')}</Empty>
      ) : (
        <div className="table-wrap" role="group" aria-label={t('agentReads.audit.title')} tabIndex={0}>
          <table className="table" aria-label={t('agentReads.audit.title')}>
            <thead>
              <tr>
                <th scope="col">{t('agentReads.audit.when')}</th>
                <th scope="col">{t('agentReads.audit.chat')}</th>
                <th scope="col">{t('agentReads.audit.tool')}</th>
                <th scope="col">{t('agentReads.audit.copy')}</th>
                <th scope="col">{t('agentReads.audit.what')}</th>
              </tr>
            </thead>
            <tbody>
              {reads.map((read) => (
                <tr key={read.id}>
                  <td className="small muted nowrap">{formatDateTime(read.at)}</td>
                  <td className="small mono">
                    <Tooltip content={read.chatId}>
                      <Link to={`/chats/${encodeURIComponent(read.chatId)}`}>{read.chatId.slice(0, 8)}</Link>
                    </Tooltip>
                  </td>
                  <td className="small mono break">{read.tool}</td>
                  <td className="small">
                    <span className="break">{teammateLabel(shared, read.owner, read.shareId) ?? t('agentReads.audit.goneCopy')}</span>{' '}
                    <span className="mono muted break">{read.shareKey}</span>
                  </td>
                  <td className="small nowrap">
                    {read.kind ? t(`sharing.kinds.${read.kind}`) : t('agentReads.audit.list')}
                    {read.recordIds.length > 0 && <span className="muted tnum"> · {t('agentReads.audit.records', { count: read.recordIds.length })}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
