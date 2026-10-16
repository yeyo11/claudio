import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { RosterVersion } from '@claudio/shared';
import { DEFAULT_COLLABORATORS_SETTINGS, CollaboratorsSettingsStore, parseCollaboratorsUpdate } from '../src/collab/settings.ts';
import { GroupsStore } from '../src/collab/groups-store.ts';
import { COLLAB_SCHEMA_VERSION, CollabStore, Db, migrate } from '../src/db.ts';
import { tempConfig } from './helpers.ts';

const at = '2026-10-16T10:00:00.000Z';
const later = '2026-10-16T11:00:00.000Z';
const owner = 'e'.repeat(64);
const share = { ownerId: owner, shareKey: 'github.com/acme/shop' };
const groupId = 'a'.repeat(64);

function withDb(fn: (store: CollabStore, db: Db) => void): void {
  const db = new Db(tempConfig());
  try {
    fn(new CollabStore(db.connection), db);
  } finally {
    db.close();
  }
}

const version = (n: number): RosterVersion => ({
  groupId,
  version: n,
  prevHash: n === 1 ? null : String(n - 1).repeat(64).slice(0, 64),
  name: 'Team',
  owner,
  members: [{ endpointId: owner, name: 'Ana', role: 'owner', addedAt: at }],
  issuedAt: at,
  signature: 'sig',
});

test('the Collaborators migration upgrades a database from the version before it', () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const raw = new DatabaseSync(join(config.dataDir, 'wrapper.db'));
  migrate(raw, COLLAB_SCHEMA_VERSION - 1);
  assert.equal(raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'collab_records'").get(), undefined);
  raw.prepare("INSERT INTO rotation_events (ts, event) VALUES (?, 'kept')").run(at);
  raw.close();

  const db = new Db(config);
  try {
    const sql = db.connection;
    for (const name of ['collab_records', 'collab_transcript_lines', 'collab_peers', 'collab_join_requests', 'collab_used_invites']) {
      assert.ok(sql.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name), name);
    }
    const userVersion = (sql.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    assert.ok(userVersion >= COLLAB_SCHEMA_VERSION);
    assert.equal((sql.prepare('SELECT event FROM rotation_events').get() as { event: string }).event, 'kept', 'the existing rows survived');
    const store = new CollabStore(sql);
    store.upsertRecords(share, 'journal', [{ recordId: '1', version: '1', json: '{}' }], at);
    assert.deepEqual(store.recordCounts(share), { journal: 1 });
  } finally {
    db.close();
  }
});

test('records are kept per owner, key and kind, replaced by id, reconciled and dropped with their copy', () => {
  withDb((store) => {
    const other = { ...share, shareKey: 'github.com/acme/api' };
    store.upsertRecords(share, 'chats', [
      { recordId: 'c1', version: 'v1', json: '{"title":"one"}' },
      { recordId: 'c2', version: 'v1', json: '{"title":"two"}' },
    ], at);
    store.upsertRecords(share, 'board', [{ recordId: 'c1', version: 'v1', json: '{"key":"SHOP-1"}' }], at);
    store.upsertRecords(other, 'chats', [{ recordId: 'c9', version: 'v1', json: '{}' }], at);
    store.upsertRecords(share, 'chats', [{ recordId: 'c1', version: 'v2', json: '{"title":"one, renamed"}' }], later);

    assert.deepEqual(store.record(share, 'chats', 'c1'), { ...share, kind: 'chats', recordId: 'c1', version: 'v2', json: '{"title":"one, renamed"}', syncedAt: later });
    assert.equal(store.record(share, 'board', 'c1')?.json, '{"key":"SHOP-1"}', 'the same id in another kind is another record');
    assert.deepEqual([...store.recordVersions(share, 'chats')].sort(), [['c1', 'v2'], ['c2', 'v1']]);
    assert.deepEqual(store.recordCounts(share), { chats: 2, board: 1 });

    assert.equal(store.deleteRecords(share, 'chats', ['c2', 'gone']), 1);
    assert.deepEqual(store.records(share, 'chats').map((r) => r.recordId), ['c1']);
    assert.throws(() => store.upsertRecords(share, 'terminals' as 'chats', [{ recordId: 'x', version: '1', json: '{}' }], at), /CHECK/);

    store.appendTranscriptLines(share, 's1', ['{"type":"user"}']);
    assert.deepEqual(store.shares(), [other, share].sort((a, b) => a.shareKey.localeCompare(b.shareKey)));
    store.dropShare(share);
    assert.equal(store.records(share, 'board').length, 0);
    assert.equal(store.transcriptLineCount(share, 's1'), 0);
    assert.deepEqual(store.shares(), [other]);
  });
});

