import type { DecisionMode, DecisionPointId, DecisionPointInfo, DecisionPointStats, DecisionProviderId, DecisionSettings } from '@claudio/shared';
import { FullText } from '@claudio/ui/components/FullText';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys } from '../../../api';
import { Slider } from '@claudio/ui/components/controls';
import { useToast } from '@claudio/ui/components/Toast';
import { ErrorBox, Segmented } from '@claudio/ui/components/ui';
import { formatDate, formatNumber, formatPercent } from '@claudio/ui/lib/format';
import { settingsHref } from '../settingsGroups';
import { pointAnchor } from '../settingsIndex';
import { BulkMode } from './BulkMode';
import {
  AREAS,
  MODES,
  POINT_KEY,
  SUPERVISOR_POINT,
  THRESHOLD_MAX,
  THRESHOLD_MIN,
  activeBlocked,
  areaOf,
  evidenceOf,
  groupSummary,
  isLimited,
  needsConsent,
  supervisorMeaning,
  type AreaId,
  type Draft,
} from './model';

export interface BulkNote {
  mode: DecisionMode;
  set: number;
  unchanged: number;
  kept: number;
  keptMode: DecisionMode;
}

const OPEN_GROUPS_KEY = 'claudio-decision-groups-open';

function readOpenGroups(): ReadonlySet<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(OPEN_GROUPS_KEY) ?? '[]');
    return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    // no storage, or not ours: every group starts folded
    return new Set();
  }
}

function writeOpenGroups(open: ReadonlySet<string>): void {
  try {
    localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify([...open]));
  } catch {
    // not persisted; still applied for this visit
  }
}

export const pointName = (t: (key: string, options: { defaultValue: string }) => string, id: DecisionPointId) =>
  t(`points.names.${POINT_KEY[id] ?? id}`, { defaultValue: id });

/**
 * The decision points by area (§7.1), each a row of evidence: what it decided, how often it agreed
 * with you and where it did not, so moving a point up a mode rests on data. Areas fold, and the ones
 * a person left open stay open; the area of a point the address names opens on its own.
 */
