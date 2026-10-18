import { Activity } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useChats, useSystemHistory, useSystemLoad, useSystemProcesses } from '../../api';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Card, Empty, ErrorBox, Loading, Segmented, Skeleton } from '@claudio/ui/components/ui';
import { formatDuration, formatNumber, formatPercent } from '@claudio/ui/lib/format';
import { MachineChart, type ChartSeries } from '../../components/MachineChart';
import { MachineFigures } from '../../components/MachineFigures';
import { bucketFor, machineReading, MACHINE_RANGES, memoryUsedPercent, pointsOf, rangeMs, SAMPLE_SECONDS, type ChartPoint, type MachineRange } from '../../lib/machine';

/** The window slides every minute, the rate the server stores readings at; a key that moved every render would refetch on each. */
const SLIDE_MS = SAMPLE_SECONDS * 1000;

const latestOf = (points: readonly ChartPoint[]): number | null => points.findLast((p) => p.v !== null)?.v ?? null;
const peakValue = (points: readonly ChartPoint[]): number | null => points.reduce<number | null>((peak, p) => (p.v !== null && (peak === null || p.v > peak) ? p.v : peak), null);

/**
 * Settings → Runs & spend → Machine (docs/plans/resource-control.md, option B): the reading now, what
 * the machine did over the last hour to week, and each chat's share of it. The Home widget says
 * whether it can take another chat; this says why, and since when.
 */
