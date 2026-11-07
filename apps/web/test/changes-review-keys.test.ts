import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChangesUpdatedEvent } from '@claudio/shared';
import { keys } from '../src/api';
import { LIVE_REFRESH_MS, liveRefresh } from '../src/components/changes/source';
import { targetMatches, targetsFor, type Target } from '../src/lib/events';

// The review screen caches a summary, the chat panel and the work item page cache the whole
// response. Sharing a key served the page's object to the review, which threw on `files`.
test("the review screen's summary never shares a cache key with the panel's whole response", () => {
  for (const scope of [{}, { commit: 'abc' }, { uncommitted: true }]) {
    assert.notDeepEqual(keys.workItemChangesReview('w1', scope), keys.workItemChanges('w1', scope));
    assert.notDeepEqual(keys.chatChangesReview('c1', scope), keys.chatChanges('c1', scope));
  }
});

test('the review keys are still refreshed by what refreshes the item and the chat', () => {
  const item: Target = [keys.workItem('w1'), 0];
  assert.ok(targetMatches(item, keys.workItemChangesReview('w1')));
  // Like the page's own changes, a work item's review is left alone by a 'no-diffs' target
  assert.equal(targetMatches([keys.workItem('w1'), 0, 'no-diffs'], keys.workItemChangesReview('w1')), false);
  assert.ok(targetMatches([['chat', 'c1'], 0], keys.chatChangesReview('c1')));
});

// A task and the integration branch follow `changes.updated` instead of the 8 s timer (R15 of
// docs/plans/ci-and-regression-open.md), which holds only while every read of their review sits
// under what that event refreshes
test("changes.updated refreshes every read of a task's and the integration branch's review", () => {
  const event: ChangesUpdatedEvent = {
    type: 'changes.updated',
    id: 1,
    at: '2026-11-07T10:00:00Z',
    title: 'Task t1: 1 commit, 0 uncommitted files',
    orchestrationId: 'o1',
    orchestrationName: 'O',
    taskId: 't1',
    branch: 'b',
    ahead: 1,
    uncommitted: 0,
  };
  const targets = targetsFor(event);
  const refreshed = (key: readonly unknown[]) => targets.some((target) => targetMatches(target, key));
  for (const scope of [{}, { commit: 'abc' }, { uncommitted: true }]) {
    assert.ok(refreshed(keys.taskChanges('o1', 't1', scope)));
    assert.ok(refreshed(keys.integrationChanges('o1', scope)));
  }
  for (const opts of [{}, { context: 'full' as const }]) {
    assert.ok(refreshed(keys.taskDiff('o1', 't1', 'a.ts', opts)));
    assert.ok(refreshed(keys.integrationDiff('o1', 'a.ts', opts)));
  }
  assert.ok(refreshed(keys.taskSteps('o1', 't1')));
});

test('a live review polls only where no event announces its moves, or while the feed is down', () => {
  // A task or the integration branch: the event, and the timer only with the feed down
  assert.equal(liveRefresh({ live: true, announced: true }, true), false);
  assert.equal(liveRefresh({ live: true, announced: true }, false), LIVE_REFRESH_MS);
  // A chat or a work item: a file a shell command writes announces nothing, so the timer stays
  assert.equal(liveRefresh({ live: true, announced: false }, true), LIVE_REFRESH_MS);
  // Nothing works on it: nothing to read again
  assert.equal(liveRefresh({ live: false, announced: false }, false), false);
  assert.equal(liveRefresh({ live: false, announced: true }, false), false);
});
