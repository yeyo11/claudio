import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { ADOPTED_PORT_TAKEN_EXIT_CODE } from '@claudio/core/launcher/protocol';
import { CRASH_DELAY_MAX_MS, CRASH_LIMIT, CRASH_WINDOW_MS, Daemon, crashDelay, idleSince, portTakenDetail, type DaemonHost, type DaemonServer } from '../src/daemon.ts';
import { DaemonClient } from '../src/daemon-launch.ts';
import { DAEMON_PROTOCOL, readDaemonRecord, type DaemonState, type FromDaemon, type LaunchFacts } from '../src/daemon-protocol.ts';
import { EMPTY_SNAPSHOT, type LiveSnapshot } from '../src/live.ts';
import type { PayloadBoot, PayloadEnd, PayloadHostOptions } from '../src/payload.ts';

// The desktop's daemon (layer 1 of docs/plans/survive-restarts.md), driven over its real socket with
// a fake payload host and fake servers: no Electron, no server, no CLI.

const roots: string[] = [];
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await tick();
  }
}

const BOOT: PayloadBoot = { dir: '/bundled', version: '0.19.0', trial: false, entry: '/bundled/server.mjs', webDist: '/bundled/web', bundled: true };

/** A server the test ends: `crash(code)` as if it died, or it ends when asked to stop */
class FakeServer implements DaemonServer {
  calls: string[] = [];
  private resolveReady!: (url: string) => void;
  private rejectReady!: (err: Error) => void;
  private resolveExit!: (code: number) => void;
  readonly ready = new Promise<string>((resolve, reject) => {
    this.resolveReady = resolve;
    this.rejectReady = reject;
  });
  readonly exited = new Promise<number>((resolve) => (this.resolveExit = resolve));
  constructor(private readonly ackStopWork = true) {
    this.ready.catch(() => undefined);
  }
  listen(port: number): void {
    this.resolveReady(`http://127.0.0.1:${String(port)}/`);
  }
  crash(code: number): void {
    this.rejectReady(new Error('gone'));
    this.resolveExit(code);
  }
  stop(): void {
    this.calls.push('stop');
    this.resolveExit(0);
  }
  kill(): void {
    this.calls.push('kill');
    this.resolveExit(137);
  }
  detail(): string {
    return 'server.log tail';
  }
  stopWork(): Promise<boolean> {
    this.calls.push('stop-work');
    if (this.ackStopWork) this.resolveExit(0);
    return Promise.resolve(this.ackStopWork);
  }
}

/** The payload machine reduced to what the daemon relies on: one boot per run, its end reported */
function fakeHost(options: PayloadHostOptions): DaemonHost {
  let stopping = false;
  let handle: ReturnType<PayloadHostOptions['spawn']> | null = null;
  let ready = false;
  return {
    run: async (): Promise<PayloadEnd> => {
      handle = options.spawn(BOOT);
      handle.ready.then(
        (url) => {
          ready = true;
          options.onReady(url, BOOT);
        },
        () => undefined,
      );
      const code = await handle.exited;
      if (stopping) return { why: 'stopped', code };
      return { why: 'exited', code, ready, detail: handle.detail() };
    },
    stop: async () => {
      stopping = true;
      handle?.stop();
      await handle?.exited;
    },
    windowLoading: () => undefined,
    pageReady: () => undefined,
  };
}

const launchFacts = (dataDir: string): LaunchFacts => ({
  env: { HOME: '/home/someone' },
  PATH: '/usr/bin',
  secretKey: 'a-key-only-electron-has',
  userData: dataDir,
  dataDir,
  workspaceDir: join(dataDir, 'ws'),
  logsDir: join(dataDir, 'logs'),
  bundledDir: '/bundled',
  bundledWeb: '/bundled/web',
  guardEntry: '/bundled/guard.mjs',
  keysDir: '/keys',
  shellJson: join(dataDir, 'no-shell.json'),
  version: '0.19.0',
  distribution: 'deb',
  aptManaged: false,
  ignoreOverlays: false,
});

