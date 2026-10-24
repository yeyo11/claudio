import { useTranslation } from 'react-i18next';
import type { Scope } from '../../../api';
import { FilesTab } from '../FilesTab';
import { ProvidersTab } from '../ProvidersTab';
import { SettingsTab } from '../SettingsTab';
import { detailLabel, sectionLabel, settingsHref } from '../settingsGroups';
import { Overridden } from '../SettingChange';
import { SignInSection } from '../SignInSection';
import { SettingsDetailRow, SettingsSection, type GroupScreenProps } from './Section';

// The user scope is the empty one: no project id means the account's own files
const USER_SCOPE: Scope = {};

/**
 * Settings → Claude Code (docs/plans/settings-ia.md §6.2): the account it runs on, the program
 * itself, and the two things of `~/.claude` too long for this screen, `settings.json` and the file
 * tree, each a detail of its own.
 */
export function ClaudeCode({ detail }: GroupScreenProps<'claude-code'>) {
  const { t } = useTranslation(['config']);
  if (detail === 'behaviour') return <SettingsTab scope={USER_SCOPE} scopeKey="user" filesHref={settingsHref('claude-code', { detail: 'files' })} />;
  if (detail === 'files') return <FilesTab scope={USER_SCOPE} />;
  return (
    <div className="settings-group">
      <SettingsSection id="sign-in" title={t(sectionLabel('sign-in'))}>
        <SignInSection />
      </SettingsSection>
      {/* Projects override the provider's limits as a whole: the section says so on its head line (plan D7) */}
      <SettingsSection id="provider" title={t(sectionLabel('provider'))} aside={<Overridden id="provider.limits" bare />}>
        <ProvidersTab />
      </SettingsSection>
      <SettingsSection id="behaviour" title={t(sectionLabel('behaviour'))}>
        <SettingsDetailRow to={settingsHref('claude-code', { detail: 'behaviour' })} label={t(detailLabel('behaviour'))} setting="behaviour.settings-json" />
      </SettingsSection>
      <SettingsSection id="files" title={t(sectionLabel('files'))}>
        <SettingsDetailRow to={settingsHref('claude-code', { detail: 'files' })} label={t(detailLabel('files'))} setting="files.tree" />
      </SettingsSection>
    </div>
  );
}
