import {
  EVAL_LIMITS,
  EVAL_NAME_PATTERN,
  EFFORT_LEVELS,
  type Effort,
  type EvalCallMatcher,
  type EvalCase,
  type EvalDefinition,
  type EvalExpectation,
  type EvalExpectationKind,
  type EvalFileListItem,
  type EvalRunSummary,
  type EvalStringMatcher,
  type EvalTargetKind,
  type FlowStage,
  type ResourceKind,
  type ToolPolicy,
} from '@claudio/shared';

/**
 * The editor's two faces of one eval file: a form of strings (what a field holds while it is being
 * typed) and the JSON the file keeps. `definitionFromForm(formFromDefinition(d))` is `d` with its
 * empty and null values left out, and a form made from that is the form it came from.
 */

export type MatcherMode = 'glob' | 'equals' | 'contains' | 'regex';

export interface MatcherForm {
  mode: MatcherMode;
  value: string;
  /** Regex flags; only read in `regex` mode */
  flags: string;
}

export interface CallForm {
  /** Name globs, comma separated: `Edit, MultiEdit` is the list `['Edit', 'MultiEdit']` */
  tool: string;
  command: MatcherForm;
  path: MatcherForm;
  outcome: '' | 'ok' | 'error' | 'denied' | 'any';
  scope: '' | 'main' | 'sub' | 'any';
  /** Matchers on the call's input fields: kept as the file has them, edited in the JSON view */
  input: Record<string, EvalStringMatcher> | null;
}

export interface ExpectForm {
  kind: EvalExpectationKind;
  call: CallForm;
  anchor: CallForm;
  calls: CallForm[];
  min: string;
  max: string;
  ifAnchor: boolean;
  strict: boolean;
  match: MatcherForm;
  file: string;
  exists: '' | 'true' | 'false';
  contains: MatcherForm;
  touchedPath: MatcherForm;
  touched: boolean;
  run: string;
  exitCode: string;
  timeoutSeconds: string;
}

export interface CaseForm {
  id: string;
  title: string;
  prompt: string;
  pin: string;
  expect: ExpectForm[];
}

export interface EvalForm {
  title: string;
  targetKind: EvalTargetKind;
  targetScope: 'project' | 'user';
  targetName: string;
  runAsAgent: string;
  runAsStage: '' | FlowStage;
  runAsModel: string;
  runAsEffort: '' | Effort;
  pin: string;
  samples: string;
  maxCostUsdPerSample: string;
  timeoutMinutes: string;
  maxCostUsd: string;
  setup: string;
  /** Kept as the file has it: the tool policy is edited in the JSON view */
  policy: ToolPolicy | null;
  cases: CaseForm[];
}

/** The tools the call matcher's field suggests; any other name or glob can be typed. */
export const KNOWN_TOOLS = ['Read', 'Edit', 'MultiEdit', 'Write', 'Bash', 'Glob', 'Grep', 'Task', 'Skill', 'WebFetch', 'WebSearch', 'NotebookEdit', 'TodoWrite', 'mcp__*'] as const;

export const EXPECTATION_KIND_LIST: readonly EvalExpectationKind[] = ['called', 'not-called', 'before', 'after', 'sequence', 'text', 'file', 'touched', 'command'];

// ---------- matchers ----------

export const emptyMatcher = (): MatcherForm => ({ mode: 'glob', value: '', flags: '' });

export function matcherForm(matcher: EvalStringMatcher | undefined): MatcherForm {
  if (matcher === undefined) return emptyMatcher();
  if (typeof matcher === 'string') return { mode: 'glob', value: matcher, flags: '' };
  if ('equals' in matcher) return { mode: 'equals', value: matcher.equals, flags: '' };
  if ('contains' in matcher) return { mode: 'contains', value: matcher.contains, flags: '' };
  return { mode: 'regex', value: matcher.regex, flags: matcher.flags ?? '' };
}

/** An empty value is no matcher at all. */
export function matcherOf(form: MatcherForm): EvalStringMatcher | undefined {
  if (form.value === '') return undefined;
  switch (form.mode) {
    case 'glob':
      return form.value;
    case 'equals':
      return { equals: form.value };
    case 'contains':
      return { contains: form.value };
    case 'regex':
      return form.flags ? { regex: form.value, flags: form.flags } : { regex: form.value };
  }
}

