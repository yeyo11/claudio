import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_GUARD_SETTINGS, type GuardOverride, type GuardSettings } from '@claudio/shared';
import { guardsWeakened, projectGuardsWeakened, resolveGuards, type GuardRunKind } from '../src/guards/resolve.ts';
import { defaultGuardSettings } from '../src/guards/settings.ts';

const settings = (patch: Partial<GuardSettings> = {}): GuardSettings => ({ ...defaultGuardSettings(), ...patch });
const DEFAULT_RULES = ['integrity', 'no-verify', 'push', 'destructive', 'secrets'];

test('every automated run kind is guarded with the default rules, integrity first', () => {
  const kinds: GuardRunKind[] = ['worker', 'integration', 'synthesis', 'verification-fixer', 'checks-fix', 'workflow'];
  for (const kind of kinds) {
    const got = resolveGuards({ kind, settings: settings() });
    assert.deepEqual(got?.rules, DEFAULT_RULES, kind);
    assert.equal(got?.mode, 'enforce');
  }
  for (const stage of ['refine', 'work', 'verify'] as const) {
    assert.deepEqual(resolveGuards({ kind: 'flow', stage, settings: settings() })?.rules, DEFAULT_RULES, stage);
  }
});

test('confined and internal kinds get no guard, even when everything else says on', () => {
  const on = settings({ automated: true });
  for (const kind of ['planner', 'supervisor', 'assistant', 'decision', 'project-docs', 'lesson'] as const) {
    assert.equal(resolveGuards({ kind, settings: on, graph: { enabled: true }, project: { guards: { chats: true } } }), null, kind);
  }
});

test('a confined run, or one whose policy allows neither commands nor edits, gets none', () => {
  assert.equal(resolveGuards({ kind: 'worker', settings: settings(), confined: true }), null);
  assert.equal(resolveGuards({ kind: 'worker', settings: settings(), policy: { commands: false, edits: false } }), null);
  assert.ok(resolveGuards({ kind: 'worker', settings: settings(), policy: { commands: true, edits: false } }));
  assert.ok(resolveGuards({ kind: 'worker', settings: settings(), policy: { edits: true } }));
  assert.equal(resolveGuards({ kind: 'chat', settings: settings(), project: { guards: { chats: true } }, policy: { commands: false, edits: false } }), null);
});

test('automated: false switches the automated kinds off, and a graph can switch them back on', () => {
  const off = settings({ automated: false });
  assert.equal(resolveGuards({ kind: 'worker', settings: off }), null);
  assert.equal(resolveGuards({ kind: 'flow', stage: 'work', settings: off }), null);
  assert.ok(resolveGuards({ kind: 'worker', settings: off, graph: { enabled: true } }));
});

test('chat: off without the project opt-in, on with it, and the global automated switch does not matter', () => {
  assert.equal(resolveGuards({ kind: 'chat', settings: settings() }), null);
  assert.equal(resolveGuards({ kind: 'chat', settings: settings(), project: {} }), null);
  assert.equal(resolveGuards({ kind: 'chat', settings: settings(), project: { guards: { chats: false } } }), null);
  assert.deepEqual(resolveGuards({ kind: 'chat', settings: settings(), project: { guards: { chats: true } } })?.rules, DEFAULT_RULES);
  assert.ok(resolveGuards({ kind: 'chat', settings: settings({ automated: false }), project: { guards: { chats: true } } }));
});

test('a graph override switches off, or merges rules over the global ones', () => {
  assert.equal(resolveGuards({ kind: 'worker', settings: settings(), graph: { enabled: false } }), null);
  assert.deepEqual(resolveGuards({ kind: 'worker', settings: settings(), graph: { rules: { push: false, 'protect-configs': true } } })?.rules, [
    'integrity',
    'no-verify',
    'destructive',
    'secrets',
    'protect-configs',
  ]);
  assert.deepEqual(resolveGuards({ kind: 'worker', settings: settings(), graph: {} })?.rules, DEFAULT_RULES);
});

