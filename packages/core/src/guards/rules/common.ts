/*
 * What the rules share: the context one decision is made in, the paths a command writes, which
 * paths are protected, and the text scan used on input the reader cannot see.
 */
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import { type GitCall, type GitWord, parseGit } from '../git.ts';
import type { GuardRuleId, GuardRulesFile, HookInput, ToolView, WriteTarget } from '../input.ts';
import { expandBraces, globToRegExp, insideAny, isInside, realResolve, resolveLexical, segments, type Links } from '../paths.ts';
import { findSecrets } from '../secrets.ts';
import type { Assign, Cmd, Scan, Word } from '../shell.ts';

export interface Block {
  matcher: string;
  reason: string;
}

export interface RuleContext {
  rules: GuardRulesFile;
  enabled: ReadonlySet<GuardRuleId>;
  input: HookInput;
  tool: ToolView;
  cmds: Cmd[];
  scans: Scan[];
  links: Links;
  /** The directory the tool runs in */
  cwd: string | null;
  known: ReadonlySet<string>;
}

export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** A command cut to 120 characters, with anything that looks like a secret masked */
export function snippet(text: string): string {
  let out = text.replace(/\s+/g, ' ').trim();
  for (const match of findSecrets(out.length > 4096 ? out.slice(0, 4096) : out)) out = out.split(match.value).join('[redacted]');
  return out.length > 120 ? `${out.slice(0, 119)}…` : out;
}

/** The git call a command makes: `git …`, or `git-push …` run directly */
export function gitOf(cmd: Cmd): GitCall | null {
  const head = cmd.argv[0];
  if (!head) return null;
  const base = baseName(head.text);
  if (base === 'git') return parseGit(cmd.argv.slice(1));
  if (base.startsWith('git-') && base.length > 4) {
    return { verb: base.slice(4), verbDynamic: false, args: cmd.argv.slice(1) as GitWord[], dirs: [], configs: [], gitDir: null, workTree: null };
  }
  return null;
}

/** The words of a command that are not options, by the usual convention (`--` ends options) */
export function positionals(argv: readonly Word[], from: number, valueOpts: readonly string[] = []): Word[] {
  const out: Word[] = [];
  let ended = false;
  for (let i = from; i < argv.length; i++) {
    const word = argv[i];
    if (!word) continue;
    const text = word.text;
    if (!ended && text === '--') ended = true;
    else if (!ended && text.startsWith('-') && text.length > 1) {
      if (valueOpts.includes(text)) i++;
    } else out.push(word);
  }
  return out;
}

/** Whether an option cluster like `-rf` holds `letter` (long options are ignored) */
export function hasShort(argv: readonly Word[], letters: string, from = 1): boolean {
  for (let i = from; i < argv.length; i++) {
    const text = argv[i]?.text ?? '';
    if (text === '--') break;
    if (text.startsWith('-') && !text.startsWith('--') && [...text.slice(1)].some((letter) => letters.includes(letter))) return true;
  }
  return false;
}

export function hasLong(argv: readonly Word[], names: readonly string[], from = 1): boolean {
  for (let i = from; i < argv.length; i++) {
    const text = argv[i]?.text ?? '';
    if (text === '--') break;
    const name = text.includes('=') ? text.slice(0, text.indexOf('=')) : text;
    if (names.includes(name)) return true;
  }
  return false;
}

