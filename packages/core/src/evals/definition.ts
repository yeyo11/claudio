import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { EFFORT_LEVELS, EVAL_CALL_SCOPES, EVAL_CASE_ID_PATTERN, EVAL_DIR, EVAL_FILE_VERSIONS, EVAL_KINDS, EVAL_LIMITS, EVAL_NAME_PATTERN, EVAL_OUTCOMES, EVAL_PIN_PATTERN, EVAL_PRESSURES, EVAL_REGEX_FLAGS, EVAL_SCOPES, EVAL_STAGES, EXPECTATION_KINDS, EXPECTATION_KINDS_V2, isRecord, type EvalDefinition, type EvalFile, type EvalTarget } from '@claudio/shared';
import { writeAtomic } from '../config/files.ts';
import { resourcePath } from '../config/resources.ts';
import { instructionsPath, projectScope, userScope, type ConfigScope } from '../config/scope.ts';
import type { CoreConfig } from '../paths.ts';

/*
 * The eval files of a project: `<project>/.claude/claudio-evals/<name>.json`, one per eval, so they
 * can be committed. The parser is hand-written, as the rest of the codebase is, and collects every
 * problem with the path of its field (`cases[0].expect[2].anchor.tool`) instead of stopping at the
 * first: the editor shows them all, and a list shows a bad file as `invalid` without hiding the rest.
 */

export type EvalFileErrorCode =
  | 'invalid-name'
  | 'too-large'
  | 'invalid'
  | 'unsupported-version'
  | 'changed-on-disk'
  | 'not-found';

export class EvalFileError extends Error {
  constructor(
    readonly code: EvalFileErrorCode,
    message: string,
    /** One entry per problem, each starting with the path of the field */
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = 'EvalFileError';
  }
}

type Json = Record<string, unknown>;

/** Collects problems as `path: reason`; a validator keeps going so one pass lists them all. */
class Problems {
  readonly list: string[] = [];
  /** Whether the file is version 2: only then are prompts, mustHold, k and judged expectations allowed */
  v2 = false;
  add(path: string, reason: string): void {
    this.list.push(`${path}: ${reason}`);
  }
}

const at = (path: string, key: string): string => (path ? `${path}.${key}` : key);

function object(p: Problems, value: unknown, path: string, keys: readonly string[]): Json | null {
  if (!isRecord(value)) {
    p.add(path, 'must be an object');
    return null;
  }
  for (const key of Object.keys(value)) if (!keys.includes(key)) p.add(at(path, key), 'unknown key');
  return value;
}

function text(p: Problems, value: unknown, path: string, min: number, max: number): string | null {
  if (typeof value !== 'string') {
    p.add(path, 'must be a string');
    return null;
  }
  if (value.length < min || value.length > max) {
    p.add(path, max === min ? `must be ${min} characters` : `must be ${min}-${max} characters`);
    return null;
  }
  return value;
}

function integer(p: Problems, value: unknown, path: string, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    p.add(path, `must be an integer from ${min} to ${max}`);
    return null;
  }
  return value;
}

function number(p: Problems, value: unknown, path: string, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    p.add(path, `must be a number from ${min} to ${max}`);
    return null;
  }
  return value;
}

function oneOf<T extends string>(p: Problems, value: unknown, path: string, allowed: readonly T[]): T | null {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    p.add(path, `must be one of ${allowed.join(', ')}`);
    return null;
  }
  return value as T;
}

function boolean(p: Problems, value: unknown, path: string): void {
  if (typeof value !== 'boolean') p.add(path, 'must be true or false');
}

function pin(p: Problems, value: unknown, path: string): void {
  if (typeof value !== 'string' || !EVAL_PIN_PATTERN.test(value)) p.add(path, 'must be a full 40-character commit SHA (a branch name moves)');
}

/** A resource name goes into a path: the resolver's own pattern, and never a bare `.` or `..`. */
const RESOURCE_NAME = /^[\w.-]{1,64}$/;

