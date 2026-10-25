import type { SpendCapRefusal } from '@claudio/shared';
import type { OpenAiErrorBody, OpenAiErrorCode, OpenAiErrorType } from './wire.ts';

/** A failure as Claudio knows it, before it becomes OpenAI's shape. */
export type OpenAiFailure =
  | { kind: 'auth'; message?: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'model-not-found'; model: string }
  | { kind: 'not-found'; message: string }
  | { kind: 'invalid-request'; message: string; param?: string | null }
  | { kind: 'unsupported-parameter'; message: string; param: string }
  | { kind: 'conflict'; message: string }
  /** The daily spend cap: opens again at local midnight, `SpendState.resetsAt` */
  | { kind: 'spend-cap'; resetsAt: string | null }
  /** The account's usage limit; `resetsAt` as ISO text or epoch seconds, as the limit readings carry it */
  | { kind: 'usage-limit'; resetsAt: string | number | null; message?: string }
  | { kind: 'unavailable'; message: string }
  | { kind: 'server'; message: string };

export interface OpenAiErrorResponse {
  status: number;
  body: OpenAiErrorBody;
  /** For `Retry-After`; absent when no reset time is known */
  retryAfterSeconds?: number;
}

const body = (message: string, type: OpenAiErrorType, code: OpenAiErrorCode | null, param: string | null = null): OpenAiErrorBody => ({
  error: { message, type, param, code },
});

/**
 * Seconds until `resetsAt`, at least one: a `Retry-After: 0` makes SDKs retry in a tight loop
 * against a limit that has not lifted yet.
 */
export function retryAfterSeconds(resetsAt: string | number | null | undefined, now: number): number | undefined {
  if (resetsAt === null || resetsAt === undefined) return undefined;
  // Epoch seconds when numeric: the CLI's rate-limit events and the account readings both count in seconds
  const at = typeof resetsAt === 'number' ? resetsAt * 1000 : Date.parse(resetsAt);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(1, Math.ceil((at - now) / 1000));
}

export function openAiError(failure: OpenAiFailure, now: number = Date.now()): OpenAiErrorResponse {
  switch (failure.kind) {
    case 'auth':
      return { status: 401, body: body(failure.message ?? 'Invalid or missing credential: send `Authorization: Bearer <token>`.', 'invalid_request_error', 'invalid_api_key') };
    case 'forbidden':
      return { status: 403, body: body(failure.message, 'invalid_request_error', 'permission_denied') };
    case 'model-not-found':
      return { status: 404, body: body(`The model \`${failure.model}\` does not exist or no provider here can run it.`, 'invalid_request_error', 'model_not_found', 'model') };
    case 'not-found':
      return { status: 404, body: body(failure.message, 'invalid_request_error', 'not_found') };
    case 'invalid-request':
      return { status: 400, body: body(failure.message, 'invalid_request_error', 'invalid_request_error', failure.param ?? null) };
    case 'unsupported-parameter':
      return { status: 400, body: body(failure.message, 'invalid_request_error', 'unsupported_parameter', failure.param) };
    case 'conflict':
      return { status: 409, body: body(failure.message, 'invalid_request_error', 'conflict') };
    case 'spend-cap': {
      const retry = retryAfterSeconds(failure.resetsAt, now);
      return {
        status: 429,
        body: body("Claudio's daily spend cap was reached; it opens again at local midnight, or when the cap is raised.", 'rate_limit_error', 'rate_limit_exceeded'),
        ...(retry !== undefined ? { retryAfterSeconds: retry } : {}),
      };
    }
    case 'usage-limit': {
      const retry = retryAfterSeconds(failure.resetsAt, now);
      return {
        status: 429,
        body: body(failure.message ?? 'The account reached its usage limit.', 'rate_limit_error', 'rate_limit_exceeded'),
        ...(retry !== undefined ? { retryAfterSeconds: retry } : {}),
      };
    }
    case 'unavailable':
      return { status: 503, body: body(failure.message, 'server_error', 'service_unavailable') };
    case 'server':
      return { status: 500, body: body(failure.message, 'server_error', 'server_error') };
  }
}

/** The 409 the spend gate answers today (`SpendGate.refusal()`), as the 429 an OpenAI client retries on. */
export function failureOfSpendCap(refusal: SpendCapRefusal): OpenAiFailure {
  return { kind: 'spend-cap', resetsAt: refusal.spend.resetsAt };
}

function isSpendCapRefusal(value: unknown): value is SpendCapRefusal {
  return typeof value === 'object' && value !== null && (value as { code?: unknown }).code === 'spend-cap' && typeof (value as { spend?: unknown }).spend === 'object';
}

/**
 * What core and the API throw, mapped by the `statusCode` they already carry (`ChatRefusal`,
 * `ChatConflictError`, `CapabilityRefusal`, `ChatStartError`…). A 5xx's message is shown only when
 * the error says it is meant for the caller (`expose`), the same rule as the API's own handler.
 */
export function failureOfThrown(err: unknown): OpenAiFailure {
  if (isSpendCapRefusal(err)) return failureOfSpendCap(err);
  const status = typeof (err as { statusCode?: unknown } | null)?.statusCode === 'number' ? (err as { statusCode: number }).statusCode : 500;
  const message = err instanceof Error ? err.message : String(err);
  if (status === 401) return { kind: 'auth', message };
  if (status === 403) return { kind: 'forbidden', message };
  if (status === 404) return { kind: 'not-found', message };
  if (status === 409) return { kind: 'conflict', message };
  if (status === 429) return { kind: 'usage-limit', resetsAt: null, message };
  if (status === 503) return { kind: 'unavailable', message };
  if (status >= 400 && status < 500) return { kind: 'invalid-request', message };
  const exposed = (err as { expose?: unknown } | null)?.expose === true;
  return { kind: 'server', message: exposed ? message : 'Internal error.' };
}
