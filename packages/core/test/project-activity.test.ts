import assert from 'node:assert/strict';
import test from 'node:test';
import type { RotationPolicy } from '@claudio/shared';
import { NO_PROJECT, noRoomRuleOf, noRoomWords, ProjectActivity, reservesOf } from '../src/project-activity.ts';

// Work in progress per project and the reserves it activates (§7.2 of
// docs/plans/account-configuration-and-project-rules.md), with an injected clock.

const rule = (over: Partial<RotationPolicy> & { projects: string[] }): RotationPolicy => ({ id: `r-${over.projects.join('-')}`, ...over });

test('a project has work in progress while a source runs work in one of its folders, and chats of no project count under their own key', () => {
  const projects: Record<string, string> = { '/w/p1': 'p1', '/w/p1/sub': 'p1', '/w/p2': 'p2' };
  const activity = new ProjectActivity(() => (dir) => projects[dir] ?? null);
  let running = ['/w/p1/sub', '/elsewhere'];
  activity.add(() => running);
  assert.deepEqual([...activity.projects()].sort(), [NO_PROJECT, 'p1']);
  running = [];
  assert.deepEqual([...activity.projects()], [], 'nothing runs: nothing is in progress');
});

test("a folder's project is remembered for a while, then looked up again", () => {
  let now = 0;
  let lookups = 0;
  let owner: string | null = 'p1';
  const activity = new ProjectActivity(() => () => (lookups++, owner), () => now);
  activity.add(() => ['/w/a']);
  activity.projects();
  activity.projects();
  assert.equal(lookups, 1, 'one lookup per folder within the window');
  owner = 'p2';
  now += 31_000;
  assert.deepEqual([...activity.projects()], ['p2']);
  assert.equal(lookups, 2);
});

test('a source that throws adds nothing and does not hide the others', () => {
  const activity = new ProjectActivity(() => () => 'p1');
  activity.add(() => {
    throw new Error('gone');
  });
  activity.add(() => ['/w']);
  assert.deepEqual([...activity.projects()], ['p1']);
});

test('no source is asked while no rule reserves, so a choice without reserves costs nothing', () => {
  const activity = new ProjectActivity(() => () => 'p1');
  let asked = 0;
  activity.add(() => (asked++, ['/w']));
  assert.deepEqual(activity.reserves([rule({ projects: ['p1'], order: ['a'] })]), []);
  assert.equal(asked, 0);
  assert.deepEqual(activity.reserves([rule({ projects: ['p1'], order: ['a'], reserve: { percent: 20 } })]), [{ project: 'p1', account: 'a', percent: 20 }]);
  assert.equal(asked, 1);
});

test("a reserve sits on the rule's preferred account, else the first of its order, only for the projects with work", () => {
  const policies = [
    rule({ projects: ['p1', 'p3'], order: ['a', 'b'], preferred: 'b', reserve: { percent: 25 } }),
    rule({ projects: ['p2'], order: ['c'], reserve: { percent: 10 } }),
    rule({ projects: [], looseChats: true, order: ['d'], reserve: { percent: 5 } }),
    rule({ projects: ['p4'], reserve: { percent: 30 } }),
  ];
  assert.deepEqual(reservesOf(policies, new Set(['p1', 'p2', 'p4'])), [
    { project: 'p1', account: 'b', percent: 25 },
    { project: 'p2', account: 'c', percent: 10 },
  ], 'p3 has no work, and a rule that names no account has nowhere to reserve');
  assert.deepEqual(reservesOf(policies, new Set([NO_PROJECT])), [{ project: NO_PROJECT, account: 'd', percent: 5 }], "loose chats hold their rule's reserve");
  assert.deepEqual(reservesOf(policies, new Set()), []);
});

test('the no-room words name the rule only when it kept the work off an account, with the earliest reset', () => {
  const reset = Date.parse('2026-11-15T18:00:00Z');
  assert.equal(
    noRoomWords({ account: null, waitUntil: reset, why: { basis: 'none', passedOver: [{ account: 'x', because: 'not-allowed', project: 'p1' }] } }),
    'no account allowed on project p1 has room until 2026-11-15T18:00:00.000Z',
  );
  assert.equal(noRoomWords({ account: null, waitUntil: null, why: { basis: 'none', passedOver: [{ account: 'x', because: 'not-allowed' }] } }), 'no account allowed on chats of no project has room');
  assert.equal(noRoomWords({ account: null, waitUntil: reset, why: { basis: 'none' } }), null, 'no rule narrowed the accounts: the lack of room is told as before');
  assert.equal(noRoomWords({ account: 'a', waitUntil: null, why: { basis: 'order', passedOver: [{ account: 'x', because: 'not-allowed' }] } }), null, 'an account had room');
  assert.equal(noRoomWords(null), null);
});

test('the no-room rule is data: the project by id (null for chats of no project), the reset and the choices left', () => {
  const reset = Date.parse('2026-11-15T18:00:00Z');
  const choice = { account: null, waitUntil: reset, why: { basis: 'none' as const, passedOver: [{ account: 'x', because: 'not-allowed' as const, project: 'p1' }] } };
  assert.deepEqual(noRoomRuleOf(choice), { project: 'p1', resetsAt: '2026-11-15T18:00:00.000Z', choices: ['wait'] });
  assert.deepEqual(noRoomRuleOf(choice, ['wait', 'once'])?.choices, ['wait', 'once'], "a person's chat may also take one turn elsewhere");
  assert.equal(noRoomRuleOf({ account: null, waitUntil: null, why: { basis: 'none', passedOver: [{ account: 'x', because: 'not-allowed', project: NO_PROJECT }] } })?.project, null);
  assert.equal(noRoomRuleOf({ account: null, waitUntil: reset, why: { basis: 'none' } }), null);
  // The English words are the same rule's
  const rule = noRoomRuleOf(choice);
  assert.equal(noRoomWords(rule), noRoomWords(choice));
});
