/*
 * Which Claudio server this page talks to, and the three things that follow from it: the base of
 * its API, the prefix of its routes and the suffix of its browser-storage keys.
 *
 * The scope is a property of the address and is fixed for the life of the page: `/s/<id>/…` is the
 * server `<id>` driven through this one (docs/plans/claudio-servers.md §4.3), everything else is
 * this server. Switching servers is a navigation to the other address, so no module state, cache,
 * draft or stream of one server can be mistaken for another's. This file sits at the bottom of the
 * web stack because the chat package keys its drafts by it too.
 */

/** The fixed id of the server the page was opened from. A remote's id is never this one. */
export const LOCAL_SERVER_ID = 'local';

/** This server's own API, where the hub's sign-in and every hub-only call go, whatever the scope */
export const HUB_API = '/api';

/** First path segment of every route of a remote scope */
export const SCOPE_SEGMENT = 's';

// What `servers.json` ids look like. Narrow on purpose: the id goes into a path and a storage key,
// and an address like `/s/..%2f..` must not become a base that points somewhere else.
const SERVER_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** An id that may name a remote: well formed, and not the reserved `local` */
export function isRemoteServerId(value: string | null | undefined): value is string {
  return typeof value === 'string' && value !== LOCAL_SERVER_ID && SERVER_ID.test(value);
}

/** `/s/<id>/rest` → the id and the path inside that scope; null for any address outside a remote scope */
export function parseScopedPath(pathname: string): { serverId: string; path: string } | null {
  const parts = pathname.split('/');
  if (parts[1] !== SCOPE_SEGMENT) return null;
  const serverId = parts[2];
  if (!isRemoteServerId(serverId)) return null;
  const rest = parts.slice(3).join('/');
  return { serverId, path: `/${rest}` };
}

/** The API a scope talks to: the hub's own, or a remote's through the hub's gateway */
export function apiBase(serverId: string): string {
  return serverId === LOCAL_SERVER_ID ? HUB_API : `${HUB_API}/servers/${encodeURIComponent(serverId)}/api`;
}

/** The router's basename for a scope; `undefined` for the local one, whose routes are unprefixed */
export function routerBasename(serverId: string): string | undefined {
  return serverId === LOCAL_SERVER_ID ? undefined : `/${SCOPE_SEGMENT}/${serverId}`;
}

/** Where a path of a scope lives in the browser's address bar */
export function scopedHref(serverId: string, path: string): string {
  const prefix = routerBasename(serverId) ?? '';
  return path === '/' && prefix ? prefix : `${prefix}${path}`;
}

/**
 * A browser-storage key of per-server data. The local server keeps its keys exactly as they were
 * (nothing to migrate), a remote's carry `:<serverId>`. Theme, language and motion never go through
 * this: they belong to the person, not to a server.
 */
export function scopedKey(key: string, serverId: string = activeServerId()): string {
  return serverId === LOCAL_SERVER_ID ? key : `${key}:${serverId}`;
}

let active: string | null = null;

function detect(): string {
  if (typeof window === 'undefined') return LOCAL_SERVER_ID;
  return parseScopedPath(window.location.pathname)?.serverId ?? LOCAL_SERVER_ID;
}

/** The scope of this page: read from the address the first time it is asked, then fixed */
export function activeServerId(): string {
  active ??= detect();
  return active;
}

/** The API base of this page's scope */
export function activeBase(): string {
  return apiBase(activeServerId());
}

/** For tests: pins the scope, or with `null` makes the next read detect it again */
export function setActiveServer(serverId: string | null): void {
  active = serverId;
}
