import type { ApiClient } from './client.ts';
import { objs, type Obj } from './fields.ts';
import type { Property } from './schema.ts';
import { KEY, PAGE_MAX, bool, int, need, num, projectOf, schema, seg, str, text, type Tool } from './tools.ts';
import { DEFAULT_GUARD_SETTINGS, PERMISSION_MODES, isRecord } from '@claudio/shared';

/**
 * The tools that change something. Each calls routes that already exist, with the chat's own token.
 * None is allowed ahead of time: the CLI asks the person before it runs any of them, so a call that
 * is denied never gets here. `WRITE_TOOLS` call routes a chat's token may call (`work`,
 * docs/plans/regression-fixes-2026-10-29.md, C1); `OWNER_TOOLS` call the person's own orchestration
 * routes, which the API opens only to a chat the person switched Claudio's server on for (D12 of
 * docs/plans/claudio-servers.md). A body carries only the fields named here. The fields that decide
 * what a worker may do (its permission mode, prompts, tools, guards and checks) are sent only when
 * given by name, never taken from a planner's draft, and the API refuses them to every other chat.
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
/** What decides what the workers may do: the person's fields, which only a chat with Claudio's server on may send (D12) */
const PERSON_FIELDS = ['permissionMode', 'permissionPrompts', 'allowedTools', 'verification', 'guards'] as const;

