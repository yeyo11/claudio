import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AccountStore, parseUsage, type Reading } from '@claudio/accounts';
import { ChatManager } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import { ClaudeCodeDriver } from '../src/providers/claude-code/driver.ts';
import { tempConfig } from './helpers.ts';

// The leak of 2026-11-16 (docs/reports/credits-never-leak-2026-11-16.md): on a second machine a
// person's chat ran on the default account past its five-hour window, with credits on and the credits
// setting at its default (`never`), and nothing stopped it. The readings that crossed the limit came
// while the lead's turn was closed and only background subagents worked, which the check passed over;
// the turns that followed were opened by the agent itself on task notifications, which no check saw;
// and the CLI sent no new event once the window stood at 1.01. Every event here is shaped as that
// machine stored it: `allowed`, `isUsingOverage: false`, utilization 1.00 then 1.01.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const VARIABLES = ['CLAUDE_CONFIG_DIR', 'FAKE_CLAUDE_TIMELINE', 'FAKE_CLAUDE_BG_AGENT_MS', 'FAKE_CLAUDE_BG_RATE_LIMITS', 'FAKE_CLAUDE_SELF_TURN_MS', 'FAKE_CLAUDE_TURN_RATE_LIMITS'];
const HOUR = 3600_000;

/** A `get_usage` answer for the account: the plan with room, and `extra_usage` on or off */
function usage(at: number, enabled: boolean, five = 31): Reading {
  return parseUsage(
    {
      subscription_type: 'team',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: five, resets_at: new Date(at + HOUR).toISOString() },
        seven_day: { utilization: 58, resets_at: new Date(at + 48 * HOUR).toISOString() },
        extra_usage: { is_enabled: enabled, monthly_limit: 10000, used_credits: 3000, utilization: null, currency: 'EUR' },
      },
    },
    at,
  );
}

/** The crossing as the stream reported it: the five-hour window at 1.00 and then 1.01, still allowed */
function crossing(overage: Record<string, unknown>): Record<string, unknown>[] {
  const resetsAt = Math.floor((Date.now() + HOUR) / 1000);
  return [1, 1.01].map((utilization) => ({ status: 'allowed', rateLimitType: 'five_hour', resetsAt, utilization, ...overage, unifiedWindows: { five_hour: { utilization, resetsAt }, seven_day: { utilization: 0.62, resetsAt: resetsAt + 40 * 3600 } } }));
}

async function rig(env: Record<string, string>) {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  let live: ChatManager | null = null;
  const store = new AccountStore({ dataDir: config.dataDir, defaultDir: config.configDir, claude: FAKE_CLAUDE, liveChatsOn: (id) => live?.liveChatsOn(id) ?? [] });
  // The machine's own settings: no `credits` key, rotation off
  await store.setSettings({ strategy: 'order', rotateOnLimit: false });
  const a = await store.add({ kind: 'token', alias: 'alpha', secret: 'tok-alpha' });
  await store.add({ kind: 'token', alias: 'beta', secret: 'tok-beta' });
  const saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
  const timeline = join(config.dataDir, 'timeline.log');
  process.env.CLAUDE_CONFIG_DIR = config.configDir;
  process.env.FAKE_CLAUDE_TIMELINE = timeline;
  Object.assign(process.env, env);
  const chats = new ChatManager(config, db, [new ClaudeCodeDriver(FAKE_CLAUDE)]);
  chats.accounts = store;
  live = chats;
  return {
    db,
    store,
    chats,
    alpha: a.id,
    timeline: () => (existsSync(timeline) ? readFileSync(timeline, 'utf8').trim().split('\n') : []),
    close: () => {
      chats.stopAll();
      db.close();
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}

const waitFor = async (check: () => boolean, ms: number, seen?: () => unknown): Promise<void> => {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() > end) throw new Error(`timed out waiting${seen ? `; saw ${JSON.stringify(seen())}` : ''}`);
    await new Promise((r) => setTimeout(r, 15));
  }
};

const noticesOf = (chats: ChatManager, id: string): string[] =>
  chats.events(id).flatMap((e) => (e.kind === 'notice' && e.text ? [e.text] : []));

test('under the default credits setting, a crossing read while only background subagents work stops them at once', async () => {
  const r = await rig({ FAKE_CLAUDE_BG_AGENT_MS: '20000', FAKE_CLAUDE_BG_RATE_LIMITS: JSON.stringify(crossing({ isUsingOverage: false, overageStatus: 'allowed' })) });
  try {
    // A Refresh earlier in the day said the account's credits are on
    await r.store.observe(r.alpha, usage(Date.now() - 88 * 60_000, true));
    const chat = r.chats.start({ prompt: 'FAKE-TEXT-ONCE delegated\nFAKE-BG-AGENT', name: 'background', keepAlive: false });
    await waitFor(() => r.chats.creditsStopOf(chat.id) !== null, 10_000, () => r.timeline());
    await r.chats.exited(chat.id);
    assert.equal(r.chats.accountOf(chat.id), r.alpha);
    assert.equal(r.chats.creditsStopOf(chat.id), 'never');
    assert.ok(!r.timeline().includes('background-ended'), 'the subagent was cut, not left to spend');
    assert.ok(noticesOf(r.chats, chat.id).some((t) => t.includes('credits may not pay')), 'the person is told why');
    const [event] = r.db.rotationEvents();
    assert.deepEqual([event?.event, event?.from, event?.reason, event?.data?.credits], ['stopped', r.alpha, 'credits', 'never']);
  } finally {
    r.close();
  }
});

