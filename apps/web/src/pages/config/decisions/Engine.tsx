import type { DecisionProviderId, DecisionSettings, DecisionTestResult, DecisionUnavailableReason, SettingDefault } from '@claudio/shared';
import { isEffort } from '@claudio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cpu, KeyRound, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys } from '../../../api';
import { Collapsible, NumberInput } from '@claudio/ui/components/controls';
import { useConfirm } from '@claudio/ui/components/Dialog';
import { ICON, ICON_SM } from '@claudio/ui/components/icons';
import { useToast } from '@claudio/ui/components/Toast';
import { ErrorBox, Segmented, Tag } from '@claudio/ui/components/ui';
import { formatCost, formatNumber, timeAgo } from '@claudio/ui/lib/format';
import { EffortPicker, effortLabel } from '../../../components/EffortPicker';
import { ModelCombobox } from '../../../components/ui';
import { Overridden, ServerSettingChange } from '../SettingChange';
import { settingsHref } from '../settingsGroups';
import { SettingsReveal } from '../groups/Block';
import { capConsequence, type Draft } from './model';

/** The server refuses a ceiling outside (0, 5] and a history outside 1..365 days. */
export const MAX_COST = 5;
export const MAX_HISTORY_DAYS = 365;
/** "When it repeats" (D10): this many of the last `RECENT` Jev requests failing raises the warning. */
const RECENT = 10;
const REPEATS = 3;

/** The rows Advanced holds: a search result for one of them opens it. */
export const ADVANCED_SETTINGS: readonly string[] = ['engine.cli-model', 'engine.cli-effort', 'engine.history-days'];

/**
 * One row of the engine (settings-patterns.md): the label and its control on one baseline, the
 * consequence under the label. An error takes the consequence's place, so nothing below moves.
 */
function Field({
  setting,
  label,
  line,
  error,
  change,
  children,
}: {
  setting: string;
  label: ReactNode;
  line?: ReactNode;
  error?: ReactNode;
  /** The row's "Changed · Reset" slot: before the control on its line on a desktop, under it on a phone */
  change?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="dp-field" data-setting={setting}>
      <div className="dp-field-text">
        <span className="dp-field-label">{label}</span>
        {error ? (
          <span className="dp-field-line is-error" role="status">
            <TriangleAlert {...ICON_SM} aria-hidden />
            {error}
          </span>
        ) : (
          line !== undefined && <span className="dp-field-line">{line}</span>
        )}
      </div>
      <div className={change === undefined ? 'dp-field-control' : 'dp-field-control has-change'}>
        {children}
        {change}
      </div>
    </div>
  );
}

/**
 * Who answers, the cap per decision and Advanced (§7.1): what every point runs on. Jev's key and
 * model show only with Jev chosen, and the CLI's model and effort only with the CLI.
 */
