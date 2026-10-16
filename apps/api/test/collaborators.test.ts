import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@claudio/core';
import type { CollaboratorsStatus, GroupInvite, GroupList, ProjectSharing, ShareKeyInUseError } from '@claudio/shared';
import { buildApp } from '../src/app.ts';
import { ROUTE_DOCS } from '../src/openapi/routes.ts';
import { transcriptPage } from '../src/routes/collaborators.ts';

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

// The binding is the core's dependency, so it is looked up from there
let irohError = '';
try {
  await import(createRequire(new URL('../../../packages/core/package.json', import.meta.url)).resolve('@number0/iroh'));
} catch (error) {
  irohError = error instanceof Error ? error.message : String(error);
}

interface Wrapper {
  app: FastifyInstance;
  core: Core;
}

/** A wrapper of its own, with the endpoint on the minimal preset and loopback, so nothing leaves the machine */
async function wrapper(t: TestContext): Promise<Wrapper> {
  const root = mkdtempSync(join(tmpdir(), 'claudio-collaborators-'));
  const saved = { preset: process.env.CLAUDIO_COLLAB_PRESET, bind: process.env.CLAUDIO_COLLAB_BIND };
  process.env.CLAUDIO_COLLAB_PRESET = 'minimal';
  process.env.CLAUDIO_COLLAB_BIND = '127.0.0.1:0';
  const core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
    }),
  );
  for (const [key, value] of [['CLAUDIO_COLLAB_PRESET', saved.preset], ['CLAUDIO_COLLAB_BIND', saved.bind]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  t.after(async () => {
    await core.collaborators.dispose();
    core.shutdown();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { app, core };
}

async function project(app: FastifyInstance, name: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/projects', ...json({ name }) });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().id as string;
}

const OWNER = 'a'.repeat(64);
const SHARE = 'b'.repeat(32);
const SHA = 'c'.repeat(64);

/** Every documented Collaborators route, with its path parameters filled in */
function collaboratorRoutes(projectId: string): Array<{ method: string; url: string; route: string }> {
  const values: Record<string, string> = { id: projectId, groupId: 'g1', from: OWNER, endpointId: OWNER, owner: OWNER, shareId: SHARE, chatId: 'chat-1', sha256: SHA };
  return Object.entries(ROUTE_DOCS)
    .filter(([, doc]) => doc.tags[0] === 'Collaborators')
    .map(([key]) => {
      const [method, path] = key.split(' ') as [string, string];
      return { method, route: key, url: `/api${path.replace(/:(\w+)/g, (_, name: string) => values[name] ?? name)}` };
    });
}

test('documents every route of §6 under the Collaborators tag', () => {
  const routes = collaboratorRoutes('p').map((r) => r.route);
  assert.equal(routes.length, 28);
  for (const route of ['GET /collaborators/shared/:owner/:shareId', 'GET /projects/:id/sharing', 'PUT /projects/:id/sharing', 'GET /collaborators/shared/:owner/:shareId/blobs/:sha256', 'GET /collaborators/shared/:owner/:shareId/chats/:chatId/subagents/:agentId'])
    assert.ok(routes.includes(route), route);
});

test("a chat's token is refused on every route, reads included, in either access mode", async (t) => {
  const { app, core } = await wrapper(t);
  const projectId = await project(app, 'shared-api');
  const routes = collaboratorRoutes(projectId);
  const chat = core.security.chatTokens.mint('chat-inj');

  const refusedAll = async (label: string) => {
    for (const { method, url, route } of routes) {
      const res = await app.inject({ method: method as 'GET', url, headers: bearer(chat), ...(method === 'GET' || method === 'DELETE' ? {} : { payload: {} }) });
      assert.equal(res.statusCode, 403, `${label}: ${route} answered ${res.statusCode} ${res.body}`);
      assert.equal(res.json().code, 'collaborators.chat-token', route);
    }
  };
  // Open mode: the token only labels the request, and the label is what refuses it
  await refusedAll('mode none');
  // The owner, with no token, still reaches them
  assert.equal((await app.inject('/api/collaborators')).statusCode, 200);

  const owner = (await app.inject({ method: 'POST', url: '/api/security/token', ...json({}) })).json<{ token: string }>().token;
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ mode: 'token' }) })).statusCode, 200);
  await refusedAll('mode token');
  assert.equal((await app.inject({ url: '/api/collaborators', headers: bearer(owner) })).statusCode, 200);
  // Nothing was changed through the refused writes
  assert.equal(core.collaborators.status().settings.enabled, false);
});

