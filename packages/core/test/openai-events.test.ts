import assert from 'node:assert/strict';
import test from 'node:test';
import type { RunEvent, RunOutcome, TokenUsage, TranscriptEntry } from '@claudio/shared';
import { ChatCompletionTranslator, completionUsage, finishReasonOf, tokenUsageOf } from '../src/openai/events.ts';
import { STREAM_DONE, type ChatCompletionChunk, type ChatCompletionStreamItem, type OpenAiErrorBody } from '../src/openai/wire.ts';

// The event half (docs/openai-compatible-api.md): Claudio's RunEvent stream as Chat Completions,
// whole and in chunks. Each chunk rule here is one that breaks a real client when it is missing.

let seq = 0;
const ev = (event: Omit<RunEvent, 'seq' | 'ts'>): RunEvent => ({ seq: ++seq, ts: '2026-10-25T00:00:00Z', ...event });
const textStart = (text: string, block: 'text' | 'thinking' = 'text') => ev({ kind: 'partial', block, text });
const textAppend = (append: string, at: number, block: 'text' | 'thinking' = 'text') => ev({ kind: 'partial', block, append, at });
const entry = (texts: string[], extra: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  uuid: `u${String(++seq)}`,
  role: 'assistant',
  timestamp: null,
  model: 'claude',
  isSidechain: false,
  parentToolUseId: null,
  blocks: texts.map((text) => ({ type: 'text' as const, text })),
  ...extra,
});
const message = (texts: string[], extra: Partial<TranscriptEntry> = {}) => ev({ kind: 'message', entry: entry(texts, extra) });
const outcome = (patch: Partial<RunOutcome> = {}): RunOutcome => ({ isError: false, turns: 1, durationMs: 10, costUsd: 0.0123, permissionDenials: [], ...patch });
const result = (patch: Partial<RunOutcome> = {}, text = '') => ev({ kind: 'result', text, outcome: outcome(patch) });
const USAGE: TokenUsage = { input: 10, output: 5, cacheRead: 100, cacheCreation: 20, total: 135 };

const translator = (includeUsage = false) => new ChatCompletionTranslator({ id: 'chatcmpl-1', model: 'sonnet', created: 1_700_000_000, includeUsage });

const isChunk = (item: ChatCompletionStreamItem): item is ChatCompletionChunk => typeof item === 'object' && 'object' in item;
const chunksOf = (items: ChatCompletionStreamItem[]): ChatCompletionChunk[] => items.filter(isChunk);
const contentOf = (items: ChatCompletionStreamItem[]): string => chunksOf(items).map((c) => c.choices[0]?.delta.content ?? '').join('');

function run(t: ChatCompletionTranslator, events: RunEvent[], usage: TokenUsage | null = USAGE): ChatCompletionStreamItem[] {
  return events.flatMap((e) => t.push(e, { usage }));
}

test('partials stream as content, and the closing message adds only what was never streamed', () => {
  const t = translator();
  const items = run(t, [textStart('Hel'), textAppend('lo, wor', 3), message(['Hello, world.']), result()]);
  assert.equal(contentOf(items), 'Hello, world.');
  assert.deepEqual(
    chunksOf(items).map((c) => c.choices[0]?.delta.content),
    ['Hel', 'lo, wor', 'ld.', undefined],
  );
  const end = t.end();
  assert.equal(end?.kind, 'completion');
  if (end?.kind === 'completion') assert.equal(end.completion.choices[0]?.message.content, 'Hello, world.');
});

test('an append that repeats text already held sends only what is new', () => {
  const items = run(translator(), [textStart('abc'), textAppend('cde', 2), message(['abcde']), result()]);
  assert.equal(contentOf(items), 'abcde');
});

test('a message with no partials at all is sent whole', () => {
  assert.equal(contentOf(run(translator(), [message(['All at once.']), result()])), 'All at once.');
});

test('thinking never reaches the client', () => {
  const items = run(translator(), [textStart('Let me think', 'thinking'), textAppend(' hard', 12, 'thinking'), textStart('Answer'), message(['Answer']), result()]);
  assert.equal(contentOf(items), 'Answer');
});

