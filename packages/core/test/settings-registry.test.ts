import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { SERVER_SETTING_IDS, type ClaudioEvent } from '@claudio/shared';
import { Core } from '../src/index.ts';
import { loadConfig } from '../src/paths.ts';
import { SettingsError } from '../src/settings-registry.ts';

/** A wrapper in a scratch directory, with whatever the environment says on top; gone after the test */
function wrapper(t: TestContext, env: NodeJS.ProcessEnv = {}): Core {
  const root = mkdtempSync(join(tmpdir(), 'claudio-settings-registry-'));
  const core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CSWAP_BIN: '/nonexistent/cswap',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
      ...env,
    }),
  );
  t.after(() => {
    core.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
  return core;
}

const fileOf = (core: Core, name: string): Record<string, unknown> => JSON.parse(readFileSync(join(core.config.dataDir, name), 'utf8')) as Record<string, unknown>;

test('a new install reports every setting at its default, and none of them changed', async (t) => {
  const core = wrapper(t);
  const { settings } = await core.settings.state();
  assert.deepEqual(Object.keys(settings).sort(), [...SERVER_SETTING_IDS].sort());
  for (const [id, state] of Object.entries(settings)) {
    assert.equal(state.changed, false, id);
    assert.equal(state.source, 'default', id);
  }
  assert.equal(settings['runs.concurrent']?.default, 8);
  assert.equal(settings['spend-cap.daily']?.default, null);
  assert.deepEqual(settings['point-flow-bounce']?.default, { mode: 'off', threshold: 0.85 });
  assert.deepEqual(settings['provider.binary']?.default, { 'claude-code': null });
  assert.equal(settings['guards.rule.protect-configs']?.default, false);
  assert.equal(settings['terminal.scrollback']?.default, 2000);
});

test('the terminal and the image defaults are the ones of this distribution', async (t) => {
  const core = wrapper(t, { CLAUDIO_DEFAULT_PERMISSION_MODE: 'bypassPermissions' });
  const { settings } = await core.settings.state();
  // The environment decides it: shown, and never offered a Reset
  assert.equal(settings['runs.permission-mode']?.source, 'env');
  assert.equal(settings['runs.permission-mode']?.changed, false);
});

test('a stored value equal to the default is not changed, a different one is', async (t) => {
  const core = wrapper(t);
  await core.appSettings.update({ maxConcurrentRuns: 8, evalsPhase2: true });
  const { settings } = await core.settings.state();
  assert.deepEqual(settings['runs.concurrent'], { changed: false, source: 'stored', default: 8 });
  assert.deepEqual(settings['evals.phase-2'], { changed: true, source: 'stored', default: false });
});

test('an app setting reset removes its key alone and emits settings.changed', async (t) => {
  const core = wrapper(t);
  await core.appSettings.update({ maxConcurrentRuns: 3, dailySpendCapUsd: 5, allowedHosts: ['claudio.example.com'] });
  const seen: ClaudioEvent[] = [];
  const stop = core.events.subscribe((event) => seen.push(event));
  t.after(stop);

  const state = await core.settings.reset('spend-cap.daily');
  assert.deepEqual(state, { changed: false, source: 'default', default: null });
  assert.deepEqual(fileOf(core, 'app-settings.json'), { maxConcurrentRuns: 3, allowedHosts: ['claudio.example.com'] });
  assert.equal(core.appSettings.dailySpendCapUsd, null);
  assert.ok(seen.some((event) => event.type === 'settings.changed'));
});

test('a setting the environment sets answers 409 setting-from-env and the file is left alone', async (t) => {
  const core = wrapper(t, { CLAUDIO_MAX_CONCURRENT_RUNS: '4' });
  await assert.rejects(core.settings.reset('runs.concurrent'), (error: unknown) => error instanceof SettingsError && error.statusCode === 409 && error.reason === 'setting-from-env');
});

test('an id that is not a setting answers 404 setting-unknown', async (t) => {
  const core = wrapper(t);
  for (const id of ['access.mode', 'engine.jev-key', 'point-nope', '__proto__']) {
    await assert.rejects(core.settings.reset(id), (error: unknown) => error instanceof SettingsError && error.statusCode === 404 && error.reason === 'setting-unknown', id);
  }
});

test("a decision point's reset removes mode and threshold, keeps its consent, and leaves the other points alone", async (t) => {
  const core = wrapper(t);
  await core.decisionSettings.set({
    provider: 'cli',
    cli: { model: 'sonnet', effort: 'low', maxCostUsd: 0.02 },
    historyDays: 30,
    points: { 'flow.bounce': { mode: 'shadow', threshold: 0.9 }, 'memory.triage': { mode: 'active', threshold: 0.7 } },
  });
  await core.decisionSettings.setConsent('flow.bounce', { granted: true, stateVersion: 1, providers: ['cli'] });
  assert.equal((await core.settings.state()).settings['point-flow-bounce']?.changed, true);

  const state = await core.settings.reset('point-flow-bounce');
  assert.deepEqual(state, { changed: false, source: 'default', default: { mode: 'off', threshold: 0.85 } });
  const points = fileOf(core, 'decisions.json').points as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(points['flow.bounce'] ?? {}), ['consent']);
  assert.equal(core.decisionSettings.get().points['flow.bounce']?.consent?.stateVersion, 1);
  assert.deepEqual(points['memory.triage'], { mode: 'active', threshold: 0.7, consent: null });

  // One field of `cli` goes, the others stay
  await core.settings.reset('engine.cli-model');
  const cli = fileOf(core, 'decisions.json').cli as Record<string, unknown>;
  assert.deepEqual(cli, { effort: 'low', maxCostUsd: 0.02 });
  assert.equal(core.decisionSettings.get().cli.model, 'haiku');
  assert.equal(core.decisionSettings.get().cli.effort, 'low');
});

