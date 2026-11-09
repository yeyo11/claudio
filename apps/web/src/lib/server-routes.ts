import { apiBase, LOCAL_SERVER_ID, scopedHref } from '@claudio/ui/lib/server-scope';

/*
 * Which pages and surfaces exist in which scope, and where a route goes when the person switches
 * server (docs/plans/claudio-servers.md §4.3, §9.3). Plain data and string functions, so a test
 * reads them without the app.
 */

/**
 * Pages that name no record of a server: the same address means the same page on any server. A
 * page that names one (`/chats/:id`, `/tasks/:key`, `/orchestration/:id`…) is in `RECORD_PAGES`
 * instead, because ids belong to one server: the other may or may not have that record. Settings
 * keeps its group and detail: the structure of Settings is the same everywhere.
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
]);

/**
 * Pages that name a record, each with the list it belongs to and the API read that says whether a
 * server has it. The read is the lightest one the record has (no read writes, none starts a
 * session); a project page reads the project's docs registry, the cheapest route that answers 404
 * for a project that is not there. Shared projects of a collaborator belong to the person's own
 * peers, not to a server, so they have no read and go to their list.
 */
const RECORD_PAGES: ReadonlyArray<{ page: RegExp; list: string; read: ((id: string) => string) | null }> = [
  { page: /^\/chats\/([^/]+)(?:\/changes)?$/, list: '/chats', read: (id) => `/chats/${id}?limit=1` },
  { page: /^\/tasks\/([^/]+)(?:\/changes)?$/, list: '/tasks', read: (key) => `/work-items/by-key/${key}` },
  { page: /^\/orchestration\/([^/]+)(?:\/changes|\/tasks\/[^/]+\/changes)?$/, list: '/orchestration', read: (id) => `/orchestrations/${id}` },
  { page: /^\/projects\/([^/]+)\/assistant$/, list: '/projects', read: (id) => `/projects/${id}/docs` },
  { page: /^\/schedules\/([^/]+)\/edit$/, list: '/schedules', read: (id) => `/schedules/${id}` },
  { page: /^\/terminals\/([^/]+)$/, list: '/terminals', read: (id) => `/terminals/${id}` },
  { page: /^\/collaborators\/shared\/[^/]+\/[^/]+$/, list: '/collaborators', read: null },
];

/** The record a page names: the page, its list, and the read of it (an API path), null when it has none */
export interface RecordRoute {
  page: string;
  list: string;
  read: string | null;
}

/** An id as it goes back into a path: decoded once and encoded again, so it is one segment and never a dot segment */
function segment(raw: string): string | null {
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return id && id !== '.' && id !== '..' ? encodeURIComponent(id) : null;
}

/** The record `path` names, or null for a page that names none (or is not a page of the app) */
export function recordOf(path: string): RecordRoute | null {
  const pathname = trimmed(path.replace(/[?#].*$/, ''));
  if (SHARED_PAGES.has(pathname)) return null;
  for (const { page, list, read } of RECORD_PAGES) {
    const match = page.exec(pathname);
    if (!match) continue;
    const id = match[1] === undefined ? null : segment(match[1]);
    return { page: pathname, list, read: read && id ? read(id) : null };
  }
  return null;
}

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
 * The page of `path` on another server, without asking it: the same one when it names no record and
 * the other server has it, the list a record page belongs to (whether the record is there is for
 * `routeOnServer` to ask), otherwise that server's Home. Query and hash do not travel, since they
 * hold ids too (the project of the top bar, a filter on a chat) and a stale one would filter the
 * other server by something it does not have.
 */
export function mapRoute(path: string, to: string): string {
  const pathname = trimmed(path.replace(/[?#].*$/, ''));
  if (to !== LOCAL_SERVER_ID && isHubOnly(pathname)) return '/';
  if (pathname === '/settings' || pathname.startsWith('/settings/')) return pathname;
  if (SHARED_PAGES.has(pathname)) return pathname;
  return recordOf(pathname)?.list ?? '/';
}

/** The browser address of the page `path` maps to on server `to`, without asking it */
export const addressOnServer = (path: string, to: string): string => scopedHref(to, mapRoute(path, to));

/** How long a switch waits to learn whether the other server has the record on the page (§12.2 E1) */
export const RECORD_READ_MS = 2_000;

/** Whether the server at API `base` answers the read `path` (a record's): resolves true when it does */
export type RecordExists = (base: string, path: string, signal: AbortSignal) => Promise<boolean>;

/**
 * The page of `path` on server `to` (§12.2 E1): a page that names a record stays when that server
 * has the record, read once through its API base within `RECORD_READ_MS`; when it has not, or does
 * not say in time, the list the record belongs to; anything else as `mapRoute` maps it. Never
 * rejects: a switch always lands somewhere.
 */
export async function routeOnServer(path: string, to: string, exists: RecordExists, waitMs: number = RECORD_READ_MS): Promise<string> {
  const record = recordOf(path);
  if (!record?.read) return mapRoute(path, to);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The budget holds even for a read that does not listen to its signal
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(false);
    }, waitMs);
  });
  try {
    return (await Promise.race([exists(apiBase(to), record.read, controller.signal), late])) ? record.page : record.list;
  } catch {
    return record.list;
  } finally {
    clearTimeout(timer);
  }
}
