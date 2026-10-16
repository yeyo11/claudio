import type { LocalizedParams } from './types.ts';

/*
 * How risky one tool call is, from its name and input alone. A reading aid, not a control: it never
 * blocks anything (that is the guard hooks' job), so a miss costs a missing tag and a false alarm
 * costs a tag nobody needed. Pure string code with no Node imports, because the server (urgency
 * input, Step by step) and the transcript in the browser must score a call the same way, as
 * `notifications.ts` does for notifications. The tables below are data: when a pattern turns out
 * noisy it is tuned here, in one place.
 */

export type ToolRiskLevel = 'low' | 'medium' | 'high';

export type ToolRiskFactor =
  /** Deletes or discards what cannot be recovered from git or a rebuild */
  | 'irreversible'
  /** Force push, rebase, amend, filter-branch */
  | 'history-rewrite'
  /** Push, publish, deploy, a write request to a remote */
  | 'leaves-machine'
  /** sudo, su, doas, recursive chmod/chown */
  | 'privilege'
  /** Writes or deletes outside the chat's directory or worktree */
  | 'outside-workdir'
  /** Reads or prints credentials into the transcript */
  | 'secrets'
  /** Writes CI config, git internals, Claude settings, env files, keys */
  | 'sensitive-path'
  /** Globs, recursive flags or home/root targets on a destructive command */
  | 'wide-scope';

export interface ToolRisk {
  level: ToolRiskLevel;
  /** 0–100, for ordering only */
  score: number;
  /** Heaviest first, so the first one is the word a tag shows */
  factors: ToolRiskFactor[];
  /** One English line with the part of the input that made it fire, for state and logs */
  reason: string;
  /** `risk.<first factor>`, or `risk.none` when nothing fired */
  reasonCode: string;
  /** `{ command | path | tool }`, clipped */
  params?: LocalizedParams;
}

export interface ToolRiskContext {
  /** Absolute directory the chat works in; null when unknown, and then nothing is outside it */
  cwd: string | null;
  /** Further directories that count as inside: the task's worktree, the documents folder */
  roots?: readonly string[];
}

/** In declaration order, which breaks a tie between factors of the same weight */
const WEIGHTS: Record<ToolRiskFactor, number> = {
  irreversible: 70,
  'history-rewrite': 70,
  'leaves-machine': 60,
  privilege: 60,
  'outside-workdir': 45,
  secrets: 40,
  'sensitive-path': 35,
  'wide-scope': 25,
};
const FACTOR_ORDER = Object.keys(WEIGHTS) as ToolRiskFactor[];

const HIGH_FROM = 60;
const MEDIUM_FROM = 30;
/** Each factor after the heaviest adds this much: two things at once are worse than either */
const EXTRA_FACTOR = 10;
/** A name is a guess about an MCP tool, so it never reaches `high` */
const MCP_CAP = HIGH_FROM - 1;
/** Input past this is not read: a command that long is pasted data, and the scan must stay cheap */
const INPUT_MAX = 64 * 1024;
const EVIDENCE_MAX = 120;
const REASON_MAX = 300;
const PARAM_MAX = 200;

const FACTOR_TEXT: Record<ToolRiskFactor, string> = {
  irreversible: 'deletes or discards what git or a rebuild cannot bring back',
  'history-rewrite': 'rewrites git history',
  'leaves-machine': 'sends something off this machine',
  privilege: 'runs with elevated privileges',
  'outside-workdir': 'writes or deletes outside the working directory',
  secrets: 'reads credentials into the transcript',
  'sensitive-path': 'changes a file that controls CI, git, Claude settings or credentials',
  'wide-scope': 'reaches wide (a glob, a recursive flag, or a home or root path)',
};

/** Built by a build, so deleting them costs a rebuild, not work. The commonest false positive. */
const REGENERABLE = new Set(['node_modules', 'dist', 'build', 'out', '.next', '.turbo', 'coverage', 'target', '.cache', 'tmp', '.pytest_cache']);

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);

