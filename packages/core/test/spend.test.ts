import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, mock } from 'node:test';
import type { ClaudioEvent, SpendPurpose, SpendState } from '@claudio/shared';
import { Db, SPEND_SCHEMA_VERSION, type SpendRow } from '../src/db.ts';
import { Core } from '../src/index.ts';
import { localDayOf, localDayWindow, SPEND_RETENTION_DAYS, SpendGate, type SpendGateDeps } from '../src/spend.ts';
import { tempConfig } from './helpers.ts';

// The daily cap's gate over a real ledger. The window is the server's local day, so the zone is
// fixed to one that changes its clock: Madrid goes forward on 2026-03-29 (23 h) and back on
// 2026-10-25 (25 h).

process.env.TZ = 'Europe/Madrid';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const config = tempConfig();
  roots.push(dirname(config.dataDir));
  mkdirSync(config.dataDir, { recursive: true });
  return { config, db: new Db(config) };
}

const row = (at: string, usd: number, extra: Partial<SpendRow> = {}): SpendRow => ({
  at,
  chatId: 'c1',
  executionId: 'e1',
  usd,
  reported: true,
  purpose: 'person',
  account: null,
  accountKind: null,
  projectId: null,
  orchestrationId: null,
  ...extra,
});

/** A gate over the database with a mutable cap and clock. */
function gateOf(db: Db, cap: number | null, at = '2026-10-16T10:00:00.000Z', extra: Partial<SpendGateDeps> = {}) {
  const clock = { cap, now: Date.parse(at) };
  const gate = new SpendGate({ db, cap: () => clock.cap, now: () => clock.now, ...extra });
  return { gate, clock };
}

const NOON = '2026-10-16T10:00:00.000Z';

test('the schema version the ledger arrives in is a real migration', () => {
  assert.ok(SPEND_SCHEMA_VERSION > 1);
});

test('the day is the local day from date parts: 23 h when the clock goes forward, 25 h when it goes back', () => {
  const hours = (ms: number) => ms / 3_600_000;
  const spring = localDayWindow(Date.parse('2026-03-29T10:00:00.000Z'));
  assert.equal(hours(spring.end - spring.start), 23);
  assert.equal(new Date(spring.start).toISOString(), '2026-03-28T23:00:00.000Z');
  const autumn = localDayWindow(Date.parse('2026-10-25T10:00:00.000Z'));
  assert.equal(hours(autumn.end - autumn.start), 25);
  assert.equal(new Date(autumn.start).toISOString(), '2026-10-24T22:00:00.000Z');
  assert.equal(hours(localDayWindow(Date.parse(NOON)).end - localDayWindow(Date.parse(NOON)).start), 24);
  assert.equal(localDayOf(Date.parse('2026-03-29T21:59:59.000Z')), '2026-03-29');
  assert.equal(localDayOf(Date.parse('2026-03-29T22:00:00.000Z')), '2026-03-30');
});

test('only the rows inside the local day count, across a DST change', () => {
  const { db } = setup();
  // The 23-hour day of 2026-03-29, local 00:00 to 24:00 = 23:00Z to 22:00Z
  db.addSpend(row('2026-03-28T22:59:59.000Z', 1)); // 23:59:59 the day before
  db.addSpend(row('2026-03-28T23:00:00.000Z', 2)); // 00:00 on the day
  db.addSpend(row('2026-03-29T21:59:59.000Z', 4)); // 23:59:59 on the day
  db.addSpend(row('2026-03-29T22:00:00.000Z', 8)); // 00:00 the day after
  const { gate } = gateOf(db, 100, '2026-03-29T10:00:00.000Z');
  const state = gate.state();
  assert.equal(state.day, '2026-03-29');
  assert.equal(state.spentUsd, 6);
  assert.equal(state.resetsAt, '2026-03-29T22:00:00.000Z');
  assert.equal(gate.state(Date.parse('2026-03-30T10:00:00.000Z')).spentUsd, 8);
  db.close();
});

test('the level follows the usage bars: ok below 60 %, warn from 60, bad from 75, exhausted at 100', () => {
  const { db } = setup();
  const { gate } = gateOf(db, 10);
  const levelAt = (total: number): SpendState => {
    db.connection.exec('DELETE FROM spend_ledger');
    db.addSpend(row(NOON, total));
    return gate.state();
  };
  assert.equal(levelAt(0).level, 'ok');
  assert.equal(levelAt(5.99).level, 'ok');
  assert.equal(levelAt(6).level, 'warn');
  assert.equal(levelAt(7.49).level, 'warn');
  assert.equal(levelAt(7.5).level, 'bad');
  assert.equal(levelAt(9.99).level, 'bad');
  assert.equal(levelAt(9.99).blocked, false);
  assert.equal(levelAt(10).level, 'exhausted');
  assert.equal(levelAt(10).blocked, true);
  assert.equal(levelAt(12).share, 1.2);
  db.close();
});

