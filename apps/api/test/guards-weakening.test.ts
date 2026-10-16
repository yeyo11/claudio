import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { Core, loadConfig } from '@claudio/core';
import { buildApp } from '../src/app.ts';

// A chat's token cannot weaken a guard through any route that accepts one (D11), while a person can.

interface Wrapper {
  app: FastifyInstance;
  core: Core;
  root: string;
  project: string;
  chat: string;
}

async function wrapper(t: { after: (fn: () => unknown) => void }): Promise<Wrapper> {
  const root = mkdtempSync(join(tmpdir(), 'claudio-guards-weak-'));
  const core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
    }),
  );
  const app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  t.after(async () => {
    core.shutdown();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const dir = join(root, 'proj');
  mkdirSync(dir);
  const imported = await app.inject({ method: 'POST', url: '/api/projects/import', payload: JSON.stringify({ path: dir, name: 'Guarded', modules: ['board'] }), headers: { 'content-type': 'application/json' } });
  assert.equal(imported.statusCode, 201, imported.body);
  return { app, core, root, project: imported.json<{ id: string }>().id, chat: core.security.chatTokens.mint('chat-42') };
}

const person = (method: InjectOptions['method'], url: string, body?: unknown): InjectOptions => ({
  method,
  url,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
});
const chatOf = (token: string, method: InjectOptions['method'], url: string, body?: unknown): InjectOptions => ({
  method,
  url,
  remoteAddress: '127.0.0.1',
  headers: { host: '127.0.0.1:34331', 'content-type': 'application/json', authorization: `Bearer ${token}` },
  ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
});

const OFF = { enabled: false };
const NO_PUSH = { rules: { push: false } };
const graph = (extra: Record<string, unknown>) => ({ name: 'g', cwd: tmpdir(), tasks: [{ id: 'a', name: 'a', prompt: 'do it' }], ...extra });

test("a chat's token cannot turn off its project's chat guards or a flow stage's guards, and can tighten them", async (t) => {
  const w = await wrapper(t);
  const url = `/api/projects/${w.project}/settings`;
  const stored = (await w.app.inject(url)).json<Record<string, unknown>>();
  const flow = (stage: unknown) => ({ ...stored, flow: { enabled: false, columns: {}, maxBounces: 2, ...(stored.flow as object | undefined), guards: { work: stage } } });

  // A person opts chats in and tightens the work stage
  const set = await w.app.inject(person('PUT', url, { ...flow({ rules: { 'protect-configs': true } }), guards: { chats: true } }));
  assert.equal(set.statusCode, 200, set.body);
  const saved = (await w.app.inject(url)).json<Record<string, unknown>>();

  // Chats off: refused
  assert.equal((await w.app.inject(chatOf(w.chat, 'PUT', url, { ...saved, guards: { chats: false } }))).statusCode, 403);
  // Dropping the document's guards reads as off: refused too
  const { guards: _guards, ...without } = saved;
  assert.equal((await w.app.inject(chatOf(w.chat, 'PUT', url, without))).statusCode, 403);
  // Stage switched off, a rule off, and a stored tightening dropped: refused
  assert.equal((await w.app.inject(chatOf(w.chat, 'PUT', url, { ...saved, ...flow(OFF) }))).statusCode, 403);
  assert.equal((await w.app.inject(chatOf(w.chat, 'PUT', url, { ...saved, ...flow(NO_PUSH) }))).statusCode, 403);
  assert.equal((await w.app.inject(chatOf(w.chat, 'PUT', url, { ...saved, ...flow({}) }))).statusCode, 403);
  // Unchanged is fine
  assert.equal((await w.app.inject(chatOf(w.chat, 'PUT', url, saved))).statusCode, 200);
  // A person may do all of it
  assert.equal((await w.app.inject(person('PUT', url, { ...saved, guards: { chats: false }, ...flow(OFF) }))).statusCode, 200);
});

test("a chat's token cannot start a graph, a relaunch, a resume or a template with weaker guards, and a person can", async (t) => {
  const w = await wrapper(t);
  const cases: Array<{ name: string; method: InjectOptions['method']; url: string; body: unknown }> = [
    { name: 'launch', method: 'POST', url: '/api/orchestrations', body: graph({ guards: OFF }) },
    { name: 'launch, one rule', method: 'POST', url: '/api/orchestrations', body: graph({ guards: NO_PUSH }) },
    { name: 'relaunch', method: 'POST', url: '/api/orchestrations/nope/relaunch', body: { spec: { guards: OFF } } },
    { name: 'resume', method: 'POST', url: '/api/orchestrations/nope/resume', body: { guards: OFF } },
    { name: 'save template', method: 'POST', url: '/api/orchestrations/templates', body: { name: 't', spec: graph({ guards: OFF }) } },
    { name: 'edit template', method: 'PATCH', url: '/api/orchestrations/templates/nope', body: { spec: graph({ guards: OFF }) } },
  ];
  for (const c of cases) {
    const chat = await w.app.inject(chatOf(w.chat, c.method, c.url, c.body));
    assert.equal(chat.statusCode, 403, `${c.name}: ${chat.body}`);
    // The person gets through the guards check: whatever else the route says, it is not a 403
    const owner = await w.app.inject(person(c.method, c.url, c.body));
    assert.notEqual(owner.statusCode, 403, `${c.name}: ${owner.body}`);
  }
  // Tightening is allowed to a chat: the check passes and the route answers for itself
  const tight = await w.app.inject(chatOf(w.chat, 'POST', '/api/orchestrations/nope/resume', { guards: { rules: { 'protect-configs': true } } }));
  assert.notEqual(tight.statusCode, 403, tight.body);
});

test("a chat's token cannot launch a saved template whose guards are off", async (t) => {
  const w = await wrapper(t);
  const saved = await w.app.inject(person('POST', '/api/orchestrations/templates', { name: 'unguarded', spec: graph({ guards: OFF }) }));
  assert.equal(saved.statusCode, 201, saved.body);
  const { id } = saved.json<{ id: string; spec: { guards?: unknown } }>();
  assert.deepEqual(core(w).orchestrator.templates.get(id)?.spec.guards, OFF, 'the template kept the override');
  const launch = await w.app.inject(chatOf(w.chat, 'POST', `/api/orchestrations/templates/${id}/launch`, {}));
  assert.equal(launch.statusCode, 403, launch.body);
});

const core = (w: Wrapper): Core => w.core;

test('every shared type holding a GuardOverride is covered by a route checked here', () => {
  const types = readFileSync(fileURLToPath(new URL('../../../packages/shared/src/types.ts', import.meta.url)), 'utf8');
  const holders = new Set<string>();
  let current: string | null = null;
  for (const line of types.split('\n')) {
    const header = /^export (?:interface|type) (\w+)/.exec(line);
    if (header) current = header[1] ?? null;
    if (current && current !== 'GuardOverride' && /\bGuardOverride\b/.test(line) && !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//')) holders.add(current);
  }
  // Each holder, and the routes that carry it (all in the test above): a new holder needs a route check
  const covered: Record<string, string[]> = {
    ProjectFlowSettings: ['PUT /projects/:id/settings'],
    OrchestrationSpec: ['POST /orchestrations', 'POST /orchestrations/:id/relaunch', 'POST /orchestrations/templates', 'PATCH /orchestrations/templates/:templateId', 'POST /orchestrations/templates/:templateId/launch'],
    ResumeOrchestrationRequest: ['POST /orchestrations/:id/resume'],
    // The read model echoes the spec's override; nothing writes it
    Orchestration: [],
  };
  assert.deepEqual([...holders].sort(), Object.keys(covered).sort(), 'a shared type with a GuardOverride has no covered route: add the weakening check and list it here');
});