const MCP_IRREVERSIBLE = new Set(['delete', 'remove', 'drop', 'destroy', 'purge', 'revoke', 'terminate']);
const MCP_LEAVES = new Set(['create', 'update', 'write', 'send', 'post', 'publish', 'push', 'merge', 'deploy', 'comment', 'upload', 'set', 'execute', 'run']);
const MCP_READ = new Set(['get', 'list', 'read', 'search', 'fetch', 'query', 'describe']);

const EXAMPLE_ENV = new Set(['example', 'sample', 'template']);
const SECRET_DIRS = new Set(['.ssh', '.aws', '.gnupg']);
const SECRET_FILES = new Set(['.npmrc', '.pypirc', '.netrc']);
const SECRET_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx'];
const CI_FILES = new Set(['.gitlab-ci.yml', 'jenkinsfile', '.mcp.json']);
const CI_DIRS = new Set(['.circleci', '.husky']);

// ---------- paths ----------

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

const isWindowsPath = (path: string): boolean => /^[A-Za-z]:[\\/]/.test(path);

const isHomePath = (path: string): boolean => path === '~' || path.startsWith('~/') || /^\$\{?HOME\}?(\/|$)/.test(path);

const isAbsolute = (path: string): boolean => path.startsWith('/') || isWindowsPath(path) || isHomePath(path);

/** POSIX normalisation: no `.`, no `..` (past the root they are dropped, as the kernel does) */
function normalize(path: string): string {
  const absolute = path.startsWith('/');
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length) parts.pop();
      else if (!absolute) parts.push('..');
      continue;
    }
    parts.push(part);
  }
  return (absolute ? '/' : '') + parts.join('/');
}

function within(path: string, dir: string): boolean {
  const root = normalize(dir);
  return root === '/' || path === root || path.startsWith(`${root}/`);
}

type Placement = 'inside' | 'outside';

/**
 * Where a path points, from `base` (the directory a command is in by now). Anything that cannot be
 * known from the text, an unset variable or an unknown directory, is inside: a guess that something
 * is outside is a false alarm, and the tag must stay worth reading.
 */
function place(path: string, base: string | null, ctx: ToolRiskContext): Placement {
  if (ctx.cwd === null) return 'inside';
  if (isHomePath(path) || isWindowsPath(path)) return 'outside';
  if (path.includes('$') || path.includes('`')) return 'inside';
  if (!isAbsolute(path) && base === null) return 'inside';
  const resolved = path.startsWith('/') ? normalize(path) : normalize(`${base ?? ctx.cwd}/${path}`);
  return within(resolved, ctx.cwd) || (ctx.roots ?? []).some((root) => within(resolved, root)) ? 'inside' : 'outside';
}

function segmentsOf(path: string): string[] {
  return path
    .replaceAll('\\', '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.');
}

/** Credentials: what reading would put into a transcript */
export function isSecretPath(path: string): boolean {
  const segments = segmentsOf(path).map((s) => s.toLowerCase());
  return segments.some((segment, index) => {
    if (segment === '.env') return true;
    if (segment.startsWith('.env.')) return segment.includes('*') || !EXAMPLE_ENV.has(segment.slice(5));
    if (segment.startsWith('.env') && segment.includes('*')) return true;
    if (SECRET_DIRS.has(segment) || SECRET_FILES.has(segment)) return true;
    if (segment.startsWith('id_rsa') || segment.startsWith('id_ed25519')) return true;
    return index === segments.length - 1 && SECRET_EXTENSIONS.some((ext) => segment.endsWith(ext));
  });
}

/** Files that change what a build, git or the CLI does next: secrets, CI, git internals, Claude settings */
function isSensitivePath(path: string): boolean {
  if (isSecretPath(path)) return true;
  const segments = segmentsOf(path).map((s) => s.toLowerCase());
  const last = segments.length - 1;
  return segments.some((segment, index) => {
    if (segment === '.git') return index < last;
    if (CI_DIRS.has(segment)) return true;
    if (segment === '.github') return segments[index + 1] === 'workflows';
    if (segment === '.claude') return segments[index + 1] === 'settings.json' || segments[index + 1] === 'settings.local.json';
    return index === last && CI_FILES.has(segment);
  });
}

// ---------- shell ----------

