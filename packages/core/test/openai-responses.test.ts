import assert from 'node:assert/strict';
import test from 'node:test';
import type { RunEvent, RunOutcome, TokenUsage, TranscriptEntry } from '@claudio/shared';
import { Db } from '../src/db.ts';
import type { ChatRuntime } from '../src/live-chat.ts';
import { historyKey, imageDigest as openAiImageDigest, keyAfterAnswer } from '../src/openai/conversation-key.ts';
import { OpenAiConversationStore } from '../src/openai/conversations.ts';
import { ResponsesTranslator, responseUsage, type ResponsesTranslatorOptions } from '../src/openai/responses-events.ts';
import { assistantOfOutput, keyAfterPrevious, parseResponsesRequest, responsesTurnOf, withPreviousOutput, type ResponsesRequest } from '../src/openai/responses-request.ts';
import { OpenAiResponseStore } from '../src/openai/responses-store.ts';
import type { OutputItem, ResponseObject, ResponseStreamEvent } from '../src/openai/responses-wire.ts';
import { sweepOpenAiChats } from '../src/openai/sweep.ts';
import { effectiveSystemPrompt, hasSystemMessages, systemPromptParts } from '../src/openai/system-prompt.ts';
import { listedInputItems, STORED_IMAGE_URL_MAX, storedInputItems } from '../src/openai/stored-images.ts';
import { tempConfig } from './helpers.ts';

// Phase 5's core (docs/openai-compatible-api.md): `POST /v1/responses` read into the request the
// Chat Completions path runs on, a turn's RunEvents as the Responses API's output items and semantic
// events, and the stored responses `previous_response_id` continues from.

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function parseOk(body: Record<string, unknown>): ResponsesRequest {
  const parsed = parseResponsesRequest({ model: 'sonnet', ...body });
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.error.body));
  return parsed.value;
}

function refused(body: Record<string, unknown>): { status: number; code: string | null; param: string | null; message: string } {
  const parsed = parseResponsesRequest({ model: 'sonnet', ...body });
  if (parsed.ok) assert.fail(`accepted: ${JSON.stringify(body)}`);
  return { status: parsed.error.status, code: parsed.error.body.error.code, param: parsed.error.body.error.param, message: parsed.error.body.error.message };
}

// ---------- the request ----------

test('a string input is one user message, and its input item is listed with an id', () => {
  const request = parseOk({ input: 'Hello there' });
  assert.deepEqual(request.chat.messages, [{ role: 'user', parts: [{ type: 'text', text: 'Hello there' }] }]);
  assert.equal(request.inputItems.length, 1);
  const item = request.inputItems[0];
  assert.equal(item?.type, 'message');
  assert.match(item?.id ?? '', /^msg_/);
  assert.equal(request.store, true, 'store defaults to true, as the reference says');
  assert.equal(request.previousResponseId, null);
});

