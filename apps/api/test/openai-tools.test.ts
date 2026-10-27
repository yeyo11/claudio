import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@claudio/core';
import { buildApp } from '../src/app.ts';
import { ClientToolRegistry } from '../src/routes/openai-tools.ts';

// Client tools on /v1/chat/completions (docs/openai-compatible-api.md, phase 4): over a real core,
// the real routes and the stub MCP server, and a fake CLI that loads the stub from `--mcp-config`,
// asks `can_use_tool` for each call and calls the stub on allow, as the spike measured the real one.

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude-openai.mjs', import.meta.url));

let root: string;
let core: Core;
let app: FastifyInstance;
let base: string;
let token: string;
let log: string;
const registry = new ClientToolRegistry();

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'claudio-api-openai-tools-'));
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
  mkdirSync(join(root, 'workspace'), { recursive: true });
  await core.appSettings.update({ maxConcurrentRuns: 64 });
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui'), clientTools: registry });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${String(address.port)}`;
  // What `server.ts` sets once the API listens: chats get it as CLAUDIO_API_URL, the stub's URL is under it
  core.runtime.apiUrl = `${base}/api`;
  token = (await core.security.setToken({})).token;
});

after(async () => {
  core.shutdown();
  await app.close();
  delete process.env.FAKE_OPENAI_PROMPTS;
  rmSync(root, { recursive: true, force: true });
});

interface ToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}
interface Completion {
  choices: Array<{ message: { role: string; content: string | null; tool_calls?: ToolCall[] }; finish_reason: string }>;
  usage?: unknown;
}
interface ErrorBody {
  error: { message: string; type: string; param: string | null; code: string | null };
}

