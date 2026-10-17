import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, keys, type Scope } from '../../../api';
import { ErrorBox, Skeleton } from '@claudio/ui/components/ui';
import { formatNumber } from '@claudio/ui/lib/format';
import { ConnectorsSection } from '../ConnectorsSection';
import { IntegrationsTab } from '../IntegrationsTab';
import { McpTab, serverTransport } from '../McpTab';
import { sectionLabel, settingsHref } from '../settingsGroups';
import { SettingsDetailRow, SettingsSection, type GroupScreenProps } from './Section';

const USER_SCOPE: Scope = {};

/** One line per server of the account, name in mono, how it is reached and its scope; the editor is the detail. */
function McpServers() {
  const { t } = useTranslation(['config']);
  const { data, error, isLoading } = useQuery({ queryKey: keys.mcp(USER_SCOPE), queryFn: () => api.mcpServers(USER_SCOPE) });
  const servers = data ?? [];
  return (
    <>
      <ErrorBox error={error} />
      {isLoading ? (
        <Skeleton rows={2} />
      ) : servers.length === 0 ? (
        <p className="small muted">{t('mcp.empty')}</p>
      ) : (
        <ul className="app-settings-hosts" aria-label={t('mcp.listAria')}>
          {servers.map((server) => (
            <li key={`${server.scope}:${server.name}`} className="app-settings-host">
              <span className="mono">{server.name}</span>
              {/* The transport and the scope are the CLI's own words, untranslated (GLOSSARY) */}
              <span className="muted">
                {serverTransport(server.config)} · {server.scope}
              </span>
            </li>
          ))}
        </ul>
      )}
      <SettingsDetailRow
        to={settingsHref('connections', { detail: 'mcp' })}
        label={t('mcp.row')}
        note={data ? formatNumber(servers.length) : undefined}
        setting="mcp.servers"
      />
    </>
  );
}

/**
 * Settings → Connections (docs/plans/settings-ia.md §6.3): the claude.ai connectors, the code hosts,
 * the trackers, the webhooks and the MCP servers, each a section; the MCP editor is the one detail.
 */
export function Connections({ detail }: GroupScreenProps<'connections'>) {
  const { t } = useTranslation(['config']);
  if (detail === 'mcp') return <McpTab scope={USER_SCOPE} />;
  return (
    <div className="settings-group">
      <SettingsSection id="connectors" title={t(sectionLabel('connectors'))}>
        <ConnectorsSection />
      </SettingsSection>
      <IntegrationsTab />
      <SettingsSection id="mcp" title={t(sectionLabel('mcp'))}>
        <McpServers />
      </SettingsSection>
    </div>
  );
}
