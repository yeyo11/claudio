import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  createLane,
  ensureLanesRoot,
  estimateDisk,
  lanesRoot,
  LanesError,
  removeRunLanes,
  resetLane,
  sweepLanes,
} from '../src/evals/lanes.js';

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();

describe('eval lanes', () => {
  let tmp: string;
  let repo: string;
  let root: string;
  let pin: string;
  const runId = 'abcdef12-0000-0000-0000-000000000000';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'claudio-lanes-'));
    repo = join(tmp, 'repo');
    root = join(tmp, 'lanes');
    mkdirSync(repo);
    sh(repo, 'init', '-q');
    // The hook of a person's repository: it must not run for an eval checkout
    const hook = join(repo, '.git', 'hooks', 'post-checkout');
    writeFileSync(hook, `#!/bin/sh\necho ran > "${join(tmp, 'hook-marker')}"\n`);
    chmodSync(hook, 0o755);
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-q', '-m', 'init');
    pin = sh(repo, 'rev-parse', 'HEAD');
    ensureLanesRoot(root);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('adds a detached, locked lane without running the repository hook', async () => {
    const lane = await createLane(repo, root, runId, 1, pin);
    assert.equal(lane.path, join(root, 'abcdef12', 'lane1'));
    assert.equal(readFileSync(join(lane.path, 'a.txt'), 'utf8'), 'one\n');
    assert.equal(existsSync(join(tmp, 'hook-marker')), false);
    assert.equal(sh(repo, 'branch', '--list').includes('lane'), false);
    assert.match(sh(repo, 'worktree', 'list', '--porcelain'), /locked claudio eval abcdef12/);
    await resetLane(lane, pin);
    assert.equal(existsSync(join(tmp, 'hook-marker')), false);
  });

  it('resets, cleans ignored files and writes the overlay between samples', async () => {
    const lane = await createLane(repo, root, runId, 1, pin);
    writeFileSync(join(lane.path, 'a.txt'), 'dirty\n');
    writeFileSync(join(lane.path, 'junk.txt'), 'x');
    await resetLane(lane, pin, { '.claude/agents/x.md': 'agent', 'b.txt': 'two' });
    assert.equal(readFileSync(join(lane.path, 'a.txt'), 'utf8'), 'one\n');
    assert.equal(existsSync(join(lane.path, 'junk.txt')), false);
    assert.equal(readFileSync(join(lane.path, '.claude/agents/x.md'), 'utf8'), 'agent');
    await resetLane(lane, pin);
    assert.equal(existsSync(join(lane.path, 'b.txt')), false);
    await assert.rejects(resetLane(lane, pin, { '../escape': 'x' }), LanesError);
  });

  it('creates lanes of one repository one at a time', async () => {
    const lanes = await Promise.all([1, 2, 3].map((n) => createLane(repo, root, runId, n, pin)));
    assert.equal(lanes.length, 3);
    assert.equal(sh(repo, 'worktree', 'list').split('\n').length, 4);
  });

  it('leaves no lane in git worktree list after removal, and keeps the others', async () => {
    const mine = join(tmp, 'mine');
    sh(repo, 'worktree', 'add', '--detach', mine, pin);
    await createLane(repo, root, runId, 1, pin);
    await removeRunLanes(repo, root, runId);
    const list = sh(repo, 'worktree', 'list');
    assert.equal(list.includes('eval'), false);
    assert.equal(list.includes(root), false);
    assert.equal(list.includes(mine), true);
    assert.equal(existsSync(join(root, 'abcdef12')), false);
  });

  it('sweeps the lanes a killed process left, but not those of a live run', async () => {
    await createLane(repo, root, runId, 1, pin);
    await createLane(repo, root, '99999999-0000-0000-0000-000000000000', 1, pin);
    const swept = await sweepLanes(root, (dir) => dir === '99999999');
    assert.deepEqual(swept, [join(root, 'abcdef12', 'lane1')]);
    assert.equal(existsSync(join(root, 'abcdef12')), false);
    assert.equal(existsSync(join(root, '99999999', 'lane1')), true);
    const list = sh(repo, 'worktree', 'list');
    assert.equal(list.includes('abcdef12'), false);
    assert.equal(list.includes('99999999'), true);
  });

  it('refuses a root below a directory with instructions', () => {
    writeFileSync(join(tmp, 'CLAUDE.md'), 'x');
    assert.throws(
      () => ensureLanesRoot(root),
      (e: unknown) => e instanceof LanesError && e.code === 'lanes-root-contaminated' && e.path === join(tmp, 'CLAUDE.md'),
    );
  });

  it('puts the root under CLAUDIO_EVALS_DIR or the data dir, never a fixed /tmp', () => {
    assert.equal(lanesRoot('/data', {}), '/data/eval-lanes');
    assert.equal(lanesRoot('/data', { CLAUDIO_EVALS_DIR: '/elsewhere' }), '/elsewhere');
  });

  it('estimates the files of the pinned tree', () => {
    const est = estimateDisk(repo, pin);
    assert.equal(est.files, 1);
    assert.equal(est.warning, false);
  });
});
