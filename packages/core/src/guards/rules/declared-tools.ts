/*
 * `declared-tools` (docs/plans/headless-image.md, D14.5): a confined API chat runs only the tools it
 * declared, every Bash subcommand only under one of its `Bash(...)` rules and in its read-only form,
 * and every path a call names only inside its working directory or its own attachment files. It is
 * defence in depth behind the CLI's confinement: under `dontAsk` the CLI still runs its built-in
 * read-only commands (`cat`, `head`, `find`…) whatever the rules say, and lets them read outside the
 * working directory. Only `node:` imports: this file is bundled into the guard program.
 */
import type { DeclaredTools } from '../input.ts';
import { expandBraces, isInside, realResolve, resolveLexical, staticPrefix } from '../paths.ts';
import type { Cmd, Word } from '../shell.ts';
import { type Block, type RuleContext, baseName, expandGlob, snippet } from './common.ts';

const block = (matcher: string, reason: string): Block => ({ matcher: `declared-tools.${matcher}`, reason });

// ── Declared rules ───────────────────────────────────────────────────────────────────────────────

/** A permission rule split into its tool and its specifier: `Bash(ls *)` → `Bash`, `ls *` */
export function parsePermissionRule(rule: string): { tool: string; spec: string | null } | null {
  const match = /^\s*([^()\s]+)\s*(?:\(([\s\S]*)\))?\s*$/.exec(rule);
  if (!match?.[1]) return null;
  return { tool: match[1], spec: match[2] ?? null };
}

/**
 * `Bash`, `Bash()`, `Bash(*)`, `Bash(:*)`, and any rule whose command is itself a wildcard
 * (`Bash(**)`, `Bash(* *)`, `Bash(*:*)`) allow every command, which a confined chat may not declare
 */
export function isUnrestrictedBash(spec: string | null): boolean {
  if (spec === null) return true;
  const command = spec.trim().replace(/:\*$/, ' *').split(/\s+/)[0] ?? '';
  return command === '' || command.includes('*');
}

/**
 * Claude Code's matching of a `Bash(...)` rule against one subcommand
 * (https://code.claude.com/docs/en/permissions, "Wildcard patterns"): no `*` is an exact match; a
 * `*` stands for any text, spaces included; a trailing ` *` (or `:*`) that is the rule's only
 * wildcard also matches the bare command, and its space is a word boundary.
 */
