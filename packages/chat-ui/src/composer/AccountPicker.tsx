import type { Account, Chat, SwitchChatAccountResponse } from '@claudio/shared';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '@claudio/ui/components/Toast';
import { ICON_SM } from '@claudio/ui/components/icons';
import { ErrorBox, Skeleton } from '@claudio/ui/components/ui';
import { accountLabel, accountRow, type AccountRow } from '../lib/account-choice';
import { chatKeys, useChatUi } from '../lib/context';
import { AccountList } from './AccountList';

const accountsKey = ['accounts'] as const;
const modelsKey = (accountId: string) => ['accounts', accountId, 'models'] as const;

/** How long the account list is trusted without being read again. */
const ACCOUNTS_FRESH_MS = 30_000;

export interface ChatAccounts {
  accounts: Account[];
  rows: AccountRow[];
  /** The row the chat moves to when its turn ends, while a switch waits */
  pending: AccountRow | undefined;
  loading: boolean;
  error: unknown;
  /** Reads the accounts again; the menu does it each time it opens */
  refresh: () => void;
  choose: (accountId: string, onDone?: () => void) => void;
  busy: boolean;
}

/**
 * The accounts as the "+" menu offers them for a chat, and the switch itself. What an account offers
 * (its models, to refuse one that cannot take the chat's) is read only while `modelsEnabled`, which
 * is when the choices are on screen: reading it for every account whenever the box is there would
 * be a request per account per chat.
 */
export function useChatAccounts(chat: Chat, modelsEnabled: boolean): ChatAccounts {
  const { t } = useTranslation('chat');
  const { client } = useChatUi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const accounts = useQuery({ queryKey: accountsKey, queryFn: () => client.accounts(), staleTime: ACCOUNTS_FRESH_MS });
  const list = useMemo(() => accounts.data ?? [], [accounts.data]);
  const models = useQueries({
    queries: list.map((account) => ({
      queryKey: modelsKey(account.id),
      queryFn: () => client.accountModels(account.id),
      enabled: Boolean(chat.model) && modelsEnabled,
    })),
  });
  const choose = useMutation<SwitchChatAccountResponse, Error, string>({
    mutationFn: (accountId) => client.switchChatAccount(chat.id, accountId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.chatScope(chat.id) });
      void queryClient.invalidateQueries({ queryKey: chatKeys.chats });
      void queryClient.invalidateQueries({ queryKey: accountsKey });
    },
    // The menu has closed by the time the server answers: an error beside the row would be unseen
    onError: (error) => toast.error(t('composerMenu.account.failed'), error),
  });
  const rows = list.map((account, index) => accountRow(account, chat, models[index]?.data));
  const pendingId = chat.pendingAccount ?? null;
  return {
    accounts: list,
    rows,
    pending: pendingId ? rows.find((row) => row.account.id === pendingId) : undefined,
    loading: accounts.isLoading,
    error: accounts.error,
    refresh: () => void accounts.refetch(),
    choose: (accountId, onDone) => choose.mutate(accountId, { onSuccess: onDone }),
    busy: choose.isPending,
  };
}

/**
 * The picker for many accounts: a search field over the same radio list the submenu has, in the
 * panel the "+" menu opens (a step of the phone's sheet, a side panel on a desktop).
 */
export function AccountPicker({ chat, state, onDone }: { chat: Chat; state: ChatAccounts; onDone: () => void }) {
  const { t } = useTranslation('chat');
  if (state.loading) return <Skeleton rows={3} height={5} />;
  if (state.error) return <ErrorBox error={state.error} />;
  const current = state.rows.find((row) => row.state === 'current');
  return (
    <div className="account-picker">
      <AccountList
        rows={state.rows}
        model={chat.model}
        chosen={current?.account.id ?? null}
        busy={state.busy}
        label={t('composerMenu.account.title')}
        search
        autoFocusSearch
        onChoose={(accountId) => state.choose(accountId, onDone)}
      />
      {state.pending && current && (
        <button type="button" className="btn btn-small account-picker-cancel" disabled={state.busy} onClick={() => state.choose(current.account.id, onDone)}>
          <Undo2 {...ICON_SM} aria-hidden /> {t('composerMenu.account.cancel')}
          <span className="muted">{t('composerMenu.account.pendingTo', { name: accountLabel(state.pending.account) })}</span>
        </button>
      )}
    </div>
  );
}
