import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@claudio/core';
import type { Workspace } from '@claudio/shared';
import { buildApp } from '../src/app.ts';
import { standInGuard } from './fixtures/declared-guard.ts';

// D14 as written (docs/plans/headless-image.md): a /v1 chat is a confined API chat in a headless
// Claudio and in a workspace, and in the full profile without a workspace it is the app's own kind
// of chat. The cwd rule splits the same way: headless refuses a folder that holds the workspaces
// root, the full profile only the root and what is inside it.

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude-openai.mjs', import.meta.url));
const TOKEN = 'profiles-test-token';

interface Side {
  core: Core;
  app: FastifyInstance;
  root: string;
  prompts: string;
}

const sides: Side[] = [];

async function start(profile: 'full' | 'headless'): Promise<Side> {
  const root = mkdtempSync(join(tmpdir(), `claudio-api-profiles-${profile}-`));
  // One file for both sides: the fake CLI reads the variable of this process, and chat ids never repeat
  process.env.FAKE_OPENAI_PROMPTS ??= join(tmpdir(), `claudio-api-profiles-${process.pid}.jsonl`);
  const prompts = process.env.FAKE_OPENAI_PROMPTS;
  const core = new Core(
    loadConfig({
      CLAUDE_BIN: FAKE,
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
      CLAUDIO_PROFILE: profile,
      ...(profile === 'headless' ? { CLAUDIO_AUTH_MODE: 'token', CLAUDIO_AUTH_TOKEN: TOKEN } : {}),
    }),
  );
  standInGuard(core, join(root, 'guard'));
  await core.appSettings.update({ maxConcurrentRuns: 64 });
  const app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  const side = { core, app, root, prompts };
  sides.push(side);
  return side;
}

let full: Side;
let headless: Side;
let fullToken: string;

before(async () => {
  full = await start('full');
  fullToken = (await full.core.security.setToken({})).token;
  headless = await start('headless');
});

after(async () => {
  const unseal = (path: string): void => {
    if (!existsSync(path) || !statSync(path).isDirectory()) return;
    chmodSync(path, 0o755);
    for (const name of readdirSync(path)) unseal(join(path, name));
  };
  for (const side of sides) {
    side.core.runtime.stopAll();
    await side.app.close();
    await side.core.shutdown();
    unseal(side.root);
    rmSync(side.root, { recursive: true, force: true });
  }
  rmSync(process.env.FAKE_OPENAI_PROMPTS ?? '', { force: true });
  delete process.env.FAKE_OPENAI_PROMPTS;
});

const user = (text: string) => ({ role: 'user', content: text });

async function complete(side: Side, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; chatId: string; text: string }> {
  const token = side === full ? fullToken : TOKEN;
  const res = await side.app.inject({ method: 'POST', url: '/api/v1/chat/completions', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, payload: JSON.stringify(body) });
  return { status: res.statusCode, chatId: String(res.headers['x-claudio-chat-id'] ?? ''), text: res.body };
}

/** The CLI arguments a chat's process was started with, as the fake CLI recorded them */
function argsOf(side: Side, chatId: string): string[] {
  const lines = readFileSync(side.prompts, 'utf8').split('\n').filter(Boolean);
  const mine = lines.map((l) => JSON.parse(l) as { sessionId?: string; args?: string[] }).filter((p) => p.sessionId === chatId && p.args);
  return mine[0]?.args ?? [];
}

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

async function workspaceIn(side: Side): Promise<Workspace> {
  const archive = gzipSync(Buffer.concat([entry('repo/', '', '5'), entry('repo/README.md', '# repo'), Buffer.alloc(1024)]));
  const res = await side.app.inject({ method: 'POST', url: '/api/workspaces', headers: { 'content-type': 'application/gzip', authorization: `Bearer ${side === full ? fullToken : TOKEN}` }, payload: archive });
  assert.equal(res.statusCode, 201, res.body);
  return res.json<Workspace>();
}

test('full profile, no workspace: a default preset with a bare Bash answers 200 and the process is not confined', async () => {
  const { core } = full;
  await core.toolPresets.upsert('bare-bash', { name: 'Bare Bash', allowedTools: ['Read', 'Bash'] });
  await core.toolPresets.setDefault({ defaultPresetId: 'bare-bash' });
  try {
    const res = await complete(full, { model: 'sonnet', messages: [user('plain chat')] });
    assert.equal(res.status, 200, res.text);
    const runtime = core.runtime.get(res.chatId);
    assert.equal(runtime?.policy ?? null, null, 'not a confined API chat');
    assert.deepEqual(runtime?.asked?.allowedTools, ['Read', 'Bash'], 'what the request declared is kept to compare');
    assert.equal(runtime?.origin, 'api');
    const args = argsOf(full, res.chatId);
    assert.ok(args.length > 0);
    assert.ok(!args.includes('--restricted'));
    assert.ok(!args.some((a) => a.startsWith('--setting-sources=')), 'the CLI reads its normal setting sources');
  } finally {
    await core.toolPresets.setDefault({ defaultPresetId: null });
  }
});

