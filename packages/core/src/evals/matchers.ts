import { promises as fs } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { EVAL_LIMITS, EVAL_REGEX_FLAGS } from '@claudio/shared';
import type { EvalCallMatcher, EvalCheck, EvalExpectation, EvalStringMatcher } from '@claudio/shared';
import type { SeenCall } from '../tool-calls.js';
import { runCommand } from '../verification.js';
import type { CommandOutcome } from '../verification.js';

// The expectation grammar of docs/plans/instruction-evals.md, "The expectation grammar".

/** How a bare-string glob reads its value: a command or text crosses `/`, a path does not. */
type GlobFlavor = 'text' | 'path';

const MAX_BRACE_EXPANSIONS = 64;

/** `{a,b}` alternation, expanded into patterns (nesting included), capped so a hostile glob cannot explode. */
function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{');
  if (open < 0) return [pattern];
  let depth = 0;
  const parts: string[] = [];
  let start = open + 1;
  for (let i = open; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        parts.push(pattern.slice(start, i));
        const head = pattern.slice(0, open);
        const tail = pattern.slice(i + 1);
        const out: string[] = [];
        for (const part of parts) {
          for (const expanded of expandBraces(head + part + tail)) {
            out.push(expanded);
            if (out.length >= MAX_BRACE_EXPANSIONS) return out;
          }
        }
        return out;
      }
    } else if (c === ',' && depth === 1) {
      parts.push(pattern.slice(start, i));
      start = i + 1;
    }
  }
  return [pattern]; // an unclosed brace is a literal
}

type GlobToken = { t: 'lit'; c: string } | { t: 'one' } | { t: 'star' } | { t: 'deep' };

function tokenise(pattern: string, flavor: GlobFlavor): GlobToken[] {
  const tokens: GlobToken[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === '*') {
      let run = 1;
      while (pattern[i + 1] === '*') {
        i++;
        run++;
      }
      // In a command or text every star crosses `/`; in a path only `**` does
      tokens.push(flavor === 'text' || run > 1 ? { t: 'deep' } : { t: 'star' });
    } else if (c === '?') {
      tokens.push({ t: 'one' });
    } else {
      tokens.push({ t: 'lit', c });
    }
  }
  return tokens;
}

/** Whole-value match by dynamic programming over a rolling row: no backtracking, O(value × pattern). */
function matchTokens(tokens: GlobToken[], value: string, flavor: GlobFlavor): boolean {
  let row = new Array<boolean>(value.length + 1).fill(false);
  row[0] = true;
  for (const token of tokens) {
    const next = new Array<boolean>(value.length + 1).fill(false);
    if (token.t === 'deep' || token.t === 'star') next[0] = row[0] as boolean;
    for (let i = 1; i <= value.length; i++) {
      const ch = value[i - 1] as string;
      if (token.t === 'lit') next[i] = (row[i - 1] as boolean) && token.c === ch;
      else if (token.t === 'one') next[i] = (row[i - 1] as boolean) && (flavor === 'text' || ch !== '/');
      else if (token.t === 'deep') next[i] = (row[i] as boolean) || (next[i - 1] as boolean) || (row[i - 1] as boolean);
      else next[i] = (row[i] as boolean) || (ch !== '/' && ((next[i - 1] as boolean) || (row[i - 1] as boolean)));
    }
    row = next;
  }
  return row[value.length] as boolean;
}

/** A glob over the whole value. Braces are alternation in a path glob only: a command may contain them (`${VAR}`). */
export function globMatch(pattern: string, value: string, flavor: GlobFlavor): boolean {
  const patterns = flavor === 'path' ? expandBraces(pattern) : [pattern];
  return patterns.some((p) => matchTokens(tokenise(p, flavor), value, flavor));
}

/** Cuts to the regex input cap on a character boundary of the UTF-16 string. */
function regexInput(value: string): string {
  return value.length > EVAL_LIMITS.regexInputBytes ? value.slice(0, EVAL_LIMITS.regexInputBytes) : value;
}

