import assert from 'node:assert/strict';
import test from 'node:test';
import type { PermissionDecision, TranscriptEntry } from '@claudio/shared';
import {
  answerStub,
  CLIENT_ABANDONED_MESSAGE,
  CLIENT_TIMEOUT_MESSAGE,
  CLIENT_TOOL_PREFIX,
  ClientToolSession,
  clientToolsProblem,
  clientToolsServerEntry,
  MAX_CLIENT_TOOL_NAME,
  NOBODY_ANSWERS,
  resultsProblem,
  sameTools,
  toolChoiceInstruction,
  trailingResults,
} from '../src/openai/client-tools.ts';
import { ChatCompletionTranslator } from '../src/openai/events.ts';
import { keyAfterAnswer, historyKey } from '../src/openai/conversation-key.ts';
import { parseChatCompletionRequest, renderResultsCold } from '../src/openai/request.ts';
import { STREAM_DONE, type ChatCompletionChunk, type ChatMessage, type ClientTool } from '../src/openai/wire.ts';
import type { PermissionQuestion } from '../src/providers/driver.ts';

// The client-tool handoff's pure half (docs/openai-compatible-api.md, phase 4): the session that
// holds the CLI's requests, the stub's JSON-RPC answers, and the translator's turn end with calls.

const tool = (name: string, description: string | null = null): ClientTool => ({ name, description, parameters: { type: 'object', properties: { city: { type: 'string' } } }, strict: false });
const ask = (toolUseId: string, name: string, input: Record<string, unknown> = { city: 'Madrid' }): PermissionQuestion => ({ id: `req-${toolUseId}`, toolName: name, toolUseId, input });
/** A call as the translator streams it and the hand-off carries it */
const call = (id: string, name: string, input: unknown = { city: 'Madrid' }) => ({ id, name, input });

/** Answers recorded per request, so a test sees every decision and that each came once. */
function recorder() {
  const answers = new Map<string, PermissionDecision[]>();
  const answer = (q: PermissionQuestion) => (d: PermissionDecision) => answers.set(q.id, [...(answers.get(q.id) ?? []), d]);
  return { answers, answer };
}

// ---------- the session as the chat's permission host ----------

test('a client tool request is held, unanswered, and a built-in tool is refused at once as nobody-answers', () => {
  const s = new ClientToolSession([tool('get_weather')]);
  const { answers, answer } = recorder();
  s.claim([call('toolu_1', 'get_weather')]);
  const first = ask('toolu_1', `${CLIENT_TOOL_PREFIX}get_weather`);
  s.ask(first, answer(first));
  assert.equal(answers.size, 0);
  assert.equal(s.heldCount(), 1);
  const bash = ask('toolu_2', 'Bash', { command: 'ls' });
  s.ask(bash, answer(bash));
  assert.deepEqual(answers.get(bash.id), [{ behavior: 'deny', message: NOBODY_ANSWERS }]);
  // A tool of the stub's name the client did not declare is not the client's either
  const other = ask('toolu_3', `${CLIENT_TOOL_PREFIX}unknown`);
  s.ask(other, answer(other));
  assert.equal(answers.get(other.id)?.[0]?.behavior, 'deny');
  assert.equal(s.heldCount(), 1);
});

test('delivering the results allows each held request with its original input, in any order', () => {
  const s = new ClientToolSession([tool('a'), tool('b')]);
  const { answers, answer } = recorder();
  const a = ask('toolu_a', `${CLIENT_TOOL_PREFIX}a`, { city: 'Lima' });
  const b = ask('toolu_b', `${CLIENT_TOOL_PREFIX}b`, { city: 'Oslo' });
  s.claim([call('toolu_a', 'a', { city: 'Lima' }), call('toolu_b', 'b', { city: 'Oslo' })]);
  s.ask(a, answer(a));
  s.ask(b, answer(b));
  s.handOff([call('toolu_a', 'a', { city: 'Lima' }), call('toolu_b', 'b', { city: 'Oslo' })], 60_000, () => assert.fail('no expiry'));
  assert.ok(s.waiting);
  assert.deepEqual(s.awaitingIds().sort(), ['toolu_a', 'toolu_b']);
  s.deliver([{ toolCallId: 'toolu_b', text: 'cold' }, { toolCallId: 'toolu_a', text: 'warm' }]);
  assert.deepEqual(answers.get(a.id), [{ behavior: 'allow', updatedInput: { city: 'Lima' } }]);
  assert.deepEqual(answers.get(b.id), [{ behavior: 'allow', updatedInput: { city: 'Oslo' } }]);
  assert.equal(s.waiting, false);
  // The stub hands over each text by the CLI's tool call id
  assert.deepEqual(s.callResult('a', 'toolu_a', { city: 'Lima' }), { text: 'warm', isError: false });
  assert.deepEqual(s.callResult('b', 'toolu_b', { city: 'Oslo' }), { text: 'cold', isError: false });
});

