import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { AccountStore, DEFAULT_ID, readingFromEvent, type Choice } from '@claudio/accounts';
import type { ChatWork } from '../src/chat-service.ts';
import { AccountSwitchRefusal, ChatManager } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import { EventBus, type ClaudioEventInput } from '../src/events.ts';
import { ClaudeCodeDriver } from '../src/providers/claude-code/driver.ts';
import { defaultProvidersSettings, defaultRotationSettings } from '../src/providers/settings.ts';
import { openWaitOf, ProviderRotation } from '../src/rotation.ts';
import { tempConfig } from './helpers.ts';

// Project rules at work (T7 of docs/plans/account-configuration-and-project-rules.md): the reserves
// that work in progress activates, the rule's account moves at the end of a turn (D9), the person's
// one turn outside a rule (D8), no room told by origin, and no rule meaning today's behaviour.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const VARIABLES = ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'FAKE_CLAUDE_ACCOUNTS', 'FAKE_CLAUDE_LIMITED_DIRS', 'FAKE_CLAUDE_LITE_DIRS'];

interface Spawn {
  dir: string | null;
}

async function rig(opts: { work?: ChatWork | null } = {}) {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const store = new AccountStore({ dataDir: config.dataDir, defaultDir: config.configDir, claude: FAKE_CLAUDE });
  await store.setSettings({ strategy: 'order' });
  const a = await store.add({ kind: 'token', alias: 'alpha', secret: 'tok-alpha' });
  const b = await store.add({ kind: 'api-key', alias: 'beta', secret: 'key-beta' });
  const dirs: Record<string, string> = { [DEFAULT_ID]: config.configDir, [a.id]: store.ref(a.id).dir, [b.id]: store.ref(b.id).dir };
  const spawns = join(config.dataDir, 'spawns.log');
  const saved: Record<string, string | undefined> = {};
  for (const name of VARIABLES) saved[name] = process.env[name];
  process.env.CLAUDE_CONFIG_DIR = config.configDir;
  process.env.ANTHROPIC_API_KEY = 'wrapper-key';
  process.env.ANTHROPIC_AUTH_TOKEN = 'wrapper-auth';
  process.env.FAKE_CLAUDE_ACCOUNTS = spawns;
  process.env.FAKE_CLAUDE_LIMITED_DIRS = '';
  process.env.FAKE_CLAUDE_LITE_DIRS = '';
  const chats = new ChatManager(config, db, [new ClaudeCodeDriver(FAKE_CLAUDE)]);
  chats.accounts = store;
  // Two project folders; anything else is a chat of no project
  const p1 = join(config.dataDir, 'p1');
  const p2 = join(config.dataDir, 'p2');
  mkdirSync(p1, { recursive: true });
  mkdirSync(p2, { recursive: true });
  chats.projectOf = (dir) => (dir.startsWith(p1) ? 'p1' : dir.startsWith(p2) ? 'p2' : null);
  const events: ClaudioEventInput[] = [];
  const bus = new EventBus();
  bus.subscribe((event) => events.push(event));
  chats.bus = bus;
  const settings = defaultProvidersSettings(['claude-code']);
  settings.rotation = defaultRotationSettings();
  const rotation = new ProviderRotation({
    db,
    runtime: chats,
    settings: () => settings,
    projectProviders: () => null,
    projectOf: (dir) => chats.projectOf?.(dir) ?? null,
    emit: (event) => events.push(event),
    ...(opts.work ? { work: () => opts.work ?? null } : {}),
    accountsChanged: (listener) => store.onChange(listener),
    pollMs: 20,
    slackMs: 0,
    now: () => Date.now(),
  });
  rotation.start();
  return {
    db,
    store,
    chats,
    rotation,
    events,
    ids: { a: a.id, b: b.id },
    dirs,
    p1,
    p2,
    held: `FAKE-WAIT-FOR ${join(config.dataDir, 'release-turn')}`,
    release: () => writeFileSync(join(config.dataDir, 'release-turn'), ''),
    spawns: (): Spawn[] => (existsSync(spawns) ? readFileSync(spawns, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Spawn) : []),
    close: () => {
      rotation.close();
      chats.stopAll();
      db.close();
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}

type Rig = Awaited<ReturnType<typeof rig>>;

// Each check waits for something the fake CLI does; the budget only bounds how long a failure takes to report
const waitFor = async (check: () => boolean, ms = 30_000, seen?: () => unknown): Promise<void> => {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() > end) throw new Error(`timed out waiting${seen ? `; saw ${JSON.stringify(seen())}` : ''}`);
    await new Promise((r) => setTimeout(r, 15));
  }
};

