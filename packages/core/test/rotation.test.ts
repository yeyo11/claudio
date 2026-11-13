import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { ProviderMove, ProvidersSettings } from '@claudio/shared';
import type { ChatWork } from '../src/chat-service.ts';
import { ChatManager } from '../src/chats.ts';
import { Core } from '../src/index.ts';
import { Db } from '../src/db.ts';
import type { ClaudioEventInput } from '../src/events.ts';
import { RunSlotRefusal } from '../src/chat-errors.ts';
import { ClaudeCodeDriver } from '../src/providers/claude-code/driver.ts';
import { defaultProvidersSettings, defaultRotationSettings } from '../src/providers/settings.ts';
import { ProviderRotation, effectiveOnLimit, openWaitOf, type WaitEnd } from '../src/rotation.ts';
import { SessionStore } from '../src/sessions.ts';
import { tempConfig } from './helpers.ts';

// The rotation over the fake Claude (`FAKE-LIMIT-ONCE`): what happens at a limit for a person's chat
// and for automated work, the wait timers, the claim and the recovery after a restart.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

interface Options {
  /** Automated work: what the chat works for */
  work?: ChatWork | null;
  /** The chats the eval runner says are its samples */
  evalSample?: boolean;
  /** Goes on with the chat's work instead of its last turn, as a workflow's lead does */
  replay?: (chatId: string, account?: string) => Promise<boolean> | null;
  pollMs?: number;
  claimMs?: number;
}

function settingsOf(): ProvidersSettings {
  const settings = defaultProvidersSettings(['claude-code']);
  settings.rotation = defaultRotationSettings();
  return settings;
}

function rig(o: Options = {}) {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const chats = new ChatManager(config, db, [new ClaudeCodeDriver(FAKE_CLAUDE)]);
  const settings = settingsOf();
  const events: ClaudioEventInput[] = [];
  const ended: Array<{ move: ProviderMove; end: WaitEnd; reason: string | null }> = [];
  let offset = 0;
  const rotation = new ProviderRotation({
    db,
    runtime: chats,
    settings: () => settings,
    projectProviders: () => null,
    projectOf: () => null,
    emit: (event) => events.push(event),
    ...(o.work ? { work: () => o.work ?? null } : {}),
    ...(o.evalSample ? { evalSample: () => true } : {}),
    ...(o.replay ? { replay: o.replay } : {}),
    ended: (m, end, reason) => ended.push({ move: m, end, reason }),
    now: () => Date.now() + offset,
    pollMs: o.pollMs ?? 20,
    slackMs: 0,
    ...(o.claimMs ? { claimMs: o.claimMs } : {}),
  });
  rotation.start();
  const limited = async (extra: Partial<Parameters<ChatManager['start']>[0]> = {}) => {
    const chat = chats.start({ prompt: 'FAKE-LIMIT-ONCE', name: 'limited', keepAlive: false, ...extra });
    await chats.exited(chat.id);
    // The announcement is handled in the next turn of the loop
    await new Promise((r) => setTimeout(r, 30));
    return chat.id;
  };
  return {
    config,
    db,
    chats,
    rotation,
    events,
    ended,
    limited,
    skip: (ms: number) => {
      offset += ms;
    },
    close: () => (rotation.close(), chats.stopAll(), db.close()),
  };
}

const waitFor = async (check: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 15));
  }
};

const pastMove = (chatId: string, provider: string, resetsAt: string | null = new Date(Date.now() - 1000).toISOString()): ProviderMove => {
  const at = new Date(Date.now() - 60_000).toISOString();
  return {
    id: `wait-${chatId}-${Math.random().toString(16).slice(2)}`,
    at,
    subjectKind: 'chat',
    subjectId: chatId,
    projectId: null,
    fromChat: chatId,
    toChat: null,
    fromProvider: provider,
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
  };
};

const work: ChatWork = { subjectKind: 'flow_run', subjectId: 'run-1' };

