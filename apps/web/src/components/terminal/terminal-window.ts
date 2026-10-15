import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/*
 * A terminal can be taken out of the panel into a window of its own: a route that draws that one
 * terminal and nothing else, attached to the same shell through the same ticket and socket (the
 * server lets several clients attach). The two windows are the same origin, so a BroadcastChannel
 * is all they need to know about each other. Nothing here is stored: a window that is gone says so
 * or is simply not heard from.
 */

/** The detached window's route: no app shell around it */
export const terminalWindowPath = (id: string): string => `/terminal-window/${encodeURIComponent(id)}`;

/** The window's name, so a second click on the same terminal focuses the window instead of opening another */
export const terminalWindowName = (id: string): string => `claudio-terminal-${id}`;

/** The terminal's id when the path is a detached window's route, otherwise null */
export function terminalWindowId(pathname: string): string | null {
  const match = /^\/terminal-window\/([^/]+)\/?$/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

const CHANNEL = 'claudio-terminal-windows';

/**
 * What the windows say to each other. `here`: this terminal is open in a window (said on opening and
 * in answer to `who`); `gone`: that window closed; `who`: the panel asking which are open;
 * `close`: the panel asking the window of this terminal to close ("Bring it here").
 */
export type WindowMessage = { type: 'here' | 'gone' | 'close'; id: string } | { type: 'who' };

export function parseWindowMessage(data: unknown): WindowMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const { type, id } = data as { type?: unknown; id?: unknown };
  if (type === 'who') return { type };
  if ((type === 'here' || type === 'gone' || type === 'close') && typeof id === 'string' && id) return { type, id };
  return null;
}

/** The set of terminals that are in a window, after one message */
export function applyWindowMessage(detached: ReadonlySet<string>, message: WindowMessage): ReadonlySet<string> {
  if (message.type === 'here' && !detached.has(message.id)) return new Set(detached).add(message.id);
  if (message.type === 'gone' && detached.has(message.id)) {
    const next = new Set(detached);
    next.delete(message.id);
    return next;
  }
  return detached;
}

const hasChannel = typeof BroadcastChannel === 'function';

/** The URL, name and features `window.open` takes for a terminal's window */
export function openTerminalWindow(id: string): Window | null {
  return window.open(terminalWindowPath(id), terminalWindowName(id), 'popup=yes,width=1000,height=640');
}

/**
 * The panel's view of it: which terminals are in a window now, and a way to bring one back. A
 * terminal opened in a window is marked at once; the window's own message confirms it, and its
 * closing (or a reload of this page, which asks `who`) corrects it.
 */
export function useDetachedTerminals(): { detached: ReadonlySet<string>; markOpened: (id: string) => void; bringBack: (id: string) => void } {
  const [detached, setDetached] = useState<ReadonlySet<string>>(() => new Set());
  const channel = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    if (!hasChannel) return;
    const own = new BroadcastChannel(CHANNEL);
    channel.current = own;
    own.onmessage = (event: MessageEvent<unknown>) => {
      const message = parseWindowMessage(event.data);
      if (message) setDetached((now) => applyWindowMessage(now, message));
    };
    own.postMessage({ type: 'who' } satisfies WindowMessage);
    return () => {
      own.close();
      channel.current = null;
    };
  }, []);

  const markOpened = useCallback((id: string) => setDetached((now) => applyWindowMessage(now, { type: 'here', id })), []);
  const bringBack = useCallback((id: string) => {
    channel.current?.postMessage({ type: 'close', id } satisfies WindowMessage);
    // The window says `gone` as it closes; a window that never heard this must not leave the terminal stuck
    setDetached((now) => applyWindowMessage(now, { type: 'gone', id }));
  }, []);
  return { detached, markOpened, bringBack };
}

/**
 * The detached window's side: says it is there, answers `who`, closes when asked, and says it is gone.
 */
export function useWindowPresence(id: string): void {
  useEffect(() => {
    if (!hasChannel) return;
    const own = new BroadcastChannel(CHANNEL);
    const here = () => own.postMessage({ type: 'here', id } satisfies WindowMessage);
    own.onmessage = (event: MessageEvent<unknown>) => {
      const message = parseWindowMessage(event.data);
      if (message?.type === 'who') here();
      else if (message?.type === 'close' && message.id === id) window.close();
    };
    const gone = () => own.postMessage({ type: 'gone', id } satisfies WindowMessage);
    here();
    window.addEventListener('pagehide', gone);
    return () => {
      window.removeEventListener('pagehide', gone);
      gone();
      own.close();
    };
  }, [id]);
}

/**
 * Full screen for one element, through the browser's Fullscreen API. `supported` is false where it
 * is not there, and the button is not drawn. Esc leaves it, as the button does; where the browser lets
 * a page keep Esc for itself (keyboard lock) a short press goes to the shell and holding it leaves.
 */
export function useFullscreen(target: RefObject<HTMLElement | null>): { supported: boolean; active: boolean; toggle: () => void } {
  const supported = typeof document !== 'undefined' && document.fullscreenEnabled === true;
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!supported) return;
    const sync = () => {
      const on = document.fullscreenElement !== null && document.fullscreenElement === target.current;
      setActive(on);
      const keyboard = (navigator as Navigator & { keyboard?: { lock?: (keys: string[]) => Promise<void>; unlock?: () => void } }).keyboard;
      if (on) void keyboard?.lock?.(['Escape'])?.catch(() => {});
      else keyboard?.unlock?.();
    };
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, [supported, target]);

  const toggle = useCallback(() => {
    const element = target.current;
    if (!element) return;
    if (document.fullscreenElement === element) void document.exitFullscreen().catch(() => {});
    else void element.requestFullscreen().catch(() => {});
  }, [target]);

  return { supported, active, toggle };
}