test('without the tool call id the stub falls back to the oldest result for that tool', () => {
  const s = new ClientToolSession([tool('a'), tool('b')]);
  s.handOff([call('t1', 'a'), call('t2', 'b'), call('t3', 'a')], 60_000, () => undefined);
  s.deliver([{ toolCallId: 't1', text: 'first a' }, { toolCallId: 't2', text: 'b' }, { toolCallId: 't3', text: 'second a' }]);
  const madrid = { city: 'Madrid' };
  assert.equal(s.callResult('a', undefined, madrid).text, 'first a');
  assert.equal(s.callResult('b', undefined, madrid).text, 'b');
  assert.equal(s.callResult('a', 'not-a-known-id', madrid).text, 'second a');
  // Nothing left: an error result at once, never a wait
  const none = s.callResult('a', undefined, madrid);
  assert.equal(none.isError, true);
});

test('without the tool call id, two calls of one tool get their own results by their arguments, and a call nothing matches gets an error, never another call\'s result', () => {
  const s = new ClientToolSession([tool('get_weather')]);
  s.handOff([call('t1', 'get_weather', { city: 'Paris' }), call('t2', 'get_weather', { city: 'Rome', unit: 'c' })], 60_000, () => undefined);
  s.deliver([{ toolCallId: 't1', text: 'Paris: 12 C' }, { toolCallId: 't2', text: 'Rome: 19 C' }]);
  // The CLI calls them in its own order, its arguments in its own key order
  assert.deepEqual(s.callResult('get_weather', undefined, { unit: 'c', city: 'Rome' }), { text: 'Rome: 19 C', isError: false });
  const other = s.callResult('get_weather', undefined, { city: 'Oslo' });
  assert.equal(other.isError, true);
  assert.match(other.text, /No result/);
  assert.deepEqual(s.callResult('get_weather', undefined, { city: 'Paris' }), { text: 'Paris: 12 C', isError: false });
});

test('identical calls take their results first in, first out, and the result of a call the CLI took back is not kept for another', () => {
  const s = new ClientToolSession([tool('a')]);
  const { answer } = recorder();
  s.claim([call('t1', 'a'), call('t2', 'a')]);
  const one = ask('t1', `${CLIENT_TOOL_PREFIX}a`);
  const two = ask('t2', `${CLIENT_TOOL_PREFIX}a`);
  s.ask(one, answer(one));
  s.ask(two, answer(two));
  s.handOff([call('t1', 'a'), call('t2', 'a')], 60_000, () => undefined);
  s.withdrawn(one.id);
  s.deliver([{ toolCallId: 't1', text: 'one' }, { toolCallId: 't2', text: 'two' }]);
  assert.equal(s.callResult('a', undefined, { city: 'Madrid' }).text, 'two');
  assert.equal(s.callResult('a', undefined, { city: 'Madrid' }).isError, true);
  const fifo = new ClientToolSession([tool('a')]);
  fifo.handOff([call('t1', 'a'), call('t2', 'a')], 60_000, () => undefined);
  fifo.deliver([{ toolCallId: 't1', text: 'one' }, { toolCallId: 't2', text: 'two' }]);
  assert.equal(fifo.callResult('a', undefined, { city: 'Madrid' }).text, 'one');
  assert.equal(fifo.callResult('a', undefined, { city: 'Madrid' }).text, 'two');
});

