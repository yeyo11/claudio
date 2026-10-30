import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { ClaudioEvent, DecisionMode, DecisionPointSettings, HealthSignal, SupervisorProposal, TranscriptEntry } from '@claudio/shared';
import type { ChatRuntime } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import { DecisionCredentialStore, DecisionSettingsStore, DEFAULT_DECISION_SETTINGS, DEFAULT_THRESHOLD } from '../src/decisions/settings.ts';
import type { ClaudioEventInput } from '../src/events.ts';
import { HealthMonitor, type TaskContext } from '../src/health-service.ts';
import { Core } from '../src/index.ts';
import { hintFrom, lastSteps, relayHint, Supervisor, SupervisorConflictError, supervisorModeOf, type SupervisorAnswer, type SupervisorQuestion } from '../src/supervisor.ts';
import { MemoryRefusal, RunSlotRefusal } from '../src/chat-errors.ts';
import { tempConfig } from './helpers.ts';
import { PASTED_NOTE } from '../src/prompt-rules.ts';

// The supervisor wakes on a bad signal, asks a housekeeping chat once per signal per chat, and keeps
// what it proposed as a row. Every test answers with a fake: the CLI stand-in of the fixtures, or a
// function. Never a real model.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));

const hung: HealthSignal = {
  kind: 'hung-command',
  level: 'bad',
  reason: '`pnpm e2e` has been running for 12 min.',
  detail: 'pnpm e2e',
  hint: 'Run long commands under `timeout`.',
};
const slow: HealthSignal = { kind: 'no-progress', level: 'warn', reason: 'No change in 20 min.' };
const looping: HealthSignal = { kind: 'loop', level: 'bad', reason: 'The same call four times.' };

const chatOf = (id: string, over: Partial<ChatRuntime> = {}): ChatRuntime =>
  ({ id, name: `chat ${id}`, cwd: '/work', workingDir: '/work/tree', origin: 'claudio', orchestrationId: null, ...over }) as ChatRuntime;

const task: TaskContext = { orchestrationId: 'orch-1', taskId: 'build', taskName: 'Build it', limits: null, elapsedMs: 0, spentUsd: 0 };

const entry = (role: 'user' | 'assistant', blocks: TranscriptEntry['blocks'], isSidechain = false): TranscriptEntry => ({
  uuid: Math.random().toString(36),
  role,
  timestamp: null,
  model: null,
  isSidechain,
  parentToolUseId: null,
  blocks,
});

function harness(answer: (q: SupervisorQuestion) => SupervisorAnswer | Promise<SupervisorAnswer> = () => ({ text: 'Check the open socket.', costUsd: 0.002, isError: false })) {
  const config = tempConfig();
  const db = new Db(config);
  const settings = new DecisionSettingsStore(config, new DecisionCredentialStore(config));
  const asked: SupervisorQuestion[] = [];
  const events: ClaudioEventInput[] = [];
  const hints: SupervisorProposal[] = [];
  const charged: Array<[string, number]> = [];
  const cancelled: Array<{ proposal: SupervisorProposal; toolUseId: string }> = [];
  const cancel = { refuse: false };
  const clock = { now: Date.parse('2026-10-30T10:00:00Z') };
  const stepsAsked: Array<HealthSignal['agent']> = [];
  let steps: TranscriptEntry[] = [];
  const spend = { open: true };
  const supervisor = new Supervisor({
    spendOpen: () => spend.open,
    now: () => clock.now,
    roomRetryMs: 5,
    roomWaitMs: 2000,
    cancel: (proposal, toolUseId) => {
      if (cancel.refuse) return Promise.reject(new Error('the call is not a command that is running: it may have ended already'));
      cancelled.push({ proposal, toolUseId });
      return Promise.resolve();
    },
    settings,
    db,
    ask: async (q) => {
      asked.push(q);
      return answer(q);
    },
    steps: (_chatId, agent) => {
      stepsAsked.push(agent);
      return Promise.resolve(steps);
    },
    hint: (p) => {
      hints.push(p);
      return Promise.resolve();
    },
    emit: (e) => events.push(e),
    charge: (id, usd) => charged.push([id, usd]),
  });
  /** The point's mode is the Supervisor's switch; the CLI model and cap are the engine's */
  const enable = async (mode: DecisionMode = 'shadow', cli: Partial<typeof DEFAULT_DECISION_SETTINGS.cli> = {}) => {
    await settings.set({ ...structuredClone(DEFAULT_DECISION_SETTINGS), cli: { ...DEFAULT_DECISION_SETTINGS.cli, ...cli } });
    await settings.setPointMode('supervisor.intervene', mode);
  };
  return { config, db, settings, supervisor, asked, events, hints, charged, spend, enable, cancelled, cancel, clock, stepsAsked, setSteps: (s: TranscriptEntry[]) => (steps = s) };
}