function target(p: Problems, value: unknown): EvalTarget | null {
  const o = object(p, value, 'target', ['kind', 'scope', 'name']);
  if (!o) return null;
  const kind = oneOf(p, o.kind, 'target.kind', EVAL_KINDS);
  const scope = oneOf(p, o.scope, 'target.scope', EVAL_SCOPES);
  if (typeof o.name !== 'string' || !o.name) {
    p.add('target.name', 'must be a non-empty string');
    return null;
  }
  if (kind === 'instructions') {
    if (o.name !== 'CLAUDE.md' && o.name !== 'CLAUDE.local.md') p.add('target.name', 'must be CLAUDE.md or CLAUDE.local.md');
    else if (scope === 'user' && o.name === 'CLAUDE.local.md') p.add('target.name', 'CLAUDE.local.md only exists in project scope');
  } else if (kind && (!RESOURCE_NAME.test(o.name) || /^\.+$/.test(o.name))) {
    p.add('target.name', 'must be a resource name (letters, digits, _ . - only, up to 64)');
  }
  return kind && scope ? { kind, scope, name: o.name } : null;
}

function policy(p: Problems, value: unknown, path: string): void {
  const o = object(p, value, path, ['read', 'edit', 'commands', 'network', 'delegate', 'workflow', 'gitPush', 'exclusive']);
  if (!o) return;
  const read = object(p, o.read, at(path, 'read'), ['allow', 'denyPaths']);
  if (read) {
    boolean(p, read.allow, at(path, 'read.allow'));
    if (read.denyPaths !== undefined) strings(p, read.denyPaths, at(path, 'read.denyPaths'));
  }
  const edit = object(p, o.edit, at(path, 'edit'), ['allow', 'deny']);
  if (edit) {
    if (edit.allow !== 'none' && edit.allow !== 'any') strings(p, edit.allow, at(path, 'edit.allow'), "'none', 'any' or a list of paths");
    if (edit.deny !== undefined) boolean(p, edit.deny, at(path, 'edit.deny'));
  }
  const commands = object(p, o.commands, at(path, 'commands'), ['allow', 'deny']);
  if (commands) {
    if (commands.allow !== 'none' && commands.allow !== 'any') commandRules(p, commands.allow, at(path, 'commands.allow'));
    if (commands.deny !== undefined && commands.deny !== 'all') commandRules(p, commands.deny, at(path, 'commands.deny'));
  }
  oneOf(p, o.network, at(path, 'network'), ['allow', 'omit', 'deny']);
  oneOf(p, o.gitPush, at(path, 'gitPush'), ['deny', 'omit']);
  if (o.delegate !== undefined && o.delegate !== 'deny') p.add(at(path, 'delegate'), "must be 'deny'");
  if (o.workflow !== undefined && o.workflow !== 'allow') p.add(at(path, 'workflow'), "must be 'allow'");
  if (o.exclusive !== undefined) boolean(p, o.exclusive, at(path, 'exclusive'));
}

function strings(p: Problems, value: unknown, path: string, what = 'a list of strings'): void {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v)) p.add(path, `must be ${what}`);
}

function commandRules(p: Problems, value: unknown, path: string): void {
  if (!Array.isArray(value)) {
    p.add(path, "must be a list of command rules (or 'none' / 'any' / 'all' where allowed)");
    return;
  }
  value.forEach((rule, i) => {
    const at_ = `${path}[${i}]`;
    if (!isRecord(rule)) return p.add(at_, 'must be an object');
    if ('pattern' in rule) {
      object(p, rule, at_, ['pattern']);
      text(p, rule.pattern, at(at_, 'pattern'), 1, 1000);
    } else {
      object(p, rule, at_, ['command', 'args']);
      text(p, rule.command, at(at_, 'command'), 1, 200);
      oneOf(p, rule.args, at(at_, 'args'), ['none', 'some', 'prefix']);
    }
  });
}

function matcher(p: Problems, value: unknown, path: string): void {
  if (typeof value === 'string') {
    if (!value) p.add(path, 'must not be empty');
    return;
  }
  if (!isRecord(value)) return p.add(path, 'must be a glob string or an object (equals, contains, regex)');
  const keys = Object.keys(value);
  const form = keys.find((k) => k === 'equals' || k === 'contains' || k === 'regex');
  if (!form) return p.add(path, 'must have one of equals, contains, regex');
  if (form === 'regex') {
    object(p, value, path, ['regex', 'flags']);
    const source = text(p, value.regex, at(path, 'regex'), 1, EVAL_LIMITS.regexSourceChars);
    let flags = '';
    if (value.flags !== undefined) {
      if (typeof value.flags !== 'string' || [...value.flags].some((f, i, all) => !EVAL_REGEX_FLAGS.includes(f) || all.indexOf(f) !== i)) {
        p.add(at(path, 'flags'), `must be some of ${[...EVAL_REGEX_FLAGS].join(', ')}, each once`);
      } else flags = value.flags;
    }
    if (source !== null) {
      try {
        new RegExp(source, flags);
      } catch {
        p.add(at(path, 'regex'), 'is not a valid regular expression');
      }
    }
  } else {
    object(p, value, path, [form]);
    text(p, value[form], at(path, form), 1, EVAL_LIMITS.promptChars.max);
  }
}

