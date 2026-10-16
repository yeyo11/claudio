import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AccountStore, CREDENTIALS_FILE, DEFAULT_ID, readingFromEvent } from '@claudio/accounts';
import { AccountSwitchRefusal, ChatManager } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import { EventBus, type ClaudioEventInput } from '../src/events.ts';
import { ClaudeCodeDriver } from '../src/providers/claude-code/driver.ts';
import { tempConfig } from './helpers.ts';

// Switching a chat's account on demand: at once when the chat is idle, queued while a turn runs, and
// the next execution carries the new account's variables and none of the old one's.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const ACCOUNT_VARIABLES = ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

interface Spawn {
  dir: string | null;
  oauth: string | null;
  apiKey: string | null;
  authToken: string | null;
}

async function rig(opts: { lite?: (ids: Record<string, string>) => string[] } = {}) {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const store = new AccountStore({ dataDir: config.dataDir, defaultDir: config.configDir, claude: FAKE_CLAUDE });
  await store.setSettings({ strategy: 'order' });
  const a = await store.add({ kind: 'token', alias: 'alpha', secret: 'tok-alpha' });
  const b = await store.add({ kind: 'api-key', alias: 'beta', secret: 'key-beta' });
  const dirs = { [DEFAULT_ID]: config.configDir, [a.id]: store.ref(a.id).dir, [b.id]: store.ref(b.id).dir };
  const spawns = join(config.dataDir, 'spawns.log');
  const saved: Record<string, string | undefined> = {};
  for (const name of ACCOUNT_VARIABLES) saved[name] = process.env[name];
  // The wrapper itself runs with credentials of its own: no process of an account may carry them
  process.env.CLAUDE_CONFIG_DIR = config.configDir;
  process.env.ANTHROPIC_API_KEY = 'wrapper-key';
  process.env.ANTHROPIC_AUTH_TOKEN = 'wrapper-auth';
  process.env.FAKE_CLAUDE_ACCOUNTS = spawns;
  process.env.FAKE_CLAUDE_LITE_DIRS = (opts.lite?.(dirs) ?? []).join(',');
  const chats = new ChatManager(config, db, [new ClaudeCodeDriver(FAKE_CLAUDE)]);
  chats.accounts = store;
  const events: ClaudioEventInput[] = [];
  const bus = new EventBus();
  bus.subscribe((event) => events.push(event));
  chats.bus = bus;
  return {
    db,
    store,
    chats,
    events,
    ids: { a: a.id, b: b.id },
    dirs,
    spawns: (): Spawn[] => (existsSync(spawns) ? readFileSync(spawns, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Spawn) : []),
    close: () => {
      chats.stopAll();
      db.close();
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      delete process.env.FAKE_CLAUDE_ACCOUNTS;
      delete process.env.FAKE_CLAUDE_LITE_DIRS;
    },
  };
}

type Rig = Awaited<ReturnType<typeof rig>>;

const waitFor = async (check: () => boolean, ms = 8000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 15));
  }
};

const refusal = (code: string) => (e: unknown) => e instanceof AccountSwitchRefusal && e.code === code;

/** A finished first turn on the CLI's own login, the process left up (or not). */
async function idleChat(r: Rig, opts: { keepAlive: boolean; prompt?: string; model?: string; account?: string }) {
  const chat = r.chats.start({ prompt: opts.prompt ?? 'hello', name: 'switch', keepAlive: opts.keepAlive, ...(opts.model ? { model: opts.model } : {}), ...(opts.account ? { account: opts.account } : {}) });
  await r.chats.waitForResult(chat.id);
  await waitFor(() => (opts.keepAlive ? r.chats.get(chat.id)?.status === 'idle' : !r.chats.get(chat.id)?.pid));
  return chat;
}

test('an idle chat with no process moves at once, and its next message runs on the new account only', async () => {
  const r = await rig();
  try {
    const chat = await idleChat(r, { keepAlive: false });
    const done = await r.chats.switchAccount(chat.id, r.ids.a, 'person');
    assert.equal(done.pending, false);
    assert.equal(done.chat.account, r.ids.a);
    assert.equal(r.chats.accountOf(chat.id), r.ids.a);

    r.chats.sendMessage(chat.id, 'again');
    await waitFor(() => r.spawns().length === 2);
    await r.chats.waitForResult(chat.id).catch(() => undefined);
    const [first, second] = r.spawns();
    assert.equal(first?.dir, r.dirs[DEFAULT_ID]);
    assert.equal(second?.dir, r.dirs[r.ids.a], 'the second process runs under the chosen account\'s config dir');
    assert.equal(second?.oauth, 'tok-alpha');
    assert.equal(second?.apiKey, null, 'and carries none of the wrapper\'s or another account\'s credentials');
    assert.equal(second?.authToken, null);
    assert.deepEqual((r.chats.get(chat.id)?.executions ?? []).map((e) => e.account), [DEFAULT_ID, r.ids.a]);

    const [event, ...rest] = r.db.rotationEvents();
    assert.equal(rest.length, 0, 'the account is announced once: spawning does not record the move again');
    assert.deepEqual([event?.event, event?.from, event?.to, event?.reason], ['switch', DEFAULT_ID, r.ids.a, 'person']);
    assert.equal(event?.data?.chatId, chat.id);
    assert.equal(event?.data?.actor, 'person');
    assert.equal(r.events.filter((e) => e.type === 'account.switched').length, 1);
    assert.ok(r.events.some((e) => e.type === 'account.switched' && e.reason === 'person'));
  } finally {
    r.close();
  }
});

