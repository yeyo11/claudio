import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AccountInUseError, AccountStore, DEFAULT_ID, readingFromEvent } from '@claudio/accounts';
import type { ChatWork } from '../src/chat-service.ts';
import { ChatManager } from '../src/chats.ts';
import { Core } from '../src/index.ts';
import { Db } from '../src/db.ts';
import { EventBus, type ClaudioEventInput } from '../src/events.ts';
import { ClaudeCodeDriver } from '../src/providers/claude-code/driver.ts';
import { defaultProvidersSettings, defaultRotationSettings } from '../src/providers/settings.ts';
import { ProviderRotation, RunNowRefusal } from '../src/rotation.ts';
import { tempConfig } from './helpers.ts';

// Several accounts over the fake Claude: the account a process runs on, the limit path (move to
// another account and replay, else wait), and what is kept of it. `FAKE_CLAUDE_LIMITED_DIRS` makes an
// account out; `FAKE_CLAUDE_ACCOUNTS` records the account variables each process was given.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const ACCOUNT_VARIABLES = ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

interface Spawn {
  dir: string | null;
  oauth: string | null;
  apiKey: string | null;
  authToken: string | null;
}

async function rig(opts: { work?: ChatWork | null; limited?: (ids: Record<string, string>) => string[]; expired?: (ids: Record<string, string>) => string[]; lite?: (ids: Record<string, string>) => string[]; resetsIn?: number; pollMs?: number; resolvedModel?: string } = {}) {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  let live: ChatManager | null = null;
  const store = new AccountStore({ dataDir: config.dataDir, defaultDir: config.configDir, claude: FAKE_CLAUDE, liveChatsOn: (id) => live?.liveChatsOn(id) ?? [] });
  await store.setSettings({ strategy: 'order' });
  const a = await store.add({ kind: 'token', alias: 'alpha', secret: 'tok-alpha' });
  const b = await store.add({ kind: 'api-key', alias: 'beta', secret: 'key-beta' });
  const c = await store.add({ kind: 'token', alias: 'gamma', secret: 'tok-gamma' });
  const dirs = { [DEFAULT_ID]: config.configDir, [a.id]: store.ref(a.id).dir, [b.id]: store.ref(b.id).dir, [c.id]: store.ref(c.id).dir };
  const spawns = join(config.dataDir, 'spawns.log');
  const saved: Record<string, string | undefined> = {};
  const set = (name: string, value: string): void => {
    saved[name] = process.env[name];
    process.env[name] = value;
  };
  for (const name of ACCOUNT_VARIABLES) saved[name] = process.env[name];
  // The wrapper itself runs with credentials of its own: no process of an account may carry them
  set('CLAUDE_CONFIG_DIR', config.configDir);
  set('ANTHROPIC_API_KEY', 'wrapper-key');
  set('ANTHROPIC_AUTH_TOKEN', 'wrapper-auth');
  set('FAKE_CLAUDE_ACCOUNTS', spawns);
  set('FAKE_CLAUDE_LIMITED_DIRS', (opts.limited?.(dirs) ?? []).join(','));
  set('FAKE_CLAUDE_EXPIRED_DIRS', (opts.expired?.(dirs) ?? []).join(','));
  set('FAKE_CLAUDE_LITE_DIRS', (opts.lite?.(dirs) ?? []).join(','));
  set('FAKE_CLAUDE_LIMIT_RESETS_IN', opts.resetsIn ? String(opts.resetsIn) : '');
  set('FAKE_CLAUDE_RESOLVED_MODEL', opts.resolvedModel ?? '');
  const chats = new ChatManager(config, db, [new ClaudeCodeDriver(FAKE_CLAUDE)]);
  chats.accounts = store;
  live = chats;
  const settings = defaultProvidersSettings(['claude-code']);
  settings.rotation = defaultRotationSettings();
  const events: ClaudioEventInput[] = [];
  const bus = new EventBus();
  bus.subscribe((event) => events.push(event));
  chats.bus = bus;
  const rotation = new ProviderRotation({
    db,
    runtime: chats,
    settings: () => settings,
    projectProviders: () => null,
    projectOf: () => null,
    emit: (event) => events.push(event),
    ...(opts.work ? { work: () => opts.work ?? null } : {}),
    accountsChanged: (listener) => store.onChange(listener),
    pollMs: opts.pollMs ?? 20,
    slackMs: 0,
  });
  rotation.start();
  return {
    config,
    db,
    store,
    chats,
    rotation,
    events,
    ids: { a: a.id, b: b.id, c: c.id },
    dirs,
    spawns: (): Spawn[] => (existsSync(spawns) ? readFileSync(spawns, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Spawn) : []),
    close: () => {
      rotation.close();
      chats.stopAll();
      db.close();
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      delete process.env.FAKE_CLAUDE_ACCOUNTS;
      delete process.env.FAKE_CLAUDE_LIMITED_DIRS;
      delete process.env.FAKE_CLAUDE_LITE_DIRS;
      delete process.env.FAKE_CLAUDE_EXPIRED_DIRS;
      delete process.env.FAKE_CLAUDE_LIMIT_RESETS_IN;
      delete process.env.FAKE_CLAUDE_RESOLVED_MODEL;
    },
  };
}

