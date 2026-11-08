import type { SchedulePreview } from '@claudio/shared';
import i18n, { type TOptions } from 'i18next';

/*
 * The prompts of the assistant's write tools (`mcp__claudio__<name>`), said in the person's words.
 * The title is what the call would do and the detail is what it carries, built from the input: a
 * tool's wire name, a field name or a status code never reaches the screen.
 */

export interface WritePrompt {
  title: string;
  /** One line per thing the call carries; empty when the title says it all */
  detail: string;
}

const PREFIX = 'mcp__claudio__';
/** What decides what a graph's workers may do: always said, so a wider run is never confirmed unseen */
const PERSON_FIELDS = ['permissionMode', 'permissionPrompts', 'allowedTools', 'guards', 'verification'] as const;
const KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

const str = (input: Record<string, unknown>, key: string): string => {
  const value = input[key];
  return typeof value === 'string' ? value.trim() : '';
};

// The keys are assembled from the tool's name and the input's values, so the typed resource lookup cannot follow them
const t = (key: string, options: TOptions = {}): string => i18n.t(`chat:permissions.writes.${key}` as 'chat:permissions.writes.anItem', options);

/** A word from one of the lists in the locale; a value it does not know is left out rather than shown as the code it is */
function word(list: 'types' | 'statuses' | 'priorities', value: string): string {
  return i18n.exists(`chat:permissions.writes.${list}.${value}`) ? t(`${list}.${value}`) : '';
}

/** A key such as CW-12 is how the person names an item; an id is not, so it becomes "a work item" */
const itemName = (input: Record<string, unknown>): string => {
  const ref = str(input, 'item');
  return KEY.test(ref) ? ref.toUpperCase() : t('anItem');
};

function fields(input: Record<string, unknown>, names: readonly string[]): string[] {
  const lines: string[] = [];
  for (const name of names) {
    const value = input[name];
    if (name === 'description' || name === 'body' || name === 'prompt' || name === 'text' || name === 'objective' || name === 'reason') {
      if (typeof value === 'string' && value.trim()) lines.push(value.trim());
    } else if (name === 'title' || name === 'model' || name === 'name') {
      if (typeof value === 'string' && value.trim()) lines.push(t(`fields.${name}`, { value: value.trim() }));
    } else if (name === 'status' || name === 'priority' || name === 'type') {
      const shown = typeof value === 'string' ? word(name === 'status' ? 'statuses' : name === 'priority' ? 'priorities' : 'types', value) : '';
      if (shown) lines.push(t(`fields.${name}`, { value: shown }));
    } else if (name === 'labels') {
      if (Array.isArray(value) && value.length) lines.push(t('fields.labels', { value: value.filter((l) => typeof l === 'string').join(', ') }));
    } else if (name === 'tasks') {
      if (Array.isArray(value)) {
        const names = value.map((task) => (task && typeof task === 'object' && 'name' in task && typeof task.name === 'string' ? task.name : '')).filter(Boolean);
        if (names.length) lines.push(t('fields.tasks', { value: names.join(' · ') }));
      }
    } else if (name === 'cron' || name === 'timezone') {
      if (typeof value === 'string' && value.trim()) lines.push(t(`fields.${name}`, { value: value.trim() }));
    } else if (name === 'overlap') {
      if (typeof value === 'string' && i18n.exists(`chat:permissions.writes.overlaps.${value}`)) lines.push(t('fields.overlap', { value: t(`overlaps.${value}`) }));
    } else if (name === 'enabled') {
      if (typeof value === 'boolean') lines.push(t(value ? 'fields.enabledOn' : 'fields.enabledOff'));
    } else if (name === 'target') {
      // What each fire starts: its kind, then what it is told to do, as the tools that start the same would say it
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const target = value as Record<string, unknown>;
        if (target.kind === 'chat' || target.kind === 'orchestration') lines.push(t(target.kind === 'chat' ? 'fields.targetChat' : 'fields.targetOrchestration'));
        lines.push(...fields(target, ['prompt', 'objective', 'tasks', 'model']));
      }
    } else if (name === 'permissionMode') {
      // The mode is the CLI's own word (bypassPermissions…): the person must see exactly what the workers will run with
      if (typeof value === 'string' && value.trim()) lines.push(t('fields.permissionMode', { value: value.trim() }));
    } else if (name === 'permissionPrompts') {
      if (value === 'host' || value === 'none') lines.push(t(value === 'host' ? 'fields.permissionPromptsHost' : 'fields.permissionPromptsNone'));
    } else if (name === 'allowedTools') {
      if (Array.isArray(value) && value.length) lines.push(t('fields.allowedTools', { value: value.filter((v) => typeof v === 'string').join(', ') }));
    } else if (name === 'guards') {
      // Only what weakens them is said: a guard switched off, or a rule of it
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const guards = value as { enabled?: unknown; rules?: unknown };
        if (guards.enabled === false) lines.push(t('fields.guardsOff'));
        const rules = guards.rules && typeof guards.rules === 'object' ? Object.entries(guards.rules as Record<string, unknown>).filter(([, on]) => on === false).map(([rule]) => rule) : [];
        if (rules.length) lines.push(t('fields.guardsRulesOff', { value: rules.join(', ') }));
      }
    } else if (name === 'verification') {
      const commands = value && typeof value === 'object' && 'commands' in value && Array.isArray(value.commands) ? value.commands.filter((c): c is string => typeof c === 'string') : [];
      if (commands.length) lines.push(t('fields.verification', { value: commands.join(' · ') }));
    } else if (name === 'acceptanceCriteria') {
      if (Array.isArray(value)) {
        const texts = value.map((c) => (c && typeof c === 'object' && 'text' in c && typeof c.text === 'string' ? c.text : '')).filter(Boolean);
        if (texts.length) lines.push(t('fields.criteria', { value: texts.join(' · ') }));
      }
    }
  }
  return lines;
}

