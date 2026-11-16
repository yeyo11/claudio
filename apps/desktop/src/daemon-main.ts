// The daemon's process: `daemon.ts` with the real server, files and clock. Run on the desktop binary
// as Node (`ELECTRON_RUN_AS_NODE=1 claudio daemon.cjs`), or for the AppImage as the binary's own main
// process (`Claudio.AppImage --claudio-daemon`), which keeps the AppImage's mount alive for as long as
// the daemon and its server run from it (S5 of docs/decisions/parked-cli-processes.md).
import { Daemon } from './daemon.ts';
import { LiveMonitor, monitorHeaders } from './live-monitor.ts';
import { LogFile } from './log.ts';
import { readShellJson } from './payload.ts';
import { rememberedPort } from './server-port.ts';
import { ServerProcess, serverEnv } from './server-process.ts';
import { DESKTOP_VERSION } from './version.ts';

const argOf = (argv: readonly string[], name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};

/** Runs the daemon until it ends; resolves to the exit code */
export async function daemonMain(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const dataDir = argOf(argv, '--data-dir');
  const logsDir = argOf(argv, '--logs');
  if (!dataDir || !logsDir) {
    process.stderr.write('claudio daemon: --data-dir and --logs are required\n');
    return 2;
  }
  // The AppImage runtime sets APPDIR: its files are in a mount that changes with every AppImage, so
  // a newer shell is never followed from here; it replaces this daemon instead
  const followsShell = !env.APPDIR;
  const log = new LogFile(logsDir, 'daemon.log', 'daemon');
  const serverLog = new LogFile(logsDir, 'server.log');
  const daemon = new Daemon({
    dataDir,
    version: DESKTOP_VERSION,
    followsShell,
    unit: argOf(argv, '--unit') ?? null,
    serverLogPath: serverLog.path,
    spawnServer: (boot, serverEnvironment, launch) => {
      const proc = new ServerProcess({ entry: boot.entry, cwd: launch.userData, env: serverEnvironment }, serverLog);
      return {
        ready: proc.start(),
        exited: proc.exited,
        stop: () => proc.signal('SIGTERM'),
        kill: () => proc.signal('SIGKILL'),
        detail: () => proc.detail,
        stopWork: () => proc.stopWork(),
      };
    },
    serverEnv: (launch, boot, token) => {
      const shell = readShellJson(launch.shellJson);
      return serverEnv({
        base: launch.env,
        PATH: launch.PATH,
        rememberedPort: rememberedPort(launch.userData),
        webDist: boot.webDist,
        dataDir: launch.dataDir,
        workspaceDir: launch.workspaceDir,
        version: launch.version,
        distribution: launch.distribution ?? undefined,
        desktopSecret: token,
        // Parked CLIs outlive the server only where everything they run from outlives it too: not
        // from an AppImage's mount, which goes with the daemon that holds it (S5)
        parkedByDefault: followsShell,
        secretKey: launch.secretKey,
        appDir: boot.dir,
        guardEntry: launch.guardEntry,
        keysDir: launch.keysDir,
        shellJson: launch.shellJson,
        shell: { inputs: shell && shell.version === launch.version ? shell.shellInputs : '', aptManaged: launch.aptManaged },
      });
    },
    health: async (origin) => {
      try {
        return (await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(5_000) })).status === 200;
      } catch {
        return false;
      }
    },
    watchIdle: (origin, token, onSnapshot) => new LiveMonitor({ origin, headers: monitorHeaders(token, {}), onSnapshot, log: (line) => log.line(line) }),
    log: (line) => log.line(line),
  });
  // `systemctl --user stop`, a logout without linger, a shutdown: the server closes as on any restart,
  // so parked work runs on and the next daemon adopts it
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => void daemon.stop('detach'));
  const code = await daemon.run();
  await Promise.all([log.close(), serverLog.close()]);
  return code;
}
