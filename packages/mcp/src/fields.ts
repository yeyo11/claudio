/**
 * What each list tool keeps of the route's answer: the fields a model needs to choose, and the id
 * that fetches the rest. The REST payloads carry what a screen draws (worktrees, environments,
 * token splits), which is most of their weight and none of what picks a row.
 */

export type Obj = Record<string, unknown>;

export const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
export const objs = (value: unknown): Obj[] => (Array.isArray(value) ? value.filter(isObj) : []);

/** The listed keys that are present; absent ones and nulls are left out, which costs a model nothing */
export function pick(source: Obj, keys: readonly string[]): Obj {
  const out: Obj = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

const keyOf = (ref: unknown): string | undefined => (isObj(ref) && typeof ref.key === 'string' ? ref.key : undefined);

/** A list the route did not answer in the shape expected goes through untouched rather than being emptied */
const shaped = (value: unknown, shape: (v: unknown) => unknown): unknown => (Array.isArray(value) || isObj(value) ? shape(value) : value);

export const projectRows = (value: unknown): unknown =>
  Array.isArray(value) ? objs(value).map((p) => pick(p, ['id', 'name', 'key', 'path', 'modules', 'chatCount', 'lastActivity', 'exists'])) : value;

export const boardRows = (value: unknown): unknown =>
  shaped(value, (board) => {
    if (!isObj(board) || !Array.isArray(board.columns)) return board;
    return {
      ...pick(board, ['projectId']),
      columns: objs(board.columns).map((column) => ({
        ...pick(column, ['status', 'count', 'limit', 'overLimit', 'more']),
        items: objs(column.items).map((item) => ({
          ...pick(item, ['key', 'id', 'type', 'title', 'status', 'priority', 'labels', 'hasDescription', 'waiting']),
          ...(isObj(item.assignee) ? { assignee: item.assignee.role ?? item.assignee.kind } : {}),
          ...(keyOf(item.epic) ? { epic: keyOf(item.epic) } : {}),
        })),
      })),
    };
  });

export const orchestrationRows = (value: unknown): unknown =>
  Array.isArray(value)
    ? objs(value).map((o) => {
        const tasks = objs(o.tasks);
        const byStatus: Record<string, number> = {};
        for (const task of tasks) if (typeof task.status === 'string') byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
        return {
          ...pick(o, ['id', 'name', 'status', 'createdAt', 'endedAt', 'costUsd', 'cwd', 'error']),
          tasks: { total: tasks.length, ...byStatus },
          ...(isObj(o.verification) && o.verification.status !== undefined ? { verification: o.verification.status } : {}),
        };
      })
    : value;

export const teamRows = (value: unknown): unknown =>
  shaped(value, (team) => {
    if (!isObj(team) || !Array.isArray(team.members)) return team;
    return {
      ...pick(team, ['projectId', 'enabled']),
      members: objs(team.members).map((m) => ({
        ...pick(m, ['agent', 'role', 'model', 'responsibility', 'columns', 'queued']),
        running: objs(m.running).map((r) => ({ run: r.id, item: keyOf(r.item) })),
        ...(isObj(m.lastRun) ? { lastRun: { run: m.lastRun.id, item: keyOf(m.lastRun.item), outcome: m.lastRun.outcome } } : {}),
      })),
    };
  });

export const flowRunRows = (value: unknown): unknown =>
  shaped(value, (page) => {
    if (!isObj(page) || !Array.isArray(page.runs)) return page;
    return {
      runs: objs(page.runs).map((r) => ({
        ...pick(r, ['id', 'role', 'agent', 'model', 'step', 'state', 'outcome', 'summary', 'error', 'chatId', 'queuedAt', 'endedAt']),
        ...(keyOf(r.item) ? { item: keyOf(r.item) } : {}),
      })),
      ...pick(page, ['total', 'nextCursor']),
    };
  });

export const journalRows = (value: unknown): unknown =>
  shaped(value, (page) => {
    if (!isObj(page) || !Array.isArray(page.entries)) return page;
    return {
      entries: objs(page.entries).map((e) => ({
        ...pick(e, ['id', 'kind', 'text', 'documentPath', 'createdAt']),
        ...(keyOf(e.item) ? { item: keyOf(e.item) } : {}),
        ...(isObj(e.author) ? { author: e.author.role ?? e.author.kind } : {}),
      })),
      ...pick(page, ['total', 'nextBefore']),
    };
  });

/** A folder below `depth` keeps its counts and loses its entries, which `more` says are there */
function documentRow(node: Obj, depth: number): Obj {
  const children = Array.isArray(node.children) ? objs(node.children) : null;
  return {
    ...pick(node, ['path', 'type', 'title', 'fileCount']),
    ...(children ? (depth > 1 ? { children: children.map((child) => documentRow(child, depth - 1)) } : children.length ? { more: true } : {}) : {}),
  };
}

export const documentRows = (value: unknown, depth = Number.POSITIVE_INFINITY): unknown =>
  shaped(value, (docs) => {
    if (!isObj(docs) || !Array.isArray(docs.tree)) return docs;
    return { ...pick(docs, ['root', 'exists', 'fileCount']), tree: objs(docs.tree).map((node) => documentRow(node, depth)) };
  });

/** One page of a document by line: `offset` lines skipped, at most `limit` kept, and where the next page starts */
export function documentPage(value: unknown, offset: number, limit: number): unknown {
  if (!isObj(value) || typeof value.content !== 'string') return value;
  const lines = value.content.split('\n');
  const from = Math.min(offset, lines.length);
  const to = Math.min(lines.length, from + limit);
  return {
    ...pick(value, ['path', 'title', 'size', 'updatedAt']),
    ...(Array.isArray(value.ties) && value.ties.length ? { ties: value.ties } : {}),
    lines: { from: from + 1, to, total: lines.length },
    content: lines.slice(from, to).join('\n'),
    ...(to < lines.length ? { nextOffset: to } : {}),
  };
}

export const chatRows = (value: unknown): unknown =>
  Array.isArray(value)
    ? objs(value).map((c) => ({
        ...pick(c, ['id', 'title', 'state', 'origin', 'model', 'messageCount', 'updatedAt', 'atLimit']),
        ...(isObj(c.project) ? { project: c.project.name, projectId: c.project.id } : {}),
        ...(isObj(c.orchestration) ? { orchestration: c.orchestration.id } : {}),
        ...(isObj(c.cost) && typeof c.cost.usd === 'number' ? { costUsd: c.cost.usd } : {}),
      }))
    : value;

export const providerRows = (value: unknown): unknown =>
  Array.isArray(value)
    ? objs(value).map((p) => ({
        ...pick(p, ['id', 'label', 'state', 'reason', 'account', 'version']),
        ...(isObj(p.limit) ? { limit: pick(p.limit, ['state', 'window', 'utilization', 'resetsAt']) } : {}),
      }))
    : value;

export const accountRows = (value: unknown): unknown =>
  Array.isArray(value)
    ? objs(value).map((a) => ({
        ...pick(a, ['id', 'kind', 'alias', 'email', 'plan', 'enabled', 'signedIn']),
        ...(isObj(a.limits) ? { limit: pick(a.limits, ['state', 'window', 'utilization', 'resetsAt', 'observedAt', 'source']) } : {}),
      }))
    : value;

export const milestoneRows = (value: unknown): unknown =>
  Array.isArray(value) ? objs(value).map((m) => pick(m, ['id', 'name', 'state', 'progress', 'closedAt'])) : value;

/** What a proposal is about, in a few words: the member, the resource, the item or the eval case */
function proposalSubject(p: Obj): string | undefined {
  const of = (key: string, field: string): string | undefined => (isObj(p[key]) && typeof (p[key] as Obj)[field] === 'string' ? String((p[key] as Obj)[field]) : undefined);
  return of('member', 'agent') ?? of('resource', 'name') ?? of('workItem', 'title') ?? of('case', 'id');
}

export const proposalRows = (proposals: readonly Obj[]): Obj[] =>
  proposals.map((p) => ({ ...pick(p, ['id', 'kind', 'status', 'runId', 'reason', 'createdAt']), ...(proposalSubject(p) ? { subject: proposalSubject(p) } : {}) }));

// ---------- one chat ----------

/** The longest a tool's input or result stays in a transcript summary */
export const SUMMARY_CLIP_CHARS = 500;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Every string in a value cut at `max`, its shape kept */
function clipped(value: unknown, max: number): unknown {
  if (typeof value === 'string') return clip(value, max);
  if (Array.isArray(value)) return value.map((v) => clipped(v, max));
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clipped(v, max)]));
  return value;
}

