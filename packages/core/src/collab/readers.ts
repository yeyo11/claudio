import { createHash } from 'node:crypto';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type {
  Attachment,
  ChatActivity,
  ClaudioEvent,
  CollaboratorsKind,
  DocumentNode,
  JournalEntry,
  JournalPage,
  MemoryFile,
  Milestone,
  PlanDraftSummary,
  ProjectDocuments,
  SharedArtifact,
  SharedChat,
  SharedDocument,
  SharedMemoryFile,
  SharedSubagent,
  WorkItem,
  WorkItemDetail,
  WorkItemFilter,
} from '@claudio/shared';
import type { ChatRecord } from '../chat-records.ts';
import type { WorktreeFacts } from '../locations.ts';
import { attachProject, type ProjectRecord } from '../projects.ts';

/*
 * The serving side's only view of this install (docs/plans/collaborators.md §3.5): seven read-only
 * ports over services that already exist. A port has `list`, `get`, `read` and `watch` and nothing
 * else, so what `serve.ts` is handed cannot write, start or stop anything. Their sources are narrow
 * functions the wiring fills from the real stores; none of them is a run, chat, flow or orchestration
 * service.
 */

/** A local project as it is shared: where it is, and under which key and groups. */
export interface SharedPlace {
  projectId: string;
  name: string;
  /** The project's directory */
  path: string;
  shareKey: string;
  groups: readonly string[];
  remote: string | null;
  subpath: string | null;
  kinds: readonly CollaboratorsKind[];
}

/**
 * One record as a port lists it. `version` changes whenever the record does; `cursor` orders a
 * kind's records by change (§4.1), so a pull sends those past the receiver's cursor; `always` is a
 * record sent on every pull whatever the cursor (a chat an agent is working in now). `load` reads the
 * record itself, only for what is sent.
 */
export interface ReadEntry<T> {
  id: string;
  version: string;
  cursor: string;
  always?: boolean;
  load: () => T | Promise<T>;
}

/** Called with the project something changed in; null when the source cannot tell which */
export type ChangeListener = (projectId: string | null) => void;

export interface ChatReader {
  list(place: SharedPlace): Promise<ReadEntry<SharedChat>[]>;
  get(place: SharedPlace, chatId: string): Promise<ReadEntry<SharedChat> | null>;
  watch(listener: ChangeListener): () => void;
}

export interface TranscriptSlice {
  bytes: Uint8Array;
  offset: number;
  next: number;
  size: number;
}

export interface TranscriptReader {
  /** From `offset`, at most `max` bytes cut after the last whole line when there is one; null when there is no such file */
  read(chatId: string, agent: string | null, offset: number, max: number): Promise<TranscriptSlice | null>;
  watch(listener: ChangeListener): () => void;
}

export interface MemoryReader {
  list(place: SharedPlace): Promise<ReadEntry<SharedMemoryFile>[]>;
  watch(listener: ChangeListener): () => void;
}

export interface JournalReader {
  list(place: SharedPlace): Promise<ReadEntry<JournalEntry>[]>;
  watch(listener: ChangeListener): () => void;
}

export interface DocumentReader {
  list(place: SharedPlace): Promise<ReadEntry<SharedDocument>[]>;
  /** A listed document's bytes, by its hash; null for a hash no listed document has */
  read(place: SharedPlace, sha256: string): Promise<Uint8Array | null>;
  watch(listener: ChangeListener): () => void;
}

/** The board: work items (`item:<id>`) and milestones (`milestone:<id>`) */
export interface WorkItemReader {
  list(place: SharedPlace): Promise<ReadEntry<WorkItemDetail | Milestone>[]>;
  watch(listener: ChangeListener): () => void;
}

/**
 * The artifacts kind: uploads of the shared chats (`upload:<id>`), orchestration results
 * (`orchestration:<id>`) and plan drafts (`plan:<id>`). Only an upload has bytes.
 */
export interface UploadReader {
  list(place: SharedPlace, chatIds: readonly string[]): Promise<ReadEntry<SharedArtifact>[]>;
  /** The bytes of an upload of one of `chatIds`, by its hash; null for any other hash */
  read(place: SharedPlace, chatIds: readonly string[], sha256: string): Promise<Uint8Array | null>;
  watch(listener: ChangeListener): () => void;
}

