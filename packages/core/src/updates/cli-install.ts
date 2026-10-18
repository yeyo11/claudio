import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, createWriteStream, lstatSync, mkdirSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { AuthMode, CliInstallError, CliVersionInfo } from '@claudio/shared';
import { VERSION, compareVersions } from '../launcher/protocol.ts';
import { satisfiesRange } from '../providers/detector.ts';

const run = promisify(execFile);

/** The native build the `claude-code` package installs on Linux x64: one file, the binary */
const PACKAGE = '@anthropic-ai/claude-code-linux-x64';
/**
 * Where the binary sits inside the package's tarball. Read with
 * `npm pack @anthropic-ai/claude-code-linux-x64@2.1.302 --dry-run` (2026-10-18): the package holds
 * LICENSE.md, README.md, package.json and `claude` (mode 0755), and npm tarballs put every file
 * under `package/`.
 */
const BINARY_IN_TARBALL = 'package/claude';
const REGISTRY = 'https://registry.npmjs.org';

/** A refusal the routes answer as `{ error, code }` with its status */
export class CliInstallRefusal extends Error {
  constructor(
    readonly statusCode: number,
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

class Failed extends Error {
  constructor(
    readonly code: CliInstallError,
    message: string,
  ) {
    super(message);
  }
}

export interface CliInstallerOptions {
  dataDir: string;
  distribution: string | undefined;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** The driver's range (`>=2.1 <3`): a version outside it is never installed */
  range: string;
  /** The version the image pins, and the one in use: an install must be newer than both */
  pinned: () => string | null;
  current: () => string | null;
  /** The newest published version, as the last registry check left it */
  latest: () => string | null;
  security: () => { mode: AuthMode; readOnly: boolean };
  /** After the CLI in use changed: what reads it again (providers, the system reading) */
  changed: () => Promise<void>;
}

/**
 * Claude Code updated in-app inside the container (docs/plans/container-polish.md, D4): the native
 * platform package from the npm registry, checked against its `dist.integrity`, its binary only (no
 * lifecycle script ever runs), into `/data/cli/<version>/bin/claude`. The image puts
 * `/data/cli/current/bin` first on PATH, and `current` is swapped with a rename, so the next CLI
 * process uses the new version and a running chat keeps its own.
 */
export class CliInstaller {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchFn: typeof fetch;
  private readonly root: string;
  private state: 'idle' | 'installing' | 'failed' = 'idle';
  private version: string | null = null;
  private error: CliInstallError | null = null;
  /** The install running now; tests await it */
  pending: Promise<void> | null = null;

  constructor(private readonly o: CliInstallerOptions) {
    this.env = o.env ?? process.env;
    this.fetchFn = o.fetch ?? fetch;
    this.root = join(o.dataDir, 'cli');
  }

  private get registry(): string {
    // The variable names the `latest` document of the main package (cli-version.ts); its registry is what comes before the scope
    const url = this.env.CLAUDIO_CLI_REGISTRY_URL?.trim();
    if (!url) return REGISTRY;
    const at = url.indexOf('/@anthropic-ai/');
    return (at >= 0 ? url.slice(0, at) : url).replace(/\/+$/, '');
  }

  /** Why installing is refused here, or null */
  private unsupported(): { status: number; reason: string; message: string } | null {
    if (this.o.distribution !== 'docker' || process.platform !== 'linux' || process.arch !== 'x64' || this.env.CLAUDIO_SERVER_UPDATE === 'off') {
      return { status: 400, reason: 'cli.unsupported', message: 'Claude Code is installed in-app only in the Linux x64 container' };
    }
    const { mode, readOnly } = this.o.security();
    if (readOnly) return { status: 400, reason: 'cli.unsupported', message: 'read-only mode is on' };
    if (mode === 'none') return { status: 403, reason: 'cli.needs-auth', message: 'installing Claude Code needs access protected by a token' };
    return null;
  }

  get installable(): boolean {
    return this.unsupported() === null;
  }

  /** Where the CLI at `path` comes from */
  source(path: string | null): CliVersionInfo['source'] {
    if (path) {
      const rel = relative(resolve(this.root), resolve(path));
      if (rel && !rel.startsWith('..') && !rel.startsWith(sep)) return 'data';
    }
    return this.o.distribution === 'docker' && this.o.pinned() !== null ? 'image' : 'path';
  }

  /** The fields `CliVersionInfo` takes from here */
  info(path: string | null): Pick<CliVersionInfo, 'source' | 'installable' | 'install'> {
    const installable = this.installable;
    return {
      source: this.source(path),
      installable,
      install: installable || this.state !== 'idle' ? { state: this.state, version: this.version, error: this.error } : null,
    };
  }

  /** Starts installing `version` (the newest known when absent); the checks that refuse it answer before anything downloads */
  install(requested?: string): void {
    const refused = this.unsupported();
    if (refused) throw new CliInstallRefusal(refused.status, refused.reason, refused.message);
    if (this.state === 'installing') throw new CliInstallRefusal(409, 'cli.busy', `Claude Code ${this.version ?? ''} is being installed`);
    const v = requested ?? this.o.latest();
    if (!v || !VERSION.test(v)) throw new CliInstallRefusal(400, 'cli.no-version', 'no newer Claude Code is known; check for one first');
    if (satisfiesRange(v, this.o.range) !== 'in') throw new CliInstallRefusal(422, 'cli.out-of-range', `Claudio does not support Claude Code ${v} (it supports ${this.o.range})`);
    const floor = [this.o.pinned(), this.o.current()].filter((x): x is string => x !== null);
    if (floor.some((x) => compareVersions(v, x) <= 0)) throw new CliInstallRefusal(422, 'cli.not-newer', `Claude Code ${v} is not newer than the one in use`);
    this.state = 'installing';
    this.version = v;
    this.error = null;
    this.pending = this.fetchAndSwap(v).finally(() => {
      this.pending = null;
    });
  }

  private async get(url: string, accept?: string): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchFn(url, { headers: accept ? { accept } : {}, signal: AbortSignal.timeout(10 * 60_000) });
    } catch (err) {
      throw new Failed('fetch-failed', err instanceof Error ? err.message : String(err));
    }
    if (!res.ok) throw new Failed('fetch-failed', `${url} answered ${String(res.status)}`);
    return res;
  }

