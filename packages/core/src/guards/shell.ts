/*
 * The shell reader: one parse of a command line into the simple commands it would run, following
 * shells, substitutions, wrappers, script files and package scripts (docs/plans/guards.md, "The
 * shell reader"). Only `node:` imports; erasable TypeScript only.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import { type Links, insideAny, normalizeAbs, resolveLexical } from './paths.ts';
import { parseGit } from './git.ts';

export interface Word {
  /** The word with quotes removed; an expansion stays as written (`$X`, `$(…)`) */
  text: string;
  /** Holds `$VAR`, `${…}`, `$(…)`, backticks, a glob, a brace list or a leading `~` */
  dynamic: boolean;
  glob: boolean;
  /** Any part of the word was quoted or escaped */
  quoted: boolean;
}

export interface Assign {
  name: string;
  value: Word;
}

export interface Redirect {
  /** `>`, `>>`, `>|`, `&>`, `&>>`, `<>`, `<`, `<<`, `<<-`, `<<<`, `>&`, `<&` */
  op: string;
  fd: string;
  target: Word | null;
  /** The here-doc body or here-string text */
  body: string | null;
}

export interface Cmd {
  argv: Word[];
  assigns: Assign[];
  redirects: Redirect[];
  /** Absolute directory it runs in; null when unknown */
  cwd: string | null;
  depth: number;
  raw: string;
  /** The words before wrappers were stripped */
  orig: Word[];
  /** Its arguments come from stdin (`xargs`) */
  xargs: boolean;
  /** Run by `find -exec`: `{}` stands for the files */
  findExec: boolean;
  /** Script text this command reads on stdin, when known */
  stdin: string | null;
  /** Raw text of the whole pipeline up to this command */
  pipeRaw: string;
}

export interface Scan {
  kind: 'interpreter' | 'opaque' | 'dynamic' | 'xargs';
  text: string;
}

export type ShellFailure = 'unparseable' | 'too-deep';

export interface ShellView {
  commands: Cmd[];
  scans: Scan[];
  error: ShellFailure | null;
  /** Symlinks the line creates (`ln -s`) */
  links: [string, string][];
}

export interface ShellContext {
  cwd: string | null;
  roots: string[];
  maxDepth: number;
  maxFilesRead: number;
  maxScriptBytes: number;
}

const MAX_COMMANDS = 10_000;
const MAX_LINE = 256 * 1024;

class ShellError extends Error {
  reason: ShellFailure;
  constructor(reason: ShellFailure) {
    super(reason);
    this.reason = reason;
  }
}

interface RawCmd {
  assigns: Assign[];
  argv: Word[];
  redirects: Redirect[];
  cwd: string | null;
  start: number;
  end: number;
  pipeStart: number;
  pipeFrom: number;
  subs: string[];
  drop: boolean;
}

const isSpace = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\r';
const OPERATORS = ';|&()<>';
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}', 'esac', 'in']);
const DROPPING = new Set(['for', 'select', 'case', 'function']);

/** Index of the `)` that closes a paren opened just before `from`; skips quotes and nested parens */
function matchParen(text: string, from: number): number {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === '\\') i++;
    else if (ch === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0) throw new ShellError('unparseable');
      i = close;
    } else if (ch === '"') {
      for (i++; i < text.length && text.charAt(i) !== '"'; i++) if (text.charAt(i) === '\\') i++;
      if (i >= text.length) throw new ShellError('unparseable');
    } else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  throw new ShellError('unparseable');
}

function matchBrace(text: string, from: number): number {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === '\\') i++;
    else if (ch === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0) throw new ShellError('unparseable');
      i = close;
    } else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  throw new ShellError('unparseable');
}

/** Decodes the inside of `$'…'`; returns the text and the index of the closing quote */
function ansiC(text: string, from: number): { value: string; end: number } {
  let out = '';
  for (let i = from; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === "'") return { value: out, end: i };
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = text.charAt(++i);
    const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b', E: '\x1b', '\\': '\\', "'": "'", '"': '"', '?': '?' };
    const mapped = simple[next];
    if (mapped !== undefined) out += mapped;
    else if (next === 'x' || next === 'u' || next === 'U') {
      const max = next === 'x' ? 2 : next === 'u' ? 4 : 8;
      const digits = /^[0-9a-fA-F]*/.exec(text.slice(i + 1, i + 1 + max))?.[0] ?? '';
      if (digits === '') out += `\\${next}`;
      else {
        const code = Number.parseInt(digits, 16);
        out += code <= 0x10ffff ? String.fromCodePoint(code) : '';
        i += digits.length;
      }
    } else if (/[0-7]/.test(next)) {
      const digits = /^[0-7]{1,3}/.exec(text.slice(i, i + 3))?.[0] ?? next;
      out += String.fromCharCode(Number.parseInt(digits, 8) & 0xff);
      i += digits.length - 1;
    } else if (next === 'c') {
      out += String.fromCharCode(text.charCodeAt(++i) & 0x1f);
    } else out += `\\${next}`;
  }
  throw new ShellError('unparseable');
}

