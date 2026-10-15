import type { FlowRun, WorkItemDetail } from '@agentry/shared';
import { useTranslation } from 'react-i18next';
import { WaitLine } from '../../../components/WaitLine';
import { useItemRuns } from './Activity';

/**
 * What the item's active runs say about their limit: the wait line while a run waits for it to
 * reset (warn and still, never live). Nothing when no run waits.
 */
export function RunState({ item }: { item: Pick<WorkItemDetail, 'id' | 'links' | 'projectId'> }) {
  const { runs } = useItemRuns(item);
  const waiting = runs.filter((run): run is FlowRun & { waiting: NonNullable<FlowRun['waiting']> } => (run.state === 'running' || run.state === 'queued') && Boolean(run.waiting));
  if (waiting.length === 0) return null;
  return (
    <div className="workitem-runstate">
      {waiting.map((run) => (
        <WaitLine key={run.id} wait={run.waiting} why={<WaitWhy />} />
      ))}
    </div>
  );
}

function WaitWhy() {
  const { t } = useTranslation('components');
  return <>{t('limitWait.why')}</>;
}