function call(p: Problems, value: unknown, path: string): void {
  const o = object(p, value, path, ['tool', 'command', 'path', 'input', 'outcome', 'scope']);
  if (!o) return;
  if (o.tool !== undefined) {
    if (typeof o.tool === 'string') {
      if (!o.tool) p.add(at(path, 'tool'), 'must not be empty');
    } else strings(p, o.tool, at(path, 'tool'), 'a name glob or a list of them');
  }
  if (o.command !== undefined) matcher(p, o.command, at(path, 'command'));
  if (o.path !== undefined) matcher(p, o.path, at(path, 'path'));
  if (o.input !== undefined) {
    if (!isRecord(o.input)) p.add(at(path, 'input'), 'must be an object of field matchers');
    else for (const [field, m] of Object.entries(o.input)) matcher(p, m, `${at(path, 'input')}.${field}`);
  }
  if (o.outcome !== undefined) oneOf(p, o.outcome, at(path, 'outcome'), EVAL_OUTCOMES);
  if (o.scope !== undefined) oneOf(p, o.scope, at(path, 'scope'), EVAL_CALL_SCOPES);
}

/** A `file` check names one file in the lane: relative, no glob, nothing that climbs out. */
function filePath(p: Problems, value: unknown, path: string): void {
  if (typeof value !== 'string' || !value) return p.add(path, 'must be a non-empty relative path');
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value) || value.includes('\\') || value.split('/').includes('..')) {
    p.add(path, 'must stay inside the worktree (relative, no ..)');
  } else if (/[*?{}[\]]/.test(value)) p.add(path, 'must be a plain path, not a glob');
}

/** A judged expectation: the statement the judge checks, its model, and the examples it is calibrated on. */
function judged(p: Problems, value: Json, path: string): void {
  const L = EVAL_LIMITS;
  text(p, value.statement, at(path, 'statement'), L.judgeStatementChars.min, L.judgeStatementChars.max);
  if (value.model !== undefined) text(p, value.model, at(path, 'model'), 1, 200);
  if (value.examples === undefined) return;
  if (!Array.isArray(value.examples) || value.examples.length > L.judgeExamples.max) {
    p.add(at(path, 'examples'), `must be a list of at most ${L.judgeExamples.max} examples`);
    return;
  }
  value.examples.forEach((e, i) => {
    const ep = `${at(path, 'examples')}[${i}]`;
    const o = object(p, e, ep, ['calls', 'final', 'pass']);
    if (!o) return;
    if (!Array.isArray(o.calls) || o.calls.length > L.callsPerSample) p.add(at(ep, 'calls'), `must be a list of at most ${L.callsPerSample} call summaries`);
    else o.calls.forEach((c, j) => text(p, c, `${at(ep, 'calls')}[${j}]`, 1, L.callInputBytes));
    if (typeof o.final !== 'string' || o.final.length > L.resultTextBytes) p.add(at(ep, 'final'), `must be a string of at most ${L.resultTextBytes} characters`);
    boolean(p, o.pass, at(ep, 'pass'));
  });
}

