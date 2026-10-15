import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentryEvent, Terminal, TerminalServerFrame } from '@claudio/shared';
import { Db } from '../src/db.ts';
import type { AgentryEventInput } from '../src/events.ts';
import { loadConfig } from '../src/paths.ts';
import { inProcessHost } from '../src/terminals/host-client.ts';
import { PtyMissingError, type Pty, type PtyBackend, type PtySpawn } from '../src/terminals/host/pty.ts';
import { TerminalError } from '../src/terminals/errors.ts';
import { EVICT_BYTES, HIGH_WATERMARK, type CoalescerClock } from '../src/terminals/flow.ts';
import { ENDED_KEPT_MS, TerminalService, type TerminalClient } from '../src/terminals/service.ts';
import { TerminalSettingsStore } from '../src/terminals/settings.ts';
import { TerminalStore } from '../src/terminals/store.ts';

/** A pid no process has: the host would otherwise signal a real one */
let fakePid = 90_000_000;

class FakePty implements Pty {
  readonly pid = fakePid++;
  written: string[] = [];
  paused = 0;
  resumed = 0;
  size: [number, number];
  private data: Array<(d: Buffer) => void> = [];
  private exits: Array<(e: { code: number | null; signal: string | null }) => void> = [];
  constructor(readonly options: PtySpawn) {
    this.size = [options.cols, options.rows];
  }
  write(data: Buffer): void {
    this.written.push(data.toString());
  }
  resize(cols: number, rows: number): void {
    this.size = [cols, rows];
  }
  pause(): void {
    this.paused += 1;
  }
  resume(): void {
    this.resumed += 1;
  }
  onData(listener: (d: Buffer) => void): void {
    this.data.push(listener);
  }
  onExit(listener: (e: { code: number | null; signal: string | null }) => void): void {
    this.exits.push(listener);
  }
  print(text: string | Buffer): void {
    for (const listener of this.data) listener(Buffer.from(text));
  }
  exit(code: number | null = 0): void {
    for (const listener of this.exits) listener({ code, signal: null });
  }
}

class Backend implements PtyBackend {
  readonly ptys: FakePty[] = [];
  spawn(options: PtySpawn): Pty {
    const pty = new FakePty(options);
    this.ptys.push(pty);
    return pty;
  }
  get last(): FakePty {
    return this.ptys.at(-1) as FakePty;
  }
}

class FakeClient implements TerminalClient {
  frames: TerminalServerFrame[] = [];
  output_: Buffer[] = [];
  closed = false;
  bufferedAmount = 0;
  constructor(
    readonly actor = 'local',
    readonly client = 'local',
    readonly origin: string | null = null,
  ) {}
  frame(frame: TerminalServerFrame): void {
    this.frames.push(frame);
  }
  output(data: Buffer): void {
    this.output_.push(data);
  }
  buffered(): number {
    return this.bufferedAmount;
  }
  close(): void {
    this.closed = true;
  }
  get text(): string {
    return Buffer.concat(this.output_).toString();
  }
  of<T extends TerminalServerFrame['type']>(type: T): Array<Extract<TerminalServerFrame, { type: T }>> {
    return this.frames.filter((f): f is Extract<TerminalServerFrame, { type: T }> => f.type === type);
  }
}

const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 15));