test('input items become the messages Chat Completions would carry, function calls joined to their assistant message', () => {
  const request = parseOk({
    input: [
      { role: 'developer', content: 'Be terse.' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Weather?' }, { type: 'input_image', image_url: `data:image/png;base64,${PNG}` }] },
      { type: 'message', role: 'assistant', id: 'msg_1', status: 'completed', content: [{ type: 'output_text', text: 'Checking.', annotations: [] }] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_a', name: 'get_weather', arguments: '{"city":"Paris"}', status: 'completed' },
      { type: 'function_call', call_id: 'call_b', name: 'get_weather', arguments: '{"city":"Rome"}' },
      { type: 'reasoning', id: 'rs_1', summary: [] },
      { type: 'function_call_output', call_id: 'call_a', output: 'sunny' },
      { type: 'function_call_output', call_id: 'call_b', output: [{ type: 'input_text', text: 'rain' }] },
    ],
  });
  const roles = request.chat.messages.map((m) => m.role);
  assert.deepEqual(roles, ['developer', 'user', 'assistant', 'tool', 'tool']);
  const assistant = request.chat.messages[2];
  assert.equal(assistant?.role, 'assistant');
  if (assistant?.role === 'assistant') {
    assert.equal(assistant.text, 'Checking.');
    assert.deepEqual(
      assistant.toolCalls.map((c) => [c.id, c.function.name, c.function.arguments]),
      [
        ['call_a', 'get_weather', '{"city":"Paris"}'],
        ['call_b', 'get_weather', '{"city":"Rome"}'],
      ],
    );
  }
  const user = request.chat.messages[1];
  assert.equal(user?.role === 'user' ? user.parts[1]?.type : null, 'image');
  assert.deepEqual(request.chat.messages[4], { role: 'tool', toolCallId: 'call_b', text: 'rain' });
  assert.deepEqual(
    request.inputItems.map((i) => [i.type, i.id]),
    [
      ['message', request.inputItems[0]?.id],
      ['message', request.inputItems[1]?.id],
      ['message', 'msg_1'],
      ['function_call', 'fc_1'],
      ['function_call', request.inputItems[4]?.id],
      ['function_call_output', request.inputItems[5]?.id],
      ['function_call_output', request.inputItems[6]?.id],
    ],
    'the reasoning item is dropped; ids the client sent are kept',
  );
});

test('back-to-back assistant messages, and two split by a developer message, stay separate assistant turns', () => {
  const said = (role: string, text: string) => ({ type: 'message', role, content: role === 'assistant' ? [{ type: 'output_text', text }] : text });
  const fewShot = parseOk({ input: [said('user', '2+2?'), said('assistant', '4'), said('assistant', 'Anything else?'), said('user', '3+3?')] });
  assert.deepEqual(
    fewShot.chat.messages.map((m) => [m.role, m.role === 'assistant' ? m.text : null]),
    [
      ['user', null],
      ['assistant', '4'],
      ['assistant', 'Anything else?'],
      ['user', null],
    ],
  );
  const split = parseOk({ input: [said('user', 'hi'), said('assistant', 'Hello.'), said('developer', 'Now answer in French.'), said('assistant', 'Bonjour.'), said('user', 'again')] });
  assert.deepEqual(
    split.chat.messages.map((m) => [m.role, m.role === 'assistant' ? m.text : null]),
    [
      ['user', null],
      ['assistant', 'Hello.'],
      ['developer', null],
      ['assistant', 'Bonjour.'],
      ['user', null],
    ],
  );
  // A developer message between an assistant message and a call ends the message: the call starts its own
  const call = parseOk({ input: [said('user', 'go'), said('assistant', 'Looking.'), said('developer', 'Be quick.'), { type: 'function_call', call_id: 'c', name: 'f', arguments: '{}' }, { type: 'function_call_output', call_id: 'c', output: 'ok' }] });
  assert.deepEqual(call.chat.messages[3], { role: 'assistant', text: '', toolCalls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }] });
});

test('a function call with no assistant message before it is an assistant message of its own', () => {
  const request = parseOk({ input: [{ role: 'user', content: 'go' }, { type: 'function_call', call_id: 'c', name: 'f', arguments: '{}' }, { type: 'function_call_output', call_id: 'c', output: 'ok' }] });
  assert.deepEqual(request.chat.messages[1], { role: 'assistant', text: '', toolCalls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }] });
});

test('instructions join the system prompt but not the conversation key, so a client may change them each turn', () => {
  const input = [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'salut' }, { role: 'user', content: 'again' }];
  const a = parseOk({ instructions: 'Answer in French.', input });
  const b = parseOk({ instructions: 'Answer in Spanish.', input });
  const promptOf = (request: ResponsesRequest): string => effectiveSystemPrompt(systemPromptParts(request.chat.messages, request.instructions, { kind: 'whole' }));
  assert.equal(promptOf(a), 'Answer in French.\n\nBe brief.');
  assert.equal(promptOf(b), 'Answer in Spanish.\n\nBe brief.');
  assert.ok(responsesTurnOf(a).historyKey);
  assert.equal(responsesTurnOf(a).historyKey, responsesTurnOf(b).historyKey);
  assert.equal(promptOf(parseOk({ input: 'x' })), '');
});

test('the conversation part accumulates along a chain, a named delta keeps the chat\'s, and instructions never carry over', () => {
  const developer = (text: string) => ({ role: 'developer', content: text });
  const userSays = (text: string) => ({ role: 'user', content: text });
  const first = parseOk({ instructions: 'X', input: [developer('Answer in French.'), userSays('one')] });
  const one = systemPromptParts(first.chat.messages, first.instructions, { kind: 'whole' });
  assert.deepEqual(one, { instructions: 'X', conversation: 'Answer in French.' });
  // previous_response_id with only a user item: the developer message stays, the instructions go
  const second = parseOk({ input: [userSays('two')] });
  const two = systemPromptParts(second.chat.messages, second.instructions, { kind: 'chain', conversation: one.conversation });
  assert.deepEqual(two, { instructions: '', conversation: 'Answer in French.' });
  assert.equal(effectiveSystemPrompt(two), 'Answer in French.');
  // A new developer item along the chain is added to what it carried
  const third = parseOk({ input: [developer('Be brief.'), userSays('three')] });
  assert.equal(systemPromptParts(third.chat.messages, null, { kind: 'chain', conversation: two.conversation }).conversation, 'Answer in French.\n\nBe brief.');
  // X-Claudio-Chat-Id with only the new message keeps the chat's part; one with system messages replaces it
  assert.equal(systemPromptParts(second.chat.messages, null, { kind: 'named', conversation: 'Answer in French.' }).conversation, 'Answer in French.');
  assert.equal(systemPromptParts(third.chat.messages, null, { kind: 'named', conversation: 'Answer in French.' }).conversation, 'Be brief.');
  // An empty system message is a system message: it clears the part
  const cleared = parseOk({ input: [developer(''), userSays('four')] });
  assert.ok(hasSystemMessages(cleared.chat.messages));
  assert.equal(systemPromptParts(cleared.chat.messages, null, { kind: 'named', conversation: 'Answer in French.' }).conversation, '');
});