test('with no cap the level is off, nothing is blocked and every start is allowed', () => {
  const { db } = setup();
  db.addSpend(row(NOON, 500));
  const { gate } = gateOf(db, null);
  const state = gate.state();
  assert.equal(state.level, 'off');
  assert.equal(state.share, null);
  assert.equal(state.blocked, false);
  assert.equal(state.capUsd, null);
  assert.equal(gate.allows('flow'), true);
  db.close();
});

test('the sum is rounded to cents before it meets the cap', () => {
  const { db } = setup();
  const { gate } = gateOf(db, 20);
  db.addSpend(row(NOON, 19.994));
  assert.equal(gate.state().spentUsd, 19.99);
  assert.equal(gate.state().blocked, false);
  db.addSpend(row(NOON, 0.002));
  // 19.996 reads 20.00: never "20,00 of 20,00" with the gate still open
  assert.equal(gate.state().spentUsd, 20);
  assert.equal(gate.state().level, 'exhausted');
  assert.equal(gate.allows('flow'), false);
  db.close();
});

test('results without a cost are counted as unreported and add nothing', () => {
  const { db } = setup();
  db.addSpend(row(NOON, 1));
  db.addSpend(row(NOON, 0, { reported: false }));
  db.addSpend(row(NOON, 0, { reported: false }));
  db.addSpend(row('2026-10-15T10:00:00.000Z', 0, { reported: false }));
  const state = gateOf(db, 10).gate.state();
  assert.equal(state.unreported, 2);
  assert.equal(state.spentUsd, 1);
  db.close();
});

test('the spend is broken down by purpose and by account kind', () => {
  const { db } = setup();
  const rows: Array<[number, SpendPurpose, string | null]> = [
    [1.5, 'person', 'login'],
    [2, 'flow', 'api-key'],
    [0.25, 'flow', 'token'],
    [0.75, 'decision', null],
    [1, 'orchestration', 'login'],
  ];
  for (const [usd, purpose, accountKind] of rows) db.addSpend(row(NOON, usd, { purpose, accountKind }));
  const state = gateOf(db, 100).gate.state();
  assert.deepEqual(state.byPurpose, { person: 1.5, flow: 2.25, decision: 0.75, orchestration: 1 });
  assert.deepEqual(state.byAccountKind, { login: 2.5, token: 0.25, apiKey: 2, unknown: 0.75 });
  assert.equal(state.spentUsd, 5.5);
  assert.equal(state.timezone, 'Europe/Madrid');
  db.close();
});

test('the waiting counts are what the cap holds back, and only while it is closed', () => {
  const { db } = setup();
  const { gate } = gateOf(db, 10, NOON, { waiting: () => ({ flowRuns: 2, orchestrationTasks: 3 }) });
  assert.deepEqual(gate.state().waiting, { flowRuns: 0, orchestrationTasks: 0 });
  db.addSpend(row(NOON, 10));
  assert.deepEqual(gate.state().waiting, { flowRuns: 2, orchestrationTasks: 3 });
  db.close();
});

test('over the cap a start is refused unless a person overrode it or its graph holds today\'s pass', () => {
  const { db } = setup();
  const passes = new Map<string, string>();
  const { gate, clock } = gateOf(db, 10, NOON, { passOf: (id) => passes.get(id) ?? null });
  assert.equal(gate.allows('flow'), true, 'below the cap');
  db.addSpend(row(NOON, 10));
  assert.equal(gate.allows('flow'), false);
  assert.equal(gate.allows('person'), false);
  assert.equal(gate.allows('person', { override: true }), true);
  assert.equal(gate.allows('orchestration', { orchestrationId: 'g1' }), false);
  passes.set('g1', '2026-10-15');
  assert.equal(gate.allows('orchestration', { orchestrationId: 'g1' }), false, 'a pass is for one day');
  passes.set('g1', localDayOf(clock.now));
  assert.equal(gate.allows('orchestration', { orchestrationId: 'g1' }), true);
  assert.equal(gate.allows('orchestration', { orchestrationId: 'g2' }), false, 'another graph has none');
  clock.cap = 20;
  assert.equal(gate.allows('flow'), true, 'raising the cap opens the gate at once');
  clock.cap = 5;
  assert.equal(gate.allows('flow'), false, 'lowering it below the spend closes it at once');
  const refusal = gate.refusal();
  assert.equal(refusal.code, 'spend-cap');
  assert.equal(refusal.spend.blocked, true);
  assert.ok(refusal.error);
  db.close();
});

