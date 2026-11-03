import { CaseSensitive, ChevronDown, ChevronUp, ExternalLink, Maximize2, Minimize2, Minus, Plus, Regex, RotateCcw, Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Terminal } from '@claudio/shared';
import { PointerMenu, type MenuEntry } from '@claudio/ui/components/controls/Menu';
import { MoreActions } from '@claudio/ui/components/controls/MoreActions';
import { Tooltip } from '@claudio/ui/components/controls/Tooltip';
import { ICON_SM } from '@claudio/ui/components/icons';
import { useToast } from '@claudio/ui/components/Toast';
import { useDecorativeMotion } from '@claudio/ui/lib/motion';
import { KeyBar, type Modifiers } from './KeyBar';
import { TerminalView, type TerminalEndedBy, type TerminalViewHandle } from './TerminalView';
import { TerminalStatus } from './TerminalStatus';
import { terminalEntries } from './terminal-entries';
import { baseName, withModifiers, type LinkState } from './terminal-model';
import { clampFont, useScreenReaderMode, useTerminalFont } from './terminal-prefs';
import { useFullscreen } from './terminal-window';

/**
 * One terminal in its frame: the header (status, title, search, ⋯), the screen and, on a phone, the
 * key bar. The frame has no gradient and no energy border: a shell is not an agent working.
 */
