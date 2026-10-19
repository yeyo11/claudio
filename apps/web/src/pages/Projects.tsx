import type { Project, ProjectCandidate } from '@claudio/shared';
import { FullText } from '@claudio/ui/components/FullText';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Copy, Download, Ellipsis, EyeOff, FolderOpen, FolderPlus, Pencil, Trash2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link, useNavigate } from 'react-router-dom';
import { api, keys, useChats, useProjectCandidates, useProjects } from '../api';
import { Menu, Sheet, type MenuEntry } from '@claudio/ui/components/controls';
import { useConfirm } from '@claudio/ui/components/Dialog';
import { ICON, ICON_SM, Monogram } from '@claudio/ui/components/icons';
import { WorkItemKey } from '../components/work-item-icons';
import { ListToolbar } from '@claudio/ui/components/ListToolbar';
import { StatusDot } from '@claudio/ui/components/motion';
import { useToast } from '@claudio/ui/components/Toast';
import { Card, Empty, ErrorBox, Loading, Tag } from '@claudio/ui/components/ui';
import { PageHeader } from '../components/PageHeader';
import { intlLocale } from '@claudio/ui/i18n/language';
import { formatDate, formatDateTime, formatNumber, timeAgo, toMs } from '@claudio/ui/lib/format';
import { matchesText, PROJECT_SORTERS, type ProjectSort } from '../lib/lists';
import { NARROW, useMediaQuery } from '@claudio/ui/lib/media';
import { GLOBAL_SCOPE, useListParams } from '../lib/list-params';
import { useProjectScope } from '../lib/project-scope';
import { NEW_PROJECT_PATH } from '../lib/work-items';
import { shortRemote } from './projects/model';
import { ModuleMarks } from './projects/parts';
import '../insights.css';

const PROJECT_SORTS = Object.keys(PROJECT_SORTERS) as ProjectSort[];
/** What the list keeps until it is reset; the list of projects is the one page the top bar's project does not narrow */
const LIST_PARAMS = ['q', 'sort'] as const;

/**
 * How long ago, as short as a stat allows ("2 d", "5 h"): `timeAgo`'s "2 d ago" does not fit a third
 * of a card at the stat's size. English keeps its narrow units, as lib/format does.
 */
function sinceShort(value: string | null): string {
  const ms = toMs(value);
  if (ms == null) return '—';
  const locale = intlLocale();
  const unit = (n: number, u: 'minute' | 'hour' | 'day') =>
    new Intl.NumberFormat(locale, { style: 'unit', unit: u, unitDisplay: locale.startsWith('en') ? 'narrow' : 'short' }).format(n);
  const minutes = Math.max(1, Math.floor((Date.now() - ms) / 60000));
  if (minutes < 60) return unit(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return unit(hours, 'hour');
  const days = Math.floor(hours / 24);
  return days < 30 ? unit(days, 'day') : formatDate(ms);
}

/** What a change to the projects makes stale: the list, what is offered, and everything scoped by a project. */
function useRefreshProjects() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: keys.projects });
    void queryClient.invalidateQueries({ queryKey: keys.chats });
    void queryClient.invalidateQueries({ queryKey: keys.overview });
    void queryClient.invalidateQueries({ queryKey: keys.memoryProjects });
  };
}

/** What the row says about a repository: its chats, across how many worktrees, and when it was last used. */
function candidateMeta(c: ProjectCandidate, t: TFunction<'projects'>): string {
  const chats = t('candidates.chats', { count: c.chatCount, n: formatNumber(c.chatCount) });
  const head = c.worktreeCount > 0 ? t('candidates.across', { chats, count: c.worktreeCount, n: formatNumber(c.worktreeCount) }) : chats;
  return head + (c.lastActivity ? t('candidates.last', { ago: timeAgo(c.lastActivity) }) : '');
}