const post = (body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> =>
  fetch(`${base}/api/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });

const weather = { type: 'function', function: { name: 'get_weather', description: 'The weather in a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } };
const lookup = { type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { key: { type: 'string' } } } } };
const user = (content: string) => ({ role: 'user', content });
const directive = (kind: string, calls: Array<{ name: string; input?: unknown }>) => `${kind} ${JSON.stringify(calls)}`;
/** The assistant message a client sends back: the answer as it got it */
const echoed = (c: Completion) => ({ role: 'assistant', content: c.choices[0]?.message.content ?? null, tool_calls: c.choices[0]?.message.tool_calls });
const toolMsg = (id: string, content: string) => ({ role: 'tool', tool_call_id: id, content });

function dataLines(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => l.slice('data: '.length));
}

interface Logged {
  sessionId: string;
  pid: number;
  prompt?: string;
  resume?: string | null;
  prompts?: string | null;
  instruction?: string | null;
  system?: string | null;
  stub?: { url: string; alwaysLoad: boolean; type: string; strict: boolean; discover: number | null; init: number; tools: Array<Record<string, unknown>> | null; unauthorized: number };
}
function logged(chatId: string): Logged[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Logged)
    .filter((l) => l.sessionId === chatId);
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Listeners on the chat's event emitter: a waiter left behind (a lost race) shows up here */
const chatListeners = (chatId: string): number =>
  (core.runtime as unknown as { chats: Map<string, { emitter: { listenerCount(event: string): number } }> }).chats.get(chatId)?.emitter.listenerCount('event') ?? -1;

const chatOf = (res: Response): string => {
  const id = res.headers.get('x-claudio-chat-id');
  assert.ok(id);
  return id;
};

// ---------- one call, whole ----------

test('a client tool call ends the turn with tool_calls, the process waits, and the result continues the same turn', async () => {
  const messages = [user(directive('TOOLS', [{ name: 'get_weather', input: { city: 'Madrid' } }]))];
  const first = await post({ model: 'sonnet', messages, tools: [weather] });
  assert.equal(first.status, 200);
  const chatId = chatOf(first);
  const body = (await first.json()) as Completion;
  const choice = body.choices[0];
  assert.equal(choice?.finish_reason, 'tool_calls');
  assert.equal(choice?.message.content, null);
  assert.equal(choice?.message.tool_calls?.length, 1);
  const call = choice?.message.tool_calls?.[0];
  assert.ok(call?.id.startsWith('toolu_'));
  assert.deepEqual({ type: call?.type, function: call?.function }, { type: 'function', function: { name: 'get_weather', arguments: '{"city":"Madrid"}' } });
  // No usage: the CLI reports it with the turn's result, which waits on the client
  assert.equal(body.usage, undefined);

  // The CLI is holding the call: the process is up, and no person sees anything to answer
  const runtime = core.runtime.get(chatId);
  assert.ok(runtime?.pid);
  assert.equal(runtime?.permissionPrompts, 'host');
  assert.equal(runtime?.pendingPrompts, 0);
  assert.deepEqual(core.permissions.list(), []);
  const panel = await fetch(`${base}/api/chats/${chatId}/permissions`, { headers: { authorization: `Bearer ${token}` } });
  assert.deepEqual(await panel.json(), []);

  // The stub was loaded as the spike requires, and answers only the chat's own process
  await until(() => logged(chatId).some((l) => l.stub));
  const stub = logged(chatId).find((l) => l.stub)?.stub;
  assert.ok(stub);
  assert.equal(stub.type, 'http');
  assert.equal(stub.alwaysLoad, true);
  // Claudio's usual servers still load: the stub's file adds to them
  assert.equal(stub.strict, false);
  assert.equal(stub.discover, -32601);
  assert.equal(stub.init, 200);
  assert.equal(stub.unauthorized, 401);
  assert.deepEqual(stub.tools, [{ name: 'get_weather', description: 'The weather in a city', inputSchema: weather.function.parameters, annotations: { readOnlyHint: true } }]);
  assert.equal(logged(chatId).find((l) => l.prompt !== undefined)?.prompts, 'host');

  // The next request finds the chat by the history and hands the result in; no message is sent
  const second = await post({ model: 'sonnet', messages: [...messages, echoed(body), toolMsg(call?.id ?? '', '21 C and sunny')], tools: [weather] });
  assert.equal(second.status, 200);
  assert.equal(chatOf(second), chatId);
  const done = (await second.json()) as Completion;
  assert.equal(done.choices[0]?.finish_reason, 'stop');
  assert.equal(done.choices[0]?.message.content, 'results: 21 C and sunny');
  assert.ok(done.usage);
  assert.equal(logged(chatId).filter((l) => l.prompt !== undefined).length, 1);
  assert.equal(core.runtime.get(chatId)?.status, 'idle');
});

// ---------- streamed ----------

test('a streamed call: the name fragment, the arguments fragment on the same index, then finish_reason tool_calls and [DONE]', async () => {
  const messages = [user(directive('TOOLS', [{ name: 'get_weather', input: { city: 'Lima' } }]))];
  const res = await post({ model: 'sonnet', messages, tools: [weather], stream: true, stream_options: { include_usage: true } });
  assert.equal(res.status, 200);
  const lines = dataLines(await res.text());
  assert.equal(lines.at(-1), '[DONE]');
  const chunks = lines.slice(0, -1).map((l) => JSON.parse(l) as { object: string; choices: Array<{ index: number; delta: Record<string, unknown>; finish_reason: string | null }>; usage: unknown });
  for (const c of chunks) assert.equal(c.object, 'chat.completion.chunk');
  const id = (chunks[0]?.choices[0]?.delta.tool_calls as Array<{ id: string }> | undefined)?.[0]?.id;
  assert.ok(id);
  assert.deepEqual(
    chunks.map((c) => ({ delta: c.choices[0]?.delta, finish: c.choices[0]?.finish_reason, usage: c.usage })),
    [
      { delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id, type: 'function', function: { name: 'get_weather', arguments: '' } }] }, finish: null, usage: null },
      { delta: { content: null, tool_calls: [{ index: 0, function: { arguments: '{"city":"Lima"}' } }] }, finish: null, usage: null },
      { delta: {}, finish: 'tool_calls', usage: null },
    ],
  );
  // The results continue the turn as a stream too
  const history = [...messages, { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'get_weather', arguments: '{"city":"Lima"}' } }] }, toolMsg(id, 'foggy')];
  const next = await post({ model: 'sonnet', messages: history, tools: [weather], stream: true });
  const text = dataLines(await next.text())
    .slice(0, -1)
    .map((l) => (JSON.parse(l) as { choices: Array<{ delta: { content?: string } }> }).choices[0]?.delta.content ?? '')
    .join('');
  assert.equal(text, 'results: foggy');
});

// ---------- parallel, mixed text, matching ----------

test('parallel calls after text arrive together, and results answered in reverse order are matched by tool call id', async () => {
  const messages = [user(directive('TOOLS_TEXT', [{ name: 'get_weather', input: { city: 'Oslo' } }, { name: 'lookup', input: { key: 'k' } }]))];
  const first = await post({ model: 'sonnet', messages, tools: [weather, lookup] });
  const body = (await first.json()) as Completion;
  assert.equal(body.choices[0]?.finish_reason, 'tool_calls');
  assert.equal(body.choices[0]?.message.content, 'Calling the tools.');
  const calls = body.choices[0]?.message.tool_calls ?? [];
  assert.deepEqual(calls.map((c) => c.function.name), ['get_weather', 'lookup']);
  const [a, b] = calls;
  assert.ok(a && b);
  const second = await post({ model: 'sonnet', messages: [...messages, echoed(body), toolMsg(b.id, 'B-result'), toolMsg(a.id, 'A-result')], tools: [weather, lookup] });
  assert.equal(((await second.json()) as Completion).choices[0]?.message.content, 'results: A-result | B-result');
});

test('a tools/call without the tool call id gets its result first in, first out', async () => {
  const messages = [user(directive('TOOLS_NOMETA', [{ name: 'lookup', input: { key: '1' } }, { name: 'lookup', input: { key: '2' } }]))];
  const body = (await (await post({ model: 'sonnet', messages, tools: [lookup] })).json()) as Completion;
  const [a, b] = body.choices[0]?.message.tool_calls ?? [];
  assert.ok(a && b);
  const done = (await (await post({ model: 'sonnet', messages: [...messages, echoed(body), toolMsg(a.id, 'one'), toolMsg(b.id, 'two')], tools: [lookup] })).json()) as Completion;
  const content = done.choices[0]?.message.content ?? '';
  assert.doesNotMatch(content, /ERROR/);
  assert.deepEqual(content.replace('results: ', '').split(' | ').sort(), ['one', 'two']);
});

test('results for unknown calls, missing results and a user message after the results are 400s that name the problem', async () => {
  const messages = [user(directive('TOOLS', [{ name: 'get_weather', input: { city: 'a' } }, { name: 'lookup', input: {} }]))];
  const body = (await (await post({ model: 'sonnet', messages, tools: [weather, lookup] })).json()) as Completion;
  const [a, b] = body.choices[0]?.message.tool_calls ?? [];
  assert.ok(a && b);
  const unknown = await post({ model: 'sonnet', messages: [...messages, echoed(body), toolMsg(a.id, 'x'), toolMsg(b.id, 'y'), toolMsg('call_nope', 'z')], tools: [weather, lookup] });
  assert.equal(unknown.status, 400);
  assert.match(((await unknown.json()) as ErrorBody).error.message, /call_nope/);
  const missing = await post({ model: 'sonnet', messages: [...messages, echoed(body), toolMsg(a.id, 'x')], tools: [weather, lookup] });
  assert.equal(missing.status, 400);
  const said = (await missing.json()) as ErrorBody;
  assert.equal(said.error.code, 'invalid_request_error');
  assert.match(said.error.message, new RegExp(b.id));
  const userAfter = await post({ model: 'sonnet', messages: [...messages, echoed(body), toolMsg(a.id, 'x'), toolMsg(b.id, 'y'), user('and also')], tools: [weather, lookup] });
  assert.equal(userAfter.status, 400);
  // None of them let the held calls through: the right request still does
  const ok = await post({ model: 'sonnet', messages: [...messages, echoed(body), toolMsg(a.id, 'x'), toolMsg(b.id, 'y')], tools: [weather, lookup] });
  assert.equal(((await ok.json()) as Completion).choices[0]?.message.content, 'results: x | y');
});

// ---------- tool_choice ----------

test("tool_choice none ignores the tools: no stub, prompts denied, and 'tools' named in x-claudio-ignored", async () => {
  const res = await post({ model: 'sonnet', messages: [user('plain question')], tools: [weather], tool_choice: 'none' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('x-claudio-ignored') ?? '', /\btools\b/);
  assert.equal(((await res.json()) as Completion).choices[0]?.message.content, 'echo: plain question');
  const chatId = chatOf(res);
  assert.equal(logged(chatId).some((l) => l.stub), false);
  assert.equal(logged(chatId).find((l) => l.prompt !== undefined)?.prompts, 'none');
});

test('a named tool_choice hands back only that tool, denies the other with a message naming the rule, and says so in the prompt', async () => {
  const messages = [user(directive('TOOLS', [{ name: 'get_weather', input: { city: 'x' } }, { name: 'lookup', input: { key: 'k' } }]))];
  const first = await post({ model: 'sonnet', messages, tools: [weather, lookup], tool_choice: { type: 'function', function: { name: 'lookup' } } }, {}, AbortSignal.timeout(20_000));
  const body = (await first.json()) as Completion;
  const calls = body.choices[0]?.message.tool_calls ?? [];
  assert.deepEqual(calls.map((c) => c.function.name), ['lookup'], `${String(first.status)} ${JSON.stringify(body)}`);
  const chatId = chatOf(first);
  assert.match(logged(chatId).find((l) => l.prompt !== undefined)?.instruction ?? '', /mcp__client__lookup/);
  const done = (await (await post({ model: 'sonnet', messages: [...messages, echoed(body), toolMsg(calls[0]?.id ?? '', 'found')], tools: [weather, lookup], tool_choice: { type: 'function', function: { name: 'lookup' } } })).json()) as Completion;
  assert.match(done.choices[0]?.message.content ?? '', /ERROR `tool_choice` requires `lookup`.* \| found$/);
});

test('tool_choice required is an instruction in the turn\'s prompt', async () => {
  const res = await post({ model: 'sonnet', messages: [user('anything')], tools: [weather], tool_choice: 'required' });
  assert.equal(res.status, 200);
  assert.match(logged(chatOf(res)).find((l) => l.prompt !== undefined)?.instruction ?? '', /at least one of the client tools/);
});

test('parallel_tool_calls false hands back one call and denies the rest', async () => {
  const messages = [user(directive('TOOLS', [{ name: 'lookup', input: { key: '1' } }, { name: 'lookup', input: { key: '2' } }]))];
  const body = (await (await post({ model: 'sonnet', messages, tools: [lookup], parallel_tool_calls: false }, {}, AbortSignal.timeout(20_000))).json()) as Completion;
  const calls = body.choices[0]?.message.tool_calls ?? [];
  assert.equal(calls.length, 1, JSON.stringify(body));
  const done = (await (await post({ model: 'sonnet', messages: [...messages, echoed(body), toolMsg(calls[0]?.id ?? '', 'r1')], tools: [lookup], parallel_tool_calls: false }, {}, AbortSignal.timeout(20_000))).json()) as Completion;
  assert.match(done.choices[0]?.message.content ?? '', /^results: r1 \| ERROR `parallel_tool_calls` is false/, JSON.stringify(done));
});

test('a built-in tool in a client-tool chat is denied at once, as a chat nobody answers, and never reaches the panel', async () => {
  const res = await post({ model: 'sonnet', messages: [user('BASH')], tools: [weather] });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as Completion).choices[0]?.message.content, 'results: ERROR Nobody is answering permission prompts for this chat');
  assert.deepEqual(core.permissions.list(), []);
});

// The early `api` deny in `askPermission` does not take a preset's allow rules away: a preset is the
// CLI's own `--allowedTools`, which it applies without sending `can_use_tool`, and the surface never
// gives a chat a Claudio tool policy for the judge to read
test('a tool preset allows its built-in tools in an api chat with and without client tools; any other built-in is denied', async () => {
  const preset = { 'x-claudio-tool-preset': 'read-only' };
  const plain = await post({ model: 'sonnet', messages: [user('BASH git status')] }, preset);
  assert.equal(((await plain.json()) as Completion).choices[0]?.message.content, 'results: bash ran');
  const refused = await post({ model: 'sonnet', messages: [user('BASH ls')] }, preset);
  assert.equal(((await refused.json()) as Completion).choices[0]?.message.content, 'results: ERROR Nobody is answering permission prompts for this chat');

  // A client call and a preset-allowed built-in in one message: the client call is handed over, the built-in runs
  const messages = [user(directive('TOOLS', [{ name: 'get_weather', input: { city: 'Bern' } }, { name: 'Bash', input: { command: 'git status' } }]))];
  const first = await post({ model: 'sonnet', messages, tools: [weather] }, preset);
  const body = (await first.json()) as Completion;
  assert.equal(body.choices[0]?.finish_reason, 'tool_calls');
  assert.deepEqual(body.choices[0]?.message.tool_calls?.map((c) => c.function.name), ['get_weather']);
  const done = await post({ model: 'sonnet', messages: [...messages, echoed(body), toolMsg(body.choices[0]?.message.tool_calls?.[0]?.id ?? '', 'snow')], tools: [weather] }, preset);
  assert.equal(((await done.json()) as Completion).choices[0]?.message.content, 'results: snow | bash ran');

  const mixed = [user(directive('TOOLS', [{ name: 'get_weather', input: { city: 'Bern' } }, { name: 'Bash', input: { command: 'ls' } }]))];
  const other = (await (await post({ model: 'sonnet', messages: mixed, tools: [weather] }, preset)).json()) as Completion;
  const end = await post({ model: 'sonnet', messages: [...mixed, echoed(other), toolMsg(other.choices[0]?.message.tool_calls?.[0]?.id ?? '', 'rain')], tools: [weather] }, preset);
  assert.equal(((await end.json()) as Completion).choices[0]?.message.content, 'results: rain | ERROR Nobody is answering permission prompts for this chat');
  assert.deepEqual(core.permissions.list(), []);
});

// ---------- the wait, disconnects, restarts ----------

test('a call nobody resolves in time gets an error result, the chat stops, and a late result is a 400', async () => {
  process.env.CLAUDIO_OPENAI_TOOL_CALL_WAIT_MS = '300';
  try {
    const messages = [user(directive('TOOLS', [{ name: 'lookup', input: {} }]))];
    const first = await post({ model: 'sonnet', messages, tools: [lookup] });
    const chatId = chatOf(first);
    const body = (await first.json()) as Completion;
    await until(() => core.runtime.get(chatId)?.pid === null);
    assert.equal(core.runtime.get(chatId)?.status, 'stopped');
    const late = await post({ model: 'sonnet', messages: [...messages, echoed(body), toolMsg(body.choices[0]?.message.tool_calls?.[0]?.id ?? '', 'too late')], tools: [lookup] });
    assert.equal(late.status, 400);
    assert.match(((await late.json()) as ErrorBody).error.message, /openaiToolCallTimeoutMinutes/);
  } finally {
    delete process.env.CLAUDIO_OPENAI_TOOL_CALL_WAIT_MS;
  }
});

test('a client that disconnects while a call is held interrupts the chat, which withdraws it', async () => {
  const controller = new AbortController();
  const res = await post({ model: 'sonnet', messages: [user(directive('TOOLS_HANG', [{ name: 'lookup', input: {} }]))], tools: [lookup], stream: true }, {}, controller.signal);
  const chatId = chatOf(res);
  const reader = res.body?.getReader();
  assert.ok(reader);
  // Read up to the call's first fragment: the CLI is holding its request by then
  let seen = '';
  while (!seen.includes('tool_calls')) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += Buffer.from(value).toString();
  }
  controller.abort();
  await until(() => core.runtime.get(chatId)?.status === 'idle');
  const results = core.runtime.events(chatId).filter((e) => e.kind === 'result');
  assert.equal(results.at(-1)?.outcome?.isError, true);
  assert.ok(core.runtime.get(chatId)?.pid);
  assert.deepEqual(core.permissions.list(), []);
});

test('the idle watchdog does not end a turn that handed its calls over and waits for the client', async () => {
  process.env.CLAUDIO_OPENAI_TURN_IDLE_MS = '1500';
  try {
    const messages = [user(directive('TOOLS', [{ name: 'lookup', input: {} }]))];
    const first = await post({ model: 'sonnet', messages, tools: [lookup] });
    const body = (await first.json()) as Completion;
    assert.equal(body.choices[0]?.finish_reason, 'tool_calls', JSON.stringify(body));
    // Twice the idle limit, waiting for the client
    await new Promise((r) => setTimeout(r, 3000));
    assert.ok(core.runtime.get(chatOf(first))?.pid);
    const done = await post({ model: 'sonnet', messages: [...messages, echoed(body), toolMsg(body.choices[0]?.message.tool_calls?.[0]?.id ?? '', 'still here')], tools: [lookup] });
    assert.equal(done.status, 200);
    assert.equal(((await done.json()) as Completion).choices[0]?.message.content, 'results: still here');
  } finally {
    delete process.env.CLAUDIO_OPENAI_TURN_IDLE_MS;
  }
});

test('the result request does not wait behind the turn that returned the calls: both finish well within the timeout', async () => {
  const messages = [user(directive('TOOLS', [{ name: 'lookup', input: {} }]))];
  const started = Date.now();
  const body = (await (await post({ model: 'sonnet', messages, tools: [lookup] })).json()) as Completion;
  const id = body.choices[0]?.message.tool_calls?.[0]?.id ?? '';
  const done = await post({ model: 'sonnet', messages: [...messages, echoed(body), toolMsg(id, 'ok')], tools: [lookup] }, {}, AbortSignal.timeout(10_000));
  assert.equal(done.status, 200);
  assert.ok(Date.now() - started < 10_000);
});

test('a result for a chat whose process died resumes it cold with --resume, the results as a message, and x-claudio-resume: cold', async () => {
  const messages = [user(directive('TOOLS', [{ name: 'lookup', input: { key: 'k' } }]))];
  const first = await post({ model: 'sonnet', messages, tools: [lookup] });
  const chatId = chatOf(first);
  const body = (await first.json()) as Completion;
  const pid = core.runtime.get(chatId)?.pid;
  assert.ok(pid);
  process.kill(pid, 'SIGKILL');
  await until(() => core.runtime.get(chatId)?.pid === null);
  const id = body.choices[0]?.message.tool_calls?.[0]?.id ?? '';
  const res = await post({ model: 'sonnet', messages: [...messages, echoed(body), toolMsg(id, 'the value')], tools: [lookup] });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-claudio-resume'), 'cold');
  assert.equal(chatOf(res), chatId);
  const resumed = logged(chatId).filter((l) => l.prompt !== undefined).at(-1);
  assert.equal(resumed?.resume, chatId);
  assert.match(resumed?.prompt ?? '', /restarted/);
  assert.match(resumed?.prompt ?? '', new RegExp(`<tool-result id="${id}">\\nthe value\\n</tool-result>`));
  // The resumed process serves the stub again, for the next calls (the fake logs it after the turn's result)
  await until(() => logged(chatId).filter((l) => l.stub).length === 2, 10_000);
  assert.equal(core.runtime.get(chatId)?.permissionPrompts, 'host');
});

test('a refused request leaves the session\'s tool_choice, parallel_tool_calls and held calls as they were, and the first client still completes', async () => {
  const messages = [user(directive('TOOLS', [{ name: 'get_weather', input: { city: 'Oslo' } }, { name: 'lookup', input: { key: 'k' } }]))];
  const first = await post({ model: 'sonnet', messages, tools: [weather, lookup] });
  const chatId = chatOf(first);
  const body = (await first.json()) as Completion;
  const [a, b] = body.choices[0]?.message.tool_calls ?? [];
  assert.ok(a && b);
  const session = registry.ofChat(chatId);
  assert.ok(session);
  await until(() => session.heldCount() === 2);
  // The same chat by name, with other calls answered and other rules: refused once the held calls are checked
  const other = [user('x'), { role: 'assistant', content: null, tool_calls: [{ id: 'call_other', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, toolMsg('call_other', 'z')];
  const refused = await post({ model: 'sonnet', messages: other, tools: [weather, lookup], tool_choice: 'none', parallel_tool_calls: false }, { 'x-claudio-chat-id': chatId });
  assert.equal(refused.status, 400);
  assert.match(((await refused.json()) as ErrorBody).error.message, /call_other/);
  assert.deepEqual(session.choice, { kind: 'auto' });
  assert.equal(session.parallel, true);
  assert.equal(session.heldCount(), 2);
  assert.deepEqual(session.awaitingIds().sort(), [a.id, b.id].sort());
  const ok = await post({ model: 'sonnet', messages: [...messages, echoed(body), toolMsg(a.id, 'A'), toolMsg(b.id, 'B')], tools: [weather, lookup] }, {}, AbortSignal.timeout(10_000));
  assert.equal(((await ok.json()) as Completion).choices[0]?.message.content, 'results: A | B');
});

test('results for calls a dead process held go to a new process of the chat as a cold resume, never to the new process\'s permission requests', async () => {
  const messages = [user(directive('TOOLS', [{ name: 'lookup', input: { key: 'k' } }]))];
  const first = await post({ model: 'sonnet', messages, tools: [lookup] });
  const chatId = chatOf(first);
  const body = (await first.json()) as Completion;
  const pid = core.runtime.get(chatId)?.pid;
  assert.ok(pid);
  process.kill(pid, 'SIGKILL');
  await until(() => core.runtime.get(chatId)?.pid === null);
  // Another turn starts a new process, which never asked for the calls
  const hello = await post({ model: 'sonnet', messages: [user('hello again')] }, { 'x-claudio-chat-id': chatId }, AbortSignal.timeout(10_000));
  assert.equal(((await hello.json()) as Completion).choices[0]?.message.content, 'echo: hello again');
  assert.ok(core.runtime.get(chatId)?.pid);
  assert.equal(registry.ofChat(chatId)?.waiting, false);
  const id = body.choices[0]?.message.tool_calls?.[0]?.id ?? '';
  const res = await post({ model: 'sonnet', messages: [...messages, echoed(body), toolMsg(id, 'the value')], tools: [lookup] }, { 'x-claudio-chat-id': chatId }, AbortSignal.timeout(10_000));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-claudio-resume'), 'cold');
  await res.json();
  assert.match(logged(chatId).filter((l) => l.prompt !== undefined).at(-1)?.prompt ?? '', new RegExp(`<tool-result id="${id}">\\nthe value\\n</tool-result>`));
});

test('a new user message instead of the results drops the held calls and continues the chat; results for only some calls are still a 400', async () => {
  const messages = [user(directive('TOOLS', [{ name: 'lookup', input: { key: '1' } }, { name: 'lookup', input: { key: '2' } }]))];
  const first = await post({ model: 'sonnet', messages, tools: [lookup] });
  const chatId = chatOf(first);
  const body = (await first.json()) as Completion;
  const [a, b] = body.choices[0]?.message.tool_calls ?? [];
  assert.ok(a && b);
  const partial = await post({ model: 'sonnet', messages: [...messages, echoed(body), toolMsg(a.id, 'one')], tools: [lookup] });
  assert.equal(partial.status, 400);
  const said = ((await partial.json()) as ErrorBody).error.message;
  assert.match(said, new RegExp(`\`${b.id}\` have no result`));
  assert.match(said, /or none and a new `user` message to drop them/);
  // The first request's wait for its result is still on the chat; the drop adds its own
  const listening = chatListeners(chatId);
  const next = await post({ model: 'sonnet', messages: [...messages, echoed(body), user('never mind, say hi')], tools: [lookup] }, {}, AbortSignal.timeout(15_000));
  assert.equal(next.status, 200);
  assert.equal(chatOf(next), chatId);
  assert.equal(((await next.json()) as Completion).choices[0]?.message.content, 'echo: never mind, say hi');
  assert.equal(registry.ofChat(chatId)?.waiting, false);
  // The interrupt's result settled the first request's wait and the drop's: neither stays behind
  assert.equal(chatListeners(chatId), listening - 1);
  // The turn that held the calls ended interrupted, before the message was sent
  const results = core.runtime.events(chatId).filter((e) => e.kind === 'result');
  assert.equal(results.at(-2)?.outcome?.isError, true);
});