interface Token {
  text: string;
  /** Any part of it was quoted: then it is data, never a flag */
  quoted: boolean;
  /** Any part of it was single-quoted: the shell expands nothing in it */
  literal: boolean;
}

/**
 * Heredoc bodies are text for another program; scoring a commit message or a pasted script as if it
 * ran would flag the commonest harmless commands. A body with no terminator runs to the end, as in
 * the shell.
 */
function stripHeredocs(source: string): string {
  const operator = /(?<!<)<<(?!<)-?[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z_]\w*))/g;
  let out = '';
  let pos = 0;
  for (;;) {
    operator.lastIndex = pos;
    const match = operator.exec(source);
    if (!match) return out + source.slice(pos);
    const word = match[1] ?? match[2] ?? match[3] ?? '';
    const lineEnd = source.indexOf('\n', match.index + match[0].length);
    if (lineEnd < 0) return out + source.slice(pos);
    out += source.slice(pos, lineEnd + 1);
    let p = lineEnd + 1;
    while (p < source.length) {
      const end = source.indexOf('\n', p);
      const line = source.slice(p, end < 0 ? source.length : end);
      p = end < 0 ? source.length : end + 1;
      if (line.trim() === word) break;
    }
    pos = p;
  }
}

/**
 * Splits a command on `&&`, `||`, `;`, `|`, a lone `&`, newlines, parentheses and backticks, and
 * each segment into words. Quoted text stays inside its word, so `echo "rm -rf /"` is an `echo`
 * with one argument and never an `rm`.
 */
function segmentize(source: string): Token[][] {
  const segments: Token[][] = [];
  let tokens: Token[] = [];
  let text = '';
  let started = false;
  let quoted = false;
  let literal = false;
  const endToken = () => {
    if (started) tokens.push({ text, quoted, literal });
    text = '';
    started = false;
    quoted = false;
    literal = false;
  };
  const endSegment = () => {
    endToken();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };
  const n = source.length;
  for (let i = 0; i < n; i++) {
    const c = source.charAt(i);
    if (c === "'") {
      started = quoted = literal = true;
      const close = source.indexOf("'", i + 1);
      const end = close < 0 ? n : close;
      text += source.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      started = quoted = true;
      for (i++; i < n && source.charAt(i) !== '"'; i++) {
        // Inside double quotes a backslash only escapes these; elsewhere it is itself (a Windows path)
        if (source.charAt(i) === '\\' && i + 1 < n && '$`"\\\n'.includes(source.charAt(i + 1))) i++;
        text += source.charAt(i);
      }
    } else if (c === '\\') {
      const next = source.charAt(i + 1);
      i++;
      if (next !== '\n' && next !== '') {
        started = true;
        text += next;
      }
    } else if (c === ' ' || c === '\t' || c === '\r') endToken();
    else if (c === '#' && !started) {
      const eol = source.indexOf('\n', i);
      i = eol < 0 ? n : eol - 1;
    } else if (c === '\n' || c === ';' || c === '(' || c === ')' || c === '`') endSegment();
    else if (c === '|') {
      endSegment();
      if (source.charAt(i + 1) === '|') i++;
    } else if (c === '&') {
      const redirect = source.charAt(i - 1) === '>' || source.charAt(i - 1) === '<' || source.charAt(i + 1) === '>';
      if (redirect) {
        started = true;
        text += c;
      } else {
        endSegment();
        if (source.charAt(i + 1) === '&') i++;
      }
    } else {
      started = true;
      text += c;
    }
  }
  endSegment();
  return segments;
}

const isFlag = (t: Token): boolean => !t.quoted && t.text.length > 1 && t.text.startsWith('-');

/** The words that are not flags; everything after a bare `--` is one whatever it looks like */
function positionals(args: readonly Token[]): Token[] {
  const out: Token[] = [];
  let ended = false;
  for (const t of args) {
    if (!ended && !t.quoted && t.text === '--') ended = true;
    else if (ended || !isFlag(t)) out.push(t);
  }
  return out;
}

const hasLong = (args: readonly Token[], name: string): boolean => args.some((t) => !t.quoted && (t.text === `--${name}` || t.text.startsWith(`--${name}=`)));

