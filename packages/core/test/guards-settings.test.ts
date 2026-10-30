import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_GUARD_SETTINGS, type GuardSettings } from '@claudio/shared';
import { parseGuardOverride, GuardSettingsStore } from '../src/guards/settings.ts';
import { parseProjectSettings } from '../src/project-settings.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'claudio-guards-settings-'));

test('no file: the defaults, on', () => {
  const store = new GuardSettingsStore(dir());
  assert.deepEqual(store.get(), DEFAULT_GUARD_SETTINGS);
  assert.equal(store.get().automated, true);
  assert.equal(store.get().mode, 'enforce');
  assert.equal(store.problem, null);
});

test('get hands out a copy', () => {
  const store = new GuardSettingsStore(dir());
  store.get().rules.push = false;
  store.get().protectConfigs.length = 0;
  assert.equal(store.get().rules.push, true);
  assert.ok(DEFAULT_GUARD_SETTINGS.protectConfigs.length > 0);
});

test('a partial update merges rules over the stored ones, persists, and reports the change', async () => {
  const root = dir();
  const seen: GuardSettings[] = [];
  const store = new GuardSettingsStore(root, { onChange: (s) => seen.push(s) });
  const next = await store.update({ rules: { 'protect-configs': true }, mode: 'observe' });
  assert.equal(next.rules['protect-configs'], true);
  assert.equal(next.rules.push, true);
  assert.equal(next.mode, 'observe');
  assert.equal(next.automated, true);
  assert.equal(seen.length, 1);
  assert.deepEqual(new GuardSettingsStore(root).get(), next);
  assert.deepEqual(await store.update({}), next);
  assert.equal(seen.length, 1);
});

test('concurrent writers keep every change', async () => {
  const store = new GuardSettingsStore(dir());
  await Promise.all([store.update({ rules: { push: false } }), store.update({ rules: { secrets: false } }), store.update({ automated: false })]);
  const got = store.get();
  assert.deepEqual([got.rules.push, got.rules.secrets, got.automated], [false, false, false]);
});

test('validation refuses the whole body and writes nothing', async () => {
  const root = dir();
  const store = new GuardSettingsStore(root);
  const bad: unknown[] = [
    null,
    [],
    { nope: 1 },
    { mode: 'off' },
    { automated: 'yes' },
    { rules: { 'declared-tools': false } },
    { rules: { integrity: 'off' } },
    { rules: { push: 'no' } },
    { rules: [] },
    { protectConfigs: ['/etc/passwd'] },
    { protectConfigs: ['a/../b'] },
    { protectConfigs: [''] },
    { protectConfigs: Array.from({ length: 201 }, (_, i) => `f${i}`) },
    { extraRoots: ['relative'] },
    { extraRoots: ['/'] },
    { extraRoots: ['/a/../b'] },
  ];
  for (const body of bad) await assert.rejects(store.update(body), (e: unknown) => e instanceof Error, JSON.stringify(body));
  await assert.rejects(store.update({ automated: false, mode: 'nope' }));
  assert.equal(store.get().automated, true);
  assert.deepEqual(new GuardSettingsStore(root).get(), DEFAULT_GUARD_SETTINGS);
});

test('globs and roots are trimmed and deduplicated', async () => {
  const store = new GuardSettingsStore(dir());
  const next = await store.update({ protectConfigs: [' a.cfg ', 'a.cfg', 'x/**'], extraRoots: ['/srv/data/', '/srv/data'] });
  assert.deepEqual(next.protectConfigs, ['a.cfg', 'x/**']);
  assert.deepEqual(next.extraRoots, ['/srv/data']);
});

test('a corrupt file gives the defaults (on) and refuses writes without touching it', async () => {
  const root = dir();
  const file = join(root, 'guards.json');
  writeFileSync(file, '{ "automated": false, ');
  const store = new GuardSettingsStore(root);
  assert.deepEqual(store.get(), DEFAULT_GUARD_SETTINGS);
  assert.ok(store.problem);
  await assert.rejects(store.update({ automated: false }), /not valid JSON/);
  assert.equal(readFileSync(file, 'utf8'), '{ "automated": false, ');
  assert.equal(store.get().automated, true);
});

