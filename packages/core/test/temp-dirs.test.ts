import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { toolRisk } from '@claudio/shared';
import { systemTempDirs } from '../src/temp-dirs.ts';

test('the temp directories are os.tmpdir() and a $TMPDIR that differs, without repeats', () => {
  const before = process.env.TMPDIR;
  try {
    process.env.TMPDIR = '/run/scratch';
    assert.deepEqual(systemTempDirs(), [...new Set([tmpdir(), '/run/scratch'])]);
    process.env.TMPDIR = tmpdir();
    assert.deepEqual(systemTempDirs(), [tmpdir()]);
  } finally {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
  }
});

test('a write under the temp directories of this machine is not outside the working directory', () => {
  const risk = toolRisk({ name: 'Write', input: { file_path: `${tmpdir()}/scratch.json` } }, { cwd: '/home/x/p', tempDirs: systemTempDirs() });
  assert.deepEqual(risk.factors, []);
});
