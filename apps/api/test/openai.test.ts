import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@claudio/core';
import type { ChatSummary, RunEvent } from '@claudio/shared';
import { buildApp } from '../src/app.ts';

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
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; prompt_tokens_details: { cached_tokens: number } };
}

const auth = (): Record<string, string> => ({ authorization: `Bearer ${token}` });

async function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/api/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth(), ...headers }, body: JSON.stringify(body) });
}

const user = (text: string) => ({ role: 'user', content: text });
const assistant = (text: string) => ({ role: 'assistant', content: text });

function assertOpenAiError(body: unknown, code: string): OpenAiErrorBody {
  const shaped = body as OpenAiErrorBody;
  assert.equal(typeof shaped.error, 'object', JSON.stringify(body));
  assert.equal(typeof shaped.error.message, 'string');
  assert.ok(['invalid_request_error', 'rate_limit_error', 'server_error'].includes(shaped.error.type), shaped.error.type);
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

function promptsOf(chatId: string): Array<{ prompt: string; images: number; pid: number }> {
  if (!existsSync(prompts)) return [];
  return readFileSync(prompts, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { sessionId: string; prompt: string; images: number; pid: number })
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
  assert.deepEqual(completion.usage, { prompt_tokens: 130, completion_tokens: 5, total_tokens: 135, prompt_tokens_details: { cached_tokens: 100 } });
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
  assert.deepEqual(completion.usage, { prompt_tokens: 130, completion_tokens: 5, total_tokens: 135, prompt_tokens_details: { cached_tokens: 100 } });
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
  assert.deepEqual(usage?.usage, { prompt_tokens: 130, completion_tokens: 5, total_tokens: 135, prompt_tokens_details: { cached_tokens: 100 } });
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
    [{ model: 'sonnet', messages: [user('x')], tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }] }, 'unsupported_parameter', 'tools'],
    [{ model: 'sonnet', messages: [user('x')], functions: [{ name: 'f', parameters: { type: 'object' } }] }, 'unsupported_parameter', 'functions'],
    [{ model: 'sonnet', messages: [user('x'), assistant('y')] }, 'invalid_request_error', 'messages'],
    [{ model: 'sonnet' }, 'invalid_request_error', 'messages'],
    [{ model: 'sonnet', messages: [user('x')], response_format: { type: 'json_object' } }, 'unsupported_parameter', 'response_format'],
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
  assert.match(((await tools.json()) as OpenAiErrorBody).error.message, /later version/);
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
