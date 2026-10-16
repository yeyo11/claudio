import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { GuardLaunch } from '../src/guards/command.ts';
import { sweepGuardFiles, writeGuardFiles } from '../src/guards/files.ts';
import { DEFAULT_LIMITS, type GuardRulesFile } from '../src/guards/input.ts';

const launch: GuardLaunch = { execPath: '/usr/bin/node', entry: '/opt/claudio/guard.mjs', electron: false, nodeVersion: '22.21.0' };
const rules = (root = '/work'): GuardRulesFile => ({
  version: 1,
  mode: 'enforce',
  rules: ['integrity', 'push'],
  roots: [root],
  mainCheckout: null,
  hooksPathDir: null,
  dataDir: '/data',
  guardDir: '/opt/claudio',
  claudeConfigDirs: [],
  protectConfigs: [],
  knownSecretSha256: [],
  limits: { ...DEFAULT_LIMITS },
});
const dataDir = () => mkdtempSync(join(tmpdir(), 'claudio-guards-files-'));
const mode = (path: string) => statSync(path).mode & 0o777;
const DAY = 24 * 3600 * 1000;

describe('guard files', () => {
  it('writes both files at 0600 in a 0700 folder', () => {
    const dir = dataDir();
    const files = writeGuardFiles(dir, rules(), launch);
    assert.equal(mode(join(dir, 'guards')), 0o700);
    assert.equal(mode(files.rulesPath), 0o600);
    assert.equal(mode(files.settingsPath), 0o600);
  });

  it('names the rules by their content and the settings point at them', () => {
    const dir = dataDir();
    const files = writeGuardFiles(dir, rules(), launch);
    const bytes = readFileSync(files.rulesPath);
    assert.equal(files.rulesSha256, createHash('sha256').update(bytes).digest('hex'));
    assert.ok(files.rulesPath.endsWith(`${files.rulesSha256.slice(0, 16)}.rules.json`));
    const settings = JSON.parse(readFileSync(files.settingsPath, 'utf8')) as {
      disableAllHooks: boolean;
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout: number }> }>>;
    };
    assert.equal(settings.disableAllHooks, false);
    const pre = settings.hooks.PreToolUse?.[0];
    assert.equal(pre?.matcher, '*');
    assert.ok(pre?.hooks[0]?.command.includes(`--sha256 ${files.rulesSha256}`));
    assert.ok(pre?.hooks[0]?.command.endsWith('--event pre-tool-use'));
    assert.ok(settings.hooks.SessionStart?.[0]?.hooks[0]?.command.endsWith('--event session-start'));
    assert.equal(pre?.hooks[0]?.timeout, 30);
    assert.deepEqual(Object.keys(settings.hooks).sort(), ['PreToolUse', 'SessionStart']);
  });

  it('gives equal rules one name whatever the key order, and other rules another', () => {
    const dir = dataDir();
    const a = writeGuardFiles(dir, rules(), launch);
    const reordered = Object.fromEntries(Object.entries(rules()).reverse()) as unknown as GuardRulesFile;
    assert.equal(writeGuardFiles(dir, reordered, launch).rulesPath, a.rulesPath);
    assert.notEqual(writeGuardFiles(dir, rules('/other'), launch).rulesPath, a.rulesPath);
  });

  it('rewrites a tampered rules file and a loosened mode', () => {
    const dir = dataDir();
    const files = writeGuardFiles(dir, rules(), launch);
    const original = readFileSync(files.rulesPath, 'utf8');
    writeFileSync(files.rulesPath, '{"version":1,"rules":[]}');
    chmodSync(files.settingsPath, 0o644);
    writeGuardFiles(dir, rules(), launch);
    assert.equal(readFileSync(files.rulesPath, 'utf8'), original);
    assert.equal(mode(files.settingsPath), 0o600);
  });

  it('replaces a link standing in for a file', () => {
    const dir = dataDir();
    const files = writeGuardFiles(dir, rules(), launch);
    const copy = join(dir, 'copy.json');
    writeFileSync(copy, readFileSync(files.rulesPath));
    unlinkSync(files.rulesPath);
    symlinkSync(copy, files.rulesPath);
    writeGuardFiles(dir, rules(), launch);
    assert.ok(!lstatSync(files.rulesPath).isSymbolicLink());
    assert.equal(readFileSync(files.rulesPath, 'utf8'), readFileSync(copy, 'utf8'));
    assert.ok(readdirSync(join(dir, 'guards')).every((name) => !name.endsWith('.tmp')));
  });
});

describe('guard sweep', () => {
  const age = (path: string, days: number) => utimesSync(path, new Date(Date.now() - days * DAY), new Date(Date.now() - days * DAY));

  it('removes old files no launch names, and keeps recent ones', () => {
    const dir = dataDir();
    const old = writeGuardFiles(dir, rules('/old'), launch);
    const fresh = writeGuardFiles(dir, rules('/fresh'), launch);
    for (const path of [old.rulesPath, old.settingsPath]) age(path, 8);
    const removed = sweepGuardFiles(dir, []);
    assert.deepEqual(removed.sort(), [old.rulesPath, old.settingsPath].sort());
    assert.ok(statSync(fresh.rulesPath).isFile() && statSync(fresh.settingsPath).isFile());
  });

  it('never removes the files of a live launch, however old', () => {
    const dir = dataDir();
    const files = writeGuardFiles(dir, rules('/live'), launch);
    age(files.rulesPath, 30);
    age(files.settingsPath, 30);
    assert.deepEqual(sweepGuardFiles(dir, [files.rulesPath, files.settingsPath]), []);
    assert.ok(statSync(files.rulesPath).isFile());
    assert.equal(sweepGuardFiles(dir, [files.settingsPath]).length, 1);
    assert.ok(statSync(files.settingsPath).isFile());
  });

  it('leaves files it does not own and a missing folder alone', () => {
    const dir = dataDir();
    assert.deepEqual(sweepGuardFiles(dir, []), []);
    const files = writeGuardFiles(dir, rules(), launch);
    const other = join(dir, 'guards', 'notes.txt');
    writeFileSync(other, 'x');
    age(other, 30);
    age(files.rulesPath, 30);
    sweepGuardFiles(dir, []);
    assert.ok(statSync(other).isFile());
  });

  it('keeps a file a launch rewrote after it had aged', () => {
    const dir = dataDir();
    const files = writeGuardFiles(dir, rules(), launch);
    age(files.rulesPath, 30);
    writeGuardFiles(dir, rules(), launch);
    assert.deepEqual(sweepGuardFiles(dir, []), []);
  });
});
