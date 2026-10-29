import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DatabaseSync } from 'node:sqlite';
import { createGunzip } from 'node:zlib';
import type { Workspace } from '@claudio/shared';
import { openDownload, type DownloadOptions } from './download.ts';
import { refuse, WorkspaceRefusal } from './refusal.ts';
import { overlaps, type WorkspaceSettings } from './settings.ts';
import { WorkspaceStore, type WorkspaceRecord } from './store.ts';
import { extractTar, within, type ExtractResult } from './tar.ts';

export { WorkspaceRefusal } from './refusal.ts';
export { workspaceSettingsFromEnv, DEFAULT_WORKSPACE_HOSTS, type WorkspaceSettings } from './settings.ts';

/** What the workspaces need of the chats: which run now and where, and a way to end them */
export interface WorkspaceChats {
  /** Chats with a live process, with the folders each runs in (its `cwd` and working directory) */
  running(): Array<{ id: string; dirs: string[] }>;
  stop(id: string): void;
  /** Resolves once the chat's process has exited */
  exited(id: string): Promise<void>;
}

export type WorkspaceSource = { kind: 'url'; url: string } | { kind: 'upload'; body: Readable };

export interface WorkspacesDeps {
  sql: DatabaseSync;
  settings: WorkspaceSettings;
  chats: WorkspaceChats;
  now?: () => number;
  /** Tests reach their own loopback server over http */
  download?: Pick<DownloadOptions, 'allowAddress' | 'protocols'>;
}

/** `ws_` and 16 characters of base64url: the only names the sweeper ever removes under the root */
const ID_RE = /^ws_[A-Za-z0-9_-]{16}$/;
const SWEEP_MS = 5 * 60_000;
/** How long `DELETE` waits for a stopped chat's process before removing the folder anyway */
const STOP_WAIT_MS = 10_000;
/** How long a removed workspace's row is kept, so its id answers `410` rather than `404` */
const KEEP_REMOVED_MS = 30 * 24 * 60 * 60_000;
/** A `removing` row this old was left by a process that stopped mid-way */
const STALE_REMOVING_MS = 10 * 60_000;

const MB = 1024 * 1024;
const mb = (bytes: number): string => String(Math.floor(bytes / MB));

const publicOf = (r: WorkspaceRecord): Workspace => ({
  id: r.id,
  source: r.source,
  host: r.host,
  bytes: r.bytes,
  files: r.files,
  createdAt: r.createdAt,
  lastUsedAt: r.lastUsedAt,
  expiresAt: r.expiresAt,
  state: r.state,
});

/** Every directory under `dir`, deepest first, never through a link */
async function directories(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...(await directories(join(dir, entry.name))));
  }
  out.push(dir);
  return out;
}

/**
 * Ephemeral workspaces (docs/plans/headless-image.md, D7): a copy of a source tree made from a
 * `tar.gz`, reached only by its id. `resolve`, `touch` and `root` are what a chat start needs.
 */
