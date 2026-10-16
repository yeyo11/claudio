import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import type { Attachment, ChatActivity, ClaudioEvent, JournalEntry, Milestone, ProjectSettings, ProjectSharingSettings, WorkItem, WorkItemDetail } from '@claudio/shared';
import type { ChatRecord } from '../src/chat-records.ts';
import type { ReaderSources } from '../src/collab/readers.ts';
import { decodeInvite, joinPayloadFor, sealJoin } from '../src/collab/invite.ts';
import { CollaboratorsService } from '../src/collab/service.ts';
import { CollabStore, Db } from '../src/db.ts';
import type { ClaudioEventInput } from '../src/events.ts';
import type { ProjectRecord } from '../src/projects.ts';
import { tempConfig } from './helpers.ts';

/*
 * Two, then three, installs syncing over real iroh endpoints on the minimal preset (loopback
 * tickets, no relay, no discovery, so no network), each a `CollaboratorsService` of its own in this
 * process with its own data directory and its own forked host. Ana shares a fixture project; Ben
 * joins directly and gets every kind of it, live; Cleo joins through Ben while Ana is offline;
 * ownership moves to Ben, who removes Cleo; then Ana stops sharing and Ben's copy goes.
 */

let irohError = '';
try {
  await import('@number0/iroh');
} catch (error) {
  irohError = error instanceof Error ? error.message : String(error);
}
const needsIroh = irohError ? { skip: `@number0/iroh does not load here: ${irohError}` } : {};

