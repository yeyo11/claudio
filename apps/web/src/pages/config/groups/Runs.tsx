import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Loading } from '@claudio/ui/components/ui';
import { EvalsSettings, RunsSettings, SpendSettings } from '../AppSettingsCards';
import { sectionLabel, settingsHref } from '../settingsGroups';
import { SettingsRowSection, SettingsSection, type GroupScreenProps } from './Section';

// Its own chunk: the charts and their stylesheet are for the one screen that draws them
const MachinePage = lazy(() => import('../MachinePage').then((m) => ({ default: m.MachinePage })));

/**
 * Settings → Runs & spend (docs/plans/settings-ia.md §6.7): what a new run gets, what all of it may
 * spend in a day, and the evals' second phase. Each section saves on its own. Usage, the status bar
 * and the spend cap's question link to `#spend-cap`. The Machine row opens the detail with the machine's history.
 */
export function Runs({ detail }: GroupScreenProps<'runs'>) {
  const { t } = useTranslation(['config']);
  if (detail === 'machine') {
    return (
      <Suspense fallback={<Loading />}>
        <MachinePage />
      </Suspense>
    );
  }
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
      <SettingsRowSection
        id="machine"
        to={settingsHref('runs', { detail: 'machine' })}
        label={t(sectionLabel('machine'))}
        description={t('config:settings.rows.machine.history')}
        setting="machine.history"
      />
    </div>
  );
}
