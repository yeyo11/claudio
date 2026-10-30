import type { GuardOverride, GuardSettings, GuardSwitchableRuleId } from '@claudio/shared';
import { useQuery } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Sheet, Switch } from '@claudio/ui/components/controls';
import { ICON_SM } from '@claudio/ui/components/icons';
import { formatNumber } from '@claudio/ui/lib/format';
import { api, keys } from '../api';
import { effectiveGuards, guardChatPath, overrideOf, skippedRules, SWITCHABLE_RULES, type EffectiveGuards } from '../lib/guards';
import { Tooltip } from '@claudio/ui/components/controls/Tooltip';

/** The global guard settings every override is read against; undefined while they load or when they could not be read. */
export function useGuardSettings(): GuardSettings | undefined {
  return useQuery({ queryKey: keys.guardSettings, queryFn: ({ signal }) => api.guardSettings({ signal }) }).data?.settings;
}

/** One rule's name in mono next to its one-line meaning: the id is the stable part, so it is never translated. */
function RuleLabel({ id }: { id: GuardSwitchableRuleId }) {
  const { t } = useTranslation('components');
  return (
    <span className="guard-rule-text">
      <span className="guard-rule-name">{t(`guards.rule.${id}.name`)}</span>
      <span className="guard-rule-desc">{t(`guards.rule.${id}.hint`)}</span>
      <span className="guard-rule-id mono">{id}</span>
    </span>
  );
}

/**
 * The "Guards" row of a graph or a flow stage: a Switch for the guard as a whole and a "Rules" button
 * with one Switch per rule in a Sheet. It edits an override of the global settings, never a copy of
 * them, so what the person leaves alone keeps following Settings. A warn line names what the runs
 * will go without.
 */
export function GuardRow({
  value,
  onChange,
  label,
  help,
  workflow = false,
}: {
  value: GuardOverride | undefined;
  onChange: (next: GuardOverride | undefined) => void;
  /** The Switch's visible label; "Guards" when absent */
  label?: string;
  help?: string;
  /** A workflow's subagents may not pass through the guard, so the help line says so (docs/plans/guards.md, F10) */
  workflow?: boolean;
}) {
  const { t } = useTranslation('components');
  const global = useGuardSettings();
  const [open, setOpen] = useState(false);
  const wanted: EffectiveGuards | null = global ? effectiveGuards(global, value) : null;
  const apply = (next: EffectiveGuards) => global && onChange(overrideOf(global, next));
  const skipped = global && wanted ? skippedRules(global, wanted) : [];

  return (
    <div className="guard-row">
      <div className="guard-row-main">
        <Switch checked={wanted?.enabled ?? false} disabled={!wanted} onChange={(enabled) => wanted && apply({ ...wanted, enabled })}>
          {label ?? t('guards.row.label')}
        </Switch>
        <button type="button" className="btn btn-small" disabled={!wanted} onClick={() => setOpen(true)}>
          {t('guards.row.rules')}
        </button>
      </div>
      <p className="field-hint">{help ?? t('guards.row.help')}</p>
      {workflow && wanted?.enabled && <p className="field-hint">{t('guards.row.workflowHint')}</p>}
      {wanted && !wanted.enabled && (
        <div className="alert alert-warn small guard-row-warn" role="status">
          <ShieldAlert className="alert-icon" {...ICON_SM} />
          <div className="alert-body">{t('guards.row.off')}</div>
        </div>
      )}
      {wanted?.enabled && skipped.length > 0 && (
        <div className="alert alert-warn small guard-row-warn" role="status">
          <ShieldAlert className="alert-icon" {...ICON_SM} />
          <div className="alert-body">
            {t('guards.row.without')} <span className="mono">{skipped.join(', ')}</span>.
          </div>
        </div>
      )}
      {wanted && (
        <Sheet open={open} onOpenChange={setOpen} title={t('guards.sheet.title')} description={t('guards.sheet.body')} side="auto">
          <div className="guard-rules">
            {SWITCHABLE_RULES.map((id) => (
              <div key={id} className="guard-rule">
                <Switch
                  checked={wanted.rules[id]}
                  disabled={!wanted.enabled}
                  onChange={(on) => apply({ ...wanted, rules: { ...wanted.rules, [id]: on } })}
                  aria-label={t(`guards.rule.${id}.name`)}
                />
                <RuleLabel id={id} />
              </div>
            ))}
          </div>
        </Sheet>
      )}
    </div>
  );
}

/** The warn chip of a task or a flow run: how many tool calls the guard blocked, a link to the chat at the first notice. */
export function GuardChip({ count, chatId }: { count: number | undefined; chatId?: string | null }) {
  const { t } = useTranslation('components');
  if (!count || count < 1) return null;
  const body = (
    <>
      <ShieldAlert size={12} strokeWidth={2} aria-hidden />
      <span className="guard-chip-n">{t('guards.chip', { count, n: formatNumber(count) })}</span>
    </>
  );
  if (!chatId) return <span className="chip guard">{body}</span>;
  return (
    <Tooltip content={t('guards.chipOpen')}>
      <Link to={guardChatPath(chatId)} className="chip guard">
        {body}
      </Link>
    </Tooltip>
  );
}
