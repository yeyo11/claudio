import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import type { Attachment, ChatActivity, ClaudioEvent, CollaboratorsKind, DocumentNode, JournalEntry, Milestone, SharedChat, WorkItem, WorkItemDetail } from '@claudio/shared';
import type { ChatRecord } from '../src/chat-records.ts';
import { createReaders, liveChatsOf, type ReaderSources, type SharedPlace } from '../src/collab/readers.ts';
import { addMember, createGenesis, endpointIdFromSeed, headOf, type RosterVersion } from '../src/collab/roster.ts';
import { CollabServer, type HeldGroup, type JoinPort, type ReplySink } from '../src/collab/serve.ts';
import { parseRequest, rawLength, type WireReply } from '../src/collab/wire.ts';

const root = mkdtempSync(join(tmpdir(), 'collab-serve-'));
after(() => rmSync(root, { recursive: true, force: true }));

const ALL: CollaboratorsKind[] = ['chats', 'memory', 'journal', 'documents', 'artifacts', 'board'];
const sha = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function install(name: string) {
  const seed = randomBytes(32);
  return { seed, id: endpointIdFromSeed(seed), name };
}

const owner = install('Ana');
const member = install('Ben');
const otherMember = install('Cleo');
const stranger = install('Eve');

function group(name: string, ...members: Array<ReturnType<typeof install>>): HeldGroup {
  let chain: RosterVersion[] = [createGenesis({ seed: owner.seed, name, owner: { name: owner.name } })];
  for (const m of members) {
    const head = chain.at(-1);
    assert.ok(head);
    chain = [...chain, addMember(head, owner.seed, m.id, { name: m.name })];
  }
  const head = chain.at(-1);
  assert.ok(head);
  return { groupId: head.groupId, chain };
}

const team = group('Team', member);
const otherTeam = group('Other', otherMember);

// ---------- A fixture install: three projects, one shared with the team ----------

function project(name: string) {
  const path = join(root, name);
  mkdirSync(join(path, 'docs'), { recursive: true });
  writeFileSync(join(path, 'CLAUDE.md'), `# ${name}\n`);
  writeFileSync(join(path, 'docs', 'plan.md'), `# Plan of ${name}\n`);
  // On disk in the project, but in no shared record: its hash must never open it
  writeFileSync(join(path, 'secret.env'), `TOKEN=${name}-${randomUUID()}\n`);
  return { id: randomUUID(), name, path, repo: null };
}

const shared = project('shared');
const unshared = project('unshared');
const elsewhere = project('elsewhere');
const projects = [shared, unshared, elsewhere];

const place = (p: typeof shared, groups: string[], kinds: CollaboratorsKind[] = ALL): SharedPlace => ({
  projectId: p.id,
  name: p.name,
  path: p.path,
  shareKey: `github.com/acme/${p.name}`,
  groups,
  remote: 'origin',
  subpath: null,
  kinds,
  agentsMayRead: true,
});

let places: SharedPlace[] = [];
const resetPlaces = (): void => {
  places = [place(shared, [team.groupId]), place(unshared, []), place(elsewhere, [otherTeam.groupId])];
};
resetPlaces();

function chat(id: string, cwd: string, updatedAt: string, extra: Partial<ChatRecord> = {}): ChatRecord {
  return {
    id,
    name: `chat ${id.slice(0, 4)}`,
    cwd,
    workingDir: null,
    origin: 'claudio',
    orchestrationId: null,
    orchestrationTaskId: null,
    derivedFrom: null,
    prompt: 'Fix the build',
    lastText: null,
    model: 'claude-opus-5-5',
    permissionMode: 'default',
    permissionPrompts: 'none',
    createdAt: '2026-10-16T09:00:00.000Z',
    updatedAt,
    ...extra,
  } as ChatRecord;
}

const sharedChat = randomUUID();
const liveChat = randomUUID();
const otherChat = randomUUID();
const chats = [
  chat(sharedChat, shared.path, '2026-10-16T10:00:00.000Z'),
  chat(liveChat, join(shared.path, 'packages', 'api'), '2026-10-16T09:30:00.000Z'),
  chat(otherChat, unshared.path, '2026-10-16T10:05:00.000Z'),
];

