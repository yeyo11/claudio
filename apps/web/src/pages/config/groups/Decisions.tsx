import type { DecisionMode, DecisionPointId, DecisionPointInfo, DecisionPointStats, DecisionSettings, DecisionSettingsUpdate } from '@claudio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useSearchParams } from 'react-router-dom';
import { api, keys } from '../../../api';
import { ICON_SM } from '@claudio/ui/components/icons';
import { useToast } from '@claudio/ui/components/Toast';
import { ErrorBox, Skeleton } from '@claudio/ui/components/ui';
import { useDirty } from '../../../lib/dirty';
import { BulkConsentDialog } from '../decisions/BulkConsentDialog';
import { ConsentDialog, ExamplePayloadDialog } from '../decisions/ConsentDialog';
import { DecisionHistory } from '../decisions/DecisionHistory';
import { ADVANCED_SETTINGS, capValid, EngineSection, MAX_HISTORY_DAYS } from '../decisions/Engine';
import { type BulkPlan, THRESHOLD_MIN, draftOf, examplePoint, needsConsent, planBulk, pointOf, sameDraft, withSettingFrom } from '../decisions/model';
import { type BulkNote, PointsSection, pointName } from '../decisions/Points';
import { settingsHref } from '../settingsGroups';
import { DECISION_POINTS, pointAnchor } from '../settingsIndex';
import { SettingsDetailRow, SettingsSection, type GroupScreenProps } from './Section';

/**
 * Settings → Decisions (docs/plans/settings-ia.md §7): who answers, the cap per decision, Advanced,
 * and every decision point as evidence, the Supervisor among them. History is a detail of its own.
 */
export function Decisions({ detail }: GroupScreenProps<'decisions'>) {
  return detail === 'history' ? <HistoryDetail /> : <DecisionsScreen />;
}