/** One suggestion: what it is, where it came from, and the two things to do with it (MobileProyectos). */
function CandidateRow({ candidate: c, onHide }: { candidate: ProjectCandidate; onHide: (c: ProjectCandidate) => void }) {
  const { t } = useTranslation(['projects', 'common']);
  const narrow = useMediaQuery(NARROW);
  const [sheet, setSheet] = useState(false);
  const hideLabel = t('candidates.hideNamed', { name: c.name });
  return (
    <li className="candidate-row">
      <div className="candidate-main" title={c.path}>
        <strong className="break">{c.name}</strong>
        <span className="mono small muted break">{c.remote ? shortRemote(c.remote) : c.path}</span>
        <span className="small muted tnum">{candidateMeta(c, t)}</span>
        {c.sameRemoteAs && (
          <span className="small muted candidate-clone">
            <Copy {...ICON_SM} aria-hidden /> {t('candidates.otherClone', { name: c.sameRemoteAs.name })}
          </span>
        )}
      </div>
      <div className="candidate-actions">
        <Link to={`${NEW_PROJECT_PATH}?path=${encodeURIComponent(c.path)}`} className="btn btn-small" aria-label={t('candidates.importNamed', { name: c.name })}>
          <Download {...ICON_SM} /> {t('importForm.import')}
        </Link>
        {narrow ? (
          <>
            <button type="button" className="icon-btn" aria-label={hideLabel} onClick={() => setSheet(true)}>
              <Ellipsis {...ICON_SM} />
            </button>
            <Sheet open={sheet} onOpenChange={setSheet} title={c.name} side="bottom" className="project-sheet">
              <div className="sheet-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setSheet(false);
                    onHide(c);
                  }}
                >
                  <EyeOff {...ICON_SM} /> {t('candidates.hide')}
                </button>
              </div>
            </Sheet>
          </>
        ) : (
          <button type="button" className="icon-btn" aria-label={hideLabel} onClick={() => onHide(c)}>
            <EyeOff {...ICON_SM} />
          </button>
        )}
      </div>
    </li>
  );
}

/**
 * What chats have run in and no project holds: repositories first, one each, then the directories
 * that are not repositories, folded. A first start shows them as a card; with projects they are a
 * nudge that opens on request. Hiding takes one away at once and the toast brings it back.
 */
function Candidates({ candidates, first }: { candidates: ProjectCandidate[]; first: boolean }) {
  const { t } = useTranslation(['projects', 'work', 'common', 'config']);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [othersOpen, setOthersOpen] = useState(false);
  const listId = useId();
  const othersId = useId();
  const repositories = candidates.filter((c) => c.kind === 'repository');
  const directories = candidates.filter((c) => c.kind === 'directory');

  const unhide = useMutation({
    mutationFn: (key: string) => api.unhideProjectCandidate({ key }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: keys.projectCandidates }),
    onError: (error) => toast.error(t('candidates.unhideFailed'), error),
  });
  const hide = useMutation({
    mutationFn: (c: ProjectCandidate) => api.hideProjectCandidate({ key: c.key }),
    onMutate: (c) => {
      queryClient.setQueryData<ProjectCandidate[]>(keys.projectCandidates, (list) => list?.filter((x) => x.key !== c.key));
    },
    onSuccess: (_done, c) =>
      toast.show({ tone: 'ok', title: t('candidates.hidden'), detail: c.name, action: { label: t('candidates.undo'), onClick: () => unhide.mutate(c.key) } }),
    onError: (error) => toast.error(t('candidates.hideFailed'), error),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: keys.projectCandidates }),
  });

  const rows = (list: ProjectCandidate[]) => list.map((c) => <CandidateRow key={c.key} candidate={c} onHide={(x) => hide.mutate(x)} />);
  const others = directories.length > 0 && (
    <div className="candidate-others">
      <button type="button" className="candidate-others-toggle" aria-expanded={othersOpen} aria-controls={othersOpen ? othersId : undefined} onClick={() => setOthersOpen(!othersOpen)}>
        <ChevronRight {...ICON_SM} className="candidate-others-chevron" />
        {t('candidates.others', { n: formatNumber(directories.length) })}
      </button>
      {othersOpen && (
        <div id={othersId}>
          <p className="small muted candidate-others-body">{t('candidates.othersBody')}</p>
          <ul className="candidate-list">{rows(directories)}</ul>
        </div>
      )}
    </div>
  );
  const list = (
    <div id={listId}>
      {repositories.length > 0 && <ul className="candidate-list">{rows(repositories)}</ul>}
      {others}
    </div>
  );
  if (first) {
    return (
      <Card title={t('candidates.firstTitle')} className="project-candidates">
        <p className="muted">{t('candidates.firstBody')}</p>
        {list}
      </Card>
    );
  }
  return (
    <section className="project-callout">
      <div className="project-callout-head">
        <FolderOpen {...ICON} className="project-callout-icon" />
        <div className="project-callout-text">
          <h2 className="project-callout-title">
            {repositories.length > 0
              ? t('candidates.moreRepos', { count: repositories.length, n: formatNumber(repositories.length) })
              : t('candidates.moreTitle', { count: directories.length, n: formatNumber(directories.length) })}
          </h2>
          <p className="project-callout-body">{t('candidates.moreBody')}</p>
        </div>
        <button type="button" className="btn btn-small" aria-expanded={open} aria-controls={open ? listId : undefined} onClick={() => setOpen(!open)}>
          {open ? t('candidates.collapse') : t('candidates.review')}
        </button>
      </div>
      {open && list}
    </section>
  );
}

