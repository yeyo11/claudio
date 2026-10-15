/*
 * The web app opens a terminal in a window of its own with `window.open` on its own
 * `/terminal-window/:id` route. In the desktop app that window must be a native one that is as
 * locked down as the main window, and no other address may open one.
 */

const ROUTE = /^\/terminal-window\/[^/]+\/?$/;

/** Whether `url` is the detached terminal's route on the local server (same origin, nothing else) */
export function isTerminalWindowUrl(url: string, serverOrigin: string | undefined): boolean {
  if (!serverOrigin) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.origin === serverOrigin && ROUTE.test(parsed.pathname);
}
