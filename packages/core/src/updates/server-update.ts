import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { AuthMode, LiveWork, ServerUpdateApplyRequest, ServerUpdateError, ServerUpdateState, ServerUpdateStatus, ServerUpdateUnsupported } from '@claudio/shared';
import type { EventBus } from '../events.ts';
import {
  MANIFEST_FILE,
  SIGNATURE_FILE,
  checkOverlay,
  compareVersions,
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
} from '../launcher/protocol.ts';
import type { ReleaseAsset } from '../release-watch.ts';

const run = promisify(execFile);

/** How often a restart that waits for idleness looks at what is live */
const IDLE_CHECK_MS = 15_000;
/** Long enough for the 202 to reach the person before the process goes */
const RESTART_DELAY_MS = 250;

/** A refusal the routes answer as `{ error, code }` with its status; `live` goes with `update.live-work` */
export class ServerUpdateRefusal extends Error {
  constructor(
    readonly statusCode: number,
    readonly reason: string,
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
  fetch?: typeof fetch;
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

/**
 * In-app updates of Claudio inside its container (docs/plans/container-polish.md, D4). A release's
 * signed bundle is downloaded and checked here, unpacked into `/data/app/<version>` and named the
 * trial in `state.json`; a restart (exit 75) hands it to the image's launcher, which checks it
 * again, boots it and keeps it only once `/api/health` answers.
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
  private state: ServerUpdateState = 'idle';
  private target: string | null = null;
  private progress: number | null = null;
  private error: ServerUpdateError | null = null;
  private needsImage: { version: string; minImage: string } | null = null;
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

  private get keysDir(): string {
    return this.env.CLAUDIO_BUNDLE_KEYS_DIR || '/app/keys';
  }

  /** Why this server cannot update itself, or null; the owner-only check is the routes' */
  unsupportedReason(): ServerUpdateUnsupported | null {
    if (this.o.distribution !== 'docker') return 'not-docker';
    // `off` is the person's choice to update from the host; the card then shows the host's commands
    if (this.env.CLAUDIO_LAUNCHER !== '1' || this.env.CLAUDIO_SERVER_UPDATE === 'off') return 'no-launcher';
    if (loadKeys(this.keysDir).length === 0) return 'no-keys';
    const { mode, readOnly } = this.o.security();
    if (readOnly) return 'read-only';
    if (mode === 'none') return 'needs-auth';
    return null;
  }

  private get source(): 'image' | 'overlay' {
    const dir = this.env.CLAUDIO_APP_DIR;
    if (!dir) return 'image';
    const rel = relative(resolve(this.root), resolve(dir));
    return rel && !rel.startsWith('..') && !rel.startsWith(sep) ? 'overlay' : 'image';
  }

  status(): ServerUpdateStatus {
    const { lastRollback } = this.readState();
    return {
      unsupportedReason: this.unsupportedReason(),
      image: this.image().version,
      running: this.o.running,
      source: this.source,
      state: this.state,
      target: this.target,
      progress: this.progress,
      error: this.error,
      needsImage: this.needsImage,
      lastRollback,
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

  private assertSupported(): void {
    const reason = this.unsupportedReason();
    if (reason === 'needs-auth') throw new ServerUpdateRefusal(403, 'update.needs-auth', 'in-app updates need access protected by a token');
    if (reason) throw new ServerUpdateRefusal(400, 'update.unsupported', `this server cannot update itself (${reason})`);
  }

  private async get(url: string): Promise<Response> {
    let res: Response;
    try {
      // GitHub refuses a request without a user-agent
      res = await this.fetchFn(url, { headers: { 'user-agent': `claudio/${this.o.running}` }, signal: AbortSignal.timeout(10 * 60_000) });
    } catch (err) {
      throw new Failed('fetch-failed', err instanceof Error ? err.message : String(err));
    }
    if (!res.ok) throw new Failed('fetch-failed', `${url} answered ${String(res.status)}`);
    return res;
  }

  /** The newest release that may be offered, with its three assets, or why there is none */
  private offered(version: string | undefined): { version: string; manifest: ReleaseAsset; signature: ReleaseAsset; assets: ReleaseAsset[] } {
    const release = this.o.release();
    if (!release || (version !== undefined && version !== release.version)) throw new ServerUpdateRefusal(404, 'update.no-release', 'no release of that version is known; check for updates first');
    const v = release.version;
    const image = this.image().version;
    if (compareVersions(v, this.o.running) <= 0 || compareVersions(v, image) <= 0) throw new ServerUpdateRefusal(404, 'update.no-release', `${v} is not newer than what runs`);
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
    if (!verifyManifest(bytes, signature, loadKeys(this.keysDir))) throw new Failed('bad-signature', 'the manifest is not signed by an accepted key');
    const manifest = parseManifest(bytes);
    if (typeof manifest === 'string') throw new Failed('bad-manifest', manifest);
    if (manifest.version !== v) throw new Failed('bad-manifest', `the manifest is for ${manifest.version}`);
    return { bytes, signature, manifest };
  }

  private imageFits(manifest: BundleManifest): boolean {
    const image = this.image();
    return compareVersions(manifest.minImage, image.version) <= 0 && manifest.nodeAbi === process.versions.modules;
  }

  /**
   * After a release check: whether the newest release needs a newer image, from its signed
   * manifest, so the card can say so before anyone downloads. A failure leaves what was known.
   */
  async inspect(): Promise<void> {
    if (this.unsupportedReason() !== null) return;
    try {
      const offer = this.offered(undefined);
      const { manifest } = await this.manifest(offer.version, offer.manifest, offer.signature);
      this.needsImage = this.imageFits(manifest) ? null : { version: manifest.version, minImage: manifest.minImage };
    } catch {
      // Nothing newer, or not reachable now: the download says why when it is asked for
    }
  }

  /** Starts downloading the newest release (202); the manifest is fetched and judged before answering */
  async download(version?: string): Promise<ServerUpdateStatus> {
    this.assertSupported();
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
      return this.status();
    }
    if (!this.imageFits(fetched.manifest)) {
      this.needsImage = { version: v, minImage: fetched.manifest.minImage };
      this.set({ state: 'idle', target: null });
      throw new ServerUpdateRefusal(412, 'update.needs-image', `Claudio ${v} needs the image ${fetched.manifest.minImage} or later`);
    }
    this.needsImage = null;
    this.pending = this.unpack(v, fetched, offer.assets).finally(() => {
      this.pending = null;
    });
    return this.status();
  }

  private fail(err: unknown): void {
    const code: ServerUpdateError =
      err instanceof Failed ? err.code : (err as NodeJS.ErrnoException | null)?.code === 'ENOSPC' ? 'disk' : 'fetch-failed';
    this.set({ state: 'failed', error: code });
  }

  private async unpack(v: string, { bytes, signature, manifest }: { bytes: Buffer; signature: string; manifest: BundleManifest }, assets: ReleaseAsset[]): Promise<void> {
    const staging = join(this.root, `.staging-${v}`);
    const tarball = `${staging}.tar.gz`;
    try {
      const asset = assets.find((a) => a.name === manifest.tarball.name);
      if (!asset || !manifest.tarball.name.startsWith(bundleName(v))) throw new Failed('bad-manifest', `the release has no ${manifest.tarball.name}`);
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      const res = await this.get(asset.url);
      if (!res.body) throw new Failed('fetch-failed', 'the tarball came empty');
      const hash = createHash('sha256');
      let received = 0;
      const total = manifest.tarball.size;
      const count = new Transform({
        transform: (chunk: Buffer, _encoding, done) => {
          hash.update(chunk);
          received += chunk.length;
          if (received > total) {
            done(new Failed('bad-signature', 'the tarball is larger than the manifest says'));
            return;
          }
          this.progress = total > 0 ? received / total : null;
          done(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), count, createWriteStream(tarball, { mode: 0o600 }));
      if (received !== total || hash.digest('hex') !== manifest.tarball.sha256) throw new Failed('bad-signature', 'the tarball does not match its signed manifest');
      this.set({ state: 'verifying' });
      // Signed and hashed by now, so what tar writes is what CI built; the image ships GNU tar
      await run('tar', ['-xzf', tarball, '-C', staging, '--no-same-owner', '--no-same-permissions']).catch((err: unknown) => {
        throw new Failed((err as NodeJS.ErrnoException).code === 'ENOSPC' || /No space left/.test(String((err as { stderr?: unknown }).stderr)) ? 'disk' : 'bad-manifest', 'the tarball did not unpack');
      });
      writeFileSync(join(staging, MANIFEST_FILE), bytes);
      writeFileSync(join(staging, SIGNATURE_FILE), signature);
      const refused = checkOverlay({ dir: staging, version: v, keys: loadKeys(this.keysDir), image: this.image(), nodeAbi: process.versions.modules });
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
  async apply(request: ServerUpdateApplyRequest = {}): Promise<ServerUpdateStatus> {
    this.assertSupported();
    if (this.state !== 'ready' && this.state !== 'scheduled') throw new ServerUpdateRefusal(409, 'update.not-ready', 'no update is downloaded yet');
    return this.restartOver(request, false);
  }

  /** Back to the image's own `/app`: forgets every overlay, then restarts */
  async revert(request: ServerUpdateApplyRequest = {}): Promise<ServerUpdateStatus> {
    this.assertSupported();
    if (this.source !== 'overlay') throw new ServerUpdateRefusal(409, 'update.not-overlay', "this server already runs the image's version");
    return this.restartOver(request, true);
  }

  private async restartOver(request: ServerUpdateApplyRequest, revert: boolean): Promise<ServerUpdateStatus> {
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
      this.set({ state: 'scheduled', ...(revert ? { target: this.image().version } : {}) });
      return this.status();
    }
    const live = await this.o.liveWork();
    if (!request.force && busy(live)) {
      throw new ServerUpdateRefusal(409, 'update.live-work', 'chats or orchestrations are running; a restart would stop them', live);
    }
    this.restartNow(revert);
    return this.status();
  }

  /** A restart that waited for idleness is called off */
  cancelScheduled(): ServerUpdateStatus {
    if (this.state === 'scheduled') {
      this.stopIdleTimer();
      const state = this.readState();
      state.scheduled = null;
      writeState(this.stateFile, state);
      const trial = state.trial;
      this.set(trial ? { state: 'ready', target: trial } : { state: 'idle', target: null });
    }
    return this.status();
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
    const to = revert ? this.image().version : (this.target ?? '');
    this.o.audit({ method: 'POST', path: '/api/system/server-update/apply', summary: revert ? `restarting onto the image's Claudio ${to}` : `restarting onto Claudio ${to}` });
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

const busy = (live: LiveWork): boolean => live.working > 0 || live.waiting > 0 || live.running > 0;