test('reasoning.effort, text.format and the tools map onto the Chat Completions request', () => {
  const request = parseOk({
    input: 'x',
    reasoning: { effort: 'minimal', summary: 'auto' },
    text: { format: { type: 'json_schema', name: 'city', schema: { type: 'object' }, strict: true }, verbosity: 'low' },
  });
  assert.equal(request.chat.reasoningEffort, 'minimal');
  assert.equal(responsesTurnOf(request).effort, 'low');
  assert.deepEqual(request.chat.responseFormat, { type: 'json_schema', name: 'city', schema: { type: 'object' }, strict: true });
  assert.deepEqual(responsesTurnOf(request).jsonSchema, { type: 'object' });
  assert.deepEqual(request.echo.text, { format: { type: 'json_schema', name: 'city', schema: { type: 'object' }, strict: true } });
  assert.deepEqual(request.chat.ignored.sort(), ['reasoning.summary', 'text.verbosity']);
  assert.deepEqual(responsesTurnOf(parseOk({ input: 'x', text: { format: { type: 'json_object' } } })).jsonSchema, { type: 'object' });
  assert.equal(responsesTurnOf(parseOk({ input: 'x', text: { format: { type: 'text' } } })).jsonSchema, undefined);
});

test('flat function tools are client tools, strict unless the client says otherwise, and tool_choice takes its Responses shapes', () => {
  const weather = { type: 'function', name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } };
  const loose = { type: 'function', name: 'lookup', strict: false };
  const request = parseOk({ input: 'x', tools: [weather, loose], tool_choice: { type: 'function', name: 'get_weather' }, parallel_tool_calls: false });
  assert.deepEqual(
    request.chat.tools.map((t) => [t.name, t.strict]),
    [
      ['get_weather', true],
      ['lookup', false],
    ],
  );
  assert.deepEqual(request.chat.toolChoice, { kind: 'function', name: 'get_weather' });
  assert.deepEqual(request.echo.toolChoice, { type: 'function', name: 'get_weather' });
  assert.equal(request.chat.parallelToolCalls, false);
  assert.equal(request.echo.parallelToolCalls, false);
  assert.deepEqual(request.echo.tools[1], { type: 'function', name: 'lookup', description: null, parameters: { type: 'object', properties: {} }, strict: false });
  for (const choice of ['auto', 'none', 'required'] as const) assert.deepEqual(parseOk({ input: 'x', tools: [weather], tool_choice: choice }).chat.toolChoice, { kind: choice });
  assert.equal(refused({ input: 'x', tool_choice: 'required' }).param, 'tool_choice');
  assert.equal(refused({ input: 'x', tools: [weather], tool_choice: { type: 'function', name: 'nope' } }).param, 'tool_choice.name');
  assert.equal(refused({ input: 'x', tools: [weather], tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [] } }).code, 'unsupported_parameter');
  assert.equal(refused({ input: 'x', tools: [weather], tool_choice: { type: 'web_search_preview' } }).code, 'unsupported_parameter');
  assert.equal(refused({ input: 'x', tools: [weather, weather] }).code, 'invalid_request_error');
  assert.equal(refused({ input: 'x', tools: [{ type: 'function', name: 'bad name' }] }).param, 'tools[0].name');
});

test('hosted tools, background, conversation objects and stored prompts are refused as unsupported', () => {
  for (const type of ['web_search', 'web_search_preview', 'file_search', 'code_interpreter', 'computer_use_preview', 'image_generation', 'mcp']) {
    const r = refused({ input: 'x', tools: [{ type }] });
    assert.equal(r.status, 400);
    assert.equal(r.code, 'unsupported_parameter', type);
    assert.equal(r.param, 'tools[0].type');
  }
  assert.equal(refused({ input: 'x', background: true }).param, 'background');
  assert.equal(parseOk({ input: 'x', background: false }).chat.model, 'sonnet');
  assert.equal(refused({ input: 'x', conversation: 'conv_1' }).param, 'conversation');
  assert.equal(refused({ input: 'x', conversation: { id: 'conv_1' } }).code, 'unsupported_parameter');
  assert.equal(refused({ input: 'x', prompt: { id: 'pmpt_1' } }).param, 'prompt');
});