/**
 * Rename, remove and purge: a `⋯` menu on a desktop, a sheet of big buttons on a phone. The phone's
 * card keeps one button, so opening the project joins the sheet (MobileProyectos).
 */
function ProjectActions({ project, onRename, onRemove, onPurge }: { project: Project; onRename: () => void; onRemove: () => void; onPurge: () => void }) {
  const { t } = useTranslation(['projects', 'common']);
  const narrow = useMediaQuery(NARROW);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const label = t('card.actionsNamed', { name: project.name });

  if (narrow) {
    // The sheet closes before the action runs, so a confirmation dialog is not stacked over it
    const run = (action: () => void) => () => {
      setOpen(false);
      action();
    };
    return (
      <>
        <button type="button" className="icon-btn project-card-more" aria-label={label} onClick={() => setOpen(true)}>
          <Ellipsis {...ICON_SM} />
        </button>
        <Sheet open={open} onOpenChange={setOpen} title={label} side="bottom" className="project-sheet">
          <div className="sheet-actions">
            <Link to={`/?project=${encodeURIComponent(project.id)}`} className="btn">
              <FolderOpen {...ICON_SM} /> {t('common:actions.open')}
            </Link>
            <button type="button" className="btn" onClick={run(onRename)}>
              <Pencil {...ICON_SM} /> {t('card.rename')}
            </button>
            <button type="button" className="btn" onClick={run(onRemove)}>
              <X {...ICON_SM} /> {t('card.remove')}
            </button>
            <button type="button" className="btn btn-danger project-sheet-purge" onClick={run(onPurge)}>
              <span className="project-sheet-purge-label">
                <Trash2 {...ICON_SM} /> {t('card.purge')}
              </span>
              <span className="project-menu-hint">{t('card.purgeHint')}</span>
            </button>
          </div>
        </Sheet>
      </>
    );
  }

  const entries: MenuEntry[] = [
    { id: 'rename', label: t('card.rename'), icon: Pencil, onSelect: onRename },
    { id: 'remove', label: t('card.remove'), icon: X, onSelect: onRemove },
    { id: 'sep', separator: true },
    {
      id: 'purge',
      label: (
        <span className="project-menu-purge">
          {t('card.purge')}
          <span className="project-menu-hint">{t('card.purgeHint')}</span>
        </span>
      ),
      icon: Trash2,
      destructive: true,
      onSelect: onPurge,
    },
  ];
  return <Menu entries={entries} label={label} className="project-card-more" />;
}

function RenameForm({ initial, pending, onSave, onCancel }: { initial: string; pending: boolean; onSave: (name: string) => void; onCancel: () => void }) {
  const { t } = useTranslation(['projects', 'common', 'config']);
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  // The menu that opened this gives focus back to its trigger as it closes; this runs after it
  useEffect(() => {
    const id = window.setTimeout(() => input.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, []);
  return (
    <form
      className="rename-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onSave(value.trim());
      }}
    >
      <input ref={input} aria-label={t('card.nameLabel')} value={value} onChange={(e) => setValue(e.target.value)} />
      <button type="submit" className="btn btn-small btn-primary" disabled={!value.trim() || pending}>
        {t('config:shared.save')}
      </button>
      <button type="button" className="btn btn-small" onClick={onCancel}>
        {t('common:actions.cancel')}
      </button>
    </form>
  );
}

