import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AccountStore, readingFromEvent } from '@claudio/accounts';
import { LIMIT_CONTINUE_TEXT, type Account, type ProviderMove } from '@claudio/shared';
import { ChatManager } from '../src/chats.ts';
import { Db, LIMIT_HOLDS_SCHEMA_VERSION, migrate } from '../src/db.ts';
import { ClaudeCodeDriver } from '../src/providers/claude-code/driver.ts';
import { defaultProvidersSettings, defaultRotationSettings } from '../src/providers/settings.ts';
import { ProviderRotation, probeTargets, type WaitEnd } from '../src/rotation.ts';
import { SessionStore } from '../src/sessions.ts';
import { tempConfig } from './helpers.ts';

// The hold sweeper (t8 of docs/plans/limit-resume-and-credits.md): the wait row is the only owner of
// a wait. It says when it looks again, keeps the turn it replays, and asks `get_usage` (stubbed here:
// no CLI, no turn) when nothing says when the accounts reset. The rotation's clock is injected and
// the tests drive the sweeper's passes themselves (`sweep()`), with its own timer an hour away.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const MIN = 60_000;
const HOUR = 60 * MIN;

const waitFor = async (check: () => boolean, ms = 20_000): Promise<void> => {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 15));
  }
};

interface Options {
  config?: ReturnType<typeof tempConfig>;
  probe?: (chatId: string, since: number) => Promise<void>;
  /** The rotation's clock starts here; the test moves it with `skip` */
  clock?: number;
  pollMs?: number;
}

/** One process on a data directory, with the rotation's clock in the test's hands. */
function boot(o: Options = {}) {
  const config = o.config ?? { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const chats = new ChatManager(config, db, [new ClaudeCodeDriver(FAKE_CLAUDE)]);
  const settings = defaultProvidersSettings(['claude-code']);
  settings.rotation = defaultRotationSettings();
  const ended: Array<{ move: ProviderMove; end: WaitEnd; reason: string | null }> = [];
  let offset = 0;
  const now = (): number => (o.clock ?? Date.now()) + offset;
  const rotation = new ProviderRotation({
    db,
    runtime: chats,
    settings: () => settings,
    projectProviders: () => null,
    projectOf: () => null,
    emit: () => undefined,
    ended: (move, end, reason) => ended.push({ move, end, reason }),
    ...(o.probe ? { probe: o.probe } : {}),
    now,
    pollMs: o.pollMs ?? HOUR,
    slackMs: 0,
    // Only the test's own passes look, unless a row falls due on the injected clock
    sweepMs: HOUR,
  });
  rotation.start();
  return {
    config,
    db,
    chats,
    rotation,
    ended,
    now,
    skip: (ms: number) => {
      offset += ms;
    },
    limited: async (prompt = 'FAKE-LIMIT-ONCE'): Promise<string> => {
      const chat = chats.start({ prompt, name: 'limited', keepAlive: false });
      await chats.exited(chat.id);
      await new Promise((r) => setTimeout(r, 30));
      return chat.id;
    },
    close: () => {
      void rotation.close();
      chats.stopAll();
      db.close();
    },
  };
}

const openRow = (chatId: string, at: string, resetsAt: string | null): ProviderMove => ({
  id: `wait-${chatId}-${Math.random().toString(16).slice(2)}`,
  at,
  subjectKind: 'chat',
  subjectId: chatId,
  projectId: null,
  fromChat: chatId,
  toChat: null,
  fromProvider: 'claude-code',
  toProvider: null,
  fromModel: null,
  toModel: null,
  action: 'wait',
  state: 'waiting',
  decidedBy: 'setting',
  decisionId: null,
  resetsAt,
  reason: null,
  updatedAt: at,
});

test('the migration keeps the open waits of an older database, due at once and with no turn', () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const raw = new DatabaseSync(join(config.dataDir, 'wrapper.db'));
  migrate(raw, LIMIT_HOLDS_SCHEMA_VERSION - 1);
  raw
    .prepare(
      `INSERT INTO provider_moves (id, at, subject_kind, subject_id, project_id, from_chat, from_provider, action, state, decided_by, resets_at, claimed_until, updated_at)
       VALUES ('old-wait', '2026-11-01T10:00:00.000Z', 'task', 'o1:t1', NULL, 'chat-1', 'claude-code', 'wait', 'resuming', 'setting', NULL, '2026-11-01T10:02:00.000Z', '2026-11-01T10:00:00.000Z')`,
    )
    .run();
  raw.close();
  const db = new Db(config);
  try {
    const [hold] = db.openHolds();
    assert.equal(hold?.id, 'old-wait', 'the wait an older Claudio opened is still open');
    assert.equal(hold.nextLookAt, null, 'no next look reads as due now');
    assert.equal(hold.probeCount, 0);
    assert.equal(hold.turn, null);
    assert.equal(hold.claimedUntil, '2026-11-01T10:02:00.000Z');
    assert.equal(db.providerMove('old-wait')?.state, 'resuming');
  } finally {
    db.close();
  }
});

