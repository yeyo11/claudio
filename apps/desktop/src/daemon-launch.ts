// How the window finds its daemon or starts one (D2 of docs/plans/survive-restarts.md): in a
// transient user unit where a systemd user manager runs, so it outlives the window, the graphical
// session (D3, with linger) and its own crashes (`Restart=on-failure`); under `setsid` elsewhere.
// Free of Electron: the window hands in its facts, and the tests their fakes.
import { spawn, spawnSync } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { compareVersions } from '@claudio/core/launcher/protocol';
import { DAEMON_FLAG, lineReader, parseFromDaemon, type DaemonState, type FromDaemon, type ToDaemon } from './daemon-protocol.ts';

export interface LaunchInput {
  /** `systemctl --user is-system-running` answered `running` or `degraded` */
  userManager: boolean;
  unit: string;
  /** The desktop binary */
  execPath: string;
  /** `dist/daemon.cjs`, run on `execPath` as Node */
  daemonEntry: string;
  /** The AppImage file, when the app runs from one: the daemon runs from its own mount of it */
  appImage?: string;
  dataDir: string;
  logsDir: string;
  /** The window's environment, for a daemon started under `setsid` */
  env: NodeJS.ProcessEnv;
}

export interface LaunchPlan {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** `setsid`: its own session, out of the window's process group, never waited for */
  detached: boolean;
}

/**
 * The command that starts the daemon. Its own arguments are not secret (the unit shows them); the
 * window's environment and the keyring key travel over the socket instead, so nothing of them is
 * written to the unit or to disk.
 */
export function daemonLaunch(o: LaunchInput): LaunchPlan {
  const runtime = o.appImage ? [o.appImage, DAEMON_FLAG] : [o.execPath, o.daemonEntry];
  const args = ['--data-dir', o.dataDir, '--logs', o.logsDir];
  // Electron as Node; the AppImage's runtime starts the binary as the app, which routes on the flag
  const asNode = o.appImage ? {} : { ELECTRON_RUN_AS_NODE: '1' };
  if (!o.userManager) {
    const [command = o.execPath, ...rest] = runtime;
    return { command, args: [...rest, ...args], env: { ...o.env, ...asNode }, detached: true };
  }
  return {
    command: 'systemd-run',
    args: [
      '--user',
      '--quiet',
      `--unit=${o.unit}`,
      '--description=Claudio server supervisor',
      // Gone from the manager once it ends, so the name is free for the next start
      '--collect',
      '--property=Restart=on-failure',
      '--property=RestartSec=2',
      // SIGTERM to the daemon only: it closes its server itself, and parked CLIs live in scopes of their own
      '--property=KillMode=mixed',
      '--property=TimeoutStopSec=45',
      ...Object.entries(asNode).map(([k, v]) => `--setenv=${k}=${v}`),
      '--',
      ...runtime,
      ...args,
      '--unit',
      o.unit,
    ],
    env: o.env,
    detached: false,
  };
}

/** Whether a systemd user manager runs here: then the daemon gets a unit of its own */
export function hasUserManager(): boolean {
  const probe = spawnSync('systemctl', ['--user', 'is-system-running'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
  return ['running', 'degraded'].includes((probe.stdout ?? '').trim());
}

export interface Runner {
  /** Runs a command to its end; resolves to its exit code and what it wrote to stderr */
  run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stderr: string }>;
  /** Starts a command in its own session and lets it go */
  detach(command: string, args: string[], env: NodeJS.ProcessEnv): void;
}

export const NODE_RUNNER: Runner = {
  run: (command, args, env) =>
    new Promise((resolve) => {
      const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
      child.once('error', (err) => resolve({ code: 127, stderr: err.message }));
      child.once('exit', (code) => resolve({ code: code ?? 1, stderr }));
    }),
  detach: (command, args, env) => {
    spawn(command, args, { env, detached: true, stdio: 'ignore' }).unref();
  },
};

/**
 * Starts the daemon by its plan. A unit of the same name left `failed` by its own restarts is reset
 * and tried once more; a manager that still refuses gets the `setsid` start instead. Resolves to how
 * it was started.
 */
export async function startDaemon(input: LaunchInput, runner: Runner, log: (line: string) => void): Promise<'unit' | 'setsid'> {
  const plan = daemonLaunch(input);
  if (plan.detached) {
    runner.detach(plan.command, plan.args, plan.env);
    return 'setsid';
  }
  let result = await runner.run(plan.command, plan.args, plan.env);
  if (result.code !== 0) {
    log(`systemd-run refused the daemon's unit (${result.stderr.trim() || `code ${String(result.code)}`}); resetting it and trying once more`);
    await runner.run('systemctl', ['--user', 'reset-failed', input.unit], plan.env);
    result = await runner.run(plan.command, plan.args, plan.env);
  }
  if (result.code === 0) return 'unit';
  log(`systemd-run refused again (${result.stderr.trim() || `code ${String(result.code)}`}); starting the daemon under setsid`);
  const fallback = daemonLaunch({ ...input, userManager: false });
  runner.detach(fallback.command, fallback.args, fallback.env);
  return 'setsid';
}

export type AttachDecision = 'attach' | 'restart-server' | 'replace';

/**
 * What a window does with the daemon it found. Another protocol cannot be spoken to: it is replaced
 * (a hand-over, which parked work survives). A daemon that cannot follow a newer shell (the AppImage's
 * mount) of another version is replaced too. One that follows it but still serves an older bundled
 * payload starts its server again, onto the shell's files as they now are.
 */
export function attachDecision(state: Pick<DaemonState, 'protocol' | 'version' | 'followsShell' | 'boot'>, window: { protocol: number; version: string }): AttachDecision {
  if (state.protocol !== window.protocol) return 'replace';
  if (!state.followsShell) return state.version === window.version ? 'attach' : 'replace';
  if (state.boot?.bundled && compareVersions(state.boot.version, window.version) < 0) return 'restart-server';
  return 'attach';
}

/** One window's connection to the daemon */
export class DaemonClient {
  private closedListeners: Array<() => void> = [];

  private constructor(
    private readonly socket: Socket,
    onMessage: (message: FromDaemon) => void,
  ) {
    socket.on(
      'data',
      lineReader((line) => {
        const message = parseFromDaemon(line);
        if (message) onMessage(message);
      }),
    );
    socket.on('error', () => undefined);
    socket.on('close', () => {
      for (const listener of this.closedListeners) listener();
    });
  }

  static connect(path: string, onMessage: (message: FromDaemon) => void, timeoutMs = 2_000): Promise<DaemonClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`the daemon did not answer on ${path}`));
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(new DaemonClient(socket, onMessage));
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  send(message: ToDaemon): void {
    if (!this.socket.destroyed) this.socket.write(`${JSON.stringify(message)}\n`);
  }

  onClose(listener: () => void): void {
    this.closedListeners.push(listener);
  }

  get open(): boolean {
    return !this.socket.destroyed;
  }

  close(): void {
    this.closedListeners = [];
    this.socket.end();
  }
}
