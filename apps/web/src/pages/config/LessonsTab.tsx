import type { Effort, LessonSettings, SettingDefault } from '@claudio/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys, useLessonSettings, useLessons } from '../../api';
import { EffortPicker } from '../../components/EffortPicker';
import { ModelPicker } from '../../components/ModelPicker';
import { NumberInput, Switch } from '@claudio/ui/components/controls';
import { useToast } from '@claudio/ui/components/Toast';
import { Card, Empty, ErrorBox, Field, Skeleton } from '@claudio/ui/components/ui';
import type { ReactNode } from 'react';
import { formatNumber } from '@claudio/ui/lib/format';
import { useDirty } from '../../lib/dirty';
import { LessonItems } from '../home/memory/Lessons';
import { ServerSettingChange, useDefaultWording } from './SettingChange';

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

type RangeLabel = `config:lessons.${'maxCost' | 'projectDaily' | 'globalDaily' | 'chatMinutes' | 'jobsDaily' | 'approveFloor' | 'deliverAt' | 'budget'}`;

/** The first number of a draft outside what the server accepts: its label's key and its range. */
export function lessonSettingsOutOfRange(draft: LessonSettings): { label: RangeLabel; min: number; max: number } | null {
  const checks: Array<[number, { min: number; max: number }, RangeLabel]> = [
    [draft.miner.maxCostUsd, LIMITS.maxCostUsd, 'config:lessons.maxCost'],
    [draft.caps.perProjectDailyUsd, LIMITS.projectDaily, 'config:lessons.projectDaily'],
    [draft.caps.globalDailyUsd, LIMITS.globalDaily, 'config:lessons.globalDaily'],
    [draft.caps.perChatMinMinutes, LIMITS.minutes, 'config:lessons.chatMinutes'],
    [draft.caps.perProjectDailyJobs, LIMITS.jobs, 'config:lessons.jobsDaily'],
    [draft.confidence.approveFloor, LIMITS.floor, 'config:lessons.approveFloor'],
    [draft.confidence.deliverAt, LIMITS.deliver, 'config:lessons.deliverAt'],
    [draft.delivery.handoffBytes, LIMITS.bytes, 'config:lessons.budget'],
  ];
  const found = checks.find(([value, limit]) => !(Number.isFinite(value) && value >= limit.min && value <= limit.max));
  return found ? { label: found[2], ...found[1] } : null;
}

/** Why a draft cannot be saved, as the key of the sentence that says it; null when it can */
export function lessonSettingsProblem(draft: LessonSettings): 'range' | 'order' | null {
  if (lessonSettingsOutOfRange(draft)) return 'range';
  // Decay must retire a lesson before it could be delivered again
  return draft.decay.retireBelow >= draft.confidence.deliverAt ? 'order' : null;
}

/** The active and retired lessons promoted out of a project: what the global lessons detail lists. */
export function useGlobalLessons() {
  const global = useLessons(null, 'all', true);
  const lessons = (global.data?.lessons ?? []).filter((lesson) => lesson.status === 'active' || lesson.status === 'retired');
  return { ...global, lessons };
}

/**
 * Settings → Instructions & memory → Global lessons (docs/plans/settings-ia.md §6.4): the lessons a
 * person promoted from a project, handed to every project that allows them.
 */
export function GlobalLessons() {
  const { t } = useTranslation(['config', 'home']);
  const global = useGlobalLessons();
  return (
    // The detail's title names the screen: the card only holds the list
    <Card>
      <p className="small muted">{t('config:lessons.globalHint')}</p>
      {global.isLoading ? (
        <Skeleton rows={3} height={16} />
      ) : global.error ? (
        <ErrorBox error={global.error} />
      ) : global.lessons.length === 0 ? (
        <Empty title={t('config:lessons.emptyTitle')} illustration="projects">
          {t('config:lessons.emptyBody')}
        </Empty>
      ) : (
        <LessonItems lessons={global.lessons} global />
      )}
    </Card>
  );
}

/** The document with the value at `path` replaced, the rest left as it is. */
export function withValueAt(settings: LessonSettings, path: readonly string[], value: unknown): LessonSettings {
  const put = (node: Record<string, unknown>, at: readonly string[]): Record<string, unknown> => {
    const [head, ...rest] = at;
    if (head === undefined) return node;
    const child = node[head];
    return { ...node, [head]: rest.length === 0 ? value : put(typeof child === 'object' && child !== null ? (child as Record<string, unknown>) : {}, rest) };
  };
  return put(settings as unknown as Record<string, unknown>, path) as unknown as LessonSettings;
}

/**
 * One setting of the document: its row carries the id settings search names (`lessons.<row>`), and
 * the "Changed · Reset" slot. A Reset puts the default into that field of the draft at once, so the
 * edits around it stay and a later Save does not write the old value back.
 */
function Row({
  id,
  label,
  path,
  onDefault,
  wording,
  children,
}: {
  id: string;
  label: string;
  path: readonly string[];
  onDefault: (path: readonly string[], value: SettingDefault) => void;
  wording?: (value: SettingDefault) => string;
  children: ReactNode;
}) {
  return (
    <div className="lessons-row" data-setting={`lessons.${id}`}>
      {children}
      <ServerSettingChange id={`lessons.${id}`} label={label} wording={wording} invalidate={[keys.lessonSettings]} onReset={(value) => onDefault(path, value)} />
    </div>
  );
}

