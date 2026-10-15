import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useToast } from '@claudio/ui/components/Toast';
import { COMPACT, useMediaQuery } from '@claudio/ui/lib/media';
import { api } from '../../api';
import { BAR_OPEN_KEY, DOCK_KEY, readPref, writePref } from './terminal-prefs';
import { useTerminalAccess } from './use-terminals';

/*
 * The terminal panel docked above the status bar. The app shell owns its state, so it is the same
 * panel on every page: the status bar's Terminal item, the chat header's button and Ctrl+` all
 * drive this one. What is open and how tall is remembered in this browser.
 */

export const MIN_HEIGHT = 160;
export const DEFAULT_HEIGHT = 280;
/** What the page keeps above the panel, as a share of the window */
const MAX_SHARE = 0.7;

export const heightLimit = (): number => Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * MAX_SHARE));
export const clampHeight = (height: number): number => Math.min(heightLimit(), Math.max(MIN_HEIGHT, Math.round(height)));

function storedHeight(): number {
  const value = Number(readPref(DOCK_KEY));
  return Number.isFinite(value) && value > 0 ? clampHeight(value) : DEFAULT_HEIGHT;
}

export interface TerminalBar {
  /** Whether a terminal may be opened from here and now: everything else is hidden without it */
  available: boolean;
  /** The panel is shown: open, available and on a screen with room for it */
  open: boolean;
  height: number;
  setHeight: (height: number) => void;
  /** The tab in front; the panel falls back to the first when it is gone */
  selectedId: string | null;
  select: (id: string) => void;
  toggle: () => void;
  show: () => void;
  hide: () => void;
  /** Set when the person opened the panel: with a project chosen and nothing running, the panel opens a shell once */
  wantsShell: boolean;
  shellOpened: () => void;
  /** Shows the panel on the chat's terminal, opening one in the chat's directory when it has none */
  openChat: (chatId: string) => Promise<void>;
}

const Context = createContext<TerminalBar | null>(null);

export function TerminalBarProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation('terminal');
  const available = useTerminalAccess();
  const compact = useMediaQuery(COMPACT);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [wanted, setWanted] = useState(() => readPref(BAR_OPEN_KEY) === '1');
  const [height, setHeightState] = useState(storedHeight);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [wantsShell, setWantsShell] = useState(false);

  const setOpen = useCallback((next: boolean, fresh = false) => {
    setWanted(next);
    writePref(BAR_OPEN_KEY, next ? '1' : '0');
    if (next && fresh) setWantsShell(true);
  }, []);
  const toggle = useCallback(() => setOpen(!wanted, true), [wanted, setOpen]);
  const show = useCallback(() => setOpen(true, true), [setOpen]);
  const hide = useCallback(() => setOpen(false), [setOpen]);
  const setHeight = useCallback((next: number) => {
    const clamped = clampHeight(next);
    setHeightState(clamped);
    writePref(DOCK_KEY, String(clamped));
  }, []);
  const shellOpened = useCallback(() => setWantsShell(false), []);

  const openChat = useCallback(
    async (chatId: string) => {
      try {
        const running = (await api.terminals({ chat: chatId })).find((terminal) => terminal.state === 'running');
        const terminal = running ?? (await api.createTerminal({ chatId }));
        void queryClient.invalidateQueries({ queryKey: ['terminal', 'list'] });
        setSelectedId(terminal.id);
        setOpen(true);
      } catch (error) {
        toast.error(t('notices.openFailed'), error);
      }
    },
    [queryClient, setOpen, toast, t],
  );

  // A window that shrinks must not leave a panel taller than the room
  useEffect(() => {
    const onResize = () => setHeightState((now) => clampHeight(now));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const usable = available && !compact;
  useEffect(() => {
    if (!usable) return;
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
  }, [usable, toggle]);

  const value = useMemo<TerminalBar>(
    () => ({ available, open: wanted && usable, height, setHeight, selectedId, select: setSelectedId, toggle, show, hide, wantsShell, shellOpened, openChat }),
    [available, wanted, usable, height, setHeight, selectedId, toggle, show, hide, wantsShell, shellOpened, openChat],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useTerminalBar(): TerminalBar {
  const value = useContext(Context);
  if (!value) throw new Error('useTerminalBar needs a TerminalBarProvider above it');
  return value;
}
