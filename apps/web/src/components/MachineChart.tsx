import { useId } from 'react';
import { formatDateTime } from '@claudio/ui/lib/format';
import { chartPath, chartX, chartY, niceMax, peakOf, type ChartFrame, type ChartPoint } from '../lib/machine';
import { useWidth } from '../lib/use-width';

/*
 * The usage-history chart's drawing, for the machine's figures: SVG from the readings with no
 * library, in the same classes and tokens. A line is told apart by its dash as well as by its
 * colour, and the figures behind it are in the description a screen reader reads.
 */

const HEIGHT = 168;
const PAD = { left: 44, right: 12, top: 10, bottom: 24 };
const DASHES = ['', '7 4', '2 4'] as const;

export interface ChartSeries {
  key: string;
  label: string;
  points: readonly ChartPoint[];
}

export function MachineChart({
  title,
  description,
  series,
  from,
  to,
  gapMs,
  format,
  yFloor,
  reference,
}: {
  title: string;
  /** What a screen reader hears: the figures, since the picture is not read */
  description: string;
  series: readonly ChartSeries[];
  from: number;
  to: number;
  gapMs: number;
  /** A tick of the y axis, in the active language */
  format: (value: number) => string;
  /** The axis reaches at least this high, so a calm machine does not draw its noise as a storm */
  yFloor: number;
  /** A line the eye compares against: the admission limit, the number of cores */
  reference?: { value: number; label: string };
}) {
  const id = useId();
  const [box, width] = useWidth<HTMLElement>(260, 560);
  const peak = Math.max(0, ...series.map((s) => peakOf(s.points)));
  const frame: ChartFrame = { from, to, width, height: HEIGHT, ...PAD, yMax: niceMax(peak, Math.max(yFloor, reference?.value ?? 0)) };
  const ticks = [0, frame.yMax / 2, frame.yMax];
  return (
    <figure className="usage-chart machine-chart" ref={box}>
      <svg viewBox={`0 0 ${width} ${HEIGHT}`} width={width} height={HEIGHT} role="img" aria-labelledby={`${id}-title ${id}-desc`} className="usage-chart-svg">
        <title id={`${id}-title`}>{title}</title>
        <desc id={`${id}-desc`}>{description}</desc>
        {ticks.map((tick) => (
          <g key={tick} aria-hidden>
            <line className="usage-chart-grid" x1={PAD.left} x2={width - PAD.right} y1={chartY(frame, tick)} y2={chartY(frame, tick)} />
            <text className="usage-chart-axis" x={PAD.left - 6} y={chartY(frame, tick) + 4} textAnchor="end">
              {format(tick)}
            </text>
          </g>
        ))}
        {reference && (
          <g aria-hidden>
            <line className="usage-chart-threshold" x1={PAD.left} x2={width - PAD.right} y1={chartY(frame, reference.value)} y2={chartY(frame, reference.value)} strokeDasharray="1 4" />
            <text className="usage-chart-axis" x={width - PAD.right} y={chartY(frame, reference.value) - 4} textAnchor="end">
              {reference.label}
            </text>
          </g>
        )}
        <g aria-hidden>
          <text className="usage-chart-axis" x={PAD.left} y={HEIGHT - 6}>
            {formatDateTime(from)}
          </text>
          <text className="usage-chart-axis" x={width - PAD.right} y={HEIGHT - 6} textAnchor="end">
            {formatDateTime(to)}
          </text>
        </g>
        {series.map((s, i) => (
          <g key={s.key} className={`usage-series usage-series-${i}`} aria-hidden>
            <path className="usage-series-line" d={chartPath(s.points, frame, gapMs)} strokeDasharray={DASHES[i % DASHES.length] || undefined} />
          </g>
        ))}
      </svg>
      {series.length > 1 && (
        <figcaption className="usage-legend">
          {series.map((s, i) => (
            <span key={s.key} className={`usage-legend-item usage-series usage-series-${i}`}>
              <svg width={28} height={10} aria-hidden>
                <line className="usage-series-line" x1={1} x2={27} y1={5} y2={5} strokeDasharray={DASHES[i % DASHES.length] || undefined} />
              </svg>
              <span className="small">{s.label}</span>
            </span>
          ))}
        </figcaption>
      )}
    </figure>
  );
}