interface Lexed {
  word: Word;
  end: number;
}

/** Reads one word from `start`; substitutions found inside it are appended to `subs` */
function lexWord(text: string, start: number, subs: string[]): Lexed {
  const n = text.length;
  let i = start;
  let out = '';
  let expand = false;
  let glob = false;
  let brace = false;
  let quoted = false;
  const tilde = text.charAt(i) === '~';

  const dollar = (inDouble: boolean): void => {
    const next = text.charAt(i + 1);
    if (next === "'" && !inDouble) {
      const decoded = ansiC(text, i + 2);
      out += decoded.value;
      quoted = true;
      i = decoded.end + 1;
    } else if (next === '"' && !inDouble) {
      i++;
    } else if (next === '(') {
      const close = matchParen(text, i + 2);
      out += text.slice(i, close + 1);
      subs.push(text.slice(i + 2, close));
      expand = true;
      i = close + 1;
    } else if (next === '{') {
      const close = matchBrace(text, i + 2);
      out += text.slice(i, close + 1);
      expand = true;
      i = close + 1;
    } else if (/[A-Za-z_]/.test(next)) {
      const name = /^[A-Za-z0-9_]+/.exec(text.slice(i + 1))?.[0] ?? '';
      out += `$${name}`;
      expand = true;
      i += 1 + name.length;
    } else if (next !== '' && /[0-9?$!@#*-]/.test(next)) {
      out += `$${next}`;
      expand = true;
      i += 2;
    } else {
      out += '$';
      i++;
    }
  };

  const backtick = (): void => {
    let j = i + 1;
    let inner = '';
    for (; j < n && text.charAt(j) !== '`'; j++) {
      if (text.charAt(j) === '\\' && '`\\$'.includes(text.charAt(j + 1))) j++;
      inner += text.charAt(j);
    }
    if (j >= n) throw new ShellError('unparseable');
    out += text.slice(i, j + 1);
    subs.push(inner);
    expand = true;
    i = j + 1;
  };

  while (i < n) {
    const ch = text.charAt(i);
    if (isSpace(ch) || ch === '\n' || OPERATORS.includes(ch)) break;
    if (ch === '\\') {
      quoted = true;
      if (text.charAt(i + 1) === '\n') i += 2;
      else if (i + 1 >= n) {
        out += '\\';
        i++;
      } else {
        out += text.charAt(i + 1);
        i += 2;
      }
    } else if (ch === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0) throw new ShellError('unparseable');
      out += text.slice(i + 1, close);
      quoted = true;
      i = close + 1;
    } else if (ch === '"') {
      quoted = true;
      i++;
      for (;;) {
        if (i >= n) throw new ShellError('unparseable');
        const c = text.charAt(i);
        if (c === '"') {
          i++;
          break;
        }
        if (c === '\\') {
          const next = text.charAt(i + 1);
          if (next === '\n') i += 2;
          else if ('$`"\\'.includes(next)) {
            out += next;
            i += 2;
          } else {
            out += c;
            i++;
          }
        } else if (c === '$') dollar(true);
        else if (c === '`') backtick();
        else {
          out += c;
          i++;
        }
      }
    } else if (ch === '$') dollar(false);
    else if (ch === '`') backtick();
    else {
      if (ch === '*' || ch === '?' || ch === '[') glob = true;
      else if (ch === '{' && text.slice(i, text.indexOf('}', i) + 1).includes(',')) brace = true;
      out += ch;
      i++;
    }
  }
  if (out === '[' || out === '[[') glob = false;
  const dynamic = expand || glob || brace || (tilde && out.length > 0);
  return { word: { text: out, dynamic, glob: glob && !expand, quoted }, end: i };
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

interface PendingHeredoc {
  redirect: Redirect;
  delimiter: string;
  strip: boolean;
}

/** Splits a command line into simple commands, in order, tracking `cd`, subshells and here-docs */
function parseCommands(text: string, startCwd: string | null): RawCmd[] {
  if (text.length > MAX_LINE) throw new ShellError('unparseable');
  const out: RawCmd[] = [];
  const stack: (string | null)[] = [];
  const dirStack: (string | null)[] = [];
  const pending: PendingHeredoc[] = [];
  let cwd = startCwd;
  const n = text.length;
  let i = 0;

  const fresh = (pipeFrom: number, pipeStart: number): RawCmd => ({
    assigns: [], argv: [], redirects: [], cwd, start: -1, end: 0, pipeStart, pipeFrom, subs: [], drop: false,
  });
  let cur = fresh(-1, -1);

  const applyCd = (cmd: RawCmd): void => {
    const head = cmd.argv[0];
    if (!head || head.dynamic) return;
    if (head.text === 'popd') {
      cwd = dirStack.pop() ?? null;
      return;
    }
    if (head.text !== 'cd' && head.text !== 'pushd') return;
    if (head.text === 'pushd') dirStack.push(cwd);
    const target = cmd.argv.slice(1).find((w) => !(w.text.startsWith('-') && w.text !== '-' && !w.quoted));
    if (!target || target.dynamic || target.text === '-') cwd = null;
    else cwd = resolveLexical(target.text, cwd);
  };

  const finish = (pos: number, pipeNext: boolean): void => {
    const filled = cur.argv.length > 0 || cur.assigns.length > 0 || cur.redirects.length > 0;
    let idx = -1;
    if (filled && !cur.drop) {
      if (out.length >= MAX_COMMANDS) throw new ShellError('unparseable');
      cur.end = pos;
      out.push(cur);
      idx = out.length - 1;
      applyCd(cur);
    }
    const pipeStart = cur.pipeStart;
    cur = pipeNext ? fresh(idx, pipeStart) : fresh(-1, -1);
    if (pipeNext && idx < 0) cur.pipeFrom = -1;
  };

  const begin = (pos: number): void => {
    if (cur.start < 0) {
      cur.start = pos;
      if (cur.pipeStart < 0) cur.pipeStart = pos;
    }
  };

  const readHeredocs = (): void => {
    for (const item of pending) {
      const lines: string[] = [];
      let found = false;
      while (i < n) {
        let eol = text.indexOf('\n', i);
        if (eol < 0) eol = n;
        let line = text.slice(i, eol);
        i = Math.min(n, eol + 1);
        if (item.strip) line = line.replace(/^\t+/, '');
        if (line === item.delimiter) {
          found = true;
          break;
        }
        lines.push(line);
      }
      if (!found) throw new ShellError('unparseable');
      item.redirect.body = lines.join('\n');
    }
    pending.length = 0;
  };

  while (i < n) {
    const ch = text.charAt(i);
    if (isSpace(ch)) {
      i++;
      continue;
    }
    if (ch === '\\' && text.charAt(i + 1) === '\n') {
      i += 2;
      continue;
    }
    if (ch === '\n') {
      finish(i, false);
      i++;
      if (pending.length > 0) readHeredocs();
      continue;
    }
    if (ch === '#') {
      const eol = text.indexOf('\n', i);
      i = eol < 0 ? n : eol;
      continue;
    }
    if (ch === ';') {
      finish(i, false);
      while (i < n && (text.charAt(i) === ';' || text.charAt(i) === '&')) i++;
      continue;
    }
    if (ch === '&' && text.charAt(i + 1) !== '>') {
      finish(i, false);
      i += text.charAt(i + 1) === '&' ? 2 : 1;
      continue;
    }
    if (ch === '|') {
      const double = text.charAt(i + 1) === '|';
      finish(i, !double);
      i += double || text.charAt(i + 1) === '&' ? 2 : 1;
      continue;
    }
    if (ch === '(') {
      if (text.charAt(i + 1) === '(' && cur.start < 0) {
        i = matchParen(text, i + 1) + 1;
        continue;
      }
      finish(i, false);
      stack.push(cwd);
      i++;
      continue;
    }
    if (ch === ')') {
      finish(i, false);
      if (stack.length > 0) cwd = stack.pop() ?? null;
      i++;
      continue;
    }
    // Redirects, optionally led by a file descriptor number
    const lead = /^\d+(?=[<>])/.exec(text.slice(i, i + 12))?.[0] ?? '';
    const at = i + lead.length;
    const rc = text.charAt(at);
    const isRedirect = rc === '<' || rc === '>' || (ch === '&' && text.charAt(i + 1) === '>');
    if (isRedirect) {
      if ((rc === '<' || rc === '>') && text.charAt(at + 1) === '(' && lead === '') {
        // Process substitution is a word
        begin(i);
        const close = matchParen(text, at + 2);
        cur.subs.push(text.slice(at + 2, close));
        cur.argv.push({ text: text.slice(at, close + 1), dynamic: true, glob: false, quoted: false });
        i = close + 1;
        continue;
      }
      begin(i);
      const opMatch = /^(?:&>>|&>|<<<|<<-|<<|<>|<&|<|>>|>\||>&|>)/.exec(text.slice(at, at + 3));
      const op = opMatch?.[0] ?? '>';
      i = at + op.length;
      while (i < n && isSpace(text.charAt(i))) i++;
      if (i >= n || text.charAt(i) === '\n' || OPERATORS.includes(text.charAt(i))) throw new ShellError('unparseable');
      const lexed = lexWord(text, i, cur.subs);
      i = lexed.end;
      const redirect: Redirect = { op, fd: lead, target: lexed.word, body: op === '<<<' ? lexed.word.text : null };
      cur.redirects.push(redirect);
      if (op === '<<' || op === '<<-') pending.push({ redirect, delimiter: lexed.word.text, strip: op === '<<-' });
      continue;
    }
    // A word
    const start = i;
    const lexed = lexWord(text, i, cur.subs);
    if (lexed.end === start) {
      i++;
      continue;
    }
    i = lexed.end;
    const word = lexed.word;
    if (cur.argv.length === 0) {
      if (!word.quoted && KEYWORDS.has(word.text) && cur.assigns.length === 0) continue;
      begin(start);
      if (!word.quoted && DROPPING.has(word.text) && cur.assigns.length === 0) cur.drop = true;
      if (ASSIGNMENT.test(text.slice(start, i))) {
        const eq = word.text.indexOf('=');
        const plus = word.text.charAt(eq - 1) === '+';
        cur.assigns.push({
          name: word.text.slice(0, plus ? eq - 1 : eq),
          value: { ...word, text: word.text.slice(eq + 1) },
        });
        continue;
      }
    }
    begin(start);
    cur.argv.push(word);
  }
  finish(n, false);
  if (pending.length > 0) throw new ShellError('unparseable');
  return out;
}

/** Splits `word` into the shell's view of an `echo` or `printf` argument list */
function decodeEscapes(text: string): string {
  return text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash']);
const PYTHON = /^python[0-9.]*$/;

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

interface State {
  cwd: string | null;
  depth: number;
  raw: string;
  pipeRaw: string;
  orig: Word[];
  redirects: Redirect[];
  stdin: string | null;
  stdinOpaque: boolean;
  xargs: boolean;
  findExec: boolean;
  /** The text being read, for scans of what the reader cannot see */
  text: string;
}

interface Stripped {
  rest?: Word[];
  text?: string;
  assigns?: Assign[];
  xargs?: boolean;
  drop?: boolean;
}

function skipOpts(argv: Word[], from: number, valueOpts: readonly string[]): number {
  let i = from;
  while (i < argv.length) {
    const w = argv[i]?.text ?? '';
    if (w === '--') return i + 1;
    if (!w.startsWith('-') || w === '-') break;
    i += valueOpts.includes(w) ? 2 : 1;
  }
  return i;
}

const join = (words: readonly Word[]): string => words.map((w) => w.text).join(' ');

export function readShell(command: string, ctx: ShellContext): ShellView {
  return new Reader(ctx).read(command);
}

class Reader {
  private ctx: ShellContext;
  private view: ShellView = { commands: [], scans: [], error: null, links: [] };
  private filesRead = 0;

  constructor(ctx: ShellContext) {
    this.ctx = ctx;
  }

  read(command: string): ShellView {
    this.walk(command, this.ctx.cwd, 0, null);
    return this.view;
  }

  private fail(reason: ShellFailure): void {
    this.view.error ??= reason;
  }

  private walk(text: string, cwd: string | null, depth: number, stdin: { text: string | null; opaque: boolean } | null): void {
    if (depth > this.ctx.maxDepth) {
      this.fail('too-deep');
      return;
    }
    let raws: RawCmd[];
    try {
      raws = parseCommands(text, cwd);
    } catch (error) {
      this.fail(error instanceof ShellError ? error.reason : 'unparseable');
      return;
    }
    for (const rc of raws) {
      for (const sub of rc.subs) this.walk(sub, rc.cwd, depth + 1, null);
      for (const assign of rc.assigns) {
        if (/^GIT_(?:EDITOR|SEQUENCE_EDITOR|PAGER)$/.test(assign.name)) this.walk(assign.value.text, rc.cwd, depth + 1, null);
      }
      let input: string | null = null;
      let opaque = false;
      const here = [...rc.redirects].reverse().find((r) => (r.op === '<<' || r.op === '<<-' || r.op === '<<<') && r.body !== null);
      if (here) input = here.body;
      else if (rc.pipeFrom >= 0) {
        input = this.producerText(raws[rc.pipeFrom], rc.cwd);
        opaque = input === null;
      } else if (stdin) {
        input = stdin.text;
        opaque = stdin.opaque;
      }
      const state: State = {
        cwd: rc.cwd,
        depth,
        raw: text.slice(rc.start, rc.end).trim(),
        pipeRaw: text.slice(rc.pipeStart < 0 ? rc.start : rc.pipeStart, rc.end).trim(),
        orig: rc.argv,
        redirects: rc.redirects,
        stdin: input,
        stdinOpaque: opaque,
        xargs: false,
        findExec: false,
        text,
      };
      this.unwrap(state, rc.argv, rc.assigns);
    }
  }

  private producerText(producer: RawCmd | undefined, cwd: string | null): string | null {
    const head = producer?.argv[0];
    if (!producer || !head || head.dynamic) return null;
    const base = baseName(head.text);
    const args = producer.argv.slice(1);
    if (base === 'echo') return decodeEscapes(join(args.filter((w) => !/^-[neE]+$/.test(w.text))));
    if (base === 'printf') return decodeEscapes(join(args));
    if (base === 'cat') {
      const here = producer.redirects.find((r) => r.body !== null);
      if (args.length === 0) return here?.body ?? null;
      const parts: string[] = [];
      for (const arg of args) {
        const content = this.readFile(arg, cwd);
        if (content === null) return null;
        parts.push(content);
      }
      return parts.join('\n');
    }
    return null;
  }

  /** The content of a file inside the roots, within the limits; null when it cannot be read */
  private readFile(word: Word, cwd: string | null): string | null {
    if (word.dynamic) return null;
    const abs = resolveLexical(word.text, cwd);
    if (abs === null || this.filesRead >= this.ctx.maxFilesRead) return null;
    try {
      const real = realpathSync(abs);
      if (!insideAny(real, this.ctx.roots)) return null;
      const info = statSync(real);
      if (!info.isFile() || info.size > this.ctx.maxScriptBytes) return null;
      this.filesRead++;
      return readFileSync(real, 'utf8');
    } catch {
      return null;
    }
  }

  private scan(kind: Scan['kind'], text: string): void {
    this.view.scans.push({ kind, text });
  }

  private emit(st: State, argv: Word[], assigns: Assign[]): void {
    this.view.commands.push({
      argv, assigns, redirects: st.redirects, cwd: st.cwd, depth: st.depth, raw: st.raw, orig: st.orig,
      xargs: st.xargs, findExec: st.findExec, stdin: st.stdin, pipeRaw: st.pipeRaw,
    });
    if (baseName(argv[0]?.text ?? '') === 'ln') {
      const flags = argv.slice(1).filter((w) => w.text.startsWith('-') && !w.text.startsWith('--'));
      const names = argv.slice(1).filter((w) => !w.text.startsWith('-'));
      const [target, name] = names;
      if (flags.some((w) => w.text.includes('s')) && target && name && !target.dynamic && !name.dynamic) {
        const from = resolveLexical(name.text, st.cwd);
        const to = resolveLexical(target.text, st.cwd);
        if (from !== null && to !== null) this.view.links.push([from, to]);
      }
    }
  }

  private unwrap(st: State, startArgv: Word[], startAssigns: Assign[]): void {
    let argv = startArgv;
    const assigns = [...startAssigns];
    for (let layer = 0; layer < 32; layer++) {
      const head = argv[0];
      if (!head) {
        this.emit(st, argv, assigns);
        return;
      }
      if (head.dynamic) {
        this.emit(st, argv, assigns);
        this.scan('dynamic', st.text);
        return;
      }
      const base = baseName(head.text);
      const stripped = this.strip(base, argv, st);
      if (stripped) {
        if (stripped.assigns) assigns.push(...stripped.assigns);
        if (stripped.xargs) {
          st = { ...st, xargs: true };
          this.scan('xargs', st.pipeRaw);
        }
        if (stripped.text !== undefined) {
          this.walk(stripped.text, st.cwd, st.depth + 1, null);
          return;
        }
        if (stripped.drop) return;
        if (stripped.rest) {
          argv = stripped.rest;
          continue;
        }
      }
      this.leaf(st, base, argv, assigns);
      return;
    }
    this.fail('too-deep');
  }

  /** Wrappers: their own options are skipped to find the command they run */
  private strip(base: string, argv: Word[], st: State): Stripped | null {
    const after = (i: number): Stripped => ({ rest: argv.slice(i) });
    switch (base) {
      case 'env': {
        const found: Assign[] = [];
        let i = 1;
        for (; i < argv.length; i++) {
          const w = argv[i]?.text ?? '';
          if (w === '-S' || w === '--split-string') return { text: `${argv[i + 1]?.text ?? ''} ${join(argv.slice(i + 2))}` };
          if (w.startsWith('-S') && !w.startsWith('--')) return { text: `${w.slice(2)} ${join(argv.slice(i + 1))}` };
          if (w.startsWith('--split-string=')) return { text: `${w.slice(15)} ${join(argv.slice(i + 1))}` };
          if (['-u', '-C', '--unset', '--chdir', '-a', '--argv0'].includes(w)) i++;
          else if (w === '--') {
            i++;
            break;
          } else if (w.startsWith('-') && w !== '-') continue;
          else if (ASSIGNMENT.test(w)) {
            const eq = w.indexOf('=');
            found.push({ name: w.slice(0, eq), value: { text: w.slice(eq + 1), dynamic: argv[i]?.dynamic ?? false, glob: false, quoted: false } });
          } else break;
        }
        return { rest: argv.slice(i), assigns: found };
      }
      case 'sudo': return after(skipOpts(argv, 1, ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-T', '-U', '-R']));
      case 'doas': return after(skipOpts(argv, 1, ['-u', '-C']));
      case 'command': {
        const i = skipOpts(argv, 1, []);
        return argv.slice(1, i).some((w) => /^-[a-z]*[vV]/.test(w.text)) ? { drop: true } : after(i);
      }
      case 'builtin': return after(1);
      case 'exec': return after(skipOpts(argv, 1, ['-a']));
      case 'nohup': case 'setsid': case 'unbuffer': return after(skipOpts(argv, 1, []));
      case 'time': return after(skipOpts(argv, 1, ['-f', '--format', '-o', '--output']));
      case 'nice': return after(skipOpts(argv, 1, ['-n', '--adjustment']));
      case 'ionice': return after(skipOpts(argv, 1, ['-c', '-n', '-p', '-P', '-t', '--class', '--classdata']));
      case 'chrt': return after(skipOpts(argv, 1, []) + 1);
      case 'taskset': return after(skipOpts(argv, 1, ['-c']) + 1);
      case 'stdbuf': return after(skipOpts(argv, 1, ['-i', '-o', '-e', '--input', '--output', '--error']));
      case 'timeout': return after(skipOpts(argv, 1, ['-s', '--signal', '-k', '--kill-after']) + 1);
      case 'chroot': return after(skipOpts(argv, 1, ['--userspec', '--groups']) + 1);
      case 'flock': {
        const i = skipOpts(argv, 1, ['-w', '--timeout', '-E', '--conflict-exit-code']);
        const c = argv.slice(1, i).findIndex((w) => w.text === '-c' || w.text === '--command');
        if (c >= 0) return { text: argv[i]?.text ?? '' };
        const cIdx = argv.findIndex((w, k) => k > 0 && (w.text === '-c' || w.text === '--command'));
        if (cIdx >= 0) return { text: argv[cIdx + 1]?.text ?? '' };
        return after(i + 1);
      }
      case 'watch': return { text: join(argv.slice(skipOpts(argv, 1, ['-n', '--interval', '-d']))) };
      case 'xargs': return { ...after(skipOpts(argv, 1, ['-I', '-n', '-P', '-d', '-a', '-L', '-s', '-E', '--max-args', '--max-procs', '--delimiter', '--arg-file', '--max-lines', '--max-chars', '--eof', '--replace'])), xargs: true };
      case 'parallel': {
        const i = skipOpts(argv, 1, ['-j', '-n', '-N', '-S', '--jobs', '--max-args']);
        const colon = argv.findIndex((w, k) => k >= i && w.text === ':::');
        return { rest: argv.slice(i, colon < 0 ? undefined : colon), xargs: true };
      }
      case 'script': case 'su': case 'runuser': {
        const c = argv.findIndex((w, k) => k > 0 && (w.text === '-c' || w.text === '--command'));
        return c >= 0 ? { text: argv[c + 1]?.text ?? '' } : null;
      }
      case 'busybox': return after(1);
      case 'nsenter': case 'unshare': case 'firejail': return after(skipOpts(argv, 1, []));
      case 'bwrap': {
        const dashes = argv.findIndex((w) => w.text === '--');
        return dashes < 0 ? null : after(dashes + 1);
      }
      case 'npx': case 'bunx': return after(skipOpts(argv, 1, ['-p', '--package']));
      case 'pnpm': case 'yarn': case 'npm': {
        const sub = argv[1]?.text;
        if (sub === 'exec' || sub === 'dlx') return after(skipOpts(argv, 2, ['-p', '--package']));
        return null;
      }
      default: return null;
    }
  }

  private leaf(st: State, base: string, argv: Word[], assigns: Assign[]): void {
    const head = argv[0];
    if (!head) return;
    if (SHELLS.has(base)) {
      this.emit(st, argv, assigns);
      this.shell(st, argv);
      return;
    }
    switch (base) {
      case 'eval': {
        this.emit(st, argv, assigns);
        if (argv.slice(1).some((w) => w.dynamic)) this.scan('dynamic', st.text);
        this.walk(join(argv.slice(1)), st.cwd, st.depth + 1, null);
        return;
      }
      case 'source': case '.': {
        this.emit(st, argv, assigns);
        this.script(st, argv[1], 'shell');
        return;
      }
      case 'git': this.emit(st, argv, assigns); this.gitNested(st, argv.slice(1)); return;
      case 'find': {
        this.emit(st, argv, assigns);
        for (let i = 1; i < argv.length; i++) {
          if (!['-exec', '-execdir', '-ok', '-okdir'].includes(argv[i]?.text ?? '')) continue;
          let j = i + 1;
          while (j < argv.length && argv[j]?.text !== ';' && argv[j]?.text !== '+') j++;
          this.unwrap({ ...st, findExec: true, redirects: [] }, argv.slice(i + 1, j), []);
          i = j;
        }
        return;
      }
      case 'npm': case 'pnpm': case 'yarn': case 'bun': {
        this.emit(st, argv, assigns);
        this.packageScript(st, base, argv);
        return;
      }
      default: break;
    }
    this.emit(st, argv, assigns);
    if (base.startsWith('git-')) {
      this.gitNested(st, [{ text: base.slice(4), dynamic: false, glob: false, quoted: false }, ...argv.slice(1)]);
      return;
    }
    if (this.interpreter(st, base, argv)) return;
    if (head.text.includes('/')) this.script(st, head, 'direct');
  }

  private shell(st: State, argv: Word[]): void {
    let i = 1;
    let hasC = false;
    let hasS = false;
    while (i < argv.length) {
      const w = argv[i]?.text ?? '';
      if (w === '--') {
        i++;
        break;
      }
      if (!(w.startsWith('-') || w.startsWith('+')) || w.length < 2) break;
      if (w.startsWith('-') && !w.startsWith('--')) {
        if (w.includes('c')) hasC = true;
        if (w.includes('s')) hasS = true;
      }
      i += ['-o', '+o', '-O', '+O', '--rcfile', '--init-file'].includes(w) ? 2 : 1;
    }
    const positional = argv[i];
    if (hasC) {
      if (!positional) return;
      if (positional.dynamic) this.scan('dynamic', st.text);
      this.walk(positional.text, st.cwd, st.depth + 1, null);
    } else if (hasS || !positional) {
      if (st.stdin !== null) this.walk(st.stdin, st.cwd, st.depth + 1, null);
      else if (st.stdinOpaque) this.scan('opaque', st.pipeRaw);
    } else this.script(st, positional, 'shell');
  }

  /** A script file named on the command line: parsed when it is a shell script, scanned otherwise */
  private script(st: State, word: Word | undefined, mode: 'shell' | 'direct'): void {
    if (!word) return;
    const content = this.readFile(word, st.cwd);
    if (content === null) {
      if (mode === 'shell' && existsSync(resolveLexical(word.text, st.cwd) ?? '/nonexistent')) this.scan('opaque', st.raw);
      return;
    }
    if (mode === 'direct') {
      const first = content.slice(0, content.indexOf('\n') < 0 ? undefined : content.indexOf('\n'));
      if (!first.startsWith('#!')) return;
      const shebang = first.slice(2).trim().split(/\s+/);
      const prog = baseName(shebang[0] === '/usr/bin/env' || baseName(shebang[0] ?? '') === 'env' ? (shebang.find((p, k) => k > 0 && !p.startsWith('-')) ?? '') : (shebang[0] ?? ''));
      if (!SHELLS.has(prog)) {
        this.scan('interpreter', content);
        return;
      }
    }
    this.walk(content, st.cwd, st.depth + 1, null);
  }

  private gitNested(st: State, words: Word[]): void {
    const call = parseGit(words);
    for (const config of call.configs) {
      if (/^(?:core\.(?:editor|pager|sshcommand)|sequence\.editor)$/i.test(config.key) && config.value) this.walk(config.value, st.cwd, st.depth + 1, null);
    }
    const args = call.args as Word[];
    const texts = args.map((w) => w.text);
    if (call.verb === 'rebase') {
      for (let i = 0; i < args.length; i++) {
        const t = texts[i] ?? '';
        if (t === '-x' || t === '--exec') this.walk(texts[i + 1] ?? '', st.cwd, st.depth + 1, null);
        else if (t.startsWith('--exec=')) this.walk(t.slice(7), st.cwd, st.depth + 1, null);
        else if (/^-x./.test(t) && !t.startsWith('--')) this.walk(t.slice(2), st.cwd, st.depth + 1, null);
      }
    } else if (call.verb === 'bisect' && texts[0] === 'run') {
      this.unwrap({ ...st, redirects: [] }, args.slice(1), []);
    } else if (call.verb === 'submodule') {
      const at = texts.indexOf('foreach');
      if (at >= 0) this.walk(join(args.slice(skipOpts(args, at + 1, []))), st.cwd, st.depth + 1, null);
    } else if (call.verb === 'filter-branch') {
      for (let i = 0; i < args.length; i++) {
        const t = texts[i] ?? '';
        if (/^--[a-z-]+-filter$/.test(t)) this.walk(texts[i + 1] ?? '', st.cwd, st.depth + 1, null);
        else if (/^--[a-z-]+-filter=/.test(t)) this.walk(t.slice(t.indexOf('=') + 1), st.cwd, st.depth + 1, null);
      }
    }
  }

  private packageScript(st: State, base: string, argv: Word[]): void {
    const values = ['--prefix', '-C', '-w', '--workspace', '--filter', '-F', '--cwd', '--dir'];
    const i = skipOpts(argv, 1, values);
    const sub = argv[i]?.text;
    if (!sub) return;
    let name: string | undefined;
    if (sub === 'run' || sub === 'run-script') name = argv[skipOpts(argv, i + 1, values)]?.text;
    else if (base === 'npm') name = ['test', 't', 'tst'].includes(sub) ? 'test' : ['start', 'stop', 'restart'].includes(sub) ? sub : undefined;
    else if (!['install', 'i', 'add', 'remove', 'rm', 'update', 'up', 'exec', 'dlx', 'init', 'link', 'unlink', 'publish', 'pack', 'create', 'x'].includes(sub)) name = sub;
    if (!name) return;
    const manifest = st.cwd === null ? null : this.readFile({ text: posix.join(st.cwd, 'package.json'), dynamic: false, glob: false, quoted: false }, null);
    if (manifest === null) {
      this.scan('opaque', st.raw);
      return;
    }
    let scripts: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(manifest);
      const found = typeof parsed === 'object' && parsed !== null ? (parsed as { scripts?: unknown }).scripts : undefined;
      if (typeof found === 'object' && found !== null) scripts = found as Record<string, unknown>;
    } catch {
      this.scan('opaque', st.raw);
      return;
    }
    for (const key of [`pre${name}`, name, `post${name}`]) {
      const body = scripts[key];
      if (typeof body === 'string') this.walk(body, st.cwd, st.depth + 1, null);
    }
  }

  /** Interpreters are not parsed: their code is scanned as text. True when the command is one. */
  private interpreter(st: State, base: string, argv: Word[]): boolean {
    const code = (short: string, long: readonly string[]): string[] => {
      const found: string[] = [];
      for (let i = 1; i < argv.length; i++) {
        const w = argv[i]?.text ?? '';
        if (w.startsWith('--')) {
          const eq = w.indexOf('=');
          if (long.includes(eq < 0 ? w : w.slice(0, eq))) found.push(eq < 0 ? (argv[++i]?.text ?? '') : w.slice(eq + 1));
        } else if (w.startsWith('-') && w.length > 1 && [...w.slice(1)].some((letter) => short.includes(letter))) found.push(argv[++i]?.text ?? '');
      }
      return found;
    };
    const firstFile = (): Word | undefined => {
      for (let i = 1; i < argv.length; i++) {
        const w = argv[i];
        if (w && !w.text.startsWith('-')) return w;
      }
      return undefined;
    };
    let snippets: string[] | null = null;
    let file = false;
    if (PYTHON.test(base)) {
      snippets = code('c', []);
      file = true;
    } else if (base === 'node' || base === 'nodejs') {
      snippets = code('ep', ['--eval', '--print']);
      file = true;
    } else if (base === 'bun') {
      snippets = code('e', ['--eval', '--print']);
      file = true;
    } else if (base === 'deno') {
      snippets = argv[1]?.text === 'eval' ? [argv[2]?.text ?? ''] : [];
      file = true;
    } else if (base === 'perl') {
      snippets = code('eE', []);
      file = true;
    } else if (base === 'ruby') {
      snippets = code('e', []);
      file = true;
    } else if (base === 'php') {
      snippets = code('r', []);
      file = true;
    } else if (base === 'lua' || base === 'luajit') {
      snippets = code('e', []);
      file = true;
    } else if (base === 'awk' || base === 'gawk' || base === 'mawk') {
      const programs = code('f', ['--file']);
      const positionals = argv.slice(1).filter((w, k, all) => !w.text.startsWith('-') && !['-F', '-v', '-f'].includes(all[k - 1]?.text ?? ''));
      snippets = [positionals[0]?.text ?? ''];
      for (const p of programs) {
        const content = this.readFile({ text: p, dynamic: false, glob: false, quoted: false }, st.cwd);
        if (content !== null) snippets.push(content);
      }
    } else if (base === 'sed') {
      const expressions = argv.slice(1).map((w) => w.text).filter((t) => !t.startsWith('-'));
      snippets = expressions.filter((t) => /(?:^|[;{\s])e\s|\/[gIimsp0-9]*e[gIimsp0-9]*(?:$|[;}\s])/.test(t));
    }
    if (snippets === null) return false;
    for (const snippet of snippets) if (snippet !== '') this.scan('interpreter', snippet);
    if (file && snippets.filter((s) => s !== '').length === 0) {
      const target = firstFile();
      if (target && (base !== 'bun' || target.text !== 'run')) {
        const content = this.readFile(target, st.cwd);
        if (content !== null) this.scan('interpreter', content);
      }
    }
    if (st.stdin !== null) this.scan('interpreter', st.stdin);
    return true;
  }
}

export { normalizeAbs };
export type { Links };
