import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type {
  AuthMode,
  LiveWork,
  ServerUpdateApplyRequest,
  ServerUpdateBlocked,
  ServerUpdateError,
  ServerUpdateOffer,
  ServerUpdateRefusalCode,
  ServerUpdateState,
  ServerUpdateStatus,
  ServerUpdateUnsupported,
  ShellInfo,
} from '@claudio/shared';
import type { EventBus } from '../events.ts';
import {
  MANIFEST_FILE,
  SIGNATURE_FILE,
  VERSION,
  baseRefusal,
  checkOverlay,
  compareVersions,
  imageBase,
  loadKeys,
  overlayDir,
  parseManifest,
  readImageInfo,
  readState,
  RESTART_EXIT_CODE,
  verifyManifest,
  writeState,
  type BundleManifest,
  type ImageInfo,
  type PayloadBase,
} from '../launcher/protocol.ts';
import type { ReleaseAsset } from '../release-watch.ts';
import { DownloadError, downloadFile, fetchOpener, hashFile, type DownloadTuning } from './download.ts';
import { errorMessage } from '@claudio/shared';

const run = promisify(execFile);

/** How often a restart that waits for idleness looks at what is live */
const IDLE_CHECK_MS = 15_000;
/** Long enough for the 202 to reach the person before the process goes */
const RESTART_DELAY_MS = 250;

/** A refusal the routes answer as `{ error, code }` with its status; `live` goes with `update.live-work` */
export class ServerUpdateRefusal extends Error {
  constructor(
    readonly statusCode: number,
    readonly reason: ServerUpdateRefusalCode,
    message: string,
    readonly live?: LiveWork,
  ) {
    super(message);
  }
}

/** A failure of the download, by the code the card shows a sentence for */
class Failed extends Error {
  constructor(
    readonly code: ServerUpdateError,
    message: string,
  ) {
    super(message);
  }
}

export interface ServerUpdatesOptions {
  dataDir: string;
  distribution: string | undefined;
  /** The version this process runs */
  running: string;
  env?: NodeJS.ProcessEnv;
  /** For the manifest, and for the tarball too when `download.open` is not given (tests) */
  fetch?: typeof fetch;
  /** How the tarball is downloaded: `node:http` with three retries unless a test says otherwise */
  download?: DownloadTuning;
  /** The newest release and its assets, as the last release check left them */
  release: () => { version: string; assets: ReleaseAsset[] } | null;
  security: () => { mode: AuthMode; readOnly: boolean };
  liveWork: () => Promise<LiveWork>;
  /** What the server did by itself, as an audit row */
  audit: (row: { method: string; path: string; summary: string }) => void;
  events?: EventBus;
  /** Where `image.json` is: the image's `/app`, whichever bundle runs */
  imageDir?: string;
  idleCheckMs?: number;
}

const bundleName = (v: string) => `claudio-server-${v}-linux-x64`;

/** Who supervises this server: the image's launcher, the desktop shell, or nobody (a source install) */
type Host = 'image' | 'desktop' | null;

/**
 * The desktop shell's facts, from the variables it sets when it starts the server. Null outside the
 * desktop, or when the shell did not say (an older shell, a run from a checkout).
 */
export function shellFromEnv(env: NodeJS.ProcessEnv): ShellInfo | null {
  if (env.CLAUDIO_LAUNCHER !== 'desktop') return null;
  const version = env.CLAUDIO_SHELL_VERSION;
  const pkg = env.CLAUDIO_SHELL_PACKAGE;
  if (!version || !VERSION.test(version) || (pkg !== 'appimage' && pkg !== 'deb')) return null;
  return { version, package: pkg, shellInputs: env.CLAUDIO_SHELL_INPUTS ?? '', aptManaged: env.CLAUDIO_SHELL_APT === '1' };
}

/**
 * In-app updates of Claudio's payload (docs/plans/container-polish.md, D4; docs/plans/unified-updates.md,
 * D1). A release's signed bundle is downloaded and checked here, unpacked into `<dataDir>/app/<version>`
 * and named the trial in `state.json`; a restart (exit 75) hands it to the host's launcher (the
 * image's `launcher.mjs`, or the desktop shell), which checks it again, boots it and keeps it only
 * once it answers.
 */
