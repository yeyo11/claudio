import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Account, Chat, ProviderMove, ProviderStatus } from '@claudio/shared';
import { ArrowRight, Hourglass, Repeat, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccountPicker, useChatAccounts } from '@claudio/chat-ui/composer/AccountPicker';
import { Sheet } from '@claudio/ui/components/controls/Sheet';
import { Tooltip } from '@claudio/ui/components/controls/Tooltip';
import { ICON, ICON_SM } from '@claudio/ui/components/icons';
import { useToast } from '@claudio/ui/components/Toast';
import { formatDateTime, formatDuration, formatHour, timeAgo, toMs } from '@claudio/ui/lib/format';
import { api, keys } from '../../api';
import { useAccountView } from '../../lib/accounts';
import { useProviders } from '../../lib/providers';
import { isKnownLimitWindow, useLimitWindowName } from '../../lib/limit-words';

export type LimitPhase = 'none' | 'limit' | 'waiting';

export interface LimitState {
  phase: LimitPhase;
  /** The chat's provider, for its name */
  status: ProviderStatus | undefined;
  /** The open wait for this chat, when there is one */
  wait: ProviderMove | null;
  /** When the limit the turn died on resets; the wait's own time wins, since it is what will be replayed */
  resetsAt: string | null;
  /** The binding window of the account the turn died on, when its reading names one */
  window: string | null;
  /** When that account's reading was taken: "last reading 5 min ago" when the reset is not known */
  observedAt: string | null;
}

/** The account the chat's last turn ran on: the one whose limit stopped it. */
const ranOn = (chat: Chat): string | null => chat.executions.at(-1)?.account ?? null;

/**
 * Whether the chat sits at a limit. Two facts say so and nothing else: an open wait for this chat,
 * or the server's `atLimit` (its last turn died on its account's limit and nothing started since).
 * No provider-wide reading and no other account's is read, so a chat that never hit a limit never
 * shows the banner. A chat a person moved to another account since is not at that account's limit:
 * its next turn starts elsewhere, so its composer is open again.
 */
export function limitPhase(chat: Chat, wait: ProviderMove | null): LimitPhase {
  if (wait) return 'waiting';
  if (chat.state === 'working' || chat.atLimit !== true) return 'none';
  const from = ranOn(chat);
  if (from !== null && chat.account != null && chat.account !== from) return 'none';
  return 'limit';
}

/** A chat's limit facts: its phase, and the reading of the account its turn died on. */
export function limitStateOf(chat: Chat, status: ProviderStatus | undefined, wait: ProviderMove | null, accounts: readonly Pick<Account, 'id' | 'limits'>[]): LimitState {
  const phase = limitPhase(chat, wait);
  const from = ranOn(chat) ?? chat.account ?? null;
  const reading = phase === 'none' ? null : (accounts.find((a) => a.id === from)?.limits ?? null);
  return { phase, status, wait, resetsAt: wait?.resetsAt ?? reading?.resetsAt ?? null, window: reading?.window ?? null, observedAt: reading?.observedAt ?? null };
}

export function useLimitState(chat: Chat | undefined): LimitState {
  const providers = useProviders();
  const view = useAccountView();
  const id = chat?.id ?? '';
  const waits = useQuery({ queryKey: keys.chatWaits(id), queryFn: () => api.limitWaits({ chatId: id, state: 'waiting' }), enabled: Boolean(chat) });
  const status = providers.data?.find((p) => p.id === chat?.provider);
  const wait = waits.data?.find((move) => move.fromChat === id && move.state === 'waiting') ?? null;
  if (!chat) return { phase: 'none', status, wait, resetsAt: null, window: null, observedAt: null };
  return limitStateOf(chat, status, wait, view?.accounts ?? []);
}

/** "Resets at 14:05 · in 2 h 10 min", or what is known when the reset is not. */
export function useResetWords(state: LimitState): string {
  const { t } = useTranslation('chats');
  const reset = toMs(state.resetsAt);
  if (reset === null) return state.observedAt ? t('limit.resetUnknown', { age: timeAgo(state.observedAt) }) : t('limit.resetNotKnown');
  const left = reset - Date.now();
  const sameDay = new Date(reset).toDateString() === new Date().toDateString();
  const at = sameDay ? formatHour(reset) : formatDateTime(reset);
  return left <= 0 ? t('limit.resetsOn', { at }) : t(sameDay ? 'limit.resets' : 'limit.resetsOn', { at, in: formatDuration(left) });
}

/** "Switch account": the composer's own account picker, in the sheet the "+" menu opens it in. */
function SwitchAccount({ chat }: { chat: Chat }) {
  const { t } = useTranslation('chats');
  const [open, setOpen] = useState(false);
  const accounts = useChatAccounts(chat, open);
  // Like the composer's "+" menu: with one account there is nothing to switch to
  if (!accounts.loading && accounts.rows.length < 2) return null;
  return (
    <>
      <button
        type="button"
        className="btn"
        onClick={() => {
          accounts.refresh();
          setOpen(true);
        }}
      >
        <Repeat {...ICON_SM} /> {t('limit.switchAccount')}
      </button>
      <Sheet open={open} onOpenChange={setOpen} title={t('limit.switchAccount')} side="auto">
        <AccountPicker chat={chat} state={accounts} onDone={() => setOpen(false)} />
      </Sheet>
    </>
  );
}

/**
 * Above the composer of a chat that hit its account's limit, and of one that waits for the reset.
 * At a limit it offers to wait, the zone's one primary, or to move the chat to another account;
 * waiting, it offers Stop waiting and Run now (the turn goes on at once on an account with room).
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
  const runNowMutation = useMutation({
    mutationFn: (moveId: string) => api.runLimitWaitNow(moveId),
    onSuccess: refresh,
    onError: (error) => toast.error(t('limit.runNowFailed'), error),
  });

  if (phase === 'none') return null;
  // A window the app has no words for is not named: "reached its usage limit" says it
  const title = isKnownLimitWindow(state.window) ? t('limit.titleWindow', { name, window: windowOf(state.window) }) : t('limit.title', { name });

  if (phase === 'waiting') {
    const pending = stopMutation.isPending || runNowMutation.isPending;
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
          <button type="button" className="btn" disabled={!wait || pending} onClick={() => wait && stopMutation.mutate(wait.id)}>
            {t('limit.stopWaiting')}
          </button>
          <Tooltip content={t('limit.runNowHint')}>
            <button type="button" className="btn" disabled={!wait || pending} onClick={() => wait && runNowMutation.mutate(wait.id)}>
              <ArrowRight {...ICON_SM} /> {t('limit.runNow')}
            </button>
          </Tooltip>
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
        <SwitchAccount chat={chat} />
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
