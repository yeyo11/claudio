import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ChatManager } from '../src/chats.ts';
import { writeChatExtrasConfigSync } from '../src/chat-tools.ts';
import { Db, migrate } from '../src/db.ts';
import { collectOverlays, pinnedPayloads, type Machine, type MachineFiles } from '../src/launcher/machine.ts';
import { EMPTY_STATE } from '../src/launcher/protocol.ts';
import type { ParkedProcess } from '../src/parked/process.ts';
import { ParkedProcesses } from '../src/parked/registry.ts';
import { CliProcessStore } from '../src/parked/store.ts';
import { PARKED_FILES } from '../src/parked/wrapper.ts';
import { processEntry } from '../src/processes.ts';
import { SessionStore } from '../src/sessions.ts';
import { CHAT_TOKEN_MAX_AGE_MS, CHAT_TOKEN_PREFIX, ChatTokenStore, chatTokenHash } from '../src/security/chat-tokens.ts';
import { tempConfig } from './helpers.ts';

// What a parked CLI holds from its server (t5 of docs/plans/survive-restarts.md): a chat token as a
// hash in its row, the address it was given, the payload it runs from and the files its start wrote.
// Fixtures only: the tokens here are made up, and no turn is run.

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));
const ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
const TOKEN = `${CHAT_TOKEN_PREFIX}fixture-token-not-a-real-credential-0001`;
const CHAT = '11111111-2222-4333-8444-555555555555';

const running: ParkedProcess[] = [];
after(() => {
  for (const p of running) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
});