test('a stage override applies to its stage only, and the graph override does not reach a flow run', () => {
  const project = { flow: { enabled: true, columns: {}, maxBounces: 1, guards: { work: { enabled: false }, verify: { rules: { secrets: false } } } } };
  assert.equal(resolveGuards({ kind: 'flow', stage: 'work', settings: settings(), project }), null);
  assert.deepEqual(resolveGuards({ kind: 'flow', stage: 'verify', settings: settings(), project })?.rules, ['integrity', 'no-verify', 'push', 'destructive']);
  assert.deepEqual(resolveGuards({ kind: 'flow', stage: 'refine', settings: settings(), project })?.rules, DEFAULT_RULES);
  assert.deepEqual(resolveGuards({ kind: 'flow', stage: 'work', settings: settings(), project: null, graph: { enabled: false } })?.rules, DEFAULT_RULES);
});

test('integrity is added whenever enabled, even with every switchable rule off', () => {
  const none = settings({ rules: { 'no-verify': false, push: false, destructive: false, secrets: false, 'protect-configs': false } });
  assert.deepEqual(resolveGuards({ kind: 'worker', settings: none })?.rules, ['integrity']);
  assert.equal(resolveGuards({ kind: 'worker', settings: none, graph: { rules: { integrity: false } as never } })?.rules.includes('integrity'), true);
});

test('mode, protectConfigs and extraRoots come from the global settings, as copies', () => {
  const s = settings({ mode: 'observe', extraRoots: ['/srv'], protectConfigs: ['a'] });
  const got = resolveGuards({ kind: 'worker', settings: s });
  assert.deepEqual([got?.mode, got?.extraRoots, got?.protectConfigs], ['observe', ['/srv'], ['a']]);
  got?.extraRoots.push('/x');
  assert.deepEqual(s.extraRoots, ['/srv']);
});

test('guardsWeakened truth table', () => {
  const none = undefined;
  const cases: Array<[string, GuardOverride | undefined, GuardOverride | undefined, boolean]> = [
    ['nothing to nothing', none, none, false],
    ['nothing to empty', none, {}, false],
    ['nothing to enabled true', none, { enabled: true }, false],
    ['nothing to enabled false', none, { enabled: false }, true],
    ['enabled false to nothing', { enabled: false }, none, false],
    ['enabled false to enabled false', { enabled: false }, { enabled: false }, false],
    ['enabled false to a rule off', { enabled: false }, { rules: { push: false } }, false],
    ['enabled true to enabled false', { enabled: true }, { enabled: false }, true],
    ['a default-on rule off', none, { rules: { push: false } }, true],
    ['a default-on rule explicitly on', none, { rules: { push: true } }, false],
    ['a default-off rule explicitly off', none, { rules: { 'protect-configs': false } }, false],
    ['a default-off rule on (tightening)', none, { rules: { 'protect-configs': true } }, false],
    ['rule off to rule on', { rules: { push: false } }, { rules: { push: true } }, false],
    ['rule off to nothing is tightening', { rules: { push: false } }, none, false],
    ['rule on to a different rule off', { rules: { push: false } }, { rules: { secrets: false } }, true],
    ['one more rule off', { rules: { push: false } }, { rules: { push: false, secrets: false } }, true],
    ['same rules off', { rules: { push: false } }, { rules: { push: false } }, false],
    ['stored tightened, sent back default', { rules: { 'protect-configs': true } }, none, true],
    ['stored tightened, sent loosened rule', { rules: { 'protect-configs': true } }, { rules: { 'protect-configs': false } }, true],
  ];
  for (const [name, before, after, expected] of cases) assert.equal(guardsWeakened(before, after), expected, name);
});

test('guardsWeakened reads both sides against the global rules the caller gives', () => {
  const base = { ...DEFAULT_GUARD_SETTINGS.rules, push: false };
  assert.equal(guardsWeakened(undefined, { rules: { push: false } }, base), false);
  assert.equal(guardsWeakened(undefined, { rules: { secrets: false } }, base), true);
});

test('projectGuardsWeakened: only turning the chat opt-in off weakens', () => {
  assert.equal(projectGuardsWeakened({ chats: true }, { chats: false }), true);
  assert.equal(projectGuardsWeakened({ chats: true }, undefined), true);
  assert.equal(projectGuardsWeakened({ chats: false }, { chats: true }), false);
  assert.equal(projectGuardsWeakened(undefined, { chats: false }), false);
  assert.equal(projectGuardsWeakened({ chats: true }, { chats: true }), false);
});
