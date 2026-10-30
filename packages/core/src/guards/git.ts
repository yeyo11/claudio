/*
 * What the guard knows about git's command line: its verbs, the global options before the verb, how
 * short options cluster, and which configuration keys can run code or redirect a push. Only `node:`
 * imports.
 */

/** A word as the shell reader hands it over; a dynamic one has an expansion the guard cannot see */
export interface GitWord {
  text: string;
  dynamic: boolean;
}

/**
 * Git's built-in command list (`git help -a` of git 2.4x, frozen here), plus `lfs` and `subtree`,
 * which ship with git or beside it. Anything else is an alias or an external `git-foo` program.
 */
export const KNOWN_GIT_VERBS: ReadonlySet<string> = new Set(
  (
    'add add--interactive am annotate apply archive backfill bisect blame branch bugreport bundle cat-file check-attr check-ignore ' +
    'check-mailmap check-ref-format checkout checkout-index cherry cherry-pick citool clean clone column commit commit-graph ' +
    'commit-tree config count-objects credential credential-cache credential-store describe diagnose diff diff-files diff-index ' +
    'diff-tree difftool fast-export fast-import fetch fetch-pack filter-branch fmt-merge-msg for-each-ref for-each-repo ' +
    'format-patch fsck fsck-objects gc get-tar-commit-id grep gui hash-object help history hook index-pack init instaweb ' +
    'interpret-trailers last-modified lfs log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file ' +
    'merge-index merge-octopus merge-one-file merge-ours merge-recursive merge-resolve merge-subtree merge-tree mergetool mktag ' +
    'mktree multi-pack-index mv name-rev notes p4 pack-objects pack-redundant pack-refs patch-id prune prune-packed pull push ' +
    'range-diff read-tree rebase receive-pack reflog refs remote repack replace replay request-pull rerere reset restore rev-list ' +
    'rev-parse revert rm scalar send-email send-pack shell shortlog show show-branch show-index show-ref sparse-checkout stage stash ' +
    'status stripspace submodule subtree survey svn switch symbolic-ref tag unpack-file unpack-objects update-index update-ref ' +
    'update-server-info upload-archive upload-pack var verify-commit verify-pack verify-tag version web--browse whatchanged ' +
    'worktree write-tree'
  ).split(' '),
);

/** Global options that take a value, as the next word or after `=` */
const GLOBAL_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env', '--attr-source']);
/** Global options that only take a value after `=` */
const GLOBAL_OPTIONAL_VALUE = new Set(['--exec-path', '--list-cmds']);

export interface GitConfigSetting {
  key: string;
  value: string | null;
  /** `--config-env`: the value is the name of an environment variable */
  fromEnv: boolean;
}

export interface GitCall {
  /** The verb, or null when there is none (`git`, `git --version`) */
  verb: string | null;
  verbDynamic: boolean;
  /** The words after the verb */
  args: GitWord[];
  /** `-C` values, in order; each is relative to the one before */
  dirs: GitWord[];
  configs: GitConfigSetting[];
  gitDir: GitWord | null;
  workTree: GitWord | null;
}

/** Splits what comes after `git` into global options, the verb and its arguments */
export function parseGit(words: readonly GitWord[]): GitCall {
  const call: GitCall = { verb: null, verbDynamic: false, args: [], dirs: [], configs: [], gitDir: null, workTree: null };
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    if (!word) break;
    const text = word.text;
    if (word.dynamic && !text.startsWith('-')) {
      call.verb = text;
      call.verbDynamic = true;
      call.args = words.slice(i + 1) as GitWord[];
      return call;
    }
    if (!text.startsWith('-')) {
      call.verb = text;
      call.args = words.slice(i + 1) as GitWord[];
      return call;
    }
    const eq = text.indexOf('=');
    const name = eq > 0 && text.startsWith('--') ? text.slice(0, eq) : text;
    if (GLOBAL_VALUE_OPTIONS.has(name)) {
      let value: GitWord | undefined;
      if (name !== text) value = { text: text.slice(eq + 1), dynamic: word.dynamic };
      else if (!GLOBAL_OPTIONAL_VALUE.has(name)) {
        value = words[i + 1];
        i++;
      }
      if (value) {
        if (name === '-C') call.dirs.push(value);
        else if (name === '-c' || name === '--config-env') {
          const at = value.text.indexOf('=');
          const key = at < 0 ? value.text : value.text.slice(0, at);
          call.configs.push({ key, value: at < 0 ? null : value.text.slice(at + 1), fromEnv: name === '--config-env' });
        } else if (name === '--git-dir') call.gitDir = value;
        else if (name === '--work-tree') call.workTree = value;
      }
    }
    i++;
  }
  return call;
}

