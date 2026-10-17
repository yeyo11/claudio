import type { CollaboratorsSettings, UpdateCollaboratorsRequest } from '@claudio/shared';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Switch } from '@claudio/ui/components/controls';
import { Card } from '@claudio/ui/components/ui';
import { settingsHref } from '../config/settingsGroups';

/**
 * Whether the Claudio assistant reads what teammates share (docs/plans/collaborators-agent-access.md,
 * level 1). The assistant runs no command, so it is on by default; a project's chats read only when
 * their project opts in, in its Sharing section. What agents read is listed in Settings → Security.
 */
export function AgentsCard({ settings, busy, onSave }: { settings: CollaboratorsSettings; busy: boolean; onSave: (changes: UpdateCollaboratorsRequest) => Promise<boolean> }) {
  const { t } = useTranslation('collaborators');
  return (
    <Card className="collab-agents" title={t('agents.title')}>
      <Switch checked={settings.assistantReads} disabled={busy} onChange={(assistantReads) => void onSave({ assistantReads })}>
        <span>{t('agents.assistant')}</span>
      </Switch>
      <p className="small muted">{t('agents.hint')}</p>
      <Link to={settingsHref('access', { detail: 'agent-reads' })} className="link-btn small" data-testid="collab-agent-reads-link">
        {t('agents.audit')}
      </Link>
    </Card>
  );
}