test('a request for a call whose result came first is allowed at once (a CLI that asks one after the other)', () => {
  const s = new ClientToolSession([tool('a'), tool('b')]);
  const { answers, answer } = recorder();
  const a = ask('t1', `${CLIENT_TOOL_PREFIX}a`);
  s.claim([call('t1', 'a'), call('t2', 'b', { city: 'Rome' })]);
  s.ask(a, answer(a));
  s.handOff([call('t1', 'a'), call('t2', 'b', { city: 'Rome' })], 60_000, () => undefined);
  s.deliver([{ toolCallId: 't1', text: '1' }, { toolCallId: 't2', text: '2' }]);
  const b = ask('t2', `${CLIENT_TOOL_PREFIX}b`, { city: 'Rome' });
  s.ask(b, answer(b));
  assert.deepEqual(answers.get(b.id), [{ behavior: 'allow', updatedInput: { city: 'Rome' } }]);
});

test("tool_choice none and a named function deny the other client tools with a message naming the rule", () => {
  const s = new ClientToolSession([tool('a'), tool('b')]);
  const { answers, answer } = recorder();
  s.choice = { kind: 'none' };
  assert.deepEqual([...s.allowedNames()], []);
  const a = ask('t1', `${CLIENT_TOOL_PREFIX}a`);
  s.ask(a, answer(a));
  assert.match(answers.get(a.id)?.[0]?.behavior === 'deny' ? String((answers.get(a.id)?.[0] as { message?: string }).message) : '', /tool_choice.*none/);
  s.choice = { kind: 'function', name: 'b' };
  assert.deepEqual([...s.allowedNames()], ['b']);
  const a2 = ask('t2', `${CLIENT_TOOL_PREFIX}a`);
  s.ask(a2, answer(a2));
  assert.match(String((answers.get(a2.id)?.[0] as { message?: string }).message), /requires `b`/);
  const b = ask('t3', `${CLIENT_TOOL_PREFIX}b`);
  s.claim([call('t3', 'b')]);
  s.ask(b, answer(b));
  assert.equal(answers.has(b.id), false);
  assert.equal(s.heldCount(), 1);
});

test('the handoff refuses held requests it does not hand over (parallel_tool_calls false)', () => {
  const s = new ClientToolSession([tool('a')]);
  s.parallel = false;
  const { answers, answer } = recorder();
  const one = ask('t1', `${CLIENT_TOOL_PREFIX}a`);
  const two = ask('t2', `${CLIENT_TOOL_PREFIX}a`);
  // The translator claims only the first call when parallel_tool_calls is false
  s.claim([call('t1', 'a')]);
  s.ask(one, answer(one));
  s.ask(two, answer(two));
  s.handOff([call('t1', 'a')], 60_000, () => undefined);
  assert.equal(answers.has(one.id), false);
  assert.match(String((answers.get(two.id)?.[0] as { message?: string }).message), /parallel_tool_calls/);
  // While the client has the calls, a request for any other call is refused
  const late = ask('t9', `${CLIENT_TOOL_PREFIX}a`);
  s.ask(late, answer(late));
  assert.equal(answers.get(late.id)?.[0]?.behavior, 'deny');
});

test('the wait runs out: every held request gets the timeout error, the calls are expired and the owner is told', async () => {
  const s = new ClientToolSession([tool('a')]);
  const { answers, answer } = recorder();
  const one = ask('t1', `${CLIENT_TOOL_PREFIX}a`);
  s.claim([call('t1', 'a')]);
  s.ask(one, answer(one));
  let expired = 0;
  s.handOff([call('t1', 'a')], 20, () => expired++);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(expired, 1);
  assert.deepEqual(answers.get(one.id), [{ behavior: 'deny', message: CLIENT_TIMEOUT_MESSAGE }]);
  assert.equal(s.expired('t1'), true);
  assert.equal(s.waiting, false);
});

test('results before the wait ends cancel it', async () => {
  const s = new ClientToolSession([tool('a')]);
  let expired = 0;
  s.handOff([call('t1', 'a')], 20, () => expired++);
  s.deliver([{ toolCallId: 't1', text: 'x' }]);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(expired, 0);
});