/** Whether `word` (before any `=value`) is an accepted abbreviation of the long option `full`, at least `min` characters long */
export function isLongOption(word: string, full: string, min = full.length): boolean {
  if (!word.startsWith('--')) return false;
  const eq = word.indexOf('=');
  const name = eq < 0 ? word : word.slice(0, eq);
  return name.length >= min && full.startsWith(name);
}

export interface ParsedFlags {
  /** Long options as written, with their `=value` */
  long: string[];
  /** Short flag letters, in the order seen, up to each cluster's first letter that takes a value */
  short: string[];
  positionals: GitWord[];
}

export interface FlagSpec {
  /** Short letters that take a value (the rest of the cluster, or the next word) */
  valueShort: string;
  /** Long options that take their value as the next word */
  valueLong?: readonly string[];
}

/** Reads a verb's arguments by git's own clustering rule: `-anm msg` is `-a -n -m msg` */
export function parseFlags(args: readonly GitWord[], spec: FlagSpec): ParsedFlags {
  const out: ParsedFlags = { long: [], short: [], positionals: [] };
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (!word) break;
    const text = word.text;
    if (text === '--') {
      out.positionals.push(...args.slice(i + 1));
      break;
    }
    if (text.startsWith('--')) {
      out.long.push(text);
      if (spec.valueLong?.includes(text)) i++;
    } else if (text.startsWith('-') && text.length > 1) {
      for (let j = 1; j < text.length; j++) {
        const letter = text.charAt(j);
        if (spec.valueShort.includes(letter)) {
          if (j === text.length - 1) i++;
          break;
        }
        out.short.push(letter);
      }
    } else out.positionals.push(word);
  }
  return out;
}

