import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { SquareTerminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import type { Terminal, TerminalStatus as TerminalStatusInfo } from '@claudio/shared';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Empty, ErrorBox, PageHeader, Skeleton } from '@claudio/ui/components/ui';
import { COMPACT, useMediaQuery } from '@claudio/ui/lib/media';
import { api, keys } from '../api';
import { PhoneHeader, useOwnPhoneHeader } from '../components/shell/PhoneHeader';
import { TerminalPanel } from '../components/terminal/TerminalPanel';
import { NewTerminal } from '../components/terminal/NewTerminal';
import { TerminalStatus as TerminalStatusWord } from '../components/terminal/TerminalStatus';
import { useTerminalBar } from '../components/terminal/terminal-bar';
import { baseName, requestFor, tabLabels, unavailableKey } from '../components/terminal/terminal-model';
import { terminalPath } from '../components/terminal/terminal-path';
import { useCloseTerminal, useOpenTerminal, useTerminalList, useTerminalStatus } from '../components/terminal/use-terminals';
import { useProjectScope } from '../lib/project-scope';

/** The feature is there but cannot be opened from here and now: the reason, and where it is changed. */
function Unavailable({ status }: { status: TerminalStatusInfo | undefined }) {
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

/**
 * `/terminals`. A desktop has one entry point, the status bar's Terminal item, so an old bookmark
 * shows that panel and goes home; a phone has no status bar and this is its list of terminals.
 */
export function Terminals() {
  const compact = useMediaQuery(COMPACT);
  return compact ? <MobileTerminals /> : <ShowPanel />;
}

function ShowPanel() {
  const status = useTerminalStatus();
  const { show } = useTerminalBar();
  const available = status.data?.available === true;
  useEffect(() => {
    if (available) show();
  }, [available, show]);
  if (status.isLoading) return <Skeleton rows={4} height={14} />;
  return <Navigate to="/" replace />;
}

/** The phone's terminals: the open ones as rows that lead to their own screen, and a way to open another. */
function MobileTerminals() {
  const { t } = useTranslation('terminal');
  const ownHeader = useOwnPhoneHeader();
  const { project, projects } = useProjectScope();
  const status = useTerminalStatus();
  const available = status.data?.available === true;
  const { terminals, isLoading, error } = useTerminalList({ all: true }, available);
  const navigate = useNavigate();
  const open = useOpenTerminal((terminal) => navigate(terminalPath(terminal.id)));
  const names = tabLabels(terminals, (id) => projects.find((each) => each.id === id)?.name);
  const title = t('page.title');

  return (
    <div>
      {ownHeader ? <PhoneHeader title={title} /> : <PageHeader title={title} />}
      <ErrorBox error={status.error ?? error} />
      {status.isLoading ? (
        <Skeleton rows={4} height={14} />
      ) : !available ? (
        <Unavailable status={status.data} />
      ) : (
        <>
          <NewTerminal project={project} projects={projects} pending={open.isPending} onOpen={(request) => open.mutate(request)} />
          {isLoading ? (
            <Skeleton rows={3} height={14} />
          ) : terminals.length === 0 ? (
            <p className="muted small">{t('list.none')}</p>
          ) : (
            <ul className="term-list">
              {terminals.map((terminal) => (
                <li key={terminal.id}>
                  <Link to={terminalPath(terminal.id)} className="term-row">
                    <SquareTerminal {...ICON_SM} aria-hidden />
                    <span className="ellipsis">{names.get(terminal.id)}</span>
                    <TerminalStatusWord terminal={terminal} link="ended" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
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
  const leave = (from: Terminal) => navigate(from.scope.kind === 'chat' ? `/chats/${encodeURIComponent(from.scope.chatId)}` : '/terminals');
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
          onReopen={() => open.mutate(requestFor(terminal))}
          onClose={() => close.mutate(terminal.id, { onSuccess: () => leave(terminal) })}
        />
      )}
    </div>
  );
}