test('the deprecated body maps onto the point\'s mode, and the view is derived from the point and the engine', async () => {
  assert.equal(supervisorModeOf({ enabled: false, autoSend: true }), 'off');
  assert.equal(supervisorModeOf({ enabled: true }), 'shadow');
  assert.equal(supervisorModeOf({ enabled: true, autoSend: false, model: 'opus', maxCostUsd: 4 }), 'shadow');
  assert.equal(supervisorModeOf({ enabled: true, autoSend: true }), 'active');
  assert.throws(() => supervisorModeOf({ enabled: 'yes' }), /enabled/);
  assert.throws(() => supervisorModeOf({ enabled: true, autoSend: 'sure' }), /autoSend/);
  assert.throws(() => supervisorModeOf([]), /JSON object/);

  const h = harness();
  // Off by default, with the engine's CLI model and the Supervisor's own cap
  assert.deepEqual(h.supervisor.config, { enabled: false, model: 'haiku', autoSend: false, maxCostUsd: 0.25 });
  await h.settings.setConsent('supervisor.intervene', { granted: true, stateVersion: 1, providers: ['jev'] });
  // The model and the cap of the body are ignored; the point keeps its threshold and consent
  assert.deepEqual(await h.supervisor.configure({ enabled: true, model: 'opus', autoSend: true, maxCostUsd: 4 }), { enabled: true, model: 'haiku', autoSend: true, maxCostUsd: 0.25 });
  const point = h.settings.get().points['supervisor.intervene'];
  assert.equal(point?.mode, 'active');
  assert.equal(point?.threshold, DEFAULT_THRESHOLD);
  assert.deepEqual(point?.consent?.providers, ['jev']);
  assert.equal((await h.supervisor.configure({ enabled: true, autoSend: false })).autoSend, false);
  assert.equal(h.settings.get().points['supervisor.intervene']?.mode, 'shadow');
  await h.supervisor.configure({ enabled: false, autoSend: true });
  assert.equal(h.settings.get().points['supervisor.intervene']?.mode, 'off');
  await assert.rejects(h.supervisor.configure({ enabled: 1 }), /enabled/);
  assert.equal(existsSync(join(h.config.dataDir, 'supervisor.json')), false, 'the file of the days before the point is never written');
});

// ---------- the one-time migration from supervisor.json ----------

/** A data directory with the given files, and the store over it */
function migrating(files: { supervisor?: unknown; decisions?: unknown }) {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const supervisorFile = join(config.dataDir, 'supervisor.json');
  const decisionsFile = join(config.dataDir, 'decisions.json');
  const write = (file: string, body: unknown) => writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  if (files.supervisor !== undefined) write(supervisorFile, files.supervisor);
  if (files.decisions !== undefined) write(decisionsFile, files.decisions);
  const store = new DecisionSettingsStore(config, new DecisionCredentialStore(config));
  const point = (): DecisionPointSettings | undefined => store.get().points['supervisor.intervene'];
  return { config, store, point, supervisorFile, decisionsFile };
}

const legacy = (enabled: boolean, autoSend: boolean) => ({ enabled, model: 'sonnet', autoSend, maxCostUsd: 0.5 });
const withPoint = (mode: DecisionMode) => ({
  ...DEFAULT_DECISION_SETTINGS,
  points: { 'supervisor.intervene': { mode, threshold: 0.9, consent: { at: '2026-10-01T00:00:00.000Z', stateVersion: 1, providers: ['jev'] } } },
});

test('the migration: disabled is Off, enabled is Shadow, enabled with autoSend is Active; the model and the cap stay behind', () => {
  for (const [enabled, autoSend, mode] of [
    [false, false, 'off'],
    [false, true, 'off'],
    [true, false, 'shadow'],
    [true, true, 'active'],
  ] as const) {
    const m = migrating({ supervisor: legacy(enabled, autoSend) });
    assert.equal(m.store.migrateSupervisor(), mode);
    assert.equal(m.point()?.mode, mode);
    assert.equal(m.point()?.threshold, DEFAULT_THRESHOLD);
    assert.deepEqual(m.store.get().cli, DEFAULT_DECISION_SETTINGS.cli, 'the engine keeps its own model and cap');
    assert.equal(m.store.supervisorMigrated(), true);
    assert.equal('supervisorMigrated' in m.store.get(), false, 'the mark is not part of what the API serves');
  }
});

test('the migration: a point the person set keeps its mode unless the Supervisor was disabled', () => {
  const kept = migrating({ supervisor: legacy(true, true), decisions: withPoint('shadow') });
  assert.equal(kept.store.migrateSupervisor(), 'shadow');
  assert.equal(kept.point()?.threshold, 0.9);
  assert.deepEqual(kept.point()?.consent?.providers, ['jev'], 'threshold and consent are left as they were');

  const activeKept = migrating({ supervisor: legacy(true, false), decisions: withPoint('active') });
  assert.equal(activeKept.store.migrateSupervisor(), 'active');

  const offTakesFile = migrating({ supervisor: legacy(true, true), decisions: withPoint('off') });
  assert.equal(offTakesFile.store.migrateSupervisor(), 'active', 'a point left Off takes the mode of the file');

  const disabled = migrating({ supervisor: legacy(false, false), decisions: withPoint('active') });
  assert.equal(disabled.store.migrateSupervisor(), 'off');
  assert.equal(disabled.point()?.mode, 'off');
});

