import { useTranslation } from 'react-i18next';
import type { EvalCellMetrics, EvalPressure, EvalRun } from '@claudio/shared';
import { Tag } from '@claudio/ui/components/ui';
import { percent, pressureDrop, runCells } from './run-model';

/**
 * A rate with the interval it is read within: a track, the range the Wilson interval covers and a
 * dot at the rate. The words beside it carry the numbers, so the bar is never the only reading.
 */
export function RateBar({ rate, interval, label }: { rate: number; interval: { low: number; high: number }; label: string }) {
  return (
    <span className="evals-rate" role="img" aria-label={label}>
      <span className="evals-rate-range" style={{ left: `${interval.low * 100}%`, width: `${Math.max(0, interval.high - interval.low) * 100}%` }} />
      <span className="evals-rate-dot" style={{ left: `${rate * 100}%` }} />
    </span>
  );
}

/** One cell of the metrics: `c/n`, the rate with its interval, and pass@k / pass^k beside it; never a bare percentage. */
export function MetricCell({ cell }: { cell: EvalCellMetrics | undefined }) {
  const { t } = useTranslation('evals');
  if (!cell || cell.n === 0)
    return (
      <span className="field-hint">
        {t('metrics.notScored')}
        {cell && cell.unjudged > 0 && ` · ${t('metrics.unjudged', { count: cell.unjudged })}`}
      </span>
    );
  const rate = cell.c / cell.n;
  const range = `${percent(cell.interval.low)}–${percent(cell.interval.high)}`;
  return (
    <span className="evals-metric">
      <span className="evals-num evals-metric-main">
        {t('metrics.rate', { c: cell.c, n: cell.n, rate: percent(rate) })}
        <span className="evals-metric-interval">{t('metrics.interval', { confidence: percent(0.95), range })}</span>
      </span>
      <RateBar rate={rate} interval={cell.interval} label={t('metrics.barLabel', { rate: percent(rate), confidence: percent(0.95), range })} />
      <span className="evals-num evals-metric-k">
        {cell.passAtK !== null && t('metrics.passAt', { k: cell.k, value: percent(cell.passAtK) })}
        {cell.passHatK !== null && ` · ${t('metrics.passHat', { k: cell.k, value: percent(cell.passHatK) })}`}
        {cell.unjudged > 0 && ` · ${t('metrics.unjudged', { count: cell.unjudged })}`}
      </span>
    </span>
  );
}

/** The cases against the variants at one pressure level, with n, the interval and the k metrics in every cell. */
export function MetricsTable({ run, pressure }: { run: EvalRun; pressure: EvalPressure }) {
  const { t } = useTranslation('evals');
  const cells = runCells(run);
  const rows = run.definition.cases.filter((c) => cells.some((cell) => cell.caseId === c.id && cell.pressure === pressure));
  if (rows.length === 0) return <p className="field-hint">{t('metrics.empty')}</p>;
  const both = run.pressures.includes('supportive') && run.pressures.includes('competing');
  return (
    <>
      <div className="evals-matrix-wrap">
        <table className="evals-matrix evals-metrics">
          <caption className="sr-only">{t('metrics.caption', { pressure: t(`pressure.${pressure}`) })}</caption>
          <thead>
            <tr>
              <th scope="col">{t('matrix.case')}</th>
              {run.variants.map((variant) => (
                <th key={variant} scope="col">
                  {t(`variant.${variant}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <th scope="row">
                  <span className="mono">{c.id}</span>
                  {c.mustHold && <Tag tone="warn">{t('draft.mustHold')}</Tag>}
                  {c.title && <span className="field-hint">{c.title}</span>}
                </th>
                {run.variants.map((variant) => (
                  <td key={variant}>
                    <MetricCell cell={cells.find((x) => x.caseId === c.id && x.variant === variant && x.pressure === pressure)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {both && <PressureDrops run={run} cells={cells} />}
    </>
  );
}

/** "How much pressure it takes to break the rule": the supportive rate against the competing one, per case and variant. */
function PressureDrops({ run, cells }: { run: EvalRun; cells: EvalCellMetrics[] }) {
  const { t } = useTranslation('evals');
  const lines = run.definition.cases.flatMap((c) =>
    run.variants.flatMap((variant) => {
      const drop = pressureDrop(cells, c.id, variant);
      return drop === null ? [] : [{ id: `${c.id}:${variant}`, caseId: c.id, variant, drop }];
    }),
  );
  if (lines.length === 0) return null;
  return (
    <div className="evals-drops">
      <h4>{t('metrics.dropTitle')}</h4>
      <p className="field-hint">{t('metrics.dropNote')}</p>
      <ul className="evals-drop-list">
        {lines.map((line) => (
          <li key={line.id} className="evals-num">
            <span className="mono">{line.caseId}</span>
            <span className="evals-drop-variant">{t(`variant.${line.variant}`)}</span>
            <span className={line.drop > 0 ? 'tone-warn' : 'tone-muted'}>{t('metrics.drop', { points: Math.round(line.drop * 100) })}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