function ProjectCard({ project, active, live }: { project: Project; active: boolean; live: boolean }) {
  const { t } = useTranslation(['projects', 'work', 'common', 'config']);
  const refresh = useRefreshProjects();
  const confirm = useConfirm();
  const toast = useToast();
  const [renaming, setRenaming] = useState(false);

  const rename = useMutation({
    mutationFn: (name: string) => api.renameProject(project.id, name),
    onSuccess: () => {
      refresh();
      setRenaming(false);
    },
    onError: (error) => toast.error(t('card.renameFailed'), error),
  });
  const remove = useMutation({
    mutationFn: () => api.removeProject(project.id),
    onSuccess: () => {
      refresh();
      toast.success(t('card.removed', { name: project.name }), t('card.removedHint'));
    },
    onError: (error) => toast.error(t('card.removeFailed'), error),
  });
  const purge = useMutation({
    mutationFn: () => api.purgeProject(project.id),
    onSuccess: (done) => {
      refresh();
      toast.success(t('card.purged', { name: project.name }), done.detail);
    },
    onError: (error) => toast.error(t('card.purgeFailed'), error),
  });

  const askRemove = async () => {
    if (remove.isPending) return;
    const ok = await confirm({
      title: t('card.removeTitle', { name: project.name }),
      body: t('card.removeBody', { count: project.chatCount, n: formatNumber(project.chatCount) }),
      confirmLabel: t('card.removeConfirm'),
    });
    if (ok) remove.mutate();
  };
  const askPurge = async () => {
    if (purge.isPending) return;
    const ok = await confirm({
      title: t('card.purgeTitle', { name: project.name }),
      body: (
        <Trans
          t={t}
          i18nKey="card.purgeBody"
          count={project.chatCount}
          values={{ n: formatNumber(project.chatCount) }}
          components={{ code: <code />, strong: <strong /> }}
        />
      ),
      confirmLabel: t('card.purgeConfirm'),
      danger: true,
    });
    if (ok) purge.mutate();
  };

  const classes = ['card', 'project-card', active ? 'is-active grad-border glow-top' : '', project.exists ? '' : 'is-warn'].filter(Boolean).join(' ');
  return (
    <li className={classes} aria-current={active || undefined}>
      <div className="project-card-head">
        <Monogram name={project.name} size={40} project />
        <div className="project-card-id">
          {renaming ? (
            <RenameForm initial={project.name} pending={rename.isPending} onSave={(name) => rename.mutate(name)} onCancel={() => setRenaming(false)} />
          ) : (
            <h2 className="project-card-name">
              <FullText className="ellipsis">{project.name}</FullText>
              <WorkItemKey value={project.key} boxed />
              {!project.exists && <Tag tone="warn">{t('work:projects.missing')}</Tag>}
            </h2>
          )}
          <span className="mono project-card-path ellipsis" title={project.path}>
            {project.path}
          </span>
          <ModuleMarks modules={project.modules} className="project-card-modules" />
        </div>
        <ProjectActions project={project} onRename={() => setRenaming(true)} onRemove={() => void askRemove()} onPurge={() => void askPurge()} />
      </div>
      <dl className="project-card-stats">
        <div className="project-stat">
          <dt className="section-label">{t('card.stats.chats')}</dt>
          <dd className="project-stat-value">{formatNumber(project.chatCount)}</dd>
        </div>
        <div className="project-stat">
          <dt className="section-label">{t('card.stats.worktrees')}</dt>
          <dd className="project-stat-value">{formatNumber(project.worktrees.length)}</dd>
        </div>
        <div className="project-stat project-stat-activity">
          <dt className="section-label">{t('card.stats.activity')}</dt>
          {live ? (
            <dd className="project-stat-value is-live">
              <StatusDot tone="active" live />
              {t('common:time.now')}
            </dd>
          ) : (
            <dd className="project-stat-value is-quiet" title={project.lastActivity ? formatDateTime(project.lastActivity) : undefined}>
              {sinceShort(project.lastActivity)}
            </dd>
          )}
        </div>
      </dl>
      <div className="project-card-actions">
        {project.exists ? (
          <Link to={`/chats/new?cwd=${encodeURIComponent(project.path)}`} className="btn btn-small project-card-new" aria-label={t('worktrees.newChatIn', { name: project.name })}>
            {t('worktrees.newChatHere')}
          </Link>
        ) : (
          <button type="button" className="btn btn-small project-card-new" disabled>
            {t('worktrees.newChatHere')}
          </button>
        )}
        <Link to={`/?project=${encodeURIComponent(project.id)}`} className="btn btn-small project-card-open" aria-label={t('card.openNamed', { name: project.name })}>
          {t('common:actions.open')}
        </Link>
      </div>
    </li>
  );
}