test('the migration runs once, never writes supervisor.json, and a later save keeps its mark', async () => {
  const m = migrating({ supervisor: legacy(true, false) });
  const before = readFileSync(m.supervisorFile, 'utf8');
  const mtime = statSync(m.supervisorFile).mtimeMs;
  assert.equal(m.store.migrateSupervisor(), 'shadow');

  // The person moves the point; the file still says enabled, and is not read again
  await m.store.setPointMode('supervisor.intervene', 'off');
  assert.equal(m.store.migrateSupervisor(), null);
  assert.equal(m.point()?.mode, 'off');

  // A whole-document save and a consent keep the mark, so a restart does not fold the file in again
  await m.store.set({ ...structuredClone(DEFAULT_DECISION_SETTINGS), points: { 'supervisor.intervene': { mode: 'off' } } });
  await m.store.setConsent('supervisor.intervene', { granted: true, stateVersion: 1, providers: ['cli'] });
  const again = new DecisionSettingsStore(m.config, new DecisionCredentialStore(m.config));
  assert.equal(again.supervisorMigrated(), true);
  assert.equal(again.migrateSupervisor(), null);
  assert.equal(again.get().points['supervisor.intervene']?.mode, 'off');

  assert.equal(readFileSync(m.supervisorFile, 'utf8'), before);
  assert.equal(statSync(m.supervisorFile).mtimeMs, mtime);
});

test('the migration: no file is nothing to fold, a broken one reads as disabled, and a broken decisions.json waits', () => {
  const none = migrating({});
  assert.equal(none.store.migrateSupervisor(), null);
  assert.equal(existsSync(none.decisionsFile), false, 'a fresh install keeps the defaults unwritten');

  const broken = migrating({ supervisor: '{ not json' });
  assert.equal(broken.store.migrateSupervisor(), 'off');
  const badFields = migrating({ supervisor: { enabled: 'yes', autoSend: true } });
  assert.equal(badFields.store.migrateSupervisor(), 'off');

  const handBroken = migrating({ supervisor: legacy(true, true), decisions: '{ half' });
  assert.equal(handBroken.store.migrateSupervisor(), null);
  assert.equal(readFileSync(handBroken.decisionsFile, 'utf8'), '{ half', 'not overwritten at start');
});

test('Core folds supervisor.json into the point when it starts, and the Supervisor reads the point', () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(join(config.dataDir, 'supervisor.json'), JSON.stringify(legacy(true, true)));
  const core = new Core({ ...config, claudeBin: FAKE_CLAUDE });
  try {
    assert.equal(core.decisionSettings.get().points['supervisor.intervene']?.mode, 'active');
    assert.deepEqual(core.supervisor.config, { enabled: true, model: 'haiku', autoSend: true, maxCostUsd: 0.25 });
  } finally {
    core.shutdown();
  }
});

test('off, it asks nothing; on, a bad signal wakes it once per signal per chat', async () => {
  const h = harness();
  const chat = chatOf('c1');
  assert.equal(await h.supervisor.wake(chat, null, [hung]), null);
  assert.equal(h.asked.length, 0, 'off by default');

  await h.enable();
  assert.equal(await h.supervisor.wake(chat, null, [slow]), null);
  assert.equal(h.asked.length, 0, 'a warning is not what wakes it');

  const proposal = await h.supervisor.wake(chat, null, [hung, slow]);
  assert.equal(h.asked.length, 1);
  assert.equal(proposal?.signal, 'hung-command');
  assert.equal(proposal?.hint, 'Check the open socket.');
  assert.equal(proposal?.status, 'proposed');
  assert.equal(proposal?.costUsd, 0.002);
  assert.equal(proposal?.taskId, undefined);
  assert.deepEqual(h.db.proposalsOf('c1'), [proposal]);

  // The same signal again, however many times the badge changes, is not asked about again
  assert.equal(await h.supervisor.wake(chat, null, [hung]), null);
  assert.equal(h.asked.length, 1);
  // A second bad signal of the same chat is its own question, and so is the same signal on another chat
  assert.equal((await h.supervisor.wake(chat, null, [hung, looping]))?.signal, 'loop');
  assert.equal((await h.supervisor.wake(chatOf('c2'), null, [hung]))?.chatId, 'c2');
  assert.equal(h.asked.length, 3);
  assert.equal(h.charged.length, 0, 'a chat of no graph charges no graph');

  // Housekeeping is never supervised
  assert.equal(await h.supervisor.wake(chatOf('c3', { origin: 'internal' }), null, [hung]), null);
  assert.equal(h.asked.length, 3);
});

test('two announcements before the answer arrives ask once', async () => {
  let release: (a: SupervisorAnswer) => void = () => undefined;
  const h = harness(() => new Promise((r) => (release = r)));
  await h.enable();
  const first = h.supervisor.wake(chatOf('c1'), null, [hung]);
  const second = await h.supervisor.wake(chatOf('c1'), null, [hung]);
  assert.equal(second, null);
  await new Promise((r) => setImmediate(r));
  release({ text: 'Look at the port.', costUsd: 0.001, isError: false });
  assert.equal((await first)?.hint, 'Look at the port.');
  assert.equal(h.asked.length, 1);
});