test('with Collaborators off: the status answers, group writes are refused, a project still has its sharing', async (t) => {
  const { app } = await wrapper(t);
  const status = (await app.inject('/api/collaborators')).json() as CollaboratorsStatus;
  assert.equal(status.settings.enabled, false);
  assert.equal(status.connection, 'off');
  assert.equal(status.endpointId, null);

  const created = await app.inject({ method: 'POST', url: '/api/collaborators/groups', ...json({ name: 'Backend' }) });
  assert.equal(created.statusCode, 409);
  assert.equal(created.json().code, 'off');
  assert.deepEqual((await app.inject('/api/collaborators/groups')).json(), { groups: [], pendingJoins: [] } satisfies GroupList);
  assert.equal((await app.inject('/api/collaborators/groups/nope/join-requests')).statusCode, 409);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/collaborators/join/nope' })).statusCode, 404);
  assert.deepEqual((await app.inject('/api/collaborators/shared')).json(), []);

  // A shared project this install does not know is 404, itself and on every reader
  const one = await app.inject(`/api/collaborators/shared/${OWNER}/${SHARE}`);
  assert.equal(one.statusCode, 404, one.body);
  assert.equal(one.json().code, 'not-found');
  for (const kind of ['chats', 'memory', 'journal', 'documents', 'work-items', 'artifacts', 'chats/x/transcript', 'chats/x/subagents/a1', `blobs/${SHA}`]) {
    const res = await app.inject(`/api/collaborators/shared/${OWNER}/${SHARE}/${kind}`);
    assert.equal(res.statusCode, 404, `${kind}: ${res.body}`);
  }
  assert.equal((await app.inject(`/api/collaborators/shared/${OWNER}/${SHARE}/blobs/not-a-hash`)).statusCode, 400);
  assert.equal((await app.inject(`/api/collaborators/shared/${OWNER}/${SHARE}/chats/x/transcript?limit=-1`)).statusCode, 400);
  assert.equal((await app.inject(`/api/collaborators/shared/${OWNER}/${SHARE}/chats/x/subagents/a1?before=x`)).statusCode, 400);
});

test("a project's sharing: the default key, an edited one, and 409 when another project holds it", async (t) => {
  const { app } = await wrapper(t);
  const first = await project(app, 'one');
  const second = await project(app, 'two');

  const sharing = (await app.inject(`/api/projects/${first}/sharing`)).json() as ProjectSharing;
  assert.equal(sharing.projectId, first);
  assert.deepEqual(sharing.groups, []);
  assert.match(sharing.shareId, /^[0-9a-f]{32}$/);
  assert.equal(sharing.keyInUse, null);

  const edited = await app.inject({ method: 'PUT', url: `/api/projects/${first}/sharing`, ...json({ shareKey: 'github.com/acme/api' }) });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal((edited.json() as ProjectSharing).shareKey, 'github.com/acme/api');
  assert.equal((edited.json() as ProjectSharing).edited, true);

  const taken = await app.inject({ method: 'PUT', url: `/api/projects/${second}/sharing`, ...json({ shareKey: 'github.com/acme/api' }) });
  assert.equal(taken.statusCode, 409, taken.body);
  const body = taken.json() as ShareKeyInUseError;
  assert.equal(body.code, 'share-key-in-use');
  assert.equal(body.projectId, first);
  assert.equal(body.projectName, 'one');

  assert.equal((await app.inject({ method: 'PUT', url: `/api/projects/${second}/sharing`, ...json({ shareKey: 'Not A Key!' }) })).statusCode, 400);
  assert.equal((await app.inject('/api/projects/ghost/sharing')).statusCode, 404);
});