test('results sent after a person interrupted the turn holding the calls go in cold to the idle process instead of waiting on it', async () => {
  const messages = [user(directive('TOOLS', [{ name: 'lookup', input: { key: 'p' } }]))];
  const first = await post({ model: 'sonnet', messages, tools: [lookup] });
  const chatId = chatOf(first);
  const body = (await first.json()) as Completion;
  const session = registry.ofChat(chatId);
  assert.ok(session);
  await until(() => session.heldCount() === 1);
  const pid = core.runtime.get(chatId)?.pid;
  // The person stops the turn in the web: the CLI withdraws its request and ends the turn; the process stays
  await core.chats.interrupt(chatId);
  await until(() => core.runtime.get(chatId)?.status === 'idle');
  // The withdrawn call is owed by nobody
  assert.equal(session.waiting, false);
  const id = body.choices[0]?.message.tool_calls?.[0]?.id ?? '';
  const res = await post({ model: 'sonnet', messages: [...messages, echoed(body), toolMsg(id, 'the value')], tools: [lookup] }, {}, AbortSignal.timeout(10_000));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-claudio-resume'), 'cold');
  await res.json();
  assert.equal(core.runtime.get(chatId)?.pid, pid);
  assert.match(logged(chatId).filter((l) => l.prompt !== undefined).at(-1)?.prompt ?? '', new RegExp(`<tool-result id="${id}">\\nthe value\\n</tool-result>`));
});

