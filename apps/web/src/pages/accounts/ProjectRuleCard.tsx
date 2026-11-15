import type { Account, Project, RotationPolicy, RotationPolicyRequest } from '@claudio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys, useAccounts, useProjects } from '../../api';
import { NumberInput, Select, Switch } from '@claudio/ui/components/controls';
import { useConfirm } from '@claudio/ui/components/Dialog';
import { ICON_SM } from '@claudio/ui/components/icons';
import { useToast } from '@claudio/ui/components/Toast';
import { Card, ErrorBox } from '@claudio/ui/components/ui';
import { formatNumber, formatPercent } from '@claudio/ui/lib/format';
import { accountName, allowsAccount, reserveAccountOf, ruleOf } from '../../lib/accounts';
import { PrefRow } from '../config/PrefRow';

/** The reserve's bounds (`RESERVE_CAP` in @claudio/accounts) and where a new one starts */
const RESERVE_MIN = 1;
const RESERVE_MAX = 30;
const RESERVE_START = 10;

/** No preferred account in the Select: the rule leaves the person's own preference in charge */
const NONE = '';

/** How long the points wait after the last step or keystroke before they are saved */
const SETTLE_MS = 600;

/**
 * The reserve's points: the field is the person's while they step or type, and is saved once it
 * settles, clamped to 1-30. It is never disabled by a save in flight, so a quick second step is not
 * lost, and a value out of range shows the clamped one it was saved as.
 */
function ReservePoints({ saved, label, onSave }: { saved: number; label: string; onSave: (percent: number) => void }) {
  const [value, setValue] = useState<number | undefined>(saved);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A save from elsewhere (or the clamp coming back) shows once nobody is typing
  useEffect(() => {
    if (!timer.current) setValue(saved);
  }, [saved]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <NumberInput
      aria-label={label}
      min={RESERVE_MIN}
      max={RESERVE_MAX}
      step={1}
      value={value}
      onChange={(next) => {
        setValue(next);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          timer.current = null;
          if (next === undefined) {
            setValue(saved);
            return;
          }
          const clamped = Math.min(RESERVE_MAX, Math.max(RESERVE_MIN, Math.round(next)));
          setValue(clamped);
          if (clamped !== saved) onSave(clamped);
        }, SETTLE_MS);
      }}
    />
  );
}

/** A policy as the request that writes it back whole, so one change never drops the other fields */
export function requestOf(policy: RotationPolicy): RotationPolicyRequest {
  return {
    projects: policy.projects,
    ...(policy.threshold !== undefined ? { threshold: policy.threshold } : {}),
    ...(policy.order ? { order: policy.order } : {}),
    ...(policy.preferred ? { preferred: policy.preferred } : {}),
    ...(policy.reserve ? { reserve: policy.reserve } : {}),
    ...(policy.strictConfig ? { strictConfig: true } : {}),
    ...(policy.looseChats ? { looseChats: true } : {}),
  };
}

/**
 * Turns one account on or off in a rule's list. Off: a rule with no list allows every account, so
 * the list becomes every other account; the preferred account it named goes with it, and the reserve
 * when nothing is left to name its account. The last allowed account cannot be turned off.
 */
export function withAccount(rule: RotationPolicyRequest, accounts: readonly Pick<Account, 'id'>[], id: string, allowed: boolean): RotationPolicyRequest {
  const current = rule.order ?? accounts.map((a) => a.id);
  const order = allowed ? (current.includes(id) ? current : [...current, id]) : current.filter((n) => n !== id);
  const { preferred, reserve, ...rest } = rule;
  const keepPreferred = preferred !== undefined && order.includes(preferred);
  return {
    ...rest,
    order,
    ...(keepPreferred ? { preferred } : {}),
    ...(reserve && (keepPreferred || order.length > 0) ? { reserve } : {}),
  };
}

/**
 * A project's account rule, in its settings (docs/plans/account-configuration-and-project-rules.md
 * §7, the owner's T9 decisions): which accounts may work on it, the one it prefers, the headroom it
 * keeps while it has work and whether rotation stays within one configuration. All optional: with no
 * rule only "Add a rule" shows. It edits the policy on `/accounts/policies` that governs the project,
 * saved at each change; a policy that governs other projects too says so, since a change reaches them.
 */
