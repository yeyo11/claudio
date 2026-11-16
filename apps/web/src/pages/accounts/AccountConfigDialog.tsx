import type { AccountConfigAction, AccountConfigMode, AccountConfigPlan, AccountConfigStart } from '@claudio/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { Dialog } from '@claudio/ui/components/Dialog';
import { ErrorBox, Segmented, Skeleton } from '@claudio/ui/components/ui';

/** The groups a plan is read in, in the order a person meets them; `keep` and `skip` change nothing and are not said */
const GROUPS = ['copied', 'linked', 'aside', 'unlinked', 'conflict'] as const;
type Group = (typeof GROUPS)[number];

const GROUP_OF: Partial<Record<AccountConfigAction, Group[]>> = {
  copy: ['copied'],
  link: ['linked'],
  // The account's own item goes aside, then the shared one takes its place: said in both lists
  replace: ['aside', 'linked'],
  'move-aside': ['aside'],
  unlink: ['unlinked'],
  conflict: ['conflict'],
};

/** The plan's steps as the names under each group; history keeps its links in both modes and is never listed */
export function planGroups(plan: AccountConfigPlan): Array<{ group: Group; names: string[] }> {
  const named = new Map<Group, string[]>();
  for (const step of plan.steps) {
    // History only shows when a switch moves it (an own `agent-memory` going aside): otherwise it is "stays shared"
    if (step.class === 'history' && step.action !== 'replace' && step.action !== 'move-aside') continue;
    for (const group of GROUP_OF[step.action] ?? []) named.set(group, [...(named.get(group) ?? []), step.name]);
  }
  return GROUPS.flatMap((group) => {
    const names = named.get(group);
    return names ? [{ group, names }] : [];
  });
}

/** What the dialog says: the mode's sentence, the start (to own only) and the plan, group by group. */
export function ConfigPlanBody({
  name,
  to,
  start,
  onStart,
  plan,
  loading,
  error,
}: {
  name: string;
  to: AccountConfigMode;
  start: AccountConfigStart;
  onStart: (start: AccountConfigStart) => void;
  plan: AccountConfigPlan | null;
  loading: boolean;
  error: unknown;
}) {
  const { t } = useTranslation(['accountsConfig', 'common']);
  const groups = plan ? planGroups(plan) : [];
  return (
      <div className="stack config-dialog">
        <p className="config-dialog-intro">{t(to === 'independent' ? 'configDialog.introOwn' : 'configDialog.introShared', { name })}</p>
        {to === 'independent' && (
          <div className="stack-tight">
            <span className="field-label">{t('configDialog.start')}</span>
            <Segmented<AccountConfigStart>
              label={t('configDialog.start')}
              value={start}
              onChange={onStart}
              options={[
                { value: 'copy', label: t('configDialog.startCopy') },
                { value: 'empty', label: t('configDialog.startEmpty') },
              ]}
            />
          </div>
        )}
        <ErrorBox error={error} title={t('configDialog.planFailed')} />
        {loading ? (
          <Skeleton rows={3} height={18} />
        ) : (
          plan &&
          (groups.length === 0 ? (
            <p className="muted small">{t('configDialog.nothing')}</p>
          ) : (
            <dl className="config-plan">
              {groups.map(({ group, names }) => (
                  <div key={group} className="config-plan-group">
                    <dt className="config-plan-label">{t(`configDialog.group.${group}`)}</dt>
                    <dd className="config-plan-names">
                      <span className="mono">{names.join(', ')}</span>
                      {group === 'aside' && plan.aside && (
                        <span className="config-plan-where small">
                          {t('configDialog.asideIn')} <span className="mono">{plan.aside}</span>
                        </span>
                      )}
                    </dd>
                  </div>
              ))}
            </dl>
          ))
        )}
        <p className="muted small">{t('configDialog.history')}</p>
      </div>
  );
}

/**
 * The mode switch, said before it happens (the owner's T9 decisions): what is copied, what is kept
 * aside and where, from `GET /accounts/:id/config/plan`, which changes nothing. A switch to the
 * account's own configuration starts from a copy, with empty offered.
 */
export function AccountConfigDialog({
  accountId,
  name,
  to,
  busy,
  onConfirm,
  onClose,
}: {
  accountId: string;
  name: string;
  to: AccountConfigMode;
  busy: boolean;
  onConfirm: (start: AccountConfigStart | undefined) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(['accountsConfig', 'common']);
  const [start, setStart] = useState<AccountConfigStart>('copy');
  const startOf = to === 'independent' ? start : undefined;
  const plan = useQuery({
    queryKey: ['accounts', accountId, 'config-plan', to, startOf ?? null],
    queryFn: ({ signal }) => api.accountConfigPlan(accountId, to, startOf, { signal }),
    // A plan is a reading of the dir now: the next opening reads it again
    staleTime: 0,
    gcTime: 0,
  });

  return (
    <Dialog
      title={t(to === 'independent' ? 'configDialog.titleOwn' : 'configDialog.titleShared', { name })}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common:actions.cancel')}
          </button>
          <button type="button" className="btn btn-primary" data-autofocus disabled={busy || !plan.data} onClick={() => onConfirm(startOf)}>
            {t(to === 'independent' ? 'configDialog.confirmOwn' : 'configDialog.confirmShared')}
          </button>
        </>
      }
    >
      <ConfigPlanBody name={name} to={to} start={start} onStart={setStart} plan={plan.data ?? null} loading={plan.isLoading} error={plan.error} />
    </Dialog>
  );
}