test('the question carries the signal, the settings and the worker\'s last steps; the event names the task', async () => {
  const h = harness();
  await h.enable('shadow', { model: 'claude-haiku-4-5', maxCostUsd: 0.02, supervisorMaxCostUsd: 0.3 });
  const long = Array.from({ length: 20 }, (_, i) => `line ${String(i)}`).join('\n');
  h.setSteps([
    entry('assistant', [{ type: 'text', text: 'Running the suite.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm e2e' } }]),
    entry('user', [{ type: 'tool_result', toolUseId: 't1', content: long, isError: true }]),
    entry('assistant', [{ type: 'tool_use', id: 's1', name: 'Grep', input: { pattern: 'secret-of-a-subagent' } }], true),
    entry('assistant', [{ type: 'text', text: 'Trying again with more time.' }, { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'pnpm e2e --slow' } }]),
  ]);
  const chat = chatOf('w1', { orchestrationId: 'orch-1' });
  const proposal = await h.supervisor.wake(chat, task, [hung]);

  const [q] = h.asked;
  assert.equal(q?.model, 'claude-haiku-4-5');
  assert.equal(q?.maxCostUsd, 0.3, "the Supervisor's own cap, not a decision's");
  assert.equal(q?.cwd, '/work/tree');
  // The task's name and the worker's steps are marked as pasted content, with the note
  assert.match(q?.prompt ?? '', /The task, as it is named:\n<pasted_content id="([0-9a-f]{8})">\nBuild it\n<\/pasted_content id="\1">/);
  assert.match(q?.prompt ?? '', /Its last steps, as its transcript records them:\n<pasted_content id="([0-9a-f]{8})">\n- Bash/);
  assert.ok(q?.prompt.includes(PASTED_NOTE));
  assert.match(q?.prompt ?? '', /hung-command: `pnpm e2e` has been running for 12 min\./);
  assert.match(q?.prompt ?? '', /Claudio's generic suggestion: Run long commands/);
  assert.match(q?.prompt ?? '', /- Bash \{"command":"pnpm e2e"\}\n {2}failed: line 0\n/);
  assert.match(q?.prompt ?? '', /line 5\n {2}… \(14 more lines\)/);
  assert.doesNotMatch(q?.prompt ?? '', /line 6/, 'a result is cut to a few lines');
  assert.match(q?.prompt ?? '', /- Bash \{"command":"pnpm e2e --slow"\}\n {2}\(still running\)/);
  assert.match(q?.prompt ?? '', /Its last message:\nTrying again with more time\./);
  assert.doesNotMatch(q?.prompt ?? '', /secret-of-a-subagent/, 'subagents are not the worker');

  assert.equal(proposal?.taskId, 'build');
  assert.equal(proposal?.orchestrationId, 'orch-1');
  assert.deepEqual(h.charged, [['orch-1', 0.002]], 'its cost goes on the graph');
  const [event] = h.events;
  assert.equal(event?.type, 'supervisor.proposed');
  if (event?.type !== 'supervisor.proposed') return;
  assert.equal(event.taskId, 'build');
  assert.equal(event.taskName, 'Build it');
  assert.equal(event.runId, 'w1');
  assert.equal(event.orchestrationId, 'orch-1');
  assert.deepEqual(event.proposal, proposal);
  assert.match(event.title, /^Build it: /);
});

test('an answer that is no use records nothing, is not asked again, and still costs what it cost', async () => {
  let call = 0;
  const h = harness(() => (++call === 1 ? { text: 'budget exceeded', costUsd: 0.05, isError: true } : { text: '  \n ', costUsd: 0.01, isError: false }));
  await h.enable();
  assert.equal(await h.supervisor.wake(chatOf('w1'), task, [hung]), null);
  assert.equal(await h.supervisor.wake(chatOf('w1'), task, [hung]), null);
  assert.equal(h.asked.length, 1);
  assert.equal(await h.supervisor.wake(chatOf('w2'), task, [hung]), null, 'an empty answer is no hint');
  assert.deepEqual(h.charged, [['orch-1', 0.05], ['orch-1', 0.01]]);
  assert.deepEqual(h.db.proposalsOf('w1'), []);
  assert.equal(h.events.length, 0);

  // A question that throws is the same: no row, not asked again
  const broken = harness(() => {
    throw new Error('the CLI is not installed');
  });
  await broken.enable();
  assert.equal(await broken.supervisor.wake(chatOf('w1'), null, [hung]), null);
  assert.equal(await broken.supervisor.wake(chatOf('w1'), null, [hung]), null);
  assert.equal(broken.asked.length, 1);
});

test('a long answer is cut to the two lines a hint is', () => {
  assert.equal(hintFrom('\n  First line.  \n\nSecond line.\nThird line.'), 'First line.\nSecond line.');
  assert.equal(hintFrom('x'.repeat(1000)).length, 400);
  assert.equal(lastSteps([]), '(nothing recorded yet)');
});

