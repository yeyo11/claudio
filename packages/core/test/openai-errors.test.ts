import assert from 'node:assert/strict';
import test from 'node:test';
import type { SpendCapRefusal, SpendState } from '@claudio/shared';
import { ChatConflictError, ChatStartError } from '../src/chat-service.ts';
import { ChatRefusal } from '../src/chats.ts';
import { failureOfSpendCap, failureOfThrown, openAiError, retryAfterSeconds } from '../src/openai/errors.ts';

// Every failure under /v1 answers in OpenAI's shape with the status its SDKs act on
// (docs/openai-compatible-api.md, errors); the rest of the API keeps `{ error: string }`.

const NOW = Date.parse('2026-10-25T12:00:00Z');

test('each failure has its status, type and code', () => {
  const cases: Array<[Parameters<typeof openAiError>[0], number, string, string]> = [
    [{ kind: 'auth' }, 401, 'invalid_request_error', 'invalid_api_key'],
    [{ kind: 'forbidden', message: 'no' }, 403, 'invalid_request_error', 'permission_denied'],
    [{ kind: 'model-not-found', model: 'gpt-4o' }, 404, 'invalid_request_error', 'model_not_found'],
    [{ kind: 'not-found', message: 'chat x not found' }, 404, 'invalid_request_error', 'not_found'],
    [{ kind: 'invalid-request', message: 'bad', param: 'messages' }, 400, 'invalid_request_error', 'invalid_request_error'],
    [{ kind: 'unsupported-parameter', message: 'no n', param: 'n' }, 400, 'invalid_request_error', 'unsupported_parameter'],
    [{ kind: 'conflict', message: 'busy' }, 409, 'invalid_request_error', 'conflict'],
    [{ kind: 'spend-cap', resetsAt: null }, 429, 'rate_limit_error', 'rate_limit_exceeded'],
    [{ kind: 'usage-limit', resetsAt: null }, 429, 'rate_limit_error', 'rate_limit_exceeded'],
    [{ kind: 'unavailable', message: 'later' }, 503, 'server_error', 'service_unavailable'],
    [{ kind: 'server', message: 'boom' }, 500, 'server_error', 'server_error'],
  ];
  for (const [failure, status, type, code] of cases) {
    const { status: s, body } = openAiError(failure, NOW);
    assert.equal(s, status, failure.kind);
    assert.equal(body.error.type, type, failure.kind);
    assert.equal(body.error.code, code, failure.kind);
    assert.equal(typeof body.error.message, 'string');
    assert.ok(body.error.message.length > 0);
  }
  assert.equal(openAiError({ kind: 'model-not-found', model: 'gpt-4o' }).body.error.param, 'model');
  assert.match(openAiError({ kind: 'model-not-found', model: 'gpt-4o' }).body.error.message, /gpt-4o/);
  assert.equal(openAiError({ kind: 'unsupported-parameter', message: 'x', param: 'n' }).body.error.param, 'n');
  assert.equal(openAiError({ kind: 'server', message: 'x' }).body.error.param, null);
});

test('the spend cap is a 429 whose Retry-After counts to the reset', () => {
  const spend = { resetsAt: '2026-10-25T22:00:00.000Z' } as SpendState;
  const refusal: SpendCapRefusal = { error: 'cap', code: 'spend-cap', spend };
  const error = openAiError(failureOfSpendCap(refusal), NOW);
  assert.equal(error.status, 429);
  assert.equal(error.retryAfterSeconds, 10 * 3600);
  // The same refusal thrown, as a route that rethrows the gate's body would
  assert.deepEqual(failureOfThrown(refusal), { kind: 'spend-cap', resetsAt: spend.resetsAt });
});

test('the usage limit takes its reset in ISO text or epoch seconds', () => {
  assert.equal(openAiError({ kind: 'usage-limit', resetsAt: '2026-10-25T12:01:00Z' }, NOW).retryAfterSeconds, 60);
  assert.equal(openAiError({ kind: 'usage-limit', resetsAt: NOW / 1000 + 90 }, NOW).retryAfterSeconds, 90);
  assert.equal(openAiError({ kind: 'usage-limit', resetsAt: null }, NOW).retryAfterSeconds, undefined);
});

test('Retry-After is never zero or negative, which would make SDKs hammer a limit still in force', () => {
  assert.equal(retryAfterSeconds('2026-10-25T11:00:00Z', NOW), 1);
  assert.equal(retryAfterSeconds(NOW / 1000, NOW), 1);
  assert.equal(retryAfterSeconds('not a date', NOW), undefined);
});

test("core's own errors map by the status they already carry", () => {
  assert.equal(openAiError(failureOfThrown(new ChatRefusal('chat x not found', 404))).status, 404);
  assert.equal(openAiError(failureOfThrown(new ChatRefusal('bad cwd'))).status, 400);
  assert.equal(openAiError(failureOfThrown(new ChatRefusal('no account can run', 503))).status, 503);
  assert.equal(openAiError(failureOfThrown(new ChatConflictError('read only', 'fork'))).status, 409);
  assert.equal(openAiError(failureOfThrown(Object.assign(new Error('nope'), { statusCode: 401 }))).body.error.code, 'invalid_api_key');
  assert.equal(openAiError(failureOfThrown(Object.assign(new Error('chat token'), { statusCode: 403 }))).status, 403);
  assert.equal(openAiError(failureOfThrown(Object.assign(new Error('slow down'), { statusCode: 429 }))).status, 429);
  assert.equal(openAiError(failureOfThrown(Object.assign(new Error('teapot'), { statusCode: 418 }))).status, 400);
});

test('a server error shows its message only when it is meant for the caller', () => {
  const exposed = openAiError(failureOfThrown(new ChatStartError('the chat could not start: spawn ENOENT')));
  assert.equal(exposed.status, 500);
  assert.match(exposed.body.error.message, /spawn ENOENT/);
  const hidden = openAiError(failureOfThrown(new Error('SQLITE_CORRUPT at /home/someone/.config')));
  assert.equal(hidden.status, 500);
  assert.ok(!hidden.body.error.message.includes('/home/someone'));
  assert.equal(openAiError(failureOfThrown('a string')).status, 500);
});

test("a start refused with a code a client acts on keeps it, in /v1's snake_case and with the REST status", () => {
  const refusal = (reason: string, statusCode: number) => Object.assign(new Error(`refused: ${reason}`), { statusCode, reason });
  const cases: Array<[string, number, string]> = [
    ['cwd-missing', 400, 'cwd_missing'],
    ['workspace-not-found', 404, 'workspace_not_found'],
    ['workspace-expired', 410, 'workspace_expired'],
    ['policy-mismatch', 409, 'policy_mismatch'],
  ];
  for (const [reason, status, code] of cases) {
    const shaped = openAiError(failureOfThrown(refusal(reason, status)));
    assert.equal(shaped.status, status, reason);
    assert.deepEqual(shaped.body.error, { message: `refused: ${reason}`, type: 'invalid_request_error', param: null, code });
  }
  // Any other reason keeps the reading by status
  assert.equal(openAiError(failureOfThrown(refusal('workspace-too-large', 413))).body.error.code, 'invalid_request_error');
});
