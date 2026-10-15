import type { SecretVault } from '../secret-vault.ts';

/**
 * Claude's own credentials: the terminal is the person's shell, and an agent's sign-in is not theirs
 * to read from it. Always removed, whatever the vault or the container holds.
 */
export const CLAUDE_CREDENTIALS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

/** The vault's tools whose credentials the person's own `gh`, `glab` and tracker CLIs need. Never Claude Code's. */
export const TERMINAL_VAULT_TOOLS = ['gh', 'glab', 'youtrack'] as const;

/**
 * What the server's environment holds that a shell must not inherit: the server's own switches
 * (`ELECTRON_RUN_AS_NODE` would make a `node` started from the shell behave as Electron), the
 * development runner's noise, the `production` the image sets (the person's `pnpm install` would
 * skip dev dependencies) and the AppImage runtime's own variables.
 */
const DROPPED = new Set(['ELECTRON_RUN_AS_NODE', 'NODE_ENV', 'INIT_CWD', 'APPIMAGE', 'APPDIR', 'ARGV0', 'OWD', ...CLAUDE_CREDENTIALS]);
const DROPPED_PREFIXES = ['CLAUDIO_', 'npm_', 'PNPM_', 'pnpm_'];
/** Variables that hold search paths, which may point into the AppImage's mount */
const PATH_LISTS = ['PATH', 'LD_LIBRARY_PATH'] as const;

export interface TerminalEnvOptions {
  /** The server's environment: `process.env` unless a test gives its own */
  base?: NodeJS.ProcessEnv;
  /** Where the vault's tool credentials come from; none adds nothing */
  vault?: Pick<SecretVault, 'get'> | null;
  cwd: string;
  version?: string;
  /** The AppImage's mount, whose entries are taken out of the path lists; defaults to `APPDIR` of the base */
  appDir?: string | undefined;
}

const dropped = (name: string): boolean => DROPPED.has(name) || DROPPED_PREFIXES.some((prefix) => name.startsWith(prefix));

/** A path list without the entries under `dir` */
function withoutDir(list: string, dir: string | undefined): string {
  if (!dir) return list;
  const prefix = dir.endsWith('/') ? dir : `${dir}/`;
  return list
    .split(':')
    .filter((entry) => entry !== dir && !entry.startsWith(prefix))
    .join(':');
}

/**
 * The environment of one shell. It is the server's, minus every `CLAUDIO_*` variable and Claude's
 * credentials, plus the vault's credentials for the person's own tools (GitHub, GitLab, YouTrack),
 * with the terminal's own variables set. `CLAUDIO_CHAT_ID` is never set: `agentryChildren()` finds a
 * chat's processes by it, and a terminal's must never be mistaken for one (the peer check relies on it).
 */
export function buildTerminalEnv(options: TerminalEnvOptions): Record<string, string> {
  const base = options.base ?? process.env;
  const appDir = options.appDir ?? base.APPDIR;
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && !dropped(name)) env[name] = value;
  }
  for (const name of PATH_LISTS) {
    const value = env[name];
    if (value === undefined) continue;
    const kept = withoutDir(value, appDir);
    if (kept) env[name] = kept;
    else delete env[name];
  }
  for (const tool of TERMINAL_VAULT_TOOLS) {
    for (const [name, value] of Object.entries(options.vault?.get(tool) ?? {})) {
      // Whatever a vault entry is called, it is never a Claude credential or one of ours
      if (!dropped(name)) env[name] = value;
    }
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'Claudio';
  if (options.version) env.TERM_PROGRAM_VERSION = options.version;
  if (!env.LANG && !env.LC_ALL) env.LANG = 'C.UTF-8';
  env.PWD = options.cwd;
  return env;
}