test('two stretches of text, before and after a tool ran, are one answer with a blank line between', () => {
  const items = run(translator(), [
    textStart("I'll look."),
    message(["I'll look."]),
    ev({ kind: 'message', entry: { ...entry([]), role: 'user', blocks: [{ type: 'tool_result', toolUseId: 't', content: 'x', isError: false }] } }),
    textStart('Found it.'),
    message(['Found it.']),
    result(),
  ]);
  assert.equal(contentOf(items), "I'll look.\n\nFound it.");
});

test("a subagent's messages are not the answer", () => {
  const items = run(translator(), [message(['from a subagent'], { isSidechain: true }), message(['nested'], { parentToolUseId: 'toolu_1' }), message(['mine']), result()]);
  assert.equal(contentOf(items), 'mine');
});

test('the first chunk carries the assistant role, and only the first', () => {
  const chunks = chunksOf(run(translator(), [textStart('a'), textAppend('b', 1), message(['ab']), result()]));
  assert.equal(chunks[0]?.choices[0]?.delta.role, 'assistant');
  for (const c of chunks.slice(1)) assert.equal(c.choices[0]?.delta.role, undefined);
});

test('an empty answer still opens with the role, and ends with a finish reason', () => {
  const chunks = chunksOf(run(translator(), [result()]));
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0]?.choices[0]?.delta, { role: 'assistant', content: '' });
  assert.equal(chunks[0]?.choices[0]?.finish_reason, 'stop');
});

test('every chunk has usage null, and the usage chunk comes last with no choices when asked for', () => {
  const items = run(translator(true), [textStart('Hi'), message(['Hi']), result()]);
  assert.equal(items.at(-1), STREAM_DONE);
  const chunks = chunksOf(items);
  const usageChunk = chunks.at(-1);
  assert.deepEqual(usageChunk?.choices, []);
  assert.deepEqual(usageChunk?.usage, { prompt_tokens: 130, completion_tokens: 5, total_tokens: 135, prompt_tokens_details: { cached_tokens: 100 } });
  for (const c of chunks.slice(0, -1)) {
    assert.equal(c.usage, null);
    assert.equal(c.choices.length, 1);
  }
});

test('without include_usage no usage chunk is sent', () => {
  const chunks = chunksOf(run(translator(false), [message(['Hi']), result()]));
  assert.ok(chunks.every((c) => c.usage === null && c.choices.length === 1));
});

test('usage is never made up: with no counts there is no usage chunk and no usage in the body', () => {
  const t = translator(true);
  const chunks = chunksOf(run(t, [message(['Hi']), result()], null));
  assert.ok(chunks.every((c) => c.usage === null));
  const end = t.end();
  assert.ok(end?.kind === 'completion' && !('usage' in end.completion));
});

test('the whole response carries usage and returns the cost apart, never in the body', () => {
  const t = translator();
  run(t, [message(['Hi']), result({ costUsd: 0.5 })]);
  const end = t.end();
  assert.equal(end?.kind, 'completion');
  if (end?.kind !== 'completion') return;
  assert.equal(end.costUsd, 0.5);
  assert.equal(end.completion.object, 'chat.completion');
  assert.equal(end.completion.usage?.total_tokens, 135);
  assert.ok(!JSON.stringify(end.completion).includes('0.5'), 'the cost is not in the body');
  assert.equal(end.text, 'Hi');
});

test('the stream ends with the [DONE] sentinel, once, and nothing follows the end', () => {
  const t = translator();
  const items = run(t, [message(['Hi']), result()]);
  assert.equal(items.filter((i) => i === STREAM_DONE).length, 1);
  assert.equal(items.at(-1), STREAM_DONE);
  assert.deepEqual(t.push(message(['late'])), []);
  assert.deepEqual(t.push(result()), []);
});

test('a failed result mid-stream becomes an error chunk before [DONE], never a silent end', () => {
  const t = translator();
  const items = run(t, [textStart('Half an ans'), result({ isError: true }, 'API Error: overloaded')]);
  assert.equal(items.at(-1), STREAM_DONE);
  const error = items.at(-2) as OpenAiErrorBody;
  assert.equal(error.error.type, 'server_error');
  assert.match(error.error.message, /overloaded/);
  assert.ok(!chunksOf(items).some((c) => c.choices[0]?.finish_reason), 'no finish reason claims the answer was complete');
  assert.equal(t.end()?.kind, 'error');
});