test('full profile, no workspace: the per-call headers are plain chat options, a bare Bash included', async () => {
  const res = await complete(full, { model: 'sonnet', messages: [user('with options')] }, {
    'x-claudio-allowed-tools': '["Bash"]',
    'x-claudio-max-turns': '4',
    'x-claudio-max-budget-usd': '0.5',
  });
  assert.equal(res.status, 200, res.text);
  const args = argsOf(full, res.chatId);
  assert.ok(!args.includes('--restricted'));
  assert.equal(args[args.indexOf('--max-turns') + 1], '4');
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '0.5');
  assert.equal(full.core.runtime.get(res.chatId)?.policy ?? null, null);
});

test('full profile, no workspace: a named chat with other values is 409 policy_mismatch, and a resent history finds its chat', async () => {
  const headers = { 'x-claudio-max-turns': '6' };
  const first = await complete(full, { model: 'sonnet', messages: [user('unconfined key')] }, headers);
  assert.equal(first.status, 200, first.text);
  const answer = (JSON.parse(first.text) as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content ?? '';
  const mismatch = await complete(full, { model: 'sonnet', messages: [user('more')] }, { 'x-claudio-chat-id': first.chatId, 'x-claudio-max-turns': '7' });
  assert.equal(mismatch.status, 409);
  assert.equal((JSON.parse(mismatch.text) as { error: { code: string } }).error.code, 'policy_mismatch');
  const named = await complete(full, { model: 'sonnet', messages: [user('more')] }, { 'x-claudio-chat-id': first.chatId, ...headers });
  assert.equal(named.status, 200, named.text);
  const again = await complete(full, { model: 'sonnet', messages: [user('unconfined key'), { role: 'assistant', content: answer }, user('next')] }, headers);
  assert.equal(again.status, 200, again.text);
  assert.equal(again.chatId, first.chatId);
});

test('full profile with X-Claudio-Workspace: the chat is confined and a bare Bash is refused', async () => {
  const ws = await workspaceIn(full);
  const res = await complete(full, { model: 'sonnet', messages: [user('in a workspace')] }, { 'x-claudio-workspace': ws.id });
  assert.equal(res.status, 200, res.text);
  assert.equal(full.core.runtime.get(res.chatId)?.policy?.workspaceId, ws.id);
  const args = argsOf(full, res.chatId);
  assert.ok(args.includes('--restricted'));
  assert.ok(args.some((a) => a.startsWith('--setting-sources=')));
  const bare = await complete(full, { model: 'sonnet', messages: [user('bash in a workspace')] }, { 'x-claudio-workspace': ws.id, 'x-claudio-allowed-tools': '["Bash"]' });
  assert.equal(bare.status, 400);
});

test('headless: every /v1 chat is confined, with no tools by default, and a bare Bash is refused', async () => {
  const res = await complete(headless, { model: 'sonnet', messages: [user('headless chat')] });
  assert.equal(res.status, 200, res.text);
  const runtime = headless.core.runtime.get(res.chatId);
  assert.deepEqual(runtime?.policy?.allowedTools, []);
  assert.equal(runtime?.asked ?? null, null);
  const args = argsOf(headless, res.chatId);
  assert.ok(args.includes('--restricted'));
  assert.ok(args.some((a) => a.startsWith('--setting-sources=')));
  const bare = await complete(headless, { model: 'sonnet', messages: [user('headless bash')] }, { 'x-claudio-allowed-tools': '["Bash"]' });
  assert.equal(bare.status, 400);
  assert.match(bare.text, /X-Claudio-Allowed-Tools/);
});

async function startChat(side: Side, cwd: string): Promise<number> {
  const token = side === full ? fullToken : TOKEN;
  const res = await side.app.inject({ method: 'POST', url: '/api/chats', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, payload: JSON.stringify({ prompt: 'where am I', cwd }) });
  return res.statusCode;
}

test('cwd rule: the full profile starts a chat in a folder that holds the workspaces root and refuses one that is or is inside it', async () => {
  const { core } = full;
  const holder = dirname(core.workspaces.root);
  assert.equal(await startChat(full, holder), 201);
  assert.equal(await startChat(full, core.workspaces.root), 400);
  const inside = join(core.workspaces.root, 'not-a-workspace');
  mkdirSync(inside, { recursive: true });
  assert.equal(await startChat(full, inside), 400);
});

test('cwd rule: headless refuses a folder that holds the workspaces root, is it or is inside it', async () => {
  const { core } = headless;
  const inside = join(core.workspaces.root, 'not-a-workspace');
  mkdirSync(inside, { recursive: true });
  for (const cwd of [dirname(core.workspaces.root), core.workspaces.root, inside]) assert.equal(await startChat(headless, cwd), 400, cwd);
});