/** Null for any tool this does not know, so its prompt stays what it was */
export function describeWrite(toolName: string, input: Record<string, unknown>): WritePrompt | null {
  if (!toolName.startsWith(PREFIX)) return null;
  const done = (title: string, lines: string[] = []): WritePrompt => ({ title, detail: lines.join('\n') });
  switch (toolName.slice(PREFIX.length)) {
    case 'create_work_item':
      // The type defaults to a task, as the tool does
      return done(t('createWorkItem', { type: word('types', str(input, 'type') || 'task') || word('types', 'task'), title: str(input, 'title') }), fields(input, ['description', 'status', 'priority', 'labels', 'acceptanceCriteria']));
    case 'update_work_item':
      return done(t('updateWorkItem', { item: itemName(input) }), fields(input, ['title', 'type', 'priority', 'labels', 'description', 'acceptanceCriteria']));
    case 'move_work_item':
      return done(t('moveWorkItem', { item: itemName(input), status: word('statuses', str(input, 'status')) }));
    case 'comment_work_item':
      return done(t('commentWorkItem', { item: itemName(input) }), fields(input, ['body']));
    case 'retry_flow_run':
      return done(t('retryFlowRun'));
    case 'retry_orchestration_task':
      return done(t('retryOrchestrationTask'));
    case 'start_chat':
      return done(t('startChat'), fields(input, ['prompt', 'model']));
    case 'check_criterion':
      return done(t(input.checked === false ? 'uncheckCriterion' : 'checkCriterion', { item: itemName(input) }));
    case 'plan_orchestration':
      return done(t('planOrchestration'), fields(input, ['objective', 'model']));
    case 'launch_orchestration': {
      const name = str(input, 'name');
      return done(name ? t('launchOrchestration', { name }) : t('launchPlannedOrchestration'), fields(input, ['objective', 'tasks', 'model', ...PERSON_FIELDS]));
    }
    case 'retry_orchestration_task_clean':
      return done(t('retryOrchestrationTaskClean'));
    case 'rerun_orchestration_task':
      return done(t('rerunOrchestrationTask'));
    case 'skip_orchestration_task':
      return done(t('skipOrchestrationTask'));
    case 'message_orchestration_task':
      return done(t('messageOrchestrationTask'), fields(input, ['text']));
    case 'verify_orchestration':
      return done(t('verifyOrchestration'), fields(input, ['verification']));
    case 'retry_orchestration_review':
      return done(t('retryOrchestrationReview'));
    case 'relaunch_orchestration':
      return done(t('relaunchOrchestration'), fields(input, ['name', 'objective', 'tasks', 'model', ...PERSON_FIELDS]));
    case 'launch_orchestration_template':
      return done(t('launchOrchestrationTemplate'), fields(input, ['name', 'objective', 'model']));
    case 'delete_orchestration':
      return done(t('deleteOrchestration'));
    case 'integrate_orchestration':
      return done(t('integrateOrchestration'));
    case 'open_orchestration_pull_request':
      return done(t('openOrchestrationPullRequest'));
    case 'accept_orchestration_review':
      return done(t('acceptOrchestrationReview'), fields(input, ['reason']));
    case 'grant_orchestration_spend_pass':
      return done(t('grantOrchestrationSpendPass'));
    case 'send_supervisor_proposal':
      return done(t('sendSupervisorProposal'));
    case 'dismiss_supervisor_proposal':
      return done(t('dismissSupervisorProposal'));
    case 'prune_orchestration_worktrees':
      return done(t(input.force === true ? 'pruneOrchestrationWorktreesForce' : 'pruneOrchestrationWorktrees'));
    case 'save_orchestration_workflow':
      return done(t('saveOrchestrationWorkflow'), fields(input, ['name']));
    case 'create_orchestration_template':
      return done(t('createOrchestrationTemplate', { name: str(input, 'name') }), fields(input, ['description', 'objective', 'tasks', 'model', ...PERSON_FIELDS]));
    case 'update_orchestration_template':
      return done(t('updateOrchestrationTemplate'), fields(input, ['name', 'description', 'objective', 'tasks', 'model', ...PERSON_FIELDS]));
    case 'delete_orchestration_template':
      return done(t('deleteOrchestrationTemplate'));
    case 'stop_orchestration':
      return done(t('stopOrchestration'));
    case 'resume_orchestration':
      return done(t('resumeOrchestration'));
    case 'send_chat_message':
      return done(t('sendChatMessage'), fields(input, ['text']));
    case 'hint_chat':
      return done(t('hintChat'), fields(input, ['text']));
    case 'interrupt_chat':
      return done(t('interruptChat'));
    case 'stop_chat':
      return done(t('stopChat'));
    case 'resume_chat':
      return done(t('resumeChat'), fields(input, ['prompt']));
    case 'fork_chat':
      return done(t('forkChat'), fields(input, ['prompt']));
    case 'accept_assistant_proposal':
      return done(t('acceptProposal'));
    case 'discard_assistant_proposal':
      return done(t('discardProposal'));
    case 'create_schedule':
      return done(t('createSchedule', { name: str(input, 'name') }), fields(input, ['cron', 'timezone', 'target', 'overlap', 'enabled']));
    case 'update_schedule':
      return done(t('updateSchedule'), fields(input, ['name', 'cron', 'timezone', 'target', 'overlap', 'enabled']));
    case 'run_schedule':
      return done(t('runSchedule'));
    case 'delete_schedule':
      return done(t('deleteSchedule'));
    default:
      return null;
  }
}

