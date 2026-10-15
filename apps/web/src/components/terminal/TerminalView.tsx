import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Terminal } from '@claudio/shared';
import { useToast } from '@claudio/ui/components/Toast';
import { copyText } from '@claudio/ui/lib/clipboard';
import { api, BASE } from '../../api';
import { defaultSocketUrl, TerminalConnection, type SocketLike } from './terminal-connection';
import { chooseRenderer, cleanPaste, pasteChunks, pasteTooLarge, type LinkState } from './terminal-model';
import { currentTerminalTheme, watchTheme } from './terminal-theme';

/** The page's own preference for the renderer: `dom` forces it, `webgl` allows it on Linux */
export const RENDERER_KEY = 'claudio-terminal-renderer';
const ACK_EVERY_BYTES = 64 * 1024;
/** Frames the fit loop waits for the proposed size to hold still, so a dragged panel sends one resize */
const FIT_STABLE_FRAMES = 8;
const FIT_DEBOUNCE_MS = 150;

export interface FindOptions {
  caseSensitive: boolean;
  regex: boolean;
}

/** What the panel around the view asks of it. */
export interface TerminalViewHandle {
  focus(): void;
  /** Bytes typed on the person's behalf (the phone's key bar) */
  input(data: string): void;
  copySelection(): Promise<boolean>;
  paste(): Promise<void>;
  find(query: string, options: FindOptions, backwards?: boolean): boolean;
  clearFind(): void;
}

interface Props {
  terminal: Terminal;
  /** A phone: the DOM renderer and a smaller cell font */
  compact: boolean;
  fontSize: number;
  /** Whether the cursor may blink: motion at full, and the tab in view */
  blink: boolean;
  screenReader: boolean;
  /** The folder the region is named after, for assistive technology */
  label: string;
  onLink: (link: LinkState) => void;
  onTitle: (title: string) => void;
  /** The shell ended, or the server closed this terminal: the list should be read again */
  onEnded: () => void;
  /** The app's own shortcuts, handed back before xterm sees the key */
  onToggle?: () => void;
  onSearch?: () => void;
  /** Lets the phone's sticky Ctrl and Alt apply to what its keyboard types */
  transformInput?: (typed: string) => string;
}

function readFlag(): string | null {
  try {
    return localStorage.getItem(RENDERER_KEY);
  } catch {
    return null;
  }
}

function gpuName(): string | null {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return null;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
  } catch {
    return null;
  }
}

/**
 * One xterm on one terminal of the server. The shell lives in the server: this view attaches, paints
 * the snapshot it is handed, and follows the output. Closing the page detaches and leaves the shell be.
 */
