import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debInstallCommand, type ShellUpdateError, type Verified } from './desktop-manifest.ts';
import type { LiveSnapshot } from './live.ts';

/**
 * The desktop app's own updates: the shell's (docs/plans/unified-updates.md, D3). Most releases change
 * only the payload, which the server downloads and the shell boots (payload.ts); this is for the
 * rest, and it never escalates:
 * - an AppImage replaces itself through electron-updater's `AppImageUpdater`, then restarts;
 * - a `.deb` with Claudio's apt source is the system updater's to update (`apt-managed`);
 * - a `.deb` without it downloads the package through `DebUpdater.downloadUpdate()`, never its
 *   `install()`, and shows the command that installs it from a terminal (`copy-command`).
 * Every download is checked against the signed desktop manifest before anything else happens to it.
 * When apt replaced the package under the running app, the state is `shell-replaced` and the way
 * out is a restart. Nothing happens unasked. Free of Electron and of electron-updater itself (both
 * are injected), so the state machine is tested with a fake of the updater's events.
 */

/** The kind of package this app runs from; also CLAUDIO_DISTRIBUTION for the server child */
export type Distribution = 'appimage' | 'deb';

export type UnsupportedReason = 'development' | 'read-only' | 'unknown-package';

export type { ShellUpdateError };

export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'verifying'; version: string }
  /** AppImage only: downloaded and verified, installed by a restart */
  | { status: 'ready'; version: string }
  /** The system's updater installs the shell; `latest` is a newer release it has not installed yet */
  | { status: 'apt-managed'; latest: string | null }
  /** A verified `.deb`, and the command that installs it */
  | { status: 'copy-command'; version: string; command: string }
  /** apt installed this version under the running app: a restart starts it */
  | { status: 'shell-replaced'; version: string }
  | { status: 'unsupported'; reason: UnsupportedReason; message: string }
  | { status: 'error'; code: ShellUpdateError; message: string };

export interface PackageFacts {
  /** process.env.APPIMAGE: the AppImage's own path, set by its runtime */
  appImage: string | undefined;
  /** The contents of <resources>/package-type, which electron-builder writes into the .deb */
  packageType: string | undefined;
}

/** What electron-updater itself looks at to pick its Linux updater (out/main.js), in the same order */
export function distributionOf({ appImage, packageType }: PackageFacts): Distribution | undefined {
  if (appImage) return 'appimage';
  if (packageType?.trim() === 'deb') return 'deb';
  return undefined;
}

