import type { Lesson, LessonEvidence, LessonJob, LessonStatus, MemoryProposal } from '@claudio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Download, Globe, Pencil, Pin, PinOff, RotateCcw, Trash2, Undo2, FileText, CircleCheck, Archive } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys, useLessonJobs, useLessons } from '../../../api';
import { MoreActions, type MenuEntry } from '@claudio/ui/components/controls';
import { useConfirm } from '@claudio/ui/components/Dialog';
import { ICON_SM } from '@claudio/ui/components/icons';
import { useToast } from '@claudio/ui/components/Toast';
import { ErrorBox, Segmented, Skeleton, Tag } from '@claudio/ui/components/ui';
import { formatCost, formatNumber, timeAgo } from '@claudio/ui/lib/format';
import { useDirty } from '../../../lib/dirty';
import { InstructionsDiffDialog } from './InstructionsDiff';

/** What the card lists: a proposed lesson waits in Proposals, and a rejected or superseded one is not shown */
type View = 'active' | 'retired' | 'all';
const SHOWN: readonly LessonStatus[] = ['active', 'retired'];

/** Jobs the footer lists, and how many "See all" reads */
const JOBS_SHOWN = 3;
const JOBS_ALL = 20;

/** Below the stored confidence by more than rounding: decay has started on it */
export const isFading = (lesson: Lesson): boolean => !lesson.pinned && lesson.status === 'active' && lesson.confidence - lesson.effectiveConfidence >= 0.005;

/** A lesson's confidence as the row writes it: two decimals, in the reader's separator */
export function useConfidence(): (value: number) => string {
  const { i18n } = useTranslation();
  const format = new Intl.NumberFormat(i18n.language, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (value) => format.format(value);
}

/** One piece of evidence: the person's words as written, what the agent had done in mono, and the chat it came from */
function EvidenceItem({ item }: { item: LessonEvidence }) {
  const { t } = useTranslation('home');
  return (
    <li className="lesson-evidence-item">
      {item.quote ? <blockquote className="lesson-quote">{item.quote}</blockquote> : <p className="lesson-quote is-empty">{t('memoryTab.lessons.noMessage')}</p>}
      <p className="lesson-evidence-meta">
        <span className="small muted">{t(`memoryTab.lessons.signal.${item.signal}`)}</span>
        {item.context && <span className="mono small muted lesson-context">{item.context}</span>}
        {item.chatId ? (
          <Link to={`/chats/${item.chatId}`} className="small">
            {item.chatTitle ?? t('memoryTab.lessons.openChat')}
          </Link>
        ) : (
          <span className="small muted">{t('memoryTab.lessons.chatDeleted')}</span>
        )}
        <time className="small muted tnum" dateTime={item.at}>
          {timeAgo(item.at)}
        </time>
      </p>
    </li>
  );
}

/** At most `limit` quotes, then "N more" */
export function EvidenceList({ evidence, limit }: { evidence: LessonEvidence[]; limit?: number }) {
  const { t } = useTranslation('home');
  const shown = limit === undefined ? evidence : evidence.slice(0, limit);
  const more = evidence.length - shown.length;
  return (
    <>
      <ul className="lesson-evidence" aria-label={t('memoryTab.lessons.evidence')}>
        {shown.map((item) => (
          <EvidenceItem key={item.id} item={item} />
        ))}
      </ul>
      {more > 0 && <p className="small muted lesson-more">{t('memoryTab.lessons.moreEvidence', { count: more, n: formatNumber(more) })}</p>}
    </>
  );
}

/** "When …" and the action as one sentence, the trigger in `--fg-2` */
export function LessonText({ trigger, action }: { trigger: string; action: string }) {
  return (
    <p className="lesson-text">
      <span className="lesson-when">{trigger.replace(/[:.\s]+$/, '')}:</span> {action}
    </p>
  );
}

/** The two fields a person edits a lesson in; a phone reads them at 16 px like every field */
function LessonEditor({ lesson, onDone }: { lesson: Lesson; onDone: () => void }) {
  const { t } = useTranslation(['home', 'common']);
  const qc = useQueryClient();
  const toast = useToast();
  const [trigger, setTrigger] = useState(lesson.trigger);
  const [action, setAction] = useState(lesson.action);
  useDirty(`lesson:${lesson.id}`, trigger !== lesson.trigger || action !== lesson.action);
  const save = useMutation({
    mutationFn: () => api.updateLesson(lesson.id, { trigger: trigger.trim(), action: action.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lessons'] });
      onDone();
    },
    onError: (error) => toast.error(t('memoryTab.lessons.saveFailed'), error),
  });
  const ready = trigger.trim() !== '' && action.trim() !== '';
  return (
    <form
      className="lesson-edit"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) save.mutate();
      }}
    >
      <label className="small muted" htmlFor={`lesson-trigger-${lesson.id}`}>
        {t('memoryTab.lessons.triggerLabel')}
      </label>
      <input id={`lesson-trigger-${lesson.id}`} autoFocus maxLength={160} value={trigger} onChange={(event) => setTrigger(event.target.value)} onKeyDown={(event) => event.key === 'Escape' && onDone()} />
      <label className="small muted" htmlFor={`lesson-action-${lesson.id}`}>
        {t('memoryTab.lessons.actionLabel')}
      </label>
      <textarea id={`lesson-action-${lesson.id}`} rows={3} maxLength={240} value={action} onChange={(event) => setAction(event.target.value)} onKeyDown={(event) => event.key === 'Escape' && onDone()} />
      <div className="memory-proposal-actions">
        <button type="button" className="btn doc-quiet btn-small" onClick={onDone}>
          {t('common:actions.cancel')}
        </button>
        <button type="submit" className="btn btn-small" disabled={save.isPending || !ready}>
          <Check {...ICON_SM} />
          {t('memoryTab.lessons.save')}
        </button>
      </div>
    </form>
  );
}

