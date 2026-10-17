import type { Orchestration, ReviewFinding, ReviewGateDetail, ReviewGateState, ReviewGateStatus, ReviewRound, ReviewRun, ReviewRunState } from '@claudio/shared';
import { Dialog } from '@claudio/ui/components/Dialog';
import { Collapsible, Sheet } from '@claudio/ui/components/controls';
import { ICON_SM } from '@claudio/ui/components/icons';
import { ProgressBar } from '@claudio/ui/components/ProgressBar';
import { Spinner } from '@claudio/ui/components/Spinner';
import { useToast } from '@claudio/ui/components/Toast';
import { Tag } from '@claudio/ui/components/ui';
import { formatCost, formatDateTime } from '@claudio/ui/lib/format';
import { NARROW, useMediaQuery } from '@claudio/ui/lib/media';
import type { ProgressCounts, ProgressStatus } from '@claudio/ui/lib/progress';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CircleAlert, Clock, Link2, ShieldCheck, TriangleAlert, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys } from '../api';
import { FindingCard } from './changes/ReviewFindings';

// The review of the merged branch, inside the verification card (docs/plans/review-gate.md, Web
// item 3; design system §18, `.rg`). The energy border turns only while reviewers run: no task is
// running then, so it is still the screen's one surface.

const STATUS_TONE: Record<ReviewGateStatus, string> = {
  pending: 'idle',
  running: 'active',
  passed: 'ok',
  blocked: 'bad',
  incomplete: 'warn',
  // A person let it through: said in warn, never as a plain pass
  accepted: 'warn',
  skipped: 'muted',
};

const RUN_TONE: Record<ReviewRunState, 'ok' | 'bad' | 'warn' | 'live' | ''> = {
  pending: '',
  running: 'live',
  waiting: 'warn',
  done: 'ok',
  invalid: 'bad',
  budget: 'bad',
  failed: 'bad',
  'timed-out': 'bad',
  cancelled: 'warn',
  interrupted: 'warn',
  'incomplete-coverage': 'warn',
};

/** One cell of the segmented bar per run of the round */
function cellOf(state: ReviewRunState): ProgressStatus {
  if (state === 'done') return 'done';
  if (state === 'running' || state === 'waiting') return 'running';
  if (state === 'pending') return 'pending';
  return 'failed';
}

/** A retry that also ended incomplete is what opens "Accept anyway" for an incomplete gate (resolved question 3) */
export function canAcceptIncomplete(detail: ReviewGateDetail | undefined): boolean {
  return (detail?.rounds ?? []).filter((round) => round.state === 'incomplete').length >= 2;
}

export interface FindingGroups {
  blocking: ReviewFinding[];
  advisory: ReviewFinding[];
  refuted: ReviewFinding[];
  outside: ReviewFinding[];
}

export function groupOfFindings(findings: readonly ReviewFinding[]): FindingGroups {
  const groups: FindingGroups = { blocking: [], advisory: [], refuted: [], outside: [] };
  for (const finding of findings) {
    if (finding.blocking) groups.blocking.push(finding);
    else if (finding.verdict === 'refuted') groups.refuted.push(finding);
    else if (finding.anchor === 'outside') groups.outside.push(finding);
    else groups.advisory.push(finding);
  }
  return groups;
}

function RunIcon({ state }: { state: ReviewRunState }) {
  if (state === 'running') return <Spinner variant="ring" />;
  if (state === 'done') return <Check {...ICON_SM} className="ok" aria-hidden />;
  if (state === 'waiting') return <Clock {...ICON_SM} aria-hidden />;
  if (state === 'pending') return <span className="dot" aria-hidden />;
  return <X {...ICON_SM} aria-hidden />;
}