/** A letter in any short-flag cluster (`-rf` has `r` and `f`); a word with a hyphen in it (`-auto-approve`) is a long flag spelt with one dash */
const hasShort = (args: readonly Token[], letter: string): boolean => args.some((t) => isFlag(t) && /^-[A-Za-z0-9]+$/.test(t.text) && t.text.slice(1).includes(letter));

const isRecursive = (args: readonly Token[]): boolean => hasShort(args, 'r') || hasShort(args, 'R') || hasLong(args, 'recursive');

/** Nothing happens in a dry run, so nothing is scored */
const isDryRun = (args: readonly Token[], shortN: boolean): boolean => hasLong(args, 'dry-run') || (shortN && hasShort(args, 'n'));

/** Drops flags that take a value, along with that value, so it is not mistaken for a word */
function withoutFlagValues(args: readonly Token[], flagsWithValue: ReadonlySet<string>): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (!t) continue;
    if (!t.quoted && flagsWithValue.has(t.text)) i++;
    else out.push(t);
  }
  return out;
}

interface Unwrapped {
  command: string | null;
  args: Token[];
  privilege: boolean;
  /** `env` or a variable assignment stood alone, which prints the environment */
  envOnly: boolean;
  viaXargs: boolean;
  /** `su -c '<this>'`: a command line of its own, to be scored in turn */
  inner: string | null;
}

const SUDO_VALUE_FLAGS = new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-R', '-r', '-t', '-T', '-U']);
const XARGS_VALUE_FLAGS = new Set(['-I', '-n', '-P', '-d', '-s', '-L', '-E', '-a']);
const ENV_VALUE_FLAGS = new Set(['-u', '-C', '-S']);

/** Strips what only decorates a command (variables, `timeout N`, `time`, `nice`, `env`) and notes `sudo` and its kin */
function unwrap(tokens: readonly Token[]): Unwrapped {
  let privilege = false;
  let viaXargs = false;
  let sawEnv = false;
  let i = 0;
  const skipFlags = (valueFlags: ReadonlySet<string>) => {
    for (; i < tokens.length; i++) {
      const t = tokens[i];
      if (!t || !isFlag(t)) return;
      if (valueFlags.has(t.text)) i++;
    }
  };
  for (; i < tokens.length; ) {
    const t = tokens[i];
    if (!t) break;
    if (!t.quoted && /^[A-Za-z_]\w*=/.test(t.text)) {
      i++;
      continue;
    }
    const name = t.quoted ? '' : basename(t.text);
    if (name === 'time' || name === 'nohup' || name === 'command' || name === 'exec') {
      i++;
      skipFlags(new Set());
    } else if (name === 'timeout') {
      i++;
      skipFlags(new Set(['-s', '-k']));
      i++;
    } else if (name === 'nice') {
      i++;
      skipFlags(new Set(['-n']));
    } else if (name === 'env') {
      sawEnv = true;
      i++;
      skipFlags(ENV_VALUE_FLAGS);
    } else if (name === 'sudo' || name === 'doas') {
      privilege = true;
      i++;
      skipFlags(SUDO_VALUE_FLAGS);
    } else if (name === 'xargs') {
      viaXargs = true;
      i++;
      skipFlags(XARGS_VALUE_FLAGS);
    } else if (name === 'su') {
      const rest = tokens.slice(i + 1);
      const at = rest.findIndex((x) => !x.quoted && (x.text === '-c' || x.text === '--command'));
      const inner = at >= 0 ? (rest[at + 1]?.text ?? null) : null;
      return { command: 'su', args: rest, privilege: true, envOnly: false, viaXargs, inner };
    } else break;
  }
  const head = tokens[i];
  if (!head) return { command: null, args: [], privilege, envOnly: sawEnv, viaXargs, inner: null };
  return { command: basename(head.text), args: tokens.slice(i + 1), privilege, envOnly: false, viaXargs, inner: null };
}

type Hits = Map<ToolRiskFactor, string>;

interface ShellState {
  /** The directory the command is in by now: the chat's, until a `cd` moves it; null once unknowable */
  base: string | null;
}

/**
 * A `cd` moves what later relative paths mean; to a directory the text cannot name, nothing is
 * known. Home and a drive are not the chat's directory, which is all a later path needs to know.
 */
