import { useTranslation } from 'react-i18next';
import type { Scope } from '../../../api';
import { PluginsTab } from '../PluginsTab';
import { ResourcesTab } from '../ResourcesTab';
import { detailLabel, detailsOf, sectionLabel, settingsHref } from '../settingsGroups';
import { ToolPresetsTab } from '../ToolPresetsTab';
import { SettingsDetailRow, SettingsSection, type GroupScreenProps } from './Section';

const USER_SCOPE: Scope = {};

/** Settings → Extensions (§6.5). A placeholder: one row per kind opening today's tab, until w3 adds the counts. */
export function Extensions({ detail }: GroupScreenProps<'extensions'>) {
  const { t } = useTranslation(['config']);
  if (detail === 'plugins') return <PluginsTab />;
  if (detail === 'tool-presets') return <ToolPresetsTab />;
  if (detail) return <ResourcesTab scope={USER_SCOPE} kind={detail} />;
  return (
    <div className="settings-group">
      {detailsOf('extensions').map((kind) => (
        <SettingsSection key={kind} id={kind} title={t(sectionLabel(kind))}>
          <SettingsDetailRow to={settingsHref('extensions', { detail: kind })} label={t(detailLabel(kind))} setting={`${kind}.list`} />
        </SettingsSection>
      ))}
    </div>
  );
}
