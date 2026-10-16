import type { MemoryProposal, MemoryProposalTarget } from '@claudio/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, Pencil, X } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, ApiRequestError, keys, useMemoryProposals } from '../../../api';
import { MoreActions } from '@claudio/ui/components/controls';
import { DecisionMark } from '../../../components/DecisionMark';
import { ICON_SM } from '@claudio/ui/components/icons';
import { useToast } from '@claudio/ui/components/Toast';
import { ErrorBox, Skeleton } from '@claudio/ui/components/ui';
import { useDirty } from '../../../lib/dirty';
import { formatNumber, timeAgo } from '@claudio/ui/lib/format';
import { taskPath } from '../../../lib/work-items';
import { RoleAvatar, useRoleName } from '../../team/RoleAvatar';

const Markdown = lazy(() => import('@claudio/ui/components/Markdown'));

/** Paths a rule's line names before folding the rest into a count */
const PATHS_SHOWN = 3;

/**
 * Where an approved proposal is written, as its card says it: `CLAUDE.md · Conventions`, `memory · tests.md`,
 * `journal`, or `rule · .claude/rules/tests.md · src/**, test/**` with the paths beyond three folded.
 */
export function TargetLine({ target }: { target: MemoryProposalTarget }) {
  const { t } = useTranslation('home');
  const where =
    target.kind === 'instructions'
      ? [t('memoryTab.target.instructions'), target.section].filter(Boolean).join(' · ')
      : target.kind === 'memory'
        ? [t('memoryTab.target.memory'), target.file].filter(Boolean).join(' · ')
        : target.kind === 'rule'
          ? [t('memoryTab.target.rule'), target.file ? `.claude/rules/${target.file}` : null, rulePathsText(target.paths ?? [], (count) => t('memoryTab.target.morePaths', { count }))].filter(Boolean).join(' · ')
          : t('memoryTab.target.journal');
  return (
    <span className="memory-proposal-to">
      <ArrowRight {...ICON_SM} />
      <span className="sr-only">{t('memoryTab.target.label')}</span>
      {target.kind === 'rule' ? <span className="mono">{where}</span> : where}
    </span>
  );
}

function rulePathsText(paths: string[], folded: (count: number) => string): string {
  const more = paths.length - PATHS_SHOWN;
  return [...paths.slice(0, PATHS_SHOWN), ...(more > 0 ? [folded(more)] : [])].join(', ');
}

/** Proposal text is Markdown the agent wrote: an inline `code` is common, a heading is not. */
function ProposalText({ text }: { text: string }) {
  return (
    <div className="memory-proposal-text md">
      <Suspense fallback={<p>{text}</p>}>
        <Markdown text={text} />
      </Suspense>
    </div>
  );
}

/**
 * Approving a `rule` answers 409 when `.claude/rules/<file>` exists with other paths: the one refusal
 * the card answers by asking for another file name, rather than by a toast.
 */
export function isRuleNameTaken(error: unknown, target: MemoryProposalTarget): boolean {
  return error instanceof ApiRequestError && error.status === 409 && target.kind === 'rule' && /other paths/.test(error.message);
}

/** The rename a taken rule file asks for: what is taken, the name to approve it under instead, and the way out. */
export function RenameRule({
  proposal,
  name,
  busy = false,
  onName,
  onCancel,
  onSubmit,
}: {
  proposal: Pick<MemoryProposal, 'id' | 'target'>;
  name: string;
  busy?: boolean;
  onName: (name: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation(['home', 'common']);
  return (
    <form
      className="memory-proposal-edit memory-proposal-rename"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) onSubmit();
      }}
    >
      <p className="small memory-proposal-taken" role="alert">
        {t('memoryTab.proposals.rename.taken', { path: `.claude/rules/${proposal.target.file ?? ''}` })}
      </p>
      <label className="small muted" htmlFor={`rename-${proposal.id}`}>
        {t('memoryTab.proposals.rename.label')}
      </label>
      <input id={`rename-${proposal.id}`} className="mono" autoFocus value={name} onChange={(event) => onName(event.target.value)} onKeyDown={(event) => event.key === 'Escape' && onCancel()} />
      <div className="memory-proposal-actions">
        <button type="button" className="btn doc-quiet btn-small" onClick={onCancel}>
          {t('common:actions.cancel')}
        </button>
        <button type="submit" className="btn btn-small" disabled={busy || !name.trim()}>
          <Check {...ICON_SM} />
          {t('memoryTab.proposals.rename.approve')}
        </button>
      </div>
    </form>
  );
}

