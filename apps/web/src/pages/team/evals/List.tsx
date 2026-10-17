import { CircleCheck, CircleX, FileWarning, FlaskConical, Hourglass, OctagonX, Plus, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { EvalFileListItem } from '@claudio/shared';
import { useEvalFiles, useEvalHead } from '../../../api';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Spinner } from '@claudio/ui/components/Spinner';
import { Empty, ErrorBox, Skeleton, Tag } from '@claudio/ui/components/ui';
import { formatCost, timeAgo } from '@claudio/ui/lib/format';
import { casesScored, listRows, RUN_TONE, runWord, type RunWord } from './model';
import { evalsForAgent } from './run-model';

const RUN_ICON: Record<RunWord | 'queued', LucideIcon | null> = {
  queued: Hourglass,
  passed: CircleCheck,
  failed: CircleX,
  capped: OctagonX,
  interrupted: TriangleAlert,
  running: null,
  waiting: Hourglass,
  cancelled: OctagonX,
};

/** The newest run's word, with its icon (the braille spinner while it runs): never a colour alone. */
export function RunTag({ word }: { word: RunWord | 'queued' }) {
  const { t } = useTranslation('evals');
  const Icon = RUN_ICON[word];
  return (
    <span className={`badge badge-${word === 'queued' ? 'muted' : RUN_TONE[word]}`}>
      {Icon ? <Icon size={12} strokeWidth={2} aria-hidden /> : <Spinner />}
      <span className="badge-text">{t(`run.${word}`)}</span>
    </span>
  );
}

function EvalRow({
  item,
  uncommitted,
  onOpen,
  onEvaluate,
}: {
  item: EvalFileListItem;
  uncommitted: boolean;
  onOpen: (name: string) => void;
  /** Runs this eval over the text handed over from a member's page */
  onEvaluate?: ((name: string) => void) | undefined;
}) {
  const { t } = useTranslation('evals');
  const def = item.definition;
  const run = item.latestRun;
  const scored = run ? casesScored(run) : null;
  const invalid = !def || item.problems.length > 0;
  return (
    <li className={onEvaluate ? 'evals-row-item' : undefined}>
      <button type="button" className="list-row list-row-button evals-row" onClick={() => onOpen(item.name)}>
        <span className="list-row-main">
          <span className="list-row-title">
            <strong>{def?.title || item.name}</strong>
            {invalid && (
              <Tag tone="bad" icon={FileWarning}>
                {t('list.invalid')}
              </Tag>
            )}
            {uncommitted && <Tag tone="muted">{t('list.notCommitted')}</Tag>}
          </span>
          <span className="meta">
            {def ? (
              <>
                <span className="mono evals-target">{`${def.target.scope === 'user' ? '~/' : ''}${def.target.kind}: ${def.target.name}`}</span>
                <span className="tnum">{t('list.cases', { count: def.cases.length })}</span>
              </>
            ) : (
              <span className="tnum">{t('list.problems', { count: item.problems.length })}</span>
            )}
          </span>
        </span>
        <span className="evals-row-run">
          {run ? (
            <>
              <RunTag word={runWord(run)} />
              {scored && <span className="evals-num">{t('list.scored', { passed: scored.passed, of: scored.of })}</span>}
              <span className="evals-num evals-when">{timeAgo(run.endedAt ?? run.startedAt ?? run.createdAt)}</span>
              <span className="evals-num">{formatCost(run.costUsd)}</span>
            </>
          ) : (
            !invalid && <span className="evals-never">{t('list.never')}</span>
          )}
        </span>
      </button>
      {onEvaluate && !invalid && (
        <button type="button" className="btn evals-evaluate" onClick={() => onEvaluate(item.name)}>
          <FlaskConical {...ICON_SM} />
          {t('list.evaluate')}
        </button>
      )}
    </li>
  );
}

/**
 * The project's evals: a row per file, the newest run on the row. Nothing to list is an `Empty`
 * with the evals illustration; a project that is not a git repository (or has no commit yet) gets
 * the reason instead, because an eval pins a commit and runs on it.
 */
export function EvalList({
  projectId,
  toolbar,
  onOpen,
  onNew,
  agent = null,
  onEvaluate,
  onClearAgent,
}: {
  projectId: string;
  toolbar: ReactNode;
  onOpen: (name: string) => void;
  onNew: () => void;
  /** Shows only the evals that measure this agent file (the entry from a member's page) */
  agent?: string | null;
  onEvaluate?: ((name: string) => void) | undefined;
  onClearAgent?: () => void;
}) {
  const { t } = useTranslation('evals');
  const files = useEvalFiles(projectId);
  const head = useEvalHead(projectId);

  const newButton = (
    <button type="button" className="btn btn-primary" onClick={onNew}>
      <Plus {...ICON_SM} />
      {t('list.new')}
    </button>
  );

  let body: ReactNode;
  if (files.error && !files.data) body = <ErrorBox error={files.error} />;
  else if (!files.data || !head.data) body = <Skeleton rows={5} height={44} />;
  else if (!head.data.git || head.data.sha === null)
    body = (
      <Empty title={head.data.git ? t('list.noCommit.title') : t('list.notGit.title')} illustration="projects" tone="warn" size="sm">
        {head.data.git ? t('list.noCommit.body') : t('list.notGit.body')}
      </Empty>
    );
  else if (files.data.length === 0)
    body = (
      <Empty title={t('list.empty.title')} illustration="evals" size="sm" action={newButton}>
        {t('list.empty.body')}
      </Empty>
    );
  else {
    const uncommitted = new Set(head.data.uncommitted);
    const shown = agent ? evalsForAgent(files.data, agent) : files.data;
    body =
      shown.length === 0 ? (
        <div className="evals-none">
          <p className="field-hint">{t('list.noneForAgent', { agent })}</p>
          {newButton}
        </div>
      ) : (
        <ul className="list evals-list" aria-label={t('title')}>
          {listRows(shown).map((row) => (
            <EvalRow key={row.item.name} item={row.item} uncommitted={uncommitted.has(row.item.name)} onOpen={onOpen} onEvaluate={onEvaluate} />
          ))}
        </ul>
      );
  }

  const canCreate = !!files.data && !!head.data?.git && head.data.sha !== null && files.data.length > 0;
  return (
    <div className="evals-page">
      <div className="team-toolbar">
        {toolbar}
        <span className="grow" />
        {canCreate && newButton}
      </div>
      {agent && (
        <div className="evals-filter" role="status">
          <Tag tone="muted">{t('list.forAgent', { agent })}</Tag>
          {onClearAgent && (
            <button type="button" className="btn btn-small" onClick={onClearAgent}>
              {t('list.showAll')}
            </button>
          )}
        </div>
      )}
      <section className="card evals-list-card">{body}</section>
    </div>
  );
}
