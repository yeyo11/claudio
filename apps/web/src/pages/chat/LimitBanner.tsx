import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Chat, ProviderMove, ProviderStatus } from '@agentry/shared';
import { Hourglass, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ICON, ICON_SM } from '@agentry/ui/components/icons';
import { useToast } from '@agentry/ui/components/Toast';
import { formatDateTime, formatDuration, formatHour, timeAgo, toMs } from '@agentry/ui/lib/format';
import { api, keys } from '../../api';
import { useProviders } from '../../lib/providers';
import { isKnownLimitWindow, useLimitWindowName } from '../../lib/limit-words';

export type LimitPhase = 'none' | 'limit' | 'waiting';

export interface LimitState {
  phase: LimitPhase;
  status: ProviderStatus | undefined;
  /** The open wait for this chat, when there is one */
  wait: ProviderMove | null;
  /** When the binding window resets; the wait's own time wins, since it is what will be replayed */
  resetsAt: string | null;
}

/**
 * Whether the chat sits at its provider's limit. The server keeps the fact only in memory, so the
 * page reads it from what survives a reload: an open wait, or the provider's own reading, together
 * with a chat that is not working and whose last turn did not end well, after the reading was taken. A chat whose
 * reading says the limit is not reached shows nothing.
 */
export function limitPhase(chat: Chat, status: ProviderStatus | undefined, wait: ProviderMove | null): LimitPhase {
  if (wait) return 'waiting';
  if (chat.state === 'working') return 'none';
  // The server saw this chat's turn die on the limit: that is the fact, whatever was read since
  if (chat.atLimit) return 'limit';
  const limit = status?.limit;
  if (!limit || limit.state !== 'exhausted') return 'none';
  const last = chat.executions.at(-1);
  if (!last || last.outcome === 'completed' || last.outcome === 'stopped') return 'none';
  // The turn must have ended on this limit: one that ended before the reading was taken failed for
  // another reason, or on an earlier window, and the limit is not what stopped it
  const ended = toMs(last.endedAt);
  const observed = toMs(limit.observedAt);
  if (ended === null || (observed !== null && ended < observed)) return 'none';
  const reset = toMs(limit.resetsAt);
  return reset !== null && reset <= Date.now() ? 'none' : 'limit';
}

export function useLimitState(chat: Chat | undefined): LimitState {
  const providers = useProviders();
  const id = chat?.id ?? '';
  const waits = useQuery({ queryKey: keys.chatWaits(id), queryFn: () => api.limitWaits({ chatId: id, state: 'waiting' }), enabled: Boolean(chat) });
  const status = providers.data?.find((p) => p.id === chat?.provider);
  const wait = waits.data?.find((move) => move.fromChat === id && move.state === 'waiting') ?? null;
  const phase = chat ? limitPhase(chat, status, wait) : 'none';
  return { phase, status, wait, resetsAt: wait?.resetsAt ?? status?.limit?.resetsAt ?? null };
}

/** "Resets at 14:05 · in 2 h 10 min", or what is known when the reset is not. */
export function useResetWords(state: LimitState): string {
  const { t } = useTranslation('chats');
  const reset = toMs(state.resetsAt);
  if (reset === null) return t('limit.resetUnknown', { age: timeAgo(state.status?.limit?.observedAt) });
  const left = reset - Date.now();
  const sameDay = new Date(reset).toDateString() === new Date().toDateString();
  const at = sameDay ? formatHour(reset) : formatDateTime(reset);
  return left <= 0 ? t('limit.resetsOn', { at }) : t(sameDay ? 'limit.resets' : 'limit.resetsOn', { at, in: formatDuration(left) });
}

/**
 * Above the composer of a chat whose provider reached its limit, and of one that waits for the
 * reset. At a limit it offers to wait, the zone's one primary; waiting, it offers Stop waiting.
 * Nothing in it moves: a limit is not live work.
 */
export function LimitBanner({ chat, state }: { chat: Chat; state: LimitState }) {
  const { t } = useTranslation('chats');
  const queryClient = useQueryClient();
  const toast = useToast();
  const providers = useProviders();
  const resetWords = useResetWords(state);
  const windowOf = useLimitWindowName();
  const { phase, status, wait } = state;

  const name = status?.label ?? providers.data?.find((p) => p.id === chat.provider)?.label ?? chat.provider;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.chatWaits(chat.id) });
    void queryClient.invalidateQueries({ queryKey: keys.chatScope(chat.id) });
  };
  const waitMutation = useMutation({ mutationFn: () => api.waitForLimit(chat.id), onSuccess: refresh, onError: (error) => toast.error(t('limit.waitFailed'), error) });
  const stopMutation = useMutation({
    mutationFn: (moveId: string) => api.cancelLimitWait(moveId),
    onSuccess: refresh,
    onError: (error) => toast.error(t('limit.stopWaitingFailed'), error),
  });

  if (phase === 'none') return null;
  const window = status?.limit?.window ?? null;
  // A window the app has no words for is not named: "reached its usage limit" says it
  const title = isKnownLimitWindow(window) ? t('limit.titleWindow', { name, window: windowOf(window) }) : t('limit.title', { name });

  if (phase === 'waiting') {
    return (
      <section className="lim" aria-label={t('limit.region')}>
        <div className="lim-head">
          <Hourglass {...ICON} className="lim-icon" />
          <div className="lim-text">
            <span className="lim-title">{t('limit.waitingTitle', { name })}</span>
            <span className="lim-reset">{resetWords}</span>
            <span>{t('limit.waitingNote')}</span>
          </div>
        </div>
        <div className="lim-acts">
          <button type="button" className="btn" disabled={!wait || stopMutation.isPending} onClick={() => wait && stopMutation.mutate(wait.id)}>
            {t('limit.stopWaiting')}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="lim" aria-label={t('limit.region')}>
      <div className="lim-head">
        <TriangleAlert {...ICON} className="lim-icon" />
        <div className="lim-text">
          <span className="lim-title">{title}</span>
          <span className="lim-reset">{resetWords}</span>
        </div>
      </div>
      <div className="lim-acts">
        <button type="button" className="btn btn-primary" disabled={waitMutation.isPending} onClick={() => waitMutation.mutate()}>
          <Hourglass {...ICON_SM} /> {t('limit.wait')}
        </button>
      </div>
      <p className="lim-note">{t('limit.noteWait')}</p>
    </section>
  );
}

/** The box where the message would go, while the chat cannot take one: the banner above is where to act. */
export function BlockedComposer({ chat, state }: { chat: Chat; state: LimitState }) {
  const { t } = useTranslation('chats');
  const providers = useProviders();
  const nameOf = (id: string) => providers.data?.find((p) => p.id === id)?.label ?? id;
  const said = state.phase === 'waiting' ? t('limit.composer.waiting', { name: nameOf(chat.provider) }) : t('limit.composer.limit');
  return (
    <div className="lim-composer">
      <textarea rows={1} disabled placeholder={said} aria-label={t('limit.composer.aria')} />
    </div>
  );
}