export const TerminalView = forwardRef<TerminalViewHandle, Props>(function TerminalView(props, ref) {
  const { t } = useTranslation('terminal');
  const toast = useToast();
  const host = useRef<HTMLDivElement>(null);
  const xterm = useRef<Xterm | null>(null);
  const search = useRef<SearchAddon | null>(null);
  const connection = useRef<TerminalConnection | null>(null);
  const refit = useRef<() => void>(() => undefined);
  // Held in a ref so the long-lived xterm handlers always call the latest of them
  const latest = useRef({ ...props, t, toast });
  latest.current = { ...props, t, toast };
  const { id } = props.terminal;

  useImperativeHandle(ref, () => ({
    focus: () => xterm.current?.focus(),
    input: (data) => {
      for (const chunk of pasteChunks(data)) connection.current?.input(chunk);
    },
    copySelection: async () => {
      const text = xterm.current?.getSelection() ?? '';
      return text ? copyText(text) : false;
    },
    paste: async () => {
      let text = '';
      try {
        text = (await navigator.clipboard?.readText()) ?? '';
      } catch {
        latest.current.toast.info(latest.current.t('notices.pasteBlocked'));
        return;
      }
      sendPaste(text);
    },
    find: (query, options, backwards) => {
      if (!query) return false;
      const addon = search.current;
      if (!addon) return false;
      return backwards ? addon.findPrevious(query, options) : addon.findNext(query, options);
    },
    clearFind: () => search.current?.clearDecorations(),
  }));

  function sendPaste(text: string): void {
    if (!text) return;
    if (pasteTooLarge(text)) {
      latest.current.toast.error(latest.current.t('notices.pasteTooLarge'));
      return;
    }
    // Through xterm, so a shell that asked for bracketed paste gets one
    xterm.current?.paste(cleanPaste(text));
  }

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    const cleanups: Array<() => void> = [];

    void (async () => {
      const cell = latest.current.fontSize;
      // Measured on the fallback font otherwise, and every glyph lands in the wrong place
      try {
        await document.fonts.load(`${cell}px "Geist Mono Variable"`);
      } catch {
        // the mono stack's next font stands in
      }
      if (disposed) return;

      const root = getComputedStyle(document.documentElement);
      const term = new Xterm({
        allowProposedApi: true,
        fontFamily: root.getPropertyValue('--mono').trim() || 'monospace',
        fontSize: cell,
        lineHeight: 1.2,
        scrollback: 5000,
        cursorBlink: latest.current.blink,
        cursorStyle: 'block',
        screenReaderMode: latest.current.screenReader,
        theme: currentTerminalTheme(),
        macOptionIsMeta: true,
      });
      const fit = new FitAddon();
      const finder = new SearchAddon();
      term.loadAddon(fit);
      term.loadAddon(finder);
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = '11';
      term.loadAddon(
        new WebLinksAddon((event, uri) => {
          event.preventDefault();
          window.open(uri, '_blank', 'noopener,noreferrer');
        }),
      );
      term.open(element);
      xterm.current = term;
      search.current = finder;
      cleanups.push(() => {
        xterm.current = null;
        search.current = null;
        term.dispose();
      });

      // The renderer: hardware WebGL on a desktop that can; a context loss is DOM for the rest of the view's life
      if (chooseRenderer({ flag: readFlag(), compact: latest.current.compact, linux: /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent), webgl2: Boolean(document.createElement('canvas').getContext?.('webgl2')), gpu: gpuName() }) === 'webgl') {
        try {
          const gl = new WebglAddon();
          gl.onContextLoss(() => gl.dispose());
          term.loadAddon(gl);
        } catch {
          // no WebGL here after all: the DOM renderer is already drawing
        }
      }

      cleanups.push(watchTheme(() => (term.options.theme = currentTerminalTheme())));

      // ---------- sending ----------
      const link = new TerminalConnection(
        id,
        {
          ticket: (terminalId) => api.terminalTicket(terminalId),
          open: (url) => new WebSocket(url) as unknown as SocketLike,
          socketUrl: (terminalId, ticket) => defaultSocketUrl(terminalId, ticket, BASE, window.location),
          setTimer: (run, ms) => window.setTimeout(run, ms),
          clearTimer: (handle) => window.clearTimeout(handle as number),
        },
        {
          onLink: (state) => latest.current.onLink(state),
          onHello: (hello) => {
            // The snapshot holds queries the screen once answered (cursor position, colours); the answers
            // would be typed into the shell, so input is held back until it has been parsed
            muted = true;
            sentSize = '';
            term.reset();
            term.resize(hello.cols, hello.rows);
            try {
              term.write(hello.snapshot, () => {
                muted = false;
                settle();
              });
            } catch {
              muted = false;
            }
          },
          onOutput: (bytes) => {
            try {
              term.write(bytes, () => {
                try {
                  parsed += bytes.length;
                  if (parsed >= ACK_EVERY_BYTES) {
                    link.frame({ type: 'ack', bytes: parsed });
                    parsed = 0;
                  }
                } catch {
                  // one throwing callback would stall xterm's write queue for good
                }
              });
            } catch {
              // a write that fails must not stop the next
            }
          },
          onSize: (cols, rows) => {
            if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
          },
          onExit: () => latest.current.onEnded(),
          onClosed: (_reason, again) => {
            if (!again) latest.current.onEnded();
          },
        },
      );
      connection.current = link;
      cleanups.push(() => {
        link.stop();
        connection.current = null;
      });

      let muted = false;
      let parsed = 0;
      let sentSize = '';

      const sendSize = () => {
        const key = `${term.cols}x${term.rows}`;
        if (key === sentSize) return;
        sentSize = key;
        link.frame({ type: 'resize', cols: term.cols, rows: term.rows });
      };

      // ---------- fitting ----------
      let frame = 0;
      let debounce: number | undefined;
      const settle = () => {
        cancelAnimationFrame(frame);
        let last = '';
        let stable = 0;
        let waited = 0;
        const step = () => {
          const proposed = fit.proposeDimensions();
          const key = proposed ? `${proposed.cols}x${proposed.rows}` : '';
          stable = key && key === last ? stable + 1 : 0;
          last = key;
          waited += 1;
          if (proposed && (stable >= 1 || waited >= FIT_STABLE_FRAMES)) {
            if (term.cols !== proposed.cols || term.rows !== proposed.rows) term.resize(proposed.cols, proposed.rows);
            sendSize();
            return;
          }
          frame = requestAnimationFrame(step);
        };
        frame = requestAnimationFrame(step);
      };
      refit.current = settle;
      const observer = new ResizeObserver(() => {
        window.clearTimeout(debounce);
        debounce = window.setTimeout(settle, FIT_DEBOUNCE_MS);
      });
      observer.observe(element);
      cleanups.push(() => {
        observer.disconnect();
        window.clearTimeout(debounce);
        cancelAnimationFrame(frame);
      });

      // ---------- typing ----------
      const data = term.onData((typed) => {
        if (muted) return;
        for (const chunk of pasteChunks(latest.current.transformInput?.(typed) ?? typed)) link.input(chunk);
      });
      const binary = term.onBinary((typed) => {
        if (muted) return;
        link.input(typed);
      });
      const title = term.onTitleChange((value) => latest.current.onTitle(value.slice(0, 120)));
      cleanups.push(() => {
        data.dispose();
        binary.dispose();
        title.dispose();
      });

      // The app's shortcuts go to the app, and the copy and paste chords to the browser; the rest is the shell's
      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown') return true;
        const ctrl = event.ctrlKey || event.metaKey;
        if (ctrl && !event.shiftKey && (event.key === '`' || event.code === 'Backquote')) {
          event.preventDefault();
          latest.current.onToggle?.();
          return false;
        }
        if (ctrl && !event.shiftKey && event.key.toLowerCase() === 'k') return false;
        if (ctrl && event.shiftKey && event.key.toLowerCase() === 'f') {
          event.preventDefault();
          latest.current.onSearch?.();
          return false;
        }
        if (ctrl && event.shiftKey && event.key.toLowerCase() === 'c') {
          const text = term.getSelection();
          if (text) void copyText(text);
          event.preventDefault();
          return false;
        }
        // The browser's own paste event follows; it is handled below so the text is cleaned first
        if (ctrl && event.shiftKey && event.key.toLowerCase() === 'v') return false;
        return true;
      });

      const onPaste = (event: ClipboardEvent) => {
        event.preventDefault();
        event.stopPropagation();
        sendPaste(event.clipboardData?.getData('text/plain') ?? '');
      };
      // In the capture phase, before xterm's own listener on its textarea pastes the text as it is
      element.addEventListener('paste', onPaste, true);
      cleanups.push(() => element.removeEventListener('paste', onPaste, true));

      const onContext = (event: MouseEvent) => {
        const text = term.getSelection();
        if (!text) return;
        event.preventDefault();
        void copyText(text);
      };
      element.addEventListener('contextmenu', onContext);
      cleanups.push(() => element.removeEventListener('contextmenu', onContext));

      const focus = () => link.frame({ type: 'focus' });
      term.textarea?.addEventListener('focus', focus);
      cleanups.push(() => term.textarea?.removeEventListener('focus', focus));

      link.start();
    })();

    return () => {
      disposed = true;
      for (const clean of cleanups.reverse()) clean();
    };
    // One view per terminal: another terminal is another mount (keyed by the caller)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Settings that change while the terminal stays open
  useEffect(() => {
    const term = xterm.current;
    if (term) term.options.cursorBlink = props.blink;
  }, [props.blink]);
  useEffect(() => {
    const term = xterm.current;
    if (term) term.options.screenReaderMode = props.screenReader;
  }, [props.screenReader]);
  useEffect(() => {
    const term = xterm.current;
    if (!term) return;
    term.options.fontSize = props.fontSize;
    refit.current();
  }, [props.fontSize]);

  return <div ref={host} className="term-screen" role="region" aria-label={props.label} />;
});