test('an idle chat with a live process has it ended between turns, and the next message resumes on the new account', async () => {
  const r = await rig();
  try {
    const chat = await idleChat(r, { keepAlive: true });
    assert.ok(r.chats.get(chat.id)?.pid, 'the process is up');
    const done = await r.chats.switchAccount(chat.id, r.ids.b, 'person');
    assert.equal(done.pending, false);
    assert.equal(r.chats.get(chat.id)?.pid, null, 'the live process was ended');

    r.chats.sendMessage(chat.id, 'again');
    await waitFor(() => r.spawns().length === 2);
    const second = r.spawns()[1];
    assert.equal(second?.dir, r.dirs[r.ids.b]);
    assert.equal(second?.apiKey, 'key-beta');
    assert.equal(second?.oauth, null, 'no variable of the old account is left in the environment');
  } finally {
    r.close();
  }
});

test('a working chat queues the switch, applies it when the result arrives, and the next message runs on it', async () => {
  const r = await rig();
  try {
    const chat = r.chats.start({ prompt: 'FAKE-SLEEP 600', name: 'busy', keepAlive: true });
    await waitFor(() => r.chats.get(chat.id)?.status === 'busy');
    const queued = await r.chats.switchAccount(chat.id, r.ids.a, 'person');
    assert.equal(queued.pending, true);
    assert.equal(queued.chat.pendingAccount, r.ids.a);
    assert.equal(r.chats.accountOf(chat.id), DEFAULT_ID, 'the turn goes on where it is');
    assert.equal(r.db.rotationEvents().length, 0, 'nothing is recorded until it applies');

    await r.chats.waitForResult(chat.id);
    await waitFor(() => r.chats.accountOf(chat.id) === r.ids.a && !r.chats.get(chat.id)?.pendingAccount);
    assert.equal(r.spawns().length, 1, 'the turn was never interrupted or replayed');
    assert.deepEqual(r.db.rotationEvents().map((e) => [e.event, e.to, e.reason]), [['switch', r.ids.a, 'person']]);

    await waitFor(() => !r.chats.get(chat.id)?.pid);
    r.chats.sendMessage(chat.id, 'next');
    await waitFor(() => r.spawns().length === 2);
    assert.equal(r.spawns()[1]?.dir, r.dirs[r.ids.a]);
    assert.equal(r.spawns()[1]?.oauth, 'tok-alpha');
  } finally {
    r.close();
  }
});

test('a pending switch is cancelled by naming the current account, and a second request for it changes nothing', async () => {
  const r = await rig();
  try {
    const chat = r.chats.start({ prompt: 'FAKE-SLEEP 500', name: 'busy', keepAlive: false });
    await waitFor(() => r.chats.get(chat.id)?.status === 'busy');
    await r.chats.switchAccount(chat.id, r.ids.a, 'person');
    const again = await r.chats.switchAccount(chat.id, r.ids.a, 'person');
    assert.equal(again.pending, true);

    const cancelled = await r.chats.switchAccount(chat.id, DEFAULT_ID, 'person');
    assert.equal(cancelled.pending, false);
    assert.equal(cancelled.chat.pendingAccount, undefined);

    await r.chats.waitForResult(chat.id);
    await r.chats.exited(chat.id);
    assert.equal(r.chats.accountOf(chat.id), DEFAULT_ID);
    assert.equal(r.db.rotationEvents().length, 0);
    await assert.rejects(r.chats.switchAccount(chat.id, DEFAULT_ID, 'person'), refusal('same-account'));
  } finally {
    r.close();
  }
});