export class ServerUpdates {
  /** Set by the server: closes everything and exits with `RESTART_EXIT_CODE` */
  onRestart: () => Promise<void> | void = () => process.exit(RESTART_EXIT_CODE);
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchFn: typeof fetch;
  private readonly root: string;
  private readonly stateFile: string;
  private readonly imageFile: string;
  private readonly idleCheckMs: number;
  /** Read once: the shell does not change under a running server */
  private readonly shell: ShellInfo | null;
  private state: ServerUpdateState = 'idle';
  private target: string | null = null;
  private progress: number | null = null;
  private error: ServerUpdateError | null = null;
  private needsImage: { version: string; minImage: string } | null = null;
  private needsShell: { version: string; minShell: string } | null = null;
  private offer: ServerUpdateOffer | null = null;
  private inspecting: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private scheduledRevert = false;
  /** The download running now; tests await it */
  pending: Promise<void> | null = null;

  constructor(private readonly o: ServerUpdatesOptions) {
    this.env = o.env ?? process.env;
    this.fetchFn = o.fetch ?? fetch;
    this.root = join(o.dataDir, 'app');
    this.stateFile = join(this.root, 'state.json');
    this.imageFile = join(o.imageDir ?? '/app', 'image.json');
    this.idleCheckMs = o.idleCheckMs ?? IDLE_CHECK_MS;
    this.shell = shellFromEnv(this.env);
    // A bundle staged before this process started and not booted yet is still ready to restart onto
    const trial = this.readState().trial;
    if (trial && compareVersions(trial, o.running) > 0) {
      this.state = 'ready';
      this.target = trial;
    }
  }

  private readState() {
    return readState(this.stateFile);
  }

  /** The image's facts; a server started outside the image (tests, e2e) takes its own version for the image's */
  image(): ImageInfo {
    return readImageInfo(this.imageFile) ?? { version: this.o.running, imageInputs: '', nodeAbi: process.versions.modules, claudeCode: null };
  }

  /** Whether the desktop shell supervises this server: only then do the update routes take its credential (D8) */
  get desktopHost(): boolean {
    return this.env.CLAUDIO_LAUNCHER === 'desktop';
  }

  private get host(): Host {
    if (this.desktopHost) return 'desktop';
    return this.o.distribution === 'docker' && this.env.CLAUDIO_LAUNCHER === '1' ? 'image' : null;
  }

  /**
   * The payload an overlay replaces: the image's (`/app`), or the one bundled in the desktop shell,
   * whose version is the shell's. Elsewhere this server's own version stands in for it.
   */
  base(): PayloadBase {
    if (this.host === 'desktop') return { kind: 'shell', version: this.shell?.version ?? this.o.running, shellInputs: this.shell?.shellInputs ?? '' };
    return imageBase(this.image(), process.versions.modules);
  }

  /** Where the public keys that verify a bundle are: in the image, or in the shell's read-only resources */
  private get keysDir(): string | null {
    if (this.env.CLAUDIO_BUNDLE_KEYS_DIR) return this.env.CLAUDIO_BUNDLE_KEYS_DIR;
    // The shell always names its own; a guessed path on the desktop would trust nothing in particular
    return this.host === 'desktop' ? null : '/app/keys';
  }

  private keys() {
    return this.keysDir ? loadKeys(this.keysDir) : [];
  }

  /** Why this host cannot install an update at all, whoever asks */
  private hostReason(): ServerUpdateUnsupported | null {
    const desktop = this.o.distribution === 'appimage' || this.o.distribution === 'deb';
    if (this.desktopHost) {
      // A desktop app run from a checkout has no bundled payload of a release to fall back to
      if (!desktop) return 'development';
    } else if (this.o.distribution !== 'docker' && !desktop) {
      return 'not-docker';
    }
    // `off` is the person's choice to update from the host; the card then shows the host's way
    if (this.host === null || this.env.CLAUDIO_SERVER_UPDATE === 'off') return 'no-launcher';
    if (this.keys().length === 0) return 'no-keys';
    return null;
  }

