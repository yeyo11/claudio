import { useTranslation } from 'react-i18next';
import { EvalsSettings, RunsSettings, SpendSettings } from '../AppSettingsCards';
import { sectionLabel } from '../settingsGroups';
import { SettingsSection, type GroupScreenProps } from './Section';

/**
 * Settings → Runs & spend (docs/plans/settings-ia.md §6.7): what a new run gets, what all of it may
 * spend in a day, and the evals' second phase. Each section saves on its own. Usage, the status bar
 * and the spend cap's question link to `#spend-cap`.
 */
export function Runs(_: GroupScreenProps<'runs'>) {
  const { t } = useTranslation(['config']);
  return (
    <div className="settings-group settings-cards">
      <SettingsSection id="runs" title={t(sectionLabel('runs'))}>
        <RunsSettings />
      </SettingsSection>
      <SettingsSection id="spend-cap" title={t(sectionLabel('spend-cap'))}>
        <SpendSettings />
      </SettingsSection>
      <SettingsSection id="evals" title={t(sectionLabel('evals'))}>
        <EvalsSettings />
      </SettingsSection>
    </div>
  );
}