const waitFor = async (check: () => boolean, ms = 8000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 15));
  }
};

const work: ChatWork = { subjectKind: 'flow_run', subjectId: 'run-1' };

test('a limit with a second account replays the turn in the same chat on it', async () => {
  const r = await rig({ limited: (d) => [d[DEFAULT_ID] ?? ''] });
  try {
    const chat = r.chats.start({ prompt: 'hello', name: 'moves', keepAlive: false });
    await waitFor(() => r.chats.accountOf(chat.id) === r.ids.a && r.spawns().length === 2);
    await r.chats.exited(chat.id);

    const [first, second] = r.spawns();
    assert.equal(first?.dir, r.dirs[DEFAULT_ID], 'it began on the CLI\'s own login');
    assert.equal(second?.dir, r.dirs[r.ids.a], 'and went on with the next account');
    assert.equal(second?.oauth, 'tok-alpha');
    assert.equal(r.chats.get(chat.id)?.account, r.ids.a);
    const executions = r.chats.get(chat.id)?.executions ?? [];
    assert.deepEqual(executions.map((e) => e.account), [DEFAULT_ID, r.ids.a], 'the first ran on the default login, the second on alpha');

    const events = r.db.rotationEvents();
    assert.equal(events.length, 1);
    assert.deepEqual([events[0]?.event, events[0]?.from, events[0]?.to, events[0]?.reason], ['switch', DEFAULT_ID, r.ids.a, 'limit']);
    const rotated = r.events.find((e) => e.type === 'run.accountRotated');
    assert.ok(rotated && rotated.type === 'run.accountRotated' && rotated.from === DEFAULT_ID && rotated.to === r.ids.a && rotated.resumed);
    assert.ok(r.events.some((e) => e.type === 'account.switched'));
    assert.equal(r.db.providerMoves({ chatId: chat.id }).length, 0, 'nothing waits');
    // The fake's 429 comes with no rate_limit_event: nothing says how full the account is or until when
    assert.equal(r.store.get(DEFAULT_ID).limits, null, 'no 100 % window and no reset are made up for the account that failed');
    assert.deepEqual(r.db.usageHistory({ account: DEFAULT_ID }), [], 'and none lands in its history');
  } finally {
    r.close();
  }
});

test('with no account left, automated work waits, with no reset made up when the CLI gave none', async () => {
  const r = await rig({ work, limited: (d) => Object.values(d) });
  try {
    const chat = r.chats.start({ prompt: 'hello', name: 'stuck', keepAlive: false });
    await waitFor(() => r.db.providerMoves({ chatId: chat.id }).length > 0);
    const [move] = r.db.providerMoves({ chatId: chat.id });
    assert.equal(move?.state, 'waiting');
    assert.equal(move?.action, 'wait');
    assert.equal(move?.resetsAt, null, 'every 429 came without a rate_limit_event, so no account says when it is back');
    assert.equal(r.spawns().length, 4, 'every account was tried once before it waited');
    assert.deepEqual(r.db.rotationEvents().map((e) => e.event), ['switch', 'switch', 'switch', 'wait']);
  } finally {
    r.close();
  }
});