// ---------- calls and expectations ----------

export function callForm(call: EvalCallMatcher | undefined): CallForm {
  return {
    tool: call?.tool === undefined ? '' : Array.isArray(call.tool) ? call.tool.join(', ') : call.tool,
    command: matcherForm(call?.command),
    path: matcherForm(call?.path),
    outcome: call?.outcome ?? '',
    scope: call?.scope ?? '',
    input: call?.input ?? null,
  };
}

export function toolsOf(text: string): string | string[] | undefined {
  const names = text.split(',').map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) return undefined;
  return names.length === 1 ? (names[0] as string) : names;
}

export function callOf(form: CallForm): EvalCallMatcher {
  const call: EvalCallMatcher = {};
  const tool = toolsOf(form.tool);
  if (tool !== undefined) call.tool = tool;
  const command = matcherOf(form.command);
  if (command !== undefined) call.command = command;
  const path = matcherOf(form.path);
  if (path !== undefined) call.path = path;
  if (form.input && Object.keys(form.input).length > 0) call.input = form.input;
  if (form.outcome) call.outcome = form.outcome;
  if (form.scope) call.scope = form.scope;
  return call;
}

export function blankExpect(kind: EvalExpectationKind = 'called'): ExpectForm {
  return {
    kind,
    call: callForm(undefined),
    anchor: callForm(undefined),
    calls: [callForm(undefined), callForm(undefined)],
    min: '',
    max: '',
    ifAnchor: false,
    strict: false,
    match: emptyMatcher(),
    file: '',
    exists: '',
    contains: emptyMatcher(),
    touchedPath: emptyMatcher(),
    touched: false,
    run: '',
    exitCode: '',
    timeoutSeconds: '',
  };
}

export function expectForm(e: EvalExpectation): ExpectForm {
  const form = blankExpect(e.kind);
  switch (e.kind) {
    case 'called':
      form.call = callForm(e.call);
      form.min = e.min === undefined ? '' : String(e.min);
      form.max = e.max === undefined ? '' : String(e.max);
      break;
    case 'not-called':
      form.call = callForm(e.call);
      break;
    case 'before':
    case 'after':
      form.call = callForm(e.call);
      form.anchor = callForm(e.anchor);
      form.ifAnchor = e.ifAnchor === true;
      break;
    case 'sequence':
      form.calls = e.calls.map(callForm);
      form.strict = e.strict === true;
      break;
    case 'text':
      form.match = matcherForm(e.match);
      break;
    case 'file':
      form.file = e.path;
      form.exists = e.exists === undefined ? '' : e.exists ? 'true' : 'false';
      form.contains = matcherForm(e.contains);
      break;
    case 'touched':
      form.touchedPath = matcherForm(e.path);
      form.touched = e.expect;
      break;
    case 'command':
      form.run = e.run;
      form.exitCode = e.exitCode === undefined ? '' : String(e.exitCode);
      form.timeoutSeconds = e.timeoutSeconds === undefined ? '' : String(e.timeoutSeconds);
      break;
  }
  return form;
}

/** A number as typed; an empty or unreadable field is left out and the server says what it thinks. */
const numberOf = (text: string): number | undefined => {
  if (text.trim() === '') return undefined;
  const n = Number(text.replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
};

export function expectationOf(form: ExpectForm): EvalExpectation {
  switch (form.kind) {
    case 'called': {
      const min = numberOf(form.min);
      const max = numberOf(form.max);
      return { kind: 'called', call: callOf(form.call), ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
    }
    case 'not-called':
      return { kind: 'not-called', call: callOf(form.call) };
    case 'before':
    case 'after':
      return { kind: form.kind, call: callOf(form.call), anchor: callOf(form.anchor), ...(form.ifAnchor ? { ifAnchor: true } : {}) };
    case 'sequence':
      return { kind: 'sequence', calls: form.calls.map(callOf), ...(form.strict ? { strict: true } : {}) };
    case 'text':
      return { kind: 'text', match: matcherOf(form.match) ?? '' };
    case 'file': {
      const contains = matcherOf(form.contains);
      return {
        kind: 'file',
        path: form.file,
        ...(form.exists ? { exists: form.exists === 'true' } : {}),
        ...(contains !== undefined ? { contains } : {}),
      };
    }
    case 'touched':
      return { kind: 'touched', path: matcherOf(form.touchedPath) ?? '', expect: form.touched };
    case 'command': {
      const exitCode = numberOf(form.exitCode);
      const timeoutSeconds = numberOf(form.timeoutSeconds);
      return { kind: 'command', run: form.run, ...(exitCode !== undefined ? { exitCode } : {}), ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}) };
    }
  }
}

