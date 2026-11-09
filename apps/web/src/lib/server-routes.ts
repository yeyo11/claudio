import { LOCAL_SERVER_ID, scopedHref } from '@claudio/ui/lib/server-scope';

/*
 * Which pages and surfaces exist in which scope, and where a route goes when the person switches
 * server (docs/plans/claudio-servers.md §4.3, §9.3). Plain data and string functions, so a test
 * reads them without the app.
 */

/**
 * Pages that name no record of a server: the same address means the same page on any server. A
 * page that names one (`/chats/:id`, `/tasks/:key`, `/orchestration/:id`…) is not here, because
 * ids belong to one server and the other cannot be expected to have that record. Settings keeps
 * its group and detail: the structure of Settings is the same everywhere.
 */
const SHARED_PAGES: ReadonlySet<string> = new Set([
  '/',
  '/assistant',
  '/chats',
  '/chats/new',
  '/projects',
  '/projects/new',
  '/tasks',
  '/tasks/milestones',
  '/orchestration',
  '/accounts',
  '/schedules',
  '/schedules/new',
  '/terminals',
  '/usage',
  '/collaborators',
]);

/** Settings sections that describe the hub's own reachability and sign-in, not the selected server's */
const HUB_ONLY_SETTINGS_SECTIONS: ReadonlySet<string> = new Set([
  // The local network card and the public tunnel card: addresses that reach the hub
  'remote',
  // The sign-in cards (access mode, owner token, read-only): the hub's credential, which the gateway never forwards
  'access',
  // The switch of Servers itself: the hub's list, and one hop only (plan D7)
  'servers',
]);

const trimmed = (pathname: string): string => (pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname) || '/';

/**
 * Whether a surface exists only on the server the page was opened from (plan D7). `path` is an
 * address of the app, with the `#section` of Settings when that is what is asked: `/servers`, or
 * `/settings/access#remote`. The desktop shell's IPC and the desktop app's own updates are hub-only
 * too, but they are not addresses: they are gated with `useHubOnlyHidden` where they are drawn.
 */
export function isHubOnly(path: string): boolean {
  const hash = path.includes('#') ? path.slice(path.indexOf('#') + 1) : '';
  const pathname = trimmed(path.replace(/[?#].*$/, ''));
  if (pathname === '/servers' || pathname.startsWith('/servers/')) return true;
  if (pathname === '/settings' || pathname.startsWith('/settings/')) return HUB_ONLY_SETTINGS_SECTIONS.has(hash);
  return false;
}

/** A Settings section, by its anchor id, that a remote scope does not show */
export const isHubOnlySection = (sectionId: string): boolean => isHubOnly(`/settings#${sectionId}`);

/**
 * The page of `path` on another server: the same one when it names no record and the other server
 * has it, otherwise that server's Home. Query and hash do not travel, since they hold ids too (the
 * project of the top bar, a filter on a chat) and a stale one would filter the other server by
 * something it does not have.
 */
export function mapRoute(path: string, to: string): string {
  const pathname = trimmed(path.replace(/[?#].*$/, ''));
  if (to !== LOCAL_SERVER_ID && isHubOnly(pathname)) return '/';
  if (pathname === '/settings' || pathname.startsWith('/settings/')) return pathname;
  if (SHARED_PAGES.has(pathname)) return pathname;
  return '/';
}

/** The browser address of the page `path` maps to on server `to` */
export const addressOnServer = (path: string, to: string): string => scopedHref(to, mapRoute(path, to));