interface Harness {
  dir: string;
  daemon: Daemon;
  servers: FakeServer[];
  envs: NodeJS.ProcessEnv[];
  logs: string[];
  exit: Promise<number>;
  idle: { push(snapshot: LiveSnapshot): void; started: number };
  clock: { now: number };
}

function harness(o: { ackStopWork?: boolean; idleStopMs?: number; waitingMaxMs?: number; dir?: string } = {}): Harness {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'claudio-daemon-'));
  if (!o.dir) roots.push(dir);
  const servers: FakeServer[] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const logs: string[] = [];
  const clock = { now: 1_000_000 };
  let onSnapshot: ((s: LiveSnapshot) => void) | null = null;
  const idle = {
    started: 0,
    push: (snapshot: LiveSnapshot) => onSnapshot?.(snapshot),
  };
  const daemon = new Daemon({
    dataDir: dir,
    version: '0.19.0',
    followsShell: true,
    unit: 'claudio-daemon-test.service',
    pid: process.pid,
    started: 42,
    now: () => clock.now,
    tickMs: 10,
    idleStopMs: o.idleStopMs ?? 60_000,
    waitingMaxMs: o.waitingMaxMs ?? 600_000,
    spawnServer: (_boot, env) => {
      const server = new FakeServer(o.ackStopWork ?? true);
      servers.push(server);
      envs.push(env);
      return server;
    },
    serverEnv: (launch, _boot, token) => ({ CLAUDIO_DESKTOP_TOKEN: token, CLAUDIO_SECRET_KEY: launch.secretKey ?? '' }),
    health: () => Promise.resolve(true),
    watchIdle: (_origin, _token, listener) => ({
      start: () => {
        idle.started += 1;
        onSnapshot = listener;
      },
      stop: () => {
        onSnapshot = null;
      },
    }),
    newHost: fakeHost,
    log: (line) => logs.push(line),
  });
  return { dir, daemon, servers, envs, logs, exit: daemon.run(), idle, clock };
}

async function attach(h: Harness): Promise<{ client: DaemonClient; states: DaemonState[]; messages: FromDaemon[] }> {
  await until(() => readDaemonRecord(h.dir) !== null);
  const record = readDaemonRecord(h.dir);
  assert.ok(record);
  const states: DaemonState[] = [];
  const messages: FromDaemon[] = [];
  const client = await DaemonClient.connect(record.socket, (message) => {
    messages.push(message);
    if (message.type === 'state') states.push(message.state);
  });
  client.send({ type: 'hello', protocol: DAEMON_PROTOCOL, version: '0.19.0', launch: launchFacts(h.dir) });
  return { client, states, messages };
}

const last = <T>(list: readonly T[]): T | undefined => list[list.length - 1];

test('the daemon leaves daemon.json, owner-only, with its pid, start time, protocol, version and a fresh credential', async () => {
  const h = harness();
  await until(() => readDaemonRecord(h.dir) !== null);
  const record = readDaemonRecord(h.dir);
  assert.ok(record);
  assert.equal(statSync(join(h.dir, 'daemon.json')).mode & 0o777, 0o600);
  assert.equal(statSync(record.socket).mode & 0o777, 0o600);
  assert.equal(record.pid, process.pid);
  assert.equal(record.started, 42);
  assert.equal(record.protocol, DAEMON_PROTOCOL);
  assert.equal(record.version, '0.19.0');
  assert.equal(record.unit, 'claudio-daemon-test.service');
  assert.equal(record.url, null, 'no server listens before a window hands its facts');
  assert.ok(record.token.length >= 40);
  assert.notEqual(harness().daemon.state().token, record.token, 'every daemon has its own credential');
  await h.daemon.stop('detach');
  assert.equal(await h.exit, 0);
  assert.equal(readDaemonRecord(h.dir), null, 'the record goes with the daemon that wrote it');
});