export const COMMIT_SPEC: FlagSpec = {
  valueShort: 'mFcCtSu',
  valueLong: ['--message', '--file', '--author', '--date', '--template', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--cleanup', '--trailer', '--pathspec-from-file'],
};
export const PUSH_SPEC: FlagSpec = { valueShort: 'o', valueLong: ['--push-option', '--receive-pack', '--exec', '--repo'] };
export const GENERIC_SPEC: FlagSpec = { valueShort: '' };

/** `--no-verify` and the abbreviations git accepts (at least `--no-ver`), or `--verify=false` */
export function isNoVerifyFlag(word: string): boolean {
  if (isLongOption(word, '--no-verify', 8)) return true;
  return /^--verify=(?:false|0|no|off)$/i.test(word);
}

const NO_VERIFY_VERBS = new Set(['commit', 'merge', 'rebase', 'am', 'push', 'cherry-pick', 'revert', 'pull']);

/** Whether a call to `verb` with `args` skips git hooks */
export function skipsHooks(verb: string, args: readonly GitWord[]): boolean {
  if (!NO_VERIFY_VERBS.has(verb)) return false;
  const flags = parseFlags(args, verb === 'commit' ? COMMIT_SPEC : verb === 'push' ? PUSH_SPEC : GENERIC_SPEC);
  if (flags.long.some(isNoVerifyFlag)) return true;
  // `-n` is `--no-verify` on commit only; on push it is `--dry-run`
  return verb === 'commit' && flags.short.includes('n');
}

const FORCE_LONG = ['--force', '--force-with-lease', '--force-if-includes', '--mirror', '--delete', '--prune'];

/** Whether `git push`/`git send-pack` arguments force, delete or mirror */
export function pushForces(args: readonly GitWord[], verb: 'push' | 'send-pack' = 'push'): boolean {
  const flags = parseFlags(args, PUSH_SPEC);
  if (flags.long.some((option) => FORCE_LONG.some((full) => isLongOption(option, full, full === '--force' ? 4 : 5)))) return true;
  if (flags.short.includes('f') || (verb === 'push' && flags.short.includes('d'))) return true;
  // Positionals are the remote, then refspecs: `+main` forces, `:main` deletes
  return flags.positionals.some((word) => word.text.startsWith('+') || word.text.startsWith(':'));
}

/** Whether `git reset` arguments carry `--hard` or an abbreviation of it */
export function resetsHard(args: readonly GitWord[]): boolean {
  return args.some((word) => isLongOption(word.text, '--hard', 4));
}

/**
 * Configuration keys that run code, move a push or change where git looks: `hooks-path` is the one
 * `no-verify` names; the rest belong to `integrity`.
 */
export function configKeyKind(rawKey: string): 'hooks-path' | 'other' | null {
  const key = rawKey.trim().toLowerCase();
  if (key === 'core.hookspath') return 'hooks-path';
  if (key.startsWith('alias.') || key === 'core.fsmonitor' || key === 'core.sshcommand' || key === 'include.path' || key.startsWith('includeif.')) return 'other';
  if (/^remote\..+\.(?:push|pushurl)$/.test(key)) return 'other';
  if (/^url\..+\.(?:pushinsteadof|insteadof)$/.test(key)) return 'other';
  if (/^credential(?:\..+)?\.helper$/.test(key)) return 'other';
  return null;
}

/** Sections whose removal or renaming drops keys {@link configKeyKind} knows */
export function configSectionKind(rawSection: string): 'hooks-path' | 'other' | null {
  const section = rawSection.trim().toLowerCase();
  if (section === 'core') return 'hooks-path';
  if (section === 'alias' || section === 'include' || section === 'includeif' || section === 'remote' || section === 'url' || section === 'credential') return 'other';
  if (/^(?:remote|url|credential|includeif)\./.test(section)) return 'other';
  return null;
}

export interface ConfigWrite {
  /** Keys or sections the call touches */
  keys: string[];
  sections: string[];
  /** `git config -e`: opens the config file in an editor */
  edit: boolean;
}

const CONFIG_READ_FLAGS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', '--get-color', '--get-colorbool', '--show-origin', '--show-scope', '--name-only']);

/** What a `git config` call writes; null when it only reads */
export function configWrite(args: readonly GitWord[]): ConfigWrite | null {
  const flags = parseFlags(args, { valueShort: 'f', valueLong: ['--file', '--blob', '--type', '--default'] });
  const longs = flags.long.map((flag) => flag.split('=')[0] ?? flag);
  if (longs.some((flag) => CONFIG_READ_FLAGS.has(flag)) || flags.short.includes('l')) return null;
  const positionals = flags.positionals.map((word) => word.text);
  const edit = flags.short.includes('e') || longs.includes('--edit');
  const writing = (name: string) => longs.includes(name);
  if (writing('--rename-section')) return { keys: [], sections: positionals.slice(0, 2), edit };
  if (writing('--remove-section')) return { keys: [], sections: positionals.slice(0, 1), edit };
  const unset = writing('--unset') || writing('--unset-all');
  const sub = positionals[0];
  // `git config set|unset|edit` (git 2.46)
  if (sub === 'set' || sub === 'unset') return { keys: positionals.slice(1, 2), sections: [], edit };
  if (sub === 'edit') return { keys: [], sections: [], edit: true };
  if (sub === 'get' || sub === 'list') return null;
  if (unset || writing('--add') || writing('--replace-all') || positionals.length >= 2) return { keys: positionals.slice(0, 1), sections: [], edit };
  return edit ? { keys: [], sections: [], edit } : null;
}

/** Environment names that change git's configuration or the programs it runs */
export function isGitConfigEnv(name: string): boolean {
  return /^GIT_CONFIG_(?:PARAMETERS|COUNT|GLOBAL|SYSTEM|NOSYSTEM|KEY_\d+|VALUE_\d+)$/.test(name) || name === 'GIT_EXEC_PATH' || name === 'GIT_SSH_COMMAND';
}
