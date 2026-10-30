import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@claudio/core';
import type { ChatDetail, ChatSummary } from '@claudio/shared';
import { buildApp } from '../src/app.ts';
import { signInDefault } from './helpers.ts';

/*
 * A new chat names a model its provider lists, or is refused before anything starts (report §4.13):
 * the CLI would otherwise answer a synthetic "model not found" and leave the chat idle and healthy.
 * And a chat's page shows what its own process loaded, never another chat's in the same folder
 * (report §4.11, plan C5). Through the e2e fake CLI, whose `initialize` lists default, opus, sonnet
 * and haiku.
 */

const FAKE_CLI = fileURLToPath(new URL('../../../e2e/fake-cli/claude', import.meta.url));

let root: string;
let app: FastifyInstance;
let core: Core;
let cwd: string;

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

before(async () => {
  // What is under test is the model and the environment, not whether this host has room for a chat now
  process.env.CLAUDIO_ADMIT_MEMORY_PRESSURE = '100';
  process.env.CLAUDIO_ADMIT_MEMORY_FLOOR_MB = '0';
  root = mkdtempSync(join(tmpdir(), 'claudio-model-env-'));
  // The CLI's own login has a credential, so chats start on it
  signInDefault(join(root, 'claude'));
  core = new Core(loadConfig({ CLAUDE_BIN: FAKE_CLI, CLAUDE_CONFIG_DIR: join(root, 'claude'), CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'), CLAUDIO_DATA_DIR: join(root, 'data') }));
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  cwd = join(root, 'shop');
  mkdirSync(cwd, { recursive: true });
});

after(async () => {
  delete process.env.CLAUDIO_ADMIT_MEMORY_PRESSURE;
  delete process.env.CLAUDIO_ADMIT_MEMORY_FLOOR_MB;
  core.runtime.stopAll();
  core.shutdown();
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

const start = (body: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/chats', ...json({ prompt: 'hello', cwd, ...body }) });

test('a model the provider does not list is a 400 model-unknown, and no chat is started', async () => {
  const before = core.runtime.list().length;
  const refused = await start({ model: 'claude-made-up-9' });
  assert.equal(refused.statusCode, 400, refused.body);
  const body = refused.json<{ error: string; code: string }>();
  assert.equal(body.code, 'model-unknown');
  assert.match(body.error, /claude-made-up-9 is not one this provider lists \(default, opus, sonnet, haiku\)/);
  assert.equal(core.runtime.list().length, before, 'nothing was started');
});

test('an alias, the id it resolves to, the 1M context form and default are all known', async () => {
  for (const model of ['sonnet', 'claude-opus-5', 'opus[1m]', 'default']) {
    const started = await start({ model });
    assert.equal(started.statusCode, 201, `${model}: ${started.body}`);
    await core.runtime.waitForResult(started.json<ChatSummary>().id);
  }
});

test("a chat's page shows what its own process loaded; a chat from a terminal in the same folder shows the folder's, labelled", async () => {
  const started = await start({ model: 'haiku' });
  assert.equal(started.statusCode, 201, started.body);
  const { id } = started.json<ChatSummary>();
  await core.runtime.waitForResult(id);
  const own = (await app.inject(`/api/chats/${id}`)).json<ChatDetail>().chat.environment;
  assert.equal(own?.source, 'chat');

  // A transcript the CLI wrote in the same folder, from a terminal: no process of it started here
  const dir = join(core.config.projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const line = { type: 'user', uuid: 'u1', timestamp: '2026-10-29T10:00:00.000Z', cwd, sessionId: 'from-terminal', isSidechain: false, message: { role: 'user', content: 'hi' } };
  writeFileSync(join(dir, 'from-terminal.jsonl'), `${JSON.stringify(line)}\n`);
  const borrowed = (await app.inject('/api/chats/from-terminal')).json<ChatDetail>().chat.environment;
  assert.equal(borrowed?.source, 'folder');
  assert.equal(borrowed?.observedAt, core.runtime.environments.ofDir(cwd)?.observedAt);
});
