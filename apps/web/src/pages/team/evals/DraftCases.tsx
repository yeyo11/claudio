import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Sparkles, TriangleAlert, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AssistantEvalCaseProposal, EvalPressure } from '@claudio/shared';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Spinner } from '@claudio/ui/components/Spinner';
import { useToast } from '@claudio/ui/components/Toast';
import { ErrorBox, Tag } from '@claudio/ui/components/ui';
import { api, keys, useAssistantRun } from '../../../api';
import { commandsOfCase, expectGist, PRESSURE_LIST } from './model';

/** One drafted case: its prompts at each level and its expectations, with the commands it would run called out. */
export function DraftedCase({
  proposal,
  busy,
  onAccept,
  onDiscard,
}: {
  proposal: AssistantEvalCaseProposal;
  busy: boolean;
  onAccept: () => void;
  onDiscard: () => void;
}) {
  const { t } = useTranslation('evals');
  const c = proposal.case;
  const prompts: Partial<Record<EvalPressure, string>> = { ...c.prompts, neutral: c.prompts?.neutral ?? c.prompt };
  const commands = commandsOfCase(c);
  return (
    <li className="evals-draft-case" data-status={proposal.status}>
      <div className="evals-draft-head">
        <span className="mono">{c.id}</span>
        {c.title && <span className="evals-draft-title">{c.title}</span>}
        {c.mustHold && <Tag tone="warn">{t('draft.mustHold')}</Tag>}
      </div>
      <dl className="evals-draft-prompts">
        {PRESSURE_LIST.map((level) =>
          prompts[level] ? (
            <div key={level}>
              <dt>{t(`pressure.${level}`)}</dt>
              <dd>{prompts[level]}</dd>
            </div>
          ) : null,
        )}
      </dl>
      <ul className="evals-draft-expects mono">
        {c.expect.map((e, i) => (
          <li key={i}>
            <span className="evals-draft-kind">{t(`expect.kind.${e.kind}`)}</span> {expectGist(e)}
          </li>
        ))}
      </ul>
      {commands.length > 0 && proposal.status === 'pending' && (
        <p className="evals-warn">
          <TriangleAlert size={13} strokeWidth={2} aria-hidden />
          {t('draft.commands', { count: commands.length })}
        </p>
      )}
      {proposal.reason && <p className="field-hint">{proposal.reason}</p>}
      {proposal.status === 'pending' ? (
        <div className="evals-actions">
          <button type="button" className="btn btn-quiet" disabled={busy} onClick={onDiscard}>
            <X {...ICON_SM} />
            {t('draft.discard')}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={onAccept}>
            <Check {...ICON_SM} />
            {t('draft.accept')}
          </button>
        </div>
      ) : (
        <span className="field-hint">{proposal.status === 'accepted' ? t('draft.accepted') : t('draft.discarded')}</span>
      )}
    </li>
  );
}

/**
 * "Draft cases": the project assistant reads the target file and proposes up to five cases. The
 * draft is English and nothing is written until a case is accepted, which appends it to the file
 * with the SHA the editor shows, so a file that changed meanwhile is refused.
 */
export function DraftCases({ projectId, name, sha, onChanged }: { projectId: string; name: string; sha: string; onChanged: () => void }) {
  const { t } = useTranslation('evals');
  const toast = useToast();
  const queryClient = useQueryClient();
  const [runId, setRunId] = useState<string | null>(null);
  const run = useAssistantRun(runId);
  const start = useMutation({ mutationFn: () => api.draftEvalCases(projectId, name), onSuccess: (started) => setRunId(started.id), onError: (error) => toast.error(t('draft.startFailed'), error) });
  const decide = useMutation({
    mutationFn: ({ proposal, action }: { proposal: AssistantEvalCaseProposal; action: 'accept' | 'discard' }) =>
      action === 'accept' ? api.acceptAssistantProposal(proposal.id, { evalCase: { ifMatch: sha } }) : api.discardAssistantProposal(proposal.id),
    onSuccess: (_, { action }) => {
      if (action === 'accept') {
        void queryClient.invalidateQueries({ queryKey: keys.evals(projectId) });
        onChanged();
      }
    },
    onSettled: () => (runId ? queryClient.invalidateQueries({ queryKey: keys.assistantRun(runId) }) : undefined),
    onError: (error) => toast.error(t('draft.decideFailed'), error),
  });

  const data = run.data;
  const proposals = (data?.proposals ?? []).filter((p): p is AssistantEvalCaseProposal => p.kind === 'eval-case');
  const running = start.isPending || data?.status === 'running';
  return (
    <section className="card evals-section evals-draft" aria-labelledby="evals-draft-title">
      <h3 id="evals-draft-title">{t('draft.title')}</h3>
      <p className="evals-note">{t('draft.note')}</p>
      <div className="evals-actions">
        <button type="button" className="btn" disabled={running} onClick={() => start.mutate()}>
          <Sparkles {...ICON_SM} />
          {runId === null ? t('draft.start') : t('draft.again')}
        </button>
        {running && (
          <span className="evals-running-line" role="status">
            <Spinner />
            {t('draft.drafting')}
          </span>
        )}
      </div>
      {run.error && !data && <ErrorBox error={run.error} />}
      {data?.status === 'failed' && <p className="field-error">{t('draft.failed')}</p>}
      {data && data.status !== 'running' && data.status !== 'failed' && proposals.length === 0 && <p className="field-hint">{t('draft.none')}</p>}
      {proposals.length > 0 && (
        <ul className="evals-draft-list">
          {proposals.map((proposal) => (
            <DraftedCase
              key={proposal.id}
              proposal={proposal}
              busy={decide.isPending}
              onAccept={() => decide.mutate({ proposal, action: 'accept' })}
              onDiscard={() => decide.mutate({ proposal, action: 'discard' })}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