const GLOB_CHARS = /[*?[]/;

/** Lists the paths a glob names by reading the directories it walks, as the shell would (no dotfiles unless asked for) */
export function expandGlob(pattern: string): string[] {
  let paths = ['/'];
  for (const part of segments(pattern)) {
    const next: string[] = [];
    if (!GLOB_CHARS.test(part)) {
      for (const base of paths) next.push(posix.join(base, part));
    } else {
      const regex = globToRegExp(part === '**' ? '*' : part);
      for (const base of paths) {
        let names: string[];
        try {
          names = readdirSync(base);
        } catch {
          continue;
        }
        for (const name of names) {
          if (name.startsWith('.') && !part.startsWith('.')) continue;
          if (regex.test(name)) next.push(posix.join(base, name));
          if (next.length > 2000) break;
        }
      }
    }
    paths = next;
    if (paths.length === 0) break;
  }
  return paths;
}

/**
 * The real paths a word names, resolved from `cwd`; null when they cannot be known (a variable, a
 * command substitution, `~`, an unknown directory). `$TMPDIR` is the run's own scratch dir.
 */
export function targetPaths(word: Word, cwd: string | null, ctx: RuleContext, followLast: boolean): string[] | null {
  let text = word.text;
  if (word.dynamic) {
    const tmp = /^\$(?:\{TMPDIR\}|TMPDIR)((?:\/[^$`*?[{~]*)?)$/.exec(text);
    const tmpDir = ctx.rules.tmpDir;
    if (tmp && tmpDir && !(tmp[1] ?? '').split('/').includes('..')) text = tmpDir + (tmp[1] ?? '');
    else if (/[$`]/.test(text) || text.startsWith('~')) return null;
  }
  const items = expandBraces(text);
  if (items === null) return null;
  const out: string[] = [];
  for (const item of items) {
    const abs = resolveLexical(item, cwd);
    if (abs === null) return null;
    if (word.glob && GLOB_CHARS.test(item)) out.push(...expandGlob(abs).map((path) => realResolve(path, followLast, ctx.links)));
    else out.push(realResolve(abs, followLast || item.endsWith('/'), ctx.links));
  }
  return out;
}

/** A single known path, or null */
export function onePath(word: Word, cwd: string | null, ctx: RuleContext, followLast: boolean): string | null {
  const paths = targetPaths(word, cwd, ctx, followLast);
  return paths && paths.length === 1 ? (paths[0] ?? null) : null;
}

export function roots(ctx: RuleContext): string[] {
  return ctx.rules.roots;
}

/** Reads a small file inside the roots, for patches and the like */
export function readSmall(path: string, ctx: RuleContext): string | null {
  try {
    const real = realpathSync(path);
    if (!insideAny(real, ctx.rules.roots)) return null;
    const info = statSync(real);
    if (!info.isFile() || info.size > ctx.rules.limits.maxScriptBytes) return null;
    return readFileSync(real, 'utf8');
  } catch {
    return null;
  }
}

export interface WriteHit {
  kind: string;
  /** Real paths; null when unknown */
  paths: string[] | null;
  /** `chmod` that removes the executable bit */
  disables: boolean;
  raw: string;
}

const NULL_SINKS = /^\/dev\/(?:null|std(?:out|err|in)|fd\/\d+|tty)$/;

/** The modes `chmod` sets that stop a hook from running */
function chmodDisables(mode: string): boolean {
  if (/^[0-7]{3,4}$/.test(mode)) return [...mode.slice(-3)].every((digit) => (Number(digit) & 1) === 0);
  return /(?:^|,)[ugoa]*-[rwXst]*x/.test(mode) || /(?:^|,)[ugoa]*=[rwst]*(?:,|$)/.test(mode);
}

function patchTargets(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^\+\+\+ (\S+)/.exec(line);
    if (match?.[1] && match[1] !== '/dev/null') out.push(match[1].replace(/^[ab]\//, ''));
  }
  return out;
}

function gitDirectoryOf(call: GitCall, cwd: string | null): string | null {
  let dir = cwd;
  for (const word of call.dirs) {
    if (word.dynamic) return null;
    dir = resolveLexical(word.text, dir);
  }
  return dir;
}

/** Every path a simple command writes, moves, deletes or changes (the "Bash writes" list) */
export function bashWrites(cmd: Cmd, ctx: RuleContext): WriteHit[] {
  const hits: WriteHit[] = [];
  const add = (kind: string, words: readonly Word[], opts: { followLast?: boolean; cwd?: string | null; disables?: boolean } = {}): void => {
    for (const word of words) {
      if (cmd.findExec && word.text === '{}') continue;
      const paths = targetPaths(word, opts.cwd === undefined ? cmd.cwd : opts.cwd, ctx, opts.followLast ?? true);
      hits.push({ kind, paths, disables: opts.disables ?? false, raw: word.text });
    }
  };
  const addText = (kind: string, texts: readonly string[], cwd: string | null): void => {
    for (const text of texts) add(kind, [{ text, dynamic: false, glob: false, quoted: true }], { cwd });
  };

  for (const redirect of cmd.redirects) {
    const writes = ['>', '>>', '>|', '&>', '&>>', '<>'].includes(redirect.op) || (redirect.op === '>&' && redirect.target !== null && !/^(?:\d+|-)$/.test(redirect.target.text));
    if (!writes || !redirect.target || NULL_SINKS.test(redirect.target.text)) continue;
    add('redirect', [redirect.target]);
  }

  const head = cmd.argv[0];
  if (!head) return hits;
  const base = baseName(head.text);
  const args = cmd.argv;
  switch (base) {
    case 'tee': add('tee', positionals(args, 1)); break;
    case 'sed': {
      if (!hasShort(args, 'i') && !hasLong(args, ['--in-place'])) break;
      const scripted = hasShort(args, 'ef') || hasLong(args, ['--expression', '--file']);
      const rest = positionals(args, 1, ['-e', '-f', '--expression', '--file']);
      add('sed-i', scripted ? rest : rest.slice(1));
      break;
    }
    case 'perl': {
      if (!args.some((w) => /^-[A-Za-z]*i/.test(w.text))) break;
      add('perl-i', positionals(args, 1, ['-e', '-E']));
      break;
    }
    case 'dd': {
      for (const word of args.slice(1)) if (word.text.startsWith('of=')) add('dd', [{ ...word, text: word.text.slice(3) }]);
      break;
    }
    case 'truncate': add('truncate', positionals(args, 1, ['-s', '--size', '-r', '--reference'])); break;
    case 'cp': case 'install': case 'rsync': case 'mv': {
      const valueOpts = ['-t', '--target-directory', '-S', '--suffix', '-m', '--mode', '-o', '--owner', '-g', '--group', '-e', '--rsh', '--exclude', '--include', '-f', '--filter'];
      const target = args.findIndex((w) => w.text === '-t' || w.text === '--target-directory');
      const files = positionals(args, 1, base === 'install' || base === 'rsync' ? valueOpts.filter((o) => o !== '-f') : valueOpts.filter((o) => o !== '-f' && o !== '-e' && o !== '--rsh'));
      const targetWord = args[target + 1];
      if (target >= 0 && targetWord) add(base, [targetWord]);
      else if (files.length > 0) {
        add(base, files.slice(-1));
        if (base === 'mv') add('mv-source', files.slice(0, -1), { followLast: false });
      }
      for (const word of args) if (word.text.startsWith('--target-directory=')) add(base, [{ ...word, text: word.text.slice(19) }]);
      break;
    }
    case 'ln': {
      const files = positionals(args, 1, ['-t', '-S']);
      add('ln', files.slice(-1), { followLast: false });
      break;
    }
    case 'rm': case 'unlink': case 'shred': add('rm', positionals(args, 1), { followLast: false }); break;
    case 'chmod': case 'chown': case 'chgrp': {
      const modeAt = args.findIndex((w, k) => k > 0 && /^[-+][rwxXst]+(?:,.*)?$/.test(w.text));
      const files = positionals(args.filter((_w, k) => k !== modeAt), 1, ['--reference']);
      const mode = modeAt > 0 ? (args[modeAt]?.text ?? '') : (files[0]?.text ?? '');
      add('chmod', modeAt > 0 ? files : files.slice(1), { disables: base !== 'chmod' || chmodDisables(mode) });
      break;
    }
    case 'touch': add('touch', positionals(args, 1, ['-d', '-t', '-r', '--date', '--reference'])); break;
    case 'patch': {
      const files = positionals(args, 1, ['-i', '-p', '-d', '-o', '-r', '-F']);
      const inFile = args.findIndex((w) => w.text === '-i' || w.text === '--input');
      const input = cmd.redirects.find((r) => r.op === '<' && r.target)?.target;
      const patchWord = args[inFile + 1] ?? input;
      if (inFile < 0 && !input && files.length > 0) add('patch', files.slice(0, 1));
      else {
        let text = cmd.stdin;
        if (text === null && patchWord && !patchWord.dynamic) {
          const path = onePath(patchWord, cmd.cwd, ctx, true);
          text = path ? readSmall(path, ctx) : null;
        }
        if (text === null) hits.push({ kind: 'patch', paths: null, disables: false, raw: 'patch' });
        else addText('patch', patchTargets(text), cmd.cwd);
      }
      break;
    }
    case 'curl': {
      for (let i = 1; i < args.length; i++) {
        const t = args[i]?.text ?? '';
        const next = args[i + 1];
        if ((t === '-o' || t === '--output') && next) add('curl', [next]);
        else if (t.startsWith('--output=')) add('curl', [{ ...(args[i] as Word), text: t.slice(9) }]);
      }
      break;
    }
    case 'wget': {
      for (let i = 1; i < args.length; i++) {
        const t = args[i]?.text ?? '';
        const next = args[i + 1];
        if ((t === '-O' || t === '--output-document') && next) add('wget', [next]);
        else if (t === '-P' && next) add('wget', [next]);
      }
      break;
    }
    case 'tar': {
      const extracting = hasShort(args, 'x') || args.slice(1, 2).some((w) => /^[a-zA-Z]*x/.test(w.text) && !w.text.startsWith('-')) || hasLong(args, ['--extract', '--get']);
      if (!extracting) break;
      const at = args.findIndex((w) => w.text === '-C' || w.text === '--directory');
      add('tar', at >= 0 && args[at + 1] ? [args[at + 1] as Word] : [{ text: '.', dynamic: false, glob: false, quoted: true }]);
      break;
    }
    case 'unzip': {
      const at = args.findIndex((w) => w.text === '-d');
      if (at >= 0 && args[at + 1]) add('unzip', [args[at + 1] as Word]);
      break;
    }
    default: break;
  }

  const call = gitOf(cmd);
  if (call && !call.verbDynamic) {
    const dir = gitDirectoryOf(call, cmd.cwd);
    const rest = call.args;
    const dashAt = rest.findIndex((w) => w.text === '--');
    switch (call.verb) {
      case 'checkout': if (dashAt >= 0) add('git-checkout', rest.slice(dashAt + 1) as Word[], { cwd: dir }); break;
      case 'restore': add('git-restore', positionals(rest as Word[], 0, ['-s', '--source']), { cwd: dir }); break;
      case 'rm': add('git-rm', positionals(rest as Word[], 0), { cwd: dir, followLast: false }); break;
      case 'mv': add('git-mv', positionals(rest as Word[], 0), { cwd: dir, followLast: false }); break;
      case 'apply': {
        const files = positionals(rest as Word[], 0, ['-p', '-C', '--directory', '--include', '--exclude']);
        let text = cmd.stdin;
        if (text === null) {
          const parts: string[] = [];
          for (const file of files) {
            const path = file.dynamic ? null : onePath(file, dir, ctx, true);
            const content = path ? readSmall(path, ctx) : null;
            if (content === null) {
              parts.length = 0;
              text = null;
              break;
            }
            parts.push(content);
            text = parts.join('\n');
          }
        }
        if (text === null) hits.push({ kind: 'git-apply', paths: null, disables: false, raw: 'git apply' });
        else addText('git-apply', patchTargets(text), dir);
        break;
      }
      default: break;
    }
  }
  return hits;
}

/** The paths a write-like tool names, as real paths; null for a missing or unresolvable one */
export function toolPath(target: WriteTarget, ctx: RuleContext): string | null {
  if (target.path === null) return null;
  const abs = resolveLexical(target.path, ctx.cwd);
  return abs === null ? null : realResolve(abs, true, ctx.links);
}

export interface EnvAssign {
  name: string;
  value: Word;
  exported: boolean;
  cmd: Cmd;
  index: number;
}

const ENV_WORD = /^([A-Za-z_][A-Za-z0-9_]*)=/;

/** Variables a command line sets: assignments before a command, `env X=…`, `export X=…`, `declare -x X=…` */
export function envAssignments(cmds: readonly Cmd[]): EnvAssign[] {
  const out: EnvAssign[] = [];
  cmds.forEach((cmd, index) => {
    for (const assign of cmd.assigns as Assign[]) out.push({ name: assign.name, value: assign.value, exported: false, cmd, index });
    const head = baseName(cmd.argv[0]?.text ?? '');
    if (['export', 'declare', 'typeset', 'readonly', 'local', 'set'].includes(head)) {
      for (const word of cmd.argv.slice(1)) {
        const match = ENV_WORD.exec(word.text);
        if (match?.[1]) out.push({ name: match[1], value: { ...word, text: word.text.slice(match[0].length) }, exported: head === 'export' || head === 'declare' || head === 'typeset', cmd, index });
      }
    }
  });
  return out;
}

// ── Protected paths ──────────────────────────────────────────────────────────────────────────────

const SETTINGS_FILES = new Set(['settings.json', 'settings.local.json']);

function settingsInScope(dir: string, ctx: RuleContext): boolean {
  const scopes = [...ctx.rules.roots, ...(ctx.rules.mainCheckout ? [ctx.rules.mainCheckout] : [])];
  return scopes.some((scope) => isInside(dir, scope) || isInside(scope, dir));
}

/** Claudio's own state, Claude's settings and git's control files; the matcher id, or null */
export function protectedMatch(real: string, how: 'tool' | 'bash', ctx: RuleContext): string | null {
  const { rules } = ctx;
  const scratch = rules.tmpDir && isInside(real, rules.tmpDir);
  if (!scratch && insideAny(real, [rules.dataDir, rules.guardDir, ...rules.claudeConfigDirs])) return 'integrity.own-state';
  const base = baseName(real);
  const parent = posix.dirname(real);
  if (SETTINGS_FILES.has(base) && baseName(parent) === '.claude' && settingsInScope(posix.dirname(parent), ctx)) return 'integrity.claude-settings';
  const parts = segments(real);
  const git = parts.indexOf('.git');
  if (git >= 0) {
    const rest = parts.slice(git + 1).join('/');
    if (how === 'tool') {
      if (rest === 'COMMIT_EDITMSG' || rest === 'MERGE_MSG') return null;
      return 'integrity.git-control';
    }
    if (rest === 'config' || rest === 'config.worktree' || rest === 'info/attributes' || /^worktrees\/[^/]+\/config\.worktree$/.test(rest)) return 'integrity.git-control';
  }
  return null;
}

/** Whether a path is one of git's hook scripts, husky's, or the configured hooks directory */
export function isHookPath(real: string, ctx: RuleContext): boolean {
  const parts = segments(real);
  const git = parts.indexOf('.git');
  if (git >= 0 && (parts[git + 1] === 'hooks' || (parts[git + 1] === 'worktrees' && parts[git + 3] === 'hooks'))) return true;
  const husky = parts.indexOf('.husky');
  if (husky >= 0 && parts[husky + 1] !== '_') return true;
  const hooksDir = ctx.rules.hooksPathDir;
  return hooksDir !== null && isInside(real, hooksDir);
}

// ── Text scan ────────────────────────────────────────────────────────────────────────────────────

/** Statements of a text, each lower-cased with quotes, brackets and commas turned into spaces */
export function statements(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[;\n|&]+/)
    .map((part) => part.replace(/[\s"'`,[\]()]+/g, ' ').trim())
    .filter((part) => part !== '');
}

export function normalizedText(text: string): string {
  return text.toLowerCase().replace(/[\s"'`,[\]()]+/g, ' ');
}