function RunRow({ run }: { run: ReviewRun }) {
  const { t } = useTranslation('orchestrationV2');
  const tone = RUN_TONE[run.state];
  const name = run.kind === 'reviewer' && run.dimension ? t(`review.dimension.${run.dimension}`) : t(`review.kind.${run.kind}`);
  return (
    <li className={`rg-run${run.state === 'running' ? ' live-rail' : ''}`}>
      <RunIcon state={run.state} />
      <span className="dim">
        {name}
        {run.chunk !== null && run.chunks !== null && run.chunks > 1 && <span className="tnum">{`${run.chunk}/${run.chunks}`}</span>}
        {run.kind === 'reviewer' && run.chunk !== null && run.chunks === 1 && <span className="tnum">1/1</span>}
      </span>
      <span className="model">{run.model ?? ''}</span>
      <span className="meta">
        <span className={`state${tone ? ` ${tone}` : ''}`}>{t(`review.runState.${run.state}`)}</span>
        <span className="cost">{run.startedAt ? formatCost(run.costUsd) : '—'}</span>
      </span>
      {run.chatId ? (
        <Link to={`/chats/${encodeURIComponent(run.chatId)}`} className="icon-link" aria-label={t('review.runChat', { name })}>
          <Link2 {...ICON_SM} />
        </Link>
      ) : (
        <span />
      )}
    </li>
  );
}

function Group({ id, count, children, defaultOpen = false }: { id: 'blocking' | 'advisory' | 'refuted' | 'outside' | 'skipped'; count: number; children: React.ReactNode; defaultOpen?: boolean }) {
  const { t } = useTranslation('orchestrationV2');
  if (count === 0) return null;
  return (
    <Collapsible
      className="rg-group"
      triggerClassName="rg-group-head"
      defaultOpen={defaultOpen}
      title={
        <>
          <span className="label">{t(`review.group.${id}`)}</span>
          <span className="n">{count}</span>
        </>
      }
    >
      <div className="rg-group-body">{children}</div>
    </Collapsible>
  );
}

/** The dialog's body, apart from its shell so a phone's Sheet and a desktop's Dialog draw the same thing */
export function AcceptFields({ reason, onReason, touched, onSubmit }: { reason: string; onReason: (reason: string) => void; touched: boolean; onSubmit: (e: FormEvent) => void }) {
  const { t } = useTranslation('orchestrationV2');
  const empty = reason.trim().length === 0;
  return (
    <form id="review-accept-form" className="rg-accept" onSubmit={onSubmit}>
      <div className="alert alert-warn" role="note">
        <TriangleAlert className="alert-icon" {...ICON_SM} />
        <div className="alert-body">{t('review.accept.warning')}</div>
      </div>
      <label className="field field-area">
        <span className="field-label">{t('review.accept.reason')}</span>
        <textarea
          rows={4}
          maxLength={1000}
          value={reason}
          autoFocus
          data-autofocus
          aria-required
          aria-invalid={touched && empty}
          aria-describedby={touched && empty ? 'review-accept-error' : undefined}
          placeholder={t('review.accept.placeholder')}
          onChange={(e) => onReason(e.target.value)}
        />
      </label>
      {touched && empty && (
        <p id="review-accept-error" className="field-error small" role="alert">
          {t('review.accept.required')}
        </p>
      )}
    </form>
  );
}

/** The files the round could not review, each with why: the gate is incomplete because of them */
export function SkippedFiles({ files }: { files: ReviewRound['skippedFiles'] }) {
  const { t } = useTranslation('orchestrationV2');
  return (
    <>
      {files.map((file) => (
        <div key={file.path} className="rg-skipped">
          <span className="mono">{file.path}</span>
          <span className="why">{file.detail ? `${t(`review.skipReason.${file.why}`)} · ${file.detail}` : t(`review.skipReason.${file.why}`)}</span>
        </div>
      ))}
    </>
  );
}

export function AcceptDialog({ orchestrationId, onClose, phone }: { orchestrationId: string; onClose: () => void; phone: boolean }) {
  const { t } = useTranslation('orchestrationV2');
  const toast = useToast();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const accept = useMutation({
    mutationFn: () => api.acceptOrchestrationReview(orchestrationId, { reason: reason.trim() }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.orchestration(orchestrationId) });
      void queryClient.invalidateQueries({ queryKey: keys.orchestrationReview(orchestrationId) });
      onClose();
    },
    onError: (err) => toast.error(t('review.accept.failed'), err),
  });
  const empty = reason.trim().length === 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!empty && !accept.isPending) accept.mutate();
  };
  const body = <AcceptFields reason={reason} onReason={setReason} touched={touched} onSubmit={submit} />;
  const confirm = (
    <>
      <button type="button" className="btn" onClick={onClose}>
        {t('review.accept.cancel')}
      </button>
      <button type="submit" form="review-accept-form" className="btn btn-primary" disabled={accept.isPending}>
        {t('review.accept.confirm')}
      </button>
    </>
  );
  if (phone) {
    return (
      <Sheet open onOpenChange={(open) => !open && onClose()} title={t('review.accept.title')} footer={<div className="rg-foot">{confirm}</div>}>
        {body}
      </Sheet>
    );
  }
  return (
    <Dialog title={t('review.accept.title')} onClose={onClose} footer={confirm}>
      {body}
    </Dialog>
  );
}