const work: ChatWork = { subjectKind: 'flow_run', subjectId: 'run-1' };

/** A finished first turn, its process left up or not. */
async function idleChat(r: Rig, opts: { keepAlive: boolean; cwd?: string; name?: string }) {
  const chat = r.chats.start({ prompt: 'hello', name: opts.name ?? 'ruled', keepAlive: opts.keepAlive, cwd: opts.cwd ?? r.p1 });
  await r.chats.waitForResult(chat.id);
  await waitFor(() => (opts.keepAlive ? r.chats.get(chat.id)?.status === 'idle' : !r.chats.get(chat.id)?.pid));
  return chat;
}

async function reading(r: Rig, account: string, utilization: number): Promise<void> {
  const at = Date.now();
  const resetsAt = Math.floor(at / 1000) + 3600;
  const status = utilization >= 1 ? 'rejected' : 'allowed';
  const read = readingFromEvent({ status, rateLimitType: 'five_hour', resetsAt, utilization, unifiedWindows: { five_hour: { utilization, resetsAt } } }, at);
  assert.ok(read);
  await r.chats.noteAccountReading(account, read);
}

const rotationOf = (r: Rig, chatId: string) => r.db.rotationEvents().filter((e) => e.data?.chatId === chatId);

test('with no rule, every choice is the one made before rules: no reserve, no work in progress read, and nothing moved', async (t: TestContext) => {
  const r = await rig();
  try {
    let asked = 0;
    r.chats.activity.add(() => (asked++, [r.p1]));
    const calls: Array<{ opts: Parameters<AccountStore['pick']>[0]; choice: Choice }> = [];
    const pick = r.store.pick.bind(r.store);
    t.mock.method(r.store, 'pick', (o: Parameters<AccountStore['pick']>[0]) => {
      const choice = pick(o);
      calls.push({ opts: o, choice });
      return choice;
    });
    const chat = await idleChat(r, { keepAlive: false });
    r.chats.chooseNext(chat.id);
    r.chats.roomFor(chat.id, null);
    r.chats.enforceRules();
    assert.equal(r.chats.noRoomUnderRule(r.p1), null);
    assert.ok(calls.length >= 3);
    assert.equal(asked, 0, 'no source of work in progress is asked while no rule reserves');
    for (const { opts, choice } of calls) {
      assert.equal(opts?.reserved, undefined, 'no reserve is passed');
      // The call as it was before rules: the same account, reason, wait and explanation
      const { project: _project, ...before } = opts ?? { current: null };
      assert.deepEqual(choice, pick(before));
    }
    assert.equal(r.chats.accountOf(chat.id), DEFAULT_ID);
    assert.deepEqual(r.db.rotationEvents(), [], 'no move was made');
  } finally {
    r.close();
  }
});

