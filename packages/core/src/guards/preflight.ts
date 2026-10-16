/*
 * What must hold before a guarded process spawns (docs/plans/guards.md, "Pre-launch checks").
 * Any failure fails the launch with a `GuardUnavailableError` and its code.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type { ProviderCapability } from '@claudio/shared';
import { type GuardLaunch, findUnsafePath, guardArgv } from './command.ts';
import { FLAG_OVERRIDES_DISABLE_ALL_HOOKS, writeGuardFiles } from './files.ts';
import { DEFAULT_LIMITS, type GuardRulesFile } from './input.ts';

export type GuardUnavailableCode =
  | 'entry-missing'
  | 'entry-untrusted'
  | 'self-test-failed'
  | 'cli-unsupported'
  | 'hooks-disabled'
  | 'managed-hooks-only'
  | 'bad-path';

export class GuardUnavailableError extends Error {
  readonly code: GuardUnavailableCode;
  constructor(code: GuardUnavailableCode, detail: string) {
    super(`Guards cannot start (${code}): ${detail}`);
    this.name = 'GuardUnavailableError';
    this.code = code;
  }
}

/** The operator's own guard entry, trusted wherever it is (O4) */
export const GUARD_ENTRY_ENV = 'CLAUDIO_GUARD_ENTRY';
/** Where the CLI reads managed settings on Linux */
const MANAGED_SETTINGS = '/etc/claude-code/managed-settings.json';
const SELF_TEST_TTL_MS = 10 * 60 * 1000;
const SELF_TEST_TIMEOUT_MS = 10_000;

export interface PreflightInput {
  launch: GuardLaunch;
  dataDir: string;
  /** Folders the entry must not live under: the run's roots and the projects */
  roots: readonly string[];
  /** The app's own install; the entry must live under it unless it is `operatorEntry` */
  installDirs: readonly string[];
  operatorEntry?: string | null;
  /** `CLAUDE_CONFIG_DIR` of the account and `~/.claude` */
  claudeConfigDirs: readonly string[];
  /** The session's cwd: the CLI reads project settings from there only (F13) */
  cwd: string;
  /** The capabilities the handshake confirmed for the installed CLI */
  capabilities: readonly ProviderCapability[];
  /** Managed settings, when the caller reads them from somewhere else (tests) */
  managedSettingsPath?: string;
  /** Overrides F12 for a test: whether our flag-level `false` beats the other sources */
  flagOverridesDisable?: boolean;
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isUnder(path: string, dir: string): boolean {
  const base = realOrSelf(dir);
  return path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);
}