test('send delivers the hint and marks it sent; dismiss marks it dismissed; each once, and only from its own chat or task', async () => {
  const h = harness();
  await h.enable();
  const chatProposal = await h.supervisor.wake(chatOf('c1'), null, [hung]);
  const taskProposal = await h.supervisor.wake(chatOf('w1'), task, [hung]);
  assert.ok(chatProposal && taskProposal);

  assert.throws(() => h.supervisor.dismiss(chatProposal.id, { chatId: 'other' }), /proposal not found/);
  await assert.rejects(h.supervisor.send(taskProposal.id, { orchestrationId: 'orch-1', taskId: 'other' }), /proposal not found/);
  await assert.rejects(h.supervisor.send('nope', { chatId: 'c1' }), /proposal not found/);

  const sent = await h.supervisor.send(chatProposal.id, { chatId: 'c1' });
  assert.equal(sent.status, 'sent');
  assert.deepEqual(h.hints.map((p) => p.id), [chatProposal.id]);
  assert.equal(h.db.proposal(chatProposal.id)?.status, 'sent');
  await assert.rejects(h.supervisor.send(chatProposal.id, { chatId: 'c1' }), (err) => err instanceof SupervisorConflictError && /already sent/.test(err.message));
  assert.throws(() => h.supervisor.dismiss(chatProposal.id, { chatId: 'c1' }), SupervisorConflictError);

  // A task's proposal is reachable from the board and from its worker's chat
  const dismissed = h.supervisor.dismiss(taskProposal.id, { orchestrationId: 'orch-1', taskId: 'build' });
  assert.equal(dismissed.status, 'dismissed');
  assert.equal(h.db.proposal(taskProposal.id)?.status, 'dismissed');
  assert.equal(h.hints.length, 1, 'a dismissed proposal reaches nobody');
  await assert.rejects(h.supervisor.send(taskProposal.id, { chatId: 'w1' }), /already dismissed/);

  // A hint that does not arrive leaves the proposal as it was
  const failing = harness();
  await failing.enable();
  const p = await failing.supervisor.wake(chatOf('c9'), null, [hung]);
  assert.ok(p);
  const refusing = new Supervisor({
    settings: failing.settings,
    db: failing.db,
    ask: () => Promise.reject(new Error('unused')),
    steps: () => Promise.resolve([]),
    hint: () => Promise.reject(new Error('The chat has no live process to nudge.')),
    emit: () => undefined,
    charge: () => undefined,
  });
  await assert.rejects(refusing.send(p.id, { chatId: 'c9' }), /no live process/);
  assert.equal(failing.db.proposal(p.id)?.status, 'proposed');
});

test('Active under the CLI sends every hint on its own; Shadow leaves each for a person', async () => {
  const h = harness();
  await h.enable('active');
  const proposal = await h.supervisor.wake(chatOf('c1'), null, [hung]);
  assert.equal(proposal?.status, 'sent');
  assert.equal(h.hints.length, 1);
  assert.equal(h.db.proposal(proposal?.id ?? '')?.status, 'sent');
  // The event said what was proposed, before it was sent
  assert.equal(h.events[0]?.type === 'supervisor.proposed' && h.events[0].proposal.status, 'proposed');

  await h.enable('shadow');
  assert.equal((await h.supervisor.wake(chatOf('c2'), null, [hung]))?.status, 'proposed');
  assert.equal(h.hints.length, 1);
});

test('a person who switches the point while the hint is drafted decides whether it is sent', async () => {
  let release: (a: SupervisorAnswer) => void = () => undefined;
  const h = harness(() => new Promise((r) => (release = r)));
  await h.enable('active');
  const woken = h.supervisor.wake(chatOf('c1'), null, [hung]);
  await new Promise((r) => setImmediate(r));
  await h.settings.setPointMode('supervisor.intervene', 'shadow');
  release({ text: 'Look at the port.', costUsd: 0.001, isError: false });
  assert.equal((await woken)?.status, 'proposed');
  assert.equal(h.hints.length, 0);
});

// ---------- through Core, with the fake CLI as both the worker and the supervisor ----------