// ---------- the file ----------

export function caseForm(c: EvalCase): CaseForm {
  return { id: c.id, title: c.title ?? '', prompt: c.prompt, pin: c.pin ?? '', expect: c.expect.map(expectForm) };
}

export function caseOf(form: CaseForm): EvalCase {
  return {
    id: form.id,
    ...(form.title ? { title: form.title } : {}),
    prompt: form.prompt,
    ...(form.pin ? { pin: form.pin } : {}),
    expect: form.expect.map(expectationOf),
  };
}

export function formFromDefinition(def: EvalDefinition): EvalForm {
  const text = (n: number | undefined) => (n === undefined ? '' : String(n));
  return {
    title: def.title,
    targetKind: def.target.kind,
    targetScope: def.target.scope,
    targetName: def.target.name,
    runAsAgent: def.runAs?.agent ?? '',
    runAsStage: def.runAs?.stage ?? '',
    runAsModel: def.runAs?.model ?? '',
    runAsEffort: def.runAs?.effort ?? '',
    pin: def.pin,
    samples: text(def.samples),
    maxCostUsdPerSample: text(def.limits?.maxCostUsdPerSample),
    timeoutMinutes: text(def.limits?.timeoutMinutes),
    maxCostUsd: text(def.limits?.maxCostUsd),
    setup: def.setup ?? '',
    policy: def.policy ?? null,
    cases: def.cases.map(caseForm),
  };
}

export function definitionFromForm(form: EvalForm): EvalDefinition {
  const runAs = {
    ...(form.runAsAgent ? { agent: form.runAsAgent } : {}),
    ...(form.runAsStage ? { stage: form.runAsStage } : {}),
    ...(form.runAsModel ? { model: form.runAsModel } : {}),
    ...(form.runAsEffort ? { effort: form.runAsEffort } : {}),
  };
  const per = numberOf(form.maxCostUsdPerSample);
  const timeout = numberOf(form.timeoutMinutes);
  const total = numberOf(form.maxCostUsd);
  const limits = {
    ...(per !== undefined ? { maxCostUsdPerSample: per } : {}),
    ...(timeout !== undefined ? { timeoutMinutes: timeout } : {}),
    ...(total !== undefined ? { maxCostUsd: total } : {}),
  };
  const samples = numberOf(form.samples);
  return {
    version: 1,
    title: form.title,
    target: { kind: form.targetKind, scope: form.targetScope, name: form.targetName },
    ...(Object.keys(runAs).length > 0 ? { runAs } : {}),
    pin: form.pin,
    ...(samples !== undefined ? { samples } : {}),
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
    ...(form.policy ? { policy: form.policy } : {}),
    ...(form.setup.trim() ? { setup: form.setup } : {}),
    cases: form.cases.map(caseOf),
  };
}

/** What "New eval" opens: the first case of a file that runs, with a pin when the checkout has a commit. */
export function blankDefinition(pin: string): EvalDefinition {
  return {
    version: 1,
    title: '',
    target: { kind: 'instructions', scope: 'project', name: 'CLAUDE.md' },
    pin,
    samples: EVAL_LIMITS.samples.default,
    cases: [{ id: 'case-1', prompt: '', expect: [{ kind: 'called', call: { tool: 'Bash' } }] }],
  };
}

export function blankCase(existing: readonly string[]): EvalCase {
  let n = existing.length + 1;
  while (existing.includes(`case-${n}`)) n += 1;
  return { id: `case-${n}`, prompt: '', expect: [{ kind: 'called', call: { tool: 'Bash' } }] };
}

/** The pretty JSON the file keeps. */
export const jsonOf = (def: EvalDefinition): string => `${JSON.stringify(def, null, 2)}\n`;

