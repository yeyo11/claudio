import { API_VERSION, type ServerMeta } from '@claudio/shared';
import { activeBase } from '@claudio/ui/lib/server-scope';
import { requestAt } from '../api';

/* What a server says about itself, and whether this web can drive it (docs/plans/claudio-servers.md §9.1) */

export type Compatibility = 'ok' | 'server-too-old' | 'web-too-old';

/**
 * A server answers routes correctly for `min..current`. This web is at `webVersion`: above the
 * server's current one it asks for routes the server lacks (the server must update), below its
 * minimum the server has dropped routes this web still uses (this Claudio must update). Anything
 * the server sent that is not a pair of integers is not compatible with it either.
 */
export function compatibility(meta: Pick<ServerMeta, 'apiVersion'> | null | undefined, webVersion: number = API_VERSION): Compatibility {
  const range = meta?.apiVersion;
  if (!range || !Number.isInteger(range.current) || !Number.isInteger(range.min) || range.min > range.current) return 'server-too-old';
  if (webVersion > range.current) return 'server-too-old';
  if (webVersion < range.min) return 'web-too-old';
  return 'ok';
}

/** `GET /meta` of the server this page is scoped to, through the gateway when it is a remote */
export const readMeta = (signal?: AbortSignal): Promise<ServerMeta> =>
  requestAt<ServerMeta>(activeBase(), '/meta', { timeoutMs: 10_000, ...(signal ? { signal } : {}) });