export class Workspaces {
  private readonly store: WorkspaceStore;
  /** Bytes written so far by the creations of this process, by id */
  private readonly inflight = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly deps: WorkspacesDeps) {
    this.store = new WorkspaceStore(deps.sql);
  }

  /** The folder every workspace lives under; no `cwd` may be, hold or sit inside it */
  get root(): string {
    return this.deps.settings.root;
  }

  get settings(): WorkspaceSettings {
    return this.deps.settings;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString();
  }

  private folderOf(id: string): string {
    return join(this.root, id);
  }

  /**
   * Whether a path is the workspaces root, inside it, or holds it: such a path is never a `cwd` or a
   * project. Judged on the path as written and as it resolves, so a symlink to a workspace (or a
   * `/proc/<pid>/cwd` of a chat running in one) names it too.
   */
  overlaps(path: string): boolean {
    const real = (p: string): string => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    };
    const given = resolve(path);
    return overlaps(given, this.root) || overlaps(real(given), real(this.root));
  }

  async create(source: WorkspaceSource): Promise<Workspace> {
    const { settings } = this.deps;
    let host: string | null = null;
    if (source.kind === 'url') {
      try {
        host = new URL(source.url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
      } catch {
        throw Object.assign(new Error('url is not a valid URL'), { statusCode: 400 });
      }
    }
    const id = `ws_${randomBytes(12).toString('base64url')}`;
    const at = this.now();
    // Reserved before a byte is downloaded, so concurrent creations at the cap cannot all pass
    if (!this.store.reserve({ id, source: source.kind, host, at: this.iso(at), expiresAt: this.iso(at + settings.ttlMs) }, settings.maxCount)) {
      throw refuse('workspace-limit', `there are already ${String(settings.maxCount)} workspaces; remove one or wait for one to expire`);
    }
    this.inflight.set(id, 0);
    const folder = this.folderOf(id);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
    try {
      await mkdir(this.root, { recursive: true, mode: 0o755 });
      await mkdir(folder, { mode: 0o755 });
      const input = source.kind === 'url' ? (await openDownload(source.url, { hosts: settings.hosts, maxBytes: settings.maxCompressedBytes, signal: controller.signal, ...this.deps.download })).body : source.body;
      const result = await this.extract(id, input, folder, controller.signal);
      for (const dir of await directories(folder)) await chmod(dir, 0o555);
      const done = this.now();
      this.store.ready(id, { bytes: result.bytes, files: result.files, topDir: result.topDir, at: this.iso(done), expiresAt: this.iso(done + settings.ttlMs) });
      const row = this.store.get(id);
      if (!row) throw new Error('the workspace row went missing');
      return publicOf(row);
    } catch (err) {
      // Over a cap or refused, nothing is left: neither the folder nor the row
      await this.removeFolder(folder).catch(() => undefined);
      this.store.forget(id);
      throw this.reworded(err, controller.signal);
    } finally {
      clearTimeout(timer);
      this.inflight.delete(id);
    }
  }

  private async extract(id: string, input: Readable, folder: string, signal: AbortSignal): Promise<ExtractResult> {
    const { settings } = this.deps;
    let compressed = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        compressed += chunk.length;
        if (compressed > settings.maxCompressedBytes) callback(refuse('workspace-too-large', `the archive is larger than ${mb(settings.maxCompressedBytes)} MB compressed`));
        else callback(null, chunk);
      },
    });
    let result: ExtractResult | null = null;
    await pipeline(
      input,
      counter,
      createGunzip(),
      async (chunks: AsyncIterable<Buffer>) => {
        result = await extractTar(chunks, folder, {
          maxBytes: settings.maxExtractedBytes,
          maxEntries: settings.maxEntries,
          onBytes: (n) => {
            let others = 0;
            for (const bytes of this.inflight.values()) others += bytes;
            if (this.store.readyBytes() + others + n > settings.maxTotalBytes) {
              throw refuse('workspace-too-large', `the workspaces would hold more than ${mb(settings.maxTotalBytes)} MB together`);
            }
            this.inflight.set(id, (this.inflight.get(id) ?? 0) + n);
          },
        });
      },
      { signal },
    );
    if (!result) throw refuse('workspace-bad-archive', 'the archive is empty');
    return result;
  }

  /**
   * What a failure says to the client. A refusal passes as it is; anything from the network is
   * reworded, since an error of the HTTP stack may carry what the request carried.
   */
  private reworded(err: unknown, signal: AbortSignal): Error {
    if (err instanceof WorkspaceRefusal) return err;
    if (signal.aborted) return refuse('workspace-timeout', `the archive was not downloaded and extracted within ${String(this.deps.settings.timeoutMs / 1000)} s`);
    const e = err as NodeJS.ErrnoException & { statusCode?: unknown };
    if (typeof e.statusCode === 'number' && err instanceof Error) return err;
    if (typeof e.code === 'string' && e.code.startsWith('Z_')) return refuse('workspace-bad-archive', 'the archive is not gzip-compressed, or it is damaged');
    if (e.code === 'ECONNRESET' || e.code === 'ERR_STREAM_PREMATURE_CLOSE' || e.code === 'ECONNABORTED') return refuse('workspace-download-failed', 'the archive was cut off before its end');
    // A file system error names a path of ours, which is safe to log; anything else is not passed on
    if (typeof e.path === 'string' && err instanceof Error) return err;
    return new Error('the workspace could not be created');
  }

  private record(id: string): WorkspaceRecord {
    const row = ID_RE.test(id) ? this.store.get(id) : null;
    if (!row) throw refuse('workspace-not-found', `workspace '${ID_RE.test(id) ? id : 'that id'}' does not exist`);
    if (row.removedAt) throw refuse('workspace-expired', `workspace '${id}' has expired or was removed`);
    return row;
  }

  get(id: string): Workspace {
    return publicOf(this.record(id));
  }

  /**
   * The working directory of a ready workspace: its single top-level directory when the archive
   * held one, else its folder. Throws a refusal with D7's codes otherwise.
   */
  resolve(id: string): string {
    const row = this.record(id);
    if (row.state === 'removing' || Date.parse(row.expiresAt) <= this.now()) throw refuse('workspace-expired', `workspace '${id}' has expired or was removed`);
    if (row.state !== 'ready') throw refuse('workspace-not-found', `workspace '${id}' is still being created`);
    const folder = this.folderOf(id);
    const dir = row.topDir ? join(folder, row.topDir) : folder;
    if (!existsSync(dir)) throw refuse('workspace-expired', `workspace '${id}' has expired or was removed`);
    return dir;
  }

  /** A chat started in it: the TTL counts from now */
  touch(id: string): void {
    const at = this.now();
    this.store.touch(id, this.iso(at), this.iso(at + this.deps.settings.ttlMs));
  }

  private chatsIn(id: string): string[] {
    const folder = this.folderOf(id);
    return this.deps.chats
      .running()
      .filter((chat) => chat.dirs.some((dir) => within(resolve(dir), folder)))
      .map((chat) => chat.id);
  }

  /** Stops the chats running in it, waits for them to exit (for a while), then removes it. */
  async remove(id: string): Promise<void> {
    const row = this.store.get(id);
    if (!ID_RE.test(id) || !row) throw refuse('workspace-not-found', `workspace '${ID_RE.test(id) ? id : 'that id'}' does not exist`);
    if (row.removedAt) return;
    if (row.state === 'creating') throw Object.assign(new Error(`workspace '${id}' is still being created`), { statusCode: 409 });
    // Another removal already holds it
    if (!this.store.startRemoving(id)) return;
    const chats = this.chatsIn(id);
    for (const chat of chats) this.deps.chats.stop(chat);
    if (chats.length > 0) {
      let wait: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all(chats.map((chat) => this.deps.chats.exited(chat).catch(() => undefined))),
        new Promise<void>((done) => {
          wait = setTimeout(done, STOP_WAIT_MS);
          wait.unref();
        }),
      ]);
      clearTimeout(wait);
    }
    await this.removeFolder(this.folderOf(id));
    this.store.removed(id, this.iso());
  }

  /**
   * Removes a workspace folder, and only one: a direct child of the root with a workspace's name.
   * Its directories are made writable again first, without following any link.
   */
  private async removeFolder(folder: string): Promise<void> {
    if (dirname(folder) !== this.root || !ID_RE.test(basename(folder))) throw new Error('not a workspace folder');
    const stat = await lstat(folder).catch(() => null);
    if (!stat) return;
    if (stat.isDirectory()) {
      for (const dir of (await directories(folder)).reverse()) await chmod(dir, 0o755).catch(() => undefined);
    }
    await rm(folder, { recursive: true, force: true });
  }

  /**
   * Removes what has expired and whose chats have ended, and what a stopped process left half
   * done. With `orphans`, also the `ws_*` folders under the root that no row knows, which is done
   * at start; nothing outside the root is ever touched. Answers how many workspaces went.
   */
  async sweep(opts: { orphans?: boolean } = {}): Promise<number> {
    const now = this.now();
    let removed = 0;
    for (const row of this.store.current()) {
      if (this.closed) return removed;
      if (this.inflight.has(row.id)) continue;
      if (row.state === 'ready' && Date.parse(row.expiresAt) <= now && this.chatsIn(row.id).length === 0) {
        await this.remove(row.id);
        removed++;
      } else if (row.state === 'creating' && Date.parse(row.createdAt) + 2 * this.deps.settings.timeoutMs < now) {
        await this.removeFolder(this.folderOf(row.id));
        this.store.forget(row.id);
        removed++;
      } else if (row.state === 'removing' && Date.parse(row.lastUsedAt) + STALE_REMOVING_MS < now && this.chatsIn(row.id).length === 0) {
        await this.removeFolder(this.folderOf(row.id));
        this.store.removed(row.id, this.iso(now));
        removed++;
      }
    }
    if (opts.orphans && existsSync(this.root)) {
      const known = new Set(this.store.current().map((row) => row.id));
      for (const entry of await readdir(this.root, { withFileTypes: true })) {
        if (entry.isDirectory() && ID_RE.test(entry.name) && !known.has(entry.name)) {
          await this.removeFolder(this.folderOf(entry.name));
          removed++;
        }
      }
    }
    this.store.pruneRemoved(this.iso(now - KEEP_REMOVED_MS));
    return removed;
  }

  /** The sweep at start, orphans included, and every five minutes after */
  start(): void {
    const run = (orphans: boolean): void => {
      void this.sweep({ orphans }).catch(() => undefined);
    };
    run(true);
    this.timer = setInterval(() => run(false), SWEEP_MS);
    this.timer.unref();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