/**
 * One lesson: its key, the sentence, its confidence and the words that say what state it is in, an
 * evidence toggle and the `⋯` menu (a sheet on a phone). `global` is a lesson of Settings → Lessons:
 * it can go back to a project, and has no project to export from or to put into `CLAUDE.md`.
 */
export function LessonRow({ lesson, global = false, onPropose }: { lesson: Lesson; global?: boolean; onPropose?: (proposal: MemoryProposal) => void }) {
  const { t } = useTranslation(['home', 'common']);
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const confidence = useConfidence();
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const fading = isFading(lesson);
  const retired = lesson.status === 'retired';

  const refresh = () => void qc.invalidateQueries({ queryKey: ['lessons'] });
  const act = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: refresh,
    onError: (error) => toast.error(t('memoryTab.lessons.actionFailed'), error),
  });
  const propose = useMutation({
    mutationFn: () => api.lessonToInstructions(lesson.id),
    onSuccess: (proposal) => {
      void qc.invalidateQueries({ queryKey: keys.memoryProposalsOf(proposal.projectId) });
      onPropose?.(proposal);
    },
    onError: (error) => toast.error(t('memoryTab.lessons.proposeFailed'), error),
  });
  const remove = async () => {
    const ok = await confirm({
      title: t('memoryTab.lessons.deleteTitle', { key: lesson.key }),
      body: t('memoryTab.lessons.deleteBody'),
      confirmLabel: t('common:actions.delete'),
      danger: true,
    });
    if (ok) act.mutate(() => api.deleteLesson(lesson.id));
  };

  const entries: MenuEntry[] = [
    { id: 'edit', label: t('memoryTab.lessons.edit'), icon: Pencil, onSelect: () => setEditing(true) },
    ...(lesson.status === 'active'
      ? [
          {
            id: 'pin',
            label: lesson.pinned ? t('memoryTab.lessons.unpin') : t('memoryTab.lessons.pin'),
            icon: lesson.pinned ? PinOff : Pin,
            onSelect: () => act.mutate(() => api.updateLesson(lesson.id, { pinned: !lesson.pinned })),
          },
          { id: 'confirm', label: t('memoryTab.lessons.confirm'), icon: CircleCheck, onSelect: () => act.mutate(() => api.confirmLesson(lesson.id)) },
          { id: 'retire', label: t('memoryTab.lessons.retire'), icon: Archive, onSelect: () => act.mutate(() => api.retireLesson(lesson.id)) },
        ]
      : [{ id: 'restore', label: t('memoryTab.lessons.restore'), icon: RotateCcw, onSelect: () => act.mutate(() => api.restoreLesson(lesson.id)) }]),
    ...(global
      ? [{ id: 'demote', label: t('memoryTab.lessons.backToProject'), icon: Undo2, onSelect: () => act.mutate(() => api.demoteLesson(lesson.id)) }]
      : [
          ...(lesson.status === 'active' ? [{ id: 'promote', label: t('memoryTab.lessons.makeGlobal'), icon: Globe, onSelect: () => act.mutate(() => api.promoteLesson(lesson.id)) }] : []),
          ...(lesson.status === 'active' && onPropose
            ? [{ id: 'instructions', label: t('memoryTab.lessons.proposeInstructions'), icon: FileText, disabled: propose.isPending, onSelect: () => propose.mutate() }]
            : []),
          // The route exports the whole project's lessons; a real link, so the browser saves the file
          ...(lesson.projectId
            ? [{ id: 'export', label: t('memoryTab.lessons.export'), icon: Download, href: api.lessonsExportUrl(lesson.projectId), download: true }]
            : []),
        ]),
    { id: 'sep', separator: true as const },
    { id: 'delete', label: t('common:actions.delete'), icon: Trash2, destructive: true, onSelect: () => void remove() },
  ];

  return (
    <li className={`lesson-row ${retired ? 'is-retired' : ''} ${fading ? 'is-fading' : ''}`.trim()} aria-label={`${lesson.key}: ${lesson.trigger}`}>
      {editing ? (
        <LessonEditor lesson={lesson} onDone={() => setEditing(false)} />
      ) : (
        <div className="lesson-main">
          <span className="lesson-key mono">{lesson.key}</span>
          <LessonText trigger={lesson.trigger} action={lesson.action} />
        </div>
      )}
      <div className="lesson-facts">
        <span className="small tnum lesson-conf" title={t('memoryTab.lessons.confidence')}>
          <span className="sr-only">{t('memoryTab.lessons.confidence')} </span>
          {confidence(lesson.effectiveConfidence)}
        </span>
        {lesson.pinned && <Tag tone="muted">{t('memoryTab.lessons.pinned')}</Tag>}
        {fading && <Tag tone="warn">{t('memoryTab.lessons.fading')}</Tag>}
        {lesson.status === 'active' && lesson.delivered && <Tag tone="ok">{t('memoryTab.lessons.delivered')}</Tag>}
        {retired && <Tag tone="muted">{t(`memoryTab.lessons.retiredBy.${lesson.retiredReason ?? 'person'}`)}</Tag>}
        <span className="small muted tnum">{t('memoryTab.lessons.seen', { n: formatNumber(lesson.seenCount) })}</span>
        {lesson.alsoInProjects > 0 && <span className="small muted">{t('memoryTab.lessons.alsoIn', { count: lesson.alsoInProjects, n: formatNumber(lesson.alsoInProjects) })}</span>}
        <span className="doc-fill" />
        {lesson.evidence.length > 0 && (
          <button type="button" className="btn doc-quiet btn-small lesson-evidence-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
            <ChevronDown {...ICON_SM} className={open ? 'is-open' : ''} />
            {t('memoryTab.lessons.evidenceToggle', { count: lesson.evidence.length, n: formatNumber(lesson.evidence.length) })}
          </button>
        )}
        <MoreActions label={t('memoryTab.lessons.more', { key: lesson.key })} entries={entries} />
      </div>
      {open && <EvidenceList evidence={lesson.evidence} />}
    </li>
  );
}