export function matchesBashRule(pattern: string, command: string): boolean {
  let rule = pattern.trim();
  if (rule.endsWith(':*')) rule = `${rule.slice(0, -2)} *`;
  const parts = rule.split('*');
  if (parts.length === 1) return command === rule;
  if (parts.length === 2 && rule.endsWith(' *')) {
    const prefix = rule.slice(0, -2);
    return command === prefix || command.startsWith(`${prefix} `);
  }
  const source = parts.map((part) => part.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')).join('[\\s\\S]*');
  return new RegExp(`^${source}$`).test(command);
}

interface Policy {
  names: Set<string>;
  prefixes: string[];
  bash: string[];
}

function policyOf(declared: DeclaredTools): Policy {
  const names = new Set(declared.alwaysAllow);
  const prefixes = [...declared.allowPrefixes];
  const bash: string[] = [];
  for (const rule of declared.tools) {
    const parsed = parsePermissionRule(rule);
    if (!parsed) continue;
    const { tool, spec } = parsed;
    if (tool === 'Bash') {
      names.add('Bash');
      // An unrestricted rule is refused at creation; here it matches nothing rather than everything
      if (!isUnrestrictedBash(spec) && spec !== null) bash.push(spec);
    } else if (tool.startsWith('mcp__') && tool.endsWith('*')) prefixes.push(tool.slice(0, -1));
    else if (tool.startsWith('mcp__') && tool.split('__').length === 2) {
      names.add(tool);
      prefixes.push(`${tool}__`);
    } else names.add(tool);
  }
  return { names, prefixes, bash };
}

function toolDeclared(name: string, policy: Policy): boolean {
  return policy.names.has(name) || policy.prefixes.some((prefix) => name.startsWith(prefix));
}

// ── Paths ────────────────────────────────────────────────────────────────────────────────────────

const allowed = (real: string, declared: DeclaredTools): boolean => isInside(real, declared.root) || declared.attachments.includes(real);
const GLOB_CHARS = /[*?[]/;

function outside(path: string, where: string): Block {
  return block('path', `${where}: ${snippet(path)} is outside the working directory and the chat's attachments`);
}

/** Null when every path `text` can name, from `cwd`, is the chat's; the block otherwise */
function checkPath(text: string, glob: boolean, cwd: string | null, ctx: RuleContext, declared: DeclaredTools, where: string): Block | null {
  if (text === '' || text === '-') return null;
  if (/[\0�]/.test(text)) return block('path', `${where}: a path holds an invalid character`);
  if (text.startsWith('~')) return outside(text, where);
  const items = expandBraces(text);
  if (items === null) return block('path', `${where}: the guard cannot tell which paths ${snippet(text)} names`);
  for (const item of items) {
    const abs = resolveLexical(item, cwd);
    if (abs === null) return block('path', `${where}: the directory ${snippet(item)} is read from is not known`);
    if (glob && GLOB_CHARS.test(item)) {
      const prefix = staticPrefix(abs) || '/';
      if (!allowed(realResolve(prefix, true, ctx.links), declared)) return outside(prefix, where);
      for (const path of expandGlob(abs)) if (!allowed(realResolve(path, true, ctx.links), declared)) return outside(path, where);
    } else if (!allowed(realResolve(abs, true, ctx.links), declared)) return outside(item, where);
  }
  return null;
}

// ── Commands ─────────────────────────────────────────────────────────────────────────────────────

/** A word of the line expands at run time: a variable, a command or a process substitution */
const expands = (word: Word): boolean => word.dynamic && (/[$`]/.test(word.text) || /^[<>]\(/.test(word.text));

/**
 * Whether the raw line expands anything, outside single quotes: `$X`, `${…}`, `$(…)`, `$((…))`,
 * backticks, `<(…)`, `>(…)`. Read on the text as well as the words, since the reader skips some
 * constructs (an arithmetic command, a loop's word list) without making words of them.
 */
export function rawExpands(line: string): boolean {
  let single = false;
  let double = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    const next = line.charAt(i + 1);
    if (single) {
      if (ch === "'") single = false;
    } else if (ch === '\\') i++;
    else if (ch === "'" && !double) single = true;
    else if (ch === '"') double = !double;
    else if (ch === '`') return true;
    else if (ch === '$' && /[A-Za-z_{(0-9?$!@#*-]/.test(next)) return true;
    else if (!double && (ch === '<' || ch === '>') && next === '(') return true;
  }
  return false;
}

/** Assignments that only change how output looks */
const SAFE_ENV = /^(?:LANG|LC_[A-Z]+|TZ|NO_COLOR|TERM|COLUMNS)$/;

/** Wrappers Claude Code itself strips before matching a rule; any other one must be declared */
const BENIGN_WRAPPERS = new Set(['timeout', 'time', 'nice', 'nohup', 'stdbuf', 'command', 'builtin', 'noglob']);
const WRAPPER_VALUE = /^(?:\d+(?:\.\d+)?[smhd]?|[+-]?\d+)$/;

/** `cd` reads nothing and runs nothing; its target is checked as a path like any other */
const DIRECTORY_COMMANDS = new Set(['cd', 'pushd', 'popd']);

interface Shape {
  /** The first operand is a pattern unless a pattern option is given */
  pattern?: boolean;
  /** Options whose value is a pattern */
  patternOpts?: ReadonlySet<string>;
  /** Options whose value is a file of patterns */
  patternFiles?: ReadonlySet<string>;
  /** Options whose value is a file */
  files?: ReadonlySet<string>;
  /** Options whose value is neither a path nor a pattern to skip */
  values?: ReadonlySet<string>;
  /** Options that run a program, rewrite what the command runs, write a file or follow links out */
  refused?: ReadonlySet<string>;
  /** Options after which there is no pattern operand (`rg --files`) */
  noPattern?: ReadonlySet<string>;
  /** Every operand is a file the command writes: refused unless it is `/dev/null` (`tee`) */
  writesOperands?: boolean;
}

const set = (...items: string[]): ReadonlySet<string> => new Set(items);
const GREP: Shape = {
  pattern: true,
  patternOpts: set('-e', '--regexp'),
  patternFiles: set('-f', '--file'),
  files: set('--exclude-from'),
  values: set('-A', '-B', '-C', '-m', '-d', '-D', '--max-count', '--after-context', '--before-context', '--context', '--color', '--colour', '--binary-files', '--devices', '--directories', '--label', '--exclude', '--include', '--exclude-dir', '--group-separator'),
  // `-R` follows every link, out of the working directory too, as `find -L` would
  refused: set('-R', '--dereference-recursive'),
};
const SHAPES: Record<string, Shape> = {
  grep: GREP,
  egrep: GREP,
  fgrep: GREP,
  rg: {
    pattern: true,
    patternOpts: set('-e', '--regexp'),
    patternFiles: set('-f', '--file'),
    files: set('--ignore-file'),
    values: set('-A', '-B', '-C', '-m', '-g', '--glob', '--iglob', '-t', '--type', '-T', '--type-not', '--type-add', '-M', '--max-columns', '-j', '--threads', '--max-depth', '-d', '--sort', '--sortr', '-E', '--encoding', '--color', '--colors', '-r', '--replace', '--max-filesize', '--context-separator', '--field-match-separator', '--path-separator'),
    refused: set('--pre', '--pre-glob', '-L', '--follow'),
    noPattern: set('--files', '--type-list'),
  },
  cut: { values: set('-d', '-f', '-b', '-c', '--delimiter', '--fields', '--bytes', '--characters', '--output-delimiter') },
  head: { values: set('-n', '-c', '--lines', '--bytes') },
  tail: { values: set('-n', '-c', '--lines', '--bytes', '--pid', '-s', '--sleep-interval') },
  // `--compress-program` runs a program on sort's temporary files, and `-o` writes one
  sort: { values: set('-t', '-k', '--field-separator', '--key', '-S', '--buffer-size', '--parallel'), refused: set('--compress-program', '-o', '--output', '--files0-from') },
  tee: { writesOperands: true },
  tar: { refused: set('-I', '--use-compress-program', '--to-command', '--checkpoint-action', '-F', '--info-script', '--new-volume-script', '--rsh-command', '--rmt-command') },
  ls: { values: set('-I', '--ignore', '--hide', '-w', '--width', '--format', '--sort', '--time', '--time-style', '-T', '--tabsize', '--block-size', '--quoting-style', '--indicator-style', '--color') },
  // `-c` and `--config-env` set configuration that makes git run programs (`core.fsmonitor`,
  // `diff.external`); `--output` writes a file, `.git/config` included; `--ext-diff`, `--textconv`
  // and `grep -O` run programs; `--upload-pack` and the like run one for a remote
  git: { refused: set('-c', '--config-env', '--exec-path', '--output', '--ext-diff', '--textconv', '-O', '--open-files-in-pager', '--upload-pack', '--receive-pack', '--exec') },
};

const sub = (word: Word, text: string): Word => ({ ...word, text });

/** What a long option stands for: itself, or the known ones it abbreviates (getopt takes a unique prefix) */
function longOptions(name: string, shape: Shape): string[] {
  const known = [shape.refused, shape.patternOpts, shape.patternFiles, shape.files, shape.values, shape.noPattern].flatMap((group) => [...(group ?? [])]);
  if (known.includes(name)) return [name];
  return known.filter((option) => option.startsWith('--') && option.startsWith(name));
}

/** The words of a command that may name a path, options' values included */
function pathWords(argv: readonly Word[], shape: Shape): { words: Word[]; refused: string | null } {
  const words: Word[] = [];
  const operands: Word[] = [];
  let ended = false;
  let patternGiven = false;
  let noPattern = false;
  /** What the options `names` (one, or the ones an abbreviation may stand for) do with their value */
  const apply = (names: readonly string[], value: () => Word | null): string | 'value' | null => {
    const refused = names.find((name) => shape.refused?.has(name));
    if (refused) return refused;
    if (names.some((name) => shape.noPattern?.has(name))) noPattern = true;
    if (names.some((name) => shape.patternFiles?.has(name) || shape.files?.has(name))) {
      if (names.some((name) => shape.patternFiles?.has(name))) patternGiven = true;
      const taken = value();
      if (taken) words.push(taken);
      return 'value';
    }
    if (names.some((name) => shape.patternOpts?.has(name))) {
      patternGiven = true;
      value();
      return 'value';
    }
    if (names.some((name) => shape.values?.has(name))) {
      value();
      return 'value';
    }
    return null;
  };
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i];
    if (!word) continue;
    const text = word.text;
    if (!ended && text === '--') {
      ended = true;
      continue;
    }
    if (ended || !text.startsWith('-') || text.length === 1) {
      operands.push(word);
      continue;
    }
    if (text.startsWith('--')) {
      const eq = text.indexOf('=');
      const name = eq > 0 ? text.slice(0, eq) : text;
      const inline = eq > 0 ? text.slice(eq + 1) : null;
      const found = apply(longOptions(name, shape), () => (inline !== null ? sub(word, inline) : (argv[++i] ?? null)));
      if (found !== null && found !== 'value') return { words, refused: found };
      // An option nobody listed, with a value attached: the value may be a path
      if (found === null && inline !== null) words.push(sub(word, inline));
      continue;
    }
    // A group of short options (`-rhf FILE`, `-ve.`), letter by letter as getopt reads it: the first
    // that takes a value takes the rest of the group, or the next word
    let taken = false;
    for (let k = 1; k < text.length && !taken; k++) {
      const rest = text.slice(k + 1);
      const found = apply([`-${text.charAt(k)}`], () => (rest !== '' ? sub(word, rest) : (argv[++i] ?? null)));
      if (found !== null && found !== 'value') return { words, refused: found };
      taken = found === 'value';
    }
    // `-f/data/x` of a command whose options are not known: its value may be attached
    if (!taken && text.length > 2 && text.includes('/')) words.push(sub(word, text.slice(2)));
  }
  if (shape.writesOperands) {
    const written = operands.find((operand) => operand.text !== '/dev/null');
    if (written) return { words, refused: `writing ${written.text}` };
  }
  if (shape.pattern && !patternGiven && !noPattern) operands.shift();
  return { words: [...words, ...operands], refused: null };
}

/** Whether a `git config` writes: a value it sets could name a program git runs later (`core.fsmonitor`) */
function gitConfigWrites(argv: readonly Word[]): boolean {
  const texts = argv.slice(1).map((word) => word.text);
  const at = texts.findIndex((text) => !text.startsWith('-'));
  if (at < 0 || texts[at] !== 'config') return false;
  return !texts.slice(at + 1).some((text) => ['--get', '--get-all', '--get-regexp', '--list', '-l', 'get', 'list'].includes(text));
}

/**
 * Whether a sed script only prints: commands made of an optional address or address range, an
 * optional `!`, and `p` (`1,20p`, `/start/,/end/p`, `$p`), separated by `;` or newlines.
 */
export function readOnlySedScript(script: string): boolean {
  const n = script.length;
  let i = 0;
  const at = (k: number): string => script.charAt(k);
  const blanks = (): void => {
    while (i < n && (at(i) === ' ' || at(i) === '\t')) i++;
  };
  const digits = (): boolean => {
    const from = i;
    while (i < n && /[0-9]/.test(at(i))) i++;
    return i > from;
  };
  const regex = (delimiter: string): boolean => {
    for (; i < n && at(i) !== delimiter; i++) {
      if (at(i) === '\n') return false;
      if (at(i) === '\\') i++;
    }
    if (i >= n) return false;
    i++;
    while (i < n && (at(i) === 'I' || at(i) === 'M')) i++;
    return true;
  };
  /** True when an address was read, false when it is malformed, null when there is none */
  const address = (second: boolean): boolean | null => {
    const ch = at(i);
    if (/[0-9]/.test(ch)) {
      digits();
      if (at(i) === '~') {
        i++;
        return digits();
      }
      return true;
    }
    if (ch === '$') {
      i++;
      return true;
    }
    if (ch === '/') {
      i++;
      return regex('/');
    }
    if (ch === '\\') {
      const delimiter = at(i + 1);
      if (delimiter === '' || delimiter === '\n' || delimiter === '\\') return false;
      i += 2;
      return regex(delimiter);
    }
    if (second && (ch === '+' || ch === '~')) {
      i++;
      return digits();
    }
    return null;
  };
  for (;;) {
    while (i < n && /[\s;]/.test(at(i))) i++;
    if (i >= n) return true;
    const first = address(false);
    if (first === false) return false;
    if (first) {
      blanks();
      if (at(i) === ',') {
        i++;
        blanks();
        if (address(true) !== true) return false;
      }
    }
    blanks();
    if (at(i) === '!') {
      i++;
      blanks();
    }
    if (at(i) !== 'p') return false;
    i++;
    blanks();
    if (i < n && at(i) !== ';' && at(i) !== '\n') return false;
  }
}

const SED_FLAGS = 'nErsuz';
const SED_LONG = new Set(['--quiet', '--silent', '--regexp-extended', '--separate', '--unbuffered', '--null-data', '--posix', '--sandbox', '--debug']);

/** sed in its read-only form: `-n`, scripts of addresses and `p`; the files it reads, or the block */
function checkSed(cmd: Cmd, where: string): { files: Word[] } | Block {
  const refuse = (what: string): Block =>
    block('sed', `${where}: sed ${what} can write or run something; only sed -n with a script of addresses and p is allowed`);
  let quiet = false;
  const scripts: string[] = [];
  const operands: Word[] = [];
  const argv = cmd.argv;
  let ended = false;
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i];
    if (!word) continue;
    const text = word.text;
    if (!ended && text === '--') ended = true;
    else if (!ended && text.startsWith('--')) {
      const eq = text.indexOf('=');
      const name = eq > 0 ? text.slice(0, eq) : text;
      if (name === '--expression') scripts.push(eq > 0 ? text.slice(eq + 1) : (argv[++i]?.text ?? ''));
      else if (!SED_LONG.has(name)) return refuse(name);
      else if (name === '--quiet' || name === '--silent') quiet = true;
    } else if (!ended && text.startsWith('-') && text.length > 1) {
      for (let k = 1; k < text.length; k++) {
        const letter = text.charAt(k);
        if (letter === 'e') {
          const rest = text.slice(k + 1);
          scripts.push(rest !== '' ? rest : (argv[++i]?.text ?? ''));
          break;
        }
        if (!SED_FLAGS.includes(letter)) return refuse(`-${letter}`);
        if (letter === 'n') quiet = true;
      }
    } else operands.push(word);
  }
  if (scripts.length === 0) {
    const script = operands.shift();
    if (script) scripts.push(script.text);
  }
  if (!quiet) return block('sed', `${where}: sed must run with -n and a script of addresses and p`);
  if (!scripts.every(readOnlySedScript)) return block('sed', `${where}: the sed script may only hold addresses and p (no s, w, r, e or other commands)`);
  return { files: operands };
}

const FIND_REFUSED = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls', '-files0-from', '-follow']);
const FIND_PATHS = new Set(['-newer', '-anewer', '-cnewer', '-samefile']);
const FIND_VALUES = new Set([
  '-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-lname', '-ilname', '-type', '-xtype',
  '-perm', '-user', '-group', '-size', '-mtime', '-atime', '-ctime', '-mmin', '-amin', '-cmin', '-maxdepth', '-mindepth',
  '-printf', '-fstype', '-uid', '-gid', '-links', '-inum', '-used', '-regextype', '-context',
]);

/** find without an action that runs, deletes or writes, and without following links out of the folder */
function checkFind(cmd: Cmd, where: string): { files: Word[] } | Block {
  const argv = cmd.argv;
  const files: Word[] = [];
  let i = 1;
  for (; i < argv.length; i++) {
    const text = argv[i]?.text ?? '';
    if (text === '-L') return block('find', `${where}: find -L follows links out of the working directory`);
    if (text === '-D' || text === '-O' || /^-O\d$/.test(text)) {
      if (text === '-D' || text === '-O') i++;
    } else if (text !== '-H' && text !== '-P') break;
  }
  for (; i < argv.length; i++) {
    const word = argv[i];
    if (!word || word.text.startsWith('-') || ['(', '!', ','].includes(word.text)) break;
    files.push(word);
  }
  for (; i < argv.length; i++) {
    const text = argv[i]?.text ?? '';
    if (FIND_REFUSED.has(text)) return block('find', `${where}: find ${text} can run, delete or write something, or reads paths from elsewhere`);
    const newer = /^-newer([a-zA-Z])([a-zA-Z])$/.exec(text);
    if (FIND_PATHS.has(text) || (newer && newer[2] !== 't')) {
      const value = argv[++i];
      if (value) files.push(value);
    } else if (FIND_VALUES.has(text) || newer) i++;
  }
  return { files };
}

const OUTPUT_OPS = new Set(['>', '>>', '>|', '&>', '&>>', '<>']);

function checkCommand(cmd: Cmd, ctx: RuleContext, declared: DeclaredTools, policy: Policy): Block | null {
  const text = cmd.argv.map((word) => word.text).join(' ');
  const where = `\`${snippet(text || cmd.raw)}\``;
  const words = [...cmd.orig, ...cmd.argv, ...cmd.assigns.map((assign) => assign.value), ...cmd.redirects.flatMap((r) => (r.target ? [r.target] : []))];
  if (words.some(expands)) return block('expansion', `${where}: a variable, command or process substitution cannot be checked in advance; write the value out`);
  for (const assign of cmd.assigns) {
    if (!SAFE_ENV.test(assign.name)) return block('assign', `${where}: setting ${assign.name} is not allowed in a confined chat`);
  }
  if (cmd.xargs) return block('xargs', `${where}: xargs takes its arguments from stdin, so the guard cannot check them`);
  if (cmd.findExec) return block('find', `${where}: a command run by find cannot be checked`);

  const head = cmd.argv[0];
  const base = head ? baseName(head.text) : '';
  if (head && !(DIRECTORY_COMMANDS.has(head.text))) {
    if (!policy.bash.some((rule) => matchesBashRule(rule, text))) return block('command', `${where} matches no declared Bash rule`);
  }

  // A wrapper the reader stripped (`sudo cat f`): only the ones Claude Code strips itself may stay undeclared
  if (head && cmd.orig !== cmd.argv && cmd.orig[0] !== head) {
    const start = cmd.orig.indexOf(head);
    const wrapper = cmd.orig.slice(0, start < 0 ? cmd.orig.length : start);
    const benign = wrapper.every((word) => word.text.startsWith('-') || WRAPPER_VALUE.test(word.text) || BENIGN_WRAPPERS.has(baseName(word.text)));
    const whole = cmd.orig.map((word) => word.text).join(' ');
    if (!benign && !policy.bash.some((rule) => matchesBashRule(rule, whole))) {
      return block('command', `\`${snippet(whole)}\`: the wrapper ${snippet(wrapper[0]?.text ?? '')} matches no declared Bash rule`);
    }
  }

  for (const redirect of cmd.redirects) {
    const target = redirect.target?.text ?? '';
    if (redirect.op === '<<' || redirect.op === '<<-') return block('heredoc', `${where}: here-documents are not allowed in a confined chat`);
    if (redirect.op === '<<<') continue;
    if ((redirect.op === '>&' || redirect.op === '<&') && /^(?:\d+-?|-)$/.test(target)) continue;
    if (OUTPUT_OPS.has(redirect.op) || redirect.op === '>&') {
      if (target !== '/dev/null') return block('redirect', `${where}: output may only be redirected to /dev/null`);
      continue;
    }
    if (redirect.target) {
      const found = checkPath(target, redirect.target.glob, cmd.cwd, ctx, declared, where);
      if (found) return found;
    }
  }
  if (!head) return null;

  let paths: Word[];
  if (base === 'sed') {
    const found = checkSed(cmd, where);
    if ('matcher' in found) return found;
    paths = found.files;
  } else if (base === 'find') {
    const found = checkFind(cmd, where);
    if ('matcher' in found) return found;
    paths = found.files;
  } else {
    if (base === 'git' && gitConfigWrites(cmd.argv)) return block('option', `${where}: git config may only read in a confined chat (--get, --list)`);
    const found = pathWords(cmd.argv, SHAPES[base] ?? {});
    if (found.refused) return block('option', `${where}: ${base} ${found.refused} runs a program, writes a file or reads outside the working directory`);
    paths = found.words;
  }
  for (const word of paths) {
    const found = checkPath(word.text, word.glob, cmd.cwd, ctx, declared, where);
    if (found) return found;
  }
  return null;
}

// ── File tools ───────────────────────────────────────────────────────────────────────────────────

const FILE_KEYS = ['file_path', 'notebook_path', 'path'];

function checkFileTool(ctx: RuleContext, declared: DeclaredTools): Block | null {
  const input = ctx.input.tool_input;
  const where = ctx.input.tool_name;
  const cwd = ctx.cwd ?? declared.root;
  for (const key of FILE_KEYS) {
    const value = input[key];
    if (typeof value !== 'string') continue;
    const found = checkPath(value, false, cwd, ctx, declared, where);
    if (found) return found;
  }
  const pattern = input.pattern;
  if (ctx.input.tool_name === 'Glob' && typeof pattern === 'string') {
    // Each alternative of a brace on its own (`{..,.}/**`), and a `..` after a wildcard (`**/../x`),
    // which no prefix check can place
    const items = expandBraces(pattern);
    if (items === null) return block('path', `${where}: the guard cannot tell which paths ${snippet(pattern)} names`);
    const base = typeof input.path === 'string' ? resolveLexical(input.path, cwd) : cwd;
    for (const item of items) {
      const parts = item.split('/');
      const wild = parts.findIndex((part) => GLOB_CHARS.test(part));
      if (wild >= 0 && parts.slice(wild).includes('..')) return block('path', `${where}: ${snippet(item)} climbs with .. after a wildcard`);
      if (item.startsWith('/') || item.startsWith('~') || parts.includes('..')) {
        const found = checkPath(staticPrefix(item) || '.', false, base, ctx, declared, where);
        if (found) return found;
      }
    }
  }
  return null;
}

export function declaredTools(ctx: RuleContext): Block | null {
  const declared = ctx.rules.declared;
  if (!declared) return null;
  const policy = policyOf(declared);
  const name = ctx.input.tool_name;
  if (declared.alwaysAllow.includes(name) || declared.allowPrefixes.some((prefix) => name.startsWith(prefix))) return null;
  if (!toolDeclared(name, policy)) return block('tool', `the tool ${snippet(name)} is not declared for this chat; declare it in its allowed tools`);

  if (ctx.tool.kind === 'bash') {
    for (const line of ctx.tool.commands) {
      if (rawExpands(line)) return block('expansion', `\`${snippet(line)}\`: a variable, command or process substitution cannot be checked in advance; write the value out`);
    }
    // xargs is named by its command below
    const scan = ctx.scans.find((item) => item.kind !== 'xargs');
    if (scan) {
      return block('opaque', `\`${snippet(scan.text)}\`: the guard cannot see what this runs (an interpreter, a script or a dynamic command)`);
    }
    for (const cmd of ctx.cmds) {
      const found = checkCommand(cmd, ctx, declared, policy);
      if (found) return found;
    }
  }
  return checkFileTool(ctx, declared);
}
