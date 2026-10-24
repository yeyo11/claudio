import type { AccountsSettings, SettingDefault } from '@claudio/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatPercent } from '@claudio/ui/lib/format';
import { api, keys } from '../../api';
import { NumberInput, Slider, Switch } from '@claudio/ui/components/controls';
import { useToast } from '@claudio/ui/components/Toast';
import { Segmented } from '@claudio/ui/components/ui';
import { ServerSettingChange } from '../config/SettingChange';

const STRATEGIES = ['order', 'least-used'] as const;

/**
 * `accounts.json` as one card: when work moves to another account and which one it takes. Nothing
 * applies until Save, so a half-edited threshold never reaches a chat that is about to start.
 */
export function RotationCard({ settings }: { settings: AccountsSettings }) {
  const { t } = useTranslation(['accountsConfig', 'config']);
  const queryClient = useQueryClient();
  const toast = useToast();
  const id = useId();
  // Only the person's unsaved edits are state; what the card shows is the saved copy with them on
  // top. A new saved copy (after a Reset or a Save elsewhere) is then shown at once for every field
  // nobody edited, with nothing to keep in step: two writers of a whole draft raced in the PR #55
  // reviews, and either flashed Discard or kept a stale value that Save wrote back
  const [edits, setEdits] = useState<Partial<AccountsSettings>>({});
  const draft: AccountsSettings = { ...settings, ...edits };
  const edit = (patch: Partial<AccountsSettings>) => setEdits((now) => ({ ...now, ...patch }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  const mutation = useMutation({
    mutationFn: (next: Partial<AccountsSettings>) => api.putAccountsSettings(next),
    onSuccess: (saved) => {
      // The saved copy first, so dropping the edits never shows the old values for a frame
      queryClient.setQueryData(keys.accountsSettings, saved);
      setEdits({});
      toast.success(t('rotation.updated'));
      void queryClient.invalidateQueries({ queryKey: keys.accountsSettings });
    },
    onError: (err) => toast.error(t('rotation.updateFailed'), err),
  });

  // A Reset drops that field's unsaved edit, if any, so it shows the saved default; the other edits stay
  const dropEdit = (field: keyof AccountsSettings) => () =>
    setEdits((now) => {
      const { [field]: _dropped, ...rest } = now;
      return rest;
    });
  const change = (setting: string, label: string, field: keyof AccountsSettings, wording?: (value: SettingDefault) => string) => (
    <ServerSettingChange id={`accounts.${setting}`} label={label} {...(wording ? { wording } : {})} invalidate={[keys.accountsSettings]} onReset={dropEdit(field)} />
  );

  return (
    <section className="card rotation-card" aria-labelledby={`${id}-title`}>
      <form
        className="rotation-form"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate(draft);
        }}
      >
        <div className="rotation-head">
          <span className="rotation-title">
            <h2 id={`${id}-title`}>{t('rotation.title')}</h2>
            <span className="muted small">{t('rotation.subtitle')}</span>
          </span>
          <div className="rotation-switch setting-change-row" data-setting="accounts.rotate-on-limit">
            <Switch checked={draft.rotateOnLimit} onChange={(rotateOnLimit) => edit({ rotateOnLimit })} tooltip={t('rotation.rotateHint')}>
              {t('rotation.rotateOnLimit')}
            </Switch>
            {change('rotate-on-limit', t('rotation.rotateOnLimit'), 'rotateOnLimit')}
          </div>
        </div>

        <div className="rotation-grid">
          <div className="rotation-field setting-change-row" data-setting="accounts.threshold">
            <span className="section-label">{t('rotation.threshold')}</span>
            <Slider aria-label={t('rotation.threshold')} min={50} max={99} value={draft.threshold} onChange={(threshold) => edit({ threshold })} />
            <span className="field-hint">{t('rotation.thresholdAt', { percent: formatPercent(draft.threshold) })}</span>
            {change('threshold', t('rotation.threshold'), 'threshold', (value) => (typeof value === 'number' ? formatPercent(value) : ''))}
          </div>
          <div className="rotation-field setting-change-row" data-setting="accounts.strategy">
            <span className="section-label">{t('rotation.strategy')}</span>
            <Segmented<AccountsSettings['strategy']>
              label={t('rotation.strategy')}
              value={draft.strategy}
              onChange={(strategy) => edit({ strategy })}
              options={STRATEGIES.map((s) => ({ value: s, label: t(`rotation.strategies.${s}`) }))}
            />
            {change('strategy', t('rotation.strategy'), 'strategy', (value) => t(`rotation.strategies.${STRATEGIES.find((s) => s === value) ?? 'order'}`))}
          </div>
          {/* Not a <label>: the stepper's own buttons would take its name */}
          <div className="rotation-field setting-change-row" data-setting="accounts.hysteresis">
            <span className="section-label">{t('rotation.hysteresis')}</span>
            <NumberInput
              aria-label={t('rotation.hysteresis')}
              min={0}
              max={50}
              step={1}
              value={draft.hysteresis}
              onChange={(hysteresis) => edit({ hysteresis: hysteresis ?? 0 })}
            />
            <span className="field-hint">{t('rotation.hysteresisHint')}</span>
            {change('hysteresis', t('rotation.hysteresis'), 'hysteresis')}
          </div>
          <div className="rotation-field setting-change-row" data-setting="accounts.cooldown">
            <span className="section-label">{t('rotation.cooldown')}</span>
            <NumberInput
              aria-label={t('rotation.cooldown')}
              min={0}
              max={86_400}
              step={60}
              value={draft.cooldownSeconds}
              onChange={(cooldownSeconds) => edit({ cooldownSeconds: cooldownSeconds ?? 0 })}
            />
            <span className="field-hint">{t('rotation.cooldownHint')}</span>
            {change('cooldown', t('rotation.cooldown'), 'cooldownSeconds')}
          </div>
        </div>

        <div className="rotation-foot">
          <span className="muted small">{t('rotation.offHint')}</span>
          <span className="rotation-actions">
            {dirty && (
              <button type="button" className="btn btn-small" onClick={() => setEdits({})}>
                {t('config:shared.discard')}
              </button>
            )}
            <button type="submit" className="btn btn-small btn-primary" disabled={!dirty || mutation.isPending}>
              {t('config:shared.save')}
            </button>
          </span>
        </div>
      </form>
    </section>
  );
}
