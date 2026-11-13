import type { HealthSignalKind } from '@claudio/shared';
import type { DecisionMode, DecisionPointId, DecisionPointInfo, DecisionPointStats, DecisionProviderId, DecisionSettings } from '@claudio/shared';
import { FullText } from '@claudio/ui/components/FullText';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Info, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys } from '../../../api';
import { Checkbox, Collapsible, Slider } from '@claudio/ui/components/controls';
import { useToast } from '@claudio/ui/components/Toast';
import { ErrorBox, Segmented, Tag } from '@claudio/ui/components/ui';
import { formatDate, formatNumber, formatPercent } from '@claudio/ui/lib/format';
import { settingsHref } from '../settingsGroups';
import { Overridden, ServerSettingChange } from '../SettingChange';
import { pointAnchor } from '../settingsIndex';
import { BulkMode } from './BulkMode';
import { gateMissing } from './gate';
import {
  AREAS,
  AUTO_SIGNAL_KINDS,
  FLOOR_DEFAULT,
  MODES,
  POINT_KEY,
  SUPERVISOR_POINT,
  THRESHOLD_MAX,
  THRESHOLD_MIN,
  activeBlocked,
  areaOf,
  bestReading,
  evidenceOf,
  gateBlocked,
  groupSummary,
  offUntilConsent,
  orderSignals,
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
  /** Points left as they are because they are not proven */
  unproven: number;
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
  onFloor,
  onAutoSignals,
  onReviewConsent,
  onReset,
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
  onFloor: (id: DecisionPointId, floor: number) => void;
  onAutoSignals: (kinds: HealthSignalKind[]) => void;
  /** Opens the consent dialog for a point that is not off and has no consent, in its current mode */
  onReviewConsent?: (id: DecisionPointId, mode: Exclude<DecisionMode, 'off'>) => void;
  /** A point went back to its default on the server: the draft takes its mode and threshold from the saved document */
  onReset?: (setting: string) => void;
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

  // Active in name only: nothing is stored for it, so it is there for as long as it is true. After an upgrade
  // this is where a person learns that what was Active now has to earn it
  const held = catalogue.filter((info) => info.effective.mode === 'active' && (info.effective.limitedBy === 'unproven' || info.effective.limitedBy === 'failing')).length;

  return (
    <>
      {held > 0 && (
        <div className="alert alert-info" role="note" data-testid="held-notice">
          <Info className="alert-icon" size={14} strokeWidth={2} aria-hidden />
          <div className="alert-body">
            <strong>{t('standing.heldTitle', { count: held, formatted: formatNumber(held) })}</strong>
            <div>{t('standing.heldBody', { count: held })}</div>
          </div>
        </div>
      )}
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
            {bulkNote.unproven > 0 && ` ${t('bulk.unproven', { count: bulkNote.unproven })}`}
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
                          onFloor={onFloor}
                          onAutoSignals={onAutoSignals}
                          onWithdraw={() => withdraw.mutate(info)}
                          {...(onReset ? { onReset } : {})}
                          {...(onReviewConsent ? { onReviewConsent } : {})}
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
  onFloor,
  onAutoSignals,
  onWithdraw,
  onReviewConsent,
  onReset,
}: {
  info: DecisionPointInfo;
  settings: DecisionSettings;
  draft: Draft;
  provider: DecisionProviderId;
  /** undefined while the numbers load, null for a point with none */
  stats?: DecisionPointStats | null | undefined;
  onMode: (id: DecisionPointId, mode: DecisionMode) => void;
  onThreshold: (id: DecisionPointId, threshold: number) => void;
  onFloor: (id: DecisionPointId, floor: number) => void;
  onAutoSignals: (kinds: HealthSignalKind[]) => void;
  onWithdraw?: () => void;
  onReviewConsent?: (id: DecisionPointId, mode: Exclude<DecisionMode, 'off'>) => void;
  onReset?: (setting: string) => void;
}) {
  const { t } = useTranslation('decisions');
  const name = pointName(t, info.id);
  const anchor = pointAnchor(info.id);
  const point = draft.points[info.id] ?? { mode: 'off' as const, threshold: info.defaultThreshold };
  const blocked = activeBlocked(info, provider);
  const off = point.mode === 'off';
  const supervisor = info.id === SUPERVISOR_POINT;
  const showThreshold = provider === 'jev' && info.kind === 'act' && !off;
  // A suggestion's confidence is only there under Jev: the CLI gives none, so it is never held to a floor
  const showFloor = provider === 'jev' && info.kind === 'suggest' && !off;
  const unproven = !blocked && gateBlocked(info, point.mode, settings.points[info.id]?.mode ?? 'off');
  const missing = gateMissing(t, info.gate, bestReading(info.live, info.replay));
  // What the row says about why a point that is on does not do what its mode names. No consent has its own words in the consent part, and a demotion its own line below
  const limit = info.effective.limitedBy;
  const limitReason =
    !supervisor && !off && point.mode === info.effective.mode && limit !== null && limit !== 'no-consent' && limit !== 'demoted'
      ? limit === 'cli'
        ? t('limited.cli')
        : t(limit === 'failing' ? 'limited.failing' : 'limited.unproven', { missing })
      : null;

  return (
    <div className="dp-point" id={anchor} data-setting={anchor} data-point={info.id}>
      <div className="dp-point-name">
        <span>{name}</span>
        <span className="dp-id">{info.id}</span>
      </div>
      <div className="dp-point-mode">
        <Segmented
          label={t('points.mode', { point: info.id })}
          value={point.mode}
          onChange={(mode) => onMode(info.id, mode)}
          options={MODES.map((mode) => ({
            value: mode,
            label: t(`points.modes.${mode}`),
            // The CLI's reason first: Jev fixes it, and only then does the proof matter
            ...(mode === 'active' && blocked ? { disabled: true, title: t('points.activeNeedsJev') } : {}),
            ...(mode === 'active' && unproven ? { disabled: true, title: t('gate.activeNeeds', { missing }) } : {}),
          }))}
        />
      </div>
      <p className="dp-evidence">
        <Tag tone={info.standing === 'proven' ? 'ok' : info.standing === 'failing' ? 'warn' : 'muted'}>{t(`standing.${info.standing}`)}</Tag>
        <EvidenceLine id={info.id} kind={info.kind} stats={stats} />
        <Overridden id={anchor} bare />
        {!off && <ConsentPart info={info} settings={settings} mode={point.mode} provider={provider} {...(onWithdraw ? { onWithdraw } : {})} {...(onReviewConsent ? { onReviewConsent } : {})} />}
      </p>
      {(limitReason || info.demoted) && (
        <p className="dp-point-line">
          <span className="dp-evidence-consent dp-consent-off">
            <TriangleAlert size={14} strokeWidth={2} aria-hidden />
            {info.demoted ? <DemotedWhy info={info} /> : limitReason}
          </span>
        </p>
      )}
      {/* Without consent a point is off whatever its mode: the line says what it does, not what was asked */}
      {supervisor && (
        <p className="dp-point-line">
          {t(`supervisor.${supervisorMeaning(offUntilConsent(info, settings.points[info.id]?.consent ?? null, point.mode, provider) ? 'off' : point.mode, provider)}`)}
        </p>
      )}
      {supervisor && point.mode === 'active' && <AutoSignals chosen={draft.autoSignals} onChange={onAutoSignals} />}
      {/* Beside the modes on a desktop (the point's grid), and on a phone a line of its own under the consequence */}
      <ServerSettingChange
        id={anchor}
        label={name}
        wording={(value) => t(`points.modes.${MODES.find((mode) => typeof value === 'object' && value !== null && !Array.isArray(value) && value.mode === mode) ?? 'off'}`)}
        invalidate={[keys.decisionSettings]}
        onReset={() => onReset?.(anchor)}
      />
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
      {showFloor && (
        <div className="dp-thr dp-point-thr">
          <span className="dp-point-line">{t('points.floorLine')}</span>
          <Slider
            aria-label={t('points.floor', { point: info.id })}
            min={THRESHOLD_MIN}
            max={THRESHOLD_MAX}
            step={0.01}
            value={point.floor ?? info.effective.floor ?? FLOOR_DEFAULT}
            onChange={(floor) => onFloor(info.id, Math.round(floor * 100) / 100)}
          />
          <output>{formatNumber(point.floor ?? info.effective.floor ?? FLOOR_DEFAULT, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</output>
        </div>
      )}
    </div>
  );
}

/**
 * What the Supervisor sends on its own under Active: a folded list of the signal kinds, each a
 * Checkbox, so a phone shows one line until the person opens it. The kinds not ticked are proposed.
 */
function AutoSignals({ chosen, onChange }: { chosen: readonly HealthSignalKind[]; onChange: (kinds: HealthSignalKind[]) => void }) {
  const { t } = useTranslation('decisions');
  // The names the health panel already uses for these signals
  const { t: names } = useTranslation('observe');
  const count = AUTO_SIGNAL_KINDS.filter((kind) => chosen.includes(kind)).length;
  return (
    <div className="dp-point-line" data-setting="supervisor.auto-signals">
      <Collapsible title={t('supervisor.autoSummary', { n: formatNumber(count), total: formatNumber(AUTO_SIGNAL_KINDS.length) })}>
        {AUTO_SIGNAL_KINDS.map((kind) => (
          <div key={kind}>
            <Checkbox checked={chosen.includes(kind)} onChange={(on) => onChange(on ? orderSignals([...chosen, kind]) : chosen.filter((other) => other !== kind))}>
              {names(`health.signal.${kind}`)}
            </Checkbox>
          </div>
        ))}
      </Collapsible>
    </div>
  );
}

/** When the engine moved the point back to Shadow and why, from what it read then. */
function DemotedWhy({ info }: { info: DecisionPointInfo }) {
  const { t } = useTranslation('decisions');
  const demoted = info.demoted;
  if (!demoted) return null;
  const evidence = demoted.evidence;
  const why =
    demoted.reason === 'failing'
      ? t(info.kind === 'act' ? 'standing.demotedWhy.failingAct' : 'standing.demotedWhy.failingSuggest', { hits: formatNumber(evidence.precision.hits), n: formatNumber(evidence.precision.n) })
      : t('standing.demotedWhy.rate', { acts: formatNumber(evidence.recentActs), rows: formatNumber(evidence.recentRows) });
  return <>{t('standing.demotedOn', { date: formatDate(demoted.at), why })}</>;
}

/**
 * "47 decisions · 31 with a known outcome · right 94 of the time it acts · differs from today's rule
 * in 12 of answers · 3 disagreements": what the point has proved, from outcomes that do not depend on
 * it. The first and the last open its decisions in History.
 */
function EvidenceLine({ id, kind, stats }: { id: DecisionPointId; kind: DecisionPointInfo['kind']; stats: DecisionPointStats | null | undefined }) {
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
      <span className="tnum">{t('evidence.direct', { formatted: formatNumber(evidence.direct) })}</span>
      {evidence.precision !== null && <span className="tnum">{t(kind === 'act' ? 'evidence.precisionAct' : 'evidence.precisionSuggest', { percent: formatPercent(evidence.precision) })}</span>}
      {evidence.differs !== null && <span className="tnum">{t('evidence.differs', { percent: formatPercent(evidence.differs) })}</span>}
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
  onReviewConsent,
}: {
  info: DecisionPointInfo;
  settings: DecisionSettings;
  mode: DecisionMode;
  provider: DecisionProviderId;
  onWithdraw?: () => void;
  onReviewConsent?: (id: DecisionPointId, mode: Exclude<DecisionMode, 'off'>) => void;
}) {
  const { t } = useTranslation('decisions');
  const consent = settings.points[info.id]?.consent ?? null;
  const state = !consent ? 'none' : consent.stateVersion === info.stateVersion ? 'given' : 'stale';
  // The engine gates on consent before it splits shadow from active (engine.ts), so any point that is not off and has none is off in fact
  const offInFact = mode !== 'off' && offUntilConsent(info, consent, mode, provider);
  return (
    <>
      {/* "Not consented" and "Off until it has consent" would say one fact twice */}
      {!(offInFact && state === 'none') && (
        <span className={`dp-evidence-consent ${state === 'given' ? '' : 'is-none'}`} {...(state === 'stale' ? { title: t('points.consent.staleHint') } : {})}>
          {state === 'given' && consent ? t('evidence.consentedOn', { date: formatDate(consent.at) }) : state === 'stale' ? t('points.consent.stale') : t('points.consent.none')}
        </span>
      )}
      {mode !== 'off' && offInFact && (
        <>
          <span className="dp-evidence-consent is-none dp-consent-off">
            <TriangleAlert size={14} strokeWidth={2} aria-hidden />
            {t('points.offUntilConsent')}
          </span>
          {onReviewConsent && (
            <button type="button" className="link-btn" onClick={() => onReviewConsent(info.id, mode)}>
              {t('points.reviewConsent')}
            </button>
          )}
        </>
      )}
      {consent && onWithdraw && (
        <button type="button" className="link-btn" aria-label={t('consent.withdrawPoint', { point: info.id })} onClick={onWithdraw}>
          {t('consent.withdrawAction')}
        </button>
      )}
    </>
  );
}
