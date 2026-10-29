/** Exit codes of `claudio` (docs/plans/headless-image.md, "The claudio command"). */
export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A refusal the command reports in one line and ends on, with the exit code it means. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode,
  ) {
    super(message);
  }
}

/** The person pressed Ctrl-C: whatever is open on the server is cancelled before the command ends. */
export class Interrupted extends Error {
  constructor() {
    super('interrupted');
  }
}

/** Long enough for a server that is busy, short enough that a wedged one does not hang an operator's shell. */
const REQUEST_TIMEOUT_MS = 15_000;

export interface ApiAnswer<T> {
  status: number;
  body: T;
}

/**
 * The few routes `claudio` calls, over HTTP like any other client of the API: the command holds no
 * state of its own and reads nothing of the server's but what the routes answer.
 */
export class Api {
  constructor(
    readonly base: string,
    private readonly token: string | null,
    /** Aborted on Ctrl-C */
    private readonly interrupt: AbortSignal,
  ) {}

  /**
   * `allow` lists the non-2xx statuses the caller reads itself (`503` from `/api/ready`); any other
   * is a `CliError`. `interruptible: false` is for the cancel sent after Ctrl-C, which must still go out.
   */
  async request<T>(method: string, path: string, opts: { body?: unknown; allow?: number[]; interruptible?: boolean } = {}): Promise<ApiAnswer<T>> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = opts.interruptible === false ? timeout : AbortSignal.any([this.interrupt, timeout]);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, { method, headers, signal, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
    } catch (err) {
      if (opts.interruptible !== false && this.interrupt.aborted) throw new Interrupted();
      if (timeout.aborted) throw new CliError(`Claudio at ${this.base} did not answer within ${String(REQUEST_TIMEOUT_MS / 1000)} s`, EXIT.usage);
      throw new CliError(`cannot reach Claudio at ${this.base}: ${reason(err)}`, EXIT.usage);
    }
    const text = await res.text().catch(() => '');
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new CliError(`${this.base} answered ${method} ${path} with something that is not Claudio's JSON (HTTP ${String(res.status)})`, EXIT.usage);
    }
    if (res.ok || opts.allow?.includes(res.status)) return { status: res.status, body: body as T };
    const said = errorText(body);
    // A credential or host refusal is the operator's to fix before anything can work: a usage error
    if (res.status === 401) throw new CliError(`Claudio refused the credential (401): pass --token or set CLAUDIO_AUTH_TOKEN`, EXIT.usage);
    if (res.status === 403 || res.status === 421) throw new CliError(`Claudio refused ${method} ${path} (${String(res.status)})${said ? `: ${said}` : ''}`, EXIT.usage);
    throw new CliError(`${method} ${path} failed (${String(res.status)})${said ? `: ${said}` : ''}`, EXIT.failed);
  }
}

function errorText(body: unknown): string | null {
  if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') return body.error;
  return null;
}

/** fetch wraps the socket's error (`ECONNREFUSED`) in a `TypeError: fetch failed`; the cause is what helps */
function reason(err: unknown): string {
  const cause = err instanceof Error ? err.cause : undefined;
  if (cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string') return cause.code;
  if (cause instanceof Error) return cause.message;
  return err instanceof Error ? err.message : String(err);
}