  /**
   * Why this server cannot update itself, or null; the owner-only check is the routes'. Under auth
   * `none` nobody may, except the desktop shell itself (`fromShell`: its per-launch credential under
   * `CLAUDIO_LAUNCHER=desktop`), so an agent's `curl` to 127.0.0.1 cannot restart the server.
   */
  unsupportedReason(fromShell = false): ServerUpdateUnsupported | null {
    const host = this.hostReason();
    if (host) return host;
    const { mode, readOnly } = this.o.security();
    if (readOnly) return 'read-only';
    if (mode === 'none' && !(fromShell && this.host === 'desktop')) return 'needs-auth';
    return null;
  }

  private get source(): 'image' | 'overlay' {
    const dir = this.env.CLAUDIO_APP_DIR;
    if (!dir) return 'image';
    const rel = relative(resolve(this.root), resolve(dir));
    return rel && !rel.startsWith('..') && !rel.startsWith(sep) ? 'overlay' : 'image';
  }

  /** The status as `fromShell` sees it: the desktop shell's own requests are not refused for auth `none` */
  status(fromShell = false): ServerUpdateStatus {
    const { lastRollback, bad } = this.readState();
    const base = this.base();
    // An offer this server has since outrun is no offer; one that failed its trial since is not installable
    const offer = this.offer && compareVersions(this.offer.version, this.o.running) > 0 ? this.offer : null;
    return {
      unsupportedReason: this.unsupportedReason(fromShell),
      image: base.version,
      running: this.o.running,
      source: this.source,
      state: this.state,
      target: this.target,
      progress: this.progress,
      error: this.error,
      needsImage: this.needsImage,
      lastRollback,
      base: base.kind,
      shell: this.shell,
      needsShell: this.needsShell,
      offer: offer?.installable && bad.includes(offer.version) ? { version: offer.version, installable: false, blocked: 'failed-before' } : offer,
    };
  }

  private set(next: { state: ServerUpdateState; target?: string | null; progress?: number | null; error?: ServerUpdateError | null }): void {
    this.state = next.state;
    if (next.target !== undefined) this.target = next.target;
    this.progress = next.progress ?? null;
    this.error = next.error ?? null;
    const status = this.status();
    this.o.events?.emit({ type: 'system.server-update', title: `Claudio update: ${status.state}`, status });
  }

  private assertSupported(fromShell: boolean): void {
    const reason = this.unsupportedReason(fromShell);
    if (reason === 'needs-auth') throw new ServerUpdateRefusal(403, 'update.needs-auth', 'in-app updates need access protected by a token');
    if (reason) throw new ServerUpdateRefusal(400, 'update.unsupported', `this server cannot update itself (${reason})`);
  }

  private async get(url: string): Promise<Response> {
    let res: Response;
    try {
      // GitHub refuses a request without a user-agent
      res = await this.fetchFn(url, { headers: { 'user-agent': `claudio/${this.o.running}` }, signal: AbortSignal.timeout(10 * 60_000) });
    } catch (err) {
      throw new Failed('fetch-failed', errorMessage(err));
    }
    if (!res.ok) throw new Failed('fetch-failed', `${url} answered ${String(res.status)}`);
    return res;
  }

  /** The newest release that may be offered, with its three assets, or why there is none */
  private offered(version: string | undefined): { version: string; manifest: ReleaseAsset; signature: ReleaseAsset; assets: ReleaseAsset[] } {
    const release = this.o.release();
    if (!release || (version !== undefined && version !== release.version)) throw new ServerUpdateRefusal(404, 'update.no-release', 'no release of that version is known; check for updates first');
    const v = release.version;
    if (compareVersions(v, this.o.running) <= 0 || compareVersions(v, this.base().version) <= 0) throw new ServerUpdateRefusal(404, 'update.no-release', `${v} is not newer than what runs`);
    if (this.readState().bad.includes(v)) throw new ServerUpdateRefusal(404, 'update.no-release', `${v} did not start here before, so it is not offered again`);
    const manifest = release.assets.find((a) => a.name === `${bundleName(v)}.json`);
    const signature = release.assets.find((a) => a.name === `${bundleName(v)}.json.sig`);
    if (!manifest || !signature) throw new ServerUpdateRefusal(404, 'update.no-release', `the release ${v} has no server bundle`);
    return { version: v, manifest, signature, assets: release.assets };
  }