test('a wait an older Claudio opened, with no next look and no turn, is taken over by the first pass and resumed', async () => {
  const r = boot();
  try {
    const id = await r.limited();
    const sent: string[] = [];
    const send = r.chats.sendMessage.bind(r.chats);
    r.chats.sendMessage = (...args: Parameters<ChatManager['sendMessage']>) => (sent.push(args[1]), send(...args));
    // Inserted as an older Claudio would have: no next look, no turn
    const row = openRow(id, new Date(r.now() - HOUR).toISOString(), new Date(r.now() - MIN).toISOString());
    assert.equal(r.db.insertProviderMove(row), true);
    await r.rotation.recover();
    await waitFor(() => r.db.providerMove(row.id)?.state === 'resumed');
    assert.equal(r.rotation.holds(id), false);
    assert.deepEqual(r.ended.map((e) => e.end), ['resumed']);
    assert.ok(sent.length >= 1, 'a turn went out');
  } finally {
    r.close();
  }
});

test('a wait with no reset asks get_usage at 5, 15, 30 and then every 60 minutes, never between', async () => {
  const probes: number[] = [];
  const clock = Date.parse('2026-11-14T10:00:00.000Z');
  const r = boot({ clock, probe: () => (probes.push(r.now() - clock), Promise.resolve()) });
  try {
    const id = await r.limited();
    const wait = r.rotation.waitFor(id);
    assert.ok(wait && wait.resetsAt === null, 'the fake gives no reset');
    assert.equal(wait.nextLookAt, new Date(clock + 5 * MIN).toISOString(), 'the first look is the first probe');
    const at = async (minutes: number): Promise<void> => {
      r.skip(clock + minutes * MIN - r.now());
      await r.rotation.sweep();
    };
    await at(1);
    await at(4);
    assert.deepEqual(probes, [], 'nothing is asked before the first look');
    await at(5);
    await r.rotation.sweep();
    await r.rotation.sweep(true);
    assert.deepEqual(probes, [5 * MIN], 'one probe per look, however many passes');
    await at(19);
    await at(20);
    await at(49);
    await at(50);
    await at(110);
    await at(170);
    assert.deepEqual(probes.map((ms) => ms / MIN), [5, 20, 50, 110, 170]);
    const row = r.db.providerMove(wait.id);
    assert.equal(row?.probeCount, 5);
    assert.equal(row?.state, 'waiting');
    assert.equal(row?.nextLookAt, new Date(clock + 230 * MIN).toISOString());
  } finally {
    r.close();
  }
});

test('a wait with no reset is given up only once a probe past maxWaitHours answered nothing', async () => {
  let probes = 0;
  const clock = Date.parse('2026-11-14T10:00:00.000Z');
  const r = boot({ clock, probe: () => (probes++, Promise.resolve()) });
  try {
    const id = await r.limited();
    const wait = r.rotation.waitFor(id);
    assert.ok(wait);
    // The cap (6 h) passed with no look in between: the process slept, say
    r.skip(7 * HOUR);
    await r.rotation.sweep();
    assert.equal(probes, 1, 'the accounts are asked before the wait is given up');
    assert.equal(r.db.providerMove(wait.id)?.state, 'waiting');
    r.skip(15 * MIN);
    await r.rotation.sweep();
    assert.equal(r.db.providerMove(wait.id)?.state, 'failed');
    assert.equal(r.db.providerMove(wait.id)?.reason, 'limit-wait-expired');
    assert.equal(probes, 1);
  } finally {
    r.close();
  }
});

