import { useTranslation } from 'react-i18next';
import { Tag } from '@claudio/ui/components/ui';
import { formatNumber, formatPercent } from '@claudio/ui/lib/format';
import type { MachineReading, PressureLevel } from '../lib/machine';

const DASH = '—';

const mb = (value: number | null): string => (value === null ? DASH : formatNumber(value));

/**
 * The four readings of the machine: memory, its pressure, whether a chat is admitted and what the
 * chats hold. One component for the Home widget and the Machine page, so both say it the same way.
 * Every verdict is a word beside its colour, and a figure the kernel does not give reads as a dash.
 */
export function MachineFigures({ reading }: { reading: MachineReading }) {
  const { t } = useTranslation('home');
  const { memory, pressure, cause, chats } = reading;
  const level: PressureLevel | null = pressure?.level ?? null;
  return (
    <div className="machine-figures">
      <div className="machine-cell">
        <span className="kpi-label">{t('machine.memory')}</span>
        <span className="machine-figure tnum">{memory ? t('machine.memoryFree', { available: mb(memory.availableMb) }) : DASH}</span>
        {memory && (
          <div className="meter-track" role="img" aria-label={t('machine.memoryUsed', { percent: formatPercent(memory.usedPercent) })}>
            <span className={`meter-fill ${memory.tone === 'neutral' ? '' : `is-${memory.tone}`}`.trim()} style={{ width: `${memory.usedPercent}%` }} />
          </div>
        )}
        <span className="kpi-sub tnum">{memory ? t('machine.memoryOf', { total: mb(memory.totalMb) }) : t('machine.notExposed')}</span>
      </div>
      <div className="machine-cell">
        <span className="kpi-label">{t('machine.pressure')}</span>
        <span className="machine-figure tnum">{pressure ? formatPercent(pressure.some10, 1) : DASH}</span>
        {level ? <Tag tone={level}>{t(`machine.level.${level}`)}</Tag> : <span className="kpi-sub">{t('machine.notExposed')}</span>}
      </div>
      <div className="machine-cell">
        <span className="kpi-label">{t('machine.admission')}</span>
        <span className="machine-figure">
          <Tag tone={reading.admitting ? 'ok' : 'bad'}>{t(reading.admitting ? 'machine.admits' : 'machine.refuses')}</Tag>
        </span>
        <span className="kpi-sub tnum">
          {cause?.kind === 'memory' && t('machine.causeMemory', { available: mb(cause.availableMb), floor: mb(cause.floorMb) })}
          {cause?.kind === 'pressure' && t('machine.causePressure', { pressure: formatPercent(cause.some10, 1), limit: formatPercent(cause.admitAt, 0) })}
        </span>
      </div>
      <div className="machine-cell">
        <span className="kpi-label">{t('machine.chats')}</span>
        <span className="machine-figure tnum">{chats ? t('machine.chatCount', { count: chats.count, n: formatNumber(chats.count) }) : DASH}</span>
        <span className="kpi-sub tnum">{chats && chats.count > 0 ? t('machine.chatsResident', { mb: mb(chats.rssMb) }) : chats ? t('machine.chatsNone') : ''}</span>
      </div>
    </div>
  );
}
