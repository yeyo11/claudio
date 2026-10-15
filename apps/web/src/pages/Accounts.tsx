import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys, useAccounts, useOverview } from '../api';
import { useConfirm } from '@agentry/ui/components/Dialog';
import { ICON, ICON_SM } from '@agentry/ui/components/icons';
import { useToast } from '@agentry/ui/components/Toast';
import { Card, Empty, ErrorBox, Skeleton, StatusBadge } from '@agentry/ui/components/ui';
import { PageHeader } from '../components/PageHeader';
import { formatDateTime, timeAgo, toMs } from '@agentry/ui/lib/format';
import { accountName, sortAccounts } from '../lib/accounts';
import { AccountCard } from './accounts/AccountCard';
import { AddAccountDialog } from './accounts/AddAccountDialog';
import { PoliciesCard } from './accounts/PoliciesCard';
import { RotationCard } from './accounts/RotationCard';
import { UsageHistoryCard } from './accounts/UsageHistoryCard';

/**
 * The Claude accounts: one config directory each, chosen per process. Usage is what Claude reports
 * in its stream and, while an account is idle, what its CLI cached, so each reading says how old it is.
 */
export function Accounts() {
  const { t } = useTranslation(['accountsConfig', 'common']);
  const { data, error, isLoading, refetch, isFetching } = useAccounts();
  const overview = useOverview();
  const settings = useQuery({ queryKey: keys.accountsSettings, queryFn: ({ signal }) => api.accountsSettings({ signal }) });
  const policies = useQuery({ queryKey: keys.accountPolicies, queryFn: ({ signal }) => api.accountPolicies({ signal }) });
  const [fullHistory, setFullHistory] = useState(false);
  const events = useQuery({
    queryKey: [...keys.accountEvents, fullHistory ? 500 : 40],
    queryFn: ({ signal }) => api.accountEvents(fullHistory ? 500 : 40, { signal }),
    refetchInterval: 10_000,
  });
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  // The dialog refocuses whenever its onClose changes, so it gets the same function every render
  const closeAdd = useCallback(() => setAdding(false), []);
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: keys.accounts });
    void queryClient.invalidateQueries({ queryKey: keys.overview });
  }, [queryClient]);

  const act = async (label: string, failure: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      toast.success(label);
      refresh();
    } catch (err) {
      toast.error(failure, err);
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) return <Skeleton rows={6} height={20} />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  const accounts = sortAccounts(data);
  const current = overview.data?.accounts?.current ?? null;
  const lastRead = data.reduce<string | null>((latest, a) => ((toMs(a.limits?.observedAt) ?? 0) > (toMs(latest) ?? 0) ? (a.limits?.observedAt ?? latest) : latest), null);
  const nameOfId = (id: string | null) => {
    const found = data.find((a) => a.id === id);
    return found ? accountName(found) : id;
  };

  const toggle = (id: string) => {
    const account = data.find((a) => a.id === id);
    if (!account) return;
    const name = accountName(account);
    void act(
      account.enabled ? t('toast.heldOut', { name }) : t('toast.backInRotation', { name }),
      account.enabled ? t('toast.heldOutFailed', { name }) : t('toast.backInRotationFailed', { name }),
      () => api.updateAccount(id, { enabled: !account.enabled }),
    );
  };
  const remove = (id: string) => {
    const account = data.find((a) => a.id === id);
    if (!account) return;
    const name = accountName(account);
    void confirm({ title: t('remove.title', { name }), body: t('remove.body'), confirmLabel: t('common:actions.remove'), danger: true }).then(async (ok) => {
      if (ok) await act(t('toast.removed', { name }), t('toast.removeFailed', { name }), () => api.removeAccount(id));
    });
  };

  const addButton = (
    <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
      <Plus {...ICON_SM} /> {t('page.add')}
    </button>
  );

  return (
    <div className="stack accounts-page">
      <PageHeader
        title={t('page.title')}
        subtitle={[t('page.count', { count: data.length }), lastRead ? t('page.usageRead', { ago: timeAgo(lastRead) }) : null].filter(Boolean).join(' · ')}
        phone={{
          actions: (
            <button type="button" className="icon-btn" onClick={() => setAdding(true)} aria-label={t('page.add')}>
              <Plus {...ICON} />
            </button>
          ),
        }}
        actions={
          <>
            <button type="button" className="btn" onClick={() => void refetch()} disabled={isFetching} aria-label={t('page.refresh')}>
              <RefreshCw {...ICON_SM} /> <span className="accounts-action-text">{t('page.refresh')}</span>
            </button>
            {addButton}
          </>
        }
      />

      {adding && <AddAccountDialog onClose={closeAdd} onAdded={refresh} />}

      {accounts.length === 0 ? (
        <Empty illustration="signed-out" tone="warn" title={t('page.none')} action={addButton}>
          {t('page.noneHint')}
        </Empty>
      ) : (
        <ul className="account-grid">
          {accounts.map((account) => (
            <AccountCard key={account.id} account={account} current={account.id === current} busy={busy} onToggle={() => toggle(account.id)} onRemove={() => remove(account.id)} />
          ))}
        </ul>
      )}

      {settings.data && <RotationCard key={JSON.stringify(settings.data)} settings={settings.data} />}

      <PoliciesCard policies={policies.data ?? []} accounts={data} />

      <UsageHistoryCard accounts={data} threshold={settings.data?.threshold ?? 85} />

      <Card
        className="rotation-log"
        title={t('log.title')}
        actions={
          <button type="button" className="btn btn-small" onClick={() => setFullHistory((v) => !v)}>
            {fullHistory ? t('log.recentOnly') : t('log.fullHistory')}
          </button>
        }
      >
        {(events.data ?? []).length === 0 ? (
          <Empty icon={RefreshCw} title={t('log.nothingYet')}>
            {t('log.hint')}
          </Empty>
        ) : (
          <ul className="list">
            {[...(events.data ?? [])].reverse().map((event) => (
              <li key={event.seq} className="list-row list-row-flow small">
                <StatusBadge status={event.event} />
                <span className="muted nowrap mono" title={formatDateTime(event.ts)}>
                  {timeAgo(event.ts)}
                </span>
                <span className="break">
                  {event.from && event.to ? `${nameOfId(event.from)} → ${nameOfId(event.to)}` : (event.reason ?? event.detail ?? '')}
                  {event.from && event.to && event.reason ? ` · ${event.reason}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