test('a wait with no reset ends when get_usage says an account is back', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const saved = { dirs: process.env.FAKE_CLAUDE_LIMITED_DIRS, dir: process.env.CLAUDE_CONFIG_DIR, key: process.env.ANTHROPIC_API_KEY };
  const db = new Db(config);
  let live: ChatManager | null = null;
  const store = new AccountStore({ dataDir: config.dataDir, defaultDir: config.configDir, claude: FAKE_CLAUDE, liveChatsOn: (id) => live?.liveChatsOn(id) ?? [] });
  await store.setSettings({ strategy: 'order' });
  const a = await store.add({ kind: 'token', alias: 'alpha', secret: 'tok-alpha' });
  process.env.CLAUDE_CONFIG_DIR = config.configDir;
  process.env.ANTHROPIC_API_KEY = 'wrapper-key';
  // Every account dies on a bare 429: no reading, no reset
  process.env.FAKE_CLAUDE_LIMITED_DIRS = [config.configDir, store.ref(a.id).dir].join(',');
  const chats = new ChatManager(config, db, [new ClaudeCodeDriver(FAKE_CLAUDE)]);
  chats.accounts = store;
  live = chats;
  const settings = defaultProvidersSettings(['claude-code']);
  settings.rotation = defaultRotationSettings();
  const asked: Array<{ chatId: string; targets: string[] }> = [];
  const rotation = new ProviderRotation({
    db,
    runtime: chats,
    settings: () => settings,
    projectProviders: () => null,
    projectOf: () => null,
    emit: () => undefined,
    accountsChanged: (listener) => store.onChange(listener),
    probe: async (chatId, since) => {
      const run = chats.get(chatId);
      asked.push({ chatId, targets: run ? probeTargets(run, store.list(), since) : [] });
      // What `get_usage` answers for alpha: back, with room
      process.env.FAKE_CLAUDE_LIMITED_DIRS = '';
      const at = Date.now();
      const reading = readingFromEvent({ status: 'allowed', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: Math.floor(at / 1000) + 5 * 3600 } } }, at);
      assert.ok(reading);
      await chats.noteAccountReading(a.id, reading);
    },
    now: () => Date.now(),
    pollMs: HOUR,
    slackMs: 0,
    sweepMs: HOUR,
    // The first look comes at once; the next one an hour later
    probeBackoffMs: [1, HOUR],
  });
  rotation.start();
  try {
    const chat = chats.start({ prompt: 'hello', name: 'asks', keepAlive: false });
    await waitFor(() => db.providerMoves({ chatId: chat.id }).some((m) => m.state === 'waiting'));
    const [wait] = db.providerMoves({ chatId: chat.id });
    assert.equal(wait?.resetsAt, null, 'nothing said when any account resets');
    await new Promise((r) => setTimeout(r, 10));
    await rotation.sweep();
    await waitFor(() => db.providerMove(wait.id)?.state === 'resumed');
    assert.equal(asked.length, 1, 'one probe, and no turn started to find out');
    assert.ok(asked[0]?.targets.includes(a.id), 'the account the chat could go on with is asked');
    await waitFor(() => (chats.get(chat.id)?.executions.length ?? 0) >= 2);
  } finally {
    void rotation.close();
    chats.stopAll();
    db.close();
    for (const [name, value] of [['FAKE_CLAUDE_LIMITED_DIRS', saved.dirs], ['CLAUDE_CONFIG_DIR', saved.dir], ['ANTHROPIC_API_KEY', saved.key]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('after a restart the wait replays the turn that died, from its row, not the nudge', async () => {
  const prompt = 'FAKE-LIMIT-REPORTED-ONCE\nPaint the blue door';
  const first = boot();
  let id = '';
  let waitId = '';
  try {
    id = await first.limited(prompt);
    const wait = first.rotation.waitFor(id);
    assert.ok(wait?.resetsAt, 'the refusal named its reset');
    waitId = wait.id;
  } finally {
    first.close();
  }

  // A new process, after the reset: the chat's memory of its turn is gone, the row's is not
  const second = boot({ config: first.config });
  try {
    await second.chats.restore(new SessionStore(first.config));
    assert.equal(second.chats.limitTurnOf(id), null, 'the restored chat does not know its turn');
    const sent: string[] = [];
    const send = second.chats.sendMessage.bind(second.chats);
    second.chats.sendMessage = (...args: Parameters<ChatManager['sendMessage']>) => (sent.push(args[1]), send(...args));
    second.skip(2 * HOUR);
    await second.rotation.recover();
    await waitFor(() => second.db.providerMove(waitId)?.state === 'resumed');
    assert.deepEqual(sent, [prompt], 'the person\'s turn went again, word for word');
    assert.ok(!sent.includes(LIMIT_CONTINUE_TEXT));
    await waitFor(() => (second.chats.get(id)?.executions.length ?? 0) >= 2);
  } finally {
    second.close();
  }
});

test('a claim cut short by a restart is taken again once it lapses', async () => {
  const r = boot();
  try {
    const id = await r.limited();
    const row = openRow(id, new Date(r.now() - HOUR).toISOString(), new Date(r.now() - MIN).toISOString());
    assert.equal(r.db.insertProviderMove(row), true);
    // A process claimed it and went away before the replay
    assert.equal(r.db.claimProviderMove(row.id, new Date(r.now()).toISOString(), new Date(r.now() + 2 * MIN).toISOString()), true);
    await r.rotation.recover();
    assert.equal(r.db.providerMove(row.id)?.state, 'resuming', 'a live claim is left alone');
    assert.equal(r.rotation.holds(id), true, 'and the chat is held all the same');
    r.skip(3 * MIN);
    await r.rotation.sweep();
    await waitFor(() => r.db.providerMove(row.id)?.state === 'resumed');
    assert.deepEqual(r.ended.map((e) => e.end), ['resumed']);
  } finally {
    r.close();
  }
});

test('a wait for a reset days away sleeps until its next look instead of passing in a loop', async () => {
  const r = boot({ pollMs: 50 });
  try {
    const id = await r.limited();
    const row = openRow(id, new Date(r.now()).toISOString(), new Date(r.now() + 72 * HOUR).toISOString());
    assert.equal(r.db.insertProviderMove(row), true);
    const passes = { n: 0 };
    const read = r.db.openHolds.bind(r.db);
    r.db.openHolds = () => (passes.n++, read());
    await r.rotation.recover();
    await new Promise((res) => setTimeout(res, 400));
    // A pass and its schedule read the rows twice; a poll every 50 ms is some sixteen reads here
    assert.ok(passes.n <= 30, `the sweeper read the waits ${String(passes.n)} times in 400 ms`);
    assert.equal(r.db.providerMove(row.id)?.state, 'waiting');
    // Against when it last looked, not against now: with a 50 ms poll, a loaded machine reached this
    // line more than 50 ms after the last pass, and a look still due read as none scheduled
    const after = r.db.providerMove(row.id);
    assert.ok(Date.parse(after?.nextLookAt ?? '') > Date.parse(after?.updatedAt ?? ''), 'it says when it looks again');
  } finally {
    r.close();
  }
});

test('a wait for a known reset asks get_usage at 15, 45 and then every 60 minutes, never between, and not once its reset comes first', async () => {
  const probes: number[] = [];
  const clock = Date.parse('2026-11-14T10:00:00.000Z');
  const r = boot({ clock, pollMs: 5 * MIN, probe: () => (probes.push(r.now() - clock), Promise.resolve()) });
  try {
    const id = await r.limited();
    const row = openRow(id, new Date(clock).toISOString(), new Date(clock + 4 * HOUR).toISOString());
    assert.equal(r.db.insertProviderMove(row), true);
    await r.rotation.recover();
    const at = async (minutes: number): Promise<void> => {
      r.skip(clock + minutes * MIN - r.now());
      await r.rotation.sweep();
      // The probe settles in the background; what it records is in place before the next look
      await new Promise((res) => setImmediate(res));
      await r.rotation.sweep();
    };
    for (const m of [5, 10, 14]) await at(m);
    assert.deepEqual(probes, [], 'the poll looks without asking');
    await at(15);
    await r.rotation.sweep(true);
    assert.deepEqual(probes, [15 * MIN], 'one probe per look, however many passes');
    for (const m of [20, 30, 40, 44]) await at(m);
    assert.equal(probes.length, 1, 'nothing is asked between two probes');
    for (let m = 45; m < 240; m += 5) await at(m);
    assert.deepEqual(probes.map((ms) => ms / MIN), [15, 45, 105, 165, 225], 'the reset at 240 comes before the probe at 285');
    const open = r.db.providerMove(row.id);
    assert.equal(open?.state, 'waiting');
    assert.equal(open?.probeCount, 5);
    assert.equal(open?.resetsAt, row.resetsAt, 'a probe that saw nothing new leaves the reset as it was');
  } finally {
    r.close();
  }
});

test('a wait for a reset four hours away goes on at its next probe once the account was reset early, and not before', async (t) => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const saved = { dirs: process.env.FAKE_CLAUDE_LIMITED_DIRS, resets: process.env.FAKE_CLAUDE_LIMIT_RESETS_IN, dir: process.env.CLAUDE_CONFIG_DIR, key: process.env.ANTHROPIC_API_KEY };
  const db = new Db(config);
  let live: ChatManager | null = null;
  const store = new AccountStore({ dataDir: config.dataDir, defaultDir: config.configDir, claude: FAKE_CLAUDE, liveChatsOn: (id) => live?.liveChatsOn(id) ?? [] });
  await store.setSettings({ strategy: 'order' });
  const a = await store.add({ kind: 'token', alias: 'alpha', secret: 'tok-alpha' });
  process.env.CLAUDE_CONFIG_DIR = config.configDir;
  process.env.ANTHROPIC_API_KEY = 'wrapper-key';
  // Every account refuses, and says it is out for four hours
  process.env.FAKE_CLAUDE_LIMITED_DIRS = [config.configDir, store.ref(a.id).dir].join(',');
  process.env.FAKE_CLAUDE_LIMIT_RESETS_IN = String(4 * 3600);
  const chats = new ChatManager(config, db, [new ClaudeCodeDriver(FAKE_CLAUDE)]);
  chats.accounts = store;
  live = chats;
  const settings = defaultProvidersSettings(['claude-code']);
  settings.rotation = defaultRotationSettings();
  let t0 = 0;
  let early = false;
  let resetAt = 0;
  const asked: Array<{ minutes: number; targets: string[] }> = [];
  let settled = 0;
  const rotation = new ProviderRotation({
    db,
    runtime: chats,
    settings: () => settings,
    projectProviders: () => null,
    projectOf: () => null,
    emit: () => undefined,
    accountsChanged: (listener) => store.onChange(listener),
    // What `get_usage` answers: the window still spent until the person resets it, then a new one with room
    probe: async (chatId, since) => {
      const run = chats.get(chatId);
      const targets = run ? probeTargets(run, store.list(), since) : [];
      asked.push({ minutes: (Date.now() - t0) / MIN, targets });
      // What the account says at the moment it is asked, whatever happens while the answer is recorded
      const wasReset = early;
      for (const id of targets) {
        const at = Date.now();
        const reading = wasReset
          ? readingFromEvent({ status: 'allowed', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.02, resetsAt: Math.floor(at / 1000) + 5 * 3600 } } }, at)
          : readingFromEvent({ status: 'allowed', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1, resetsAt: Math.floor(resetAt / 1000) } } }, at);
        assert.ok(reading);
        await chats.noteAccountReading(id, reading);
      }
      settled++;
    },
    // One clock: the chats, the accounts and the rotation all read `Date`, which the test moves
    now: () => Date.now(),
    pollMs: 5 * MIN,
    slackMs: 0,
    sweepMs: HOUR,
  });
  rotation.start();
  try {
    const chat = chats.start({ prompt: 'hello', name: 'all out', keepAlive: false });
    await waitFor(() => db.providerMoves({ chatId: chat.id }).some((m) => m.state === 'waiting'));
    const [wait] = db.providerMoves({ chatId: chat.id });
    assert.ok(wait?.resetsAt && Date.parse(wait.resetsAt) > Date.now() + 3 * HOUR, 'the refusal named a reset hours away');
    resetAt = Date.parse(wait.resetsAt);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t0 = Date.parse(wait.at);
    const to = async (minutes: number): Promise<void> => {
      t.mock.timers.tick(Math.max(0, t0 + minutes * MIN - Date.now()));
      await rotation.sweep();
      await new Promise((res) => setImmediate(res));
      await rotation.sweep();
    };

    await to(5);
    await to(10);
    assert.equal(asked.length, 0, 'the poll looks without asking');
    await to(15);
    await waitFor(() => settled === 1);
    await to(15);
    assert.ok(asked[0]?.targets.includes(a.id), 'the account the chat could go on with is asked');
    assert.equal(db.providerMove(wait.id)?.state, 'waiting', 'still spent: the wait goes on');

    // The person resets the account's quota from Claude's settings
    early = true;
    process.env.FAKE_CLAUDE_LIMITED_DIRS = '';
    await to(20);
    await to(40);
    assert.equal(asked.length, 1, 'nothing is asked before the next probe');
    assert.equal(db.providerMove(wait.id)?.state, 'waiting', 'and nothing else says it was reset');

    await to(45);
    await waitFor(() => db.providerMove(wait.id)?.state === 'resumed');
    assert.deepEqual(asked.map((p) => p.minutes), [15, 45]);
    assert.ok(Date.now() < resetAt, 'it went on hours before the reset the refusal announced');
    assert.equal(db.providerMove(wait.id)?.probeCount, 2);
    assert.equal(store.get(a.id).limits?.state, 'ok', 'the account shows the reading the probe took');
    await waitFor(() => (chats.get(chat.id)?.executions.length ?? 0) >= 3 && chats.get(chat.id)?.status !== 'busy' && chats.get(chat.id)?.status !== 'starting');
    assert.equal(chats.atLimit(chat.id), false, 'the turn went through');
  } finally {
    void rotation.close();
    chats.stopAll();
    db.close();
    for (const [name, value] of [['FAKE_CLAUDE_LIMITED_DIRS', saved.dirs], ['FAKE_CLAUDE_LIMIT_RESETS_IN', saved.resets], ['CLAUDE_CONFIG_DIR', saved.dir], ['ANTHROPIC_API_KEY', saved.key]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('a probe asks only the accounts a chat could go on with whose reading is older than the last look', () => {
  const reading = (at: string) => ({ state: 'exhausted', observedAt: at }) as unknown as NonNullable<Account['limits']>;
  const accounts = [
    { id: 'a', kind: 'login', enabled: true, signedIn: true, limits: reading('2026-11-14T09:00:00.000Z') },
    { id: 'b', kind: 'login', enabled: true, signedIn: true, limits: reading('2026-11-14T11:00:00.000Z') },
    { id: 'c', kind: 'login', enabled: true, signedIn: true, limits: null },
    { id: 'd', kind: 'api-key', enabled: true, signedIn: true, limits: null },
    { id: 'e', kind: 'login', enabled: false, signedIn: true, limits: null },
    { id: 'f', kind: 'token', enabled: true, signedIn: false, limits: null },
  ] satisfies Array<Pick<Account, 'id' | 'kind' | 'enabled' | 'signedIn' | 'limits'>>;
  const since = Date.parse('2026-11-14T10:00:00.000Z');
  assert.deepEqual(probeTargets({ account: 'a' }, accounts, since), ['a', 'c'], 'b read since; an API key has no plan; e is off; f is signed out');
  assert.deepEqual(probeTargets({ account: 'c', accountPinned: true }, accounts, since), ['c'], 'a pinned chat goes on only with its own account');
});