test('integrity is switched like any rule, and a document stored before it had a switch reads it as on', async () => {
  const root = dir();
  writeFileSync(join(root, 'guards.json'), JSON.stringify({ rules: { push: false } }));
  const store = new GuardSettingsStore(root);
  assert.equal(store.get().rules.integrity, true, 'the default while the guard is on');
  assert.equal((await store.update({ rules: { integrity: false } })).rules.integrity, false);
  assert.equal(new GuardSettingsStore(root).get().rules.integrity, false);
  assert.equal((await store.resetKeys([['rules', 'integrity']])).rules.integrity, true);
});

test('a stored document with bad keys keeps the good ones and drops the rest', () => {
  const root = dir();
  writeFileSync(
    join(root, 'guards.json'),
    JSON.stringify({ mode: 'observe', automated: 'maybe', rules: { push: false, secrets: 'x', integrity: false, 'declared-tools': false, bogus: false }, protectConfigs: ['/abs'], extraRoots: ['/ok'], extra: 1 }),
  );
  const got = new GuardSettingsStore(root).get();
  assert.equal(got.mode, 'observe');
  assert.equal(got.automated, true);
  assert.deepEqual(got.rules, { ...DEFAULT_GUARD_SETTINGS.rules, push: false, integrity: false });
  assert.deepEqual(got.protectConfigs, DEFAULT_GUARD_SETTINGS.protectConfigs);
  assert.deepEqual(got.extraRoots, ['/ok']);
  assert.ok(!('extra' in got));
});

test('a stored document that is not an object reads as the defaults', () => {
  const root = dir();
  writeFileSync(join(root, 'guards.json'), '[1]');
  assert.deepEqual(new GuardSettingsStore(root).get(), DEFAULT_GUARD_SETTINGS);
});

test('an override names only enabled and rules; integrity is a rule it may switch, declared-tools is not', () => {
  assert.deepEqual(parseGuardOverride({ enabled: false, rules: { push: false } }), { enabled: false, rules: { push: false } });
  assert.deepEqual(parseGuardOverride({}), {});
  assert.deepEqual(parseGuardOverride({ rules: { integrity: false } }), { rules: { integrity: false } });
  assert.throws(() => parseGuardOverride({ rules: { 'declared-tools': false } }), /declared-tools/);
  assert.throws(() => parseGuardOverride({ mode: 'observe' }));
  assert.throws(() => parseGuardOverride({ enabled: 'no' }));
});

test('project settings validate guards and flow.guards, and drop empties', () => {
  const base = { modules: [], template: null, keyPrefix: 'ABC', board: { types: ['task'], columnLimits: {} } };
  const flow = { enabled: true, columns: {}, maxBounces: 2 };
  const parsed = parseProjectSettings({ ...base, guards: { chats: true }, flow: { ...flow, guards: { work: { enabled: false }, verify: {} } } });
  assert.deepEqual(parsed.guards, { chats: true });
  assert.deepEqual(parsed.flow?.guards, { work: { enabled: false } });
  assert.equal(parseProjectSettings({ ...base, flow: { ...flow, guards: { verify: {} } } }).flow?.guards, undefined);
  assert.throws(() => parseProjectSettings({ ...base, guards: { chats: 'yes' } }), /guards.chats/);
  assert.throws(() => parseProjectSettings({ ...base, guards: [] }));
  assert.throws(() => parseProjectSettings({ ...base, flow: { ...flow, guards: { ship: {} } } }), /not a flow stage/);
  assert.deepEqual(parseProjectSettings({ ...base, flow: { ...flow, guards: { work: { rules: { integrity: false } } } } }).flow?.guards, { work: { rules: { integrity: false } } });
  assert.throws(() => parseProjectSettings({ ...base, flow: { ...flow, guards: { work: { rules: { 'declared-tools': false } } } } }), /declared-tools/);
});
