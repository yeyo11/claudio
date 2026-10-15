import { useQuery } from '@tanstack/react-query';
import { Info, SquareTerminal, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Terminal, TerminalStatus } from '@claudio/shared';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Empty, ErrorBox, PageHeader, Skeleton } from '@claudio/ui/components/ui';
import { COMPACT, useMediaQuery } from '@claudio/ui/lib/media';
import { api, keys } from '../api';
import { PhoneHeader, useOwnPhoneHeader } from '../components/shell/PhoneHeader';
import { TerminalPanel } from '../components/terminal/TerminalPanel';
import { TerminalWorkspace } from '../components/terminal/TerminalWorkspace';
import { baseName, unavailableKey } from '../components/terminal/terminal-model';
import { terminalPath } from '../components/terminal/use-dock';
import { useCloseTerminal, useOpenTerminal, useTerminalStatus } from '../components/terminal/use-terminals';
import { useProjectScope } from '../lib/project-scope';

/**
 * What limits the terminal, said once on the page that opens one: this machine only, the tunnel with
 * a token, or any device with a token (which is the one that warns).
 */
function Limits({ status }: { status: TerminalStatus }) {
  const { t } = useTranslation('terminal');
  const wide = status.settings.remote === 'any';
  const Icon = wide ? TriangleAlert : Info;
  return (
    <p className={wide ? 'term-note' : 'term-note term-limits small muted'}>
      <Icon {...ICON_SM} aria-hidden />
      {t(`limits.${status.settings.remote}`)}
    </p>
  );
}

/** The feature is there but cannot be opened from here and now: the reason, and where it is changed. */
function Unavailable({ status }: { status: TerminalStatus | undefined }) {
  const { t } = useTranslation('terminal');
  return (
    <Empty icon={SquareTerminal} title={t('unavailable.title')}>
      <p>{status?.reason ? t(unavailableKey(status.reason)) : t('unavailable.unknown')}</p>
      <Link to="/settings?tab=security" className="btn btn-small">
        {t('unavailable.settings')}
      </Link>
    </Empty>
  );
}

/** A project's terminals (`/terminals?project=<id>`): tabs, a New terminal button and the open one in its frame. */
export function Terminals() {
  const { t } = useTranslation('terminal');
  const compact = useMediaQuery(COMPACT);
  const ownHeader = useOwnPhoneHeader();
  const { project, ready } = useProjectScope();
  const status = useTerminalStatus();
  const title = t('page.title');
  const header = ownHeader ? (
    <PhoneHeader title={title} subtitle={project?.name} />
  ) : (
    <PageHeader title={title} subtitle={project ? <span className="mono">{project.path}</span> : undefined} />
  );

  return (
    // Bounded by the page (terminal.css, `.term-page`): the screen inside takes the room left, it does not grow the page
    <div className="term-page">
      {header}
      <ErrorBox error={status.error} />
      {status.isLoading || (!ready && !project) ? (
        <Skeleton rows={4} height={14} />
      ) : !status.data?.available ? (
        <Unavailable status={status.data} />
      ) : !project ? (
        <Empty icon={SquareTerminal} title={t('page.noProject')}>
          <Link to="/projects" className="btn btn-small">
            {t('page.projects')}
          </Link>
        </Empty>
      ) : (
        <>
          <Limits status={status.data} />
          <TerminalWorkspace
            scope={{ project: project.id }}
            request={(worktree) => ({ projectId: project.id, ...(worktree ? { worktree } : {}) })}
            worktrees={project.worktrees}
            compact={compact}
          />
        </>
      )}
    </div>
  );
}

/** One terminal on a screen of its own (`/terminals/:id`): what a phone opens, with the key bar above the keyboard. */
export function TerminalScreen() {
  const { t } = useTranslation('terminal');
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const compact = useMediaQuery(COMPACT);
  const ownHeader = useOwnPhoneHeader();
  const status = useTerminalStatus();
  const one = useQuery({ queryKey: keys.terminalOne(id), queryFn: ({ signal }) => api.terminal(id, { signal }) });
  const terminal = one.data;
  const leave = (from: Terminal) => navigate(from.scope.kind === 'chat' ? `/chats/${encodeURIComponent(from.scope.chatId)}` : `/terminals?project=${encodeURIComponent(from.scope.projectId)}`);
  const open = useOpenTerminal((next) => navigate(terminalPath(next.id), { replace: true }));
  const close = useCloseTerminal();

  const name = terminal ? baseName(terminal.cwd) : t('page.title');
  const header = ownHeader ? (
    <PhoneHeader title={name} subtitle={terminal?.cwd} back={terminal ? { onBack: () => leave(terminal) } : undefined} />
  ) : (
    <PageHeader title={name} subtitle={terminal ? <span className="mono">{terminal.cwd}</span> : undefined} />
  );

  return (
    <div className="term-page">
      {header}
      {one.isLoading || status.isLoading ? (
        <Skeleton rows={4} height={14} />
      ) : !status.data?.available ? (
        <Unavailable status={status.data} />
      ) : !terminal ? (
        <>
          <ErrorBox error={one.error} />
          <Empty icon={SquareTerminal} title={t('page.notFound')} />
        </>
      ) : (
        <TerminalPanel
          // The same terminal read again is the same xterm
          key={terminal.id}
          terminal={terminal}
          compact={compact}
          onEnded={() => void one.refetch()}
          onReopen={() => open.mutate(terminal.scope.kind === 'chat' ? { chatId: terminal.scope.chatId } : { projectId: terminal.scope.projectId, ...(terminal.scope.worktree ? { worktree: terminal.scope.worktree } : {}) })}
          onClose={() => close.mutate(terminal.id, { onSuccess: () => leave(terminal) })}
        />
      )}
    </div>
  );
}