function ProposalRow({ proposal, phone }: { proposal: MemoryProposal; phone: boolean }) {
  const { t } = useTranslation(['home', 'common']);
  const roleName = useRoleName();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  // A rule whose file is taken by a rule with other paths: the name to approve it under instead
  const [renaming, setRenaming] = useState<string | null>(null);
  useDirty(`proposal:${proposal.id}`, editing !== null && editing !== proposal.text);

  const settle = () => void qc.invalidateQueries({ queryKey: keys.memoryProposalsOf(proposal.projectId) });
  const approve = useMutation({
    mutationFn: ({ text, file }: { text?: string; file?: string } = {}) =>
      api.approveMemoryProposal(proposal.id, { ...(text !== undefined && text !== proposal.text ? { text } : {}), ...(file !== undefined && file !== proposal.target.file ? { file } : {}) }),
    onSuccess: () => {
      setEditing(null);
      setRenaming(null);
      settle();
      toast.success(t('memoryTab.proposals.approved'));
    },
    onError: (error) => {
      // 409 on a rule is its name being taken by a rule with other paths: the person renames it
      if (isRuleNameTaken(error, proposal.target)) setRenaming((current) => current ?? proposal.target.file ?? '');
      else toast.error(t('memoryTab.proposals.approveFailed'), error);
    },
  });
  const reject = useMutation({
    mutationFn: () => api.rejectMemoryProposal(proposal.id),
    onSuccess: () => {
      settle();
      toast.success(t('memoryTab.proposals.rejected'));
    },
    onError: (error) => toast.error(t('memoryTab.proposals.rejectFailed'), error),
  });
  const busy = approve.isPending || reject.isPending;
  const role = proposal.proposedBy.role ?? null;
  const who = role ? roleName(role) : t('memoryTab.proposals.anAgent');

  const meta = (
    <div className="memory-proposal-meta">
      {role && <RoleAvatar role={role} size="sm" />}
      <b>{who}</b>
      {proposal.item && (
        <>
          <span>{t('memoryTab.proposals.from')}</span>
          <Link to={taskPath(proposal.item.key)} className="workitem-key workitem-key-link" title={proposal.item.title}>
            {proposal.item.key}
          </Link>
        </>
      )}
      <span>
        · <time dateTime={proposal.createdAt}>{timeAgo(proposal.createdAt)}</time>
      </span>
      <DecisionMark subjectKind="memory_proposal" subjectId={proposal.id} />
    </div>
  );

  const rename = renaming !== null && (
    <RenameRule
      proposal={proposal}
      name={renaming}
      busy={busy}
      onName={setRenaming}
      onCancel={() => setRenaming(null)}
      onSubmit={() => approve.mutate({ ...(editing !== null ? { text: editing.trim() } : {}), file: renaming.trim() })}
    />
  );

  const editor = editing !== null && (
    <form
      className="memory-proposal-edit"
      onSubmit={(event) => {
        event.preventDefault();
        if (editing.trim()) approve.mutate({ text: editing.trim() });
      }}
    >
      <textarea
        autoFocus
        rows={3}
        value={editing}
        aria-label={t('memoryTab.proposals.editLabel')}
        onChange={(event) => setEditing(event.target.value)}
        onKeyDown={(event) => event.key === 'Escape' && setEditing(null)}
      />
      <div className="memory-proposal-actions">
        <button type="button" className="btn doc-quiet btn-small" onClick={() => setEditing(null)}>
          {t('common:actions.cancel')}
        </button>
        <button type="submit" className="btn btn-small" disabled={busy || !editing.trim()}>
          <Check {...ICON_SM} />
          {t('memoryTab.proposals.approveEdited')}
        </button>
      </div>
    </form>
  );

  if (phone) {
    return (
      <li className="memory-proposal" aria-label={proposal.text}>
        {editor || <ProposalText text={proposal.text} />}
        {meta}
        <TargetLine target={proposal.target} />
        {proposal.reason && <p className="memory-proposal-reason">{proposal.reason}</p>}
        {rename}
        {editing === null && renaming === null && (
          <div className="memory-proposal-actions">
            <button type="button" className="btn memory-approve" disabled={busy} onClick={() => approve.mutate({})}>
              <Check {...ICON_SM} />
              {t('memoryTab.proposals.approve')}
            </button>
            <button type="button" className="btn doc-quiet memory-reject" disabled={busy} onClick={() => reject.mutate()}>
              {t('memoryTab.proposals.reject')}
            </button>
            <span className="doc-fill" />
            <MoreActions
              label={t('memoryTab.proposals.more')}
              entries={[{ id: 'edit', label: t('memoryTab.proposals.edit'), icon: Pencil, onSelect: () => setEditing(proposal.text) }]}
            />
          </div>
        )}
      </li>
    );
  }

  return (
    <li className="memory-proposal" aria-label={proposal.text}>
      <TargetLine target={proposal.target} />
      {editor || <ProposalText text={proposal.text} />}
      {proposal.reason && <p className="memory-proposal-reason">{proposal.reason}</p>}
      {rename}
      <div className="memory-proposal-foot">
        {meta}
        {editing === null && renaming === null && (
          <div className="memory-proposal-actions">
            <button type="button" className="btn doc-quiet btn-small memory-reject" disabled={busy} onClick={() => reject.mutate()}>
              <X {...ICON_SM} />
              {t('memoryTab.proposals.reject')}
            </button>
            <button type="button" className="btn doc-quiet btn-small memory-edit" disabled={busy} onClick={() => setEditing(proposal.text)}>
              <Pencil {...ICON_SM} />
              {t('memoryTab.proposals.edit')}
            </button>
            <button type="button" className="btn btn-small memory-approve" disabled={busy} onClick={() => approve.mutate({})}>
              <Check {...ICON_SM} />
              {t('memoryTab.proposals.approve')}
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

/** How many proposals of the project wait for the person: the Memory tab's figure. */
export function usePendingProposalCount(projectId: string, enabled = true): number {
  const proposals = useMemoryProposals(enabled ? projectId : null, 'pending');
  return proposals.data?.length ?? 0;
}

/** The count of proposals waiting, in idle with its words: what the Memory tab carries too. */
export function WaitingBadge({ count }: { count: number }) {
  const { t } = useTranslation('home');
  return <span className="badge badge-idle memory-waiting">{t('memoryTab.proposals.waiting', { count, n: formatNumber(count) })}</span>;
}

/**
 * The memory entries team members proposed, oldest first, approved or discarded one by one
 * (decision 33). Nothing is written before the person approves; editing first writes the edited text.
 */
export function Proposals({ projectId, phone = false }: { projectId: string; phone?: boolean }) {
  const { t } = useTranslation('home');
  const proposals = useMemoryProposals(projectId, 'pending');
  const list = [...(proposals.data ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const body = proposals.isLoading ? (
    <Skeleton rows={3} height={16} />
  ) : proposals.error ? (
    <ErrorBox error={proposals.error} />
  ) : list.length === 0 ? (
    <p className="small muted memory-none">{t('memoryTab.proposals.none')}</p>
  ) : (
    <ul className="memory-proposals" aria-label={t('memoryTab.proposals.title')}>
      {list.map((proposal) => (
        <ProposalRow key={proposal.id} proposal={proposal} phone={phone} />
      ))}
    </ul>
  );

  if (phone) {
    return (
      <>
        <div className="memory-phone-note">
          {list.length > 0 && <WaitingBadge count={list.length} />}
          <span className="small muted">{t('memoryTab.proposals.nothingWithoutYouShort')}</span>
        </div>
        <div className="card memory-card">{body}</div>
      </>
    );
  }
  return (
    <section className="card memory-card" aria-labelledby="memory-proposals-title">
      <div className="card-head">
        <h2 id="memory-proposals-title">{t('memoryTab.proposals.title')}</h2>
        {list.length > 0 && <WaitingBadge count={list.length} />}
        <span className="doc-fill" />
        <span className="small muted">{t('memoryTab.proposals.nothingWithoutYou')}</span>
      </div>
      {body}
    </section>
  );
}
