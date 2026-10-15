import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useToast } from '@claudio/ui/components/Toast';
import { COMPACT, useMediaQuery } from '@claudio/ui/lib/media';
import { api } from '../../api';
import { useTerminalAccess } from './use-terminals';

/** The terminal's address on a phone: a screen of its own, like a chat. */
export const terminalPath = (id: string) => `/terminals/${encodeURIComponent(id)}`;

/** A project's terminals: the page with its tabs. */
export const projectTerminalsPath = (projectId: string) => `/terminals?project=${encodeURIComponent(projectId)}`;

/**
 * The chat page's terminal button and shortcut. Where a terminal cannot be opened there is no button
 * (`available` is false). On a desktop it toggles the dock; on a phone it goes to the terminal's own
 * screen, opening a shell in the chat's directory when none is running.
 */
export function useTerminalDock(chatId: string) {
  const { t } = useTranslation('terminal');
  const available = useTerminalAccess();
  const compact = useMediaQuery(COMPACT);
  const navigate = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState(false);

  // Another chat starts with the dock shut
  useEffect(() => setOpen(false), [chatId]);

  const toggle = useCallback(() => {
    if (!compact) {
      setOpen((now) => !now);
      return;
    }
    void (async () => {
      try {
        const running = (await api.terminals({ chat: chatId })).find((terminal) => terminal.state === 'running');
        const terminal = running ?? (await api.createTerminal({ chatId }));
        navigate(terminalPath(terminal.id));
      } catch (error) {
        toast.error(t('notices.openFailed'), error);
      }
    })();
  }, [compact, chatId, navigate, toast, t]);

  useEffect(() => {
    if (!available) return;
    const onKey = (event: KeyboardEvent) => {
      // The terminal's own key handler already took it, and toggled
      if (event.defaultPrevented) return;
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
      if (event.key !== '`' && event.code !== 'Backquote') return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [available, toggle]);

  return { available, open: open && !compact, toggle, close: () => setOpen(false) };
}
