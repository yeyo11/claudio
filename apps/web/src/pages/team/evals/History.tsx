import { ArrowLeft, ChevronDown, GitCompare, TriangleAlert, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EvalRunSummary, EvalVariant } from '@claudio/shared';
import { Checkbox, Select } from '@claudio/ui/components/controls';
import { ICON_SM } from '@claudio/ui/components/icons';
import { ErrorBox, Skeleton } from '@claudio/ui/components/ui';
import { formatCost, timeAgo } from '@claudio/ui/lib/format';
import { useEvalHistory, useEvalRun } from '../../../api';
import { RunTag } from './List';
import { casesScored, runWord } from './model';
import { compareRuns, comparisonWarnings, sharedVariant } from './run-model';

type Filter = EvalVariant | 'all';

/** Two runs of one eval side by side, with what makes the numbers less comparable said first. */
function ComparePanel({ ids, onClose }: { ids: [string, string]; onClose: () => void }) {
  const { t } = useTranslation('evals');
  const older = useEvalRun(ids[0]);
  const newer = useEvalRun(ids[1]);
  const failed = older.error ?? newer.error;
  let body;
  if (failed && !(older.data && newer.data)) body = <ErrorBox error={failed} />;
  else if (!older.data || !newer.data) body = <Skeleton rows={4} height={18} />;
  else {
    const variant = sharedVariant(older.data, newer.data);
    const warnings = comparisonWarnings(older.data, newer.data);
    const rows = variant ? compareRuns(older.data, newer.data, variant) : [];
    body = (
      <>
        {warnings.length > 0 && (
          <div className="alert alert-warn" role="status">
            <TriangleAlert size={16} strokeWidth={1.75} aria-hidden className="alert-icon" />
            <div className="alert-body">
              <strong>{t('history.differ')}</strong>
              <ul className="evals-problems">
                {warnings.map((w) => (
                  <li key={w}>{t(`history.differs.${w}`)}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
        {variant === null ? (
          <p className="field-hint">{t('history.noShared')}</p>
        ) : (
          <div className="evals-matrix-wrap">
            <table className="evals-matrix">
              <caption className="sr-only">{t('history.compareCaption', { variant: t(`variant.${variant}`) })}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('matrix.case')}</th>
                  <th scope="col">{timeAgo(older.data.createdAt)}</th>
                  <th scope="col">{timeAgo(newer.data.createdAt)}</th>
                  <th scope="col">{t('matrix.compared')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.caseId}>
                    <th scope="row" className="mono">
                      {row.caseId}
                    </th>
                    <td className="mono evals-num">{row.a ? `${row.a.passed}/${row.a.scored}` : '—'}</td>
                    <td className="mono evals-num">{row.b ? `${row.b.passed}/${row.b.scored}` : '—'}</td>
                    <td>{row.verdict ? <span className={`evals-verdict tone-${row.verdict === 'regressed' ? 'bad' : row.verdict === 'improved' ? 'ok' : 'idle'}`}>{t(`verdict.${row.verdict}`)}</span> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </>
    );
  }
  return (
    <section className="card evals-section" aria-labelledby="evals-compare-title">
      <div className="evals-cases-head">
        <h3 id="evals-compare-title">{t('history.compareTitle')}</h3>
        <button type="button" className="btn btn-small" onClick={onClose}>
          <X {...ICON_SM} />
          {t('history.closeCompare')}
        </button>
      </div>
      {body}
    </section>
  );
}

function RunRow({ run, picking, picked, disabled, onPick, onOpen }: { run: EvalRunSummary; picking: boolean; picked: boolean; disabled: boolean; onPick: (on: boolean) => void; onOpen: () => void }) {
  const { t } = useTranslation('evals');
  const scored = casesScored(run);
  return (
    <li className="evals-history-item">
      {picking && <Checkbox checked={picked} disabled={disabled && !picked} onChange={onPick} aria-label={t('history.pick', { when: timeAgo(run.createdAt) })} className="check evals-pick" />}
      <button type="button" className="list-row list-row-button evals-row" onClick={onOpen}>
        <span className="list-row-main">
          <span className="list-row-title">
            <RunTag word={run.state === 'queued' ? 'queued' : runWord(run)} />
            <span className="mono evals-num">{timeAgo(run.createdAt)}</span>
          </span>
          <span className="meta mono">{run.variants.map((v) => t(`variant.${v}`)).join(' · ')}</span>
        </span>
        <span className="evals-row-run">
          {scored && <span className="mono evals-num">{t('list.scored', { passed: scored.passed, of: scored.of })}</span>}
          <span className="mono evals-num">{formatCost(run.costUsd)}</span>
        </span>
      </button>
    </li>
  );
}

/**
 * An eval's runs, newest first and a page at a time. "Compare with…" asks for two of them and sets
 * them side by side; it warns when the model, the CLI or the definition differ between them.
 */
export function EvalHistory({ projectId, name, onBack, onOpenRun }: { projectId: string; name: string; onBack: () => void; onOpenRun: (runId: string) => void }) {
  const { t } = useTranslation('evals');
  const history = useEvalHistory(projectId, name);
  const [filter, setFilter] = useState<Filter>('all');
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [comparing, setComparing] = useState<[string, string] | null>(null);

  const runs = (history.data?.pages ?? []).flatMap((page) => page.runs).filter((run) => filter === 'all' || run.variants.includes(filter));
  const pick = (id: string, on: boolean) => setPicked((ids) => (on ? [...ids, id].slice(0, 2) : ids.filter((x) => x !== id)));
  const compare = () => {
    // The older run first: the newer one is judged against it
    const chosen = runs.filter((run) => picked.includes(run.id)).reverse();
    const [first, second] = chosen;
    if (first && second) setComparing([first.id, second.id]);
  };
  const stopPicking = () => {
    setPicking(false);
    setPicked([]);
  };

  let body;
  if (history.error && !history.data) body = <ErrorBox error={history.error} />;
  else if (!history.data) body = <Skeleton rows={4} height={44} />;
  else if (runs.length === 0) body = <p className="field-hint">{filter === 'all' ? t('history.empty') : t('history.emptyFiltered')}</p>;
  else
    body = (
      <ul className="list evals-list" aria-label={t('history.title')}>
        {runs.map((run) => (
          <RunRow key={run.id} run={run} picking={picking} picked={picked.includes(run.id)} disabled={picked.length >= 2} onPick={(on) => pick(run.id, on)} onOpen={() => onOpenRun(run.id)} />
        ))}
      </ul>
    );

  return (
    <div className="evals-editor">
      <div className="evals-editor-head">
        <button type="button" className="btn" onClick={onBack}>
          <ArrowLeft {...ICON_SM} />
          {t('editor.back')}
        </button>
        <h2 className="evals-editor-title">{t('history.titleFor', { name })}</h2>
        <span className="grow" />
        <Select<Filter>
          value={filter}
          onChange={setFilter}
          aria-label={t('history.filter')}
          options={[{ value: 'all', label: t('history.allVariants') }, ...(['pinned', 'current', 'proposed'] as const).map((v) => ({ value: v, label: t(`variant.${v}`) }))]}
        />
        {picking ? (
          <>
            <button type="button" className="btn" onClick={stopPicking}>
              {t('history.stopPicking')}
            </button>
            <button type="button" className="btn btn-primary" disabled={picked.length < 2} onClick={compare}>
              <GitCompare {...ICON_SM} />
              {t('history.compareTwo')}
            </button>
          </>
        ) : (
          <button type="button" className="btn" disabled={runs.length < 2} onClick={() => setPicking(true)}>
            <GitCompare {...ICON_SM} />
            {t('history.compareWith')}
          </button>
        )}
      </div>
      {picking && <p className="field-hint">{t('history.pickTwo', { count: picked.length })}</p>}
      {comparing && <ComparePanel ids={comparing} onClose={() => setComparing(null)} />}
      <section className="card evals-list-card">{body}</section>
      {history.hasNextPage && (
        <div className="list-more">
          <button type="button" className="btn btn-small" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
            {t('history.more')}
            <ChevronDown {...ICON_SM} />
          </button>
        </div>
      )}
    </div>
  );
}
