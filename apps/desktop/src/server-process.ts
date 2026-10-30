import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:os';
import { createInterface } from 'node:readline';
import { withServerThreadpool } from '@claudio/core/launcher/protocol';
import type { LogFile } from './log.ts';

const READY_PREFIX = 'CLAUDIO_READY ';
const READY_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 5_000;

export interface ServerSpawn {
  entry: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/**
 * The secret the tray authenticates with, new at each launch. The owner can guard the server from
 * its Security panel, which keeps only a hash of the token: the app never learns it, so without a
 * credential of its own the tray would poll unauthenticated forever. It exists in this process and
 * in the server's memory only, and is useless once the app quits.
 */
export function newDesktopSecret(): string {
  return randomBytes(32).toString('base64url');
}

export interface ServerEnvOptions {
  /** What the app inherited; everything the person set there reaches the server unchanged */
  base: NodeJS.ProcessEnv;
  PATH: string;
  /** The port this install used last, or null on a first start */
  rememberedPort: number | null;
  webDist: string;
  dataDir: string;
  workspaceDir: string;
  version: string;
  distribution: string | undefined;
  desktopSecret: string;
  /** The key for the server's secret files, from `secretKeyFor`; null when the keyring is not there */
  secretKey?: string | null;
  /** The payload this server runs: `<resources>/server`, or an overlay in `<dataDir>/app/<version>` */
  appDir: string;
  /** The shell's guard, whichever payload runs */
  guardEntry: string;
  /** The shell's public keys, which a downloaded payload must verify against */
  keysDir: string;
  /** The shell as the server reports it (`ShellInfo`); `inputs` is '' when the package has no `shell.json` */
  shell: { inputs: string; aptManaged: boolean };
}

export function serverEnv(opts: ServerEnvOptions): NodeJS.ProcessEnv {
  return {
    ...withServerThreadpool(opts.base),
    PATH: opts.PATH,
    // The port this install used last, so its address survives a restart; PORT still wins,
    // and 0 on a first start lets the operating system choose one to remember
    PORT: opts.base.PORT || String(opts.rememberedPort ?? 0),
    HOST: '127.0.0.1',
    CLAUDIO_WEB_DIST: opts.webDist,
    // Supervised by this shell (docs/plans/unified-updates.md, Environment variables): exit 75 starts
    // the server again, and the update routes take the shell's own credential (D8)
    CLAUDIO_LAUNCHER: 'desktop',
    CLAUDIO_APP_DIR: opts.appDir,
    // The guard and the keys are the shell's, never a payload's: an overlay lives in a folder the
    // person (and so an agent running as them) can write
    CLAUDIO_GUARD_ENTRY: opts.guardEntry,
    CLAUDIO_BUNDLE_KEYS_DIR: opts.keysDir,
    CLAUDIO_SHELL_VERSION: opts.version,
    CLAUDIO_SHELL_INPUTS: opts.shell.inputs,
    ...(opts.distribution ? { CLAUDIO_SHELL_PACKAGE: opts.distribution } : {}),
    CLAUDIO_SHELL_APT: opts.shell.aptManaged ? '1' : '0',
    CLAUDIO_DATA_DIR: opts.dataDir,
    CLAUDIO_WORKSPACE_DIR: opts.workspaceDir,
    CLAUDIO_VERSION: opts.version,
    // The UI offers the install that fits: this app's own updater, or instructions
    ...(opts.distribution ? { CLAUDIO_DISTRIBUTION: opts.distribution } : {}),
    CLAUDIO_DESKTOP_TOKEN: opts.desktopSecret,
    // Never inherited from the person's environment: only the keyring's key, or none at all
    CLAUDIO_SECRET_KEY: opts.secretKey ?? undefined,
    // The desktop is not a sandbox: CLAUDIO_DEFAULT_PERMISSION_MODE stays unset (core default: acceptEdits)
  };
}

/** Runs the bundled API on Electron's own Node (ELECTRON_RUN_AS_NODE) and tracks its lifecycle */
export class ServerProcess {
  private child: ChildProcess | undefined;
  private stopping = false;
  private lastDetail = '';
  private resolveExit: (code: number) => void = () => undefined;
  /** Resolves with the exit code of the server `start` spawned (128 + the signal's number for a signal) */
  readonly exited: Promise<number>;

  constructor(
    private readonly spec: ServerSpawn,
    private readonly log: LogFile,
    /** Called when the server dies after it was ready without having been asked to stop */
    private readonly onCrash: (detail: string) => void = () => undefined,
  ) {
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  /** How it ended: the exit, and the end of its stderr */
  get detail(): string {
    return this.lastDetail;
  }

  /** Sends a signal to the server, without waiting */
  signal(signal: NodeJS.Signals): void {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    this.stopping = true;
    child.kill(signal);
  }

  /** Resolves with the server URL once it printed its READY line. Once per instance. */
  start(): Promise<string> {
    return new Promise((resolve, reject) => {
      // The IPC channel makes the server exit by itself if this process dies without cleaning up
      const child = spawn(process.execPath, [this.spec.entry], {
        cwd: this.spec.cwd,
        env: { ...this.spec.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      this.child = child;
      this.stopping = false;
      this.log.line(`starting server: ${process.execPath} ${this.spec.entry} (pid ${child.pid})`);

      let ready = false;
      let stderrTail = '';
      const timer = setTimeout(() => {
        if (!ready) fail(new Error(`Server did not become ready within ${READY_TIMEOUT_MS / 1000}s`));
      }, READY_TIMEOUT_MS);

      const fail = (err: Error) => {
        clearTimeout(timer);
        child.kill('SIGKILL');
        reject(err);
      };

      // Logs and the READY line share stdout; match by prefix instead of expecting the first line
      createInterface({ input: child.stdout! }).on('line', (line) => {
        this.log.write(`${line}\n`);
        if (ready || !line.startsWith(READY_PREFIX)) return;
        try {
          const { url } = JSON.parse(line.slice(READY_PREFIX.length)) as { url: string };
          ready = true;
          clearTimeout(timer);
          resolve(url);
        } catch {
          fail(new Error(`Malformed READY line: ${line}`));
        }
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        this.log.write(chunk);
        stderrTail = (stderrTail + chunk.toString()).slice(-2000);
      });

      child.once('error', (err) => {
        this.log.line(`server failed to spawn: ${err.message}`);
        if (!ready) fail(err);
        // A process that never started emits no exit
        if (child.pid === undefined) {
          this.lastDetail = `The server could not be started: ${err.message}`;
          this.resolveExit(127);
        }
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        const how = signal ? `signal ${signal}` : `code ${code}`;
        this.log.line(`server exited with ${how}`);
        if (this.child === child) this.child = undefined;
        const detail = `The server exited with ${how}.${stderrTail ? `\n\n${stderrTail.trim()}` : ''}`;
        this.lastDetail = detail;
        this.resolveExit(code ?? 128 + (signal ? (constants.signals[signal] ?? 1) : 1));
        if (this.stopping) return;
        if (ready) this.onCrash(detail);
        else reject(new Error(detail));
      });
    });
  }

  /** SIGTERM, then SIGKILL if it does not leave within the grace period */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    this.stopping = true;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
      child.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  get running(): boolean {
    return this.child !== undefined;
  }
}
