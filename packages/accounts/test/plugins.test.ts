import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { describeConfig } from '../src/config-mode.ts';
import { diffPlugins, PLUGINS_RECORD, PluginReconciler, planPlugins, readPluginState, type PluginReconcilerOptions } from '../src/plugins.ts';

const FAKE = fileURLToPath(new URL('./fake-plugin-claude.mjs', import.meta.url));

interface Catalog {
  sources: Record<string, string>;
  catalog: Record<string, Record<string, string>>;
  fail?: string[];
  hang?: boolean;
  delayMs?: number;
}

let work: string;
let n = 0;
before(() => {
  work = mkdtempSync(join(tmpdir(), 'plugins-test-'));
});
after(() => rmSync(work, { recursive: true, force: true }));

interface World {
  root: string;
  def: string;
  log: string;
  claude: string;
  say: string[];
  setCatalog(c: Catalog): void;
  /** Writes the default's records: user-scope installs by id and version, the ones switched off, and the marketplaces' sources */
  setDefault(installed: Record<string, string>, opts?: { off?: string[]; sources?: Record<string, unknown>; extra?: Record<string, unknown[]> }): void;
  account(name: string, installed?: Record<string, string>, opts?: { known?: string[]; linked?: boolean }): string;
  calls(): { dir: string; args: string[]; started: number; ended: number; leaks: string[]; failed?: string }[];
  reconciler(targets: string[], extra?: Partial<PluginReconcilerOptions>): PluginReconciler;
}

function record(installed: Record<string, string>, extra: Record<string, unknown[]> = {}): string {
  const plugins: Record<string, unknown[]> = {};
  for (const [id, version] of Object.entries(installed)) plugins[id] = [{ scope: 'user', installPath: `/x/${id}/${version}`, version }];
  return JSON.stringify({ version: 2, plugins: { ...plugins, ...extra } });
}

