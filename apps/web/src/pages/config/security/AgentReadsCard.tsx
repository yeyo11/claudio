import type { AgentReadEntry, SharedProject } from '@claudio/shared';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Card, Empty, ErrorBox, Skeleton } from '@claudio/ui/components/ui';
import { formatDateTime } from '@claudio/ui/lib/format';
import { teammateLabel } from '../../../components/TeammateName';
import { collaboratorsApi, collaboratorsKeys, useSharedProjects, type AgentReadQuery } from '../../../lib/api/collaborators';
import { Tooltip } from '@claudio/ui/components/controls/Tooltip';
import { SettingsDetailRow } from '../groups/Section';
import { settingsHref } from '../settingsGroups';

/** The newest reads the detail lists: the route keeps 20,000, a person reads the recent ones */
export const AGENT_READS_SHOWN = 50;
/** The ones the group's screen shows above the row that opens the rest */
export const AGENT_READS_LATEST = 5;
const QUERY: AgentReadQuery = { limit: AGENT_READS_SHOWN };
const LATEST: AgentReadQuery = { limit: AGENT_READS_LATEST };

/**
 * Settings → Access & safety → Agent reads (docs/plans/collaborators-agent-access.md): every read an
 * agent of this install made of what teammates share, newest first, with the chat that read it, the
 * tool, whose copy and what of it. Agents' tools send no event, so it is read again while open.
 */
export function AgentReadsCard() {
  return <AgentReads query={QUERY} />;
}

/** The Agent reads section of Access & safety: the latest few, and the row that opens every one. */
export function AgentReadsLatest() {
  const { t } = useTranslation('collaborators');
  return (
    <>
      <AgentReads query={LATEST} />
      <SettingsDetailRow to={settingsHref('access', { detail: 'agent-reads' })} label={t('agentReads.audit.openAll')} />
    </>
  );
}

function AgentReads({ query }: { query: AgentReadQuery }) {
  const reads = useQuery({
    queryKey: collaboratorsKeys.agentReads(query),
    queryFn: ({ signal }) => collaboratorsApi.agentReads(query, { signal }),
    refetchInterval: 15_000,
  });
  const shared = useSharedProjects();
  return (
    <AgentReadsView
      reads={reads.data?.reads}
      error={reads.error}
      shared={shared.data ?? []}
      refreshing={reads.isFetching}
      onRefresh={() => void reads.refetch()}
    />
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
