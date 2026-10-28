import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@claudio/core';
import type { ChatSummary } from '@claudio/shared';
import { buildApp } from '../src/app.ts';
import { standInGuard } from './fixtures/declared-guard.ts';
import { ClientToolRegistry } from '../src/routes/openai-tools.ts';

// `POST /v1/responses` and its stored responses (docs/openai-compatible-api.md, phase 5), over a
// real core, the real routes and stub MCP server, and the fake CLI the Chat Completions tests use.

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude-openai.mjs', import.meta.url));
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let root: string;
let core: Core;
let app: FastifyInstance;
let base: string;
let token: string;
let log: string;
const registry = new ClientToolRegistry();

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'claudio-api-openai-responses-'));
  log = join(root, 'prompts.jsonl');
  process.env.FAKE_OPENAI_PROMPTS = log;
  core = new Core(
    loadConfig({
      CLAUDE_BIN: FAKE,
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
    }),
  );
  standInGuard(core, join(root, 'guard'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  await core.appSettings.update({ maxConcurrentRuns: 64 });
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui'), clientTools: registry });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${String(address.port)}`;
  core.runtime.apiUrl = `${base}/api`;
  token = (await core.security.setToken({})).token;
});

after(async () => {
  core.shutdown();
  await app.close();
  delete process.env.FAKE_OPENAI_PROMPTS;
  rmSync(root, { recursive: true, force: true });
});

// ---------- helpers ----------

interface OutputItem {
  type: string;
  id: string;
  status: string;
  role?: string;
  content?: Array<{ type: string; text: string }>;
  call_id?: string;
  name?: string;
  arguments?: string;
}
interface ResponseBody {
  id: string;
  object: string;
  created_at: number;
  status: string;
  error: { code: string; message: string } | null;
  incomplete_details: { reason: string } | null;
  instructions: string | null;
  model: string;
  output: OutputItem[];
  previous_response_id: string | null;
  store: boolean;
  text: unknown;
  tools: unknown[];
  tool_choice: unknown;
  parallel_tool_calls: boolean;
  metadata: Record<string, string>;
  usage: { input_tokens: number; input_tokens_details: { cached_tokens: number; cache_write_tokens: number }; output_tokens: number; total_tokens: number; cost_usd?: number } | null;
}
interface ErrorBody {
  error: { message: string; type: string; param: string | null; code: string | null };
}
interface StreamEvent {
  name: string;
  type: string;
  sequence_number: number;
  response?: ResponseBody;
  item?: OutputItem;
  delta?: string;
  arguments?: string;
}
interface Logged {
  sessionId: string;
  pid: number;
  prompt?: string;
  resume?: string | null;
  images?: number;
  schema?: string | null;
  system?: string | null;
  instruction?: string | null;
  stub?: unknown;
}

const auth = (): Record<string, string> => ({ authorization: `Bearer ${token}` });
const post = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${base}/api/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth(), ...headers }, body: JSON.stringify(body) });
const get = (path: string): Promise<Response> => fetch(`${base}/api/v1${path}`, { headers: auth() });

async function ok(res: Response): Promise<ResponseBody> {
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as ResponseBody;
}

const chatOf = (res: Response): string => {
  const id = res.headers.get('x-claudio-chat-id');
  assert.ok(id);
  return id;
};

const textOf = (body: ResponseBody): string =>
  body.output
    .filter((i) => i.type === 'message')
    .flatMap((i) => i.content ?? [])
    .map((c) => c.text)
    .join('');

/** Every SSE frame with its `event:` name and parsed `data:` */
function eventsOf(text: string): StreamEvent[] {
  return text
    .split('\n\n')
    .map((frame) => {
      const lines = frame.split('\n');
      const name = lines.find((l) => l.startsWith('event: '))?.slice('event: '.length);
      const data = lines.find((l) => l.startsWith('data: '))?.slice('data: '.length);
      return name !== undefined && data !== undefined ? { ...(JSON.parse(data) as Omit<StreamEvent, 'name'>), name } : null;
    })
    .filter((e): e is StreamEvent => e !== null);
}

function logged(chatId: string): Logged[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Logged)
    .filter((l) => l.sessionId === chatId);
}
const turnsOf = (chatId: string): Logged[] => logged(chatId).filter((l) => l.prompt !== undefined);

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function assertError(body: unknown, code: string, param?: string | null): ErrorBody {
  const shaped = body as ErrorBody;
  assert.equal(typeof shaped.error?.message, 'string', JSON.stringify(body));
  assert.equal(shaped.error.code, code, JSON.stringify(body));
  if (param !== undefined) assert.equal(shaped.error.param, param, JSON.stringify(body));
  return shaped;
}

const weather = { type: 'function', name: 'get_weather', description: 'The weather in a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } };
const lookup = { type: 'function', name: 'lookup', parameters: { type: 'object', properties: { key: { type: 'string' } } } };
const directive = (kind: string, calls: Array<{ name: string; input?: unknown }>) => `${kind} ${JSON.stringify(calls)}`;
const output = (callId: string, text: string) => ({ type: 'function_call_output', call_id: callId, output: text });
const callsOf = (body: ResponseBody): OutputItem[] => body.output.filter((i) => i.type === 'function_call');

// ---------- whole answers ----------

test('a string input is answered whole as a response object, with usage, the chat header and the cost header', async () => {
  const res = await post({ model: 'sonnet', input: 'Hello Responses', metadata: { app: 'test' } });
  const body = await ok(res);
  const chatId = chatOf(res);
  assert.match(body.id, /^resp_[0-9a-f]{32}$/);
  assert.equal(body.object, 'response');
  assert.equal(typeof body.created_at, 'number');
  assert.equal(body.status, 'completed');
  assert.equal(body.model, 'sonnet');
  assert.equal(body.error, null);
  assert.equal(body.incomplete_details, null);
  assert.equal(body.store, true);
  assert.equal(body.previous_response_id, null);
  assert.deepEqual(body.metadata, { app: 'test' });
  assert.deepEqual(body.text, { format: { type: 'text' } });
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.parallel_tool_calls, true);
  assert.equal(body.output.length, 1);
  const message = body.output[0];
  assert.equal(message?.type, 'message');
  assert.match(message?.id ?? '', /^msg_/);
  assert.equal(message?.role, 'assistant');
  assert.equal(message?.status, 'completed');
  assert.deepEqual(message?.content, [{ type: 'output_text', text: 'echo: Hello Responses', annotations: [], logprobs: [] }]);
  // The fake's first turn: 10 input, 100 cache read, 20 cache write, 5 output
  assert.deepEqual(body.usage, { input_tokens: 130, input_tokens_details: { cached_tokens: 100, cache_write_tokens: 20 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 135, cost_usd: 0.01 });
  assert.equal(res.headers.get('x-claudio-cost-usd'), '0.01');
  assert.equal(core.runtime.get(chatId)?.origin, 'api');
  assert.equal((await core.chats.get(chatId))?.title, 'Hello Responses');
  // The turn's cost is in usage only: no other field of the response carries it
  assert.equal(JSON.stringify({ ...body, usage: null }).includes('cost'), false, 'the cost is only usage.cost_usd');
});

test('item input and instructions: messages of every role, instructions and developer text in the system prompt', async () => {
  const res = await post({
    model: 'sonnet',
    instructions: 'Answer like a pirate.',
    input: [
      { role: 'developer', content: 'Keep it short.' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'First line' }, { type: 'input_text', text: 'Second line' }] },
    ],
  });
  const body = await ok(res);
  assert.equal(body.instructions, 'Answer like a pirate.');
  assert.equal(textOf(body), 'echo: Second line');
  const turn = turnsOf(chatOf(res))[0];
  assert.equal(turn?.prompt, 'First line\nSecond line');
  assert.match(turn?.system ?? '', /^Answer like a pirate\.\n\nKeep it short\./);
});

