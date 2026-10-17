import type { AgentReadScope } from '@claudio/shared';
import { Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@claudio/ui/components/controls/Tooltip';

/**
 * "Reads teammates' shares": the chat's agent has the read tools for what teammates share
 * (docs/plans/collaborators-agent-access.md), every copy for the assistant, its project's for any
 * other chat. A neutral fact beside the guard's tag, with what it reads in the tooltip; nothing
 * when it reads none. Nothing here moves: reading is not working.
 */
export function TeammateReadsTag({ scope }: { scope: AgentReadScope | null | undefined }) {
  const { t } = useTranslation('collaborators');
  if (!scope) return null;
  return (
    <Tooltip content={t(`agentReads.chip.${scope.kind}`)}>
      <span className="badge badge-muted teammate-reads-tag" tabIndex={0} data-testid="chat-teammate-reads">
        <Users size={12} strokeWidth={2} aria-hidden />
        <span className="badge-text">{t('agentReads.chip.label')}</span>
      </span>
    </Tooltip>
  );
}