test('a withdrawn request (an interrupt) and the end of the process leave nothing held', () => {
  const s = new ClientToolSession([tool('a')]);
  const { answers, answer } = recorder();
  const one = ask('t1', `${CLIENT_TOOL_PREFIX}a`);
  const two = ask('t2', `${CLIENT_TOOL_PREFIX}a`);
  s.claim([call('t1', 'a'), call('t2', 'a')]);
  s.ask(one, answer(one));
  s.ask(two, answer(two));
  s.withdrawn(one.id);
  assert.equal(s.heldCount(), 1);
  s.ended();
  assert.equal(s.heldCount(), 0);
  assert.equal(answers.size, 0);
});

test('a client-tool request nobody claimed is denied at once; the end of the process forgets the calls with the client', () => {
  const s = new ClientToolSession([tool('a')]);
  const { answers, answer } = recorder();
  const stray = ask('t0', `${CLIENT_TOOL_PREFIX}a`);
  s.ask(stray, answer(stray));
  assert.match(String((answers.get(stray.id)?.[0] as { message?: string }).message), /not handed to the client/);
  assert.equal(s.heldCount(), 0);
  s.claim([call('t1', 'a')]);
  const one = ask('t1', `${CLIENT_TOOL_PREFIX}a`);
  s.ask(one, answer(one));
  s.handOff([call('t1', 'a')], 60_000, () => assert.fail('no expiry'), 4242);
  assert.equal(s.holderPid, 4242);
  s.ended();
  assert.equal(s.waiting, false);
  assert.equal(s.holderPid, null);
  assert.deepEqual(s.awaitingIds(), []);
});

test('dropping the calls answers a request still held with an error result and forgets them', () => {
  const s = new ClientToolSession([tool('a')]);
  const { answers, answer } = recorder();
  s.claim([call('t1', 'a')]);
  const one = ask('t1', `${CLIENT_TOOL_PREFIX}a`);
  s.ask(one, answer(one));
  s.handOff([call('t1', 'a')], 60_000, () => assert.fail('no expiry'));
  s.abandon();
  assert.deepEqual(answers.get(one.id), [{ behavior: 'deny', message: CLIENT_ABANDONED_MESSAGE }]);
  assert.equal(s.waiting, false);
  assert.equal(s.heldCount(), 0);
});

// ---------- validation ----------

