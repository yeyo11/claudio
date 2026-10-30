import type { ApiClient } from './client.ts';
import { objs, type Obj } from './fields.ts';
import type { Property } from './schema.ts';
import { KEY, PAGE_MAX, bool, int, need, num, projectOf, schema, seg, str, text, type Tool } from './tools.ts';
import { isRecord } from '@claudio/shared';

/**
 * The tools that change something. Each calls routes that already exist and that a chat's own token
 * may call (`work`, docs/plans/regression-fixes-2026-10-29.md, C1), with that token. None is allowed
 * ahead of time: the CLI asks the person before it runs any of them, so a call that is denied never
 * gets here. None deletes, touches a setting, an account or security, or widens what a chat may do:
 * a body carries only the fields named here, never a permission mode, a tool list or a server.
 */

const STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'done'];
const TYPES = ['epic', 'story', 'task', 'bug'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const item = str('A key such as AGN-12, or an item id', { minLength: 1, maxLength: 200 });
const chatId = str('The chat id, as list_chats gives it', { minLength: 1, maxLength: 200 });
const orchestrationId = str('The orchestration id, as list_orchestrations gives it', { minLength: 1, maxLength: 200 });
const prompt = (description: string): Property => str(description, { minLength: 1, maxLength: 100_000 });
const model = str('The model, such as sonnet or opus; leave it out for the default', { minLength: 1, maxLength: 200 });
const labels: Property = { type: 'array', description: 'The labels, which replace the current ones', items: str('One label', { minLength: 1, maxLength: 100 }), maxItems: 50 };
const criterionText = str('What must hold', { minLength: 1, maxLength: 1000 });
const newCriteria: Property = {
  type: 'array',
  description: 'The acceptance checklist, in order',
  items: { type: 'object', description: 'One criterion', properties: { text: criterionText }, required: ['text'], additionalProperties: false },
  maxItems: 50,
};
const replacedCriteria: Property = {
  type: 'array',
  description:
    'The whole checklist, which replaces the current one in this order: keep a criterion by passing its id (as get_work_item gives it) with its text, which keeps whether it is checked; one without an id is new, and one left out is removed',
  items: {
    type: 'object',
    description: 'One criterion',
    properties: { id: str('The id of a criterion the item already has', { minLength: 1, maxLength: 200 }), text: criterionText },
    required: ['text'],
    additionalProperties: false,
  },
  maxItems: 50,
};
const limits: Property = {
  type: 'object',
  description: 'What each worker may spend before Claudio stops it',
  properties: { maxMinutes: int('Minutes per task', 1, 24 * 60), maxCostUsd: { type: 'number', description: 'Dollars per task', minimum: 0.01, maximum: 1000 } },
  additionalProperties: false,
};
const taskSpec: Property = {
  type: 'object',
  description: 'One task of the graph',
  properties: {
    id: str('Unique in the graph, short (a, b, api)', { minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9_-]+$' }),
    name: str('What the task is called on the board', { minLength: 1, maxLength: 200 }),
    prompt: prompt('What the worker is asked to do'),
    dependsOn: { type: 'array', description: 'The ids of the tasks it waits for', items: str('A task id', { minLength: 1, maxLength: 100 }), maxItems: 50 },
    model,
    effort: str('How hard the worker thinks', { enum: EFFORTS }),
  },
  required: ['id', 'name', 'prompt'],
  additionalProperties: false,
};

/** What identifies a result, and nothing of the rest: the model needs the key, the id and where it stands */
const KEEP = ['id', 'key', 'title', 'name', 'status', 'state', 'outcome', 'type', 'priority', 'chatId', 'runId', 'orchestrationId', 'taskId', 'projectId'];
export function identify(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of KEEP) if (typeof source[key] === 'string' || typeof source[key] === 'number') out[key] = source[key];
  for (const nested of ['item', 'column', 'chat', 'message']) if (source[nested] && typeof source[nested] === 'object') out[nested] = identify(source[nested]);
  return out;
}

/** The id behind an item reference: a key goes through the by-key route, an id is used as it is */
async function itemId(api: ApiClient, ref: string): Promise<string> {
  const value = ref.trim();
  if (!KEY.test(value)) return value;
  const found = await api.get(`/work-items/by-key/${seg(value.toUpperCase())}`);
  const id = found && typeof found === 'object' && 'id' in found ? found.id : undefined;
  if (typeof id !== 'string') throw new Error(`no work item has the key ${value}`);
  return id;
}

/** The body without the fields that only name the target */
function without(args: Record<string, unknown>, ...names: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([key]) => !names.includes(key)));
}

