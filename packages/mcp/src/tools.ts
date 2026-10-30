import type { ApiClient, Query } from './client.ts';
import type { ClaudioMcpToolName } from './names.ts';
import {
  accountRows,
  boardRows,
  chatRows,
  chatView,
  documentPage,
  documentRows,
  flowRunRows,
  isObj,
  journalRows,
  milestoneRows,
  objs,
  orchestrationRows,
  projectRows,
  proposalRows,
  providerRows,
  teamRows,
  type Obj,
} from './fields.ts';
import type { Property, Schema } from './schema.ts';

export interface Tool {
  name: ClaudioMcpToolName;
  /** What it does, for the model; its first sentence is what the assistant's guide says it can do */
  description: string;
  inputSchema: Schema;
  /**
   * Every route it may call, as `METHOD /pattern` the way the API documents them (`ROUTE_DOCS`): a
   * test holds each to the real route table and to what the tool actually calls
   */
  routes: readonly string[];
  /** How to ask for the rest when the answer is cut: the paging arguments, by name */
  paging?: string;
  run(args: Record<string, unknown>, api: ApiClient): Promise<unknown>;
}

export const str = (description: string, extra: Partial<Property> = {}): Property => ({ type: 'string', description, ...extra });
export const int = (description: string, minimum: number, maximum?: number): Property => ({
  type: 'integer',
  description,
  minimum,
  ...(maximum === undefined ? {} : { maximum }),
});
export const bool = (description: string): Property => ({ type: 'boolean', description });
export const schema = (properties: Record<string, Property>, required: string[] = []): Schema => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

export const text = (args: Record<string, unknown>, key: string): string | undefined => {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
};
export const num = (args: Record<string, unknown>, key: string): number | undefined => {
  const value = args[key];
  return typeof value === 'number' ? value : undefined;
};
export const need = (args: Record<string, unknown>, key: string): string => text(args, key) ?? '';
/** One path segment: an id or a key from the model must never reach past its own place in the path */
export const seg = (value: string): string => encodeURIComponent(value);

export const KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
export const PAGE_MAX = 50;
/** Rows a list answers with when no limit is given: a real install has more than a thousand chats */
const LIST_DEFAULT = 25;
/** Transcript entries `get_chat` answers with when no limit is given */
const ENTRIES_DEFAULT = 10;
/** Lines `read_document` answers with when no limit is given, and the most it takes */
const LINES_DEFAULT = 200;
const LINES_MAX = 2_000;
/** Folder levels `list_documents` answers with when no depth is given */
const DOCUMENT_DEPTH_DEFAULT = 2;
/** Runs `list_assistant_proposals` opens at most, newest first */
const PROPOSAL_RUNS_MAX = 10;
const DAY = '^\\d{4}-\\d{2}-\\d{2}$';
export const projectId = str('The project id, as list_projects gives it', { minLength: 1, maxLength: 200 });

const BOARD_FILTERS = ['status', 'type', 'priority', 'labels', 'assignee'] as const;

export function pick(args: Record<string, unknown>, keys: readonly string[]): Query {
  const query: Query = {};
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' || typeof value === 'number') query[key] = value;
  }
  return query;
}

/** The server's local day, as the daily spend counts it: what "today" means to the person */
async function serverDay(api: ApiClient): Promise<string> {
  const spend = await api.get('/spend');
  if (isObj(spend) && typeof spend.day === 'string') return spend.day;
  throw new Error('the server did not say what day it is (GET /spend has no day): give from and to');
}

/** The project of an id, as `GET /projects` lists it; the API has no route for one project */
export async function projectOf(api: ApiClient, id: string): Promise<Obj> {
  const found = objs(await api.get('/projects')).find((p) => p.id === id);
  if (!found) throw new Error(`no project has the id ${id}: list_projects gives the ids`);
  return found;
}

/** The proposals of a project's recent assistant runs, each run opened only when its counts say it holds some */
async function proposalsOf(api: ApiClient, project: string, status: string, kind: string | undefined): Promise<Obj[]> {
  const runs = objs(await api.get(`/projects/${seg(project)}/assistant/runs`));
  const holding = runs.filter((run) => {
    if (!isObj(run.counts)) return true;
    return Object.entries(run.counts).some(([k, c]) => (!kind || k === kind) && isObj(c) && typeof c[status] === 'number' && c[status] > 0);
  });
  const out: Obj[] = [];
  for (const run of holding.slice(0, PROPOSAL_RUNS_MAX)) {
    if (typeof run.id !== 'string') continue;
    const detail = await api.get(`/assistant/runs/${seg(run.id)}`);
    if (!isObj(detail)) continue;
    for (const proposal of objs(detail.proposals)) if (proposal.status === status && (!kind || proposal.kind === kind)) out.push(proposal);
  }
  return out;
}