test('unknown, hosted and referenced input items are refused', () => {
  const unknown = refused({ input: [{ type: 'mystery' }, { role: 'user', content: 'x' }] });
  assert.equal(unknown.code, 'invalid_request_error');
  assert.equal(unknown.param, 'input[0].type');
  assert.equal(refused({ input: [{ type: 'web_search_call', id: 'ws', status: 'completed' }, { role: 'user', content: 'x' }] }).code, 'unsupported_parameter');
  assert.equal(refused({ input: [{ type: 'item_reference', id: 'msg_1' }, { role: 'user', content: 'x' }] }).code, 'unsupported_parameter');
  assert.equal(refused({ input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'f' }] }] }).code, 'unsupported_parameter');
  assert.equal(refused({ input: [{ role: 'user', content: [{ type: 'input_image', file_id: 'file_1' }] }] }).param, 'input[0].content[0].file_id');
  assert.equal(refused({ input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'ftp://x/y.png' }] }] }).code, 'unsupported_parameter');
  assert.equal(refused({ input: [{ role: 'robot', content: 'x' }] }).param, 'input[0].role');
});

test('a request must end with the client: a user message or a function call output', () => {
  assert.equal(refused({ input: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }] }).param, 'input');
  assert.equal(refused({ input: [{ role: 'user', content: 'x' }, { type: 'function_call', call_id: 'c', name: 'f', arguments: '{}' }] }).param, 'input');
  assert.equal(refused({ input: '' }).param, 'input');
  assert.equal(refused({ input: [] }).param, 'input');
  assert.equal(refused({}).param, 'input');
  assert.equal(refused({ input: 'x', model: '' }).param, 'model');
});

