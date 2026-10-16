import type { Effort, LessonSettings } from '@claudio/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys, useLessonSettings, useLessons } from '../../api';
import { EffortPicker } from '../../components/EffortPicker';
import { ModelPicker } from '../../components/ModelPicker';
import { NumberInput, Switch } from '@claudio/ui/components/controls';
import { useToast } from '@claudio/ui/components/Toast';
import { Card, Empty, ErrorBox, Field, Skeleton } from '@claudio/ui/components/ui';
import { useDirty } from '../../lib/dirty';
import { LessonItems } from '../home/memory/Lessons';

/** What the settings accept, mirrored from the server so a bad number is said before saving */
const LIMITS = {
  maxCostUsd: { min: 0.01, max: 1 },
  projectDaily: { min: 0, max: 100 },
  globalDaily: { min: 0, max: 1000 },
  floor: { min: 0.3, max: 0.95 },
  deliver: { min: 0.3, max: 0.9 },
  bytes: { min: 512, max: 4096 },
  minutes: { min: 0, max: 1440 },
  jobs: { min: 0, max: 1000 },
} as const;

/** Why a draft cannot be saved, as the key of the sentence that says it; null when it can */
export function lessonSettingsProblem(draft: LessonSettings): 'range' | 'order' | null {
  const inRange = (value: number, limit: { min: number; max: number }) => Number.isFinite(value) && value >= limit.min && value <= limit.max;
  const { miner, caps, confidence, delivery } = draft;
  if (
    !inRange(miner.maxCostUsd, LIMITS.maxCostUsd) ||
    !inRange(caps.perProjectDailyUsd, LIMITS.projectDaily) ||
    !inRange(caps.globalDailyUsd, LIMITS.globalDaily) ||
    !inRange(caps.perChatMinMinutes, LIMITS.minutes) ||
    !inRange(caps.perProjectDailyJobs, LIMITS.jobs) ||
    !inRange(confidence.approveFloor, LIMITS.floor) ||
    !inRange(confidence.deliverAt, LIMITS.deliver) ||
    !inRange(delivery.handoffBytes, LIMITS.bytes)
  )
    return 'range';
  // Decay must retire a lesson before it could be delivered again
  return draft.decay.retireBelow >= confidence.deliverAt ? 'order' : null;
}

/**
 * Settings → Lessons: the global lessons (promoted by a person, handed to every project that allows
 * them) and the document that governs mining, decay and delivery. Nothing here is live.
 */
