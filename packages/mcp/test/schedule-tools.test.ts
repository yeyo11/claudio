import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Schedule } from '@claudio/shared';
import { scheduleRows, scheduleRunRows } from '../src/fields.ts';
import { CLAUDIO_MCP_READ_TOOL_NAMES, CLAUDIO_MCP_WRITE_TOOL_NAMES } from '../src/names.ts';
import { ROUTE_DOCS } from '../../../apps/api/src/openapi/routes.ts';
import { seed, type Seeded } from './fixture.ts';

/*
 * The schedule reads against the real API (docs/plans/terminal-menu-schedules-v1-tools.md §2.3). The
 * schedules are made as the person would, over the API: the tools only read them.
 */

let s: Seeded;
before(async () => {
  s = await seed();
});
after(() => s.close());

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

test('the schedule reads are work routes; the writes declare routes that are still the person’s', () => {
  for (const name of ['list_schedules', 'get_schedule_runs', 'preview_schedule'] as const) assert.ok(CLAUDIO_MCP_READ_TOOL_NAMES.includes(name), name);
  // The writes exist (the plan, §2.3) though their routes are person: write-tools.test.ts lists the exception
  assert.deepEqual(CLAUDIO_MCP_WRITE_TOOL_NAMES.filter((n) => n.endsWith('_schedule')), ['create_schedule', 'update_schedule', 'run_schedule']);
  const docs = ROUTE_DOCS as Record<string, { access?: string }>;
  for (const route of ['GET /schedules', 'GET /schedules/:id/runs', 'GET /schedules/preview']) assert.equal(docs[route]?.access ?? 'work', 'work', route);
  // Held here so the day a route becomes work, the exception in write-tools.test.ts is removed
  for (const route of ['POST /schedules', 'PATCH /schedules/:id', 'POST /schedules/:id/run']) assert.equal(docs[route]?.access, 'person', route);
});

test('list_schedules says when each fires and what it starts, with a long prompt cut', async () => {
  const chat = await s.app.inject({
    method: 'POST',
    url: '/api/schedules',
    ...json({ name: 'nightly', cron: '0 3 * * *', timezone: 'UTC', overlap: 'skip', target: { kind: 'chat', chat: { prompt: `tidy ${'x'.repeat(500)}`, cwd: s.project.path, model: 'sonnet' } } }),
  });
  assert.equal(chat.statusCode, 201);
  const orchestration = await s.app.inject({
    method: 'POST',
    url: '/api/schedules',
    ...json({ name: 'weekly review', cron: '0 9 * * 1', timezone: 'UTC', enabled: false, target: { kind: 'orchestration', spec: { name: 'review', cwd: s.project.path, tasks: [{ id: 'a', name: 'a', prompt: 'do it' }, { id: 'b', name: 'b', prompt: 'do it' }] } } }),
  });
  assert.equal(orchestration.statusCode, 201);

  const out = await s.call('list_schedules');
  assert.equal(out.isError, false, out.text);
  const rows = out.json as Array<Record<string, unknown> & { target: Record<string, unknown> }>;
  assert.deepEqual(rows.map((r) => r.name), ['nightly', 'weekly review']);
  const [nightly, weekly] = rows;
  assert.ok(nightly && weekly);
  assert.deepEqual([nightly.cron, nightly.timezone, nightly.enabled, nightly.overlap], ['0 3 * * *', 'UTC', true, 'skip']);
  assert.equal(typeof nightly.nextRunAt, 'string');
  assert.equal(nightly.target.kind, 'chat');
  assert.equal(String(nightly.target.prompt).length, 201, 'the prompt is cut at 200 characters');
  assert.equal(nightly.target.model, 'sonnet');
  assert.deepEqual([weekly.enabled, weekly.target], [false, { kind: 'orchestration', name: 'review', cwd: s.project.path, tasks: 2 }]);
  assert.equal('nextRunAt' in weekly, false, 'a switched-off schedule has no next fire, and null is left out');
  assert.equal('createdAt' in nightly, false);
});

test('get_schedule_runs reads the history of one schedule, 25 rows unless limit says otherwise', async () => {
  const [first] = (await s.call('list_schedules')).json as Array<{ id: string }>;
  assert.ok(first);
  // A run by hand is recorded as a run, whether or not the target could start (no CLI here): the tool reads it
  const ran = await s.app.inject({ method: 'POST', url: `/api/schedules/${first.id}/run` });
  assert.equal(ran.statusCode, 201);

  const from = s.seen.length;
  const out = await s.call('get_schedule_runs', { scheduleId: first.id });
  assert.equal(out.isError, false, out.text);
  assert.equal(new URL(s.seen[from]?.url ?? '').searchParams.get('limit'), '25');
  const runs = out.json as Array<Record<string, unknown>>;
  assert.equal(runs.length, 1);
  assert.deepEqual(Object.keys(runs[0] ?? {}).filter((k) => !['id', 'at', 'status', 'chatId', 'error'].includes(k)), []);
  assert.ok(['started', 'failed'].includes(String(runs[0]?.status)), String(runs[0]?.status));

  await s.call('get_schedule_runs', { scheduleId: first.id, limit: 3 });
  assert.equal(new URL(s.seen.at(-1)?.url ?? '').searchParams.get('limit'), '3');
  const tooMany = await s.call('get_schedule_runs', { scheduleId: first.id, limit: 501 });
  assert.equal(tooMany.isError, true, 'the schema caps the limit before any request');
});

test('preview_schedule says what an expression will do and saves nothing', async () => {
  const before = ((await s.app.inject('/api/schedules')).json() as Schedule[]).length;
  const ok = await s.call('preview_schedule', { cron: '30 8 * * 1-5', timezone: 'Europe/Madrid', count: 3 });
  assert.equal(ok.isError, false, ok.text);
  const preview = ok.json as { valid: boolean; description?: string; timezone: string; next: string[] };
  assert.equal(preview.valid, true);
  assert.equal(preview.timezone, 'Europe/Madrid');
  assert.equal(preview.next.length, 3);
  assert.ok(preview.description && preview.description.length > 0);

  const bad = await s.call('preview_schedule', { cron: 'every day' });
  assert.equal(bad.isError, false, 'an expression that is wrong is an answer, not a failure');
  assert.equal((bad.json as { valid: boolean }).valid, false);
  assert.equal(((await s.app.inject('/api/schedules')).json() as Schedule[]).length, before);
});

test('the rows keep what picks a schedule and pass through what they do not know', () => {
  assert.equal(scheduleRows('nope'), 'nope');
  assert.deepEqual(scheduleRunRows({ error: 'x' }), { error: 'x' });
  assert.deepEqual(scheduleRows([{ id: 'a', name: 'n', cron: '@daily', enabled: true, overlap: 'parallel', lastRunAt: null, nextRunAt: 'n', createdAt: 'c', target: { kind: 'later' } }]), [
    { id: 'a', name: 'n', cron: '@daily', enabled: true, overlap: 'parallel', nextRunAt: 'n', target: { kind: 'later' } },
  ]);
  assert.deepEqual(scheduleRunRows([{ id: 'r', scheduleId: 'a', at: 't', slot: 's', status: 'queued' }]), [{ id: 'r', at: 't', slot: 's', status: 'queued' }]);
});
