import { ClipboardPaste, Copy, Search } from 'lucide-react';
import type { TFunction } from 'i18next';
import type { MenuItem } from '@claudio/ui/components/controls/Menu';

/** The shortcuts of the three entries, as the terminal's key handler binds them */
export const TERMINAL_SHORTCUTS = { copy: 'Ctrl+Shift+C', paste: 'Ctrl+Shift+V', search: 'Ctrl+Shift+F' } as const;

export interface TerminalEntryOptions {
  t: TFunction<'terminal'>;
  /** The shell is live: an ended one takes no paste */
  running: boolean;
  /**
   * The screen still shows the shell's output: an ended terminal keeps its last screen, which can be
   * copied from and searched (as its keys already do). Defaults to `running`.
   */
  readable?: boolean;
  /** A phone shows no shortcuts: it has no keyboard chords to press */
  compact: boolean;
  /**
   * Whether text is selected, when it is known (a right click reads it). `undefined` leaves Copy
   * enabled: the `⋯` is opened without looking at the screen, and Copy answers "Nothing is selected".
   */
  hasSelection?: boolean;
  onCopy: () => void;
  onPaste: () => void;
  onSearch: () => void;
}

/**
 * Copy, Paste and Search: the entries the right-click menu and the head of the panel's `⋯` menu
 * share, so the two cannot drift apart in names, order, shortcuts or when they are off.
 */
export function terminalEntries({ t, running, readable = running, compact, hasSelection, onCopy, onPaste, onSearch }: TerminalEntryOptions): MenuItem[] {
  const nothingToCopy = readable && hasSelection === false;
  return [
    {
      id: 'copy',
      label: t('menu.copy'),
      icon: Copy,
      onSelect: onCopy,
      shortcut: compact ? undefined : TERMINAL_SHORTCUTS.copy,
      disabled: !readable || nothingToCopy,
      disabledReason: !readable ? t('menu.ended') : nothingToCopy ? t('menu.copyNone') : undefined,
    },
    {
      id: 'paste',
      label: t('menu.paste'),
      icon: ClipboardPaste,
      onSelect: onPaste,
      shortcut: compact ? undefined : TERMINAL_SHORTCUTS.paste,
      disabled: !running,
      disabledReason: running ? undefined : t('menu.ended'),
    },
    {
      id: 'search',
      label: t('menu.search'),
      icon: Search,
      onSelect: onSearch,
      shortcut: compact ? undefined : TERMINAL_SHORTCUTS.search,
      disabled: !readable,
      disabledReason: readable ? undefined : t('menu.ended'),
    },
  ];
}
