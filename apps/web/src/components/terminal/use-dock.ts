import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useToast } from '@claudio/ui/components/Toast';
import { COMPACT, useMediaQuery } from '@claudio/ui/lib/media';
import { api } from '../../api';
import { useTerminalBar } from './terminal-bar';
import { useTerminalList } from './use-terminals';

/** The terminal's address on a phone: a screen of its own, like a chat. */
export const terminalPath = (id: string) => `/terminals/${encodeURIComponent(id)}`;

/** A project's terminals: the page with its tabs. */
export const projectTerminalsPath = (projectId: string) => `/terminals?project=${encodeURIComponent(projectId)}`;

/**
 * The chat page's terminal button. Where a terminal cannot be opened there is no button
 * (`available` is false). On a desktop it shows the app's terminal panel on a terminal in the chat's
 * directory, opening one when the chat has none, and hides the panel when that terminal is in front;
 * on a phone it goes to the terminal's own screen.
 */
export function useTerminalDock(chatId: string) {
  const { t } = useTranslation('terminal');
  const bar = useTerminalBar();
  const compact = useMediaQuery(COMPACT);
  const navigate = useNavigate();
  const toast = useToast();
  const { terminals } = useTerminalList({ chat: chatId }, bar.available && bar.open);
  const showing = bar.open && terminals.some((terminal) => terminal.id === bar.selectedId);

  const { hide, openChat } = bar;
  const toggle = useCallback(() => {
    if (!compact) {
      if (showing) hide();
      else void openChat(chatId);
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
  }, [compact, showing, hide, openChat, chatId, navigate, toast, t]);

  return { available: bar.available, open: showing, toggle };
}
