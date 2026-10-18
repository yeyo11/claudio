import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  aheadCount,
  aheadCountAsync,
  commitsBetween,
  commitsBetweenAsync,
  diffFiles,
  diffFilesAsync,
  fileDiff,
  fileDiffAsync,
  git,
  gitRaw,
  gitRawAsync,
  isGitRepo,
  isGitRepoAsync,
  mergeBase,
  mergeBaseAsync,
  parentOf,
  parentOfAsync,
  uncommittedFiles,
  uncommittedFilesAsync,
  untrackedDiff,
  untrackedDiffAsync,
} from '../src/git.ts';

const run = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();

function repo(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'claudio-git-async-'));
  run(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
  run(dir, 'add', '.');
  run(dir, 'commit', '-q', '-m', 'first');
  const base = run(dir, 'rev-parse', 'HEAD');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'b.txt'), 'b\n');
  run(dir, 'add', '.');
  run(dir, 'commit', '-q', '-m', 'second');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n');
  writeFileSync(join(dir, 'new.txt'), 'fresh\n');
  return { dir, base };
}

test('every async twin answers what its sync original answers', async () => {
  const { dir, base } = repo();
  assert.equal(await isGitRepoAsync(dir), isGitRepo(dir));
  assert.equal(await isGitRepoAsync(tmpdir()), false);
  assert.equal(await aheadCountAsync(dir, base), aheadCount(dir, base));
  assert.deepEqual(await commitsBetweenAsync(dir, base), commitsBetween(dir, base));
  assert.deepEqual(await diffFilesAsync(dir, base, 'HEAD'), diffFiles(dir, base, 'HEAD'));
  assert.deepEqual(await uncommittedFilesAsync(dir), uncommittedFiles(dir));
  assert.equal(await mergeBaseAsync(dir, 'HEAD', base), mergeBase(dir, 'HEAD', base));
  assert.equal(await parentOfAsync(dir, base), parentOf(dir, base), 'a root commit is measured against the empty tree');
  assert.equal(await fileDiffAsync(dir, base, undefined, ['a.txt']), fileDiff(dir, base, undefined, ['a.txt']));
  assert.equal(await untrackedDiffAsync(dir, 'new.txt'), untrackedDiff(dir, 'new.txt'));
});

test('a failing git call reads the same sync and async, and output past the buffer keeps its code', async () => {
  const { dir } = repo();
  const args = ['rev-parse', '--verify', 'no-such-ref'];
  let sync = '';
  try {
    gitRaw(dir, args);
  } catch (err) {
    sync = (err as Error).message;
  }
  await assert.rejects(() => gitRawAsync(dir, args), (err: Error) => err.message === sync && sync.startsWith('git rev-parse:'));
  await assert.rejects(
    () => gitRawAsync(dir, ['log', '--format=%H'], { maxBuffer: 10 }),
    (err: Error & { code?: string }) => err.code === 'ENOBUFS' && /output too large/.test(err.message),
  );
});

test('the event loop keeps turning while an async git call runs, and stops for the sync one', async () => {
  const { dir } = repo();
  // A git alias that sleeps stands for a diff of a huge branch, with a duration that does not depend on the machine
  const slow = ['-c', 'alias.slow=!sleep 0.4', 'slow'];
  let ticks = 0;
  let running = true;
  const spin = (): void => {
    if (!running) return;
    ticks += 1;
    setImmediate(spin);
  };
  setImmediate(spin);
  await gitRawAsync(dir, slow, { timeout: 10_000 });
  const during = ticks;
  assert.ok(during > 20, `the loop turned ${String(during)} times while git slept`);

  ticks = 0;
  git(dir, slow, 10_000);
  // The sync call held the loop for its whole 400 ms: nothing ran in between
  assert.ok(ticks <= 1, `the loop turned ${String(ticks)} times while the sync call held it`);
  running = false;
});
