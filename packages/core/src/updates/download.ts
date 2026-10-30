import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { Readable, Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { errorMessage } from '@claudio/shared';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Why a download failed. `interrupted`: the connection dropped, reset or went quiet once the answer
 * had started (a short body included); `network`: no answer at all; `http`: an answer other than the
 * file; `wrong-size`: a size other than the one the caller expects, announced or sent; `disk`: the file could not be written.
 */
export type DownloadFailure = 'interrupted' | 'network' | 'http' | 'wrong-size' | 'disk';

export class DownloadError extends Error {
  constructor(
    readonly kind: DownloadFailure,
    message: string,
    /** Whether another attempt can change the outcome */
    readonly retryable: boolean,
    readonly status?: number,
    /** The system error behind it (`ENOSPC`…), when there is one */
    readonly code?: string,
  ) {
    super(message);
  }
}

/** An answer as the downloader reads it, whichever client brought it */
export interface Opened {
  status: number;
  header: (name: string) => string | undefined;
  body: Readable;
}

export type Opener = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; idleTimeoutMs: number }) => Promise<Opened>;

/** What tunes the downloader; production takes the defaults, tests shorten the waits */
export interface DownloadTuning {
  open?: Opener;
  /** The wait before each retry; its length is the number of retries */
  backoffMs?: readonly number[];
  /** How long the connection may stay silent before the attempt counts as interrupted */
  idleTimeoutMs?: number;
  wait?: (ms: number) => Promise<void>;
  /** The stream the body is written through; tests slow it down to hold back-pressure */
  createWriter?: (file: string, flags: 'w' | 'a') => Writable;
}

export interface DownloadOptions extends DownloadTuning {
  headers?: Record<string, string>;
  /** The exact size the file must have (a signed manifest's): more fails at once, less is an interruption */
  size?: number;
  /** How long one attempt may take in all */
  attemptTimeoutMs?: number;
  onProgress?: (received: number, total: number | null) => void;
  onRetry?: (retry: number, error: DownloadError, resumeFrom: number) => void;
}

export interface DownloadResult {
  bytes: number;
  attempts: number;
  /** The attempts that went on from a partial file instead of starting over */
  resumed: number;
}

/** Three retries, the last one half a minute later: long enough for a dropped link or a CDN hiccup */
export const DEFAULT_BACKOFF_MS: readonly number[] = [2_000, 8_000, 30_000];
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 30 * 60_000;
const MAX_REDIRECTS = 5;