test('parameters the CLI cannot honour are named for x-claudio-ignored; metadata is kept and checked', () => {
  const request = parseOk({ input: 'x', temperature: 0.2, top_p: 0.9, max_output_tokens: 100, truncation: 'auto', service_tier: 'flex', include: ['reasoning.encrypted_content'], metadata: { a: 'b' }, user: 'u1' });
  assert.deepEqual(request.chat.ignored.sort(), ['include', 'max_output_tokens', 'service_tier', 'temperature', 'top_p', 'truncation'].sort());
  assert.deepEqual(request.metadata, { a: 'b' });
  assert.equal(request.chat.user, 'u1');
  assert.equal(request.echo.temperature, 0.2);
  assert.equal(request.echo.truncation, 'auto');
  assert.deepEqual(parseOk({ input: 'x', truncation: 'disabled', include: [] }).chat.ignored, []);
  assert.equal(refused({ input: 'x', metadata: { a: 1 } }).param, 'metadata');
  assert.equal(refused({ input: 'x', metadata: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${String(i)}`, 'v'])) }).param, 'metadata');
  assert.equal(refused({ input: 'x', store: 'yes' }).param, 'store');
  assert.equal(parseOk({ input: 'x', store: false }).store, false);
});

// ---------- previous_response_id ----------

test("a stored response's output is the assistant message its follow-up continues after", () => {
  const output: OutputItem[] = [
    { type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Checking.', annotations: [], logprobs: [] }] },
    { type: 'function_call', id: 'fc_1', call_id: 'call_a', name: 'get_weather', arguments: '{"city":"Paris"}', status: 'completed' },
  ];
  assert.deepEqual(assistantOfOutput(output), { role: 'assistant', text: 'Checking.', toolCalls: [{ id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] });
  const follow = withPreviousOutput(parseOk({ input: [{ type: 'function_call_output', call_id: 'call_a', output: 'sunny' }] }), output);
  const turn = responsesTurnOf(follow);
  assert.equal(turn.delta.prompt, '<tool-result id="call_a">\nsunny\n</tool-result>', 'only the new items go to the chat');
});

test('the key after a previous_response_id turn is the one the same conversation resent whole carries', () => {
  const first = parseOk({ input: 'Weather in Paris?' });
  const seed = responsesTurnOf(first).keySeed;
  const answer1 = { text: 'Checking.', toolCalls: [{ id: 'call_a', type: 'function' as const, function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] };
  const stored = keyAfterAnswer(seed, first.chat.messages, answer1);
  const second = parseOk({ input: [{ type: 'function_call_output', call_id: 'call_a', output: 'sunny' }] });
  const after = keyAfterPrevious(stored, second.chat.messages, { text: 'It is sunny.', toolCalls: [] });
  const whole = parseOk({
    input: [
      { role: 'user', content: 'Weather in Paris?' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking.' }] },
      { type: 'function_call', call_id: 'call_a', name: 'get_weather', arguments: '{ "city": "Paris" }' },
      { type: 'function_call_output', call_id: 'call_a', output: 'sunny' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'It is sunny.' }] },
      { role: 'user', content: 'And tomorrow?' },
    ],
  });
  assert.equal(historyKey(responsesTurnOf(whole).keySeed, whole.chat.messages), after);
});

// ---------- the events ----------

let seq = 0;
const ev = (event: Omit<RunEvent, 'seq' | 'ts'>): RunEvent => ({ seq: ++seq, ts: '2026-10-26T00:00:00Z', ...event });
const entry = (blocks: TranscriptEntry['blocks']): TranscriptEntry => ({ uuid: `u${String(++seq)}`, role: 'assistant', timestamp: null, model: 'claude', isSidechain: false, parentToolUseId: null, blocks });
const textStart = (text: string) => ev({ kind: 'partial', block: 'text', text });
const textAppend = (append: string, at: number) => ev({ kind: 'partial', block: 'text', append, at });
const message = (text: string) => ev({ kind: 'message', entry: entry([{ type: 'text', text }]) });
const callMessage = (id: string, name: string, input: unknown) => ev({ kind: 'message', entry: entry([{ type: 'tool_use', id, name: `mcp__client__${name}`, input }]) });
const outcome = (patch: Partial<RunOutcome> = {}): RunOutcome => ({ isError: false, turns: 1, durationMs: 10, costUsd: 0.02, permissionDenials: [], ...patch });
const result = (patch: Partial<RunOutcome> = {}, text = '') => ev({ kind: 'result', text, outcome: outcome(patch) });
const USAGE: TokenUsage = { input: 10, output: 5, cacheRead: 100, cacheCreation: 20, total: 135 };

function translator(patch: Partial<ResponsesTranslatorOptions> = {}): ResponsesTranslator {
  let n = 0;
  return new ResponsesTranslator({
    id: 'resp_1',
    model: 'sonnet',
    createdAt: 1_760_000_000,
    instructions: 'Be brief.',
    previousResponseId: null,
    store: true,
    metadata: { k: 'v' },
    echo: parseOk({ input: 'x' }).echo,
    itemId: (prefix) => `${prefix}_${String(++n)}`,
    ...patch,
  });
}

const types = (events: ResponseStreamEvent[]): string[] => events.map((e) => e.type);

function assertNumbered(events: ResponseStreamEvent[]): void {
  assert.deepEqual(
    events.map((e) => e.sequence_number),
    events.map((_, i) => i),
    'sequence_number counts up from 0 with no gap',
  );
}

test('a text answer streams the reference order of events, numbered from 0, and ends completed with its usage', () => {
  const t = translator();
  const events = [...t.open(), ...[textStart('Hel'), textAppend('lo.', 3), message('Hello.'), result()].flatMap((e) => t.push(e, { usage: USAGE }))];
  assert.deepEqual(types(events), [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.delta',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.completed',
  ]);
  assertNumbered(events);
  const created = events[0];
  assert.equal(created?.type === 'response.created' ? created.response.status : null, 'in_progress');
  const done = events.at(-1);
  assert.ok(done?.type === 'response.completed');
  const response = done.response;
  assert.equal(response.status, 'completed');
  assert.deepEqual(response.output, [{ type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Hello.', annotations: [], logprobs: [] }] }]);
  assert.deepEqual(response.usage, { input_tokens: 130, input_tokens_details: { cached_tokens: 100, cache_write_tokens: 20 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 135 });
  assert.equal(response.instructions, 'Be brief.');
  assert.deepEqual(response.metadata, { k: 'v' });
  const end = t.end();
  assert.equal(end?.kind, 'response');
  if (end?.kind === 'response') {
    assert.equal(end.costUsd, 0.02);
    assert.deepEqual(end.response, response);
  }
  assert.deepEqual(t.answered(), { text: 'Hello.', toolCalls: [] });
});

test('the item added event carries the item as it starts, not as it ends', () => {
  const t = translator();
  const events = [...t.open(), ...[textStart('Hi'), message('Hi'), result()].flatMap((e) => t.push(e, { usage: USAGE }))];
  const added = events.find((e) => e.type === 'response.output_item.added');
  assert.ok(added?.type === 'response.output_item.added');
  assert.deepEqual(added.item, { type: 'message', id: 'msg_1', status: 'in_progress', role: 'assistant', content: [] });
});

test('client calls stream as function_call items with their arguments, and handing them over completes the response', () => {
  const t = translator({ clientTools: { prefix: 'mcp__client__', names: new Set(['get_weather']), single: false } });
  const events = [...t.open(), ...t.push(textStart('Checking.')), ...t.push(message('Checking.')), ...t.push(callMessage('toolu_1', 'get_weather', { city: 'Paris' })), ...t.push(callMessage('toolu_2', 'get_weather', { city: 'Rome' }))];
  const handed = t.handOff();
  assert.ok(handed);
  const all = [...events, ...handed];
  assert.deepEqual(types(all), [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.output_item.added',
    'response.function_call_arguments.delta',
    'response.function_call_arguments.done',
    'response.output_item.done',
    'response.output_item.added',
    'response.function_call_arguments.delta',
    'response.function_call_arguments.done',
    'response.output_item.done',
    'response.completed',
  ]);
  assertNumbered(all);
  const done = all.at(-1);
  assert.ok(done?.type === 'response.completed');
  assert.equal(done.response.status, 'completed');
  assert.equal(done.response.usage, null, 'the CLI reports usage only once the results are in');
  assert.deepEqual(done.response.output.slice(1), [
    { type: 'function_call', id: 'fc_2', call_id: 'toolu_1', name: 'get_weather', arguments: '{"city":"Paris"}', status: 'completed' },
    { type: 'function_call', id: 'fc_3', call_id: 'toolu_2', name: 'get_weather', arguments: '{"city":"Rome"}', status: 'completed' },
  ]);
  assert.deepEqual(t.answered()?.toolCalls.map((c) => c.id), ['toolu_1', 'toolu_2']);
});

test('text after a client call opens its own message item without the block separator, and the output resent finds the same key', () => {
  const t = translator({ clientTools: { prefix: 'mcp__client__', names: new Set(['get_weather']), single: false } });
  const mixed = ev({
    kind: 'message',
    entry: entry([
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'toolu_1', name: 'mcp__client__get_weather', input: { city: 'Paris' } },
      { type: 'text', text: 'One moment.' },
    ]),
  });
  const events = [...t.open(), ...t.push(mixed)];
  const handed = t.handOff();
  assert.ok(handed);
  const done = [...events, ...handed].at(-1);
  assert.ok(done?.type === 'response.completed');
  const output = done.response.output;
  assert.deepEqual(
    output.map((i) => (i.type === 'message' ? ['message', i.content[0]?.text] : [i.type, i.call_id])),
    [
      ['message', 'Checking.'],
      ['function_call', 'toolu_1'],
      ['message', 'One moment.'],
    ],
  );
  const deltas = [...events, ...handed].flatMap((e) => (e.type === 'response.output_text.delta' ? [e.delta] : []));
  assert.deepEqual(deltas, ['Checking.', 'One moment.'], 'no item starts with the separator');

  // The key the answer was remembered under is the one both ways back to the chat carry
  const first = parseOk({ input: 'Weather in Paris?' });
  const answered = t.answered();
  assert.ok(answered);
  assert.equal(assistantOfOutput(output).text, answered.text);
  const remembered = keyAfterAnswer(responsesTurnOf(first).keySeed, first.chat.messages, answered);
  const resent = parseOk({ input: [{ role: 'user', content: 'Weather in Paris?' }, ...output, { type: 'function_call_output', call_id: 'toolu_1', output: 'sunny' }] });
  assert.equal(historyKey(responsesTurnOf(resent).keySeed, resent.chat.messages), remembered, 'the whole output resent');
  const followed = withPreviousOutput(parseOk({ input: [{ type: 'function_call_output', call_id: 'toolu_1', output: 'sunny' }] }), output);
  assert.equal(historyKey(responsesTurnOf(first).keySeed, [...first.chat.messages, ...followed.chat.messages]), remembered, 'the stored output before the new items');
});

test('a failure after the response was created is response.failed with its error, the unfinished item left incomplete', () => {
  const t = translator();
  const events = [...t.open(), ...t.push(textStart('Partial')), ...t.push(result({ isError: true }, 'boom'))];
  assert.deepEqual(types(events), ['response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added', 'response.output_text.delta', 'response.failed']);
  assertNumbered(events);
  const failed = events.at(-1);
  assert.ok(failed?.type === 'response.failed');
  assert.equal(failed.response.status, 'failed');
  assert.deepEqual(failed.response.error, { code: 'server_error', message: 'The run failed: boom' });
  assert.equal(failed.response.output[0]?.status, 'incomplete');
  assert.equal(failed.response.usage, null);
  const end = t.end();
  assert.equal(end?.kind, 'error');
  if (end?.kind === 'error') assert.equal(end.status, 500);
});

test('a failure outside the events, before any output, still fails the response, and a usage limit says so', () => {
  const t = translator();
  const events = t.failWith({ kind: 'usage-limit', resetsAt: null, message: 'limit' });
  assert.deepEqual(types(events), ['response.created', 'response.in_progress', 'response.failed']);
  const failed = events.at(-1);
  assert.equal(failed?.type === 'response.failed' ? failed.response.error?.code : null, 'rate_limit_exceeded');
  assert.deepEqual(t.failWith({ kind: 'server', message: 'again' }), [], 'nothing after the end');
});

test('a budget that cut the answer is incomplete with max_output_tokens, and a refusal with content_filter', () => {
  const t = translator();
  const events = [...t.open(), ...[textStart('Half an ans'), result({ isError: true, cause: 'budget' })].flatMap((e) => t.push(e, { usage: USAGE }))];
  assert.equal(events.at(-1)?.type, 'response.incomplete');
  const end = t.end();
  assert.ok(end?.kind === 'response');
  assert.equal(end.response.status, 'incomplete');
  assert.deepEqual(end.response.incomplete_details, { reason: 'max_output_tokens' });
  assert.equal(end.response.output[0]?.status, 'incomplete');
  const refusal = translator();
  for (const e of [message('No.'), result({ stopReason: 'refusal' })]) refusal.push(e);
  const refused = refusal.end();
  assert.ok(refused?.kind === 'response');
  assert.deepEqual(refused.response.incomplete_details, { reason: 'content_filter' });
});

test('a structured answer is one text delta of the JSON at the end, the prose beside it left out', () => {
  const t = translator({ structured: true });
  const events = [...t.open(), ...[textStart('Here it is'), message('Here it is'), result({ structuredOutput: { capital: 'Paris' }, stopReason: 'tool_use' })].flatMap((e) => t.push(e, { usage: USAGE }))];
  const deltas = events.flatMap((e) => (e.type === 'response.output_text.delta' ? [e.delta] : []));
  assert.deepEqual(deltas, ['{"capital":"Paris"}']);
  assert.equal(events.at(-1)?.type, 'response.completed');
});

test('usage counts cache reads and writes as input, named apart', () => {
  assert.deepEqual(responseUsage({ input: 1, output: 2, cacheRead: 3, cacheCreation: 4, total: 10 }), {
    input_tokens: 8,
    input_tokens_details: { cached_tokens: 3, cache_write_tokens: 4 },
    output_tokens: 2,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 10,
  });
});

// ---------- the stored responses ----------

function stores(now: () => string): { responses: OpenAiResponseStore; conversations: OpenAiConversationStore; db: Db } {
  const db = new Db(tempConfig());
  return { responses: new OpenAiResponseStore(db.connection, now), conversations: new OpenAiConversationStore(db.connection, now), db };
}

const responseObject = (id: string): ResponseObject => {
  const t = translator({ id });
  for (const e of [message('Hi.'), result()]) t.push(e, { usage: USAGE });
  const end = t.end();
  assert.ok(end?.kind === 'response');
  return end.response;
};

test('a stored response is found again with its chat, key, object and input; deleting it removes only the row', () => {
  const { responses, db } = stores(() => '2026-10-26T10:00:00.000Z');
  try {
    const inputItems = storedInputItems(parseOk({ input: 'hi' }).inputItems, () => null);
    responses.save({ id: 'resp_a', chatId: 'chat-1', conversationKey: 'k1', response: responseObject('resp_a'), conversationSystem: 'Be brief.', inputItems });
    const found = responses.find('resp_a');
    assert.equal(found?.chatId, 'chat-1');
    assert.equal(found?.conversationSystem, 'Be brief.', 'the chain carries its system and developer messages');
    assert.equal(found?.conversationKey, 'k1');
    assert.equal(found?.response.id, 'resp_a');
    assert.deepEqual(responses.inputItems('resp_a'), inputItems);
    assert.equal(responses.inputItems('resp_missing'), null);
    assert.equal(found?.createdAt, '2026-10-26T10:00:00.000Z');
    assert.equal(responses.find('resp_missing'), null);
    assert.equal(responses.delete('resp_a'), true);
    assert.equal(responses.delete('resp_a'), false);
    assert.equal(responses.find('resp_a'), null);
  } finally {
    db.close();
  }
});

test("deleting a chat from the store drops its stored responses with it", () => {
  const { responses, db } = stores(() => '2026-10-26T10:00:00.000Z');
  try {
    responses.save({ id: 'resp_a', chatId: 'chat-1', conversationKey: 'k', response: responseObject('resp_a'), conversationSystem: null, inputItems: [] });
    responses.save({ id: 'resp_b', chatId: 'chat-2', conversationKey: 'k', response: responseObject('resp_b'), conversationSystem: null, inputItems: [] });
    db.deleteChat('chat-1');
    assert.equal(responses.find('resp_a'), null);
    assert.equal(responses.find('resp_b')?.chatId, 'chat-2');
    assert.equal(responses.hasChat('chat-1'), false);
    assert.equal(responses.hasChat('chat-2'), true);
  } finally {
    db.close();
  }
});

const runtime = (id: string, fields: Partial<ChatRuntime> = {}): ChatRuntime => ({ id, origin: 'api', pid: null, updatedAt: '2026-01-01T00:00:00.000Z', ...fields }) as ChatRuntime;

test('the sweep expires old stored responses, and an api chat a fresh one still leads to is kept', async () => {
  let at = '2026-01-01T00:00:00.000Z';
  const { responses, conversations, db } = stores(() => at);
  try {
    responses.save({ id: 'resp_old', chatId: 'old-chat', conversationKey: 'k', response: responseObject('resp_old'), conversationSystem: null, inputItems: [] });
    at = '2026-01-20T00:00:00.000Z';
    responses.save({ id: 'resp_new', chatId: 'kept-chat', conversationKey: 'k', response: responseObject('resp_new'), conversationSystem: null, inputItems: [] });
    const removed: string[] = [];
    const sweep = await sweepOpenAiChats(
      { conversations, responses, runtime: { list: () => [runtime('old-chat'), runtime('kept-chat')] }, remove: async (id) => void removed.push(id) },
      Date.parse('2026-01-21T00:00:00.000Z'),
      7 * 24 * 3600 * 1000,
    );
    assert.equal(sweep.responses, 1);
    assert.equal(responses.find('resp_old'), null);
    assert.ok(responses.find('resp_new'));
    assert.deepEqual(removed, ['old-chat']);
  } finally {
    db.close();
  }
});

test('a large data URL image leaves a small stored row, and the listed input reads it back from its upload', () => {
  const { responses, db } = stores(() => '2026-10-26T10:00:00.000Z');
  try {
    const bytes = 3 * 1024 * 1024;
    const payload = Buffer.alloc(bytes, 7);
    const big = `data:image/png;base64,${payload.toString('base64')}`;
    const link = 'https://example.com/cat.png';
    const long = `https://example.com/${'a'.repeat(STORED_IMAGE_URL_MAX)}`;
    const request = parseOk({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'All?' }, { type: 'input_image', image_url: big }, { type: 'input_image', image_url: link, detail: 'low' }, { type: 'input_image', image_url: long }] }] });
    // The turn still gets the image whole
    const user = request.chat.messages[0];
    assert.equal(user?.role === 'user' && user.parts[1]?.type === 'image' && user.parts[1].image.kind === 'data' ? user.parts[1].image.sizeBytes : null, bytes);
    const inputItems = storedInputItems(request.inputItems, (image) => (image.kind === 'data' ? 'up-1' : null));
    responses.save({ id: 'resp_img', chatId: 'chat-1', conversationKey: 'k', response: responseObject('resp_img'), conversationSystem: null, inputItems });
    const row = db.connection.prepare('SELECT length(input_items) AS n FROM openai_responses WHERE id = ?').get('resp_img') as { n: number };
    assert.ok(row.n < 1024, `the row holds ${String(row.n)} characters of input`);
    const stored = responses.inputItems('resp_img');
    assert.ok(stored);
    const digest = openAiImageDigest({ kind: 'data', mediaType: 'image/png', base64: payload.toString('base64'), sizeBytes: bytes });
    assert.deepEqual(responses.uploadsOfImage('chat-1', digest), ['up-1'], 'a later row finds the upload by the image');
    assert.deepEqual(responses.uploadsOfImage('chat-2', digest), []);

    const read = (upload: string) => (upload === 'up-1' ? { bytes: payload, mediaType: 'image/png' } : null);
    const listed = listedInputItems(stored, read)[0];
    assert.ok(listed?.type === 'message');
    assert.deepEqual(listed.content, [
      { type: 'input_text', text: 'All?' },
      { type: 'input_image', image_url: big, detail: 'auto' },
      { type: 'input_image', image_url: link, detail: 'low' },
      { type: 'input_image', image_url: `https://example.com/?claudio-omitted-chars=${String(long.length)}`, detail: 'auto' },
    ]);
    // Without its upload, the image is a marker with its type and size
    const gone = listedInputItems(stored, () => null)[0];
    assert.ok(gone?.type === 'message');
    assert.deepEqual(gone.content[1], { type: 'input_image', image_url: `data:image/png;claudio-omitted-bytes=${String(bytes)},`, detail: 'auto' });
  } finally {
    db.close();
  }
});

test('an image is the same in the conversation key however its bytes were base64-encoded', () => {
  // `AB==` and `AA==` decode to the same byte: a client's encoding and the one read back from an upload
  const withImage = (base64: string) => parseOk({ input: [{ role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${base64}` }] }, { role: 'assistant', content: 'seen' }, { role: 'user', content: 'next' }] });
  const a = withImage('AB==');
  const b = withImage('AA==');
  assert.equal(historyKey(responsesTurnOf(a).keySeed, a.chat.messages), historyKey(responsesTurnOf(b).keySeed, b.chat.messages));
});
