import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AccountStore, DEFAULT_ID, readingFromEvent } from '@claudio/accounts';
import { ChatManager } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import type { ClaudioEventInput } from '../src/events.ts';
import { ClaudeCodeDriver } from '../src/providers/claude-code/driver.ts';
import { defaultProvidersSettings, defaultRotationSettings } from '../src/providers/settings.ts';
import { ProviderRotation } from '../src/rotation.ts';
import { tempConfig } from './helpers.ts';

// A person's chat, a schedule's chat and a housekeeping chat at a limit, with rotation on and every
// account out (cases C1 to C7 of docs/plans/limit-resume-and-credits.md). Several accounts over the
// fake Claude: `FAKE_CLAUDE_LIMITED_DIRS` makes an account out, `FAKE_CLAUDE_ACCOUNTS` records spawns.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const ENV = ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'FAKE_CLAUDE_ACCOUNTS', 'FAKE_CLAUDE_LIMITED_DIRS', 'FAKE_CLAUDE_LIMIT_RESETS_IN'];

async function rig(o: { limited: 'all' | 'default'; resetsIn?: number }) {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  let live: ChatManager | null = null;
  const store = new AccountStore({ dataDir: config.dataDir, defaultDir: config.configDir, claude: FAKE_CLAUDE, liveChatsOn: (id) => live?.liveChatsOn(id) ?? [] });
  await store.setSettings({ strategy: 'order' });
  const a = await store.add({ kind: 'token', alias: 'alpha', secret: 'tok-alpha' });
  const b = await store.add({ kind: 'token', alias: 'beta', secret: 'tok-beta' });
  const dirs = [config.configDir, store.ref(a.id).dir, store.ref(b.id).dir];
  const spawns = join(config.dataDir, 'spawns.log');
  const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  process.env.CLAUDE_CONFIG_DIR = config.configDir;
  process.env.ANTHROPIC_API_KEY = 'wrapper-key';
  process.env.ANTHROPIC_AUTH_TOKEN = 'wrapper-auth';
  process.env.FAKE_CLAUDE_ACCOUNTS = spawns;
  process.env.FAKE_CLAUDE_LIMITED_DIRS = (o.limited === 'all' ? dirs : dirs.slice(0, 1)).join(',');
  process.env.FAKE_CLAUDE_LIMIT_RESETS_IN = o.resetsIn ? String(o.resetsIn) : '';
  const chats = new ChatManager(config, db, [new ClaudeCodeDriver(FAKE_CLAUDE)]);
  chats.accounts = store;
  live = chats;
  const settings = defaultProvidersSettings(['claude-code']);
  settings.rotation = defaultRotationSettings();
  const events: ClaudioEventInput[] = [];
  const rotation = new ProviderRotation({
    db,
    runtime: chats,
    settings: () => settings,
    projectProviders: () => null,
    projectOf: () => null,
    emit: (event) => events.push(event),
    accountsChanged: (listener) => store.onChange(listener),
    // Long: only a reading or the reset itself may end a wait in these tests
    pollMs: 3_600_000,
    slackMs: 0,
  });
  rotation.start();
  return {
    db,
    store,
    chats,
    rotation,
    events,
    dirs,
    spawns: (): number => (existsSync(spawns) ? readFileSync(spawns, 'utf8').trim().split('\n').length : 0),
    close: () => {
      void rotation.close();
      chats.stopAll();
      db.close();
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}

const waitFor = async (check: () => boolean, ms = 30_000): Promise<void> => {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 15));
  }
};

const sec = (ms: number): number => Math.floor(ms / 1000);
const roomy = (at: number) => readingFromEvent({ status: 'allowed', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0, resetsAt: sec(at) + 5 * 3600 } } }, at);

