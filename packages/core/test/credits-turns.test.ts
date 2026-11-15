import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AccountStore } from '@claudio/accounts';
import type { AccountCreditsSetting } from '@claudio/shared';
import { ChatManager } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import { EventBus, type ClaudioEventInput } from '../src/events.ts';
import { ClaudeCodeDriver } from '../src/providers/claude-code/driver.ts';
import { defaultProvidersSettings, defaultRotationSettings } from '../src/providers/settings.ts';
import { ProviderRotation } from '../src/rotation.ts';
import { localDayWindow } from '../src/spend.ts';
import { tempConfig } from './helpers.ts';

// A turn that crosses into an account's usage credits (t7 of docs/plans/limit-resume-and-credits.md):
// stopped at once where the account's credits setting does not let them pay (D4, D5), let through and
// marked paid where it does. The fake CLI reports the crossing as the SDK's typings describe it
// (`FAKE_CLAUDE_OVERAGE_DIRS`): no paid turn was ever recorded, and none is spent here.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const VARIABLES = ['CLAUDE_CONFIG_DIR', 'FAKE_CLAUDE_ACCOUNTS', 'FAKE_CLAUDE_OVERAGE_DIRS'];

async function rig(credits: AccountCreditsSetting | null) {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  let live: ChatManager | null = null;
  const store = new AccountStore({ dataDir: config.dataDir, defaultDir: config.configDir, claude: FAKE_CLAUDE, liveChatsOn: (id) => live?.liveChatsOn(id) ?? [] });
  await store.setSettings({ strategy: 'order' });
  const a = await store.add({ kind: 'token', alias: 'alpha', secret: 'tok-alpha' });
  const b = await store.add({ kind: 'token', alias: 'beta', secret: 'tok-beta' });
  // Alpha, first in the order, is the account whose plan is spent and whose credits cover it
  if (credits) await store.setSettings({ credits: { [a.id]: credits } });
  const saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
  const spawns = join(config.dataDir, 'spawns.log');
  process.env.CLAUDE_CONFIG_DIR = config.configDir;
  process.env.FAKE_CLAUDE_ACCOUNTS = spawns;
  const paying = store.ref(a.id).dir;
  process.env.FAKE_CLAUDE_OVERAGE_DIRS = paying;
  const chats = new ChatManager(config, db, [new ClaudeCodeDriver(FAKE_CLAUDE)]);
  chats.accounts = store;
  live = chats;
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
    projectOf: () => null,
    emit: (event) => events.push(event),
    accountsChanged: (listener) => store.onChange(listener),
    creditsStop: (chatId) => chats.creditsStopOf(chatId),
    pollMs: 20,
    slackMs: 0,
    now: () => Date.now(),
  });
  rotation.start();
  const today = localDayWindow(Date.now());
  return {
    config,
    paying,
    db,
    store,
    chats,
    events,
    ids: { a: a.id, b: b.id },
    dirs: () => (existsSync(spawns) ? readFileSync(spawns, 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { dir: string | null }).dir) : []),
    creditsUsd: () => creditsSpentOn(db, today),
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

function creditsSpentOn(db: Db, day: { start: number; end: number }): number {
  return db.spendBetween(new Date(day.start).toISOString(), new Date(day.end).toISOString()).creditsUsd;
}

// Each check waits for something to happen; the budget only bounds how long a real failure takes to report
const waitFor = async (check: () => boolean, ms = 30_000, seen?: () => unknown): Promise<void> => {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() > end) throw new Error(`timed out waiting${seen ? `; saw ${JSON.stringify(seen())}` : ''}`);
    await new Promise((r) => setTimeout(r, 15));
  }
};

/** A prompt whose turn goes on until the test lets it: it is still running when the crossing is read */
function gated(dir: string): { prompt: string; open: () => void } {
  const gate = join(dir, `gate-${String(Math.random()).slice(2)}`);
  return { prompt: `FAKE-WAIT-FOR ${gate}`, open: () => writeFileSync(gate, '1') };
}

test('under the default credits setting, a turn that crosses into credits is stopped at once and goes on with another account', async () => {
  const r = await rig(null);
  try {
    const turn = gated(r.config.dataDir);
    const chat = r.chats.start({ prompt: turn.prompt, name: 'crosses', keepAlive: false });
    await waitFor(() => r.chats.accountOf(chat.id) === r.ids.b, 30_000, () => r.dirs());
    turn.open();
    await r.chats.exited(chat.id);

    assert.equal(r.dirs()[0], r.paying, 'it began on the account whose plan is spent');
    const [event] = r.db.rotationEvents();
    assert.deepEqual([event?.event, event?.from, event?.to, event?.reason, event?.data?.credits], ['switch', r.ids.a, r.ids.b, 'credits', 'never']);
    const executions = r.chats.get(chat.id)?.executions ?? [];
    assert.equal(executions[0]?.cause, 'rate-limit', 'the stopped turn is recorded as a limit, which a restart reads back');
    assert.ok(!r.events.some((e) => e.type === 'account.credits'), 'nothing says credits are being spent');
  } finally {
    r.close();
  }
});

test('under allow, a turn that crosses into credits goes on, is marked paid in the spend ledger, and is announced', async () => {
  const r = await rig({ use: 'allow', capMinor: null });
  try {
    const chat = r.chats.start({ prompt: 'hello', name: 'pays', keepAlive: false });
    await r.chats.exited(chat.id);
    assert.deepEqual(r.dirs(), [r.paying], 'one process, on the account whose credits pay');
    assert.equal(r.db.rotationEvents().length, 0);
    assert.ok(r.creditsUsd() > 0, 'its spend is marked as paid from credits');
    const announced = r.events.filter((e) => e.type === 'account.credits');
    assert.equal(announced.length, 1);

  } finally {
    r.close();
  }
});

test("under allow with Claudio's cap set and the month's spend not known, the turn is stopped rather than spend on a guess", async () => {
  const r = await rig({ use: 'allow', capMinor: 500 });
  try {
    const turn = gated(r.config.dataDir);
    const chat = r.chats.start({ prompt: turn.prompt, name: 'capped', keepAlive: false });
    await waitFor(() => r.chats.accountOf(chat.id) === r.ids.b, 30_000, () => r.dirs());
    turn.open();
    await r.chats.exited(chat.id);
    const [event] = r.db.rotationEvents();
    assert.deepEqual([event?.reason, event?.data?.credits], ['credits', 'cap']);
  } finally {
    r.close();
  }
});

test('under last-resort, a turn that crosses into credits moves to an account that still has plan quota', async () => {
  const r = await rig({ use: 'last-resort', capMinor: null });
  try {
    const turn = gated(r.config.dataDir);
    const chat = r.chats.start({ prompt: turn.prompt, name: 'last resort', keepAlive: false });
    await waitFor(() => r.chats.accountOf(chat.id) === r.ids.b, 30_000, () => r.dirs());
    turn.open();
    await r.chats.exited(chat.id);
    const [event] = r.db.rotationEvents();
    assert.deepEqual([event?.from, event?.to, event?.reason, event?.data?.credits], [r.ids.a, r.ids.b, 'credits', 'quota-elsewhere']);
  } finally {
    r.close();
  }
});
