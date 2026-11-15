import type { AccountConfigMode, AccountConfigStart, AccountsSettings } from '@claudio/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { api, keys, useAccounts, useProjects } from '../api';
import { useConfirm } from '@claudio/ui/components/Dialog';
import { ICON, ICON_SM } from '@claudio/ui/components/icons';
import { Spinner } from '@claudio/ui/components/Spinner';
import { useToast } from '@claudio/ui/components/Toast';
import { Card, Empty, ErrorBox, Skeleton, StatusBadge } from '@claudio/ui/components/ui';
import { PageHeader } from '../components/PageHeader';
import { formatDateTime, timeAgo, toMs } from '@claudio/ui/lib/format';
import { accountName, accountUsable, reservesByAccount, sortAccounts, usageStale, useAccountView } from '../lib/accounts';
import { AccountCard } from './accounts/AccountCard';
import { AccountConfigDialog } from './accounts/AccountConfigDialog';
import { CliCanaryLine } from './accounts/CliCanaryLine';
import { AddAccountDialog } from './accounts/AddAccountDialog';
import { SignInAgainDialog } from './accounts/SignInAgainDialog';
import { ModelFallbacksCard } from './accounts/ModelFallbacksCard';
import { PoliciesCard } from './accounts/PoliciesCard';
import { RotationCard } from './accounts/RotationCard';
import { UsageHistoryCard } from './accounts/UsageHistoryCard';

/**
 * The Claude accounts: one config directory each, chosen per process. Usage is what Claude reports
 * in its stream and, while an account is idle, what its CLI cached, so each reading says how old it is.
 */
