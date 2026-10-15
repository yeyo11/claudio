import { CaseSensitive, ChevronDown, ChevronUp, ClipboardPaste, Copy, ExternalLink, Maximize2, Minimize2, Minus, Plus, Regex, RotateCcw, Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Terminal } from '@claudio/shared';
import type { MenuEntry } from '@claudio/ui/components/controls/Menu';
import { MoreActions } from '@claudio/ui/components/controls/MoreActions';
import { Tooltip } from '@claudio/ui/components/controls/Tooltip';
import { ICON_SM } from '@claudio/ui/components/icons';
import { useToast } from '@claudio/ui/components/Toast';
import { useDecorativeMotion } from '@claudio/ui/lib/motion';
import { KeyBar, type Modifiers } from './KeyBar';
import { TerminalView, type TerminalViewHandle } from './TerminalView';
import { TerminalStatus } from './TerminalStatus';
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
  /** The shell ended or the server closed it: the lists should be read again */
  onEnded: () => void;
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
    else toast.info(t('notices.nothingSelected'));
  };

  const entries: MenuEntry[] = [
    { id: 'copy', label: t('menu.copy'), icon: Copy, onSelect: () => void copy(), disabled: !running },
    { id: 'paste', label: t('menu.paste'), icon: ClipboardPaste, onSelect: () => void view.current?.paste(), disabled: !running },
    { id: 'search', label: t('menu.search'), icon: Search, onSelect: () => setSearching(true), shortcut: compact ? undefined : 'Ctrl+Shift+F', disabled: !running },
    { id: 'font-up', label: t('menu.fontUp', { size: clampFont(font.size + 1) }), icon: Plus, onSelect: () => font.set(font.size + 1) },
    { id: 'font-down', label: t('menu.fontDown', { size: clampFont(font.size - 1) }), icon: Minus, onSelect: () => font.set(font.size - 1) },
    { id: 'close', label: t('menu.close'), icon: X, destructive: true, onSelect: onClose },
  ];

  const head = (
    <div className="term-head">
      <TerminalStatus terminal={terminal} link={link} />
      {searching ? (
        <div className="term-find">
          <input
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
          fontSize={font.size}
          blink={blink}
          screenReader={screenReader}
          label={t('panel.screen', { path: terminal.cwd })}
          onLink={setLinkState}
          onTitle={setTitle}
          onEnded={onEnded}
          onToggle={onToggle}
          onSearch={() => setSearching(true)}
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
      {compact && running && <KeyBar mods={mods} onMods={setMods} onSend={(data) => view.current?.input(data)} />}
    </section>
  );
}