export function ProjectRuleCard({ project }: { project: Project }) {
  const { t } = useTranslation(['accountsConfig', 'common']);
  const id = useId();
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const accounts = useAccounts();
  const projects = useProjects(false);
  const policies = useQuery({ queryKey: keys.accountPolicies, queryFn: ({ signal }) => api.accountPolicies({ signal }) });
  const settings = useQuery({ queryKey: keys.accountsSettings, queryFn: ({ signal }) => api.accountsSettings({ signal }) });
  const rule = ruleOf(policies.data ?? [], project.id);

  const save = useMutation({
    mutationFn: (next: RotationPolicyRequest) => (rule ? api.updateAccountPolicy(rule.id, next) : api.createAccountPolicy(next)),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.accountPolicies }),
  });
  const remove = useMutation({
    mutationFn: (policy: RotationPolicy) => api.deleteAccountPolicy(policy.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.accountPolicies });
      toast.success(t('projectRule.removed'));
    },
    onError: (err) => toast.error(t('projectRule.removeFailed'), err),
  });

  const list = accounts.data ?? [];
  // With one account or none there is nothing to choose between
  if (!policies.data || list.length < 2) return null;
  const nameOf = (account: string) => {
    const found = list.find((a) => a.id === account);
    return found ? accountName(found) : account;
  };

  if (!rule) {
    return (
      <Card className="project-rule-card" title={t('projectRule.title')}>
        <div className="project-rule-none">
          <span className="muted">{t('projectRule.none')}</span>
          <button type="button" className="btn btn-small" disabled={save.isPending} onClick={() => save.mutate({ projects: [project.id] })}>
            <Plus {...ICON_SM} />
            {t('projectRule.add')}
          </button>
        </div>
        <ErrorBox error={save.error} title={t('projectRule.saveFailed')} />
      </Card>
    );
  }

  const request = requestOf(rule);
  const write = (next: RotationPolicyRequest) => save.mutate(next);
  const allowed = list.filter((a) => allowsAccount(rule, a.id));
  const others = [...rule.projects.filter((p) => p !== project.id).map((p) => projects.data?.find((x) => x.id === p)?.name ?? p), ...(rule.looseChats ? [t('policies.looseChatsName')] : [])];
  const reserveAccount = reserveAccountOf(rule);
  const threshold = rule.threshold ?? settings.data?.threshold ?? 90;
  const percent = rule.reserve?.percent ?? RESERVE_START;
  // Strict grouping only means something once an account keeps its own configuration
  const showStrict = rule.strictConfig === true || list.some((a) => a.config?.mode === 'independent');

  return (
    <Card
      className="project-rule-card"
      title={t('projectRule.title')}
      actions={
        <button
          type="button"
          className="btn btn-small"
          disabled={remove.isPending}
          onClick={() =>
            void confirm({
              title: t('projectRule.removeTitle'),
              body: others.length > 0 ? t('projectRule.removeBodyShared', { projects: others.join(', ') }) : t('projectRule.removeBody'),
              confirmLabel: t('projectRule.remove'),
              danger: true,
            }).then((ok) => {
              if (ok) remove.mutate(rule);
            })
          }
        >
          <Trash2 {...ICON_SM} />
          {t('projectRule.remove')}
        </button>
      }
    >
      {others.length > 0 && <p className="muted small">{t('projectRule.alsoGoverns', { projects: others.join(', ') })}</p>}
      <div className="pref-rows project-rule-rows">
        <PrefRow
          id={`${id}-allowed`}
          setting="project.account-rule.allowed"
          stacked
          title={t('projectRule.allowed')}
          hint={rule.order ? t('projectRule.allowedSome', { count: allowed.length, n: formatNumber(allowed.length), total: formatNumber(list.length) }) : t('projectRule.allowedAll')}
        >
          <div className="project-rule-accounts">
            {list.map((account) => {
              const on = allowsAccount(rule, account.id);
              return (
                <Switch
                  key={account.id}
                  checked={on}
                  // The last allowed account stays: a rule that allows none would stop every run here
                  disabled={save.isPending || (on && allowed.length === 1)}
                  onChange={(next) => write(withAccount(request, list, account.id, next))}
                >
                  {accountName(account)}
                </Switch>
              );
            })}
          </div>
        </PrefRow>

        <PrefRow
          id={`${id}-preferred`}
          setting="project.account-rule.preferred"
          title={t('projectRule.preferred')}
          hint={rule.preferred ? t('projectRule.preferredOn', { name: nameOf(rule.preferred) }) : t('projectRule.preferredOff')}
        >
          <Select
            aria-label={t('projectRule.preferred')}
            value={rule.preferred ?? NONE}
            disabled={save.isPending}
            options={[{ value: NONE, label: t('projectRule.preferredNone') }, ...allowed.map((a) => ({ value: a.id, label: accountName(a) }))]}
            onChange={(value) => {
              const { preferred: _dropped, reserve, ...rest } = request;
              // Without a preferred account and a list, the reserve has no account to sit on
              const keepReserve = reserve && (value !== NONE || rest.order !== undefined);
              write({ ...rest, ...(value !== NONE ? { preferred: value } : {}), ...(keepReserve ? { reserve } : {}) });
            }}
          />
        </PrefRow>

        <PrefRow
          id={`${id}-reserve`}
          setting="project.account-rule.reserve"
          title={t('projectRule.reserve')}
          hint={
            !reserveAccount
              ? t('projectRule.reserveNeedsAccount')
              : rule.reserve
                ? t('projectRule.reserveOn', { name: nameOf(reserveAccount), at: formatPercent(Math.max(0, threshold - percent)), threshold: formatPercent(threshold) })
                : t('projectRule.reserveOff', { name: nameOf(reserveAccount) })
          }
        >
          <div className="project-rule-reserve">
            <Switch
              checked={rule.reserve !== undefined}
              disabled={save.isPending || !reserveAccount}
              onChange={(on) => {
                const { reserve: _dropped, ...rest } = request;
                write(on ? { ...rest, reserve: { percent } } : rest);
              }}
            >
              {t('projectRule.reserveSwitch')}
            </Switch>
            {rule.reserve && (
              <span className="project-rule-points">
                <ReservePoints saved={rule.reserve.percent} label={t('projectRule.reservePoints')} onSave={(percent) => write({ ...request, reserve: { percent } })} />
                <span className="muted small">{t('projectRule.points', { count: rule.reserve.percent })}</span>
              </span>
            )}
          </div>
        </PrefRow>

        {showStrict && (
          <PrefRow id={`${id}-strict`} setting="project.account-rule.strict" title={t('projectRule.strict')} hint={t(rule.strictConfig ? 'projectRule.strictOn' : 'projectRule.strictOff')}>
            <Switch
              checked={rule.strictConfig === true}
              disabled={save.isPending}
              aria-label={t('projectRule.strict')}
              onChange={(on) => {
                const { strictConfig: _dropped, ...rest } = request;
                write(on ? { ...rest, strictConfig: true } : rest);
              }}
            />
          </PrefRow>
        )}
      </div>
      <ErrorBox error={save.error} title={t('projectRule.saveFailed')} />
    </Card>
  );
}