test('a limit moves to an account that offers the chat\'s model, and waits when none does', async () => {
  // Alpha and beta are Pro-like (no opus); the CLI's own login and gamma offer it
  const r = await rig({ work, limited: (d) => [d[DEFAULT_ID] ?? ''], lite: (d) => Object.values(d).slice(1, 3) });
  try {
    const chat = r.chats.start({ prompt: 'hello', name: 'opus', keepAlive: false, model: 'opus' });
    await waitFor(() => r.chats.accountOf(chat.id) === r.ids.c && r.spawns().length === 2);
    assert.deepEqual(r.spawns().map((s) => s.dir), [r.dirs[DEFAULT_ID], r.dirs[r.ids.c]], 'alpha and beta were passed over');
  } finally {
    r.close();
  }

  const w = await rig({ work, limited: (d) => [d[DEFAULT_ID] ?? ''], lite: (d) => Object.values(d).slice(1) });
  try {
    const chat = w.chats.start({ prompt: 'hello', name: 'opus waits', keepAlive: false, model: 'opus' });
    await waitFor(() => w.db.providerMoves({ chatId: chat.id }).length > 0);
    assert.equal(w.spawns().length, 1, 'no replay on an account without opus');
    assert.deepEqual(w.db.rotationEvents().map((e) => e.event), ['wait']);
  } finally {
    w.close();
  }
});

test("a person's chat follows rotateOnLimit: off leaves it with its banner", async () => {
  const r = await rig({ limited: (d) => [d[DEFAULT_ID] ?? ''] });
  try {
    await r.store.setSettings({ rotateOnLimit: false });
    const chat = r.chats.start({ prompt: 'hello', name: 'asks', keepAlive: false });
    await r.chats.exited(chat.id);
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(r.spawns().length, 1);
    assert.equal(r.chats.accountOf(chat.id), DEFAULT_ID);
    assert.equal(r.events.filter((e) => e.type === 'run.rateLimited').length, 1);
    assert.equal(r.db.rotationEvents().length, 0);
    assert.equal(r.db.providerMoves({ chatId: chat.id }).length, 0);
  } finally {
    r.close();
  }
});

test('a pinned chat rotates only within its policy', async () => {
  const r = await rig({ limited: (d) => [d.b ?? ''] });
  try {
    // dirs is keyed by id; the rig could not know the ids when it built the limited list
    process.env.FAKE_CLAUDE_LIMITED_DIRS = r.dirs[r.ids.b] ?? '';
    await r.store.createPolicy({ projects: ['p'], order: [r.ids.b, r.ids.c] });
    r.chats.projectOf = () => 'p';
    const chat = r.chats.start({ prompt: 'hello', name: 'pinned', keepAlive: false, account: r.ids.b });
    await waitFor(() => r.chats.accountOf(chat.id) === r.ids.c && r.spawns().length === 2);
    const [first, second] = r.spawns();
    assert.equal(first?.dir, r.dirs[r.ids.b]);
    assert.equal(first?.apiKey, 'key-beta');
    assert.equal(second?.dir, r.dirs[r.ids.c], 'gamma is next in the policy; alpha and the default login are not in it');
    assert.equal(second?.oauth, 'tok-gamma');
    assert.equal(second?.apiKey, null);
    assert.equal(r.chats.get(chat.id)?.accountPinned, true);
  } finally {
    r.close();
  }
});

test('two chats run on two accounts at once, and no process carries two accounts\' variables', async () => {
  const r = await rig();
  try {
    const one = r.chats.start({ prompt: 'one', name: 'one', keepAlive: false, account: r.ids.a });
    const two = r.chats.start({ prompt: 'two', name: 'two', keepAlive: false, account: r.ids.b });
    await Promise.all([r.chats.exited(one.id), r.chats.exited(two.id)]);
    assert.equal(r.chats.accountOf(one.id), r.ids.a);
    assert.equal(r.chats.accountOf(two.id), r.ids.b);
    const spawns = r.spawns();
    assert.equal(spawns.length, 2);
    const alpha = spawns.find((s) => s.dir === r.dirs[r.ids.a]);
    const beta = spawns.find((s) => s.dir === r.dirs[r.ids.b]);
    assert.deepEqual([alpha?.oauth, alpha?.apiKey, alpha?.authToken], ['tok-alpha', null, null], 'the wrapper\'s own key and auth token never reach it');
    assert.deepEqual([beta?.oauth, beta?.apiKey, beta?.authToken], [null, 'key-beta', null]);
  } finally {
    r.close();
  }
});