test('a crossing whose events carry no overage field takes a fresh get_usage, and stops the work when it says credits are on', async () => {
  const r = await rig({ FAKE_CLAUDE_BG_AGENT_MS: '20000', FAKE_CLAUDE_BG_RATE_LIMITS: JSON.stringify(crossing({})) });
  try {
    const probed: string[] = [];
    r.chats.probeUsage = async (id) => {
      probed.push(id);
      await r.chats.noteAccountReading(id, usage(Date.now(), true, 101));
    };
    const chat = r.chats.start({ prompt: 'FAKE-TEXT-ONCE delegated\nFAKE-BG-AGENT', name: 'probed', keepAlive: false });
    await waitFor(() => r.chats.creditsStopOf(chat.id) !== null, 10_000, () => ({ probed, timeline: r.timeline() }));
    await r.chats.exited(chat.id);
    assert.deepEqual(probed, [r.alpha], 'one get_usage for the account, however many readings crossed');
    assert.ok(!r.timeline().includes('background-ended'));
  } finally {
    r.close();
  }
});

test('a turn the agent opens on its own on an account whose plan is spent with credits on is stopped', async () => {
  const r = await rig({ FAKE_CLAUDE_SELF_TURN_MS: '300' });
  try {
    await r.store.observe(r.alpha, usage(Date.now() - 88 * 60_000, true));
    const chat = r.chats.start({ prompt: 'FAKE-TEXT-ONCE first', name: 'self turn' });
    await waitFor(() => (r.chats.get(chat.id)?.executions[0]?.turns ?? 0) > 0, 10_000);
    // The window crossed between turns, while nothing ran: nothing to stop yet
    await r.chats.noteAccountReading(r.alpha, { source: 'stream', status: 'allowed', windows: { five_hour: { utilization: 1.01, resetsAt: Math.floor((Date.now() + HOUR) / 1000) } }, at: Date.now(), overage: { observedAt: new Date().toISOString(), using: false, status: 'allowed' } });
    assert.equal(r.chats.creditsStopOf(chat.id), null);
    await waitFor(() => r.chats.creditsStopOf(chat.id) !== null, 10_000);
    assert.equal(r.chats.creditsStopOf(chat.id), 'never');
  } finally {
    r.close();
  }
});

// The other face, seen on the same machine at 19:05Z the same day (the report's second part): the CLI
// sent a rejected event and went on working, with the five-hour window at 83 %. Claudio kept the chat
// marked at its limit from then on, never cleared it while the process lived, wrote `cause:
// 'rate-limit'` when the process ended for an update, and the next start showed the chat stopped at
// its five-hour limit with the plan not spent. The event carries no reset, as that execution's
// missing `limitResetsAt` says it did.
function rejectedAtRoom(overage: Record<string, unknown>): string {
  const resetsAt = Math.floor((Date.now() + 3 * HOUR) / 1000);
  return JSON.stringify([{ status: 'rejected', rateLimitType: 'five_hour', utilization: 0.83, ...overage, unifiedWindows: { five_hour: { utilization: 0.83, resetsAt }, seven_day: { utilization: 0.01, resetsAt: resetsAt + 100 * 3600 } } }]);
}

test('a rejection the CLI goes past with the plan window at 83 % neither stops the turn under never nor counts as a limit', async () => {
  const r = await rig({ FAKE_CLAUDE_TURN_RATE_LIMITS: rejectedAtRoom({ isUsingOverage: false, overageStatus: 'allowed' }) });
  try {
    await r.store.observe(r.alpha, usage(Date.now() - 60_000, true));
    const chat = r.chats.start({ prompt: 'hello', name: 'room left', keepAlive: false });
    await r.chats.exited(chat.id);
    assert.equal(r.chats.creditsStopOf(chat.id), null, 'nothing crossed into credits');
    const [execution] = r.chats.get(chat.id)?.executions ?? [];
    assert.equal(execution?.outcome, 'completed');
    assert.notEqual(execution?.cause, 'rate-limit');
    assert.equal(r.db.rotationEvents().length, 0);
  } finally {
    r.close();
  }
});

test('a chat whose turn went through after a rejected event is not left at its limit when its process ends', async () => {
  const r = await rig({ FAKE_CLAUDE_TURN_RATE_LIMITS: rejectedAtRoom({}) });
  try {
    const chat = r.chats.start({ prompt: 'hello', name: 'went through' });
    await waitFor(() => (r.chats.get(chat.id)?.executions[0]?.turns ?? 0) > 0, 10_000);
    // The process ends with the turn answered, as it did for the update
    r.chats.stop(chat.id);
    await r.chats.exited(chat.id);
    const [execution] = r.chats.get(chat.id)?.executions ?? [];
    assert.notEqual(execution?.cause, 'rate-limit', 'a restart would read the chat back as stopped at its limit');
  } finally {
    r.close();
  }
});