test('a new message after a person interrupted the turn holding the calls is an ordinary turn, with no second interrupt to wait out', async () => {
  const messages = [user(directive('TOOLS', [{ name: 'lookup', input: { key: 'q' } }]))];
  const first = await post({ model: 'sonnet', messages, tools: [lookup] });
  const chatId = chatOf(first);
  const body = (await first.json()) as Completion;
  const session = registry.ofChat(chatId);
  assert.ok(session);
  await until(() => session.heldCount() === 1);
  await core.chats.interrupt(chatId);
  await until(() => core.runtime.get(chatId)?.status === 'idle');
  const ends = core.runtime.events(chatId).filter((e) => e.kind === 'result').length;
  const next = await post({ model: 'sonnet', messages: [...messages, echoed(body), user('something else')], tools: [lookup] }, {}, AbortSignal.timeout(10_000));
  assert.equal(next.status, 200);
  assert.equal(((await next.json()) as Completion).choices[0]?.message.content, 'echo: something else');
  // One result more, the new turn's: nothing was interrupted on its way
  const results = core.runtime.events(chatId).filter((e) => e.kind === 'result');
  assert.equal(results.length, ends + 1);
  assert.equal(results.at(-1)?.outcome?.isError, false);
});

test('a new message that would be refused leaves the held calls and the turn holding them as they were', async () => {
  const messages = [user(directive('TOOLS', [{ name: 'lookup', input: { key: '1' } }, { name: 'lookup', input: { key: '2' } }]))];
  const first = await post({ model: 'sonnet', messages, tools: [lookup] });
  const chatId = chatOf(first);
  const body = (await first.json()) as Completion;
  const [a, b] = body.choices[0]?.message.tool_calls ?? [];
  assert.ok(a && b);
  const session = registry.ofChat(chatId);
  assert.ok(session);
  await until(() => session.heldCount() === 2);
  const pid = core.runtime.get(chatId)?.pid;
  const ends = core.runtime.events(chatId).filter((e) => e.kind === 'result').length;
  const api = core.runtime.apiUrl;
  core.runtime.apiUrl = null;
  try {
    // Other tools: the process would have to start again with the stub, whose address is not known
    const refused = await post({ model: 'sonnet', messages: [...messages, echoed(body), user('forget those')], tools: [lookup, weather] }, {}, AbortSignal.timeout(10_000));
    assert.equal(refused.status, 503);
  } finally {
    core.runtime.apiUrl = api;
  }
  assert.equal(session.heldCount(), 2);
  assert.deepEqual(session.awaitingIds().sort(), [a.id, b.id].sort());
  assert.equal(core.runtime.get(chatId)?.pid, pid);
  assert.notEqual(core.runtime.get(chatId)?.status, 'idle');
  assert.equal(core.runtime.events(chatId).filter((e) => e.kind === 'result').length, ends);
  const ok = await post({ model: 'sonnet', messages: [...messages, echoed(body), toolMsg(a.id, 'A'), toolMsg(b.id, 'B')], tools: [lookup] }, {}, AbortSignal.timeout(10_000));
  assert.equal(((await ok.json()) as Completion).choices[0]?.message.content, 'results: A | B');
});

