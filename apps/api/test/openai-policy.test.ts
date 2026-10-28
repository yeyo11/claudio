import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@claudio/core';
import type { ApiChatPolicy, ToolPreset, Workspace } from '@claudio/shared';
import { buildApp } from '../src/app.ts';
import { requestPolicyOf } from '../src/routes/openai.ts';
import { standInGuard } from './fixtures/declared-guard.ts';

// `/v1` parity and typed run errors (docs/plans/headless-image.md, D8 and D16): every `/v1` chat is
// a confined API chat whose policy comes from the X-Claudio-* headers, is part of the conversation
// key and is fixed for the chat; a turn that ends without its answer is a final 422 that says why.

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude-openai.mjs', import.meta.url));

let root: string;
let core: Core;
let app: FastifyInstance;
let base: string;
let token: string;
let prompts: string;
let armed: Array<{ cwd: string; tools: string[] }>;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'claudio-api-openai-policy-'));
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
  armed = standInGuard(core, join(root, 'guard'));
  await core.appSettings.update({ maxConcurrentRuns: 64 });
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${String(address.port)}`;
  token = (await core.security.setToken({})).token;
});

after(async () => {
  core.runtime.stopAll();
  for (const entry of existsSync(core.workspaces.root) ? readdirSync(core.workspaces.root) : []) await core.workspaces.remove(entry);
  await app.close();
  await core.shutdown();
  delete process.env.FAKE_OPENAI_PROMPTS;
  // Workspace folders are written read-only
  const unseal = (path: string): void => {
    if (!existsSync(path) || !statSync(path).isDirectory()) return;
    chmodSync(path, 0o755);
    for (const name of readdirSync(path)) unseal(join(path, name));
  };
  unseal(root);
  rmSync(root, { recursive: true, force: true });
});

interface ErrorBody {
  error: { message: string; type: string; param: string | null; code: string | null };
}

const auth = (): Record<string, string> => ({ authorization: `Bearer ${token}` });
const user = (text: string) => ({ role: 'user', content: text });
const assistant = (text: string) => ({ role: 'assistant', content: text });

function completions(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/api/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth(), ...headers }, body: JSON.stringify(body) });
}

function responses(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/api/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth(), ...headers }, body: JSON.stringify(body) });
}

const chatOf = (res: Response): string => res.headers.get('x-claudio-chat-id') ?? '';

function assertError(body: unknown, type: string, code: string): ErrorBody {
  const shaped = body as ErrorBody;
  assert.equal(typeof shaped.error, 'object', JSON.stringify(body));
  assert.equal(shaped.error.type, type, JSON.stringify(body));
  assert.equal(shaped.error.code, code, JSON.stringify(body));
  return shaped;
}

function dataLines(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length));
}

function promptsOf(chatId: string): Array<{ prompt: string; pid: number }> {
  if (!existsSync(prompts)) return [];
  return readFileSync(prompts, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { sessionId: string; prompt?: string; pid: number })
    .filter((p): p is { sessionId: string; prompt: string; pid: number } => p.sessionId === chatId && typeof p.prompt === 'string');
}

const ANSWER_SCHEMA = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
const schemaFormat = { type: 'json_schema', json_schema: { name: 'answer', schema: ANSWER_SCHEMA } };

// A tar.gz built by hand, as the workspace tests do: one top-level folder holding one file
function entry(name: string, body: string, type = '0'): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 'latin1');
  h.write(`${Buffer.byteLength(body).toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  h.write('        ', 148, 'latin1');
  h.write(type, 156, 'latin1');
  h.write('ustar\0', 257, 'latin1');
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  const data = Buffer.from(body);
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

async function workspace(): Promise<Workspace> {
  const archive = gzipSync(Buffer.concat([entry('repo/', '', '5'), entry('repo/README.md', '# repo'), Buffer.alloc(1024)]));
  const res = await fetch(`${base}/api/workspaces`, { method: 'POST', headers: { 'content-type': 'application/gzip', ...auth() }, body: archive });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as Workspace;
}

// ---------- the headers ----------

test('the four headers become the chat policy on both endpoints, and the guard is armed with the declared rules', async () => {
  const ws = await workspace();
  const headers = {
    'x-claudio-workspace': ws.id,
    'x-claudio-max-turns': '7',
    'x-claudio-max-budget-usd': '0.25',
    'x-claudio-allowed-tools': JSON.stringify(['Read', 'Grep', 'Bash(ls *)']),
  };
  const expected: ApiChatPolicy = { workspaceId: ws.id, allowedTools: ['Read', 'Grep', 'Bash(ls *)'], maxTurns: 7, maxBudgetUsd: 0.25, schema: false };
  for (const send of [() => completions({ model: 'sonnet', messages: [user('policy one')] }, headers), () => responses({ model: 'sonnet', input: 'policy two' }, headers)]) {
    const res = await send();
    assert.equal(res.status, 200, await res.clone().text());
    await res.json();
    const runtime = core.runtime.get(chatOf(res));
    assert.deepEqual(runtime?.policy, expected);
    assert.equal(runtime?.permissionMode, 'dontAsk');
    assert.equal(runtime?.cwd, join(core.workspaces.root, ws.id, 'repo'), 'the single top-level folder is the working directory');
    assert.deepEqual(armed.at(-1), { cwd: runtime?.cwd, tools: ['Read', 'Grep', 'Bash(ls *)'] });
  }
});

test('without headers a chat declares no tools in headless and the default preset in the full profile, with the configured budget', async () => {
  const preset: ToolPreset = { id: 'reads', name: 'Reads', description: '', allowedTools: ['Read', 'Glob'], disallowedTools: [] };
  const presets = { get: (id: string) => (id === preset.id ? preset : undefined), defaultPreset: () => preset };
  const read = (): undefined => undefined;
  const config = { ...core.config, chatBudgetUsd: 1.5 };
  const headless = requestPolicyOf({ config, profile: 'headless', toolPresets: presets as unknown as Core['toolPresets'] }, read, { cwd: undefined, schema: true });
  assert.deepEqual(headless, { workspaceId: null, allowedTools: [], maxTurns: null, maxBudgetUsd: 1.5, schema: true });
  const full = requestPolicyOf({ config, profile: 'full', toolPresets: presets as unknown as Core['toolPresets'] }, read, { cwd: undefined, schema: false });
  assert.deepEqual(full.allowedTools, ['Read', 'Glob']);
  // A preset named by the header is read in either profile
  const named = requestPolicyOf({ config, profile: 'headless', toolPresets: presets as unknown as Core['toolPresets'] }, (name) => (name === 'x-claudio-tool-preset' ? 'reads' : undefined), { cwd: undefined, schema: false });
  assert.deepEqual(named.allowedTools, ['Read', 'Glob']);
});

test('an invalid header value is a 400 invalid_request_error naming the header, on both endpoints', async () => {
  const cases: Array<[Record<string, string>, RegExp]> = [
    [{ 'x-claudio-max-turns': '0' }, /X-Claudio-Max-Turns/],
    [{ 'x-claudio-max-turns': 'many' }, /X-Claudio-Max-Turns/],
    [{ 'x-claudio-max-budget-usd': '-1' }, /X-Claudio-Max-Budget-Usd/],
    [{ 'x-claudio-max-budget-usd': 'NaN' }, /X-Claudio-Max-Budget-Usd/],
    [{ 'x-claudio-allowed-tools': 'Read' }, /X-Claudio-Allowed-Tools/],
    [{ 'x-claudio-allowed-tools': '[1]' }, /X-Claudio-Allowed-Tools/],
    [{ 'x-claudio-allowed-tools': '["Bash"]' }, /X-Claudio-Allowed-Tools.*every command/],
    [{ 'x-claudio-allowed-tools': '["Read"]', 'x-claudio-tool-preset': 'read-only' }, /X-Claudio-Allowed-Tools and X-Claudio-Tool-Preset/],
    [{ 'x-claudio-workspace': '../etc' }, /X-Claudio-Workspace/],
    [{ 'x-claudio-workspace': 'ws_abc', 'x-claudio-cwd': join(root, 'workspace') }, /X-Claudio-Workspace and X-Claudio-Cwd/],
  ];
  for (const [headers, message] of cases) {
    for (const res of [await completions({ model: 'sonnet', messages: [user('bad')] }, headers), await responses({ model: 'sonnet', input: 'bad' }, headers)]) {
      assert.equal(res.status, 400, JSON.stringify(headers));
      assert.match(assertError(await res.json(), 'invalid_request_error', 'invalid_request_error').error.message, message);
    }
  }
});

test('a write tool in a workspace is refused before anything starts', async () => {
  const ws = await workspace();
  const res = await completions({ model: 'sonnet', messages: [user('write')] }, { 'x-claudio-workspace': ws.id, 'x-claudio-allowed-tools': '["Edit"]' });
  assert.equal(res.status, 400);
  assert.match(assertError(await res.json(), 'invalid_request_error', 'invalid_request_error').error.message, /read only/);
});

// ---------- the conversation key ----------

test('the policy is in the conversation key: the same history with other headers is another chat, the same ones the same chat', async () => {
  const tools = { 'x-claudio-allowed-tools': '["Read"]' };
  const first = await completions({ model: 'sonnet', messages: [user('keyed policy')] }, tools);
  const answer = ((await first.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content ?? '';
  const history = [user('keyed policy'), assistant(answer), user('next')];
  const same = await completions({ model: 'sonnet', messages: history }, tools);
  await same.json();
  assert.equal(chatOf(same), chatOf(first));
  const others: Array<Record<string, string>> = [{ 'x-claudio-allowed-tools': '["Grep"]' }, { ...tools, 'x-claudio-max-turns': '3' }, { ...tools, 'x-claudio-max-budget-usd': '0.1' }, {}];
  for (const other of others) {
    const res = await completions({ model: 'sonnet', messages: history }, other);
    assert.equal(res.status, 200, JSON.stringify(other));
    await res.json();
    assert.notEqual(chatOf(res), chatOf(first), JSON.stringify(other));
  }
  assert.deepEqual(promptsOf(chatOf(first)).map((p) => p.prompt), ['keyed policy', 'next']);
});

test('a one-shot request (no assistant message) starts a new chat every time, a retry included', async () => {
  const body = { model: 'sonnet', messages: [{ role: 'system', content: 'Summarise.' }, user('the same one-shot')] };
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await completions(body, { 'x-claudio-max-budget-usd': '0.2' });
    assert.equal(res.status, 200);
    await res.json();
    ids.push(chatOf(res));
  }
  const retried = await responses({ model: 'sonnet', instructions: 'Summarise.', input: 'the same one-shot' });
  await retried.json();
  ids.push(chatOf(retried));
  assert.equal(new Set(ids).size, ids.length, 'no retry lands in an earlier chat');
});

test('a continuation naming a chat with another policy is a 409 policy_mismatch, under X-Claudio-Chat-Id and previous_response_id', async () => {
  const tools = { 'x-claudio-allowed-tools': '["Read"]' };
  const first = await completions({ model: 'sonnet', messages: [user('named')] }, tools);
  await first.json();
  const chatId = chatOf(first);
  const mismatch = await completions({ model: 'sonnet', messages: [user('more')] }, { 'x-claudio-chat-id': chatId, 'x-claudio-allowed-tools': '["Read","Grep"]' });
  assert.equal(mismatch.status, 409);
  assert.match(assertError(await mismatch.json(), 'invalid_request_error', 'policy_mismatch').error.message, new RegExp(chatId));
  const matching = await completions({ model: 'sonnet', messages: [user('more')] }, { 'x-claudio-chat-id': chatId, ...tools });
  assert.equal(matching.status, 200);
  await matching.json();

  const one = await responses({ model: 'sonnet', input: 'chained' }, { 'x-claudio-max-turns': '4' });
  const stored = (await one.json()) as { id: string };
  const chained = await responses({ model: 'sonnet', previous_response_id: stored.id, input: 'again' }, { 'x-claudio-max-turns': '5' });
  assert.equal(chained.status, 409);
  assertError(await chained.json(), 'invalid_request_error', 'policy_mismatch');
  const kept = await responses({ model: 'sonnet', previous_response_id: stored.id, input: 'again' }, { 'x-claudio-max-turns': '4' });
  assert.equal(kept.status, 200, await kept.clone().text());
  assert.equal(chatOf(kept), chatOf(one));
});

// ---------- refusals of a start, in OpenAI's shape ----------

test('an unknown workspace is 404 workspace_not_found, an expired one 410 workspace_expired, a vanished cwd 400 cwd_missing', async () => {
  const unknown = await completions({ model: 'sonnet', messages: [user('nowhere')] }, { 'x-claudio-workspace': 'ws_AAAAAAAAAAAAAAAA' });
  assert.equal(unknown.status, 404);
  assertError(await unknown.json(), 'invalid_request_error', 'workspace_not_found');

  const ws = await workspace();
  const inWs = { 'x-claudio-workspace': ws.id };
  const started = await responses({ model: 'sonnet', input: 'in the workspace' }, inWs);
  await started.json();
  const wsChat = chatOf(started);
  assert.equal((await fetch(`${base}/api/workspaces/${ws.id}`, { method: 'DELETE', headers: auth() })).status, 204);
  await core.runtime.exited(wsChat);
  // A cold resume of a chat whose workspace is gone (D9): the folder is never made again
  const expired = await completions({ model: 'sonnet', messages: [user('again')] }, { ...inWs, 'x-claudio-chat-id': wsChat });
  assert.equal(expired.status, 410);
  assertError(await expired.json(), 'invalid_request_error', 'workspace_expired');
  const fresh = await responses({ model: 'sonnet', input: 'a new one' }, inWs);
  assert.equal(fresh.status, 410);
  assertError(await fresh.json(), 'invalid_request_error', 'workspace_expired');

  const dir = join(root, 'workspace', 'vanishing');
  mkdirSync(dir, { recursive: true });
  const inDir = await completions({ model: 'sonnet', messages: [user('in a folder')] }, { 'x-claudio-cwd': dir });
  await inDir.json();
  const dirChat = chatOf(inDir);
  core.runtime.stop(dirChat);
  await core.runtime.exited(dirChat);
  rmSync(dir, { recursive: true, force: true });
  const missing = await completions({ model: 'sonnet', messages: [user('again')] }, { 'x-claudio-chat-id': dirChat });
  assert.equal(missing.status, 400);
  assertError(await missing.json(), 'invalid_request_error', 'cwd_missing');
});

// ---------- typed run errors ----------

/** Each D16 code, whole and streamed, on Chat Completions and on Responses */
async function assertRunError(directive: string, code: string, opts: { schema?: boolean; headers?: Record<string, string>; message?: RegExp } = {}): Promise<void> {
  const format = opts.schema ? { response_format: schemaFormat } : {};
  const text = opts.schema ? { text: { format: { type: 'json_schema', name: 'answer', schema: ANSWER_SCHEMA } } } : {};
  const headers = opts.headers ?? {};

  const whole = await completions({ model: 'sonnet', messages: [user(directive)], ...format }, headers);
  assert.equal(whole.status, 422, `${directive}: final, never a 5xx a client retries`);
  const body = assertError(await whole.json(), 'run_error', code);
  if (opts.message) assert.match(body.error.message, opts.message);

  const streamed = await completions({ model: 'sonnet', stream: true, messages: [user(directive)], ...format }, headers);
  const lines = dataLines(await streamed.text());
  assert.equal(lines.at(-1), '[DONE]');
  assertError(JSON.parse(lines.at(-2) ?? '{}'), 'run_error', code);

  const response = await responses({ model: 'sonnet', input: directive, ...text }, headers);
  assert.equal(response.status, 422);
  assertError(await response.json(), 'run_error', code);

  const events = dataLines(await (await responses({ model: 'sonnet', stream: true, input: directive, ...text }, headers)).text()).map(
    (l) => JSON.parse(l) as { type: string; response?: { error?: { code: string; message: string } } },
  );
  const failed = events.at(-1);
  assert.equal(failed?.type, 'response.failed');
  assert.equal(failed?.response?.error?.code, code);
  if (opts.message) assert.match(failed?.response?.error?.message ?? '', opts.message);
}

test('a turn the guard blocked and that ended with no answer is 422 tool_blocked naming the command and the missing rule', async () => {
  const blocked = /guard blocked a Bash call: `cat \/data\/auth\.json` matches no declared Bash rule/;
  await assertRunError('BLOCKED cat /data/auth.json', 'tool_blocked', { headers: { 'x-claudio-allowed-tools': '["Bash(ls *)"]' }, message: blocked });
  // Under a schema, a blocked call before a give-up is what the client fixes, not the schema
  await assertRunError('BLOCKED cat /data/auth.json', 'tool_blocked', { schema: true, message: blocked });
});

test('the turn ceilings and a model that gives up on the schema are 422 max_turns, max_budget and no_structured_output', async () => {
  await assertRunError('TURNS', 'max_turns', { headers: { 'x-claudio-max-turns': '2' } });
  await assertRunError('BUDGET', 'max_budget', { schema: true, headers: { 'x-claudio-max-budget-usd': '0.05' } });
  await assertRunError('GIVE UP', 'no_structured_output', { schema: true });
});
