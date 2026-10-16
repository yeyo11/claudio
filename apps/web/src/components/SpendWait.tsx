import type { Orchestration, SpendState } from '@claudio/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Clock } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys, useSpend } from '../api';
import { ICON_SM } from '@claudio/ui/components/icons';
import { ErrorBox } from '@claudio/ui/components/ui';
import { spendResetTime, waitingForSpend } from '../lib/spend-cap';
import { SpendCapDialog } from './SpendCapDialog';

/**
 * A board card whose flow run is queued while the day's cap is reached: the strip under it says what
 * holds it and when it comes back, with the same quiet "Keep going today" as a graph (resolved
 * question 2 of the plan). Nothing moves, as on every wait. Nothing while the gate is open. Not a
 * live region: a board with several would announce each of them, so `SpendWaitSummary` speaks once.
 */
export function SpendQueuedLine({ itemId, inline = false }: { itemId?: string; inline?: boolean }) {
  const { t } = useTranslation(['work', 'components']);
  const queryClient = useQueryClient();
  const state = useSpend().data;
  const [asking, setAsking] = useState(false);
  const pass = useMutation({
    mutationFn: () => api.grantItemSpendPass(itemId ?? ''),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.spend });
      void queryClient.invalidateQueries({ queryKey: keys.workItems });
      setAsking(false);
    },
  });
  if (!state?.blocked) return null;
  const canPass = Boolean(itemId) && !inline;
  return (
    <>
      <div className="wait-line">
        <Clock {...ICON_SM} aria-hidden />
        <span>{t('work:spendWait.card', { time: spendResetTime(state) })}</span>
        {canPass && (
          <button type="button" className="btn btn-ghost btn-small spend-wait-go" onClick={() => setAsking(true)}>
            {t('components:spendCap.goOn')}
          </button>
        )}
      </div>
      <ErrorBox error={pass.error} />
      {asking && <SpendCapDialog spend={state} confirmLabel={t('components:spendCap.goOn')} busy={pass.isPending} onConfirm={() => pass.mutate()} onCancel={() => setAsking(false)} />}
    </>
  );
}

/**
 * The one polite announcement of the board's wait: how many cards the cap holds. Visually hidden,
 * because each card says it in words already; this is only for a screen reader, once.
 */
export function SpendWaitSummary() {
  const { t } = useTranslation('work');
  const state = useSpend().data;
  const count = state?.blocked ? state.waiting.flowRuns : 0;
  return (
    <div className="sr-only" role="status" aria-live="polite">
      {state && count > 0 ? t('spendWait.summary', { count, time: spendResetTime(state) }) : ''}
    </div>
  );
}

/**
 * The orchestration page's line while the cap holds tasks back: how many wait, when they return, and
 * a quiet way to go on today anyway, which asks first and gives this graph today's pass.
 */
export function OrchestrationSpendWait({ orch }: { orch: Orchestration }) {
  const { t } = useTranslation(['orchestration', 'components']);
  const queryClient = useQueryClient();
  const state: SpendState | undefined = useSpend().data;
  const [asking, setAsking] = useState(false);
  const pass = useMutation({
    mutationFn: () => api.grantSpendPass(orch.id),
    onSuccess: (next) => {
      queryClient.setQueryData(keys.orchestration(orch.id), next);
      void queryClient.invalidateQueries({ queryKey: keys.spend });
      setAsking(false);
    },
  });
  const count = state ? waitingForSpend(orch, state) : 0;
  if (!state || count === 0) return null;
  return (
    <>
      <div className="wait-line" role="status">
        <Clock {...ICON_SM} aria-hidden />
        <span>
          <b>{t('orchestration:spendWait.tasks', { count, time: spendResetTime(state) })}</b>
          <span className="why">{t('orchestration:spendWait.why')}</span>
        </span>
        <button type="button" className="btn btn-ghost btn-small spend-wait-go" onClick={() => setAsking(true)}>
          {t('components:spendCap.goOn')}
        </button>
      </div>
      <ErrorBox error={pass.error} />
      {asking && <SpendCapDialog spend={state} confirmLabel={t('components:spendCap.goOn')} busy={pass.isPending} onConfirm={() => pass.mutate()} onCancel={() => setAsking(false)} />}
    </>
  );
}