test("a person's chat at a limit is announced and left alone, until its click", async () => {
  const { db, events, limited, rotation, close } = rig();
  try {
    const id = await limited();
    assert.equal(events.filter((e) => e.type === 'run.rateLimited').length, 1);
    assert.equal(db.providerMoves({ chatId: id }).length, 0, 'nothing waits on its own');
    assert.equal(rotation.holds(id), false);

    const wait = rotation.waitFor(id);
    assert.equal(wait?.state, 'waiting');
    assert.equal(wait?.decidedBy, 'person');
    assert.equal(wait?.fromProvider, 'claude-code');
    assert.equal(rotation.holds(id), true);
    assert.equal(events.filter((e) => e.type === 'run.limitWaiting').length, 1);
    assert.equal(rotation.waitOf(id), wait?.id);
    assert.equal(rotation.waitFor(id), null, 'one open wait per chat');
  } finally {
    close();
  }
});

test("a schedule's chat is a person's: at a limit it only asks, and nothing waits on its own", async () => {
  // A schedule starts an ordinary chat and ties no run, task or item to it, so no work is found for it
  const { db, events, limited, rotation, close } = rig();
  try {
    const id = await limited();
    assert.equal(events.filter((e) => e.type === 'run.rateLimited').length, 1);
    assert.equal(db.providerMoves({ chatId: id }).length, 0);
    assert.equal(rotation.holds(id), false);
  } finally {
    close();
  }
});

test('an eval sample at a limit is announced and never held, moved or replayed', async () => {
  // The same chat as automated work would be waited on; a sample is run again from scratch instead
  const control = rig({ work });
  try {
    const id = await control.limited();
    assert.ok(control.rotation.holds(id) || control.db.providerMoves({ chatId: id }).length > 0, 'automated work is held');
  } finally {
    control.close();
  }
  const { chats, db, events, limited, rotation, close } = rig({ work, evalSample: true });
  try {
    const id = await limited();
    assert.equal(events.filter((e) => e.type === 'run.rateLimited').length, 1);
    assert.equal(db.providerMoves({ chatId: id }).length, 0);
    assert.equal(rotation.holds(id), false);
    assert.equal(rotation.waitOf(id), null);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(chats.get(id)?.executions.length, 1, 'the turn was not replayed');
  } finally {
    close();
  }
});

test('wait on Claude: the turn is replayed once when the reset has passed', async () => {
  const { chats, db, ended, limited, rotation, close } = rig();
  try {
    const id = await limited();
    const row = pastMove(id, 'claude-code');
    assert.equal(db.insertProviderMove(row), true);
    rotation.recover();
    await waitFor(() => db.providerMove(row.id)?.state === 'resumed');
    await chats.exited(id);
    assert.equal(chats.get(id)?.executions.at(-1)?.outcome, 'completed', 'the replay went through');
    assert.deepEqual(ended.map((e) => e.end), ['resumed']);
    assert.equal(rotation.holds(id), false);
  } finally {
    close();
  }
});

test('a wait with no reset known ends failed once the cap passes', async () => {
  const { db, ended, limited, rotation, skip, close } = rig();
  try {
    const id = await limited();
    const wait = rotation.waitFor(id);
    assert.ok(wait && wait.resetsAt === null, 'the fake reports no reset');
    skip(7 * 3_600_000);
    await waitFor(() => db.providerMove(wait.id)?.state === 'failed');
    assert.equal(db.providerMove(wait.id)?.reason, 'limit-wait-expired');
    assert.deepEqual(ended.map((e) => [e.end, e.reason]), [['failed', 'limit-wait-expired']]);
    assert.equal(rotation.holds(id), false);
  } finally {
    close();
  }
});

