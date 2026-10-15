import type { AccountsSettings } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { NumberInput, Slider, Switch } from '@agentry/ui/components/controls';
import { useToast } from '@agentry/ui/components/Toast';
import { Segmented } from '@agentry/ui/components/ui';

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
  const [draft, setDraft] = useState(settings);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  const mutation = useMutation({
    mutationFn: (next: Partial<AccountsSettings>) => api.putAccountsSettings(next),
    onSuccess: (saved) => {
      setDraft(saved);
      toast.success(t('rotation.updated'));
      void queryClient.invalidateQueries({ queryKey: keys.accountsSettings });
    },
    onError: (err) => toast.error(t('rotation.updateFailed'), err),
  });

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
          <Switch checked={draft.rotateOnLimit} onChange={(rotateOnLimit) => setDraft({ ...draft, rotateOnLimit })} tooltip={t('rotation.rotateHint')}>
            {t('rotation.rotateOnLimit')}
          </Switch>
        </div>

        <div className="rotation-grid">
          <div className="rotation-field">
            <span className="section-label">{t('rotation.threshold')}</span>
            <Slider aria-label={t('rotation.threshold')} min={50} max={99} value={draft.threshold} onChange={(threshold) => setDraft({ ...draft, threshold })} />
            <span className="field-hint">{t('rotation.thresholdAt', { pct: draft.threshold })}</span>
          </div>
          <div className="rotation-field">
            <span className="section-label">{t('rotation.strategy')}</span>
            <Segmented<AccountsSettings['strategy']>
              label={t('rotation.strategy')}
              value={draft.strategy}
              onChange={(strategy) => setDraft({ ...draft, strategy })}
              options={STRATEGIES.map((s) => ({ value: s, label: t(`rotation.strategies.${s}`) }))}
            />
          </div>
          {/* Not a <label>: the stepper's own buttons would take its name */}
          <div className="rotation-field">
            <span className="section-label">{t('rotation.hysteresis')}</span>
            <NumberInput
              aria-label={t('rotation.hysteresis')}
              min={0}
              max={50}
              step={1}
              value={draft.hysteresis}
              onChange={(hysteresis) => setDraft({ ...draft, hysteresis: hysteresis ?? 0 })}
            />
            <span className="field-hint">{t('rotation.hysteresisHint')}</span>
          </div>
          <div className="rotation-field">
            <span className="section-label">{t('rotation.cooldown')}</span>
            <NumberInput
              aria-label={t('rotation.cooldown')}
              min={0}
              max={86_400}
              step={60}
              value={draft.cooldownSeconds}
              onChange={(cooldownSeconds) => setDraft({ ...draft, cooldownSeconds: cooldownSeconds ?? 0 })}
            />
            <span className="field-hint">{t('rotation.cooldownHint')}</span>
          </div>
        </div>

        <div className="rotation-foot">
          <span className="muted small">{t('rotation.offHint')}</span>
          <span className="rotation-actions">
            {dirty && (
              <button type="button" className="btn btn-small" onClick={() => setDraft(settings)}>
                {t('config:shared.reset')}
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
