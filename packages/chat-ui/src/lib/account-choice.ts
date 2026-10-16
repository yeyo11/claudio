import type { Account, AccountLimit, ModelOption } from '@claudio/shared';

/** The CLI's own config dir: what a chat that names no account ran on. */
const DEFAULT_ID = 'default';

/** Why an account cannot be chosen for the chat, or `ok` when it can. `current` is the one in use. */
export type AccountRowState = 'current' | 'ok' | 'disabled' | 'signed-out' | 'exhausted' | 'model-unavailable';

export interface AccountRow {
  account: Account;
  state: AccountRowState;
  /** Use of the binding window as a whole percent; null when nothing was read */
  pct: number | null;
  /** ISO time an exhausted account comes back */
  resetsAt: string | null;
}

/** What a person calls an account: its alias, else the email the CLI reported, else its id. */
export const accountLabel = (account: Pick<Account, 'alias' | 'email' | 'id'>): string => account.alias ?? account.email ?? account.id;

const usagePct = (limit: AccountLimit | null): number | null => (limit && limit.utilization !== null ? Math.min(100, Math.round(limit.utilization * 100)) : null);

/** The account lists the model by its alias or by any of the ids the alias stands for. */
export function offersModel(models: readonly ModelOption[], model: string): boolean {
  const wanted = model.toLowerCase();
  return models.some((m) => m.value.toLowerCase() === wanted || m.resolvedModel?.toLowerCase() === wanted || m.ids?.some((id) => id.toLowerCase() === wanted));
}

/**
 * One account as the composer's menu offers it for a chat. `models` is what the account offers, or
 * undefined while that is not known: an account is then not refused for a model nobody checked, and
 * the server, which does check, has the last word.
 */
export function accountRow(account: Account, chat: { account?: string | null; model: string | null }, models: readonly ModelOption[] | undefined): AccountRow {
  const limit = account.limits;
  const row = { account, pct: usagePct(limit), resetsAt: limit?.resetsAt ?? null };
  if (account.id === (chat.account ?? DEFAULT_ID)) return { ...row, state: 'current' };
  if (!account.enabled) return { ...row, state: 'disabled' };
  if (!account.signedIn) return { ...row, state: 'signed-out' };
  if (limit?.state === 'exhausted') return { ...row, state: 'exhausted' };
  if (chat.model && models && models.length > 0 && !offersModel(models, chat.model)) return { ...row, state: 'model-unavailable' };
  return { ...row, state: 'ok' };
}

/** A row the person can press. */
export const canChoose = (row: AccountRow): boolean => row.state === 'ok';