/** What the address points at: `#point-…`, or the row a search result or the palette opened. */
function useAddressed(): string | null {
  const location = useLocation();
  const state: unknown = location.state;
  const setting = typeof state === 'object' && state !== null && typeof (state as { setting?: unknown }).setting === 'string' ? (state as { setting: string }).setting : null;
  return setting ?? (decodeURIComponent(location.hash.replace(/^#/, '')) || null);
}

function DecisionsScreen() {
  const settings = useQuery({ queryKey: keys.decisionSettings, queryFn: () => api.decisionSettings() });
  const points = useQuery({ queryKey: keys.decisionPoints, queryFn: () => api.decisionPoints() });
  return (
    <div className="settings-group dp-screen">
      <ErrorBox error={settings.error ?? points.error} />
      {!settings.data || !points.data ? <Skeleton rows={8} /> : <DecisionsForm saved={settings.data} catalogue={points.data} />}
    </div>
  );
}

function DecisionsForm({ saved, catalogue }: { saved: DecisionSettings; catalogue: DecisionPointInfo[] }) {
  const { t } = useTranslation('decisions');
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState(() => draftOf(saved));
  const base = useMemo(() => draftOf(saved), [saved]);
  const dirty = !sameDraft(draft, base);
  useDirty('decisions', dirty);

  // A consent or a key saved elsewhere on the page replaces `saved`, but must not undo what is being edited
  const previous = useRef(base);
  useEffect(() => {
    const before = previous.current;
    previous.current = base;
    if (before !== base) setDraft((current) => (sameDraft(current, before) ? base : current));
  }, [base]);

  // One window for every number on the screen: the evidence and the cap's volume read the same history
  const stats = useQuery({ queryKey: keys.decisionStats(saved.historyDays), queryFn: () => api.decisionStats(saved.historyDays) });
  const statsOf = useMemo(
    () => (stats.data ? new Map<DecisionPointId, DecisionPointStats>(stats.data.points.map((row) => [row.point, row])) : null),
    [stats.data],
  );
  const decisions = stats.data ? stats.data.points.reduce((sum, row) => sum + row.count, 0) : null;

  // The address may name a point (its area opens) or a row of Advanced (it unfolds)
  const addressed = useAddressed();
  const focus = addressed ? (DECISION_POINTS.find((id) => pointAnchor(id) === addressed) ?? null) : null;
  const [advancedOpen, setAdvancedOpen] = useState(() => addressed !== null && ADVANCED_SETTINGS.includes(addressed));
  useEffect(() => {
    if (addressed !== null && ADVANCED_SETTINGS.includes(addressed)) setAdvancedOpen(true);
  }, [addressed]);

  // A point leaving `off` without consent for what it sends now waits here for the person to see it
  const [asking, setAsking] = useState<{ id: DecisionPointId; mode: Exclude<DecisionMode, 'off'> } | null>(null);
  const setMode = (id: DecisionPointId, mode: DecisionMode) =>
    setDraft((current) => ({ ...current, points: { ...current.points, [id]: { ...pointOf(current, catalogue, id), mode } } }));
  const onMode = (id: DecisionPointId, mode: DecisionMode) => {
    const info = catalogue.find((point) => point.id === id);
    if (mode !== 'off' && info && needsConsent(info, saved.points[id]?.consent ?? null, draft.provider)) setAsking({ id, mode });
    else setMode(id, mode);
  };

  // Setting many points at once: what it did is said under the control until the next change
  const [bulkAsking, setBulkAsking] = useState<{ plan: BulkPlan; mode: DecisionMode } | null>(null);
  const [bulkNote, setBulkNote] = useState<BulkNote | null>(null);
  const applyPlan = (plan: BulkPlan, mode: DecisionMode) => {
    setDraft((current) => {
      const points = { ...current.points };
      for (const change of plan.changes) points[change.id] = { ...pointOf(current, catalogue, change.id), mode: change.mode };
      return { ...current, points };
    });
    // A point kept at shadow counts once, as kept: it is neither "set" to the asked mode nor merely "already there"
    const kept = new Set(plan.capped);
    setBulkNote({
      mode,
      set: plan.changes.filter((change) => change.mode === mode).length,
      unchanged: plan.unchanged.filter((id) => !kept.has(id)).length,
      kept: kept.size,
      keptMode: 'shadow',
    });
  };
  const onBulk = (ids: readonly DecisionPointId[], mode: DecisionMode) => {
    const plan = planBulk(catalogue, ids, mode, (id) => draft.points[id]?.mode ?? 'off', (id) => saved.points[id]?.consent ?? null, draft.provider);
    if (plan.needConsent.length > 0) setBulkAsking({ plan, mode });
    else applyPlan(plan, mode);
  };
  const askedInfo = asking ? catalogue.find((point) => point.id === asking.id) : undefined;

  // "See an example payload": the first consented point's state, or the Supervisor's when none is
  const [example, setExample] = useState<DecisionPointInfo | null>(null);
  const showExample = () => {
    const order = [...DECISION_POINTS, ...catalogue.map((info) => info.id)];
    const id = examplePoint(order, (point) => Boolean(saved.points[point]?.consent));
    setExample(catalogue.find((info) => info.id === id) ?? null);
  };

  // A row reset on the server: its field in the draft becomes what the saved document now holds
  const onReset = (setting: string) => {
    const fresh = queryClient.getQueryData<DecisionSettings>(keys.decisionSettings);
    if (fresh) setDraft((current) => withSettingFrom(current, draftOf(fresh), setting));
  };

  const patch = (next: Partial<typeof draft>) => setDraft((current) => ({ ...current, ...next }));

  const costValid = capValid(draft.cli.maxCostUsd);
  const supervisorCostValid = capValid(draft.cli.supervisorMaxCostUsd);
  const daysValid = Number.isInteger(draft.historyDays) && draft.historyDays >= 1 && draft.historyDays <= MAX_HISTORY_DAYS;
  const valid = draft.cli.model.trim() !== '' && costValid && supervisorCostValid && daysValid;

  const save = useMutation({
    mutationFn: () => {
      // Consent is not part of the document the server accepts as a change, but it is part of its shape
      const ids = new Set<DecisionPointId>([...(Object.keys(saved.points) as DecisionPointId[]), ...(Object.keys(draft.points) as DecisionPointId[])]);
      const body: DecisionSettingsUpdate = {
        provider: draft.provider,
        cli: { ...draft.cli, model: draft.cli.model.trim() },
        historyDays: draft.historyDays,
        points: Object.fromEntries(
          [...ids].map((id) => {
            const point = draft.points[id] ?? { mode: 'off' as const, threshold: catalogue.find((p) => p.id === id)?.defaultThreshold ?? THRESHOLD_MIN };
            return [id, { ...point, consent: saved.points[id]?.consent ?? null }];
          }),
        ),
      };
      return api.putDecisionSettings(body);
    },
    onSuccess: (next) => {
      queryClient.setQueryData(keys.decisionSettings, next);
      void queryClient.invalidateQueries({ queryKey: keys.decisionPoints });
      toast.success(t('engine.saved'));
    },
  });

  return (
    <>
      <SettingsSection id="engine" title={t('whoAnswers')}>
        <EngineSection
          saved={saved}
          draft={draft}
          patch={patch}
          costValid={costValid}
          supervisorCostValid={supervisorCostValid}
          daysValid={daysValid}
          decisions={decisions}
          advancedOpen={advancedOpen}
          onAdvanced={setAdvancedOpen}
          onExample={showExample}
          onReset={onReset}
        />
      </SettingsSection>
      <SettingsSection id="points" title={t('points.title')}>
        <PointsSection
          catalogue={catalogue}
          settings={saved}
          draft={draft}
          stats={statsOf}
          focus={focus}
          onMode={onMode}
          onBulk={onBulk}
          onReviewConsent={(id, mode) => setAsking({ id, mode })}
          onReset={onReset}
          bulkNote={bulkNote}
          onThreshold={(id, threshold) => setDraft((current) => ({ ...current, points: { ...current.points, [id]: { ...pointOf(current, catalogue, id), threshold } } }))}
        />
        <SettingsDetailRow to={settingsHref('decisions', { detail: 'history' })} label={t('allHistory')} setting="points.history" />
      </SettingsSection>
      {asking && askedInfo && (
        <ConsentDialog
          info={askedInfo}
          name={pointName(t, askedInfo.id)}
          provider={draft.provider}
          mode={asking.mode}
          consent={saved.points[asking.id]?.consent ?? null}
          onClose={() => setAsking(null)}
          onGranted={() => {
            setMode(asking.id, asking.mode);
            setAsking(null);
          }}
        />
      )}
      {bulkAsking && (
        <BulkConsentDialog
          provider={draft.provider}
          items={bulkAsking.plan.needConsent.flatMap(({ id, mode }) => {
            const info = catalogue.find((point) => point.id === id);
            return info ? [{ info, mode, name: pointName(t, id), consent: saved.points[id]?.consent ?? null }] : [];
          })}
          onClose={() => setBulkAsking(null)}
          onGranted={() => {
            applyPlan(bulkAsking.plan, bulkAsking.mode);
            setBulkAsking(null);
          }}
        />
      )}
      {example && <ExamplePayloadDialog info={example} name={pointName(t, example.id)} onClose={() => setExample(null)} />}
      {(dirty || save.isPending) && (
        <div className="dp-foot card" role="group" aria-label={t('engine.save')}>
          <ErrorBox error={save.error} />
          <button type="button" className="btn btn-primary dp-save" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
            <Save {...ICON_SM} />
            {/* Both labels take the room, the hidden one too, so "Saving…" does not move the bar */}
            <span className="dp-save-label">
              <span aria-hidden={save.isPending}>{t('engine.save')}</span>
              <span aria-hidden={!save.isPending}>{t('engine.saving')}</span>
            </span>
          </button>
          <button type="button" className="btn" disabled={save.isPending} onClick={() => setDraft(base)}>
            {t('engine.discard')}
          </button>
        </div>
      )}
    </>
  );
}

/** Every decision (`/settings/decisions/history`), filtered by `?point=` when a point's evidence opened it. */
function HistoryDetail() {
  const settings = useQuery({ queryKey: keys.decisionSettings, queryFn: () => api.decisionSettings() });
  const points = useQuery({ queryKey: keys.decisionPoints, queryFn: () => api.decisionPoints() });
  const [params, setParams] = useSearchParams();
  const catalogue = points.data ?? [];
  const asked = params.get('point');
  // An id the catalogue does not hold (a stale link) filters nothing rather than showing an empty list
  const point = asked && (points.data ? catalogue.some((info) => info.id === asked) : DECISION_POINTS.includes(asked as DecisionPointId)) ? (asked as DecisionPointId) : null;
  return (
    <div className="settings-group dp-screen">
      <ErrorBox error={settings.error ?? points.error} />
      <DecisionHistory
        catalogue={catalogue}
        days={settings.data?.historyDays ?? null}
        point={point}
        onPoint={(next) =>
          setParams(
            (current) => {
              const out = new URLSearchParams(current);
              if (next) out.set('point', next);
              else out.delete('point');
              return out;
            },
            { replace: true },
          )
        }
      />
    </div>
  );
}