const root = mkdtempSync(join(tmpdir(), 'collab-sync-'));
const sha = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function until<T>(what: string, probe: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---------- Ana's fixture project ----------

const projectDir = join(root, 'api');
mkdirSync(join(projectDir, 'docs'), { recursive: true });
writeFileSync(join(projectDir, 'CLAUDE.md'), '# API\n');
writeFileSync(join(projectDir, 'docs', 'plan.md'), '# The plan\n');
const project: ProjectRecord = { id: randomUUID(), name: 'api', path: projectDir };

const chatId = randomUUID();
const chatRecord = {
  id: chatId,
  name: 'Fix the build',
  cwd: projectDir,
  workingDir: null,
  origin: 'claudio',
  prompt: 'Fix the build',
  model: 'claude-opus-5-5',
  createdAt: '2026-10-16T09:00:00.000Z',
  updatedAt: '2026-10-16T10:00:00.000Z',
} as unknown as ChatRecord;
const transcript = join(root, `${chatId}.jsonl`);
writeFileSync(transcript, '{"n":1}\n{"n":2}\n');
// A subagent the chat delegated to, whose transcript the CLI keeps beside the chat's
const subagentDir = join(root, chatId, 'subagents');
mkdirSync(subagentDir, { recursive: true });
const subagentTranscript = join(subagentDir, 'agent-a1.jsonl');
writeFileSync(subagentTranscript, '{"sub":1}\n');
writeFileSync(join(subagentDir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Find the bug' }));
const subagent = { agentId: 'a1', workflowRunId: null };

const uploadFile = join(root, 'notes.txt');
writeFileSync(uploadFile, 'an upload of the chat');
const upload: Attachment = { id: randomUUID(), name: 'notes.txt', mediaType: 'text/plain', kind: 'file', sizeBytes: 21, path: uploadFile, createdAt: '2026-10-16T09:10:00.000Z' };
// A later message attaches a second file: the copy gets it with the chat, not on an artifacts notice
const laterFile = join(root, 'later.txt');
writeFileSync(laterFile, 'attached later');
const laterUpload: Attachment = { id: randomUUID(), name: 'later.txt', mediaType: 'text/plain', kind: 'file', sizeBytes: 14, path: laterFile, createdAt: '2026-10-16T09:20:00.000Z' };
const chatUploads = [{ uploadId: upload.id, attachedAt: upload.createdAt }];

const journal: JournalEntry[] = [
  { id: 'j1', projectId: project.id, kind: 'note', text: 'Decided to use iroh', createdAt: '2026-10-16T08:00:00.000Z' } as unknown as JournalEntry,
];
const item = { id: 'w1', projectId: project.id, title: 'Build it', updatedAt: '2026-10-16T08:30:00.000Z' } as unknown as WorkItem;
const milestone = { id: 'm1', projectId: project.id, name: 'v1', updatedAt: '2026-10-16T08:40:00.000Z' } as unknown as Milestone;

const anaListeners = new Set<(event: ClaudioEvent) => void>();
const anaEvent = (type: string): void => {
  for (const l of anaListeners) l({ id: 1, at: new Date().toISOString(), title: type, type, projectId: project.id } as unknown as ClaudioEvent);
};

const anaSources: ReaderSources = {
  projects: () => [project],
  worktreeOf: () => null,
  chats: () => [chatRecord],
  // An agent works in the chat: its transcript is pulled as it grows
  liveChats: () => new Map<string, ChatActivity | null>([[chatId, null]]),
  transcriptFile: async (id) => (id === chatId ? transcript : null),
  memory: {
    list: async (projectId) =>
      projectId === project.id ? [{ projectId, name: 'MEMORY.md', path: '/m/MEMORY.md', isIndex: true, description: null, type: null, content: '- remember iroh', updatedAt: '2026-10-16T07:00:00.000Z' }] : [],
  },
  journal: { page: (projectId) => ({ entries: journal.filter((e) => e.projectId === projectId), total: journal.length, handed: { entries: 0, bytes: 0, lessons: 0, lessonBytes: 0 }, nextBefore: null }) },
  documents: { tree: async (projectId) => ({ projectId, root: 'docs', exists: true, tree: [{ name: 'plan.md', path: 'docs/plan.md', type: 'file', title: 'The plan', ties: [] }], fileCount: 1, tiedCount: 0 }) },
  workItems: {
    list: (filter) => (filter?.projectId === project.id ? [item] : []),
    get: (id) => ({ ...item, id }) as unknown as WorkItemDetail,
    milestones: (projectId) => (projectId === project.id ? [milestone] : []),
  },
  uploadsOfChat: async (id) => (id === chatId ? [...chatUploads] : []),
  uploads: {
    get: (id) => {
      const found = [upload, laterUpload].find((u) => u.id === id);
      if (!found) throw new Error('upload not found');
      return found;
    },
  },
  orchestrations: (projectId) => (projectId === project.id ? [{ id: 'o1', name: 'Build', finalResult: 'Done', updatedAt: '2026-10-16T09:50:00.000Z' }] : []),
  planDrafts: () => [],
  events: {
    subscribe: (listener) => {
      anaListeners.add(listener);
      return () => anaListeners.delete(listener);
    },
  },
};

const emptySources: ReaderSources = {
  ...anaSources,
  projects: () => [],
  chats: () => [],
  liveChats: () => new Map(),
  events: { subscribe: () => () => undefined },
};

// ---------- Installs ----------

interface Install {
  name: string;
  service: CollaboratorsService;
  store: CollabStore;
  events: ClaudioEventInput[];
  close(): Promise<void>;
}

const installs: Install[] = [];
after(async () => {
  for (const i of installs) await i.close();
  rmSync(root, { recursive: true, force: true });
});

function install(name: string, projects: ProjectRecord[], sources: ReaderSources, bindAddr = '127.0.0.1:0'): Install {
  const config = tempConfig();
  const db = new Db(config);
  const store = new CollabStore(db.connection);
  const vault = new Map<string, Record<string, string>>();
  const sharing = new Map<string, ProjectSharingSettings>();
  const events: ClaudioEventInput[] = [];
  const service = new CollaboratorsService({
    config,
    store,
    vault: { get: (tool) => ({ ...(vault.get(tool) ?? {}) }), set: async (tool, values) => void vault.set(tool, { ...(vault.get(tool) ?? {}), ...values }) },
    emit: (event) => void events.push(event),
    projects: () => projects,
    projectSettings: {
      stored: (id) => {
        const s = sharing.get(id);
        return (s ? { sharing: s } : {}) as ProjectSettings;
      },
      update: async (p, change) => {
        const before = (sharing.get(p.id) ? { sharing: sharing.get(p.id) } : {}) as ProjectSettings;
        const after = change(before);
        if (after.sharing) sharing.set(p.id, after.sharing);
        return { before, after };
      },
      shareKeyHolder: () => null,
    },
    sources,
    preset: 'minimal',
    bindAddr,
    reconcileMs: 60_000,
    retryMs: 150,
    debounceMs: 30,
    pendingMs: 150,
    idleMs: 3000,
    ...(process.env.COLLAB_SYNC_DEBUG ? { log: (message: string) => console.log(`[${name}] ${message}`) } : {}),
  });
  const entry: Install = {
    name,
    service,
    store,
    events,
    close: async () => {
      await service.dispose();
      db.close();
    },
  };
  installs.push(entry);
  return entry;
}

async function turnOn(i: Install): Promise<string> {
  await i.service.update({ enabled: true, displayName: i.name });
  await until(`${i.name} bound`, () => i.service.status().connection !== 'starting' && i.service.status().connection !== 'off');
  const id = i.service.endpointId();
  assert.ok(id);
  return id;
}

const SHARE_KEY = 'github.com/acme/api';

/**
 * A UDP port free now. Ana binds to it on every start, so the ticket her invites carry stays good
 * after she comes back: on the minimal preset there is no discovery to find her new one.
 */
async function freePort(): Promise<number> {
  const socket = createSocket('udp4');
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return port;
}

test('three installs: sync of every kind, live, a relayed join, a transfer, a removal and an unshare', needsIroh, async () => {
  const ana = install('Ana', [project], anaSources, `127.0.0.1:${String(await freePort())}`);
  const ben = install('Ben', [], emptySources);
  const cleo = install('Cleo', [], emptySources);
  const anaId = await turnOn(ana);
  const benId = await turnOn(ben);
  const cleoId = await turnOn(cleo);

  // ---- A group, and a direct join: Ana is online, so she signs Ben in at once
  const group = await ana.service.createGroup('Backend');
  assert.equal(group.isOwner, true);
  const invite = ana.service.createInvite(group.id);
  const joined = await ben.service.join(invite.text);
  assert.equal(joined.state, 'joined');
  assert.deepEqual(joined.state === 'joined' ? joined.group.members.map((m) => m.name) : [], ['Ana', 'Ben']);
  // The same secret a second time is refused: it is one-time
  await assert.rejects(cleo.service.join(invite.text), /refused/);

  // ---- Ana shares the project; Ben gets all of it
  const sharing = await ana.service.updateProjectSharing(project.id, { groups: [group.id], shareKey: SHARE_KEY });
  assert.deepEqual(sharing.groups, [group.id]);
  const shared = await until('Ben sees the share', async () => (await ben.service.shared()).find((p) => p.shareKey === SHARE_KEY && p.owner === anaId));
  assert.equal(shared.ownerName, 'Ana');
  assert.equal(shared.name, 'api');
  const shareId = shared.shareId;
  await until('Ben holds every kind', () => {
    const counts = ben.store.recordCounts({ ownerId: anaId, shareKey: SHARE_KEY });
    return counts.chats && counts.memory && counts.journal && counts.documents && counts.board && counts.artifacts;
  });
  assert.deepEqual(ben.service.sharedChats(anaId, shareId).map((c) => [c.id, c.live]), [[chatId, true]]);
  assert.deepEqual(ben.service.sharedMemory(anaId, shareId).map((m) => m.content), ['- remember iroh']);
  assert.deepEqual(ben.service.sharedJournal(anaId, shareId).map((e) => e.id), ['j1']);
  assert.deepEqual(ben.service.sharedDocuments(anaId, shareId).map((d) => d.path).sort(), ['CLAUDE.md', 'docs/plan.md']);
  const board = ben.service.sharedBoard(anaId, shareId);
  assert.deepEqual([board.items.map((i) => i.id), board.milestones.map((m) => m.id)], [['w1'], ['m1']]);
  assert.deepEqual(ben.service.sharedArtifacts(anaId, shareId).map((a) => `${a.kind}:${a.id}`).sort(), [`orchestration:o1`, `upload:${upload.id}`]);
  await until('the transcript', () => ben.service.sharedTranscript(anaId, shareId, chatId).total === 2);
  assert.deepEqual(ben.service.sharedTranscript(anaId, shareId, chatId).lines.map((l) => l.line), ['{"n":1}', '{"n":2}']);
  // The subagent's transcript comes with the chat's, held apart from it
  await until("the subagent's transcript", () => ben.service.sharedTranscript(anaId, shareId, chatId, { agent: subagent }).total === 1);
  assert.deepEqual(ben.service.sharedTranscript(anaId, shareId, chatId, { agent: subagent }).lines.map((l) => l.line), ['{"sub":1}']);
  assert.deepEqual(ben.service.sharedChats(anaId, shareId)[0]?.subagents?.map((a) => [a.agentId, a.description]), [['a1', 'Find the bug']]);
  assert.throws(() => ben.service.sharedTranscript(anaId, shareId, chatId, { agent: { agentId: 'nope', workflowRunId: null } }), /No such subagent/);

  // A blob on open: a document, by the hash its copied record names, and nothing else
  const docHash = sha('# The plan\n');
  const file = await ben.service.blob(anaId, shareId, docHash);
  assert.equal(readFileSync(file, 'utf8'), '# The plan\n');
  await assert.rejects(ben.service.blob(anaId, shareId, sha('not named')), /No such blob/);

  // ---- Live: what Ana's agent appends, and a new journal entry, reach Ben by the watch
  await until('the watch is open', async () => (await ben.service.shared()).find((p) => p.shareKey === SHARE_KEY)?.sync.state === 'live');
  appendFileSync(transcript, '{"n":3}\n');
  anaEvent('sessions.changed');
  await until('the appended line', () => ben.service.sharedTranscript(anaId, shareId, chatId).total === 3);
  appendFileSync(subagentTranscript, '{"sub":2}\n');
  anaEvent('sessions.changed');
  await until("the subagent's appended line", () => ben.service.sharedTranscript(anaId, shareId, chatId, { agent: subagent }).total === 2);
  assert.equal(ben.service.sharedTranscript(anaId, shareId, chatId).total, 3, "the chat's own transcript is not touched by its subagent's");
  chatUploads.push({ uploadId: laterUpload.id, attachedAt: new Date().toISOString() });
  appendFileSync(transcript, '{"n":4}\n');
  anaEvent('sessions.changed');
  await until('the upload the chat attached later', () => ben.service.sharedArtifacts(anaId, shareId).some((a) => a.kind === 'upload' && a.id === laterUpload.id));
  assert.equal(readFileSync(await ben.service.blob(anaId, shareId, sha('attached later')), 'utf8'), 'attached later');
  journal.push({ id: 'j2', projectId: project.id, kind: 'note', text: 'And a relay', createdAt: '2026-10-16T11:00:00.000Z' } as unknown as JournalEntry);
  anaEvent('journal.changed');
  await until('the new journal entry', () => ben.service.sharedJournal(anaId, shareId).some((e) => e.id === 'j2'));
  assert.ok(ben.events.some((e) => e.type === 'collaborators.synced'));

  // ---- A relayed join: Ana's invite names Ben, then Ana goes offline
  await until('Ana sees Ben online', () => ana.service.getGroup(group.id).members.find((m) => m.endpointId === benId)?.presence?.online);
  const relayedInvite = ana.service.createInvite(group.id);
  await ana.service.update({ enabled: false });
  const pending = await cleo.service.join(relayedInvite.text);
  assert.equal(pending.state, 'pending');
  assert.equal(pending.state === 'pending' ? pending.pending.relayedBy?.endpointId : null, benId);
  // Cleo holds no roster yet: the invite's relay names tell her who holds the request
  assert.equal(pending.state === 'pending' ? pending.pending.relayedBy?.name : null, 'Ben');
  assert.equal(cleo.service.groupList().pendingJoins[0]?.relayedBy?.name, 'Ben');
  assert.equal(cleo.service.groupList().pendingJoins.length, 1);
  // The relaying member carries an opaque request, never the secret
  const held = ben.store.joinRequest(group.id, cleoId);
  assert.ok(held && !held.sealed.includes(JSON.parse(Buffer.from(relayedInvite.text.slice('claudio-invite:'.length), 'base64url').toString()).secret));

  // Ana comes back: Ben hands her the request, she accepts it, and Cleo's chain arrives through Ben
  await turnOn(ana);
  const requests = await until('the relayed request reaches Ana', () => {
    const list = ana.service.joinRequests(group.id);
    return list.length ? list : null;
  });
  assert.deepEqual(requests.map((r) => [r.from, r.name, r.relayedBy?.endpointId, r.relayedBy?.name]), [[cleoId, 'Cleo', benId, 'Ben']]);
  // The event the owner's notification is made of names the group and who relayed the request
  const asked = ana.events.find((e) => e.type === 'collaborators.join-request');
  assert.ok(asked?.type === 'collaborators.join-request');
  assert.deepEqual([asked.groupName, asked.request.from, asked.request.relayedBy?.name], [group.name, cleoId, 'Ben']);
  await ana.service.acceptJoin(group.id, cleoId);
  assert.ok(ana.events.some((e) => e.type === 'collaborators.changed' && e.title === `Cleo joined ${group.name}`));
  // The answer clears the notification
  assert.deepEqual(
    ana.events.filter((e) => e.type === 'collaborators.join-answered').map((e) => (e.type === 'collaborators.join-answered' ? [e.groupId, e.from, e.answer] : null)),
    [[group.id, cleoId, 'accepted']],
  );
  // A request the owner denies is cleared too; one never held here has nothing to clear
  const dan = 'd'.repeat(64);
  const danInvite = decodeInvite(ana.service.createInvite(group.id).text);
  ana.store.putJoinRequest({ groupId: group.id, fromEndpointId: dan, sealed: sealJoin(anaId, joinPayloadFor(danInvite, { endpointId: dan, name: 'Dan' })), relayedBy: benId, expiresAt: null, receivedAt: new Date().toISOString() });
  ana.service.denyJoin(group.id, dan);
  const denied = ana.events.filter((e) => e.type === 'collaborators.join-answered').at(-1);
  assert.deepEqual(denied?.type === 'collaborators.join-answered' ? [denied.from, denied.answer, denied.title] : denied?.type, [dan, 'denied', 'The join of Dan was denied']);
  assert.throws(() => ana.service.denyJoin(group.id, dan), /No such join request/);
  await until('Cleo is in', () => cleo.service.groupList().groups.some((g) => g.id === group.id && g.members.some((m) => m.endpointId === cleoId)));
  assert.equal(cleo.service.groupList().pendingJoins.length, 0);
  await until('Cleo syncs Ana too', () => cleo.store.recordCounts({ ownerId: anaId, shareKey: SHARE_KEY }).journal);

  // ---- Transfer: Ben owns the group from now on, and signs the next version
  await ana.service.transferOwnership(group.id, benId);
  await until('Ben learns he owns it', () => ben.service.getGroup(group.id).isOwner);
  assert.equal(ana.service.getGroup(group.id).isOwner, false);
  assert.throws(() => ana.service.createInvite(group.id), /Only the group owner/);

  // ---- Removal by the new owner: Ana stops serving Cleo; Cleo keeps what she has
  await ben.service.removeMember(group.id, cleoId);
  await until('Ana learns of the removal', () => !ana.service.getGroup(group.id).members.some((m) => m.endpointId === cleoId));
  assert.equal(ana.service.getGroup(group.id).head.version, ben.service.getGroup(group.id).head.version);
  assert.ok(cleo.store.recordCounts({ ownerId: anaId, shareKey: SHARE_KEY }).journal, 'copies a removed member holds stay on their machine');

  // ---- Unshare: Ben's copy goes
  await ana.service.updateProjectSharing(project.id, { groups: [] });
  await until('Ben drops the copy', async () => !(await ben.service.shared()).some((p) => p.shareKey === SHARE_KEY));
  assert.deepEqual(ben.store.recordCounts({ ownerId: anaId, shareKey: SHARE_KEY }), {});
  assert.equal(ben.store.transcriptLineCount({ ownerId: anaId, shareKey: SHARE_KEY }, chatId), 0);
  assert.equal(ben.store.transcriptLineCount({ ownerId: anaId, shareKey: SHARE_KEY }, `${chatId}/agent-a1.jsonl`), 0);
});