test('transcript lines are numbered in order, paged, and a pull replayed from a seq replaces rather than doubles', () => {
  withDb((store) => {
    assert.equal(store.appendTranscriptLines(share, 's1', ['a', 'b', 'c']), 3);
    assert.equal(store.appendTranscriptLines(share, 's1', ['d']), 4);
    assert.equal(store.appendTranscriptLines(share, 's2', ['other']), 1);
    assert.deepEqual(store.transcriptLines(share, 's1', { after: 0, limit: 2 }), [{ seq: 1, line: 'b' }, { seq: 2, line: 'c' }]);
    // The offset was not written after the last pull: the same bytes come again, from seq 3
    assert.equal(store.appendTranscriptLines(share, 's1', ['d', 'e'], 3), 5);
    assert.deepEqual(store.transcriptLines(share, 's1').map((l) => l.line), ['a', 'b', 'c', 'd', 'e']);
    // A seq past the end leaves no gap
    assert.equal(store.appendTranscriptLines(share, 's1', ['f'], 99), 6);
    assert.equal(store.transcriptLineCount(share, 's1'), 6);
    store.deleteTranscript(share, 's1');
    assert.equal(store.transcriptLineCount(share, 's1'), 0);
    assert.equal(store.transcriptLineCount(share, 's2'), 1);
  });
});

test('a peer is seen with its path, and a connection that does not know the path keeps the last one', () => {
  withDb((store) => {
    store.seePeer(owner, at, 'relay');
    store.seePeer(owner, later, null);
    assert.deepEqual(store.peer(owner), { endpointId: owner, lastSeenAt: later, path: 'relay' });
    store.seePeer(owner, later, 'direct');
    assert.equal(store.peer(owner)?.path, 'direct');
    assert.throws(() => store.seePeer('f'.repeat(64), at, 'carrier-pigeon' as 'relay'), /CHECK/);
    assert.equal(store.peers().length, 1);
    store.forgetPeer(owner);
    assert.equal(store.peer(owner), null);
  });
});

test('relayed joins are held until forwarded or expired, and a second request from the same joiner replaces the first', () => {
  withDb((store) => {
    const joiner = 'j'.repeat(64);
    const base = { groupId, fromEndpointId: joiner, sealed: 'blob-1', relayedBy: null, expiresAt: '2026-10-23T10:00:00.000Z', receivedAt: at };
    store.putJoinRequest(base);
    store.putJoinRequest({ ...base, sealed: 'blob-2', receivedAt: later });
    store.putJoinRequest({ ...base, fromEndpointId: 'k'.repeat(64), expiresAt: '2026-10-17T00:00:00.000Z' });
    assert.equal(store.joinRequest(groupId, joiner)?.sealed, 'blob-2');
    assert.equal(store.joinRequests({ groupId }).length, 2);

    store.markJoinForwarded(groupId, joiner, later);
    assert.deepEqual(store.joinRequests({ pending: true }).map((r) => r.fromEndpointId), ['k'.repeat(64)]);
    assert.equal(store.pruneJoinRequests('2026-10-16T12:00:00.000Z'), 1, 'the forwarded one goes');
    assert.equal(store.pruneJoinRequests('2026-10-18T00:00:00.000Z'), 1, 'the expired one goes');
    assert.equal(store.joinRequests().length, 0);
  });
});