test('stopping a wait closes it as cancelled and the turn is never replayed', async () => {
  const { chats, db, ended, limited, rotation, close } = rig();
  try {
    const id = await limited();
    const wait = rotation.waitFor(id);
    assert.ok(wait);
    assert.equal(rotation.cancel(wait.id), true);
    assert.equal(db.providerMove(wait.id)?.state, 'cancelled');
    assert.equal(rotation.cancel(wait.id), false, 'not open any more');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(chats.get(id)?.executions.length, 1);
    assert.deepEqual(ended.map((e) => e.end), ['cancelled']);
  } finally {
    close();
  }
});

test('a wait survives a restart: the chat is restored and its turn goes on', async () => {
  const first = rig();
  let id = '';
  let rowId = '';
  try {
    id = await first.limited();
    const row = pastMove(id, 'claude-code', new Date(Date.now() + 3_600_000).toISOString());
    rowId = row.id;
    first.db.insertProviderMove(row);
  } finally {
    first.rotation.close();
    first.chats.stopAll();
  }
  // A new process on the same data directory
  const db = new Db(first.config);
  const chats = new ChatManager(first.config, db, [new ClaudeCodeDriver(FAKE_CLAUDE)]);
  const settings = settingsOf();
  const rotation = new ProviderRotation({
    db,
    runtime: chats,
    settings: () => settings,
    projectProviders: () => null,
    projectOf: () => null,
    emit: () => undefined,
    // The reset passes while the process is down
    now: () => Date.now() + 2 * 3_600_000,
    pollMs: 20,
    slackMs: 0,
  });
  try {
    await chats.restore(new SessionStore(first.config));
    assert.ok(chats.get(id), 'the chat is back');
    rotation.recover();
    await waitFor(() => db.providerMove(rowId)?.state === 'resumed');
    await waitFor(() => (chats.get(id)?.executions.length ?? 0) >= 2);
  } finally {
    rotation.close();
    chats.stopAll();
    db.close();
    first.db.close();
  }
});

/** The wait a person's chat opens by itself at a limit (the Core has an account store): these tests insert a due row of their own instead */
const dropOpenWait = async (core: Core, chatId: string): Promise<void> => {
  await waitFor(() => core.db.providerMoves({ chatId }).some((m) => m.state === 'waiting'));
  for (const m of core.db.providerMoves({ chatId })) if (m.state === 'waiting') core.rotation.cancel(m.id);
};

test('two Cores on one data directory replay a wait once', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const one = new Core(config);
  let two: Core | null = null;
  try {
    const chat = one.runtime.start({ prompt: 'FAKE-LIMIT-ONCE', name: 'limited', keepAlive: false });
    await one.runtime.exited(chat.id);
    await dropOpenWait(one, chat.id);
    // The second process boots on the same data directory and restores the same chat from its transcript
    two = new Core(config);
    const second = two;
    await waitFor(() => second.runtime.get(chat.id) !== undefined);
    const turns = (core: Core) => core.runtime.get(chat.id)?.executions.length ?? 0;
    const before = turns(one) + turns(second);
    const row = pastMove(chat.id, 'claude-code');
    assert.equal(one.db.insertProviderMove(row), true);
    one.rotation.recover();
    second.rotation.recover();
    await waitFor(() => one.db.providerMove(row.id)?.state === 'resumed');
    // Bounded waits: `exited` on the process that did not replay the turn has nothing to wait for,
    // and on a slow runner it hung the whole file. The replayed turn is counted where it started
    await waitFor(() => turns(one) + turns(second) >= before + 1, 20_000);
    await waitFor(() => !one.runtime.get(chat.id)?.pid && !second.runtime.get(chat.id)?.pid, 20_000);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(turns(one) + turns(second), before + 1, 'one replay between the two processes');
  } finally {
    two?.shutdown();
    one.shutdown();
  }
});