test('a request for an account that does not exist is refused', async () => {
  const r = await rig();
  try {
    assert.throws(() => r.chats.start({ prompt: 'x', keepAlive: false, account: 'acc-nope' }), /account acc-nope not found/);
  } finally {
    r.close();
  }
});

test('readings land in usage_history once per change', async () => {
  const r = await rig();
  try {
    const at = Date.now();
    const info = { status: 'allowed', rateLimitType: 'five_hour', resetsAt: Math.floor(at / 1000) + 3600, utilization: 0.4, unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: Math.floor(at / 1000) + 3600 } } };
    const reading = readingFromEvent(info, at);
    assert.ok(reading);
    await r.chats.noteAccountReading(r.ids.a, reading);
    await r.chats.noteAccountReading(r.ids.a, { ...reading, at: at + 1000 });
    const next = readingFromEvent({ ...info, unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: info.resetsAt } } }, at + 2000);
    assert.ok(next);
    await r.chats.noteAccountReading(r.ids.a, next);
    const history = r.db.usageHistory({ account: r.ids.a });
    assert.deepEqual(history.map((p) => [p.window, p.pct]), [['five_hour', 40], ['five_hour', 50]]);
    assert.equal(r.store.get(r.ids.a).limits?.utilization, 0.5);
  } finally {
    r.close();
  }
});

test('the overview serves the account view and names the one new work starts on, as /auth does', async () => {
  const config = tempConfig();
  const core = new Core({ ...config, claudeBin: FAKE_CLAUDE });
  try {
    // The CLI's own login has no credential at all here, so it is no account
    const empty = (await core.overview()).accounts;
    assert.deepEqual([empty?.inUse, empty?.inUseReason, empty?.accounts.length, empty?.atLimit, empty?.nextReset], [null, 'signed-out', 0, false, null]);
    mkdirSync(config.configDir, { recursive: true });
    writeFileSync(join(config.configDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } }));
    const before = (await core.overview()).accounts;
    assert.equal(before?.accounts.length, 1);
    assert.equal(before?.inUse?.id, DEFAULT_ID);
    await core.accounts.add({ kind: 'token', alias: 'alpha', secret: 'tok' });
    await core.accounts.setEnabled(DEFAULT_ID, false);
    const after = (await core.overview()).accounts;
    assert.equal(after?.accounts.length, 2);
    assert.equal(after?.inUse?.label, 'alpha');
    assert.equal(after?.settings.strategy, 'least-used');
    // One view: what the status bar's /auth names is what the overview names
    assert.deepEqual((await core.system(true)).auth.inUse, after?.inUse);
  } finally {
    core.shutdown();
  }
});

// A sign-in failure (the CLI's 401) is a state of the account and moves the turn as a limit does

test('an automated run whose account sign-in expired moves to the next account, which is marked out until cleared', async () => {
  const r = await rig({ work, expired: (d) => [d[DEFAULT_ID] ?? ''] });
  try {
    const chat = r.chats.start({ prompt: 'hello', name: 'expired', keepAlive: false });
    await waitFor(() => r.chats.accountOf(chat.id) === r.ids.a && r.spawns().length === 2);
    await r.chats.exited(chat.id);
    const [event] = r.db.rotationEvents();
    assert.deepEqual([event?.event, event?.from, event?.to, event?.reason], ['switch', DEFAULT_ID, r.ids.a, 'auth']);
    assert.equal(r.events.filter((e) => e.type === 'run.rateLimited').length, 0, 'it is no limit');
    assert.ok(r.events.some((e) => e.type === 'run.accountRotated'));
    assert.equal(r.store.get(DEFAULT_ID).signInState, 'expired');
    assert.equal(r.store.get(DEFAULT_ID).signedIn, false);
    assert.equal(r.store.get(DEFAULT_ID).limits, null, 'and no limit is made up for it');

    // Excluded: a new chat does not start on it
    const next = r.chats.start({ prompt: 'again', name: 'next', keepAlive: false });
    await r.chats.exited(next.id);
    assert.equal(r.chats.accountOf(next.id), r.ids.a);

    // Until it is cleared
    await r.store.clearAuthFailed(DEFAULT_ID);
    assert.notEqual(r.store.get(DEFAULT_ID).signInState, 'expired');
    assert.equal(r.store.pick({ current: null, pinned: null, policy: r.store.policyFor(null) }).account, DEFAULT_ID);
  } finally {
    r.close();
  }
});