test('a point with no consent left goes from the document whole', async (t) => {
  const core = wrapper(t);
  await core.decisionSettings.set({ provider: 'cli', cli: { model: 'haiku', effort: 'low', maxCostUsd: 0.02 }, historyDays: 30, points: { 'flow.bounce': { mode: 'shadow', threshold: 0.9 } } });
  await core.settings.reset('point-flow-bounce');
  assert.equal(fileOf(core, 'decisions.json').points, undefined);
});

test('a lessons reset removes one field and keeps the rest of its group', async (t) => {
  const core = wrapper(t);
  await core.lessonSettings.update({ miner: { model: 'sonnet', maxCostUsd: 0.1 } });
  assert.equal((await core.settings.state()).settings['lessons.miner-model']?.changed, true);
  await core.settings.reset('lessons.miner-model');
  const miner = fileOf(core, 'lessons.json').miner as Record<string, unknown>;
  assert.equal(miner.model, undefined);
  assert.equal(miner.maxCostUsd, 0.1);
  assert.equal((await core.lessonSettings.get()).miner.model, 'haiku');
});

test('a guard rule reset leaves the other rules and the mode alone and emits guards.changed', async (t) => {
  const core = wrapper(t);
  await core.guards.update({ mode: 'observe', rules: { push: false, secrets: false } });
  const seen: ClaudioEvent[] = [];
  const stop = core.events.subscribe((event) => seen.push(event));
  t.after(stop);

  await core.settings.reset('guards.rule.push');
  const rules = fileOf(core, 'guards.json').rules as Record<string, unknown>;
  assert.equal(rules.push, undefined);
  assert.equal(rules.secrets, false);
  assert.equal(core.guards.get().rules.push, true);
  assert.equal(core.guards.get().mode, 'observe');
  assert.ok(seen.some((event) => event.type === 'guards.changed'));
});

test('a terminal reset removes one key, keeps the rest, and emits terminal.changed', async (t) => {
  const core = wrapper(t);
  await core.terminals.updateSettings({ maxTerminals: 4, idleMinutes: 60 });
  const seen: ClaudioEvent[] = [];
  const stop = core.events.subscribe((event) => seen.push(event));
  t.after(stop);

  await core.settings.reset('terminal.max-terminals');
  assert.deepEqual(fileOf(core, 'terminal.json'), { idleMinutes: 60 });
  assert.equal(core.terminals.settings().maxTerminals, 8);
  assert.ok(seen.some((event) => event.type === 'terminal.changed'));
});

