import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { Chat, ChatCompaction, RunEvent, TranscriptEntry } from '@claudio/shared';
import type { ClaudioEventInput } from '../src/events.ts';
import { ChatManager } from '../src/chats.ts';
import { ChatNotes, ContextControl, ContextRefusal, compactText, recognizeSecrets, SESSION_NOTE_INSTRUCTIONS } from '../src/index.ts';
import { COMPACTION_LEASE_MS, Db } from '../src/db.ts';
import { Core } from '../src/index.ts';
import type { ContextSignal, RunResult } from '../src/live-chat.ts';
import { encodeProjectId } from '../src/workspace.ts';
import { tempConfig } from './helpers.ts';

// Compact now, end to end over the core fake CLI (which replays what Claude Code 2.1.300 recorded),
// and the rows' bookkeeping over crafted signals for what a replay cannot time (an interrupt, a stop).

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));

async function until<T>(read: () => T | undefined | null | false | Promise<T | undefined | null | false>, what: string, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A conversation to compact: the transcript the CLI would have written, which is what "has history" reads */
function history(config: ReturnType<typeof tempConfig>, core: Core, id: string): void {
  const cwd = core.runtime.get(id)?.cwd ?? config.workspaceDir;
  const dir = join(config.projectsDir, encodeProjectId(cwd));
  mkdirSync(dir, { recursive: true });
  const at = '2026-03-10T10:00:00Z';
  const usage = { input_tokens: 10, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 0, output_tokens: 5 };
  writeFileSync(
    join(dir, `${id}.jsonl`),
    [
      { type: 'user', uuid: 'u1', timestamp: at, cwd, sessionId: id, message: { role: 'user', content: 'refactor the parser' } },
      { type: 'assistant', uuid: 'a1', timestamp: at, cwd, sessionId: id, message: { id: 'm1', role: 'assistant', model: 'claude-opus-5', usage, content: [{ type: 'text', text: 'done' }] } },
    ]
      .map((o) => JSON.stringify(o))
      .join('\n'),
  );
}

function setup() {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const core = new Core(config);
  return { config, core };
}

const idle = (core: Core, id: string) => until(() => core.runtime.get(id)?.status === 'idle' && core.runtime.get(id), `${id} to be idle`);
const rowOf = (core: Core, id: string, state: ChatCompaction['state']) => until(() => core.db.compactions(id).find((c) => c.state === state), `a ${state} compaction of ${id}`);
const boundaries = (events: RunEvent[]) => events.filter((e) => e.entry?.compaction?.part === 'boundary');

/** A live, idle chat with history, as the fake runs it */
async function liveChat(config: ReturnType<typeof tempConfig>, core: Core) {
  const chat = core.runtime.start({ prompt: 'hello' });
  await idle(core, chat.id);
  history(config, core, chat.id);
  return chat;
}

// ---------- the button, end to end ----------

test('compacting an idle live chat records the boundary, the divider, the cost-free row and the note kept from the summary', async () => {
  const { config, core } = setup();
  try {
    const chat = await liveChat(config, core);
    assert.equal((await core.chats.get(chat.id, { fresh: true }))?.compact?.available, true);
    const row = await core.context.compact(chat.id, { focus: 'the plan and the failing test' }, 'owner');
    assert.equal(row.origin, 'person');
    assert.equal(row.structuredNote, true);
    const done = await rowOf(core, chat.id, 'done');
    assert.equal(done.id, row.id);
    assert.equal(done.trigger, 'manual');
    assert.equal(done.focus, 'the plan and the failing test');
    assert.ok(done.preTokens && done.postTokens && done.preTokens > done.postTokens, 'the CLI\'s own figures');
    assert.ok(done.boundaryUuid);
    assert.equal(done.costUsd, null, 'a cost is only what the CLI reported over the process, never an estimate');
    // The divider is in the live stream at once, and the summary beside it became a note
    assert.equal(boundaries(core.runtime.events(chat.id)).length, 1);
    const kept = await until(() => core.notes.list(chat.id)[0], 'the note of the compaction');
    assert.equal(kept.source, 'compaction');
    assert.equal(kept.compactionId, done.id);
    assert.equal(core.db.compactionById(done.id)?.noteId, kept.id);
  } finally {
    core.shutdown();
  }
});

test('a chat nobody holds is compacted by resuming it', async () => {
  const { config, core } = setup();
  try {
    const chat = core.runtime.start({ prompt: 'hello', keepAlive: false });
    await until(() => core.runtime.get(chat.id)?.executions.every((e) => e.endedAt !== null) && core.runtime.get(chat.id), 'the first execution');
    history(config, core, chat.id);
    const row = await core.context.compact(chat.id, { structuredNote: false });
    await rowOf(core, chat.id, 'done');
    assert.equal(core.db.compactionById(row.id)?.structuredNote, false);
    assert.equal(core.runtime.get(chat.id)?.executions.length, 2, 'a second execution on the same chat');
    assert.equal(core.notes.list(chat.id).length, 0, 'no note unless one was asked for');
  } finally {
    core.shutdown();
  }
});

test('a compaction that fails in the CLI is a failed row and a notice in the stream, and the slot is free again', async () => {
  process.env.FAKE_CLAUDE_COMPACT = 'fail';
  const { config, core } = setup();
  try {
    const chat = await liveChat(config, core);
    await core.context.compact(chat.id, {});
    const failed = await rowOf(core, chat.id, 'failed');
    assert.equal(failed.failure, 'cli');
    assert.match(failed.error ?? '', /aborted/);
    const notice = core.runtime.events(chat.id).find((e) => e.kind === 'notice' && e.data?.code === 'compaction.failed');
    assert.ok(notice, 'the failure is said in the stream');
    await idle(core, chat.id);
    assert.equal((await core.chats.get(chat.id, { fresh: true }))?.compact?.available, true);
  } finally {
    delete process.env.FAKE_CLAUDE_COMPACT;
    core.shutdown();
  }
});

test('a compaction the CLI does by itself becomes a cli row and a divider entry', async () => {
  const { config, core } = setup();
  try {
    const chat = await liveChat(config, core);
    core.runtime.sendMessage(chat.id, 'AUTOCOMPACT');
    const row = await rowOf(core, chat.id, 'done');
    assert.equal(row.origin, 'cli');
    assert.equal(row.trigger, 'auto');
    assert.equal(row.preTokens, 18095);
    assert.equal(row.postTokens, 1094);
    assert.equal(boundaries(core.runtime.events(chat.id)).length, 1, 'a divider in the stream');
    assert.equal(core.db.compactions(chat.id).length, 1, 'the failed attempt before it (too_few_groups) is not a row');
  } finally {
    core.shutdown();
  }
});

test('a /compact typed into an idle chat is the person\'s compaction, and one typed while it works is only recorded when it lands', async () => {
  const { config, core } = setup();
  try {
    const chat = await liveChat(config, core);
    const receipt = await core.chats.send(chat.id, { text: '/compact keep the parser' });
    assert.ok(receipt.message);
    const row = await rowOf(core, chat.id, 'done');
    assert.equal(row.origin, 'typed');
    assert.equal(row.focus, 'keep the parser');
    assert.equal(row.structuredNote, false);
    await idle(core, chat.id);

    // Working: not intercepted, an ordinary message, and the boundary it causes gets a typed row of its own
    core.runtime.sendMessage(chat.id, 'SLEEP 1');
    await until(() => core.runtime.get(chat.id)?.status === 'busy', 'a working chat');
    await core.chats.send(chat.id, { text: '/compact' });
    await until(() => core.db.compactions(chat.id).length === 2, 'the second boundary');
    const second = core.db.compactions(chat.id)[0];
    assert.equal(second?.origin, 'typed');
    assert.equal(second?.state, 'done');
  } finally {
    core.shutdown();
  }
});

// ---------- what a compaction is not ----------

test('the result of a compaction moves no item and ends no run: only a turn of work is fanned out', async () => {
  const { config, core } = setup();
  try {
    const heard: Array<{ to: string; purpose?: string }> = [];
    const spy = (to: string) => (_id: string, result: RunResult) => void heard.push({ to, ...(result.purpose ? { purpose: result.purpose } : {}) });
    const inner = core as unknown as { workLinks: { chatResult: unknown } };
    inner.workLinks.chatResult = spy('workLinks');
    (core.flow as unknown as { chatResult: unknown }).chatResult = spy('flow');
    (core.assistant as unknown as { chatResult: unknown }).chatResult = spy('assistant');

    const chat = core.runtime.start({ prompt: 'hello' });
    await idle(core, chat.id);
    assert.deepEqual(heard.map((h) => h.to), ['workLinks', 'flow', 'assistant'], 'a turn of work is heard by all three');
    heard.length = 0;
    history(config, core, chat.id);
    await core.context.compact(chat.id, {});
    await rowOf(core, chat.id, 'done');
    await idle(core, chat.id);
    assert.deepEqual(heard, [], 'a compaction is nobody\'s work product');
    assert.equal(core.runtime.get(chat.id)?.executions.at(-1)?.turns, 1, 'its turn is still counted: it is real');
  } finally {
    core.shutdown();
  }
});

test('a housekeeping turn lost to the limit is not replayed on another account', () => {
  const db = new Db(tempConfig());
  try {
    const runtime = new ChatManager(tempConfig(), db);
    const hits: string[] = [];
    runtime.on('limit-hit', (chat: { id: string }) => hits.push(chat.id));
    const started = runtime.start({ prompt: 'hello', keepAlive: false });
    const chat = (runtime as unknown as { chats: Map<string, { rateLimited: boolean; purpose: string | null; lastUserTurn: unknown; limitRequested: boolean }> }).chats.get(started.id);
    assert.ok(chat);
    Object.assign(chat, { rateLimited: true, purpose: 'compact', lastUserTurn: { text: '/compact', attachments: [] } });
    (runtime as unknown as { maybeLimit: (c: unknown) => void }).maybeLimit(chat);
    assert.deepEqual(hits, [], 'no replay');
    // ...and the same turn of work would have been replayed
    Object.assign(chat, { purpose: null, limitRequested: false });
    (runtime as unknown as { maybeLimit: (c: unknown) => void }).maybeLimit(chat);
    assert.deepEqual(hits, [started.id]);
    runtime.stopAll();
  } finally {
    db.close();
  }
});

// ---------- the refusals ----------

/** A chat that every refusal applies to, and what lifts each one, in the order the plan fixes */
const refusable = (): Chat =>
  ({
    id: 'c1',
    origin: 'internal',
    control: { mode: 'readOnly', reason: 'held', action: 'fork' },
    context: null,
    messageCount: 0,
    environment: { slashCommands: [] },
    atLimit: true,
    state: 'working',
  }) as unknown as Chat;

function control(over: { flow?: boolean; assistant?: boolean; held?: boolean; status?: string } = {}) {
  const db = new Db(tempConfig());
  const runtime = Object.assign(new EventEmitter(), { get: () => ({ id: 'c1', name: 'c', status: over.status ?? 'idle', pid: 1, turns: 0, costUsd: 0, pendingPrompts: 0, lastText: null, origin: 'claudio', orchestrationId: null }), notice: () => undefined, executionExtrasOf: () => ({}) });
  const notes = new ChatNotes({ db, check: async () => undefined, turn: async () => undefined, compactionEntries: async () => [] });
  const emitted: ClaudioEventInput[] = [];
  const context = new ContextControl({
    db,
    runtime: runtime as unknown as ChatManager,
    chats: {} as never,
    flowOwns: () => over.flow ?? false,
    assistantOwns: () => over.assistant ?? false,
    limitHeld: () => over.held ?? false,
    notes,
    emit: (e) => emitted.push(e),
  });
  return { db, runtime, context, notes, emitted };
}

test('every refusal is reachable, and the first one that applies wins', () => {
  const { db, context } = control();
  try {
    const chat = refusable();
    const next = (change: Record<string, unknown>) => Object.assign(chat, change);
    assert.equal(context.availability(chat).refusal, 'housekeeping');
    assert.equal(context.availability(next({ origin: 'claudio' })).refusal, 'read-only');
    assert.equal(context.availability(next({ control: { mode: 'interactive' } })).refusal, 'no-history');
    assert.equal(context.availability(next({ messageCount: 4 })).refusal, 'unsupported');
    assert.equal(context.availability(next({ environment: { slashCommands: ['compact'] } })).refusal, 'at-limit');
    assert.equal(context.availability(next({ atLimit: false })).refusal, 'busy', 'nothing else applies yet');
    assert.equal(context.availability(next({ state: 'waiting' })).refusal, 'waiting');
    // `open` beats `waiting` and `busy`
    const claimed = db.claimHousekeeping('c1', { kind: 'compaction', leaseUntil: new Date(Date.now() + 60_000).toISOString(), row: { id: 'r1', origin: 'person', focus: null, structuredNote: true, flowRunId: null, requestedBy: null, requestedAt: new Date().toISOString() } }, new Date().toISOString());
    assert.ok(claimed);
    const open = context.availability(chat);
    assert.equal(open.refusal, 'open');
    assert.equal(open.open?.id, 'r1');
    // an environment not known yet does not refuse
    assert.equal(context.availability(next({ environment: null })).refusal, 'open');
    db.updateCompaction('r1', { state: 'done' }, { from: ['requested'] });
    assert.equal(context.availability(chat).refusal, 'waiting');
    assert.equal(context.availability(next({ state: 'idle' })).available, true);
  } finally {
    db.close();
  }
});

test('a run that owns the chat, or an open rotation wait, refuses before anything the chat is doing', () => {
  const owned = control({ flow: true });
  const assistant = control({ assistant: true });
  const limit = control({ held: true });
  try {
    const idleChat = { ...refusable(), origin: 'claudio', control: { mode: 'interactive' }, messageCount: 3, environment: { slashCommands: ['compact'] }, atLimit: false, state: 'idle' } as unknown as Chat;
    assert.equal(owned.context.availability({ ...idleChat, state: 'working' } as Chat).refusal, 'run');
    assert.equal(assistant.context.availability(idleChat).refusal, 'run');
    assert.equal(limit.context.availability({ ...idleChat, state: 'working' } as Chat).refusal, 'at-limit', 'a rotation wait is a limit wait');
    assert.equal(new ContextRefusal('run').statusCode, 409);
    assert.equal(new ContextRefusal('busy').reason, 'busy');
  } finally {
    owned.db.close();
    assistant.db.close();
    limit.db.close();
  }
});

test('a body that is not a focus string, or is too long, is a bad request and claims nothing', async () => {
  const { config, core } = setup();
  try {
    const chat = await liveChat(config, core);
    await assert.rejects(core.context.compact(chat.id, { focus: 4 as unknown as string }), /focus must be a string/);
    await assert.rejects(core.context.compact(chat.id, { focus: 'x'.repeat(501) }), /at most 500/);
    await assert.rejects(core.context.compact(chat.id, { structuredNote: 'yes' as unknown as boolean }), /boolean/);
    assert.equal(core.db.compactions(chat.id).length, 0);
    await assert.rejects(core.context.compact('nope', {}), /not found/);
    const row = await core.context.compact(chat.id, { focus: '   ' });
    assert.equal(row.focus, null, 'an empty focus is read as absent');
    await rowOf(core, chat.id, 'done');
  } finally {
    core.shutdown();
  }
});

test('a second compaction while one is open is refused open, even from another process', async () => {
  const { config, core } = setup();
  try {
    const chat = await liveChat(config, core);
    // The slot as another process of the same data directory holds it
    core.db.claimHousekeeping(chat.id, { kind: 'compaction', leaseUntil: new Date(Date.now() + 60_000).toISOString(), row: { id: 'theirs', origin: 'person', focus: null, structuredNote: true, flowRunId: null, requestedBy: null, requestedAt: new Date().toISOString() } }, new Date().toISOString());
    await assert.rejects(core.context.compact(chat.id, {}), (err: unknown) => err instanceof ContextRefusal && err.reason === 'open');
  } finally {
    core.shutdown();
  }
});

// ---------- how a row closes ----------

/** A running compaction of `c1`, claimed the way the button claims it, and the signals a process would send for it */
function running() {
  const rig = control();
  const claimed = (rig.context as unknown as { claim: (chatId: string, row: object) => ChatCompaction }).claim('c1', { origin: 'person', focus: null, structuredNote: true, flowRunId: null, requestedBy: null });
  const signal = (s: ContextSignal) => rig.context.onEvent('c1', s);
  signal({ kind: 'driver', event: { kind: 'compacting', active: true } });
  return { ...rig, signal, row: () => rig.db.compactionById(claimed.id) };
}
const result = (over: Partial<RunResult> = {}): RunResult => ({ purpose: 'compact', isError: false, result: '', structuredOutput: undefined, costUsd: 0, ...over });

test('a compacting status moves the row to running and keeps its lease', () => {
  const { db, row, signal } = running();
  try {
    assert.equal(row()?.state, 'running');
    assert.ok(row()?.startedAt);
    signal({ kind: 'driver', event: { kind: 'compacting', active: true } });
    assert.equal(row()?.state, 'running');
  } finally {
    db.close();
  }
});

test('an interrupt cancels the row as interrupted, a stop as stopped, an exit fails it as process-ended', () => {
  for (const [name, close, state, failure] of [
    ['interrupt', (s: (x: ContextSignal) => void) => s({ kind: 'driver', event: { kind: 'compact-failed', error: 'API Error: Request was aborted.' }, interrupted: true }), 'cancelled', 'interrupted'],
    ['stop', (s: (x: ContextSignal) => void) => s({ kind: 'ended', stopped: true, error: null }), 'cancelled', 'stopped'],
    ['exit', (s: (x: ContextSignal) => void) => s({ kind: 'ended', stopped: false, error: 'exit code 137' }), 'failed', 'process-ended'],
  ] as const) {
    const { db, row, signal } = running();
    try {
      close(signal);
      assert.equal(row()?.state, state, name);
      assert.equal(row()?.failure, failure, name);
    } finally {
      db.close();
    }
  }
});

test('a result with no boundary fails the row for the reason it ended: the budget, the limit, or the CLI', () => {
  for (const [name, over, failure] of [
    ['budget', { isError: true, cause: 'budget' as const, result: 'maximum budget exceeded' }, 'budget'],
    ['limit', { isError: true, cause: 'rate-limit' as const, result: 'usage limit reached' }, 'limit'],
    ['cli', {}, 'cli'],
  ] as const) {
    const { db, row, signal } = running();
    try {
      signal({ kind: 'result', result: result(over), interrupted: false });
      assert.equal(row()?.state, 'failed', name);
      assert.equal(row()?.failure, failure, name);
      assert.ok(row()?.error, `${name} says why`);
    } finally {
      db.close();
    }
  }
});

test('the cost of a compaction is the difference the CLI reported, and only when it grew', () => {
  const { db, signal, row } = running();
  try {
    // The chat had cost nothing when the row was claimed, so what the result reports is the turn's
    signal({ kind: 'driver', event: { kind: 'compacted', entry: { uuid: 'b1', role: 'user', timestamp: null, model: null, isSidechain: false, parentToolUseId: null, blocks: [] }, uuid: 'b1', trigger: 'manual', preTokens: 100, postTokens: 10, durationMs: 5, run: { kind: 'message' } } });
    assert.equal(row()?.state, 'done');
    assert.equal(row()?.boundaryUuid, 'b1');
    signal({ kind: 'result', result: result({ costUsd: 0.0123 }), interrupted: false });
    assert.equal(row()?.costUsd, 0.0123);
  } finally {
    db.close();
  }
});

// ---------- a process that died ----------

test('a row whose lease passed is lost at the next boot, and one still inside it is left to its owner', () => {
  const config = tempConfig();
  const db = new Db(config);
  try {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    const claim = (chatId: string, leaseUntil: string) =>
      db.claimHousekeeping(chatId, { kind: 'compaction', leaseUntil, row: { id: `row-${chatId}`, origin: 'person', focus: null, structuredNote: true, flowRunId: null, requestedBy: null, requestedAt: new Date().toISOString() } }, new Date(Date.now() - 5000).toISOString());
    claim('old', past);
    claim('live', future);
    control_with(db);
    assert.equal(db.compactionById('row-old')?.state, 'failed');
    assert.equal(db.compactionById('row-old')?.failure, 'lost');
    assert.equal(db.compactionById('row-live')?.state, 'requested');
  } finally {
    db.close();
  }
});

/** A `ContextControl` over an existing database: constructing one is what sweeps at boot */
function control_with(db: Db): ContextControl {
  const runtime = Object.assign(new EventEmitter(), { get: () => null });
  return new ContextControl({ db, runtime: runtime as unknown as ChatManager, chats: {} as never, flowOwns: () => false, assistantOwns: () => false, notes: new ChatNotes({ db, check: async () => undefined, turn: async () => undefined, compactionEntries: async () => [] }), emit: () => undefined });
}

test('compactAndWait never rejects: a chat that cannot be compacted comes back as null, and the chat is left as it was', async () => {
  const { core } = setup();
  try {
    assert.equal(await core.context.compactAndWait('nope', { flowRunId: 'run-1' }), null);
  } finally {
    core.shutdown();
  }
});

test('compactAndWait compacts with the run\'s own options and answers once the row is closed and the process gone', async () => {
  const { config, core } = setup();
  try {
    const chat = core.runtime.start({ prompt: 'hello', keepAlive: false });
    await until(() => core.runtime.get(chat.id)?.executions.every((e) => e.endedAt !== null) && core.runtime.get(chat.id), 'the first execution');
    history(config, core, chat.id);
    const row = await core.context.compactAndWait(chat.id, { flowRunId: 'run-7', structuredNote: false });
    assert.equal(row?.state, 'done');
    assert.equal(row?.origin, 'flow');
    assert.equal(row?.flowRunId, 'run-7');
    assert.equal(core.runtime.get(chat.id)?.pid, null, 'the process is gone, so the run can resume the chat');
  } finally {
    core.shutdown();
  }
});

test('what is sent for a compaction is /compact, the focus as written, then the fixed note instructions on one line', () => {
  assert.equal(compactText(null, false), '/compact');
  assert.equal(compactText('the plan', false), '/compact Keep in particular: the plan');
  assert.equal(compactText('the plan', true), `/compact Keep in particular: the plan ${SESSION_NOTE_INSTRUCTIONS}`);
  assert.ok(!compactText(null, true).includes('\n'));
});

// ---------- safety (x9) ----------

test('a flow compaction runs under the run\'s own policy and budget, and never under its schema', async () => {
  const spawns = join(mkdtempSync(join(tmpdir(), 'claudio-spawns-')), 'spawns.log');
  process.env.FAKE_CLAUDE_SPAWNS = spawns;
  const { config, core } = setup();
  try {
    const chat = core.runtime.start({ prompt: 'hello', keepAlive: false });
    await until(() => core.runtime.get(chat.id)?.executions.every((e) => e.endedAt !== null) && core.runtime.get(chat.id), 'the first execution');
    history(config, core, chat.id);
    const row = await core.context.compactAndWait(chat.id, {
      flowRunId: 'run-9',
      options: {
        model: 'claude-sonnet-5',
        permissionMode: 'acceptEdits',
        allowedTools: ['Read', 'Edit'],
        disallowedTools: ['Bash(git push:*)'],
        maxBudgetUsd: 0.25,
        permissionPrompts: 'none',
        toolPreset: null,
        jsonSchema: { type: 'object' },
      } as never,
    });
    assert.equal(row?.state, 'done');
    // The compaction is a resume of the same chat: the last chat process started
    const argv = readFileSync(spawns, 'utf8').trim().split('\n').filter((line) => line.includes(`--resume ${chat.id}`)).at(-1) ?? '';
    assert.ok(argv, 'a resume of the chat');
    assert.match(argv, /--permission-mode acceptEdits/);
    assert.match(argv, /--disallowedTools=Bash\(git push:\*\)/, 'a push stays denied');
    assert.match(argv, /--max-budget-usd 0\.25/, 'capped by the run\'s budget');
    assert.match(argv, /--permission-prompts none/);
    assert.doesNotMatch(argv, /--json-schema/, 'a compaction is not held to the run\'s schema');
  } finally {
    delete process.env.FAKE_CLAUDE_SPAWNS;
    core.shutdown();
  }
});

test('a note leaves the server with Claudio\'s own secrets and anything shaped like a secret masked, so the journal prefill starts from that', () => {
  const db = new Db(tempConfig());
  const forget = recognizeSecrets({ values: () => ['vault-value-only-claudio-holds'], isSecret: () => false });
  try {
    const notes = new ChatNotes({ db, check: async () => undefined, turn: async () => undefined, compactionEntries: async () => [] });
    const now = new Date().toISOString();
    assert.ok(db.claimHousekeeping('c9', { kind: 'compaction', leaseUntil: new Date(Date.now() + COMPACTION_LEASE_MS).toISOString(), row: { id: 'k9', origin: 'person', focus: null, structuredNote: true, flowRunId: null, requestedBy: null, requestedAt: now } }, now));
    const row = db.compactionById('k9');
    assert.ok(row);
    const text = ['## Goal', 'Ship it with vault-value-only-claudio-holds', '## Done (with evidence)', 'API_KEY=hunter2hunter2', '## Failed', '-', '## Not tried yet', '-', '## Files in flight', '-', '## Next step', 'export GH=ghp_abcdefghijklmnopqrstuvwxyz1234'].join('\n');
    const entry = { uuid: 's9', role: 'user', timestamp: now, model: null, isSidechain: false, parentToolUseId: null, blocks: [{ type: 'text', text }], compaction: { part: 'summary' } } as unknown as TranscriptEntry;
    notes.fromCompaction(row, entry);
    const [served] = notes.list('c9');
    assert.ok(served?.text);
    assert.doesNotMatch(served.text, /vault-value-only-claudio-holds|hunter2|ghp_/);
    assert.match(served.text, /\[redacted\]/);
    assert.doesNotMatch(JSON.stringify(served.sections), /vault-value-only-claudio-holds|hunter2|ghp_/);
    assert.equal(served.sections?.goal, 'Ship it with [redacted]');
  } finally {
    forget();
    db.close();
  }
});
