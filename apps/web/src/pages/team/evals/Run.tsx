import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, ArrowUp, CircleCheck, CircleX, Equal, Hourglass, MinusCircle, OctagonX, RotateCw, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { EvalCaseVerdict, EvalPressure, EvalRun, EvalSample, EvalVariant } from '@claudio/shared';
import { useConfirm } from '@claudio/ui/components/Dialog';
import { ICON_SM } from '@claudio/ui/components/icons';
import { ProgressBar } from '@claudio/ui/components/ProgressBar';
import { Spinner } from '@claudio/ui/components/Spinner';
import { useToast } from '@claudio/ui/components/Toast';
import { ErrorBox, Segmented, Skeleton, Tag } from '@claudio/ui/components/ui';
import { formatCost, formatDateTime } from '@claudio/ui/lib/format';
import { NARROW, useMediaQuery } from '@claudio/ui/lib/media';
import { api, keys, useEvalGate, useEvalRun } from '../../../api';
import { teamSearch } from '../model';
import { GateCard } from './Gate';
import { MetricsTable } from './Metrics';
import { RunTag } from './List';
import { PRESSURE_LIST, runWord } from './model';
import { cellState, proposedTextOf, runLive, showsMetrics, stashSave, runMatrix, runProgress, runResumable, runStage, resumeCeiling, unrunSamples, type CellState, type MatrixRow } from './run-model';
import { SampleSheet } from './Sample';
import { Tooltip } from '@claudio/ui/components/controls/Tooltip';

const CELL_ICON: Record<CellState, LucideIcon | null> = { passed: CircleCheck, failed: CircleX, running: null, queued: Hourglass, notScored: MinusCircle };
const CELL_TONE: Record<CellState, string> = { passed: 'ok', failed: 'bad', running: 'live', queued: 'muted', notScored: 'muted' };
const VERDICT_ICON: Record<EvalCaseVerdict, LucideIcon> = { regressed: ArrowDown, improved: ArrowUp, same: Equal };
const VERDICT_TONE: Record<EvalCaseVerdict, string> = { regressed: 'bad', improved: 'ok', same: 'muted' };

/** A value that changes at most every `ms`: the progress a screen reader hears is not read out sample by sample. */
function useThrottled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    const wait = Math.max(0, last.current + ms - Date.now());
    const timer = setTimeout(() => {
      last.current = Date.now();
      setShown(value);
    }, last.current === 0 ? 0 : wait);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return shown;
}

/** One attempt: an icon and a word (the word is for screen readers), and the ring while it runs. */
function Attempt({ sample, onOpen }: { sample: EvalSample; onOpen: (id: string) => void }) {
  const { t } = useTranslation('evals');
  const state = cellState(sample);
  const Icon = CELL_ICON[state];
  return (
    <Tooltip content={t(`cell.${state}`)}>
      <button type="button" className={`evals-attempt tone-${CELL_TONE[state]}`} onClick={() => onOpen(sample.id)}>
        {Icon ? <Icon size={14} strokeWidth={2} aria-hidden /> : <Spinner variant="ring" />}
        <span className="sr-only">{t('matrix.attempt', { attempt: sample.attempt, state: t(`cell.${state}`) })}</span>
        <span className="evals-attempt-n tnum" aria-hidden>
          {sample.attempt}
        </span>
      </button>
    </Tooltip>
  );
}

function Cell({ cell, onOpen }: { cell: MatrixRow['cells'][number]; onOpen: (id: string) => void }) {
  const { t } = useTranslation('evals');
  return (
    <span className="evals-cell">
      {cell.attempts.map((sample) => (
        <Attempt key={sample.id} sample={sample} onOpen={onOpen} />
      ))}
      {cell.flaky && <Tag tone="warn">{t('matrix.flaky')}</Tag>}
    </span>
  );
}

function Verdict({ verdict }: { verdict: EvalCaseVerdict | undefined }) {
  const { t } = useTranslation('evals');
  if (!verdict) return <span className="field-hint">—</span>;
  const Icon = VERDICT_ICON[verdict];
  return (
    <span className={`evals-verdict tone-${VERDICT_TONE[verdict]}`}>
      <Icon size={13} strokeWidth={2} aria-hidden />
      {t(`verdict.${verdict}`)}
    </span>
  );
}

