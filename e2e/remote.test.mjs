// `pnpm e2e:remote`'s own logic, without GitHub: which specs a prefix names, how many shards, which
// listed run is the one a dispatch started, and the command line.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultShards, matchSpecs, parseArgs, pickRun } from './remote.mjs';

const files = ['a11y-core.spec.mjs', 'a11y-shell.spec.mjs', 'config.spec.mjs', 'palette.spec.mjs', 'README.md'];

test('a prefix names the specs that start with it, as e2e/run.mjs picks them; none names the whole suite', () => {
  assert.deepEqual(matchSpecs(['a11y'], files), { matched: ['a11y-core.spec.mjs', 'a11y-shell.spec.mjs'], unknown: [] });
  assert.deepEqual(matchSpecs([], files).matched, ['a11y-core.spec.mjs', 'a11y-shell.spec.mjs', 'config.spec.mjs', 'palette.spec.mjs']);
});

test('a prefix that names no spec is reported, so a typo cannot pass as an empty green run', () => {
  assert.deepEqual(matchSpecs(['config', 'palete'], files), { matched: ['config.spec.mjs'], unknown: ['palete'] });
});

test('the whole suite gets 4 shards; a few specs get one per two, between 1 and 4', () => {
  assert.equal(defaultShards(90, true), 4);
  assert.equal(defaultShards(1, false), 1);
  assert.equal(defaultShards(2, false), 1);
  assert.equal(defaultShards(5, false), 3);
  assert.equal(defaultShards(30, false), 4);
});

test('the run picked is the newest dispatch of this commit created after the dispatch', () => {
  const since = Date.parse('2026-10-17T14:00:00Z');
  const runs = [
    { databaseId: 1, headSha: 'abc', createdAt: '2026-10-17T13:50:00Z' },
    { databaseId: 2, headSha: 'def', createdAt: '2026-10-17T14:00:03Z' },
    { databaseId: 3, headSha: 'abc', createdAt: '2026-10-17T14:00:02Z' },
    { databaseId: 4, headSha: 'abc', createdAt: '2026-10-17T14:00:04Z' },
  ];
  assert.equal(pickRun(runs, 'abc', since)?.databaseId, 4);
  assert.equal(pickRun(runs, 'zzz', since), null);
  assert.equal(pickRun(runs.slice(0, 1), 'abc', since), null);
});

test('the command line: prefixes (spaces or commas), --shards 1 to 4, --wait <run id>', () => {
  assert.deepEqual(parseArgs(['config,palette', 'a11y']), { prefixes: ['config', 'palette', 'a11y'], shards: null, wait: null });
  assert.deepEqual(parseArgs(['--shards', '2', 'a11y']), { prefixes: ['a11y'], shards: 2, wait: null });
  assert.deepEqual(parseArgs(['--wait', '39037264501']), { prefixes: [], shards: null, wait: '39037264501' });
  assert.throws(() => parseArgs(['--shards', '5']), /1 to 4/);
  assert.throws(() => parseArgs(['--wait', 'x']), /run id/);
  assert.throws(() => parseArgs(['--fast']), /unknown option/);
  assert.throws(() => parseArgs(['$(rm -rf ~)']), /spec prefix/);
});