/** A settings file read as data; anything unreadable counts as absent, as the CLI treats it */
function readSettings(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function checkEntry(input: PreflightInput): void {
  const { entry } = input.launch;
  let stat;
  try {
    stat = statSync(entry);
  } catch {
    throw new GuardUnavailableError('entry-missing', `${entry} does not exist`);
  }
  if (!stat.isFile()) throw new GuardUnavailableError('entry-missing', `${entry} is not a regular file`);
  if (stat.mode & 0o022) throw new GuardUnavailableError('entry-missing', `${entry} is writable by its group or by everyone`);

  const real = realpathSync(entry);
  const operator = input.operatorEntry ? realOrSelf(input.operatorEntry) : null;
  if (operator !== null && real === operator) return;
  const plugins = input.claudeConfigDirs.map((dir) => join(dir, 'plugins'));
  const forbidden = [...input.roots, ...plugins].some((dir) => isUnder(real, dir));
  if (forbidden) throw new GuardUnavailableError('entry-untrusted', `${real} is under a project, a root or a plugin cache`);
  if (!input.installDirs.some((dir) => isUnder(real, dir))) throw new GuardUnavailableError('entry-untrusted', `${real} is not part of the app's install`);
}

function checkSettingSources(input: PreflightInput): void {
  const managed = readSettings(input.managedSettingsPath ?? MANAGED_SETTINGS);
  // F12 could not record managed settings, so a `true` there is taken to switch the hooks off whatever our flag says
  if (managed?.disableAllHooks === true) throw new GuardUnavailableError('hooks-disabled', 'managed settings set disableAllHooks');
  if (managed?.allowManagedHooksOnly === true) throw new GuardUnavailableError('managed-hooks-only', 'managed settings allow only managed hooks');

  if (input.flagOverridesDisable ?? FLAG_OVERRIDES_DISABLE_ALL_HOOKS) return;
  const files = [
    ...input.claudeConfigDirs.map((dir) => join(dir, 'settings.json')),
    join(input.cwd, '.claude', 'settings.json'),
    join(input.cwd, '.claude', 'settings.local.json'),
  ];
  for (const file of files) {
    if (readSettings(file)?.disableAllHooks === true) throw new GuardUnavailableError('hooks-disabled', `${file} sets disableAllHooks`);
  }
}

/** Every check that needs no process; the self-test is separate because it spawns one */
export function checkGuardPreflight(input: PreflightInput): void {
  const unsafe = findUnsafePath([input.launch.execPath, input.launch.entry, input.dataDir]);
  if (unsafe !== null) throw new GuardUnavailableError('bad-path', 'a path holds a newline or a NUL');
  if (!input.capabilities.includes('settingsFlag') || !input.capabilities.includes('hookEvents')) {
    throw new GuardUnavailableError('cli-unsupported', 'the installed CLI lacks --settings or --include-hook-events');
  }
  checkEntry(input);
  checkSettingSources(input);
}

/** The recorded Bash inputs the self-test feeds the guard */
const SELF_TEST_CASES = [
  { command: 'git push origin main', exit: 2, marker: /^claudio-guard\/1 block /m },
  { command: 'ls', exit: 0, marker: /^claudio-guard\/1 pass /m },
] as const;

function runGuard(argv: string[], stdin: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((done) => {
    const child = spawn('/usr/bin/env', argv, { stdio: ['pipe', 'ignore', 'pipe'], env: {} });
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), SELF_TEST_TIMEOUT_MS);
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
    child.on('error', () => {
      clearTimeout(timer);
      done({ code: null, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

/** Spawns the guard as the CLI would, with throwaway rules, and checks that it blocks a push and passes `ls` */
export async function runGuardSelfTest(launch: GuardLaunch): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), 'claudio-guard-selftest-'));
  try {
    const root = join(scratch, 'work');
    mkdirSync(root);
    const dataDir = join(scratch, 'data');
    const rules: GuardRulesFile = {
      version: 1,
      mode: 'enforce',
      rules: ['integrity', 'no-verify', 'push', 'destructive', 'secrets'],
      roots: [realOrSelf(root)],
      mainCheckout: null,
      hooksPathDir: null,
      dataDir: realOrSelf(scratch),
      guardDir: realOrSelf(join(launch.entry, '..')),
      claudeConfigDirs: [],
      protectConfigs: [],
      knownSecretSha256: [],
      limits: { ...DEFAULT_LIMITS },
    };
    const { rulesPath, rulesSha256 } = writeGuardFiles(dataDir, rules, launch);
    for (const [index, test] of SELF_TEST_CASES.entries()) {
      const stdin = JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: test.command },
        tool_use_id: `toolu_selftest${index}`,
        session_id: 'selftest',
        cwd: root,
      });
      const result = await runGuard([...guardArgv(launch, rulesPath, rulesSha256), '--event', 'pre-tool-use'], stdin);
      if (result.code !== test.exit || !test.marker.test(result.stderr)) {
        throw new GuardUnavailableError('self-test-failed', `\`${test.command}\` ended with ${result.code ?? 'no code'}, expected ${test.exit}`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The checks of a launch, with the self-test run once per 10 minutes for a given guard */
export class GuardPreflight {
  private readonly passed = new Map<string, number>();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    private readonly deps: { now?: () => number; selfTest?: (launch: GuardLaunch) => Promise<void>; ttlMs?: number } = {},
  ) {}

  async verify(input: PreflightInput): Promise<void> {
    checkGuardPreflight(input);
    await this.selfTest(input.launch);
  }

  /**
   * The checks for a launch that cannot wait: every one that needs no process, and a self-test that
   * passed before. A launch with none yet fails and starts one, so the next finds it done; one that
   * went stale keeps counting while a fresh one runs.
   */
  verifyNow(input: PreflightInput): void {
    checkGuardPreflight(input);
    const { launch } = input;
    const key = [launch.execPath, launch.entry, launch.electron, launch.nodeVersion].join('\0');
    const at = this.passed.get(key);
    if (at === undefined || (this.deps.now ?? Date.now)() - at >= (this.deps.ttlMs ?? SELF_TEST_TTL_MS)) void this.selfTest(launch).catch(() => {});
    if (at === undefined) throw new GuardUnavailableError('self-test-failed', 'the guard self-test has not passed yet; it runs now, so try again in a moment');
  }

  /** At server start, so a broken guard is known before the first launch */
  async selfTest(launch: GuardLaunch): Promise<void> {
    const key = [launch.execPath, launch.entry, launch.electron, launch.nodeVersion].join('\0');
    const now = (this.deps.now ?? Date.now)();
    const at = this.passed.get(key);
    if (at !== undefined && now - at < (this.deps.ttlMs ?? SELF_TEST_TTL_MS)) return;
    let running = this.pending.get(key);
    if (!running) {
      running = (this.deps.selfTest ?? runGuardSelfTest)(launch)
        .then(() => {
          this.passed.set(key, now);
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, running);
    }
    await running;
  }
}
