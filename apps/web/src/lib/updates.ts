import type { ClaudioDistribution, ServerUpdateApplyRequest, ServerUpdateStatus } from '@claudio/shared';

/**
 * What the Updates card offers, decided from what kind of install the server is and from where the
 * page runs. The server's release check says whether a newer Claudio exists; only the desktop
 * window can act on it itself, every other surface gets the steps to take it.
 */

/** `UpdateState` of apps/desktop/src/ipc.ts, as the preload hands it over */
export type DesktopUpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'verifying'; version: string }
  | { status: 'ready'; version: string }
  | { status: 'apt-managed'; latest: string | null }
  | { status: 'copy-command'; version: string; command: string }
  | { status: 'shell-replaced'; version: string }
  | { status: 'unsupported'; reason: string; message: string }
  | { status: 'error'; code: ShellUpdateError; message: string };

/** `ShellUpdateError` of the shell: `other` is whatever it could not name */
export type ShellUpdateError = 'bad-signature' | 'fetch-failed' | 'other';

/** What a restart would stop: shared's `LiveWork`, copied because the shell's answers are parsed here */
export interface LiveWork {
  working: number;
  waiting: number;
  running: number;
  terminals: number;
}

/** `SwitchState` of the shell: whether the `.deb` can become the AppImage here, and what stays behind */
export interface SwitchState {
  available: boolean;
  reason: 'not-deb' | 'sandbox-restricted' | 'no-fuse' | null;
  debStillInstalled: boolean;
}

/** `PayloadAction` of the shell: the update writes it sends to the server with its own credential */
export type PayloadAction = { action: 'download'; version?: string } | { action: 'apply' | 'revert'; force?: boolean; whenIdle?: boolean } | { action: 'cancel-scheduled' };

/** `InstallAnswer` of apps/desktop/src/updater.ts */
export type DesktopInstallAnswer =
  | { status: 'restarting'; version: string }
  | { status: 'scheduled'; version: string }
  | { status: 'busy'; version: string; live: LiveWork }
  | { status: 'not-ready'; state: DesktopUpdateState };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0);

const SHELL_ERRORS: readonly ShellUpdateError[] = ['bad-signature', 'fetch-failed', 'other'];

/** The shell's state, or null when it sent something this build does not know (an older or newer shell) */
export function parseUpdateState(value: unknown): DesktopUpdateState | null {
  if (!isRecord(value)) return null;
  const { status, version, percent, reason, message, latest, command, code } = value;
  switch (status) {
    case 'idle':
    case 'checking':
      return { status };
    case 'available':
    case 'ready':
    case 'verifying':
    case 'shell-replaced':
      return text(version) ? { status, version } : null;
    case 'downloading':
      if (!text(version)) return null;
      return { status, version, percent: typeof percent === 'number' && Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : 0 };
    case 'apt-managed':
      return { status, latest: text(latest) ? latest : null };
    case 'copy-command':
      return text(version) && text(command) ? { status, version, command } : null;
    case 'unsupported':
      return text(message) ? { status, reason: text(reason) ? reason : 'unknown', message } : null;
    case 'error':
      // An older shell sends no code: its message is all there is, so it reads as `other`
      return { status, code: SHELL_ERRORS.find((known) => known === code) ?? 'other', message: text(message) ? message : '' };
    default:
      return null;
  }
}

const liveOf = (value: Record<string, unknown>): LiveWork => ({
  working: count(value.working),
  waiting: count(value.waiting),
  running: count(value.running),
  terminals: count(value.terminals),
});

export function parseInstallAnswer(value: unknown): DesktopInstallAnswer | null {
  if (!isRecord(value)) return null;
  const { status, version } = value;
  if ((status === 'restarting' || status === 'scheduled') && text(version)) return { status, version };
  if (status === 'busy' && text(version) && isRecord(value.live)) return { status, version, live: liveOf(value.live) };
  if (status === 'not-ready') {
    const state = parseUpdateState(value.state);
    return state ? { status, state } : null;
  }
  return null;
}

const SWITCH_REASONS: ReadonlyArray<NonNullable<SwitchState['reason']>> = ['not-deb', 'sandbox-restricted', 'no-fuse'];

/** The switch offer, or null from a shell that has none: the page then offers nothing */
export function parseSwitchState(value: unknown): SwitchState | null {
  if (!isRecord(value) || typeof value.available !== 'boolean') return null;
  return {
    available: value.available,
    reason: SWITCH_REASONS.find((known) => known === value.reason) ?? null,
    debStillInstalled: value.debStillInstalled === true,
  };
}

/** What the shell answers when a server route refused: the route's status and code, and the live work of a 409 */
export interface PayloadRefusal {
  status: number;
  code: string | null;
  live: LiveWork | null;
}