test('turned on: a group is created, listed and invited to, and the change is announced', { skip: irohError ? `@number0/iroh does not load here: ${irohError}` : false }, async (t) => {
  const { app, core } = await wrapper(t);
  const events: string[] = [];
  t.after(core.events.subscribe((event) => events.push(event.type)));

  const on = await app.inject({ method: 'PUT', url: '/api/collaborators', ...json({ enabled: true, displayName: 'Ana' }) });
  assert.equal(on.statusCode, 200, on.body);
  const status = on.json() as CollaboratorsStatus;
  assert.equal(status.settings.enabled, true);
  assert.match(status.endpointId ?? '', /^[0-9a-f]{64}$/);
  assert.ok(events.includes('collaborators.changed'));

  const created = await app.inject({ method: 'POST', url: '/api/collaborators/groups', ...json({ name: 'Backend' }) });
  assert.equal(created.statusCode, 201, created.body);
  const groupId = created.json().id as string;
  assert.equal(created.json().isOwner, true);
  assert.equal(((await app.inject('/api/collaborators/groups')).json() as GroupList).groups[0]?.name, 'Backend');
  assert.equal((await app.inject({ method: 'POST', url: '/api/collaborators/groups', ...json({ name: '' }) })).statusCode, 400);

  // The invite waits for the endpoint to be bound
  let invite: GroupInvite | null = null;
  for (const deadline = Date.now() + 20_000; !invite && Date.now() < deadline; ) {
    const res = await app.inject({ method: 'POST', url: `/api/collaborators/groups/${groupId}/invites` });
    if (res.statusCode === 201) invite = res.json() as GroupInvite;
    else {
      assert.equal(res.json().code, 'not-ready', res.body);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.ok(invite, 'the endpoint never bound');
  assert.equal(invite.groupName, 'Backend');

  // An install cannot join with its own invite, and a damaged one is 400
  assert.equal((await app.inject({ method: 'POST', url: '/api/collaborators/join', ...json({ invite: invite.text }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/collaborators/join', ...json({ invite: 'garbage' }) })).statusCode, 400);
  assert.deepEqual((await app.inject(`/api/collaborators/groups/${groupId}/join-requests`)).json(), []);

  // The owner of a group with no other member may leave it
  assert.deepEqual((await app.inject({ method: 'DELETE', url: `/api/collaborators/groups/${groupId}` })).json(), { ok: true });
  assert.deepEqual(((await app.inject('/api/collaborators/groups')).json() as GroupList).groups, []);

  const off = await app.inject({ method: 'PUT', url: '/api/collaborators', ...json({ enabled: false }) });
  assert.equal((off.json() as CollaboratorsStatus).connection, 'off');
});

test("a copied transcript is paged as entries, newest last, without subagents' lines", () => {
  const line = (n: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'user', uuid: `u${n}`, timestamp: '2026-10-16T09:00:00.000Z', message: { role: 'user', content: `message ${n}` }, ...extra });
  const lines = [line(0), '{torn', line(1, { isSidechain: true }), JSON.stringify({ type: 'summary', summary: 'x' }), line(2), line(3), line(4)];

  const tail = transcriptPage('c', lines, true, { limit: 2 });
  assert.equal(tail.total, 4);
  assert.equal(tail.from, 2);
  assert.equal(tail.live, true);
  assert.deepEqual(tail.entries.map((e) => e.uuid), ['u3', 'u4']);

  const earlier = transcriptPage('c', lines, false, { limit: 2, before: tail.from });
  assert.equal(earlier.from, 0);
  assert.deepEqual(earlier.entries.map((e) => e.uuid), ['u0', 'u2']);
  assert.deepEqual(transcriptPage('c', lines, false, { before: 0 }).entries, []);
});

test("a copied subagent's transcript is read whole: every line of it is a sidechain", () => {
  const line = (n: number) =>
    JSON.stringify({ type: 'assistant', uuid: `s${n}`, isSidechain: true, timestamp: '2026-10-16T09:00:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: `step ${n}` }] } });
  const lines = [line(0), '{torn', line(1), line(2)];
  const page = transcriptPage('c', lines, false, { agent: true, limit: 2 });
  assert.equal(page.total, 3);
  assert.deepEqual(page.entries.map((e) => e.uuid), ['s1', 's2']);
  // Read as a chat's, the same lines are a subagent's and left out
  assert.equal(transcriptPage('c', lines, false).total, 0);
});
