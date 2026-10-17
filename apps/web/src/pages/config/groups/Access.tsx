import { useTranslation } from 'react-i18next';
import { RemoteAccessTab } from '../RemoteAccessTab';
import { AgentReadsCard } from '../security/AgentReadsCard';
import { AuditCard, SecurityTab } from '../SecurityTab';
import { sectionLabel } from '../settingsGroups';
import { SettingsSection, type GroupScreenProps } from './Section';

/** Settings → Access & safety (§6.8). A placeholder over today's Security and Remote access tabs, until w4 builds the screen. */
export function Access({ detail }: GroupScreenProps<'access'>) {
  const { t } = useTranslation(['config']);
  if (detail === 'audit') return <AuditCard />;
  if (detail === 'agent-reads') return <AgentReadsCard />;
  return (
    <div className="settings-group">
      <SettingsSection id="access" title={t(sectionLabel('access'))}>
        <SecurityTab />
      </SettingsSection>
      <SettingsSection id="remote" title={t(sectionLabel('remote'))}>
        <RemoteAccessTab />
      </SettingsSection>
    </div>
  );
}
