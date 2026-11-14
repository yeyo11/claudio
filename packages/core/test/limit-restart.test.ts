import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { ProviderMove } from '@claudio/shared';
import { LIMIT_CONTINUE_TEXT } from '@claudio/shared';
import type { ChatWork } from '../src/chat-service.ts';
import { RunSlotRefusal } from '../src/chat-errors.ts';
import { ChatManager, limitedTailAt } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import { ClaudeCodeDriver } from '../src/providers/claude-code/driver.ts';
import { defaultProvidersSettings, defaultRotationSettings } from '../src/providers/settings.ts';
import { ProviderRotation, type WaitEnd } from '../src/rotation.ts';
import { SessionStore } from '../src/sessions.ts';
import { emptyTokenUsage } from '../src/usage.ts';
import { tempConfig } from './helpers.ts';

// A chat at its limit, over the fake Claude: what a restart keeps of it (case C2 of
// docs/plans/limit-resume-and-credits.md), a resume the runtime refuses, and a person who writes to
// a chat that waits. `FAKE-LIMIT-REPORTED-ONCE` is a turn that dies on a rejected `rate_limit_event`
// that carries a reset an hour away, followed by the 429.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const LIMITED = 'FAKE-LIMIT-REPORTED-ONCE';
const HOUR = 3_600_000;

const waitFor = async (check: () => boolean, ms = 20_000): Promise<void> => {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 15));
  }
};