const transcripts = join(root, 'transcripts');
mkdirSync(transcripts, { recursive: true });
for (const c of chats) writeFileSync(join(transcripts, `${c.id}.jsonl`), `{"n":1,"chat":"${c.id}"}\n{"n":2}\n`);
// The agents the CLI keeps beside a session's transcript: a subagent with its meta, a workflow
// agent, and a subagent of the chat of the unshared project
const agentsOf = (id: string) => join(transcripts, id, 'subagents');
mkdirSync(join(agentsOf(sharedChat), 'workflows', 'wf_run1'), { recursive: true });
writeFileSync(join(agentsOf(sharedChat), 'agent-a1.jsonl'), '{"sub":1}\n{"sub":2}\n');
writeFileSync(join(agentsOf(sharedChat), 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Find the bug', toolUseId: 'toolu_1' }));
writeFileSync(join(agentsOf(sharedChat), 'workflows', 'wf_run1', 'agent-w1.jsonl'), '{"wf":1}\n');
writeFileSync(join(agentsOf(sharedChat), 'notes.txt'), 'not an agent');
mkdirSync(agentsOf(otherChat), { recursive: true });
writeFileSync(join(agentsOf(otherChat), 'agent-x1.jsonl'), '{"other":1}\n');

const uploadsDir = join(root, 'uploads');
mkdirSync(uploadsDir, { recursive: true });
function upload(content: string): Attachment {
  const id = randomUUID();
  const path = join(uploadsDir, `${id}.txt`);
  writeFileSync(path, content);
  return { id, name: 'notes.txt', mediaType: 'text/plain', kind: 'file', sizeBytes: content.length, path, createdAt: '2026-10-16T09:10:00.000Z' };
}
const sharedUpload = upload('an upload of the shared chat');
const otherUpload = upload('an upload of a chat of another project');
const uploads = new Map([sharedUpload, otherUpload].map((u) => [u.id, u]));
const chatUploads = new Map<string, string[]>([
  [sharedChat, [sharedUpload.id]],
  [otherChat, [otherUpload.id]],
]);

const journal: JournalEntry[] = [
  { id: 'j1', projectId: shared.id, kind: 'note', text: 'Decided X', itemId: null, item: null, author: { kind: 'person' }, approvedBy: null, proposalId: null, documentPath: null, sources: [], createdAt: '2026-10-16T08:00:00.000Z' } as unknown as JournalEntry,
];

const item = { id: 'w1', projectId: shared.id, title: 'Build it', updatedAt: '2026-10-16T08:30:00.000Z' } as unknown as WorkItem;
const milestone = { id: 'm1', projectId: shared.id, name: 'v1', updatedAt: '2026-10-16T08:40:00.000Z' } as unknown as Milestone;

const listeners = new Set<(event: ClaudioEvent) => void>();
const emit = (event: Partial<ClaudioEvent> & { type: string }): void => {
  for (const l of listeners) l({ id: 1, at: new Date().toISOString(), ...event } as unknown as ClaudioEvent);
};

const docTree = (p: typeof shared): DocumentNode[] => [{ name: 'plan.md', path: 'docs/plan.md', type: 'file', title: `Plan of ${p.name}`, ties: [] }];
const byId = (id: string) => projects.find((p) => p.id === id) ?? shared;

const sources: ReaderSources = {
  projects: () => projects,
  place: () => ({ repo: null, exists: true, source: null }),
  chats: () => chats,
  liveChats: () => new Map<string, ChatActivity | null>([[liveChat, { kind: 'tool', tool: 'Edit', since: '2026-10-16T10:00:00.000Z' }]]),
  transcriptFile: async (id) => (chats.some((c) => c.id === id) ? join(transcripts, `${id}.jsonl`) : null),
  memory: {
    list: async (projectId) =>
      projectId === shared.id ? [{ projectId, name: 'MEMORY.md', path: '/x/MEMORY.md', isIndex: true, description: null, type: null, content: '- index', updatedAt: '2026-10-16T07:00:00.000Z' }] : [],
  },
  journal: {
    page: (projectId) => ({ entries: journal.filter((e) => e.projectId === projectId), total: 1, handed: { entries: 0, bytes: 0, lessons: 0, lessonBytes: 0 }, nextBefore: null }),
  },
  documents: { tree: async (projectId) => ({ projectId, root: 'docs', exists: true, tree: docTree(byId(projectId)), fileCount: 1, tiedCount: 0 }) },
  workItems: {
    list: (filter) => (filter?.projectId === shared.id ? [item] : []),
    get: (id) => ({ ...item, id, detail: true }) as unknown as WorkItemDetail,
    milestones: (projectId) => (projectId === shared.id ? [milestone] : []),
  },
  uploadsOfChat: async (id) => (chatUploads.get(id) ?? []).map((uploadId) => ({ uploadId, attachedAt: '2026-10-16T10:00:00.000Z' })),
  uploads: {
    get: (id) => {
      const found = uploads.get(id);
      if (!found) throw new Error('upload not found');
      return found;
    },
  },
  orchestrations: (projectId) => (projectId === shared.id ? [{ id: 'o1', name: 'Build', finalResult: 'Done', updatedAt: '2026-10-16T09:50:00.000Z' }] : []),
  planDrafts: () => [],
  events: {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  },
};

const joinCalls: string[] = [];
/** The tag of the invite the stranger was denied with */
const DENIED_TAG = 'd'.repeat(64);
const joins: JoinPort = {
  join: async (from, g) => {
    joinCalls.push(`join:${from}:${g.groupId}`);
    return { type: 'pending', groupId: g.groupId, owner: owner.id };
  },
  joinRelay: async (from, g) => {
    joinCalls.push(`joinRelay:${from}:${g.groupId}`);
    return { type: 'ack' };
  },
  leave: async (from, g) => {
    joinCalls.push(`leave:${from}:${g.groupId}`);
    return { type: 'ack' };
  },
  denied: (from, g, tag) => from === stranger.id && g.groupId === team.groupId && tag === DENIED_TAG,
  joinAnswers: async (from, g) => {
    joinCalls.push(`joinAnswers:${from}:${g.groupId}`);
    return { type: 'joinAnswers', groupId: g.groupId, denied: [] };
  },
};

const server = new CollabServer({ groups: () => [team, otherTeam], places: () => places, readers: createReaders(sources), joins, debounceMs: 10 });

interface Answer {
  frames: WireReply[];
  bytes: Uint8Array;
}

async function ask(from: string, frame: unknown, controller = new AbortController()): Promise<Answer> {
  const frames: WireReply[] = [];
  const parts: Uint8Array[] = [];
  const sink: ReplySink = {
    frame: async (reply) => {
      frames.push(JSON.parse(JSON.stringify(reply)) as WireReply);
    },
    bytes: async (data) => {
      parts.push(data);
    },
    signal: controller.signal,
  };
  await server.handle(from, frame, sink);
  return { frames, bytes: Buffer.concat(parts) };
}

const errorOf = (answer: Answer): string | null => {
  const first = answer.frames[0];
  return first?.type === 'error' ? first.code : null;
};

const key = (p: typeof shared) => `github.com/acme/${p.name}`;
const docHash = sha(`# Plan of shared\n`);

/** One of every frame, about the shared project */
const everyFrame = (): unknown[] => [
  { type: 'hello', heads: { [team.groupId]: headOf(team.chain) } },
  { type: 'roster', groupId: team.groupId, sinceVersion: 0 },
  // A tag nobody was denied with is answered as a roster ask is
  { type: 'roster', groupId: team.groupId, sinceVersion: 0, denial: 'e'.repeat(64) },
  { type: 'joinAnswers', groupId: team.groupId },
  { type: 'joinRelay', groupId: team.groupId, sealed: 'A'.repeat(80), from: stranger.id, receivedAt: '2026-10-16T10:00:00.000Z', expiresAt: null },
  { type: 'leave', groupId: team.groupId },
  { type: 'catalog', groupId: team.groupId },
  ...ALL.map((kind) => ({ type: 'pull', shareKey: key(shared), kind, since: null })),
  { type: 'transcript', shareKey: key(shared), session: sharedChat, agent: null, offset: 0 },
  { type: 'blob', shareKey: key(shared), sha256: docHash },
  { type: 'watch', shareKeys: [key(shared)] },
];

test('every frame is checked as a request before anything is read', () => {
  for (const frame of everyFrame()) assert.ok(parseRequest(frame), JSON.stringify(frame));
  assert.equal(parseRequest({ type: 'transcript', shareKey: key(shared), session: '../../etc/passwd', agent: null, offset: 0 }), null);
  assert.equal(parseRequest({ type: 'transcript', shareKey: key(shared), session: sharedChat, agent: '../../x.jsonl', offset: 0 }), null);
  assert.equal(parseRequest({ type: 'blob', shareKey: key(shared), sha256: 'abc' }), null);
  assert.equal(parseRequest({ type: 'run', prompt: 'rm -rf /' }), null);
  assert.equal(rawLength({ type: 'blob', bytes: 10 }), 10);
  assert.equal(rawLength({ type: 'records', bytes: 10 }), 0);
});

test('every frame but join is refused for a non-member, before anything is read', async () => {
  for (const frame of everyFrame()) {
    const answer = await ask(stranger.id, frame);
    assert.equal(errorOf(answer), 'forbidden', JSON.stringify(frame));
    assert.equal(answer.frames.length, 1);
    assert.equal(answer.bytes.length, 0);
  }
  // A member of another group is no member of this one
  assert.equal(errorOf(await ask(otherMember.id, { type: 'catalog', groupId: team.groupId })), 'forbidden');
  assert.equal(errorOf(await ask(otherMember.id, { type: 'leave', groupId: team.groupId })), 'forbidden');
  assert.deepEqual(joinCalls, []);
});

test('join is the one frame taken from a non-member, for a group this install holds', async () => {
  joinCalls.length = 0;
  const answer = await ask(stranger.id, { type: 'join', groupId: team.groupId, sealed: 'B'.repeat(120) });
  assert.deepEqual(answer.frames, [{ type: 'pending', groupId: team.groupId, owner: owner.id }]);
  assert.equal(errorOf(await ask(stranger.id, { type: 'join', groupId: 'f'.repeat(64), sealed: 'B'.repeat(120) })), 'not-found');
  // leave and joinRelay come from a member, for its own group
  assert.deepEqual((await ask(member.id, { type: 'leave', groupId: team.groupId })).frames, [{ type: 'ack' }]);
  assert.deepEqual((await ask(member.id, { type: 'joinRelay', groupId: team.groupId, sealed: 'C'.repeat(80), from: stranger.id, receivedAt: '2026-10-16T10:00:00.000Z', expiresAt: null })).frames, [{ type: 'ack' }]);
  assert.deepEqual(joinCalls, [`join:${stranger.id}:${team.groupId}`, `leave:${member.id}:${team.groupId}`, `joinRelay:${member.id}:${team.groupId}`]);
});

test('a joiner that names the invite it was denied with is told denied; another tag, group or asker is answered as before', async () => {
  joinCalls.length = 0;
  assert.deepEqual((await ask(stranger.id, { type: 'roster', groupId: team.groupId, sinceVersion: 0, denial: DENIED_TAG })).frames, [{ type: 'denied', groupId: team.groupId }]);
  assert.equal(errorOf(await ask(stranger.id, { type: 'roster', groupId: team.groupId, sinceVersion: 0 })), 'forbidden');
  assert.equal(errorOf(await ask(stranger.id, { type: 'roster', groupId: otherTeam.groupId, sinceVersion: 0, denial: DENIED_TAG })), 'forbidden');
  assert.equal(errorOf(await ask(otherMember.id, { type: 'roster', groupId: team.groupId, sinceVersion: 0, denial: DENIED_TAG })), 'forbidden');
  // A member gets its roster whatever it names
  assert.equal((await ask(member.id, { type: 'roster', groupId: team.groupId, sinceVersion: 0, denial: DENIED_TAG })).frames[0]?.type, 'roster');
  // A tag that is not one is no request at all
  assert.equal(errorOf(await ask(stranger.id, { type: 'roster', groupId: team.groupId, sinceVersion: 0, denial: 'nope' })), 'bad-request');
  // The owner hands its denials to a member of the group only
  assert.deepEqual((await ask(member.id, { type: 'joinAnswers', groupId: team.groupId })).frames, [{ type: 'joinAnswers', groupId: team.groupId, denied: [] }]);
  assert.deepEqual(joinCalls, [`joinAnswers:${member.id}:${team.groupId}`]);
});

test('every frame about a project is refused for an unshared project, and for one shared with another group', async () => {
  for (const target of [unshared, elsewhere]) {
    const frames = [
      ...ALL.map((kind) => ({ type: 'pull', shareKey: key(target), kind, since: null })),
      { type: 'transcript', shareKey: key(target), session: otherChat, agent: null, offset: 0 },
      { type: 'blob', shareKey: key(target), sha256: sha(`# Plan of ${target.name}\n`) },
      { type: 'watch', shareKeys: [key(target)] },
      { type: 'watch', shareKeys: [key(shared), key(target)] },
    ];
    for (const frame of frames) {
      const answer = await ask(member.id, frame);
      assert.equal(errorOf(answer), 'not-found', JSON.stringify(frame));
      assert.equal(answer.bytes.length, 0);
    }
  }
  const catalog = (await ask(member.id, { type: 'catalog', groupId: team.groupId })).frames[0];
  assert.equal(catalog?.type, 'catalog');
  if (catalog?.type === 'catalog') assert.deepEqual(catalog.projects.map((p) => p.shareKey), [key(shared)]);
});

test('unsharing a project refuses its frames from then on', async () => {
  assert.equal(errorOf(await ask(member.id, { type: 'pull', shareKey: key(shared), kind: 'chats', since: null })), null);
  places = places.map((p) => (p.projectId === shared.id ? { ...p, groups: [] } : p));
  try {
    assert.equal(errorOf(await ask(member.id, { type: 'pull', shareKey: key(shared), kind: 'chats', since: null })), 'not-found');
    assert.equal(errorOf(await ask(member.id, { type: 'blob', shareKey: key(shared), sha256: docHash })), 'not-found');
  } finally {
    resetPlaces();
  }
});

test("the catalog carries the sharer's flag on agent reads, so the reading install can honour it", async () => {
  const flagOf = async (): Promise<boolean | undefined> => {
    const catalog = (await ask(member.id, { type: 'catalog', groupId: team.groupId })).frames[0];
    return catalog?.type === 'catalog' ? catalog.projects.find((p) => p.shareKey === key(shared))?.agentsMayRead : undefined;
  };
  assert.equal(await flagOf(), true);
  places = places.map((p) => (p.projectId === shared.id ? { ...p, agentsMayRead: false } : p));
  try {
    assert.equal(await flagOf(), false);
    // The person still reads it: the flag is about agents only
    assert.equal(errorOf(await ask(member.id, { type: 'pull', shareKey: key(shared), kind: 'chats', since: null })), null);
  } finally {
    resetPlaces();
  }
});

test('a kind the project does not share is refused', async () => {
  places = places.map((p) => (p.projectId === shared.id ? { ...p, kinds: ['chats'] } : p));
  try {
    assert.equal(errorOf(await ask(member.id, { type: 'pull', shareKey: key(shared), kind: 'journal', since: null })), 'not-found');
    assert.equal(errorOf(await ask(member.id, { type: 'blob', shareKey: key(shared), sha256: docHash })), 'not-found');
    assert.equal(errorOf(await ask(member.id, { type: 'pull', shareKey: key(shared), kind: 'chats', since: null })), null);
  } finally {
    resetPlaces();
  }
});

test('a blob is never served by its hash alone', async () => {
  const unknown = await ask(member.id, { type: 'blob', shareKey: key(shared), sha256: sha('nothing has this') });
  // A file in the shared project's directory that no shared record names
  const unreferenced = await ask(member.id, { type: 'blob', shareKey: key(shared), sha256: sha(`TOKEN=x\n`) });
  // A document and an upload that exist, but of a project not shared with this member
  const otherDoc = await ask(member.id, { type: 'blob', shareKey: key(shared), sha256: sha(`# Plan of unshared\n`) });
  const otherUploadBlob = await ask(member.id, { type: 'blob', shareKey: key(shared), sha256: sha('an upload of a chat of another project') });
  for (const answer of [unknown, unreferenced, otherDoc, otherUploadBlob]) {
    // The same answer whether the hash exists or not
    assert.deepEqual(answer.frames, [{ type: 'error', code: 'not-found' }]);
    assert.equal(answer.bytes.length, 0);
  }

  const doc = await ask(member.id, { type: 'blob', shareKey: key(shared), sha256: docHash });
  assert.deepEqual(doc.frames, [{ type: 'blob', sha256: docHash, bytes: Buffer.byteLength('# Plan of shared\n') }]);
  assert.equal(Buffer.from(doc.bytes).toString(), '# Plan of shared\n');

  const up = await ask(member.id, { type: 'blob', shareKey: key(shared), sha256: sha('an upload of the shared chat') });
  assert.equal(Buffer.from(up.bytes).toString(), 'an upload of the shared chat');
});

test('pull sends each kind in batches that end with the cursor, and only what changed after it', async () => {
  const first = await ask(member.id, { type: 'pull', shareKey: key(shared), kind: 'chats', since: null });
  const records = first.frames.flatMap((f) => (f.type === 'records' ? f.records : []));
  assert.deepEqual(records.map((r) => r.id).sort(), [liveChat, sharedChat].sort());
  const last = first.frames.at(-1);
  assert.equal(last?.type, 'cursor');
  const cursor = last?.type === 'cursor' ? last.cursor : null;
  assert.equal(cursor, `2026-10-16T10:00:00.000Z|${sharedChat}`);
  const live = records.find((r) => r.id === liveChat)?.data as { live: boolean; activity: unknown };
  assert.equal(live.live, true);

  // Nothing changed since: only the chat an agent is working in comes again
  const again = await ask(member.id, { type: 'pull', shareKey: key(shared), kind: 'chats', since: cursor });
  assert.deepEqual(again.frames.flatMap((f) => (f.type === 'records' ? f.records.map((r) => r.id) : [])), [liveChat]);

  for (const [kind, ids] of [
    ['memory', ['file:MEMORY.md']],
    ['journal', ['j1']],
    ['documents', ['file:CLAUDE.md', 'file:docs/plan.md']],
    ['board', ['item:w1', 'milestone:m1']],
    ['artifacts', ['orchestration:o1', `upload:${sharedUpload.id}`]],
  ] as const) {
    const answer = await ask(member.id, { type: 'pull', shareKey: key(shared), kind, since: null });
    assert.deepEqual(answer.frames.flatMap((f) => (f.type === 'records' ? f.records.map((r) => r.id) : [])).sort(), [...ids].sort(), kind);
  }
});

test('a transcript is served only for a chat the project shares', async () => {
  const answer = await ask(member.id, { type: 'transcript', shareKey: key(shared), session: sharedChat, agent: null, offset: 0 });
  const head = answer.frames[0];
  assert.equal(head?.type, 'transcript');
  if (head?.type === 'transcript') assert.equal(head.bytes, answer.bytes.length);
  assert.ok(Buffer.from(answer.bytes).toString().startsWith(`{"n":1,"chat":"${sharedChat}"}`));
  const tail = await ask(member.id, { type: 'transcript', shareKey: key(shared), session: sharedChat, agent: null, offset: answer.bytes.length });
  assert.equal(tail.bytes.length, 0);

  // A session of another project, named under the shared project's key
  assert.equal(errorOf(await ask(member.id, { type: 'transcript', shareKey: key(shared), session: otherChat, agent: null, offset: 0 })), 'not-found');
  assert.equal(errorOf(await ask(member.id, { type: 'transcript', shareKey: key(shared), session: randomUUID(), agent: null, offset: 0 })), 'not-found');
});

test("a chat's agents are listed with it, and their transcripts are served only through a shared chat", async () => {
  const pulled = await ask(member.id, { type: 'pull', shareKey: key(shared), kind: 'chats', since: null });
  const records = pulled.frames.flatMap((f) => (f.type === 'records' ? f.records : []));
  const agents = (records.find((r) => r.id === sharedChat)?.data as SharedChat).subagents ?? [];
  assert.deepEqual(
    agents.map(({ agentId, workflowRunId, subagentType, description, size }) => ({ agentId, workflowRunId, subagentType, description, size })).sort((a, b) => a.agentId.localeCompare(b.agentId)),
    [
      { agentId: 'a1', workflowRunId: null, subagentType: 'Explore', description: 'Find the bug', size: 20 },
      { agentId: 'w1', workflowRunId: 'wf_run1', subagentType: null, description: null, size: 9 },
    ],
  );
  // Nothing of the owner's paths goes with them
  assert.ok(!JSON.stringify(agents).includes(transcripts));
  assert.deepEqual((records.find((r) => r.id === liveChat)?.data as SharedChat).subagents, []);

  const sub = await ask(member.id, { type: 'transcript', shareKey: key(shared), session: sharedChat, agent: 'agent-a1.jsonl', offset: 0 });
  assert.equal(sub.frames[0]?.type, 'transcript');
  assert.equal(Buffer.from(sub.bytes).toString(), '{"sub":1}\n{"sub":2}\n');
  const wf = await ask(member.id, { type: 'transcript', shareKey: key(shared), session: sharedChat, agent: 'workflows/wf_run1/agent-w1.jsonl', offset: 0 });
  assert.equal(Buffer.from(wf.bytes).toString(), '{"wf":1}\n');

  // An agent of a chat the project does not share, one that is not there, and a path that walks out
  assert.equal(errorOf(await ask(member.id, { type: 'transcript', shareKey: key(shared), session: otherChat, agent: 'agent-x1.jsonl', offset: 0 })), 'not-found');
  assert.equal(errorOf(await ask(member.id, { type: 'transcript', shareKey: key(shared), session: sharedChat, agent: 'agent-nope.jsonl', offset: 0 })), 'not-found');
  assert.equal(errorOf(await ask(member.id, { type: 'transcript', shareKey: key(shared), session: sharedChat, agent: '../agent-a1.jsonl', offset: 0 })), 'bad-request');
});

test('watch sends changed notices for the watched project only, and ends with its stream', async () => {
  const controller = new AbortController();
  const frames: WireReply[] = [];
  const sink: ReplySink = { frame: async (r) => void frames.push(r), bytes: async () => undefined, signal: controller.signal };
  const watching = server.handle(member.id, { type: 'watch', shareKeys: [key(shared)] }, sink);
  // The checks are done before the watch subscribes
  while (listeners.size === 0) await new Promise((r) => setImmediate(r));
  emit({ type: 'journal.changed', projectId: unshared.id });
  emit({ type: 'journal.changed', projectId: shared.id });
  emit({ type: 'workitem.updated', projectId: shared.id });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(
    frames.map((f) => (f.type === 'changed' ? f.kind : f.type)).sort(),
    ['board', 'journal'],
  );
  controller.abort();
  await watching;
  assert.equal(listeners.size, 0);
});

test('a malformed frame is a bad request', async () => {
  assert.equal(errorOf(await ask(member.id, { type: 'pull', shareKey: key(shared), kind: 'terminals', since: null })), 'bad-request');
  assert.equal(errorOf(await ask(member.id, 'hello')), 'bad-request');
});

test('a chat idle between turns, its process kept, is not live in a copy; a working or waiting one is', () => {
  const editing: ChatActivity = { kind: 'tool', tool: 'Edit', since: '2026-10-16T10:00:00.000Z' };
  const live = liveChatsOf([
    { id: 'working', pid: 10, status: 'busy', pendingPrompts: 0, activity: editing },
    { id: 'asking', pid: 11, status: 'busy', pendingPrompts: 1, activity: null },
    { id: 'between-turns', pid: 12, status: 'idle', pendingPrompts: 0, activity: null },
    { id: 'ended', pid: null, status: 'completed', pendingPrompts: 0, activity: null },
  ]);
  assert.deepEqual([...live.keys()].sort(), ['asking', 'working']);
  assert.deepEqual(live.get('working'), editing);
});
