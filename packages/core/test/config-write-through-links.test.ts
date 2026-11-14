import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { writeAtomic } from '../src/config/files.ts';

let root: string;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'claudio-core-links-'));
});
after(() => rmSync(root, { recursive: true, force: true }));

test('an editor\'s save of a symlinked file keeps the link and writes the file it points at', async () => {
  // The owner's agents/shipcast.md is such a link into their own repository
  const real = join(root, 'repo-agent.md');
  const link = join(root, 'agent.md');
  writeFileSync(real, 'before');
  symlinkSync(real, link);
  await writeAtomic(link, 'after');
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readFileSync(real, 'utf8'), 'after');
});

test('a save of a plain file still replaces it whole, with the mode asked for', async () => {
  const file = join(root, 'plain.json');
  await writeAtomic(file, '{}', 0o600);
  assert.equal(readFileSync(file, 'utf8'), '{}');
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
});