/** One process on a data directory: its chats, its database and a rotation whose clock the test moves */
function boot(o: { config?: ReturnType<typeof tempConfig>; claimMs?: number; pollMs?: number; work?: ChatWork } = {}) {
  const config = o.config ?? { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const chats = new ChatManager(config, db, [new ClaudeCodeDriver(FAKE_CLAUDE)]);
  const settings = defaultProvidersSettings(['claude-code']);
  settings.rotation = defaultRotationSettings();
  const ended: Array<{ move: ProviderMove; end: WaitEnd; reason: string | null }> = [];
  let offset = 0;
  const rotation = new ProviderRotation({
    db,
    runtime: chats,
    settings: () => settings,
    projectProviders: () => null,
    projectOf: () => null,
    emit: () => undefined,
    ...(o.work ? { work: () => o.work ?? null } : {}),
    ended: (move, end, reason) => ended.push({ move, end, reason }),
    now: () => Date.now() + offset,
    // A test that gives it an hour leaves only what the test does to end a wait before its reset
    pollMs: o.pollMs ?? 20,
    slackMs: 0,
    ...(o.claimMs ? { claimMs: o.claimMs } : {}),
  });
  rotation.start();
  return {
    config,
    db,
    chats,
    rotation,
    ended,
    skip: (ms: number) => {
      offset += ms;
    },
    /** A chat whose first turn died at the limit */
    limited: async (): Promise<string> => {
      const chat = chats.start({ prompt: LIMITED, name: 'limited', keepAlive: false });
      await chats.exited(chat.id);
      return chat.id;
    },
    close: () => {
      void rotation.close();
      chats.stopAll();
      db.close();
    },
  };
}

test('a chat at its limit before a restart is still at it after, and its wait opens and goes on by itself', async () => {
  const first = boot();
  let id = '';
  let recorded: string | undefined;
  try {
    id = await first.limited();
    assert.equal(first.chats.atLimit(id), true);
    recorded = first.chats.get(id)?.executions[0]?.limitResetsAt;
    assert.ok(recorded && Date.parse(recorded) > Date.now() + 50 * 60_000, 'the execution recorded the reset the refusal gave');
  } finally {
    first.close();
  }

  // A new process on the same data directory, long after the chat ended: every ended chat is old enough to retire
  const second = boot({ config: first.config });
  try {
    second.chats.retireAfterMs = 0;
    await second.chats.restore(new SessionStore(first.config));
    assert.equal(second.chats.atLimit(id), true, 'the banner and the Wait route still see a chat at its limit');
    assert.equal(second.chats.limitResetOf(id), recorded, 'and its reset is the one recorded');
    assert.deepEqual(second.chats.retireEnded(Date.now() + 2 * HOUR), [], 'a chat at its limit is not retired from memory');

    // What a click on Wait does
    const wait = second.rotation.waitFor(id);
    assert.ok(wait, 'the wait opens: the route no longer answers 409');
    assert.equal(wait.resetsAt, recorded);
    second.skip(2 * HOUR);
    await waitFor(() => second.db.providerMove(wait.id)?.state === 'resumed');
    await waitFor(() => (second.chats.get(id)?.executions.length ?? 0) >= 2);
    await second.chats.exited(id);
    assert.equal(second.chats.atLimit(id), false, 'the turn went through');
  } finally {
    second.close();
  }
});

test('a chat whose last turn went through is not at a limit after a restart', async () => {
  const first = boot();
  let id = '';
  try {
    const chat = first.chats.start({ prompt: 'hello', name: 'fine', keepAlive: false });
    id = chat.id;
    await first.chats.exited(id);
  } finally {
    first.close();
  }
  const second = boot({ config: first.config });
  try {
    await second.chats.restore(new SessionStore(first.config));
    assert.equal(second.chats.atLimit(id), false);
  } finally {
    second.close();
  }
});

test('a resume the runtime refuses leaves the chat at its limit and is retried as the turn it was', async (t) => {
  const p = boot({ claimMs: 50 });
  try {
    const id = await p.limited();
    const sent = t.mock.method(p.chats, 'sendMessage');
    Object.assign(p.chats.defaults, { maxConcurrentRuns: 1 });
    const cwd = mkdtempSync(join(tmpdir(), 'claudio-limit-'));
    const busy = p.chats.start({ prompt: 'FAKE-SLEEP 60000', name: 'takes the only slot', cwd, purpose: 'person' });

    const wait = p.rotation.waitFor(id);
    assert.ok(wait);
    p.skip(2 * HOUR);
    // Every look at the wait is refused for lack of a run slot: the claim lapses and it looks again
    await waitFor(() => sent.mock.calls.some((call) => call.error instanceof RunSlotRefusal));
    assert.equal(p.chats.atLimit(id), true, 'the banner stays: nothing started');
    assert.equal(p.db.providerMove(wait.id)?.state, 'resuming', 'and so does the wait');

    p.chats.stop(busy.id);
    await p.chats.exited(busy.id);
    await waitFor(() => p.db.providerMove(wait.id)?.state === 'resumed');
    await waitFor(() => (p.chats.get(id)?.executions.length ?? 0) >= 2);
    const texts = sent.mock.calls.map((call) => call.arguments[1]);
    assert.ok(texts.includes(LIMITED), 'the turn that died was sent again');
    assert.ok(!texts.includes(LIMIT_CONTINUE_TEXT), 'and not the nudge a counted replay falls back to');
  } finally {
    p.close();
  }
});

test('a replay the runtime refuses is no replay: it can be asked again', async () => {
  const p = boot();
  try {
    const id = await p.limited();
    Object.assign(p.chats.defaults, { maxConcurrentRuns: 1 });
    const cwd = mkdtempSync(join(tmpdir(), 'claudio-limit-'));
    const busy = p.chats.start({ prompt: 'FAKE-SLEEP 60000', name: 'takes the only slot', cwd, purpose: 'person' });
    await assert.rejects(p.chats.replayLastTurn(id), RunSlotRefusal);
    await assert.rejects(p.chats.replayLastTurn(id), RunSlotRefusal, 'a refusal is not a replay: a second ask is refused for the slot, not turned away');
    assert.equal(p.chats.atLimit(id), true);
    p.chats.stop(busy.id);
    await p.chats.exited(busy.id);
    assert.equal(await p.chats.replayLastTurn(id), true, 'the turn goes again once there is room');
    await waitFor(() => p.chats.atLimit(id) === false);
  } finally {
    p.close();
  }
});

test("a person's message to a chat that waits ends the wait at once, and nothing is replayed over it", async () => {
  const p = boot({ pollMs: HOUR });
  try {
    const id = await p.limited();
    const wait = p.rotation.waitFor(id);
    assert.ok(wait);
    // The poll is an hour away: only the send can end it
    p.chats.send(id, 'never mind, do this instead');
    assert.equal(p.db.providerMove(wait.id)?.state, 'cancelled');
    assert.equal(p.db.providerMove(wait.id)?.reason, 'a person took over the chat');
    assert.deepEqual(p.ended.map((e) => e.end), ['cancelled']);
    assert.equal(p.rotation.waitOf(id), null);
    await p.chats.exited(id);
    p.skip(2 * HOUR);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(p.chats.get(id)?.executions.length, 2, 'the limit and the person\'s turn, no replay');
  } finally {
    p.close();
  }
});

test("a message to a task's chat does not end the wait the rotation holds for it", async () => {
  const p = boot({ pollMs: HOUR, work: { subjectKind: 'flow_run', subjectId: 'run-1' } });
  try {
    const id = await p.limited();
    // The rotation opens the wait of a task's chat by itself
    await waitFor(() => p.rotation.waitOf(id) !== null);
    const moveId = p.rotation.waitOf(id) ?? '';
    p.chats.send(id, 'a hint from the orchestrator');
    assert.equal(p.db.providerMove(moveId)?.state, 'waiting');
  } finally {
    p.close();
  }
});

test('the reset a limit failure recorded survives in the executions that name the accounts it died on', () => {
  const exec = (account: string, limitResetsAt?: string) => ({
    id: `e-${account}`,
    startedAt: '2026-11-12T15:25:00.000Z',
    endedAt: '2026-11-12T15:25:50.000Z',
    outcome: 'failed' as const,
    error: null,
    cause: 'rate-limit' as const,
    permissionMode: 'acceptEdits' as const,
    model: null,
    account,
    maxBudgetUsd: null,
    costUsd: null,
    tokens: emptyTokenUsage(),
    turns: 1,
    ...(limitResetsAt ? { limitResetsAt } : {}),
  });
  assert.deepEqual(limitedTailAt([exec('a', '2026-11-12T17:00:00.000Z'), exec('b')]), [
    { account: 'b', at: Date.parse('2026-11-12T15:25:50.000Z'), until: null },
    { account: 'a', at: Date.parse('2026-11-12T15:25:50.000Z'), until: Date.parse('2026-11-12T17:00:00.000Z') },
  ]);
});
