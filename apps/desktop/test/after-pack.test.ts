import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
// @ts-expect-error a plain .mjs build hook with no types
import { dropGroupWrite } from '../scripts/after-pack.mjs';

test('a packed tree built under umask 002 loses group and other write, and keeps everything else', () => {
  const root = mkdtempSync(join(tmpdir(), 'claudio-after-pack-'));
  try {
    const server = join(root, 'resources', 'server');
    mkdirSync(server, { recursive: true });
    const guard = join(server, 'guard.mjs');
    const bin = join(root, 'claudio');
    writeFileSync(guard, 'export {}');
    writeFileSync(bin, '#!/bin/sh');
    chmodSync(guard, 0o664);
    chmodSync(bin, 0o775);
    chmodSync(server, 0o775);
    symlinkSync(guard, join(root, 'link.mjs'));
    assert.ok(dropGroupWrite(root) >= 3);
    assert.equal(statSync(guard).mode & 0o777, 0o644);
    assert.equal(statSync(bin).mode & 0o777, 0o755);
    assert.equal(statSync(server).mode & 0o777, 0o755);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