const DISK_CODES = new Set(['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'EISDIR', 'ENOTDIR', 'EMFILE', 'ENFILE', 'EIO']);
const NO_ANSWER_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED']);

const noop = () => undefined;

/** Any thrown value as a `DownloadError`; a code we do not recognise is taken for a dropped connection, which another attempt may get past */
function classify(err: unknown, answered: boolean): DownloadError {
  if (err instanceof DownloadError) return err;
  const code = (err as NodeJS.ErrnoException | null)?.code ?? '';
  const message = errorMessage(err);
  if (DISK_CODES.has(code)) return new DownloadError('disk', message, false, undefined, code);
  if (!answered && NO_ANSWER_CODES.has(code)) return new DownloadError('network', message, true);
  return new DownloadError(answered ? 'interrupted' : 'network', message || code || 'the connection failed', true);
}

/**
 * The default client: `node:http`/`node:https`, following redirects. Not `fetch`: undici's parser
 * asserts `!this.paused` when a `Connection: close` server ends the socket while the body is paused
 * by back-pressure, and throws that from a socket listener, where no caller can catch it (the desktop
 * smoke run, Node 24.22). The listeners added here stay for the request's whole life, so an error
 * the socket raises after the caller gave up has somewhere to go.
 */
export const httpOpener: Opener = (url, init) => openHttp(url, init, 0);

function openHttp(url: string, init: Parameters<Opener>[1], redirects: number): Promise<Opened> {
  const target = new URL(url);
  const client = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null;
  if (!client) return Promise.reject(new DownloadError('network', `cannot download ${target.protocol} URLs`, false));
  return new Promise<Opened>((resolve, reject) => {
    let answered = false;
    const req = client.get(target, { headers: init.headers, signal: init.signal, timeout: init.idleTimeoutMs });
    req.on('timeout', () => req.destroy(new DownloadError(answered ? 'interrupted' : 'network', `no data for ${String(init.idleTimeoutMs)} ms`, true)));
    req.on('error', (err) => reject(classify(err, answered)));
    req.on('response', (res) => {
      answered = true;
      res.on('error', noop);
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && status !== 304 && location) {
        res.resume();
        const next = new URL(location, target);
        if (redirects >= MAX_REDIRECTS) return reject(new DownloadError('http', `${url} redirected too many times`, false, status));
        // A signed asset could be fetched over plain HTTP from a test server, but never downgraded to it
        if (target.protocol === 'https:' && next.protocol !== 'https:') return reject(new DownloadError('http', `${url} redirected to ${next.protocol}`, false, status));
        openHttp(next.href, init, redirects + 1).then(resolve, reject);
        return;
      }
      const header = (name: string) => {
        const value = res.headers[name.toLowerCase()];
        return Array.isArray(value) ? value[0] : value;
      };
      resolve({ status, header, body: res });
    });
  });
}

/** An `Opener` over an injected `fetch`, for tests that serve their answers from a map */
export function fetchOpener(fetchFn: typeof fetch): Opener {
  return async (url, init) => {
    let res: Response;
    try {
      res = await fetchFn(url, { headers: init.headers, signal: init.signal });
    } catch (err) {
      throw classify(err, false);
    }
    const body = res.body ? Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]) : Readable.from([]);
    body.on('error', noop);
    return { status: res.status, header: (name) => res.headers.get(name) ?? undefined, body };
  };
}

/** What the last answer allowed the next attempt to ask for */
interface Resume {
  /** `Accept-Ranges: bytes` */
  ranges: boolean;
  /** A strong ETag or a Last-Modified date, sent as `If-Range` so a changed file comes whole */
  validator: string | null;
}

const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+|\*)$/;

/**
 * Downloads `url` into `file`, retrying an interrupted transfer with back-off. A retry goes on from
 * the partial file with `Range` when the server advertised `Accept-Ranges: bytes` and answers 206 from
 * exactly where the file ends; otherwise it starts over. Resolves only once the file holds the whole
 * body: a partial file never counts as done, so the caller's hash or signature check runs on all of it.
 */