function change(state: ShellState, args: readonly Token[]): void {
  const target = positionals(args)[0]?.text;
  if (target === undefined || isHomePath(target)) state.base = '/~';
  else if (target === '-' || target.includes('$') || target.includes('`')) state.base = null;
  else if (target.startsWith('/')) state.base = normalize(target);
  else if (isWindowsPath(target)) state.base = '/C:';
  else state.base = state.base === null ? null : normalize(`${state.base}/${target}`);
}

const isRegenerable = (path: string): boolean => {
  const parts = path.replace(/\/+$/, '').split('/');
  let last = parts.pop() ?? '';
  if (last === '*') last = parts.pop() ?? '';
  return REGENERABLE.has(last);
};

/** A target that goes up, to the root or home, or matches by glob: the call reaches wider than one named thing */
function isWideTarget(text: string): boolean {
  return text.includes('*') || text === '/' || isHomePath(text) || text === '..' || text.startsWith('../') || text.includes('/../') || text.endsWith('/..');
}

const SQL_COMMANDS = new Set(['psql', 'sqlite3', 'mysql', 'mariadb']);

function sqlDestroys(text: string): boolean {
  if (/\bdrop\s+(table|database|schema)\b/i.test(text) || /\btruncate\s+table\b/i.test(text)) return true;
  return text.split(';').some((statement) => /\bdelete\s+from\b/i.test(statement) && !/\bwhere\b/i.test(statement));
}

const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const SSH_VALUE_FLAGS = new Set(['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w']);
const GH_VALUE_FLAGS = new Set(['-R', '--repo', '-H', '--hostname']);
const CONTAINER_NAMES = new Set(['container', 'image', 'volume', 'network']);
const WRITE_METHODS = /^(post|put|patch|delete)$/i;
/** `host:` or `user@host:` of scp and rsync; a drive letter or a URL is not one */
const REMOTE_ARGUMENT = /^(?:[^\s/@:]+@)?[A-Za-z0-9][A-Za-z0-9._-]+:(?!\/\/)/;

/** Whether `curl` was told to send something: a method that writes, a body, a form or an upload */
function curlSends(args: readonly Token[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (!t || t.quoted || !t.text.startsWith('-')) continue;
    if (t.text.startsWith('--')) {
      const name = t.text.split('=')[0] ?? '';
      if (name === '--data' || name.startsWith('--data-') || name === '--form' || name.startsWith('--form-') || name === '--upload-file') return true;
      if (name === '--request') {
        const method = t.text.includes('=') ? t.text.slice(name.length + 1) : (args[i + 1]?.text ?? '');
        if (WRITE_METHODS.test(method)) return true;
      }
      continue;
    }
    // A short cluster ends at the first flag that takes a value, which is the rest of the word
    for (let k = 1; k < t.text.length; k++) {
      const letter = t.text.charAt(k);
      if (letter === 'd' || letter === 'F' || letter === 'T') return true;
      if (letter === 'X') {
        const method = k + 1 < t.text.length ? t.text.slice(k + 1) : (args[i + 1]?.text ?? '');
        if (WRITE_METHODS.test(method)) return true;
        break;
      }
      if ('HouAemwbcKxEYyzr'.includes(letter)) break;
    }
  }
  return false;
}

/** Whether the arguments of `gh api` write: a method that writes, or a field */
function ghApiWrites(args: readonly Token[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (!t || t.quoted) continue;
    if (t.text === '-f' || t.text === '-F' || t.text === '--field' || t.text === '--raw-field') return true;
    if (t.text.startsWith('--field=') || t.text.startsWith('--raw-field=')) return true;
    if (t.text === '-X' || t.text === '--method') {
      if (WRITE_METHODS.test(args[i + 1]?.text ?? '')) return true;
    } else if (t.text.startsWith('-X') && WRITE_METHODS.test(t.text.slice(2))) return true;
    else if (t.text.startsWith('--method=') && WRITE_METHODS.test(t.text.slice(9))) return true;
  }
  return false;
}

