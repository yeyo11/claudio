import { activeBase } from '@claudio/ui/lib/server-scope';
import { requestAt } from '../api';

/*
 * What a server says about itself, and whether this web can drive it.
 *
 * `ServerMeta` is the contract of docs/plans/claudio-servers.md §9.1, owned by the `remote-side`
 * task. It is mirrored here only because that task lands on its own branch; once both are merged
 * the interface and `WEB_API_VERSION` should be replaced by the shared `ServerMeta` and
 * `API_VERSION`, which must agree with these values.
 */
export interface ServerMeta {
  instanceId: string;
  version: string;
  apiVersion: { current: number; min: number };
  capabilities: string[];
}

/** The API version this web was built against (the shared `API_VERSION` once that lands) */
export const WEB_API_VERSION = 1;

export type Compatibility = 'ok' | 'server-too-old' | 'web-too-old';

/**
 * A server answers routes correctly for `min..current`. This web is at `webVersion`: above the
 * server's current one it asks for routes the server lacks (the server must update), below its
 * minimum the server has dropped routes this web still uses (this Claudio must update). Anything
 * the server sent that is not a pair of integers is not compatible with it either.
 */
export function compatibility(meta: Pick<ServerMeta, 'apiVersion'> | null | undefined, webVersion: number = WEB_API_VERSION): Compatibility {
  const range = meta?.apiVersion;
  if (!range || !Number.isInteger(range.current) || !Number.isInteger(range.min) || range.min > range.current) return 'server-too-old';
  if (webVersion > range.current) return 'server-too-old';
  if (webVersion < range.min) return 'web-too-old';
  return 'ok';
}

/** `GET /meta` of the server this page is scoped to, through the gateway when it is a remote */
export const readMeta = (signal?: AbortSignal): Promise<ServerMeta> =>
  requestAt<ServerMeta>(activeBase(), '/meta', { timeoutMs: 10_000, ...(signal ? { signal } : {}) });
