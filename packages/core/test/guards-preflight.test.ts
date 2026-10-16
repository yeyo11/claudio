import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ProviderCapability } from '@claudio/shared';
import type { GuardLaunch } from '../src/guards/command.ts';
import { GuardPreflight, GuardUnavailableError, type PreflightInput, checkGuardPreflight, runGuardSelfTest } from '../src/guards/preflight.ts';
import { confirmClaudeHelp } from '../src/providers/claude-code/handshake.ts';
import { claudeCodeManifest } from '../src/providers/claude-code/manifest.ts';

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '../src/guards/main.ts');
const HELP = readFileSync(new URL('./fixtures/recordings/claude-hooks/2.1.301/help.txt', import.meta.url), 'utf8');
const tmp = () => mkdtempSync(join(tmpdir(), 'claudio-guards-preflight-'));
const CAPS: ProviderCapability[] = ['settingsFlag', 'hookEvents'];

interface World {
  input: PreflightInput;
  install: string;
  cwd: string;
  config: string;
}

/** An install folder holding a copy of the guard, a project, and a config home, all clean */
function world(): World {
  const base = tmp();
  const install = join(base, 'install');
  const cwd = join(base, 'project');
  const config = join(base, 'config');
  for (const dir of [install, cwd, config]) mkdirSync(dir);
  const entry = join(install, 'guard.mjs');
  copyFileSync(MAIN, entry);
  chmodSync(entry, 0o644);
  const launch: GuardLaunch = { execPath: process.execPath, entry, electron: false, nodeVersion: process.versions.node };
  return {
    install,
    cwd,
    config,
    input: {
      launch,
      dataDir: join(base, 'data'),
      roots: [cwd],
      installDirs: [install],
      claudeConfigDirs: [config],
      cwd,
      capabilities: CAPS,
      managedSettingsPath: join(base, 'no-managed.json'),
    },
  };
}

function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof GuardUnavailableError ? error.code : `other: ${String(error)}`;
  }
}

const withEntry = (input: PreflightInput, entry: string): PreflightInput => ({ ...input, launch: { ...input.launch, entry } });

/** A copy of the guard outside every trusted folder */
function foreignEntry(): string {
  const entry = join(tmp(), 'guard.mjs');
  copyFileSync(MAIN, entry);
  chmodSync(entry, 0o644);
  return entry;
}

describe('guard preflight codes', () => {
  it('passes on a clean world', () => {
    assert.equal(code(() => checkGuardPreflight(world().input)), null);
  });

  it('entry-missing: absent, not a regular file, or writable by others', () => {
    const w = world();
    assert.equal(code(() => checkGuardPreflight(withEntry(w.input, join(w.install, 'gone.mjs')))), 'entry-missing');
    assert.equal(code(() => checkGuardPreflight(withEntry(w.input, w.install))), 'entry-missing');
    chmodSync(w.input.launch.entry, 0o666);
    assert.equal(code(() => checkGuardPreflight(w.input)), 'entry-missing');
    chmodSync(w.input.launch.entry, 0o664);
    assert.equal(code(() => checkGuardPreflight(w.input)), 'entry-missing');
  });

  it('entry-untrusted: outside the install; the operator entry is trusted wherever it is', () => {
    const w = world();
    const outside = foreignEntry();
    assert.equal(code(() => checkGuardPreflight(withEntry(w.input, outside))), 'entry-untrusted');
    assert.equal(code(() => checkGuardPreflight({ ...withEntry(w.input, outside), operatorEntry: outside })), null);
  });

  it('entry-untrusted: under a root or a plugin cache, even inside the install', () => {
    const w = world();
    assert.equal(code(() => checkGuardPreflight({ ...w.input, roots: [w.install] })), 'entry-untrusted');
    const plugins = join(w.config, 'plugins');
    mkdirSync(plugins);
    const planted = join(plugins, 'guard.mjs');
    copyFileSync(MAIN, planted);
    chmodSync(planted, 0o644);
    assert.equal(code(() => checkGuardPreflight({ ...withEntry(w.input, planted), installDirs: [plugins] })), 'entry-untrusted');
  });

  it('entry-untrusted: a link out of the install is judged by where it leads', () => {
    const w = world();
    const link = join(w.install, 'link.mjs');
    symlinkSync(foreignEntry(), link);
    assert.equal(code(() => checkGuardPreflight(withEntry(w.input, link))), 'entry-untrusted');
  });

  it('cli-unsupported: the handshake did not confirm both flags', () => {
    const w = world();
    assert.equal(code(() => checkGuardPreflight({ ...w.input, capabilities: ['settingsFlag'] })), 'cli-unsupported');
    assert.equal(code(() => checkGuardPreflight({ ...w.input, capabilities: ['hookEvents'] })), 'cli-unsupported');
    assert.equal(code(() => checkGuardPreflight({ ...w.input, capabilities: [] })), 'cli-unsupported');
  });

  it('hooks-disabled: our flag-level false beats user, project and local settings (F12), so they pass', () => {
    const w = world();
    writeFileSync(join(w.config, 'settings.json'), '{"disableAllHooks":true}');
    assert.equal(code(() => checkGuardPreflight(w.input)), null);
  });

  it('hooks-disabled: managed settings are not covered by that fact, so a true there fails', () => {
    const w = world();
    const managed = join(tmp(), 'managed-settings.json');
    writeFileSync(managed, '{"disableAllHooks":true}');
    assert.equal(code(() => checkGuardPreflight({ ...w.input, managedSettingsPath: managed })), 'hooks-disabled');
  });

  it('hooks-disabled: user, project and local settings fail when the flag would not win', () => {
    for (const rel of [['config', 'settings.json'], ['project', '.claude', 'settings.json'], ['project', '.claude', 'settings.local.json']]) {
      const w = world();
      const file = join(w.config, '..', ...rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '{"disableAllHooks":true}');
      const input = { ...w.input, flagOverridesDisable: false };
      assert.equal(code(() => checkGuardPreflight(input)), 'hooks-disabled', rel.join('/'));
      writeFileSync(file, '{"disableAllHooks":false}');
      assert.equal(code(() => checkGuardPreflight(input)), null);
      writeFileSync(file, 'not json');
      assert.equal(code(() => checkGuardPreflight(input)), null);
    }
  });

  it('managed-hooks-only: managed settings allow only managed hooks', () => {
    const w = world();
    const managed = join(tmp(), 'managed-settings.json');
    writeFileSync(managed, '{"allowManagedHooksOnly":true}');
    assert.equal(code(() => checkGuardPreflight({ ...w.input, managedSettingsPath: managed })), 'managed-hooks-only');
    writeFileSync(managed, '{"allowManagedHooksOnly":false}');
    assert.equal(code(() => checkGuardPreflight({ ...w.input, managedSettingsPath: managed })), null);
  });

  it('bad-path: a newline or a NUL in a path of the command', () => {
    const w = world();
    assert.equal(code(() => checkGuardPreflight({ ...w.input, dataDir: '/data/a\nb' })), 'bad-path');
    assert.equal(code(() => checkGuardPreflight({ ...w.input, launch: { ...w.input.launch, execPath: '/usr/bin/no\0de' } })), 'bad-path');
    assert.equal(code(() => checkGuardPreflight(withEntry(w.input, '/a/guard\n.mjs'))), 'bad-path');
  });
});