export function LessonsTab() {
  const { t } = useTranslation(['config', 'home']);
  const toast = useToast();
  const qc = useQueryClient();
  const settings = useLessonSettings();
  const global = useLessons(null, 'all', true);
  const [held, setDraft] = useState<LessonSettings | null>(null);
  // What the person is editing, or what is saved until they start
  const draft = held ?? settings.data ?? null;
  const dirty = draft !== null && settings.data !== undefined && JSON.stringify(draft) !== JSON.stringify(settings.data);
  useDirty('lessons-settings', dirty);
  const problem = draft ? lessonSettingsProblem(draft) : null;

  const save = useMutation({
    mutationFn: (next: LessonSettings) => api.putLessonSettings(next),
    onSuccess: (saved) => {
      qc.setQueryData(keys.lessonSettings, saved);
      setDraft(saved);
      toast.success(t('config:lessons.saved'));
    },
    onError: (error) => toast.error(t('config:lessons.saveFailed'), error),
  });

  const lessons = (global.data?.lessons ?? []).filter((lesson) => lesson.status === 'active' || lesson.status === 'retired');
  const set = (patch: (d: LessonSettings) => LessonSettings) => {
    if (draft) setDraft(patch(draft));
  };
  const num = (value: number | undefined, fallback: number) => value ?? fallback;

  return (
    <>
      <Card title={t('config:lessons.globalTitle')}>
        <p className="small muted">{t('config:lessons.globalHint')}</p>
        {global.isLoading ? (
          <Skeleton rows={3} height={16} />
        ) : global.error ? (
          <ErrorBox error={global.error} />
        ) : lessons.length === 0 ? (
          <Empty title={t('config:lessons.emptyTitle')} illustration="projects">
            {t('config:lessons.emptyBody')}
          </Empty>
        ) : (
          <LessonItems lessons={lessons} global />
        )}
      </Card>

      <Card title={t('config:lessons.settingsTitle')}>
        {settings.isLoading && <Skeleton rows={5} height={18} />}
        <ErrorBox error={settings.error} />
        {draft && (
          <form
            className="lessons-settings"
            onSubmit={(event) => {
              event.preventDefault();
              if (!problem) save.mutate(draft);
            }}
          >
            <Field label={t('config:lessons.model')} hint={t('config:lessons.modelHint')}>
              <ModelPicker value={draft.miner.model} onChange={(model) => set((d) => ({ ...d, miner: { ...d.miner, model } }))} aria-label={t('config:lessons.model')} />
            </Field>
            <Field label={t('config:lessons.effort')}>
              <EffortPicker
                value={draft.miner.effort ?? ''}
                onChange={(effort: Effort | '') => set((d) => ({ ...d, miner: { ...d.miner, effort: effort === '' ? null : effort } }))}
                model={draft.miner.model}
                use="work"
                aria-label={t('config:lessons.effort')}
              />
            </Field>
            <Field label={t('config:lessons.maxCost')} hint={t('config:lessons.maxCostHint')}>
              <NumberInput decimal step={0.01} min={LIMITS.maxCostUsd.min} max={LIMITS.maxCostUsd.max} value={draft.miner.maxCostUsd} onChange={(v) => set((d) => ({ ...d, miner: { ...d.miner, maxCostUsd: num(v, 0) } }))} aria-label={t('config:lessons.maxCost')} />
            </Field>
            <Field label={t('config:lessons.projectDaily')}>
              <NumberInput decimal step={0.1} min={LIMITS.projectDaily.min} max={LIMITS.projectDaily.max} value={draft.caps.perProjectDailyUsd} onChange={(v) => set((d) => ({ ...d, caps: { ...d.caps, perProjectDailyUsd: num(v, 0) } }))} aria-label={t('config:lessons.projectDaily')} />
            </Field>
            <Field label={t('config:lessons.globalDaily')}>
              <NumberInput decimal step={0.1} min={LIMITS.globalDaily.min} max={LIMITS.globalDaily.max} value={draft.caps.globalDailyUsd} onChange={(v) => set((d) => ({ ...d, caps: { ...d.caps, globalDailyUsd: num(v, 0) } }))} aria-label={t('config:lessons.globalDaily')} />
            </Field>
            <Field label={t('config:lessons.chatMinutes')} hint={t('config:lessons.chatMinutesHint')}>
              <NumberInput min={LIMITS.minutes.min} max={LIMITS.minutes.max} value={draft.caps.perChatMinMinutes} onChange={(v) => set((d) => ({ ...d, caps: { ...d.caps, perChatMinMinutes: num(v, 0) } }))} aria-label={t('config:lessons.chatMinutes')} />
            </Field>
            <Field label={t('config:lessons.jobsDaily')}>
              <NumberInput min={LIMITS.jobs.min} max={LIMITS.jobs.max} value={draft.caps.perProjectDailyJobs} onChange={(v) => set((d) => ({ ...d, caps: { ...d.caps, perProjectDailyJobs: num(v, 0) } }))} aria-label={t('config:lessons.jobsDaily')} />
            </Field>
            <Field label={t('config:lessons.approveFloor')} hint={t('config:lessons.approveFloorHint')}>
              <NumberInput decimal step={0.05} min={LIMITS.floor.min} max={LIMITS.floor.max} value={draft.confidence.approveFloor} onChange={(v) => set((d) => ({ ...d, confidence: { ...d.confidence, approveFloor: num(v, 0) } }))} aria-label={t('config:lessons.approveFloor')} />
            </Field>
            <Field label={t('config:lessons.deliverAt')} hint={t('config:lessons.deliverAtHint')}>
              <NumberInput decimal step={0.05} min={LIMITS.deliver.min} max={LIMITS.deliver.max} value={draft.confidence.deliverAt} onChange={(v) => set((d) => ({ ...d, confidence: { ...d.confidence, deliverAt: num(v, 0) } }))} aria-label={t('config:lessons.deliverAt')} />
            </Field>
            <Field label={t('config:lessons.budget')} hint={t('config:lessons.budgetHint')}>
              <NumberInput step={256} min={LIMITS.bytes.min} max={LIMITS.bytes.max} value={draft.delivery.handoffBytes} onChange={(v) => set((d) => ({ ...d, delivery: { ...d.delivery, handoffBytes: num(v, 0) } }))} aria-label={t('config:lessons.budget')} />
            </Field>
            <div className="lessons-switches">
              <Switch checked={draft.delivery.looseChats} onChange={(looseChats) => set((d) => ({ ...d, delivery: { ...d.delivery, looseChats } }))}>
                {t('config:lessons.looseChats')}
              </Switch>
              <Switch checked={draft.signals.repeatedErrorsTrigger} onChange={(repeatedErrorsTrigger) => set((d) => ({ ...d, signals: { ...d.signals, repeatedErrorsTrigger } }))}>
                {t('config:lessons.repeatedErrors')}
              </Switch>
              <Switch checked={draft.manualMining} onChange={(manualMining) => set((d) => ({ ...d, manualMining }))}>
                {t('config:lessons.manualMining')}
              </Switch>
            </div>
            <p className="small muted">
              {t('config:lessons.decay', {
                grace: draft.decay.graceDays,
                period: draft.decay.periodDays,
                step: draft.decay.step,
                below: draft.decay.retireBelow,
              })}
            </p>
            {problem && (
              <p className="field-error" role="alert">
                {t(`config:lessons.problem.${problem}`)}
              </p>
            )}
            <div className="lessons-settings-actions">
              <button type="button" className="btn btn-quiet" disabled={!dirty || save.isPending} onClick={() => setDraft(settings.data ?? null)}>
                {t('config:lessons.discard')}
              </button>
              <button type="submit" className="btn btn-primary" disabled={!dirty || save.isPending || problem !== null}>
                {t('config:lessons.save')}
              </button>
            </div>
          </form>
        )}
      </Card>
    </>
  );
}