/** A transcript entry: `summary` drops thinking and cuts tool inputs and results, `full` keeps the blocks */
function entryRow(entry: Obj, index: number, full: boolean): Obj {
  const blocks: Obj[] = [];
  for (const block of objs(entry.blocks)) {
    switch (block.type) {
      case 'text':
        blocks.push(pick(block, ['type', 'text']));
        break;
      case 'thinking':
        if (full) blocks.push(pick(block, ['type', 'text']));
        break;
      case 'tool_use':
        blocks.push({ ...pick(block, ['type', 'id', 'name']), input: full ? block.input : clipped(block.input, SUMMARY_CLIP_CHARS) });
        break;
      case 'tool_result':
        blocks.push({
          ...pick(block, ['type', 'toolUseId', 'isError']),
          content: full || typeof block.content !== 'string' ? block.content : clip(block.content, SUMMARY_CLIP_CHARS),
        });
        break;
      default:
        blocks.push(pick(block, ['type', 'name', 'mediaType']));
    }
  }
  return { i: index, ...pick(entry, ['role', 'timestamp']), ...(entry.isSidechain === true ? { sidechain: true } : {}), blocks };
}

const count = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

/**
 * A chat as a model reads it: what it is and where it stands, its children counted, its last three
 * executions, what it waits on, and one page of its transcript. The route's detail carries what the
 * chat's page draws (every execution, every child, the environment), most of its weight.
 */
