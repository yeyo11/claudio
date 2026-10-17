import { useTranslation } from 'react-i18next';
import type { Scope } from '../../../api';
import { Connectors } from '../../Connectors';
import { IntegrationsTab } from '../IntegrationsTab';
import { McpTab } from '../McpTab';
import { detailLabel, sectionLabel, settingsHref } from '../settingsGroups';
import { SettingsDetailRow, SettingsSection, type GroupScreenProps } from './Section';

const USER_SCOPE: Scope = {};

/**
 * Settings → Connections (§6.3). A placeholder over today's pages, in the plan's order, until w3
 * builds the screen: Integrations still draws its hosts, trackers and webhooks as one block.
 */
export function Connections({ detail }: GroupScreenProps<'connections'>) {
  const { t } = useTranslation(['config']);
  if (detail === 'mcp') return <McpTab scope={USER_SCOPE} />;
  return (
    <div className="settings-group">
      <SettingsSection id="connectors" title={t(sectionLabel('connectors'))}>
        <Connectors />
      </SettingsSection>
      <SettingsSection id="code-hosts" title={t(sectionLabel('code-hosts'))}>
        <IntegrationsTab />
      </SettingsSection>
      <SettingsSection id="mcp" title={t(sectionLabel('mcp'))}>
        <SettingsDetailRow to={settingsHref('connections', { detail: 'mcp' })} label={t(detailLabel('mcp'))} setting="mcp.servers" />
      </SettingsSection>
    </div>
  );
}