function world(): World {
  const root = join(work, `w${(n += 1)}`);
  const def = join(root, 'default');
  mkdirSync(join(def, 'plugins'), { recursive: true });
  const stateFile = join(root, 'catalog.json');
  const log = join(root, 'calls.log');
  writeFileSync(log, '');
  const claude = join(root, 'claude');
  writeFileSync(claude, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} ${JSON.stringify(stateFile)} ${JSON.stringify(log)} "$@"\n`);
  chmodSync(claude, 0o755);
  const say: string[] = [];
  const w: World = {
    root,
    def,
    log,
    claude,
    say,
    setCatalog: (c) => writeFileSync(stateFile, JSON.stringify(c)),
    setDefault(installed, opts = {}) {
      writeFileSync(join(def, 'plugins', 'installed_plugins.json'), record(installed, opts.extra));
      const enabled = Object.fromEntries(Object.keys(installed).map((id) => [id, !(opts.off ?? []).includes(id)]));
      writeFileSync(join(def, 'settings.json'), JSON.stringify({ enabledPlugins: enabled }));
      const known = Object.fromEntries(Object.entries(opts.sources ?? {}).map(([name, source]) => [name, { source, installLocation: `/x/${name}` }]));
      writeFileSync(join(def, 'plugins', 'known_marketplaces.json'), JSON.stringify(known));
    },
    account(name, installed = {}, opts = {}) {
      const dir = join(root, 'accounts', name);
      mkdirSync(join(dir, 'plugins'), { recursive: true });
      if (opts.linked !== false) symlinkSync(join(def, 'settings.json'), join(dir, 'settings.json'));
      writeFileSync(join(dir, 'plugins', 'installed_plugins.json'), record(installed));
      writeFileSync(join(dir, 'plugins', 'known_marketplaces.json'), JSON.stringify(Object.fromEntries((opts.known ?? []).map((m) => [m, { source: { source: 'github', repo: `x/${m}` } }]))));
      for (const m of opts.known ?? []) writeFileSync(join(dir, 'plugins', `catalog-${m}.json`), JSON.stringify({}));
      return dir;
    },
    calls: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as ReturnType<World['calls']>[number]),
    reconciler: (targets, extra = {}) =>
      new PluginReconciler({
        defaultDir: def,
        claude: () => claude,
        targets: () => targets.map((dir) => ({ id: dir.split('/').pop() ?? dir, dir })),
        idle: () => true,
        log: (line) => say.push(line),
        timeoutMs: 15_000,
        debounceMs: 20,
        ...extra,
      }),
  };
  return w;
}

const versionsOf = (dir: string): Record<string, string> => Object.fromEntries([...readPluginState(dir).installed]);
const SLUICE = { source: 'github', repo: 'owner/sluice' };
const OFFICIAL = { source: 'github', repo: 'anthropics/claude-plugins-official' };

describe('plugins of a shared account', () => {
  let live: PluginReconciler | null = null;
  afterEach(() => {
    live?.close();
    live = null;
  });

  // B6 and B7 of the plan: the owner's accounts lacked code-review and ran Sluice 0.5.0 against 0.12.1
  it('brings a shared account to the default: installs what it lacks and updates what runs at another version', async () => {
    const w = world();
    w.setDefault({ 'sluice@sluice': '0.12.1', 'code-review@official': '1.0.0' }, { sources: { sluice: SLUICE, official: OFFICIAL } });
    w.setCatalog({ sources: { 'owner/sluice': 'sluice', 'anthropics/claude-plugins-official': 'official' }, catalog: { sluice: { sluice: '0.12.1' }, official: { 'code-review': '1.0.0' } } });
    const acc = w.account('a1', { 'sluice@sluice': '0.5.0' }, { known: ['sluice'] });
    assert.deepEqual(diffPlugins(w.def, acc), { missing: ['code-review@official'], differing: ['sluice@sluice'] });
    live = w.reconciler([acc]);
    await live.run();
    assert.deepEqual(versionsOf(acc), { 'sluice@sluice': '0.12.1', 'code-review@official': '1.0.0' });
    assert.deepEqual(diffPlugins(w.def, acc), { missing: [], differing: [] });
    assert.deepEqual(w.say, []);
  });

  it('uses the CLI commands in the account environment and writes nothing of the default dir', async () => {
    const w = world();
    w.setDefault({ 'code-review@official': '1.0.0' }, { sources: { official: OFFICIAL } });
    w.setCatalog({ sources: { 'anthropics/claude-plugins-official': 'official' }, catalog: { official: { 'code-review': '1.0.0' } } });
    const acc = w.account('a1');
    const records = [join(w.def, 'plugins', 'installed_plugins.json'), join(w.def, 'plugins', 'known_marketplaces.json')];
    const before = records.map((f) => readFileSync(f, 'utf8'));
    const settings = JSON.parse(readFileSync(join(w.def, 'settings.json'), 'utf8')) as unknown;
    live = w.reconciler([acc]);
    await live.run();
    assert.deepEqual(
      w.calls().map((c) => c.args.join(' ')),
      ['plugin marketplace add anthropics/claude-plugins-official', 'plugin install code-review@official --scope user'],
    );
    assert.ok(w.calls().every((c) => c.dir === acc), 'every command ran with the account dir as CLAUDE_CONFIG_DIR');
    assert.deepEqual(records.map((f) => readFileSync(f, 'utf8')), before);
    // `settings.json` is the account's through the link, and the CLI rewrites it to what it already said
    assert.deepEqual(JSON.parse(readFileSync(join(w.def, 'settings.json'), 'utf8')), settings);
  });

  it('refreshes the account marketplace before it updates a plugin from it', async () => {
    const w = world();
    w.setDefault({ 'sluice@sluice': '0.12.1' }, { sources: { sluice: SLUICE } });
    // The account's clone still lists 0.5.0 as the newest: only a refresh lets the update reach 0.12.1
    w.setCatalog({ sources: {}, catalog: { sluice: { sluice: '0.12.1' } } });
    const acc = w.account('a1', { 'sluice@sluice': '0.5.0' }, { known: ['sluice'] });
    writeFileSync(join(acc, 'plugins', 'catalog-sluice.json'), JSON.stringify({ sluice: '0.5.0' }));
    live = w.reconciler([acc]);
    await live.run();
    assert.deepEqual(w.calls().map((c) => c.args.slice(1).join(' ')), ['marketplace update sluice', 'update sluice@sluice --scope user']);
    assert.deepEqual(versionsOf(acc), { 'sluice@sluice': '0.12.1' });
  });

  it('never uninstalls a plugin a person installed on the account, and removes one Claudio installed once the default drops it', async () => {
    const w = world();
    w.setDefault({ 'code-review@official': '1.0.0' }, { sources: { official: OFFICIAL } });
    w.setCatalog({ sources: { 'anthropics/claude-plugins-official': 'official' }, catalog: { official: { 'code-review': '1.0.0' } } });
    const acc = w.account('a1', { 'mine@own': '2.0.0' }, { known: ['own'] });
    live = w.reconciler([acc]);
    await live.run();
    assert.deepEqual(versionsOf(acc), { 'mine@own': '2.0.0', 'code-review@official': '1.0.0' });
    assert.deepEqual(JSON.parse(readFileSync(join(acc, PLUGINS_RECORD), 'utf8')), { installed: ['code-review@official'] });
    // The default uninstalls code-review: it was Claudio's on this account, so it goes; the person's stays
    w.setDefault({}, { sources: { official: OFFICIAL } });
    await live.run();
    assert.deepEqual(versionsOf(acc), { 'mine@own': '2.0.0' });
    assert.ok(w.calls().some((c) => c.args.join(' ') === 'plugin uninstall code-review@official --scope user'));
    assert.ok(!w.calls().some((c) => c.args.includes('mine@own')));
  });

  it('leaves a plugin the default has switched off, and a plugin of a project scope, alone', async () => {
    const w = world();
    w.setDefault({ 'off@official': '1.0.0', 'on@official': '1.0.0' }, { off: ['off@official'], sources: { official: OFFICIAL }, extra: { 'scoped@official': [{ scope: 'project', projectPath: '/p', version: '9' }] } });
    w.setCatalog({ sources: { 'anthropics/claude-plugins-official': 'official' }, catalog: { official: { off: '1.0.0', on: '1.0.0', scoped: '9' } } });
    const acc = w.account('a1');
    assert.deepEqual(diffPlugins(w.def, acc), { missing: ['on@official'], differing: [] });
    live = w.reconciler([acc]);
    await live.run();
    assert.deepEqual(versionsOf(acc), { 'on@official': '1.0.0' });
    // An install would have switched the plugin on in the settings the account shares with the default
    assert.equal((JSON.parse(readFileSync(join(w.def, 'settings.json'), 'utf8')) as { enabledPlugins: Record<string, boolean> }).enabledPlugins['off@official'], false);
  });

  it('starts no process when the account already matches the default', async () => {
    const w = world();
    w.setDefault({ 'code-review@official': '1.0.0' }, { sources: { official: OFFICIAL } });
    w.setCatalog({ sources: {}, catalog: {} });
    const acc = w.account('a1', { 'code-review@official': '1.0.0' }, { known: ['official'] });
    live = w.reconciler([acc]);
    await live.run();
    assert.deepEqual(w.calls(), []);
  });

  it('waits for an account with a live chat, says so once, and reconciles it when it is idle', async () => {
    const w = world();
    w.setDefault({ 'code-review@official': '1.0.0' }, { sources: { official: OFFICIAL } });
    w.setCatalog({ sources: { 'anthropics/claude-plugins-official': 'official' }, catalog: { official: { 'code-review': '1.0.0' } } });
    const acc = w.account('a1');
    let busy = true;
    live = w.reconciler([acc], { idle: () => !busy });
    await live.run();
    await live.run();
    assert.deepEqual(w.calls(), []);
    assert.equal(w.say.filter((l) => l.includes('live chat')).length, 1, 'said once, not at every pass');
    busy = false;
    await live.run();
    assert.deepEqual(versionsOf(acc), { 'code-review@official': '1.0.0' });
  });

  it('looks again at a deferred account on its own timer, which exists only while one waits', async () => {
    const w = world();
    w.setDefault({ 'code-review@official': '1.0.0' }, { sources: { official: OFFICIAL } });
    w.setCatalog({ sources: { 'anthropics/claude-plugins-official': 'official' }, catalog: { official: { 'code-review': '1.0.0' } } });
    const acc = w.account('a1');
    let busy = true;
    live = w.reconciler([acc], { idle: () => !busy, retryMs: 30 });
    await live.run();
    busy = false;
    await waitFor(() => 'code-review@official' in versionsOf(acc));
  });

  it('says a failed command once, goes on to the next, and tries the failure again at the next pass', async () => {
    const w = world();
    w.setDefault({ 'a@official': '1.0.0', 'b@official': '1.0.0' }, { sources: { official: OFFICIAL } });
    w.setCatalog({ sources: { 'anthropics/claude-plugins-official': 'official' }, catalog: { official: { a: '1.0.0', b: '1.0.0' } }, fail: ['install:a@official'] });
    const acc = w.account('a1');
    live = w.reconciler([acc]);
    await live.run();
    assert.deepEqual(versionsOf(acc), { 'b@official': '1.0.0' });
    await live.run();
    assert.equal(w.say.length, 1, 'the same failure is not logged again');
    assert.match(w.say[0] ?? '', /a1.*plugin install a@official.*simulated failure/);
    w.setCatalog({ sources: { 'anthropics/claude-plugins-official': 'official' }, catalog: { official: { a: '1.0.0', b: '1.0.0' } } });
    await live.run();
    assert.deepEqual(versionsOf(acc), { 'a@official': '1.0.0', 'b@official': '1.0.0' });
  });

  it('skips the installs of a marketplace that could not be added', async () => {
    const w = world();
    w.setDefault({ 'a@official': '1.0.0' }, { sources: { official: OFFICIAL } });
    w.setCatalog({ sources: { 'anthropics/claude-plugins-official': 'official' }, catalog: {}, fail: ['marketplace-add:anthropics/claude-plugins-official'] });
    const acc = w.account('a1');
    live = w.reconciler([acc]);
    await live.run();
    assert.deepEqual(w.calls().map((c) => c.args[1]), ['marketplace']);
  });

  it('ends a command that hangs at its timeout and reports it', async () => {
    const w = world();
    w.setDefault({ 'a@official': '1.0.0' }, { sources: { official: OFFICIAL } });
    w.setCatalog({ sources: { 'anthropics/claude-plugins-official': 'official' }, catalog: {}, hang: true });
    const acc = w.account('a1', {}, { known: ['official'] });
    live = w.reconciler([acc], { timeoutMs: 300 });
    const at = Date.now();
    await live.run();
    assert.ok(Date.now() - at < 10_000);
    assert.ok(w.say.some((l) => l.includes('failed')));
    assert.deepEqual(versionsOf(acc), {});
  });

  it('does not ask again for an update that left the plugin behind the default', async () => {
    const w = world();
    w.setDefault({ 'sluice@sluice': '0.12.1' }, { sources: { sluice: SLUICE } });
    // The marketplace has nothing newer than 0.6.0, so no update can reach the default's version
    w.setCatalog({ sources: {}, catalog: { sluice: { sluice: '0.6.0' } } });
    const acc = w.account('a1', { 'sluice@sluice': '0.5.0' }, { known: ['sluice'] });
    live = w.reconciler([acc]);
    await live.run();
    assert.equal(versionsOf(acc)['sluice@sluice'], '0.6.0');
    const calls = w.calls().length;
    await live.run();
    assert.equal(w.calls().length, calls);
    assert.deepEqual(diffPlugins(w.def, acc), { missing: [], differing: ['sluice@sluice'] });
  });

  it('gives its commands no credential and none of the server environment', async () => {
    const w = world();
    w.setDefault({ 'a@official': '1.0.0' }, { sources: { official: OFFICIAL } });
    w.setCatalog({ sources: { 'anthropics/claude-plugins-official': 'official' }, catalog: { official: { a: '1.0.0' } } });
    const acc = w.account('a1');
    live = w.reconciler([acc], { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: 'secret-a', ANTHROPIC_API_KEY: 'secret-b', CLAUDIO_AUTH_TOKEN: 'secret-c', CLAUDE_CONFIG_DIR: '/somewhere/else' } });
    await live.run();
    assert.ok(w.calls().length > 0);
    assert.ok(w.calls().every((c) => c.leaks.length === 0 && c.dir === acc));
  });

  it('reconciles one account at a time', async () => {
    const w = world();
    w.setDefault({ 'a@official': '1.0.0' }, { sources: { official: OFFICIAL } });
    w.setCatalog({ sources: { 'anthropics/claude-plugins-official': 'official' }, catalog: { official: { a: '1.0.0' } }, delayMs: 60 });
    const [a1, a2] = [w.account('a1'), w.account('a2')];
    live = w.reconciler([a1, a2]);
    await live.run();
    const calls = w.calls();
    assert.equal(calls.length, 4);
    for (const [i, call] of calls.entries()) {
      const next = calls[i + 1];
      if (next) assert.ok(call.ended <= next.started, 'a command starts after the previous one ended');
    }
    assert.deepEqual([...new Set(calls.map((c) => c.dir))], [a1, a2]);
  });

  it('says once that a marketplace has no source it could add again, and installs nothing from it', async () => {
    const w = world();
    w.setDefault({ 'a@odd': '1.0.0' }, { sources: { odd: { source: 'settings', name: 'odd' } } });
    w.setCatalog({ sources: {}, catalog: {} });
    const acc = w.account('a1');
    live = w.reconciler([acc]);
    await live.run();
    await live.run();
    assert.deepEqual(w.calls(), []);
    assert.equal(w.say.length, 1);
    assert.match(w.say[0] ?? '', /a@odd/);
  });

  it('runs a pass when the default records a new plugin, after the debounce, with no polling', async () => {
    const w = world();
    w.setDefault({}, { sources: { official: OFFICIAL } });
    w.setCatalog({ sources: { 'anthropics/claude-plugins-official': 'official' }, catalog: { official: { a: '1.0.0' } } });
    const acc = w.account('a1');
    live = w.reconciler([acc]);
    live.start();
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(w.calls(), []);
    w.setDefault({ 'a@official': '1.0.0' }, { sources: { official: OFFICIAL } });
    await waitFor(() => 'a@official' in versionsOf(acc));
  });

  it('runs a pass at start-up without any change', async () => {
    const w = world();
    w.setDefault({ 'a@official': '1.0.0' }, { sources: { official: OFFICIAL } });
    w.setCatalog({ sources: { 'anthropics/claude-plugins-official': 'official' }, catalog: { official: { a: '1.0.0' } } });
    const acc = w.account('a1');
    live = w.reconciler([acc]);
    live.start();
    await waitFor(() => 'a@official' in versionsOf(acc));
  });

  it('starts nothing after it is closed', async () => {
    const w = world();
    w.setDefault({ 'a@official': '1.0.0' }, { sources: { official: OFFICIAL } });
    w.setCatalog({ sources: { 'anthropics/claude-plugins-official': 'official' }, catalog: { official: { a: '1.0.0' } } });
    const acc = w.account('a1');
    live = w.reconciler([acc]);
    live.start();
    live.close();
    await new Promise((r) => setTimeout(r, 120));
    assert.deepEqual(w.calls(), []);
  });
});

describe('the plugin plan', () => {
  it('lists only user-scope plugins of the default that its settings do not switch off', () => {
    const state = (installed: Record<string, string>, enabled: Record<string, boolean> = {}) => ({ installed: new Map(Object.entries(installed)), enabled: new Map(Object.entries(enabled)), marketplaces: new Map([['m', 'o/m']]), known: new Set<string>() });
    const plan = planPlugins(state({ 'a@m': '1', 'b@m': '1' }, { 'b@m': false }), state({}), new Set());
    assert.deepEqual(plan.steps, [
      { kind: 'marketplace-add', marketplace: 'm', source: 'o/m' },
      { kind: 'install', id: 'a@m' },
    ]);
  });

  it('reads an absent or unreadable record as empty and never throws', () => {
    const dir = join(work, 'bad');
    mkdirSync(join(dir, 'plugins'), { recursive: true });
    writeFileSync(join(dir, 'plugins', 'installed_plugins.json'), '{not json');
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ enabledPlugins: ['x'], extraKnownMarketplaces: 4 }));
    const state = readPluginState(dir);
    assert.equal(state.installed.size, 0);
    assert.equal(state.enabled.size, 0);
    assert.deepEqual(diffPlugins(dir, join(work, 'nowhere')), { missing: [], differing: [] });
  });
});

describe('what the Accounts page is served', () => {
  it('carries the plugins a shared account lacks or runs differently, and none for an independent one', () => {
    const w = world();
    w.setDefault({ 'sluice@sluice': '0.12.1', 'code-review@official': '1.0.0' });
    const acc = w.account('a1', { 'sluice@sluice': '0.5.0' });
    assert.deepEqual(describeConfig(acc, w.def, 'shared', null).plugins, { missing: ['code-review@official'], differing: ['sluice@sluice'] });
    assert.deepEqual(describeConfig(acc, w.def, 'independent', null).plugins, { missing: [], differing: [] });
    assert.ok(!existsSync(join(acc, PLUGINS_RECORD)), 'reading it writes nothing');
  });
});

async function waitFor(ok: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail('timed out waiting for the condition');
}