function scanGit(args: readonly Token[], hit: (factor: ToolRiskFactor) => void): void {
  const rest: Token[] = [];
  let sub: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (!t) continue;
    if (sub !== null) rest.push(t);
    else if (!t.quoted && GIT_VALUE_FLAGS.has(t.text)) i++;
    else if (!isFlag(t)) sub = t.text;
  }
  const words = positionals(rest).map((t) => t.text);
  switch (sub) {
    case 'reset':
      if (hasLong(rest, 'hard')) hit('irreversible');
      break;
    case 'clean':
      if ((hasShort(rest, 'f') || hasLong(rest, 'force')) && !isDryRun(rest, true)) hit('irreversible');
      break;
    case 'branch':
      if (hasShort(rest, 'D') || (hasLong(rest, 'delete') && hasLong(rest, 'force'))) hit('irreversible');
      break;
    case 'checkout':
      if (rest.some((t) => !t.quoted && t.text === '--') && words.includes('.')) hit('irreversible');
      else if (words.length === 1 && words[0] === '.') hit('irreversible');
      break;
    case 'restore':
      if (words.includes('.') && (!hasLong(rest, 'staged') || hasLong(rest, 'worktree'))) hit('irreversible');
      break;
    case 'stash':
      if (words[0] === 'drop' || words[0] === 'clear') hit('irreversible');
      break;
    case 'push':
      if (isDryRun(rest, true)) break;
      hit('leaves-machine');
      if (hasLong(rest, 'force') || hasLong(rest, 'force-with-lease') || hasLong(rest, 'force-if-includes') || hasShort(rest, 'f') || words.some((w) => w.startsWith('+'))) hit('history-rewrite');
      break;
    case 'rebase':
    case 'filter-branch':
    case 'filter-repo':
      hit('history-rewrite');
      break;
    case 'commit':
      if (hasLong(rest, 'amend')) hit('history-rewrite');
      break;
  }
}