function expectation(p: Problems, value: unknown, path: string): void {
  if (!isRecord(value)) return p.add(path, 'must be an object');
  const kind = oneOf(p, value.kind, at(path, 'kind'), p.v2 ? EXPECTATION_KINDS_V2 : EXPECTATION_KINDS);
  if (!kind) return;
  const fields: Record<string, readonly string[]> = {
    called: ['call', 'min', 'max'],
    'not-called': ['call'],
    before: ['call', 'anchor', 'ifAnchor'],
    after: ['call', 'anchor', 'ifAnchor'],
    sequence: ['calls', 'strict'],
    text: ['match'],
    file: ['path', 'exists', 'contains'],
    touched: ['path', 'expect'],
    command: ['run', 'exitCode', 'timeoutSeconds'],
    judged: ['statement', 'model', 'examples'],
  };
  object(p, value, path, ['kind', ...(fields[kind] ?? [])]);
  const callAt = (key: string) => call(p, value[key], at(path, key));
  switch (kind) {
    case 'called': {
      callAt('call');
      const min = value.min === undefined ? null : integer(p, value.min, at(path, 'min'), 0, 1000);
      const max = value.max === undefined ? null : integer(p, value.max, at(path, 'max'), 0, 1000);
      if (min !== null && max !== null && max < min) p.add(at(path, 'max'), 'must not be below min');
      break;
    }
    case 'not-called':
      callAt('call');
      break;
    case 'before':
    case 'after':
      callAt('call');
      callAt('anchor');
      if (value.ifAnchor !== undefined) boolean(p, value.ifAnchor, at(path, 'ifAnchor'));
      break;
    case 'sequence': {
      const { min, max } = EVAL_LIMITS.sequenceCalls;
      if (!Array.isArray(value.calls) || value.calls.length < min || value.calls.length > max) {
        p.add(at(path, 'calls'), `must be a list of ${min}-${max} call matchers`);
      } else value.calls.forEach((c, i) => call(p, c, `${at(path, 'calls')}[${i}]`));
      if (value.strict !== undefined) boolean(p, value.strict, at(path, 'strict'));
      break;
    }
    case 'text':
      matcher(p, value.match, at(path, 'match'));
      break;
    case 'file':
      filePath(p, value.path, at(path, 'path'));
      if ((value.exists === undefined) === (value.contains === undefined)) p.add(path, 'needs exactly one of exists, contains');
      if (value.exists !== undefined) boolean(p, value.exists, at(path, 'exists'));
      if (value.contains !== undefined) matcher(p, value.contains, at(path, 'contains'));
      break;
    case 'touched':
      matcher(p, value.path, at(path, 'path'));
      boolean(p, value.expect, at(path, 'expect'));
      break;
    case 'judged':
      judged(p, value, path);
      break;
    case 'command':
      text(p, value.run, at(path, 'run'), 1, EVAL_LIMITS.promptChars.max);
      if (value.exitCode !== undefined) integer(p, value.exitCode, at(path, 'exitCode'), 0, 255);
      if (value.timeoutSeconds !== undefined) integer(p, value.timeoutSeconds, at(path, 'timeoutSeconds'), 1, EVAL_LIMITS.commandTimeoutSeconds.max);
      break;
  }
}

function evalCase(p: Problems, value: unknown, path: string, seen: Set<string>): void {
  const o = object(p, value, path, p.v2 ? ['id', 'title', 'prompt', 'prompts', 'mustHold', 'pin', 'expect'] : ['id', 'title', 'prompt', 'pin', 'expect']);
  if (!o) return;
  if (typeof o.id !== 'string' || !EVAL_CASE_ID_PATTERN.test(o.id)) p.add(at(path, 'id'), 'must be lowercase letters, digits and dashes, up to 48, starting with a letter or digit');
  else if (seen.has(o.id)) p.add(at(path, 'id'), `duplicates another case (${o.id})`);
  else seen.add(o.id);
  if (o.title !== undefined) text(p, o.title, at(path, 'title'), EVAL_LIMITS.titleChars.min, EVAL_LIMITS.titleChars.max);
  const { min: pmin, max: pmax } = EVAL_LIMITS.promptChars;
  if (p.v2 && o.prompts !== undefined) {
    const pr = object(p, o.prompts, at(path, 'prompts'), EVAL_PRESSURES);
    if (pr) {
      const neutral = text(p, pr.neutral, at(path, 'prompts.neutral'), pmin, pmax);
      for (const level of ['supportive', 'competing'] as const) {
        if (pr[level] !== undefined) text(p, pr[level], at(path, `prompts.${level}`), pmin, pmax);
      }
      // `prompt` is the neutral prompt; a file may carry both only when they agree
      if (o.prompt !== undefined && neutral !== null && o.prompt !== neutral) p.add(at(path, 'prompt'), 'must equal prompts.neutral when both are given');
    }
  } else text(p, o.prompt, at(path, 'prompt'), pmin, pmax);
  if (o.mustHold !== undefined) boolean(p, o.mustHold, at(path, 'mustHold'));
  if (o.pin !== undefined) pin(p, o.pin, at(path, 'pin'));
  const { min, max } = EVAL_LIMITS.expectPerCase;
  if (!Array.isArray(o.expect) || o.expect.length < min || o.expect.length > max) {
    p.add(at(path, 'expect'), `must be a list of ${min}-${max} expectations`);
  } else o.expect.forEach((e, i) => expectation(p, e, `${at(path, 'expect')}[${i}]`));
}

