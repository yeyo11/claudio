import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../../api';
import { formatNumber } from '@claudio/ui/lib/format';
import { PluginsTab } from '../PluginsTab';
import { ResourcesTab } from '../ResourcesTab';
import { sectionLabel, settingsHref } from '../settingsGroups';
import { ToolPresetsTab } from '../ToolPresetsTab';
import { ResourceRow } from './ResourceRow';
import { SettingsDetailRow, SettingsSection, type GroupScreenProps } from './Section';

/** The installed plugins and the marketplaces they come from. */
function PluginsRow() {
  const { t } = useTranslation(['config']);
  const { data } = useQuery({ queryKey: keys.plugins, queryFn: () => api.plugins() });
  return (
    <SettingsDetailRow
      to={settingsHref('extensions', { detail: 'plugins' })}
      label={t('plugins.row')}
      note={data ? `${formatNumber(data.installed.length)} · ${t('plugins.fromMarketplaces', { count: data.marketplaces.length })}` : undefined}
      setting="plugins.list"
    />
  );
}

/** The presets, and how many of them ship with Claudio. */
function ToolPresetsRow() {
  const { t } = useTranslation(['config']);
  const { data } = useQuery({ queryKey: keys.toolPresets, queryFn: () => api.toolPresets() });
  const shipped = data ? data.presets.filter((preset) => preset.builtIn).length : 0;
  return (
    <SettingsDetailRow
      to={settingsHref('extensions', { detail: 'tool-presets' })}
      label={t('toolPresets.row')}
      note={data ? `${formatNumber(data.presets.length)} · ${t('toolPresets.shippedCount', { count: shipped })}` : undefined}
      setting="tool-presets.list"
    />
  );
}

/**
 * Settings → Extensions (docs/plans/settings-ia.md §6.5): one row per kind, with how many there are
 * and where they come from, opening its editor. Plugins keeps its Installed / Browse / Marketplaces
 * switch inside its detail: that is the detail's content, not a third level of navigation.
 */
export function Extensions({ detail }: GroupScreenProps<'extensions'>) {
  const { t } = useTranslation(['config']);
  if (detail === 'plugins') return <PluginsTab />;
  if (detail === 'tool-presets') return <ToolPresetsTab />;
  if (detail) return <ResourcesTab scope={{}} kind={detail} />;
  return (
    <div className="settings-group">
      <SettingsSection id="plugins" title={t(sectionLabel('plugins'))}>
        <PluginsRow />
      </SettingsSection>
      {(['skills', 'agents', 'commands', 'workflows'] as const).map((kind) => (
        <SettingsSection key={kind} id={kind} title={t(sectionLabel(kind))}>
          <ResourceRow kind={kind} />
        </SettingsSection>
      ))}
      <SettingsSection id="tool-presets" title={t(sectionLabel('tool-presets'))}>
        <ToolPresetsRow />
      </SettingsSection>
    </div>
  );
}
