/*
 * The web app opens a terminal in a window of its own with `window.open` on its own
 * `/terminal-window/:id` route. In the desktop app that window must be a native one that is as
 * locked down as the main window, and no other address may open one.
 *
 * A page can also drive another Claudio through this one: its routes then live under `/s/<id>/`
 * (docs/plans/claudio-servers.md §4.3), still on the local server's origin, so a terminal of that
 * server opens on `/s/<id>/terminal-window/:id`. The shell carries no copy of the web's helpers (its
 * inputs change only with a new shell), so the scope's shape is spelt out here, as narrow as the
 * web's: the reserved `local` is never a prefix.
 */

/** `/s/<id>`: a remote's scope. The id is as `servers.json` writes them, never `local` */
const SCOPE = /^\/s\/(?!local(?:\/|$))[A-Za-z0-9_-]{1,64}(?=\/|$)/;

const ROUTE = /^\/terminal-window\/[^/]+\/?$/;

/** The scope prefix of an app path (`/s/<id>`), or `''` for the local server's own pages */
export function scopeOf(pathname: string): string {
  return SCOPE.exec(pathname)?.[0] ?? '';
}

/** Whether `url` is the detached terminal's route on the local server (same origin, nothing else), in any scope */
export function isTerminalWindowUrl(url: string, serverOrigin: string | undefined): boolean {
  if (!serverOrigin) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.origin !== serverOrigin) return false;
  return ROUTE.test(parsed.pathname.slice(scopeOf(parsed.pathname).length));
}

/**
 * How the shell opens an in-app path in the main window, which shows `currentUrl`: with the page's
 * own router (`ipc`, the path inside the page's scope, as its router's basename expects it) when the
 * path is of the scope the page is in, otherwise as a fresh load of the local server (`load`). A
 * path of the hub (a tray chat, the desktop updates) never lands inside a remote's scope, and a
 * page on another origin is never driven.
 */
export function navigationFor(currentUrl: string, path: string, serverOrigin: string): { kind: 'ipc'; path: string } | { kind: 'load'; url: string } {
  const load = { kind: 'load', url: `${serverOrigin}${path}` } as const;
  let current: URL;
  try {
    current = new URL(currentUrl);
  } catch {
    return load;
  }
  if (current.origin !== serverOrigin) return load;
  const scope = scopeOf(path.replace(/[?#].*$/, ''));
  if (scope !== scopeOf(current.pathname)) return load;
  const inside = path.slice(scope.length);
  return { kind: 'ipc', path: inside.startsWith('/') ? inside : `/${inside}` };
}
