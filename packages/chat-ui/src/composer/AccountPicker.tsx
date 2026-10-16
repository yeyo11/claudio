import type { Chat, SwitchChatAccountResponse } from '@claudio/shared';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Undo2 } from 'lucide-react';
import { useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { usageTone } from '@claudio/ui/components/motion';
import { ICON_SM } from '@claudio/ui/components/icons';
import { ErrorBox, Skeleton, Tag } from '@claudio/ui/components/ui';
import { formatClock } from '@claudio/ui/lib/format';
import { accountLabel, accountRow, canChoose, type AccountRow } from '../lib/account-choice';
import { chatKeys, useChatUi } from '../lib/context';

const accountsKey = ['accounts'] as const;
const modelsKey = (accountId: string) => ['accounts', accountId, 'models'] as const;

/**
 * The account section of the "+" menu: one row per account, the chat's own marked, and the choice
 * of another one. An idle chat moves at once; a working one takes it when the turn ends, and the row
 * says so until then. With fewer than two accounts there is nothing to choose, so nothing shows.
 */
export function AccountPicker({ chat }: { chat: Chat }) {
  const { t } = useTranslation('chat');
  const { client } = useChatUi();
  const queryClient = useQueryClient();
  const list = useRef<HTMLUListElement>(null);
  const accounts = useQuery({ queryKey: accountsKey, queryFn: () => client.accounts(), staleTime: 0 });
  // What each account offers decides whether it can take the chat's model; read only when there is a model to match
  const models = useQueries({
    queries: (accounts.data ?? []).map((account) => ({
      queryKey: modelsKey(account.id),
      queryFn: () => client.accountModels(account.id),
      enabled: Boolean(chat.model),
    })),
  });
  const choose = useMutation<SwitchChatAccountResponse, Error, string>({
    mutationFn: (accountId) => client.switchChatAccount(chat.id, accountId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.chatScope(chat.id) });
      void queryClient.invalidateQueries({ queryKey: chatKeys.chats });
      void queryClient.invalidateQueries({ queryKey: accountsKey });
    },
  });

  if (accounts.isLoading) return <Skeleton rows={2} height={5} />;
  if (accounts.error) return <ErrorBox error={accounts.error} />;
  const all = accounts.data ?? [];
  if (all.length < 2) return null;

  const rows = all.map((account, index) => accountRow(account, chat, models[index]?.data));
  const pending = chat.pendingAccount ?? null;
  const current = rows.find((row) => row.state === 'current');
  const heading = `account-${chat.id}`;

  // Arrow keys move between the rows, disabled ones included: their reason is what a person came to read
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const items = Array.from(list.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const target = e.key === 'ArrowDown' ? items[(at + 1) % items.length] : e.key === 'ArrowUp' ? items[(at - 1 + items.length) % items.length] : e.key === 'Home' ? items[0] : e.key === 'End' ? items[items.length - 1] : undefined;
    if (!target) return;
    e.preventDefault();
    target.focus();
  };

  return (
    <section className="composer-menu-section" aria-labelledby={heading}>
      <h3 id={heading} className="section-label">
        {t('composerMenu.account.title')}
      </h3>
      <ul ref={list} className="composer-accounts" role="menu" aria-label={t('composerMenu.account.title')} onKeyDown={onKeyDown}>
        {rows.map((row, index) => (
          <AccountItem
            key={row.account.id}
            row={row}
            model={chat.model}
            waiting={pending === row.account.id}
            // One tab stop for the list: the account in use, else the first row
            tabbable={current ? row === current : index === 0}
            busy={choose.isPending}
            onChoose={() => choose.mutate(row.account.id)}
          />
        ))}
      </ul>
      {pending && current && (
        <div className="composer-account-pending">
          <p className="small muted">{t('composerMenu.account.pending')}</p>
          <button type="button" className="btn btn-small" disabled={choose.isPending} onClick={() => choose.mutate(current.account.id)}>
            <Undo2 {...ICON_SM} aria-hidden /> {t('composerMenu.account.undo')}
          </button>
        </div>
      )}
      <ErrorBox error={choose.error} />
    </section>
  );
}

function AccountItem({ row, model, waiting, tabbable, busy, onChoose }: { row: AccountRow; model: string | null; waiting: boolean; tabbable: boolean; busy: boolean; onChoose: () => void }) {
  const { t } = useTranslation('chat');
  const { account, state, pct, resetsAt } = row;
  const usable = canChoose(row);
  const tone = pct === null ? 'neutral' : usageTone(pct, state === 'exhausted');
  const fill = state === 'exhausted' ? 100 : (pct ?? 0);
  return (
    <li role="none" className={`composer-account ${state === 'current' ? 'is-current' : ''} ${usable || state === 'current' ? '' : 'is-off'}`.trim()}>
      <button
        type="button"
        role="menuitemradio"
        aria-checked={state === 'current'}
        aria-disabled={!usable || busy}
        tabIndex={tabbable ? 0 : -1}
        className="composer-account-btn"
        onClick={() => {
          if (usable && !busy) onChoose();
        }}
      >
        <span className="composer-account-mark" aria-hidden>
          {state === 'current' && <Check {...ICON_SM} />}
        </span>
        <span className="composer-account-body">
          <span className="composer-account-head">
            <span className="composer-account-name ellipsis">{accountLabel(account)}</span>
            {account.plan && <span className="composer-account-plan mono small muted">{account.plan}</span>}
          </span>
          {pct !== null && (
            <span className="composer-account-usage">
              <span className="meter-track meter-thin" role="img" aria-label={t('composerMenu.account.used', { percent: pct })}>
                <span className={tone === 'neutral' ? 'meter-fill' : `meter-fill is-${tone}`} style={{ width: `${fill}%` }} />
              </span>
              <span className="mono small muted">{pct} %</span>
            </span>
          )}
          <span className="composer-account-state small">
            {waiting ? (
              <Tag tone="warn">{t('composerMenu.account.whenTurnEnds')}</Tag>
            ) : state === 'current' ? (
              <Tag tone="ok">{t('composerMenu.account.inUse')}</Tag>
            ) : state === 'disabled' ? (
              <Tag>{t('composerMenu.account.disabled')}</Tag>
            ) : state === 'sign-in-expired' ? (
              <Tag tone="bad">{t('composerMenu.account.signInExpired')}</Tag>
            ) : state === 'signed-out' ? (
              <Tag tone="warn">{t('composerMenu.account.signedOut')}</Tag>
            ) : state === 'exhausted' ? (
              <Tag tone="bad">{resetsAt ? t('composerMenu.account.exhaustedUntil', { time: formatClock(resetsAt) }) : t('composerMenu.account.exhausted')}</Tag>
            ) : state === 'model-unavailable' ? (
              <Tag tone="warn">{t('composerMenu.account.noModel', { model: model ?? '' })}</Tag>
            ) : null}
          </span>
        </span>
      </button>
    </li>
  );
}