async function until<T>(read: () => T | undefined | null | false | Promise<T | undefined | null | false>, what: string, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('a worker that turns bad gets a proposal from a read-only housekeeping chat, shown on its health and sent through the hint route', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const log = join(config.dataDir, 'spawns.log');
  process.env.FAKE_CLAUDE_SPAWNS = log;
  const core = new Core(config);
  const events: ClaudioEvent[] = [];
  core.events.subscribe((e) => events.push(e));
  const monitor = new HealthMonitor(
    {
      runtime: core.runtime,
      health: core.health,
      emit: (event) => core.events.emit(event),
      taskOf: () => null,
      onBad: (chat, t, signals) => void core.supervisor.wake(chat, t, signals),
    },
    0,
  );
  try {
    // The cap is the engine's Supervisor cap now; the body's own cap and a decision's are not it
    await core.decisionSettings.set({ ...structuredClone(DEFAULT_DECISION_SETTINGS), cli: { ...DEFAULT_DECISION_SETTINGS.cli, maxCostUsd: 0.03, supervisorMaxCostUsd: 0.4 } });
    await core.supervisor.configure({ enabled: true, model: 'opus', autoSend: false, maxCostUsd: 1 });
    const chat = core.runtime.start({ prompt: 'SLEEP 60' });
    await until(() => core.runtime.pulse(chat.id)?.commands[0], 'the command to start');

    monitor.check(Date.now() + 12 * 60_000);
    const proposed = await until(() => events.find((e) => e.type === 'supervisor.proposed'), 'the proposal', 15_000);
    assert.equal(proposed.type === 'supervisor.proposed' && proposed.runId, chat.id);
    monitor.check(Date.now() + 12 * 60_000 + 1000);
    monitor.check(Date.now() + 13 * 60_000);

    // The housekeeping chat: its own process, no transcript, the read-only preset, the ceiling as a flag
    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    const housekeeping = lines.filter((l) => l.includes('--no-session-persistence'));
    assert.equal(housekeeping.length, 1, 'asked once however many times the monitor looks');
    const argv = housekeeping[0]?.split(' ') ?? [];
    const flag = (name: string) => argv[argv.indexOf(name) + 1];
    assert.equal(flag('--model'), 'haiku');
    assert.equal(flag('--max-budget-usd'), '0.4');
    assert.ok(argv.some((a) => a.startsWith('--allowedTools=Read,Glob,Grep,')), argv.join(' '));
    // Confined like a decision's one-shot (C3): its preset's tools only, no settings file, no MCP server, nothing to ask
    assert.ok(argv.includes('--restricted'), argv.join(' '));
    assert.ok(argv.includes('--tools=Read,Glob,Grep,Bash'), argv.join(' '));
    assert.ok(argv.includes('--setting-sources='), argv.join(' '));
    assert.ok(argv.includes('--strict-mcp-config'), argv.join(' '));
    assert.equal(flag('--permission-mode'), 'dontAsk');
    assert.ok(!argv.includes('--settings'), 'and no guard');
    // Read-only, and like every run Claudio starts for a graph it may never push
    // The log splits argv on spaces, so the rule `Bash(git push *)` is read on the whole line
    assert.ok(housekeeping[0]?.includes(' --disallowedTools=Edit,Write,MultiEdit,NotebookEdit,Bash(git push),Bash(git push *) '), argv.join(' '));
    // It is gone once it answered: the proposal is its record
    await until(() => !core.runtime.list().some((r) => r.origin === 'internal'), 'the housekeeping chat to be removed');

    const [row] = core.db.proposalsOf(chat.id);
    assert.ok(row);
    assert.equal(row.costUsd, 0.01, 'the cost the CLI reported in its result');
    assert.match(row.hint, /^args=/, 'the fake answers with its own argv');

    // The chat's health carries it while the signal stands
    const health = core.health.read(chat.id, { state: 'working', lastEnded: null, context: null, failedBranches: 0 }, Date.now() + 12 * 60_000);
    assert.equal(health.level, 'bad');
    assert.equal(health.proposal?.id, row.id);
    const well = core.health.read(chat.id, { state: 'working', lastEnded: null, context: null, failedBranches: 0 });
    assert.equal(well.proposal, null, 'a chat that looks well shows no proposal');

    const sent = await core.supervisor.send(row.id, { chatId: chat.id });
    assert.equal(sent.status, 'sent');
    const said = core.runtime.events(chat.id).flatMap((e) => e.entry?.blocks ?? []).flatMap((b) => (b.type === 'text' ? [b.text] : []));
    assert.ok(said.some((t) => t.startsWith('A hint from the person following this chat') && t.includes(row.hint.slice(0, 40))));
  } finally {
    monitor.stop();
    core.shutdown();
    delete process.env.FAKE_CLAUDE_SPAWNS;
    if (existsSync(log)) writeFileSync(log, '');
  }
});

test('what the supervisor spends on a worker of a graph is added to the graph', () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const core = new Core(config);
  try {
    const orch = core.orchestrator.create({ name: 'g', cwd: config.workspaceDir, tasks: [{ id: 'a', name: 'A', prompt: 'hello' }] });
    const before = core.orchestrator.get(orch.id)?.costUsd ?? 0;
    core.orchestrator.chargeSupervisor(orch.id, 0.004);
    core.orchestrator.chargeSupervisor(orch.id, 0);
    core.orchestrator.chargeSupervisor('no-such-graph', 1);
    assert.equal(Math.round(((core.orchestrator.get(orch.id)?.costUsd ?? 0) - before) * 1000) / 1000, 0.004);
  } finally {
    core.shutdown();
  }
});

test('over the daily spend cap it makes no call, and asks about the signal once the cap lets go', async () => {
  const h = harness();
  const chat = chatOf('c1');
  await h.enable();
  h.spend.open = false;
  assert.equal(await h.supervisor.wake(chat, null, [hung]), null);
  assert.equal(h.asked.length, 0);
  assert.deepEqual(h.db.proposalsOf('c1'), [], 'a signal not asked about is not answered either');
  h.spend.open = true;
  assert.equal((await h.supervisor.wake(chat, null, [hung]))?.signal, 'hung-command');
  assert.equal(h.asked.length, 1);
});

