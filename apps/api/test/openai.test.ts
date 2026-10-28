import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ChatCompletionTranslator, ChatConflictError, ChatNotFoundError, Core, loadConfig, parseChatCompletionRequest, ResponsesTranslator, RunSlotRefusal, STREAM_DONE, translateOpenAiRequest, type ChatCompletionRequest, type OpenAiTurnTranslator } from '@claudio/core';
import type { ChatSummary, RunEvent } from '@claudio/shared';
import { buildApp } from '../src/app.ts';
import { failureOf, TurnRun } from '../src/routes/openai.ts';

// The OpenAI-compatible routes over a real core and a fake CLI that keeps its process across turns
// and reports its cost and token counts cumulative, as the real one does (docs/openai-compatible-api.md).

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude-openai.mjs', import.meta.url));
// A 1x1 PNG: the upload store reads the type from the bytes
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let root: string;
let core: Core;
let app: FastifyInstance;
let base: string;
let token: string;
let prompts: string;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'claudio-api-openai-'));
  prompts = join(root, 'prompts.jsonl');
  process.env.FAKE_OPENAI_PROMPTS = prompts;
  core = new Core(
    loadConfig({
      CLAUDE_BIN: FAKE,
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
    }),
  );
  mkdirSync(join(root, 'workspace', 'sub'), { recursive: true });
  // Each chat keeps its process up between turns, as it does for a person, and this file starts many
  await core.appSettings.update({ maxConcurrentRuns: 64 });
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${String(address.port)}`;
  // Authentication stays off (`mode: none`); the OpenAI routes still need the owner's token
  token = (await core.security.setToken({})).token;
});

after(async () => {
  core.shutdown();
  await app.close();
  delete process.env.FAKE_OPENAI_PROMPTS;
  rmSync(root, { recursive: true, force: true });
});

interface OpenAiErrorBody {
  error: { message: string; type: string; param: string | null; code: string | null };
}

interface Completion {
  id: string;
  object: string;
  model: string;
  choices: Array<{ index: number; message: { role: string; content: string | null }; finish_reason: string }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; prompt_tokens_details: { cached_tokens: number }; cost_usd?: number };
}

const auth = (): Record<string, string> => ({ authorization: `Bearer ${token}` });

async function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/api/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth(), ...headers }, body: JSON.stringify(body) });
}

const user = (text: string) => ({ role: 'user', content: text });

function parseOk(body: unknown): ChatCompletionRequest {
  const parsed = parseChatCompletionRequest(body);
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.error.body));
  return parsed.value;
}
const assistant = (text: string) => ({ role: 'assistant', content: text });

function assertOpenAiError(body: unknown, code: string): OpenAiErrorBody {
  const shaped = body as OpenAiErrorBody;
  assert.equal(typeof shaped.error, 'object', JSON.stringify(body));
  assert.equal(typeof shaped.error.message, 'string');
  assert.ok(['invalid_request_error', 'rate_limit_error', 'server_error', 'run_error'].includes(shaped.error.type), shaped.error.type);
  assert.ok('param' in shaped.error);
  assert.equal(shaped.error.code, code, JSON.stringify(body));
  return shaped;
}

/** Every `data:` line of an SSE body, in order */
function dataLines(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length));
}

function promptsOf(chatId: string): Array<{ prompt: string; images: number; pid: number; schema: string | null }> {
  if (!existsSync(prompts)) return [];
  return readFileSync(prompts, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { sessionId: string; prompt: string; images: number; pid: number; schema: string | null })
    .filter((p) => p.sessionId === chatId);
}

// ---------- models ----------

test('GET /v1/models lists the models a chat can run on in OpenAI\'s list shape', async () => {
  const res = await fetch(`${base}/api/v1/models`, { headers: auth() });
  assert.equal(res.status, 200);
  const list = (await res.json()) as { object: string; data: Array<{ id: string; object: string; created: number; owned_by: string }> };
  assert.equal(list.object, 'list');
  assert.ok(list.data.length > 0);
  for (const model of list.data) {
    assert.equal(model.object, 'model');
    assert.equal(typeof model.created, 'number');
    assert.equal(model.owned_by, 'claude-code');
  }
  assert.ok(list.data.some((m) => m.id === 'sonnet'));
});

test('GET /v1/models/:id finds a model by its value, and an unknown one is 404 model_not_found', async () => {
  const one = await fetch(`${base}/api/v1/models/sonnet`, { headers: auth() });
  assert.equal(one.status, 200);
  assert.deepEqual(await one.json(), { id: 'sonnet', object: 'model', created: 0, owned_by: 'claude-code' });
  const missing = await fetch(`${base}/api/v1/models/gpt-4o`, { headers: auth() });
  assert.equal(missing.status, 404);
  const body = assertOpenAiError(await missing.json(), 'model_not_found');
  assert.equal(body.error.param, 'model');
});

// ---------- whole answers, resumes and tokens ----------

test('a whole completion answers OpenAI\'s shape, names its chat and its cost in headers, and counts this turn\'s tokens', async () => {
  const res = await post({ model: 'sonnet', messages: [{ role: 'system', content: 'Be brief.' }, user('hello')], temperature: 0.2 });
  assert.equal(res.status, 200, await res.clone().text());
  const chatId = res.headers.get('x-claudio-chat-id');
  assert.ok(chatId);
  assert.equal(res.headers.get('x-claudio-cost-usd'), '0.01');
  assert.equal(res.headers.get('x-claudio-ignored'), 'temperature');
  const completion = (await res.json()) as Completion;
  assert.match(completion.id, /^chatcmpl-/);
  assert.equal(completion.object, 'chat.completion');
  assert.equal(completion.model, 'sonnet');
  assert.equal(completion.choices[0]?.message.content, 'echo: hello');
  assert.equal(completion.choices[0]?.finish_reason, 'stop');
  // input 10 + cache read 100 + cache creation 20, as the fake reports one turn
  // The turn's own cost in the body too (D16), the same figure as the header
  assert.deepEqual(completion.usage, { prompt_tokens: 130, completion_tokens: 5, total_tokens: 135, prompt_tokens_details: { cached_tokens: 100 }, cost_usd: 0.01 });
  assert.equal(core.runtime.get(chatId)?.origin, 'api');
});

test('a resent history continues the same chat with only the new messages, and the second turn is not billed twice', async () => {
  const first = await post({ model: 'sonnet', messages: [user('one')] });
  assert.equal(first.status, 200);
  const chatId = first.headers.get('x-claudio-chat-id');
  assert.ok(chatId);
  await first.json();
  const second = await post({ model: 'sonnet', messages: [user('one'), assistant('echo: one'), user('two')] });
  assert.equal(second.status, 200, await second.clone().text());
  assert.equal(second.headers.get('x-claudio-chat-id'), chatId);
  const completion = (await second.json()) as Completion;
  assert.equal(completion.choices[0]?.message.content, 'echo: two');
  // The process reports 20/10/200/40 cumulative now; the turn is the growth since its first result
  assert.deepEqual(completion.usage, { prompt_tokens: 130, completion_tokens: 5, total_tokens: 135, prompt_tokens_details: { cached_tokens: 100 }, cost_usd: 0.01 });
  assert.equal(second.headers.get('x-claudio-cost-usd'), '0.01');
  const sent = promptsOf(chatId);
  assert.equal(sent.length, 2);
  assert.equal(sent[1]?.prompt, 'two', 'only the delta reaches the chat');
  assert.equal(sent[0]?.pid, sent[1]?.pid, 'the same process took both turns');
});

test('X-Claudio-Chat-Id continues that chat, and an unknown id is 404 in OpenAI\'s shape', async () => {
  const first = await post({ model: 'sonnet', messages: [user('alpha')] });
  const chatId = first.headers.get('x-claudio-chat-id');
  assert.ok(chatId);
  await first.json();
  const named = await post({ model: 'sonnet', messages: [user('beta')] }, { 'x-claudio-chat-id': chatId });
  assert.equal(named.status, 200);
  assert.equal(named.headers.get('x-claudio-chat-id'), chatId);
  assert.equal(((await named.json()) as Completion).choices[0]?.message.content, 'echo: beta');
  const unknown = await post({ model: 'sonnet', messages: [user('beta')] }, { 'x-claudio-chat-id': 'no-such-chat' });
  assert.equal(unknown.status, 404);
  assertOpenAiError(await unknown.json(), 'not_found');
});

test('API chats stay out of the chat list unless it asks for their origin', async () => {
  const res = await post({ model: 'sonnet', messages: [user('listed?')] });
  const chatId = res.headers.get('x-claudio-chat-id');
  await res.json();
  const defaults = (await (await fetch(`${base}/api/chats`)).json()) as ChatSummary[];
  assert.ok(!defaults.some((c) => c.id === chatId));
  const api = (await (await fetch(`${base}/api/chats?origin=api`)).json()) as ChatSummary[];
  assert.ok(api.some((c) => c.id === chatId));
});

// ---------- titles ----------

/** The title the API serves for the chat a completion started */
async function titleOfCompletion(body: unknown): Promise<{ chatId: string; title: string | undefined }> {
  const res = await post(body);
  assert.equal(res.status, 200, await res.clone().text());
  const chatId = res.headers.get('x-claudio-chat-id') ?? '';
  await res.json();
  return { chatId, title: (await core.chats.get(chatId))?.title };
}

test("an API chat is titled with its first user message's first line, never the workspace name", async () => {
  const { title } = await titleOfCompletion({ model: 'sonnet', messages: [user('  Summarise the release notes\nand list the breaking changes')] });
  assert.equal(title, 'Summarise the release notes');
});

test('a system message before the first user message never becomes the title', async () => {
  const { title } = await titleOfCompletion({ model: 'sonnet', messages: [{ role: 'system', content: 'You are terse.' }, user('Name three rivers')] });
  assert.equal(title, 'Name three rivers');
});

test('a cold start over a history is titled with its first user message, not the preamble or the rendered turns', async () => {
  const first = 'Plan a trip to Lisbon';
  const { chatId, title } = await titleOfCompletion({ model: 'sonnet', messages: [user(first), assistant('Three days?'), user('Yes, three days')] });
  assert.equal(title, first);
  assert.match(promptsOf(chatId)[0]?.prompt ?? '', /<earlier-turns>/, 'the chat did start cold, over the rendered history');
});

test("an image part leaves the title to the message's text", async () => {
  const { title } = await titleOfCompletion({ model: 'sonnet', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }, { type: 'text', text: 'What is in this picture?' }] }] });
  assert.equal(title, 'What is in this picture?');
});

test('a long first message is cut to 100 characters, as a transcript title is', async () => {
  const { title } = await titleOfCompletion({ model: 'sonnet', messages: [user('x'.repeat(150))] });
  assert.equal(title, 'x'.repeat(100));
});

test('a resumed API chat keeps the title of its first turn', async () => {
  const { chatId, title } = await titleOfCompletion({ model: 'sonnet', messages: [user('Draft the changelog')] });
  assert.equal(title, 'Draft the changelog');
  const second = await post({ model: 'sonnet', messages: [user('Draft the changelog'), assistant('echo: Draft the changelog'), user('Shorter, please')] });
  assert.equal(second.headers.get('x-claudio-chat-id'), chatId);
  await second.json();
  assert.equal((await core.chats.get(chatId))?.title, 'Draft the changelog');
});

test('a chat started outside /v1 keeps its generated name until its transcript titles it', async () => {
  const res = await fetch(`${base}/api/chats`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'An ordinary chat' }) });
  assert.equal(res.status, 201, await res.clone().text());
  const { id } = (await res.json()) as { id: string };
  assert.match((await core.chats.get(id))?.title ?? '', new RegExp(`^workspace-${id.slice(0, 6)}$`));
});

// ---------- streaming ----------

test('a streamed completion sends role first, the text, a final chunk, the usage chunk when asked, then [DONE]', async () => {
  const res = await post({ model: 'sonnet', stream: true, stream_options: { include_usage: true }, messages: [user('streamed')] });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.ok(res.headers.get('x-claudio-chat-id'));
  const lines = dataLines(await res.text());
  assert.equal(lines.at(-1), '[DONE]');
  const chunks = lines.slice(0, -1).map((l) => JSON.parse(l) as { object: string; choices: Array<{ delta: { role?: string; content?: string | null }; finish_reason: string | null }>; usage: unknown });
  for (const chunk of chunks) assert.equal(chunk.object, 'chat.completion.chunk');
  assert.equal(chunks[0]?.choices[0]?.delta.role, 'assistant');
  const usage = chunks.at(-1);
  assert.deepEqual(usage?.choices, []);
  // The cost rides on the usage chunk: on a stream the header is a trailer most SDKs never read
  assert.deepEqual(usage?.usage, { prompt_tokens: 130, completion_tokens: 5, total_tokens: 135, prompt_tokens_details: { cached_tokens: 100 }, cost_usd: 0.01 });
  const final = chunks.at(-2);
  assert.equal(final?.choices[0]?.finish_reason, 'stop');
  assert.deepEqual(final?.choices[0]?.delta, {});
  const text = chunks.flatMap((c) => c.choices.map((ch) => ch.delta.content ?? '')).join('');
  assert.equal(text, 'echo: streamed');
  for (const chunk of chunks.slice(0, -1)) assert.equal(chunk.usage, null);
});

test('without include_usage a stream has no usage chunk', async () => {
  const res = await post({ model: 'sonnet', stream: true, messages: [user('no usage')] });
  const lines = dataLines(await res.text());
  assert.equal(lines.at(-1), '[DONE]');
  const chunks = lines.slice(0, -1).map((l) => JSON.parse(l) as { choices: unknown[]; usage: unknown });
  assert.ok(chunks.every((c) => c.choices.length === 1 && c.usage === null));
});

// OpenAI's streams carry data in every event. An event made of fields alone (a `retry:` the panel's
// streams open with) reaches the Python SDK as empty data, which it parses as JSON and fails on
test('every event of a stream carries data, and none opens with a retry field', async () => {
  const res = await post({ model: 'sonnet', stream: true, messages: [user('frames')] });
  const text = await res.text();
  assert.doesNotMatch(text, /^retry:/m);
  const events = text.split(/\n\n/).map((frame) => frame.split('\n').filter((line) => line && !line.startsWith(':'))).filter((lines) => lines.length > 0);
  assert.ok(events.length > 1);
  for (const lines of events) assert.ok(lines.some((line) => line.startsWith('data:')), `an event without data: ${JSON.stringify(lines)}`);
});

test('a turn that fails mid-stream ends with an error chunk and [DONE]; whole, it is a 500 in OpenAI\'s shape', async () => {
  const streamed = await post({ model: 'sonnet', stream: true, messages: [user('FAIL boom')] });
  assert.equal(streamed.status, 200);
  const lines = dataLines(await streamed.text());
  assert.equal(lines.at(-1), '[DONE]');
  assertOpenAiError(JSON.parse(lines.at(-2) ?? '{}'), 'server_error');
  const whole = await post({ model: 'sonnet', messages: [user('FAIL boom')] });
  assert.equal(whole.status, 500);
  assert.ok(whole.headers.get('x-claudio-chat-id'), 'the chat exists, so its id is still told');
  assert.match(assertOpenAiError(await whole.json(), 'server_error').error.message, /boom/);
});

test('a process that dies without a result is an error, not a silent end', async () => {
  const whole = await post({ model: 'sonnet', messages: [user('EXIT')] });
  assert.equal(whole.status, 500);
  assertOpenAiError(await whole.json(), 'server_error');
});

// ---------- refusals and errors ----------

test('what this phase cannot do is refused with 400 before any chat starts', async () => {
  const cases: Array<[unknown, string, string | null]> = [
    [{ model: 'sonnet', n: 2, messages: [user('x')] }, 'invalid_request_error', 'n'],
    [{ model: 'sonnet', messages: [user('x')], tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }], response_format: { type: 'json_object' } }, 'unsupported_parameter', 'response_format'],
    [{ model: 'sonnet', messages: [user('x')], functions: [{ name: 'f', parameters: { type: 'object' } }] }, 'unsupported_parameter', 'functions'],
    [{ model: 'sonnet', messages: [user('x'), assistant('y')] }, 'invalid_request_error', 'messages'],
    [{ model: 'sonnet' }, 'invalid_request_error', 'messages'],
  ];
  const before = (await (await fetch(`${base}/api/chats?origin=api`)).json()) as ChatSummary[];
  for (const [body, code, param] of cases) {
    const res = await post(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    const error = await res.json();
    if (code === 'unsupported_parameter') assert.equal(assertOpenAiError(error, code).error.param, param);
    else assert.equal((error as OpenAiErrorBody).error.type, 'invalid_request_error', JSON.stringify(error));
  }
  const tools = await post(cases[1]?.[0]);
  assert.match(((await tools.json()) as OpenAiErrorBody).error.message, /not supported yet/);
  const after = (await (await fetch(`${base}/api/chats?origin=api`)).json()) as ChatSummary[];
  assert.equal(after.length, before.length, 'no chat started');
});

test('errors under /v1 are OpenAI-shaped while the rest of the API keeps its own', async () => {
  const unknownRoute = await fetch(`${base}/api/v1/embeddings`, { method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body: '{}' });
  assert.equal(unknownRoute.status, 404);
  assertOpenAiError(await unknownRoute.json(), 'not_found');
  const elsewhere = await fetch(`${base}/api/chats/no-such-chat`);
  assert.equal(elsewhere.status, 404);
  assert.equal(typeof ((await elsewhere.json()) as { error: unknown }).error, 'string');
});

test('the OpenAI routes need a credential even with authentication off, which the rest does not', async () => {
  const none = await fetch(`${base}/api/v1/models`);
  assert.equal(none.status, 401);
  assertOpenAiError(await none.json(), 'invalid_api_key');
  const wrong = await fetch(`${base}/api/v1/models`, { headers: { authorization: 'Bearer not-the-token-at-all-not-at-all' } });
  assert.equal(wrong.status, 401);
  assertOpenAiError(await wrong.json(), 'invalid_api_key');
  assert.equal((await fetch(`${base}/api/chats`)).status, 200, 'the rest of the API stays open under mode none');
});

test('X-Claudio-Cwd must be an absolute directory inside the workspace or a project', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'claudio-openai-outside-'));
  try {
    for (const cwd of ['relative/dir', join(root, 'workspace', 'missing'), outside]) {
      const res = await post({ model: 'sonnet', messages: [user('where')] }, { 'x-claudio-cwd': cwd });
      assert.equal(res.status, 400, cwd);
      assert.match(((await res.json()) as OpenAiErrorBody).error.message, /x-claudio-cwd/);
    }
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
  const inside = await post({ model: 'sonnet', messages: [user('where')] }, { 'x-claudio-cwd': join(root, 'workspace', 'sub') });
  assert.equal(inside.status, 200);
  const chatId = inside.headers.get('x-claudio-chat-id');
  await inside.json();
  assert.equal(core.runtime.get(chatId ?? '')?.cwd, join(root, 'workspace', 'sub'));
});

test('an unknown X-Claudio-Tool-Preset is refused', async () => {
  const res = await post({ model: 'sonnet', messages: [user('x')] }, { 'x-claudio-tool-preset': 'no-such-preset' });
  assert.equal(res.status, 400);
  assertOpenAiError(await res.json(), 'invalid_request_error');
});

test('chats started here run with no permission prompts, the default preset and never bypassPermissions', async () => {
  await core.appSettings.update({ defaultPermissionMode: 'bypassPermissions' });
  try {
    const res = await post({ model: 'sonnet', messages: [user('safe?')] });
    const chatId = res.headers.get('x-claudio-chat-id') ?? '';
    await res.json();
    const runtime = core.runtime.get(chatId);
    assert.ok(runtime);
    assert.notEqual(runtime.permissionMode, 'bypassPermissions');
    assert.equal(runtime.permissionPrompts, 'none');
  } finally {
    await core.appSettings.update({ defaultPermissionMode: 'acceptEdits' });
  }
});

test('over the daily spend cap the answer is 429 with Retry-After in OpenAI\'s shape', async () => {
  await core.appSettings.update({ dailySpendCapUsd: 1 });
  core.db.addSpend({ at: new Date().toISOString(), chatId: 'seed', executionId: 'seed', usd: 5, reported: true, purpose: 'flow', account: null, accountKind: null, projectId: null, orchestrationId: null });
  try {
    const res = await post({ model: 'sonnet', messages: [user('spend')] });
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) >= 1);
    const body = assertOpenAiError(await res.json(), 'rate_limit_exceeded');
    assert.equal(body.error.type, 'rate_limit_error');
  } finally {
    await core.appSettings.update({ dailySpendCapUsd: null });
  }
});

// ---------- concurrency and disconnects ----------

test('two requests on one conversation run one after the other in its chat instead of colliding', async () => {
  const first = await post({ model: 'sonnet', messages: [user('base')] });
  const chatId = first.headers.get('x-claudio-chat-id');
  await first.json();
  const history = [user('base'), assistant('echo: base')];
  const [a, b] = await Promise.all([
    post({ model: 'sonnet', messages: [...history, user('SLOW 400')] }),
    post({ model: 'sonnet', messages: [...history, user('second')] }),
  ]);
  assert.equal(a.status, 200, await a.clone().text());
  assert.equal(b.status, 200, await b.clone().text());
  assert.equal(a.headers.get('x-claudio-chat-id'), chatId);
  assert.equal(b.headers.get('x-claudio-chat-id'), chatId);
  assert.equal(((await a.json()) as Completion).choices[0]?.message.content, 'echo: SLOW 400');
  assert.equal(((await b.json()) as Completion).choices[0]?.message.content, 'echo: second');
});

test('with every run slot taken the answer is a 429 the client retries after, not a 400', async () => {
  await core.appSettings.update({ maxConcurrentRuns: 1 });
  try {
    const res = await post({ model: 'sonnet', messages: [user('no room')] });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '5');
    assert.equal(assertOpenAiError(await res.json(), 'rate_limit_exceeded').error.type, 'rate_limit_error');
  } finally {
    await core.appSettings.update({ maxConcurrentRuns: 64 });
  }
});

test('a client that disconnects interrupts its chat', async () => {
  const chatId = await new Promise<string>((resolve, reject) => {
    const req = httpRequest(
      `${base}/api/v1/chat/completions`,
      { method: 'POST', headers: { 'content-type': 'application/json', ...auth() } },
      (res) => {
        const id = res.headers['x-claudio-chat-id'];
        // The stream is open and the turn hangs: walk away
        res.once('data', () => {
          req.destroy();
          resolve(String(id));
        });
      },
    );
    req.on('error', (err) => {
      if (!(err as NodeJS.ErrnoException).code?.startsWith('ECONNRESET')) reject(err);
    });
    req.end(JSON.stringify({ model: 'sonnet', stream: true, messages: [user('HANG')] }));
  });
  const deadline = Date.now() + 10_000;
  let stopped: RunEvent | undefined;
  while (Date.now() < deadline && !stopped) {
    stopped = core.chats.events(chatId).find((e) => e.kind === 'result');
    if (!stopped) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(stopped, 'the hanging turn ended');
  assert.equal(stopped.outcome?.cause, 'stopped');
});

// ---------- images ----------

test('an image part becomes an attachment of the turn, and a URL to a private address is refused', async () => {
  const res = await post({ model: 'sonnet', messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }] }] });
  assert.equal(res.status, 200, await res.clone().text());
  const chatId = res.headers.get('x-claudio-chat-id') ?? '';
  await res.json();
  assert.equal(promptsOf(chatId)[0]?.images, 1);

  const local = await post({ model: 'sonnet', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `${base}/api/health` } }] }] });
  assert.equal(local.status, 400);
  assert.match(((await local.json()) as OpenAiErrorBody).error.message, /could not be fetched/);
});

// ---------- review fixes ----------

/** A PNG of about `bytes`: the signature the upload store sniffs, then padding */
function pngOf(bytes: number): string {
  const head = Buffer.from(PNG, 'base64');
  return Buffer.concat([head, Buffer.alloc(Math.max(0, bytes - head.length))]).toString('base64');
}

const imageMessage = (base64: string) => ({ role: 'user', content: [{ type: 'text', text: 'big picture' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } }] });

test('an inline image above 1 MiB reaches the chat, and one above the cap gets the size message, not a 413', async () => {
  const big = await post({ model: 'sonnet', messages: [imageMessage(pngOf(2 * 1024 * 1024))] });
  assert.equal(big.status, 200, await big.clone().text());
  const chatId = big.headers.get('x-claudio-chat-id') ?? '';
  await big.json();
  assert.equal(promptsOf(chatId)[0]?.images, 1);

  const huge = await post({ model: 'sonnet', messages: [imageMessage(pngOf(5 * 1024 * 1024 + 1024))] });
  assert.equal(huge.status, 400);
  assert.match(((await huge.json()) as OpenAiErrorBody).error.message, /bytes; the most is 5242880/);
});

test("X-Claudio-Chat-Id and a conversation key only reach chats this surface started", async () => {
  const person = await fetch(`${base}/api/chats`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'a person' }) });
  assert.equal(person.status, 201, await person.clone().text());
  const personId = ((await person.json()) as ChatSummary).id;
  core.runtime.apiUrl = `${base}/api`;
  const assistantRes = await fetch(`${base}/api/assistant/chats`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'the assistant' }) });
  assert.equal(assistantRes.status, 201, await assistantRes.clone().text());
  const assistantId = ((await assistantRes.json()) as ChatSummary).id;
  const worker = core.runtime.start({ prompt: 'a worker', purpose: 'orchestration' }, { orchestrationId: 'graph-1' });
  assert.equal(worker.origin, 'orchestration');

  for (const id of [personId, assistantId, worker.id]) {
    const res = await post({ model: 'sonnet', messages: [user('inject')] }, { 'x-claudio-chat-id': id });
    assert.equal(res.status, 404, id);
    assertOpenAiError(await res.json(), 'not_found');
    assert.ok(!promptsOf(id).some((p) => p.prompt === 'inject'), `nothing was written into ${id}`);
  }

  // A key that leads to a person's chat is a miss: a new chat starts, the person's stays untouched
  const history = [user('keyed'), assistant('echo: keyed')];
  const parsed = translateOpenAiRequest(parseOk({ model: 'sonnet', messages: [...history, user('next')] }));
  assert.ok(parsed.historyKey);
  core.openaiConversations.remember(parsed.historyKey, personId, null);
  const keyed = await post({ model: 'sonnet', messages: [...history, user('next')] });
  assert.equal(keyed.status, 200);
  assert.notEqual(keyed.headers.get('x-claudio-chat-id'), personId);
  await keyed.json();
  assert.ok(!promptsOf(personId).some((p) => p.prompt.includes('next')));
});

test('a turn on a live chat runs without host prompts and never in bypassPermissions', async () => {
  const first = await post({ model: 'sonnet', messages: [user('live')] });
  const chatId = first.headers.get('x-claudio-chat-id') ?? '';
  await first.json();
  core.runtime.setPermissionPrompts(chatId, 'host');
  await core.runtime.updateSettings(chatId, { permissionMode: 'bypassPermissions' });
  assert.notEqual(core.runtime.get(chatId)?.pid, null, 'the process is still up');
  const next = await post({ model: 'sonnet', messages: [user('live'), assistant('echo: live'), user('again')] });
  assert.equal(next.status, 200, await next.clone().text());
  assert.equal(next.headers.get('x-claudio-chat-id'), chatId);
  await next.json();
  const runtime = core.runtime.get(chatId);
  assert.equal(runtime?.permissionPrompts, 'none');
  assert.notEqual(runtime?.permissionMode, 'bypassPermissions');
});

test('a turn that shows no sign of life for the idle period fails in OpenAI\'s shape and is interrupted', async () => {
  process.env.CLAUDIO_OPENAI_TURN_IDLE_MS = '600';
  try {
    const res = await post({ model: 'sonnet', messages: [user('HANG')] }, {});
    assert.equal(res.status, 500);
    const chatId = res.headers.get('x-claudio-chat-id') ?? '';
    assert.match(assertOpenAiError(await res.json(), 'server_error').error.message, /no activity/);
    const deadline = Date.now() + 10_000;
    let ended: RunEvent | undefined;
    while (Date.now() < deadline && !ended) {
      ended = core.chats.events(chatId).find((e) => e.kind === 'result');
      if (!ended) await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(ended?.outcome?.cause, 'stopped', 'the chat was interrupted');
  } finally {
    delete process.env.CLAUDIO_OPENAI_TURN_IDLE_MS;
  }
});

test("a resumed chat answers with this turn's result, never the one an earlier execution left in the buffer", async () => {
  const first = await post({ model: 'sonnet', messages: [user('earlier')] });
  const chatId = first.headers.get('x-claudio-chat-id') ?? '';
  await first.json();
  await fetch(`${base}/api/chats/${chatId}/stop`, { method: 'POST' });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && core.runtime.get(chatId)?.pid !== null) await new Promise((r) => setTimeout(r, 50));
  assert.equal(core.runtime.get(chatId)?.pid, null);
  assert.ok(core.chats.events(chatId).some((e) => e.kind === 'result'), 'the buffer holds the earlier result');
  const next = await post({ model: 'sonnet', messages: [user('earlier'), assistant('echo: earlier'), user('later')] });
  assert.equal(next.status, 200, await next.clone().text());
  assert.equal(next.headers.get('x-claudio-chat-id'), chatId);
  assert.equal(((await next.json()) as Completion).choices[0]?.message.content, 'echo: later');
});

test('X-Claudio-Cwd on a chat that exists is named in x-claudio-ignored when it differs', async () => {
  const sub = join(root, 'workspace', 'sub');
  const first = await post({ model: 'sonnet', messages: [user('cwd first')] }, { 'x-claudio-cwd': sub });
  await first.json();
  const history = [user('cwd first'), assistant('echo: cwd first')];
  const same = await post({ model: 'sonnet', messages: [...history, user('same')] }, { 'x-claudio-cwd': sub });
  assert.equal(same.status, 200);
  assert.ok(!(same.headers.get('x-claudio-ignored') ?? '').includes('x-claudio-cwd'));
  await same.json();
  const moved = await post({ model: 'sonnet', messages: [...history, user('same'), assistant('echo: same'), user('elsewhere')] }, { 'x-claudio-cwd': join(root, 'workspace') });
  assert.equal(moved.status, 200);
  assert.equal(moved.headers.get('x-claudio-chat-id'), first.headers.get('x-claudio-chat-id'));
  assert.match(moved.headers.get('x-claudio-ignored') ?? '', /x-claudio-cwd/);
  await moved.json();
});

test("tools with tool_choice 'none' are ignored and named; the legacy functions are still refused", async () => {
  const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
  const none = await post({ model: 'sonnet', messages: [user('no tools please')], tools, tool_choice: 'none' });
  assert.equal(none.status, 200, await none.clone().text());
  assert.match(none.headers.get('x-claudio-ignored') ?? '', /\btools\b/);
  assert.equal(((await none.json()) as Completion).choices[0]?.message.content, 'echo: no tools please');
  const refused: Array<[Record<string, unknown>, string]> = [
    [{ functions: [{ name: 'lookup', parameters: { type: 'object' } }], function_call: 'none' }, 'functions'],
  ];
  for (const [extra, param] of refused) {
    const res = await post({ model: 'sonnet', messages: [user('x')], ...extra });
    assert.equal(res.status, 400, JSON.stringify(extra));
    assert.equal(assertOpenAiError(await res.json(), 'unsupported_parameter').error.param, param);
  }
});

// ---------- response_format (phase 3) ----------

const ANSWER_SCHEMA = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
const jsonSchemaFormat = (schema: Record<string, unknown>, strict = true) => ({ type: 'json_schema', json_schema: { name: 'answer', schema, strict } });

test('response_format json_schema answers whole with the structured output as JSON content, never the prose around it', async () => {
  const res = await post({ model: 'sonnet', messages: [user('structured')], response_format: jsonSchemaFormat(ANSWER_SCHEMA) });
  assert.equal(res.status, 200, await res.clone().text());
  const chatId = res.headers.get('x-claudio-chat-id') ?? '';
  const completion = (await res.json()) as Completion;
  const content = completion.choices[0]?.message.content ?? '';
  assert.deepEqual(JSON.parse(content), { answer: 'echo: structured' });
  assert.equal(completion.choices[0]?.finish_reason, 'stop');
  assert.ok(completion.usage, 'the usage is still counted');
  assert.equal(promptsOf(chatId)[0]?.schema, JSON.stringify(ANSWER_SCHEMA), 'the schema reached the CLI as --json-schema');
});

test('a streamed structured answer sends the JSON as one content chunk before the finish chunk', async () => {
  const res = await post({ model: 'sonnet', stream: true, messages: [user('streamed structure')], response_format: jsonSchemaFormat(ANSWER_SCHEMA) });
  assert.equal(res.status, 200);
  const lines = dataLines(await res.text());
  assert.equal(lines.at(-1), '[DONE]');
  const chunks = lines.slice(0, -1).map((l) => JSON.parse(l) as { choices: Array<{ delta: { role?: string; content?: string | null }; finish_reason: string | null }> });
  const pieces = chunks.flatMap((c) => c.choices.map((ch) => ch.delta.content ?? '')).filter(Boolean);
  assert.deepEqual(pieces, [JSON.stringify({ answer: 'echo: streamed structure' })], 'the prose is not streamed, and the JSON comes whole');
  assert.equal(chunks[0]?.choices[0]?.delta.role, 'assistant');
  assert.equal(chunks.at(-1)?.choices[0]?.finish_reason, 'stop');
});

test('response_format json_object holds the answer to an object schema', async () => {
  const res = await post({ model: 'sonnet', messages: [user('any object')], response_format: { type: 'json_object' } });
  assert.equal(res.status, 200, await res.clone().text());
  const chatId = res.headers.get('x-claudio-chat-id') ?? '';
  assert.deepEqual(JSON.parse(((await res.json()) as Completion).choices[0]?.message.content ?? ''), { answer: 'echo: any object' });
  assert.equal(promptsOf(chatId)[0]?.schema, JSON.stringify({ type: 'object' }));
});

test('response_format text is a plain answer with no schema', async () => {
  const res = await post({ model: 'sonnet', messages: [user('plain text')], response_format: { type: 'text' } });
  assert.equal(res.status, 200, await res.clone().text());
  const chatId = res.headers.get('x-claudio-chat-id') ?? '';
  assert.equal(((await res.json()) as Completion).choices[0]?.message.content, 'echo: plain text');
  assert.equal(promptsOf(chatId)[0]?.schema, null);
});

test('a schema change between turns of one conversation restarts its process with the new schema; the same schema keeps it', async () => {
  const other = { type: 'object', properties: { answer: { type: 'string' }, extra: { type: 'number' } }, required: ['answer'] };
  const first = await post({ model: 'sonnet', messages: [user('s1')], response_format: jsonSchemaFormat(ANSWER_SCHEMA) });
  assert.equal(first.status, 200, await first.clone().text());
  const chatId = first.headers.get('x-claudio-chat-id') ?? '';
  const a1 = ((await first.json()) as Completion).choices[0]?.message.content ?? '';
  const h1 = [user('s1'), assistant(a1)];

  const second = await post({ model: 'sonnet', messages: [...h1, user('s2')], response_format: jsonSchemaFormat(other) });
  assert.equal(second.status, 200, await second.clone().text());
  assert.equal(second.headers.get('x-claudio-chat-id'), chatId, 'the conversation key does not depend on the schema');
  const a2 = ((await second.json()) as Completion).choices[0]?.message.content ?? '';
  assert.deepEqual(JSON.parse(a2), { answer: 'echo: s2' });
  const h2 = [...h1, user('s2'), assistant(a2)];

  // The same schema with its keys in another order is the same schema: the process stays
  const reordered = { required: ['answer'], properties: { extra: { type: 'number' }, answer: { type: 'string' } }, type: 'object' };
  const third = await post({ model: 'sonnet', messages: [...h2, user('s3')], response_format: jsonSchemaFormat(reordered, false) });
  assert.equal(third.status, 200, await third.clone().text());
  const a3 = ((await third.json()) as Completion).choices[0]?.message.content ?? '';
  const h3 = [...h2, user('s3'), assistant(a3)];

  const fourth = await post({ model: 'sonnet', messages: [...h3, user('s4')] });
  assert.equal(fourth.status, 200, await fourth.clone().text());
  assert.equal(fourth.headers.get('x-claudio-chat-id'), chatId);
  assert.equal(((await fourth.json()) as Completion).choices[0]?.message.content, 'echo: s4', 'a turn with no schema after one is plain text again');

  const sent = promptsOf(chatId);
  assert.deepEqual(sent.map((p) => p.prompt), ['s1', 's2', 's3', 's4'], 'every turn after the first is a delta of the same chat');
  assert.deepEqual(sent.map((p) => p.schema), [JSON.stringify(ANSWER_SCHEMA), JSON.stringify(other), JSON.stringify(other), null]);
  assert.notEqual(sent[1]?.pid, sent[0]?.pid, 'a new schema needed a new process');
  assert.equal(sent[2]?.pid, sent[1]?.pid, 'the same schema kept the process');
  assert.notEqual(sent[3]?.pid, sent[2]?.pid, 'dropping the schema needed a new process too');
});

test('a structured turn that ends without its output is a final 422 no_structured_output, never an empty 200', async () => {
  const whole = await post({ model: 'sonnet', messages: [user('GIVE UP')], response_format: jsonSchemaFormat(ANSWER_SCHEMA) });
  assert.equal(whole.status, 422, 'not a 5xx: a client must not retry a turn that would end the same way');
  assert.match(assertOpenAiError(await whole.json(), 'no_structured_output').error.message, /response_format.*cannot match that schema/s);

  const streamed = await post({ model: 'sonnet', stream: true, messages: [user('GIVE UP')], response_format: jsonSchemaFormat(ANSWER_SCHEMA) });
  assert.equal(streamed.status, 200);
  const lines = dataLines(await streamed.text());
  assert.equal(lines.at(-1), '[DONE]');
  assertOpenAiError(JSON.parse(lines.at(-2) ?? '{}'), 'no_structured_output');
  assert.ok(!lines.some((l) => l.includes('Here is the structured answer')), 'no prose reached the client');
});

// ---------- how failures are classified ----------

test('a failure is classified by its type, never by its wording', () => {
  assert.equal(failureOf(new ChatNotFoundError()).kind, 'not-found');
  assert.equal(failureOf(new RunSlotRefusal(2)).kind, 'usage-limit');
  assert.equal(failureOf(new ChatConflictError('busy', null)).kind, 'conflict');
  // The words that used to decide no longer do
  assert.equal(failureOf(new Error('the upload was not found')).kind, 'invalid-request');
  assert.equal(failureOf(new Error('Concurrent run limit reached (2)')).kind, 'invalid-request');
  assert.equal(failureOf(new TypeError('x is not found')).kind, 'server');
  const plain = new Error('thing not found');
  failureOf(plain);
  assert.equal((plain as { statusCode?: unknown }).statusCode, undefined, 'the thrown error is not mutated');
});

test('a conversation key that fails to store still ends the stream with [DONE] and frees the chat for the next request', async () => {
  const first = await post({ model: 'sonnet', messages: [user('before the failure')] });
  assert.equal(first.status, 200, await first.clone().text());
  const chatId = first.headers.get('x-claudio-chat-id') ?? '';
  const named = { 'x-claudio-chat-id': chatId };
  const sent = (body: unknown): Promise<Response> =>
    fetch(`${base}/api/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth(), ...named }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const remember = core.openaiConversations.remember;
  core.openaiConversations.remember = () => {
    throw new Error('database is locked');
  };
  let lines: string[];
  try {
    const res = await sent({ model: 'sonnet', stream: true, messages: [user('streamed while the disk is full')] });
    assert.equal(res.status, 200);
    lines = dataLines(await res.text());
  } finally {
    core.openaiConversations.remember = remember;
  }
  assert.equal(lines.at(-1), '[DONE]');
  const text = lines.slice(0, -1).map((l) => JSON.parse(l) as { choices: Array<{ delta: { content?: string | null } }> }).flatMap((c) => c.choices.map((ch) => ch.delta.content ?? '')).join('');
  assert.equal(text, 'echo: streamed while the disk is full');
  const next = await sent({ model: 'sonnet', messages: [user('after the failure')] });
  assert.equal(next.status, 200, await next.clone().text());
  assert.equal(((await next.json()) as Completion).choices[0]?.message.content, 'echo: after the failure');
});