test("another project's work in progress keeps headroom on its rule's account: other work leaves it early, and gets it back when that work ends", async () => {
  const r = await rig();
  try {
    await r.store.createPolicy({ projects: ['p1'], order: [r.ids.a, r.ids.b], preferred: r.ids.a, reserve: { percent: 30 } });
    await reading(r, r.ids.a, 0.7);
    const other = await idleChat(r, { keepAlive: false, cwd: r.p2, name: 'other project' });
    await r.chats.switchAccount(other.id, r.ids.a, 'person');
    assert.deepEqual(r.chats.activity.reserves(r.store.policies()), [], 'p1 has no work yet');
    assert.equal(r.chats.chooseNext(other.id)?.account, r.ids.a, 'at 70 % alpha is under the threshold of 90');

    const busy = r.chats.start({ prompt: r.held, name: 'p1 at work', keepAlive: false, cwd: r.p1 });
    await waitFor(() => r.chats.get(busy.id)?.status === 'busy');
    assert.deepEqual(r.chats.activity.reserves(r.store.policies()), [{ project: 'p1', account: r.ids.a, percent: 30 }]);
    const reserved = r.chats.chooseNext(other.id);
    assert.notEqual(reserved?.account, r.ids.a, 'over 60 % alpha is kept for p1');
    assert.equal(reserved?.reason, 'reserve');
    assert.ok(reserved?.why.passedOver?.some((p) => p.account === r.ids.a && p.because === 'reserved' && p.project === 'p1'));

    r.release();
    await r.chats.waitForResult(busy.id);
    await waitFor(() => r.chats.get(busy.id)?.status !== 'busy');
    assert.equal(r.chats.chooseNext(other.id)?.account, r.ids.a, 'the reserve ends with the work');
  } finally {
    r.close();
  }
});

