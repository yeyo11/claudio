import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProvidersSettingsStore } from '../src/providers/settings.ts';

const store = (ids = ['a', 'b', 'c']) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agentry-providers-settings-'));
  return { dataDir, store: new ProvidersSettingsStore({ dataDir }, ids) };
};

test('an absent file reads as every provider on, in registry order, with no default', () => {
  const { store: s } = store();
  assert.deepEqual(s.get(), {
    providers: { a: { enabled: true, binaryPath: null }, b: { enabled: true, binaryPath: null }, c: { enabled: true, binaryPath: null } },
    order: ['a', 'b', 'c'],
    defaultProvider: null,
    rotation: { onLimit: { action: 'wait', allowed: ['wait'], maxWaitHours: 6 } },
  });
});

test('a provider left out of a write keeps the defaults and one left out of the order is appended', async () => {
  const { store: s } = store();
  const saved = await s.set({ providers: { b: { enabled: false } }, order: ['c'] });
  assert.equal(saved.providers.b?.enabled, false);
  assert.equal(saved.providers.a?.enabled, true);
  assert.deepEqual(saved.order, ['c', 'a', 'b']);
});

test('what was saved is what the next store reads, and a broken file reads as the defaults', async () => {
  const { dataDir, store: s } = store();
  await s.set({ defaultProvider: 'b' });
  assert.equal(new ProvidersSettingsStore({ dataDir }, ['a', 'b', 'c']).get().defaultProvider, 'b');
  writeFileSync(join(dataDir, 'providers.json'), '{ not json');
  assert.equal(new ProvidersSettingsStore({ dataDir }, ['a', 'b', 'c']).get().defaultProvider, null);
});

test('a write that fails validation leaves the document as it was', async () => {
  const { store: s } = store();
  await s.set({ defaultProvider: 'a' });
  await assert.rejects(s.set({ defaultProvider: 'zzz' }), /defaultProvider must be one of/);
  await assert.rejects(s.set({ providers: { a: { binaryPath: 'relative/bin' } } }), /absolute path/);
  assert.equal(s.get().defaultProvider, 'a');
});

test('rotation: a partial onLimit keeps the defaults and the chosen action stays among the allowed', async () => {
  const { store: s } = store();
  const saved = await s.set({ rotation: { onLimit: { maxWaitHours: 12 } } });
  assert.deepEqual(saved.rotation?.onLimit, { action: 'wait', allowed: ['wait'], maxWaitHours: 12 });
});

test('rotation: values out of range and unknown actions are refused and change nothing', async () => {
  const { store: s } = store();
  const good = await s.set({ rotation: { onLimit: { maxWaitHours: 3 } } });
  for (const bad of [
    { rotation: [] },
    { rotation: { onLimit: { action: 'fly' } } },
    { rotation: { onLimit: { action: 'handoff' } } },
    { rotation: { onLimit: { allowed: [] } } },
    { rotation: { onLimit: { allowed: ['wait', 'wait'] } } },
    { rotation: { onLimit: { maxWaitHours: 0 } } },
    { rotation: { onLimit: { maxWaitHours: 49 } } },
  ]) {
    await assert.rejects(s.set(bad), JSON.stringify(bad));
  }
  assert.deepEqual(s.get().rotation, good.rotation);
});

test('a file written by another build loads: unknown providers, a removed model map and move counts are ignored', async () => {
  const { dataDir, store: s } = store();
  writeFileSync(
    join(dataDir, 'providers.json'),
    JSON.stringify({
      providers: { a: { enabled: false }, codex: { enabled: true } },
      order: ['codex', 'b'],
      defaultProvider: 'codex',
      rotation: { onLimit: { action: 'wait', maxMoves: 2 }, modelMap: [{ from: { provider: 'codex', model: 'x' } }] },
    }),
  );
  const read = new ProvidersSettingsStore({ dataDir }, ['a', 'b', 'c']).get();
  assert.equal(read.providers.a?.enabled, false);
  assert.equal('codex' in read.providers, false);
  assert.deepEqual(read.order, ['b', 'a', 'c']);
  assert.equal(read.defaultProvider, null);
  assert.deepEqual(read.rotation?.onLimit, { action: 'wait', allowed: ['wait'], maxWaitHours: 6 });
  assert.ok(s);
});