test('dropping calls whose turn does not end within the grace is a 409 that leaves no waiter on the chat', async () => {
  process.env.CLAUDIO_OPENAI_INTERRUPT_GRACE_MS = '300';
  let chatId = '';
  try {
    const messages = [user(directive('TOOLS_DEAF', [{ name: 'lookup', input: { key: 'd' } }]))];
    const first = await post({ model: 'sonnet', messages, tools: [lookup] });
    chatId = chatOf(first);
    const body = (await first.json()) as Completion;
    const session = registry.ofChat(chatId);
    assert.ok(session);
    await until(() => session.heldCount() === 1);
    const listening = chatListeners(chatId);
    const res = await post({ model: 'sonnet', messages: [...messages, echoed(body), user('moving on')], tools: [lookup] }, {}, AbortSignal.timeout(10_000));
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as ErrorBody).error.message, /still ending the turn/);
    assert.equal(chatListeners(chatId), listening);
  } finally {
    delete process.env.CLAUDIO_OPENAI_INTERRUPT_GRACE_MS;
    if (chatId) core.runtime.stop(chatId);
  }
});

test('each message of a turn claims only the client calls new in it, not every call so far again', async () => {
  const hello = await post({ model: 'sonnet', messages: [user('hi')], tools: [lookup] });
  const chatId = chatOf(hello);
  await hello.json();
  const session = registry.ofChat(chatId);
  assert.ok(session);
  const sizes: number[] = [];
  const claim = session.claim.bind(session);
  session.claim = (calls) => {
    sizes.push(calls.length);
    claim(calls);
  };
  const calls = [{ name: 'lookup', input: { key: '1' } }, { name: 'lookup', input: { key: '2' } }, { name: 'lookup', input: { key: '3' } }];
  const res = await post({ model: 'sonnet', messages: [user(directive('TOOLS', calls))], tools: [lookup] }, { 'x-claudio-chat-id': chatId });
  const body = (await res.json()) as Completion;
  assert.equal(body.choices[0]?.message.tool_calls?.length, 3);
  // The CLI writes one message per block: each claims its own call
  assert.deepEqual(sizes, [1, 1, 1]);
  // Claiming less changes nothing the CLI sees: every call is held
  await until(() => session.heldCount() === 3);
  const ids = body.choices[0]?.message.tool_calls?.map((c) => c.id) ?? [];
  const done = await post({ model: 'sonnet', messages: [user(directive('TOOLS', calls)), echoed(body), ...ids.map((id, i) => toolMsg(id, String(i)))], tools: [lookup] }, { 'x-claudio-chat-id': chatId }, AbortSignal.timeout(10_000));
  assert.equal(((await done.json()) as Completion).choices[0]?.message.content, 'results: 0 | 1 | 2');
});