test('no server starts before a window hands over its facts, and the key reaches only the server env', async () => {
  const h = harness();
  await until(() => readDaemonRecord(h.dir) !== null);
  await tick();
  assert.equal(h.servers.length, 0);
  const { client, states } = await attach(h);
  await until(() => h.servers.length === 1);
  h.servers[0]?.listen(48123);
  await until(() => last(states)?.phase === 'ready');
  assert.equal(last(states)?.url, 'http://127.0.0.1:48123/');
  assert.equal(readDaemonRecord(h.dir)?.url, 'http://127.0.0.1:48123/');
  assert.equal(h.envs[0]?.CLAUDIO_SECRET_KEY, 'a-key-only-electron-has');
  assert.equal(h.envs[0]?.CLAUDIO_DESKTOP_TOKEN, last(states)?.token);
  client.close();
  await h.daemon.stop('detach');
  await h.exit;
});

test('a second daemon on the same data directory leaves the first one be', async () => {
  const h = harness();
  await until(() => readDaemonRecord(h.dir) !== null);
  const second = harness({ dir: h.dir });
  assert.equal(await second.exit, 0);
  assert.equal(readDaemonRecord(h.dir)?.started, 42, "the first daemon's record stays");
  assert.ok(second.logs.some((l) => l.includes('another daemon already answers')));
  await h.daemon.stop('detach');
  await h.exit;
});

test('a socket a dead daemon left behind is taken over', async () => {
  const first = harness();
  await until(() => readDaemonRecord(first.dir) !== null);
  // Its record removed and its listener closed, but the socket file stays, as after a SIGKILL
  const record = readDaemonRecord(first.dir);
  assert.ok(record);
  await first.daemon.stop('detach');
  await first.exit;
  const { closeSync, openSync } = await import('node:fs');
  closeSync(openSync(record.socket, 'w'));
  const h = harness({ dir: first.dir });
  await until(() => readDaemonRecord(h.dir) !== null);
  assert.equal(statSync(record.socket).isSocket(), true);
  await h.daemon.stop('detach');
  await h.exit;
});

test('a server that crashes after it listened is started again after a pause that doubles', async () => {
  assert.equal(crashDelay([], 0), 1_000);
  assert.equal(crashDelay([0], 10), 2_000);
  assert.equal(crashDelay([0, 1, 2, 3], 10), 16_000);
  assert.equal(crashDelay([0, 1, 2, 3, 4, 5, 6, 7].map((i) => -CRASH_WINDOW_MS * 2 + i), 10), 1_000);
  assert.ok(CRASH_DELAY_MAX_MS <= 30_000);
  // Crashes older than the window no longer count
  assert.equal(crashDelay([0, 1, 2, 3, 4], CRASH_WINDOW_MS + 10), 1_000);

  const h = harness();
  const { client, states } = await attach(h);
  await until(() => h.servers.length === 1);
  h.servers[0]?.listen(48124);
  await until(() => last(states)?.phase === 'ready');
  h.servers[0]?.crash(1);
  await until(() => last(states)?.phase === 'restarting');
  assert.ok(h.logs.some((l) => l.includes('starting it again in 1 s')));
  await until(() => h.servers.length === 2, 3_000);
  h.servers[1]?.listen(48124);
  await until(() => last(states)?.phase === 'ready');
  client.close();
  await h.daemon.stop('detach');
  await h.exit;
});

test(`a server that keeps crashing is given up on after ${String(CRASH_LIMIT)} crashes, until a window asks again`, () => {
  const now = 5 * 60_000;
  const crashes = Array.from({ length: CRASH_LIMIT }, (_, i) => now - (i + 1) * 1_000);
  assert.equal(crashDelay(crashes, now), null);
  assert.equal(crashDelay(crashes.slice(1), now), 16_000, 'one fewer is still worth a try');
});

test('a server that never listened is not restarted in a loop: the window is told why', async () => {
  const h = harness();
  const { client, states } = await attach(h);
  await until(() => h.servers.length === 1);
  h.servers[0]?.crash(1);
  await until(() => last(states)?.phase === 'failed');
  assert.equal(last(states)?.detail, 'server.log tail');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(h.servers.length, 1, 'no second start on its own');
  client.send({ type: 'restart-server' });
  await until(() => h.servers.length === 2);
  client.close();
  await h.daemon.stop('detach');
  await h.exit;
});