export interface Readers {
  chats: ChatReader;
  transcripts: TranscriptReader;
  memory: MemoryReader;
  journal: JournalReader;
  documents: DocumentReader;
  workItems: WorkItemReader;
  uploads: UploadReader;
}

/** An orchestration of a project with a result to show */
export interface OrchestrationResult {
  id: string;
  name: string;
  finalResult: string;
  updatedAt: string;
}

/** What the readers read from. Each member is a read of an existing store; nothing here writes. */
export interface ReaderSources {
  projects(): readonly ProjectRecord[];
  worktreeOf(dir: string): WorktreeFacts | null;
  /** Every chat record (`chats` rows) */
  chats(): readonly ChatRecord[];
  /** Chats an agent is working in now, with what it is doing */
  liveChats(): ReadonlyMap<string, ChatActivity | null>;
  /** How many messages a chat's transcript holds, when known */
  messageCount?(chatId: string): number | null;
  /** The CLI's JSONL of a session (`<configDir>/projects/<slug>/<session>.jsonl`); null when there is none */
  transcriptFile(sessionId: string): Promise<string | null>;
  memory: { list(projectId: string): Promise<MemoryFile[]> };
  journal: { page(projectId: string, query?: { limit?: unknown; before?: unknown }): JournalPage };
  documents: { tree(projectId: string): Promise<ProjectDocuments> };
  workItems: { list(filter?: WorkItemFilter): WorkItem[]; get(itemId: string): WorkItemDetail; milestones(projectId: string): Milestone[] };
  /** The uploads a chat's messages attached, and when each was first attached (`chat-uploads.ts`) */
  uploadsOfChat(chatId: string): Promise<ReadonlyArray<{ uploadId: string; attachedAt: string }>>;
  uploads: { get(id: string): Attachment };
  orchestrations(projectId: string): readonly OrchestrationResult[];
  planDrafts(projectId: string): readonly PlanDraftSummary[];
  events: { subscribe(listener: (event: ClaudioEvent) => void): () => void };
}

const JOURNAL_PAGE = 200;
/** The documents folder is Markdown the person keeps; a file past this is not one of those */
const DOCUMENT_MAX_BYTES = 8 * 1024 * 1024;

const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const versionOf = (value: unknown): string => sha256(JSON.stringify(value)).slice(0, 32);

/** The project an event names, when it names one */
function eventProject(event: ClaudioEvent): string | null {
  const projectId = (event as { projectId?: unknown }).projectId;
  return typeof projectId === 'string' ? projectId : null;
}

function watchEvents(sources: ReaderSources, matches: (event: ClaudioEvent) => boolean, listener: ChangeListener): () => void {
  return sources.events.subscribe((event) => {
    if (matches(event)) listener(eventProject(event));
  });
}

const startsWith = (event: ClaudioEvent, ...prefixes: string[]): boolean => prefixes.some((p) => event.type.startsWith(p));

/** Caches a file's hash by its size and mtime, so a listing does not reread unchanged files */
class HashCache {
  private readonly known = new Map<string, { size: number; mtimeMs: number; sha256: string }>();

  async of(file: string, max: number): Promise<{ sha256: string; size: number; mtime: Date } | null> {
    let facts;
    try {
      facts = await stat(file);
    } catch {
      return null;
    }
    if (!facts.isFile() || facts.size > max) return null;
    const cached = this.known.get(file);
    if (cached && cached.size === facts.size && cached.mtimeMs === facts.mtimeMs) return { sha256: cached.sha256, size: facts.size, mtime: facts.mtime };
    let bytes;
    try {
      bytes = await readFile(file);
    } catch {
      return null;
    }
    const hash = sha256(bytes);
    this.known.set(file, { size: facts.size, mtimeMs: facts.mtimeMs, sha256: hash });
    return { sha256: hash, size: bytes.length, mtime: facts.mtime };
  }
}

function chatsOf(sources: ReaderSources, place: SharedPlace): Array<{ record: ChatRecord; branch: string | null }> {
  const projects = sources.projects();
  const out: Array<{ record: ChatRecord; branch: string | null }> = [];
  for (const record of sources.chats()) {
    // Claudio's own internal chats (the assistant, judges) are not the project's work
    if (record.origin === 'internal' || record.claudioAssistant) continue;
    const attached = attachProject(projects, record.workingDir ?? record.cwd, sources.worktreeOf) ?? attachProject(projects, record.cwd, sources.worktreeOf);
    if (attached?.project.id !== place.projectId) continue;
    out.push({ record, branch: attached.worktree?.branch ?? null });
  }
  return out;
}