test('a usage limit mid-stream is a rate-limit error chunk', () => {
  const items = run(translator(), [result({ isError: true, cause: 'rate-limit' }, "You've hit your limit")]);
  assert.equal((items.at(-2) as OpenAiErrorBody).error.code, 'rate_limit_exceeded');
});

test('a failure outside the events is an error chunk too', () => {
  const t = translator();
  t.push(textStart('Hi'));
  const items = t.failWith({ kind: 'server', message: 'The process exited.' });
  assert.deepEqual(items, [{ error: { message: 'The process exited.', type: 'server_error', param: null, code: 'server_error' } }, STREAM_DONE]);
  const end = t.end();
  assert.ok(end?.kind === 'error' && end.status === 500);
});

test('finish_reason: stop, length, content_filter and tool_calls', () => {
  assert.equal(finishReasonOf(outcome(), false), 'stop');
  assert.equal(finishReasonOf(outcome({ stopReason: 'max_tokens' }), false), 'length');
  assert.equal(finishReasonOf(outcome({ isError: true, cause: 'budget' }), false), 'length');
  assert.equal(finishReasonOf(outcome({ stopReason: 'refusal' }), false), 'content_filter');
  assert.equal(finishReasonOf(outcome({ stopReason: 'end_turn' }), true), 'tool_calls');
  const items = run(translator(), [textStart('Partial'), result({ isError: true, cause: 'budget' })]);
  assert.equal(chunksOf(items).at(-1)?.choices[0]?.finish_reason, 'length', 'a budget cut is a short answer, not an error');
});

test('tool-call deltas keep a stable index per call, with content null while a call streams', () => {
  const t = translator();
  const items = [
    ...t.toolCallDelta({ id: 'call_a', name: 'get_weather', argumentsAppend: '{"city":' }),
    ...t.toolCallDelta({ id: 'call_b', name: 'get_time', argumentsAppend: '{}' }),
    ...t.toolCallDelta({ id: 'call_a', name: 'get_weather', argumentsAppend: '"Madrid"}' }),
    ...t.push(result(), { usage: USAGE }),
  ];
  const chunks = chunksOf(items);
  assert.equal(chunks[0]?.choices[0]?.delta.role, 'assistant');
  assert.deepEqual(chunks[0]?.choices[0]?.delta.tool_calls, [{ index: 0, id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"city":' } }]);
  assert.deepEqual(chunks[1]?.choices[0]?.delta.tool_calls, [{ index: 1, id: 'call_b', type: 'function', function: { name: 'get_time', arguments: '{}' } }]);
  assert.deepEqual(chunks[2]?.choices[0]?.delta.tool_calls, [{ index: 0, function: { arguments: '"Madrid"}' } }]);
  for (const c of chunks.slice(0, 3)) assert.equal(c.choices[0]?.delta.content, null);
  assert.equal(chunks[3]?.choices[0]?.finish_reason, 'tool_calls');

  const end = t.end();
  assert.equal(end?.kind, 'completion');
  if (end?.kind !== 'completion') return;
  assert.equal(end.completion.choices[0]?.message.content, null);
  assert.deepEqual(end.completion.choices[0]?.message.tool_calls, [
    { id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Madrid"}' } },
    { id: 'call_b', type: 'function', function: { name: 'get_time', arguments: '{}' } },
  ]);
});

test('chunks carry the id, model and created the caller chose', () => {
  const [chunk] = chunksOf(translator().push(message(['x'])));
  assert.equal(chunk?.id, 'chatcmpl-1');
  assert.equal(chunk?.object, 'chat.completion.chunk');
  assert.equal(chunk?.model, 'sonnet');
  assert.equal(chunk?.created, 1_700_000_000);
});

test("token usage sums the CLI's per-model figures, and OpenAI's prompt tokens include the cached ones", () => {
  assert.equal(tokenUsageOf([]), null);
  assert.deepEqual(
    tokenUsageOf([
      { model: 'a', inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 },
      { model: 'b', inputTokens: 10, outputTokens: 20 },
    ]),
    { input: 11, output: 22, cacheRead: 3, cacheCreation: 4, total: 40 },
  );
  assert.deepEqual(completionUsage(USAGE), { prompt_tokens: 130, completion_tokens: 5, total_tokens: 135, prompt_tokens_details: { cached_tokens: 100 } });
});