test("a person's chat with rotation on waits for the reset when every account is out, and goes on by itself", async () => {
  const r = await rig({ limited: 'all', resetsIn: 3600 });
  try {
    const chat = r.chats.start({ prompt: 'hello', name: 'asks', keepAlive: false });
    await waitFor(() => r.db.providerMoves({ chatId: chat.id }).some((m) => m.state === 'waiting'));
    const [move] = r.db.providerMoves({ chatId: chat.id });
    assert.equal(move?.decidedBy, 'setting');
    assert.equal(move?.subjectKind, 'chat');
    assert.ok(move?.resetsAt && Date.parse(move.resetsAt) > Date.now() + 50 * 60_000, 'every account said it is out for about an hour');
    assert.equal(r.rotation.holds(chat.id), true);
    assert.equal(r.events.filter((e) => e.type === 'run.limitWaiting').length, 1);

    // The CLI's own login is back, and a reading says so: nobody clicked anything
    process.env.FAKE_CLAUDE_LIMITED_DIRS = r.dirs.slice(1).join(',');
    const reading = roomy(Math.max(Date.now(), Date.parse(move?.at ?? '') + 1));
    assert.ok(reading);
    await r.chats.noteAccountReading(DEFAULT_ID, reading);
    await waitFor(() => r.db.providerMove(move?.id ?? '')?.state === 'resumed');
    await waitFor(() => r.chats.get(chat.id)?.status !== 'busy' && r.chats.get(chat.id)?.status !== 'starting');
    assert.equal(r.chats.accountOf(chat.id), DEFAULT_ID);
    assert.equal(r.chats.atLimit(chat.id), false, 'and the turn went through');
  } finally {
    r.close();
  }
});

test("a schedule's chat, which is an ordinary chat, waits for the reset like a person's", async () => {
  const r = await rig({ limited: 'all', resetsIn: 3600 });
  try {
    // What a schedule starts: a chat of the project with no run, task or item tied to it
    const chat = r.chats.start({ prompt: 'nightly review', name: 'Nightly review', keepAlive: false });
    await waitFor(() => r.db.providerMoves({ chatId: chat.id }).some((m) => m.state === 'waiting'));
    assert.equal(r.rotation.holds(chat.id), true);
  } finally {
    r.close();
  }
});

test("a person's chat with rotation off keeps its banner and nothing waits", async () => {
  const r = await rig({ limited: 'all', resetsIn: 3600 });
  try {
    await r.store.setSettings({ rotateOnLimit: false });
    const chat = r.chats.start({ prompt: 'hello', name: 'asks', keepAlive: false });
    await r.chats.exited(chat.id);
    await waitFor(() => r.events.some((e) => e.type === 'run.rateLimited'));
    await new Promise((res) => setTimeout(res, 150));
    assert.equal(r.db.providerMoves({ chatId: chat.id }).length, 0);
  } finally {
    r.close();
  }
});

test("a housekeeping chat at a limit is not resumed on another account and waits for nothing", async () => {
  // The CLI's own login is out and the others have room: a person's chat would move there
  const r = await rig({ limited: 'default' });
  try {
    const chat = r.chats.start({ prompt: 'housekeeping', name: 'Supervisor', keepAlive: false, internal: true });
    await r.chats.exited(chat.id);
    await waitFor(() => r.events.some((e) => e.type === 'run.rateLimited'));
    await new Promise((res) => setTimeout(res, 200));
    assert.equal(r.spawns(), 1, 'no replay was started on any account');
    assert.equal(r.db.providerMoves({ chatId: chat.id }).length, 0);
    assert.equal(r.db.rotationEvents().length, 0);
    assert.equal(r.rotation.holds(chat.id), false);
  } finally {
    r.close();
  }
});

test("a person's wait that ended because they wrote does not stop the next limit from waiting", async () => {
  const r = await rig({ limited: 'all', resetsIn: 3600 });
  try {
    const chat = r.chats.start({ prompt: 'hello', name: 'asks', keepAlive: false });
    await waitFor(() => r.db.providerMoves({ chatId: chat.id }).some((m) => m.state === 'waiting'));
    const [first] = r.db.providerMoves({ chatId: chat.id });
    // The person writes while every account is still out: that turn dies at the limit too
    r.chats.send(chat.id, 'try this instead');
    await waitFor(() => r.db.providerMove(first?.id ?? '')?.state === 'cancelled');
    await waitFor(() => r.db.providerMoves({ chatId: chat.id }).some((m) => m.state === 'waiting'));
    const open = r.db.providerMoves({ chatId: chat.id }).filter((m) => m.state === 'waiting');
    assert.equal(open.length, 1);
    assert.notEqual(open[0]?.id, first?.id);
  } finally {
    r.close();
  }
});
