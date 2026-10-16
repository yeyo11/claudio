import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { ChatSummary, Lesson, LessonJob, LessonList, LessonSettings, MemoryProposal, MemoryProposalPreview, Project } from '@claudio/shared';
import { Core, loadConfig } from '@claudio/core';
import { buildApp } from '../src/app.ts';

// The lesson routes over a real core with scratch dirs. Chats are the core tests' fake CLI, so a
// manual mining job may run its miner against it; nothing here reads the real ~/.claude.
const FAKE_CLAUDE = fileURLToPath(new URL('../../../packages/core/test/fixtures/fake-claude.mjs', import.meta.url));

let app: FastifyInstance;
let core: Core;
let root: string;

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

async function importProject(name: string, modules: string[]): Promise<Project & { dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'claudio-api-lessons-project-'));
  const res = await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path: dir, name, modules }) });
  assert.equal(res.statusCode, 201, res.body);
  return { ...res.json<Project>(), dir };
}

let signals = 0;
const candidate = (trigger: string, action: string) => ({
  trigger,
  action,
  signals: ['s1'],
  quote: 'no, not like that',
  confidence: 0.6,
  restates: null,
  contradicts: null,
  instructions: 'none' as const,
  mechanical: false,
});

/** A lesson the miner proposed: `proposed` until the person approves its proposal */
function propose(projectId: string, trigger: string, action: string): { lesson: Lesson; proposal: MemoryProposal } {
  signals += 1;
  const evidence = new Map([['s1', { signal: 'correction' as const, quote: 'no, not like that', context: 'Edit src/cart.ts', chatId: 'c1', entryUuid: `u${String(signals)}`, at: new Date().toISOString() }]]);
  core.lessons.createFromCandidates([candidate(trigger, action)], { projectId, chatId: 'c1', chatTitle: 'Fix the cart', evidence });
  const proposal = core.memoryProposals.list(projectId).find((p) => p.status === 'pending' && p.lesson?.trigger === trigger);
  assert.ok(proposal?.lesson, 'the candidate became a proposal');
  return { lesson: proposal.lesson, proposal };
}

/** An active lesson, approved as the person would through the route */
async function activeLesson(projectId: string, trigger: string, action: string): Promise<Lesson> {
  const { proposal } = propose(projectId, trigger, action);
  const res = await app.inject({ method: 'POST', url: `/api/memory-proposals/${proposal.id}/approve`, ...json({}) });
  assert.equal(res.statusCode, 200, res.body);
  const lesson = res.json<MemoryProposal>().lesson;
  assert.ok(lesson);
  assert.equal(lesson.status, 'active');
  return lesson;
}

const get = <T>(url: string) => app.inject(url).then((r) => r.json<T>());
const post = (url: string, body?: unknown) => app.inject({ method: 'POST', url, ...(body === undefined ? {} : json(body)) });

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'claudio-api-lessons-'));
  core = new Core(
    loadConfig({
      CLAUDE_BIN: FAKE_CLAUDE,
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
    }),
  );
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
});

after(async () => {
  await app.close();
  core.shutdown();
});

test('a project lists its lessons by status, and a bad status or project is refused', async () => {
  const project = await importProject('Lists', ['memory']);
  const base = `/api/projects/${project.id}/lessons`;
  const empty = await get<LessonList>(base);
  assert.deepEqual(empty.lessons, []);
  assert.equal(empty.handed.lessons, 0);

  const waiting = propose(project.id, 'When editing the cart', 'Keep totals in cents').lesson;
  assert.deepEqual((await get<LessonList>(base)).lessons, [], 'a proposed lesson is not active');
  assert.deepEqual((await get<LessonList>(`${base}?status=proposed`)).lessons.map((l) => l.id), [waiting.id]);
  assert.deepEqual((await get<LessonList>(`${base}?status=all`)).lessons.map((l) => l.id), [waiting.id]);

  const active = await activeLesson(project.id, 'When writing tests', 'Name them after the behaviour');
  const listed = await get<LessonList>(base);
  assert.deepEqual(listed.lessons.map((l) => l.id), [active.id]);
  assert.equal(listed.handed.lessons, 1);
  assert.ok(listed.handed.bytes > 0 && listed.handed.budget >= listed.handed.bytes);

  const bad = await app.inject(`${base}?status=nope`);
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /status must be one of/);
  assert.equal((await app.inject('/api/projects/nope/lessons')).statusCode, 404);

  const one = await app.inject(`/api/lessons/${active.id}`);
  assert.equal(one.statusCode, 200);
  assert.equal(one.json<Lesson>().key, active.key);
  assert.equal((await app.inject('/api/lessons/nope')).statusCode, 404);
});