/** Every problem of a value as an eval definition, without throwing. Empty means it parses. */
export function evalDefinitionProblems(value: unknown): string[] {
  const p = new Problems();
  if (isRecord(value) && !(EVAL_FILE_VERSIONS as readonly unknown[]).includes(value.version)) {
    p.add('version', 'unsupported-version');
    return p.list;
  }
  p.v2 = isRecord(value) && value.version === 2;
  const o = object(p, value, '', p.v2 ? ['version', 'title', 'target', 'runAs', 'pin', 'samples', 'k', 'limits', 'policy', 'setup', 'cases'] : ['version', 'title', 'target', 'runAs', 'pin', 'samples', 'limits', 'policy', 'setup', 'cases']);
  if (!o) return p.list.map((m) => m.replace(/^: /, ''));
  text(p, o.title, 'title', EVAL_LIMITS.titleChars.min, EVAL_LIMITS.titleChars.max);
  const t = target(p, o.target);
  if (o.runAs !== undefined) {
    const r = object(p, o.runAs, 'runAs', ['agent', 'stage', 'model', 'effort']);
    if (r) {
      if (r.agent !== undefined) {
        const agent = text(p, r.agent, 'runAs.agent', 1, 64);
        if (agent !== null && t?.kind === 'agent' && agent !== t.name) p.add('runAs.agent', 'must equal target.name when the target is an agent');
      }
      if (r.stage !== undefined) oneOf(p, r.stage, 'runAs.stage', EVAL_STAGES);
      if (r.model !== undefined) text(p, r.model, 'runAs.model', 1, 200);
      if (r.effort !== undefined && r.effort !== null) oneOf(p, r.effort, 'runAs.effort', EFFORT_LEVELS);
    }
  }
  pin(p, o.pin, 'pin');
  const L = EVAL_LIMITS;
  const n = o.samples === undefined ? null : integer(p, o.samples, 'samples', L.samples.min, p.v2 ? L.metricSamples.max : L.samples.max);
  if (o.k !== undefined) {
    const k = integer(p, o.k, 'k', 1, L.metricSamples.max);
    // k is read against n scored samples, so it may not exceed the n the file asks for (default 5)
    const limit = n ?? L.metricSamples.default;
    if (k !== null && k > limit) p.add('k', `must not exceed samples (${limit})`);
  }
  if (o.limits !== undefined) {
    const l = object(p, o.limits, 'limits', ['maxCostUsdPerSample', 'timeoutMinutes', 'maxCostUsd']);
    if (l) {
      if (l.maxCostUsdPerSample !== undefined) number(p, l.maxCostUsdPerSample, 'limits.maxCostUsdPerSample', L.maxCostUsdPerSample.min, L.maxCostUsdPerSample.max);
      if (l.timeoutMinutes !== undefined) integer(p, l.timeoutMinutes, 'limits.timeoutMinutes', L.timeoutMinutes.min, L.timeoutMinutes.max);
      if (l.maxCostUsd !== undefined) number(p, l.maxCostUsd, 'limits.maxCostUsd', L.maxCostUsd.min, L.maxCostUsd.max);
    }
  }
  if (o.policy !== undefined && o.policy !== null) policy(p, o.policy, 'policy');
  if (o.setup !== undefined && o.setup !== null) text(p, o.setup, 'setup', 1, L.promptChars.max);
  if (!Array.isArray(o.cases) || o.cases.length < L.cases.min || o.cases.length > L.cases.max) {
    p.add('cases', `must be a list of ${L.cases.min}-${L.cases.max} cases`);
  } else {
    const seen = new Set<string>();
    o.cases.forEach((c, i) => evalCase(p, c, `cases[${i}]`, seen));
  }
  return p.list;
}

/** A version 2 case with `prompts` always carries `prompt` too, the neutral one, so readers need no second path. */
export function normalizeEvalDefinition(definition: EvalDefinition): EvalDefinition {
  return { ...definition, cases: definition.cases.map((c) => (c.prompts ? { ...c, prompt: c.prompts.neutral } : c)) };
}