/** A matcher's regex, or the reason it is not one. */
function compileRegex(source: string, flags: string | undefined): RegExp | string {
  if (source.length > EVAL_LIMITS.regexSourceChars) return `regex is longer than ${EVAL_LIMITS.regexSourceChars} characters`;
  const f = flags ?? '';
  for (const flag of f) if (!EVAL_REGEX_FLAGS.includes(flag) || f.indexOf(flag) !== f.lastIndexOf(flag)) return `regex flag "${flag}" is not allowed`;
  try {
    return new RegExp(source, f);
  } catch (error) {
    return `regex does not compile: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Whether `value` satisfies `matcher`. An unusable regex never matches (its reason is `matcherProblem`). */
export function matchString(matcher: EvalStringMatcher, value: string, flavor: GlobFlavor = 'text'): boolean {
  if (typeof matcher === 'string') return globMatch(matcher, value, flavor);
  if ('equals' in matcher) return value === matcher.equals;
  if ('contains' in matcher) return value.includes(matcher.contains);
  const re = compileRegex(matcher.regex, matcher.flags);
  if (typeof re === 'string') return false;
  return re.test(regexInput(value));
}

/** Why a matcher can never match, or null: a check with such a matcher fails with this as its detail. */
export function matcherProblem(matcher: EvalStringMatcher): string | null {
  if (typeof matcher === 'string' || !('regex' in matcher)) return null;
  const re = compileRegex(matcher.regex, matcher.flags);
  return typeof re === 'string' ? re : null;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Reads one shell word (quote-aware) from the start of `s`; null when `s` is empty. */
function firstWord(s: string): { word: string; rest: string } | null {
  const text = s.trimStart();
  if (!text) return null;
  let quote: '"' | "'" | null = null;
  let i = 0;
  for (; i < text.length; i++) {
    const c = text[i] as string;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"') i++;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '\\') i++;
    else if (/\s/.test(c)) break;
  }
  return { word: text.slice(0, i), rest: text.slice(i) };
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Strips leading `VAR=value`, `timeout <n>`, `env`, `nice` and `command` from a segment. */
function stripWrappers(segment: string): string {
  let rest = segment.trim();
  for (let guard = 0; guard < 20; guard++) {
    const first = firstWord(rest);
    if (!first) return '';
    if (ASSIGNMENT.test(first.word)) {
      rest = first.rest.trim();
    } else if (first.word === 'env' || first.word === 'command') {
      rest = first.rest.trim();
    } else if (first.word === 'nice') {
      rest = first.rest.trim();
      const flag = firstWord(rest);
      if (flag && (flag.word === '-n' || /^-\d+$/.test(flag.word) || flag.word.startsWith('--adjustment='))) {
        const after = flag.word === '-n' ? firstWord(flag.rest) : flag;
        rest = (after ? after.rest : '').trim();
      }
    } else if (first.word === 'timeout') {
      rest = first.rest.trim();
      // Options (`-k 5`, `--signal=KILL`) and then the duration
      for (let i = 0; i < 6; i++) {
        const w = firstWord(rest);
        if (!w) break;
        if (w.word === '-k' || w.word === '-s' || w.word === '--kill-after' || w.word === '--signal') rest = (firstWord(w.rest)?.rest ?? '').trim();
        else if (w.word.startsWith('-')) rest = w.rest.trim();
        else break;
      }
      const duration = firstWord(rest);
      if (duration && /^\d+(\.\d+)?[smhd]?$/.test(duration.word)) rest = duration.rest.trim();
    } else {
      return rest;
    }
  }
  return rest;
}

/**
 * Splits a Bash command on `&&`, `||`, `;`, `|` and newlines, outside quotes, `$(…)`, backticks,
 * parentheses and heredoc bodies, and strips the wrappers from each segment.
 */
export function commandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let depth = 0; // `$(`, `(` and `{ … }` nesting; a separator inside stays text
  let backtick = false;
  const pendingHeredocs: string[] = [];
  const flush = () => {
    const stripped = stripWrappers(current);
    if (stripped) segments.push(stripped);
    current = '';
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (quote) {
      current += c;
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < command.length) current += command[++i];
      continue;
    }
    if (c === '\\' && i + 1 < command.length) {
      current += c + command[++i];
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    if (c === '`') {
      backtick = !backtick;
      current += c;
      continue;
    }
    if (c === '(') {
      depth++;
      current += c;
      continue;
    }
    if (c === ')') {
      depth = Math.max(0, depth - 1);
      current += c;
      continue;
    }
    if (c === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      const m = /^<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9_]+))/.exec(command.slice(i));
      if (m) pendingHeredocs.push(m[1] ?? m[2] ?? m[3] ?? '');
      current += '<<';
      i++;
      continue;
    }
    if (c === '\n' && pendingHeredocs.length > 0) {
      // The bodies are text of this segment, up to a line that is only the delimiter
      current += c;
      for (const delimiter of pendingHeredocs.splice(0)) {
        for (;;) {
          const end = command.indexOf('\n', i + 1);
          const line = command.slice(i + 1, end < 0 ? command.length : end);
          current += line + (end < 0 ? '' : '\n');
          i = end < 0 ? command.length : end;
          if (line.trim() === delimiter || end < 0) break;
        }
      }
      flush(); // the newline after the delimiter ends the command
      continue;
    }
    if (depth === 0 && !backtick) {
      const two = command.slice(i, i + 2);
      if (two === '&&' || two === '||') {
        flush();
        i++;
        continue;
      }
      if (c === ';' || c === '|' || c === '\n') {
        flush();
        continue;
      }
    }
    current += c;
  }
  flush();
  return segments;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * The path a call names, from the input field each built-in tool uses (F7): `file_path` for Read,
 * Edit, MultiEdit and Write; `notebook_path` for NotebookEdit; `path` for Glob and Grep. Other tools
 * have none.
 */
