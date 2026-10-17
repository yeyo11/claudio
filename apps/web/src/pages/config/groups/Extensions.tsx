import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../../api';
import { formatNumber } from '@claudio/ui/lib/format';
import { PluginsTab } from '../PluginsTab';
import { ResourcesTab } from '../ResourcesTab';
import { sectionLabel, settingsHref } from '../settingsGroups';
import { ToolPresetsTab } from '../ToolPresetsTab';
import { ResourceRow } from './ResourceRow';
import { RowSections, SettingsRowSection, type GroupScreenProps } from './Section';

/** The installed plugins and, when there are any, the marketplaces they come from. */
function PluginsRow() {
  const { t } = useTranslation(['config']);
  const { data } = useQuery({ queryKey: keys.plugins, queryFn: () => api.plugins() });
  const from = data && data.installed.length > 0 && data.marketplaces.length > 0 ? ` · ${t('plugins.fromMarketplaces', { count: data.marketplaces.length })}` : '';
  return (
    <SettingsRowSection
      id="plugins"
      to={settingsHref('extensions', { detail: 'plugins' })}
      label={t(sectionLabel('plugins'))}
      description={t('plugins.row')}
      note={data ? `${formatNumber(data.installed.length)}${from}` : undefined}
      setting="plugins.list"
    />
  );
}

/** The presets, and how many ship with Claudio when they are not all of them. */
function ToolPresetsRow() {
  const { t } = useTranslation(['config']);
  const { data } = useQuery({ queryKey: keys.toolPresets, queryFn: () => api.toolPresets() });
  const total = data?.presets.length ?? 0;
  const shipped = data ? data.presets.filter((preset) => preset.builtIn).length : 0;
  const source = shipped > 0 && shipped < total ? ` · ${t('toolPresets.shippedCount', { count: shipped })}` : '';
  return (
    <SettingsRowSection
      id="tool-presets"
      to={settingsHref('extensions', { detail: 'tool-presets' })}
      label={t(sectionLabel('tool-presets'))}
      description={t('toolPresets.row')}
      note={data ? `${formatNumber(total)}${source}` : undefined}
      setting="tool-presets.list"
    />
  );
}

/**
 * Settings → Extensions (docs/plans/settings-ia.md §6.5): one row per kind, with how many there are
 * and where they come from, opening its editor. Each kind is a section of one row, so the row names
 * it. Plugins keeps its Installed / Browse / Marketplaces switch inside its detail: that is the
 * detail's content, not a third level of navigation.
 */
export function Extensions({ detail }: GroupScreenProps<'extensions'>) {
  if (detail === 'plugins') return <PluginsTab />;
  if (detail === 'tool-presets') return <ToolPresetsTab />;
  if (detail) return <ResourcesTab scope={{}} kind={detail} />;
  return (
    <div className="settings-group">
      <RowSections>
        <PluginsRow />
        <ResourceRow kind="skills" />
        <ResourceRow kind="agents" />
        <ResourceRow kind="commands" />
        <ResourceRow kind="workflows" />
        <ToolPresetsRow />
      </RowSections>
    </div>
  );
}
