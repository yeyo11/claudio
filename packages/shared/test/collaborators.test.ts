import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COLLABORATORS_KINDS, notificationsFor, type ClaudioEvent, type CollaboratorsKind, type SyncState } from '../src/index.ts';

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