test("a person's chat whose account sign-in expired moves with rotateOnLimit, and stays put without it", async () => {
  const r = await rig({ expired: (d) => [d[DEFAULT_ID] ?? ''] });
  try {
    const chat = r.chats.start({ prompt: 'hello', name: 'person', keepAlive: false });
    await waitFor(() => r.chats.accountOf(chat.id) === r.ids.a && r.spawns().length === 2);
    assert.equal(r.db.rotationEvents()[0]?.reason, 'auth');
    assert.equal(r.db.providerMoves({ chatId: chat.id }).length, 0);
  } finally {
    r.close();
  }

  const off = await rig({ expired: (d) => [d[DEFAULT_ID] ?? ''] });
  try {
    await off.store.setSettings({ rotateOnLimit: false });
    const chat = off.chats.start({ prompt: 'hello', name: 'person off', keepAlive: false });
    await off.chats.exited(chat.id);
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(off.spawns().length, 1);
    assert.equal(off.chats.accountOf(chat.id), DEFAULT_ID);
    assert.equal(off.db.rotationEvents().length, 0);
    assert.equal(off.store.get(DEFAULT_ID).signInState, 'expired', 'the account is marked all the same');
  } finally {
    off.close();
  }
});

test('with every account signed out, automated work waits, and goes on once an account can take it', async () => {
  const r = await rig({ work, expired: (d) => Object.values(d) });
  try {
    const chat = r.chats.start({ prompt: 'hello', name: 'all out', keepAlive: false });
    await waitFor(() => r.db.providerMoves({ chatId: chat.id }).length > 0);
    const [move] = r.db.providerMoves({ chatId: chat.id });
    assert.equal(move?.state, 'waiting');
    assert.equal(move?.reason, 'sign-in expired');
    assert.equal(r.spawns().length, 4, 'every account was tried once before it waited');
    assert.deepEqual(r.db.rotationEvents().map((e) => [e.event, e.reason]), [['switch', 'auth'], ['switch', 'auth'], ['switch', 'auth'], ['wait', 'auth']]);

    // An account signs in again and works: the wait ends on its own
    process.env.FAKE_CLAUDE_EXPIRED_DIRS = '';
    await r.store.clearAuthFailed(r.ids.c);
    await waitFor(() => r.db.providerMove(move?.id ?? '')?.state === 'resumed');
    assert.equal(r.chats.accountOf(chat.id), r.ids.c);
  } finally {
    r.close();
  }
});

// R10 (2026-10-16): every account was out at 12:44 UTC and the waits took the earliest reset they
// knew (13:10), while the CLI's own login restarted its window around 12:50 with 0 % used. Twelve
// tasks kept waiting for a reset that was not the first way back.
const sec = (ms: number): number => Math.floor(ms / 1000);
const roomy = (at: number) => readingFromEvent({ status: 'allowed', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0, resetsAt: sec(at) + 5 * 3600 } } }, at);