/** How many projects a phone lists before it offers the search and the sort. */
const PHONE_TOOLBAR_FROM = 5;

export function Projects() {
  const { t } = useTranslation(['projects', 'work', 'common', 'config']);
  const narrow = useMediaQuery(NARROW);
  const { data, error, isLoading } = useProjects();
  const projects = data ?? [];
  // The card that stands out is the project the top bar has selected; with All projects none does
  const { projectId: activeId } = useProjectScope();
  // A project is live while a chat under it is working: that, and only that, gets the pinging dot
  const working = useChats({ state: 'working', origin: ['claudio', 'external', 'orchestration'] });
  const liveIds = new Set((working.data ?? []).flatMap((chat) => (chat.project ? [chat.project.id] : [])));
  // Candidates are always there to offer; the page decides how loudly, and only asks once it knows
  const candidates = useProjectCandidates(!isLoading);
  const offered = candidates.data ?? [];
  const first = !isLoading && projects.length === 0;
  const listState = useListParams('projects', LIST_PARAMS, GLOBAL_SCOPE);
  // On a phone a handful of cards is read at a glance; the search and the sort come with a longer list
  const toolbar = !narrow || projects.length >= PHONE_TOOLBAR_FROM;
  // A search kept from a longer list must not hide cards behind a toolbar that is not there
  const search = toolbar ? (listState.params.get('q') ?? '') : '';
  const sort = (toolbar && PROJECT_SORTS.find((s) => s === listState.params.get('sort'))) || 'activity';
  const shown = projects.filter((project) => matchesText(search, [project.name, project.path])).sort(PROJECT_SORTERS[sort]);
  const newButton = (primary: boolean) => (
    <Link to={NEW_PROJECT_PATH} className={primary ? 'btn btn-primary' : 'btn'}>
      <FolderPlus {...ICON_SM} />
      {t('work:projects.newProject')}
    </Link>
  );
  // One primary per zone: while the empty state offers the import, the header's copy steps back
  const emptyShown = first && offered.length === 0;

  return (
    <>
      <PageHeader
        title={t('work:projects.title')}
        // A phone's header is its title and its actions (MobileProyectos); the count is the cards themselves
        subtitle={narrow ? undefined : t('page.subtitle', { count: projects.length, n: formatNumber(projects.length) })}
        actions={newButton(!emptyShown)}
        // MobileProyectos: the title and a new project, the FAB below starting a chat
        phone={{
          actions: (
            <Link to={NEW_PROJECT_PATH} className="icon-btn" aria-label={t('work:projects.newProject')}>
              <FolderPlus {...ICON} />
            </Link>
          ),
        }}
      />
      <ErrorBox error={error} />
      {isLoading ? (
        <Loading />
      ) : projects.length === 0 ? (
        offered.length === 0 && (
          <Empty illustration="projects" size={narrow ? 'sm' : undefined} title={t('work:projects.empty')} action={newButton(true)}>
            {t('page.emptyHint')}
          </Empty>
        )
      ) : (
        <div>
          {toolbar && (
            <ListToolbar
              search={{ value: search, onChange: (value) => listState.patch({ q: value }), placeholder: t('list.searchPlaceholder'), label: t('list.searchLabel') }}
              sort={{ value: sort, options: PROJECT_SORTS.map((value) => ({ value, label: t(`list.sort.${value}`) })), onChange: (v) => listState.patch({ sort: v === 'activity' ? null : v }), label: t('list.sortLabel') }}
              onReset={listState.reset}
              active={search !== '' || sort !== 'activity'}
            />
          )}
          {shown.length === 0 ? (
            <Empty illustration="no-results" size={narrow ? 'sm' : undefined} title={t('list.noneMatch')}>
              {t('list.noneMatchHint')}
            </Empty>
          ) : (
            <ul className="project-grid">
              {shown.map((project) => (
                <ProjectCard key={project.id} project={project} active={project.id === activeId} live={liveIds.has(project.id)} />
              ))}
            </ul>
          )}
        </div>
      )}
      {offered.length > 0 && <Candidates candidates={offered} first={first} />}
    </>
  );
}
