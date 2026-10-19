import { useEffect } from 'react';
import { SquareTerminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Empty, ErrorBox, Skeleton } from '@claudio/ui/components/ui';
import { useProjects } from '../api';
import { TerminalPanel } from '../components/terminal/TerminalPanel';
import { baseName, requestFor, tabLabels } from '../components/terminal/terminal-model';
import { terminalWindowPath, useWindowPresence } from '../components/terminal/terminal-window';
import { useCloseTerminal, useOpenTerminal, useTerminalOne, useTerminalStatus } from '../components/terminal/use-terminals';
import { Unavailable } from './Terminals';

/**
 * `/terminal-window/:id`: one terminal and nothing else, for the window a person detached it into.
 * It attaches to the same shell as the panel does, through the same ticket and socket, so what is
 * typed here and there is one shell. Closing the window leaves the shell running.
 */
export function TerminalWindow({ id }: { id: string }) {
  const { t } = useTranslation('terminal');
  const navigate = useNavigate();
  const status = useTerminalStatus();
  const projects = useProjects();
  const one = useTerminalOne(id);
  const { terminal } = one;
  const open = useOpenTerminal((next) => navigate(terminalWindowPath(next.id), { replace: true }));
  const close = useCloseTerminal();
  useWindowPresence(id);

  const name = terminal ? (tabLabels([terminal], (projectId) => projects.data?.find((each) => each.id === projectId)?.name, t('new.workspace')).get(terminal.id) ?? baseName(terminal.cwd)) : null;
  // The window's title is what the window manager and the desktop app show
  useEffect(() => {
    document.title = `${t('page.windowTitle')} — ${name ?? ''}`.replace(/ — $/, '');
  }, [t, name]);

  return (
    <div className="term-window">
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
          key={terminal.id}
          terminal={terminal}
          compact={false}
          autoFocus
          onEnded={(reason) => {
            // Closed by a person elsewhere: the server forgot the id, so the window says so instead of asking for it
            if (reason === 'closed') one.forget();
            else void one.refetch();
          }}
          onReopen={() => open.mutate(requestFor(terminal))}
          onClose={() => {
            one.forget();
            close.mutate(terminal.id, { onSuccess: () => window.close(), onError: one.remember });
          }}
        />
      )}
    </div>
  );
}