/** Agent files are named as the wire accepts them (`wire.ts`), so a listed one can always be asked for */
const AGENT_FILE_NAME = /^agent-([A-Za-z0-9_-]{1,64})\.jsonl$/;
const RUN_DIR = /^[A-Za-z0-9_-]{1,64}$/;
/** More than any chat delegates; a listing past it keeps the most recent */
const MAX_SUBAGENTS = 500;
const MAX_META_TEXT = 500;

const metaText = (value: unknown): string | null => (typeof value === 'string' && value ? value.slice(0, MAX_META_TEXT) : null);

/**
 * The agents of a chat, from the files the CLI keeps beside its transcript (`sessions.ts`):
 * `subagents/agent-<id>.jsonl` and `subagents/workflows/<runId>/agent-<id>.jsonl`, each with its
 * `.meta.json`. Only what names and sizes a transcript; nothing of the owner's paths.
 */
async function subagentsOf(sources: ReaderSources, chatId: string): Promise<SharedSubagent[]> {
  const main = await sources.transcriptFile(chatId);
  if (!main) return [];
  const base = join(main.slice(0, -'.jsonl'.length), 'subagents');
  const out: SharedSubagent[] = [];
  const scan = async (dir: string, runId: string | null): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const agentId = AGENT_FILE_NAME.exec(name)?.[1];
      if (!agentId) continue;
      const info = await stat(join(dir, name)).catch(() => null);
      if (!info?.isFile()) continue;
      let meta: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(await readFile(join(dir, `agent-${agentId}.meta.json`), 'utf8')) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
      } catch {
        // An agent whose meta is not there yet is listed by its id
      }
      out.push({
        agentId,
        workflowRunId: runId,
        subagentType: metaText(meta.agentType),
        description: metaText(meta.description),
        workflowPhase: metaText(meta.workflowPhase),
        size: info.size,
        updatedAt: info.mtime.toISOString(),
      });
    }
  };
  await scan(base, null);
  const runs = await readdir(join(base, 'workflows')).catch(() => [] as string[]);
  for (const run of runs) if (RUN_DIR.test(run)) await scan(join(base, 'workflows', run), run);
  out.sort((a, b) => (a.updatedAt ?? '').localeCompare(b.updatedAt ?? ''));
  return out.slice(-MAX_SUBAGENTS);
}

function chatEntry(sources: ReaderSources, record: ChatRecord, branch: string | null): ReadEntry<SharedChat> {
  const live = sources.liveChats();
  const isLive = live.has(record.id);
  return {
    id: record.id,
    version: `${record.updatedAt}${isLive ? '+live' : ''}`,
    cursor: `${record.updatedAt}|${record.id}`,
    ...(isLive ? { always: true } : {}),
    load: async () => ({
      id: record.id,
      title: record.name || record.prompt.slice(0, 120),
      firstPrompt: record.prompt || null,
      messageCount: sources.messageCount?.(record.id) ?? 0,
      startedAt: record.createdAt,
      updatedAt: record.updatedAt,
      model: record.model,
      origin: record.origin,
      branch,
      live: isLive,
      activity: live.get(record.id) ?? null,
      subagents: await subagentsOf(sources, record.id),
    }),
  };
}

function chatReader(sources: ReaderSources): ChatReader {
  return {
    list: async (place) => chatsOf(sources, place).map(({ record, branch }) => chatEntry(sources, record, branch)),
    get: async (place, chatId) => {
      const found = chatsOf(sources, place).find(({ record }) => record.id === chatId);
      return found ? chatEntry(sources, found.record, found.branch) : null;
    },
    watch: (listener) => watchEvents(sources, (e) => e.type === 'sessions.changed' || startsWith(e, 'run.'), listener),
  };
}