  /** The manifest, signed by an accepted key and made for this image, or the failure that says why not */
  private async manifest(v: string, manifestAsset: ReleaseAsset, signatureAsset: ReleaseAsset): Promise<{ bytes: Buffer; signature: string; manifest: BundleManifest }> {
    const bytes = Buffer.from(await (await this.get(manifestAsset.url)).arrayBuffer());
    const signature = await (await this.get(signatureAsset.url)).text();
    if (!verifyManifest(bytes, signature, this.keys())) throw new Failed('bad-signature', 'the manifest is not signed by an accepted key');
    const manifest = parseManifest(bytes);
    if (typeof manifest === 'string') throw new Failed('bad-manifest', manifest);
    if (manifest.version !== v) throw new Failed('bad-manifest', `the manifest is for ${manifest.version}`);
    return { bytes, signature, manifest };
  }

  /**
   * Whether a bundle fits this host's base (the image and its Node's ABI, or the desktop shell's
   * version against `minShell`), kept as `needsImage`/`needsShell` so the card can say so before
   * anyone downloads. Null when it fits, else what it needs.
   */
  private judgeFit(manifest: BundleManifest): ServerUpdateBlocked | null {
    const fits = baseRefusal(manifest, this.base()) === null;
    const desktop = this.base().kind === 'shell';
    this.needsImage = fits || desktop ? null : { version: manifest.version, minImage: manifest.minImage };
    this.needsShell = fits || !desktop ? null : { version: manifest.version, minShell: manifest.minShell };
    if (fits) return null;
    return desktop ? 'needs-shell' : 'needs-image';
  }

  /**
   * The installable check, after every release check and at start (owner's test, 2026-10-18: a
   * release without a bundle was offered for a download that could only fail). It judges the newest
   * release from its assets and its signed manifest, so the card never offers what cannot install.
   * A host that cannot update at all is not judged, and nothing but the manifest is fetched.
   */
  async inspect(): Promise<void> {
    // The daily check's hook and the button's own call are one judgement
    this.inspecting ??= this.judgeRelease().finally(() => {
      this.inspecting = null;
    });
    await this.inspecting;
  }

  private async judgeRelease(): Promise<void> {
    if (this.hostReason() !== null) return;
    const release = this.o.release();
    if (!release || compareVersions(release.version, this.o.running) <= 0 || compareVersions(release.version, this.base().version) <= 0) {
      this.offer = null;
      this.needsImage = null;
      this.needsShell = null;
      return;
    }
    const v = release.version;
    const judge = (blocked: ServerUpdateBlocked | null) => {
      this.offer = { version: v, installable: blocked === null, blocked };
    };
    if (this.readState().bad.includes(v)) return judge('failed-before');
    const manifestAsset = release.assets.find((a) => a.name === `${bundleName(v)}.json`);
    const signatureAsset = release.assets.find((a) => a.name === `${bundleName(v)}.json.sig`);
    if (!manifestAsset || !signatureAsset) return judge('no-bundle');
    let manifest: BundleManifest;
    try {
      manifest = (await this.manifest(v, manifestAsset, signatureAsset)).manifest;
    } catch {
      // Unreachable now, or not signed by a key this host trusts: either way nothing is offered
      return judge('unverified');
    }
    if (!manifest.tarball.name.startsWith(bundleName(v)) || !release.assets.some((a) => a.name === manifest.tarball.name)) return judge('no-bundle');
    judge(this.judgeFit(manifest));
  }