async function until<T>(read: () => T, done: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function rig(now?: () => number) {
  const dataDir = mkdtempSync(join(tmpdir(), 'claudio-holds-'));
  const sql = new DatabaseSync(join(dataDir, 'wrapper.db'));
  migrate(sql);
  const store = new CliProcessStore(sql);
  /** A server: the registry over the shared database, as a restart builds it again */
  const server = () => new ParkedProcesses({ dataDir, store, handoverSeconds: 300, scopes: false, userManager: () => false, stopGraceSeconds: 2, ...(now ? { now } : {}) });
  return { dataDir, sql, store, server };
}

async function launch(registry: ParkedProcesses, dataDir: string, env: NodeJS.ProcessEnv = {}) {
  const parked = registry.start({
    chatId: CHAT,
    bin: FAKE,
    args: ARGS,
    cwd: dataDir,
    env: { ...process.env, CLAUDIO_API_URL: 'http://127.0.0.1:45871/api', CLAUDIO_API_TOKEN: TOKEN, ...env },
  });
  running.push(parked);
  parked.listen(() => {}, () => {});
  // Reading the pid is what writes it to the row
  await until(() => parked.cli(), (cli) => cli !== null, 'the CLI to be recorded');
  return parked;
}

test('a chat token stays valid after a restart while its parked process lives, and only the hash is stored', async () => {
  const r = rig();
  const parked = await launch(r.server(), r.dataDir);
  const row = r.store.get(parked.id);
  assert.equal(row?.tokenHash, chatTokenHash(TOKEN));
  // Nothing the database or the process's directory holds is the token
  const dump = JSON.stringify(r.sql.prepare('SELECT * FROM cli_processes').all());
  assert.ok(!dump.includes(TOKEN) && !dump.includes(TOKEN.slice(CHAT_TOKEN_PREFIX.length)));
  for (const name of readdirSync(parked.dir)) if (name !== PARKED_FILES.fifo) assert.ok(!readFileSync(join(parked.dir, name), 'utf8').includes(TOKEN), name);
  // The restarted server: an empty token store that reads the rows
  const restarted = new ChatTokenStore();
  restarted.stored = r.server();
  assert.equal(restarted.verify(TOKEN), CHAT);
  assert.equal(restarted.holds(TOKEN), true);
  assert.equal(restarted.verify(`${TOKEN}x`), null);
  assert.equal(new ChatTokenStore().verify(TOKEN), null, 'a store with no rows behind it still knows no token');
  parked.kill('SIGKILL');
  await once(parked, 'close');
});

test('a stored chat token is refused once its process has ended: the row and the hash go with it', async () => {
  const r = rig();
  const registry = r.server();
  const parked = await launch(registry, r.dataDir);
  const store = new ChatTokenStore();
  store.stored = registry;
  assert.equal(store.verify(TOKEN), CHAT);
  parked.stdin.end();
  await once(parked, 'close');
  assert.equal(store.verify(TOKEN), null);
  assert.equal(r.store.byTokenHash(chatTokenHash(TOKEN)), null);
  assert.equal(r.sql.prepare('SELECT COUNT(*) AS n FROM cli_processes').get()?.n, 0);
});

/** A pid no process has now, so nothing can match it by start time either */
function unusedPid(): number {
  for (let pid = 4_194_000; pid > 1; pid -= 1) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
  throw new Error('no free pid');
}

test('a stored chat token is bound to the process by pid and start time, to a server that holds it, and to a day', async () => {
  let clock = Date.now();
  const r = rig(() => clock);
  const registry = r.server();
  const parked = await launch(registry, r.dataDir);
  const store = new ChatTokenStore();
  store.stored = registry;
  const cli = r.store.get(parked.id)?.cli;
  assert.ok(cli);
  // The pid was reused by another process: same pid, a start time that is not the CLI's
  r.sql.prepare('UPDATE cli_processes SET cli_started = ?').run(cli.started + 1);
  assert.equal(store.verify(TOKEN), null, 'a different start time is a different process');
  // Not `cli.pid + 1`: under load that is often the CLI's own child, started in the same clock tick
  r.sql.prepare('UPDATE cli_processes SET cli_started = ?, cli_pid = ?').run(cli.started, unusedPid());
  assert.equal(store.verify(TOKEN), null, 'a different pid is a different process');
  r.sql.prepare('UPDATE cli_processes SET cli_pid = ?').run(cli.pid);
  assert.equal(store.verify(TOKEN), CHAT);
  // No server holds it (released, or its owner gone and not yet taken): nobody answers for it
  r.sql.prepare('UPDATE cli_processes SET owner_pid = NULL, owner_started = NULL').run();
  assert.equal(store.verify(TOKEN), null);
  r.sql.prepare('UPDATE cli_processes SET owner_pid = 999999999, owner_started = 1').run();
  assert.equal(store.verify(TOKEN), null);
  r.sql.prepare('UPDATE cli_processes SET owner_pid = ?, owner_started = ?').run(process.pid, processEntry(process.pid)?.started ?? 0);
  assert.equal(store.verify(TOKEN), CHAT);
  clock += CHAT_TOKEN_MAX_AGE_MS;
  assert.equal(store.verify(TOKEN), null, 'the day cap of every chat token holds across restarts');
  parked.kill('SIGKILL');
  await once(parked, 'close');
});

test('a token minted in memory is unaffected by the stored ones', () => {
  const store = new ChatTokenStore();
  store.stored = { chatForTokenHash: () => 'someone-else' };
  const token = store.mint('chat-a');
  assert.equal(store.verify(token), 'chat-a');
  store.revoke(token);
  // Revoked in memory, and not in any row: refused by the stored source's own answer only
  assert.equal(store.verify(token), 'someone-else');
});

test('a parked process records the address it was given, its payload directory and its CLI version', async () => {
  const r = rig();
  const registry = r.server();
  registry.cliVersion = () => '9.9.9-fixture';
  const parked = await launch(registry, r.dataDir, { CLAUDIO_MCP_ENTRY: '/data/app/0.20.0/server/mcp.mjs' });
  const row = r.store.get(parked.id);
  assert.equal(row?.payloadDir, '/data/app/0.20.0/server');
  assert.equal(row?.cliVersion, '9.9.9-fixture');
  assert.equal(readFileSync(join(parked.dir, PARKED_FILES.apiUrl), 'utf8').trim(), 'http://127.0.0.1:45871/api');
  assert.equal(registry.apiPort(), 45871);
  parked.kill('SIGKILL');
  await once(parked, 'close');
  assert.equal(registry.apiPort(), null, 'no running CLI, no address to keep');
});

test('a restarted server binds the port its running CLIs hold: the one most of them hold, the newest on a tie', async () => {
  const r = rig();
  const registry = r.server();
  assert.equal(registry.apiPort(), null);
  const one = await launch(registry, r.dataDir, { CLAUDIO_API_URL: 'http://127.0.0.1:41001/api' });
  const two = await launch(registry, r.dataDir, { CLAUDIO_API_URL: 'http://127.0.0.1:41002/api' });
  r.sql.prepare('UPDATE cli_processes SET started_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', one.id);
  assert.equal(registry.apiPort(), 41002, 'a tie goes to the newest process');
  const three = await launch(registry, r.dataDir, { CLAUDIO_API_URL: 'http://127.0.0.1:41001/api' });
  assert.equal(registry.apiPort(), 41001, 'two processes outweigh one');
  for (const p of [one, two, three]) p.kill('SIGKILL');
  await Promise.all([one, two, three].map((p) => once(p, 'close')));
});

test('a chat with a CLI running keeps the files its start wrote when the next server starts', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE, parked: { handoverSeconds: 300, scopes: false } };
  const db = new Db(config);
  const before = new ChatManager(config, db);
  const chat = before.start({ prompt: 'hello', cwd: config.workspaceDir });
  await until(() => before.parked.held()[0], (p) => p !== undefined, 'the parked process');
  const kept = writeChatExtrasConfigSync(config.dataDir, chat.id, { demo: { command: 'x' } });
  const strangers = writeChatExtrasConfigSync(config.dataDir, '99999999-2222-4333-8444-555555555555', { demo: { command: 'x' } });
  // Another server restores: the first one's process is held by a server that runs, so it is left alone
  const next = new ChatManager(config, db);
  await next.restore(new SessionStore(config));
  assert.equal(existsSync(kept), true, 'the running CLI still reads its --mcp-config');
  assert.equal(existsSync(strangers), false, 'a chat with no process has nothing to keep it');
  await before.stopAll(500);
  await next.stopAll(500);
  db.close();
});