test('refusals of tool results and the effort a live process cannot take use the Chat Completions names', async () => {
  const calls = [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' } }];
  const stranger = await post({ model: 'sonnet', messages: [user('q'), { role: 'assistant', content: null, tool_calls: calls }, { role: 'tool', tool_call_id: 'zz', content: '?' }] });
  assert.equal(stranger.status, 400);
  const refused = assertOpenAiError(await stranger.json(), 'invalid_request_error');
  assert.equal(refused.error.param, 'messages');
  assert.match(refused.error.message, /`zz`.*a `tool` message must answer one of its `tool_calls`/);

  const first = await post({ model: 'sonnet', reasoning_effort: 'low', messages: [user('think a little')] });
  assert.equal(first.status, 200, await first.clone().text());
  const next = await post({ model: 'sonnet', reasoning_effort: 'high', messages: [user('again')] }, { 'x-claudio-chat-id': first.headers.get('x-claudio-chat-id') ?? '' });
  assert.equal(next.status, 200, await next.clone().text());
  assert.ok((next.headers.get('x-claudio-ignored') ?? '').split(', ').includes('reasoning_effort'));
});

test('a system message that changes under X-Claudio-Chat-Id restarts the idle process with it', async () => {
  const first = await post({ model: 'sonnet', messages: [{ role: 'system', content: 'Be brief.' }, user('first')] });
  assert.equal(first.status, 200, await first.clone().text());
  const chatId = first.headers.get('x-claudio-chat-id') ?? '';
  const again = await post({ model: 'sonnet', messages: [{ role: 'system', content: 'Be thorough.' }, user('second')] }, { 'x-claudio-chat-id': chatId });
  assert.equal(again.status, 200, await again.clone().text());
  const turns = promptsOf(chatId) as Array<{ prompt: string; pid: number; system?: string | null }>;
  assert.deepEqual(
    turns.map((t) => [t.prompt, t.system]),
    [
      ['first', 'Be brief.'],
      ['second', 'Be thorough.'],
    ],
  );
  assert.notEqual(turns[1]?.pid, turns[0]?.pid);
});

test('a request under X-Claudio-Chat-Id without system messages keeps the chat\'s prompt, on the live process and on a cold resume', async () => {
  const first = await post({ model: 'sonnet', messages: [{ role: 'system', content: 'Answer in French.' }, user('first')] });
  assert.equal(first.status, 200, await first.clone().text());
  const chatId = first.headers.get('x-claudio-chat-id') ?? '';
  const named = { 'x-claudio-chat-id': chatId };
  const second = await post({ model: 'sonnet', messages: [user('second')] }, named);
  assert.equal(second.status, 200, await second.clone().text());
  core.runtime.stop(chatId);
  const deadline = Date.now() + 5000;
  while (core.runtime.get(chatId)?.pid !== null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  const third = await post({ model: 'sonnet', messages: [user('third')] }, named);
  assert.equal(third.status, 200, await third.clone().text());
  const turns = promptsOf(chatId) as Array<{ prompt: string; pid: number; system?: string | null }>;
  assert.deepEqual(
    turns.map((t) => [t.prompt, t.system]),
    [
      ['first', 'Answer in French.'],
      ['second', 'Answer in French.'],
      ['third', 'Answer in French.'],
    ],
  );
  assert.equal(turns[1]?.pid, turns[0]?.pid, 'no restart for a prompt that did not change');
  assert.notEqual(turns[2]?.pid, turns[0]?.pid, 'the third turn was a cold resume');
});

// ---------- a writer that throws ----------

/** A turn fed by hand: the core it reads is only what `TurnRun` asks of a chat */
function handFedTurn<Item>(translator: OpenAiTurnTranslator<Item>, reported: unknown[]): { run: TurnRun<Item>; feed(event: Omit<RunEvent, 'seq' | 'ts'>): void } {
  let listener: (event: RunEvent) => void = () => {};
  let seq = 0;
  const fake = {
    runtime: { streamPosition: () => null, nextResult: () => new Promise(() => {}), pulse: () => null, lastTurn: () => null },
    chats: {
      subscribe: (_id: string, cb: (event: RunEvent) => void) => {
        listener = cb;
        return () => {};
      },
      events: () => [],
      interrupt: async () => {},
    },
  } as unknown as Core;
  const run = new TurnRun<Item>(fake, translator, new Map(), (err) => reported.push(err));
  run.attach('chat-hand-fed');
  return { run, feed: (event) => listener({ seq: ++seq, ts: '2026-10-27T00:00:00Z', ...event } as RunEvent) };
}

const said = (text: string) => ({ kind: 'message' as const, entry: { uuid: `u-${text}`, role: 'assistant' as const, timestamp: null, model: 'claude', isSidechain: false, parentToolUseId: null, blocks: [{ type: 'text' as const, text }] } });
const ended = { kind: 'result' as const, text: '', outcome: { isError: false, turns: 1, durationMs: 1, costUsd: 0, permissionDenials: [] } };

/** A Chat Completions chunk that carries the finish reason */
const finishes = (item: unknown): boolean => typeof item === 'object' && item !== null && 'choices' in item && (item as { choices: Array<{ finish_reason: string | null }> }).choices.some((c) => c.finish_reason !== null);
const isError = (item: unknown): boolean => typeof item === 'object' && item !== null && 'error' in item;
const responsesTranslator = (): ResponsesTranslator =>
  new ResponsesTranslator({ id: 'resp_t', model: 'sonnet', createdAt: 0, instructions: null, previousResponseId: null, store: false, metadata: {}, echo: { tools: [], toolChoice: 'auto', text: { format: { type: 'text' } }, parallelToolCalls: true, reasoningEffort: null, maxOutputTokens: null, temperature: null, topP: null, truncation: 'disabled', user: null }, structured: false });

test('a writer that throws on one item still gets every item after it, the end of the stream included', async () => {
  const reported: unknown[] = [];
  const { run, feed } = handFedTurn(new ChatCompletionTranslator({ id: 'chatcmpl-t', model: 'sonnet', created: 0, includeUsage: false, structured: false }), reported);
  const written: unknown[] = [];
  // The chunk with the finish reason goes in one batch with [DONE], right before it
  run.stream((item) => {
    if (finishes(item)) throw new Error('cannot serialise this chunk');
    written.push(item);
  });
  feed(said('one'));
  feed(ended);
  await run.done;
  assert.equal(reported.length, 2, 'the end item was tried once more');
  assert.equal(written.at(-1), STREAM_DONE, 'the stream still ends with [DONE]');
  assert.ok(!written.some(isError), 'a turn that completed never streams an error');
});

test('a [DONE] that fails once is written again, and never after an error chunk', async () => {
  const reported: unknown[] = [];
  const { run, feed } = handFedTurn(new ChatCompletionTranslator({ id: 'chatcmpl-t', model: 'sonnet', created: 0, includeUsage: false, structured: false }), reported);
  const written: unknown[] = [];
  let refused = false;
  run.stream((item) => {
    if (item === STREAM_DONE && !refused) {
      refused = true;
      throw new Error('a full socket buffer');
    }
    written.push(item);
  });
  feed(said('one'));
  feed(ended);
  await run.done;
  const finish = written.findIndex(finishes);
  assert.ok(finish >= 0);
  assert.deepEqual(written.slice(finish + 1), [STREAM_DONE], 'only [DONE] follows the finish chunk');
});

test('when the event that ends a completed turn fails once, it is written again and the stream never claims a failure', async () => {
  const reported: unknown[] = [];
  const translator = responsesTranslator();
  const { run, feed } = handFedTurn(translator, reported);
  const written: string[] = [];
  let refused = false;
  run.stream((event) => {
    if (event.type === 'response.completed' && !refused) {
      refused = true;
      throw new Error('a full socket buffer');
    }
    written.push(event.type);
  }, translator.open());
  feed(said('hello'));
  feed(ended);
  await run.done;
  assert.equal(written.at(-1), 'response.completed');
  assert.ok(!written.includes('response.failed'));
});

test('when the event that ends a completed turn can never be written, the stream ends plainly, not as a failure', async () => {
  const reported: unknown[] = [];
  const translator = responsesTranslator();
  const { run, feed } = handFedTurn(translator, reported);
  const written: string[] = [];
  run.stream((event) => {
    if (event.type === 'response.completed') throw new Error('cannot serialise the response');
    written.push(event.type);
  }, translator.open());
  feed(said('hello'));
  feed(ended);
  await run.done;
  assert.equal(reported.length, 2);
  assert.ok(!written.includes('response.failed'), 'the stored response says completed; so does the stream');
});

test('a completed turn whose end can never be written keeps the connection', async () => {
  const translator = responsesTranslator();
  const { run, feed } = handFedTurn(translator, []);
  let cut = 0;
  run.stream(
    (event) => {
      if (event.type === 'response.completed') throw new Error('cannot serialise the response');
    },
    translator.open(),
    () => cut++,
  );
  feed(said('hello'));
  feed(ended);
  await run.done;
  assert.equal(cut, 0);
});

test('a failed Chat Completions turn whose error cannot be written cuts the connection rather than end as an answer', async () => {
  const reported: unknown[] = [];
  const { run, feed } = handFedTurn(new ChatCompletionTranslator({ id: 'chatcmpl-t', model: 'sonnet', created: 0, includeUsage: false, structured: false }), reported);
  let cut = 0;
  run.stream(
    (item) => {
      if (isError(item)) throw new Error('cannot serialise the error');
    },
    [],
    () => cut++,
  );
  feed(said('one'));
  run.fail({ kind: 'server', message: 'the process died' });
  await run.done;
  assert.equal(reported.length, 2, 'the error was tried once more first');
  assert.equal(cut, 1);
});

test('a failed Responses turn whose response.failed cannot be written cuts the connection', async () => {
  const translator = responsesTranslator();
  const { run, feed } = handFedTurn(translator, []);
  let cut = 0;
  run.stream(
    (event) => {
      if (event.type === 'response.failed') throw new Error('cannot serialise the response');
    },
    translator.open(),
    () => cut++,
  );
  feed(said('hello'));
  run.fail({ kind: 'server', message: 'the process died' });
  await run.done;
  assert.equal(cut, 1);
});

test('a late subscriber of a finished turn writes its opening and earlier items once, retrying only the end', async () => {
  const reported: unknown[] = [];
  const translator = responsesTranslator();
  const { run, feed } = handFedTurn(translator, reported);
  feed(said('hello'));
  feed(ended);
  const tried: string[] = [];
  run.stream((event) => {
    tried.push(event.type);
    if (event.type === 'response.created' || event.type === 'response.completed') throw new Error('a full socket buffer');
  }, translator.open());
  await run.done;
  assert.equal(tried.filter((t) => t === 'response.created').length, 1, 'an opening event is not written twice');
  assert.equal(tried.filter((t) => t === 'response.completed').length, 2, 'the end is');
  assert.equal(reported.length, 3);
});

test('a turn that finished releases even when reporting a failed write throws', async () => {
  const translator = responsesTranslator();
  const { run, feed } = handFedTurn(translator, {
    push: () => {
      throw new Error('the logger is gone');
    },
  } as unknown as unknown[]);
  run.stream((event) => {
    if (event.type === 'response.completed') throw new Error('cannot serialise the response');
  }, translator.open());
  feed(said('hello'));
  assert.throws(() => feed(ended), /the logger is gone/);
  await run.done;
});
