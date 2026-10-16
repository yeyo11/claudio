/*
 * The settings file and the rules file of a run, content-addressed under `<dataDir>/guards/`
 * (docs/plans/guards.md, D3 and D4), and the sweep that removes the ones no run uses.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, utimesSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type GuardLaunch, guardCommand, sha256Hex } from './command.ts';
import type { GuardRulesFile } from './input.ts';

export const GUARD_DIR = 'guards';
/** F12: `disableAllHooks: false` in the `--settings` file beats a `true` in user, project and local settings, on both CLI builds */
export const FLAG_OVERRIDES_DISABLE_ALL_HOOKS = true;
/** A hook's timeout is in seconds (F8); the guard's own deadline is shorter, so the CLI's is never reached */
const HOOK_TIMEOUT_SECONDS = 30;
export const SWEEP_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
export const SWEEP_INTERVAL_MS = 6 * 3600 * 1000;

export interface GuardFiles {
  settingsPath: string;
  rulesPath: string;
  rulesSha256: string;
}

/** Keys sorted at every depth, so equal rules always give equal bytes */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export function serializeRules(rules: GuardRulesFile): string {
  return `${JSON.stringify(canonical(rules))}\n`;
}

export function buildSettings(command: string): string {
  const hook = (event: string) => [{ type: 'command', command: `${command} --event ${event}`, timeout: HOOK_TIMEOUT_SECONDS }];
  const settings = {
    ...(FLAG_OVERRIDES_DISABLE_ALL_HOOKS ? { disableAllHooks: false } : {}),
    hooks: {
      SessionStart: [{ hooks: hook('session-start') }],
      PreToolUse: [{ matcher: '*', hooks: hook('pre-tool-use') }],
    },
  };
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/**
 * Writes `body` to `dir/name` unless the file already holds exactly that. A file with other content,
 * a link or a looser mode is what an agent that tampered with it leaves, so it is rewritten.
 */
function ensureFile(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  const bytes = Buffer.from(body);
  try {
    const stat = lstatSync(path);
    if (stat.isFile() && readFileSync(path).equals(bytes)) {
      if ((stat.mode & 0o777) !== 0o600) chmodSync(path, 0o600);
      const now = new Date();
      utimesSync(path, now, now);
      return path;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Two writers of the same content write the same name; rename is atomic, so either one wins whole
  const tmp = join(dir, `${name}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  return path;
}

export function writeGuardFiles(dataDir: string, rules: GuardRulesFile, launch: GuardLaunch): GuardFiles {
  const dir = join(dataDir, GUARD_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  const rulesBody = serializeRules(rules);
  const rulesSha256 = sha256Hex(rulesBody);
  const rulesPath = ensureFile(dir, `${rulesSha256.slice(0, 16)}.rules.json`, rulesBody);

  const settingsBody = buildSettings(guardCommand(launch, rulesPath, rulesSha256));
  const settingsPath = ensureFile(dir, `${sha256Hex(settingsBody).slice(0, 16)}.settings.json`, settingsBody);
  return { settingsPath, rulesPath, rulesSha256 };
}

const SWEPT = /\.(?:rules\.json|settings\.json|tmp)$/;

/**
 * Removes the guard files older than `maxAgeMs` that no live launch names. Removing a rules file
 * under a live run would block every tool of that run, so a live one is never touched whatever its
 * age. Returns the paths removed.
 */
export function sweepGuardFiles(dataDir: string, live: Iterable<string>, opts: { now?: number; maxAgeMs?: number } = {}): string[] {
  const dir = join(dataDir, GUARD_DIR);
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? SWEEP_MAX_AGE_MS;
  const keep = new Set([...live].map((path) => resolve(path)));
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!SWEPT.test(name)) continue;
    const path = join(dir, name);
    if (keep.has(resolve(path))) continue;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || now - stat.mtimeMs < maxAge) continue;
      unlinkSync(path);
      removed.push(path);
    } catch {
      // Gone already, or not ours to remove: the next sweep looks again
    }
  }
  return removed;
}

/** Sweeps now and every 6 hours; `live` is asked each time, so a launch made since still counts */
export function startGuardSweep(dataDir: string, live: () => Iterable<string>, onError?: (error: unknown) => void): () => void {
  const run = () => {
    try {
      sweepGuardFiles(dataDir, live());
    } catch (error) {
      onError?.(error);
    }
  };
  run();
  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