test('an input image goes to the chat as an attachment; a file id or another scheme is refused', async () => {
  const res = await post({ model: 'sonnet', input: [{ role: 'user', content: [{ type: 'input_text', text: 'What is this?' }, { type: 'input_image', image_url: `data:image/png;base64,${PNG}`, detail: 'auto' }] }] });
  await ok(res);
  assert.equal(turnsOf(chatOf(res))[0]?.images, 1);
  assert.match(turnsOf(chatOf(res))[0]?.prompt ?? '', /\[image 1\]/);
  const byId = await post({ model: 'sonnet', input: [{ role: 'user', content: [{ type: 'input_image', file_id: 'file_1' }] }] });
  assert.equal(byId.status, 400);
  assertError(await byId.json(), 'unsupported_parameter', 'input[0].content[0].file_id');
  const notAnImage = await post({ model: 'sonnet', input: [{ role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${Buffer.from('not a png').toString('base64')}` }] }] });
  assert.equal(notAnImage.status, 400);
  assertError(await notAnImage.json(), 'unsupported_parameter', 'input');
});

// ---------- state ----------

test('previous_response_id continues the same chat with only the new input, and the response says which it followed', async () => {
  const first = await post({ model: 'sonnet', input: 'Remember the word kumquat' });
  const one = await ok(first);
  const chatId = chatOf(first);
  const second = await post({ model: 'sonnet', previous_response_id: one.id, input: [{ role: 'user', content: 'What was the word?' }] });
  const two = await ok(second);
  assert.equal(chatOf(second), chatId);
  assert.equal(two.previous_response_id, one.id);
  assert.equal(textOf(two), 'echo: What was the word?');
  const turns = turnsOf(chatId);
  assert.equal(turns.length, 2);
  assert.equal(turns[1]?.prompt, 'What was the word?', 'only the new item goes to the chat');
  assert.equal(turns[1]?.pid, turns[0]?.pid, 'the same live process took it');
  // The second turn's own usage, not the process's running total
  assert.equal(two.usage?.output_tokens, 5);
  assert.equal(second.headers.get('x-claudio-cost-usd'), '0.01');
});

test('an unknown, deleted or never-stored previous_response_id is 404 not_found, and nothing runs', async () => {
  const unknown = await post({ model: 'sonnet', previous_response_id: 'resp_nope', input: 'x' });
  assert.equal(unknown.status, 404);
  assertError(await unknown.json(), 'not_found', 'previous_response_id');

  const kept = await ok(await post({ model: 'sonnet', input: 'to be deleted' }));
  const deleted = await fetch(`${base}/api/v1/responses/${kept.id}`, { method: 'DELETE', headers: auth() });
  assert.deepEqual(await deleted.json(), { id: kept.id, object: 'response.deleted', deleted: true });
  const afterDelete = await post({ model: 'sonnet', previous_response_id: kept.id, input: 'x' });
  assert.equal(afterDelete.status, 404);
  assertError(await afterDelete.json(), 'not_found', 'previous_response_id');

  const unstoredRes = await post({ model: 'sonnet', input: 'not kept', store: false });
  const unstored = await ok(unstoredRes);
  assert.equal(unstored.store, false);
  assert.equal((await get(`/responses/${unstored.id}`)).status, 404, 'store: false is not retrievable');
  const continued = await post({ model: 'sonnet', previous_response_id: unstored.id, input: 'x' });
  assert.equal(continued.status, 404, 'nor continuable');
  assert.equal(turnsOf(chatOf(unstoredRes)).length, 1);
});

test('a stored response is only continued into a chat this surface started; its chat deleted takes it along', async () => {
  const person = await fetch(`${base}/api/chats`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'a person' }) });
  assert.equal(person.status, 201, await person.clone().text());
  const personId = ((await person.json()) as ChatSummary).id;
  const theirs = await ok(await post({ model: 'sonnet', input: 'borrowed' }));
  const stored = core.openaiResponses.find(theirs.id);
  assert.ok(stored);
  core.openaiResponses.save({ ...stored, id: 'resp_person', chatId: personId, inputItems: [] });
  const res = await post({ model: 'sonnet', previous_response_id: 'resp_person', input: 'inject' });
  assert.equal(res.status, 404);
  assertError(await res.json(), 'not_found', 'previous_response_id');
  assert.ok(!logged(personId).some((l) => l.prompt === 'inject'));

  const goneRes = await post({ model: 'sonnet', input: 'goes with its chat' });
  const gone = await ok(goneRes);
  const chatId = chatOf(goneRes);
  await core.chats.interrupt(chatId).catch(() => undefined);
  core.runtime.stop(chatId);
  await until(() => core.runtime.get(chatId)?.pid === null);
  const removed = await fetch(`${base}/api/chats/${chatId}`, { method: 'DELETE' });
  assert.ok(removed.status < 300, await removed.clone().text());
  assert.equal(core.openaiResponses.find(gone.id), null);
  assert.equal((await get(`/responses/${gone.id}`)).status, 404);
});

test('a resent history finds its chat without an id, also after a previous_response_id turn', async () => {
  const first = await post({ model: 'sonnet', input: 'alpha' });
  const one = await ok(first);
  const chatId = chatOf(first);
  const second = await post({ model: 'sonnet', previous_response_id: one.id, input: 'beta' });
  const two = await ok(second);
  assert.equal(chatOf(second), chatId);
  // The client forgets the id and sends everything, the outputs as it got them
  const third = await post({ model: 'sonnet', store: false, input: [{ role: 'user', content: 'alpha' }, ...one.output, { role: 'user', content: 'beta' }, ...two.output, { role: 'user', content: 'gamma' }] });
  await ok(third);
  assert.equal(chatOf(third), chatId);
  assert.equal(turnsOf(chatId).at(-1)?.prompt, 'gamma');
});

test('a budget that cut the answer is a 200 incomplete response with max_output_tokens', async () => {
  const body = await ok(await post({ model: 'sonnet', input: 'BUDGET' }));
  assert.equal(body.status, 'incomplete');
  assert.deepEqual(body.incomplete_details, { reason: 'max_output_tokens' });
  assert.equal(body.output[0]?.status, 'incomplete');
  assert.equal(textOf(body), 'A long answer that the budget cut');
});

test('a failed turn answered whole is an error in OpenAI shape, and nothing is stored', async () => {
  const before = (core.db.connection.prepare('SELECT COUNT(*) AS n FROM openai_responses').get() as { n: number }).n;
  const res = await post({ model: 'sonnet', input: 'FAIL broken' });
  assert.equal(res.status, 500);
  assertError(await res.json(), 'server_error');
  assert.equal((core.db.connection.prepare('SELECT COUNT(*) AS n FROM openai_responses').get() as { n: number }).n, before);
});

// ---------- structured output ----------

test('text.format json_schema answers the structured output as the message text, whole and streamed as one delta', async () => {
  const format = { type: 'json_schema', name: 'answer', schema: { type: 'object', properties: { answer: { type: 'string' } } }, strict: true };
  const whole = await post({ model: 'sonnet', input: 'Capital?', text: { format } });
  const body = await ok(whole);
  assert.deepEqual(JSON.parse(textOf(body)), { answer: 'echo: Capital?' });
  assert.deepEqual(body.text, { format });
  assert.ok(turnsOf(chatOf(whole))[0]?.schema);

  const streamed = await post({ model: 'sonnet', input: 'Again?', text: { format }, stream: true });
  const events = eventsOf(await streamed.text());
  const deltas = events.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta);
  assert.deepEqual(deltas, [JSON.stringify({ answer: 'echo: Again?' })]);
  assert.equal(events.at(-1)?.type, 'response.completed');
});

// ---------- streaming ----------

test('every Responses stream event carries data, and none opens with a retry field', async () => {
  const res = await post({ model: 'sonnet', input: 'Frames', stream: true });
  const text = await res.text();
  assert.doesNotMatch(text, /^retry:/m);
  const events = text.split(/\n\n/).map((frame) => frame.split('\n').filter((line) => line && !line.startsWith(':'))).filter((lines) => lines.length > 0);
  assert.ok(events.length > 1);
  for (const lines of events) assert.ok(lines.some((line) => line.startsWith('data:')), `an event without data: ${JSON.stringify(lines)}`);
});

test('a streamed text answer is the reference sequence of named events with a rising sequence_number', async () => {
  const res = await post({ model: 'sonnet', input: 'Stream me', stream: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const chatId = chatOf(res);
  const text = await res.text();
  assert.ok(!text.includes('[DONE]'), 'the Responses stream has no [DONE]');
  const events = eventsOf(text);
  assert.deepEqual(
    events.map((e) => e.type),
    [
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
    ],
  );
  for (const event of events) assert.equal(event.name, event.type, 'each frame is named for its type');
  assert.deepEqual(
    events.map((e) => e.sequence_number),
    events.map((_, i) => i),
  );
  assert.equal(events[0]?.response?.status, 'in_progress');
  const done = events.at(-1)?.response;
  assert.equal(done?.status, 'completed');
  assert.equal(textOf(done as ResponseBody), 'echo: Stream me');
  assert.ok(done?.usage);
  // The streamed response is stored as it ended
  const stored = await get(`/responses/${done?.id ?? ''}`);
  assert.deepEqual(await stored.json(), done);
  assert.equal(turnsOf(chatId).length, 1);
});

test('a streamed failure ends with response.failed carrying the error, never a silent end', async () => {
  const res = await post({ model: 'sonnet', input: 'FAIL kaput', stream: true });
  assert.equal(res.status, 200);
  const events = eventsOf(await res.text());
  assert.deepEqual(
    events.map((e) => e.type),
    ['response.created', 'response.in_progress', 'response.failed'],
  );
  const failed = events.at(-1)?.response;
  assert.equal(failed?.status, 'failed');
  assert.deepEqual(failed?.error, { code: 'server_error', message: 'The run failed: kaput' });
  assert.equal((await get(`/responses/${failed?.id ?? ''}`)).status, 404, 'a failed response is not stored');

  const died = await post({ model: 'sonnet', input: 'EXIT', stream: true });
  const diedEvents = eventsOf(await died.text());
  assert.equal(diedEvents.at(-1)?.type, 'response.failed');
  assert.match(diedEvents.at(-1)?.response?.error?.message ?? '', /ended before it answered/);
});

// ---------- function tools ----------

test('a function call ends the response completed with a function_call item; function_call_output with previous_response_id finishes the turn', async () => {
  const first = await post({ model: 'sonnet', input: directive('TOOLS', [{ name: 'get_weather', input: { city: 'Madrid' } }]), tools: [weather] });
  const one = await ok(first);
  const chatId = chatOf(first);
  assert.equal(one.status, 'completed');
  assert.equal(one.usage, null, 'the CLI reports usage once the results are in');
  assert.deepEqual(one.tools, [{ ...weather, strict: true }]);
  const calls = callsOf(one);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.match(call?.id ?? '', /^fc_/);
  assert.match(call?.call_id ?? '', /^toolu_/);
  assert.equal(call?.name, 'get_weather');
  assert.equal(call?.arguments, '{"city":"Madrid"}');
  assert.equal(call?.status, 'completed');
  assert.equal(registry.ofChat(chatId)?.waiting, true);

  const second = await post({ model: 'sonnet', previous_response_id: one.id, input: [output(call?.call_id ?? '', '21 C and sunny')], tools: [weather] });
  const two = await ok(second);
  assert.equal(chatOf(second), chatId);
  assert.equal(textOf(two), 'results: 21 C and sunny');
  assert.ok(two.usage);
  assert.equal(turnsOf(chatId).length, 1, 'no message was sent: the held call took the result');
});

test('parallel calls stream as function_call items with their arguments events; results in any order are matched by call_id', async () => {
  const res = await post({ model: 'sonnet', stream: true, input: directive('TOOLS_TEXT', [{ name: 'get_weather', input: { city: 'Paris' } }, { name: 'get_weather', input: { city: 'Rome' } }]), tools: [weather] });
  const events = eventsOf(await res.text());
  assert.deepEqual(
    events.map((e) => e.type),
    [
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
    ],
  );
  assert.deepEqual(
    events.map((e) => e.sequence_number),
    events.map((_, i) => i),
  );
  const added = events.filter((e) => e.type === 'response.output_item.added' && e.item?.type === 'function_call');
  assert.ok(added.every((e) => e.item?.status === 'in_progress' && e.item.arguments === ''));
  const done = events.at(-1)?.response as ResponseBody;
  const [paris, rome] = callsOf(done);
  assert.equal(paris?.arguments, '{"city":"Paris"}');
  assert.equal(rome?.arguments, '{"city":"Rome"}');
  const next = await post({ model: 'sonnet', previous_response_id: done.id, input: [output(rome?.call_id ?? '', 'rain'), output(paris?.call_id ?? '', 'sun')], tools: [weather] });
  assert.equal(textOf(await ok(next)), 'results: sun | rain');
});

test('function_call_output works with the whole history resent instead of previous_response_id', async () => {
  const input = [{ role: 'user', content: directive('TOOLS', [{ name: 'lookup', input: { key: 'k1' } }]) }];
  const first = await post({ model: 'sonnet', input, tools: [lookup], store: false });
  const one = await ok(first);
  const call = callsOf(one)[0];
  const second = await post({ model: 'sonnet', input: [...input, ...one.output, output(call?.call_id ?? '', 'value one')], tools: [lookup] });
  assert.equal(chatOf(second), chatOf(first));
  assert.equal(textOf(await ok(second)), 'results: value one');
});

test('results that do not answer the calls are 400s that name them', async () => {
  const one = await ok(await post({ model: 'sonnet', input: directive('TOOLS', [{ name: 'lookup', input: { key: 'a' } }, { name: 'lookup', input: { key: 'b' } }]), tools: [lookup] }));
  const [a] = callsOf(one);
  const partial = await post({ model: 'sonnet', previous_response_id: one.id, input: [output(a?.call_id ?? '', 'only one')], tools: [lookup] });
  assert.equal(partial.status, 400);
  const missing = assertError(await partial.json(), 'invalid_request_error', 'input').error.message;
  assert.match(missing, /have no output: send a `function_call_output` with each `call_id`/);
  const stranger = await post({ model: 'sonnet', previous_response_id: one.id, input: [output('call_unknown', 'who?')], tools: [lookup] });
  assert.equal(stranger.status, 400);
  const unknown = assertError(await stranger.json(), 'invalid_request_error', 'input').error.message;
  assert.match(unknown, /`call_unknown`.*`function_call_output`/);
  // While the CLI holds the calls, a user message after their outputs is refused in the same words
  const [, b] = callsOf(one);
  const chatter = await post({ model: 'sonnet', previous_response_id: one.id, input: [output(a?.call_id ?? '', 'A'), output(b?.call_id ?? '', 'B'), { role: 'user', content: 'and also' }], tools: [lookup] });
  assert.equal(chatter.status, 400);
  const held = assertError(await chatter.json(), 'invalid_request_error', 'input').error.message;
  assert.match(held, /after `function_call_output` items/);
  for (const said of [missing, unknown, held]) assert.doesNotMatch(said, /`tool` message|`tool_calls`/, 'no Chat Completions words on /v1/responses');
});

test('reasoning.effort a live process cannot take is named in x-claudio-ignored by its Responses name', async () => {
  const one = await ok(await post({ model: 'sonnet', input: 'think a little', reasoning: { effort: 'low' } }));
  const next = await post({ model: 'sonnet', previous_response_id: one.id, input: 'and again', reasoning: { effort: 'high' } });
  await ok(next);
  const ignored = (next.headers.get('x-claudio-ignored') ?? '').split(', ');
  assert.ok(ignored.includes('reasoning.effort'), ignored.join(', '));
  assert.ok(!ignored.includes('reasoning_effort'));
});

test('a new user message instead of the results drops the held calls and the chat goes on', async () => {
  const firstRes = await post({ model: 'sonnet', input: directive('TOOLS', [{ name: 'lookup', input: { key: 'x' } }]), tools: [lookup] });
  const first = await ok(firstRes);
  const chatId = chatOf(firstRes);
  await until(() => registry.ofChat(chatId)?.heldCount() === 1);
  const next = await post({ model: 'sonnet', previous_response_id: first.id, input: 'Never mind, say hi', tools: [lookup] });
  assert.equal(textOf(await ok(next)), 'echo: Never mind, say hi');
  assert.equal(chatOf(next), chatId);
  assert.equal(registry.ofChat(chatId)?.waiting, false);
});

test('results for calls a person withdrew go in cold to the idle process', async () => {
  const firstRes = await post({ model: 'sonnet', input: directive('TOOLS', [{ name: 'lookup', input: { key: 'w' } }]), tools: [lookup] });
  const first = await ok(firstRes);
  const chatId = chatOf(firstRes);
  const session = registry.ofChat(chatId);
  assert.ok(session);
  await until(() => session.heldCount() === 1);
  await core.chats.interrupt(chatId);
  await until(() => core.runtime.get(chatId)?.status === 'idle');
  assert.equal(session.waiting, false);
  const id = callsOf(first)[0]?.call_id ?? '';
  const res = await post({ model: 'sonnet', previous_response_id: first.id, input: [output(id, 'late value')], tools: [lookup] });
  await ok(res);
  assert.equal(res.headers.get('x-claudio-resume'), 'cold');
  assert.match(turnsOf(chatId).at(-1)?.prompt ?? '', new RegExp(`<tool-result id="${id}">\\nlate value\\n</tool-result>`));
});

test('results for a chat whose process died resume it cold with --resume and x-claudio-resume: cold', async () => {
  const firstRes = await post({ model: 'sonnet', input: directive('TOOLS', [{ name: 'lookup', input: { key: 'dead' } }]), tools: [lookup] });
  const first = await ok(firstRes);
  const chatId = chatOf(firstRes);
  const pid = core.runtime.get(chatId)?.pid;
  assert.ok(pid);
  process.kill(pid, 'SIGKILL');
  await until(() => core.runtime.get(chatId)?.pid === null);
  const id = callsOf(first)[0]?.call_id ?? '';
  const res = await post({ model: 'sonnet', previous_response_id: first.id, input: [output(id, 'after the crash')], tools: [lookup] });
  await ok(res);
  assert.equal(res.headers.get('x-claudio-resume'), 'cold');
  const resumed = turnsOf(chatId).at(-1);
  assert.equal(resumed?.resume, chatId);
  assert.match(resumed?.prompt ?? '', /restarted/);
});

test('tool_choice in the Responses shapes: none leaves the tools out, a named function and required become the turn instruction', async () => {
  const none = await post({ model: 'sonnet', input: 'no tools please', tools: [weather], tool_choice: 'none' });
  await ok(none);
  assert.match(none.headers.get('x-claudio-ignored') ?? '', /tools/);
  assert.equal(registry.ofChat(chatOf(none)), undefined, 'no stub without tools');

  const named = await post({ model: 'sonnet', input: 'named', tools: [weather, lookup], tool_choice: { type: 'function', name: 'lookup' } });
  const namedBody = await ok(named);
  assert.deepEqual(namedBody.tool_choice, { type: 'function', name: 'lookup' });
  assert.match(turnsOf(chatOf(named))[0]?.instruction ?? '', /mcp__client__lookup/);

  const required = await post({ model: 'sonnet', input: 'required', tools: [weather], tool_choice: 'required' });
  await ok(required);
  assert.match(turnsOf(chatOf(required))[0]?.instruction ?? '', /call at least one/);

  const single = await post({ model: 'sonnet', input: directive('TOOLS', [{ name: 'lookup', input: { key: '1' } }, { name: 'lookup', input: { key: '2' } }]), tools: [lookup], parallel_tool_calls: false });
  const singleBody = await ok(single);
  assert.equal(callsOf(singleBody).length, 1);
  assert.equal(singleBody.parallel_tool_calls, false);
});

// ---------- refusals ----------

test('what this surface cannot do is refused before anything runs', async () => {
  const cases: Array<[Record<string, unknown>, string, string]> = [
    [{ tools: [weather], text: { format: { type: 'json_object' } } }, 'unsupported_parameter', 'text.format'],
    [{ tools: [{ type: 'web_search' }] }, 'unsupported_parameter', 'tools[0].type'],
    [{ tools: [{ type: 'code_interpreter', container: { type: 'auto' } }] }, 'unsupported_parameter', 'tools[0].type'],
    [{ tools: [{ type: 'mcp', server_label: 'x', server_url: 'https://example.com' }] }, 'unsupported_parameter', 'tools[0].type'],
    [{ background: true }, 'unsupported_parameter', 'background'],
    [{ conversation: 'conv_123' }, 'unsupported_parameter', 'conversation'],
    [{ tools: [{ type: 'function', name: 'Bash' }] }, 'invalid_request_error', 'tools[0].name'],
    [{ input: [{ type: 'mystery' }, { role: 'user', content: 'x' }] }, 'invalid_request_error', 'input[0].type'],
  ];
  for (const [patch, code, param] of cases) {
    const res = await post({ model: 'sonnet', input: 'should not run', ...patch });
    assert.equal(res.status, 400, JSON.stringify(patch));
    assertError(await res.json(), code, param);
  }
  const model = await post({ model: 'gpt-9', input: 'x' });
  assert.equal(model.status, 404);
  assertError(await model.json(), 'model_not_found', 'model');
  const noAuth = await fetch(`${base}/api/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'sonnet', input: 'x' }) });
  assert.equal(noAuth.status, 401);
  assertError(await noAuth.json(), 'invalid_api_key');
});