export function EngineSection({
  saved,
  draft,
  patch,
  costValid,
  daysValid,
  decisions,
  advancedOpen,
  onAdvanced,
  onExample,
  onReset,
}: {
  saved: DecisionSettings;
  draft: Draft;
  patch: (next: Partial<Draft>) => void;
  costValid: boolean;
  daysValid: boolean;
  /** Decisions in the history window, for the cap's consequence; null while it loads */
  decisions: number | null;
  advancedOpen: boolean;
  onAdvanced: (open: boolean) => void;
  onExample: () => void;
  /** A row went back to its default on the server: the draft takes that field from the saved document */
  onReset: (setting: string) => void;
}) {
  const { t } = useTranslation('decisions');
  const { t: tc } = useTranslation('components');
  const jev = draft.provider === 'jev';
  const invalidate = [keys.decisionSettings];
  const change = (setting: string, label: string, wording?: (value: SettingDefault) => string) => (
    <ServerSettingChange id={setting} label={label} {...(wording ? { wording } : {})} invalidate={invalidate} onReset={() => onReset(setting)} />
  );

  return (
    <>
      <JevUnavailable provider={draft.provider} />
      <div className="dp-who" data-setting="engine.who-answers">
        <div className="setting-change-row">
          <Segmented
            label={t('whoAnswers')}
            value={draft.provider}
            onChange={(provider) => patch({ provider })}
            options={[
              { value: 'cli', label: t('engine.cli') },
              { value: 'jev', label: <JevLabel /> },
            ]}
          />
          <p className="dp-field-line">
            {jev ? (
              <>
                {t('consequence.jev')}{' '}
                <button type="button" className="link-btn" onClick={onExample}>
                  {t('examplePayload')}
                </button>
              </>
            ) : (
              t('consequence.cli')
            )}
            <Overridden id="engine.who-answers" />
          </p>
          {change('engine.who-answers', t('whoAnswers'), (value) => (value === 'jev' ? t('engine.jev') : t('engine.cli')))}
        </div>
      </div>
      <SettingsReveal open={jev}>
        <p className="dp-field-line dp-model-hint">
          <Trans t={t} i18nKey="engine.modelPinned" values={{ model: saved.jev.model }} components={{ mono: <span className="dp-mono" /> }} />
        </p>
        <JevKey saved={saved} />
      </SettingsReveal>
      <Field
        setting="engine.cap"
        label={t('cap.label')}
        line={<CapLine cap={draft.cli.maxCostUsd} decisions={decisions} days={saved.historyDays} />}
        error={costValid ? undefined : t('engine.maxCostInvalid', { max: MAX_COST })}
        change={change('engine.cap', t('cap.label'), (value) => (typeof value === 'number' ? formatCost(value) : ''))}
      >
        <div className="dp-cost">
          <NumberInput
            aria-label={t('cap.label')}
            decimal
            min={0.01}
            max={MAX_COST}
            step={0.01}
            value={draft.cli.maxCostUsd}
            onChange={(maxCostUsd) => patch({ cli: { ...draft.cli, maxCostUsd: maxCostUsd ?? 0 } })}
          />
        </div>
      </Field>
      <Collapsible className="dp-advanced" title={t('advanced')} open={advancedOpen} onOpenChange={onAdvanced}>
        {!jev && (
          <>
            <Field setting="engine.cli-model" label={t('engine.cliModel')} error={draft.cli.model.trim() === '' ? t('engine.cliModelEmpty') : undefined}
              change={change('engine.cli-model', t('engine.cliModel'))}
            >
              <div className="dp-model">
                <ModelCombobox aria-label={t('engine.cliModel')} value={draft.cli.model} onChange={(model) => patch({ cli: { ...draft.cli, model } })} />
              </div>
            </Field>
            <Field
              setting="engine.cli-effort"
              label={t('engine.effort')}
              change={change('engine.cli-effort', t('engine.effort'), (value) => (typeof value === 'string' ? effortLabel(tc, value) : ''))}
            >
              <EffortPicker
                aria-label={t('engine.effort')}
                value={isEffort(draft.cli.effort) ? draft.cli.effort : ''}
                onChange={(effort) => effort && patch({ cli: { ...draft.cli, effort } })}
                model={draft.cli.model}
                use="chat"
                allowUnset={false}
              />
            </Field>
          </>
        )}
        <Field
          setting="engine.history-days"
          label={t('engine.historyDays')}
          line={t('engine.historyDaysHint')}
          error={daysValid ? undefined : t('engine.historyDaysInvalid', { max: MAX_HISTORY_DAYS })}
          change={change('engine.history-days', t('engine.historyDays'))}
        >
          <div className="dp-cost">
            <NumberInput
              aria-label={t('engine.historyDays')}
              min={1}
              max={MAX_HISTORY_DAYS}
              value={draft.historyDays}
              onChange={(historyDays) => patch({ historyDays: historyDays ?? 0 })}
            />
          </div>
        </Field>
      </Collapsible>
    </>
  );
}

/** The cap's consequence (owner's decision 7), from the history window's volume and the daily spend cap. */
export function CapLine({ cap, decisions, days, dailyCapUsd }: { cap: number; decisions: number | null; days: number; dailyCapUsd?: number | null }) {
  const { t } = useTranslation('decisions');
  const spend = useQuery({ queryKey: keys.spend, queryFn: () => api.spend(), enabled: dailyCapUsd === undefined });
  const daily = dailyCapUsd !== undefined ? dailyCapUsd : (spend.data?.capUsd ?? null);
  const { perDayUsd, withinDaily } = capConsequence(cap, decisions ?? 0, days, daily);
  return (
    <>
      <span className="tnum">{perDayUsd === null ? t('cap.none', { cost: formatCost(cap) }) : t('cap.perDay', { cost: formatCost(perDayUsd) })}</span>
      {withinDaily !== null && (
        <>
          {' · '}
          <Link to={settingsHref('runs', { section: 'spend-cap' })} className="tnum dp-cap-link">
            {t('cap.withinDaily', { count: withinDaily, formatted: formatNumber(withinDaily) })}
          </Link>
        </>
      )}
    </>
  );
}

/** Jev ships as a beta: an outside service still being measured in shadow, so its option says so, once. */
function JevLabel() {
  const { t } = useTranslation('decisions');
  return (
    <span className="dp-beta-title">
      {/* A label, not a verdict: neutral, so it reads on the selected option's fill in both themes */}
      {t('engine.jev')} <Tag>{t('engine.beta')}</Tag>
    </span>
  );
}

