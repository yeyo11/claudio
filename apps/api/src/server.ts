import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { acquireDataDirLock, Core, dataDirFrom, loadConfig, MCP_ENTRY_ENV, RESTART_EXIT_CODE } from '@claudio/core';
import { buildApp } from './app.ts';

export interface StartServerOptions {
  port?: number;
  host?: string;
  /** Built UI to serve; defaults to CLAUDIO_WEB_DIST or the monorepo's apps/web/dist */
  webDist?: string;
  /**
   * Whether a taken port is answered by binding one the system picks (default true, what the
   * desktop shell wants). Off, a taken port is the error it is: `pnpm dev` and a container have a
   * fixed address in front of them, and moving would leave that address pointing at something else.
   */
  portFallback?: boolean;
}

export interface RunningServer {
  /** Base URL with the real bound port (useful when listening on port 0) */
  url: string;
  port: number;
  /** Stops the runs and closes the HTTP server */
  close(): Promise<void>;
}

/**
 * Listens on `port`, and on whatever the operating system hands out when that one is taken.
 *
 * A port asked for by number is a preference and not a promise — the desktop shell remembers the
 * one it used last so the URL stays put between launches, and something else on the machine may
 * hold it today. Refusing to start over that would trade a moving address for no address at all,
 * which is the worse of the two. Port 0 already means "whatever is free", so it has nothing to
 * fall back to, and an error that is not a taken port is a real failure either way.
 */
export async function listenOn(app: FastifyInstance, port: number, host: string, fallback = true): Promise<void> {
  try {
    await app.listen({ port, host });
  } catch (err) {
    if (!fallback || port === 0 || (err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    app.log.warn(`port ${String(port)} is taken; listening on one the operating system picks instead`);
    await app.listen({ port: 0, host });
  }
}

/** Creates the core, builds the app and listens. Shared by the CLI entrypoint and the desktop bundle. */
export async function startServer(opts: StartServerOptions = {}): Promise<RunningServer> {
  const host = opts.host ?? '127.0.0.1';
  // Before anything reads or writes the data directory: a second server on it (one an agent started
  // with this one's CLAUDIO_DATA_DIR in its environment) stops here, with DataDirLockedError
  const lock = acquireDataDirLock(dataDirFrom());
  let core: Core;
  try {
    core = new Core(loadConfig());
  } catch (err) {
    lock.release();
    throw err;
  }
  // Read into the guard by now. Every chat, command and check the server starts inherits
  // `process.env`, and the desktop app's secret is not theirs to hold, nor to write to a transcript
  delete process.env.CLAUDIO_DESKTOP_TOKEN;
  delete process.env.CLAUDIO_SECRET_KEY;
  // The owner's token too: a deployment that seeds it here (Docker, Compose, Helm) would otherwise
  // hand it to every chat, which could then do anything the owner can. `config.authEnv` has it now
  delete process.env.CLAUDIO_AUTH_TOKEN;
  let app: Awaited<ReturnType<typeof buildApp>>;
  try {
    app = await buildApp(core, { webDist: opts.webDist });
  } catch (err) {
    lock.release();
    throw err;
  }
  for (const stray of core.runtime.strays()) {
    app.log.warn(
      `chat ${stray.chatId}: CLI process ${stray.pid} from a previous wrapper is still working on it; ` +
        'it will not be resumed beside that process until it exits or the chat is stopped',
    );
  }

  core.cliVersion.startDaily();
  core.release.startDaily();

  const system = await core.system();
  // Installing or signing in in a terminal shows up on its own; the first full detection runs beside start-up
  void core.providers.refresh().then(() => core.providers.startWatching()).catch(() => undefined);
  void core.hosts.refresh().then(() => core.hosts.startWatching()).catch(() => undefined);
  if (!system.cli.installed) app.log.error(`Claude Code CLI not detected: ${system.cli.error}`);
  else if (!system.auth.loggedIn) app.log.warn('Claude Code is installed but no account is signed in: open Claudio and sign in under Settings → Claude Code, or set ANTHROPIC_API_KEY.');
  else app.log.info(`Claude Code ${system.cli.version} ready (auth: ${system.auth.tokenSource}, plan: ${system.auth.subscriptionType ?? 'n/a'})`);

  try {
    await listenOn(app, opts.port ?? 8797, host, opts.portFallback ?? true);
  } catch (err) {
    const ended = core.shutdown();
    await app.close();
    await ended;
    lock.release();
    throw err;
  }

  // Someone who opens the port is told what they just published: this API runs arbitrary commands
  if ((host === '0.0.0.0' || host === '::') && core.security.mode === 'none') {
    app.log.warn(
      `bound to ${host}: this API runs commands on the machine it is on, and nothing is asking for a credential. ` +
        'Whoever reaches the port owns the machine. Set a token (CLAUDIO_AUTH_TOKEN, or the security panel), or bind HOST=127.0.0.1.',
    );
  }

  const { port } = app.server.address() as AddressInfo;
  // A wildcard bind is reachable through loopback; advertise that instead of 0.0.0.0 / ::
  const urlHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  const url = `http://${urlHost}:${port}`;
  core.runtime.apiUrl = `${url}/api`;
  // In a bundle (the container, the desktop app) mcp.mjs sits beside this file; from source it does
  // not, and the core starts the server through tsx instead
  const bundledMcp = fileURLToPath(new URL('./mcp.mjs', import.meta.url));
  if (!process.env[MCP_ENTRY_ENV] && existsSync(bundledMcp)) process.env[MCP_ENTRY_ENV] = bundledMcp;
  // The guard program sits beside it the same way. The name is the one guards/command.ts exports as
  // GUARD_ENTRY_ENV; it is repeated here because that module is not part of this task's base
  const bundledGuard = fileURLToPath(new URL('./guard.mjs', import.meta.url));
  if (!process.env.CLAUDIO_GUARD_ENTRY && existsSync(bundledGuard)) process.env.CLAUDIO_GUARD_ENTRY = bundledGuard;
  // The port it bound to, which is not always the one it asked for; this also opens the tunnel
  // when "start with Claudio" is on
  core.tunnel.attach(port, urlHost, lock.id);
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      const ended = core.shutdown();
      await app.close();
      // The process exits next, and a probe still running would outlive it and keep writing the
      // config home it was started with
      await ended;
      lock.release();
    })();
    return closing;
  };
  // An in-app update ends this process the way SIGTERM does, with the code that has the launcher start it again
  core.serverUpdates.onRestart = async () => {
    await close();
    process.exit(RESTART_EXIT_CODE);
  };
  return { url, port, close };
}
