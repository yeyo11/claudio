import { useSyncExternalStore } from 'react';

/*
 * What this browser remembers about its terminals (`claudio-terminal-*` in localStorage): the cell
 * font, the dock's height and whether a screen reader gets xterm's own accessible tree. Per browser,
 * never sent to the server.
 */

const FONT_KEY = 'claudio-terminal-font';
const READER_KEY = 'claudio-terminal-screen-reader';
export const DOCK_KEY = 'claudio-terminal-dock';

export const FONT_MIN = 10;
export const FONT_MAX = 22;
export const DEFAULT_FONT = { desktop: 13, phone: 12 } as const;

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
};

export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // private mode: the choice lasts until the page is left
  }
  emit();
}

export const clampFont = (size: number): number => Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(size)));

/** The cell font in pixels and how to change it; the default is 13 on a desktop and 12 on a phone. */
export function useTerminalFont(compact: boolean): { size: number; set: (size: number | null) => void } {
  const stored = useSyncExternalStore(subscribe, () => readPref(FONT_KEY), () => null);
  const parsed = stored === null ? NaN : Number(stored);
  const size = Number.isFinite(parsed) ? clampFont(parsed) : compact ? DEFAULT_FONT.phone : DEFAULT_FONT.desktop;
  return { size, set: (next) => writePref(FONT_KEY, next === null ? null : String(clampFont(next))) };
}

export function useScreenReaderMode(): [boolean, (on: boolean) => void] {
  const stored = useSyncExternalStore(subscribe, () => readPref(READER_KEY), () => null);
  return [stored === '1', (on) => writePref(READER_KEY, on ? '1' : null)];
}