/**
 * Settings → Instructions & memory → Lessons: the document that governs mining, decay and delivery,
 * as rows on the group's screen. It saves on its own, as the card did. Nothing here is live.
 */
export function LessonSettingsRows() {
  const { t } = useTranslation(['config', 'home']);
  const toast = useToast();
  const qc = useQueryClient();
  const settings = useLessonSettings();
  const [held, setDraft] = useState<LessonSettings | null>(null);
  // What the person is editing, or what is saved until they start
  const draft = held ?? settings.data ?? null;
  const dirty = draft !== null && settings.data !== undefined && JSON.stringify(draft) !== JSON.stringify(settings.data);
  useDirty('lessons-settings', dirty);
  const problem = draft ? lessonSettingsProblem(draft) : null;
  const outOfRange = draft && problem === 'range' ? lessonSettingsOutOfRange(draft) : null;

  const save = useMutation({
    mutationFn: (next: LessonSettings) => api.putLessonSettings(next),
    onSuccess: (saved) => {
      qc.setQueryData(keys.lessonSettings, saved);
      setDraft(saved);
      toast.success(t('config:lessons.saved'));
    },
    onError: (error) => toast.error(t('config:lessons.saveFailed'), error),
  });

  const set = (patch: (d: LessonSettings) => LessonSettings) => {
    if (draft) setDraft(patch(draft));
  };
  const num = (value: number | undefined, fallback: number) => value ?? fallback;
  const generic = useDefaultWording();
  const unsetEffort = (value: SettingDefault) => (value === null ? t('config:settings.changeSlot.automatic') : generic(value));
  // Only a draft being edited needs the default put in; with none, the rows read the refetched document
  const onDefault = (path: readonly string[], value: SettingDefault) => setDraft((held) => (held ? withValueAt(held, path, value) : held));

  return (
    <>
      {settings.isLoading && <Skeleton rows={11} height={18} />}
      <ErrorBox error={settings.error} />
      {draft && (
        <form
          className="lessons-settings"
          onSubmit={(event) => {
            event.preventDefault();
            if (!problem) save.mutate(draft);
          }}
        >
          <Row id="miner-model" label={t('config:lessons.model')} path={['miner', 'model']} onDefault={onDefault}>
            <Field label={t('config:lessons.model')} hint={t('config:lessons.modelHint')}>
              <ModelPicker value={draft.miner.model} onChange={(model) => set((d) => ({ ...d, miner: { ...d.miner, model } }))} aria-label={t('config:lessons.model')} />
            </Field>
          </Row>
          <Row id="miner-effort" label={t('config:lessons.effort')} path={['miner', 'effort']} onDefault={onDefault} wording={unsetEffort}>
            <Field label={t('config:lessons.effort')} hint={t('config:lessons.effortHint')}>
              <EffortPicker
                value={draft.miner.effort ?? ''}
                onChange={(effort: Effort | '') => set((d) => ({ ...d, miner: { ...d.miner, effort: effort === '' ? null : effort } }))}
                model={draft.miner.model}
                use="work"
                aria-label={t('config:lessons.effort')}
              />
            </Field>
          </Row>
          <Row id="max-cost" label={t('config:lessons.maxCost')} path={['miner', 'maxCostUsd']} onDefault={onDefault}>
            <Field label={t('config:lessons.maxCost')} hint={t('config:lessons.maxCostHint')}>
              <NumberInput decimal step={0.01} min={LIMITS.maxCostUsd.min} max={LIMITS.maxCostUsd.max} value={draft.miner.maxCostUsd} onChange={(v) => set((d) => ({ ...d, miner: { ...d.miner, maxCostUsd: num(v, 0) } }))} aria-label={t('config:lessons.maxCost')} />
            </Field>
          </Row>
          <Row id="project-daily" label={t('config:lessons.projectDaily')} path={['caps', 'perProjectDailyUsd']} onDefault={onDefault}>
            <Field label={t('config:lessons.projectDaily')} hint={t('config:lessons.projectDailyHint')}>
              <NumberInput decimal step={0.1} min={LIMITS.projectDaily.min} max={LIMITS.projectDaily.max} value={draft.caps.perProjectDailyUsd} onChange={(v) => set((d) => ({ ...d, caps: { ...d.caps, perProjectDailyUsd: num(v, 0) } }))} aria-label={t('config:lessons.projectDaily')} />
            </Field>
          </Row>
          <Row id="global-daily" label={t('config:lessons.globalDaily')} path={['caps', 'globalDailyUsd']} onDefault={onDefault}>
            <Field label={t('config:lessons.globalDaily')} hint={t('config:lessons.globalDailyHint')}>
              <NumberInput decimal step={0.1} min={LIMITS.globalDaily.min} max={LIMITS.globalDaily.max} value={draft.caps.globalDailyUsd} onChange={(v) => set((d) => ({ ...d, caps: { ...d.caps, globalDailyUsd: num(v, 0) } }))} aria-label={t('config:lessons.globalDaily')} />
            </Field>
          </Row>
          <Row id="chat-minutes" label={t('config:lessons.chatMinutes')} path={['caps', 'perChatMinMinutes']} onDefault={onDefault}>
            <Field label={t('config:lessons.chatMinutes')} hint={t('config:lessons.chatMinutesHint')}>
              <NumberInput min={LIMITS.minutes.min} max={LIMITS.minutes.max} value={draft.caps.perChatMinMinutes} onChange={(v) => set((d) => ({ ...d, caps: { ...d.caps, perChatMinMinutes: num(v, 0) } }))} aria-label={t('config:lessons.chatMinutes')} />
            </Field>
          </Row>
          <Row id="jobs-daily" label={t('config:lessons.jobsDaily')} path={['caps', 'perProjectDailyJobs']} onDefault={onDefault}>
            <Field label={t('config:lessons.jobsDaily')} hint={t('config:lessons.jobsDailyHint')}>
              <NumberInput min={LIMITS.jobs.min} max={LIMITS.jobs.max} value={draft.caps.perProjectDailyJobs} onChange={(v) => set((d) => ({ ...d, caps: { ...d.caps, perProjectDailyJobs: num(v, 0) } }))} aria-label={t('config:lessons.jobsDaily')} />
            </Field>
          </Row>
          <Row id="approve-floor" label={t('config:lessons.approveFloor')} path={['confidence', 'approveFloor']} onDefault={onDefault}>
            <Field label={t('config:lessons.approveFloor')} hint={t('config:lessons.approveFloorHint')}>
              <NumberInput decimal step={0.05} min={LIMITS.floor.min} max={LIMITS.floor.max} value={draft.confidence.approveFloor} onChange={(v) => set((d) => ({ ...d, confidence: { ...d.confidence, approveFloor: num(v, 0) } }))} aria-label={t('config:lessons.approveFloor')} />
            </Field>
          </Row>
          <Row id="deliver-at" label={t('config:lessons.deliverAt')} path={['confidence', 'deliverAt']} onDefault={onDefault}>
            <Field label={t('config:lessons.deliverAt')} hint={t('config:lessons.deliverAtHint')}>
              <NumberInput decimal step={0.05} min={LIMITS.deliver.min} max={LIMITS.deliver.max} value={draft.confidence.deliverAt} onChange={(v) => set((d) => ({ ...d, confidence: { ...d.confidence, deliverAt: num(v, 0) } }))} aria-label={t('config:lessons.deliverAt')} />
            </Field>
          </Row>
          <Row id="budget" label={t('config:lessons.budget')} path={['delivery', 'handoffBytes']} onDefault={onDefault}>
            <Field label={t('config:lessons.budget')} hint={t('config:lessons.budgetHint')}>
              <NumberInput step={256} min={LIMITS.bytes.min} max={LIMITS.bytes.max} value={draft.delivery.handoffBytes} onChange={(v) => set((d) => ({ ...d, delivery: { ...d.delivery, handoffBytes: num(v, 0) } }))} aria-label={t('config:lessons.budget')} />
            </Field>
          </Row>
          <div className="lessons-switches">
            <Row id="loose-chats" label={t('config:lessons.looseChats')} path={['delivery', 'looseChats']} onDefault={onDefault}>
              <Switch checked={draft.delivery.looseChats} onChange={(looseChats) => set((d) => ({ ...d, delivery: { ...d.delivery, looseChats } }))}>
                {t('config:lessons.looseChats')}
              </Switch>
            </Row>
            <Row id="repeated-errors" label={t('config:lessons.repeatedErrors')} path={['signals', 'repeatedErrorsTrigger']} onDefault={onDefault}>
              <Switch checked={draft.signals.repeatedErrorsTrigger} onChange={(repeatedErrorsTrigger) => set((d) => ({ ...d, signals: { ...d.signals, repeatedErrorsTrigger } }))}>
                {t('config:lessons.repeatedErrors')}
              </Switch>
            </Row>
            <Row id="manual-mining" label={t('config:lessons.manualMining')} path={['manualMining']} onDefault={onDefault}>
              <Switch checked={draft.manualMining} onChange={(manualMining) => set((d) => ({ ...d, manualMining }))}>
                {t('config:lessons.manualMining')}
              </Switch>
            </Row>
          </div>
          <p className="small muted">
            {t('config:lessons.decay', {
              grace: draft.decay.graceDays,
              period: draft.decay.periodDays,
              step: draft.decay.step,
              below: draft.decay.retireBelow,
            })}
          </p>
          {/* Always there, so a message appearing pushes nothing down; it names the setting to fix */}
          <p className="field-error lessons-problem" role="alert">
            {outOfRange
              ? t('config:lessons.problem.field', { field: t(outOfRange.label), min: formatNumber(outOfRange.min), max: formatNumber(outOfRange.max) })
              : problem
                ? t(`config:lessons.problem.${problem}`)
                : null}
          </p>
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
    </>
  );
}
