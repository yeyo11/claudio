import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig, RunSlotRefusal } from '@claudio/core';
import { buildApp } from '../src/app.ts';
import { ClientToolRegistry } from '../src/routes/openai-tools.ts';

// Run slots against idle API chats (docs/openai-compatible-api.md, "Real-client tests"): every OpenAI
// conversation is a chat whose process stays up between turns, so a start that finds every slot
// taken ends the least recently used idle API process instead of refusing, and only that one.

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude-openai.mjs', import.meta.url));

let root: string;
let core: Core;
let app: FastifyInstance;
let base: string;
let token: string;
let log: string;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'claudio-api-openai-slots-'));
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
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui'), clientTools: new ClientToolRegistry() });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${String(address.port)}`;
  // The stub of the client tools is reached under it, as `server.ts` sets it once the API listens
  core.runtime.apiUrl = `${base}/api`;
  token = (await core.security.setToken({})).token;
});

afterEach(async () => {
  core.runtime.stopAll();
  await until(() => core.runtime.activeCount() === 0, 'every process to end');
  await core.appSettings.update({ maxConcurrentRuns: 64 });
});

after(async () => {
  core.shutdown();
  await app.close();
  delete process.env.FAKE_OPENAI_PROMPTS;
  rmSync(root, { recursive: true, force: true });
});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await pause(20);
  }
}

const user = (content: string) => ({ role: 'user', content });
const assistant = (content: string) => ({ role: 'assistant', content });
const weather = { type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } };

