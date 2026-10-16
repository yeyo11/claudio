import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@claudio/core';
import type { ReviewGateDetail, ReviewRoleInfo } from '@claudio/shared';
import { buildApp } from '../src/app.ts';

process.env.FAKE_CLAUDE_LOGGED_IN = '1';
const FAKE_CLAUDE = fileURLToPath(new URL('../../../packages/core/test/fixtures/fake-claude.mjs', import.meta.url));

let app: FastifyInstance;
let core: Core;
let projectId: string;
let projectPath: string;

before(async () => {
  const root = mkdtempSync(join(tmpdir(), 'claudio-api-review-'));
  const workspace = join(root, 'workspace');
  projectPath = join(workspace, 'proj');
  mkdirSync(projectPath, { recursive: true });
  core = new Core(
    loadConfig({
      CLAUDE_BIN: FAKE_CLAUDE,
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: workspace,
      CLAUDIO_DATA_DIR: join(root, 'data'),
    }),
  );
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  const res = await app.inject({ method: 'POST', url: '/api/projects/import', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ path: projectPath }) });
  projectId = res.json<{ id: string }>().id;
});

after(async () => {
  for (const o of core.orchestrator.list()) core.orchestrator.stop(o.id);
  core.runtime.stopAll();
  await app.close();
  core.shutdown();
});

const post = (url: string, body?: unknown) =>
  app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body ?? {}) });

test('every review route is documented with a summary and its tag', async () => {
  const spec = (await app.inject('/openapi.json')).json<{ paths: Record<string, Record<string, { summary?: string; tags?: string[] }>> }>();
  for (const [path, method, tag] of [
    ['/api/orchestrations/{id}/review', 'get', 'Orchestration'],
    ['/api/orchestrations/{id}/review/retry', 'post', 'Orchestration'],
    ['/api/orchestrations/{id}/review/accept', 'post', 'Orchestration'],
    ['/api/projects/{id}/review-roles', 'get', 'Projects'],
    ['/api/projects/{id}/review-roles/{role}', 'post', 'Projects'],
  ] as const) {
    const op = spec.paths[path]?.[method];
    assert.ok(op?.summary && op.tags?.includes(tag), `${method} ${path}`);
  }
});

test('the review routes answer 404 for an unknown graph', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/orchestrations/nope/review' })).statusCode, 404);
  assert.equal((await post('/api/orchestrations/nope/review/retry')).statusCode, 404);
  assert.equal((await post('/api/orchestrations/nope/review/accept', { reason: 'checked by hand' })).statusCode, 404);
});

test('GET review checks the bounds of limit, offset and round', async () => {
  for (const q of ['limit=0', 'limit=501', 'limit=x', 'offset=-1', 'offset=1.5', 'round=0']) {
    assert.equal((await app.inject({ method: 'GET', url: `/api/orchestrations/nope/review?${q}` })).statusCode, 400, q);
  }
  assert.equal((await app.inject({ method: 'GET', url: '/api/orchestrations/nope/review?limit=500&offset=0&round=1&blocking=1' })).statusCode, 404);
});

test('review roles: list, write the default once, 409 over an existing file, 404s', async () => {
  const list = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/review-roles` });
  assert.equal(list.statusCode, 200);
  const roles = list.json<ReviewRoleInfo[]>();
  assert.deepEqual(roles.map((r) => r.role).sort(), ['conventions', 'correctness', 'security', 'tests', 'verifier']);
  assert.ok(roles.every((r) => r.source === 'builtin'));

  const written = await post(`/api/projects/${projectId}/review-roles/security`);
  assert.equal(written.statusCode, 201);
  const info = written.json<ReviewRoleInfo>();
  assert.equal(info.role, 'security');
  assert.equal(info.source, 'project');

  const again = await post(`/api/projects/${projectId}/review-roles/security`);
  assert.equal(again.statusCode, 409);
  assert.equal(again.json<{ code: string }>().code, 'role-exists');

  writeFileSync(join(projectPath, info.file), 'mine\n');
  assert.equal((await post(`/api/projects/${projectId}/review-roles/security`)).statusCode, 409);

  assert.equal((await post(`/api/projects/${projectId}/review-roles/nope`)).statusCode, 404);
  assert.equal((await post('/api/projects/missing/review-roles/security')).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/api/projects/missing/review-roles' })).statusCode, 404);
});

test('a graph without a review gate: 404 on GET, 409 on retry; with one, GET answers an empty page', async () => {
  const started = await post('/api/orchestrations', { name: 'plain', cwd: projectPath, synthesize: false, tasks: [{ id: 'a', name: 'a', prompt: 'hello' }] });
  assert.equal(started.statusCode, 201);
  const { id } = started.json<{ id: string }>();
  assert.equal((await app.inject({ method: 'GET', url: `/api/orchestrations/${id}/review` })).statusCode, 404);

  const retry = await post(`/api/orchestrations/${id}/review/retry`);
  assert.equal(retry.statusCode, 409);
  assert.equal(retry.json<{ code: string }>().code, 'review-not-acceptable');

  const short = await post(`/api/orchestrations/${id}/review/accept`, { reason: 'x' });
  assert.ok(short.statusCode === 400 || short.statusCode === 409, String(short.statusCode));

  const live = core.orchestrator.get(id);
  assert.ok(live);
  live.verificationSpec = { commands: [], fixer: false, maxAttempts: 1, review: {} };
  const detail = await app.inject({ method: 'GET', url: `/api/orchestrations/${id}/review?limit=10&offset=0&blocking=1` });
  assert.equal(detail.statusCode, 200);
  const body = detail.json<ReviewGateDetail>();
  assert.deepEqual(body.findings, []);
  assert.equal(body.totalFindings, 0);
});