function machine(dataDir: string, pinned: MachineFiles['pinned']): Machine {
  const removed: string[] = [];
  const files = { exists: () => true, list: () => ['0.19.0', '0.20.0', '0.21.0', '.staging-x'], remove: (p: string) => removed.push(p), ...(pinned ? { pinned } : {}) } as unknown as MachineFiles;
  return Object.assign({ baseDir: '/app', dataDir, files, now: () => 0, log: () => {} }, { removed }) as Machine & { removed: string[] };
}

test('an overlay a running CLI still runs from is not collected, and one nobody uses still is', () => {
  const m = machine('/d', () => ['/d/app/0.19.0/server']) as Machine & { removed: string[] };
  collectOverlays(m, { ...EMPTY_STATE, active: '0.21.0' });
  assert.deepEqual(m.removed.sort(), ['/d/app/.staging-x', '/d/app/0.20.0'].sort());
});

test('an overlay is collected as before where nothing is pinned, and kept whole where the pins cannot be read', () => {
  const none = machine('/d', undefined) as Machine & { removed: string[] };
  collectOverlays(none, { ...EMPTY_STATE, active: '0.21.0' });
  assert.deepEqual(none.removed.sort(), ['/d/app/.staging-x', '/d/app/0.19.0', '/d/app/0.20.0'].sort());
  const unreadable = machine('/d', () => null) as Machine & { removed: string[] };
  collectOverlays(unreadable, { ...EMPTY_STATE, active: '0.21.0' });
  assert.deepEqual(unreadable.removed, ['/d/app/.staging-x']);
});

test('the pins are read from the rows of processes that still run, and from none that ended', async () => {
  const r = rig();
  assert.deepEqual(pinnedPayloads(mkdtempSync(join(tmpdir(), 'claudio-nodb-'))), []);
  const parked = await launch(r.server(), r.dataDir, { CLAUDIO_MCP_ENTRY: join(r.dataDir, 'app', '0.20.0', 'server', 'mcp.mjs') });
  assert.deepEqual(pinnedPayloads(r.dataDir), [join(r.dataDir, 'app', '0.20.0', 'server')]);
  mkdirSync(join(r.dataDir, 'x'), { recursive: true });
  writeFileSync(join(r.dataDir, 'x', 'f'), '');
  parked.kill('SIGKILL');
  await once(parked, 'close');
  assert.deepEqual(pinnedPayloads(r.dataDir), []);
  const broken = mkdtempSync(join(tmpdir(), 'claudio-baddb-'));
  writeFileSync(join(broken, 'wrapper.db'), 'not a database');
  assert.equal(pinnedPayloads(broken), null);
});

// The integration with adoption (t4): a CLI the next start takes over calls the API with the token it
// was started with, and only from the moment this server owns its row.
test('an adopted chat\'s CLI keeps calling the API with its old token: refused before adoption and after the process ends, its configs kept', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE, parked: { handoverSeconds: 300, scopes: false } };
  const db = new Db(config);
  const before = new ChatManager(config, db);
  before.apiUrl = 'http://127.0.0.1:45872/api';
  const chat = before.start({ prompt: 'SLEEP 3', cwd: config.workspaceDir });
  const parked = (await until(() => before.parked.held()[0], (p) => p !== undefined, 'the parked process')) as ParkedProcess;
  const cli = await until(() => parked.cli(), (c) => c !== null, 'the CLI pid');
  // The token as the CLI holds it, from its own environment: the only place it ever is
  const token = /CLAUDIO_API_TOKEN=(agc_[^\0]+)/.exec(readFileSync(`/proc/${String(cli?.pid)}/environ`, 'utf8'))?.[1] ?? '';
  assert.ok(token.startsWith(CHAT_TOKEN_PREFIX));
  const extras = writeChatExtrasConfigSync(config.dataDir, chat.id, { demo: { command: 'x' } });
  // A clean shutdown lets the process go on and releases its row
  await before.stopAll(500);
  db.close();

  const db2 = new Db(config);
  const after = new ChatManager(config, db2);
  // What `Core` wires: this server's token store reads the rows of its parked processes
  after.chatTokens.stored = after.parked;
  assert.equal(after.chatTokens.verify(token), null, 'no server owns the row yet: the old token answers nobody');
  await after.restore(new SessionStore(config));
  assert.equal(after.adopted(chat.id), true);
  assert.equal(after.chatTokens.verify(token), chat.id, 'adopted: the old token works again');
  assert.equal(after.chatTokens.holds(token), true);
  assert.equal(existsSync(extras), true, 'the adopted CLI still reads its --mcp-config');
  const closed = once(after.parked.held()[0] as ParkedProcess, 'close');
  (after.parked.held()[0] as ParkedProcess).kill('SIGKILL');
  await closed;
  assert.equal(after.chatTokens.verify(token), null, 'the process ended: its row and its token are gone');
  await after.stopAll(500);
  db2.close();
});