function transcriptReader(sources: ReaderSources): TranscriptReader {
  return {
    read: async (chatId, agent, offset, max) => {
      const main = await sources.transcriptFile(chatId);
      if (!main) return null;
      let file = main;
      if (agent) {
        const base = join(main.slice(0, -'.jsonl'.length), 'subagents');
        file = join(base, ...agent.split('/'));
        // `agent` is checked on the wire; this keeps the file under the session's own folder whatever reached here
        const rel = relative(base, file);
        if (rel.startsWith('..') || rel.includes(`..${sep}`)) return null;
      }
      let handle;
      try {
        handle = await open(file, 'r');
      } catch {
        return null;
      }
      try {
        const size = (await handle.stat()).size;
        const from = Math.min(offset, size);
        const want = Math.max(0, Math.min(max, size - from));
        const buffer = Buffer.alloc(want);
        const { bytesRead } = want > 0 ? await handle.read(buffer, 0, want, from) : { bytesRead: 0 };
        let bytes = buffer.subarray(0, bytesRead);
        // Whole lines only, so the receiver stores lines; a line longer than `max` goes as it is
        const last = bytes.lastIndexOf(0x0a);
        if (last >= 0 && last < bytes.length - 1) bytes = bytes.subarray(0, last + 1);
        return { bytes, offset: from, next: from + bytes.length, size };
      } finally {
        await handle.close();
      }
    },
    watch: (listener) => watchEvents(sources, (e) => e.type === 'sessions.changed' || startsWith(e, 'run.'), listener),
  };
}

function memoryReader(sources: ReaderSources): MemoryReader {
  return {
    list: async (place) => {
      const files = await sources.memory.list(place.projectId);
      return files.map((file) => {
        const data: SharedMemoryFile = { name: file.name, isIndex: file.isIndex, description: file.description, type: file.type, content: file.content, updatedAt: file.updatedAt };
        return { id: `file:${file.name}`, version: sha256(file.content).slice(0, 32), cursor: `${file.updatedAt ?? ''}|${file.name}`, load: () => data };
      });
    },
    // The memory files live under the CLI's projects folder, which the sessions watcher covers (§4.2)
    watch: (listener) => watchEvents(sources, (e) => e.type === 'sessions.changed' || e.type.startsWith('memory.'), listener),
  };
}

function journalReader(sources: ReaderSources): JournalReader {
  return {
    list: async (place) => {
      const entries: JournalEntry[] = [];
      let before: string | null = null;
      for (;;) {
        const page = sources.journal.page(place.projectId, { limit: JOURNAL_PAGE, ...(before ? { before } : {}) });
        entries.push(...page.entries);
        if (!page.nextBefore || page.entries.length === 0) break;
        before = page.nextBefore;
      }
      return entries.map((entry) => ({ id: entry.id, version: versionOf(entry), cursor: `${entry.createdAt}|${entry.id}`, load: () => entry }));
    },
    watch: (listener) => watchEvents(sources, (e) => e.type.startsWith('journal.'), listener),
  };
}

function* files(nodes: readonly DocumentNode[]): Generator<DocumentNode> {
  for (const node of nodes) {
    if (node.type === 'file') yield node;
    else if (node.children) yield* files(node.children);
  }
}

function documentReader(sources: ReaderSources): DocumentReader {
  const hashes = new HashCache();
  const list = async (place: SharedPlace): Promise<Array<ReadEntry<SharedDocument> & { file: string; sha256: string }>> => {
    const wanted: Array<{ path: string; title: string | null }> = [{ path: 'CLAUDE.md', title: null }];
    try {
      const tree = await sources.documents.tree(place.projectId);
      if (tree.exists) for (const node of files(tree.tree)) if (node.path !== 'CLAUDE.md') wanted.push({ path: node.path, title: node.title ?? null });
    } catch {
      // A project whose documents folder cannot be read still shares its CLAUDE.md
    }
    const out: Array<ReadEntry<SharedDocument> & { file: string; sha256: string }> = [];
    for (const doc of wanted) {
      const file = join(place.path, ...doc.path.split('/'));
      if (relative(place.path, file).startsWith('..')) continue;
      const facts = await hashes.of(file, DOCUMENT_MAX_BYTES);
      if (!facts) continue;
      const updatedAt = facts.mtime.toISOString();
      const data: SharedDocument = { path: doc.path, title: doc.title, size: facts.size, updatedAt, sha256: facts.sha256 };
      out.push({ id: `file:${doc.path}`, version: facts.sha256.slice(0, 32), cursor: `${updatedAt}|${doc.path}`, load: () => data, file, sha256: facts.sha256 });
    }
    return out;
  };
  return {
    list,
    read: async (place, hash) => {
      const found = (await list(place)).find((entry) => entry.sha256 === hash);
      if (!found) return null;
      try {
        const bytes = await readFile(found.file);
        // The file changed since it was listed: what the hash names is gone
        return sha256(bytes) === hash ? bytes : null;
      } catch {
        return null;
      }
    },
    watch: (listener) => watchEvents(sources, (e) => e.type.startsWith('document.'), listener),
  };
}

