import type { Account, AccountChoiceWhy, AccountLimit, ModelOption, RotationPolicy } from '@claudio/shared';

/** The CLI's own config dir: what a chat that names no account ran on. */
const DEFAULT_ID = 'default';

/**
 * Why an account cannot be chosen for the chat, or `ok` when it can. `current` is the one in use.
 * `not-allowed`: usable, but the rule of the chat's project does not list it; a person may still
 * take it for one turn ("use another account once", D8 of the account-configuration plan).
 */
export type AccountRowState = 'current' | 'ok' | 'not-allowed' | 'disabled' | 'sign-in-expired' | 'signed-out' | 'exhausted' | 'model-unavailable';

export interface AccountRow {
  account: Account;
  state: AccountRowState;
  /** Use of the binding window as a whole percent; null when nothing was read */
  pct: number | null;
  /** ISO time an exhausted account comes back */
  resetsAt: string | null;
  /** On the `current` row: why the rotation chose it, as the server explains its last choice */
  why?: AccountChoiceWhy;
  /** On the `current` row: the name of the account the chat is pinned to, when the project's rule ignores the pin */
  pinIgnored?: string;
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
export function accountRow(
  account: Account,
  chat: { account?: string | null; model: string | null },
  models: readonly ModelOption[] | undefined,
  /** The rule of the chat's project, when one governs it */
  rule?: Pick<RotationPolicy, 'order'> | null,
): AccountRow {
  const limit = account.limits;
  const row = { account, pct: usagePct(limit), resetsAt: limit?.resetsAt ?? null };
  if (account.id === (chat.account ?? DEFAULT_ID)) return { ...row, state: 'current' };
  if (!account.enabled) return { ...row, state: 'disabled' };
  // An unusable sign-in also clears signedIn; it goes first so the row says what fixes it
  if (account.signInState === 'expired' || account.signInState === 'incomplete') return { ...row, state: 'sign-in-expired' };
  if (!account.signedIn) return { ...row, state: 'signed-out' };
  if (limit?.state === 'exhausted') return { ...row, state: 'exhausted' };
  if (chat.model && models && models.length > 0 && !offersModel(models, chat.model)) return { ...row, state: 'model-unavailable' };
  // Only an account that could run the chat is offered once: the rule is the one thing in its way
  if (rule?.order && !rule.order.includes(account.id)) return { ...row, state: 'not-allowed' };
  return { ...row, state: 'ok' };
}

/**
 * The rows with the chat's own explanation on its current one: the basis of the choice that put it
 * there, and the pin a project rule ignored, by its name. Nothing when the server gave none (a
 * person's switch, a chat that has not chosen since a restart).
 */
export function withWhy(rows: readonly AccountRow[], why: AccountChoiceWhy | undefined): AccountRow[] {
  if (!why) return [...rows];
  const pinned = why.pinIgnored ? rows.find((row) => row.account.id === why.pinIgnored)?.account : undefined;
  return rows.map((row) => (row.state === 'current' ? { ...row, why, ...(why.pinIgnored ? { pinIgnored: pinned ? accountLabel(pinned) : why.pinIgnored } : {}) } : row));
}

/** A row the person can press. */
export const canChoose = (row: AccountRow): boolean => row.state === 'ok' || row.state === 'not-allowed';

/** A row taken for one turn only, outside the project's rule. */
export const onlyOnce = (row: AccountRow): boolean => row.state === 'not-allowed';

/** The rule that governs a project: at most one policy lists it. */
export const ruleFor = (policies: readonly RotationPolicy[] | undefined, projectId: string | null | undefined): RotationPolicy | null =>
  (projectId ? policies?.find((policy) => policy.projects.includes(projectId)) : policies?.find((policy) => policy.looseChats)) ?? null;