  /** Starts downloading the newest release (202); the manifest is fetched and judged before answering */
  async download(version?: string, fromShell = false): Promise<ServerUpdateStatus> {
    this.assertSupported(fromShell);
    if (this.state === 'downloading' || this.state === 'verifying' || this.state === 'restarting' || this.state === 'scheduled') {
      throw new ServerUpdateRefusal(409, 'update.busy', `an update is already ${this.state}`);
    }
    const offer = this.offered(version);
    const v = offer.version;
    this.set({ state: 'downloading', target: v, progress: 0 });
    let fetched: { bytes: Buffer; signature: string; manifest: BundleManifest };
    try {
      fetched = await this.manifest(v, offer.manifest, offer.signature);
    } catch (err) {
      this.fail(err);
      return this.status(fromShell);
    }
    const blocked = this.judgeFit(fetched.manifest);
    if (blocked !== null) {
      this.offer = { version: v, installable: false, blocked };
      this.set({ state: 'idle', target: null });
      if (blocked === 'needs-shell') throw new ServerUpdateRefusal(412, 'update.needs-shell', `Claudio ${v} needs the desktop app ${fetched.manifest.minShell} or later`);
      throw new ServerUpdateRefusal(412, 'update.needs-image', `Claudio ${v} needs the image ${fetched.manifest.minImage} or later`);
    }
    this.pending = this.unpack(v, fetched, offer.assets).finally(() => {
      this.pending = null;
    });
    return this.status(fromShell);
  }

  private fail(err: unknown): void {
    this.set({ state: 'failed', error: failureCode(err) });
  }

  private async unpack(v: string, { bytes, signature, manifest }: { bytes: Buffer; signature: string; manifest: BundleManifest }, assets: ReleaseAsset[]): Promise<void> {
    const staging = join(this.root, `.staging-${v}`);
    const tarball = `${staging}.tar.gz`;
    try {
      const asset = assets.find((a) => a.name === manifest.tarball.name);
      if (!asset || !manifest.tarball.name.startsWith(bundleName(v))) throw new Failed('bad-manifest', `the release has no ${manifest.tarball.name}`);
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      const total = manifest.tarball.size;
      const { bytes: received } = await downloadFile(asset.url, tarball, {
        // An injected `fetch` (tests) serves the tarball too; the server itself downloads over node:http
        ...(this.o.fetch ? { open: fetchOpener(this.o.fetch) } : {}),
        ...this.o.download,
        headers: { 'user-agent': `claudio/${this.o.running}` },
        size: total,
        onProgress: (n) => {
          this.progress = total > 0 ? n / total : null;
        },
      });
      // On the whole file as it lies on disk, whatever number of attempts and resumes it took
      if (received !== total || (await hashFile(tarball, 'sha256')) !== manifest.tarball.sha256) throw new Failed('bad-signature', 'the tarball does not match its signed manifest');
      this.set({ state: 'verifying' });
      // Signed and hashed by now, so what tar writes is what CI built; the image ships GNU tar
      await run('tar', ['-xzf', tarball, '-C', staging, '--no-same-owner', '--no-same-permissions']).catch((err: unknown) => {
        throw new Failed((err as NodeJS.ErrnoException).code === 'ENOSPC' || /No space left/.test(String((err as { stderr?: unknown }).stderr)) ? 'disk' : 'bad-manifest', 'the tarball did not unpack');
      });
      writeFileSync(join(staging, MANIFEST_FILE), bytes);
      writeFileSync(join(staging, SIGNATURE_FILE), signature);
      const refused = checkOverlay({ dir: staging, version: v, keys: this.keys(), base: this.base() });
      if (refused) throw new Failed('bad-signature', refused);
      const dir = overlayDir(this.root, v);
      rmSync(dir, { recursive: true, force: true });
      renameSync(staging, dir);
      const state = this.readState();
      state.trial = v;
      state.attempts = 0;
      writeState(this.stateFile, state);
      this.set({ state: 'ready', target: v });
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      this.fail(err);
    } finally {
      rmSync(tarball, { force: true });
    }
  }

  /** Restarts onto the downloaded bundle, asking first when work is live (the desktop's rule) */
  async apply(request: ServerUpdateApplyRequest = {}, fromShell = false): Promise<ServerUpdateStatus> {
    this.assertSupported(fromShell);
    if (this.state !== 'ready' && this.state !== 'scheduled') throw new ServerUpdateRefusal(409, 'update.not-ready', 'no update is downloaded yet');
    return this.restartOver(request, false, fromShell);
  }