// ---------- occurrences, the agent a signal names, room, and acting on a hung command (C3) ----------

const hungCall = (toolUseId: string, since = '2026-10-30T09:40:00.000Z'): HealthSignal => ({ ...hung, toolUseId, since });

test('one proposal per occurrence: a second hang of the same kind is a new question, the same one is not', async () => {
  const h = harness();
  await h.enable();
  const chat = chatOf('c1');
  const first = await h.supervisor.wake(chat, null, [hungCall('toolu_1')]);
  assert.equal(first?.occurrence, 'toolu_1');
  assert.equal(await h.supervisor.wake(chat, null, [hungCall('toolu_1')]), null, 'the same command is answered once');
  const second = await h.supervisor.wake(chat, null, [hungCall('toolu_2', '2026-10-30T09:55:00.000Z')]);
  assert.equal(second?.occurrence, 'toolu_2');
  assert.equal(h.asked.length, 2);
  assert.deepEqual(h.db.proposalsOf('c1').map((p) => p.occurrence).sort(), ['toolu_1', 'toolu_2']);
  // A stall run that ends on the command already answered is the same thing to act on, not a second
  assert.equal(await h.supervisor.wake(chat, null, [{ kind: 'repeat-stall', level: 'bad', reason: 'pnpm e2e hung 3 times', toolUseId: 'toolu_2', since: '2026-10-30T09:00:00.000Z' }]), null);
  assert.equal(h.asked.length, 2);
});

test('a proposal kept before occurrences were keyed holds its kind for that occurrence only', async () => {
  const h = harness();
  await h.enable();
  const legacy: SupervisorProposal = { id: 'old', chatId: 'c1', signal: 'hung-command', hint: 'Stop the suite.', costUsd: 0.01, at: '2026-10-29T10:00:00.000Z', status: 'sent' };
  assert.ok(h.db.saveProposal(legacy));
  assert.equal(h.db.proposal('old')?.occurrence, undefined, 'read back as it was stored');
  assert.equal((await h.supervisor.wake(chatOf('c1'), null, [hungCall('toolu_9')]))?.occurrence, 'toolu_9', 'a new hang of a long chat is asked about');
});

test('a question that failed is asked again once fifteen minutes have passed, not before', async () => {
  let call = 0;
  const h = harness(() => (++call === 1 ? { text: '', costUsd: 0.01, isError: true } : { text: 'Kill the stale server.', costUsd: 0.01, isError: false }));
  await h.enable();
  const signal = hungCall('toolu_1');
  assert.equal(await h.supervisor.wake(chatOf('c1'), null, [signal]), null);
  h.clock.now += 14 * 60_000;
  assert.equal(await h.supervisor.wake(chatOf('c1'), null, [signal]), null);
  assert.equal(h.asked.length, 1);
  h.clock.now += 2 * 60_000;
  assert.equal((await h.supervisor.wake(chatOf('c1'), null, [signal]))?.hint, 'Kill the stale server.');
  assert.equal(h.asked.length, 2);
});

test('a question refused for room, a full slot or short memory, is retried and never counted as failed', async () => {
  let call = 0;
  const h = harness(() => {
    call += 1;
    if (call === 1) throw new RunSlotRefusal(4);
    if (call === 2) throw new MemoryRefusal('Not enough memory to start a chat: 300 MB available, below the 512 MB floor');
    return { text: 'Check the port.', costUsd: 0.01, isError: false };
  });
  await h.enable();
  const proposal = await h.supervisor.wake(chatOf('c1'), null, [hungCall('toolu_1')]);
  assert.equal(proposal?.hint, 'Check the port.');
  assert.equal(h.asked.length, 3);

  // No room in time: nothing is recorded, and the next announcement asks again
  const full = harness(() => {
    throw new RunSlotRefusal(4);
  });
  await full.enable();
  // The wait is measured on the Supervisor's clock: each try moves it on, so the deadline comes without a real wait
  const tick = setInterval(() => (full.clock.now += 500), 1);
  try {
    assert.equal(await full.supervisor.wake(chatOf('c1'), null, [hungCall('toolu_1')]), null);
    const tries = full.asked.length;
    assert.ok(tries >= 2, `retried while it waited (${String(tries)} tries)`);
    assert.equal(await full.supervisor.wake(chatOf('c1'), null, [hungCall('toolu_1')]), null);
    assert.ok(full.asked.length > tries, 'not held as failed');
    assert.deepEqual(full.db.proposalsOf('c1'), []);
  } finally {
    clearInterval(tick);
  }
});

