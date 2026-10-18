import type { ClaudioDistribution, ServerUpdateStatus } from '@claudio/shared';

/**
 * What the Updates card offers, decided from what kind of install the server is and from where the
 * page runs. The server's release check says whether a newer Claudio exists; only the desktop
 * window can act on it itself, every other surface gets the steps to take it.
 */

/** `UpdateState` of apps/desktop/src/updater.ts, as the preload hands it over */
export type DesktopUpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'unsupported'; reason: string; message: string }
  | { status: 'error'; message: string };

/** What a restart would stop */
export interface LiveWork {
  working: number;
  waiting: number;
  running: number;
}

/** `InstallAnswer` of apps/desktop/src/updater.ts */
export type DesktopInstallAnswer =
  | { status: 'restarting'; version: string }
  | { status: 'scheduled'; version: string }
  | { status: 'busy'; version: string; live: LiveWork }
  | { status: 'not-ready'; state: DesktopUpdateState };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0);

/** The shell's state, or null when it sent something this build does not know (an older or newer shell) */
export function parseUpdateState(value: unknown): DesktopUpdateState | null {
  if (!isRecord(value)) return null;
  const { status, version, percent, reason, message } = value;
  switch (status) {
    case 'idle':
    case 'checking':
      return { status };
    case 'available':
    case 'ready':
      return text(version) ? { status, version } : null;
    case 'downloading':
      if (!text(version)) return null;
      return { status, version, percent: typeof percent === 'number' && Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : 0 };
    case 'unsupported':
      return text(message) ? { status, reason: text(reason) ? reason : 'unknown', message } : null;
    case 'error':
      return { status, message: text(message) ? message : '' };
    default:
      return null;
  }
}

export function parseInstallAnswer(value: unknown): DesktopInstallAnswer | null {
  if (!isRecord(value)) return null;
  const { status, version } = value;
  if ((status === 'restarting' || status === 'scheduled') && text(version)) return { status, version };
  if (status === 'busy' && text(version) && isRecord(value.live)) {
    const { working, waiting, running } = value.live;
    return { status, version, live: { working: count(working), waiting: count(waiting), running: count(running) } };
  }
  if (status === 'not-ready') {
    const state = parseUpdateState(value.state);
    return state ? { status, state } : null;
  }
  return null;
}

/** A page opened on the machine that runs the server, as opposed to a phone or another computer */
export function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Where the steps to take a release are run */
export type UpdateHow = 'docker' | 'source' | 'desktop-app';

export type UpdateRoute =
  /** The desktop window, whose shell downloads and installs the release itself */
  | { kind: 'desktop' }
  /** Steps to show; `remote` addresses them to whoever runs the server, not to the reader */
  | { kind: 'steps'; how: UpdateHow; remote: boolean };

export function updateRoute({
  distribution,
  desktopUpdates,
  hostname,
}: {
  distribution: ClaudioDistribution;
  /** window.claudioDesktop.updates is there: this page is the desktop app's own window */
  desktopUpdates: boolean;
  hostname: string;
}): UpdateRoute {
  if (desktopUpdates) return { kind: 'desktop' };
  const how: UpdateHow = distribution === 'docker' ? 'docker' : distribution === 'source' ? 'source' : 'desktop-app';
  return { kind: 'steps', how, remote: !isLoopback(hostname) };
}

/**
 * A container cannot tell how it was started, so the card offers each way docs/deploy.md documents,
 * in the order people meet them: the README's `docker run`, a compose file on the published image,
 * and the repository's own compose file, which builds the image instead of pulling one.
 */
export const DOCKER_UPDATE_WAYS = [
  { way: 'run', command: 'docker pull ghcr.io/yeyo11/claudio' },
  { way: 'compose', command: 'docker compose pull && docker compose up -d' },
  { way: 'checkout', command: 'git pull && docker compose up -d --build' },
] as const;
/**
 * Starts Claudio with all three folders on a volume with a name. The image declares `VOLUME` for
 * each, so a command that names fewer still starts, with the rest on volumes Docker makes on its own
 * and the next command does not reattach: replacing the container then loses the sign-in, the
 * transcripts and the projects. The workspace is a named volume too, not `$PWD/workspace`, which
 * is a different folder from wherever the command is run next.
 */
export const DOCKER_RUN_COMMAND =
  'docker run -d --init --name claudio --restart unless-stopped -p 127.0.0.1:8797:8797 -v claudio-config:/home/node/.claude -v claudio-data:/data -v claudio-workspace:/workspace ghcr.io/yeyo11/claudio';
/** What follows `docker pull`: the old container goes, the volumes stay */
export const DOCKER_REPLACE_COMMAND = `docker stop claudio && docker rm claudio && ${DOCKER_RUN_COMMAND}`;
export const SOURCE_UPDATE_COMMAND = 'git pull && pnpm install && pnpm build';

// ---------- Claudio updating itself in a container (docs/plans/container-polish.md, D4) ----------

/** The states in which the server is doing something on its own, so the card asks again soon */
export function serverUpdateRefetchMs(status: Pick<ServerUpdateStatus, 'state'> | undefined): number | false {
  return status && (status.state === 'downloading' || status.state === 'verifying' || status.state === 'restarting') ? 2000 : false;
}

/** The counts a `409 update.live-work` carries, or null for any other failure */
export function liveWorkOf(error: unknown): LiveWork | null {
  if (!isRecord(error) || error.code !== 'update.live-work' || !isRecord(error.live)) return null;
  const { working, waiting, running } = error.live;
  return { working: count(working), waiting: count(waiting), running: count(running) };
}

const ROLLBACK_KEY = 'cw:rollback-dismissed';

/**
 * The rollback notice a person put away in this browser, by its `lastRollback.at`: the launcher keeps
 * the last rollback in its state for good, so without this the notice would come back on every visit.
 * A later rollback has another `at` and shows again.
 */
export function dismissedRollback(): string | null {
  try {
    return localStorage.getItem(ROLLBACK_KEY);
  } catch {
    return null;
  }
}

export function dismissRollback(at: string): void {
  try {
    localStorage.setItem(ROLLBACK_KEY, at);
  } catch {
    // private mode: the notice comes back next visit, which is all it costs
  }
}