  private async fetchAndSwap(v: string): Promise<void> {
    const staging = join(this.root, `.staging-${v}`);
    const tarball = `${staging}.tgz`;
    try {
      const doc = (await (await this.get(`${this.registry}/${PACKAGE}/${v}`, 'application/json')).json()) as { version?: unknown; dist?: { tarball?: unknown; integrity?: unknown } };
      const integrity = typeof doc.dist?.integrity === 'string' ? doc.dist.integrity : '';
      if (doc.version !== v || typeof doc.dist?.tarball !== 'string' || !integrity.startsWith('sha512-')) throw new Failed('fetch-failed', 'the registry sent no tarball for that version');
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(join(staging, 'bin'), { recursive: true });
      const res = await this.get(doc.dist.tarball);
      if (!res.body) throw new Failed('fetch-failed', 'the tarball came empty');
      const hash = createHash('sha512');
      const tap = new Transform({
        transform: (chunk: Buffer, _encoding, done) => {
          hash.update(chunk);
          done(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), tap, createWriteStream(tarball, { mode: 0o600 }));
      if (`sha512-${hash.digest('base64')}` !== integrity) throw new Failed('integrity', "the tarball does not match the registry's integrity");
      // The binary only: nothing else of the package is written, and no script of it runs
      await run('tar', ['-xzf', tarball, '-C', staging, '--no-same-owner', BINARY_IN_TARBALL]).catch(() => {
        throw new Failed('fetch-failed', `the tarball has no ${BINARY_IN_TARBALL}`);
      });
      const binary = join(staging, 'bin', 'claude');
      renameSync(join(staging, BINARY_IN_TARBALL), binary);
      rmSync(join(staging, 'package'), { recursive: true, force: true });
      chmodSync(binary, 0o755);
      const { stdout } = await run(binary, ['--version'], { timeout: 30_000 }).catch(() => ({ stdout: '' }));
      if (stdout.trim().split(/\s+/)[0] !== v) throw new Failed('version-mismatch', `the binary does not report ${v}`);
      const dir = join(this.root, v);
      rmSync(dir, { recursive: true, force: true });
      renameSync(staging, dir);
      // A rename over the old link is atomic: a CLI starting now finds either the old or the new one
      const next = join(this.root, `.current-${String(process.pid)}`);
      rmSync(next, { force: true });
      symlinkSync(v, next);
      renameSync(next, join(this.root, 'current'));
      this.state = 'idle';
      this.error = null;
      await this.o.changed().catch(() => undefined);
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      this.state = 'failed';
      this.error = err instanceof Failed ? err.code : (err as NodeJS.ErrnoException | null)?.code === 'ENOSPC' ? 'disk' : 'fetch-failed';
    } finally {
      rmSync(tarball, { force: true });
    }
  }

  /** Use the image's version again: the link goes, and the launcher removes the version at the next start */
  async uninstall(): Promise<void> {
    const link = join(this.root, 'current');
    let isLink = false;
    try {
      isLink = lstatSync(link).isSymbolicLink();
    } catch {
      // None
    }
    if (!isLink) throw new CliInstallRefusal(409, 'cli.not-installed', 'no Claude Code is installed in /data');
    unlinkSync(link);
    this.state = 'idle';
    this.version = null;
    this.error = null;
    await this.o.changed().catch(() => undefined);
  }
}