/** The sentence under the head: why the gate is where it is, in Claudio's own words */
function Reason({ state }: { state: ReviewGateState }) {
  const { t } = useTranslation('orchestrationV2');
  const accepted = state.accepted;
  if (state.status === 'accepted' && accepted) {
    return (
      <div className="rg-reason warn" role="status">
        <TriangleAlert className="ico" {...ICON_SM} />
        <span>
          {t('review.reason.accepted', { by: accepted.by })} <q>{accepted.reason}</q>
        </span>
      </div>
    );
  }
  if ((state.status !== 'blocked' && state.status !== 'incomplete') || !state.reason) return null;
  return (
    <div className={`rg-reason ${state.status === 'blocked' ? 'bad' : 'warn'}`} role="status">
      {state.status === 'blocked' ? <CircleAlert className="ico" {...ICON_SM} /> : <TriangleAlert className="ico" {...ICON_SM} />}
      <span>{state.reason}</span>
    </div>
  );
}

export function ReviewGateSection({ orch }: { orch: Orchestration }) {
  const { t } = useTranslation('orchestrationV2');
  const state = orch.verification?.review;
  const toast = useToast();
  const queryClient = useQueryClient();
  const phone = useMediaQuery(NARROW);
  const [accepting, setAccepting] = useState(false);
  // The card reads the detail again when the round, the status or the number of finished runs moves
  const detailQ = useQuery({
    queryKey: [...keys.orchestrationReview(orch.id), state?.round, state?.status, state?.runs.done],
    queryFn: ({ signal }) => api.orchestrationReview(orch.id, { limit: 100 }, { signal }),
    enabled: !!state,
    retry: false,
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.orchestration(orch.id) });
    void queryClient.invalidateQueries({ queryKey: keys.orchestrationReview(orch.id) });
  };
  const retry = useMutation({
    mutationFn: () => api.retryOrchestrationReview(orch.id),
    onSuccess: refresh,
    onError: (err) => toast.error(t('review.retryFailed'), err),
  });
  const verifyAgain = useMutation({
    mutationFn: () => api.verifyOrchestration(orch.id),
    onSuccess: refresh,
    onError: (err) => toast.error(t('review.verifyFailed'), err),
  });
  if (!state) return null;

  const detail = detailQ.data;
  const round = detail?.rounds.find((r) => r.round === state.round) ?? detail?.rounds.at(-1);
  const runs = round?.runs ?? [];
  const groups = groupOfFindings(detail?.findings ?? []);
  const skipped = round?.skippedFiles ?? [];
  const running = state.status === 'running';
  const settled = state.status === 'blocked' || state.status === 'incomplete' || state.status === 'passed' || state.status === 'accepted';
  const acceptable = state.status === 'blocked' || (state.status === 'incomplete' && canAcceptIncomplete(detail));
  const counts: ProgressCounts = {
    done: state.runs.done,
    running: state.runs.running,
    failed: state.runs.failed,
    pending: Math.max(0, state.runs.total - state.runs.done - state.runs.running - state.runs.failed),
  };
  const maxCost = orch.verificationSpec?.review?.maxCostUsd ?? 5;
  const noFindings = state.status === 'passed' && groups.blocking.length + groups.advisory.length + groups.refuted.length + groups.outside.length === 0;
  const total = state.counts.blocking + state.counts.advisory + state.counts.refuted + state.counts.outside;

  return (
    <section className={`rg${running ? ' live-energy' : ''}`} aria-label={t('review.title')} data-review-status={state.status}>
      <div className="rg-head">
        <h3>{t('review.title')}</h3>
        <Tag tone={STATUS_TONE[state.status]} icon={state.status === 'passed' ? ShieldCheck : undefined}>
          {t(`review.status.${state.status}`)}
        </Tag>
        {running && (
          <span className="rg-verb" role="status">
            <Spinner />
            {state.phase ? t(`review.phase.${state.phase}`) : t('review.phase.reviewing')}
          </span>
        )}
        <span className="grow" />
        <span className="facts">
          {t('review.facts', { round: Math.max(state.round, 1), max: state.maxFixRounds + 1 })}
          {state.head && (
            <>
              {' · '}
              <span className="mono">{state.head.slice(0, 7)}</span>
            </>
          )}
          {` · ${t('review.costOf', { cost: formatCost(state.costUsd), limit: formatCost(maxCost) })}`}
        </span>
      </div>

      {state.waiting && (
        <div className="rg-reason warn" role="status">
          <Clock className="ico" {...ICON_SM} />
          <span>
            {t('review.waiting')} <span className="tnum">{state.waiting.resetsAt ? formatDateTime(state.waiting.resetsAt) : ''}</span>
          </span>
        </div>
      )}
      <Reason state={state} />

      {state.runs.total > 0 && (
        <div className="rg-segs">
          <ProgressBar variant="segments" counts={counts} unit={t('review.runsUnit')} />
          <span className="tnum">{t('review.runsOf', { done: state.runs.done, total: state.runs.total })}</span>
        </div>
      )}
      {runs.length > 0 && (
        <ul className="rg-runs">
          {runs.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
        </ul>
      )}

      {noFindings && (
        <p className="rg-quiet" role="status">
          <Check {...ICON_SM} className="ok" aria-hidden />
          {t('review.noFindings')}
        </p>
      )}
      {state.status === 'pending' && <p className="rg-quiet">{t('review.pendingNote')}</p>}

      <Group id="blocking" count={groups.blocking.length} defaultOpen>
        {groups.blocking.map((finding) => (
          <FindingCard key={finding.id} finding={finding} full phone={phone} />
        ))}
      </Group>
      <Group id="advisory" count={groups.advisory.length}>
        {groups.advisory.map((finding) => (
          <FindingCard key={finding.id} finding={finding} full phone={phone} />
        ))}
      </Group>
      <Group id="refuted" count={groups.refuted.length}>
        {groups.refuted.map((finding) => (
          <FindingCard key={finding.id} finding={finding} full phone={phone} />
        ))}
      </Group>
      <Group id="outside" count={groups.outside.length}>
        {groups.outside.map((finding) => (
          <FindingCard key={finding.id} finding={finding} full phone={phone} />
        ))}
      </Group>
      <Group id="skipped" count={skipped.length}>
        <SkippedFiles files={skipped} />
      </Group>
      {total > 0 && detail && detail.totalFindings > detail.findings.length && (
        <p className="rg-quiet small">{t('review.moreFindings', { shown: detail.findings.length, total: detail.totalFindings })}</p>
      )}

      {settled && (
        <div className="rg-foot">
          {state.status === 'incomplete' && (
            <button type="button" className="btn btn-primary" disabled={retry.isPending} onClick={() => retry.mutate()}>
              {t('review.retry')}
            </button>
          )}
          {(state.status === 'blocked' || state.status === 'incomplete') && (
            <button type="button" className="btn" disabled={!acceptable} onClick={() => setAccepting(true)}>
              {t('review.acceptAnyway')}
            </button>
          )}
          <button type="button" className="btn" disabled={verifyAgain.isPending} onClick={() => verifyAgain.mutate()}>
            {t('review.verifyAgain')}
          </button>
          {state.status === 'blocked' && <span className="hint">{t('review.holdsPullRequest')}</span>}
          {state.status === 'incomplete' && <span className="hint">{acceptable ? t('review.holdsPullRequest') : t('review.acceptAfterRetry')}</span>}
        </div>
      )}
      {accepting && <AcceptDialog orchestrationId={orch.id} phone={phone} onClose={() => setAccepting(false)} />}
    </section>
  );
}