/** Rows of lessons, or the words for none */
export function LessonItems({ lessons, global = false, onPropose }: { lessons: Lesson[]; global?: boolean; onPropose?: (proposal: MemoryProposal) => void }) {
  const { t } = useTranslation('home');
  return (
    <ul className="lessons" aria-label={t('memoryTab.lessons.title')}>
      {lessons.map((lesson) => (
        <LessonRow key={lesson.id} lesson={lesson} global={global} {...(onPropose ? { onPropose } : {})} />
      ))}
    </ul>
  );
}

const JOB_TONE: Partial<Record<LessonJob['status'] | NonNullable<LessonJob['outcome']>, 'warn' | 'bad'>> = {
  failed: 'bad',
  'daily-cap': 'warn',
  'rate-limited': 'warn',
  'over-budget': 'warn',
};

/** A mining job in neutral words: queued, running or done are not a live agent, so no spinner */
function JobLine({ job }: { job: LessonJob }) {
  const { t } = useTranslation('home');
  const tone = JOB_TONE[job.status] ?? (job.outcome ? JOB_TONE[job.outcome] : undefined);
  return (
    <li className="lesson-job">
      <span className="small muted">{t(`memoryTab.lessons.trigger.${job.trigger}`)}</span>
      <span className={`small ${tone ? `lesson-job-${tone}` : ''}`.trim()}>
        {t(`memoryTab.lessons.jobStatus.${job.status}`)}
        {job.outcome && job.status !== 'failed' ? ` · ${t(`memoryTab.lessons.outcome.${job.outcome}`, { n: formatNumber(job.proposed) })}` : ''}
      </span>
      <span className="doc-fill" />
      {job.costUsd !== null && <span className="small muted tnum">{formatCost(job.costUsd)}</span>}
      <time className="small muted tnum" dateTime={job.createdAt}>
        {timeAgo(job.createdAt)}
      </time>
    </li>
  );
}