test('granting a pass hands the day to the graph and tells the listeners', () => {
  const { db } = setup();
  const granted: string[] = [];
  const { gate } = gateOf(db, 10, NOON, { grant: (id, day) => granted.push(`${id}@${day}`) });
  let heard = 0;
  gate.onChange(() => heard++);
  gate.grantPass('g1');
  assert.deepEqual(granted, ['g1@2026-10-16']);
  assert.equal(heard, 1);
  db.close();
});

test('the listeners hear a level crossing, a cap change and nothing in between', () => {
  const { db } = setup();
  const { gate, clock } = gateOf(db, 10);
  let heard = 0;
  gate.onChange(() => heard++);
  gate.start();
  db.addSpend(row(NOON, 1));
  gate.recorded();
  assert.equal(heard, 0, 'a result inside the same level says nothing');
  db.addSpend(row(NOON, 5.5));
  gate.recorded();
  assert.equal(heard, 1, 'ok to warn');
  db.addSpend(row(NOON, 0.1));
  gate.recorded();
  assert.equal(heard, 1);
  clock.cap = 100;
  gate.capChanged();
  assert.equal(heard, 2);
  gate.close();
  db.close();
});

test('one alert per day and level even with two gates on one database', () => {
  const { config, db } = setup();
  const second = new Db(config);
  const heard: string[] = [];
  const first = gateOf(db, 10);
  const other = gateOf(second, 10);
  first.gate.onAlert((level) => heard.push(`first:${level}`));
  other.gate.onAlert((level) => heard.push(`second:${level}`));
  first.gate.start();
  other.gate.start();

  db.addSpend(row(NOON, 7.5));
  first.gate.recorded();
  other.gate.recorded();
  assert.deepEqual(heard, ['first:warn'], 'the process that inserted the row raises it');

  db.addSpend(row(NOON, 2.5));
  other.gate.recorded();
  first.gate.recorded();
  assert.deepEqual(heard, ['first:warn', 'second:exhausted']);

  // Nothing more the same day
  db.addSpend(row(NOON, 1));
  first.gate.recorded();
  other.gate.recorded();
  first.gate.capChanged();
  assert.equal(heard.length, 2);

  // The next day raises them again
  first.clock.now = Date.parse('2026-10-17T10:00:00.000Z');
  db.addSpend(row('2026-10-17T10:00:00.000Z', 10));
  first.gate.recorded();
  assert.deepEqual(heard.slice(2), ['first:warn', 'first:exhausted']);
  first.gate.close();
  other.gate.close();
  second.close();
  db.close();
});

test('a result that jumps over 75 % straight to the cap raises both alerts', () => {
  const { db } = setup();
  const { gate } = gateOf(db, 10);
  const heard: string[] = [];
  gate.onAlert((level) => heard.push(level));
  gate.start();
  db.addSpend(row(NOON, 11));
  gate.recorded();
  assert.deepEqual(heard, ['warn', 'exhausted']);
  gate.close();
  db.close();
});

test('the midnight timer fires at the next local midnight and arms itself again for the next one', () => {
  const { db } = setup();
  // 23:30 in Madrid (CEST): half an hour to midnight
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-16T21:30:00.000Z') });
  try {
    const gate = new SpendGate({ db, cap: () => 10 });
    let heard = 0;
    gate.onChange(() => heard++);
    gate.start();
    mock.timers.tick(29 * 60_000);
    assert.equal(heard, 0);
    mock.timers.tick(60_000);
    assert.equal(heard, 1, 'midnight');
    assert.equal(gate.state().day, '2026-10-17');
    // The day after is 25 h long (the clock goes back on 2026-10-25), but this one is 24 h
    mock.timers.tick(23 * 3_600_000);
    assert.equal(heard, 1);
    mock.timers.tick(3_600_000);
    assert.equal(heard, 2, 'and the next midnight, armed from the date parts again');
    gate.close();
    mock.timers.tick(48 * 3_600_000);
    assert.equal(heard, 2, 'a closed gate stays quiet');
  } finally {
    mock.timers.reset();
    db.close();
  }
});