test('a wait replayed by a process that restored the chat ends the process after the turn, as its starter would', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const one = new Core(config);
  let two: Core | null = null;
  try {
    const chat = one.runtime.start({ prompt: 'FAKE-LIMIT-ONCE', name: 'limited', keepAlive: false });
    await one.runtime.exited(chat.id);
    await dropOpenWait(one, chat.id);
    two = new Core(config);
    const second = two;
    await waitFor(() => second.runtime.get(chat.id) !== undefined);
    const row = pastMove(chat.id, 'claude-code');
    assert.equal(second.db.insertProviderMove(row), true);
    // Only the restoring process recovers the wait, so it is the one that replays
    second.rotation.recover();
    await waitFor(() => second.db.providerMove(row.id)?.state === 'resumed');
    await waitFor(() => (second.runtime.get(chat.id)?.executions.length ?? 0) >= 2, 20_000);
    // Started with `keepAlive: false`, the chat's process ends after its turn rather than idling on
    await waitFor(() => !second.runtime.get(chat.id)?.pid && second.runtime.get(chat.id)?.status !== 'busy', 20_000);
    assert.notEqual(second.runtime.get(chat.id)?.status, 'idle');
  } finally {
    two?.shutdown();
    one.shutdown();
  }
});

test('a chat whose work goes on its own way is not replayed when its wait ends: the hook resumes it', async () => {
  const calls: Array<[string, string | undefined]> = [];
  let knows = '';
  const { chats, db, ended, limited, rotation, close } = rig({ replay: (chatId, account) => (chatId === knows ? (calls.push([chatId, account]), Promise.resolve(true)) : null) });
  try {
    const id = await limited();
    knows = id;
    const executions = chats.get(id)?.executions.length;
    const row = pastMove(id, 'claude-code');
    assert.equal(db.insertProviderMove(row), true);
    rotation.recover();
    await waitFor(() => db.providerMove(row.id)?.state === 'resumed');
    assert.deepEqual(calls, [[id, undefined]]);
    assert.equal(chats.get(id)?.executions.length, executions, 'the turn that died is not sent again');
    assert.deepEqual(ended.map((e) => e.end), ['resumed']);
  } finally {
    close();
  }
});

test('a chat the hook does not know is replayed as before', async () => {
  const { chats, db, ended, limited, rotation, close } = rig({ replay: () => null });
  try {
    const id = await limited();
    const row = pastMove(id, 'claude-code');
    assert.equal(db.insertProviderMove(row), true);
    rotation.recover();
    await waitFor(() => db.providerMove(row.id)?.state === 'resumed');
    await chats.exited(id);
    assert.equal(chats.get(id)?.executions.at(-1)?.outcome, 'completed', 'the replay went through');
    assert.deepEqual(ended.map((e) => e.end), ['resumed']);
  } finally {
    close();
  }
});

test('automated work at a limit waits on its own, by the setting', async () => {
  const { db, events, limited, rotation, close } = rig({ work });
  try {
    const id = await limited();
    await waitFor(() => rotation.waitOf(id) !== null);
    const [wait] = db.providerMoves({ chatId: id });
    assert.equal(wait?.action, 'wait');
    assert.equal(wait?.state, 'waiting');
    assert.equal(wait?.decidedBy, 'setting');
    assert.equal(wait?.subjectKind, 'flow_run');
    assert.equal(wait?.subjectId, 'run-1');
    assert.equal(db.providerMoves({ chatId: id }).length, 1);
    assert.equal(rotation.holds(id), true);
    assert.equal(events.filter((e) => e.type === 'run.limitWaiting').length, 1);
    assert.equal(openWaitOf(db, id)?.moveId, wait?.id);
  } finally {
    close();
  }
});

test('automated work whose limit handling fails waits for the reset instead of being left open', async () => {
  const { db, limited, rotation, close } = rig({ work });
  // The first write of the wait fails; the fallback writes it again
  const insert = db.insertProviderMove.bind(db);
  let failed = false;
  db.insertProviderMove = (move: ProviderMove) => {
    if (!failed) {
      failed = true;
      throw new Error('broken write');
    }
    return insert(move);
  };
  try {
    const id = await limited();
    await waitFor(() => rotation.waitOf(id) !== null);
    assert.match(db.providerMoves({ chatId: id })[0]?.reason ?? '', /handling the limit failed: broken write/);
    assert.equal(rotation.holds(id), true);
  } finally {
    close();
  }
});