describe('guard self-test', () => {
  const launch: GuardLaunch = { execPath: process.execPath, entry: MAIN, electron: false, nodeVersion: process.versions.node };
  const failed = (error: unknown) => error instanceof GuardUnavailableError && error.code === 'self-test-failed';

  it('passes with the real guard: a push is blocked and ls passes', async () => {
    await runGuardSelfTest(launch);
  });

  it('self-test-failed: an entry that blocks nothing', async () => {
    const entry = join(tmp(), 'noop.mjs');
    writeFileSync(entry, 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));');
    await assert.rejects(runGuardSelfTest({ ...launch, entry }), failed);
  });

  it('self-test-failed: an entry that cannot run', async () => {
    await assert.rejects(runGuardSelfTest({ ...launch, entry: join(tmp(), 'missing.mjs') }), failed);
  });

  it('runs once per 10 minutes for a guard, shares a run in flight, and retries after a failure', async () => {
    let now = 0;
    let runs = 0;
    let fail = false;
    const preflight = new GuardPreflight({
      now: () => now,
      selfTest: async () => {
        runs += 1;
        if (fail) throw new GuardUnavailableError('self-test-failed', 'x');
      },
    });
    await Promise.all([preflight.selfTest(launch), preflight.selfTest(launch)]);
    assert.equal(runs, 1);
    now = 9 * 60 * 1000;
    await preflight.selfTest(launch);
    assert.equal(runs, 1);
    now = 11 * 60 * 1000;
    fail = true;
    await assert.rejects(preflight.selfTest(launch));
    assert.equal(runs, 2);
    await assert.rejects(preflight.selfTest(launch));
    assert.equal(runs, 3);
  });

  it('verify runs the checks before the self-test', async () => {
    let ran = false;
    const preflight = new GuardPreflight({
      selfTest: async () => {
        ran = true;
      },
    });
    const w = world();
    await assert.rejects(preflight.verify({ ...w.input, capabilities: [] }), (error: unknown) => error instanceof GuardUnavailableError && error.code === 'cli-unsupported');
    assert.equal(ran, false);
    await preflight.verify(w.input);
    assert.equal(ran, true);
  });
});

describe('capabilities from the recorded --help', () => {
  it('confirms --settings and --include-hook-events from the recorded CLI help', () => {
    const result = confirmClaudeHelp(HELP, '2.1.301');
    assert.deepEqual(result.confirmed, ['settingsFlag', 'hookEvents']);
    assert.deepEqual(result.missing, []);
  });

  it('declares both capabilities in the manifest', () => {
    assert.ok(claudeCodeManifest.capabilities.includes('settingsFlag') && claudeCodeManifest.capabilities.includes('hookEvents'));
  });

  it('marks a flag missing only when the help was readable', () => {
    const without = HELP.split('\n').filter((line) => !/--include-hook-events|--settings /.test(line)).join('\n');
    assert.deepEqual(confirmClaudeHelp(without).missing, ['settingsFlag', 'hookEvents']);
    const unreadable = confirmClaudeHelp('');
    assert.deepEqual([unreadable.confirmed, unreadable.missing], [[], []]);
  });
});