test('the export is every lesson of every status as a download, and its jobs are paged', async () => {
  const project = await importProject('Export', ['memory']);
  propose(project.id, 'When exporting', 'Waits for the person');
  const active = await activeLesson(project.id, 'When importing', 'Never read lessons in');
  await post(`/api/lessons/${active.id}/retire`);

  const res = await app.inject(`/api/projects/${project.id}/lessons/export`);
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-disposition']), /^attachment; filename=".*\.json"$/);
  assert.deepEqual(res.json<Lesson[]>().map((l) => l.status).sort(), ['proposed', 'retired']);
  assert.equal((await app.inject('/api/projects/nope/lessons/export')).statusCode, 404);

  const jobs = `/api/projects/${project.id}/lessons/jobs`;
  assert.deepEqual(await get<LessonJob[]>(jobs), []);
  assert.equal((await app.inject(`${jobs}?limit=0`)).statusCode, 400);
  assert.equal((await app.inject(`${jobs}?limit=many`)).statusCode, 400);
  assert.equal((await app.inject(`${jobs}?limit=500`)).statusCode, 200, 'above 100 is brought down');
  assert.equal((await app.inject('/api/projects/nope/lessons/jobs')).statusCode, 404);
});

test('a lesson is edited, pinned, confirmed, retired, restored and deleted, with the errors of each', async () => {
  const project = await importProject('Changes', ['memory']);
  const lesson = await activeLesson(project.id, 'When naming files', 'Use kebab-case');
  const url = `/api/lessons/${lesson.id}`;

  const edited = await app.inject({ method: 'PATCH', url, ...json({ action: 'Use kebab-case for every file' }) });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal(edited.json<Lesson>().action, 'Use kebab-case for every file');
  const pinned = await app.inject({ method: 'PATCH', url, ...json({ pinned: true }) });
  assert.equal(pinned.json<Lesson>().pinned, true);
  assert.equal((await app.inject({ method: 'PATCH', url, ...json({}) })).statusCode, 400, 'nothing to change');
  assert.equal((await app.inject({ method: 'PATCH', url, ...json({ trigger: 'x'.repeat(400) }) })).statusCode, 400, 'the validator refuses it');
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/lessons/nope', ...json({ pinned: true }) })).statusCode, 404);

  assert.equal((await post(`${url}/confirm`)).statusCode, 200);
  assert.equal((await post('/api/lessons/nope/confirm')).statusCode, 404);

  assert.equal((await post(`${url}/restore`)).statusCode, 409, 'it is not retired');
  const retired = await post(`${url}/retire`, { reason: 'obsolete' });
  assert.equal(retired.statusCode, 200, retired.body);
  assert.equal(retired.json<Lesson>().status, 'retired');
  assert.equal((await post(`${url}/retire`)).statusCode, 409);
  assert.equal((await post(`${url}/confirm`)).statusCode, 409);
  assert.equal((await app.inject({ method: 'PATCH', url, ...json({ pinned: false }) })).statusCode, 409, 'only an active lesson is edited');
  assert.equal((await post('/api/lessons/nope/retire')).statusCode, 404);
  assert.equal((await post('/api/lessons/nope/restore')).statusCode, 404);
  const restored = await post(`${url}/restore`);
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal(restored.json<Lesson>().status, 'active');

  const deleted = await app.inject({ method: 'DELETE', url });
  assert.deepEqual(deleted.json(), { ok: true });
  assert.equal((await app.inject(url)).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url })).statusCode, 404);

  const waiting = propose(project.id, 'When waiting', 'Stay proposed').lesson;
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/lessons/${waiting.id}` })).statusCode, 409, 'a proposed lesson is rejected, not deleted');
});

test('every change needs the Memory module on, and a read does not', async () => {
  const project = await importProject('Switched', ['memory']);
  const lesson = await activeLesson(project.id, 'When the module is off', 'Reads still work');
  await app.inject({ method: 'PATCH', url: `/api/projects/${project.id}`, ...json({ modules: [] }) });
  assert.equal((await app.inject(`/api/lessons/${lesson.id}`)).statusCode, 200);
  assert.equal((await app.inject(`/api/projects/${project.id}/lessons`)).statusCode, 200);
  const off = await app.inject({ method: 'PATCH', url: `/api/lessons/${lesson.id}`, ...json({ pinned: true }) });
  assert.equal(off.statusCode, 409);
  assert.match(off.json().error, /Memory module is off/);
  assert.equal((await post(`/api/lessons/${lesson.id}/instructions`, {})).statusCode, 409);
  assert.equal((await post(`/api/lessons/${lesson.id}/retire`)).statusCode, 409);
});

test('a lesson is promoted to a global one and demoted back', async () => {
  const project = await importProject('Promote', ['memory']);
  const lesson = await activeLesson(project.id, 'When promoting', 'Say it everywhere');
  const promoted = await post(`/api/lessons/${lesson.id}/promote`);
  assert.equal(promoted.statusCode, 200, promoted.body);
  const global = promoted.json<Lesson>();
  assert.equal(global.projectId, null);
  assert.equal(global.promotedFrom, lesson.id);

  const globals = await get<LessonList>('/api/lessons/global');
  assert.ok(globals.lessons.some((l) => l.id === global.id));
  assert.ok((await get<LessonList>('/api/lessons/global?status=all')).lessons.some((l) => l.id === global.id));
  assert.equal((await app.inject('/api/lessons/global?status=nope')).statusCode, 400);
  assert.equal((await post(`/api/lessons/${global.id}/promote`)).statusCode, 409, 'a global lesson is not a project one');
  assert.equal((await post(`/api/lessons/${lesson.id}/promote`)).statusCode, 409, 'it was superseded by its global copy');
  assert.equal((await post('/api/lessons/nope/promote')).statusCode, 404);

  assert.equal((await post(`/api/lessons/${global.id}/demote`, { projectId: 42 })).statusCode, 400);
  assert.equal((await post('/api/lessons/nope/demote', {})).statusCode, 404);
  const demoted = await post(`/api/lessons/${global.id}/demote`, {});
  assert.equal(demoted.statusCode, 200, demoted.body);
  assert.equal(demoted.json<Lesson>().projectId, project.id);
  assert.equal((await post(`/api/lessons/${demoted.json<Lesson>().id}/demote`, {})).statusCode, 409, 'a project lesson cannot be demoted');
});

test('a lesson goes to CLAUDE.md through a proposal with a preview, and approving it needs the preview', async () => {
  const project = await importProject('Instructions', ['memory']);
  const lesson = await activeLesson(project.id, 'When adding routes', 'Document each in the README');
  const made = await post(`/api/lessons/${lesson.id}/instructions`, { section: 'Routes' });
  assert.equal(made.statusCode, 201, made.body);
  const proposal = made.json<MemoryProposal>();
  assert.equal(proposal.target.kind, 'instructions');
  assert.equal(proposal.lessonId, lesson.id);
  assert.equal((await post(`/api/lessons/${lesson.id}/instructions`, {})).statusCode, 409, 'one is waiting already');
  assert.equal((await post(`/api/lessons/${lesson.id}/instructions`, { section: 3 })).statusCode, 400);
  assert.equal((await post('/api/lessons/nope/instructions', {})).statusCode, 404);

  const preview = await post(`/api/memory-proposals/${proposal.id}/preview`, {});
  assert.equal(preview.statusCode, 200, preview.body);
  const shown = preview.json<MemoryProposalPreview>();
  assert.equal(shown.path, 'CLAUDE.md');
  assert.equal(shown.exists, false);
  assert.match(shown.diff, /\+- When adding routes/);
  const edited = await post(`/api/memory-proposals/${proposal.id}/preview`, { text: '- When adding routes: write the README row first' });
  assert.match(edited.json<MemoryProposalPreview>().diff, /README row first/);
  assert.equal((await post('/api/memory-proposals/nope/preview', {})).statusCode, 404);

  const unseen = await post(`/api/memory-proposals/${proposal.id}/approve`, {});
  assert.equal(unseen.statusCode, 400, 'the diff has to be seen first');
  const approved = await post(`/api/memory-proposals/${proposal.id}/approve`, { previewOf: shown.sha256 });
  assert.equal(approved.statusCode, 200, approved.body);
  assert.equal((await get<Lesson>(`/api/lessons/${lesson.id}`)).status, 'retired');

  // A proposal that is not for CLAUDE.md has no diff
  const other = propose(project.id, 'When previewing', 'Only instructions have a diff').proposal;
  assert.equal((await post(`/api/memory-proposals/${other.id}/preview`, {})).statusCode, 400);

  // The lesson that is not active cannot be proposed
  assert.equal((await post(`/api/lessons/${lesson.id}/instructions`, {})).statusCode, 409);
});

test('a proposal outlives its project: the preview says the project is not imported', async () => {
  const project = await importProject('Gone', ['memory']);
  const lesson = await activeLesson(project.id, 'When the project goes', 'The preview refuses');
  const proposal = (await post(`/api/lessons/${lesson.id}/instructions`, {})).json<MemoryProposal>();
  const removed = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}` });
  assert.equal(removed.statusCode, 200, removed.body);
  const res = await post(`/api/memory-proposals/${proposal.id}/preview`, {});
  assert.ok(res.statusCode === 409 || res.statusCode === 404, res.body);
  if (res.statusCode === 409) assert.match(res.json().error, /not imported/);
});