export function MachinePage() {
  const { t } = useTranslation(['config', 'home']);
  const [range, setRange] = useState<MachineRange>('6h');
  const load = useSystemLoad();
  const processes = useSystemProcesses();
  const chats = useChats({ origin: ['claudio', 'external', 'orchestration', 'internal'] });

  const now = Math.floor(Date.now() / SLIDE_MS) * SLIDE_MS;
  const from = now - rangeMs(range);
  const bucket = bucketFor(range);
  const history = useSystemHistory(range, { since: new Date(from).toISOString(), bucket });
  const reading = load.data ? machineReading(load.data, processes.data) : null;
  const samples = history.data ?? [];

  const describe = (name: string, points: readonly ChartPoint[], format: (v: number) => string) => {
    const latest = latestOf(points);
    const peak = peakValue(points);
    return latest === null || peak === null ? t('config:machine.describeNone', { name }) : t('config:machine.describe', { name, latest: format(latest), peak: format(peak) });
  };
  const percent = (v: number) => formatPercent(v, v < 10 ? 1 : 0);
  const charts = (): Array<{ id: string; title: string; series: ChartSeries[]; format: (v: number) => string; yFloor: number; reference?: { value: number; label: string } }> => {
    const memory = pointsOf(samples, memoryUsedPercent);
    const pressure: ChartSeries[] = [
      { key: 'memory', label: t('config:machine.pressureMemory'), points: pointsOf(samples, (s) => s.memorySome10) },
      { key: 'cpu', label: t('config:machine.pressureCpu'), points: pointsOf(samples, (s) => s.cpuSome10) },
      { key: 'io', label: t('config:machine.pressureIo'), points: pointsOf(samples, (s) => s.ioSome10) },
    ];
    const loadPoints = pointsOf(samples, (s) => s.load1);
    const cores = load.data?.cores ?? 0;
    const admitAt = load.data?.limits.memoryPressure;
    const decimal = (v: number) => formatNumber(v, { maximumFractionDigits: 1 });
    return [
      { id: 'memory', title: t('config:machine.memoryUsed'), series: [{ key: 'used', label: t('config:machine.memoryUsed'), points: memory }], format: (v) => formatPercent(v, 0), yFloor: 100 },
      {
        id: 'pressure',
        title: t('config:machine.pressure'),
        series: pressure,
        format: (v) => formatPercent(v, 0),
        yFloor: 25,
        ...(admitAt !== undefined ? { reference: { value: admitAt, label: t('config:machine.admitLimit', { limit: formatPercent(admitAt, 0) }) } } : {}),
      },
      {
        id: 'load',
        title: t('config:machine.load'),
        series: [{ key: 'load', label: t('config:machine.load'), points: loadPoints }],
        format: decimal,
        yFloor: Math.max(1, cores),
        ...(cores > 0 ? { reference: { value: cores, label: t('config:machine.cores', { count: cores, n: formatNumber(cores) }) } } : {}),
      },
    ];
  };

  const titleOf = (chatId: string): string | null => {
    const chat = chats.data?.find((c) => c.id === chatId);
    return chat ? (chat.firstPrompt ?? chat.title) : null;
  };
  const rows = [...(processes.data?.chats ?? [])].sort((a, b) => (b.rssMb ?? -1) - (a.rssMb ?? -1));

  return (
    <div className="settings-group settings-cards" data-setting="machine.history">
      <Card title={<span className="title-icon"><Activity {...ICON_SM} /> {t('config:machine.now')}</span>}>
        <ErrorBox error={load.error} />
        {load.isLoading ? (
          <Skeleton rows={2} height={16} />
        ) : reading && !reading.exposed ? (
          <p className="muted small">{t('home:machine.noFigures')}</p>
        ) : reading ? (
          <MachineFigures reading={reading} />
        ) : null}
      </Card>

      <Card title={t('config:machine.history')}>
        <p className="muted small">{t('config:machine.historyHint')}</p>
        <div className="toolbar">
          <Segmented<MachineRange> label={t('config:machine.range')} value={range} onChange={setRange} options={MACHINE_RANGES.map((r) => ({ value: r, label: t(`config:machine.ranges.${r}`) }))} />
        </div>
        <ErrorBox error={history.error} />
        {history.isLoading ? (
          <Loading />
        ) : samples.length === 0 && !history.error ? (
          <Empty icon={Activity} title={t('config:machine.none')}>
            {t('config:machine.noneHint')}
          </Empty>
        ) : (
          <div className="machine-charts">
            {charts().map((chart) => (
              <section key={chart.id} className="machine-chart-block" aria-labelledby={`machine-chart-${chart.id}`}>
                <h3 id={`machine-chart-${chart.id}`} className="machine-chart-title">
                  {chart.title}
                </h3>
                <MachineChart
                  title={chart.title}
                  description={chart.series.map((s) => describe(s.label, s.points, chart.format)).join(' ')}
                  series={chart.series}
                  from={from}
                  to={now + SLIDE_MS}
                  gapMs={Math.max(5 * 60_000, bucket * 3000)}
                  format={chart.format}
                  yFloor={chart.yFloor}
                  {...(chart.reference ? { reference: chart.reference } : {})}
                />
              </section>
            ))}
            <p className="muted small">{t('config:machine.worst', { minutes: formatNumber(Math.round(bucket / 60)) })}</p>
          </div>
        )}
      </Card>

      <Card title={t('config:machine.chats')}>
        <ErrorBox error={processes.error} />
        {processes.isLoading ? (
          <Skeleton rows={3} height={16} />
        ) : rows.length === 0 ? (
          <p className="muted small">{t('home:machine.chatsNone')}</p>
        ) : (
          <div className="table-wrap">
            <table className="table machine-table">
              <caption className="sr-only">{t('config:machine.chatsCaption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('config:machine.colChat')}</th>
                  <th scope="col" className="num">{t('config:machine.colProcesses')}</th>
                  <th scope="col" className="num">{t('config:machine.colMemory')}</th>
                  <th scope="col" className="num">{t('config:machine.colCpu')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.chatId}>
                    <th scope="row" className="machine-chat">
                      <span className="ellipsis">{titleOf(row.chatId) ?? t('config:machine.untitled')}</span>
                      <span className="mono small muted ellipsis">{row.chatId}</span>
                    </th>
                    <td className="num tnum">{formatNumber(row.processes)}</td>
                    <td className="num tnum">{row.rssMb === null ? '—' : t('config:machine.mb', { mb: formatNumber(row.rssMb) })}</td>
                    <td className="num tnum">{row.cpuSeconds === null ? '—' : formatDuration(row.cpuSeconds * 1000)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