test('a client-tool request no call handed to the client covers (a subagent\'s) is denied at once instead of held', async () => {
  const res = await post({ model: 'sonnet', messages: [user(directive('TOOLS_SIDE', [{ name: 'lookup', input: { key: 's' } }]))], tools: [lookup] }, {}, AbortSignal.timeout(8_000));
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as Completion).choices[0]?.message.content, 'results: ERROR This call was not handed to the client.');
});

test('a tool list that only changes order keeps the idle process and the stub it serves', async () => {
  const first = await post({ model: 'sonnet', messages: [user('order one')], tools: [weather, lookup] });
  const chatId = chatOf(first);
  const answered = (await first.json()) as Completion;
  const pid = core.runtime.get(chatId)?.pid;
  assert.ok(pid);
  await until(() => core.runtime.get(chatId)?.status === 'idle');
  const second = await post({ model: 'sonnet', messages: [user('order one'), echoed(answered), user('order two')], tools: [lookup, weather] }, { 'x-claudio-chat-id': chatId });
  assert.equal(((await second.json()) as Completion).choices[0]?.message.content, 'echo: order two');
  assert.equal(core.runtime.get(chatId)?.pid, pid);
});

test('a new chat whose start fails after its session was bound leaves no session behind', async () => {
  const before = registry.size;
  const create = core.chats.create.bind(core.chats);
  let started: string | null = null;
  // The chat is created and its session bound in the start callback, then the call throws
  core.chats.create = (async (...args: Parameters<typeof create>) => {
    const chat = await create(...args);
    started = chat.id;
    throw new Error('the start failed after the chat was created');
  }) as typeof create;
  try {
    const res = await post({ model: 'sonnet', messages: [user('hello with tools, failing')], tools: [weather] });
    assert.ok(res.status >= 400);
    await res.json();
  } finally {
    core.chats.create = create;
  }
  assert.ok(started);
  assert.equal(registry.ofChat(started), undefined);
  assert.deepEqual(registry.size, before);
  core.runtime.stop(started);
});