test('previous_response_id and X-Claudio-Chat-Id naming different chats is a 400', async () => {
  const aRes = await post({ model: 'sonnet', input: 'chat a' });
  const a = await ok(aRes);
  const bRes = await post({ model: 'sonnet', input: 'chat b' });
  await ok(bRes);
  const res = await post({ model: 'sonnet', previous_response_id: a.id, input: 'x' }, { 'x-claudio-chat-id': chatOf(bRes) });
  assert.equal(res.status, 400);
  assertError(await res.json(), 'invalid_request_error', 'previous_response_id');
});

// ---------- retrieve, delete, input items ----------

test('GET returns the stored response, DELETE removes the row but not the chat, and input_items pages the input', async () => {
  const res = await post({ model: 'sonnet', input: [{ role: 'developer', content: 'Be terse.' }, { role: 'user', content: 'one' }, { role: 'user', content: 'two' }] });
  const body = await ok(res);
  const chatId = chatOf(res);
  const fetched = await get(`/responses/${body.id}`);
  assert.equal(fetched.status, 200);
  assert.deepEqual(await fetched.json(), body);

  const page = (await (await get(`/responses/${body.id}/input_items?limit=2`)).json()) as { object: string; data: Array<{ id: string; role: string }>; first_id: string; last_id: string; has_more: boolean };
  assert.equal(page.object, 'list');
  assert.deepEqual(
    page.data.map((i) => i.role),
    ['user', 'user'],
    'newest first',
  );
  assert.equal(page.has_more, true);
  const rest = (await (await get(`/responses/${body.id}/input_items?limit=2&after=${page.last_id}`)).json()) as typeof page;
  assert.deepEqual(
    rest.data.map((i) => i.role),
    ['developer'],
  );
  assert.equal(rest.has_more, false);
  const asc = (await (await get(`/responses/${body.id}/input_items?order=asc`)).json()) as typeof page;
  assert.equal(asc.data[0]?.role, 'developer');
  assert.equal((await get(`/responses/${body.id}/input_items?limit=0`)).status, 400);

  const deleted = await fetch(`${base}/api/v1/responses/${body.id}`, { method: 'DELETE', headers: auth() });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { id: body.id, object: 'response.deleted', deleted: true });
  const again = await fetch(`${base}/api/v1/responses/${body.id}`, { method: 'DELETE', headers: auth() });
  assert.equal(again.status, 404);
  assertError(await again.json(), 'not_found');
  assert.equal((await get(`/responses/${body.id}`)).status, 404);
  assert.equal((await get(`/responses/${body.id}/input_items`)).status, 404);
  assert.ok(await core.chats.get(chatId), 'the chat stays');
});

