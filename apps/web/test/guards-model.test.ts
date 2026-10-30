import assert from 'node:assert/strict';
import test from 'node:test';
import type { GuardSettings } from '@claudio/shared';
import { effectiveGuards, guardTag, overrideOf, skippedRules } from '../src/lib/guards';
import { setStageGuards } from '../src/pages/team/model';

const settings: GuardSettings = {
  mode: 'enforce',
  automated: true,
  rules: { integrity: true, 'no-verify': true, push: true, destructive: true, secrets: true, 'protect-configs': false },
  protectConfigs: [],
  extraRoots: [],
};

test('a state equal to the settings is no override at all', () => {
  assert.equal(overrideOf(settings, effectiveGuards(settings, undefined)), undefined);
});

test('only what differs from the settings is kept, and it is named as skipped', () => {
  const wanted = { enabled: true, rules: { ...settings.rules, push: false } };
  assert.deepEqual(overrideOf(settings, wanted), { rules: { push: false } });
  assert.deepEqual(skippedRules(settings, wanted), ['push']);
  assert.equal(overrideOf(settings, { ...wanted, enabled: false })?.enabled, false);
});

test('integrity is a rule an override can switch off like the others (D6)', () => {
  const wanted = { enabled: true, rules: { ...settings.rules, integrity: false } };
  assert.deepEqual(overrideOf(settings, wanted), { rules: { integrity: false } });
  assert.deepEqual(skippedRules(settings, wanted), ['integrity']);
});

test('the header tag follows the guard state', () => {
  const base = { rules: ['integrity' as const], mode: 'enforce' as const };
  assert.equal(guardTag({ ...base, state: 'off' }), null);
  assert.equal(guardTag(null), null);
  assert.deepEqual(guardTag({ ...base, state: 'armed' }), { word: 'armed', tone: 'muted' });
  assert.deepEqual(guardTag({ ...base, mode: 'observe', state: 'armed' }), { word: 'observe', tone: 'warn' });
  assert.deepEqual(guardTag({ ...base, state: 'missing' }), { word: 'missing', tone: 'bad' });
});

test('a flow stage without an override drops its key', () => {
  const flow = { enabled: true, maxBounces: 1, columns: {} };
  const set = setStageGuards(flow, 'work', { enabled: false });
  assert.deepEqual(set.guards, { work: { enabled: false } });
  assert.equal(setStageGuards(set, 'work', undefined).guards, undefined);
});