/** The factors one command word and its arguments fire, before the privilege and the width are added */
function scanCommand(unwrapped: Unwrapped, state: ShellState, ctx: ToolRiskContext, hit: (factor: ToolRiskFactor) => void): void {
  const { command, args } = unwrapped;
  if (command === null) {
    if (unwrapped.envOnly) hit('secrets');
    return;
  }
  const words = positionals(args);
  const texts = words.map((t) => t.text);
  switch (command) {
    case 'cd':
      change(state, args);
      return;
    case 'rm': {
      let outside = false;
      let regenerable = words.length > 0;
      for (const t of words) {
        const placement = place(t.text, state.base, ctx);
        if (placement === 'outside') outside = true;
        if (placement === 'outside' || t.text.includes('$') || !isRegenerable(t.text)) regenerable = false;
      }
      if (outside) {
        hit('irreversible');
        hit('outside-workdir');
      } else if (isRecursive(args) && !regenerable) hit('irreversible');
      return;
    }
    case 'shred':
    case 'truncate':
      hit('irreversible');
      return;
    case 'find':
      if (args.some((t) => !t.quoted && t.text === '-delete')) hit('irreversible');
      return;
    case 'dd':
      if (args.some((t) => t.text.startsWith('of='))) hit('irreversible');
      return;
    case 'su':
      return;
    case 'git':
      scanGit(args, hit);
      return;
    case 'chmod':
    case 'chown':
      if (isRecursive(args) || (command === 'chmod' && texts[0] === '777')) hit('privilege');
      return;
    case 'cat':
    case 'less':
    case 'head':
    case 'tail':
      if (texts.some(isSecretPath)) hit('secrets');
      return;
    case 'printenv':
      hit('secrets');
      return;
    case 'echo':
    case 'printf':
      if (args.some((t) => !t.literal && /\$\{?[A-Za-z0-9_]*(TOKEN|KEY|SECRET)[A-Za-z0-9_]*/.test(t.text))) hit('secrets');
      return;
    case 'npm':
    case 'pnpm':
    case 'yarn':
      if ((texts[0] === 'publish' || (command === 'yarn' && texts[0] === 'npm' && texts[1] === 'publish')) && !isDryRun(args, false)) hit('leaves-machine');
      return;
    case 'docker': {
      const [first, second] = texts;
      if (first === 'push') hit('leaves-machine');
      else if (first === 'rm' || first === 'rmi' || (first === 'system' && second === 'prune') || (first !== undefined && CONTAINER_NAMES.has(first) && (second === 'rm' || second === 'prune'))) hit('irreversible');
      return;
    }
    case 'kubectl': {
      const verbs = texts.slice(0, 3);
      if (isDryRun(args, false)) return;
      if (verbs.includes('delete')) hit('irreversible');
      else if (verbs.includes('apply')) hit('leaves-machine');
      return;
    }
    case 'terraform':
      if (texts[0] === 'destroy') hit('irreversible');
      else if (texts[0] === 'apply') hit('leaves-machine');
      return;
    case 'gh': {
      const pos = positionals(withoutFlagValues(args, GH_VALUE_FLAGS)).map((t) => t.text);
      const [group, verb] = pos;
      if (group === 'pr' && ['create', 'merge', 'comment', 'review'].includes(verb ?? '')) hit('leaves-machine');
      else if (group === 'release' && verb === 'create') hit('leaves-machine');
      else if (group === 'issue' && (verb === 'create' || verb === 'comment')) hit('leaves-machine');
      else if (group === 'api' && ghApiWrites(args)) hit('leaves-machine');
      return;
    }
    case 'glab': {
      const [group, verb] = texts;
      if (group === 'mr' && ['create', 'merge', 'note'].includes(verb ?? '')) hit('leaves-machine');
      else if (group === 'release' && verb === 'create') hit('leaves-machine');
      return;
    }
    case 'curl':
      if (curlSends(args)) hit('leaves-machine');
      return;
    case 'wget':
      if (args.some((t) => !t.quoted && t.text.startsWith('--post-'))) hit('leaves-machine');
      return;
    case 'scp':
      if (texts.some((t) => REMOTE_ARGUMENT.test(t))) hit('leaves-machine');
      return;
    case 'rsync':
      if (!isDryRun(args, true) && texts.some((t) => REMOTE_ARGUMENT.test(t))) hit('leaves-machine');
      return;
    case 'ssh':
      // A host alone opens a shell for a person; a host and a command runs something there
      if (positionals(withoutFlagValues(args, SSH_VALUE_FLAGS)).length >= 2) hit('leaves-machine');
      return;
    case 'aws':
      if (texts[0] === 's3' && ['cp', 'sync', 'rm', 'mv'].includes(texts[1] ?? '') && texts.some((t) => t.startsWith('s3://'))) hit('leaves-machine');
      return;
  }
  if (command === 'mkfs' || command.startsWith('mkfs.')) hit('irreversible');
  else if (SQL_COMMANDS.has(command) && sqlDestroys(args.map((t) => t.text).join(' '))) hit('irreversible');
}

const MAX_NESTING = 2;

function scanBash(source: string, ctx: ToolRiskContext): Hits {
  const hits: Hits = new Map();
  const state: ShellState = { base: ctx.cwd };
  const scan = (text: string, privileged: boolean, depth: number) => {
    for (const tokens of segmentize(stripHeredocs(text))) {
      const unwrapped = unwrap(tokens);
      const evidence = clip(tokens.map((t) => t.text).join(' '), EVIDENCE_MAX);
      const segment = new Set<ToolRiskFactor>();
      const hit = (factor: ToolRiskFactor) => {
        segment.add(factor);
        if (!hits.has(factor)) hits.set(factor, evidence);
      };
      if (unwrapped.privilege || privileged) hit('privilege');
      scanCommand(unwrapped, state, ctx, hit);
      // Width only matters on a command that is already destructive or privileged
      if (segment.has('irreversible') || segment.has('privilege')) {
        if (unwrapped.viaXargs || isRecursive(unwrapped.args) || unwrapped.args.some((t) => isWideTarget(t.text))) hit('wide-scope');
      }
      if (unwrapped.inner !== null && depth < MAX_NESTING) scan(unwrapped.inner, true, depth + 1);
    }
  };
  scan(source, false, 0);
  return hits;
}

// ---------- the other tools ----------

const stringOf = (value: unknown): string => (typeof value === 'string' ? value.slice(0, INPUT_MAX) : '');

/** The segment a name is judged by: its first word that is a verb the tables know */
function mcpVerb(tool: string): 'irreversible' | 'leaves-machine' | 'read' | null {
  const words = tool
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_\-.\s]+/);
  for (const word of words) {
    if (MCP_IRREVERSIBLE.has(word)) return 'irreversible';
    if (MCP_LEAVES.has(word)) return 'leaves-machine';
    if (MCP_READ.has(word)) return 'read';
  }
  return null;
}