test('a wait goes on with the first account a new reading gives room, not at the reset it waited for (R10)', async () => {
  // A long poll: only the new reading can end this wait before the hour is out
  const r = await rig({ work, limited: (d) => Object.values(d), resetsIn: 3600, pollMs: 3_600_000 });
  try {
    const chat = r.chats.start({ prompt: 'hello', name: 'all out', keepAlive: false });
    await waitFor(() => r.db.providerMoves({ chatId: chat.id }).some((m) => m.state === 'waiting'));
    const [move] = r.db.providerMoves({ chatId: chat.id });
    assert.ok(move?.resetsAt && Date.parse(move.resetsAt) > Date.now() + 50 * 60_000, 'every account said it is out for about an hour');
    assert.equal(r.spawns().length, 4, 'every account was tried once before it waited');

    // The CLI's own login restarts early, and its cache (or another chat's stream) says so
    process.env.FAKE_CLAUDE_LIMITED_DIRS = [r.dirs[r.ids.a], r.dirs[r.ids.b], r.dirs[r.ids.c]].join(',');
    const reading = roomy(Date.now());
    assert.ok(reading);
    await r.chats.noteAccountReading(DEFAULT_ID, reading);

    await waitFor(() => r.db.providerMove(move?.id ?? '')?.state === 'resumed');
    await waitFor(() => r.spawns().length === 5 && r.chats.get(chat.id)?.status !== 'busy' && r.chats.get(chat.id)?.status !== 'starting');
    assert.equal(r.spawns()[4]?.dir, r.dirs[DEFAULT_ID], 'the turn went on with the account that had room');
    assert.equal(r.chats.accountOf(chat.id), DEFAULT_ID);
    assert.equal(r.chats.atLimit(chat.id), false, 'and went through');
  } finally {
    r.close();
  }
});

test('a wait for a reset goes on with an account signed in again while the others are still out (R10)', async () => {
  // Alpha's sign-in expired; the CLI's own login, beta and gamma are out for an hour
  const r = await rig({ work, limited: (d) => Object.values(d).filter((_, i) => i !== 1), expired: (d) => [Object.values(d)[1] ?? ''], resetsIn: 3600, pollMs: 3_600_000 });
  try {
    const chat = r.chats.start({ prompt: 'hello', name: 'all out', keepAlive: false });
    await waitFor(() => r.db.providerMoves({ chatId: chat.id }).some((m) => m.state === 'waiting'));
    const [move] = r.db.providerMoves({ chatId: chat.id });
    assert.equal(move?.reason, null, 'the last account said it was out: a wait for a reset');
    assert.equal(r.store.get(r.ids.a).signInState, 'expired');

    process.env.FAKE_CLAUDE_EXPIRED_DIRS = '';
    const before = r.spawns().length;
    await r.store.clearAuthFailed(r.ids.a);
    await waitFor(() => r.db.providerMove(move?.id ?? '')?.state === 'resumed' && r.spawns().length > before);
    assert.equal(r.spawns().at(-1)?.dir, r.dirs[r.ids.a]);
    assert.equal(r.chats.accountOf(chat.id), r.ids.a);
  } finally {
    r.close();
  }
});

test('a reading that leaves every account out moves the wait to the earliest reset it now knows (R10)', async () => {
  const r = await rig({ work, limited: (d) => Object.values(d), resetsIn: 3600, pollMs: 3_600_000 });
  try {
    const chat = r.chats.start({ prompt: 'hello', name: 'all out', keepAlive: false });
    await waitFor(() => r.db.providerMoves({ chatId: chat.id }).some((m) => m.state === 'waiting'));
    const [move] = r.db.providerMoves({ chatId: chat.id });
    process.env.FAKE_CLAUDE_LIMITED_DIRS = '';
    // Beta's window is reported to reset in a moment: still out now, back soon
    const soon = Date.now() + 400;
    const reading = readingFromEvent({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: soon / 1000, unifiedWindows: { five_hour: { utilization: 1, resetsAt: soon / 1000 } } }, Date.now());
    assert.ok(reading);
    await r.chats.noteAccountReading(r.ids.b, reading);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(r.db.providerMove(move?.id ?? '')?.state, 'waiting', 'beta is still out');
    const before = r.spawns().length;
    await waitFor(() => r.db.providerMove(move?.id ?? '')?.state === 'resumed' && r.spawns().length > before);
    assert.equal(r.spawns().at(-1)?.dir, r.dirs[r.ids.b], 'its reset passing is a way back');
  } finally {
    r.close();
  }
});