/** The warning of D10: shown when the last Jev requests keep failing, and only while Jev is the provider. */
function JevUnavailable({ provider }: { provider: DecisionProviderId }) {
  const { t } = useTranslation('decisions');
  const recent = useQuery({
    queryKey: keys.decisionsRecent({ provider: 'jev', limit: RECENT }),
    queryFn: () => api.decisions({ provider: 'jev', limit: RECENT }),
    refetchInterval: 30_000,
  });
  if (provider !== 'jev' || !recent.data) return null;
  const failed = recent.data.items.filter((row) => row.status === 'unavailable');
  if (failed.length < REPEATS) return null;
  const counts = new Map<DecisionUnavailableReason, number>();
  for (const row of failed) if (row.unavailable) counts.set(row.unavailable, (counts.get(row.unavailable) ?? 0) + 1);
  const reasons = [...counts].map(([reason, n]) => `${formatNumber(n)} ${t(`engine.reason.${reason}`)}`).join(', ');
  const last = failed[0];
  return (
    <div className="alert alert-warn" role="status">
      <TriangleAlert className="alert-icon" {...ICON} />
      <div className="alert-body dp-note-card">
        <strong>{t('engine.unavailableTitle')}</strong>
        <span>
          {t('engine.unavailableBody', {
            failed: formatNumber(failed.length),
            total: formatNumber(recent.data.items.length),
            reasons,
            when: last ? timeAgo(last.at) : '',
          })}
        </span>
      </div>
    </div>
  );
}

/** The Jev key, in the secrets pattern: asked for where Jev is chosen, never shown again once saved. */
function JevKey({ saved }: { saved: DecisionSettings }) {
  const { t } = useTranslation('decisions');
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState('');
  const [result, setResult] = useState<DecisionTestResult | null>(null);
  const [testedAt, setTestedAt] = useState<number | null>(null);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: keys.decisionSettings });
  const putKey = useMutation({
    mutationFn: () => api.putDecisionKey(key.trim()),
    onSuccess: () => {
      setKey('');
      setEditing(false);
      setResult(null);
      refresh();
      toast.success(t('engine.keySaved'));
    },
  });
  const removeKey = useMutation({
    mutationFn: () => api.deleteDecisionKey(),
    onSuccess: () => {
      setResult(null);
      refresh();
      toast.success(t('engine.keyRemoved'));
    },
  });
  const test = useMutation({
    mutationFn: () => api.testDecisionProvider('jev'),
    onSuccess: (next) => {
      setResult(next);
      setTestedAt(Date.now());
    },
  });

  const remove = async () => {
    const ok = await confirm({
      title: t('engine.removeKeyTitle'),
      body: t('engine.removeKeyBody'),
      confirmLabel: t('engine.removeKey'),
      danger: true,
    });
    if (ok) removeKey.mutate();
  };
  const showInput = editing || !saved.jev.keySet;

  return (
    <Field setting="engine.jev-key" label={t('engine.jevKey')} line={t('engine.jevKeyHint')}>
      <div className="dp-key-body">
        {showInput ? (
          <form
            className="dp-inline"
            onSubmit={(event) => {
              event.preventDefault();
              if (key.trim() !== '') putKey.mutate();
            }}
          >
            <div className="field dp-key">
              <input
                type="password"
                className="mono"
                autoComplete="off"
                aria-label={t('engine.jevKeyInput')}
                value={key}
                onChange={(event) => setKey(event.target.value)}
              />
            </div>
            {/* Secondary: the screen's primary action is the save bar's, and two gradients are the most a screen takes */}
            <button type="submit" className="btn" disabled={key.trim() === '' || putKey.isPending}>
              <KeyRound {...ICON_SM} />
              <span className="dp-save-label">
                <span aria-hidden={putKey.isPending}>{t('engine.saveKey')}</span>
                <span aria-hidden={!putKey.isPending}>{t('engine.savingKey')}</span>
              </span>
            </button>
            {saved.jev.keySet && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setEditing(false);
                  setKey('');
                }}
              >
                {t('engine.cancelKey')}
              </button>
            )}
          </form>
        ) : (
          <div className="dp-inline">
            <span className="dp-mono" aria-label={t('engine.jevKeyInput')}>
              {'••••••••••••'}
              {saved.jev.keyHint ?? ''}
            </span>
            <button type="button" className="btn" onClick={() => setEditing(true)}>
              {t('engine.changeKey')}
            </button>
            <button type="button" className="btn btn-ghost" disabled={removeKey.isPending} onClick={() => void remove()}>
              {t('engine.removeKey')}
            </button>
          </div>
        )}
        <ErrorBox error={putKey.error ?? removeKey.error ?? test.error} />
        {saved.jev.keySet && (
          <div className="dp-key-state">
            <button type="button" className="btn" disabled={test.isPending} onClick={() => test.mutate()}>
              <Cpu {...ICON_SM} /> {test.isPending ? t('engine.testing') : t('engine.test')}
            </button>
            {result && (
              <>
                <span className={`badge ${result.ok ? 'badge-ok' : 'badge-bad'}`}>
                  <span className={`dot ${result.ok ? 'dot-ok' : 'dot-bad'}`} />
                  {result.ok ? t('engine.connected') : t('engine.failed')}
                </span>
                <span className="tnum">
                  {result.ok ? `${formatNumber(result.latencyMs / 1000, { maximumFractionDigits: 1 })} s` : result.reason ? t(`engine.reason.${result.reason}`) : ''}
                  {testedAt !== null && ` · ${timeAgo(testedAt)}`}
                </span>
              </>
            )}
          </div>
        )}
      </div>
    </Field>
  );
}
