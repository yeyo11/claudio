import { useTranslation } from 'react-i18next';
import { Skeleton } from '@claudio/ui/components/ui';
import { MachineFigures } from '../../../components/MachineFigures';
import { useSystemLoad, useSystemProcesses } from '../../../api';
import { machineReading } from '../../../lib/machine';
import type { WidgetProps } from '../registry';

/**
 * Whether the machine can take another chat: memory, its pressure, the admission verdict and what the
 * chats hold. Nothing here is a live agent, so it carries no motion; it reads the same two routes the
 * admission itself is built on (`GET /api/system/load` and `/api/system/processes`).
 */
export function MachineWidget({ title, id }: WidgetProps) {
  const { t } = useTranslation('home');
  const load = useSystemLoad();
  const processes = useSystemProcesses();
  const heading = `${id}-title`;
  const reading = load.data ? machineReading(load.data, processes.data) : null;
  return (
    <section className="card kpi machine-card" aria-labelledby={heading} aria-busy={load.isLoading}>
      <h2 id={heading} className="kpi-label machine-title">
        {title}
      </h2>
      {load.isLoading ? (
        <Skeleton rows={2} height={16} />
      ) : !reading ? (
        <span className="kpi-sub" role="status">
          {t('machine.unreadable')}
        </span>
      ) : !reading.exposed ? (
        <span className="kpi-sub">{t('machine.noFigures')}</span>
      ) : (
        <MachineFigures reading={reading} />
      )}
    </section>
  );
}