test('the midnight timer across the 25-hour day waits the real length of the day', () => {
  const { db } = setup();
  // 23:30 on 2026-10-24 in Madrid (CEST); the next day has 25 hours
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-24T21:30:00.000Z') });
  try {
    const gate = new SpendGate({ db, cap: () => 10 });
    let heard = 0;
    gate.onChange(() => heard++);
    gate.start();
    mock.timers.tick(30 * 60_000);
    assert.equal(heard, 1);
    mock.timers.tick(24 * 3_600_000);
    assert.equal(heard, 1, 'not yet: the day lasts 25 hours');
    mock.timers.tick(3_600_000);
    assert.equal(heard, 2);
    gate.close();
  } finally {
    mock.timers.reset();
    db.close();
  }
});

test('startup keeps 35 days of rows and alerts and drops the rest', () => {
  const { db } = setup();
  const now = Date.parse(NOON);
  const daysAgo = (n: number) => new Date(now - n * 86_400_000).toISOString();
  db.addSpend(row(daysAgo(60), 1));
  db.addSpend(row(daysAgo(SPEND_RETENTION_DAYS + 1), 2));
  db.addSpend(row(daysAgo(SPEND_RETENTION_DAYS - 2), 4));
  db.addSpend(row(daysAgo(1), 8));
  db.addSpend(row(NOON, 16));
  db.addSpendAlert(localDayOf(now - 60 * 86_400_000), 'warn');
  db.addSpendAlert(localDayOf(now - 2 * 86_400_000), 'warn');
  const { gate } = gateOf(db, 100);
  gate.start();
  const left = (db.connection.prepare('SELECT usd FROM spend_ledger ORDER BY usd').all() as Array<{ usd: number }>).map((r) => r.usd);
  assert.deepEqual(left, [4, 8, 16]);
  const alerts = db.connection.prepare('SELECT day FROM spend_alerts').all() as Array<{ day: string }>;
  assert.deepEqual(alerts.map((a) => a.day), [localDayOf(now - 2 * 86_400_000)]);
  gate.close();
  db.close();
});

// ---------- the gate wired into Core ----------

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

async function until<T>(read: () => T | undefined | null | false, what: string, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('a result writes the ledger, the cap closes the gate, and raising it starts what waited, with the events on the bus', async () => {
  const core = new Core({ ...tempConfig(), claudeBin: FAKE_CLAUDE });
  try {
    const events: ClaudioEvent[] = [];
    core.events.observe((e) => events.push(e));
    // The fake CLI reports 0.01 a result: a cap of 0.01 is reached by the first one
    await core.appSettings.update({ dailySpendCapUsd: 0.01 });
    assert.equal(core.spend.state().level, 'ok');
    assert.equal(core.spend.allows('flow'), true);

    const first = core.runtime.start({ prompt: 'work', keepAlive: false, purpose: 'orchestration' });
    await core.runtime.waitForResult(first.id);
    await until(() => core.spend.state().blocked, 'the gate to close');
    assert.equal(core.spend.state().byPurpose.orchestration, 0.01);
    assert.ok(events.some((e) => e.type === 'spend.changed'), 'the crossing is on the bus');
    const alerts = events.filter((e) => e.type === 'spend.alert').map((e) => (e.type === 'spend.alert' ? e.level : null));
    assert.deepEqual(alerts, ['warn', 'exhausted']);

    // A graph's pending task waits; the pass and a raised cap both let it through
    const repo = mkdtempSync(join(tmpdir(), 'claudio-spend-'));
    const held = core.orchestrator.create({ name: 'held', cwd: repo, tasks: [{ id: 'a', name: 'a', prompt: 'work' }], synthesize: false });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(core.orchestrator.get(held.id)?.tasks[0]?.status, 'pending');
    assert.equal(core.spend.state().waiting.orchestrationTasks, 1);

    const changes = events.filter((e) => e.type === 'spend.changed').length;
    await core.appSettings.update({ dailySpendCapUsd: 100 });
    assert.ok(events.filter((e) => e.type === 'spend.changed').length > changes, 'a cap change is announced');
    await until(() => core.orchestrator.get(held.id)?.status === 'completed', 'the held graph to run');

    // A pass: the gate shut again, one graph goes on
    await core.appSettings.update({ dailySpendCapUsd: 0.01 });
    const passed = core.orchestrator.create({ name: 'passed', cwd: repo, tasks: [{ id: 'a', name: 'a', prompt: 'work' }], synthesize: false });
    assert.equal(core.orchestrator.get(passed.id)?.tasks[0]?.status, 'pending');
    core.spend.grantPass(passed.id);
    await until(() => core.orchestrator.get(passed.id)?.status === 'completed', 'the graph with a pass to run');
    assert.equal(core.orchestrator.get(passed.id)?.spendPass, core.spend.state().day);
  } finally {
    core.shutdown();
  }
});