function manualClock() {
  let now = 1_000_000;
  const timers: Array<{ at: number; run: () => void; live: boolean }> = [];
  const clock: CoalescerClock = {
    now: () => now,
    after: (ms, run) => {
      const timer = { at: now + ms, run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
  };
  return {
    clock,
    now: () => now,
    advance(ms: number) {
      now += ms;
      for (const timer of timers) {
        if (timer.live && timer.at <= now) {
          timer.live = false;
          timer.run();
        }
      }
    },
  };
}

function setup(options: { env?: NodeJS.ProcessEnv; loader?: () => PtyBackend } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'claudio-terminal-service-'));
  const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  const config = loadConfig({ CLAUDIO_DATA_DIR: join(root, 'data'), CLAUDIO_WORKSPACE_DIR: join(root, 'ws'), CLAUDE_CONFIG_DIR: join(root, 'claude') });
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(config);
  const backend = new Backend();
  const events: AgentryEventInput[] = [];
  const time = manualClock();
  const env = { HOME: '/home/person', PATH: '/usr/bin', CLAUDIO_API_TOKEN: 'secret', CLAUDIO_AUTH_TOKEN: 'owner', ...(options.env ?? {}) };
  const service = new TerminalService({
    store: new TerminalStore(db.connection),
    settings: new TerminalSettingsStore(config, {}),
    lookup: {
      project: async (id) => (id === 'p1' ? { path: project, worktrees: [] } : null),
      chat: async (id) => (id === 'c1' ? { cwd: project, worktree: null, projectId: 'p1' } : null),
    },
    emit: (event) => events.push(event),
    host: inProcessHost({ loadPty: options.loader ?? (() => backend) }),
    env,
    now: time.now,
    clock: time.clock,
    tickMs: 0,
    ptyResolvable: () => true,
  });
  return { service, backend, db, events, time, project, root, store: new TerminalStore(db.connection) };
}

/** Stops the service as the server does; the fake shells exit when the host would have ended them */
async function stop(ctx: ReturnType<typeof setup>): Promise<void> {
  const stopping = ctx.service.shutdown();
  await settle();
  for (const pty of ctx.backend.ptys) pty.exit(null);
  await stopping;
}

const who = { actor: 'local', client: 'local' };
const changes = (events: AgentryEventInput[]): Extract<AgentryEvent, { type: 'terminal.changed' }>[] =>
  events.filter((e): e is Extract<AgentryEvent, { type: 'terminal.changed' }> => e.type === ('terminal.changed' as const)) as never;

async function opened(ctx: ReturnType<typeof setup>): Promise<Terminal> {
  await ctx.service.updateSettings({ enabled: true });
  return ctx.service.create({ projectId: 'p1', cols: 100, rows: 30 }, who);
}

test('a new install has the terminal off, and opening one says so', async () => {
  const ctx = setup();
  const status = ctx.service.status();
  assert.equal(status.enabled, false);
  assert.equal(status.available, false);
  assert.equal(status.reason, 'off');
  await assert.rejects(ctx.service.create({ projectId: 'p1' }, who), (e) => e instanceof TerminalError && e.code === 'terminal.off' && e.status === 409);
  ctx.service.tick();
  await stop(ctx);
});

test('opening a terminal starts a login shell in the project with a scrubbed environment, and records the session', async () => {
  const ctx = setup();
  const terminal = await opened(ctx);
  assert.equal(terminal.state, 'running');
  assert.equal(terminal.cwd, ctx.project);
  assert.deepEqual([terminal.cols, terminal.rows], [100, 30]);
  assert.match(terminal.id, /^term_[A-Za-z0-9_-]{22}$/);
  const spawned = ctx.backend.last;
  assert.deepEqual(spawned.options.args, ['-l']);
  assert.equal(spawned.options.cwd, ctx.project);
  assert.equal(Object.keys(spawned.options.env).some((name) => name.startsWith('CLAUDIO_')), false);
  assert.equal(spawned.options.env.TERM, 'xterm-256color');
  const history = ctx.service.history();
  assert.equal(history.entries[0]?.id, terminal.id);
  assert.equal(history.entries[0]?.actor, 'local');
  assert.equal(ctx.service.status().running, 1);
  assert.equal(changes(ctx.events).at(-1)?.terminals[0]?.id, terminal.id);
  await stop(ctx);
});