function MiningFooter({ projectId, settingsHref }: { projectId: string; settingsHref: string }) {
  const { t } = useTranslation('home');
  const [all, setAll] = useState(false);
  const jobs = useLessonJobs(projectId, all ? JOBS_ALL : JOBS_SHOWN);
  const project = useQuery({ queryKey: keys.projectSettings(projectId), queryFn: () => api.projectSettings(projectId) });
  const global = useQuery({ queryKey: keys.decisionSettings, queryFn: () => api.decisionSettings() });
  const mode = project.data?.decisions?.points?.['lesson.mine']?.mode ?? global.data?.points['lesson.mine']?.mode ?? 'off';
  const list = jobs.data ?? [];
  return (
    <div className="lessons-foot">
      <p className="small muted lessons-mining">
        <span>{t('memoryTab.lessons.mining', { mode: t(`memoryTab.lessons.mode.${mode}`) })}</span>
        <Link to={settingsHref}>{t('memoryTab.lessons.miningLink')}</Link>
      </p>
      {list.length > 0 && (
        <ul className="lesson-jobs" aria-label={t('memoryTab.lessons.jobs')}>
          {list.slice(0, all ? JOBS_ALL : JOBS_SHOWN).map((job) => (
            <JobLine key={job.id} job={job} />
          ))}
        </ul>
      )}
      {(all || list.length >= JOBS_SHOWN) && (
        <button type="button" className="link-btn small" onClick={() => setAll(!all)}>
          {all ? t('memoryTab.lessons.fewer') : t('memoryTab.lessons.seeAll')}
        </button>
      )}
    </div>
  );
}

/**
 * The Lessons card of the Memory tab: what the person's corrections taught, as sentences with their
 * confidence and evidence. Nothing here is live (no gradient, no spinner): a lesson is a record.
 * A phone shows it as the Lessons segment, where the row's actions open in a sheet.
 */
export function LessonsCard({ projectId, phone = false, settingsHref }: { projectId: string; phone?: boolean; settingsHref: string }) {
  const { t } = useTranslation('home');
  const [view, setView] = useState<View>('active');
  const [diffFor, setDiffFor] = useState<MemoryProposal | null>(null);
  const lessons = useLessons(projectId, 'all');
  const all = (lessons.data?.lessons ?? []).filter((lesson) => SHOWN.includes(lesson.status));
  const list = all.filter((lesson) => view === 'all' || lesson.status === view);
  const active = all.filter((lesson) => lesson.status === 'active').length;
  const handed = lessons.data?.handed;

  const body = lessons.isLoading ? (
    <Skeleton rows={3} height={16} />
  ) : lessons.error ? (
    <ErrorBox error={lessons.error} />
  ) : list.length === 0 ? (
    <p className="small muted memory-none lessons-none">
      {all.length === 0 ? t('memoryTab.lessons.none') : t(`memoryTab.lessons.none_${view}`)}{' '}
      {all.length === 0 && <Link to={settingsHref}>{t('memoryTab.lessons.noneLink')}</Link>}
    </p>
  ) : (
    <LessonItems lessons={list} onPropose={setDiffFor} />
  );

  const head = (
    <>
      <span className="small muted tnum lessons-count">{t('memoryTab.lessons.count', { count: active, n: formatNumber(active) })}</span>
      {handed && (
        <span className="small muted tnum lessons-handed">
          {t('memoryTab.lessons.handed', { n: formatNumber(handed.lessons), total: formatNumber(handed.lessons + handed.overBudget) })}
          {handed.overBudget > 0 && <Tag tone="warn">{t('memoryTab.lessons.overBudget')}</Tag>}
        </span>
      )}
    </>
  );
  const switcher = (
    <Segmented<View>
      label={t('memoryTab.lessons.view')}
      value={view}
      onChange={setView}
      options={[
        { value: 'active', label: t('memoryTab.lessons.viewActive') },
        { value: 'retired', label: t('memoryTab.lessons.viewRetired') },
        { value: 'all', label: t('memoryTab.lessons.viewAll') },
      ]}
    />
  );
  const dialog = diffFor && <InstructionsDiffDialog proposal={diffFor} onClose={() => setDiffFor(null)} />;

  if (phone) {
    return (
      <>
        <div className="memory-phone-note lessons-phone-head">{head}</div>
        {switcher}
        <div className="card memory-card">
          {body}
          <MiningFooter projectId={projectId} settingsHref={settingsHref} />
        </div>
        {dialog}
      </>
    );
  }
  return (
    <section className="card memory-card" aria-labelledby="memory-lessons-title">
      <div className="card-head">
        <h2 id="memory-lessons-title">{t('memoryTab.lessons.title')}</h2>
        {head}
        <span className="doc-fill" />
        {switcher}
      </div>
      {body}
      <MiningFooter projectId={projectId} settingsHref={settingsHref} />
      {dialog}
    </section>
  );
}