test('rejecting a lesson proposal rejects the lesson, and a stale lesson approval is refused', async () => {
  const project = await importProject('Reject', ['memory']);
  const { lesson, proposal } = propose(project.id, 'When rejecting', 'Never proposed again');
  const rejected = await post(`/api/memory-proposals/${proposal.id}/reject`, { reason: 'not a rule' });
  assert.equal(rejected.statusCode, 200, rejected.body);
  assert.equal((await get<Lesson>(`/api/lessons/${lesson.id}`)).status, 'rejected');
  assert.equal((await post(`/api/memory-proposals/${proposal.id}/approve`, {})).statusCode, 409);

  const next = propose(project.id, 'When merging', 'Needs a real target');
  assert.equal((await post(`/api/memory-proposals/${next.proposal.id}/approve`, { mergeInto: 'nope' })).statusCode, 404);
  assert.equal((await get<Lesson>(`/api/lessons/${next.lesson.id}`)).status, 'proposed', 'a refused approval leaves it proposed');
});

test('the settings are read with defaults, changed in part and checked for range', async () => {
  const before = await get<LessonSettings>('/api/lessons/settings');
  assert.equal(before.manualMining, true);
  const changed = await app.inject({ method: 'PUT', url: '/api/lessons/settings', ...json({ caps: { perChatMinMinutes: 45 } }) });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json<LessonSettings>().caps.perChatMinMinutes, 45);
  assert.equal(changed.json<LessonSettings>().miner.model, before.miner.model, 'the rest is kept');
  assert.equal((await get<LessonSettings>('/api/lessons/settings')).caps.perChatMinMinutes, 45);
  const bad = await app.inject({ method: 'PUT', url: '/api/lessons/settings', ...json({ miner: { maxCostUsd: 50 } }) });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /maxCostUsd/);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/lessons/settings', ...json({ caps: 3 }) })).statusCode, 400);
  await app.inject({ method: 'PUT', url: '/api/lessons/settings', ...json({ caps: { perChatMinMinutes: before.caps.perChatMinMinutes } }) });
});