export async function downloadFile(url: string, file: string, o: DownloadOptions = {}): Promise<DownloadResult> {
  const backoff = o.backoffMs ?? DEFAULT_BACKOFF_MS;
  const wait = o.wait ?? ((ms: number) => sleep(ms));
  let resume: Resume = { ranges: false, validator: null };
  let total: number | null = o.size ?? null;
  let resumed = 0;
  rmSync(file, { force: true });
  for (let attempt = 0; ; attempt += 1) {
    const offset = attempt > 0 && resume.ranges ? sizeOf(file) : 0;
    const from = total !== null && offset >= total ? 0 : offset;
    try {
      const done = await attemptOnce(url, file, from, resume.validator, total, o, (next) => {
        resume = next.resume;
        total = next.total ?? total;
      });
      if (done.resumedFrom > 0) resumed += 1;
      return { bytes: done.bytes, attempts: attempt + 1, resumed };
    } catch (err) {
      const failure = classify(err, true);
      if (!failure.retryable || attempt >= backoff.length) {
        rmSync(file, { force: true });
        throw failure;
      }
      const next = resume.ranges ? sizeOf(file) : 0;
      o.onRetry?.(attempt + 1, failure, next);
      await wait(backoff[attempt] ?? 0);
    }
  }
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

async function attemptOnce(
  url: string,
  file: string,
  offset: number,
  validator: string | null,
  knownTotal: number | null,
  o: DownloadOptions,
  learn: (next: { resume: Resume; total: number | null }) => void,
): Promise<{ bytes: number; resumedFrom: number }> {
  const headers: Record<string, string> = { ...o.headers };
  if (offset > 0) {
    headers.range = `bytes=${String(offset)}-`;
    if (validator) headers['if-range'] = validator;
  }
  const open = o.open ?? httpOpener;
  const res = await open(url, { headers, signal: AbortSignal.timeout(o.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS), idleTimeoutMs: o.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS });
  const discard = () => res.body.destroy();
  let start = 0;
  let total: number | null = null;
  if (res.status === 206 && offset > 0) {
    const range = CONTENT_RANGE.exec(res.header('content-range') ?? '');
    const first = range ? Number(range[1]) : NaN;
    const whole = range?.[3] === '*' || !range ? null : Number(range[3]);
    if (first !== offset || (whole !== null && knownTotal !== null && whole !== knownTotal)) {
      discard();
      // Not the rest of the file we hold: the next attempt starts over
      learn({ resume: { ranges: false, validator: null }, total: null });
      throw new DownloadError('interrupted', `${url} answered a range that does not continue the partial file`, true, 206);
    }
    start = offset;
    total = whole;
  } else if (res.status === 200) {
    const length = Number(res.header('content-length') ?? NaN);
    total = Number.isFinite(length) ? length : null;
  } else {
    discard();
    if (res.status === 416) {
      learn({ resume: { ranges: false, validator: null }, total: null });
      throw new DownloadError('interrupted', `${url} refused the range`, true, 416);
    }
    // A server error or a rate limit may pass; anything else will answer the same again
    const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
    throw new DownloadError('http', `${url} answered ${String(res.status)}`, retryable, res.status);
  }
  const etag = res.header('etag');
  learn({
    resume: { ranges: /\bbytes\b/i.test(res.header('accept-ranges') ?? '') || res.status === 206, validator: etag && !etag.startsWith('W/') ? etag : (res.header('last-modified') ?? null) },
    total,
  });
  const expected = total ?? knownTotal;
  // The server announces another file than the signed one: no retry will make it match
  if (o.size !== undefined && expected !== null && expected !== o.size) {
    discard();
    throw new DownloadError('wrong-size', `${url} is ${String(expected)} bytes, not the ${String(o.size)} expected`, false);
  }
  let received = start;
  const count = new Transform({
    transform: (chunk: Buffer, _encoding, done) => {
      received += chunk.length;
      if (o.size !== undefined && received > o.size) {
        done(new DownloadError('wrong-size', `${url} sent more than the ${String(o.size)} bytes expected`, false));
        return;
      }
      o.onProgress?.(received, o.size ?? expected);
      done(null, chunk);
    },
  });
  const writer = (o.createWriter ?? ((path, flags) => createWriteStream(path, { flags, mode: 0o600 })))(file, start > 0 ? 'a' : 'w');
  writer.on('error', noop);
  try {
    await pipeline(res.body, count, writer);
  } catch (err) {
    // The partial file's size is what the next attempt resumes from, so it must be final first
    await closed(writer);
    throw classify(err, true);
  }
  const want = o.size ?? expected;
  if (want !== null && received !== want) {
    throw new DownloadError('interrupted', `${url} ended after ${String(received)} of ${String(want)} bytes`, true);
  }
  return { bytes: received, resumedFrom: start };
}

function closed(stream: Writable): Promise<void> {
  if (stream.closed) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once('close', () => resolve());
    // A stream that never emits `close` (one built with `emitClose: false`) must not hold the retry forever
    setTimeout(resolve, 1_000).unref();
  });
}

/** The digest of a whole file, read back from disk: what was written is what is checked */
export async function hashFile(file: string, algorithm: 'sha256' | 'sha512', encoding: 'hex' | 'base64' = 'hex'): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest(encoding);
}
