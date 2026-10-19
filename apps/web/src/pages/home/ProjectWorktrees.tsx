import type { Project, ProjectWorktree, WorktreeCreator } from '@claudio/shared';
import { GitBranch, Lock, MessageSquarePlus, MessagesSquare, SquareKanban, Workflow } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Card, Empty } from '@claudio/ui/components/ui';
import { formatNumber, timeAgo } from '@claudio/ui/lib/format';
import { taskPath } from '../../lib/work-items';

/** Who made the worktree, as a link to what they made it for; one made by hand has no line at all. */
function Creator({ creator }: { creator: WorktreeCreator }) {
  const { t } = useTranslation('projects');
  if (creator.kind === 'orchestration') {
    return (
      <Link to={`/orchestration/${encodeURIComponent(creator.orchestrationId)}`} className="meta-icon">
        <Workflow size={12} strokeWidth={1.75} aria-hidden /> {creator.orchestrationName} · {creator.taskName}
      </Link>
    );
  }
  if (creator.kind === 'work-item') {
    return (
      <Link to={taskPath(creator.key)} className="meta-icon">
        <SquareKanban size={12} strokeWidth={1.75} aria-hidden /> {creator.title ? t('worktrees.creatorTask', { key: creator.key, title: creator.title }) : creator.key}
      </Link>
    );
  }
  return (
    <Link to={`/chats/${encodeURIComponent(creator.chatId)}`} className="meta-icon">
      <MessagesSquare size={12} strokeWidth={1.75} aria-hidden /> {creator.title ? t('worktrees.creatorChat', { title: creator.title }) : t('worktrees.chatOnly')}
    </Link>
  );
}

/** One checkout of the repository: its branch, who made it, how much work ran in it, and a way into a chat there. */
function WorktreeRow({ project, worktree }: { project: Project; worktree: ProjectWorktree }) {
  const { t } = useTranslation('projects');
  const name = worktree.branch ?? worktree.name ?? worktree.path;
  const chats = `/chats?project=${encodeURIComponent(project.id)}&worktree=${encodeURIComponent(worktree.path)}`;
  return (
    <li className={`worktree-row ${worktree.main ? 'is-main' : ''}`}>
      <div className="worktree-main">
        <span className="worktree-branch">
          <GitBranch {...ICON_SM} />
          {worktree.detached ? (
            <>
              <span className="badge badge-muted">{t('worktrees.detached')}</span>
              {worktree.name && <span className="mono break">{worktree.name}</span>}
            </>
          ) : (
            <span className="mono break">{name}</span>
          )}
          {worktree.main && <span className="badge badge-muted">{t('worktrees.main')}</span>}
          {worktree.locked !== null && (
            <span className="badge badge-muted">
              <Lock {...ICON_SM} aria-hidden /> {t('worktrees.locked')}
            </span>
          )}
        </span>
        <span className="small muted mono break">{worktree.path}</span>
        {worktree.locked && <span className="small muted break worktree-locked-reason">{worktree.locked}</span>}
        {worktree.createdBy && (
          <span className="small muted meta">
            <Creator creator={worktree.createdBy} />
          </span>
        )}
        {worktree.chatCount > 0 && (
          <span className="small muted tnum">
            <Link to={chats} className="worktree-chats">
              {t('worktrees.chatsMeta', { count: worktree.chatCount, n: formatNumber(worktree.chatCount) })}
              {worktree.lastActivity ? ` · ${timeAgo(worktree.lastActivity)}` : ''}
            </Link>
          </span>
        )}
      </div>
      {/* The header's New chat is the main checkout's */}
      {!worktree.main && (
        <div className="worktree-tags">
          <Link to={`/chats/new?cwd=${encodeURIComponent(worktree.cwd)}`} className="btn btn-small worktree-new" aria-label={t('worktrees.newChatIn', { name })}>
            <MessageSquarePlus {...ICON_SM} /> {t('worktrees.newChatHere')}
          </Link>
        </div>
      )}
    </li>
  );
}

/** The project's repository: its main checkout first, then every linked worktree git has, by last activity. */
export function ProjectWorktrees({ project }: { project: Project }) {
  const { t } = useTranslation('projects');
  const main = project.worktrees.find((w) => w.main);
  const linked = project.worktrees
    .filter((w) => !w.main)
    .sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? '') || a.path.localeCompare(b.path));
  return (
    <Card
      title={t('worktrees.title')}
      actions={
        <Link to={`/chats?project=${encodeURIComponent(project.id)}`} className="btn btn-small">
          <MessagesSquare {...ICON_SM} /> {t('worktrees.chats')}
        </Link>
      }
    >
      {!project.repo ? (
        <Empty title={t('worktrees.notRepo')} illustration="projects" />
      ) : (
        <>
          <ul className="worktree-list">
            {main && <WorktreeRow project={project} worktree={main} />}
            {linked.map((worktree) => (
              <WorktreeRow key={worktree.path} project={project} worktree={worktree} />
            ))}
          </ul>
          {linked.length === 0 && (
            <Empty title={t('worktrees.emptyTitle')} illustration="projects">
              <Trans t={t} i18nKey="worktrees.emptyBody" components={{ mono: <span className="mono" /> }} />
            </Empty>
          )}
          {project.removedWorktrees > 0 && (
            <p className="small muted worktree-removed">
              <Link to={`/chats?project=${encodeURIComponent(project.id)}&worktree=removed`}>
                {t('worktrees.removed', { count: project.removedWorktrees, n: formatNumber(project.removedWorktrees) })}
              </Link>
            </p>
          )}
        </>
      )}
    </Card>
  );
}