export function TerminalPanel({
  terminal,
  compact,
  onReopen,
  onClose,
  onToggle,
  onLink,
  onEnded,
  autoFocus = false,
  onFocused,
  onDetach,
}: {
  terminal: Terminal;
  compact: boolean;
  onReopen: () => void;
  onClose: () => void;
  /** The dock's `Ctrl+\`` */
  onToggle?: () => void;
  onLink?: (link: LinkState) => void;
  /** Takes the keyboard once attached: the person just opened this terminal */
  autoFocus?: boolean;
  onFocused?: () => void;
  /** Opens this terminal in a window of its own; only where that is offered (the panel on a desktop) */
  onDetach?: () => void;
  /** The shell ended or the server closed it, and why: `closed` means the id is gone for good */
  onEnded: (reason: TerminalEndedBy) => void;
}) {
  const { t } = useTranslation('terminal');
  const toast = useToast();
  const view = useRef<TerminalViewHandle>(null);
  const frame = useRef<HTMLElement>(null);
  const fullscreen = useFullscreen(frame);
  const [link, setLink] = useState<LinkState>('connecting');
  const [title, setTitle] = useState('');
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  // Where a right click opened the menu, and whether text was selected then
  const [pointer, setPointer] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null);
  // The search field takes the keyboard itself: the menu must not hand it back to the screen
  const searchTakesFocus = useRef(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const pressedOutside = useRef(false);
  const [mods, setMods] = useState<Modifiers>({ ctrl: false, alt: false });
  const font = useTerminalFont(compact);
  const [screenReader] = useScreenReaderMode();
  const blink = useDecorativeMotion();
  // A terminal that was live when it opened stays on screen after it ends, so the last of its output can be read
  const wasLive = useRef(terminal.state === 'running');
  if (terminal.state === 'running') wasLive.current = true;
  const running = terminal.state === 'running';

  // Once attached, so the first keys land in the shell; never on a page load, which is not the person's doing
  useEffect(() => {
    if (!autoFocus || link !== 'open') return;
    view.current?.focus();
    onFocused?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus, link]);

  const setLinkState = (next: LinkState) => {
    setLink(next);
    onLink?.(next);
  };
  const options = { caseSensitive, regex };
  const find = (backwards: boolean) => {
    if (!view.current?.find(query, options, backwards) && query) toast.info(t('search.none'));
  };
  const closeSearch = () => {
    setSearching(false);
    view.current?.clearFind();
    view.current?.focus();
  };

  const copy = async () => {
    if (await view.current?.copySelection()) toast.success(t('notices.copied'));
    // Says how to select: a phone has no drag, and a long press is what it knows
    else toast.info(t(compact ? 'notices.nothingSelectedTouch' : 'notices.nothingSelected'));
  };

  // The socket goes before the request does, so it cannot reconnect to a terminal the server is forgetting
  const close = () => {
    view.current?.forget();
    onClose();
  };

  const shared = (hasSelection?: boolean) =>
    terminalEntries({
      t,
      running,
      compact,
      hasSelection,
      onCopy: () => void copy(),
      onPaste: () => void view.current?.paste(),
      onSearch: () => {
        searchTakesFocus.current = true;
        setSearching(true);
      },
    });

  const entries: MenuEntry[] = [
    ...shared(),
    { id: 'font-up', label: t('menu.fontUp', { size: clampFont(font.size + 1) }), icon: Plus, onSelect: () => font.set(font.size + 1) },
    { id: 'font-down', label: t('menu.fontDown', { size: clampFont(font.size - 1) }), icon: Minus, onSelect: () => font.set(font.size - 1) },
    { id: 'close', label: t('menu.close'), icon: X, destructive: true, onSelect: close },
  ];

  const head = (
    <div className="term-head">
      <TerminalStatus terminal={terminal} link={link} />
      {searching ? (
        <div className="term-find">
          <input
            ref={searchInput}
            className="term-search"
            type="search"
            autoFocus
            value={query}
            placeholder={t('search.placeholder')}
            aria-label={t('search.label')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') find(event.shiftKey);
              if (event.key === 'Escape') closeSearch();
            }}
          />
          <Tooltip content={t('search.case')}>
            <button type="button" className="icon-btn" aria-label={t('search.case')} aria-pressed={caseSensitive} onClick={() => setCaseSensitive(!caseSensitive)}>
              <CaseSensitive {...ICON_SM} />
            </button>
          </Tooltip>
          <Tooltip content={t('search.regex')}>
            <button type="button" className="icon-btn" aria-label={t('search.regex')} aria-pressed={regex} onClick={() => setRegex(!regex)}>
              <Regex {...ICON_SM} />
            </button>
          </Tooltip>
          <button type="button" className="icon-btn" aria-label={t('search.previous')} onClick={() => find(true)}>
            <ChevronUp {...ICON_SM} />
          </button>
          <button type="button" className="icon-btn" aria-label={t('search.next')} onClick={() => find(false)}>
            <ChevronDown {...ICON_SM} />
          </button>
          <button type="button" className="icon-btn" aria-label={t('search.close')} onClick={closeSearch}>
            <X {...ICON_SM} />
          </button>
        </div>
      ) : (
        <span className="term-title ellipsis" title={terminal.cwd}>
          {title || terminal.cwd}
        </span>
      )}
      <span className="term-fill" />
      {!running && (
        <button type="button" className="btn btn-small" onClick={onReopen}>
          <RotateCcw {...ICON_SM} /> {t('actions.reopen')}
        </button>
      )}
      {!searching && running && !compact && (
        <Tooltip content={t('search.label')}>
          <button type="button" className="icon-btn" aria-label={t('search.label')} onClick={() => setSearching(true)}>
            <Search {...ICON_SM} />
          </button>
        </Tooltip>
      )}
      {fullscreen.supported && !compact && running && (
        <Tooltip content={fullscreen.active ? t('fullscreen.exit') : t('fullscreen.enter')}>
          <button
            type="button"
            className="icon-btn"
            aria-label={fullscreen.active ? t('fullscreen.exit') : t('fullscreen.enter')}
            aria-pressed={fullscreen.active}
            onClick={() => {
              fullscreen.toggle();
              view.current?.focus();
            }}
          >
            {fullscreen.active ? <Minimize2 {...ICON_SM} /> : <Maximize2 {...ICON_SM} />}
          </button>
        </Tooltip>
      )}
      {onDetach && running && !compact && (
        <Tooltip content={t('window.open')}>
          <button type="button" className="icon-btn" aria-label={t('window.open')} onClick={onDetach}>
            <ExternalLink {...ICON_SM} />
          </button>
        </Tooltip>
      )}
      <MoreActions entries={entries} label={t('menu.label')} title={baseName(terminal.cwd)} />
    </div>
  );

  return (
    <section ref={frame} className="term" aria-label={t('panel.label', { name: baseName(terminal.cwd) })}>
      {head}
      {wasLive.current ? (
        <TerminalView
          ref={view}
          terminal={terminal}
          compact={compact}
          /* design-lint-ok: the cell size is the person's own terminal setting, outside the type scale */
          fontSize={font.size}
          blink={blink}
          screenReader={screenReader}
          label={t('panel.screen', { path: terminal.cwd })}
          onLink={setLinkState}
          onTitle={setTitle}
          onEnded={onEnded}
          onToggle={onToggle}
          // A field that is already open does not autofocus again, so the shortcut puts the keyboard in it
          onSearch={() => {
            setSearching(true);
            searchInput.current?.focus();
          }}
          onContextMenu={(menu) => {
            searchTakesFocus.current = false;
            pressedOutside.current = false;
            setPointer(menu);
          }}
          transformInput={(typed) => {
            if (!mods.ctrl && !mods.alt) return typed;
            setMods({ ctrl: false, alt: false });
            return typed.length === 1 ? withModifiers(typed, mods) : typed;
          }}
        />
      ) : (
        <div className="term-screen term-gone">
          <p className="muted">{t('panel.gone')}</p>
        </div>
      )}
      <PointerMenu
        entries={shared(pointer?.hasSelection)}
        at={pointer}
        label={t('menu.label')}
        boundary={frame.current}
        container={fullscreen.active ? frame.current : null}
        onClose={() => setPointer(null)}
        onCloseAutoFocus={(event) => {
          // Back to the screen the click was on, unless Search just opened its own field. Radix runs this
          // a tick after the menu unmounted, so something else may already hold the focus: a second
          // right click that opened the menu again. Only an empty focus (the menu's own item went with
          // the menu) is the terminal's to take back; a press elsewhere is `pressedOutside`'s.
          event.preventDefault();
          if (searchTakesFocus.current) {
            searchTakesFocus.current = false;
            // A field that was already open does not autofocus again
            searchInput.current?.focus();
          } else if (pressedOutside.current) pressedOutside.current = false;
          else if (!document.activeElement || document.activeElement === document.body) view.current?.focus();
        }}
        // A press elsewhere closed the menu: that press chooses where the focus goes, not the menu
        onPointerDownOutside={() => {
          pressedOutside.current = true;
        }}
      />
      {compact && running && <KeyBar mods={mods} onMods={setMods} onSend={(data) => view.current?.input(data)} />}
    </section>
  );
}
