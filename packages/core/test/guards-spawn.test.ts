import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { GuardRequest } from '../src/guards/launch.ts';
import { Core } from '../src/index.ts';
import type { ChatGuardPlan } from '../src/live-chat.ts';
import { tempConfig } from './helpers.ts';

// What Core does about guards around a chat's processes (D6 of
// docs/plans/regression-fixes-2026-10-29.md): every spawn its caller handed no plan to derives one
// from the settings as they are then; the assistant is never guarded; and the guard folder is swept
// from the start and stops being swept at shutdown. The launcher's own checks are tested elsewhere,
// so it is a recorder here.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
process.env.FAKE_CLAUDE_LOGGED_IN = '1';

function setup() {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const core = new Core(config);
  const prepared: GuardRequest[] = [];
  const derived: GuardRequest[] = [];
  const plan = (request: GuardRequest): ChatGuardPlan => ({ rules: ['integrity'], mode: 'enforce', settingsPath: '/nowhere/x.settings.json', rulesSha256: 'a'.repeat(64), request });
  // Null for a chat that really starts (nothing would arm it); the requests are what is checked
  core.guardLauncher.prepare = (request) => {
    prepared.push(request);
    return Promise.resolve(null);
  };
  core.guardLauncher.prepareNow = (request) => {
    derived.push(request);
    return plan(request);
  };
  return { config, core, prepared, derived, plan };
}

test("a respawn derives the plan from the request its last plan came from, with the project's settings of now", async () => {
  const { core, derived, plan } = setup();
  const dir = mkdtempSync(join(tmpdir(), 'claudio-guards-spawn-'));
  try {
    const project = await core.importProject({ path: dir, name: 'shop', template: 'software', modules: ['board'] });
    const settings = await core.projectSettings(project.id);
    const request: GuardRequest = { kind: 'chat', cwd: dir, project: { guards: { chats: true } }, projectId: project.id, interactive: true };
    await core.saveProjectSettings(project.id, { ...settings, guards: { chats: false } });

    const planner = core.runtime.guardPlanner;
    assert.ok(planner, 'Core sets the planner');
    const next = planner({ cwd: dir, plan: plan(request), person: true, policy: null, confined: false });
    assert.equal(derived.length, 1);
    assert.equal(derived[0]?.kind, 'chat');
    assert.deepEqual(derived[0]?.project?.guards, { chats: false }, 'the opt-in as it is now, not as it was at the start');
    assert.equal(next?.request?.projectId, project.id);

    // An automated run keeps its own kind and override; only the settings are read again
    const worker: GuardRequest = { kind: 'worker', cwd: dir, graph: { rules: { push: false } } };
    planner({ cwd: dir, plan: plan(worker), person: false, policy: null, confined: false });
    assert.deepEqual([derived[1]?.kind, derived[1]?.graph], ['worker', { rules: { push: false } }]);
  } finally {
    core.shutdown();
  }
});

test("a person's chat that ran unguarded is derived from its project's opt-in; anything else with no plan stays unguarded", async () => {
  const { core, derived } = setup();
  const dir = mkdtempSync(join(tmpdir(), 'claudio-guards-spawn-'));
  try {
    const project = await core.importProject({ path: dir, name: 'shop', template: 'software', modules: ['board'] });
    const settings = await core.projectSettings(project.id);
    await core.saveProjectSettings(project.id, { ...settings, guards: { chats: true } });
    const planner = core.runtime.guardPlanner;
    assert.ok(planner);

    planner({ cwd: dir, plan: null, person: true, policy: null, confined: true });
    assert.deepEqual(
      [derived[0]?.kind, derived[0]?.projectId, derived[0]?.project?.guards, derived[0]?.confined, derived[0]?.interactive],
      ['chat', project.id, { chats: true }, true, true],
    );
    // A worker whose orchestration gave it none, or a folder outside every project: nothing to derive
    assert.equal(planner({ cwd: dir, plan: null, person: false, policy: null, confined: false }), null);
    assert.equal(planner({ cwd: tmpdir(), plan: null, person: true, policy: null, confined: false }), null);
    assert.equal(derived.length, 1);
  } finally {
    core.shutdown();
  }
});

test("the assistant chat is never guarded, even in a project whose chats are; a person's chat there asks", async () => {
  const { core, prepared } = setup();
  const dir = mkdtempSync(join(tmpdir(), 'claudio-guards-spawn-'));
  try {
    core.runtime.apiUrl = 'http://127.0.0.1:34332/api';
    const project = await core.importProject({ path: dir, name: 'shop', template: 'software', modules: ['board'] });
    const settings = await core.projectSettings(project.id);
    await core.saveProjectSettings(project.id, { ...settings, guards: { chats: true } });

    const assistant = await core.startClaudioAssistantChat({ prompt: 'how is it going?', projectId: project.id });
    assert.equal(prepared.length, 0, 'the assistant does not ask for a guard');
    assert.equal(core.runtime.get(assistant.id)?.guards, undefined);

    await core.chats.create({ prompt: 'hello', cwd: dir });
    assert.deepEqual(prepared.map((r) => [r.kind, r.projectId, r.confined]), [['chat', project.id, false]]);
  } finally {
    core.shutdown();
  }
});

test('the guard folder is swept from the start: old files nobody names go, and shutdown stops the sweep', () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const dir = join(config.dataDir, 'guards');
  mkdirSync(dir, { recursive: true });
  const old = join(dir, '0123456789abcdef.rules.json');
  const fresh = join(dir, 'fedcba9876543210.settings.json');
  writeFileSync(old, '{}\n');
  writeFileSync(fresh, '{}\n');
  const longAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  utimesSync(old, longAgo, longAgo);
  const core = new Core(config);
  try {
    assert.equal(core.started.has('guardSweep'), true);
    assert.equal(existsSync(old), false, 'a file a week old that no plan names is removed');
    assert.equal(existsSync(fresh), true, 'a recent one is kept');
  } finally {
    core.shutdown();
  }
});
