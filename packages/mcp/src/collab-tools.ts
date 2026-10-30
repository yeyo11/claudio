import type { ApiClient } from './client.ts';
import { isObj, objs, pick, type Obj } from './fields.ts';
import type { ClaudioMcpCollabToolName } from './names.ts';
import { KEY, int, need, schema, seg, str, text, type Tool } from './tools.ts';
import { fromTeammate, fromTeammates, TextResult, type ContentSource } from './untrusted.ts';

/**
 * The reads of what teammates share with this install (docs/plans/collaborators-agent-access.md).
 * Each reads the copy this install holds, with the chat's own token: the API decides at every call
 * whether this chat may read that copy, never pulls from the teammate's install for it, and writes
 * the read down for the person to see. Nothing here writes, and no tool returns a blob: a document or
 * an upload is named, with its size, never handed over.
 */

const PAGE_MAX = 200;
const TRANSCRIPT_MAX = 200;

const owner = str('The endpoint id of the install that shares the project, as collab_list_shared gives it', { minLength: 1, maxLength: 200 });
const shareId = str('The shareId of the shared project, as collab_list_shared gives it', { minLength: 1, maxLength: 200 });

const COPY_ROUTE = 'GET /collaborators/shared/:owner/:shareId';
const copyPath = (args: Record<string, unknown>): string => `/collaborators/shared/${seg(need(args, 'owner'))}/${seg(need(args, 'shareId'))}`;

const str0 = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The shared project's own record: who shares it and how fresh the copy is, for the header */
async function sourceOf(api: ApiClient, args: Record<string, unknown>, tool: ClaudioMcpCollabToolName): Promise<ContentSource> {
  const share = await api.get(copyPath(args), {}, { tool });
  const s: Obj = isObj(share) ? share : {};
  const sync = isObj(s.sync) ? s.sync : {};
  return {
    ownerName: str0(s.ownerName),
    ownerLabel: typeof s.ownerLabel === 'string' ? s.ownerLabel : null,
    owner: str0(s.owner) || need(args, 'owner'),
    project: str0(s.name),
    shareKey: str0(s.shareKey),
    lastSyncedAt: typeof sync.lastSyncedAt === 'string' ? sync.lastSyncedAt : null,
  };
}

const limited = <T>(rows: T[], limit: number | undefined): T[] => (limit ? rows.slice(0, limit) : rows);
const numArg = (args: Record<string, unknown>, key: string): number | undefined => (typeof args[key] === 'number' ? args[key] : undefined);

/** One tool of a copy: the header from the share's record, the content from `read` */
function copyTool(
  name: ClaudioMcpCollabToolName,
  description: string,
  properties: Parameters<typeof schema>[0],
  required: string[],
  what: string,
  /** The copy's routes it reads, below `/collaborators/shared/:owner/:shareId` */
  under: readonly string[],
  read: (args: Record<string, unknown>, api: ApiClient, base: string) => Promise<unknown>,
): Tool {
  return {
    name,
    description,
    inputSchema: schema({ owner, shareId, ...properties }, ['owner', 'shareId', ...required]),
    routes: [COPY_ROUTE, ...under.map((path) => `${COPY_ROUTE}${path}`)],
    run: async (args, api) => {
      const source = await sourceOf(api, args, name);
      return fromTeammate(source, what, await read(args, api, copyPath(args)));
    },
  };
}