export function Accounts() {
  const { t } = useTranslation(['accountsConfig', 'common']);
  const { data, error, isLoading } = useAccounts();
  const view = useAccountView();
  const settings = useQuery({ queryKey: keys.accountsSettings, queryFn: ({ signal }) => api.accountsSettings({ signal }) });
  const policies = useQuery({ queryKey: keys.accountPolicies, queryFn: ({ signal }) => api.accountPolicies({ signal }) });
  const fallbacks = useQuery({ queryKey: keys.modelFallbacks, queryFn: ({ signal }) => api.modelFallbacks({ signal }) });
  const [fullHistory, setFullHistory] = useState(false);
  // No poll: `accounts.changed` and the switch events refetch everything under ['accounts']
  const events = useQuery({
    queryKey: [...keys.accountEvents, fullHistory ? 500 : 40],
    queryFn: ({ signal }) => api.accountEvents(fullHistory ? 500 : 40, { signal }),
  });
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [configSwitch, setConfigSwitch] = useState<{ id: string; to: AccountConfigMode } | null>(null);
  const projects = useProjects(false);
  // The dialog refocuses whenever its onClose changes, so it gets the same function every render
  const closeAdd = useCallback(() => setAdding(false), []);
  const closeSignIn = useCallback(() => setSigningIn(null), []);
  const closeConfigSwitch = useCallback(() => setConfigSwitch(null), []);
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: keys.accounts });
    void queryClient.invalidateQueries({ queryKey: keys.overview });
  }, [queryClient]);

  // The CLI is asked for the real usage (no tokens); the answer replaces the list, and an account it
  // could not read is named, since it keeps its last reading and would otherwise look fresh
  const [reading, setReading] = useState(false);
  const readUsage = useCallback(async () => {
    setReading(true);
    try {
      const result = await api.refreshAccounts();
      queryClient.setQueryData(keys.accounts, result.accounts);
      void queryClient.invalidateQueries({ queryKey: keys.overview });
      if (result.failed.length > 0) {
        const names = result.failed.map((f) => {
          const found = result.accounts.find((a) => a.id === f.id);
          return found ? accountName(found) : f.id;
        });
        toast.error(t('toast.refreshFailed', { names: names.join(', ') }), new Error(result.failed.map((f) => f.error).join('; ')));
      }
    } catch (err) {
      toast.error(t('toast.refreshError'), err);
    } finally {
      setReading(false);
    }
  }, [queryClient, toast, t]);
  // Opening Accounts reads the CLI when its last answer is older than ten minutes, once per visit
  const autoRead = useRef(false);
  const stale = data ? usageStale(data) : false;
  useEffect(() => {
    if (!stale || autoRead.current) return;
    autoRead.current = true;
    void readUsage();
  }, [stale, readUsage]);

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
  const signingAgain = data.find((a) => a.id === signingIn) ?? null;
  const current = view?.inUse?.id ?? null;
  const preferred = settings.data?.preferred ?? null;
  const lastRead = data.reduce<string | null>((latest, a) => ((toMs(a.limits?.observedAt) ?? 0) > (toMs(latest) ?? 0) ? (a.limits?.observedAt ?? latest) : latest), null);
  // The rotation's own reasons are said in words; any other text (a wait's cause) is shown as it was recorded
  const reasonText = (reason: string | null): string | null => {
    switch (reason) {
      case 'limit':
        return t('reason.limit');
      case 'threshold':
        return t('reason.threshold');
      case 'person':
        return t('reason.person');
      case 'disabled':
        return t('reason.disabled');
      case 'signed-out':
        return t('reason.signed-out');
      case 'auth':
        return t('reason.auth');
      case 'credits':
        return t('reason.credits');
      case 'reserve':
        return t('reason.reserve');
      case 'rule':
        return t('reason.rule');
      default:
        return reason;
    }
  };
  const nameOfId = (id: string | null) => {
    const found = data.find((a) => a.id === id);
    return found ? accountName(found) : id;
  };

  // What each account's card says about the headroom a project's rule keeps on it
  const reserves = reservesByAccount(policies.data ?? [], (id) => projects.data?.find((p) => p.id === id)?.name ?? id, t('policies.looseChatsName'));

  const switchConfig = (id: string, to: AccountConfigMode, start: AccountConfigStart | undefined) => {
    const account = data.find((a) => a.id === id);
    if (!account) return;
    const name = accountName(account);
    void act(t(to === 'independent' ? 'config.toast.nowOwn' : 'config.toast.nowShared', { name }), t('config.toast.switchFailed', { name }), async () => {
      await api.setAccountConfig(id, to, start);
      setConfigSwitch(null);
    });
  };
  const repairConfig = (id: string) => {
    const account = data.find((a) => a.id === id);
    const config = account?.config;
    if (!account || !config) return;
    const name = accountName(account);
    // Applying the mode the account is in links what waits; a switch left half-way is applied again to finish it
    const mode = config.switching?.to ?? config.mode;
    const start = mode === 'independent' ? config.switching?.start : undefined;
    void act(t('config.toast.repaired', { name }), t('config.toast.repairFailed', { name }), () => api.setAccountConfig(id, mode, start));
  };
  const useSharedItem = (id: string, item: string) => {
    const account = data.find((a) => a.id === id);
    if (!account) return;
    const name = accountName(account);
    void (async () => {
      // The question says where the account's own copy will be kept, from a plan that changes nothing
      let aside: string | null = null;
      try {
        aside = (await api.accountConfigItemPlan(id, item)).aside;
      } catch (err) {
        toast.error(t('config.toast.useSharedFailed', { item }), err);
        return;
      }
      const ok = await confirm({
        title: t('config.useSharedTitle', { item, name }),
        body: aside ? (
          // One paragraph: the dialog's body lays its children out as blocks, and the path sits inside the sentence
          <p className="config-aside-text">
            <Trans t={t} i18nKey="config.useSharedBody" values={{ aside }} components={{ path: <span className="mono" /> }} />
          </p>
        ) : (
          t('config.useSharedBodyNoAside')
        ),
        confirmLabel: t('config.useShared'),
      });
      if (ok) await act(t('config.toast.usedShared', { item, name }), t('config.toast.useSharedFailed', { item }), () => api.useSharedConfigItem(id, item));
    })();
  };
  const switching = configSwitch ? data.find((a) => a.id === configSwitch.id) : undefined;

  const putSettings = (patch: Partial<AccountsSettings>) => api.putAccountsSettings(patch);
  const toggle = (id: string) => {
    const account = data.find((a) => a.id === id);
    if (!account) return;
    const name = accountName(account);
    const flip = (clearPreference: boolean) =>
      act(
        account.enabled ? t('toast.heldOut', { name }) : t('toast.backInRotation', { name }),
        account.enabled ? t('toast.heldOutFailed', { name }) : t('toast.backInRotationFailed', { name }),
        async () => {
          // A held-out account cannot be the preferred one: the preference goes first, so new work never waits on it
          if (clearPreference) await putSettings({ preferred: null });
          await api.updateAccount(id, { enabled: !account.enabled });
        },
      );
    const isPreferred = preferred === id;
    const last = accountUsable(account) && !data.some((a) => a.id !== id && accountUsable(a));
    // Returning one to rotation, or holding out one whose absence changes nothing, needs no question
    if (!account.enabled || (!isPreferred && !last)) {
      void flip(false);
      return;
    }
    void confirm({
      title: t('holdOut.title', { name }),
      body: last ? t('holdOut.lastBody') : t('holdOut.preferredBody'),
      confirmLabel: t('card.holdOut'),
    }).then((ok) => {
      if (ok) void flip(isPreferred);
    });
  };
  const prefer = (id: string) => {
    const account = data.find((a) => a.id === id);
    if (!account) return;
    const name = accountName(account);
    void act(t('toast.preferred', { name }), t('toast.preferFailed', { name }), async () => {
      const saved = await putSettings({ preferred: id });
      queryClient.setQueryData(keys.accountsSettings, saved);
    });
  };
  const remove = (id: string) => {
    const account = data.find((a) => a.id === id);
    if (!account) return;
    const name = accountName(account);
    void confirm({ title: t('remove.title', { name }), body: t('remove.body'), confirmLabel: t('common:actions.remove'), danger: true }).then(async (ok) => {
      if (ok) await act(t('toast.removed', { name }), t('toast.removeFailed', { name }), () => api.removeAccount(id));
    });
  };

  const addButton = (primary: boolean) => (
    <button type="button" className={primary ? 'btn btn-primary' : 'btn'} onClick={() => setAdding(true)}>
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
            <button type="button" className="btn" onClick={() => void readUsage()} disabled={reading} aria-busy={reading} aria-label={t('page.refresh')}>
              <span className="accounts-refresh-icon">{reading ? <Spinner /> : <RefreshCw {...ICON_SM} />}</span>
              <span className="accounts-action-text">{t('page.refresh')}</span>
              {reading && <span className="sr-only" role="status">{t('page.refreshing')}</span>}
            </button>
            {/* With no account the empty state's button is the zone's primary */}
            {addButton(accounts.length > 0)}
          </>
        }
      />

      {adding && <AddAccountDialog onClose={closeAdd} onAdded={refresh} />}
      {configSwitch && switching && (
        <AccountConfigDialog
          accountId={switching.id}
          name={accountName(switching)}
          to={configSwitch.to}
          busy={busy}
          onConfirm={(start) => switchConfig(switching.id, configSwitch.to, start)}
          onClose={closeConfigSwitch}
        />
      )}
      {signingAgain && <SignInAgainDialog key={signingAgain.id} account={signingAgain} onClose={closeSignIn} onDone={refresh} />}

      {accounts.length === 0 ? (
        <Empty illustration="signed-out" tone="warn" title={t('page.none')} action={addButton(true)}>
          {t('page.noneHint')}
        </Empty>
      ) : (
        <ul className="account-grid">
          {accounts.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              creditsUse={settings.data?.credits[account.id]?.use ?? 'never'}
              current={account.id === current}
              preferred={account.id === preferred}
              busy={busy}
              onToggle={() => toggle(account.id)}
              onRemove={() => remove(account.id)}
              // With no preference, the account in use is already where new work starts: nothing to offer on it
              {...(account.id === current && preferred === null ? {} : { onPrefer: () => prefer(account.id) })}
              onSignInAgain={() => setSigningIn(account.id)}
              {...(account.config
                ? {
                    onSwitchConfig: () => setConfigSwitch({ id: account.id, to: account.config?.mode === 'shared' ? 'independent' : 'shared' }),
                    onRepairConfig: () => repairConfig(account.id),
                    onUseSharedItem: (item: string) => useSharedItem(account.id, item),
                  }
                : {})}
              {...(reserves.has(account.id) ? { reservedFor: reserves.get(account.id) } : {})}
            />
          ))}
        </ul>
      )}

      {/* Only shared accounts stand on what it checks, and with none there is nothing to say */}
      {accounts.length > 0 && <CliCanaryLine />}

      {settings.data && <RotationCard settings={settings.data} accounts={data} />}

      <PoliciesCard policies={policies.data ?? []} accounts={data} />

      <ModelFallbacksCard fallbacks={fallbacks.data ?? []} />

      <UsageHistoryCard accounts={data} threshold={settings.data?.threshold ?? 90} />

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
                <span className="muted nowrap tnum" title={formatDateTime(event.ts)}>
                  {timeAgo(event.ts)}
                </span>
                <span className="break">
                  {event.from && event.to ? `${nameOfId(event.from)} → ${nameOfId(event.to)}` : (reasonText(event.reason) ?? event.detail ?? '')}
                  {event.from && event.to && event.reason ? ` · ${reasonText(event.reason)}` : ''}
                  {event.data?.once === true ? ` · ${t('log.once')}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
