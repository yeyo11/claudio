import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AccountStore, DEFAULT_ID, readingFromEvent } from '@claudio/accounts';
import type { ChatWork } from '../src/chat-service.ts';
import { ChatManager } from '../src/chats.ts';
import { Core } from '../src/index.ts';
import { Db } from '../src/db.ts';
import { EventBus, type ClaudioEventInput } from '../src/events.ts';
import { ClaudeCodeDriver } from '../src/providers/claude-code/driver.ts';
import { defaultProvidersSettings, defaultRotationSettings } from '../src/providers/settings.ts';
import { ProviderRotation } from '../src/rotation.ts';
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

async function rig(opts: { work?: ChatWork | null; limited?: (ids: Record<string, string>) => string[]; lite?: (ids: Record<string, string>) => string[] } = {}) {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const store = new AccountStore({ dataDir: config.dataDir, defaultDir: config.configDir, claude: FAKE_CLAUDE });
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
  set('FAKE_CLAUDE_LITE_DIRS', (opts.lite?.(dirs) ?? []).join(','));
  const chats = new ChatManager(config, db, [new ClaudeCodeDriver(FAKE_CLAUDE)]);
  chats.accounts = store;
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
    pollMs: 20,
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
    assert.equal(r.store.get(DEFAULT_ID).limits?.state, 'exhausted', 'the account that hit the limit is out');
  } finally {
    r.close();
  }
});

test('with no account left, automated work waits for the earliest reset', async () => {
  const r = await rig({ work, limited: (d) => Object.values(d) });
  try {
    const chat = r.chats.start({ prompt: 'hello', name: 'stuck', keepAlive: false });
    await waitFor(() => r.db.providerMoves({ chatId: chat.id }).length > 0);
    const [move] = r.db.providerMoves({ chatId: chat.id });
    assert.equal(move?.state, 'waiting');
    assert.equal(move?.action, 'wait');
    assert.ok(move?.resetsAt && Date.parse(move.resetsAt) > Date.now(), 'the accounts say when the first is back');
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

test('the overview counts the accounts and names the one new work starts on', async () => {
  const config = tempConfig();
  const core = new Core({ ...config, claudeBin: FAKE_CLAUDE });
  try {
    const before = (await core.overview()).accounts;
    assert.deepEqual(before, { total: 1, ready: 1, current: DEFAULT_ID });
    await core.accounts.add({ kind: 'token', alias: 'alpha', secret: 'tok' });
    await core.accounts.setEnabled(DEFAULT_ID, false);
    const after = (await core.overview()).accounts;
    assert.equal(after?.total, 2);
    assert.equal(after?.ready, 1);
    assert.notEqual(after?.current, DEFAULT_ID);
  } finally {
    core.shutdown();
  }
});