// R11: "Stop waiting" also offers "run it now on an account with room"
test('run now sends a waiting turn on at once, on the first account the readings allow, even one it died on (R11)', async () => {
  const r = await rig({ work, limited: (d) => Object.values(d), pollMs: 3_600_000 });
  try {
    const chat = r.chats.start({ prompt: 'hello', name: 'all out', keepAlive: false });
    await waitFor(() => r.db.providerMoves({ chatId: chat.id }).some((m) => m.state === 'waiting'));
    const [move] = r.db.providerMoves({ chatId: chat.id });
    // Nothing says when any account is back (no reading came with the 429s); the person knows better
    process.env.FAKE_CLAUDE_LIMITED_DIRS = '';
    const before = r.spawns().length;
    const done = await r.rotation.runNow(move?.id ?? '');
    assert.equal(done.account, DEFAULT_ID, 'the first account in the order');
    assert.equal(done.move.state, 'resumed');
    await waitFor(() => r.spawns().length > before && r.chats.get(chat.id)?.status !== 'busy' && r.chats.get(chat.id)?.status !== 'starting');
    assert.equal(r.spawns().at(-1)?.dir, r.dirs[DEFAULT_ID]);
    assert.equal(r.chats.atLimit(chat.id), false, 'the turn went through');
    assert.deepEqual(r.db.rotationEvents().at(-1)?.reason, 'person', 'recorded as a person\'s move');
    await assert.rejects(r.rotation.runNow(move?.id ?? ''), (e: unknown) => e instanceof RunNowRefusal && e.code === 'wait-over');
  } finally {
    r.close();
  }
});

test('run now is refused while every account reads out, and the wait stays (R11)', async () => {
  const r = await rig({ work, limited: (d) => Object.values(d), resetsIn: 3600, pollMs: 3_600_000 });
  try {
    const chat = r.chats.start({ prompt: 'hello', name: 'all out', keepAlive: false });
    await waitFor(() => r.db.providerMoves({ chatId: chat.id }).some((m) => m.state === 'waiting'));
    const [move] = r.db.providerMoves({ chatId: chat.id });
    await assert.rejects(r.rotation.runNow(move?.id ?? ''), (e: unknown) => e instanceof RunNowRefusal && e.code === 'no-room' && /until/.test(e.message));
    assert.equal(r.db.providerMove(move?.id ?? '')?.state, 'waiting');
  } finally {
    r.close();
  }
});

// The regressions of 2026-10-29 (docs/reports/regression-audit-2026-10-29.md, §2 and §4.12)

test('an account a live chat runs on is not removed; one removed behind the app\'s back leaves the chat and the server going (§2.1)', async () => {
  const r = await rig();
  const gate = join(r.config.dataDir, 'go-on');
  try {
    const results: string[] = [];
    r.chats.on('chat-result', (id: string) => results.push(id));
    const chat = r.chats.start({ prompt: `FAKE-WAIT-FOR ${gate}`, name: 'live', keepAlive: false, account: r.ids.a });
    await waitFor(() => r.chats.liveChatsOn(r.ids.a).includes(chat.id));
    await assert.rejects(r.store.remove(r.ids.a), (e: unknown) => e instanceof AccountInUseError && e.statusCode === 409 && e.chats.includes(chat.id));
    assert.ok(r.store.find(r.ids.a), 'still there');
    // The terminal's claudio-accounts shares the data dir and knows of no chat: it removes the account anyway
    const terminal = new AccountStore({ dataDir: r.config.dataDir, defaultDir: r.config.configDir, claude: FAKE_CLAUDE });
    await terminal.remove(r.ids.a);
    r.store.reload();
    assert.equal(r.store.find(r.ids.a), null);
    // The turn ends well on an account that is gone: the fold looks it up and goes on (on 10-25 it threw and the server died)
    writeFileSync(gate, '');
    await r.chats.exited(chat.id);
    assert.deepEqual(results, [chat.id]);
    assert.equal(r.chats.get(chat.id)?.status, 'completed');
  } finally {
    r.close();
  }
});