export function PointsSection({
  catalogue,
  settings,
  draft,
  stats,
  focus,
  onMode,
  onBulk,
  bulkNote,
  onThreshold,
}: {
  catalogue: DecisionPointInfo[];
  settings: DecisionSettings;
  draft: Draft;
  stats: ReadonlyMap<DecisionPointId, DecisionPointStats> | null;
  /** The point `#point-…` or a search result named */
  focus: DecisionPointId | null;
  onMode: (id: DecisionPointId, mode: DecisionMode) => void;
  onBulk: (ids: readonly DecisionPointId[], mode: DecisionMode) => void;
  bulkNote: BulkNote | null;
  onThreshold: (id: DecisionPointId, threshold: number) => void;
}) {
  const { t } = useTranslation('decisions');
  const queryClient = useQueryClient();
  const toast = useToast();
  // Consent is withdrawn from the row: it is a setting of its own, saved at once, apart from the form
  const withdraw = useMutation({
    mutationFn: (info: DecisionPointInfo) => api.putDecisionConsent(info.id, { granted: false, stateVersion: info.stateVersion, providers: [] }),
    onSuccess: (next) => {
      queryClient.setQueryData(keys.decisionSettings, next);
      toast.success(t('consent.withdrawn'));
    },
  });
  const [open, setOpen] = useState<ReadonlySet<string>>(readOpenGroups);
  const setGroups = (next: ReadonlySet<string>) => {
    setOpen(next);
    writeOpenGroups(next);
  };
  const toggle = (id: string) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setGroups(next);
  };
  // Opened for this visit only: the area someone else's link pointed at is not one they chose to keep open
  useEffect(() => {
    if (!focus) return;
    const area = areaOf(focus) ?? 'other';
    setOpen((current) => (current.has(area) ? current : new Set([...current, area])));
  }, [focus]);

  const modeOf = (id: DecisionPointId): DecisionMode => draft.points[id]?.mode ?? 'off';
  const byId = new Map(catalogue.map((info) => [info.id, info]));
  // A point the catalogue has and no area lists (a newer server) still shows, last, rather than vanishing
  const listed = new Set(AREAS.flatMap((area) => area.points));
  const extra = catalogue.filter((info) => !listed.has(info.id)).map((info) => info.id);
  const groups: Array<{ id: AreaId | 'other'; points: readonly DecisionPointId[] }> = [
    ...AREAS.map((area) => ({ id: area.id as AreaId | 'other', points: area.points.filter((id) => byId.has(id)) })),
    { id: 'other' as const, points: extra },
  ].filter((group) => group.points.length > 0);
  const allOpen = groups.length > 0 && groups.every((group) => open.has(group.id));

  if (groups.length === 0) return <p className="dp-field-line">{t('points.none')}</p>;

  return (
    <>
      <div className="dp-bulk-bar">
        <span className="dp-field-line tnum">{t('points.count', { points: formatNumber(catalogue.length), groups: formatNumber(groups.length) })}</span>
        <BulkMode scope={t('bulk.allScope')} onApply={(mode) => onBulk(catalogue.map((info) => info.id), mode)} />
        <button type="button" className="btn btn-ghost btn-small dp-toggle-all" onClick={() => setGroups(allOpen ? new Set() : new Set(groups.map((group) => group.id)))}>
          {allOpen ? t('points.collapseAll') : t('points.expandAll')}
        </button>
        {bulkNote && (
          <p className="dp-bulk-note dp-field-line" role="status">
            {t('bulk.result', { count: bulkNote.set, mode: t(`points.modes.${bulkNote.mode}`) })}
            {bulkNote.unchanged > 0 && ` ${t('bulk.unchanged', { count: bulkNote.unchanged })}`}
            {bulkNote.kept > 0 && ` ${t('bulk.kept', { count: bulkNote.kept, mode: t(`points.modes.${bulkNote.keptMode}`) })}`}
            {` ${t('bulk.saveHint')}`}
          </p>
        )}
      </div>
      <ErrorBox error={withdraw.error} />
      <div className="dp-areas">
        {groups.map((group) => {
          const isOpen = open.has(group.id);
          return (
            <div key={group.id} className="dp-area" role="group" aria-label={t(`points.areas.${group.id}`)}>
              <div className="dp-area-head">
                <button type="button" className="dp-area-toggle" aria-expanded={isOpen} aria-controls={`dp-area-${group.id}`} onClick={() => toggle(group.id)}>
                  <ChevronRight size={14} strokeWidth={2} className="dp-area-chevron" aria-hidden />
                  <span className="dp-area-name">{t(`points.areas.${group.id}`)}</span>
                  <FullText className="dp-area-summary">{groupSummary(group.points.map(modeOf), (mode, count) => t(`points.summary.${mode}`, { count }))}</FullText>
                </button>
                <BulkMode scope={t(`points.areas.${group.id}`)} onApply={(mode) => onBulk(group.points, mode)} />
              </div>
              <div id={`dp-area-${group.id}`} className="dp-area-points" hidden={!isOpen}>
                {isOpen &&
                  group.points.map((id) => {
                    const info = byId.get(id);
                    return (
                      info && (
                        <PointRow
                          key={id}
                          info={info}
                          settings={settings}
                          draft={draft}
                          provider={draft.provider}
                          stats={stats ? (stats.get(id) ?? null) : undefined}
                          onMode={onMode}
                          onThreshold={onThreshold}
                          onWithdraw={() => withdraw.mutate(info)}
                        />
                      )
                    );
                  })}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

/**
 * One point as evidence (manifesto §2): its name and mode, then what it decided over the history
 * window, the consent when it is not off, what the Supervisor does in its mode, and the threshold
 * only where it acts (Jev, an act point).
 */
export function PointRow({
  info,
  settings,
  draft,
  provider,
  stats,
  onMode,
  onThreshold,
  onWithdraw,
}: {
  info: DecisionPointInfo;
  settings: DecisionSettings;
  draft: Draft;
  provider: DecisionProviderId;
  /** undefined while the numbers load, null for a point with none */
  stats?: DecisionPointStats | null | undefined;
  onMode: (id: DecisionPointId, mode: DecisionMode) => void;
  onThreshold: (id: DecisionPointId, threshold: number) => void;
  onWithdraw?: () => void;
}) {
  const { t } = useTranslation('decisions');
  const name = pointName(t, info.id);
  const anchor = pointAnchor(info.id);
  const point = draft.points[info.id] ?? { mode: 'off' as const, threshold: info.defaultThreshold };
  const blocked = activeBlocked(info, provider);
  const off = point.mode === 'off';
  const supervisor = info.id === SUPERVISOR_POINT;
  const showThreshold = provider === 'jev' && info.kind === 'act' && !off;

  return (
    <div className="dp-point" id={anchor} data-setting={anchor} data-point={info.id}>
      <div className="dp-point-name">
        <span>{name}</span>
        <span className="dp-id">{info.id}</span>
      </div>
      <Segmented
        label={t('points.mode', { point: info.id })}
        value={point.mode}
        onChange={(mode) => onMode(info.id, mode)}
        options={MODES.map((mode) => ({
          value: mode,
          label: t(`points.modes.${mode}`),
          ...(mode === 'active' && blocked ? { disabled: true, title: t('points.activeNeedsJev') } : {}),
        }))}
      />
      <p className="dp-evidence">
        <EvidenceLine id={info.id} stats={stats} />
        {!off && <ConsentPart info={info} settings={settings} mode={point.mode} provider={provider} {...(onWithdraw ? { onWithdraw } : {})} />}
      </p>
      {supervisor && <p className="dp-point-line">{t(`supervisor.${supervisorMeaning(point.mode, provider)}`)}</p>}
      {showThreshold && (
        <div className="dp-thr dp-point-thr">
          <span className="dp-point-line">{t('points.thresholdLine')}</span>
          <Slider
            aria-label={t('points.threshold', { point: info.id })}
            min={THRESHOLD_MIN}
            max={THRESHOLD_MAX}
            step={0.01}
            value={point.threshold}
            onChange={(threshold) => onThreshold(info.id, Math.round(threshold * 100) / 100)}
          />
          <output>{formatNumber(point.threshold, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</output>
        </div>
      )}
    </div>
  );
}

/** "47 decisions · agrees with you 94 % · 3 disagreements": the last part opens its decisions in History. */
function EvidenceLine({ id, stats }: { id: DecisionPointId; stats: DecisionPointStats | null | undefined }) {
  const { t } = useTranslation('decisions');
  // Reserved while the numbers load, so the row does not grow under the pointer
  if (stats === undefined) return <span className="dp-evidence-wait">{t('evidence.none')}</span>;
  const evidence = evidenceOf(stats ?? undefined);
  if (evidence.count === 0) return <span>{t('evidence.none')}</span>;
  const history = settingsHref('decisions', { detail: 'history', query: { point: id } });
  const count = t('evidence.count', { count: evidence.count, formatted: formatNumber(evidence.count) });
  return (
    <>
      {evidence.disagreements > 0 ? <span className="tnum">{count}</span> : <Link to={history} className="tnum">{count}</Link>}
      {evidence.agreement !== null && <span className="tnum">{t('evidence.agrees', { percent: formatPercent(evidence.agreement) })}</span>}
      {evidence.disagreements > 0 && (
        <Link to={history} className="tnum">
          {t('evidence.disagreements', { count: evidence.disagreements, formatted: formatNumber(evidence.disagreements) })}
        </Link>
      )}
    </>
  );
}

/** "Consented on 17 Oct · Withdraw", on a point that is not off: what lets it send its state. */
function ConsentPart({
  info,
  settings,
  mode,
  provider,
  onWithdraw,
}: {
  info: DecisionPointInfo;
  settings: DecisionSettings;
  mode: DecisionMode;
  provider: DecisionProviderId;
  onWithdraw?: () => void;
}) {
  const { t } = useTranslation('decisions');
  const consent = settings.points[info.id]?.consent ?? null;
  const state = !consent ? 'none' : consent.stateVersion === info.stateVersion ? 'given' : 'stale';
  return (
    <>
      <span className={`dp-evidence-consent ${state === 'given' ? '' : 'is-none'}`} {...(state === 'stale' ? { title: t('points.consent.staleHint') } : {})}>
        {state === 'given' && consent ? t('evidence.consentedOn', { date: formatDate(consent.at) }) : state === 'stale' ? t('points.consent.stale') : t('points.consent.none')}
      </span>
      {isLimited(info, consent, mode, provider) && needsConsent(info, consent, provider) && <span className="dp-evidence-consent is-none">{t('points.limited')}</span>}
      {consent && onWithdraw && (
        <button type="button" className="link-btn" aria-label={t('consent.withdrawPoint', { point: info.id })} onClick={onWithdraw}>
          {t('consent.withdrawAction')}
        </button>
      )}
    </>
  );
}