test('the port parked chats hold being taken is a failure that says so, never a retry loop', async () => {
  assert.match(portTakenDetail('boot\nport 48125 is taken, and CLI processes that outlived the last server can reach the API only there\n'), /^port 48125 is taken/);
  assert.match(portTakenDetail(null), /taken by another program/);
  const h = harness();
  const { client, states } = await attach(h);
  await until(() => h.servers.length === 1);
  h.servers[0]?.crash(ADOPTED_PORT_TAKEN_EXIT_CODE);
  await until(() => last(states)?.phase === 'failed');
  assert.ok(h.logs.some((l) => l.includes('port the running chats hold is taken')));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(h.servers.length, 1);
  client.close();
  await h.daemon.stop('detach');
  await h.exit;
});

test('stopping all work asks the server to stop its chats; detaching closes it as on a restart', async () => {
  for (const work of ['stop-work', 'detach'] as const) {
    const h = harness();
    const { client, states, messages } = await attach(h);
    await until(() => h.servers.length === 1);
    h.servers[0]?.listen(48126);
    await until(() => last(states)?.phase === 'ready');
    client.send({ type: 'stop', work });
    assert.equal(await h.exit, 0);
    assert.deepEqual(h.servers[0]?.calls, work === 'stop-work' ? ['stop-work'] : ['stop']);
    assert.ok(messages.some((m) => m.type === 'stopped'));
    assert.equal(readDaemonRecord(h.dir), null);
  }
});

test('a server that does not take the request to stop its work is stopped as on a restart', async () => {
  const h = harness({ ackStopWork: false });
  const { states, client } = await attach(h);
  await until(() => h.servers.length === 1);
  h.servers[0]?.listen(48127);
  await until(() => last(states)?.phase === 'ready');
  client.send({ type: 'stop', work: 'stop-work' });
  await h.exit;
  assert.deepEqual(h.servers[0]?.calls, ['stop-work', 'stop']);
});

test('with no window attached, the daemon runs on while work is live and stops once nothing has been for a while', async () => {
  assert.equal(idleSince({ ...EMPTY_SNAPSHOT, working: 1 }, 10, 20), null);
  assert.equal(idleSince(EMPTY_SNAPSHOT, null, 20), 20);
  assert.equal(idleSince(EMPTY_SNAPSHOT, 10, 20), 10);
  assert.equal(idleSince(null, 10, 20), 10);

  const h = harness({ idleStopMs: 120_000 });
  const { client, states } = await attach(h);
  await until(() => h.servers.length === 1);
  h.servers[0]?.listen(48128);
  await until(() => last(states)?.phase === 'ready');
  assert.equal(h.idle.started, 0, 'a window is attached: nothing to watch');
  client.close();
  await until(() => h.idle.started === 1);
  h.idle.push({ ...EMPTY_SNAPSHOT, working: 1 });
  h.clock.now += 10 * 60_000;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(h.servers[0]?.calls, [], 'a chat is working: the daemon stays');
  h.idle.push(EMPTY_SNAPSHOT);
  h.clock.now += 60_000;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(h.servers[0]?.calls, [], 'idle for less than the limit');
  h.clock.now += 61_000;
  h.idle.push(EMPTY_SNAPSHOT);
  assert.equal(await h.exit, 0);
  assert.deepEqual(h.servers[0]?.calls, ['stop-work'], 'nothing is live, so nothing is left running');
});

test('a daemon no window ever came to (a unit restarted on its own) ends by itself', async () => {
  const h = harness({ waitingMaxMs: 1_000 });
  await until(() => readDaemonRecord(h.dir) !== null);
  h.clock.now += 2_000;
  assert.equal(await h.exit, 0);
  assert.equal(h.servers.length, 0);
});
