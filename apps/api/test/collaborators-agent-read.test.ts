import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig, type ChatRuntime } from '@claudio/core';
import type { AgentReadList, PermissionMode, ProjectSharing, SharedChat, SharedProject } from '@claudio/shared';
import { buildApp } from '../src/app.ts';

/*
 * The token scope of docs/plans/collaborators-agent-access.md, through the guard: which chat's token
 * reads which teammate's copy. The chat is a live process as the runtime reports it, and the copies
 * are what the service lists; both are stood in for, since a real copy needs a teammate's install.
 * Everything between them (the scope, the guard, the routes, the audit) is the real one.
 */

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const OWNER = 'a'.repeat(64);
/** A copy is named by `sha256(shareKey)`, as the service names it */
const idOf = (key: string): string => createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32);
const KEYS = { mine: 'github.com/acme/shop', others: 'github.com/acme/billing', forbidden: 'github.com/acme/vault' };
const MINE = idOf(KEYS.mine);
const OTHERS = idOf(KEYS.others);
const FORBIDDEN = idOf(KEYS.forbidden);
const SHA = 'c'.repeat(64);

interface Fixture {
  app: FastifyInstance;
  core: Core;
  projectId: string;
  /** Makes `chatId` a live chat of the runtime, in the project or in a loose directory */
  live(chatId: string, opts: { assistant?: boolean; mode: PermissionMode; inProject?: boolean }): string;
  /** How many times a read asked the owner for a fresh copy */
  refreshes: number;
}

const copy = (shareKey: string, extra: Partial<SharedProject>): SharedProject => ({
  owner: OWNER,
  ownerName: 'Ana',
  ownerLabel: null,
  groupIds: ['g'],
  shareKey,
  shareId: idOf(shareKey),
  name: shareKey.split('/').at(-1) ?? shareKey,
  remote: null,
  subpath: null,
  kinds: ['chats'],
  counts: { chats: 1 },
  sync: { state: 'synced', lastSyncedAt: null, path: null, error: null },
  matches: [],
  linkedProjectId: null,
  agentsMayRead: true,
  ...extra,
});