test('the cap on running terminals answers 409 terminal.limit, and a closed one frees a place', async () => {
  const ctx = setup();
  await ctx.service.updateSettings({ enabled: true, maxTerminals: 1 });
  const first = await ctx.service.create({ projectId: 'p1' }, who);
  await assert.rejects(ctx.service.create({ chatId: 'c1' }, who), (e) => e instanceof TerminalError && e.code === 'terminal.limit' && e.status === 409);
  ctx.service.close(first.id);
  await ctx.service.create({ chatId: 'c1' }, who);
  assert.equal(ctx.service.running(), 1);
  await stop(ctx);
});

test('two requests at once cannot both fit under the cap', async () => {
  const ctx = setup();
  await ctx.service.updateSettings({ enabled: true, maxTerminals: 1 });
  const results = await Promise.allSettled([ctx.service.create({ projectId: 'p1' }, who), ctx.service.create({ projectId: 'p1' }, who)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  await stop(ctx);
});

test('a client attaches and gets hello with the screen so far, then everything after', async () => {
  const ctx = setup();
  const terminal = await opened(ctx);
  ctx.backend.last.print('\x1b[32mgreen\x1b[0m before\r\n');
  await settle();
  const client = new FakeClient();
  await ctx.service.attach(terminal.id, client);
  const hello = client.of('hello')[0];
  assert.ok(hello);
  assert.equal(hello.terminal.id, terminal.id);
  assert.deepEqual([hello.cols, hello.rows], [100, 30]);
  assert.match(hello.snapshot, /green/);
  assert.match(hello.snapshot, /before/);
  ctx.backend.last.print('after\r\n');
  await settle();
  ctx.time.advance(10);
  assert.equal(client.text, 'after\r\n');
  await stop(ctx);
});

test('output that arrives while a client attaches is in its snapshot once, never twice', async () => {
  const ctx = setup();
  const terminal = await opened(ctx);
  const existing = new FakeClient();
  await ctx.service.attach(terminal.id, existing);
  ctx.backend.last.print('one\r\n');
  await settle();
  const late = new FakeClient();
  const attaching = ctx.service.attach(terminal.id, late);
  ctx.backend.last.print('two\r\n');
  await attaching;
  ctx.backend.last.print('three\r\n');
  await settle();
  ctx.time.advance(10);
  const seen = late.of('hello')[0]?.snapshot + late.text;
  assert.equal(seen.match(/one/g)?.length, 1);
  assert.equal(seen.match(/two/g)?.length, 1);
  assert.equal(seen.match(/three/g)?.length, 1);
  assert.match(existing.text, /one[\s\S]*two[\s\S]*three/);
  await stop(ctx);
});

test('a half-written sequence at the snapshot instant is sent as the tail, then completed by the live bytes', async () => {
  const ctx = setup();
  const terminal = await opened(ctx);
  ctx.backend.last.print('ok\x1b[3');
  await settle();
  const client = new FakeClient();
  await ctx.service.attach(terminal.id, client);
  assert.equal(client.text, '\x1b[3');
  ctx.backend.last.print('1mred');
  await settle();
  ctx.time.advance(10);
  assert.equal(client.text, '\x1b[31mred');
  await stop(ctx);
});

test('input reaches the shell, and the fifth client on one terminal is refused', async () => {
  const ctx = setup();
  const terminal = await opened(ctx);
  const clients = [new FakeClient(), new FakeClient(), new FakeClient(), new FakeClient()];
  const connections: Array<Awaited<ReturnType<typeof ctx.service.attach>>> = [];
  for (const client of clients) connections.push(await ctx.service.attach(terminal.id, client));
  assert.equal(ctx.service.get(terminal.id)?.clients, 4);
  await assert.rejects(ctx.service.attach(terminal.id, new FakeClient()), (e) => e instanceof TerminalError && e.code === 'terminal.clients');
  connections[0]?.input(Buffer.from('echo hi\r'));
  await settle();
  assert.deepEqual(ctx.backend.last.written, ['echo hi\r']);
  assert.throws(() => connections[0]?.input(Buffer.alloc(64 * 1024 + 1)), (e) => e instanceof TerminalError && e.code === 'terminal.input-too-large');
  connections[3]?.detach();
  assert.equal(ctx.service.get(terminal.id)?.clients, 3);
  await stop(ctx);
});

test('the size belongs to the client that last sent input, focused or resized; the others are told', async () => {
  const ctx = setup();
  const terminal = await opened(ctx);
  const desk = new FakeClient();
  const phone = new FakeClient();
  const deskConn = await ctx.service.attach(terminal.id, desk);
  const phoneConn = await ctx.service.attach(terminal.id, phone);
  phoneConn.resize(40, 20);
  await settle();
  assert.deepEqual(ctx.backend.last.size, [40, 20]);
  assert.deepEqual(desk.of('size'), [{ type: 'size', cols: 40, rows: 20 }]);
  assert.deepEqual(phone.of('size'), []);
  deskConn.resize(120, 40);
  await settle();
  assert.deepEqual(ctx.backend.last.size, [120, 40]);
  assert.deepEqual(phone.of('size'), [{ type: 'size', cols: 120, rows: 40 }]);
  // The phone types: its last size is the terminal's again
  phoneConn.input(Buffer.from('l'));
  await settle();
  assert.deepEqual(ctx.backend.last.size, [40, 20]);
  // Out-of-range sizes are clamped
  deskConn.resize(100_000, 0);
  await settle();
  assert.deepEqual(ctx.backend.last.size, [500, 1]);
  await stop(ctx);
});

test('a client that does not acknowledge pauses the shell; acknowledging resumes it', async () => {
  const ctx = setup();
  const terminal = await opened(ctx);
  const client = new FakeClient();
  const conn = await ctx.service.attach(terminal.id, client);
  const pty = ctx.backend.last;
  const chunk = Buffer.alloc(60 * 1024, 120);
  for (let sent = 0; sent <= HIGH_WATERMARK; sent += chunk.length) pty.print(chunk);
  await settle();
  ctx.time.advance(10);
  await settle();
  assert.ok(pty.paused >= 1, 'paused');
  const received = client.output_.reduce((n, b) => n + b.length, 0);
  conn.ack(received);
  await settle();
  assert.ok(pty.resumed >= 1, 'resumed');
  await stop(ctx);
});

test('a client more than 8 MiB behind is told evicted-slow and closed, and the others carry on', async () => {
  const ctx = setup();
  const terminal = await opened(ctx);
  const slow = new FakeClient();
  const fast = new FakeClient();
  await ctx.service.attach(terminal.id, slow);
  const fastConn = await ctx.service.attach(terminal.id, fast);
  slow.bufferedAmount = EVICT_BYTES + 1;
  ctx.backend.last.print(Buffer.alloc(8 * 1024, 120));
  await settle();
  ctx.time.advance(10);
  assert.deepEqual(slow.of('closed'), [{ type: 'closed', reason: 'evicted-slow' }]);
  assert.equal(slow.closed, true);
  assert.equal(ctx.service.get(terminal.id)?.clients, 1);
  fastConn.ack(8 * 1024);
  assert.equal(ctx.service.get(terminal.id)?.state, 'running');
  await stop(ctx);
});

test('the shell exiting leaves clients attached to see how it ended, and keeps the terminal listed', async () => {
  const ctx = setup();
  const terminal = await opened(ctx);
  const client = new FakeClient();
  await ctx.service.attach(terminal.id, client);
  ctx.backend.last.exit(7);
  await settle();
  assert.deepEqual(client.of('exit'), [{ type: 'exit', code: 7, signal: null }]);
  assert.equal(client.closed, false);
  const ended = ctx.service.get(terminal.id);
  assert.equal(ended?.state, 'exited');
  assert.equal(ended?.exitCode, 7);
  assert.equal(ended?.endReason, 'exit');
  assert.equal(ctx.service.running(), 0);
  // A late client still sees the screen and how it ended
  const late = new FakeClient();
  await ctx.service.attach(terminal.id, late);
  assert.equal(late.of('hello').length, 1);
  assert.deepEqual(late.of('exit'), [{ type: 'exit', code: 7, signal: null }]);
  // An hour later it is forgotten
  ctx.time.advance(ENDED_KEPT_MS + 1);
  ctx.service.tick();
  assert.equal(ctx.service.get(terminal.id), null);
  assert.equal(ctx.service.history().entries[0]?.endReason, 'exit');
  await stop(ctx);
});

test('closing a terminal tells its clients, asks the host to end the shell, and records why', async () => {
  const ctx = setup();
  const terminal = await opened(ctx);
  const client = new FakeClient();
  await ctx.service.attach(terminal.id, client);
  const closed = ctx.service.close(terminal.id);
  assert.equal(closed?.state, 'closed');
  assert.deepEqual(client.of('closed'), [{ type: 'closed', reason: 'closed' }]);
  assert.equal(client.closed, true);
  await assert.rejects(ctx.service.attach(terminal.id, new FakeClient()), (e) => e instanceof TerminalError && e.code === 'terminal.not-found');
  const row = ctx.service.history().entries[0];
  assert.equal(row?.endReason, 'closed');
  assert.equal(row?.attachments[0]?.detachedAt === null, false);
  assert.equal(ctx.service.close('term_nope'), null);
  await stop(ctx);
});

test('a terminal the person closed leaves the list at once, and the history still records it', async () => {
  const ctx = setup();
  const kept = await opened(ctx);
  const closing = await ctx.service.create({ projectId: 'p1' }, who);
  ctx.service.close(closing.id);
  assert.deepEqual(ctx.service.list().map((t) => t.id), [kept.id]);
  assert.equal(ctx.service.get(closing.id), null);
  assert.equal(ctx.service.close(closing.id), null, 'closing it again finds nothing');
  assert.equal(ctx.service.history().entries.find((e) => e.id === closing.id)?.endReason, 'closed');
  await stop(ctx);
});

test('X on a terminal that ended by itself forgets it, while an ended one nobody dismissed stays listed', async () => {
  const ctx = setup();
  const terminal = await opened(ctx);
  ctx.backend.last.exit(0);
  await settle();
  assert.equal(ctx.service.list()[0]?.state, 'exited');
  assert.equal(ctx.service.close(terminal.id)?.state, 'exited');
  assert.deepEqual(ctx.service.list(), []);
  await assert.rejects(ctx.service.attach(terminal.id, new FakeClient()), (e) => e instanceof TerminalError && e.code === 'terminal.not-found');
  await stop(ctx);
});

test('turning the terminal off closes every terminal with the reason disabled', async () => {
  const ctx = setup();
  const terminal = await opened(ctx);
  const client = new FakeClient();
  await ctx.service.attach(terminal.id, client);
  const turning = ctx.service.updateSettings({ enabled: false });
  // The settings write is asynchronous: the shell may only exit once the service has started closing it,
  // and a fixed delay is too short on a loaded machine
  for (let waited = 0; client.of('closed').length === 0 && waited < 200; waited++) await settle();
  ctx.backend.last.exit(null);
  const status = await turning;
  assert.equal(status.enabled, false);
  assert.deepEqual(client.of('closed'), [{ type: 'closed', reason: 'disabled' }]);
  assert.equal(ctx.service.get(terminal.id)?.endReason, 'disabled');
  await stop(ctx);
});

test('a terminal nobody has attached for idleMinutes ends, and one with a client does not', async () => {
  const ctx = setup();
  await ctx.service.updateSettings({ enabled: true, idleMinutes: 5 });
  const lonely = await ctx.service.create({ projectId: 'p1' }, who);
  const watched = await ctx.service.create({ projectId: 'p1' }, who);
  await ctx.service.attach(watched.id, new FakeClient());
  ctx.time.advance(4 * 60_000);
  ctx.service.tick();
  assert.equal(ctx.service.get(lonely.id)?.state, 'running');
  ctx.time.advance(61_000);
  ctx.service.tick();
  assert.equal(ctx.service.get(lonely.id)?.endReason, 'idle');
  assert.equal(ctx.service.get(watched.id)?.state, 'running');
  await stop(ctx);
});

test('the idle clock restarts when the last client leaves', async () => {
  const ctx = setup();
  await ctx.service.updateSettings({ enabled: true, idleMinutes: 5 });
  const terminal = await ctx.service.create({ projectId: 'p1' }, who);
  const conn = await ctx.service.attach(terminal.id, new FakeClient());
  ctx.time.advance(10 * 60_000);
  ctx.service.tick();
  assert.equal(ctx.service.get(terminal.id)?.state, 'running');
  conn.detach();
  ctx.time.advance(4 * 60_000);
  ctx.service.tick();
  assert.equal(ctx.service.get(terminal.id)?.state, 'running');
  ctx.time.advance(2 * 60_000);
  ctx.service.tick();
  assert.equal(ctx.service.get(terminal.id)?.endReason, 'idle');
  await stop(ctx);
});

test('shutdown ends every shell and writes the rows before it returns', async () => {
  const ctx = setup();
  const terminal = await opened(ctx);
  const client = new FakeClient();
  await ctx.service.attach(terminal.id, client);
  const stopping = ctx.service.shutdown();
  // The rows are written synchronously: the database may close right after
  const row = ctx.store.history(10, 0).entries[0];
  assert.equal(row?.endReason, 'server-stopping');
  assert.ok(row?.attachments[0]?.detachedAt);
  ctx.backend.last.exit(null);
  await stopping;
  assert.deepEqual(client.of('closed'), [{ type: 'closed', reason: 'server-stopping' }]);
});

test('a binary that does not load makes the feature unavailable with pty-missing', async () => {
  const ctx = setup({
    loader: () => {
      throw new PtyMissingError('node-pty did not load', 'glibc 2.28 not found');
    },
  });
  await ctx.service.updateSettings({ enabled: true });
  await assert.rejects(ctx.service.create({ projectId: 'p1' }, who), (e) => e instanceof TerminalError && e.code === 'terminal.unavailable');
  assert.equal(ctx.service.status().reason, 'pty-missing');
  assert.equal(ctx.service.status().available, false);
  assert.equal(ctx.service.list().length, 0);
  await stop(ctx);
});

test('a node-pty that cannot be found at all reads unavailable before anything tries it', async () => {
  const ctx = setup();
  const missing = new TerminalService({
    store: ctx.store,
    settings: new TerminalSettingsStore({ dataDir: join(ctx.root, 'data') }, {}),
    lookup: { project: async () => null, chat: async () => null },
    emit: () => undefined,
    tickMs: 0,
    ptyResolvable: () => false,
  });
  await missing.updateSettings({ enabled: true });
  assert.equal(missing.status().reason, 'pty-missing');
  await missing.shutdown();
  await stop(ctx);
});

test('a host that fails ends its terminals as host-failed, and three failures in five minutes turn the feature off until it is turned on again', async () => {
  const ctx = setup();
  await ctx.service.updateSettings({ enabled: true });
  const factory = inProcessHost({ loadPty: () => ctx.backend });
  let failed: ((reason: string) => void) | null = null;
  const service = new TerminalService({
    store: ctx.store,
    settings: new TerminalSettingsStore({ dataDir: join(ctx.root, 'data') }, {}),
    lookup: { project: async () => ({ path: ctx.project, worktrees: [] }), chat: async () => null },
    emit: () => undefined,
    host: (listener) => {
      failed = listener.failed;
      return factory(listener);
    },
    now: ctx.time.now,
    clock: ctx.time.clock,
    tickMs: 0,
    ptyResolvable: () => true,
  });
  const states: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const terminal = await service.create({ projectId: 'p1' }, who);
    (failed as unknown as (reason: string) => void)('boom');
    states.push(`${service.get(terminal.id)?.state}/${service.get(terminal.id)?.endReason}`);
    ctx.time.advance(1000);
  }
  assert.deepEqual(states, ['closed/host-failed', 'closed/host-failed', 'closed/host-failed']);
  assert.equal(service.status().reason, 'host-failed');
  await assert.rejects(service.create({ projectId: 'p1' }, who), (e) => e instanceof TerminalError && e.code === 'terminal.unavailable');
  await service.updateSettings({ enabled: false });
  await service.updateSettings({ enabled: true });
  assert.equal(service.status().reason, null);
  await service.shutdown();
  await stop(ctx);
});

test('a refused attempt is a row with its reason and no content, for the owner to see', async () => {
  const ctx = setup();
  const terminal = await opened(ctx);
  ctx.service.recordRefusal({ terminalId: terminal.id, actor: 'chat:abc', client: '127.0.0.1', origin: 'http://evil.example', reason: 'chat-token' });
  ctx.service.recordRefusal({ actor: 'local', client: '127.0.0.1', reason: 'from-agent' });
  const { entries, total } = ctx.service.history();
  assert.equal(total, 2);
  const withSession = entries.find((e) => e.id === terminal.id);
  assert.deepEqual(withSession?.attachments.map((a) => a.refused), ['chat-token']);
  assert.equal(withSession?.attachments[0]?.origin, 'http://evil.example');
  const orphan = entries.find((e) => e.id === '');
  assert.deepEqual(orphan?.attachments.map((a) => a.refused), ['from-agent']);
  assert.deepEqual(ctx.service.history(1, 0).entries.length, 1);
  await stop(ctx);
});

test('settings are validated whole, kept in terminal.json, and the environment can pin the switch', async () => {
  const ctx = setup();
  await assert.rejects(ctx.service.updateSettings({ maxTerminals: 99 }), (e) => e instanceof TerminalError && e.code === 'terminal.bad-settings');
  await assert.rejects(ctx.service.updateSettings({ idleMinutes: 1 }), (e) => e instanceof TerminalError && e.code === 'terminal.bad-settings');
  await assert.rejects(ctx.service.updateSettings({ remote: 'lan' as never }), (e) => e instanceof TerminalError && e.code === 'terminal.bad-settings');
  await assert.rejects(ctx.service.updateSettings({ shell: '/nonexistent/shell' }), (e) => e instanceof TerminalError && e.code === 'terminal.bad-settings');
  await assert.rejects(ctx.service.updateSettings({ replayLines: 5000 }), (e) => e instanceof TerminalError && e.code === 'terminal.bad-settings');
  assert.equal(ctx.service.settings().maxTerminals, 8, 'a patch with a bad value changes nothing');
  const status = await ctx.service.updateSettings({ remote: 'any', scrollbackLines: 3000, replayLines: 2000 });
  assert.equal(status.settings.remote, 'any');
  assert.equal(status.sources.remote, 'file');
  assert.equal(status.sources.maxTerminals, 'default');

  const pinned = new TerminalSettingsStore({ dataDir: join(ctx.root, 'data') }, { CLAUDIO_TERMINAL: 'off' });
  assert.equal(pinned.vetoed, true);
  assert.equal(pinned.get().enabled, false);
  assert.equal(pinned.sources().enabled, 'env');
  await assert.rejects(pinned.update({ enabled: true }), (e) => e instanceof TerminalError && e.code === 'terminal.env-locked');
  const on = new TerminalSettingsStore({ dataDir: join(ctx.root, 'data') }, { CLAUDIO_TERMINAL: 'on' });
  assert.equal(on.get().enabled, true);
  await stop(ctx);
});
