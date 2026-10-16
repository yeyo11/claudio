import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { RateLimitInfo } from '@claudio/shared';
import { ClaudeBranches } from '../src/providers/claude-code/branches.ts';
import { unreportedOf } from '../src/providers/claude-code/context-usage.ts';
import { ClaudeCodeDriver } from '../src/providers/claude-code/driver.ts';
import type { DriverEvent } from '../src/providers/driver.ts';
import { limitFromInfo } from '../src/providers/limits.ts';

function attach() {
  const written: Array<Record<string, unknown>> = [];
  const events: DriverEvent[] = [];
  const io = { write: (text: string) => void written.push(JSON.parse(text) as Record<string, unknown>), end: () => {}, up: () => true };
  const session = new ClaudeCodeDriver('claude').attach(io, (e) => events.push(e), new ClaudeBranches());
  return { session, written, events };
}

test('a result carries every per-model token field, and a missing one is absent', () => {
  const { session, events } = attach();
  session.readLine(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'ok',
      modelUsage: {
        'claude-opus-4': {
          inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40,
          webSearchRequests: 2, maxOutputTokens: 32000, costUSD: 0.5, contextWindow: 200000,
        },
        'claude-haiku': { costUSD: 0.01, inputTokens: 'x' },
      },
    }),
  );
  const result = events.find((e) => e.kind === 'result');
  assert.ok(result && result.kind === 'result');
  assert.deepEqual(result.modelUsage, [
    {
      model: 'claude-opus-4', costUsd: 0.5, contextWindow: 200000, inputTokens: 10, outputTokens: 20,
      cacheReadInputTokens: 30, cacheCreationInputTokens: 40, webSearchRequests: 2, maxOutputTokens: 32000,
    },
    { model: 'claude-haiku', costUsd: 0.01 },
  ]);
});

test('a rate_limit_event passes overage and utilization through', () => {
  const { session, events } = attach();
  session.readLine(
    JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed', utilization: 0.7, surpassedThreshold: 0.5, overageStatus: 'allowed', isUsingOverage: true,
        overageResetsAt: 1_800_000_000, overageDisabledReason: 'none',
      },
    }),
  );
  const event = events.find((e) => e.kind === 'rate-limit');
  assert.ok(event && event.kind === 'rate-limit');
  assert.deepEqual(
    [event.info.utilization, event.info.surpassedThreshold, event.info.overageStatus, event.info.isUsingOverage, event.info.overageResetsAt, event.info.overageDisabledReason],
    [0.7, 0.5, 'allowed', true, 1_800_000_000, 'none'],
  );
});

test('a stderr line that says rate limit is only stderr', () => {
  const { session, events } = attach();
  session.readError('Error: API rate limit exceeded; usage limit reached');
  assert.deepEqual(events, [{ kind: 'stderr', text: 'Error: API rate limit exceeded; usage limit reached' }]);
});

test('a result is the account\'s limit by its 429, never by its wording', () => {
  const resultOf = (raw: Record<string, unknown>) => {
    const { session, events } = attach();
    session.readLine(JSON.stringify({ type: 'result', subtype: 'error_during_execution', num_turns: 1, ...raw }));
    const result = events.find((e) => e.kind === 'result');
    assert.ok(result && result.kind === 'result');
    return result.rateLimited;
  };
  assert.equal(resultOf({ is_error: true, api_error_status: 429, result: "You've hit your usage limit" }), true);
  assert.equal(resultOf({ is_error: true, api_error_status: 429 }), true, 'the status alone is enough');
  assert.equal(resultOf({ is_error: true, result: 'The tests failed: the client hit a rate limit' }), false, 'a work failure that quotes a limit');
  assert.equal(resultOf({ is_error: false, api_error_status: 429, result: 'ok' }), false);
});

test('a limit says it is using overage and when that resets; without them it reads as before', () => {
  const base: RateLimitInfo = { status: 'allowed', windows: { '5h': { utilization: 0.2, resetsAt: 1_800_000_000 } }, observedAt: 'x' };
  const plain = limitFromInfo('claude-code', base, 'stream', 'x');
  assert.equal(plain.overage, undefined);
  assert.equal(plain.state, 'ok');
  const over = limitFromInfo('claude-code', { ...base, isUsingOverage: true, overageResetsAt: 1_800_003_600, overageStatus: 'allowed' }, 'stream', 'x');
  assert.deepEqual(over.overage, { status: 'allowed', using: true, resetsAt: new Date(1_800_003_600_000).toISOString() });
  assert.equal(over.state, 'near');
  assert.equal(limitFromInfo('claude-code', { ...base, windows: {}, surpassedThreshold: 0.75 }, 'stream', 'x').state, 'near');
  assert.equal(limitFromInfo('claude-code', { ...base, windows: {}, utilization: 0.4 }, 'stream', 'x').utilization, 0.4);
});