test('looking for lessons by hand answers 202 and refuses a chat that cannot be mined', async () => {
  const project = await importProject('Mine', ['memory']);
  const quiet = await importProject('Quiet', []);
  const start = async (cwd: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/chats', ...json({ prompt: 'hello', cwd }) });
    assert.equal(res.statusCode, 201, res.body);
    return res.json<ChatSummary>().id;
  };
  const chatId = await start(project.dir);
  const url = (id: string) => `/api/chats/${id}/lessons/mine`;

  assert.equal((await post(url('nope'))).statusCode, 404);
  const loose = await start(mkdtempSync(join(tmpdir(), 'claudio-api-lessons-loose-')));
  assert.equal((await post(url(loose))).statusCode, 409, 'a chat outside a project');
  const memoryOff = await post(url(await start(quiet.dir)));
  assert.equal(memoryOff.statusCode, 409);
  assert.match(memoryOff.json().error, /Memory module is off/);

  // An open job for the chat: the same work, refused
  const insert = (id: string, status: string, trigger: string) =>
    core.db.connection
      .prepare('INSERT INTO lesson_jobs (id, project_id, chat_id, trigger, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, project.id, chatId, trigger, status, new Date().toISOString());
  insert('open-job', 'queued', 'run-ended');
  assert.equal((await post(url(chatId))).statusCode, 409);
  core.db.connection.prepare("UPDATE lesson_jobs SET status = 'done' WHERE id = 'open-job'").run();

  // A hand-started job less than ten minutes ago: 429
  insert('recent-job', 'done', 'manual');
  const limited = await post(url(chatId));
  assert.equal(limited.statusCode, 429);
  assert.match(limited.json().error, /10 minutes/);
  core.db.connection.prepare("DELETE FROM lesson_jobs WHERE id IN ('open-job', 'recent-job')").run();

  // The day's cap
  await app.inject({ method: 'PUT', url: '/api/lessons/settings', ...json({ caps: { perProjectDailyJobs: 0 } }) });
  const capped = await post(url(chatId));
  assert.equal(capped.statusCode, 429);
  assert.match(capped.json().error, /cap/);

  // The switch
  await app.inject({ method: 'PUT', url: '/api/lessons/settings', ...json({ caps: { perProjectDailyJobs: 20 }, manualMining: false }) });
  assert.equal((await post(url(chatId))).statusCode, 409);
  await app.inject({ method: 'PUT', url: '/api/lessons/settings', ...json({ manualMining: true }) });

  const started = await post(url(chatId));
  assert.equal(started.statusCode, 202, started.body);
  const job = started.json<LessonJob>();
  assert.equal(job.trigger, 'manual');
  assert.equal(job.chatId, chatId);
  assert.equal(job.projectId, project.id);
  assert.ok((await get<LessonJob[]>(`/api/projects/${project.id}/lessons/jobs`)).some((j) => j.id === job.id));
  core.lessonQueue.stop();
});