/** Strict: throws {@link EvalFileError} listing every problem. The write path uses this. */
export function parseEvalDefinition(value: unknown): EvalDefinition {
  const problems = evalDefinitionProblems(value);
  if (problems.length) {
    const unsupported = problems.length === 1 && problems[0] === 'version: unsupported-version';
    throw new EvalFileError(unsupported ? 'unsupported-version' : 'invalid', problems.join('; '), problems);
  }
  return normalizeEvalDefinition(value as EvalDefinition);
}

export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/** The scope a target lives in: the project's, or the account's config dir. */
function targetScope(t: EvalTarget, projectPath: string, config: CoreConfig): ConfigScope {
  return t.scope === 'user' ? userScope(config) : projectScope(projectPath);
}

/**
 * The file an eval's target is, from the resolvers in `config/`; never from the eval file's own
 * words, so a committed eval cannot point a run at an arbitrary file.
 */
export function evalTargetPath(t: EvalTarget, projectPath: string, config: CoreConfig): string {
  const scope = targetScope(t, projectPath, config);
  switch (t.kind) {
    case 'agent':
      return resourcePath(scope, 'agents', t.name);
    case 'skill':
      return resourcePath(scope, 'skills', t.name);
    case 'rule':
      return resourcePath(scope, 'rules', t.name);
    case 'instructions':
      if (t.name !== 'CLAUDE.md' && t.name !== 'CLAUDE.local.md') throw new Error('instructions target must be CLAUDE.md or CLAUDE.local.md');
      return instructionsPath(scope, t.name === 'CLAUDE.local.md' ? 'local' : 'shared');
  }
}

function checkName(name: string): void {
  if (typeof name !== 'string' || !EVAL_NAME_PATTERN.test(name)) {
    throw new EvalFileError('invalid-name', 'an eval name is lowercase letters, digits and dashes, up to 64, starting with a letter or digit');
  }
}

const TMP_FILE = /\.json\.\d+\.tmp$/;

/** What is on disk for one path: bytes and their SHA, or the reason the file is not read. */
async function load(file: string): Promise<{ raw: string; sha: string } | { problem: string; sha: string } | null> {
  const info = await lstat(file).catch(() => null);
  if (!info) return null;
  if (info.isSymbolicLink()) return { problem: 'a symbolic link is not read', sha: '' };
  if (!info.isFile()) return { problem: 'not a file', sha: '' };
  if (info.size > EVAL_LIMITS.fileBytes) return { problem: `too large (over ${EVAL_LIMITS.fileBytes / 1024} KiB)`, sha: '' };
  const bytes = await readFile(file);
  return { raw: bytes.toString('utf8'), sha: sha256(bytes) };
}

function describe(name: string, path: string, loaded: NonNullable<Awaited<ReturnType<typeof load>>>): EvalFile {
  if ('problem' in loaded) return { name, path, sha: loaded.sha, definition: null, problems: [`file: ${loaded.problem}`] };
  let value: unknown;
  try {
    value = JSON.parse(loaded.raw);
  } catch {
    return { name, path, sha: loaded.sha, definition: null, problems: ['file: not valid JSON'] };
  }
  const problems = evalDefinitionProblems(value);
  return { name, path, sha: loaded.sha, definition: problems.length ? null : normalizeEvalDefinition(value as EvalDefinition), problems };
}

/** List, read, write and delete the eval files of a project. */
export class EvalDefinitionStore {
  /** The SHA of the last content Claudio wrote to each path, so a watcher can tell its own writes from the person's. */
  private readonly written = new Map<string, string>();

  dir(projectPath: string): string {
    return join(projectPath, EVAL_DIR);
  }

  private file(projectPath: string, name: string): string {
    checkName(name);
    return join(this.dir(projectPath), `${name}.json`);
  }

  /** Whether this content is what Claudio itself last wrote to the file. */
  wroteSha(path: string, sha: string): boolean {
    return this.written.get(path) === sha;
  }