const ONLY_SWITCHED_ON = "a chat's token sends it only while the person has Claudio's server switched on for the chat";
const REVIEW_MODELS = { reviewer: str('Model of the reviewers'), verifier: str('Model of the runs that confirm a finding'), fixer: str('Model of the fixer') };
/** The review gate that runs after the checks pass, as ReviewGateSpec takes it; every field has its default */
const review: Property = {
  type: 'object',
  description: 'The review gate: agents review the merged diff after the checks pass and, by default, a fixer mends what blocks. Every field has a default, so {} turns it on',
  properties: {
    dimensions: {
      type: 'object',
      description: 'Which reviews run besides correctness, which always does',
      properties: {
        tests: bool('Whether weak or missing tests are reviewed; the default is true'),
        security: str('auto runs the security review when its trigger matches, always on every diff, off never; the default is auto', { enum: ['auto', 'always', 'off'] }),
        conventions: bool("Whether the repository's own rules are reviewed; the default is true when it has CLAUDE.md, CONTRIBUTING.md or .claude/rules"),
      },
      additionalProperties: false,
    },
    depth: str('light runs correctness (and security when triggered) in chunks twice as large; the default is full', { enum: ['light', 'full'] }),
    fixer: bool('Whether blocking findings go to a fixer; the default is true'),
    maxFixRounds: int('Fixer rounds; the gate reviews at most one more time than this. The default is 2', 0, 5),
    maxCostUsd: { type: 'number', description: 'Dollars the whole gate may spend; the default is 5', minimum: 0.01, maximum: 1000 },
    maxRunCostUsd: { type: 'number', description: 'Dollars one reviewer or verifier run may spend; the default is 1', minimum: 0.01, maximum: 1000 },
    timeoutMinutes: int("Minutes of one run's own work; the default is 15", 1, 60),
    concurrency: int('Review runs of this graph at the same time; the default is 3', 1, 6),
    models: { type: 'object', description: 'Models by role; the defaults are sonnet for reviewers, opus for verifiers and the verification model, else the graph model, for the fixer', properties: REVIEW_MODELS, additionalProperties: false },
    exclude: { type: 'array', description: 'Globs added to the built-in exclusions, in gitignore syntax from the repository top', items: str('One glob', { minLength: 1, maxLength: 500 }), maxItems: 100 },
  },
  additionalProperties: false,
};
const command = str('One command', { minLength: 1, maxLength: 2000 });
const verification: Property = {
  type: 'object',
  description: `The checks run on the integration branch once the graph is merged; ${ONLY_SWITCHED_ON}`,
  properties: {
    commands: {
      type: 'array',
      description: 'Shell commands, run in order. An entry that is a list of commands runs them at the same time, and the next entry starts once all of them have ended. May be empty when review is given',
      items: { anyOf: [command, { type: 'array', description: 'Commands that run at the same time', items: command, minItems: 1, maxItems: 20 }], description: 'A command, or a list of commands that run at the same time' },
      maxItems: 50,
    },
    review,
    fixer: bool('Whether an agent fixes what fails; the default is false'),
    maxAttempts: int('Fixer attempts per failing command', 1, 10),
    model,
    effort: str('How hard the fixer thinks', { enum: EFFORTS }),
    timeoutMinutes: int('Minutes each command may run; the default is 20', 1, 24 * 60),
    maxCostUsd: { type: 'number', description: 'Dollars the fixer may spend over its attempts', minimum: 0.01, maximum: 1000 },
    install: str('The install command run first; detected from the lockfile when left out', { minLength: 1, maxLength: 2000 }),
    failGraph: bool('Whether failed checks leave the orchestration failed'),
    e2eSpecs: bool('Whether the browser specs the changes touch run before the merge; the default is true'),
  },
  required: ['commands'],
  additionalProperties: false,
};
const PERSON_PROPERTIES: Record<(typeof PERSON_FIELDS)[number], Property> = {
  permissionMode: str(`How the workers' permissions run; the app's default when left out. ${ONLY_SWITCHED_ON}`, { enum: [...PERMISSION_MODES] }),
  permissionPrompts: str(`host sends each worker's permission prompts to the person; none leaves them unanswered. ${ONLY_SWITCHED_ON}`, { enum: ['host', 'none'] }),
  allowedTools: { type: 'array', description: `Tools every worker may use without asking, such as Bash(pnpm test:*); ${ONLY_SWITCHED_ON}`, items: str('One tool rule', { minLength: 1, maxLength: 500 }), maxItems: 100 },
  verification,
  guards: {
    type: 'object',
    description: `The guards of this graph's runs over the app's settings; ${ONLY_SWITCHED_ON}`,
    properties: {
      enabled: bool('false switches the guards off for this graph'),
      rules: {
        type: 'object',
        description: 'Rules switched on or off for this graph, by id',
        properties: Object.fromEntries(Object.keys(DEFAULT_GUARD_SETTINGS.rules).map((rule) => [rule, bool(`The ${rule} rule`)])),
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
};

const taskId = str('The task id, as get_orchestration gives it', { minLength: 1, maxLength: 200 });
const templateId = str('The template id, as list_orchestration_templates gives it', { minLength: 1, maxLength: 200 });
const proposalId = str("The Supervisor's proposal id, as get_orchestration gives it on the task", { minLength: 1, maxLength: 200 });
const orchestrationPath = (args: Record<string, unknown>): string => `/orchestrations/${seg(need(args, 'orchestrationId'))}`;
const taskPath = (args: Record<string, unknown>): string => `${orchestrationPath(args)}/tasks/${seg(need(args, 'taskId'))}`;

/** A graph's fields for a template or a relaunch: its own settings, the person's fields and its tasks, as given */
function graphFields(args: Record<string, unknown>): Obj {
  return { ...only(args, GRAPH_FIELDS), ...only(args, PERSON_FIELDS), ...(args.tasks === undefined ? {} : { tasks: objs(args.tasks).map((task) => only(task, TASK_FIELDS)) }) };
}

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

const OVERLAPS = ['parallel', 'skip', 'queue'];
const scheduleId = str('The schedule id, as list_schedules gives it', { minLength: 1, maxLength: 200 });
const cron = str('Five fields (minute, hour, day of month, month, day of week), or @hourly, @daily, @weekly, @monthly, @yearly; preview_schedule says what it will do', { minLength: 1, maxLength: 200 });
const timezone = str("An IANA zone such as Europe/Madrid; the server's when left out", { minLength: 1, maxLength: 100 });
const overlap = str('What a fire does while the last run is still going: parallel (the default) starts anyway, skip starts nothing, queue starts it when that run ends', { enum: OVERLAPS });
const scheduleTargetSpec: Property = {
  type: 'object',
  description:
    'What each fire starts. kind chat: a chat with a prompt (and projectId, model, name). kind orchestration: a graph from tasks, or from a planner draft with fromPlan, in a project (and name, objective, model, effort, concurrency, synthesize, worktree, maxAttempts, limits)',
  properties: {
    kind: str('chat or orchestration', { enum: ['chat', 'orchestration'] }),
    projectId: str('The project id the work happens in, as list_projects gives it', { minLength: 1, maxLength: 200 }),
    prompt: prompt('The first message of each chat (kind chat)'),
    name: str('What the chat or the orchestration is called', { minLength: 1, maxLength: 200 }),
    model,
    fromPlan: str('The planner chat id plan_orchestration answered with (kind orchestration)', { minLength: 1, maxLength: 200 }),
    objective: str('What the orchestration should achieve', { maxLength: 100_000 }),
    tasks: { type: 'array', description: 'The tasks of the graph (kind orchestration), when not from a plan', items: taskSpec, maxItems: PAGE_MAX },
    effort: str('How hard the workers think', { enum: EFFORTS }),
    concurrency: int('How many workers run at once; the default is 3', 1, 16),
    synthesize: bool('Whether a final agent writes a report from the results'),
    worktree: bool('Whether each worker works in its own git worktree'),
    maxAttempts: int('Attempts a failed task gets, the first included', 1, 5),
    limits,
  },
  required: ['kind'],
  additionalProperties: false,
};

/**
 * The target a schedule starts, built as `start_chat` and `launch_orchestration` build theirs: only
 * the fields named here reach the route, so a confirmed call cannot schedule more than the defaults
 */
async function scheduleTarget(value: unknown, api: ApiClient): Promise<Obj> {
  if (!isRecord(value)) throw new Error('a schedule needs a target');
  const rest = without(value, 'kind');
  if (value.kind === 'chat') {
    const project = text(rest, 'projectId');
    const cwd = project ? await projectPath(api, project) : undefined;
    if (!text(rest, 'prompt')) throw new Error('a chat target needs a prompt');
    return { kind: 'chat', chat: { prompt: need(rest, 'prompt'), ...(cwd ? { cwd } : {}), ...only(rest, ['model', 'name']) } };
  }
  if (value.kind === 'orchestration') return { kind: 'orchestration', spec: await launchSpec(rest, api) };
  throw new Error('the target kind is chat or orchestration');
}

const SCHEDULE_FIELDS = ['name', 'cron', 'timezone', 'overlap', 'enabled'] as const;
/** What identifies a schedule or a run of one, and when it fires next; never the target's prompts */
const SCHEDULE_KEEP = ['id', 'name', 'cron', 'timezone', 'enabled', 'overlap', 'lastRunAt', 'nextRunAt', 'scheduleId', 'status', 'at', 'chatId', 'orchestrationId', 'error'] as const;
function scheduleResult(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return { ...only(value, SCHEDULE_KEEP), ...(isRecord(value.target) && typeof value.target.kind === 'string' ? { target: value.target.kind } : {}) };
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
      "Launches an orchestration in a project: a graph of tasks that agents run in parallel, from the tasks given or from a planner's draft (fromPlan). The workers run with the app's defaults for permissions, tools, guards and checks unless permissionMode, permissionPrompts, allowedTools, guards or verification are given, which a chat may send only while the person has Claudio's server switched on for it.",
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
      ...PERSON_PROPERTIES,
    }),
    routes: ['GET /projects', 'GET /orchestrations/plans/:runId', 'POST /orchestrations'],
    // The person's fields only as given by name: a planner's draft is an agent's output, and never widens the run
    run: async (args, api) => identify(await api.send('POST', '/orchestrations', { ...(await launchSpec(args, api)), ...only(args, PERSON_FIELDS) })),
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
    inputSchema: schema({ orchestrationId, taskId }, ['orchestrationId', 'taskId']),
    routes: ['POST /orchestrations/:id/tasks/:taskId/retry'],
    run: async (args, api) => identify(await api.send('POST', `${taskPath(args)}/retry`)),
  },
  {
    name: 'retry_orchestration_task_clean',
    description: 'Starts a failed task of an orchestration over, in a new chat and a worktree rebuilt from the commit it started from; the failed chat stays listed as what was tried.',
    inputSchema: schema({ orchestrationId, taskId }, ['orchestrationId', 'taskId']),
    routes: ['POST /orchestrations/:id/tasks/:taskId/retry-clean'],
    run: async (args, api) => identify(await api.send('POST', `${taskPath(args)}/retry-clean`)),
  },
  {
    name: 'rerun_orchestration_task',
    description: 'Runs a task of a finished orchestration (completed, failed or stopped) again, with every task that depends on it, each in a new chat.',
    inputSchema: schema({ orchestrationId, taskId }, ['orchestrationId', 'taskId']),
    routes: ['POST /orchestrations/:id/tasks/:taskId/rerun'],
    run: async (args, api) => identify(await api.send('POST', `${taskPath(args)}/rerun`)),
  },
  {
    name: 'skip_orchestration_task',
    description: 'Gives up a failed or blocked task of an orchestration and every task that depends on it, so the graph can finish without them. Nothing is deleted.',
    inputSchema: schema({ orchestrationId, taskId }, ['orchestrationId', 'taskId']),
    routes: ['POST /orchestrations/:id/tasks/:taskId/skip'],
    run: async (args, api) => identify(await api.send('POST', `${taskPath(args)}/skip`)),
  },
  {
    name: 'message_orchestration_task',
    description:
      "Sends a message to the worker of an orchestration task that is still running: it reaches the worker's chat mid-run, as its next message. A task that finished refuses it; fork its chat instead.",
    inputSchema: schema({ orchestrationId, taskId, text: str('The message', { minLength: 1, maxLength: 10_000 }) }, ['orchestrationId', 'taskId', 'text']),
    // The task's hint route, not the chat's message route: it is the one the board uses, it checks the task still runs, and it frames the text for the worker
    routes: ['POST /orchestrations/:id/tasks/:taskId/hint'],
    run: async (args, api) => identify(await api.send('POST', `${taskPath(args)}/hint`, { text: need(args, 'text') })),
  },
  {
    name: 'verify_orchestration',
    description:
      "Runs an orchestration's checks on its integration branch again, or with the verification given, which a chat may send only while the person has Claudio's server switched on for it. It answers at once; get_orchestration follows the verification's status.",
    inputSchema: schema({ orchestrationId, verification }, ['orchestrationId']),
    routes: ['POST /orchestrations/:id/verify'],
    run: async (args, api) => identify(await api.send('POST', `${orchestrationPath(args)}/verify`, only(args, ['verification']))),
  },
  {
    name: 'retry_orchestration_review',
    description: "Runs the review gate of an orchestration again on its integration branch, without running its checks again. It answers at once; get_orchestration follows the review's state.",
    inputSchema: schema({ orchestrationId }, ['orchestrationId']),
    routes: ['POST /orchestrations/:id/review/retry'],
    run: async (args, api) => identify(await api.send('POST', `${orchestrationPath(args)}/review/retry`)),
  },
  {
    name: 'relaunch_orchestration',
    description:
      "Relaunches an orchestration that is not running as a new one, with corrections: tasks, when given, replace its whole task list, and the settings given replace its own. The original is left as it was. A chat may change the settings only while the person has Claudio's server switched on for it.",
    inputSchema: schema(
      {
        orchestrationId,
        tasks: { type: 'array', description: 'The whole new task list; the old one when left out', items: taskSpec, maxItems: PAGE_MAX },
        name: str('What the new orchestration is called', { minLength: 1, maxLength: 200 }),
        objective: str('What it should achieve', { maxLength: 100_000 }),
        model,
        effort: str('How hard the workers think', { enum: EFFORTS }),
        concurrency: int('How many workers run at once', 1, 16),
        synthesize: bool('Whether a final agent writes a report from the results'),
        worktree: bool('Whether each worker works in its own git worktree'),
        maxAttempts: int('Attempts a failed task gets, the first included', 1, 5),
        limits,
        ...PERSON_PROPERTIES,
      },
      ['orchestrationId'],
    ),
    routes: ['POST /orchestrations/:id/relaunch'],
    run: async (args, api) => {
      const { tasks, ...spec } = graphFields(args);
      return identify(await api.send('POST', `${orchestrationPath(args)}/relaunch`, { ...(Object.keys(spec).length ? { spec } : {}), ...(tasks === undefined ? {} : { tasks }) }));
    },
  },
  {
    name: 'launch_orchestration_template',
    description: "Launches a saved orchestration template, with a new objective, project, name, model or effort for this run only; the template is not changed.",
    inputSchema: schema(
      {
        templateId,
        projectId: str("The project id the work happens in, as list_projects gives it; the template's folder when left out", { minLength: 1, maxLength: 200 }),
        objective: str('What this run should achieve', { maxLength: 100_000 }),
        name: str("What the orchestration is called; the template's name when left out", { minLength: 1, maxLength: 200 }),
        model,
        effort: str('How hard the workers think', { enum: EFFORTS }),
      },
      ['templateId'],
    ),
    routes: ['GET /projects', 'POST /orchestrations/templates/:templateId/launch'],
    run: async (args, api) => {
      const project = text(args, 'projectId');
      const body = { ...only(args, ['objective', 'name', 'model', 'effort']), ...(project ? { cwd: await projectPath(api, project) } : {}) };
      return identify(await api.send('POST', `/orchestrations/templates/${seg(need(args, 'templateId'))}/launch`, body));
    },
  },
  {
    name: 'start_chat',
    description: "Starts a new chat with a first prompt, in a project's folder when one is given, optionally as one of that folder's agents (list_agents gives the names). The chat gets the app's defaults, never more: the agent brings its prompt and can only narrow the tools.",
    inputSchema: schema(
      {
        prompt: prompt('The first message'),
        projectId: str('The project id the chat works in, as list_projects gives it', { minLength: 1, maxLength: 200 }),
        model,
        name: str('A name for the chat; the first prompt is its title otherwise', { minLength: 1, maxLength: 200 }),
        agent: str('The agent the chat starts as, as list_agents gives it for the project: a user agent such as shipcast, a plugin agent such as brand:lead, or one of the project', { minLength: 1, maxLength: 256 }),
      },
      ['prompt'],
    ),
    routes: ['GET /projects', 'POST /chats'],
    run: async (args, api) => {
      const project = text(args, 'projectId');
      const cwd = project ? await projectPath(api, project) : undefined;
      // Only these reach the route: no permission mode, tool list, preset, MCP, account or prompts, so one confirmed call cannot start a chat that is more than the defaults
      const body = { prompt: need(args, 'prompt'), ...(cwd ? { cwd } : {}), ...(text(args, 'model') ? { model: text(args, 'model') } : {}), ...(text(args, 'name') ? { name: text(args, 'name') } : {}), ...(text(args, 'agent') ? { agent: text(args, 'agent') } : {}) };
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
    name: 'message_chat_subagent',
    description: "Writes straight to one subagent of another chat that has a live process, as the person would from the subagent's view: the subagent reads it, the chat's lead does not. The agentId is the subagent's id as the chat lists it. A stopped subagent cannot be written to; a finished one is resumed by the message.",
    inputSchema: schema({ chatId, agentId: str("The subagent's agent id, as the chat's subagents list it", { minLength: 1, maxLength: 200 }), text: str('The message', { minLength: 1, maxLength: 100_000 }) }, ['chatId', 'agentId', 'text']),
    routes: ['POST /chats/:id/subagents/:agentId/messages'],
    run: async (args, api) => {
      notSelf(api, need(args, 'chatId'), 'message the subagents of');
      return identify(await api.send('POST', `/chats/${seg(need(args, 'chatId'))}/subagents/${seg(need(args, 'agentId'))}/messages`, { text: need(args, 'text') }));
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
  {
    name: 'create_schedule',
    description:
      'Creates a schedule: a chat or an orchestration that Claudio starts by itself on a cron expression, enabled unless enabled is false. It keeps spending while nobody watches, so check the expression with preview_schedule first.',
    inputSchema: schema({ name: str('What the schedule is called', { minLength: 1, maxLength: 200 }), cron, timezone, target: scheduleTargetSpec, overlap, enabled: bool('false creates it switched off') }, ['name', 'cron', 'target']),
    routes: ['GET /projects', 'GET /orchestrations/plans/:runId', 'POST /schedules'],
    run: async (args, api) => scheduleResult(await api.send('POST', '/schedules', { ...only(args, SCHEDULE_FIELDS), target: await scheduleTarget(args.target, api) })),
  },
  {
    name: 'update_schedule',
    description: "Changes the fields given of a schedule, its expression, target and overlap policy included; enabled false switches it off. Changing the expression, the zone or switching it on starts its clock afresh.",
    inputSchema: schema(
      { scheduleId, name: str('The new name', { minLength: 1, maxLength: 200 }), cron, timezone, target: scheduleTargetSpec, overlap, enabled: bool('true switches it on, false switches it off') },
      ['scheduleId'],
    ),
    routes: ['GET /projects', 'GET /orchestrations/plans/:runId', 'PATCH /schedules/:id'],
    run: async (args, api) => {
      const body = { ...only(args, SCHEDULE_FIELDS), ...(args.target === undefined ? {} : { target: await scheduleTarget(args.target, api) }) };
      if (Object.keys(body).length === 0) throw new Error('nothing to change: pass at least one field besides scheduleId');
      return scheduleResult(await api.send('PATCH', `/schedules/${seg(need(args, 'scheduleId'))}`, body));
    },
  },
  {
    name: 'run_schedule',
    description: "Runs a schedule's target now, whatever its timetable says and even while it is switched off; the run is recorded and does not move when it fires next. It spends now.",
    inputSchema: schema({ scheduleId }, ['scheduleId']),
    routes: ['POST /schedules/:id/run'],
    run: async (args, api) => scheduleResult(await api.send('POST', `/schedules/${seg(need(args, 'scheduleId'))}/run`)),
  },
  {
    name: 'delete_schedule',
    description: 'Deletes a schedule and its run history; what it already started is not touched. It cannot be undone: switch it off with update_schedule when it may be wanted again.',
    inputSchema: schema({ scheduleId }, ['scheduleId']),
    routes: ['DELETE /schedules/:id'],
    run: async (args, api) => {
      const id = need(args, 'scheduleId');
      await api.send('DELETE', `/schedules/${seg(id)}`);
      return { deleted: true, scheduleId: id };
    },
  },
];

/** The spec a template is saved with: the graph's own fields, the person's and its tasks, in the project given */
async function templateSpec(args: Record<string, unknown>, api: ApiClient, base: Obj = {}): Promise<Obj> {
  const project = text(args, 'projectId');
  const given = graphFields(args);
  return { ...base, ...given, ...(project ? { cwd: await projectPath(api, project) } : {}) };
}

/** The fields of a template a tool may set, besides those that name it */
const TEMPLATE_GRAPH_PROPERTIES: Record<string, Property> = {
  projectId: str('The project id the graph runs in, as list_projects gives it; a launch may give another', { minLength: 1, maxLength: 200 }),
  tasks: { type: 'array', description: 'The tasks of the graph', items: taskSpec, maxItems: PAGE_MAX },
  objective: str('What the graph should achieve', { maxLength: 100_000 }),
  engine: str('graph (the default) or workflow', { enum: ['graph', 'workflow'] }),
  model,
  effort: str('How hard the workers think', { enum: EFFORTS }),
  concurrency: int('How many workers run at once; the default is 3', 1, 16),
  synthesize: bool('Whether a final agent writes a report from the results'),
  worktree: bool('Whether each worker works in its own git worktree'),
  maxAttempts: int('Attempts a failed task gets, the first included', 1, 5),
  limits,
  ...PERSON_PROPERTIES,
};
const TEMPLATE_GRAPH_KEYS = Object.keys(TEMPLATE_GRAPH_PROPERTIES);

/** What names a pull request, and where it stands: never the description it was opened with */
function pullRequestResult(value: unknown): unknown {
  const pr = isRecord(value) && isRecord(value.pullRequest) ? value.pullRequest : value;
  return isRecord(pr) ? only(pr, ['id', 'phase', 'host', 'ref', 'number', 'url', 'error']) : pr;
}

/**
 * The writes on the person's own orchestration routes (`person`, `CLAUDIO_MCP_OWNER_TOOL_NAMES`). The
 * API answers them for a chat only while the person has Claudio's server switched on for it (D12 of
 * docs/plans/claudio-servers.md), and refuses every other chat with 403; each still asks the person
 * first. Every route they call is under `/orchestrations`, which a test holds them to: that prefix is
 * where the widening ends.
 */
export const OWNER_TOOLS: readonly Tool[] = [
  {
    name: 'delete_orchestration',
    description:
      'Deletes an orchestration that is not running, with its worktrees; their branches are kept, and a worktree with uncommitted work refuses the deletion. It cannot be undone.',
    inputSchema: schema({ orchestrationId }, ['orchestrationId']),
    routes: ['DELETE /orchestrations/:id'],
    run: async (args, api) => {
      const id = need(args, 'orchestrationId');
      await api.send('DELETE', `/orchestrations/${seg(id)}`);
      return { deleted: true, orchestrationId: id };
    },
  },
  {
    name: 'integrate_orchestration',
    description: "Merges every completed task's branch into an orchestration's integration branch again, handing conflicts to an integrator agent: after a conflict was resolved by hand, or for a graph that never integrated.",
    inputSchema: schema({ orchestrationId }, ['orchestrationId']),
    routes: ['POST /orchestrations/:id/integrate'],
    run: async (args, api) => identify(await api.send('POST', `${orchestrationPath(args)}/integrate`)),
  },
  {
    name: 'open_orchestration_pull_request',
    description:
      "Pushes an orchestration's integration branch to origin and opens a pull request (GitHub) or merge request (GitLab) for it. It leaves the machine; a review gate that has not passed or been accepted holds it.",
    inputSchema: schema({ orchestrationId }, ['orchestrationId']),
    routes: ['POST /orchestrations/:id/pull-request'],
    run: async (args, api) => pullRequestResult(await api.send('POST', `${orchestrationPath(args)}/pull-request`)),
  },
  {
    name: 'accept_orchestration_review',
    description:
      "Accepts an orchestration's blocked or incomplete review gate with a written reason, bound to the commit the gate stopped on: any new commit voids it.",
    inputSchema: schema({ orchestrationId, reason: str("Why the findings are accepted, in the person's words", { minLength: 1, maxLength: 5000 }) }, ['orchestrationId', 'reason']),
    routes: ['POST /orchestrations/:id/review/accept'],
    run: async (args, api) => identify(await api.send('POST', `${orchestrationPath(args)}/review/accept`, { reason: need(args, 'reason') })),
  },
  {
    name: 'grant_orchestration_spend_pass',
    description: "Lets an orchestration run past today's daily spend cap: its tasks start although the cap was reached, until the server's day ends. It spends.",
    inputSchema: schema({ orchestrationId }, ['orchestrationId']),
    routes: ['POST /orchestrations/:id/spend-pass'],
    run: async (args, api) => identify(await api.send('POST', `${orchestrationPath(args)}/spend-pass`)),
  },
  {
    name: 'send_supervisor_proposal',
    description: "Sends the hint the Supervisor proposed for a running worker of an orchestration to that worker; a task that is no longer running refuses it.",
    inputSchema: schema({ orchestrationId, taskId, proposalId }, ['orchestrationId', 'taskId', 'proposalId']),
    routes: ['POST /orchestrations/:id/tasks/:taskId/supervisor/:proposalId/send'],
    run: async (args, api) => identify(await api.send('POST', `${taskPath(args)}/supervisor/${seg(need(args, 'proposalId'))}/send`)),
  },
  {
    name: 'dismiss_supervisor_proposal',
    description: "Dismisses the hint the Supervisor proposed for a worker of an orchestration; nothing reaches the worker.",
    inputSchema: schema({ orchestrationId, taskId, proposalId }, ['orchestrationId', 'taskId', 'proposalId']),
    routes: ['POST /orchestrations/:id/tasks/:taskId/supervisor/:proposalId/dismiss'],
    run: async (args, api) => identify(await api.send('POST', `${taskPath(args)}/supervisor/${seg(need(args, 'proposalId'))}/dismiss`)),
  },
  {
    name: 'prune_orchestration_worktrees',
    description:
      "Removes an orchestration's worktrees; branches are kept, so committed work survives. A worktree with uncommitted changes is left alone and reported unless force is true, which throws those changes away.",
    inputSchema: schema({ orchestrationId, force: bool('true also removes worktrees with uncommitted changes, losing them') }, ['orchestrationId']),
    routes: ['POST /orchestrations/:id/worktrees/prune'],
    run: async (args, api) => api.send('POST', `${orchestrationPath(args)}/worktrees/prune`, args.force === true ? { force: true } : {}),
  },
  {
    name: 'save_orchestration_workflow',
    description: "Saves an orchestration's graph as a workflow script in its project's .claude/workflows/, where the Workflow tool runs it by name.",
    inputSchema: schema(
      { orchestrationId, name: str("The workflow's file and name; one derived from the graph's when left out", { minLength: 1, maxLength: 100 }), overwrite: bool('true replaces a saved workflow of the same name') },
      ['orchestrationId'],
    ),
    routes: ['POST /orchestrations/:id/workflow/save'],
    run: async (args, api) => {
      const saved = await api.send('POST', `${orchestrationPath(args)}/workflow/save`, only(args, ['name', 'overwrite']));
      return isRecord(saved) ? only(saved, ['name', 'path', 'scope']) : saved;
    },
  },
  {
    name: 'create_orchestration_template',
    description:
      'Saves a graph as an orchestration template, by name: the graph of an orchestration (fromOrchestration), or the tasks and settings given. A template is launched again with launch_orchestration_template.',
    inputSchema: schema(
      {
        name: str('What the template is called', { minLength: 1, maxLength: 200 }),
        description: str('What it is for', { maxLength: 2000 }),
        fromOrchestration: str('The id of an orchestration whose graph is saved, as it was launched', { minLength: 1, maxLength: 200 }),
        ...TEMPLATE_GRAPH_PROPERTIES,
      },
      ['name'],
    ),
    routes: ['GET /projects', 'POST /orchestrations/templates'],
    run: async (args, api) => {
      const named = only(args, ['name', 'description']);
      const from = text(args, 'fromOrchestration');
      if (from) {
        if (TEMPLATE_GRAPH_KEYS.some((key) => args[key] !== undefined)) throw new Error('give fromOrchestration or the graph, not both');
        return identify(await api.send('POST', '/orchestrations/templates', { ...named, fromOrchestration: from }));
      }
      if (!Array.isArray(args.tasks) || !args.tasks.length) throw new Error('a template needs a graph: pass tasks, or fromOrchestration');
      return identify(await api.send('POST', '/orchestrations/templates', { ...named, spec: { name: need(args, 'name'), ...(await templateSpec(args, api)) } }));
    },
  },
  {
    name: 'update_orchestration_template',
    description: 'Changes the fields given of an orchestration template: its name, its description, and its graph, whose settings and tasks given replace the stored ones. Orchestrations already launched from it are not affected.',
    inputSchema: schema(
      { templateId, name: str('The new name', { minLength: 1, maxLength: 200 }), description: str('The new description', { maxLength: 2000 }), ...TEMPLATE_GRAPH_PROPERTIES },
      ['templateId'],
    ),
    routes: ['GET /projects', 'GET /orchestrations/templates/:templateId', 'PATCH /orchestrations/templates/:templateId'],
    run: async (args, api) => {
      const path = `/orchestrations/templates/${seg(need(args, 'templateId'))}`;
      const body: Obj = only(args, ['name', 'description']);
      // The route replaces the spec whole, so what is not given is kept from the stored one
      if (TEMPLATE_GRAPH_KEYS.some((key) => args[key] !== undefined)) {
        const stored = await api.get(path);
        const base = isRecord(stored) && isRecord(stored.spec) ? stored.spec : {};
        body.spec = await templateSpec(args, api, base);
      }
      if (Object.keys(body).length === 0) throw new Error('nothing to change: pass at least one field besides templateId');
      return identify(await api.send('PATCH', path, body));
    },
  },
  {
    name: 'delete_orchestration_template',
    description: 'Deletes an orchestration template; orchestrations launched from it are not affected. It cannot be undone.',
    inputSchema: schema({ templateId }, ['templateId']),
    routes: ['DELETE /orchestrations/templates/:templateId'],
    run: async (args, api) => {
      const id = need(args, 'templateId');
      await api.send('DELETE', `/orchestrations/templates/${seg(id)}`);
      return { deleted: true, templateId: id };
    },
  },
];
