import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Core } from '../src/index.ts';
import { resolveClaudeBin, type ClaudeBinOptions } from '../src/claude-bin.ts';
import type { SessionLaunch } from '../src/providers/driver.ts';
import { tempConfig } from './helpers.ts';

/** A data dir whose `cli/current` points at `version`, with an executable (or not) binary */
function dataWith(version: string | null, opts: { executable?: boolean } = {}): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'claudio-bin-'));
  if (version) {
    mkdirSync(join(dataDir, 'cli', version, 'bin'), { recursive: true });
    const bin = join(dataDir, 'cli', version, 'bin', 'claude');
    writeFileSync(bin, `#!/bin/sh\necho "${version} (Claude Code)"\n`);
    chmodSync(bin, opts.executable === false ? 0o644 : 0o755);
    symlinkSync(version, join(dataDir, 'cli', 'current'));
  }
  return dataDir;
}

const options = (dataDir: string, over: Partial<ClaudeBinOptions> = {}): ClaudeBinOptions => ({
  configured: 'claude',
  dataDir,
  distribution: 'docker',
  override: () => null,
  pinned: () => '2.1.302',
  range: '>=2.1 <3',
  ...over,
});

test('the binary the person set in Settings wins over a valid overlay', () => {
  const dataDir = dataWith('2.1.303');
  assert.equal(resolveClaudeBin(options(dataDir, { override: () => '/opt/claude' })), '/opt/claude');
});

test('a valid overlay is used by absolute path, ahead of the name looked up on PATH', () => {
  const dataDir = dataWith('2.1.303');
  assert.equal(resolveClaudeBin(options(dataDir)), join(dataDir, 'cli', '2.1.303', 'bin', 'claude'));
});

test('with no overlay the configured name is kept', () => {
  assert.equal(resolveClaudeBin(options(dataWith(null))), 'claude');
});

test('an overlay not newer than the image pin is ignored', () => {
  assert.equal(resolveClaudeBin(options(dataWith('2.1.302'))), 'claude');
  assert.equal(resolveClaudeBin(options(dataWith('2.1.301'))), 'claude');
});

test('an overlay outside the driver range, a non-executable one, or outside the container is ignored', () => {
  assert.equal(resolveClaudeBin(options(dataWith('3.0.0'))), 'claude');
  assert.equal(resolveClaudeBin(options(dataWith('2.1.303', { executable: false }))), 'claude');
  assert.equal(resolveClaudeBin(options(dataWith('2.1.303'), { distribution: 'deb' })), 'claude');
});

test('after an install the driver launches the overlay by absolute path', async () => {
  const pinned = process.env.CLAUDIO_CLAUDE_CODE_PINNED;
  process.env.CLAUDIO_CLAUDE_CODE_PINNED = '2.1.302';
  const config = tempConfig();
  config.distribution = 'docker';
  const core = new Core(config);
  after(() => {
    if (pinned === undefined) delete process.env.CLAUDIO_CLAUDE_CODE_PINNED;
    else process.env.CLAUDIO_CLAUDE_CODE_PINNED = pinned;
  });
  const spec = { id: 'x', nativeId: null, created: false, forkFrom: null, name: 'x', cwd: '/tmp', permissionMode: 'default', model: null, effort: null, confine: null, maxBudgetUsd: null, permissionPrompts: 'none', jsonSchema: null, internal: false, policy: null } as unknown as SessionLaunch;
  const driver = core.runtime.providers.driverFor('claude-code');
  assert.ok(driver);
  assert.equal(driver.launch(spec).bin, 'claude');
  // What the installer leaves behind: the version's directory and the link to it
  const bin = join(config.dataDir, 'cli', '2.1.303', 'bin', 'claude');
  mkdirSync(join(config.dataDir, 'cli', '2.1.303', 'bin'), { recursive: true });
  writeFileSync(bin, '#!/bin/sh\necho "2.1.303 (Claude Code)"\n');
  chmodSync(bin, 0o755);
  symlinkSync('2.1.303', join(config.dataDir, 'cli', 'current'));
  assert.equal(driver.launch(spec).bin, bin);
  assert.equal(config.claudeBin, bin);
  // The version the card and /api/system read comes from running that same path
  const system = await core.system(true);
  assert.equal(system.cli.version, '2.1.303');
  assert.equal(system.cli.path, bin);
  await core.shutdown?.();
});