/** The fields of `source` named in `keys` that are present, as they are */
function only(source: Obj, keys: readonly string[]): Obj {
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined && source[key] !== null).map((key) => [key, source[key]]));
}

/** The directory of a project, from its id */
async function projectPath(api: ApiClient, id: string): Promise<string> {
  const project = await projectOf(api, id);
  if (typeof project.path !== 'string') throw new Error(`the project ${id} has no path`);
  return project.path;
}

/** A chat may not stop, interrupt or message the chat it runs in: that would end its own turn */
function notSelf(api: ApiClient, id: string, what: string): void {
  if (api.chatId && id === api.chatId) throw new Error(`this chat cannot ${what} itself: name another chat`);
}

const TASK_FIELDS = ['id', 'name', 'prompt', 'dependsOn', 'model', 'effort'] as const;
const GRAPH_FIELDS = ['name', 'objective', 'engine', 'model', 'effort', 'concurrency', 'synthesize', 'worktree', 'maxAttempts', 'limits'] as const;

/**
 * The spec `launch_orchestration` sends: the graph's own fields and its tasks, from the arguments or
 * from a planner's draft, and nothing that decides what a worker may do (its permission mode, tools,
 * prompts, guards or verification), which stay the app's defaults.
 */
async function launchSpec(args: Record<string, unknown>, api: ApiClient): Promise<Obj> {
  const planId = text(args, 'fromPlan');
  const draft: Obj = planId ? ((await api.get(`/orchestrations/plans/${seg(planId)}`)) as Obj) : {};
  if (planId && !isRecord(draft)) throw new Error(`the planner chat ${planId} left no draft`);
  const tasks = objs(args.tasks ?? draft.tasks).map((task) => only(task, TASK_FIELDS));
  if (!tasks.length) throw new Error('an orchestration needs tasks: pass tasks, or fromPlan with the planner chat id');
  const project = text(args, 'projectId');
  const cwd = project ? await projectPath(api, project) : typeof draft.cwd === 'string' ? draft.cwd : undefined;
  if (!cwd) throw new Error('an orchestration needs a project: pass projectId');
  const graph = { ...only(draft, GRAPH_FIELDS), ...only(args, GRAPH_FIELDS) };
  if (typeof graph.name !== 'string') throw new Error('an orchestration needs a name');
  return { ...graph, cwd, tasks, ...(planId ? { plannerRunId: planId } : {}) };
}