test("the decision engine's own chats never wait", async () => {
  const { db, events, limited, rotation, close } = rig();
  try {
    const id = await limited({ internal: true });
    assert.equal(db.providerMoves({ chatId: id }).length, 0);
    assert.equal(rotation.holds(id), false);
    assert.equal(events.filter((e) => e.type === 'run.rateLimited').length, 1);
  } finally {
    close();
  }
});

test('the effective setting is the project override on the global one', () => {
  const settings = settingsOf();
  assert.equal(effectiveOnLimit(settings, null).action, 'wait');
  assert.equal(effectiveOnLimit(settings, { onLimit: { maxWaitHours: 12 } }).maxWaitHours, 12);
  assert.equal(effectiveOnLimit({}, null).action, 'wait', 'a file written before rotation reads as the defaults');
});

// ---------- the waits that stranded work (docs/plans/limit-resume-and-credits.md, t1) ----------

const HOUR = 3_600_000;

test('a wait for a weekly reset days away arms one timer per poll, however long it has waited', async () => {
  const { db, limited, rotation, skip, close } = rig({ pollMs: 50 });
  try {
    const id = await limited();
    // The cap on unknown resets passed long ago; the reset itself is three days off
    skip(7 * HOUR);
    const row = pastMove(id, 'claude-code', new Date(Date.now() + 7 * HOUR + 72 * HOUR).toISOString());
    assert.equal(db.insertProviderMove(row), true);
    const reads = { n: 0 };
    const read = db.providerMove.bind(db);
    db.providerMove = (moveId: string) => (reads.n++, read(moveId));
    rotation.recover();
    await new Promise((r) => setTimeout(r, 400));
    // A timer at 0 ms would read the row hundreds of times in this window
    assert.ok(reads.n <= 12, `the wait looked ${String(reads.n)} times in 400 ms`);
    assert.equal(db.providerMove(row.id)?.state, 'waiting', 'a known reset is waited for, not given up on');
  } finally {
    close();
  }
});

test('a wait whose resume is refused for a full runtime looks again and goes on', async () => {
  const { chats, db, ended, limited, rotation, close } = rig({ claimMs: 150 });
  try {
    const id = await limited();
    const replay = chats.replayLastTurn.bind(chats);
    let refusals = 0;
    chats.replayLastTurn = (chatId: string, account?: string) => {
      if (refusals++ === 0) throw new RunSlotRefusal(8);
      return replay(chatId, account);
    };
    const row = pastMove(id, 'claude-code');
    assert.equal(db.insertProviderMove(row), true);
    rotation.recover();
    await waitFor(() => refusals >= 1);
    await new Promise((r) => setTimeout(r, 30));
    assert.notEqual(db.providerMove(row.id)?.state, 'failed', 'a full runtime is no reason to end the wait');
    assert.equal(ended.length, 0);
    assert.equal(rotation.holds(id), true);
    await waitFor(() => db.providerMove(row.id)?.state === 'resumed');
    assert.ok(refusals >= 2, 'it tried again');
    assert.deepEqual(ended.map((e) => e.end), ['resumed']);
  } finally {
    close();
  }
});

