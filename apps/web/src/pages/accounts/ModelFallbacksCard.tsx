import type { ModelFallback } from '@claudio/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Plus, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { ModelPicker } from '../../components/ModelPicker';
import { Tooltip } from '@claudio/ui/components/controls';
import { ICON_SM } from '@claudio/ui/components/icons';
import { useToast } from '@claudio/ui/components/Toast';
import { Card, Empty, ErrorBox } from '@claudio/ui/components/ui';

type Pair = Pick<ModelFallback, 'from' | 'to' | 'origin'>;

/**
 * The models a chat may continue on when no account with room can run its own. Nothing is applied
 * on its own: each pair is written here by the person, or accepted from the `account.model-fallback`
 * suggestion. Without one the chat waits.
 */
export function ModelFallbacksCard({ fallbacks }: { fallbacks: ModelFallback[] }) {
  const { t } = useTranslation(['accountsConfig', 'common']);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [suggested, setSuggested] = useState<{ from: string; to: string } | null>(null);
  const [noSuggestion, setNoSuggestion] = useState<string | null>(null);

  // The API replaces the whole list, so every change sends the rest with it
  const save = useMutation({
    mutationFn: (next: Pair[]) => api.putModelFallbacks({ fallbacks: next }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.modelFallbacks });
      toast.success(t('modelFallbacks.saved'));
    },
    onError: (err) => toast.error(t('modelFallbacks.saveFailed'), err),
  });
  const suggest = useMutation({
    mutationFn: (model: string) => api.suggestModelFallback(model),
    onSuccess: (result) => {
      setSuggested(result.suggestion ? { from: result.model, to: result.suggestion } : null);
      setNoSuggestion(result.suggestion ? null : result.model);
    },
    onError: (err) => toast.error(t('modelFallbacks.suggestFailed'), err),
  });

  const others = (model: string): Pair[] => fallbacks.filter((f) => f.from !== model).map(({ from: a, to: b, origin }) => ({ from: a, to: b, origin }));
  const withPair = (pair: { from: string; to: string }, origin: ModelFallback['origin']): Pair[] => [...others(pair.from), { ...pair, origin }];
  const canAdd = from !== '' && to !== '' && from !== to && !save.isPending;

  return (
    <Card title={t('modelFallbacks.title')}>
      <p className="muted small">{t('modelFallbacks.intro')}</p>
      <ErrorBox error={save.error} title={t('modelFallbacks.saveFailed')} />
      {fallbacks.length === 0 ? (
        <Empty title={t('modelFallbacks.none')}>{t('modelFallbacks.noneHint')}</Empty>
      ) : (
        <ul className="list">
          {fallbacks.map((fallback) => (
            <li key={fallback.from} className="list-row list-row-flow">
              <div className="list-row-main">
                <div className="strong break mono">
                  {fallback.from} <ArrowRight {...ICON_SM} aria-hidden /> {fallback.to}
                </div>
                <div className="muted small">{t(`modelFallbacks.origin.${fallback.origin}`)}</div>
              </div>
              <span className="row-actions">
                <Tooltip content={t('common:actions.remove')}>
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={save.isPending}
                    aria-label={t('modelFallbacks.remove', { from: fallback.from, to: fallback.to })}
                    onClick={() => save.mutate(others(fallback.from))}
                  >
                    <X {...ICON_SM} />
                  </button>
                </Tooltip>
              </span>
            </li>
          ))}
        </ul>
      )}

      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canAdd) return;
          save.mutate(withPair({ from, to }, 'user'));
          setFrom('');
          setTo('');
          setSuggested(null);
          setNoSuggestion(null);
        }}
      >
        <div className="field-label">{t('modelFallbacks.from')}</div>
        <ModelPicker
          value={from}
          onChange={(next) => {
            setFrom(next);
            setSuggested(null);
            setNoSuggestion(null);
          }}
          placeholder={t('modelFallbacks.pick')}
          aria-label={t('modelFallbacks.from')}
        />
        <div className="field-label">{t('modelFallbacks.to')}</div>
        <ModelPicker value={to} onChange={setTo} placeholder={t('modelFallbacks.pick')} aria-label={t('modelFallbacks.to')} />
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={!canAdd}>
            <Plus {...ICON_SM} /> {save.isPending ? t('modelFallbacks.saving') : t('modelFallbacks.add')}
          </button>
          <button type="button" className="btn" disabled={from === '' || suggest.isPending} onClick={() => suggest.mutate(from)}>
            <Sparkles {...ICON_SM} /> {suggest.isPending ? t('modelFallbacks.suggesting') : t('modelFallbacks.suggest')}
          </button>
        </div>
        <div role="status" className="small">
          {suggested && (
            <span className="meta-icon">
              <span>
                <Trans t={t} i18nKey="modelFallbacks.suggestion" values={suggested} components={{ mono: <span className="mono" /> }} />
              </span>
              <button
                type="button"
                className="btn btn-small"
                disabled={save.isPending}
                onClick={() => {
                  save.mutate(withPair(suggested, 'suggestion'));
                  setSuggested(null);
                }}
              >
                {t('modelFallbacks.accept')}
              </button>
            </span>
          )}
          {noSuggestion && <span className="muted">{t('modelFallbacks.noSuggestion', { model: noSuggestion })}</span>}
        </div>
      </form>
    </Card>
  );
}