function workItemReader(sources: ReaderSources): WorkItemReader {
  return {
    list: async (place) => {
      const out: ReadEntry<WorkItemDetail | Milestone>[] = [];
      for (const item of sources.workItems.list({ projectId: place.projectId })) {
        out.push({ id: `item:${item.id}`, version: item.updatedAt, cursor: `${item.updatedAt}|item:${item.id}`, load: () => sources.workItems.get(item.id) });
      }
      for (const milestone of sources.workItems.milestones(place.projectId)) {
        out.push({ id: `milestone:${milestone.id}`, version: milestone.updatedAt, cursor: `${milestone.updatedAt}|milestone:${milestone.id}`, load: () => milestone });
      }
      return out;
    },
    watch: (listener) => watchEvents(sources, (e) => startsWith(e, 'workitem.', 'milestone.'), listener),
  };
}

function uploadReader(sources: ReaderSources): UploadReader {
  const hashes = new HashCache();
  const uploads = async (chatIds: readonly string[]): Promise<Array<{ attachment: Attachment; chatId: string; sha256: string; attachedAt: string }>> => {
    const out: Array<{ attachment: Attachment; chatId: string; sha256: string; attachedAt: string }> = [];
    const seen = new Set<string>();
    for (const chatId of chatIds) {
      for (const { uploadId: id, attachedAt } of await sources.uploadsOfChat(chatId)) {
        if (seen.has(id)) continue;
        seen.add(id);
        let attachment;
        try {
          attachment = sources.uploads.get(id);
        } catch {
          continue;
        }
        const facts = await hashes.of(attachment.path, Number.MAX_SAFE_INTEGER);
        if (facts) out.push({ attachment, chatId, sha256: facts.sha256, attachedAt });
      }
    }
    return out;
  };
  return {
    list: async (place, chatIds) => {
      const out: ReadEntry<SharedArtifact>[] = [];
      for (const { attachment, chatId, sha256: hash, attachedAt } of await uploads(chatIds)) {
        const data: SharedArtifact = { kind: 'upload', id: attachment.id, name: attachment.name, mediaType: attachment.mediaType, sizeBytes: attachment.sizeBytes, sha256: hash, chatId, createdAt: attachment.createdAt };
        // By when it joined the chat, not when the file was saved: an upload found in an older chat after a restart is still past a copy's cursor
        out.push({ id: `upload:${attachment.id}`, version: hash.slice(0, 32), cursor: `${attachedAt}|upload:${attachment.id}`, load: () => data });
      }
      for (const o of sources.orchestrations(place.projectId)) {
        const data: SharedArtifact = { kind: 'orchestration', id: o.id, name: o.name, finalResult: o.finalResult, updatedAt: o.updatedAt };
        out.push({ id: `orchestration:${o.id}`, version: versionOf(data), cursor: `${o.updatedAt}|orchestration:${o.id}`, load: () => data });
      }
      for (const plan of sources.planDrafts(place.projectId)) {
        const data: SharedArtifact = { kind: 'plan', id: plan.runId, name: plan.name, objective: plan.objective, taskCount: plan.taskCount, createdAt: plan.createdAt };
        out.push({ id: `plan:${plan.runId}`, version: versionOf(data), cursor: `${plan.createdAt}|plan:${plan.runId}`, load: () => data });
      }
      return out;
    },
    read: async (_place, chatIds, hash) => {
      const found = (await uploads(chatIds)).find((u) => u.sha256 === hash);
      if (!found) return null;
      try {
        const bytes = await readFile(found.attachment.path);
        return sha256(bytes) === hash ? bytes : null;
      } catch {
        return null;
      }
    },
    watch: (listener) => watchEvents(sources, (e) => startsWith(e, 'orchestration.', 'run.'), listener),
  };
}

/** The seven ports over the install's stores */
export function createReaders(sources: ReaderSources): Readers {
  return {
    chats: chatReader(sources),
    transcripts: transcriptReader(sources),
    memory: memoryReader(sources),
    journal: journalReader(sources),
    documents: documentReader(sources),
    workItems: workItemReader(sources),
    uploads: uploadReader(sources),
  };
}

