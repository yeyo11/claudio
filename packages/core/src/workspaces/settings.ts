import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** What bounds the workspaces of one Claudio (docs/plans/headless-image.md, D7). */
export interface WorkspaceSettings {
  /** Where every `ws_<id>` folder lives; nothing outside it is ever removed by the sweeper */
  root: string;
  /** Host names a `{ url }` source and each of its redirects may name */
  hosts: string[];
  maxCompressedBytes: number;
  /** Counted as bytes are written, not from the archive's headers */
  maxExtractedBytes: number;
  /** Regular files and directories, together */
  maxEntries: number;
  /** Download and extraction together */
  timeoutMs: number;
  /** Workspaces at once, the ones being created included */
  maxCount: number;
  /** Bytes under the root, every workspace together */
  maxTotalBytes: number;
  /** From the last use: a chat started in it moves it */
  ttlMs: number;
}

const MB = 1024 * 1024;

export const DEFAULT_WORKSPACE_HOSTS = ['codeload.github.com'];

const isSet = (value: string | undefined): value is string => value !== undefined && value.trim() !== '';

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name];
  if (!isSet(value)) return fallback;
  const n = Number(value.trim());
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name}: '${value}' is not a whole number above 0`);
  return n;
}

const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

function hostsFrom(value: string | undefined): string[] {
  if (!isSet(value)) return [...DEFAULT_WORKSPACE_HOSTS];
  const hosts = value
    .split(/[\s,]+/)
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  for (const host of hosts) {
    if (!HOST_RE.test(host)) throw new Error(`CLAUDIO_WORKSPACE_HOSTS: '${host}' is not a host name`);
  }
  return hosts;
}

/** Whether `child` is `parent` or inside it. */
export function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Whether one path is the other, or either holds the other. */
export function overlaps(a: string, b: string): boolean {
  return inside(a, b) || inside(b, a);
}

/**
 * The workspace settings from the environment. A value that is not valid stops the start, as the
 * spend cap's does, rather than run with a cap nobody chose. The root defaults to `/workspaces` in the
 * image, and elsewhere to a `workspaces` folder beside the data directory, so two Claudios on one
 * machine (the desktop app and a dev server) never sweep each other's.
 */
export function workspaceSettingsFromEnv(
  env: NodeJS.ProcessEnv,
  places: { dataDir: string; workspaceDir: string; configDir: string; distribution?: string },
): WorkspaceSettings {
  const fallbackRoot = places.distribution === 'docker' ? '/workspaces' : join(dirname(places.dataDir), 'workspaces');
  const root = resolve(isSet(env.CLAUDIO_WORKSPACES_DIR) ? env.CLAUDIO_WORKSPACES_DIR.trim() : fallbackRoot);
  // A workspace is reachable only by its id: a root that is, holds or sits inside the default
  // working directory, the data or the CLI's config would make it nameable as a `cwd`, or let the
  // sweeper reach what is not its own
  for (const [name, dir] of [
    ['CLAUDIO_WORKSPACE_DIR', places.workspaceDir],
    ['CLAUDIO_DATA_DIR', places.dataDir],
    ['CLAUDE_CONFIG_DIR', places.configDir],
  ] as const) {
    if (overlaps(root, resolve(dir))) throw new Error(`CLAUDIO_WORKSPACES_DIR: '${root}' overlaps ${name} ('${dir}'); point it at a folder of its own`);
  }
  if (root === dirname(root)) throw new Error('CLAUDIO_WORKSPACES_DIR: the file system root cannot hold workspaces');
  return {
    root,
    hosts: hostsFrom(env.CLAUDIO_WORKSPACE_HOSTS),
    maxCompressedBytes: positiveInteger(env, 'CLAUDIO_WORKSPACE_MAX_COMPRESSED_MB', 100) * MB,
    maxExtractedBytes: positiveInteger(env, 'CLAUDIO_WORKSPACE_MAX_EXTRACTED_MB', 500) * MB,
    maxEntries: positiveInteger(env, 'CLAUDIO_WORKSPACE_MAX_FILES', 50_000),
    timeoutMs: positiveInteger(env, 'CLAUDIO_WORKSPACE_TIMEOUT_SECONDS', 60) * 1000,
    maxCount: positiveInteger(env, 'CLAUDIO_WORKSPACE_MAX_COUNT', 20),
    maxTotalBytes: positiveInteger(env, 'CLAUDIO_WORKSPACES_MAX_TOTAL_MB', 2048) * MB,
    ttlMs: positiveInteger(env, 'CLAUDIO_WORKSPACE_TTL_MINUTES', 120) * 60_000,
  };
}
