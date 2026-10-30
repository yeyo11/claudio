import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig, type CoreConfig } from '@claudio/core';
import type { ChatSummary } from '@claudio/shared';
import { buildApp } from '../src/app.ts';

// The listings of docs/plans/regression-fixes-2026-10-29.md (C7): the chat list a page at a time,
// a project's chats filtered before anything is assembled, and the overview read once for every
// caller until something it shows changes. No CLI is ever started: the binary does not exist.
let app: FastifyInstance;
let core: Core;
let config: CoreConfig;
let projectId: string;

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

/** A transcript the CLI would have written for a session in `cwd`, last active at `at`. */
function transcript(id: string, cwd: string, at: string): void {
  const dir = join(config.projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'user', uuid: `${id}-1`, timestamp: '2026-01-01T09:00:00.000Z', cwd, message: { role: 'user', content: `Task ${id}` } },
    { type: 'assistant', uuid: `${id}-2`, timestamp: at, cwd, message: { id: `m-${id}`, role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Done' }] } },
  ];
  writeFileSync(join(dir, `${id}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

before(async () => {
  const root = mkdtempSync(join(tmpdir(), 'claudio-listing-'));
  config = loadConfig({
    CLAUDE_BIN: '/nonexistent/claude',
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
    CLAUDIO_DATA_DIR: join(root, 'data'),
  });
  core = new Core(config);
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  const res = await app.inject({ method: 'POST', url: '/api/projects', ...json({ name: 'listed' }) });
  assert.equal(res.statusCode, 201);
  const project = res.json<{ id: string; path: string }>();
  projectId = project.id;
  // Two chats in the project, five outside it; two of them at the same instant, which the id orders
  mkdirSync(join(project.path, 'src'), { recursive: true });
  transcript('00000000-0000-4000-8000-000000000001', project.path, '2026-01-01T10:00:00.000Z');
  transcript('00000000-0000-4000-8000-000000000002', join(project.path, 'src'), '2026-01-03T10:00:00.000Z');
  for (let i = 3; i <= 7; i++) transcript(`00000000-0000-4000-8000-00000000000${String(i)}`, join(root, 'loose', String(i)), i === 4 ? '2026-01-05T10:00:00.000Z' : `2026-01-0${String(i)}T10:00:00.000Z`);
});

after(async () => {
  await app.close();
  await core.shutdown();
});

test('the chat list is read a page at a time, and the pages put together are the whole list in its order', async () => {
  const whole = (await app.inject('/api/chats?limit=1000')).json<ChatSummary[]>();
  assert.equal(whole.length, 7);
  const ids: string[] = [];
  let url = '/api/chats?limit=3';
  for (let pages = 0; ; pages++) {
    assert.ok(pages < 5, 'the pages end');
    const res = await app.inject(url);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-total-count'], '7');
    const page = res.json<ChatSummary[]>();
    ids.push(...page.map((c) => c.id));
    const next = res.headers['x-next-cursor'];
    if (next === undefined) break;
    // The cursor a client builds from the last chat it holds is the one the server sends
    const last = page.at(-1);
    assert.equal(next, `${last?.updatedAt ?? ''}~${last?.id ?? ''}`);
    url = `/api/chats?limit=3&after=${encodeURIComponent(String(next))}`;
  }
  assert.deepEqual(ids, whole.map((c) => c.id));
  // Two chats active at the same instant are told apart by their id, so no page boundary can split or repeat them
  const tied = whole.filter((c) => c.updatedAt === '2026-01-05T10:00:00.000Z').map((c) => c.id);
  assert.deepEqual(tied, [...tied].sort());
  assert.equal(tied.length, 2);
});

test('without a limit the list answers a page of 200, and a cursor it never sent is refused', async () => {
  const res = await app.inject('/api/chats');
  assert.equal(res.json<ChatSummary[]>().length, 7);
  assert.equal(res.headers['x-next-cursor'], undefined);
  assert.equal((await app.inject('/api/chats?after=nothing')).statusCode, 400);
});

test("a project's list holds its chats, wherever in the project they ran", async () => {
  const res = await app.inject(`/api/chats?project=${projectId}`);
  assert.equal(res.headers['x-total-count'], '2');
  assert.deepEqual(
    res.json<ChatSummary[]>().map((c) => c.id),
    ['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001'],
  );
  const projects = (await app.inject('/api/projects')).json<Array<{ id: string; chatCount: number }>>();
  assert.equal(projects.find((p) => p.id === projectId)?.chatCount, 2, 'the project list counts what its page lists');
});

test("the overview's chats are read once for every caller until an event says what they show changed", async () => {
  let reads = 0;
  const glance = core.chats.glance.bind(core.chats);
  core.chats.glance = (...args) => {
    reads += 1;
    return glance(...args);
  };
  core.events.emit({ type: 'sessions.changed', title: 'Sessions changed' });
  const first = await core.overview();
  assert.equal(first.counts.chats, 7);
  assert.equal(first.recentChats[0]?.id, '00000000-0000-4000-8000-000000000007');
  assert.equal(first.counts.backgroundTasks + first.counts.subagents + first.counts.workflows, 0, 'nothing runs');
  await core.overview();
  assert.equal(reads, 1, 'a second caller within two seconds shares the reading');

  // What a chat is doing this second is not something the overview shows
  core.events.emit({ type: 'chat.activity', title: 'x is thinking', runId: 'x', runName: 'x', sessionId: 'x', orchestrationId: null, internal: false, taskId: null, activity: null });
  await core.overview();
  assert.equal(reads, 1);

  core.events.emit({ type: 'sessions.changed', title: 'Sessions changed' });
  assert.equal((await core.overview()).counts.chats, 7);
  assert.equal(reads, 2);
});