/** The cases against the variants: a real table, with a column for the comparison when two variants ran. */
export function Matrix({ run, verdicts, phone, onOpen, pressure }: { run: EvalRun; verdicts: Map<string, EvalCaseVerdict> | null; phone: boolean; onOpen: (id: string) => void; pressure?: EvalPressure }) {
  const { t } = useTranslation('evals');
  const rows = runMatrix(run, pressure);
  if (rows.length === 0) return <p className="field-hint">{t('matrix.empty')}</p>;
  if (phone)
    return (
      <div className="evals-matrix-cards">
        {rows.map((row) => (
          <article key={row.caseId} className="card evals-matrix-card" aria-label={row.caseId}>
            <h4 className="mono">{row.caseId}</h4>
            {row.title && <p className="field-hint">{row.title}</p>}
            <dl>
              {row.cells.map((cell) => (
                <div key={cell.variant} className="evals-matrix-line">
                  <dt>{t(`variant.${cell.variant}`)}</dt>
                  <dd>
                    <Cell cell={cell} onOpen={onOpen} />
                  </dd>
                </div>
              ))}
              {verdicts && (
                <div className="evals-matrix-line">
                  <dt>{t('matrix.compared')}</dt>
                  <dd>
                    <Verdict verdict={verdicts.get(row.caseId)} />
                  </dd>
                </div>
              )}
            </dl>
          </article>
        ))}
      </div>
    );
  return (
    <div className="evals-matrix-wrap">
      <table className="evals-matrix">
        <caption className="sr-only">{t('matrix.caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('matrix.case')}</th>
            {run.variants.map((variant) => (
              <th key={variant} scope="col">
                {t(`variant.${variant}`)}
              </th>
            ))}
            {verdicts && <th scope="col">{t('matrix.compared')}</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.caseId}>
              <th scope="row">
                <span className="mono">{row.caseId}</span>
                {row.title && <span className="field-hint">{row.title}</span>}
              </th>
              {row.cells.map((cell) => (
                <td key={cell.variant}>
                  <Cell cell={cell} onOpen={onOpen} />
                </td>
              ))}
              {verdicts && (
                <td>
                  <Verdict verdict={verdicts.get(row.caseId)} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The two variants a comparison is made between: the current file against the proposal, else the first two. */
export function comparedVariants(variants: readonly EvalVariant[]): [EvalVariant, EvalVariant] | null {
  if (variants.length < 2) return null;
  const base = variants.includes('current') ? 'current' : (variants[0] as EvalVariant);
  const other = variants.includes('proposed') && base !== 'proposed' ? 'proposed' : (variants.find((v) => v !== base) as EvalVariant);
  return [base, other];
}

/** The word of a run's header and its notice for the states that ask something of the person. */
function Notice({ run, onResume, onStop, busy }: { run: EvalRun; onResume: () => void; onStop: () => void; busy: boolean }) {
  const { t } = useTranslation('evals');
  const stage = runStage(run);
  const unrun = unrunSamples(run.samples);
  if (stage === 'waiting')
    return (
      <div className="alert alert-warn" role="status">
        <Hourglass size={16} strokeWidth={1.75} aria-hidden className="alert-icon" />
        <div className="alert-body">
          <strong>{t('notice.waiting.title')}</strong>
          <div>{run.resetsAt ? t('notice.waiting.until', { time: formatDateTime(run.resetsAt) }) : t('notice.waiting.body')}</div>
          <div className="evals-actions">
            <button type="button" className="btn" disabled={busy} onClick={onStop}>
              <OctagonX {...ICON_SM} />
              {t('run.stop')}
            </button>
          </div>
        </div>
      </div>
    );
  if (stage === 'capped' || stage === 'interrupted')
    return (
      <div className="alert alert-warn" role="status">
        <TriangleAlert size={16} strokeWidth={1.75} aria-hidden className="alert-icon" />
        <div className="alert-body">
          <strong>{stage === 'capped' ? t('notice.capped', { count: unrun }) : t('notice.interrupted', { count: unrun })}</strong>
          <div className="evals-actions">
            <button type="button" className="btn" disabled={busy} onClick={onResume}>
              <RotateCw {...ICON_SM} />
              {t('run.resume')}
            </button>
          </div>
        </div>
      </div>
    );
  if (stage === 'failed')
    return (
      <div className="alert alert-bad" role="alert">
        <CircleX size={16} strokeWidth={1.75} aria-hidden className="alert-icon" />
        <div className="alert-body">
          <strong>{t('notice.failed')}</strong>
          {run.reason && <div className="mono">{run.reason}</div>}
        </div>
      </div>
    );
  if (stage === 'cancelled') return <p className="field-hint">{t('notice.cancelled')}</p>;
  return null;
}

/**
 * One run: its state, its progress by sample, what it has cost, and the cases against the
 * variants. The run card is the screen's one surface that moves, and only while the run is going.
 */
export function RunView({ projectId, runId, onBack }: { projectId: string; runId: string; onBack: () => void }) {
  const { t } = useTranslation('evals');
  const phone = useMediaQuery(NARROW);
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const run = useEvalRun(runId);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [open, setOpen] = useState<string | null>(null);
  const [pressure, setPressure] = useState<EvalPressure>('neutral');
  const data = run.data;
  const gate = useEvalGate(runId, !!data && data.variants.includes('current') && data.variants.includes('proposed') && data.state === 'ended');
  const pair = data ? comparedVariants(data.variants) : null;
  const compare = useQuery({
    queryKey: keys.evalCompare(runId, pair?.[0] ?? '', pair?.[1] ?? ''),
    queryFn: ({ signal }) => api.evalCompare(runId, pair?.[0] ?? 'current', pair?.[1] ?? 'proposed', { signal }),
    enabled: pair !== null && !!data && data.samples.some((s) => s.state === 'ended'),
    retry: false,
  });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: keys.evals(projectId) });
  const cancel = useMutation({ mutationFn: () => api.cancelEvalRun(runId), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: keys.evalRun(runId) }); refresh(); }, onError: (error) => toast.error(t('run.cancelFailed'), error) });
  const resume = useMutation({
    mutationFn: (ceiling: number) => api.resumeEvalRun(runId, ceiling),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.evalRun(runId) });
      refresh();
    },
    onError: (error) => toast.error(t('run.resumeFailed'), error),
  });

  const gateChanged = () => {
    void queryClient.invalidateQueries({ queryKey: keys.evalRun(runId) });
    refresh();
  };
  const rejudge = useMutation({ mutationFn: () => api.rejudgeEvalRun(runId), onSuccess: gateChanged, onError: (error) => toast.error(t('gate.rejudgeFailed'), error) });
  const acceptJudge = useMutation({ mutationFn: ({ caseId, idx }: { caseId: string; idx: number }) => api.acceptEvalJudge(runId, caseId, idx), onSuccess: gateChanged, onError: (error) => toast.error(t('gate.acceptFailed'), error) });

  const counts = data ? runProgress(data.samples) : null;
  const total = counts ? counts.done + counts.failed + counts.running + counts.pending + counts.skipped : 0;
  const announce = counts ? t('run.announce', { done: counts.done + counts.failed + counts.skipped, total }) : '';
  const announced = useThrottled(announce, 5000);

  if (run.error && !data) return <ErrorBox error={run.error} />;
  if (!data || !counts) return <Skeleton rows={6} height={20} />;

  const stage = runStage(data);
  const live = runLive(data);
  const verdicts = compare.data ? new Map(compare.data.cases.map((c) => [c.caseId, c.verdict] as const)) : null;
  const askResume = () => {
    const ceiling = resumeCeiling(data);
    void confirm({ title: t('run.resumeTitle'), body: t('run.resumeBody', { count: unrunSamples(data.samples), cost: formatCost(ceiling) }), confirmLabel: t('run.resumeConfirm', { cost: formatCost(ceiling) }) }).then(
      (ok) => ok && resume.mutate(ceiling),
    );
  };
  // "Save proposed" is the member's own editor with the proposed text in it: the person still presses Save
  const proposedText = proposedTextOf(data);
  const saveAgent = data.definition.target.kind === 'agent' && data.definition.target.scope === 'project' ? data.definition.target.name : null;
  const saveProposed =
    proposedText !== null && saveAgent !== null
      ? () => {
          if (!stashSave(sessionStorage, projectId, saveAgent, proposedText)) return toast.error(t('gate.saveFailed'));
          navigate({ search: teamSearch(params, { section: 'members', member: saveAgent, eval: null, run: null, for: null }) });
        }
      : undefined;
  const levels = data.pressures.length > 0 ? PRESSURE_LIST.filter((p) => data.pressures.includes(p)) : (['neutral'] as EvalPressure[]);
  const level = levels.includes(pressure) ? pressure : (levels[0] ?? 'neutral');
  const opened = open ? data.samples.find((s) => s.id === open) : undefined;

  return (
    <div className="evals-run">
      <div className="evals-editor-head">
        <button type="button" className="btn" onClick={onBack}>
          <ArrowLeft {...ICON_SM} />
          {t('run.back')}
        </button>
        <h2 className="evals-editor-title">{data.definition.title}</h2>
        <span className="grow" />
        {live && (
          <button type="button" className="btn" disabled={cancel.isPending || stage === 'waiting'} onClick={() => cancel.mutate()}>
            <OctagonX {...ICON_SM} />
            {t('run.cancel')}
          </button>
        )}
        {runResumable(data) && (
          <button type="button" className="btn btn-primary" disabled={resume.isPending} onClick={askResume}>
            <RotateCw {...ICON_SM} />
            {t('run.resume')}
          </button>
        )}
      </div>

      <section className={`card evals-run-card${stage === 'running' ? ' live-energy' : ''}`} aria-label={t('run.summary')}>
        <div className="evals-run-head">
          <RunTag word={data.state === 'queued' ? 'queued' : runWord(data)} />
          <span className="evals-num">{t('run.cost', { spent: formatCost(data.costUsd), ceiling: formatCost(data.maxCostUsd) })}</span>
          <span className="evals-num">{data.variants.map((v) => t(`variant.${v}`)).join(' · ')}</span>
        </div>
        <ProgressBar variant="segments" counts={counts} unit={t('run.samples')} />
        <p className="sr-only" aria-live="polite">
          {announced}
        </p>
        <ul className="evals-counts tnum">
          <li>{t('run.counts.done', { count: counts.done })}</li>
          <li>{t('run.counts.failed', { count: counts.failed })}</li>
          {counts.running > 0 && <li>{t('run.counts.running', { count: counts.running })}</li>}
          {counts.pending > 0 && <li>{t('run.counts.pending', { count: counts.pending })}</li>}
          {counts.skipped > 0 && <li>{t('run.counts.skipped', { count: counts.skipped })}</li>}
        </ul>
      </section>

      <Notice run={data} onResume={askResume} onStop={() => cancel.mutate()} busy={cancel.isPending || resume.isPending} />

      {gate.data && (
        <GateCard
          gate={gate.data}
          busy={rejudge.isPending || acceptJudge.isPending}
          onRejudge={() => rejudge.mutate()}
          onAcceptJudge={(caseId, idx) => acceptJudge.mutate({ caseId, idx })}
          {...(saveProposed ? { onSaveProposed: saveProposed } : {})}
        />
      )}

      <section className="evals-section" aria-labelledby="evals-run-matrix">
        <h3 id="evals-run-matrix">{t('matrix.title')}</h3>
        {levels.length > 1 && (
          <Segmented<EvalPressure> value={level} label={t('pressure.label')} onChange={setPressure} options={levels.map((p) => ({ value: p, label: t(`pressure.${p}`) }))} />
        )}
        <Matrix run={data} verdicts={verdicts} phone={phone} onOpen={setOpen} pressure={level} />
      </section>

      {showsMetrics(data) && (
        <section className="evals-section" aria-labelledby="evals-run-metrics">
          <h3 id="evals-run-metrics">{t('metrics.title')}</h3>
          <p className="field-hint">{t('metrics.note')}</p>
          <MetricsTable run={data} pressure={level} />
        </section>
      )}

      {opened && <SampleSheet runId={runId} sampleId={opened.id} title={`${t('sample.title', { case: opened.caseId, variant: t(`variant.${opened.variant}`), attempt: opened.attempt })}${opened.pressure && opened.pressure !== 'neutral' ? ` · ${t(`pressure.${opened.pressure}`)}` : ''}`} onClose={() => setOpen(null)} />}
    </div>
  );
}