test('a wait whose resume is refused for longer than maxWaitHours ends failed with the refusal', async () => {
  const { chats, db, ended, limited, rotation, skip, close } = rig({ claimMs: 100 });
  try {
    const id = await limited();
    chats.replayLastTurn = () => {
      throw new RunSlotRefusal(8);
    };
    const row = pastMove(id, 'claude-code');
    assert.equal(db.insertProviderMove(row), true);
    rotation.recover();
    await waitFor(() => db.providerMove(row.id)?.state === 'resuming');
    skip(7 * HOUR);
    await waitFor(() => db.providerMove(row.id)?.state === 'failed');
    assert.match(db.providerMove(row.id)?.reason ?? '', /Concurrent run limit reached/);
    assert.deepEqual(ended.map((e) => e.end), ['failed']);
  } finally {
    close();
  }
});

test('a wait whose chat no process has any more is closed failed, and a later wait for that chat can open', async () => {
  const { db, ended, rotation, close } = rig();
  try {
    const row = pastMove('chat-deleted', 'claude-code');
    assert.equal(db.insertProviderMove(row), true);
    rotation.recover();
    assert.equal(db.providerMove(row.id)?.state, 'failed');
    assert.equal(db.providerMove(row.id)?.reason, 'its chat is gone');
    assert.deepEqual(ended.map((e) => e.end), ['failed']);
    assert.equal(db.insertProviderMove(pastMove('chat-deleted', 'claude-code')), true, 'the unique index no longer refuses it');
  } finally {
    close();
  }
});

test("a wait whose chat another process holds is left open for that process", async () => {
  const first = rig();
  let id = '';
  try {
    id = await first.limited();
  } finally {
    first.rotation.close();
    first.chats.stopAll();
  }
  // A second process on the same data directory that has not restored the chat
  const db = new Db(first.config);
  const chats = new ChatManager(first.config, db, [new ClaudeCodeDriver(FAKE_CLAUDE)]);
  const settings = settingsOf();
  const rotation = new ProviderRotation({ db, runtime: chats, settings: () => settings, projectProviders: () => null, projectOf: () => null, emit: () => undefined, pollMs: 20, slackMs: 0 });
  try {
    const row = pastMove(id, 'claude-code', new Date(Date.now() + HOUR).toISOString());
    assert.equal(db.insertProviderMove(row), true);
    rotation.recover();
    assert.equal(db.providerMove(row.id)?.state, 'waiting');
  } finally {
    rotation.close();
    chats.stopAll();
    db.close();
    first.db.close();
  }
});

test("a person's wait ends when they send a message, and the turn that died is not replayed over it", async () => {
  const { chats, db, ended, limited, rotation, close } = rig();
  try {
    const id = await limited();
    const wait = rotation.waitFor(id);
    assert.ok(wait);
    chats.send(id, 'actually, do this instead');
    await waitFor(() => db.providerMove(wait.id)?.state === 'cancelled');
    assert.equal(db.providerMove(wait.id)?.reason, 'a person took over the chat');
    assert.deepEqual(ended.map((e) => e.end), ['cancelled']);
    await chats.exited(id);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(chats.get(id)?.executions.length, 2, 'the limited turn and the person\'s own, nothing replayed');
    assert.equal(rotation.holds(id), false);
  } finally {
    close();
  }
});

test('a wait of automated work is not ended by a message: the person did not take over a task', async () => {
  const { chats, db, limited, rotation, close } = rig({ work });
  try {
    const id = await limited();
    await waitFor(() => rotation.waitOf(id) !== null);
    const wait = db.providerMoves({ chatId: id })[0];
    chats.send(id, 'a note');
    await chats.exited(id);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(db.providerMove(wait?.id ?? '')?.state, 'waiting');
  } finally {
    close();
  }
});

test('closing the rotation clears its timers and settles what they started', async () => {
  const { db, limited, rotation, close } = rig({ pollMs: 10 });
  try {
    const id = await limited();
    const wait = rotation.waitFor(id);
    assert.ok(wait);
    await rotation.close();
    const reads = { n: 0 };
    const read = db.providerMove.bind(db);
    db.providerMove = (moveId: string) => (reads.n++, read(moveId));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(reads.n, 0, 'no timer looks at a wait after close');
  } finally {
    close();
  }
});