  /** Back to the base payload (the image's `/app`, or the desktop shell's own): forgets every overlay, then restarts */
  async revert(request: ServerUpdateApplyRequest = {}, fromShell = false): Promise<ServerUpdateStatus> {
    this.assertSupported(fromShell);
    if (this.source !== 'overlay') throw new ServerUpdateRefusal(409, 'update.not-overlay', 'this server already runs the base version');
    return this.restartOver(request, true, fromShell);
  }

  private async restartOver(request: ServerUpdateApplyRequest, revert: boolean, fromShell: boolean): Promise<ServerUpdateStatus> {
    if (request.whenIdle) {
      this.scheduledRevert = revert;
      this.stopIdleTimer();
      this.idleTimer = setInterval(() => {
        void this.o.liveWork().then((live) => {
          if (this.state === 'scheduled' && !busy(live)) this.restartNow(this.scheduledRevert);
        }, () => undefined);
      }, this.idleCheckMs);
      this.idleTimer.unref();
      if (!revert) {
        const state = this.readState();
        state.scheduled = this.target;
        writeState(this.stateFile, state);
      }
      this.set({ state: 'scheduled', ...(revert ? { target: this.base().version } : {}) });
      return this.status(fromShell);
    }
    const live = await this.o.liveWork();
    if (!request.force && busy(live)) {
      throw new ServerUpdateRefusal(409, 'update.live-work', 'chats, orchestrations or terminals are running; a restart would stop them', live);
    }
    this.restartNow(revert);
    return this.status(fromShell);
  }

  /** A restart that waited for idleness is called off */
  cancelScheduled(fromShell = false): ServerUpdateStatus {
    if (this.state === 'scheduled') {
      this.stopIdleTimer();
      const state = this.readState();
      state.scheduled = null;
      writeState(this.stateFile, state);
      const trial = state.trial;
      this.set(trial ? { state: 'ready', target: trial } : { state: 'idle', target: null });
    }
    return this.status(fromShell);
  }

  private restartNow(revert: boolean): void {
    this.stopIdleTimer();
    const state = this.readState();
    state.scheduled = null;
    if (revert) {
      state.trial = null;
      state.active = null;
      state.previous = null;
      state.attempts = 0;
    }
    if (existsSync(this.root)) writeState(this.stateFile, state);
    const base = this.base();
    const to = revert ? base.version : (this.target ?? '');
    const where = base.kind === 'shell' ? "the desktop app's" : "the image's";
    this.o.audit({ method: 'POST', path: '/api/system/server-update/apply', summary: revert ? `restarting onto ${where} Claudio ${to}` : `restarting onto Claudio ${to}` });
    this.set({ state: 'restarting', target: to });
    setTimeout(() => void this.onRestart(), RESTART_DELAY_MS).unref();
  }

  /** At start: a rollback the launcher made since the last start becomes an audit row, once */
  auditRollback(): void {
    if (!existsSync(this.stateFile)) return;
    const state = this.readState();
    const rollback = state.lastRollback;
    if (!rollback || state.rollbackAudited === rollback.at) return;
    this.o.audit({ method: 'POST', path: '/api/system/server-update/rollback', summary: `Claudio ${rollback.from} did not start; the launcher went back to ${rollback.to}` });
    state.rollbackAudited = rollback.at;
    writeState(this.stateFile, state);
  }

  private stopIdleTimer(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  close(): void {
    this.stopIdleTimer();
  }
}

function failureCode(err: unknown): ServerUpdateError {
  if (err instanceof Failed) return err.code;
  if (err instanceof DownloadError) {
    if (err.kind === 'interrupted') return 'download-interrupted';
    // Another size than the signed manifest's cannot be the signed tarball
    if (err.kind === 'wrong-size') return 'bad-signature';
    if (err.kind === 'disk') return err.code === 'ENOSPC' || err.code === 'EDQUOT' ? 'disk' : 'fetch-failed';
    return 'fetch-failed';
  }
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOSPC' ? 'disk' : 'fetch-failed';
}

// An open terminal counts: its shell ends with the server (docs/plans/unified-updates.md, D6)
const busy = (live: LiveWork): boolean => live.working > 0 || live.waiting > 0 || live.running > 0 || live.terminals > 0;