export const TOOLS: readonly Tool[] = [
  {
    name: 'list_projects',
    description: 'Lists every project Claudio knows, with its key prefix and modules. Use it first to find a project id.',
    inputSchema: schema({}),
    routes: ['GET /projects'],
    run: async (_args, api) => projectRows(await api.get('/projects')),
  },
  {
    name: 'get_overview',
    description: "Reads the dashboard in one call: what is running, waiting and failing across Claudio. Use it as the first look at 'how is everything'.",
    inputSchema: schema({}),
    routes: ['GET /overview'],
    run: (_args, api) => api.get('/overview'),
  },
  {
    name: 'get_board',
    description: "Reads a board of work items by status, for one project or for all of them. Use it for 'what is in progress' or 'what is waiting for review'.",
    inputSchema: schema({
      projectId: str('The project id; leave it out for the board of every project', { minLength: 1, maxLength: 200 }),
      doneLimit: int('How many done cards to include', 0, PAGE_MAX),
      status: str('Comma separated statuses to keep'),
      type: str('Comma separated types to keep'),
      priority: str('Comma separated priorities to keep'),
      labels: str('Comma separated labels to keep'),
      assignee: str('Comma separated assignees to keep'),
      epicId: str('Only the items of this epic'),
      milestoneId: str('Only the items of this milestone, as list_milestones gives it'),
      q: str('Text to search in titles'),
    }),
    routes: ['GET /projects/:id/work-items/board', 'GET /work-items/board'],
    paging: 'The board was cut to fit. Narrow it: one projectId, a status, a type or q.',
    run: (args, api) => {
      const query = { ...pick(args, [...BOARD_FILTERS, 'epicId', 'milestoneId', 'q', 'doneLimit']) };
      const id = text(args, 'projectId');
      return api.get(id ? `/projects/${seg(id)}/work-items/board` : '/work-items/board', query).then(boardRows);
    },
  },
  {
    name: 'get_work_item',
    description:
      "Reads one work item by key (AGN-12, any case) or id, with its acceptance criteria (each with its id), comments, history, links and flow runs. Use it for 'how is X going'.",
    inputSchema: schema({ item: str('A key such as AGN-12, or an item id', { minLength: 1, maxLength: 200 }) }, ['item']),
    routes: ['GET /work-items/by-key/:key', 'GET /work-items/:itemId', 'GET /work-items/:itemId/runs'],
    run: async (args, api) => {
      const item = need(args, 'item').trim();
      // The detail already carries the links; the runs are a route of their own
      const detail = await api.get(KEY.test(item) ? `/work-items/by-key/${seg(item.toUpperCase())}` : `/work-items/${seg(item)}`);
      const id = detail && typeof detail === 'object' && 'id' in detail && typeof detail.id === 'string' ? detail.id : item;
      const runs = await api.get(`/work-items/${seg(id)}/runs`);
      return { ...(detail as object), runs };
    },
  },
  {
    name: 'list_milestones',
    description: "Lists a project's milestones, oldest first, with their state and progress. Use it to find the milestoneId get_board and the work item tools take.",
    inputSchema: schema({ projectId }, ['projectId']),
    routes: ['GET /projects/:id/milestones'],
    run: async (args, api) => milestoneRows(await api.get(`/projects/${seg(need(args, 'projectId'))}/milestones`)),
  },
  {
    name: 'list_orchestrations',
    description: 'Lists the orchestrations, newest first, with their state and cost, 25 unless limit says otherwise. Use it to find an orchestration id.',
    inputSchema: schema({ limit: int('How many to return; the default is 25', 1, PAGE_MAX) }),
    routes: ['GET /orchestrations'],
    paging: 'The list was cut to fit: ask for a smaller limit.',
    run: async (args, api) => {
      const all = await api.get('/orchestrations');
      return orchestrationRows(Array.isArray(all) ? all.slice(0, num(args, 'limit') ?? LIST_DEFAULT) : all);
    },
  },
  {
    name: 'get_orchestration',
    description: "Reads one orchestration with every task's state, result and cost, its verification and its final report. Use it for 'why did X fail'.",
    inputSchema: schema({ orchestrationId: str('The orchestration id', { minLength: 1, maxLength: 200 }) }, ['orchestrationId']),
    routes: ['GET /orchestrations/:id'],
    paging: "The orchestration was cut to fit: a task's chat holds its whole story, read it with get_chat.",
    // The view carries the tasks, the verification and the final result: one route is enough
    run: (args, api) => api.get(`/orchestrations/${seg(need(args, 'orchestrationId'))}`),
  },
  {
    name: 'get_orchestration_plan',
    description: 'Reads the draft task graph a planner chat of plan_orchestration produced, once that chat is idle. Use it to show the plan to the person before launch_orchestration.',
    inputSchema: schema({ runId: str('The planner chat id plan_orchestration answered with', { minLength: 1, maxLength: 200 }) }, ['runId']),
    routes: ['GET /orchestrations/plans/:runId'],
    run: (args, api) => api.get(`/orchestrations/plans/${seg(need(args, 'runId'))}`),
  },
  {
    name: 'list_assistant_proposals',
    description:
      "Lists the proposals of a project's assistant (team members, resources, work items, eval cases), the pending ones unless status says otherwise. Use it to find the id accept_assistant_proposal and discard_assistant_proposal take.",
    inputSchema: schema(
      {
        projectId,
        status: str('Which proposals; the default is pending', { enum: ['pending', 'accepted', 'discarded', 'superseded'] }),
        kind: str('Only proposals of this kind', { enum: ['team-member', 'resource', 'work-item', 'eval-case'] }),
      },
      ['projectId'],
    ),
    routes: ['GET /projects/:id/assistant/runs', 'GET /assistant/runs/:runId'],
    paging: 'The proposals were cut to fit: ask for one kind.',
    run: async (args, api) => proposalRows(await proposalsOf(api, need(args, 'projectId'), text(args, 'status') ?? 'pending', text(args, 'kind'))),
  },
  {
    name: 'get_team',
    description: "Reads a project's team: its agents, their roles and what each is doing. Use it for 'who works on this'.",
    inputSchema: schema({ projectId }, ['projectId']),
    routes: ['GET /projects/:id/team'],
    run: async (args, api) => teamRows(await api.get(`/projects/${seg(need(args, 'projectId'))}/team`)),
  },
  {
    name: 'list_flow_runs',
    description: "Lists a project's flow runs, newest first, filtered by agent, role, status or item. Use it for 'what did the team do' or 'what failed'.",
    inputSchema: schema(
      {
        projectId,
        agent: str('Comma separated agents'),
        role: str('Comma separated roles'),
        status: str('Comma separated run statuses'),
        itemId: str('Only the runs of this work item id'),
        before: str('Only the runs before this date and time (ISO 8601)'),
        cursor: str('The nextCursor of the previous page, to read the next one'),
        limit: int('How many to return', 1, PAGE_MAX),
      },
      ['projectId'],
    ),
    routes: ['GET /projects/:id/flow/runs'],
    paging: 'The runs were cut to fit: ask for a smaller limit, and the next page with cursor.',
    run: async (args, api) => flowRunRows(await api.get(`/projects/${seg(need(args, 'projectId'))}/flow/runs`, pick(args, ['agent', 'role', 'status', 'itemId', 'before', 'cursor', 'limit']))),
  },
  {
    name: 'get_journal',
    description: "Reads a project's journal, newest first: what the team and people noted. Use it for 'what happened lately'.",
    inputSchema: schema({ projectId, limit: int('How many entries', 1, PAGE_MAX), before: str('Only entries before this cursor or date') }, ['projectId']),
    routes: ['GET /projects/:id/journal'],
    paging: 'The journal was cut to fit: ask for a smaller limit, and older entries with before (the nextBefore it gave).',
    run: async (args, api) => journalRows(await api.get(`/projects/${seg(need(args, 'projectId'))}/journal`, pick(args, ['limit', 'before']))),
  },
  {
    name: 'list_documents',
    description: "Lists the tree of a project's documents, two folder levels deep unless depth says otherwise. Use it to find the path of a document before read_document.",
    inputSchema: schema({ projectId, depth: int('How many folder levels to list; the default is 2. A folder below it says more: true', 1, 16) }, ['projectId']),
    routes: ['GET /projects/:id/documents'],
    paging: 'The tree was cut to fit: ask for a smaller depth.',
    run: async (args, api) => documentRows(await api.get(`/projects/${seg(need(args, 'projectId'))}/documents`), num(args, 'depth') ?? DOCUMENT_DEPTH_DEFAULT),
  },
  {
    name: 'read_document',
    description: 'Reads one document of a project by its path, as list_documents gives it, 200 lines at a time. Use it to read a plan, a decision or a report.',
    inputSchema: schema(
      {
        projectId,
        path: str('The document path inside the project', { minLength: 1, maxLength: 1000 }),
        offset: int('Lines to skip from the top: the nextOffset of the previous page', 0),
        limit: int('How many lines to read; the default is 200', 1, LINES_MAX),
      },
      ['projectId', 'path'],
    ),
    routes: ['GET /projects/:id/documents/file'],
    paging: 'The page was cut to fit: ask for fewer lines with limit, and go on with offset.',
    run: async (args, api) =>
      documentPage(await api.get(`/projects/${seg(need(args, 'projectId'))}/documents/file`, { path: need(args, 'path') }), num(args, 'offset') ?? 0, num(args, 'limit') ?? LINES_DEFAULT),
  },
  {
    name: 'list_chats',
    description: "Lists chats, newest first, with their state, 25 unless limit says otherwise. Use it for 'which chats are waiting for me' or 'what ran in project X'.",
    inputSchema: schema({
      project: str('Only the chats of this project id'),
      state: str('Only chats in this state', { enum: ['working', 'waiting', 'idle'] }),
      origin: str('Comma separated origins: claudio, external, orchestration, internal'),
      limit: int('How many chats; the default is 25', 1, PAGE_MAX),
    }),
    routes: ['GET /chats'],
    paging: 'The list was cut to fit: ask for a smaller limit, a project or a state.',
    run: async (args, api) => chatRows(await api.get('/chats', { ...pick(args, ['project', 'state', 'origin']), limit: num(args, 'limit') ?? LIST_DEFAULT })),
  },
  {
    name: 'get_chat',
    description:
      'Reads one chat: its state, model, cost and children, its last executions, the prompts it waits on, and a page of its transcript (the last 10 entries, tool inputs and results cut short). Use it to see what a chat did or needs; page back with before.',
    inputSchema: schema(
      {
        chatId: str('The chat id', { minLength: 1, maxLength: 200 }),
        limit: int('How many transcript entries; the default is 10', 1, PAGE_MAX),
        before: int('Only entries before this index: the olderBefore of the previous answer', 0),
        entries: str('summary (the default) cuts tool inputs and results at 500 characters and drops thinking; full keeps them', { enum: ['summary', 'full'] }),
      },
      ['chatId'],
    ),
    routes: ['GET /chats/:id', 'GET /chats/:id/permissions'],
    paging: 'The chat was cut to fit: ask for fewer entries with limit, entries: summary, and older ones with before.',
    run: async (args, api) => {
      const id = seg(need(args, 'chatId'));
      const before = num(args, 'before');
      const [detail, permissions] = await Promise.all([
        api.get(`/chats/${id}`, { limit: num(args, 'limit') ?? ENTRIES_DEFAULT, ...(before !== undefined ? { before } : {}) }),
        // Read beside the detail; a failure is said in the answer, never taken for "no prompt"
        api.get(`/chats/${id}/permissions`).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) })),
      ]);
      return chatView(detail, permissions, text(args, 'entries') === 'full');
    },
  },
  {
    name: 'get_usage',
    description:
      "Reads cost and tokens for a range of days, with their breakdown by model and project; today (the server's day) unless from and to say otherwise. Use it for 'what did I spend'.",
    inputSchema: schema({
      from: str("First day, YYYY-MM-DD; the default is the server's today", { pattern: DAY }),
      to: str("Last day, YYYY-MM-DD; the default is the server's today", { pattern: DAY }),
    }),
    routes: ['GET /spend', 'GET /usage', 'GET /usage/breakdown'],
    paging: 'The usage was cut to fit: ask for a shorter range of days.',
    run: async (args, api) => {
      // A missing bound is the server's day, never all of history
      const today = text(args, 'from') && text(args, 'to') ? undefined : await serverDay(api);
      const query = { from: text(args, 'from') ?? today, to: text(args, 'to') ?? today };
      const [usage, breakdown] = await Promise.all([api.get('/usage', query), api.get('/usage/breakdown', query)]);
      return { from: query.from, to: query.to, usage, breakdown };
    },
  },
  {
    name: 'list_providers',
    description:
      "Lists the agent provider (Claude Code): whether it is ready and why not, its account, and its usage limit per window with the reset. Use it for 'how close am I to the limit' and 'which agents can I use'.",
    inputSchema: schema({}),
    routes: ['GET /providers'],
    // What the detector last read, never a new detection: refreshing runs every installed CLI
    run: async (_args, api) => providerRows(await api.get('/providers')),
  },
  {
    name: 'list_accounts',
    description:
      "Lists the Claude accounts: kind, alias or email, plan, whether each is enabled and signed in, and its usage limit (binding window, utilization 0-1, reset, how old the reading is). Use it for 'which account has room' and 'how close is each account to its limit'.",
    inputSchema: schema({}),
    routes: ['GET /accounts'],
    run: async (_args, api) => accountRows(await api.get('/accounts')),
  },
];
