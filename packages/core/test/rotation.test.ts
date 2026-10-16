import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { ProviderMove, ProvidersSettings } from '@claudio/shared';
import type { ChatWork } from '../src/chat-service.ts';
import { ChatManager } from '../src/chats.ts';
import { Core } from '../src/index.ts';
import { Db } from '../src/db.ts';
import type { ClaudioEventInput } from '../src/events.ts';
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
    ended: (m, end, reason) => ended.push({ move: m, end, reason }),
    now: () => Date.now() + offset,
    pollMs: 20,
    slackMs: 0,
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

test('two Cores on one data directory replay a wait once', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const one = new Core(config);
  let two: Core | null = null;
  try {
    const chat = one.runtime.start({ prompt: 'FAKE-LIMIT-ONCE', name: 'limited', keepAlive: false });
    await one.runtime.exited(chat.id);
    await new Promise((r) => setTimeout(r, 30));
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