export const COLLAB_TOOLS: readonly Tool[] = [
  {
    name: 'collab_list_shared',
    description:
      "The projects teammates share with this install that this chat may read, by person and install: each with the owner and shareId the other collab_ tools take, what it shares and when the copy was last synced. Use it first for 'what is my teammate working on'.",
    inputSchema: schema({}),
    routes: ['GET /collaborators/shared'],
    run: async (_args, api) => {
      const list = objs(await api.get('/collaborators/shared', {}, { tool: 'collab_list_shared' }));
      if (!list.length) return new TextResult('No project shared with this install is readable by this chat.');
      // Person, then install, then project: the order the Shared tab reads in
      const people = new Map<string, Map<string, { owner: string; label: unknown; projects: Obj[] }>>();
      for (const share of list) {
        const person = str0(share.ownerName);
        const installs = people.get(person) ?? new Map();
        people.set(person, installs);
        const id = str0(share.owner);
        const install = installs.get(id) ?? { owner: id, label: share.ownerLabel ?? null, projects: [] };
        installs.set(id, install);
        const sync = isObj(share.sync) ? share.sync : {};
        install.projects.push({
          ...pick(share, ['name', 'shareId', 'shareKey', 'remote', 'subpath', 'groupIds', 'kinds', 'counts']),
          sync: pick(sync, ['state', 'lastSyncedAt']),
        });
      }
      const groups = [...new Set(list.flatMap((share) => (Array.isArray(share.groupIds) ? share.groupIds.filter((g): g is string => typeof g === 'string') : [])))];
      return fromTeammates('What teammates share with this install', {
        groups,
        people: [...people].map(([name, installs]) => ({ name, installs: [...installs.values()] })),
      });
    },
  },
  copyTool(
    'collab_read_chats',
    "A teammate's shared chats, as the copy holds them: title, first prompt, size, model, whether an agent works in it now, and its subagents. Use it to find a chatId for collab_read_transcript.",
    { limit: int('How many chats', 1, PAGE_MAX) },
    [],
    'Chats',
    ['/chats'],
    async (args, api, base) =>
      limited(objs(await api.get(`${base}/chats`, {}, { tool: 'collab_read_chats' })), numArg(args, 'limit')).map((chat) => ({
        ...pick(chat, ['id', 'title', 'firstPrompt', 'messageCount', 'startedAt', 'updatedAt', 'model', 'origin', 'branch', 'live']),
        subagents: objs(chat.subagents).map((agent) => pick(agent, ['agentId', 'workflowRunId', 'subagentType', 'description', 'workflowPhase'])),
      })),
  ),
  copyTool(
    'collab_read_transcript',
    "A window of a teammate's shared chat transcript, newest entries last, paged like a local chat: pass the window's `from` as `before` to read further back. With agentId, a subagent's transcript (with workflowRunId, a workflow agent's).",
    {
      chatId: str('The chat id, as collab_read_chats gives it', { minLength: 1, maxLength: 200 }),
      agentId: str('A subagent of the chat, as collab_read_chats lists them', { minLength: 1, maxLength: 200 }),
      workflowRunId: str('The workflow run of a workflow agent (wf_…), with agentId', { minLength: 1, maxLength: 200 }),
      limit: int('How many entries', 1, TRANSCRIPT_MAX),
      before: int('Only the entries before this index: the `from` of the previous window', 0),
    },
    ['chatId'],
    'A chat transcript',
    ['/chats/:chatId/transcript', '/chats/:chatId/subagents/:agentId'],
    async (args, api, base) => {
      const chat = `${base}/chats/${seg(need(args, 'chatId'))}`;
      const agentId = text(args, 'agentId');
      const workflow = text(args, 'workflowRunId');
      if (workflow && !agentId) throw new Error('workflowRunId needs the agentId of the workflow agent');
      const query = { limit: numArg(args, 'limit') ?? 50, before: numArg(args, 'before'), ...(workflow ? { workflow } : {}) };
      const page = await api.get(agentId ? `${chat}/subagents/${seg(agentId)}` : `${chat}/transcript`, query, { tool: 'collab_read_transcript' });
      return isObj(page) ? { ...page, ...(typeof page.from === 'number' && page.from > 0 ? { earlier: { before: page.from } } : {}) } : page;
    },
  ),
  copyTool(
    'collab_read_memory',
    "A teammate's shared project memory: what their agents remembered about the project. With name, one file only.",
    { name: str('One memory file, by name', { minLength: 1, maxLength: 300 }) },
    [],
    'Project memory',
    ['/memory'],
    async (args, api, base) => {
      const files = objs(await api.get(`${base}/memory`, {}, { tool: 'collab_read_memory' })).map((file) => pick(file, ['name', 'isIndex', 'description', 'type', 'updatedAt', 'content']));
      const name = text(args, 'name');
      if (!name) return files;
      const found = files.filter((file) => file.name === name);
      if (!found.length) throw new Error(`the copy holds no memory file named ${JSON.stringify(name)}`);
      return found;
    },
  ),
  copyTool(
    'collab_read_documents',
    "What a teammate's shared project holds besides chats: its documents (path, title, size), the final results of its orchestrations, its plan drafts, and its uploads (name and size). A document's or an upload's content is never readable here: the person opens it in the Shared tab.",
    {},
    [],
    'Documents and artifacts',
    ['/documents', '/artifacts'],
    async (_args, api, base) => {
      const [documents, artifacts] = await Promise.all([
        api.get(`${base}/documents`, {}, { tool: 'collab_read_documents' }),
        api.get(`${base}/artifacts`, {}, { tool: 'collab_read_documents' }),
      ]);
      return {
        documents: objs(documents).map((doc) => pick(doc, ['path', 'title', 'size', 'updatedAt'])),
        // The hash of an upload is the handle of its bytes, which an agent is never given
        artifacts: objs(artifacts).map((artifact) =>
          artifact.kind === 'upload'
            ? pick(artifact, ['kind', 'id', 'name', 'mediaType', 'sizeBytes', 'chatId', 'createdAt'])
            : pick(artifact, ['kind', 'id', 'name', 'finalResult', 'objective', 'taskCount', 'updatedAt', 'createdAt']),
        ),
      };
    },
  ),
  copyTool(
    'collab_read_board',
    "A teammate's shared board: the work items by key, title, type, status and priority, and the milestones. With item (a key or an id), that one item with its description, criteria, comments and links.",
    {
      item: str('A key such as AGN-12, or an item id', { minLength: 1, maxLength: 200 }),
      status: str('Only the items in this status', { enum: ['backlog', 'todo', 'in_progress', 'in_review', 'done'] }),
    },
    [],
    'The board',
    ['/work-items'],
    async (args, api, base) => {
      const board = await api.get(`${base}/work-items`, {}, { tool: 'collab_read_board' });
      const items = objs(isObj(board) ? board.items : []);
      const ref = text(args, 'item')?.trim();
      if (ref) {
        const found = items.find((item) => (KEY.test(ref) ? str0(item.key).toUpperCase() === ref.toUpperCase() : item.id === ref));
        if (!found) throw new Error(`the copy holds no work item ${JSON.stringify(ref)}`);
        return found;
      }
      const status = text(args, 'status');
      return {
        items: items
          .filter((item) => !status || item.status === status)
          .map((item) => ({
            ...pick(item, ['id', 'key', 'type', 'title', 'status', 'priority', 'labels', 'milestoneId', 'updatedAt']),
            ...(isObj(item.assignee) ? { assignee: item.assignee.role ?? item.assignee.kind } : {}),
            ...(isObj(item.epic) && typeof item.epic.key === 'string' ? { epic: item.epic.key } : {}),
          })),
        milestones: objs(isObj(board) ? board.milestones : []).map((m) => pick(m, ['id', 'name', 'state', 'progress', 'updatedAt'])),
      };
    },
  ),
  copyTool(
    'collab_read_journal',
    "A teammate's shared project journal, newest first: what their team and agents noted.",
    { limit: int('How many entries', 1, PAGE_MAX) },
    [],
    'The journal',
    ['/journal'],
    async (args, api, base) =>
      limited(objs(await api.get(`${base}/journal`, {}, { tool: 'collab_read_journal' })), numArg(args, 'limit') ?? 50).map((entry) => ({
        ...pick(entry, ['id', 'kind', 'text', 'documentPath', 'createdAt']),
        ...(isObj(entry.item) ? { item: pick(entry.item, ['key', 'title']) } : {}),
        ...(isObj(entry.author) ? { author: pick(entry.author, ['kind', 'name', 'role']) } : {}),
      })),
  ),
];