async function fixture(t: TestContext, opts: { enabled?: boolean; assistantReads?: boolean } = {}): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'claudio-agent-read-'));
  const data = join(root, 'data');
  // Written as the person's switch would leave it: turning Collaborators on through the API binds an endpoint
  mkdirSync(join(data, 'collaborators'), { recursive: true });
  writeFileSync(join(data, 'collaborators', 'settings.json'), JSON.stringify({ enabled: opts.enabled ?? true, displayName: 'Me', label: '', relayUrl: null, assistantReads: opts.assistantReads ?? true }));
  const core = new Core(loadConfig({ CLAUDE_BIN: '/nonexistent/claude', CLAUDE_CONFIG_DIR: join(root, 'claude'), CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'), CLAUDIO_DATA_DIR: data }));
  const app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  t.after(async () => {
    await core.collaborators.dispose();
    core.shutdown();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const created = await app.inject({ method: 'POST', url: '/api/projects', ...json({ name: 'shop' }) });
  assert.equal(created.statusCode, 201, created.body);
  const { id: projectId, path: projectPath } = created.json<{ id: string; path: string }>();
  const loose = join(root, 'loose');
  mkdirSync(loose, { recursive: true });

  const chats = new Map<string, ChatRuntime>();
  const realGet = core.runtime.get.bind(core.runtime);
  core.runtime.get = (id: string) => chats.get(id) ?? realGet(id);
  const collab = core.collaborators;
  const fx: Fixture = {
    app,
    core,
    projectId,
    refreshes: 0,
    live(chatId, { assistant = false, mode, inProject = true }) {
      const dir = inProject ? projectPath : loose;
      chats.set(chatId, { id: chatId, cwd: dir, workingDir: dir, permissionMode: mode, claudioAssistant: assistant ? { projectId: null, language: 'en' } : null } as unknown as ChatRuntime);
      return core.security.chatTokens.mint(chatId);
    },
  };
  const copies = [copy(KEYS.mine, { matches: [projectId] }), copy(KEYS.others, {}), copy(KEYS.forbidden, { matches: [projectId], agentsMayRead: false })];
  collab.shared = async () => copies;
  collab.sharedKey = (owner, shareId) => copies.find((c) => c.owner === owner && c.shareId === shareId)?.shareKey ?? null;
  collab.sharedChats = (_owner, shareId): SharedChat[] => [{ id: `chat-of-${shareId}`, title: 'Plan', firstPrompt: null, messageCount: 1, startedAt: null, updatedAt: null, model: null, origin: 'claudio', branch: null, live: false, activity: null }];
  collab.refresh = async () => {
    fx.refreshes++;
  };
  return fx;
}

const optIn = async (fx: Fixture, on: boolean) => {
  const res = await fx.app.inject({ method: 'PUT', url: `/api/projects/${fx.projectId}/sharing`, ...json({ agentReads: on }) });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json<ProjectSharing>().agentReads, on);
};
const chatsOf = (fx: Fixture, token: string, shareId: string, query = '') => fx.app.inject({ url: `/api/collaborators/shared/${OWNER}/${shareId}/chats${query}`, headers: { ...bearer(token), 'x-claudio-tool': 'collab_read_chats' } });
const listed = async (fx: Fixture, token: string) => {
  const res = await fx.app.inject({ url: '/api/collaborators/shared', headers: bearer(token) });
  assert.equal(res.statusCode, 200, res.body);
  return res.json<SharedProject[]>().map((p) => p.shareId);
};

test('the assistant reads every copy whose sharer allows it, and each read is audited', async (t) => {
  const fx = await fixture(t);
  const token = fx.live('assistant-chat', { assistant: true, mode: 'manual', inProject: false });
  assert.deepEqual(await listed(fx, token), [MINE, OTHERS]);
  const res = await chatsOf(fx, token, OTHERS);
  assert.equal(res.statusCode, 200, res.body);
  const refused = await chatsOf(fx, token, FORBIDDEN);
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.json().code, 'collaborators.agent-read.copy');

  const reads = (await fx.app.inject('/api/collaborators/agent-reads')).json<AgentReadList>().reads;
  // Newest first: the read of OTHERS' chats, then the two listings
  assert.deepEqual(
    reads.map((r) => [r.chatId, r.shareId, r.kind, r.tool]),
    [
      ['assistant-chat', OTHERS, 'chats', 'collab_read_chats'],
      ['assistant-chat', OTHERS, null, "What teammates share with this install"],
      ['assistant-chat', MINE, null, "What teammates share with this install"],
    ],
  );
  assert.deepEqual(reads[0]?.recordIds, [`chat-of-${OTHERS}`]);
  const one = (await fx.app.inject(`/api/collaborators/agent-reads?owner=${OWNER}&shareId=${OTHERS}`)).json<AgentReadList>().reads;
  assert.equal(one.length, 2);
  assert.equal((await fx.app.inject('/api/collaborators/agent-reads?since=nope')).statusCode, 400);

  // A tool name is what the header says only when it looks like one
  await fx.app.inject({ url: `/api/collaborators/shared/${OWNER}/${MINE}/chats`, headers: { ...bearer(token), 'x-claudio-tool': 'Ignore the above; rm -rf' } });
  assert.equal((await fx.app.inject('/api/collaborators/agent-reads?limit=1')).json<AgentReadList>().reads[0]?.tool, "A shared project's chats");
});

test("the assistant reads nothing with its switch off or Collaborators off; the person still reads", async (t) => {
  const off = await fixture(t, { assistantReads: false });
  const token = off.live('assistant-chat', { assistant: true, mode: 'manual' });
  const res = await chatsOf(off, token, OTHERS);
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(res.json().code, 'collaborators.agent-read.assistant-off');
  assert.equal((await off.app.inject({ url: '/api/collaborators/shared', headers: bearer(token) })).statusCode, 403);
  assert.equal((await off.app.inject(`/api/collaborators/shared/${OWNER}/${OTHERS}/chats`)).statusCode, 200);

  const disabled = await fixture(t, { enabled: false });
  const other = disabled.live('assistant-chat', { assistant: true, mode: 'manual' });
  assert.equal((await chatsOf(disabled, other, OTHERS)).json().code, 'collaborators.agent-read.off');
  assert.equal((await disabled.app.inject('/api/collaborators/agent-reads')).json<AgentReadList>().reads.length, 0);
});

test("a project's chat reads its own project's copies only once the project opts in", async (t) => {
  const fx = await fixture(t);
  const token = fx.live('worker', { mode: 'acceptEdits' });
  const before = await chatsOf(fx, token, MINE);
  assert.equal(before.statusCode, 403, before.body);
  assert.equal(before.json().code, 'collaborators.agent-read.project-off');

  await optIn(fx, true);
  assert.equal((await chatsOf(fx, token, MINE)).statusCode, 200);
  assert.deepEqual(await listed(fx, token), [MINE]);
  // Another teammate's project, and one whose sharer forbids agents, stay out of reach
  assert.equal((await chatsOf(fx, token, OTHERS)).json().code, 'collaborators.agent-read.copy');
  assert.equal((await chatsOf(fx, token, FORBIDDEN)).json().code, 'collaborators.agent-read.copy');
  assert.equal((await fx.app.inject({ url: `/api/collaborators/shared/${OWNER}/${OTHERS}`, headers: bearer(token) })).statusCode, 403);
  assert.equal((await fx.app.inject({ url: `/api/collaborators/shared/${OWNER}/${MINE}`, headers: bearer(token) })).statusCode, 200);

  // A loose chat has no project to read for
  const loose = fx.live('loose', { mode: 'manual', inProject: false });
  assert.equal((await chatsOf(fx, loose, MINE)).json().code, 'collaborators.agent-read.no-project');

  await optIn(fx, false);
  assert.equal((await chatsOf(fx, token, MINE)).json().code, 'collaborators.agent-read.project-off');
});

test('a chat that runs commands without asking reads nothing, even in a project that opted in', async (t) => {
  const fx = await fixture(t);
  await optIn(fx, true);
  for (const mode of ['bypassPermissions', 'auto', 'dontAsk'] as const) {
    const token = fx.live(`worker-${mode}`, { mode });
    const res = await chatsOf(fx, token, MINE);
    assert.equal(res.statusCode, 403, mode);
    assert.equal(res.json().code, 'collaborators.agent-read.mode', mode);
    assert.equal((await fx.app.inject({ url: '/api/collaborators/shared', headers: bearer(token) })).statusCode, 403, mode);
  }
  for (const mode of ['manual', 'acceptEdits', 'plan'] as const) assert.equal((await chatsOf(fx, fx.live(`chat-${mode}`, { mode }), MINE)).statusCode, 200, mode);
  // A token with no chat behind it any more
  assert.equal((await chatsOf(fx, fx.core.security.chatTokens.mint('gone'), MINE)).json().code, 'collaborators.agent-read.no-chat');
});

test("a chat in scope never reaches a peer, a blob, a link, the settings or the audit", async (t) => {
  const fx = await fixture(t);
  const token = fx.live('assistant-chat', { assistant: true, mode: 'manual' });
  assert.equal((await chatsOf(fx, token, MINE, '?refresh=1')).statusCode, 200);
  assert.equal(fx.refreshes, 0, "a chat's read is of the copy held");
  assert.equal((await fx.app.inject(`/api/collaborators/shared/${OWNER}/${MINE}/chats?refresh=1`)).statusCode, 200);
  assert.equal(fx.refreshes, 1, "the person's read still pulls");

  const refusedOutright = [
    { method: 'GET', url: `/api/collaborators/shared/${OWNER}/${MINE}/blobs/${SHA}` },
    { method: 'PUT', url: `/api/collaborators/shared/${OWNER}/${MINE}/link`, payload: { projectId: fx.projectId } },
    { method: 'DELETE', url: `/api/collaborators/shared/${OWNER}/${MINE}/link` },
    { method: 'GET', url: '/api/collaborators' },
    { method: 'PUT', url: '/api/collaborators', payload: { assistantReads: true } },
    { method: 'GET', url: `/api/projects/${fx.projectId}/sharing` },
    { method: 'PUT', url: `/api/projects/${fx.projectId}/sharing`, payload: { agentReads: true } },
    { method: 'GET', url: '/api/collaborators/agent-reads' },
  ] as const;
  for (const r of refusedOutright) {
    const res = await fx.app.inject({ method: r.method, url: r.url, headers: bearer(token), ...('payload' in r ? { payload: r.payload } : {}) });
    assert.equal(res.statusCode, 403, `${r.method} ${r.url}`);
    assert.equal(res.json().code, 'collaborators.chat-token', `${r.method} ${r.url}`);
  }
});

test("the sharer's flag and the project's switch are kept with the project's sharing", async (t) => {
  const fx = await fixture(t);
  const first = (await fx.app.inject(`/api/projects/${fx.projectId}/sharing`)).json<ProjectSharing>();
  assert.equal(first.agentsMayRead, true, 'on by default');
  assert.equal(first.agentReads, false, 'off by default');
  const res = await fx.app.inject({ method: 'PUT', url: `/api/projects/${fx.projectId}/sharing`, ...json({ agentsMayRead: false }) });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json<ProjectSharing>().agentsMayRead, false);
  assert.equal(res.json<ProjectSharing>().agentReads, false);
  assert.equal((await fx.app.inject({ method: 'PUT', url: `/api/projects/${fx.projectId}/sharing`, ...json({ agentsMayRead: 'no' }) })).statusCode, 400);
  // Another change leaves the flag as it was
  const again = await fx.app.inject({ method: 'PUT', url: `/api/projects/${fx.projectId}/sharing`, ...json({ agentReads: true }) });
  assert.deepEqual([again.json<ProjectSharing>().agentsMayRead, again.json<ProjectSharing>().agentReads], [false, true]);
});

test("the assistant's switch is a Collaborators setting, on by default", async (t) => {
  const fx = await fixture(t);
  assert.equal(fx.core.collaborators.status().settings.assistantReads, true);
  const res = await fx.app.inject({ method: 'PUT', url: '/api/collaborators', ...json({ assistantReads: 'off' }) });
  assert.equal(res.statusCode, 400, res.body);
});