/** The JSON view's text as a definition, or why it is not one; what the server thinks of it is the 400's. */
export function definitionFromJson(text: string): { ok: true; definition: EvalDefinition } | { ok: false; error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const o = value as Partial<EvalDefinition> | null;
  const shaped =
    typeof o === 'object' && o !== null && typeof o.title === 'string' && typeof o.target === 'object' && o.target !== null && typeof o.pin === 'string' && Array.isArray(o.cases) &&
    o.cases.every((c) => typeof c === 'object' && c !== null && typeof c.prompt === 'string' && Array.isArray(c.expect));
  return shaped ? { ok: true, definition: value as EvalDefinition } : { ok: false, error: 'not an eval definition' };
}

// ---------- names, problems, pins ----------

/** The file name a title suggests: lower case words joined by hyphens, within the name's pattern. */
export function nameFromTitle(title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return slug;
}

export const validName = (name: string): boolean => EVAL_NAME_PATTERN.test(name);

/** The reasons a refused write gave for `path` itself or anything inside it (`cases[0]` holds `cases[0].prompt`). */
export function problemsAt(problems: readonly string[], path: string): string[] {
  return problems
    .filter((problem) => {
      const at = problem.split(': ', 1)[0] ?? '';
      return at === path || at.startsWith(`${path}.`) || at.startsWith(`${path}[`);
    })
    .map((problem) => problem.slice(problem.indexOf(': ') + 2));
}

export const shortSha = (sha: string): string => sha.slice(0, 7);

/** Whether the form's definition is the file's as saved. */
export const sameDefinition = (a: EvalDefinition, b: EvalDefinition): boolean => JSON.stringify(a) === JSON.stringify(b);

export const EFFORTS: readonly Effort[] = EFFORT_LEVELS;

/** The resource kind a target kind's names come from; `instructions` has two fixed names. */
export function resourceKindOf(kind: EvalTargetKind): ResourceKind | null {
  switch (kind) {
    case 'agent':
      return 'agents';
    case 'skill':
      return 'skills';
    case 'rule':
      return 'rules';
    case 'instructions':
      return null;
  }
}

export const INSTRUCTION_NAMES = ['CLAUDE.md', 'CLAUDE.local.md'] as const;

// ---------- the list ----------

export type RunWord = 'passed' | 'failed' | 'capped' | 'interrupted' | 'running' | 'waiting' | 'cancelled';

/** The one word a run is listed under. */
export function runWord(run: EvalRunSummary): RunWord {
  if (run.state === 'waiting') return 'waiting';
  if (run.state !== 'ended') return 'running';
  switch (run.outcome) {
    case 'capped':
      return 'capped';
    case 'interrupted':
      return 'interrupted';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'failed';
    default:
      return (run.counts.failed ?? 0) > 0 ? 'failed' : 'passed';
  }
}

export const RUN_TONE: Record<RunWord, 'ok' | 'bad' | 'warn' | 'muted'> = {
  passed: 'ok',
  failed: 'bad',
  capped: 'warn',
  interrupted: 'warn',
  running: 'muted',
  waiting: 'warn',
  cancelled: 'muted',
};

/** "n/m cases" of the variant a person most likely cares about: `current`, then `proposed`, then `pinned`. */
export function casesScored(run: EvalRunSummary): { passed: number; of: number } | null {
  for (const variant of ['current', 'proposed', 'pinned'] as const) {
    const scored = run.scored[variant];
    if (scored) return scored;
  }
  return null;
}

export type ListRow =
  | { kind: 'invalid'; item: EvalFileListItem }
  | { kind: 'eval'; item: EvalFileListItem; cases: number; target: string };

/** A file that did not parse is listed as invalid, with its problems; the rest as evals. */
export function listRows(files: readonly EvalFileListItem[]): ListRow[] {
  return files.map((item): ListRow => {
    const def = item.definition;
    if (!def || item.problems.length > 0) return { kind: 'invalid', item };
    return { kind: 'eval', item, cases: def.cases.length, target: targetPath(def.target) };
  });
}

/** The file under test as a person reads it: from the target, never from the eval file. */
export function targetPath(target: EvalDefinition['target']): string {
  const root = target.scope === 'user' ? '~/.claude' : '.claude';
  switch (target.kind) {
    case 'agent':
      return `${root}/agents/${target.name}.md`;
    case 'skill':
      return `${root}/skills/${target.name}/SKILL.md`;
    case 'rule':
      return `${root}/rules/${target.name}.md`;
    case 'instructions':
      return target.scope === 'user' ? `~/.claude/${target.name}` : target.name;
  }
}