test('tool names that are too long under the prefix, name a built-in, or differ only by case are refused', () => {
  assert.equal(clientToolsProblem([tool('get_weather')]), null);
  const long = clientToolsProblem([tool('x'.repeat(MAX_CLIENT_TOOL_NAME + 1))]);
  assert.equal(long?.kind, 'invalid-request');
  assert.match(long?.kind === 'invalid-request' ? long.message : '', /too long/);
  assert.equal(clientToolsProblem([tool('x'.repeat(MAX_CLIENT_TOOL_NAME))]), null);
  const builtin = clientToolsProblem([tool('bash')]);
  assert.match(builtin?.kind === 'invalid-request' ? builtin.message : '', /Claude Code's own tools/);
  assert.equal(clientToolsProblem([tool('Lookup'), tool('lookup')])?.kind, 'invalid-request');
});

test('the trailing results must answer every call of the last assistant message, and nothing else', () => {
  const calls = [{ id: 'c1', type: 'function' as const, function: { name: 'a', arguments: '{}' } }, { id: 'c2', type: 'function' as const, function: { name: 'b', arguments: '{}' } }];
  const history = (results: ChatMessage[]): ChatMessage[] => [{ role: 'user', parts: [{ type: 'text', text: 'q' }] }, { role: 'assistant', text: '', toolCalls: calls }, ...results];
  assert.equal(resultsProblem(trailingResults(history([{ role: 'tool', toolCallId: 'c1', text: '1' }, { role: 'tool', toolCallId: 'c2', text: '2' }]))), null);
  const missing = resultsProblem(trailingResults(history([{ role: 'tool', toolCallId: 'c1', text: '1' }])));
  assert.match(missing?.kind === 'invalid-request' ? missing.message : '', /`c2`/);
  const unknown = resultsProblem(trailingResults(history([{ role: 'tool', toolCallId: 'c1', text: '1' }, { role: 'tool', toolCallId: 'c2', text: '2' }, { role: 'tool', toolCallId: 'zz', text: '?' }])));
  assert.match(unknown?.kind === 'invalid-request' ? unknown.message : '', /`zz`/);
  const after = trailingResults(history([{ role: 'tool', toolCallId: 'c1', text: '1' }, { role: 'tool', toolCallId: 'c2', text: '2' }, { role: 'user', parts: [{ type: 'text', text: 'more' }] }]));
  assert.equal(after.userAfter, true);
});

test('the key after a tool_calls answer is the one the client\'s next request is looked up by', () => {
  const seed = { model: 'sonnet', systemPrompt: null, user: null };
  const first: ChatMessage[] = [{ role: 'user', parts: [{ type: 'text', text: 'weather?' }] }];
  const answered = keyAfterAnswer(seed, first, { text: '', toolCalls: [{ id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Madrid","unit":"c"}' } }] });
  // The client resends the call with `content: null` and its arguments re-serialised, then the result
  const next = parseChatCompletionRequest({
    model: 'sonnet',
    messages: [
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{ "unit": "c", "city": "Madrid" }' } }] },
      { role: 'tool', tool_call_id: 'toolu_1', content: '21 C' },
    ],
  });
  assert.ok(next.ok);
  assert.equal(historyKey(seed, next.value.messages), answered);
});

test('sameTools compares names with their case, as the stub lists them, and its sort is consistent', () => {
  assert.ok(sameTools([tool('b'), tool('a'), tool('c')], [tool('c'), tool('a'), tool('b')]));
  assert.ok(!sameTools([tool('Lookup')], [tool('lookup')]));
});

test('sameTools ignores order, and the cold results prompt says the session restarted', () => {
  assert.ok(sameTools([tool('a'), tool('b')], [tool('b'), tool('a')]));
  assert.ok(!sameTools([tool('a')], [tool('a', 'described')]));
  const cold = renderResultsCold([{ role: 'user', parts: [{ type: 'text', text: 'q' }] }, { role: 'assistant', text: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }] }, { role: 'tool', toolCallId: 'c1', text: 'R' }]);
  assert.match(cold.prompt, /restarted/);
  assert.match(cold.prompt, /<tool-result id="c1">\nR\n<\/tool-result>/);
  assert.equal(toolChoiceInstruction({ kind: 'auto' }), null);
  assert.match(toolChoiceInstruction({ kind: 'function', name: 'a' }) ?? '', /mcp__client__a/);
});

test('the stub entry loads up front and sends the chat token by reference, never a literal secret', () => {
  assert.deepEqual(clientToolsServerEntry('http://127.0.0.1:1/api/openai/client-tools/x/mcp'), {
    type: 'http',
    url: 'http://127.0.0.1:1/api/openai/client-tools/x/mcp',
    headers: { Authorization: 'Bearer ${CLAUDIO_API_TOKEN}' },
    alwaysLoad: true,
  });
});

// ---------- the stub's JSON-RPC ----------

test('the stub lists the tools read-only, answers calls from the results, and 202s notifications', () => {
  const s = new ClientToolSession([tool('get_weather', 'The weather')]);
  const init = answerStub({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, s);
  assert.equal(init.status, 200);
  assert.deepEqual((init as { body: { result: { capabilities: unknown } } }).body.result.capabilities, { tools: {} });
  assert.deepEqual(answerStub({ jsonrpc: '2.0', method: 'notifications/initialized' }, s), { status: 202 });
  const discover = answerStub({ jsonrpc: '2.0', id: 2, method: 'server/discover' }, s) as { body: { error: { code: number } } };
  assert.equal(discover.body.error.code, -32601);
  const list = answerStub({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, s) as { body: { result: { tools: unknown[] } } };
  assert.deepEqual(list.body.result.tools, [{ name: 'get_weather', description: 'The weather', inputSchema: tool('x').parameters, annotations: { readOnlyHint: true } }]);
  s.handOff([{ id: 'toolu_9', name: 'get_weather', input: {} }], 60_000, () => undefined);
  s.deliver([{ toolCallId: 'toolu_9', text: 'sunny' }]);
  const call = answerStub({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_weather', arguments: {}, _meta: { 'claudecode/toolUseId': 'toolu_9' } } }, s) as { body: { result: unknown } };
  assert.deepEqual(call.body.result, { content: [{ type: 'text', text: 'sunny' }] });
  const again = answerStub({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_weather', arguments: {} } }, s) as { body: { result: { isError?: boolean } } };
  assert.equal(again.body.result.isError, true);
});

// ---------- the translator's turn end ----------

let seq = 0;
const toolUse = (id: string, name: string, input: unknown): TranscriptEntry => ({ uuid: `u${String(++seq)}`, role: 'assistant', timestamp: null, model: 'claude', isSidechain: false, parentToolUseId: null, blocks: [{ type: 'tool_use', id, name, input }] });
const textEntry = (text: string): TranscriptEntry => ({ uuid: `u${String(++seq)}`, role: 'assistant', timestamp: null, model: 'claude', isSidechain: false, parentToolUseId: null, blocks: [{ type: 'text', text }] });
const msg = (entry: TranscriptEntry) => ({ kind: 'message' as const, entry, seq: ++seq, ts: 'now' });
const clientTranslator = (names: string[], single = false) =>
  new ChatCompletionTranslator({ id: 'chatcmpl-1', model: 'sonnet', created: 1, includeUsage: true, clientTools: { prefix: CLIENT_TOOL_PREFIX, names: new Set(names), single } });

test('a client call streams as two fragments on one index, and the handoff ends with finish_reason tool_calls', () => {
  const t = clientTranslator(['get_weather']);
  const out = [...t.push(msg(textEntry('Let me check.'))), ...t.push(msg(toolUse('toolu_1', `${CLIENT_TOOL_PREFIX}get_weather`, { city: 'Madrid' })))];
  const ended = t.handOff();
  assert.ok(ended);
  const chunks = [...out, ...ended];
  assert.equal(chunks.at(-1), STREAM_DONE);
  const deltas = chunks.filter((c): c is ChatCompletionChunk => typeof c === 'object' && 'object' in c).map((c) => ({ delta: c.choices[0]?.delta, finish: c.choices[0]?.finish_reason }));
  assert.deepEqual(deltas, [
    { delta: { role: 'assistant', content: 'Let me check.' }, finish: null },
    { delta: { content: null, tool_calls: [{ index: 0, id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] }, finish: null },
    { delta: { content: null, tool_calls: [{ index: 0, function: { arguments: '{"city":"Madrid"}' } }] }, finish: null },
    { delta: {}, finish: 'tool_calls' },
  ]);
  const end = t.end();
  assert.equal(end?.kind, 'completion');
  if (end?.kind !== 'completion') return;
  assert.deepEqual(end.completion.choices[0]?.message, { role: 'assistant', content: 'Let me check.', refusal: null, tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Madrid"}' } }] });
  // The CLI reports usage only with the result, which has not come: none is invented
  assert.equal(end.completion.usage, undefined);
});

test('parallel calls get indexes 0 and 1; built-in, disallowed and single-mode extra calls are not the client\'s', () => {
  const t = clientTranslator(['a', 'b']);
  t.push(msg(toolUse('t0', 'Bash', { command: 'ls' })));
  t.push(msg(toolUse('t1', `${CLIENT_TOOL_PREFIX}a`, {})));
  t.push(msg(toolUse('t2', `${CLIENT_TOOL_PREFIX}b`, { x: 1 })));
  t.push(msg(toolUse('t3', `${CLIENT_TOOL_PREFIX}c`, {})));
  assert.deepEqual(t.clientCalls(), [{ id: 't1', name: 'a', input: {} }, { id: 't2', name: 'b', input: { x: 1 } }]);
  const single = clientTranslator(['a', 'b'], true);
  single.push(msg(toolUse('t1', `${CLIENT_TOOL_PREFIX}a`, {})));
  single.push(msg(toolUse('t2', `${CLIENT_TOOL_PREFIX}b`, {})));
  assert.deepEqual(single.clientCalls(), [{ id: 't1', name: 'a', input: {} }]);
  // No call, no handoff: the turn goes on to its result
  assert.equal(clientTranslator(['a']).handOff(), null);
});
