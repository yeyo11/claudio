import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { SquareTerminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Empty, ErrorBox, Skeleton } from '@claudio/ui/components/ui';
import { api, keys, useProjects } from '../api';
import { TerminalPanel } from '../components/terminal/TerminalPanel';
import { baseName, requestFor, tabLabels } from '../components/terminal/terminal-model';
import { terminalWindowPath, useWindowPresence } from '../components/terminal/terminal-window';
import { useCloseTerminal, useOpenTerminal, useTerminalStatus } from '../components/terminal/use-terminals';
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
  const one = useQuery({ queryKey: keys.terminalOne(id), queryFn: ({ signal }) => api.terminal(id, { signal }) });
  const terminal = one.data;
  const open = useOpenTerminal((next) => navigate(terminalWindowPath(next.id), { replace: true }));
  const close = useCloseTerminal();
  useWindowPresence(id);

  const name = terminal ? (tabLabels([terminal], (projectId) => projects.data?.find((each) => each.id === projectId)?.name).get(terminal.id) ?? baseName(terminal.cwd)) : null;
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
          onEnded={() => void one.refetch()}
          onReopen={() => open.mutate(requestFor(terminal))}
          onClose={() => close.mutate(terminal.id, { onSuccess: () => window.close() })}
        />
      )}
    </div>
  );
}