// ---------- storage failures ----------

/** Makes both stores throw as SQLite does under contention, for the length of `run`. */
async function withFailingStores<T>(run: () => Promise<T>): Promise<T> {
  const save = core.openaiResponses.save;
  const remember = core.openaiConversations.remember;
  const busy = (): never => {
    throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
  };
  core.openaiResponses.save = busy;
  core.openaiConversations.remember = busy;
  try {
    return await run();
  } finally {
    core.openaiResponses.save = save;
    core.openaiConversations.remember = remember;
  }
}

test('a store that fails to write still serves the answer, whole and streamed, and frees the conversation for the next request', async () => {
  const first = await post({ model: 'sonnet', input: 'before the failure' });
  await ok(first);
  const chatId = chatOf(first);
  const named = { 'x-claudio-chat-id': chatId };
  // Bounded: before the fix the request never settled
  const bounded = { signal: AbortSignal.timeout(5000) };
  const sent = (body: unknown): Promise<Response> =>
    fetch(`${base}/api/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth(), ...named }, body: JSON.stringify(body), ...bounded });

  const whole = await withFailingStores(() => sent({ model: 'sonnet', input: 'whole while the disk is full' }));
  const body = await ok(whole);
  assert.equal(body.status, 'completed');
  assert.equal(textOf(body), 'echo: whole while the disk is full');
  assert.equal((await get(`/responses/${body.id}`)).status, 404, 'the response that could not be stored is not found later');

  const streamed = await withFailingStores(async () => {
    const res = await sent({ model: 'sonnet', input: 'streamed while the disk is full', stream: true });
    return { status: res.status, events: eventsOf(await res.text()) };
  });
  assert.equal(streamed.status, 200);
  assert.equal(streamed.events.at(-1)?.type, 'response.completed', 'the final event still goes out');
  assert.equal(textOf(streamed.events.at(-1)?.response as ResponseBody), 'echo: streamed while the disk is full');

  // The chat's queue was released: the next request on it is served
  const next = await sent({ model: 'sonnet', input: 'after the failure' });
  assert.equal(textOf(await ok(next)), 'echo: after the failure');
  assert.equal(chatOf(next), chatId);
});

// ---------- instructions on a live process ----------

test('new instructions restart the idle process with them; the same ones keep it, and none clears them', async () => {
  const first = await post({ model: 'sonnet', instructions: 'Answer like a pirate.', input: 'one' });
  const one = await ok(first);
  const chatId = chatOf(first);
  const two = await ok(await post({ model: 'sonnet', previous_response_id: one.id, instructions: 'Answer like a poet.', input: 'two' }));
  const three = await ok(await post({ model: 'sonnet', previous_response_id: two.id, instructions: 'Answer like a poet.', input: 'three' }));
  await ok(await post({ model: 'sonnet', previous_response_id: three.id, input: 'four' }));
  const turns = turnsOf(chatId);
  assert.deepEqual(
    turns.map((t) => t.prompt),
    ['one', 'two', 'three', 'four'],
  );
  assert.equal(turns[0]?.system, 'Answer like a pirate.');
  assert.equal(turns[1]?.system, 'Answer like a poet.', 'the live process was restarted with the new instructions');
  assert.notEqual(turns[1]?.pid, turns[0]?.pid);
  assert.equal(turns[1]?.resume, chatId, 'resumed, so the conversation goes on');
  assert.equal(turns[2]?.pid, turns[1]?.pid, 'the same instructions keep the process');
  assert.equal(turns[3]?.system, null, 'a request without instructions does not run under the last ones');
});

test('new instructions on a held function call are named in x-claudio-ignored and reach the chat with its next turn', async () => {
  const firstRes = await post({ model: 'sonnet', input: directive('TOOLS', [{ name: 'lookup', input: { key: 'i' } }]), tools: [lookup] });
  const first = await ok(firstRes);
  const chatId = chatOf(firstRes);
  const call = callsOf(first)[0];
  // As the reference's own function-calling example does: instructions only on the second request
  const second = await post({ model: 'sonnet', previous_response_id: first.id, instructions: 'Be brief.', input: [output(call?.call_id ?? '', 'value')], tools: [lookup] });
  const two = await ok(second);
  assert.equal(textOf(two), 'results: value');
  assert.ok((second.headers.get('x-claudio-ignored') ?? '').split(', ').includes('instructions'));
  await ok(await post({ model: 'sonnet', previous_response_id: two.id, instructions: 'Be brief.', input: 'next', tools: [lookup] }));
  assert.equal(turnsOf(chatId).at(-1)?.system, 'Be brief.');
});

// ---------- the system prompt's two parts ----------

test('a developer message stays in the chat\'s system prompt under previous_response_id, on the live process and without a restart', async () => {
  const firstRes = await post({ model: 'sonnet', input: [{ role: 'developer', content: 'Answer in French.' }, { role: 'user', content: 'one' }] });
  const first = await ok(firstRes);
  const chatId = chatOf(firstRes);
  const second = await post({ model: 'sonnet', previous_response_id: first.id, input: 'two' });
  await ok(second);
  assert.equal(second.headers.get('x-claudio-ignored'), null);
  const turns = turnsOf(chatId);
  assert.deepEqual(
    turns.map((t) => [t.prompt, t.system]),
    [
      ['one', 'Answer in French.'],
      ['two', 'Answer in French.'],
    ],
  );
  assert.equal(turns[1]?.pid, turns[0]?.pid, 'the same effective prompt keeps the process');
});

test('a cold resume runs with the chain\'s developer messages, after a plain turn and after held calls whose process died', async () => {
  const firstRes = await post({ model: 'sonnet', input: [{ role: 'developer', content: 'Answer in French.' }, { role: 'user', content: 'one' }] });
  const first = await ok(firstRes);
  const chatId = chatOf(firstRes);
  await core.chats.interrupt(chatId).catch(() => undefined);
  core.runtime.stop(chatId);
  await until(() => core.runtime.get(chatId)?.pid === null);
  await ok(await post({ model: 'sonnet', previous_response_id: first.id, input: 'two' }));
  const resumed = turnsOf(chatId).at(-1);
  assert.equal(resumed?.resume, chatId);
  assert.equal(resumed?.system, 'Answer in French.', 'a request without system messages does not erase the chain\'s');

  const heldRes = await post({ model: 'sonnet', input: [{ role: 'developer', content: 'Answer in German.' }, { role: 'user', content: directive('TOOLS', [{ name: 'lookup', input: { key: 'k' } }]) }], tools: [lookup] });
  const held = await ok(heldRes);
  const heldChat = chatOf(heldRes);
  const pid = core.runtime.get(heldChat)?.pid;
  assert.ok(pid);
  process.kill(pid, 'SIGKILL');
  await until(() => core.runtime.get(heldChat)?.pid === null);
  const res = await post({ model: 'sonnet', previous_response_id: held.id, input: [output(callsOf(held)[0]?.call_id ?? '', 'value')], tools: [lookup] });
  await ok(res);
  assert.equal(res.headers.get('x-claudio-resume'), 'cold');
  assert.equal(turnsOf(heldChat).at(-1)?.system, 'Answer in German.');
});

test('a held turn with the same instructions names nothing ignored, and the next turn keeps instructions and developer text', async () => {
  const firstRes = await post({ model: 'sonnet', instructions: 'X', input: [{ role: 'developer', content: 'D' }, { role: 'user', content: directive('TOOLS', [{ name: 'lookup', input: { key: 'h' } }]) }], tools: [lookup] });
  const first = await ok(firstRes);
  const chatId = chatOf(firstRes);
  const second = await post({ model: 'sonnet', previous_response_id: first.id, instructions: 'X', input: [output(callsOf(first)[0]?.call_id ?? '', 'value')], tools: [lookup] });
  const two = await ok(second);
  assert.equal(textOf(two), 'results: value');
  assert.equal(second.headers.get('x-claudio-ignored'), null, 'nothing the client sent was left out');
  await ok(await post({ model: 'sonnet', previous_response_id: two.id, instructions: 'X', input: 'next', tools: [lookup] }));
  const turns = turnsOf(chatId);
  assert.equal(turns.at(-1)?.system, 'X\n\nD');
  assert.equal(turns.at(-1)?.pid, turns[0]?.pid, 'an unchanged prompt keeps the process');
});

test('new instructions on an idle chat with client tools while the API address is unknown keep the live process and are named, never a 503', async () => {
  const firstRes = await post({ model: 'sonnet', instructions: 'Answer like a pirate.', input: 'one', tools: [lookup] });
  const first = await ok(firstRes);
  const chatId = chatOf(firstRes);
  const pid = core.runtime.get(chatId)?.pid;
  const api = core.runtime.apiUrl;
  core.runtime.apiUrl = null;
  let second: Response;
  try {
    second = await post({ model: 'sonnet', previous_response_id: first.id, instructions: 'Answer like a poet.', input: 'two', tools: [lookup] });
  } finally {
    core.runtime.apiUrl = api;
  }
  const two = await ok(second);
  assert.deepEqual((second.headers.get('x-claudio-ignored') ?? '').split(', '), ['instructions']);
  assert.equal(turnsOf(chatId).at(-1)?.system, 'Answer like a pirate.');
  assert.equal(turnsOf(chatId).at(-1)?.pid, pid);
  // Once the address is known, the next turn takes them
  await ok(await post({ model: 'sonnet', previous_response_id: two.id, instructions: 'Answer like a poet.', input: 'three', tools: [lookup] }));
  assert.equal(turnsOf(chatId).at(-1)?.system, 'Answer like a poet.');
});

test('a new developer message while the live process must keep its prompt is named as input, never as system', async () => {
  const firstRes = await post({ model: 'sonnet', input: [{ role: 'developer', content: 'D1' }, { role: 'user', content: 'one' }], tools: [lookup] });
  await ok(firstRes);
  const chatId = chatOf(firstRes);
  const api = core.runtime.apiUrl;
  core.runtime.apiUrl = null;
  let second: Response;
  try {
    second = await post({ model: 'sonnet', input: [{ role: 'developer', content: 'D2' }, { role: 'user', content: 'two' }], tools: [lookup] }, { 'x-claudio-chat-id': chatId });
  } finally {
    core.runtime.apiUrl = api;
  }
  await ok(second);
  assert.deepEqual((second.headers.get('x-claudio-ignored') ?? '').split(', '), ['input']);
});

/** A request while the API's address is unknown: a chat with client tools must keep its process's prompt */
async function withoutApiUrl(send: () => Promise<Response>): Promise<Response> {
  const api = core.runtime.apiUrl;
  core.runtime.apiUrl = null;
  try {
    return await send();
  } finally {
    core.runtime.apiUrl = api;
  }
}

const ignoredOf = (res: Response): string[] => (res.headers.get('x-claudio-ignored') ?? '').split(', ').filter(Boolean);

test('dropped instructions stay named on the next turn that keeps the process, though the chat\'s row already has them dropped', async () => {
  const firstRes = await post({ model: 'sonnet', instructions: 'X', input: [{ role: 'developer', content: 'D' }, { role: 'user', content: directive('TOOLS', [{ name: 'lookup', input: { key: 'd' } }]) }], tools: [lookup] });
  const first = await ok(firstRes);
  const chatId = chatOf(firstRes);
  const second = await post({ model: 'sonnet', previous_response_id: first.id, input: [output(callsOf(first)[0]?.call_id ?? '', 'value')], tools: [lookup] });
  const two = await ok(second);
  assert.deepEqual(ignoredOf(second), ['instructions'], 'the held turn goes on with them');
  const third = await withoutApiUrl(() => post({ model: 'sonnet', previous_response_id: two.id, input: 'next', tools: [lookup] }));
  await ok(third);
  assert.equal(turnsOf(chatId).at(-1)?.system, 'X\n\nD', 'the process still runs the old instructions');
  assert.deepEqual(ignoredOf(third), ['instructions'], 'what was left out is the instructions, not the input');
});

test('a changed developer message with the same instructions stays named as input on consecutive turns that keep the process', async () => {
  const firstRes = await post({ model: 'sonnet', instructions: 'X', input: [{ role: 'developer', content: 'D1' }, { role: 'user', content: 'one' }], tools: [lookup] });
  await ok(firstRes);
  const chatId = chatOf(firstRes);
  const ask = (prompt: string) => () => post({ model: 'sonnet', instructions: 'X', input: [{ role: 'developer', content: 'D2' }, { role: 'user', content: prompt }], tools: [lookup] }, { 'x-claudio-chat-id': chatId });
  const second = await withoutApiUrl(ask('two'));
  await ok(second);
  assert.deepEqual(ignoredOf(second), ['input']);
  const third = await withoutApiUrl(ask('three'));
  await ok(third);
  assert.equal(turnsOf(chatId).at(-1)?.system, 'X\n\nD1');
  assert.deepEqual(ignoredOf(third), ['input'], 'the instructions run as asked; the developer message does not');
});

test('a chat without its prompt row keeps its process\'s prompt and writes no row from the joined one', async () => {
  const firstRes = await post({ model: 'sonnet', instructions: 'I', input: [{ role: 'developer', content: 'C' }, { role: 'user', content: 'one' }] });
  await ok(firstRes);
  const chatId = chatOf(firstRes);
  // A chat from before the rows were kept
  core.db.connection.prepare('DELETE FROM openai_chat_prompts WHERE chat_id = ?').run(chatId);
  const second = await post({ model: 'sonnet', instructions: 'J', input: 'two' }, { 'x-claudio-chat-id': chatId });
  await ok(second);
  const turns = turnsOf(chatId);
  assert.equal(turns.at(-1)?.system, 'I\n\nC', 'the old instructions are not carried as the conversation part');
  assert.equal(turns.at(-1)?.pid, turns[0]?.pid);
  assert.equal(core.openaiChatPrompts.find(chatId), null, 'no row is written from a guess');
  assert.ok((second.headers.get('x-claudio-ignored') ?? '').split(', ').includes('instructions'));
});

// ---------- input_items round trip ----------

test('input_items replayed with the output as the next input reach the same chat, images read back from their uploads', async () => {
  const image = { type: 'input_image', image_url: `data:image/png;base64,${PNG}`, detail: 'auto' };
  const firstRes = await post({ model: 'sonnet', input: [{ role: 'developer', content: 'Describe images.' }, { role: 'user', content: [{ type: 'input_text', text: 'What is this?' }, image] }] });
  const first = await ok(firstRes);
  const chatId = chatOf(firstRes);
  type Listed = { data: Array<Record<string, unknown> & { content?: Array<Record<string, unknown>> }> };
  const listed = (await (await get(`/responses/${first.id}/input_items?order=asc`)).json()) as Listed;
  assert.deepEqual(listed.data[1]?.content?.[1], image, 'the image comes back as it was sent');

  // A stateless client rebuilds its history from what the API listed, and sends it again
  const history = [...listed.data, ...first.output];
  const secondRes = await post({ model: 'sonnet', input: [...history, { role: 'user', content: 'And now?' }] });
  const second = await ok(secondRes);
  assert.equal(chatOf(secondRes), chatId, 'the same conversation key');
  assert.equal(turnsOf(chatId).at(-1)?.prompt, 'And now?', 'continued warm, not started again cold');

  // The second row lists the first image too, although this turn uploaded nothing
  const again = (await (await get(`/responses/${second.id}/input_items?order=asc`)).json()) as Listed;
  assert.deepEqual(again.data[1]?.content?.[1], image);

  // An upload that is gone leaves a marker with the image's type and size
  const stored = core.openaiResponses.inputItems(first.id);
  const part = stored?.[1]?.type === 'message' ? stored[1].content[1] : undefined;
  assert.ok(part && 'stored' in part && part.stored.kind === 'data' && part.stored.upload);
  rmSync(join(core.uploads.dir, part.stored.upload), { recursive: true, force: true });
  const marked = (await (await get(`/responses/${first.id}/input_items?order=asc`)).json()) as Listed;
  assert.match(String(marked.data[1]?.content?.[1]?.image_url), /^data:image\/png;claudio-omitted-bytes=\d+,$/);
});

test('storing a turn saves no upload of its own: an image no stored response holds is listed as its marker', async () => {
  const image = { type: 'input_image', image_url: `data:image/png;base64,${PNG}`, detail: 'auto' };
  // Not stored, so no row names the upload this turn made
  const firstRes = await post({ model: 'sonnet', store: false, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Twice?' }, image, image] }] });
  const first = await ok(firstRes);
  const uploads = readdirSync(core.uploads.dir).length;
  const secondRes = await post({ model: 'sonnet', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Twice?' }, image, image] }, ...first.output, { role: 'user', content: 'And now?' }] });
  const second = await ok(secondRes);
  assert.equal(chatOf(secondRes), chatOf(firstRes), 'continued warm');
  assert.equal(readdirSync(core.uploads.dir).length, uploads, 'no 5 MB copy per image part');
  type Listed = { data: Array<{ content?: Array<{ image_url?: string }> }> };
  const listed = (await (await get(`/responses/${second.id}/input_items?order=asc`)).json()) as Listed;
  assert.match(String(listed.data[0]?.content?.[1]?.image_url), /claudio-omitted-bytes=/);
});

test('an image this turn uploaded is named from the turn, with no lookup in earlier rows, however often the input carries it', async () => {
  const image = { type: 'input_image', image_url: `data:image/png;base64,${PNG}`, detail: 'auto' };
  const firstRes = await post({ model: 'sonnet', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Look' }, image] }] });
  const first = await ok(firstRes);
  const lookups: string[] = [];
  const original = core.openaiResponses.uploadsOfImage.bind(core.openaiResponses);
  core.openaiResponses.uploadsOfImage = (chatId, digest) => {
    lookups.push(digest);
    return original(chatId, digest);
  };
  let second: Awaited<ReturnType<typeof ok>>;
  try {
    second = await ok(await post({ model: 'sonnet', previous_response_id: first.id, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Again' }, image, image] }] }));
  } finally {
    core.openaiResponses.uploadsOfImage = original;
  }
  assert.deepEqual(lookups, []);
  const stored = core.openaiResponses.inputItems(second.id);
  const parts = stored?.[0]?.type === 'message' ? stored[0].content : [];
  const named = parts.flatMap((p) => ('stored' in p && p.stored.kind === 'data' ? [p.stored.upload] : []));
  assert.equal(named.length, 2);
  assert.ok(named[0]);
  assert.equal(named[0], named[1], 'one upload for the one image');
});
