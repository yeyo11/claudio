import { accessSync, constants, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { AppSettingSource, TerminalRemote, TerminalSettings, UpdateTerminalSettingsRequest } from '@claudio/shared';
import { writeAtomic } from '../config/files.ts';
import type { CoreConfig } from '../paths.ts';
import { TerminalError } from './errors.ts';

/** `CLAUDIO_TERMINAL=off|on` overrides `enabled`: what whoever deployed Claudio decided wins over the UI */
export const TERMINAL_ENV = 'CLAUDIO_TERMINAL';

export const TERMINAL_DEFAULTS: Readonly<TerminalSettings> = {
  enabled: false,
  remote: 'tunnel',
  maxTerminals: 8,
  idleMinutes: 30,
  scrollbackLines: 2000,
  replayLines: 1000,
  shell: null,
  loginShell: true,
};

export const TERMINAL_BOUNDS = {
  maxTerminals: [1, 32],
  idleMinutes: [5, 1440],
  scrollbackLines: [500, 10_000],
  replayLines: [0, 10_000],
} as const;

const REMOTES: readonly TerminalRemote[] = ['off', 'tunnel', 'any'];
const KEYS = Object.keys(TERMINAL_DEFAULTS) as (keyof TerminalSettings)[];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function integer(key: keyof typeof TERMINAL_BOUNDS, value: unknown): number {
  const [min, max] = TERMINAL_BOUNDS[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new TerminalError('terminal.bad-settings', `${key} must be a whole number from ${String(min)} to ${String(max)}`, 400);
  }
  return value;
}

/** The shells the system lists, for the check that a shell the person names is one */
function listedShells(): string[] | null {
  try {
    return readFileSync('/etc/shells', 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('/'));
  } catch {
    return null;
  }
}

function shellProblem(path: string): string | null {
  if (!isAbsolute(path) || path.length > 4096) return 'shell must be an absolute path';
  try {
    accessSync(path, constants.X_OK);
  } catch {
    return 'shell must be an executable that exists';
  }
  const listed = listedShells();
  return listed && !listed.includes(path) ? 'shell must be one listed in /etc/shells' : null;
}

function parseKey<K extends keyof TerminalSettings>(key: K, value: unknown): TerminalSettings[K];
function parseKey(key: keyof TerminalSettings, value: unknown): TerminalSettings[keyof TerminalSettings] {
  switch (key) {
    case 'enabled':
    case 'loginShell':
      if (typeof value !== 'boolean') throw new TerminalError('terminal.bad-settings', `${key} must be true or false`, 400);
      return value;
    case 'remote':
      if (typeof value !== 'string' || !REMOTES.includes(value as TerminalRemote)) throw new TerminalError('terminal.bad-settings', `remote must be one of ${REMOTES.join(', ')}`, 400);
      return value as TerminalRemote;
    case 'shell': {
      if (value === null) return null;
      if (typeof value !== 'string') throw new TerminalError('terminal.bad-settings', 'shell must be a path or null', 400);
      const problem = shellProblem(value);
      if (problem) throw new TerminalError('terminal.bad-settings', problem, 400);
      return value;
    }
    default:
      return integer(key, value);
  }
}

/** `on` and `off` (any case) say something; anything else leaves the file and the default in charge */
function envSwitch(env: NodeJS.ProcessEnv): boolean | null {
  const value = env[TERMINAL_ENV]?.trim().toLowerCase();
  if (value === 'on' || value === 'true' || value === '1') return true;
  if (value === 'off' || value === 'false' || value === '0') return false;
  return null;
}

/**
 * `terminal.json` in the data directory, under the environment's `CLAUDIO_TERMINAL`: the three
 * layers `app-settings.ts` has, for the one setting the environment may pin. Absent until the first
 * save, so a new install reads the defaults: the terminal is off.
 */
export class TerminalSettingsStore {
  private readonly file: string;
  private stored: Partial<TerminalSettings> = {};

  constructor(
    config: Pick<CoreConfig, 'dataDir'>,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.file = join(config.dataDir, 'terminal.json');
    mkdirSync(config.dataDir, { recursive: true });
    this.stored = this.read();
  }

  get(): TerminalSettings {
    const settings: TerminalSettings = { ...TERMINAL_DEFAULTS, ...this.stored };
    const pinned = envSwitch(this.env);
    if (pinned !== null) settings.enabled = pinned;
    // A replay longer than the scrollback has nothing to replay: the two bounds are one rule
    settings.replayLines = Math.min(settings.replayLines, settings.scrollbackLines);
    return settings;
  }

  sources(): Record<keyof TerminalSettings, AppSettingSource> {
    const pinned = envSwitch(this.env) !== null;
    return Object.fromEntries(KEYS.map((key) => [key, key === 'enabled' && pinned ? 'env' : key in this.stored ? 'file' : 'default'])) as Record<
      keyof TerminalSettings,
      AppSettingSource
    >;
  }

  /** Whether the environment turns the feature off for the whole deployment */
  get vetoed(): boolean {
    return envSwitch(this.env) === false;
  }

  /** Validates the patch whole, then writes: a patch with one bad value changes nothing */
  async update(patch: UpdateTerminalSettingsRequest): Promise<TerminalSettings> {
    if (!isObject(patch)) throw new TerminalError('terminal.bad-settings', 'settings must be an object', 400);
    const next: Partial<TerminalSettings> = { ...this.stored };
    for (const [key, value] of Object.entries(patch)) {
      if (!(KEYS as string[]).includes(key)) throw new TerminalError('terminal.bad-settings', `${key} is not a terminal setting`, 400);
      if (value === undefined) continue;
      if (key === 'enabled' && envSwitch(this.env) !== null) throw new TerminalError('terminal.env-locked', `${TERMINAL_ENV} decides whether the terminal is on`, 409);
      (next as Record<string, unknown>)[key] = parseKey(key as keyof TerminalSettings, value);
    }
    const merged = { ...TERMINAL_DEFAULTS, ...next };
    if (merged.replayLines > merged.scrollbackLines) throw new TerminalError('terminal.bad-settings', 'replayLines cannot exceed scrollbackLines', 400);
    await writeAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`);
    this.stored = next;
    return this.get();
  }

  private read(): Partial<TerminalSettings> {
    if (!existsSync(this.file)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!isObject(parsed)) return {};
      const out: Partial<TerminalSettings> = {};
      for (const key of KEYS) {
        if (!(key in parsed)) continue;
        try {
          (out as Record<string, unknown>)[key] = parseKey(key, parsed[key]);
        } catch {
          // A hand edit that went bad reads as the default for that key, never as a terminal left on
        }
      }
      return out;
    } catch {
      return {};
    }
  }
}

/**
 * The shell a terminal runs: the setting if it is still usable, else the server's `$SHELL`, else the
 * login shell of the user that runs Claudio, else bash, else sh. Windows is out of scope.
 */
export function resolveShell(settings: Pick<TerminalSettings, 'shell'>, env: NodeJS.ProcessEnv = process.env): string {
  const usable = (path: string | null | undefined): path is string => {
    if (!path || !isAbsolute(path)) return false;
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  let own: string | null = null;
  try {
    own = userInfo().shell;
  } catch {
    // no passwd entry for this user
  }
  return [settings.shell, env.SHELL, own, '/bin/bash', '/bin/sh'].find(usable) ?? '/bin/sh';
}