/** <resources>/package-type, or undefined outside a package that has one */
export function readPackageType(resourcesPath: string): string | undefined {
  try {
    return readFileSync(join(resourcesPath, 'package-type'), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The updater unlinks the AppImage and moves the new one into its folder, so both must be writable */
export function appImageWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    accessSync(dirname(path), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** What the `.deb`'s postinst writes (D4) */
export const APT_SOURCE = '/etc/apt/sources.list.d/claudio.sources';
export const APT_KEYRING = '/usr/share/keyrings/claudio-archive-keyring.gpg';

/** The apt source is registered. A source without its keyring only breaks `apt update`, so both must be there. */
export function aptManaged(exists: (path: string) => boolean = existsSync): boolean {
  return exists(APT_SOURCE) && exists(APT_KEYRING);
}

export interface SupportFacts extends PackageFacts {
  dev: boolean;
  appImageWritable: (path: string) => boolean;
}

export type Support = { supported: true; distribution: Distribution } | Extract<UpdateState, { status: 'unsupported' }>;

/** Whether this copy can update itself, and if not, why, in words the UI can show */
export function updateSupport(facts: SupportFacts): Support {
  if (facts.dev) {
    return { status: 'unsupported', reason: 'development', message: 'Updates are off in a development build.' };
  }
  const distribution = distributionOf(facts);
  if (!distribution) {
    return {
      status: 'unsupported',
      reason: 'unknown-package',
      message: 'This copy of Claudio was not installed from an AppImage or a .deb, so it cannot update itself.',
    };
  }
  if (distribution === 'appimage' && facts.appImage && !facts.appImageWritable(facts.appImage)) {
    return {
      status: 'unsupported',
      reason: 'read-only',
      message: `The AppImage at ${facts.appImage} cannot be replaced: the file or its folder is not writable.`,
    };
  }
  return { supported: true, distribution };
}

/**
 * The part of electron-updater's `AppUpdater`/`BaseUpdater` this module drives, declared
 * structurally so a test can hand in a fake. Listeners take `unknown`: what the events carry is
 * checked here rather than trusted. `install` is only ever called on the AppImage's engine.
 */
export interface UpdaterEngine {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  logger: { info(message?: unknown): void; warn(message?: unknown): void; error(message?: unknown): void } | null;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: { version: string } } | null>;
  /** Resolves with the downloaded files' paths */
  downloadUpdate(): Promise<unknown>;
  /** Replaces the installed app with the downloaded one, synchronously; false when it could not */
  install(isSilent?: boolean, isForceRunAfter?: boolean): boolean;
}

export interface DesktopUpdaterOptions {
  support: Support;
  /** Called at most once, and only when this copy can update: nothing loads electron-updater otherwise */
  engine: () => UpdaterEngine;
  /** Asked at every check on a `.deb`: whether the apt source is registered */
  aptManaged?: () => boolean;
  /** Checks a downloaded package against the release's signed desktop manifest */
  verify: (version: string, file: string, kind: Distribution) => Promise<Verified>;
  log: (line: string) => void;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const versionOf = (info: unknown): string | undefined => {
  const version = (info as { version?: unknown } | null)?.version;
  return typeof version === 'string' ? version : undefined;
};
const fileOf = (value: unknown): string | undefined => {
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  const file = (value as { downloadedFile?: unknown } | null)?.downloadedFile;
  return typeof file === 'string' ? file : undefined;
};
/** electron-updater's own sha512 check failing is a bad download, not a network problem */
const codeOf = (err: unknown): ShellUpdateError => (/sha512|checksum/i.test(messageOf(err)) ? 'bad-signature' : 'fetch-failed');

export class DesktopUpdater {
  private current: UpdateState;
  private readonly listeners = new Set<(state: UpdateState) => void>();
  private engineInstance: UpdaterEngine | undefined;
  /** Set by install({ whenIdle }): the quit path installs the downloaded update once the server is down */
  private installOnQuitRequested = false;
  /** Where the AppImage ended up: a hand-downloaded, versioned file name is replaced by the new version's */
  private appImagePath: string | undefined;
  /** The verified AppImage, checked again right before it is installed */
  private downloaded: { version: string; file: string } | undefined;
  /** The newest release a check found, whatever the state shows now */
  private latestFound: string | undefined;
  private replaced = false;
  /** What the engine's `update-downloaded` event said, for an engine whose promise does not */
  private downloadedFile: string | undefined;

  constructor(private readonly opts: DesktopUpdaterOptions) {
    this.current = 'supported' in opts.support ? this.restingState() : opts.support;
  }

  get state(): UpdateState {
    return this.current;
  }

  get distribution(): Distribution | undefined {
    return 'supported' in this.opts.support ? this.opts.support.distribution : undefined;
  }

  /** Whether the system's updater installs this app; read again at every check */
  get aptManaged(): boolean {
    return this.distribution === 'deb' && (this.opts.aptManaged?.() ?? false);
  }

  /** The version a restart installs or starts: a verified AppImage, or the one apt put in place */
  get readyVersion(): string | undefined {
    return this.current.status === 'ready' || this.current.status === 'shell-replaced' ? this.current.version : undefined;
  }

  /** The newest release the last check found, null when none was newer or none ran */
  get latest(): string | undefined {
    return this.latestFound;
  }

  get installOnQuit(): boolean {
    return this.installOnQuitRequested && this.current.status === 'ready';
  }

  /** The new AppImage's path when the updater renamed it, for the relaunch */
  get installedAppImage(): string | undefined {
    return this.appImagePath;
  }

  onState(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private set(state: UpdateState): void {
    // Once apt replaced the app, a restart is the only thing left to do with this process
    if (this.replaced && state.status !== 'shell-replaced') return;
    // The engine's events and this module's own steps often say the same thing; say it once
    if (JSON.stringify(state) === JSON.stringify(this.current)) return;
    this.current = state;
    for (const listener of this.listeners) listener(state);
  }

  /** What a supported copy shows when nothing is under way */
  private restingState(): UpdateState {
    return this.aptManaged ? { status: 'apt-managed', latest: this.latestFound ?? null } : { status: 'idle' };
  }

  private get busy(): boolean {
    const s = this.current.status;
    return s === 'downloading' || s === 'verifying' || s === 'ready' || s === 'copy-command' || s === 'shell-replaced';
  }

  private get engine(): UpdaterEngine | undefined {
    if (!('supported' in this.opts.support)) return undefined;
    if (this.engineInstance) return this.engineInstance;
    const engine = this.opts.engine();
    engine.autoDownload = false;
    engine.autoInstallOnAppQuit = false;
    engine.logger = {
      info: (m) => this.opts.log(`updater: ${String(m)}`),
      warn: (m) => this.opts.log(`updater warning: ${String(m)}`),
      error: (m) => this.opts.log(`updater error: ${String(m)}`),
    };
    engine.on('download-progress', (progress) => {
      const percent = (progress as { percent?: unknown } | null)?.percent;
      const s = this.current;
      if (typeof percent === 'number' && Number.isFinite(percent) && s.status === 'downloading') {
        this.set({ status: 'downloading', version: s.version, percent: Math.max(0, Math.min(100, Math.round(percent))) });
      }
    });
    engine.on('update-downloaded', (info) => {
      this.downloadedFile = fileOf(info) ?? this.downloadedFile;
    });
    engine.on('appimage-filename-updated', (path) => {
      if (typeof path === 'string') this.appImagePath = path;
    });
    // The calls below reject with the same error; an emitter with no listener would throw it again
    engine.on('error', (err) => this.opts.log(`updater error: ${messageOf(err)}`));
    this.engineInstance = engine;
    return engine;
  }

  /**
   * Asks GitHub's latest-linux.yml whether there is a newer version; the state says what it found.
   * A `.deb` under apt only learns the version: the system's updater installs it.
   */
  async check(): Promise<UpdateState> {
    const engine = this.engine;
    if (!engine || this.busy) return this.current;
    const apt = this.aptManaged;
    if (!apt) this.set({ status: 'checking' });
    try {
      const result = await engine.checkForUpdates();
      this.latestFound = result?.isUpdateAvailable ? versionOf(result.updateInfo) : undefined;
      if (apt) this.set({ status: 'apt-managed', latest: this.latestFound ?? null });
      else this.set(this.latestFound ? { status: 'available', version: this.latestFound } : { status: 'idle' });
    } catch (err) {
      this.set(apt ? { status: 'apt-managed', latest: null } : { status: 'error', code: codeOf(err), message: messageOf(err) });
    }
    return this.current;
  }

  /**
   * Downloads the newest release, checking first when nothing is known about it yet, then checks it
   * against the signed desktop manifest: an AppImage is then `ready`; a `.deb` is `copy-command`.
   * A file that fails the check is never offered.
   */
  async download(): Promise<UpdateState> {
    const engine = this.engine;
    if (!engine || this.busy || this.aptManaged) return this.current;
    const found = this.current.status === 'available' ? this.current : await this.check();
    if (found.status !== 'available') return found;
    const { version } = found;
    this.set({ status: 'downloading', version, percent: 0 });
    this.downloadedFile = undefined;
    let file: string | undefined;
    try {
      file = fileOf(await engine.downloadUpdate()) ?? this.downloadedFile;
    } catch (err) {
      this.set({ status: 'error', code: codeOf(err), message: messageOf(err) });
      return this.current;
    }
    if (!file) {
      this.set({ status: 'error', code: 'other', message: 'the updater did not say where it put the download' });
      return this.current;
    }
    return this.verify(version, file);
  }

  private async verify(version: string, file: string): Promise<UpdateState> {
    const kind = this.distribution;
    if (!kind) return this.current;
    this.set({ status: 'verifying', version });
    const checked = await this.opts.verify(version, file, kind);
    if (!checked.ok) {
      this.opts.log(`update ${version} refused: ${checked.message}`);
      this.set({ status: 'error', code: checked.code, message: checked.message });
      return this.current;
    }
    if (kind === 'appimage') {
      this.downloaded = { version, file };
      this.set({ status: 'ready', version });
      return this.current;
    }
    try {
      this.set({ status: 'copy-command', version, command: debInstallCommand(file, version, checked.sha256) });
    } catch (err) {
      this.set({ status: 'error', code: 'other', message: messageOf(err) });
    }
    return this.current;
  }

  /** apt installed `version` under the running app (`<resources>/shell.json` changed): only a restart is left */
  markReplaced(version: string): void {
    if (this.replaced) return;
    this.replaced = true;
    this.installOnQuitRequested = false;
    this.set({ status: 'shell-replaced', version });
  }

  /**
   * The update applies the next time the app quits. electron-updater's own `autoInstallOnAppQuit`
   * only takes effect when it is already on as the download finishes, and it installs on Electron's
   * `quit` whatever the server child is doing; the quit path asks `installOnQuit` and calls `install`
   * itself instead, after the server is down.
   */
  requestInstallOnQuit(): boolean {
    if (this.current.status !== 'ready') return false;
    this.installOnQuitRequested = true;
    return true;
  }

  /**
   * Replaces the AppImage with the downloaded update; the caller has stopped the server and quits
   * after. The file is checked against the signed manifest again first: it sat in the person's
   * cache since the download.
   */
  async install(): Promise<boolean> {
    const engine = this.engine;
    const downloaded = this.downloaded;
    if (!engine || this.current.status !== 'ready' || this.distribution !== 'appimage' || !downloaded) return false;
    const checked = await this.opts.verify(downloaded.version, downloaded.file, 'appimage');
    if (!checked.ok) {
      this.opts.log(`update ${downloaded.version} refused before installing: ${checked.message}`);
      this.downloaded = undefined;
      this.set({ status: 'error', code: checked.code, message: checked.message });
      return false;
    }
    try {
      // Silent, and no run after: the caller relaunches once this process has exited, so the new
      // instance does not lose the single-instance lock to the one still shutting down
      return engine.install(true, false);
    } catch (err) {
      this.set({ status: 'error', code: 'other', message: messageOf(err) });
      return false;
    }
  }
}

/**
 * How the new AppImage is started once this process is gone. Not `app.relaunch()`: on Linux that
 * hands the job to a helper run from Electron's own binary, which inside an AppImage lives in the
 * image's mount, and the mount goes away as this process exits, taking the helper with it before it
 * starts anything. A shell outside the mount waits for this process to exit, so the new instance
 * gets the single-instance lock, and then runs the AppImage's real path.
 *
 * Chromium leaves some descriptors inheritable (the DevTools socket among them), and whatever reaches
 * the new instance keeps files of the old mount open, so the old image's FUSE process never exits.
 * The shell closes everything above stderr before it runs the new one. Bash, because a plain sh
 * cannot close a descriptor above 9, and the AppImage's own AppRun already needs it.
 */
export function appImageRelaunch(pid: number, appImage: string, args: readonly string[]): { command: string; args: string[] } {
  const script = [
    'for fd in /proc/$$/fd/*; do n=${fd##*/}; if [ "$n" -gt 2 ]; then eval "exec $n>&-"; fi; done 2>/dev/null',
    'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done',
    'shift',
    'exec "$@"',
  ].join('\n');
  return { command: '/bin/bash', args: ['-c', script, 'claudio-relaunch', String(pid), appImage, ...args] };
}

/** What is live that a restart would stop: the tray's counts, and the open terminals (D6) */
export interface LiveWork {
  working: number;
  waiting: number;
  running: number;
  terminals: number;
}

export const liveWorkOf = (snapshot: LiveSnapshot, terminals: number): LiveWork => ({
  working: snapshot.working,
  waiting: snapshot.waiting,
  running: snapshot.running,
  terminals,
});

const isBusy = (w: LiveWork) => w.working > 0 || w.waiting > 0 || w.running > 0 || w.terminals > 0;

/** "2 working · 1 orchestration · 1 terminal", or null when nothing is live */
export function workWords(w: LiveWork): string | null {
  const parts: string[] = [];
  if (w.working) parts.push(`${w.working} working`);
  if (w.waiting) parts.push(`${w.waiting} waiting`);
  if (w.running) parts.push(`${w.running} ${w.running === 1 ? 'orchestration' : 'orchestrations'}`);
  if (w.terminals) parts.push(`${w.terminals} ${w.terminals === 1 ? 'terminal' : 'terminals'}`);
  return parts.length ? parts.join(' · ') : null;
}

export type InstallAnswer =
  | { status: 'restarting'; version: string }
  | { status: 'scheduled'; version: string }
  | { status: 'busy'; version: string; live: LiveWork }
  | { status: 'not-ready'; state: UpdateState };

export interface InstallRequest {
  /** Install the next time the app quits instead of now */
  whenIdle?: boolean;
  /** Restart even though work is live: the person was asked and said so */
  force?: boolean;
}

/**
 * What `install` does with the update, given what is live. A restart stops the server, and with it
 * every chat, orchestration and terminal in flight, so it never happens over live work unless the
 * person was asked (`force`); a chat waiting for a permission answer counts too, its CLI is running.
 * A downloaded AppImage installs on restart or on quit; a shell apt replaced is already installed,
 * so the next start, now or after a quit, is the new version.
 */
export function installDecision(state: UpdateState, live: LiveWork, request: InstallRequest): InstallAnswer {
  if (state.status !== 'ready' && state.status !== 'shell-replaced') return { status: 'not-ready', state };
  if (request.whenIdle) return { status: 'scheduled', version: state.version };
  if (!request.force && isBusy(live)) return { status: 'busy', version: state.version, live };
  return { status: 'restarting', version: state.version };
}

/** The request the page sent over IPC, reduced to the two flags it may carry */
export function parseInstallRequest(value: unknown): InstallRequest {
  if (!value || typeof value !== 'object') return {};
  const { whenIdle, force } = value as Record<string, unknown>;
  return { whenIdle: whenIdle === true, force: force === true };
}
