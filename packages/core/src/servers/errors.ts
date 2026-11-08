/**
 * A refusal of the hub's (docs/plans/claudio-servers.md, §4.2): an HTTP status and an i18n code the
 * API answers as `code`, the shape `ServerLinkError` has on the remote side.
 */
export class ServersError extends Error {
  constructor(
    readonly statusCode: number,
    readonly reason: string,
    message: string,
    /** Fields the answer carries beside `error` and `code`, for a refusal the person acts on (the fingerprint to confirm) */
    readonly details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
  }
}

/**
 * The `ServersError` behind a failure. undici hands a connector's error back as it is, but may wrap
 * it on the way (a request aborted while connecting), so the causes are followed a few levels down.
 */
export function serversErrorOf(error: unknown): ServersError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth++) {
    if (current instanceof ServersError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export const notFound = (id: string): ServersError => new ServersError(404, 'servers.not-found', `no server with id ${id}`);

export const disabled = (): ServersError => new ServersError(409, 'servers.disabled', 'Servers are off: turn them on in the settings first (PUT /servers/settings)');