const recorded = (file: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/recordings/claude/${file}`, import.meta.url)), 'utf8')) as Record<string, unknown>;

test('contextUsage returns the recorded answer; detail is sent only when given; an error rejects without killing the session', async () => {
  const { session, written } = attach();
  const reply = (body: Record<string, unknown>) => {
    const last = written.at(-1) as { request_id: string };
    session.readLine(JSON.stringify({ type: 'control_response', response: { request_id: last.request_id, ...body } }));
  };
  const full = recorded('context-usage-full.json');
  const usage = session.contextUsage?.();
  assert.deepEqual((written.at(-1) as { request: unknown }).request, { subtype: 'get_context_usage' });
  reply({ subtype: 'success', response: full });
  assert.deepEqual(await usage, full);

  const summary = recorded('context-usage-summary.json');
  const light = session.contextUsage?.('summary');
  assert.deepEqual((written.at(-1) as { request: unknown }).request, { subtype: 'get_context_usage', detail: 'summary' });
  reply({ subtype: 'success', response: summary });
  assert.deepEqual(await light, summary);

  // What the CLI answered an invented subtype with, and a bad `detail`, both recorded (F1, F4)
  const errors = recorded('context-usage-errors.json') as Record<string, { answer: { response: Record<string, unknown> } }>;
  const failing = session.contextUsage?.();
  reply({ subtype: 'error', error: errors.unknownSubtype?.answer.response.error });
  await assert.rejects(failing as Promise<unknown>, (e: unknown) => unreportedOf(e) === 'unsupported');
  const refused = session.contextUsage?.();
  reply({ subtype: 'error', error: errors.invalidDetail?.answer.response.error });
  await assert.rejects(refused as Promise<unknown>, (e: unknown) => unreportedOf(e) === 'refused');
  const again = session.contextUsage?.();
  reply({ subtype: 'success', response: {} });
  assert.deepEqual(await again, {});
});

test('a control request nobody answers is a timeout, not a refusal', () => {
  assert.equal(unreportedOf(new Error('the CLI did not answer get_context_usage in time')), 'timeout');
});

test('setOption maxThinkingTokens sends set_max_thinking_tokens and resolves on the answer', async () => {
  const { session, written } = attach();
  const sent = session.setOption({ maxThinkingTokens: 4000 });
  const last = written.at(-1) as { request_id: string; request: unknown };
  assert.deepEqual(last.request, { subtype: 'set_max_thinking_tokens', max_thinking_tokens: 4000 });
  session.readLine(JSON.stringify({ type: 'control_response', response: { request_id: last.request_id, subtype: 'success' } }));
  await sent;
});

test('a can_use_tool request carries the blocked path, reason, title, display name and agent; without them it is unchanged', () => {
  const { session, events } = attach();
  const request = { subtype: 'can_use_tool', tool_name: 'Edit', tool_use_id: 't1', input: {} };
  const extra = { blocked_path: '/etc/hosts', decision_reason: 'outside the project', title: 'Edit hosts', display_name: 'Edit', agent_id: 'sub-1' };
  session.readLine(JSON.stringify({ type: 'control_request', request_id: 'r1', request: { ...request, ...extra } }));
  session.readLine(JSON.stringify({ type: 'control_request', request_id: 'r2', request }));
  const questions = events.flatMap((e) => (e.kind === 'permission-request' ? [e.question] : []));
  assert.equal(questions.length, 2);
  assert.deepEqual(
    [questions[0]?.blockedPath, questions[0]?.decisionReason, questions[0]?.title, questions[0]?.displayName, questions[0]?.agentId],
    ['/etc/hosts', 'outside the project', 'Edit hosts', 'Edit', 'sub-1'],
  );
  assert.deepEqual(questions[1], { id: 'r2', toolName: 'Edit', toolUseId: 't1', input: {} });
});