test('a second limit after a wait-replay still rotates: the replay count never holds back a move (§2.2)', async () => {
  // The CLI's own login is out (its reset a few seconds away, again at every turn); alpha reads out a while longer
  const r = await rig({ work, limited: (d) => [d[DEFAULT_ID] ?? ''], resetsIn: 3 });
  try {
    await r.store.setEnabled(r.ids.b, false);
    await r.store.setEnabled(r.ids.c, false);
    // Read now, so the choice at the limit does not spend the login's reset reading them
    await r.store.warmModels();
    const at = Date.now();
    const out = readingFromEvent({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(at / 1000) + 9 }, at);
    assert.ok(out);
    await r.store.observe(r.ids.a, out);
    const chat = r.chats.start({ prompt: 'hello', name: 'twice', keepAlive: false });
    // First limit → wait → at the reset the turn is replayed on no new account → second limit → it
    // waits for alpha and goes on there. Before the fix the second limit announced nothing at all
    await waitFor(() => r.chats.accountOf(chat.id) === r.ids.a && r.chats.get(chat.id)?.status === 'completed', 30_000);
    const dirs = r.spawns().map((s) => s.dir);
    assert.ok(dirs.filter((d) => d === r.dirs[DEFAULT_ID]).length >= 2, 'the CLI\'s own login was replayed after its first wait');
    assert.equal(dirs.at(-1), r.dirs[r.ids.a]);
    assert.ok(r.db.providerMoves({ chatId: chat.id }).length >= 2, 'a wait for each limit');
  } finally {
    r.close();
  }
});

test('a chat started on default moves to an account without the model the CLI resolved it to (§2.3)', async () => {
  // Only the CLI's own login offers opus, and it is out; the CLI reports `default` as claude-opus-5-5
  const r = await rig({ work, limited: (d) => [d[DEFAULT_ID] ?? ''], lite: (d) => Object.values(d).slice(1), resolvedModel: 'claude-opus-5-5' });
  try {
    const chat = r.chats.start({ prompt: 'hello', name: 'default model', keepAlive: false, model: 'default' });
    await waitFor(() => r.chats.accountOf(chat.id) === r.ids.a && r.spawns().length === 2);
    await r.chats.exited(chat.id);
    assert.equal(r.chats.get(chat.id)?.model, 'claude-opus-5-5', 'the chat reads the resolved model');
    assert.equal(r.db.providerMoves({ chatId: chat.id }).length, 0, 'and never waited for an account that offers it');
  } finally {
    r.close();
  }
});

test('a fork keeps its source\'s account and pin (§4.12)', async () => {
  const r = await rig();
  try {
    const source = r.chats.start({ prompt: 'hello', name: 'source', keepAlive: false, account: r.ids.b });
    await r.chats.exited(source.id);
    const known = r.chats.get(source.id);
    assert.ok(known);
    const fork = r.chats.fork(source.id, { prompt: 'in a copy' }, { cwd: known.cwd, name: known.name, model: null });
    // A fork's process is held between turns: its result, not its exit, is the end of the turn
    await r.chats.waitForResult(fork.id);
    assert.equal(r.chats.accountOf(fork.id), r.ids.b);
    assert.equal(r.chats.get(fork.id)?.accountPinned, true);
    assert.equal(r.spawns().at(-1)?.dir, r.dirs[r.ids.b]);
  } finally {
    r.close();
  }
});

test('new work starts on the preferred account, a pin still wins, and settings.order drives the order strategy (§2.10)', async () => {
  const r = await rig();
  try {
    await r.store.setSettings({ preferred: r.ids.c });
    const free = r.chats.start({ prompt: 'one', name: 'free', keepAlive: false });
    const pinned = r.chats.start({ prompt: 'two', name: 'pinned', keepAlive: false, account: r.ids.b });
    await Promise.all([r.chats.exited(free.id), r.chats.exited(pinned.id)]);
    assert.equal(r.chats.accountOf(free.id), r.ids.c);
    assert.equal(r.chats.accountOf(pinned.id), r.ids.b);
    await r.store.setSettings({ preferred: null, order: [r.ids.b, r.ids.a, r.ids.c, DEFAULT_ID] });
    const ordered = r.chats.start({ prompt: 'three', name: 'ordered', keepAlive: false });
    await r.chats.exited(ordered.id);
    assert.equal(r.chats.accountOf(ordered.id), r.ids.b);
  } finally {
    r.close();
  }
});