/**
 * The shell's answer to a payload action: the route's `ServerUpdateStatus`, or a refusal. Anything
 * else (an older shell, a malformed answer) is null, which the caller treats as a failure with no code.
 */
export function parsePayloadAnswer(value: unknown): { status: ServerUpdateStatus } | { refusal: PayloadRefusal } | null {
  if (!isRecord(value)) return null;
  if (typeof value.status === 'number' && value.status >= 400) {
    return { refusal: { status: value.status, code: text(value.code) ? value.code : null, live: isRecord(value.live) ? liveOf(value.live) : null } };
  }
  if (typeof value.state === 'string' && typeof value.running === 'string' && typeof value.image === 'string') {
    // The shape is the server's own (`ServerUpdateStatus`); only what the card cannot do without is checked
    return { status: value as unknown as ServerUpdateStatus };
  }
  return null;
}

/** A refusal as an error the card's mutations throw: `code` and `live` are what `liveWorkOf` and `updateErrorCode` read */
export function refusalError(refusal: PayloadRefusal): Error & { code: string | null; live: LiveWork | null } {
  return Object.assign(new Error(refusal.code ?? `status ${refusal.status}`), { code: refusal.code, live: refusal.live });
}

const UPDATE_ERROR_CODES = [
  'fetch-failed',
  'bad-signature',
  'bad-manifest',
  'disk',
  'needs-image',
  'needs-shell',
  'needs-auth',
  'not-owner',
  'unsupported',
  'no-release',
  'busy',
  'not-ready',
  'not-overlay',
  'live-work',
] as const;
export type UpdateErrorCode = (typeof UPDATE_ERROR_CODES)[number];

/**
 * The code of a failure of the update, whether a refusal of the routes (`update.<code>`) or a
 * `ServerUpdateStatus.error`. The card words each from its code and never from the server's text;
 * null is a code this build does not know, worded with the card's generic sentence.
 */
export function updateErrorCode(error: unknown): UpdateErrorCode | null {
  const raw = typeof error === 'string' ? error : isRecord(error) && typeof error.code === 'string' ? error.code : null;
  if (!raw) return null;
  const bare = raw.startsWith('update.') ? raw.slice('update.'.length) : raw;
  return UPDATE_ERROR_CODES.find((known) => known === bare) ?? null;
}

/** Whether pressing the same button again can change the outcome; every other code has a way out of its own */
export function canRetryUpdate(code: UpdateErrorCode | null): boolean {
  return code === null || code === 'fetch-failed' || code === 'bad-signature' || code === 'bad-manifest' || code === 'disk' || code === 'busy';
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
  return liveOf(error.live);
}

/** The calls the Claudio zone makes, by whoever may make them: this page with a credential, or the desktop shell for it */
export interface PayloadActions {
  download: () => Promise<ServerUpdateStatus>;
  apply: (body: ServerUpdateApplyRequest) => Promise<ServerUpdateStatus>;
  revert: (body: ServerUpdateApplyRequest) => Promise<ServerUpdateStatus>;
  cancel: () => Promise<ServerUpdateStatus>;
}

/**
 * The actions sent through the shell (docs/plans/unified-updates.md, D8): the desktop window holds no
 * owner credential, so the shell calls the routes with its own and hands back the route's answer. A
 * refusal is thrown as an error carrying its `code` and `live`, the same shape the page's own client
 * throws, so one set of handlers reads both.
 */
export function payloadActionsVia(call: (action: PayloadAction) => Promise<unknown>): PayloadActions {
  const run = async (action: PayloadAction): Promise<ServerUpdateStatus> => {
    const answer = parsePayloadAnswer(await call(action));
    if (!answer) throw new Error('The shell sent an answer this page does not know');
    if ('refusal' in answer) throw refusalError(answer.refusal);
    return answer.status;
  };
  return {
    download: () => run({ action: 'download' }),
    apply: (body) => run({ action: 'apply', ...body }),
    revert: (body) => run({ action: 'revert', ...body }),
    cancel: () => run({ action: 'cancel-scheduled' }),
  };
}

/**
 * Whether the Claudio zone shows a primary action. The card has one `btn-primary` per zone at most,
 * and when this zone has none the Desktop app zone's action is the card's one.
 */
export function payloadHasPrimary(status: ServerUpdateStatus | undefined, updateAvailable: boolean): boolean {
  if (!status || status.unsupportedReason) return false;
  if (status.state === 'ready') return true;
  const notInstallable = status.needsImage !== null || status.needsShell !== null || (status.offer !== null && !status.offer.installable);
  return status.state === 'idle' && updateAvailable && !notInstallable;
}

/** Removes the `.deb` once the AppImage runs: only root may, so the card shows it and the person runs it (D5) */
export const REMOVE_DEB_COMMAND = '/usr/bin/sudo /usr/bin/apt remove claudio';

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
