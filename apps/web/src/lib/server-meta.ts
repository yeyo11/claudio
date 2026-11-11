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

/**
 * Whether release `a` is newer than `b`, both `major.minor.patch` (a pre-release or build suffix is
 * ignored). False when either does not read as a version, so a server too old to say stays quiet.
 */
export function isNewerVersion(a: string | null | undefined, b: string | null | undefined): boolean {
  const parse = (v: string | null | undefined): number[] | null => {
    const m = typeof v === 'string' ? /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim()) : null;
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/** `GET /meta` of the server this page is scoped to, through the gateway when it is a remote */
export const readMeta = (signal?: AbortSignal): Promise<ServerMeta> =>
  requestAt<ServerMeta>(activeBase(), '/meta', { timeoutMs: 10_000, ...(signal ? { signal } : {}) });
