import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Segmented } from '@claudio/ui/components/ui';
import { formatDateTime } from '@claudio/ui/lib/format';
import { percent, type TrendPoint } from './run-model';

const W = 640;
const H = 190;
const PAD = { left: 40, right: 16, top: 12, bottom: 24 };

/**
 * The pass-rate trend of an eval: one series, so no legend (the heading names it). The line is the
 * rate of cases that passed; the band behind it is the 95 % Wilson interval of that rate, so a run
 * of three cases is never drawn as certain as a run of thirty. Every point can be read from the
 * table view, and the last one carries its value.
 */
export function PassTrend({ points }: { points: TrendPoint[] }) {
  const { t } = useTranslation('evals');
  const [view, setView] = useState<'chart' | 'table'>('chart');
  if (points.length < 2) return <p className="field-hint">{t('trend.few')}</p>;
  const x = (i: number) => PAD.left + (i / (points.length - 1)) * (W - PAD.left - PAD.right);
  const y = (rate: number) => PAD.top + (1 - rate) * (H - PAD.top - PAD.bottom);
  // design-lint-ok: SVG geometry
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(p.rate).toFixed(1)}`).join(' ');
  // design-lint-ok: SVG geometry
  const band = [...points.map((p, i) => `${x(i).toFixed(1)},${y(p.interval.high).toFixed(1)}`), ...[...points].reverse().map((p, i) => `${x(points.length - 1 - i).toFixed(1)},${y(p.interval.low).toFixed(1)}`)].join(' ');
  const last = points[points.length - 1] as TrendPoint;
  const detail = (p: TrendPoint) => t('trend.point', { when: formatDateTime(p.at), passed: p.passed, of: p.of, rate: percent(p.rate), range: `${percent(p.interval.low)}–${percent(p.interval.high)}`, confidence: percent(0.95) });
  return (
    <figure className="evals-trend">
      <figcaption className="evals-trend-head">
        <h4>{t('trend.title')}</h4>
        <Segmented<'chart' | 'table'>
          value={view}
          label={t('trend.view')}
          onChange={setView}
          options={[
            { value: 'chart', label: t('trend.chart') },
            { value: 'table', label: t('trend.table') },
          ]}
        />
      </figcaption>
      {view === 'chart' ? (
        <svg className="evals-trend-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('trend.aria', { count: points.length, rate: percent(last.rate) })} preserveAspectRatio="xMidYMid meet">
          {[0, 0.5, 1].map((tick) => (
            <g key={tick}>
              <line className="evals-trend-grid" x1={PAD.left} x2={W - PAD.right} y1={y(tick)} y2={y(tick)} />
              <text className="evals-trend-axis" x={PAD.left - 8} y={y(tick)} textAnchor="end" dominantBaseline="middle">
                {percent(tick)}
              </text>
            </g>
          ))}
          <polygon className="evals-trend-band" points={band} />
          <path className="evals-trend-line" d={line} />
          {points.map((p, i) => (
            <g key={p.runId}>
              <circle className="evals-trend-dot" cx={x(i)} cy={y(p.rate)} r={4} />
              <circle className="evals-trend-hit" cx={x(i)} cy={y(p.rate)} r={14}>
                <title>{detail(p)}</title>
              </circle>
            </g>
          ))}
          <text className="evals-trend-value" x={x(points.length - 1)} y={y(last.rate) - 12} textAnchor="end">
            {percent(last.rate)}
          </text>
        </svg>
      ) : (
        <div className="evals-matrix-wrap">
          <table className="evals-matrix">
            <caption className="sr-only">{t('trend.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('trend.when')}</th>
                <th scope="col">{t('trend.cases')}</th>
                <th scope="col">{t('trend.rate')}</th>
              </tr>
            </thead>
            <tbody>
              {[...points].reverse().map((p) => (
                <tr key={p.runId}>
                  <th scope="row" className="tnum">
                    {formatDateTime(p.at)}
                  </th>
                  <td className="evals-num">{`${p.passed}/${p.of}`}</td>
                  <td className="evals-num">{`${percent(p.rate)} (${percent(p.interval.low)}–${percent(p.interval.high)})`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </figure>
  );
}