test('Active cancels a hung command with the hint as the reason, and sends the hint only when the cancel is refused', async () => {
  const h = harness(() => ({ text: 'The suite waits on port 5432; start the database first.', costUsd: 0.01, isError: false }));
  await h.enable('active');
  const proposal = await h.supervisor.wake(chatOf('c1'), null, [hungCall('toolu_1')]);
  assert.equal(proposal?.status, 'sent');
  assert.deepEqual(
    h.cancelled.map((c) => [c.toolUseId, c.proposal.hint]),
    [['toolu_1', 'The suite waits on port 5432; start the database first.']],
  );
  assert.equal(h.hints.length, 0, 'the cancel carried it: no message besides');
  assert.equal(h.db.proposal(proposal?.id ?? '')?.status, 'sent');

  h.cancel.refuse = true;
  const refused = await h.supervisor.wake(chatOf('c1'), null, [hungCall('toolu_2')]);
  assert.equal(refused?.status, 'sent');
  assert.equal(h.cancelled.length, 1);
  assert.deepEqual(h.hints.map((p) => p.id), [refused?.id]);

  // A signal that is not about one running command is a message, as before
  const looped = await h.supervisor.wake(chatOf('c1'), null, [looping]);
  assert.equal(looped?.status, 'sent');
  assert.equal(h.cancelled.length, 1);
  assert.equal(h.hints.length, 2);

  // Shadow cancels nothing: a person decides
  await h.enable('shadow');
  h.cancel.refuse = false;
  assert.equal((await h.supervisor.wake(chatOf('c1'), null, [hungCall('toolu_3')]))?.status, 'proposed');
  assert.equal(h.cancelled.length, 1);
});

test("a signal about a subagent's call reads that agent's steps and asks the lead to relay the hint or stop it", async () => {
  const h = harness(() => ({ text: 'Run the grep on src/ only.', costUsd: 0.01, isError: false }));
  await h.enable('active');
  h.cancel.refuse = true;
  const agent = { parentToolUseId: 'toolu_agent', description: 'Audit the CLI bundle', subagentType: 'Explore' };
  const sub = (blocks: TranscriptEntry['blocks']): TranscriptEntry => ({ ...entry('assistant', blocks, true), parentToolUseId: 'toolu_agent' });
  h.setSteps([
    entry('assistant', [{ type: 'tool_use', id: 'lead1', name: 'Bash', input: { command: 'lead-only-step' } }]),
    sub([{ type: 'tool_use', id: 's1', name: 'Bash', input: { command: 'grep -r x /usr/lib/node_modules' } }]),
    { ...entry('assistant', [{ type: 'tool_use', id: 'o1', name: 'Read', input: { file_path: 'another-agent-step' } }], true), parentToolUseId: 'toolu_other' },
  ]);
  const signal: HealthSignal = { ...hungCall('s1'), detail: 'grep -r x /usr/lib/node_modules', agent };
  const proposal = await h.supervisor.wake(chatOf('c1'), null, [signal]);

  assert.deepEqual(h.stepsAsked, [agent], 'the steps of that agent were asked for');
  const prompt = h.asked[0]?.prompt ?? '';
  assert.match(prompt, /a subagent the agent launched \(type Explore\), described as:\n<pasted_content id="([0-9a-f]{8})">\nAudit the CLI bundle\n/);
  assert.match(prompt, /- Bash \{"command":"grep -r x \/usr\/lib\/node_modules"\}/);
  assert.doesNotMatch(prompt, /lead-only-step|another-agent-step/, "only that agent's own steps");
  assert.match(prompt, /Write a hint for the subagent/);

  assert.ok(proposal);
  assert.deepEqual(proposal.agent, agent);
  assert.match(proposal.hint, /^Your background agent `Audit the CLI bundle` is stuck\. Relay this to it with SendMessage, or stop it/);
  assert.ok(proposal.hint.endsWith('Run the grep on src/ only.'));
  // What the lead was sent, and what the store reads back
  assert.equal(h.hints[0]?.hint, proposal.hint);
  assert.deepEqual(h.db.proposal(proposal.id)?.agent, agent);
});

test('lastSteps reads the lead alone by default, and one subagent when asked', () => {
  const lead = entry('assistant', [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'lead' } }]);
  const sub = { ...entry('assistant', [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'sub' } }], true), parentToolUseId: 'p1' };
  assert.match(lastSteps([lead, sub]), /"lead"/);
  assert.doesNotMatch(lastSteps([lead, sub]), /"sub"/);
  assert.match(lastSteps([lead, sub], 'p1'), /"sub"/);
  assert.doesNotMatch(lastSteps([lead, sub], 'p1'), /"lead"/);
  assert.equal(relayHint({ parentToolUseId: 'p1' }, 'x'), 'Your background agent `p1` is stuck. Relay this to it with SendMessage, or stop it if it cannot get past it: x');
});

test('the store keeps one row per occurrence of a signal per chat', () => {
  const h = harness();
  const row = (id: string, occurrence: string): SupervisorProposal => ({ id, chatId: 'c1', signal: 'hung-command', occurrence, hint: 'h', costUsd: 0, at: '2026-10-30T10:00:00.000Z', status: 'proposed' });
  assert.equal(h.db.saveProposal(row('a', 'toolu_1')), true);
  assert.equal(h.db.saveProposal(row('b', 'toolu_1')), false);
  assert.equal(h.db.saveProposal(row('c', 'toolu_2')), true);
});
