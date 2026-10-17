import { useTranslation } from 'react-i18next';
import { AppearanceTab } from '../AppearanceTab';
import { CliCard } from '../CliCard';
import { InstallTab } from '../InstallTab';
import { NotificationsTab } from '../NotificationsTab';
import { PrefRows } from '../PrefRow';
import { sectionLabel } from '../settingsGroups';
import { UpdatesCard } from '../UpdatesCard';
import { SettingsSection, type GroupScreenProps } from './Section';

/**
 * Settings → General (docs/plans/settings-ia.md §6.1): how this browser looks and tells, which
 * Claudio and which Claude Code run, and the app on this device. Every choice here saves at once.
 */
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
        <PrefRows>
          <UpdatesCard />
          <CliCard />
        </PrefRows>
      </SettingsSection>
      <SettingsSection id="install" title={t(sectionLabel('install'))}>
        <InstallTab />
      </SettingsSection>
    </div>
  );
}