test('a switch still pending when the next process starts applies to it', async () => {
  const r = await rig();
  try {
    const chat = r.chats.start({ prompt: 'FAKE-SLEEP 300', name: 'busy', keepAlive: false });
    await waitFor(() => r.chats.get(chat.id)?.status === 'busy');
    await r.chats.switchAccount(chat.id, r.ids.b, 'person');
    await r.chats.exited(chat.id);
    r.chats.sendMessage(chat.id, 'next');
    await waitFor(() => r.spawns().length === 2);
    assert.equal(r.spawns()[1]?.dir, r.dirs[r.ids.b]);
    assert.equal(r.chats.accountOf(chat.id), r.ids.b);
  } finally {
    r.close();
  }
});

test('a chat started on an account keeps a pin, now on the account it was switched to', async () => {
  const r = await rig();
  try {
    const chat = await idleChat(r, { keepAlive: false, account: r.ids.a });
    assert.equal(r.chats.get(chat.id)?.accountPinned, true);
    await r.chats.switchAccount(chat.id, r.ids.b, 'person');
    assert.equal(r.chats.get(chat.id)?.accountPinned, true);
    r.chats.sendMessage(chat.id, 'again');
    await waitFor(() => r.spawns().length === 2);
    assert.equal(r.spawns()[1]?.dir, r.dirs[r.ids.b]);
  } finally {
    r.close();
  }
});

test('an account that cannot be chosen is refused with its reason, and the chat is left alone', async () => {
  const r = await rig({ lite: (d) => [Object.values(d)[2] ?? ""] });
  try {
    const chat = await idleChat(r, { keepAlive: false, model: 'opus' });
    await assert.rejects(r.chats.switchAccount('no-such-chat', r.ids.a, 'person'), refusal('chat-not-found'));
    await assert.rejects(r.chats.switchAccount(chat.id, 'acc-nope', 'person'), refusal('account-not-found'));
    await assert.rejects(r.chats.switchAccount(chat.id, DEFAULT_ID, 'person'), refusal('same-account'));

    await r.store.setEnabled(r.ids.a, false);
    await assert.rejects(r.chats.switchAccount(chat.id, r.ids.a, 'person'), refusal('disabled'));
    await r.store.setEnabled(r.ids.a, true);

    const at = Date.now();
    const reading = readingFromEvent({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(at / 1000) + 3600, utilization: 1, unifiedWindows: { five_hour: { utilization: 1, resetsAt: Math.floor(at / 1000) + 3600 } } }, at);
    assert.ok(reading);
    await r.chats.noteAccountReading(r.ids.a, reading);
    await assert.rejects(r.chats.switchAccount(chat.id, r.ids.a, 'person'), refusal('exhausted'));

    await assert.rejects(r.chats.switchAccount(chat.id, r.ids.b, 'person'), refusal('model-unavailable'));

    assert.equal(r.chats.accountOf(chat.id), DEFAULT_ID);
    assert.equal(r.chats.get(chat.id)?.pendingAccount, undefined);
    assert.equal(r.db.rotationEvents().length, 0);
  } finally {
    r.close();
  }
});

test('an account that is signed out is refused', async () => {
  const r = await rig();
  try {
    const chat = await idleChat(r, { keepAlive: false });
    const login = await r.store.add({ kind: 'login', alias: 'sso' });
    await assert.rejects(r.chats.switchAccount(chat.id, login.id, 'person'), refusal('signed-out'));
  } finally {
    r.close();
  }
});

test('an account whose sign-in expired, or whose credentials have no refresh token, is refused as sign-in-expired', async () => {
  const r = await rig();
  try {
    const chat = await idleChat(r, { keepAlive: false });
    await r.store.markAuthFailed(r.ids.a);
    assert.equal(r.store.get(r.ids.a).signInState, 'expired');
    await assert.rejects(r.chats.switchAccount(chat.id, r.ids.a, 'person'), refusal('sign-in-expired'));

    const login = await r.store.add({ kind: 'login', alias: 'copied' });
    mkdirSync(r.store.ref(login.id).dir, { recursive: true });
    // A broken copy: an access token and no refresh token. Only the key's presence is ever read
    writeFileSync(join(r.store.ref(login.id).dir, CREDENTIALS_FILE), JSON.stringify({ claudeAiOauth: { accessToken: 'access' } }));
    assert.equal(r.store.get(login.id).signInState, 'incomplete');
    await assert.rejects(r.chats.switchAccount(chat.id, login.id, 'person'), refusal('sign-in-expired'));

    assert.equal(r.chats.accountOf(chat.id), DEFAULT_ID);
    assert.equal(r.db.rotationEvents().length, 0);

    // Once a run on it succeeds again the account can be chosen
    await r.store.clearAuthFailed(r.ids.a);
    assert.equal((await r.chats.switchAccount(chat.id, r.ids.a, 'person')).pending, false);
    assert.equal(r.chats.accountOf(chat.id), r.ids.a);
  } finally {
    r.close();
  }
});
