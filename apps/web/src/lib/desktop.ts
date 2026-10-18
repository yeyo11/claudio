import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { PayloadAction } from './updates';

/**
 * The desktop shell (apps/desktop) loads this same UI in an Electron window whose title bar is
 * drawn by the page: the top bar becomes the window's drag region and leaves room for the window
 * controls. The preload exposes `window.claudioDesktop`; when it is there, `<html>` gets
 * `is-desktop` and `desktop-<platform>` before the first paint, and the CSS in `styles/shell.css`
 * does the rest. In a browser nothing is stamped and nothing changes.
 */

export interface TitleBarTheme {
  /** The top bar's background, painted behind the window controls (a hex colour) */
  color: string;
  /** The window controls' glyphs (a hex colour) */
  symbolColor: string;
}

/**
 * What the preload (apps/desktop/src/preload.ts) exposes, kept minimal on purpose. The methods are
 * optional so a UI served to an older shell, or a browser, just skips them.
 */
export interface DesktopBridge {
  platform: string;
  version: string;
  /** The window controls follow the page's theme */
  setTitleBarTheme?: (theme: TitleBarTheme) => void;
  /** The tray asks the page to open an in-app path; returns the unsubscribe function */
  onNavigate?: (listener: (path: string) => void) => () => void;
  /** The app's own updates, through electron-updater; see lib/updates.ts for the shapes it answers with */
  updates?: DesktopUpdatesBridge;
  /** Tells the shell the web rendered (`notifyPageReady`); the shell may expose it under `updates` instead */
  pageReady?: () => void;
}

/**
 * The preload hands these over as `unknown`: what they carry is checked by `parseUpdateState` and
 * `parseInstallAnswer` in lib/updates.ts rather than trusted.
 */
export interface DesktopUpdatesBridge {
  state: () => Promise<unknown>;
  /** Returns the unsubscribe function */
  onState: (listener: (state: unknown) => void) => () => void;
  download: () => Promise<unknown>;
  install: (options?: { whenIdle?: boolean; force?: boolean }) => Promise<unknown>;
  /**
   * The payload's writes, made by the shell with its own credential: the window holds none
   * (docs/plans/unified-updates.md, D8). Optional like every method here, so an older shell shows
   * the server's state without actions.
   */
  payload?: (action: PayloadAction) => Promise<unknown>;
  /** Whether the `.deb` can become the AppImage here (`parseSwitchState` reads the answer) */
  switchState?: () => Promise<unknown>;
  /** Installs the AppImage and restarts from it; answers like `install` */
  switchToAppImage?: (options?: { force?: boolean }) => Promise<unknown>;
  /** Tells the shell the web rendered, which ends a payload trial's window check (also read from the bridge itself) */
  pageReady?: () => void;
}

declare global {
  interface Window {
    claudioDesktop?: DesktopBridge;
  }
}

/** The classes `<html>` carries inside the desktop app; none in a browser. */
export function desktopClasses(bridge: unknown): string[] {
  if (!bridge || typeof bridge !== 'object') return [];
  const platform = (bridge as { platform?: unknown }).platform;
  // Only a plain token becomes a class name: whatever the bridge says cannot inject another one
  const safe = typeof platform === 'string' && /^[a-z0-9]+$/i.test(platform) ? platform.toLowerCase() : null;
  return safe ? ['is-desktop', `desktop-${safe}`] : ['is-desktop'];
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const classes = desktopClasses(window.claudioDesktop);
  if (classes.length) document.documentElement.classList.add(...classes);
}

/**
 * The title bar colours for the theme on screen: the top bar's `--bg` behind the window controls,
 * `--text` for their glyphs. Read from the computed tokens rather than repeated here, so a token
 * change reaches the title bar by itself.
 */
export function titleBarTheme(style: Pick<CSSStyleDeclaration, 'getPropertyValue'>): TitleBarTheme | null {
  const color = style.getPropertyValue('--bg').trim();
  const symbolColor = style.getPropertyValue('--text').trim();
  const hex = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
  return hex.test(color) && hex.test(symbolColor) ? { color, symbolColor } : null;
}

/** Tells the desktop shell which colours the theme now shows; nothing in a browser. */
export function syncDesktopTitleBar(): void {
  const bridge = typeof window !== 'undefined' ? window.claudioDesktop : undefined;
  if (!bridge?.setTitleBarTheme) return;
  // A frame later: the theme attribute has applied and, on first load, the stylesheets have too
  requestAnimationFrame(() => {
    const theme = titleBarTheme(getComputedStyle(document.documentElement));
    if (theme) bridge.setTitleBarTheme?.(theme);
  });
}

/**
 * Tells the shell this page rendered. A new payload's trial boot waits for it (30 s after the window
 * loads) before it counts as good, so a web that answers /api/health and never paints is rolled back.
 * Once per page load; nothing in a browser or under an older shell.
 */
let pageReadySent = false;
export function notifyPageReady(): void {
  if (pageReadySent || typeof window === 'undefined') return;
  const bridge = window.claudioDesktop;
  const send = bridge?.pageReady ?? bridge?.updates?.pageReady;
  if (!send) return;
  pageReadySent = true;
  send();
}

/** Opens what the tray picks (a live chat, New chat…) with the app's router, keeping its state. */
export function useDesktopNavigation(): void {
  const navigate = useNavigate();
  useEffect(() => {
    const subscribe = typeof window !== 'undefined' ? window.claudioDesktop?.onNavigate : undefined;
    return subscribe?.((path) => {
      if (path.startsWith('/') && !path.startsWith('//')) navigate(path);
    });
  }, [navigate]);
}