test('an invite secret is spent once, across a restart, and forgotten with its group', () => {
  const config = tempConfig();
  const first = new Db(config);
  try {
    const store = new CollabStore(first.connection);
    assert.equal(store.useInvite(groupId, 'h1', at), true);
    assert.equal(store.useInvite(groupId, 'h1', later), false);
    assert.equal(store.useInvite('b'.repeat(64), 'h1', at), true, 'the same hash in another group is another secret');
  } finally {
    first.close();
  }
  const second = new Db(config);
  try {
    const store = new CollabStore(second.connection);
    assert.equal(store.isInviteUsed(groupId, 'h1'), true);
    assert.equal(store.useInvite(groupId, 'h1', later), false);
    store.putJoinRequest({ groupId, fromEndpointId: owner, sealed: 's', relayedBy: null, expiresAt: null, receivedAt: at });
    store.dropGroup(groupId);
    assert.equal(store.isInviteUsed(groupId, 'h1'), false);
    assert.equal(store.joinRequests().length, 0);
    assert.equal(store.isInviteUsed('b'.repeat(64), 'h1'), true);
  } finally {
    second.close();
  }
});

test('cursors are kept per owner, share key and kind, with transcript offsets beside them', async () => {
  const groups = new GroupsStore(tempConfig());
  const other = 'f'.repeat(64);
  assert.deepEqual(groups.cursors(groupId, owner, share.shareKey), { kinds: {}, transcripts: {} });
  await groups.setKindCursor(groupId, owner, share.shareKey, 'chats', '2026-10-16T10:00:00.000Z|c1');
  await groups.setKindCursor(groupId, owner, share.shareKey, 'journal', '42');
  await groups.setKindCursor(groupId, owner, 'github.com/acme/api', 'chats', 'other-key');
  await groups.setKindCursor(groupId, other, share.shareKey, 'chats', 'other-owner');
  await groups.setKindCursor(groupId, owner, share.shareKey, 'chats', '2026-10-16T11:00:00.000Z|c7');
  await groups.setTranscriptOffset(groupId, owner, share.shareKey, 's1', 1024);

  const held = groups.cursors(groupId, owner, share.shareKey);
  assert.deepEqual(held.kinds, { chats: '2026-10-16T11:00:00.000Z|c7', journal: '42' });
  assert.equal(held.transcripts.s1, 1024);
  assert.equal(groups.cursors(groupId, owner, 'github.com/acme/api').kinds.chats, 'other-key');
  assert.equal(groups.cursors(groupId, other, share.shareKey).kinds.chats, 'other-owner');
  assert.throws(() => groups.setTranscriptOffset(groupId, owner, share.shareKey, 's1', -1), /offset/);

  await groups.dropCursors(groupId, owner, share.shareKey);
  assert.deepEqual(groups.cursors(groupId, owner, share.shareKey), { kinds: {}, transcripts: {} });
  assert.equal(groups.cursors(groupId, owner, 'github.com/acme/api').kinds.chats, 'other-key');
  await groups.dropCursors(groupId, owner);
  assert.equal(groups.cursors(groupId, owner, 'github.com/acme/api').kinds.chats, undefined);
  assert.equal(groups.cursors(groupId, other, share.shareKey).kinds.chats, 'other-owner');
});

test('a group document holds its chain and links, refuses an id that is not a hash, and goes on leave', async () => {
  const config = tempConfig();
  const groups = new GroupsStore(config);
  assert.deepEqual(groups.ids(), []);
  await groups.setChain(groupId, [version(1), version(2)]);
  await groups.setLink(groupId, share.shareKey, 'p1');
  await groups.setLink(groupId, '__proto__', 'p2');
  const doc = groups.read(groupId);
  assert.deepEqual(doc?.chain.map((v) => v.version), [1, 2]);
  assert.equal(doc?.links[share.shareKey], 'p1');
  assert.equal(Object.getOwnPropertyDescriptor(doc?.links, '__proto__')?.value, 'p2', 'a peer-made key stays a key');
  await groups.setLink(groupId, share.shareKey, null);
  assert.equal(groups.read(groupId)?.links[share.shareKey], undefined);
  assert.deepEqual(groups.ids(), [groupId]);
  assert.equal(groups.all().length, 1);

  assert.throws(() => groups.read('../settings'), /invalid group id/);
  assert.throws(() => groups.setChain('A'.repeat(64), []), /invalid group id/);

  await groups.delete(groupId);
  assert.equal(groups.read(groupId), null);
  assert.deepEqual(groups.ids(), []);
});

