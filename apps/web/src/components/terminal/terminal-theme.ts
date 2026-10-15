import type { ITheme } from '@xterm/xterm';

const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;

/**
 * xterm's theme, built from the `--term-*` tokens (packages/ui/src/styles/tokens.css) as the page
 * computes them now: no colour is written here, so a theme the tokens change reaches the terminal too.
 * A token the page does not define reads as empty, and xterm keeps its own default for that colour.
 */
export function readTerminalTheme(style: Pick<CSSStyleDeclaration, 'getPropertyValue'>): ITheme {
  const token = (name: string): string | undefined => style.getPropertyValue(name).trim() || undefined;
  const theme: ITheme = {};
  const set = <K extends keyof ITheme>(key: K, name: string) => {
    const value = token(name);
    if (value) theme[key] = value as ITheme[K];
  };
  set('background', '--term-bg');
  set('foreground', '--term-fg');
  set('cursor', '--term-cursor');
  set('cursorAccent', '--term-bg');
  set('selectionBackground', '--term-selection');
  ANSI.forEach((name, i) => {
    set(name, `--term-ansi-${i}`);
    set(`bright${name[0]?.toUpperCase()}${name.slice(1)}` as keyof ITheme, `--term-ansi-${i + 8}`);
  });
  return theme;
}

/** The theme as the document shows it now. */
export function currentTerminalTheme(): ITheme {
  return readTerminalTheme(getComputedStyle(document.documentElement));
}

/**
 * Calls `apply` whenever the app's theme changes: `data-theme` on the root, or the system's
 * preference while the theme follows it. Returns how to stop.
 */
export function watchTheme(apply: () => void): () => void {
  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const system = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: light)') : null;
  system?.addEventListener('change', apply);
  return () => {
    observer.disconnect();
    system?.removeEventListener('change', apply);
  };
}
