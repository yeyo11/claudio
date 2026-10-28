import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import type { Chat, Workspace } from '@claudio/shared';
import { Core, loadConfig } from '@claudio/core';
import { buildApp } from '../src/app.ts';

// `workspaceId` on POST /api/chats and the REST answers of a confined API chat
// (docs/plans/headless-image.md, D14 and D9): its refusals with their codes, and no resume, fork or
// settings change. What its process is started with is covered in packages/core/test/confined-chat.test.ts.

let app: FastifyInstance;
let core: Core;
let root: string;

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

const tgz = (...entries: Buffer[]): Buffer => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
const post = (url: string, body: unknown) => app.inject({ method: 'POST', url, payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'claudio-confined-'));
  core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
    }),
  );
  // The guard's install is not what these routes test: the launch is handed a plan of its own
  core.guardLauncher.prepareDeclared = async () => {
    const settingsPath = join(root, 'data', 'guard.settings.json');
    writeFileSync(settingsPath, '{}');
    return { rules: ['integrity', 'declared-tools'], mode: 'enforce', settingsPath, rulesSha256: '0'.repeat(64) };
  };
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
});

after(async () => {
  await app.close();
  await core.shutdown();
  const unseal = (path: string): void => {
    if (!statSync(path).isDirectory()) return;
    chmodSync(path, 0o755);
    for (const name of readdirSync(path)) unseal(join(path, name));
  };
  unseal(root);
  rmSync(root, { recursive: true, force: true });
});

test('a chat named by workspaceId is a confined API chat whose policy is on its view, and it cannot be resumed, forked or changed', async () => {
  const created = await app.inject({ method: 'POST', url: '/api/workspaces', payload: tgz(entry('repo/', '', '5'), entry('repo/a.txt', 'a')), headers: { 'content-type': 'application/gzip' } });
  assert.equal(created.statusCode, 201);
  const ws = created.json<Workspace>();

  const chat = await post('/api/chats', { prompt: 'read a.txt', workspaceId: ws.id, allowedTools: ['Read'], maxBudgetUsd: 0.2 });
  assert.equal(chat.statusCode, 201, chat.body);
  const { id, policy } = chat.json<Chat>();
  assert.deepEqual(policy, { workspaceId: ws.id, allowedTools: ['Read'], maxTurns: null, maxBudgetUsd: 0.2, schema: false });
  assert.deepEqual((await app.inject({ method: 'GET', url: `/api/chats/${id}` })).json<{ chat: Chat }>().chat.policy, policy);
  await core.runtime.exited(id);

  const resumed = await post(`/api/chats/${id}/resume`, { prompt: 'again' });
  assert.equal(resumed.statusCode, 409);
  assert.equal((await post(`/api/chats/${id}/fork`, { prompt: 'again' })).statusCode, 409);
  const patched = await app.inject({ method: 'PATCH', url: `/api/chats/${id}`, payload: JSON.stringify({ permissionMode: 'bypassPermissions' }), headers: { 'content-type': 'application/json' } });
  assert.equal(patched.statusCode, 409);
});

test('the refusals of a start answer with their status and, where a client acts on it, their code', async () => {
  const created = await app.inject({ method: 'POST', url: '/api/workspaces', payload: tgz(entry('repo/', '', '5'), entry('repo/a.txt', 'a')), headers: { 'content-type': 'application/gzip' } });
  const ws = created.json<Workspace>();
  const cases: Array<[Record<string, unknown>, number, string | undefined]> = [
    [{ workspaceId: ws.id, permissionMode: 'bypassPermissions' }, 400, undefined],
    [{ workspaceId: ws.id, claudioMcp: true }, 400, undefined],
    [{ workspaceId: ws.id, allowedTools: ['Bash'] }, 400, undefined],
    [{ workspaceId: ws.id, allowedTools: ['Write'] }, 400, undefined],
    [{ workspaceId: 7 }, 400, undefined],
    [{ workspaceId: 'ws_AAAAAAAAAAAAAAAA' }, 404, 'workspace-not-found'],
    [{ cwd: join(root, 'workspace', 'missing') }, 400, 'cwd-missing'],
    [{ cwd: core.workspaces.root }, 400, undefined],
  ];
  for (const [body, status, code] of cases) {
    const res = await post('/api/chats', { prompt: 'x', ...body });
    assert.equal(res.statusCode, status, `${JSON.stringify(body)}: ${res.body}`);
    assert.equal(res.json<{ code?: string }>().code, code, JSON.stringify(body));
  }
  // An expired or removed workspace is a 410 a client tells apart from one that never existed
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/workspaces/${ws.id}` })).statusCode, 204);
  const gone = await post('/api/chats', { prompt: 'x', workspaceId: ws.id });
  assert.equal(gone.statusCode, 410);
  assert.equal(gone.json<{ code?: string }>().code, 'workspace-expired');
});
