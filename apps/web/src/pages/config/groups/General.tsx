import { useTranslation } from 'react-i18next';
import { AppearanceTab } from '../AppearanceTab';
import { CliCard } from '../CliCard';
import { InstallTab } from '../InstallTab';
import { NotificationsTab } from '../NotificationsTab';
import { sectionLabel } from '../settingsGroups';
import { UpdatesCard } from '../UpdatesCard';
import { SettingsSection, type GroupScreenProps } from './Section';

/** Settings → General (§6.1). A placeholder over today's tabs, in the plan's order, until w2 builds the screen. */
export function General(_: GroupScreenProps<'general'>) {
  const { t } = useTranslation(['config']);
  return (
    <div className="settings-group">
      <SettingsSection id="appearance" title={t(sectionLabel('appearance'))}>
        <AppearanceTab />
      </SettingsSection>
      <SettingsSection id="notifications" title={t(sectionLabel('notifications'))}>
        <NotificationsTab />
      </SettingsSection>
      <SettingsSection id="updates" title={t(sectionLabel('updates'))}>
        <UpdatesCard />
        <CliCard />
      </SettingsSection>
      <SettingsSection id="install" title={t(sectionLabel('install'))}>
        <InstallTab />
      </SettingsSection>
    </div>
  );
}