  /** Every file of the folder; one that cannot run is listed with its problems, and the rest still load. */
  async list(projectPath: string): Promise<EvalFile[]> {
    const dir = this.dir(projectPath);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const files: EvalFile[] = [];
    for (const entry of entries) {
      if (TMP_FILE.test(entry.name)) continue;
      const path = join(dir, entry.name);
      const stem = entry.name.endsWith('.json') ? entry.name.slice(0, -'.json'.length) : entry.name;
      if (!entry.name.endsWith('.json') || !EVAL_NAME_PATTERN.test(stem)) {
        files.push({ name: entry.name, path, sha: '', definition: null, problems: ['file: the name must be <name>.json with lowercase letters, digits and dashes'] });
        continue;
      }
      const loaded = await load(path);
      if (loaded) files.push(describe(stem, path, loaded));
    }
    return files.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** One file, or null when there is none. A name that is not an eval name is refused. */
  async read(projectPath: string, name: string): Promise<EvalFile | null> {
    const path = this.file(projectPath, name);
    const loaded = await load(path);
    return loaded ? describe(name, path, loaded) : null;
  }

  /**
   * Strict write, atomic. `ifMatch` is the SHA the editor read (`null` when it expects no file), and
   * a different file on disk is `changed-on-disk`. The check and the rename are not one step, so a
   * person's save in between is not caught; two Claudio writers are not a case this guards.
   */
  async write(projectPath: string, name: string, value: unknown, options: { ifMatch: string | null }): Promise<EvalFile> {
    const path = this.file(projectPath, name);
    const definition = parseEvalDefinition(value);
    const content = `${JSON.stringify(definition, null, 2)}\n`;
    if (Buffer.byteLength(content, 'utf8') > EVAL_LIMITS.fileBytes) {
      throw new EvalFileError('too-large', `an eval file is at most ${EVAL_LIMITS.fileBytes / 1024} KiB`);
    }
    const current = await load(path);
    const currentSha = current ? current.sha : null;
    if (currentSha !== options.ifMatch) {
      throw new EvalFileError('changed-on-disk', 'the file changed on disk since it was read');
    }
    await mkdir(this.dir(projectPath), { recursive: true });
    await writeAtomic(path, content);
    const sha = sha256(content);
    this.written.set(path, sha);
    return { name, path, sha, definition, problems: [] };
  }

  /** Delete a file; `ifMatch` guards against removing what the person changed. False when there was none. */
  async remove(projectPath: string, name: string, options: { ifMatch?: string } = {}): Promise<boolean> {
    const path = this.file(projectPath, name);
    const current = await load(path);
    if (!current) return false;
    if (options.ifMatch !== undefined && options.ifMatch !== current.sha) {
      throw new EvalFileError('changed-on-disk', 'the file changed on disk since it was read');
    }
    await rm(path, { force: true });
    this.written.delete(path);
    return true;
  }
}

interface ConsentEntry {
  project: string;
  name: string;
  sha: string;
  grantedAt: string;
}

/**
 * Which file content the person has accepted to run: the prompts, the setup and every assertion
 * command (decision 16). Keyed by the file's SHA-256, so any edit asks again, and kept in
 * `<dataDir>/eval-consents.json` so it survives a restart. One entry per eval: a new grant replaces
 * the old content's.
 */
export class EvalConsents {
  private readonly file: string;

  constructor(config: Pick<CoreConfig, 'dataDir'>) {
    this.file = join(config.dataDir, 'eval-consents.json');
  }

  private async load(): Promise<ConsentEntry[]> {
    try {
      const doc = JSON.parse(await readFile(this.file, 'utf8')) as { consents?: unknown };
      if (!Array.isArray(doc.consents)) return [];
      return doc.consents.filter(
        (c): c is ConsentEntry =>
          isRecord(c) && typeof c.project === 'string' && typeof c.name === 'string' && typeof c.sha === 'string' && typeof c.grantedAt === 'string',
      );
    } catch {
      return []; // missing or damaged: nothing is consented to, which is the safe reading
    }
  }

  private save(consents: ConsentEntry[]): Promise<void> {
    return writeAtomic(this.file, `${JSON.stringify({ version: 1, consents }, null, 2)}\n`, 0o600);
  }

  /** True only when the person accepted this very content. */
  async has(projectPath: string, name: string, sha: string): Promise<boolean> {
    if (!sha) return false;
    return (await this.load()).some((c) => c.project === projectPath && c.name === name && c.sha === sha);
  }

  async grant(projectPath: string, name: string, sha: string): Promise<void> {
    if (!sha) throw new Error('a consent needs the SHA of the content');
    const rest = (await this.load()).filter((c) => !(c.project === projectPath && c.name === name));
    rest.push({ project: projectPath, name, sha, grantedAt: new Date().toISOString() });
    await this.save(rest);
  }

  /** Forget an eval's consent, as when its file is deleted. */
  async revoke(projectPath: string, name: string): Promise<void> {
    const all = await this.load();
    const rest = all.filter((c) => !(c.project === projectPath && c.name === name));
    if (rest.length !== all.length) await this.save(rest);
  }
}