test('a provider reset removes the binary path of every provider and keeps the rest of the document', async (t) => {
  const core = wrapper(t);
  await core.providersSettings.set({ providers: { 'claude-code': { enabled: true, binaryPath: '/opt/claude' } }, rotation: { onLimit: { maxWaitHours: 12 } } });
  await core.settings.reset('provider.binary');
  const doc = fileOf(core, 'providers.json');
  assert.deepEqual((doc.providers as Record<string, unknown>)['claude-code'], { enabled: true });
  assert.equal(core.providersSettings.get().rotation?.onLimit.maxWaitHours, 12);
  await core.settings.reset('provider.limits');
  assert.equal(fileOf(core, 'providers.json').rotation, undefined);
  assert.equal(core.providersSettings.get().rotation?.onLimit.maxWaitHours, 6);
});

test('a tunnel reset removes its one key', async (t) => {
  const core = wrapper(t);
  writeFileSync(join(core.config.dataDir, 'tunnel-settings.json'), JSON.stringify({ startWithClaudio: true }));
  assert.equal(core.tunnel.startStored(), true);
  await core.settings.reset('remote.tunnel');
  assert.deepEqual(fileOf(core, 'tunnel-settings.json'), {});
  assert.equal(core.tunnel.status().settings.startWithClaudio, false);
});

test('an accounts reset removes its key from the file and keeps the other settings and the accounts', async (t) => {
  const core = wrapper(t);
  await core.accounts.setSettings({ threshold: 80, cooldownSeconds: 60 });
  assert.equal((await core.settings.state()).settings['accounts.threshold']?.changed, true);
  await core.settings.reset('accounts.threshold');
  assert.deepEqual(fileOf(core, 'accounts.json').settings, { cooldownSeconds: 60 });
  assert.equal(core.accounts.settings().threshold, 90);
  assert.equal(core.accounts.settings().cooldownSeconds, 60);
});

test('a collaborators reset removes its key and keeps the name teammates see', async (t) => {
  const core = wrapper(t);
  await core.collaborators.update({ displayName: 'Ana', assistantReads: false });
  await core.settings.reset('collaborators.assistant-reads');
  const doc = JSON.parse(readFileSync(join(core.config.dataDir, 'collaborators', 'settings.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(doc.assistantReads, undefined);
  assert.equal(doc.displayName, 'Ana');
  assert.equal(core.collaborators.currentSettings().assistantReads, true);
});

test('a reset the store would refuse is refused with its words, and changes nothing', async (t) => {
  const core = wrapper(t);
  await core.terminals.updateSettings({ scrollbackLines: 8000, replayLines: 5000 });
  await assert.rejects(core.settings.reset('terminal.scrollback'), (error: unknown) => error instanceof SettingsError && error.statusCode === 400 && /replayLines/.test(error.message));
  assert.deepEqual(fileOf(core, 'terminal.json'), { scrollbackLines: 8000, replayLines: 5000 });
});

test('overrides are counted from the projects that set them, sorted by project name', async (t) => {
  const core = wrapper(t);
  const zeta = await core.createProject({ name: 'zeta' });
  const alpha = await core.createProject({ name: 'alpha' });
  const plain = await core.createProject({ name: 'plain' });
  const override = async (id: string, change: (settings: Record<string, unknown>) => Record<string, unknown>) => {
    const current = (await core.projectSettings(id)) as unknown as Record<string, unknown>;
    await core.saveProjectSettings(id, change(current));
  };
  await override(zeta.id, (s) => ({
    ...s,
    decisions: { provider: 'jev', points: { 'flow.bounce': { mode: 'shadow' } } },
    providers: { onLimit: { maxWaitHours: 2 } },
    flow: { enabled: false, columns: {}, maxBounces: 2, guards: { work: { rules: { push: false } } } },
  }));
  // An old file's provider order is dropped on read (one provider runs), so it never counts
  await override(alpha.id, (s) => ({ ...s, decisions: { provider: 'jev' }, providers: { order: ['claude-code'] } }));
  await override(plain.id, (s) => ({ ...s, decisions: { provider: 'inherit' } }));

  const overrides = await core.settings.overrides();
  assert.deepEqual(overrides['engine.who-answers'], [alpha.id, zeta.id]);
  assert.deepEqual(overrides['point-flow-bounce'], [zeta.id]);
  assert.deepEqual(overrides['provider.limits'], [zeta.id]);
  assert.equal(overrides['provider.order'], undefined);
  assert.deepEqual(overrides['guards.rule.push'], [zeta.id]);
  assert.equal(overrides['guards.rule.secrets'], undefined);
  assert.ok(!Object.values(overrides).some((ids) => ids.includes(plain.id)));
});