// ---------- refusals ----------

test("a chat's stub goes with the chat: once the chat is removed its URL answers 401 even to a valid token of that chat", async () => {
  const res = await post({ model: 'sonnet', messages: [user('hello with tools')], tools: [weather] });
  assert.equal(res.status, 200);
  const chatId = chatOf(res);
  await res.json();
  await until(() => logged(chatId).some((l) => l.stub));
  const url = logged(chatId).find((l) => l.stub)?.stub?.url ?? '';
  // A token of the chat's own, as its process holds, outlives the removal here on purpose: only the stub's teardown refuses it
  const own = core.security.chatTokens.mint(chatId);
  const list = (): Promise<Response> =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${own}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal((await list()).status, 200);
  // The chat's own --mcp-config, found by its name, goes with it too
  const files = (): string[] => readdirSync(join(root, 'data', 'mcp')).filter((f) => f.startsWith(`extra-${chatId}-`));
  assert.equal(files().length, 1);
  core.runtime.stop(chatId);
  await until(() => core.runtime.get(chatId)?.pid === null || core.runtime.get(chatId)?.pid === undefined);
  await until(() => core.runtime.remove(chatId), 5000);
  assert.equal((await list()).status, 401);
  assert.deepEqual(files(), []);
  core.security.chatTokens.revoke(own);
});