test("a rule set under an idle chat with a live process moves it between turns, recorded as the rule's", async () => {
  const r = await rig();
  try {
    const chat = await idleChat(r, { keepAlive: true });
    assert.equal(r.chats.accountOf(chat.id), DEFAULT_ID);
    await r.store.createPolicy({ projects: ['p1'], order: [r.ids.a] });
    r.chats.enforceRules();
    await waitFor(() => r.chats.accountOf(chat.id) === r.ids.a);
    const [event] = rotationOf(r, chat.id);
    assert.deepEqual([event?.event, event?.from, event?.to, event?.reason], ['switch', DEFAULT_ID, r.ids.a, 'rule']);
    assert.equal(event?.data?.project, 'p1');
    assert.ok(r.chats.events(chat.id).some((e) => e.kind === 'notice' && /rule of this chat's project does not allow/.test(e.text ?? '')));
    // The same rules seen again change nothing
    r.chats.enforceRules();
    assert.equal(rotationOf(r, chat.id).length, 1);
  } finally {
    r.close();
  }
});

test('a rule set under a working chat never interrupts its turn: the chat moves when the turn ends', async () => {
  const r = await rig();
  try {
    const chat = r.chats.start({ prompt: r.held, name: 'working', keepAlive: true, cwd: r.p1 });
    await waitFor(() => r.chats.get(chat.id)?.status === 'busy');
    await r.store.createPolicy({ projects: ['p1'], order: [r.ids.b] });
    r.chats.enforceRules();
    assert.equal(r.chats.get(chat.id)?.pendingAccount, r.ids.b, 'the move waits for the turn');
    assert.equal(r.chats.accountOf(chat.id), DEFAULT_ID);
    assert.equal(r.chats.get(chat.id)?.status, 'busy', 'the turn goes on');
    r.release();
    await waitFor(() => r.chats.accountOf(chat.id) === r.ids.b);
    assert.deepEqual(rotationOf(r, chat.id).map((e) => e.reason), ['rule']);
  } finally {
    r.close();
  }
});

test("a chat with no process whose account the rule no longer allows starts its next turn on an allowed one, with reason rule", async () => {
  const r = await rig();
  try {
    const chat = await idleChat(r, { keepAlive: false });
    await r.store.createPolicy({ projects: ['p1'], order: [r.ids.a] });
    r.chats.sendMessage(chat.id, 'again');
    await waitFor(() => r.spawns().length === 2);
    assert.equal(r.spawns()[1]?.dir, r.dirs[r.ids.a]);
    assert.ok(r.events.some((e) => e.type === 'account.switched' && e.reason === 'rule'));
  } finally {
    r.close();
  }
});

test('a person may use an account outside the rule once: one turn runs there, then the rule takes the chat back', async () => {
  const r = await rig();
  try {
    await r.store.createPolicy({ projects: ['p1'], order: [r.ids.a] });
    const chat = await idleChat(r, { keepAlive: false });
    assert.equal(r.chats.accountOf(chat.id), r.ids.a);
    await assert.rejects(r.chats.switchAccount(chat.id, r.ids.b, 'person'), (e: unknown) => e instanceof AccountSwitchRefusal && e.code === 'not-allowed');
    const done = await r.chats.switchAccount(chat.id, r.ids.b, 'person', { once: true });
    assert.equal(done.chat.account, r.ids.b);
    const [once] = rotationOf(r, chat.id);
    assert.deepEqual([once?.reason, once?.data?.once, once?.data?.project], ['person', true, 'p1']);

    r.chats.sendMessage(chat.id, 'one turn there');
    await waitFor(() => r.spawns().length === 2);
    assert.equal(r.spawns()[1]?.dir, r.dirs[r.ids.b], 'the turn ran where the person put it');
    await waitFor(() => r.chats.accountOf(chat.id) === r.ids.a, 30_000, () => rotationOf(r, chat.id));
    assert.deepEqual(rotationOf(r, chat.id).map((e) => e.reason), ['person', 'rule']);
  } finally {
    r.close();
  }
});

test("automated work whose rule's accounts are all out waits, and the wait names the rule, as data a page can say in its words", async () => {
  const r = await rig({ work });
  try {
    process.env.FAKE_CLAUDE_LIMITED_DIRS = r.dirs[r.ids.a] ?? '';
    await r.store.createPolicy({ projects: ['p1'], order: [r.ids.a] });
    const chat = r.chats.start({ prompt: 'hello', name: 'task', keepAlive: false, cwd: r.p1 });
    await waitFor(() => r.db.providerMoves({ chatId: chat.id }).length > 0);
    const [move] = r.db.providerMoves({ chatId: chat.id });
    assert.equal(move?.state, 'waiting');
    assert.match(move?.reason ?? '', /^waiting: no account allowed on project p1 has room/);
    assert.deepEqual(r.spawns().map((s) => s.dir), [r.dirs[r.ids.a]], 'no account outside the rule was tried');
    const wait = r.db.rotationEvents().find((e) => e.event === 'wait');
    assert.match(String(wait?.data?.rule ?? ''), /no account allowed on project p1/);
    assert.equal(wait?.data?.project, 'p1');
    // The project by its id, the reset and what is left: an automated run only waits
    assert.equal(move?.rule?.project, 'p1');
    assert.deepEqual(move?.rule?.choices, ['wait']);
    assert.equal(move?.rule?.resetsAt, move?.resetsAt);
    // The row keeps it, and the wait the work shows carries it
    assert.deepEqual(r.db.providerMove(move?.id ?? '')?.rule, move?.rule);
    assert.deepEqual(openWaitOf(r.db, chat.id)?.rule, move?.rule);
  } finally {
    r.close();
  }
});

test("a person's chat at its limit under a rule is told the rule and what is left to them", async (t: TestContext) => {
  const r = await rig();
  try {
    process.env.FAKE_CLAUDE_LIMITED_DIRS = r.dirs[r.ids.a] ?? '';
    await r.store.setSettings({ rotateOnLimit: false });
    await r.store.createPolicy({ projects: ['p1'], order: [r.ids.a] });
    const decided = t.mock.method(r.rotation, 'onLimitHit');
    const chat = r.chats.start({ prompt: 'hello', name: 'asks', keepAlive: false, cwd: r.p1 });
    await r.chats.exited(chat.id);
    await waitFor(() => decided.mock.callCount() > 0);
    await Promise.all(decided.mock.calls.map((call) => call.result));
    const told = r.chats.events(chat.id).find((e) => e.kind === 'notice' && /no account allowed on project p1 has room/.test(e.text ?? ''));
    assert.match(told?.text ?? '', /use another account once/);
    // The page says it from the data: the project, by id, and the two ways a person has
    assert.equal(told?.kind === 'notice' ? told.data?.reason : null, 'no-room');
    const rule = (told?.kind === 'notice' ? told.data?.rule : null) as { project: string | null; choices: string[] } | null;
    assert.equal(rule?.project, 'p1');
    assert.deepEqual(rule?.choices, ['wait', 'once']);
    assert.equal(r.db.providerMoves({ chatId: chat.id }).length, 0, 'it still waits for the person');
  } finally {
    r.close();
  }
});

test('a schedule is told to skip only when the rule left no allowed account with room', async () => {
  const r = await rig();
  try {
    await r.store.createPolicy({ projects: ['p1'], order: [r.ids.a] });
    assert.equal(r.chats.noRoomUnderRule(r.p1), null, 'alpha has room');
    await reading(r, r.ids.a, 1);
    assert.match(r.chats.noRoomUnderRule(r.p1) ?? '', /^no account allowed on project p1 has room until /);
    assert.equal(r.chats.noRoomUnderRule(r.p2), null, 'a project with no rule is not held');
  } finally {
    r.close();
  }
});

test("a chat serves why it runs on its account, with a pin the project's rule ignores named apart", async () => {
  const r = await rig();
  try {
    // Pinned to beta before any rule existed: the pin stays on the chat, and a later rule forbids it
    const chat = r.chats.start({ prompt: 'hello', name: 'pinned', keepAlive: false, cwd: r.p1, account: r.ids.b });
    await r.chats.waitForResult(chat.id);
    await waitFor(() => !r.chats.get(chat.id)?.pid);
    assert.equal(r.chats.get(chat.id)?.accountWhy?.basis, 'pin');
    await r.store.createPolicy({ projects: ['p1'], order: [r.ids.a] });
    r.chats.sendMessage(chat.id, 'again');
    await waitFor(() => r.spawns().length === 2);
    const why = r.chats.get(chat.id)?.accountWhy;
    assert.equal(r.chats.accountOf(chat.id), r.ids.a);
    assert.equal(why?.pinIgnored, r.ids.b, 'the pin the rule ignores is named');
    assert.ok(why?.passedOver?.some((p) => p.account === r.ids.b && p.because === 'not-allowed'));
  } finally {
    r.close();
  }
});

test("the rotation's own move at a limit says from which account to which, so the page can tell a crossing of configurations", async () => {
  const r = await rig({ work });
  try {
    process.env.FAKE_CLAUDE_LIMITED_DIRS = r.dirs[r.ids.a] ?? '';
    // The rule only fixes the order, alpha then beta, so the move is from one to the other
    await r.store.createPolicy({ projects: ['p1'], order: [r.ids.a, r.ids.b] });
    const chat = r.chats.start({ prompt: 'hello', name: 'task', keepAlive: false, cwd: r.p1 });
    await waitFor(() => r.spawns().length >= 2, 30_000, () => r.spawns());
    const moved = r.chats.events(chat.id).find((e) => e.kind === 'notice' && e.data?.reason === 'rotation');
    assert.ok(moved && moved.kind === 'notice', 'the move is told with its data');
    assert.deepEqual([moved.data?.from, moved.data?.account, moved.data?.cause], [r.ids.a, r.ids.b, 'limit']);
    await waitFor(() => r.chats.accountOf(chat.id) === r.ids.b);
    assert.ok(r.chats.get(chat.id)?.accountWhy, 'the account it moved to carries the choice that took it');
  } finally {
    r.close();
  }
});
