import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COLLABORATORS_HREF, COLLABORATORS_KINDS, interrupts, notificationsFor, settlesWaiting, type ClaudioEvent, type CollaboratorsKind, type JoinRequest, type NotificationDraft, type SyncState } from '../src/index.ts';

test('COLLABORATORS_KINDS lists every kind a shared project carries, once', () => {
  // A record over the union fails to compile when a kind is added without being listed here
  const every: Record<CollaboratorsKind, true> = { chats: true, memory: true, journal: true, documents: true, artifacts: true, board: true };
  assert.deepEqual([...COLLABORATORS_KINDS].sort(), Object.keys(every).sort());
  assert.equal(new Set(COLLABORATORS_KINDS).size, COLLABORATORS_KINDS.length);
});

test("a teammate's presence or a finished pull wakes nobody", () => {
  // Syncing is not an agent working and a peer coming online is not news: both only refresh the page
  const sync: SyncState = { state: 'live', lastSyncedAt: '2026-10-16T10:00:00.000Z', path: 'relay', error: null };
  const events: ClaudioEvent[] = [
    { id: 1, at: '', title: 'Ana online', type: 'collaborators.peer', endpointId: 'a'.repeat(64), name: 'Ana', presence: { online: true, path: 'relay', lastSeenAt: null } },
    { id: 2, at: '', title: 'Synced', type: 'collaborators.synced', owner: 'a'.repeat(64), shareKey: 'github.com/acme/api', shareId: '0'.repeat(32), kind: 'chats', sync },
    { id: 3, at: '', title: 'Roster changed', type: 'collaborators.changed', scope: 'roster', groupId: 'g', projectId: null },
  ];
  for (const event of events) assert.deepEqual(notificationsFor(event), [], event.type);
});

const GROUP = 'a'.repeat(64);
const CLEO = 'c'.repeat(64);
const joinRequest = (fields: Partial<JoinRequest> = {}): ClaudioEvent => ({
  id: 4,
  at: '2026-10-16T10:00:00.000Z',
  title: 'Cleo asks to join Platform',
  type: 'collaborators.join-request',
  groupName: 'Platform',
  request: { groupId: GROUP, from: CLEO, name: 'Cleo', relayedBy: null, receivedAt: '2026-10-16T09:59:00.000Z', expiresAt: '2026-10-23T09:00:00.000Z', ...fields },
});
const onlyDraft = (event: ClaudioEvent): NotificationDraft => {
  const drafts = notificationsFor(event);
  assert.equal(drafts.length, 1);
  return drafts[0] as NotificationDraft;
};

test('a join request is news for the owner, sent to the page where it is answered', () => {
  const direct = onlyDraft(joinRequest());
  assert.equal(direct.kind, 'collaborators');
  assert.equal(direct.href, COLLABORATORS_HREF);
  assert.equal(direct.title, 'Cleo asks to join Platform');
  assert.equal(direct.body, 'Accept or deny it on the Collaborators page.');
  // A teammate waits on it: it reaches a phone at the default level, and never twice for one request
  assert.equal(interrupts(direct, 'important'), true);
  assert.equal(direct.dedupeMs, 0);

  const relayed = onlyDraft(joinRequest({ relayedBy: { endpointId: 'b'.repeat(64), name: 'Ben' } }));
  assert.equal(relayed.body, 'Relayed by Ben. Accept or deny it on the Collaborators page.');
  // The same request handed over again is the same news; one made with a later invite is new
  assert.equal(relayed.key, direct.key);
  assert.notEqual(onlyDraft(joinRequest({ expiresAt: '2026-10-30T09:00:00.000Z' })).key, direct.key);
});

test("answering a join, or losing it, settles that join's notification and no other", () => {
  const mine = onlyDraft(joinRequest());
  const otherJoiner = onlyDraft(joinRequest({ from: 'd'.repeat(64) }));
  const otherGroup = onlyDraft(joinRequest({ groupId: 'e'.repeat(64) }));
  for (const answer of ['accepted', 'denied', 'dropped'] as const) {
    const settles = settlesWaiting({ id: 5, at: '', title: 'answered', type: 'collaborators.join-answered', groupId: GROUP, from: CLEO, answer });
    assert.ok(settles, answer);
    assert.equal(settles(mine), true);
    assert.equal(settles(otherJoiner), false);
    assert.equal(settles(otherGroup), false);
  }
  assert.equal(settlesWaiting(joinRequest()), null);
});