export const WRITE_TOOLS: readonly Tool[] = [
  {
    name: 'create_work_item',
    description: 'Creates a work item in a project, in the backlog unless a status is given.',
    inputSchema: schema(
      {
        projectId: str('The project id, as list_projects gives it', { minLength: 1, maxLength: 200 }),
        title: str('The title', { minLength: 1, maxLength: 500 }),
        type: str('The type; the default is task', { enum: TYPES }),
        description: str('The description, in Markdown', { maxLength: 50_000 }),
        status: str('The column; the default is backlog', { enum: STATUSES.filter((s) => s !== 'done') }),
        priority: str('The priority; the default is medium', { enum: PRIORITIES }),
        labels,
        epicId: str('The id of an epic of the same project', { minLength: 1, maxLength: 200 }),
        milestoneId: str('The id of a milestone of the same project, as list_milestones gives it', { minLength: 1, maxLength: 200 }),
        acceptanceCriteria: newCriteria,
      },
      ['projectId', 'title'],
    ),
    routes: ['POST /projects/:id/work-items'],
    run: async (args, api) => identify(await api.send('POST', `/projects/${seg(need(args, 'projectId'))}/work-items`, without(args, 'projectId'))),
  },
  {
    name: 'update_work_item',
    description: 'Changes the fields given of a work item, its checklist included; the status and the order change through move_work_item, and a check through check_criterion.',
    inputSchema: schema(
      {
        item,
        type: str('The new type', { enum: TYPES }),
        title: str('The new title', { minLength: 1, maxLength: 500 }),
        description: str('The new description, in Markdown', { maxLength: 50_000 }),
        priority: str('The new priority', { enum: PRIORITIES }),
        labels,
        epicId: str('The id of an epic of the same project', { minLength: 1, maxLength: 200 }),
        milestoneId: str('The id of a milestone of the same project, as list_milestones gives it', { minLength: 1, maxLength: 200 }),
        acceptanceCriteria: replacedCriteria,
      },
      ['item'],
    ),
    routes: ['GET /work-items/by-key/:key', 'PATCH /work-items/:itemId'],
    run: async (args, api) => identify(await api.send('PATCH', `/work-items/${seg(await itemId(api, need(args, 'item')))}`, without(args, 'item'))),
  },
  {
    name: 'check_criterion',
    description: "Checks or unchecks one acceptance criterion of a work item, by the criterion's id as get_work_item gives it.",
    inputSchema: schema(
      { item, criterionId: str('The criterion id, as get_work_item lists it', { minLength: 1, maxLength: 200 }), checked: bool('true to check it, false to uncheck it') },
      ['item', 'criterionId', 'checked'],
    ),
    routes: ['GET /work-items/by-key/:key', 'PATCH /work-items/:itemId/criteria/:criterionId'],
    run: async (args, api) =>
      identify(await api.send('PATCH', `/work-items/${seg(await itemId(api, need(args, 'item')))}/criteria/${seg(need(args, 'criterionId'))}`, { checked: args.checked === true })),
  },
  {
    name: 'move_work_item',
    description: 'Moves a work item to another column, which can start a team member when the flow is on for that column. A card is never moved to Done: the person does that.',
    inputSchema: schema(
      {
        item,
        status: str('The column to move to', { enum: STATUSES }),
        afterId: str('The id of the card it goes right after in that column; leave it out to put it last', { minLength: 1, maxLength: 200 }),
      },
      ['item', 'status'],
    ),
    routes: ['GET /work-items/by-key/:key', 'POST /work-items/:itemId/move'],
    run: async (args, api) => {
      // Checked before any request: only a person moves an item to Done (docs/team-and-flow.md)
      if (text(args, 'status') === 'done') throw new Error('a work item is not moved to Done by the assistant: tell the person to move the card to Done themselves');
      return identify(await api.send('POST', `/work-items/${seg(await itemId(api, need(args, 'item')))}/move`, without(args, 'item')));
    },
  },
  {
    name: 'comment_work_item',
    description: 'Adds a comment to a work item.',
    inputSchema: schema({ item, body: str('The comment, in Markdown', { minLength: 1, maxLength: 50_000 }) }, ['item', 'body']),
    routes: ['GET /work-items/by-key/:key', 'POST /work-items/:itemId/comments'],
    run: async (args, api) => identify(await api.send('POST', `/work-items/${seg(await itemId(api, need(args, 'item')))}/comments`, without(args, 'item'))),
  },
  {
    name: 'retry_flow_run',
    description: 'Queues a new flow run for the work item of a run that failed.',
    inputSchema: schema({ runId: str('The flow run id, as list_flow_runs gives it', { minLength: 1, maxLength: 200 }) }, ['runId']),
    routes: ['POST /flow-runs/:runId/retry'],
    run: async (args, api) => identify(await api.send('POST', `/flow-runs/${seg(need(args, 'runId'))}/retry`)),
  },
  {
    name: 'plan_orchestration',
    description:
      'Starts a planner agent that drafts an orchestration (a task graph) for an objective in a project, without launching it. It answers with the planner chat; once that chat is idle, get_orchestration_plan reads the draft.',
    inputSchema: schema(
      {
        objective: prompt('What the orchestration should achieve, as the person put it'),
        projectId: str('The project id the work happens in, as list_projects gives it', { minLength: 1, maxLength: 200 }),
        model,
        maxTasks: int('The most tasks the draft may have', 1, PAGE_MAX),
      },
      ['objective', 'projectId'],
    ),
    routes: ['GET /projects', 'POST /orchestrations/plan/start'],
    run: async (args, api) => {
      const body = { objective: need(args, 'objective'), cwd: await projectPath(api, need(args, 'projectId')), ...(text(args, 'model') ? { model: text(args, 'model') } : {}), ...(num(args, 'maxTasks') ? { maxTasks: num(args, 'maxTasks') } : {}) };
      return identify(await api.send('POST', '/orchestrations/plan/start', body));
    },
  },
  {
    name: 'launch_orchestration',
    description:
      "Launches an orchestration in a project: a graph of tasks that agents run in parallel, from the tasks given or from a planner's draft (fromPlan). The workers run with the app's defaults for permissions and tools.",
    inputSchema: schema({
      projectId: str('The project id the work happens in; with fromPlan it may be left out to keep the draft folder', { minLength: 1, maxLength: 200 }),
      fromPlan: str('The planner chat id plan_orchestration answered with: its draft is launched, with the fields given here over it', { minLength: 1, maxLength: 200 }),
      name: str('What the orchestration is called', { minLength: 1, maxLength: 200 }),
      objective: str('What it should achieve', { maxLength: 100_000 }),
      engine: str('graph (the default) or workflow', { enum: ['graph', 'workflow'] }),
      tasks: { type: 'array', description: 'The tasks, when not from a plan', items: taskSpec, maxItems: PAGE_MAX },
      model,
      effort: str('How hard the workers think', { enum: EFFORTS }),
      concurrency: int('How many workers run at once; the default is 3', 1, 16),
      synthesize: bool('Whether a final agent writes a report from the results'),
      worktree: bool('Whether each worker works in its own git worktree'),
      maxAttempts: int('Attempts a failed task gets, the first included', 1, 5),
      limits,
    }),
    routes: ['GET /projects', 'GET /orchestrations/plans/:runId', 'POST /orchestrations'],
    run: async (args, api) => identify(await api.send('POST', '/orchestrations', await launchSpec(args, api))),
  },
  {
    name: 'stop_orchestration',
    description: 'Stops every worker of a running orchestration; resume_orchestration picks it up again.',
    inputSchema: schema({ orchestrationId }, ['orchestrationId']),
    routes: ['POST /orchestrations/:id/stop'],
    run: async (args, api) => identify(await api.send('POST', `/orchestrations/${seg(need(args, 'orchestrationId'))}/stop`)),
  },
  {
    name: 'resume_orchestration',
    description: 'Resumes a stopped orchestration: the tasks that did not complete run again, and those that did keep their results.',
    inputSchema: schema({ orchestrationId }, ['orchestrationId']),
    routes: ['POST /orchestrations/:id/resume'],
    run: async (args, api) => identify(await api.send('POST', `/orchestrations/${seg(need(args, 'orchestrationId'))}/resume`)),
  },
  {
    name: 'retry_orchestration_task',
    description: 'Runs a failed task of an orchestration again.',
    inputSchema: schema({ orchestrationId, taskId: str('The task id, as get_orchestration gives it', { minLength: 1, maxLength: 200 }) }, ['orchestrationId', 'taskId']),
    routes: ['POST /orchestrations/:id/tasks/:taskId/retry'],
    run: async (args, api) => identify(await api.send('POST', `/orchestrations/${seg(need(args, 'orchestrationId'))}/tasks/${seg(need(args, 'taskId'))}/retry`)),
  },
  {
    name: 'start_chat',
    description: "Starts a new chat with a first prompt, in a project's folder when one is given. The chat gets the app's defaults, never more.",
    inputSchema: schema(
      {
        prompt: prompt('The first message'),
        projectId: str('The project id the chat works in, as list_projects gives it', { minLength: 1, maxLength: 200 }),
        model,
        name: str('A name for the chat; the first prompt is its title otherwise', { minLength: 1, maxLength: 200 }),
      },
      ['prompt'],
    ),
    routes: ['GET /projects', 'POST /chats'],
    run: async (args, api) => {
      const project = text(args, 'projectId');
      const cwd = project ? await projectPath(api, project) : undefined;
      // Only these reach the route: no permission mode, tool list, preset, MCP, account or prompts, so one confirmed call cannot start a chat that is more than the defaults
      const body = { prompt: need(args, 'prompt'), ...(cwd ? { cwd } : {}), ...(text(args, 'model') ? { model: text(args, 'model') } : {}), ...(text(args, 'name') ? { name: text(args, 'name') } : {}) };
      return identify(await api.send('POST', '/chats', body));
    },
  },
  {
    name: 'send_chat_message',
    description: 'Sends a message to another chat that has a live process, as the person would from its composer; a chat without one is resumed with resume_chat.',
    inputSchema: schema({ chatId, text: str('The message', { minLength: 1, maxLength: 100_000 }) }, ['chatId', 'text']),
    routes: ['POST /chats/:id/messages'],
    run: async (args, api) => {
      notSelf(api, need(args, 'chatId'), 'message');
      return identify(await api.send('POST', `/chats/${seg(need(args, 'chatId'))}/messages`, { text: need(args, 'text') }));
    },
  },
  {
    name: 'hint_chat',
    description: 'Sends a hint to another chat that is working: a nudge it reads as its next message, for a chat that is stuck or going the wrong way.',
    inputSchema: schema({ chatId, text: str('The hint', { minLength: 1, maxLength: 10_000 }) }, ['chatId', 'text']),
    routes: ['POST /chats/:id/hint'],
    run: async (args, api) => {
      notSelf(api, need(args, 'chatId'), 'hint');
      return identify(await api.send('POST', `/chats/${seg(need(args, 'chatId'))}/hint`, { text: need(args, 'text') }));
    },
  },
  {
    name: 'interrupt_chat',
    description: "Interrupts another chat's current turn and keeps its process, which then reads what waits for it.",
    inputSchema: schema({ chatId }, ['chatId']),
    routes: ['POST /chats/:id/interrupt'],
    run: async (args, api) => {
      notSelf(api, need(args, 'chatId'), 'interrupt');
      return identify(await api.send('POST', `/chats/${seg(need(args, 'chatId'))}/interrupt`));
    },
  },
  {
    name: 'stop_chat',
    description: 'Stops what is working on another chat; the conversation is kept and resume_chat continues it.',
    inputSchema: schema({ chatId }, ['chatId']),
    routes: ['POST /chats/:id/stop'],
    run: async (args, api) => {
      notSelf(api, need(args, 'chatId'), 'stop');
      return identify(await api.send('POST', `/chats/${seg(need(args, 'chatId'))}/stop`));
    },
  },
  {
    name: 'resume_chat',
    description: 'Continues a chat that has no live process, in place, with a new message; it keeps its tools and settings.',
    inputSchema: schema({ chatId, prompt: prompt('The message it continues with') }, ['chatId', 'prompt']),
    routes: ['POST /chats/:id/resume'],
    run: async (args, api) => identify(await api.send('POST', `/chats/${seg(need(args, 'chatId'))}/resume`, { prompt: need(args, 'prompt') })),
  },
  {
    name: 'fork_chat',
    description: 'Continues a chat in a copy with a new message, leaving the original untouched; the way forward for a chat another program holds.',
    inputSchema: schema({ chatId, prompt: prompt('The message the copy starts with') }, ['chatId', 'prompt']),
    routes: ['POST /chats/:id/fork'],
    run: async (args, api) => identify(await api.send('POST', `/chats/${seg(need(args, 'chatId'))}/fork`, { prompt: need(args, 'prompt') })),
  },
  {
    name: 'accept_assistant_proposal',
    description: 'Accepts a pending proposal of the project assistant (as list_assistant_proposals gives it), which creates what it proposes: a team member, a resource or a work item.',
    inputSchema: schema({ proposalId: str('The proposal id, as list_assistant_proposals gives it', { minLength: 1, maxLength: 200 }) }, ['proposalId']),
    routes: ['POST /assistant/proposals/:proposalId/accept'],
    run: async (args, api) => identify(await api.send('POST', `/assistant/proposals/${seg(need(args, 'proposalId'))}/accept`)),
  },
  {
    name: 'discard_assistant_proposal',
    description: 'Discards a pending proposal of the project assistant (as list_assistant_proposals gives it); nothing is created.',
    inputSchema: schema({ proposalId: str('The proposal id, as list_assistant_proposals gives it', { minLength: 1, maxLength: 200 }) }, ['proposalId']),
    routes: ['POST /assistant/proposals/:proposalId/discard'],
    run: async (args, api) => identify(await api.send('POST', `/assistant/proposals/${seg(need(args, 'proposalId'))}/discard`)),
  },
];
