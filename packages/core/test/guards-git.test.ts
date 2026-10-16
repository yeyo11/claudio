import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KNOWN_GIT_VERBS, configKeyKind, configWrite, parseGit, pushForces, resetsHard, skipsHooks } from '../src/guards/git.ts';

const words = (line: string) => line.split(' ').map((text) => ({ text, dynamic: false }));

describe('guard git tables', () => {
  it('finds the verb behind global options', () => {
    const call = parseGit(words('-C ../x -c core.pager=cat --no-pager --git-dir=.git push origin'));
    assert.equal(call.verb, 'push');
    assert.equal(call.dirs[0]?.text, '../x');
    assert.equal(call.configs[0]?.key, 'core.pager');
    assert.deepEqual(call.args.map((a) => a.text), ['origin']);
  });
  it('clusters -n on commit the way git does', () => {
    const skips = (args: string) => skipsHooks('commit', words(args));
    for (const yes of ['-n -m x', '-an', '-anm x', '-nm x', '--no-ver', '--no-verify']) assert.ok(skips(yes), yes);
    for (const no of ['-mn', '-am msg', '--no-edit', '-m x']) assert.ok(!skips(no), no);
    assert.ok(!skipsHooks('push', words('-n')));
    assert.ok(skipsHooks('merge', words('--no-verify')));
  });
  it('knows built-in verbs and not aliases', () => {
    assert.ok(KNOWN_GIT_VERBS.has('commit') && KNOWN_GIT_VERBS.has('worktree'));
    assert.ok(!KNOWN_GIT_VERBS.has('p'));
  });
  it('compares config keys case-insensitively', () => {
    assert.equal(configKeyKind('CORE.HOOKSPATH'), 'hooks-path');
    assert.equal(configKeyKind('alias.p'), 'other');
    assert.equal(configKeyKind('user.name'), null);
    assert.equal(configKeyKind('remote.origin.pushurl'), 'other');
  });
  it('tells reads from writes in git config', () => {
    assert.equal(configWrite(words('--get core.hooksPath')), null);
    assert.deepEqual(configWrite(words('--global include.path /x'))?.keys, ['include.path']);
    assert.deepEqual(configWrite(words('--unset core.hooksPath'))?.keys, ['core.hooksPath']);
  });
  it('detects forces and hard resets, with abbreviations', () => {
    for (const yes of ['-f', '--force-with-lease=x', 'origin +main', 'origin :main', '--mirror', '-uf origin b', '--delete']) assert.ok(pushForces(words(yes)), yes);
    assert.ok(!pushForces(words('origin main')));
    assert.ok(resetsHard(words('--har HEAD')) && !resetsHard(words('--soft HEAD~1')));
  });
});
