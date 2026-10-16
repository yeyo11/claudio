/*
 * The command the CLI runs for a hook (docs/plans/guards.md, D7): a clean environment, the Node
 * binary of the API process and the bundled guard, and nothing the project or the agent exported.
 */
import { createHash } from 'node:crypto';

export type GuardEvent = 'pre-tool-use' | 'session-start';

export interface GuardLaunch {
  /** `process.execPath` of the API process */
  execPath: string;
  /** The bundled `guard.mjs`, or `main.ts` from a source checkout */
  entry: string;
  /** Under Electron the binary runs the entry as Node only with `ELECTRON_RUN_AS_NODE`, which `standalone.ts` deletes from the server's environment */
  electron: boolean;
  /** `process.versions.node`; decides whether a `.ts` entry needs `--experimental-strip-types` */
  nodeVersion: string;
}

export const GUARD_ENV_PATH = '/usr/local/bin:/usr/bin:/bin';
const STRIP_TYPES_FLAGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];

/** Node strips TypeScript types by default from 23.6 */
function needsStripTypes(entry: string, nodeVersion: string): boolean {
  if (!entry.endsWith('.ts')) return false;
  const [major = 0, minor = 0] = nodeVersion.split('.').map((part) => Number.parseInt(part, 10));
  return major < 23 || (major === 23 && minor < 6);
}

/** `'` written as `'\''`, the one way a POSIX shell keeps any byte inside single quotes */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The first of these strings that holds a newline or a NUL: such a path cannot be quoted safely into a hook command */
export function findUnsafePath(paths: readonly string[]): string | null {
  return paths.find((path) => /[\n\r\0]/.test(path)) ?? null;
}

/** The program and its words, before quoting: `argv[0]` is `/usr/bin/env` */
function words(launch: GuardLaunch, rulesPath: string, rulesSha256: string): Array<{ text: string; quote: boolean }> {
  const plain = (text: string) => ({ text, quote: false });
  const path = (text: string) => ({ text, quote: true });
  return [
    plain('/usr/bin/env'),
    plain('-i'),
    plain(`PATH=${GUARD_ENV_PATH}`),
    plain('LANG=C.UTF-8'),
    ...(launch.electron ? [plain('ELECTRON_RUN_AS_NODE=1')] : []),
    path(launch.execPath),
    ...(needsStripTypes(launch.entry, launch.nodeVersion) ? STRIP_TYPES_FLAGS.map(plain) : []),
    path(launch.entry),
    plain('--rules'),
    path(rulesPath),
    plain('--sha256'),
    plain(rulesSha256),
  ];
}

/** The guard's argv without the event, for the self-test, which spawns it directly with no shell */
export function guardArgv(launch: GuardLaunch, rulesPath: string, rulesSha256: string): string[] {
  return words(launch, rulesPath, rulesSha256).map((word) => word.text);
}

/** The hook command without its `--event`; the settings file adds one per hook */
export function guardCommand(launch: GuardLaunch, rulesPath: string, rulesSha256: string): string {
  return words(launch, rulesPath, rulesSha256)
    .map((word) => (word.quote ? shellQuote(word.text) : word.text))
    .join(' ');
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