/**
 * The expression a schedule write asks for, which the prompt checks against the server before the
 * person answers: what it means in words and when it fires next. Null for any other tool, and for
 * an update that leaves the expression as it is.
 */
export function scheduleToCheck(toolName: string, input: Record<string, unknown>): { cron: string; timezone: string | undefined } | null {
  if (toolName !== `${PREFIX}create_schedule` && toolName !== `${PREFIX}update_schedule`) return null;
  const cron = str(input, 'cron');
  return cron ? { cron, timezone: str(input, 'timezone') || undefined } : null;
}

/**
 * The lines the server's preview adds to such a prompt: the expression in words, its next fires, or
 * what is wrong with it. They are said beside the prompt's input block, never in it: that block is
 * monospace and holds literals, and a sentence and a time are not.
 *
 * The fires are told on the clock of the zone the expression is read in, the one the prompt's input
 * block names: in the browser's own, `0 3 * * *` in Europe/Madrid would read as 21:00 the evening
 * before on a device in New York, next to "In words: At 03:00". When that zone is not the browser's,
 * the line names it, so nobody takes those hours for their own.
 */
export function previewLines(preview: SchedulePreview, formatTime: (iso: string, timeZone: string) => string, localZone: string): string[] {
  if (!preview.valid) return [t('preview.invalid', { value: preview.error ?? '' })];
  const lines: string[] = [];
  if (preview.description) lines.push(t('preview.words', { value: preview.description }));
  if (preview.next.length) {
    const value = preview.next.map((at) => formatTime(at, preview.timezone)).join(' · ');
    lines.push(preview.timezone === localZone ? t('preview.next', { value }) : t('preview.nextIn', { value, zone: preview.timezone }));
  }
  return lines;
}

/** What the prompt says while the preview is being read */
export const previewLoading = (): string => t('preview.loading');
