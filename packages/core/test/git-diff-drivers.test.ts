import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { diffFiles, fileDiff, probeChanges, untrackedDiff } from '../src/git.ts';

/** A repo whose .git/config names a textconv and an external diff driver that each leave a marker file. */
function repoWithDrivers() {
  const root = mkdtempSync(join(tmpdir(), 'claudio-drivers-'));
  const repo = join(root, 'repo');
  const marker = join(root, 'ran');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', encoding: 'utf8' });
  execFileSync('git', ['init', '-q', repo]);
  git('config', 'user.name', 'someone');
  git('config', 'user.email', 'someone@example.com');
  const script = join(root, 'driver.sh');
  writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\ncat "$1"\n`);
  chmodSync(script, 0o755);
  git('config', 'diff.evil.textconv', script);
  git('config', 'diff.evil.command', script);
  writeFileSync(join(repo, '.gitattributes'), '*.txt diff=evil\n');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  writeFileSync(join(repo, 'a.txt'), 'two\n');
  return { repo, marker, git };
}

test('the driver in the fixture really runs for a plain git diff', () => {
  const { repo, marker, git } = repoWithDrivers();
  git('diff');
  assert.equal(existsSync(marker), true, `${repo}: the fixture would prove nothing`);
});

test('building a diff never runs a textconv or external diff driver the repository names', async () => {
  const { repo, marker } = repoWithDrivers();
  diffFiles(repo, 'HEAD');
  fileDiff(repo, 'HEAD', undefined, ['a.txt']);
  untrackedDiff(repo, 'a.txt');
  await probeChanges(repo, null);
  assert.equal(existsSync(marker), false, 'a driver from .git/config ran while Claudio built a diff');
});