export function chatView(detail: unknown, permissions: unknown, full: boolean): unknown {
  if (!isObj(detail) || !isObj(detail.chat)) return detail;
  const chat = detail.chat;
  const children = isObj(chat.children) ? chat.children : {};
  const branches = [...objs(children.subagents), ...objs(children.backgroundTasks), ...objs(children.workflows)];
  const executions = objs(chat.executions);
  const from = typeof detail.from === 'number' ? detail.from : 0;
  return {
    ...pick(chat, ['id', 'title', 'state', 'model', 'origin', 'alive', 'cwd', 'account', 'atLimit', 'control', 'activity', 'updatedAt']),
    ...(isObj(chat.project) ? { project: chat.project.name, projectId: chat.project.id } : {}),
    ...(isObj(chat.orchestration) ? { orchestration: chat.orchestration.id } : {}),
    ...(isObj(chat.cost) && typeof chat.cost.usd === 'number' ? { costUsd: chat.cost.usd } : {}),
    ...(isObj(chat.health) ? { health: pick(chat.health, ['level', 'reason']) } : {}),
    ...(count(chat.pending) ? { pendingMessages: count(chat.pending) } : {}),
    children: {
      subagents: count(children.subagents),
      backgroundTasks: count(children.backgroundTasks),
      workflows: count(children.workflows),
      running: branches.filter((b) => b.status === 'running').length,
    },
    executions: {
      total: executions.length,
      last: executions.slice(-3).map((e) => pick(e, ['id', 'startedAt', 'endedAt', 'outcome', 'error', 'cause', 'model', 'account'])),
    },
    // The prompts the chat waits on a person for; an error reading them is said, never hidden as none
    permissions: Array.isArray(permissions)
      ? objs(permissions).map((q) => ({ ...pick(q, ['id', 'toolName', 'description', 'requestedAt']), input: clipped(q.input, SUMMARY_CLIP_CHARS) }))
      : permissions,
    transcript: {
      from,
      ...pick(detail, ['total']),
      entries: objs(detail.entries).map((entry, i) => entryRow(entry, from + i, full)),
      // The page above this one, for `before`; absent at the top of the transcript
      ...(from > 0 ? { olderBefore: from } : {}),
    },
  };
}