function scanEdit(path: string, ctx: ToolRiskContext, hits: Hits): void {
  if (!path) return;
  if (place(path, ctx.cwd, ctx) === 'outside') hits.set('outside-workdir', path);
  if (isSensitivePath(path)) hits.set('sensitive-path', path);
}

function build(hits: Hits, options: { cap?: boolean; floor?: boolean; params?: LocalizedParams }): ToolRisk {
  // `wide-scope` only ever adds to another factor; on its own it is not a risk
  if (hits.size === 1 && hits.has('wide-scope')) hits.clear();
  const factors = [...hits.keys()].sort((a, b) => WEIGHTS[b] - WEIGHTS[a] || FACTOR_ORDER.indexOf(a) - FACTOR_ORDER.indexOf(b));
  const first = factors[0];
  if (first === undefined) return { level: 'low', score: 0, factors: [], reason: 'No risk factor matched', reasonCode: 'risk.none', ...(options.params ? { params: options.params } : {}) };
  let score = Math.min(100, WEIGHTS[first] + EXTRA_FACTOR * (factors.length - 1));
  // A file written outside the working directory is the clearest case of a call that leaves the
  // chat's sandbox, and no other factor decides it: it reads as high on its own
  if (options.floor && hits.has('outside-workdir')) score = Math.max(score, HIGH_FROM);
  if (options.cap) score = Math.min(score, MCP_CAP);
  const reason = clip(factors.map((f) => `${FACTOR_TEXT[f]} (${hits.get(f) ?? ''})`).join('; '), REASON_MAX);
  return {
    level: score >= HIGH_FROM ? 'high' : score >= MEDIUM_FROM ? 'medium' : 'low',
    score,
    factors,
    reason,
    reasonCode: `risk.${first}`,
    ...(options.params ? { params: options.params } : {}),
  };
}

/**
 * Scores one tool call. `Bash` is read as shell words, the file tools by their path, MCP tools by the
 * verb in their name; every other tool is `low`. Only the first 64 KiB of an input is read.
 */
export function toolRisk(call: { name: string; input: Record<string, unknown> }, ctx: ToolRiskContext): ToolRisk {
  const { name, input } = call;
  const hits: Hits = new Map();
  if (name === 'Bash') {
    const command = stringOf(input.command);
    for (const [factor, evidence] of scanBash(command, ctx)) hits.set(factor, evidence);
    return build(hits, { params: { command: clip(command, PARAM_MAX) } });
  }
  if (EDIT_TOOLS.has(name)) {
    const path = stringOf(input.file_path) || stringOf(input.notebook_path);
    scanEdit(path, ctx, hits);
    return build(hits, { floor: true, params: { path: clip(path, PARAM_MAX) } });
  }
  if (READ_TOOLS.has(name)) {
    // A Grep pattern is a regular expression, not a path; its `glob` and `path` are
    const candidates = [stringOf(input.file_path), stringOf(input.path), stringOf(input.glob), name === 'Glob' ? stringOf(input.pattern) : ''];
    const secret = candidates.find((c) => c !== '' && isSecretPath(c));
    if (secret !== undefined) hits.set('secrets', secret);
    return build(hits, { params: { path: clip(candidates.find((c) => c !== '') ?? '', PARAM_MAX) } });
  }
  if (name.startsWith('mcp__')) {
    const tool = name.split('__').slice(2).join('__');
    const verb = mcpVerb(tool);
    if (verb === 'irreversible' || verb === 'leaves-machine') hits.set(verb, name);
    return build(hits, { cap: true, params: { tool: clip(name, PARAM_MAX) } });
  }
  return build(hits, {});
}