test('tool names that collide with a built-in, are too long or repeat, and the legacy functions, are refused', async () => {
  const named = (name: string) => ({ type: 'function', function: { name, parameters: { type: 'object' } } });
  const builtin = await post({ model: 'sonnet', messages: [user('x')], tools: [named('Bash')] });
  assert.equal(builtin.status, 400);
  assert.equal(((await builtin.json()) as ErrorBody).error.code, 'invalid_request_error');
  const long = await post({ model: 'sonnet', messages: [user('x')], tools: [named('a'.repeat(60))] });
  assert.equal(long.status, 400);
  assert.match(((await long.json()) as ErrorBody).error.message, /mcp__client__/);
  const twice = await post({ model: 'sonnet', messages: [user('x')], tools: [named('f'), named('f')] });
  assert.equal(twice.status, 400);
  const legacy = await post({ model: 'sonnet', messages: [user('x')], functions: [{ name: 'f', parameters: { type: 'object' } }] });
  assert.equal(legacy.status, 400);
  const said = (await legacy.json()) as ErrorBody;
  assert.equal(said.error.code, 'unsupported_parameter');
  assert.equal(said.error.param, 'functions');
});

test('client tools together with response_format are refused as not supported yet', async () => {
  const res = await post({ model: 'sonnet', messages: [user('x')], tools: [weather], response_format: { type: 'json_object' } });
  assert.equal(res.status, 400);
  const said = (await res.json()) as ErrorBody;
  assert.equal(said.error.code, 'unsupported_parameter');
  assert.equal(said.error.param, 'response_format');
  assert.match(said.error.message, /not supported yet/);
});

// ---------- the setting ----------

test('the tool-call timeout setting round-trips through /settings/app and resets with null', async () => {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const read = async () => (await (await fetch(`${base}/api/settings/app`, { headers })).json()) as { openaiToolCallTimeoutMinutes: number; sources: Record<string, string> };
  assert.equal((await read()).openaiToolCallTimeoutMinutes, 10);
  const set = await fetch(`${base}/api/settings/app`, { method: 'PUT', headers, body: JSON.stringify({ openaiToolCallTimeoutMinutes: 25 }) });
  assert.equal(set.status, 200);
  assert.equal((await read()).openaiToolCallTimeoutMinutes, 25);
  assert.equal((await read()).sources.openaiToolCallTimeoutMinutes, 'file');
  const bad = await fetch(`${base}/api/settings/app`, { method: 'PUT', headers, body: JSON.stringify({ openaiToolCallTimeoutMinutes: 0 }) });
  assert.equal(bad.status, 400);
  await fetch(`${base}/api/settings/app`, { method: 'PUT', headers, body: JSON.stringify({ openaiToolCallTimeoutMinutes: null }) });
  const after = await read();
  assert.equal(after.openaiToolCallTimeoutMinutes, 10);
  assert.equal(after.sources.openaiToolCallTimeoutMinutes, 'default');
});

// ---------- the system prompt with client tools ----------

const system = (content: string) => ({ role: 'system', content });

test('results sent under X-Claudio-Chat-Id without the system message name nothing ignored, and the next turn keeps the chat\'s prompt', async () => {
  const messages = [system('Answer in French.'), user(directive('TOOLS', [{ name: 'lookup', input: { key: 's' } }]))];
  const first = await post({ model: 'sonnet', messages, tools: [lookup] });
  assert.equal(first.status, 200, await first.clone().text());
  const chatId = chatOf(first);
  const body = (await first.json()) as Completion;
  const call = body.choices[0]?.message.tool_calls?.[0];
  assert.ok(call);
  const named = { 'x-claudio-chat-id': chatId };
  const second = await post({ model: 'sonnet', messages: [user('q'), echoed(body), toolMsg(call.id, 'value')], tools: [lookup] }, named);
  assert.equal(second.status, 200, await second.clone().text());
  assert.equal(second.headers.get('x-claudio-ignored'), null);
  const third = await post({ model: 'sonnet', messages: [user('and now?')], tools: [lookup] }, named);
  assert.equal(third.status, 200, await third.clone().text());
  const turns = logged(chatId).filter((l) => l.prompt !== undefined);
  assert.equal(turns.at(-1)?.system, 'Answer in French.');
  assert.equal(turns.at(-1)?.pid, turns[0]?.pid, 'the same prompt keeps the process');
});

test('a new system message on an idle chat with client tools while the API address is unknown keeps the live process and is named, never a 503', async () => {
  const first = await post({ model: 'sonnet', messages: [system('Be brief.'), user('one')], tools: [lookup] });
  assert.equal(first.status, 200, await first.clone().text());
  const chatId = chatOf(first);
  const pid = core.runtime.get(chatId)?.pid;
  const named = { 'x-claudio-chat-id': chatId };
  const api = core.runtime.apiUrl;
  core.runtime.apiUrl = null;
  let second: Response;
  try {
    second = await post({ model: 'sonnet', messages: [system('Be thorough.'), user('two')], tools: [lookup] }, named, AbortSignal.timeout(10_000));
  } finally {
    core.runtime.apiUrl = api;
  }
  assert.equal(second.status, 200, await second.clone().text());
  assert.deepEqual((second.headers.get('x-claudio-ignored') ?? '').split(', '), ['messages'], 'named by the field Chat Completions has');
  const turns = logged(chatId).filter((l) => l.prompt !== undefined);
  assert.equal(turns.at(-1)?.system, 'Be brief.');
  assert.equal(turns.at(-1)?.pid, pid);
  // Once the address is known, a named request without system messages runs the one the client sent last
  const third = await post({ model: 'sonnet', messages: [user('three')], tools: [lookup] }, named);
  assert.equal(third.status, 200, await third.clone().text());
  assert.equal(logged(chatId).filter((l) => l.prompt !== undefined).at(-1)?.system, 'Be thorough.');
});
