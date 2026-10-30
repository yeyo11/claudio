import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@claudio/core';
import type { Chat, ChatMessageResponse, ChatSummary } from '@claudio/shared';
import { buildApp } from '../src/app.ts';

// The delivery routes of C2 over HTTP (docs/plans/regression-fixes-2026-10-29.md): what waits in a
// chat says who sent it and which foreground call holds it, a waiting message can be withdrawn, and
// the call can be sent to the background instead of interrupting the turn. On the queueing fake,
// which answers `background_tasks` and `cancel_async_message` as the CLI does.
const FAKE_QUEUE = fileURLToPath(new URL('../../../packages/core/test/fixtures/fake-claude-queue.mjs', import.meta.url));
const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let app: FastifyInstance;
let core: Core;
let root: string;
let cwd: string;
let queueLog: string;
let savedLog: string | undefined;

type Op = { op: string; text?: string; uuid?: string | null; toolUseId?: string; subtype?: string };
const ops = (): Op[] => (existsSync(queueLog) ? readFileSync(queueLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Op) : []);

async function until(what: string, ready: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await ready()) return;
    await sleep(40);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const read = async (id: string): Promise<Chat> => (await app.inject(`/api/chats/${id}`)).json<{ chat: Chat }>().chat;

async function started(prompt: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/chats', ...json({ prompt, cwd }) });
  assert.equal(res.statusCode, 201, res.body);
  return res.json<ChatSummary>().id;
}

async function sendTo(id: string, text: string): Promise<ChatMessageResponse['message']> {
  const res = await app.inject({ method: 'POST', url: `/api/chats/${id}/messages`, ...json({ text }) });
  assert.equal(res.statusCode, 200, res.body);
  return res.json<ChatMessageResponse>().message;
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'claudio-api-delivery-'));
  cwd = join(root, 'cwd');
  mkdirSync(cwd);
  queueLog = join(root, 'queue.jsonl');
  savedLog = process.env.FAKE_QUEUE_LOG;
  process.env.FAKE_QUEUE_LOG = queueLog;
  core = new Core(
    loadConfig({
      CLAUDE_BIN: FAKE_QUEUE,
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
    }),
  );
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
});

after(async () => {
  for (const name of ['f1', 'f2', 'f3']) writeFileSync(join(root, name), '');
  await app.close();
  core.shutdown();
  await sleep(150);
  if (savedLog === undefined) delete process.env.FAKE_QUEUE_LOG;
  else process.env.FAKE_QUEUE_LOG = savedLog;
  rmSync(root, { recursive: true, force: true });
});

test('a message held behind a foreground agent says so, and sending the agent to the background delivers it', async () => {
  const id = await started(`AGENT ${join(root, 'f1')}`);
  await until('the agent call', async () => (await read(id)).activity?.tool === 'Agent');
  const message = await sendTo(id, 'look at the config first');
  const [waiting] = (await read(id)).pending ?? [];
  assert.equal(waiting?.id, message.id);
  assert.equal(waiting?.source, 'person');
  assert.deepEqual(waiting?.blockedBy, { toolUseId: 'toolu_agent_1', name: 'Agent', description: 'look around the repository' });

  const wrong = await app.inject({ method: 'POST', url: `/api/chats/${id}/commands/toolu_nope/background` });
  assert.equal(wrong.statusCode, 409, wrong.body);
  assert.equal(wrong.json<{ code?: string }>().code, 'not-running');

  const sent = await app.inject({ method: 'POST', url: `/api/chats/${id}/commands/toolu_agent_1/background` });
  assert.equal(sent.statusCode, 200, sent.body);
  await until('the message to be read', async () => ((await read(id)).pending ?? []).length === 0);
  assert.ok(!ops().some((o) => o.op === 'control' && o.subtype === 'interrupt'), 'nothing was interrupted');
});

test('a waiting message is withdrawn, then refused as taken, and an unknown one is not found', async () => {
  const id = await started(`HOLD ${join(root, 'f2')}`);
  await until('the turn', async () => (await read(id)).state === 'working');
  const message = await sendTo(id, 'never mind this');
  await until('the CLI to queue it', () => ops().some((o) => o.op === 'enqueue' && o.text === 'never mind this'));
  const withdrawn = await app.inject({ method: 'DELETE', url: `/api/chats/${id}/messages/${message.id}` });
  assert.equal(withdrawn.statusCode, 200, withdrawn.body);
  assert.deepEqual((await read(id)).pending ?? [], []);
  assert.ok(ops().some((o) => o.op === 'cancelled' && o.uuid === message.id));

  const again = await app.inject({ method: 'DELETE', url: `/api/chats/${id}/messages/${message.id}` });
  assert.equal(again.statusCode, 409, again.body);
  assert.equal(again.json<{ code?: string }>().code, 'taken');
  const unknown = await app.inject({ method: 'DELETE', url: `/api/chats/${id}/messages/00000000-0000-4000-8000-000000000000` });
  assert.equal(unknown.statusCode, 404, unknown.body);
});

test("a person's hint over HTTP waits as the person's, with the words they wrote", async () => {
  const id = await started(`HOLD ${join(root, 'f3')}`);
  await until('the turn', async () => (await read(id)).state === 'working');
  const res = await app.inject({ method: 'POST', url: `/api/chats/${id}/hint`, ...json({ text: 'is a connection left open?' }) });
  assert.equal(res.statusCode, 200, res.body);
  const hint = ((await read(id)).pending ?? []).find((m) => m.text === 'is a connection left open?');
  assert.equal(hint?.source, 'person');
  assert.equal(hint?.state, 'written');
  const empty = await app.inject({ method: 'POST', url: `/api/chats/${id}/hint`, ...json({}) });
  assert.equal(empty.statusCode, 400, empty.body);
});