export function callPath(call: Pick<SeenCall, 'name' | 'input'>): string | null {
  switch (call.name) {
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return asText(call.input.file_path) || null;
    case 'NotebookEdit':
      return asText(call.input.notebook_path) || null;
    case 'Glob':
    case 'Grep':
      return asText(call.input.path) || null;
    default:
      return null;
  }
}

/** Relative to the lane root, `/` separators, no `./`. A path outside the lane stays absolute. */
export function normalisePath(path: string, laneRoot: string): string {
  const abs = isAbsolute(path) ? resolve(path) : resolve(laneRoot, path);
  const rel = relative(resolve(laneRoot), abs);
  if (rel === '' ) return '.';
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return abs.split(sep).join('/');
  return rel.split(sep).join('/');
}

/** Whether one call satisfies a call matcher: every field given must match. */
export function callMatches(call: SeenCall, matcher: EvalCallMatcher, laneRoot: string): boolean {
  const scope = matcher.scope ?? 'main';
  if (scope !== 'any' && call.scope !== scope) return false;
  const outcome = matcher.outcome ?? 'any';
  if (outcome !== 'any' && call.outcome !== outcome) return false;
  if (matcher.tool !== undefined) {
    const globs = Array.isArray(matcher.tool) ? matcher.tool : [matcher.tool];
    if (!globs.some((g) => globMatch(g, call.name, 'text'))) return false;
  }
  if (matcher.command !== undefined) {
    if (call.name !== 'Bash') return false;
    const command = asText(call.input.command);
    if (!command) return false;
    const candidates = [command, ...commandSegments(command)];
    if (!candidates.some((s) => matchString(matcher.command as EvalStringMatcher, s, 'text'))) return false;
  }
  if (matcher.path !== undefined) {
    const path = callPath(call);
    if (path === null) return false;
    const normal = normalisePath(path, laneRoot);
    // A path outside the lane stays absolute, so a relative glob (`**` included) must not reach it
    if (typeof matcher.path === 'string' && normal.startsWith('/') && !matcher.path.startsWith('/')) return false;
    if (!matchString(matcher.path, normal, 'path')) return false;
  }
  if (matcher.input !== undefined) {
    for (const [field, m] of Object.entries(matcher.input)) {
      const value = call.input[field];
      if (typeof value !== 'string' || !matchString(m, value, 'text')) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Expectations
// ---------------------------------------------------------------------------

export interface EvalContext {
  /** In stream order */
  calls: SeenCall[];
  /** The final `result` text, or null when there was none */
  resultText: string | null;
  /** The lane's root, as a real path */
  laneRoot: string;
  /** Paths from `git status --porcelain=v1 -z`, against the pin plus the overlay */
  touched: string[];
  /** Replaceable for tests; defaults to the verification runner */
  runCommand?: (command: string, cwd: string, timeoutMs: number) => Promise<CommandOutcome>;
}

const describe = (call: SeenCall): string => {
  const path = callPath(call);
  const command = call.name === 'Bash' ? asText(call.input.command) : '';
  const subject = command ? ` \`${command.length > 60 ? `${command.slice(0, 57)}...` : command}\`` : path ? ` ${path}` : '';
  return `${call.name}${subject} (#${call.seq})`;
};

const tail = (text: string, bytes: number): string => (text.length > bytes ? text.slice(text.length - bytes) : text);

function check(idx: number, expectation: EvalExpectation, passed: boolean, detail: string, evidence: SeenCall | null, output: string | null = null): EvalCheck {
  return { idx, kind: expectation.kind, passed, detail, evidenceSeq: evidence?.seq ?? null, output };
}

function problemOf(expectation: EvalExpectation): string | null {
  const matchers: EvalStringMatcher[] = [];
  const addCall = (m: EvalCallMatcher) => {
    if (m.command !== undefined) matchers.push(m.command);
    if (m.path !== undefined) matchers.push(m.path);
    if (m.input) matchers.push(...Object.values(m.input));
  };
  switch (expectation.kind) {
    case 'called':
    case 'not-called':
      addCall(expectation.call);
      break;
    case 'before':
    case 'after':
      addCall(expectation.call);
      addCall(expectation.anchor);
      break;
    case 'sequence':
      expectation.calls.forEach(addCall);
      break;
    case 'text':
      matchers.push(expectation.match);
      break;
    case 'touched':
      matchers.push(expectation.path);
      break;
    case 'file':
      if (expectation.contains !== undefined) matchers.push(expectation.contains);
      break;
    default:
      break;
  }
  for (const m of matchers) {
    const problem = matcherProblem(m);
    if (problem) return problem;
  }
  return null;
}

/** `real` is `target`'s realpath, inside `root`'s realpath. */
function within(root: string, real: string): boolean {
  return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
}

async function checkFile(idx: number, e: Extract<EvalExpectation, { kind: 'file' }>, ctx: EvalContext): Promise<EvalCheck> {
  const fail = (detail: string) => check(idx, e, false, detail, null);
  if (isAbsolute(e.path) || /[*?{}[\]]/.test(e.path)) return fail(`file path "${e.path}" must be relative to the lane and contain no glob`);
  let root: string;
  try {
    root = await fs.realpath(ctx.laneRoot);
  } catch {
    return fail('the lane no longer exists');
  }
  const target = resolve(root, e.path);
  if (!within(root, target)) return fail(`file "${e.path}" is outside the lane`);
  let real: string;
  try {
    real = await fs.realpath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // A dangling symlink is not "absent": it points somewhere the check must not follow
      const link = await fs.lstat(target).then((s) => s.isSymbolicLink()).catch(() => false);
      if (link) return fail(`file "${e.path}" is a symbolic link that cannot be resolved`);
      if (e.exists === false) return check(idx, e, true, `file ${e.path} does not exist`, null);
      return fail(`file ${e.path} does not exist`);
    }
    return fail(`file ${e.path} could not be resolved`);
  }
  if (!within(root, real)) return fail(`file "${e.path}" resolves outside the lane`);
  if (e.exists !== undefined && e.exists === false) return fail(`file ${e.path} exists`);
  if (e.contains === undefined) return check(idx, e, true, `file ${e.path} exists`, null);
  const problem = matcherProblem(e.contains);
  if (problem) return fail(problem);
  let text: string;
  try {
    const handle = await fs.open(real, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return fail(`${e.path} is not a regular file`);
      const buffer = Buffer.alloc(Math.min(stat.size, EVAL_LIMITS.fileCheckBytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      text = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return fail(`file ${e.path} could not be read`);
  }
  const ok = matchString(e.contains, text, 'text');
  return check(idx, e, ok, ok ? `file ${e.path} matches` : `file ${e.path} does not match`, null);
}

function checkSequence(idx: number, e: Extract<EvalExpectation, { kind: 'sequence' }>, ctx: EvalContext): EvalCheck {
  const { calls, laneRoot } = ctx;
  if (e.strict) {
    const main = calls.filter((c) => c.scope === 'main');
    for (let start = 0; start + e.calls.length <= main.length; start++) {
      const window = e.calls.map((m, j) => main[start + j] as SeenCall);
      if (window.every((c, j) => callMatches(c, { scope: 'any', ...(e.calls[j] as EvalCallMatcher) }, laneRoot))) {
        return check(idx, e, true, `calls ${window.map(describe).join(', then ')} are consecutive`, window[window.length - 1] ?? null);
      }
    }
    return check(idx, e, false, 'the calls never appear one right after another among the main calls', null);
  }
  const found: SeenCall[] = [];
  let message = -1;
  for (const [i, m] of e.calls.entries()) {
    // The earliest match in a strictly later message leaves the most room for the rest
    const hit = calls.find((c) => c.message > message && callMatches(c, m, laneRoot));
    if (!hit) {
      const last = found[found.length - 1];
      return check(idx, e, false, `step ${i + 1} of ${e.calls.length} never happens${last ? ` after ${describe(last)}` : ''}`, last ?? null);
    }
    found.push(hit);
    message = hit.message;
  }
  return check(idx, e, true, `calls ${found.map(describe).join(', then ')} appear in order`, found[found.length - 1] ?? null);
}

async function evaluateOne(idx: number, e: EvalExpectation, ctx: EvalContext): Promise<EvalCheck> {
  const problem = problemOf(e);
  if (problem) return check(idx, e, false, problem, null);
  const { calls, laneRoot } = ctx;
  const matching = (m: EvalCallMatcher) => calls.filter((c) => callMatches(c, m, laneRoot));
  switch (e.kind) {
    case 'called': {
      const hits = matching(e.call);
      const min = e.min ?? 1;
      const max = e.max;
      const ok = hits.length >= min && (max === undefined || hits.length <= max);
      const range = max === undefined ? `at least ${min}` : `${min} to ${max}`;
      const detail = hits.length === 0 ? `no matching call; wanted ${range}` : `${hits.length} matching call${hits.length === 1 ? '' : 's'} (first ${describe(hits[0] as SeenCall)}); wanted ${range}`;
      return check(idx, e, ok, detail, hits[0] ?? null);
    }
    case 'not-called': {
      const hit = matching(e.call)[0];
      return check(idx, e, !hit, hit ? `${describe(hit)} matched but must not happen` : 'no matching call', hit ?? null);
    }
    case 'before': {
      const anchors = matching(e.anchor);
      const first = anchors[0];
      if (!first) return check(idx, e, e.ifAnchor === true, e.ifAnchor ? 'the anchor never happened, so nothing is required' : 'the anchor never happened', null);
      const earlier = matching(e.call).find((c) => c.message < first.message);
      if (earlier) return check(idx, e, true, `${describe(earlier)} is before the first anchor ${describe(first)}`, earlier);
      const tie = matching(e.call).find((c) => c.message === first.message);
      return check(idx, e, false, tie ? `${describe(tie)} is in the same message as the first anchor ${describe(first)}, so it is simultaneous, not before` : `no matching call before the first anchor ${describe(first)}`, tie ?? first);
    }
    case 'after': {
      const anchors = matching(e.anchor);
      const last = anchors[anchors.length - 1];
      if (!last) return check(idx, e, e.ifAnchor === true, e.ifAnchor ? 'the anchor never happened, so nothing is required' : 'the anchor never happened', null);
      const later = matching(e.call).find((c) => c.message > last.message);
      if (later) return check(idx, e, true, `${describe(later)} is after the last anchor ${describe(last)}`, later);
      const tie = matching(e.call).find((c) => c.message === last.message);
      return check(idx, e, false, tie ? `${describe(tie)} is in the same message as the last anchor ${describe(last)}, so it is simultaneous, not after` : `no matching call after the last anchor ${describe(last)}`, tie ?? last);
    }
    case 'sequence':
      return checkSequence(idx, e, ctx);
    // Phase 2: the runner asks the judge (evals/judge.ts) and replaces this check with its verdict; a matcher never decides it
    case 'judged':
      return check(idx, e, false, 'a judged expectation is decided by the judge, not by a matcher', null);
    case 'text': {
      if (ctx.resultText === null) return check(idx, e, false, 'the sample produced no final text', null);
      const ok = matchString(e.match, ctx.resultText, 'text');
      return check(idx, e, ok, ok ? 'the final text matches' : 'the final text does not match', null);
    }
    case 'file':
      return checkFile(idx, e, ctx);
    case 'touched': {
      const hit = ctx.touched.find((p) => matchString(e.path, p, 'path'));
      const ok = e.expect ? hit !== undefined : hit === undefined;
      return check(idx, e, ok, hit ? `${hit} was touched${e.expect ? '' : ', and must not be'}` : `no touched path matches${e.expect ? ', but one must' : ''}`, null);
    }
    case 'command': {
      const seconds = Math.min(e.timeoutSeconds ?? EVAL_LIMITS.commandTimeoutSeconds.default, EVAL_LIMITS.commandTimeoutSeconds.max);
      const run = ctx.runCommand ?? ((c, cwd, ms) => runCommand(c, cwd, ms));
      const outcome = await run(e.run, laneRoot, seconds * 1000);
      const want = e.exitCode ?? 0;
      const ok = !outcome.timedOut && !outcome.cancelled && outcome.exitCode === want;
      const detail = outcome.timedOut
        ? `\`${e.run}\` did not finish in ${seconds} s`
        : outcome.cancelled
          ? `\`${e.run}\` was cancelled`
          : `\`${e.run}\` exited ${outcome.exitCode ?? 'without a code'}; wanted ${want}`;
      return check(idx, e, ok, detail, null, tail(outcome.output, EVAL_LIMITS.checkOutputBytes));
    }
  }
}

/** Evaluates a case's expectations in order. A check that cannot be evaluated is a failure with the reason as `detail`. */
export async function evaluateExpectations(expect: EvalExpectation[], ctx: EvalContext): Promise<EvalCheck[]> {
  const checks: EvalCheck[] = [];
  for (const [idx, e] of expect.entries()) {
    try {
      checks.push(await evaluateOne(idx, e, ctx));
    } catch (error) {
      checks.push(check(idx, e, false, `the check could not be evaluated: ${error instanceof Error ? error.message : String(error)}`, null));
    }
  }
  return checks;
}
