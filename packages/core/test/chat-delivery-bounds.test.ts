import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { AccountStore } from '@claudio/accounts';
import type { MessageDelivery } from '@claudio/shared';
import { ChatManager, ChatRefusal, DeliveryRefusal, RunSlotRefusal } from '../src/chats.ts';
import { AUTO_HINT_PREFIX, CHAT_HINT_PREFIX } from '../src/chat-service.ts';
import { Db } from '../src/db.ts';
import { Core } from '../src/index.ts';
import type { LiveChat } from '../src/live-chat.ts';
import { ClaudeCodeDriver } from '../src/providers/claude-code/driver.ts';
import { tempConfig } from './helpers.ts';

// The regression fixes of 2026-10-29 for chat delivery (docs/plans/regression-fixes-2026-10-29.md,
// C2, D3, D4; report §1): a message the agent never reads cannot pin a chat, nothing ends a chat's
// process while it runs work in the background, and "Send now" has the CLI's documented
// alternatives. All of it over the queueing fake, which answers the control requests as the CLI does.

const FAKE_QUEUE = fileURLToPath(new URL('./fixtures/fake-claude-queue.mjs', import.meta.url));

async function until<T>(read: () => T | undefined | null | false, what: string, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Op = { op: string; prompt?: string; text?: string; uuid?: string | null; subtype?: string; toolUseId?: string };

/** Sets environment variables for one test and gives back the old values on close. */
function withEnv(vars: Record<string, string>): () => void {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

function rig(env: Record<string, string> = {}, setup?: (config: ReturnType<typeof tempConfig>) => void) {
  const config = tempConfig();
  setup?.(config);
  const scratch = mkdtempSync(join(tmpdir(), 'claudio-bounds-'));
  const queueLog = join(scratch, 'queue.jsonl');
  const restore = withEnv({ FAKE_QUEUE_LOG: queueLog, ...env });
  const db = new Db(config);
  const chats = new ChatManager(config, db, [new ClaudeCodeDriver(FAKE_QUEUE)]);
  const ops = (): Op[] => (existsSync(queueLog) ? readFileSync(queueLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Op) : []);
  const deliveries = (id: string): MessageDelivery[] => chats.events(id).flatMap((e) => (e.kind === 'delivery' && e.delivery ? [e.delivery] : []));
  const file = (name: string) => join(scratch, name);
  const release = (name: string) => writeFileSync(file(name), '');
  /** The manager's own record of a chat, for the marks no route shows */
  const live = (id: string): LiveChat | undefined => (chats as unknown as { chats: Map<string, LiveChat> }).chats.get(id);
  const close = async () => {
    for (const name of ['f1', 'f2', 'f3']) release(name);
    chats.stopAll();
    await pause(150);
    db.close();
    restore();
    rmSync(scratch, { recursive: true, force: true });
    rmSync(join(config.dataDir, '..'), { recursive: true, force: true });
  };
  return { config, db, chats, scratch, ops, deliveries, file, release, live, close };
}

// ---------- §1.1: `written` is bounded ----------

test('a message the CLI drops without reading it back is settled not-read after the result, and the chat goes idle', async () => {
  const r = rig({ CLAUDIO_READ_BACK_MS: '300' });
  try {
    const chat = r.chats.start({ prompt: `HOLD ${r.file('f1')}` });
    await until(() => r.ops().some((o) => o.op === 'turn'), 'the first turn');
    const dropped = r.chats.sendMessage(chat.id, 'DROP this one, as a UserPromptSubmit hook would');
    assert.equal(dropped.taken, 'written');
    await until(() => r.ops().some((o) => o.op === 'enqueue'), 'the CLI to queue it');
    r.release('f1');
    await until(() => r.ops().some((o) => o.op === 'dropped'), 'the CLI to drop it');
    const lost = await until(() => r.deliveries(chat.id).find((d) => d.id === dropped.id && d.state === 'undelivered'), 'the message to be settled');
    assert.equal(lost.reason, 'not-read');
    assert.equal(lost.source, 'person');
    await until(() => r.chats.get(chat.id)?.status === 'idle', 'the chat to go idle');
    const listed = r.chats.get(chat.id)?.pending ?? [];
    assert.deepEqual(listed.map((m) => [m.id, m.state]), [[dropped.id, 'undelivered']]);
  } finally {
    await r.close();
  }
});

test('a message queued at a result keeps the chat busy only until the CLI reads it back as its next turn', async () => {
  const r = rig({ CLAUDIO_READ_BACK_MS: '300' });
  try {
    const chat = r.chats.start({ prompt: `HOLD ${r.file('f1')}` });
    await until(() => r.ops().some((o) => o.op === 'turn'), 'the first turn');
    const queued = r.chats.sendMessage(chat.id, `HOLD ${r.file('f2')}`);
    await until(() => r.ops().some((o) => o.op === 'enqueue'), 'the CLI to queue it');
    r.release('f1');
    await until(() => r.deliveries(chat.id).some((d) => d.id === queued.id && d.state === 'delivered'), 'its read-back');
    await pause(500);
    // Read back as its turn started: it is the agent's now, and nothing calls it lost
    assert.ok(!r.deliveries(chat.id).some((d) => d.state === 'undelivered'));
    assert.equal(r.chats.get(chat.id)?.status, 'busy');
    const delivered = r.deliveries(chat.id).find((d) => d.id === queued.id && d.state === 'delivered');
    assert.ok(delivered?.at, 'a delivery says when the agent took the message');
  } finally {
    await r.close();
  }
});

test('an interrupt whose receipt no longer lists a written message settles it at once', async () => {
  // The read-back window is long here, so only the receipt can settle it
  const r = rig({ CLAUDIO_READ_BACK_MS: '60000' });
  try {
    const chat = r.chats.start({ prompt: `HOLD ${r.file('f1')}` });
    await until(() => r.ops().some((o) => o.op === 'turn'), 'the first turn');
    const dropped = r.chats.sendMessage(chat.id, 'DROP me');
    await until(() => r.ops().some((o) => o.op === 'enqueue'), 'the CLI to queue it');
    r.release('f1');
    await until(() => r.ops().some((o) => o.op === 'dropped'), 'the CLI to drop it');
    // The card still waits: "Send now" asks the CLI, whose receipt says it holds nothing
    assert.equal(r.chats.get(chat.id)?.pending?.[0]?.state, 'written');
    await r.chats.interrupt(chat.id, dropped.id);
    const lost = r.deliveries(chat.id).find((d) => d.id === dropped.id && d.state === 'undelivered');
    assert.equal(lost?.reason, 'not-read');
    assert.equal(r.live(chat.id)?.interruptRequested, false, 'no turn was under way, so no result will clear the mark');
  } finally {
    await r.close();
  }
});

test('a message the receipt still lists survives the interrupt and is read back by the next turn', async () => {
  const r = rig();
  try {
    const chat = r.chats.start({ prompt: `HOLD ${r.file('f1')}` });
    await until(() => r.ops().some((o) => o.op === 'turn'), 'the first turn');
    const waiting = r.chats.sendMessage(chat.id, 'read me next');
    await until(() => r.ops().some((o) => o.op === 'enqueue'), 'the CLI to queue it');
    await r.chats.interrupt(chat.id, waiting.id);
    await until(() => r.deliveries(chat.id).some((d) => d.id === waiting.id && d.state === 'delivered'), 'its read-back');
    assert.ok(!r.deliveries(chat.id).some((d) => d.state === 'undelivered'));
  } finally {
    await r.close();
  }
});

test('a read-back that comes after the message was given up on still delivers it', async () => {
  const r = rig({ CLAUDIO_READ_BACK_MS: '60000' });
  try {
    const chat = r.chats.start({ prompt: `HOLD ${r.file('f1')}` });
    await until(() => r.ops().some((o) => o.op === 'turn'), 'the first turn');
    const message = r.chats.sendMessage(chat.id, 'taken late');
    await until(() => r.ops().some((o) => o.op === 'enqueue'), 'the CLI to queue it');
    const chatRecord = r.live(chat.id);
    assert.ok(chatRecord);
    const pending = chatRecord.pending.get(message.id);
    assert.ok(pending);
    // As the read-back window would have it
    chatRecord.pending.delete(message.id);
    chatRecord.lose(pending, 'the agent went on without reading it', 'not-read');
    r.release('f1');
    await until(() => r.deliveries(chat.id).some((d) => d.id === message.id && d.state === 'delivered'), 'the late delivery');
    assert.ok(!(r.chats.get(chat.id)?.pending ?? []).some((m) => m.id === message.id), 'it is no longer listed as lost');
  } finally {
    await r.close();
  }
});

// ---------- §1.7: the interrupt's mark ----------

test('an interrupt sent between turns leaves no mark for the next turn', async () => {
  const r = rig();
  try {
    const chat = r.chats.start({ prompt: 'first' });
    await until(() => r.chats.get(chat.id)?.status === 'idle', 'the first turn to end');
    // Busy as a background agent's line makes it, with no turn of the lead's under way
    const record = r.live(chat.id);
    assert.ok(record);
    record.setStatus('busy');
    await r.chats.interrupt(chat.id);
    assert.equal(record.interruptRequested, false);
  } finally {
    await r.close();
  }
});

// ---------- §1.8: whether a process reads back comes from its handshake ----------

test('a CLI whose version reads back keeps its messages followed after a first turn that read nothing back', async () => {
  const r = rig({ FAKE_INIT_VERSION: '2.1.312', FAKE_SKIP_FIRST_REPLAY: '1' });
  try {
    const chat = r.chats.start({ prompt: 'a local command' });
    await until(() => r.chats.get(chat.id)?.status === 'idle', 'the first turn to end', 2000);
    // The turn ran on it: taken, though nothing was read back, and never called lost
    assert.deepEqual(r.chats.get(chat.id)?.pending, []);
    const held = r.chats.sendMessage(chat.id, `HOLD ${r.file('f1')}`);
    await until(() => r.deliveries(chat.id).some((d) => d.id === held.id && d.state === 'delivered'), 'the second turn to read its message back');
    const later = r.chats.sendMessage(chat.id, 'written while it holds');
    assert.equal(later.taken, 'written');
    assert.deepEqual(r.chats.get(chat.id)?.pending?.map((m) => [m.id, m.state]), [[later.id, 'written']]);
  } finally {
    await r.close();
  }
});

test('a CLI that names no version is still found out at its first result', async () => {
  const r = rig({ FAKE_SKIP_FIRST_REPLAY: '1' });
  try {
    const chat = r.chats.start({ prompt: 'a local command' });
    await until(() => r.chats.get(chat.id)?.status === 'idle', 'the first turn to end');
    r.chats.sendMessage(chat.id, `HOLD ${r.file('f1')}`);
    await until(() => r.ops().filter((o) => o.op === 'turn').length === 2, 'the second turn');
    r.chats.sendMessage(chat.id, 'written while it holds');
    assert.deepEqual(r.chats.get(chat.id)?.pending, []);
  } finally {
    await r.close();
  }
});

// ---------- §1.4, D4: the alternatives to a blind interrupt ----------

test('a message held behind a foreground agent names it, and sending the agent to the background delivers it without an interrupt', async () => {
  const r = rig();
  try {
    const chat = r.chats.start({ prompt: `AGENT ${r.file('f1')}` });
    await until(() => r.live(chat.id)?.foreground.size === 1, 'the foreground agent call');
    const waiting = r.chats.sendMessage(chat.id, 'look at the config first');
    const [listed] = r.chats.get(chat.id)?.pending ?? [];
    assert.deepEqual(listed?.blockedBy, { toolUseId: 'toolu_agent_1', name: 'Agent', description: 'look around the repository' });
    await assert.rejects(r.chats.backgroundCall(chat.id, 'toolu_nope'), (err: unknown) => err instanceof DeliveryRefusal && err.reason === 'not-running' && err.statusCode === 409);
    await r.chats.backgroundCall(chat.id, 'toolu_agent_1');
    await until(() => r.deliveries(chat.id).some((d) => d.id === waiting.id && d.state === 'delivered'), 'the message read at the tool boundary');
    assert.ok(r.ops().some((o) => o.op === 'background' && o.toolUseId === 'toolu_agent_1'));
    assert.ok(!r.ops().some((o) => o.op === 'control' && o.subtype === 'interrupt'), 'nothing was interrupted');
    // The call returned: nothing holds a message any more, and it cannot be sent to the background twice
    await until(() => r.chats.get(chat.id)?.status === 'idle', 'the turn to end');
    await assert.rejects(r.chats.backgroundCall(chat.id, 'toolu_agent_1'), (err: unknown) => err instanceof DeliveryRefusal && err.reason === 'not-running');
  } finally {
    await r.close();
  }
});

test('a queued message is withdrawn from the CLI, and refused once the agent has taken it', async () => {
  const r = rig();
  try {
    const chat = r.chats.start({ prompt: `HOLD ${r.file('f1')}` });
    await until(() => r.ops().some((o) => o.op === 'turn'), 'the first turn');
    const message = r.chats.sendMessage(chat.id, 'never mind this');
    await until(() => r.ops().some((o) => o.op === 'enqueue'), 'the CLI to queue it');
    await r.chats.cancelMessage(chat.id, message.id);
    assert.ok(r.ops().some((o) => o.op === 'cancelled' && o.uuid === message.id));
    const withdrawn = r.deliveries(chat.id).find((d) => d.id === message.id);
    assert.deepEqual([withdrawn?.state, withdrawn?.reason], ['undelivered', 'cancelled']);
    // Not lost: whoever withdrew it knows, and a page opened later has nothing to hand back
    assert.deepEqual(r.chats.get(chat.id)?.pending, []);
    await assert.rejects(r.chats.cancelMessage(chat.id, message.id), (err: unknown) => err instanceof DeliveryRefusal && err.reason === 'taken');
    await assert.rejects(r.chats.cancelMessage(chat.id, '00000000-0000-4000-8000-000000000000'), (err: unknown) => err instanceof ChatRefusal && err.statusCode === 404);
    r.release('f1');
    await pause(300);
    assert.ok(!r.ops().some((o) => o.op === 'turn' && o.prompt === 'never mind this'), 'the agent never ran it');
  } finally {
    await r.close();
  }
});

test('a message held for the next process is withdrawn without reaching any agent', async () => {
  const r = rig({ FAKE_LINGER_MS: '1500' });
  try {
    const chat = r.chats.start({ prompt: 'first', keepAlive: false });
    await until(() => r.ops().some((o) => o.op === 'eof'), 'stdin to close');
    const held = r.chats.sendMessage(chat.id, 'for the next process');
    assert.equal(held.taken, 'held');
    await r.chats.cancelMessage(chat.id, held.id);
    assert.equal(r.deliveries(chat.id).find((d) => d.id === held.id && d.state === 'undelivered')?.reason, 'cancelled');
    await pause(2000);
    assert.equal(r.ops().filter((o) => o.op === 'turn').length, 1, 'no process was started for it');
  } finally {
    await r.close();
  }
});

// ---------- §1.3: a process that exits without closing its pipes ----------

test('a process that exits while a child holds its pipes is closed a moment later', async () => {
  const r = rig({ FAKE_CLOSE_GAP_MS: '4000', CLAUDIO_CLOSE_AFTER_EXIT_MS: '300' });
  try {
    const chat = r.chats.start({ prompt: 'first', keepAlive: false });
    await until(() => r.chats.get(chat.id)?.pid === null, 'the process to exit');
    await until(() => r.chats.get(chat.id)?.executions[0]?.endedAt, 'the execution to end', 3000);
    assert.equal(r.chats.isLeaving(chat.id), false);
    // A message now starts a process at once instead of waiting for the child to go
    const next = r.chats.sendMessage(chat.id, 'after the close');
    assert.equal(next.taken, 'started');
  } finally {
    await r.close();
  }
});

// ---------- §1.9: `carried` ----------

test('a limit replay says each waiting message goes on, under the id the page knows it by', async () => {
  const r = rig();
  try {
    const chat = r.chats.start({ prompt: `HOLD ${r.file('f1')}` });
    await until(() => r.ops().some((o) => o.op === 'turn'), 'the first turn');
    const later = r.chats.sendMessage(chat.id, 'written during it');
    await until(() => r.ops().some((o) => o.op === 'enqueue'), 'the CLI to queue it');
    assert.equal(await r.chats.replayLastTurn(chat.id), true);
    assert.deepEqual(r.deliveries(chat.id).filter((d) => d.state === 'carried').map((d) => [d.id, d.chatId]), [[later.id, chat.id]]);
    r.release('f1');
    await until(() => r.deliveries(chat.id).some((d) => d.id === later.id && d.state === 'delivered'), 'its delivery');
  } finally {
    await r.close();
  }
});

test('a replay with a turn of the caller keeps what waited, after that turn and under its own ids', async () => {
  const r = rig();
  try {
    const chat = r.chats.start({ prompt: `HOLD ${r.file('f1')}` });
    await until(() => r.ops().some((o) => o.op === 'turn'), 'the first turn');
    const waiting = r.chats.sendMessage(chat.id, 'still waiting');
    await until(() => r.ops().some((o) => o.op === 'enqueue'), 'the CLI to queue it');
    assert.equal(await r.chats.replayWith(chat.id, 'resume the workflow from its cache'), true);
    await until(() => r.deliveries(chat.id).some((d) => d.id === waiting.id && d.state === 'delivered'), 'its delivery');
    const turns = r.ops().filter((o) => o.op === 'turn').map((o) => o.prompt);
    assert.deepEqual(turns.slice(1), ['resume the workflow from its cache', 'still waiting']);
    assert.ok(r.deliveries(chat.id).some((d) => d.id === waiting.id && d.state === 'carried'));
    assert.ok(!r.deliveries(chat.id).some((d) => d.state === 'undelivered'), 'nothing that waited was called lost');
  } finally {
    await r.close();
  }
});

// ---------- D3: background work is never idle-ended ----------

test('the idle timeout does not end the input of a chat whose agent runs work in the background', async () => {
  const r = rig({ CLAUDIO_IDLE_TIMEOUT_MS: '200' });
  try {
    const chat = r.chats.start({ prompt: `BG ${r.file('f1')}` });
    await until(() => r.chats.get(chat.id)?.status === 'idle', 'the turn to end');
    await pause(900);
    assert.ok(!r.ops().some((o) => o.op === 'eof'), 'the input was ended while the background command ran');
    assert.notEqual(r.chats.get(chat.id)?.pid, null);
    r.release('f1');
    await until(() => r.ops().some((o) => o.op === 'eof'), 'the input to end once the work is over', 4000);
  } finally {
    await r.close();
  }
});

test('a one-turn chat keeps its input open while its background work runs, and ends it after', async () => {
  const r = rig();
  try {
    r.chats.start({ prompt: `BG ${r.file('f1')}`, keepAlive: false });
    await until(() => r.ops().some((o) => o.op === 'turn'), 'the turn');
    await pause(600);
    assert.ok(!r.ops().some((o) => o.op === 'eof'), 'the CLI was told to wind its background work down');
    r.release('f1');
    await until(() => r.ops().some((o) => o.op === 'eof'), 'the input to end', 4000);
  } finally {
    await r.close();
  }
});

test('a chat running background work is never evicted for a slot, past the idle timeout too', async () => {
  const r = rig({ CLAUDIO_IDLE_TIMEOUT_MS: '100' }, (config) => Object.assign(config, { maxConcurrentRuns: 1 }));
  try {
    const chat = r.chats.start({ prompt: `BG ${r.file('f1')}` });
    await until(() => r.chats.get(chat.id)?.status === 'idle', 'the turn to end');
    await pause(300);
    assert.throws(() => r.chats.start({ prompt: 'another' }), (err: unknown) => err instanceof RunSlotRefusal);
    assert.ok(!r.ops().some((o) => o.op === 'eof'));
  } finally {
    await r.close();
  }
});

test("a person's account switch waits for the background work, says so, and moves once it is over", async () => {
  const r = rig();
  const store = new AccountStore({ dataDir: r.config.dataDir, defaultDir: r.config.configDir, claude: FAKE_QUEUE });
  try {
    const account = await store.add({ kind: 'token', alias: 'alpha', secret: 'tok-alpha' });
    r.chats.accounts = store;
    const chat = r.chats.start({ prompt: `BG ${r.file('f1')}` });
    await until(() => r.chats.get(chat.id)?.status === 'idle', 'the turn to end');
    const switched = await r.chats.switchAccount(chat.id, account.id, 'person');
    assert.equal(switched.pending, true);
    assert.ok(r.chats.events(chat.id).some((e) => e.kind === 'notice' && /waits for the work running in the background/.test(e.text ?? '')));
    assert.ok(!r.ops().some((o) => o.op === 'eof'), 'the process was ended under the background work');
    r.release('f1');
    await until(() => r.chats.get(chat.id)?.account === account.id && !r.chats.get(chat.id)?.pendingAccount, 'the move once the work is over');
  } finally {
    await r.close();
  }
});

// ---------- §1.6: hints carry their source and go through the sends in order ----------

test('a hint goes through the chat\'s sends in order, framed by who sent it', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_QUEUE };
  const scratch = mkdtempSync(join(tmpdir(), 'claudio-bounds-'));
  const queueLog = join(scratch, 'queue.jsonl');
  const restore = withEnv({ FAKE_QUEUE_LOG: queueLog });
  const core = new Core(config);
  try {
    const chat = core.runtime.start({ prompt: `HOLD ${join(scratch, 'f1')}` });
    await until(() => existsSync(queueLog), 'the first turn');
    // The person's send reads the chat slowly: a hint that skipped the order would overtake it
    const service = core.chats as unknown as { summaryOf: (id: string) => Promise<unknown> };
    const read = service.summaryOf.bind(core.chats);
    let calls = 0;
    service.summaryOf = async (id: string) => {
      if (calls++ === 0) await pause(300);
      return read(id);
    };
    await Promise.all([core.chats.send(chat.id, { text: 'one' }), core.chats.hint(chat.id, 'two, from the Supervisor', { source: 'supervisor' })]);
    const enqueued = () => readFileSync(queueLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Op).filter((o) => o.op === 'enqueue').map((o) => o.text ?? '');
    const written = await until(() => (enqueued().length >= 2 ? enqueued() : null), 'both to reach the CLI');
    assert.equal(written[0], 'one');
    assert.equal(written[1], `${AUTO_HINT_PREFIX}\n\ntwo, from the Supervisor`);
    const pending = core.runtime.get(chat.id)?.pending ?? [];
    const hint = pending.find((m) => m.source === 'supervisor');
    // The page reads the words, without the framing the agent gets
    assert.equal(hint?.text, 'two, from the Supervisor');
    assert.equal(pending.find((m) => m.text === 'one')?.source, 'person');
    await core.chats.hint(chat.id, 'from a person');
    assert.ok(enqueued().includes(`${CHAT_HINT_PREFIX}\n\nfrom a person`));
  } finally {
    writeFileSync(join(scratch, 'f1'), '');
    core.shutdown();
    await pause(150);
    restore();
    rmSync(scratch, { recursive: true, force: true });
    rmSync(join(config.dataDir, '..'), { recursive: true, force: true });
  }
});
