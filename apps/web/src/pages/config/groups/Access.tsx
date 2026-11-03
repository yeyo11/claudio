import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../../api';
import { ErrorBox, Skeleton } from '@claudio/ui/components/ui';
import { SecretsCard } from '../../../components/setup/SecretsCard';
import { HostsSettings } from '../AppSettingsCards';
import { GuardsCard } from '../GuardsCard';
import { RemoteAccessTab } from '../RemoteAccessTab';
import { AccessCard, ReadOnlyCard, TokenCard } from '../security/AccessCards';
import { AgentReadsCard, AgentReadsLatest } from '../security/AgentReadsCard';
import { AuditCard, AuditLatest } from '../security/AuditCard';
import { TerminalCard } from '../security/TerminalCard';
import { sectionLabel } from '../settingsGroups';
import { SettingsSection, type GroupScreenProps } from './Section';

/**
 * Settings → Access & safety (docs/plans/settings-ia.md §6.8): who may use this wrapper and what
 * they may do, and the logs of what was done. Everything here administers the guard itself, so a
 * mistake locks the person out of their own wrapper: the pieces that can do that ask first. The two
 * logs show their latest rows here; each detail owns its filters.
 */
export function Access({ detail }: GroupScreenProps<'access'>) {
  const { t } = useTranslation(['config']);
  const auth = useQuery({ queryKey: keys.securityAuth, queryFn: api.securityAuth });

  if (detail === 'audit') {
    return (
      <div className="settings-group settings-cards" data-setting="audit.log">
        <AuditCard />
      </div>
    );
  }
  if (detail === 'agent-reads') {
    return (
      <div className="settings-group settings-cards" data-setting="agent-reads.log">
        <AgentReadsCard />
      </div>
    );
  }

  return (
    <div className="settings-group settings-cards">
      <SettingsSection id="access" title={t(sectionLabel('access'))}>
        <ErrorBox error={auth.error} />
        {auth.isLoading && <Skeleton rows={6} />}
        {auth.data && (
          <>
            {/* Remounted from the server's copy whenever it changes, so the draft never outlives it */}
            <AccessCard key={JSON.stringify(auth.data)} auth={auth.data} />
            <TokenCard auth={auth.data} />
            <ReadOnlyCard auth={auth.data} />
          </>
        )}
        <p className="small muted">{t('security.footnote')}</p>
      </SettingsSection>
      <SettingsSection id="hosts" title={t(sectionLabel('hosts'))}>
        <HostsSettings />
      </SettingsSection>
      <SettingsSection id="remote" title={t(sectionLabel('remote'))}>
        {/* The tab marks its own blocks: `lan.*` on the local network card's rows, `remote.tunnel` on the tunnel's */}
        <RemoteAccessTab />
      </SettingsSection>
      <SettingsSection id="secrets" title={t(sectionLabel('secrets'))}>
        <div className="settings-block" data-setting="secrets.storage">
          <SecretsCard />
        </div>
      </SettingsSection>
      <SettingsSection id="guards" title={t(sectionLabel('guards'))}>
        <div className="settings-block" data-setting="guards.rules">
          <GuardsCard readOnly={auth.data?.readOnly ?? false} />
        </div>
      </SettingsSection>
      <SettingsSection id="terminal" title={t(sectionLabel('terminal'))}>
        <div className="settings-block" data-setting="terminal.enabled">
          <TerminalCard />
        </div>
      </SettingsSection>
      <SettingsSection id="audit" title={t(sectionLabel('audit'))}>
        <AuditLatest />
      </SettingsSection>
      <SettingsSection id="agent-reads" title={t(sectionLabel('agent-reads'))}>
        <AgentReadsLatest />
      </SettingsSection>
    </div>
  );
}