const post = (body: unknown): Promise<Response> =>
  fetch(`${base}/api/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

const personStart = (prompt: string): Promise<Response> =>
  fetch(`${base}/api/chats`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }) });

const chatOf = (res: Response): string => {
  const id = res.headers.get('x-claudio-chat-id');
  assert.ok(id, 'the answer names its chat');
  return id;
};

const live = (chatId: string): boolean => core.runtime.livePids().some((p) => p.chatId === chatId);
const idle = (chatId: string) => until(() => core.runtime.get(chatId)?.status === 'idle', `${chatId} to idle`);

/** A finished /v1 conversation whose process stays up, idle */
async function idleApiChat(text: string, system?: string): Promise<string> {
  const res = await post({ model: 'sonnet', messages: [...(system ? [{ role: 'system', content: system }] : []), user(text)] });
  assert.equal(res.status, 200, await res.clone().text());
  await res.json();
  const id = chatOf(res);
  await idle(id);
  return id;
}

interface Logged {
  sessionId: string;
  pid: number;
  prompt: string;
  resume: string | null;
  system: string | null;
}
function logged(chatId: string): Logged[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Logged)
    .filter((l) => l.sessionId === chatId);
}

test('a new /v1 conversation with every slot held by idle API chats is served, and the least recently used one gives its process up', async () => {
  await core.appSettings.update({ maxConcurrentRuns: 2 });
  const older = await idleApiChat('first');
  await pause(30);
  const newer = await idleApiChat('second');

  const res = await post({ model: 'sonnet', messages: [user('third')] });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(((await res.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content, 'echo: third');
  await until(() => !live(older), 'the older idle chat to exit');
  assert.ok(live(newer), 'the more recently used one keeps its process');
  assert.ok(live(chatOf(res)));
  assert.ok(core.runtime.activeCount() <= 2);
});

test('an evicted API chat resumes cold on its next turn with its system prompt, its conversation and its chat', async () => {
  await core.appSettings.update({ maxConcurrentRuns: 1 });
  const system = 'Answer like a pirate.';
  const evicted = await idleApiChat('alpha', system);
  const firstPid = logged(evicted)[0]?.pid;

  const other = await post({ model: 'sonnet', messages: [user('taking the slot')] });
  assert.equal(other.status, 200, await other.clone().text());
  await other.json();
  await until(() => !live(evicted), 'the evicted chat to exit');
  await idle(chatOf(other));

  // The client goes on with the whole history, as it always does: the conversation key finds the same chat
  const next = await post({ model: 'sonnet', messages: [{ role: 'system', content: system }, user('alpha'), assistant('echo: alpha'), user('beta')] });
  assert.equal(next.status, 200, await next.clone().text());
  assert.equal(chatOf(next), evicted);
  assert.equal(((await next.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content, 'echo: beta');
  const turns = logged(evicted);
  const last = turns.at(-1);
  assert.equal(turns.length, 2);
  assert.equal(last?.resume, evicted, 'resumed with --resume, cold');
  assert.notEqual(last?.pid, firstPid, 'in a process of its own');
  assert.match(last?.system ?? '', /Answer like a pirate\./);
  assert.match(last?.prompt ?? '', /beta/);
  assert.doesNotMatch(last?.prompt ?? '', /alpha/, 'the session holds the history; only the new message is sent');
});

test('a person\'s chat start takes the slot of an idle API chat', async () => {
  await core.appSettings.update({ maxConcurrentRuns: 1 });
  const apiChat = await idleApiChat('hello');
  const res = await personStart('A chat of my own');
  assert.equal(res.status, 201, await res.clone().text());
  await until(() => !live(apiChat), 'the API chat to exit');
});

test('a busy API chat, one holding client tool calls and a person\'s idle chat are never evicted, and the refusal stays as it was', async () => {
  await core.appSettings.update({ maxConcurrentRuns: 3 });
  const busyRes = post({ model: 'sonnet', messages: [user('SLOW 3000')] });
  const holding = await post({ model: 'sonnet', tools: [weather], messages: [user(`TOOLS ${JSON.stringify([{ name: 'get_weather', input: { city: 'Madrid' } }])}`)] });
  assert.equal(holding.status, 200, await holding.clone().text());
  assert.equal(((await holding.json()) as { choices: Array<{ finish_reason: string }> }).choices[0]?.finish_reason, 'tool_calls');
  const holder = chatOf(holding);
  // The CLI waits on the stub for the client's result, so its turn is still open
  assert.equal(core.runtime.get(holder)?.status, 'busy');
  const person = await personStart('Mine');
  assert.equal(person.status, 201, await person.clone().text());
  const personId = ((await person.json()) as { id: string }).id;
  await idle(personId);
  await until(() => core.runtime.activeCount() === 3, 'three processes up');
  const busy = core.runtime.livePids().map((p) => p.chatId).find((id) => id !== holder && id !== personId);
  assert.ok(busy);
  assert.equal(core.runtime.get(busy)?.status, 'busy');

  const refusedApi = await post({ model: 'sonnet', messages: [user('no room')] });
  assert.equal(refusedApi.status, 429, await refusedApi.clone().text());
  assert.equal(refusedApi.headers.get('retry-after'), '5');
  const refusedPerson = await personStart('No room either');
  assert.equal(refusedPerson.status, 400, await refusedPerson.clone().text());
  assert.match(((await refusedPerson.json()) as { error: string }).error, /run slot|concurrent/i);

  await pause(100);
  for (const id of [busy, holder, personId]) assert.ok(live(id), `${id} keeps its process`);
  assert.equal(core.runtime.activeCount(), 3);
  core.runtime.stopAll();
  await busyRes.then((r) => r.text()).catch(() => '');
});

test('two concurrent /v1 admissions with one evictable process: one is served, the other refused, never both', async () => {
  await core.appSettings.update({ maxConcurrentRuns: 2 });
  const evictable = await idleApiChat('idle');
  const busy = post({ model: 'sonnet', messages: [user('SLOW 3000')] });
  await until(() => core.runtime.activeCount() === 2, 'both slots taken');

  const [a, b] = await Promise.all([post({ model: 'sonnet', messages: [user('SLOW 1500')] }), post({ model: 'sonnet', messages: [user('SLOW 1500')] })]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 429], `${await a.clone().text()} / ${await b.clone().text()}`);
  await Promise.all([a.text(), b.text()]);
  assert.ok(!live(evictable));
  core.runtime.stopAll();
  await busy.then((r) => r.text()).catch(() => '');
});

test('two starts in one tick with one evictable process do not both take its slot', async () => {
  await core.appSettings.update({ maxConcurrentRuns: 1 });
  const evictable = await idleApiChat('idle');
  // Same tick: the evicted process is still up when the second start is admitted
  const first = core.runtime.start({ prompt: 'SLOW 1000' });
  assert.throws(() => core.runtime.start({ prompt: 'SLOW 1000' }), RunSlotRefusal);
  assert.ok(first.id);
  await until(() => !live(evictable), 'the evicted chat to exit');
  assert.equal(core.runtime.activeCount(), 1);
});

test('when evicting every idle API chat would still not make room, none is evicted', async () => {
  await core.appSettings.update({ maxConcurrentRuns: 2 });
  const evictable = await idleApiChat('idle');
  const busy = post({ model: 'sonnet', messages: [user('SLOW 3000')] });
  await until(() => core.runtime.activeCount() === 2, 'both slots taken');
  // Lowered below what runs: one more start needs two places, and only one process could give its own
  await core.appSettings.update({ maxConcurrentRuns: 1 });

  const refused = await post({ model: 'sonnet', messages: [user('no room')] });
  assert.equal(refused.status, 429, await refused.clone().text());
  await pause(100);
  assert.ok(live(evictable), 'the idle API chat keeps its process when its slot would not be enough');
  core.runtime.stopAll();
  await busy.then((r) => r.text()).catch(() => '');
});