test('group documents are written atomically: concurrent changes all land, no temp file stays, a broken file is never written over', async () => {
  const config = tempConfig();
  const groups = new GroupsStore(config);
  await Promise.all([
    groups.setChain(groupId, [version(1)]),
    ...['chats', 'memory', 'journal', 'documents', 'artifacts', 'board'].map((kind, i) =>
      groups.setKindCursor(groupId, owner, share.shareKey, kind as 'chats', String(i)),
    ),
    groups.setLink(groupId, share.shareKey, 'p1'),
  ]);
  const doc = groups.read(groupId);
  assert.equal(doc?.chain.length, 1);
  assert.equal(Object.keys(groups.cursors(groupId, owner, share.shareKey).kinds).length, 6);
  assert.equal(doc?.links[share.shareKey], 'p1');
  assert.deepEqual(readdirSync(groups.dir), [`${groupId}.json`]);

  const file = join(groups.dir, `${groupId}.json`);
  writeFileSync(file, '{"chain": [');
  assert.equal(groups.read(groupId), null);
  await assert.rejects(() => groups.setLink(groupId, share.shareKey, 'p2'), /does not parse/);
  assert.equal(readFileSync(file, 'utf8'), '{"chain": [', 'the broken file is left for a person to recover');
});

test('the Collaborators settings default when absent, validate a change, and are written atomically', async () => {
  const config = tempConfig();
  const settings = new CollaboratorsSettingsStore(config);
  assert.deepEqual(settings.read(), DEFAULT_COLLABORATORS_SETTINGS);
  assert.equal(existsSync(settings.file), false, 'a read writes nothing');

  assert.deepEqual(parseCollaboratorsUpdate({ displayName: '  Ana  ', relayUrl: '', extra: 1 }), { displayName: 'Ana', relayUrl: null });
  assert.equal(parseCollaboratorsUpdate({ relayUrl: 'https://relay.acme.dev' }).relayUrl, 'https://relay.acme.dev/');
  assert.throws(() => parseCollaboratorsUpdate({ enabled: 'yes' }), /enabled/);
  assert.throws(() => parseCollaboratorsUpdate({ relayUrl: 'ftp://relay.acme.dev' }), /relayUrl/);
  assert.throws(() => parseCollaboratorsUpdate({ relayUrl: 'https://me:pw@relay.acme.dev' }), /credentials/);
  assert.throws(() => parseCollaboratorsUpdate({ displayName: 'x'.repeat(101) }), /displayName/);
  assert.throws(() => parseCollaboratorsUpdate([]), /object/);

  await Promise.all([settings.update({ enabled: true }), settings.update({ displayName: 'Ana' }), settings.update({ label: 'desktop' })]);
  assert.deepEqual(settings.read(), { enabled: true, displayName: 'Ana', label: 'desktop', relayUrl: null });
  assert.deepEqual(readdirSync(join(config.dataDir, 'collaborators')), ['settings.json']);

  // A hand edit with one bad field keeps the others
  writeFileSync(settings.file, JSON.stringify({ enabled: true, displayName: 'Ana', label: 7, relayUrl: 'nope' }));
  assert.deepEqual(settings.read(), { enabled: true, displayName: 'Ana', label: '', relayUrl: null });
  writeFileSync(settings.file, '{');
  assert.deepEqual(settings.read(), DEFAULT_COLLABORATORS_SETTINGS);
});
