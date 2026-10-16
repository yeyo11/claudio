import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { DecisionRecord, Execution, ProviderMove } from '@claudio/shared';
import type { LegacyRun, StoredChat } from '../src/chat-records.ts';
import { CHAT_ENTRIES_SCHEMA_VERSION, CONTEXT_CONTROL_SCHEMA_VERSION, type HousekeepingClaim, PROVIDER_ROTATION_SCHEMA_VERSION,CHAT_PROVIDER_SCHEMA_VERSION, CHECKS_SCHEMA_VERSION, CODE_HOSTS_SCHEMA_VERSION, Db, DECISION_SIGNALS_SCHEMA_VERSION as MIGRATIONS_WITH_SIGNALS, ISSUE_SCOPE_SCHEMA_VERSION, ISSUES_SCHEMA_VERSION, JEV_COST_SCHEMA_VERSION, MERGES_SCHEMA_VERSION, migrate, RENAME_SCHEMA_VERSION, REVIEW_GATE_SCHEMA_VERSION, REVIEWS_SCHEMA_VERSION, SPEND_SCHEMA_VERSION, WORK_ITEMS_SCHEMA_VERSION } from '../src/db.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { orchestrationPullRequestOf, type OrchestrationPullRequestRow } from '../src/orchestration-pr-rows.ts';
import { changeRequestMergeOf, pullRequestOf, reviewDraftOf, reviewPostOf, type ChangeRequestMergeRow, type PullRequestRow, type ReviewDraftRow, type ReviewPostRow } from '../src/work-item-rows.ts';
import { ChatManager } from '../src/chats.ts';
import { SessionStore } from '../src/sessions.ts';
import { tempConfig } from './helpers.ts';

const at = (minute: number) => `2026-09-18T20:${String(minute).padStart(2, '0')}:00.000Z`;

const execution = (id: string, startedAt: string, extra: Partial<Execution> = {}): Execution => ({
  id,
  startedAt,
  endedAt: startedAt,
  outcome: 'completed',
  error: null,
  permissionMode: 'plan',
  model: null,
  maxBudgetUsd: null,
  costUsd: 0.5,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
  turns: 1,
  ...extra,
});

const chat = (id: string, createdAt: string, executions: Execution[] = [execution(`${id}-1`, createdAt)]): StoredChat => ({
  record: {
    id,
    name: id,
    cwd: '/tmp',
    workingDir: null,
    origin: 'claudio',
    orchestrationId: null,
    orchestrationTaskId: null,
    derivedFrom: null,
    prompt: 'hi',
    lastText: 'ok',
    model: null,
    permissionMode: 'plan',
    permissionPrompts: 'none',
    createdAt,
    updatedAt: createdAt,
  },
  executions,
});

/** A run as the wrapper stored it before a run became an execution of a chat. */
const legacyRun = (id: string, sessionId: string | null, createdAt: string, extra: Partial<LegacyRun> = {}): LegacyRun => ({
  id,
  name: id,
  sessionId,
  cwd: '/tmp',
  model: null,
  permissionMode: 'plan',
  status: 'completed',
  createdAt,
  updatedAt: createdAt,
  endedAt: createdAt,
  turns: 1,
  costUsd: 0.25,
  prompt: 'hi',
  lastText: 'ok',
  error: null,
  orchestrationId: null,
  orchestrationTaskId: null,
  internal: false,
  account: null,
  ...extra,
});

test('the labels table keeps no index nothing queries, on a new database or an upgraded one', () => {
  const indexes = (db: DatabaseSync) =>
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'work_item_labels' AND sql IS NOT NULL").all() as Array<{ name: string }>).map((i) => i.name);
  const fresh = new Db(tempConfig());
  assert.deepEqual(indexes(fresh.connection), []);
  fresh.close();

  const old = new DatabaseSync(':memory:');
  migrate(old, WORK_ITEMS_SCHEMA_VERSION);
  assert.deepEqual(indexes(old), ['work_item_labels_label']);
  migrate(old);
  assert.deepEqual(indexes(old), []);
  old.close();
});

test('chats stored before the provider column read as claude-code after the migration', () => {
  const raw = new DatabaseSync(':memory:');
  migrate(raw, CHAT_PROVIDER_SCHEMA_VERSION - 1);
  const old = chat('old', '2026-09-18T10:00:00Z');
  raw.prepare('INSERT INTO chats (id, created_at, json) VALUES (?, ?, ?)').run('old', old.record.createdAt, JSON.stringify(old.record));
  migrate(raw);
  const row = raw.prepare('SELECT provider FROM chats WHERE id = ?').get('old') as { provider: string };
  assert.equal(row.provider, 'claude-code');
  // A process still on the old schema writes no column, and SQLite fills the default
  raw.prepare('INSERT INTO chats (id, created_at, json) VALUES (?, ?, ?)').run('older-writer', old.record.createdAt, JSON.stringify(old.record));
  assert.equal((raw.prepare('SELECT provider FROM chats WHERE id = ?').get('older-writer') as { provider: string }).provider, 'claude-code');
  raw.close();
});

test('the provider column is the truth for a chat, and a record without one is claude-code', () => {
  const db = new Db(tempConfig());
  const other = chat('other', '2026-09-18T11:00:00Z');
  other.record.provider = 'codex';
  db.saveChats([chat('plain', '2026-09-18T10:00:00Z'), other], null);
  const byId = new Map(db.loadChats().map((c) => [c.record.id, c.record.provider]));
  assert.equal(byId.get('plain'), 'claude-code');
  assert.equal(byId.get('other'), 'codex');
  // Changed in the column alone, the JSON copy follows it
  db.connection.prepare("UPDATE chats SET provider = 'claude-code' WHERE id = 'other'").run();
  assert.equal(db.loadChats().find((c) => c.record.id === 'other')?.record.provider, 'claude-code');
  db.close();
});

test('two processes upgrading an old database at once never run a migration twice', async () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  // A database as the release before the work items left it, so several migrations are pending
  const raw = new DatabaseSync(join(config.dataDir, 'wrapper.db'));
  raw.exec('PRAGMA busy_timeout = 5000');
  raw.exec('PRAGMA journal_mode = WAL');
  migrate(raw, WORK_ITEMS_SCHEMA_VERSION - 1);
  // This process takes the write lock first, and keeps it until the other one is waiting on it
  raw.exec('BEGIN IMMEDIATE');
  const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'db-opener.ts');
  const child = spawn(process.execPath, [...process.execArgv, fixture, dirname(config.dataDir)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  await new Promise<void>((resolve) => child.stdout.on('data', () => resolve()));
  await new Promise((r) => setTimeout(r, 400));
  raw.exec('COMMIT');
  migrate(raw);

  assert.equal(await exited, 0, stderr);
  const version = raw.prepare('PRAGMA user_version').get() as { user_version: number };
  const fresh = new Db({ ...config });
  assert.equal(fresh.connection.prepare('PRAGMA user_version').get()?.user_version, version.user_version);
  fresh.close();
  raw.close();
});

test('chats round-trip with their executions, newest first, and the cap drops the oldest with theirs', () => {
  const db = new Db(tempConfig());
  db.saveChats([chat('a', '2026-09-18T10:00:00Z'), chat('b', '2026-09-18T11:00:00Z', [execution('b-1', '2026-09-18T11:00:00Z'), execution('b-2', '2026-09-18T11:30:00Z', { turns: 4 })])], 200);
  assert.deepEqual(
    db.loadChats().map((c) => c.record.id),
    ['b', 'a'],
  );
  // The history of one chat is what it says, oldest first, however often it was saved
  assert.deepEqual(db.loadChats()[0]?.executions.map((e) => [e.id, e.turns]), [['b-1', 1], ['b-2', 4]]);

  db.saveChats([chat('c', '2026-09-18T12:00:00Z')], 2);
  assert.deepEqual(
    db.loadChats().map((c) => c.record.id),
    ['c', 'b'],
  );

  db.deleteChat('c');
  assert.deepEqual(
    db.loadChats().map((c) => c.record.id),
    ['b'],
  );
  db.close();
});

test('a save of only what changed keeps the executions it leaves out, and trims nothing unless asked', () => {
  const db = new Db(tempConfig());
  db.saveChats([chat('a', '2026-09-18T10:00:00Z', [execution('a-1', '2026-09-18T10:00:00Z')]), chat('b', '2026-09-18T11:00:00Z')], 200);
  db.saveChats([chat('a', '2026-09-18T10:00:00Z', [execution('a-2', '2026-09-18T10:30:00Z')])], null);
  assert.deepEqual(db.loadChats().find((c) => c.record.id === 'a')?.executions.map((e) => e.id), ['a-1', 'a-2']);
  db.saveChats([chat('c', '2026-09-18T12:00:00Z')], null);
  assert.equal(db.loadChats().length, 3);
  db.saveChats([chat('d', '2026-09-18T13:00:00Z')], 3);
  assert.deepEqual([...db.storedChats(['a', 'b', 'c', 'd'])].sort(), ['b', 'c', 'd']);
  db.close();
});

test('saving a chat again updates its executions in place instead of adding a second history', () => {
  const db = new Db(tempConfig());
  const live = execution('e1', '2026-09-18T10:00:00Z', { endedAt: null, outcome: null, costUsd: null });
  db.saveChats([chat('a', '2026-09-18T10:00:00Z', [live])], 200);
  db.saveChats([chat('a', '2026-09-18T10:00:00Z', [{ ...live, endedAt: '2026-09-18T10:05:00Z', outcome: 'completed', costUsd: 0.3 }])], 200);

  const [stored] = db.loadChats();
  assert.equal(stored?.executions.length, 1);
  assert.deepEqual([stored?.executions[0]?.outcome, stored?.executions[0]?.costUsd], ['completed', 0.3]);
  db.close();
});

test('a save never drops the chats another process owns', () => {
  const config = tempConfig();
  const a = new Db(config);
  const b = new Db(config);
  a.saveChats([chat('from-a', '2026-09-18T10:00:00Z')], 200);
  // b knows nothing about a's chat — the old whole-file write erased it here
  b.saveChats([chat('from-b', '2026-09-18T11:00:00Z')], 200);
  assert.deepEqual(
    a.loadChats().map((c) => c.record.id),
    ['from-b', 'from-a'],
  );
  a.close();
  b.close();
});

test('a pre-SQLite runs.json is carried into the store once, as chats', async () => {
  const config = tempConfig();
  const legacy = join(config.dataDir, 'runs.json');
  writeFileSync(legacy, JSON.stringify([legacyRun('old', 'session-old', '2026-09-18T09:00:00Z')]));

  const db = new Db(config);
  const manager = new ChatManager(config, db);
  await manager.restore(new SessionStore(config));

  assert.deepEqual(
    manager.list().map((r) => r.id),
    ['session-old'],
  );
  assert.deepEqual(
    db.loadChats().map((c) => c.record.id),
    ['session-old'],
  );
  // Renamed away, so a second boot cannot resurrect chats the user deleted since
  assert.equal(existsSync(legacy), false);
  assert.equal(existsSync(`${legacy}.migrated`), true);
  db.close();
});

test('a planner draft outlives the response that was supposed to carry it', () => {
  const config = tempConfig();
  const first = new Db(config);
  first.savePlanDraft('run-1', {
    name: 'refactor-auth',
    objective: 'Split the auth module',
    tasks: [
      { id: 'a', name: 'A', prompt: 'do a', dependsOn: [] },
      { id: 'b', name: 'B', prompt: 'do b', dependsOn: ['a'] },
    ],
  });
  first.close();

  // A new process: the run itself is gone (planner runs are internal), the plan is not
  const second = new Db(config);
  const stored = second.planDraft('run-1');
  assert.equal(stored?.name, 'refactor-auth');
  assert.equal(stored?.tasks.length, 2);
  assert.equal(second.planDraft('missing'), null);

  const listed = second.planDrafts();
  assert.deepEqual(
    listed.map((d) => [d.runId, d.taskCount, d.objective]),
    [['run-1', 2, 'Split the auth module']],
  );

  // Re-reading the same run replaces the row rather than duplicating it
  second.savePlanDraft('run-1', { name: 'refactor-auth', tasks: [{ id: 'a', name: 'A', prompt: 'do a', dependsOn: [] }] });
  assert.equal(second.planDrafts().length, 1);
  assert.equal(second.planDrafts()[0]?.taskCount, 1);
  second.close();
});

test('an internal chat survives a restart, because the planner is one', async () => {
  const config = tempConfig();
  const db = new Db(config);
  // What the orchestration planner looks like in the store: internal, but real paid work
  const planner = chat('planner', '2026-09-18T20:57:00Z');
  db.saveChats([{ ...planner, record: { ...planner.record, name: 'orchestration-planner', origin: 'internal' } }], 200);

  const manager = new ChatManager(config, db);
  await manager.restore(new SessionStore(config));
  const restored = manager.list();
  assert.equal(restored.length, 1);
  assert.equal(restored[0]?.name, 'orchestration-planner');
  assert.equal(restored[0]?.origin, 'internal');
  db.close();
});

test('an orchestration stored before a field existed still schedules', () => {
  const config = tempConfig();
  const db = new Db(config);
  // Exactly what was on disk: written before `worktree` and `allowedTools` were added
  db.saveOrchestrations([
    {
      id: 'old-1',
      name: 'legacy',
      objective: null,
      status: 'stopped',
      cwd: '/tmp',
      model: null,
      permissionMode: 'acceptEdits',
      concurrency: 3,
      synthesize: false,
      createdAt: '2026-09-18T21:21:39.941Z',
      endedAt: '2026-09-18T21:34:05.149Z',
      finalResult: null,
      costUsd: 1.71,
      tasks: [],
    } as unknown as Parameters<Db['saveOrchestrations']>[0][number],
  ]);

  const orchestrator = new Orchestrator(config, new ChatManager(config, db), db);
  const loaded = orchestrator.get('old-1');
  // Reading `.length` off an absent array threw inside launch(), where a bare catch swallowed it
  // and retried every three seconds for ever: the graph reported itself running with nothing running.
  assert.deepEqual(loaded?.allowedTools, []);
  assert.equal(loaded?.worktree, false);
  db.close();
});

test('what Claude loaded in a directory survives a restart', () => {
  const config = tempConfig();
  const first = new Db(config);
  first.saveEnvironment({
    cwd: '/work/app',
    observedAt: '2026-01-01T10:00:00Z',
    chatId: 'r1',
    cliVersion: '2.1.277',
    model: 'claude-opus-5',
    permissionMode: 'acceptEdits',
    outputStyle: null,
    tools: ['Bash', 'Edit'],
    mcpServers: [{ name: 'docs', status: 'connected' }],
    agents: [],
    skills: [],
    plugins: [],
    slashCommands: [],
    memoryPaths: {},
  } as unknown as Parameters<Db['saveEnvironment']>[0]);
  first.close();

  // The init event that carried this is gone after a restart, and the transcript never had it
  const loaded = new Db(config).loadEnvironments();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.cwd, '/work/app');
  assert.deepEqual(loaded[0]?.tools, ['Bash', 'Edit']);
});

function decisionRow(id: string, over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id,
    point: 'run.continuation',
    kind: 'act',
    projectId: 'p1',
    subjectKind: 'flow_run',
    subjectId: 'r1',
    provider: 'jev',
    model: 'jev-1.13.0',
    mode: 'active',
    status: 'answered',
    unavailable: null,
    state: { open: 2 },
    questions: [],
    answers: null,
    confidence: 0.9,
    threshold: 0.85,
    acted: true,
    visible: false,
    savedRun: true,
    latencyMs: 120,
    inputTokens: 40,
    costUsd: 0.01,
    outcome: null,
    agreed: null,
    resolvedAt: null,
    feedback: null,
    feedbackAt: null,
    openedAt: null,
    paletteAction: null,
    at: at(1),
    ...over,
  };
}

test('decisions round-trip, resolve once, and let feedback outrank the inference', () => {
  const db = new Db(tempConfig());
  db.insertDecision(decisionRow('d1'));
  assert.deepEqual(db.decision('d1'), decisionRow('d1'));

  assert.equal(db.resolveDecision('d1', { summary: 'ran', agreed: true }, at(2)), true);
  assert.equal(db.resolveDecision('d1', { summary: 'again', agreed: false }, at(3)), false);
  assert.equal(db.decision('d1')?.agreed, true);
  assert.equal(db.decision('d1')?.outcome?.summary, 'ran');

  assert.equal(db.setDecisionFeedback('d1', 'not_useful', at(4)), true);
  assert.equal(db.decision('d1')?.agreed, false);
  assert.equal(db.setDecisionFeedback('nope', 'useful', at(4)), false);

  db.insertDecision(decisionRow('d2'));
  db.setDecisionFeedback('d2', 'useful', at(5));
  db.resolveDecision('d2', { summary: 'x', agreed: false }, at(6));
  assert.equal(db.decision('d2')?.agreed, true);
  // The person's word is a resolution too, so the stats count the row as resolved
  assert.equal(db.decision('d2')?.resolvedAt, at(5));
  assert.equal(db.decision('d1')?.resolvedAt, at(2));
  db.close();
});

test('an older database migrates with the decisions signals empty, and a new row keeps them', () => {
  const version = MIGRATIONS_WITH_SIGNALS;
  const old = new DatabaseSync(':memory:');
  migrate(old, version - 1);
  old.exec(
    `INSERT INTO decisions (id, point, kind, subject_kind, provider, model, mode, status, state, questions, acted, visible, saved_run, latency_ms, at)
     VALUES ('old', 'palette.intent', 'suggest', 'palette', 'jev', 'm', 'shadow', 'answered', '{}', '[]', 0, 0, 0, 1, '2026-01-01T00:00:00.000Z')`,
  );
  migrate(old);
  const columns = (old.prepare('PRAGMA table_info(decisions)').all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(columns.includes('opened_at') && columns.includes('palette_action'));
  const row = old.prepare('SELECT opened_at, palette_action FROM decisions WHERE id = ?').get('old');
  assert.deepEqual({ ...row }, { opened_at: null, palette_action: null });
  old.close();
});

test('the palette action classifies against the answer and the first report stands', () => {
  const db = new Db(tempConfig());
  const answered = (id: string) => decisionRow(id, { point: 'palette.intent', subjectKind: 'palette', subjectId: null, answers: { command: { kind: 'choice', value: 'go.home', probabilities: null, confidence: 1 } } });
  for (const id of ['a', 'b', 'c']) db.insertDecision(answered(id));
  assert.equal(db.setDecisionPaletteAction('a', 'go.home', at(2))?.paletteAction?.action, 'proposed');
  assert.equal(db.setDecisionPaletteAction('b', 'chat.new', at(2))?.paletteAction?.action, 'other');
  assert.deepEqual(db.setDecisionPaletteAction('c', null, at(2))?.paletteAction, { action: 'dismissed', commandId: null, at: at(2) });
  assert.equal(db.setDecisionPaletteAction('a', null, at(3))?.paletteAction?.action, 'proposed');
  assert.equal(db.setDecisionPaletteAction('nope', null, at(3)), null);
  db.close();
});

test('a notification open marks the newest row for its key once', () => {
  const db = new Db(tempConfig());
  const push = (id: string, when: number) => decisionRow(id, { point: 'notification.urgency', subjectKind: 'notification', subjectId: 'k1', at: at(when) });
  db.insertDecision(push('n1', 1));
  db.insertDecision(push('n2', 2));
  assert.equal(db.markNotificationOpened('k1', at(5)), 'n2');
  assert.equal(db.markNotificationOpened('k1', at(9)), 'n2');
  assert.equal(db.decision('n2')?.openedAt, at(5));
  assert.equal(db.decision('n1')?.openedAt, null);
  assert.equal(db.markNotificationOpened('other', at(9)), null);
  db.close();
});

test('decisions page newest first, filter, and report stats', () => {
  const db = new Db(tempConfig());
  db.insertDecision(decisionRow('a', { at: at(1) }));
  db.insertDecision(decisionRow('b', { at: at(2), provider: 'cli', model: 'haiku', confidence: null, acted: false, costUsd: 0.02, projectId: null }));
  db.insertDecision(decisionRow('c', { at: at(3), projectId: null, point: 'palette.intent', status: 'unavailable', unavailable: 'timeout', confidence: null, acted: false, savedRun: false, costUsd: null }));

  const first = db.listDecisions({ limit: 2 });
  assert.deepEqual(first.items.map((d) => d.id), ['c', 'b']);
  assert.ok(first.nextCursor);
  const second = db.listDecisions({ limit: 2, ...(first.nextCursor ? { cursor: first.nextCursor } : {}) });
  assert.deepEqual(second.items.map((d) => d.id), ['a']);
  assert.equal(second.nextCursor, null);

  assert.deepEqual(db.listDecisions({ provider: 'cli' }).items.map((d) => d.id), ['b']);
  assert.deepEqual(db.listDecisions({ point: 'palette.intent', status: 'unavailable' }).items.map((d) => d.id), ['c']);
  assert.deepEqual(db.listDecisions({ since: at(2), until: at(2) }).items.map((d) => d.id), ['b']);
  assert.deepEqual(db.listDecisions({ projectId: 'p1' }).items.map((d) => d.id), ['a']);
  db.insertDecision(decisionRow('s', { at: at(4), subjectKind: 'work_item', subjectId: 'w1', visible: true }));
  assert.deepEqual(db.listDecisions({ subjectKind: 'work_item', subjectId: 'w1', visible: true }).items.map((d) => d.id), ['s']);
  assert.deepEqual(db.listDecisions({ subjectId: 'w1', visible: true }).items.length, 1);
  db.deleteDecision('s');

  const stats = db.decisionStats(at(0));
  const run = stats.points.find((p) => p.point === 'run.continuation');
  assert.equal(run?.count, 2);
  assert.equal(run?.acted, 1);
  assert.equal(run?.runsSaved, 1);
  assert.equal(run?.meanConfidence, 0.9);
  assert.equal(stats.points.find((p) => p.point === 'palette.intent')?.unavailable, 1);
  assert.equal(stats.claudeRunsSaved, 1);
  assert.equal(stats.jevCostUsd, 0.01);
  assert.equal(db.decisionStats(at(3)).points.length, 1);
  db.close();
});

test('decisions delete one, clear a filtered set, and prune by age', () => {
  const db = new Db(tempConfig());
  db.insertDecision(decisionRow('a', { at: at(1) }));
  db.insertDecision(decisionRow('b', { at: at(2), provider: 'cli' }));
  db.insertDecision(decisionRow('c', { at: at(3) }));
  assert.equal(db.deleteDecision('a'), true);
  assert.equal(db.deleteDecision('a'), false);
  assert.equal(db.clearDecisions({ provider: 'cli' }), 1);
  assert.equal(db.pruneDecisions(at(3)), 0);
  assert.equal(db.pruneDecisions(at(4)), 1);
  db.insertDecision(decisionRow('d'));
  assert.equal(db.clearDecisions(), 1);
  assert.equal(db.listDecisions().items.length, 0);
  db.close();
});

test('pull requests stored before the code hosts read as github, with a ref, and the new tables exist', () => {
  const raw = new DatabaseSync(':memory:');
  // The rows below name no parent: the test is about columns and indexes, not the work item's own rows
  raw.exec('PRAGMA foreign_keys = OFF');
  migrate(raw, CODE_HOSTS_SCHEMA_VERSION - 1);
  const insert = raw.prepare(
    `INSERT INTO work_item_pull_requests (id, item_id, project_id, phase, number, branch, base, approved_at, created_at, updated_at)
     VALUES (?, 'i', 'p', 'open', 12, 'claudio-task/CW-1', 'main', ?, ?, ?)`,
  );
  insert.run('old', at(1), at(1), at(1));
  migrate(raw);
  const row = raw.prepare('SELECT * FROM work_item_pull_requests WHERE id = ?').get('old') as unknown as PullRequestRow;
  assert.equal(row.host, 'github');
  assert.equal(row.hostname, null);
  assert.deepEqual([pullRequestOf(row).host, pullRequestOf(row).ref], ['github', '#12']);
  assert.equal(pullRequestOf({ ...row, host: 'gitlab' }).ref, '!12');
  assert.equal(pullRequestOf({ ...row, number: null }).ref, null);
  // A process still on the old schema writes no host, and SQLite fills the default
  insert.run('older-writer', at(2), at(2), at(2));
  assert.equal((raw.prepare('SELECT host FROM work_item_pull_requests WHERE id = ?').get('older-writer') as { host: string }).host, 'github');

  const add = raw.prepare(
    `INSERT INTO orchestration_pull_requests (id, orchestration_id, cwd, host, phase, branch, base, created_at, updated_at)
     VALUES (?, 'o', '/repo', 'gitlab', ?, 'b', 'main', ?, ?)`,
  );
  add.run('a', 'open', at(1), at(1));
  // One live change request per orchestration; a finished one frees the slot
  assert.throws(() => add.run('b', 'preparing', at(2), at(2)), /UNIQUE/);
  raw.prepare("UPDATE orchestration_pull_requests SET phase = 'closed' WHERE id = 'a'").run();
  add.run('c', 'preparing', at(3), at(3));
  const read = orchestrationPullRequestOf(raw.prepare('SELECT * FROM orchestration_pull_requests WHERE id = ?').get('c') as unknown as OrchestrationPullRequestRow);
  assert.deepEqual([read.phase, read.host, read.ref, read.error], ['preparing', 'gitlab', null, null]);

  raw.prepare("INSERT INTO host_rate_limits (host, bucket, updated_at) VALUES ('github.com', 'core', ?)").run(at(1));
  assert.equal((raw.prepare('SELECT strikes FROM host_rate_limits').get() as { strikes: number }).strikes, 0);
  raw.close();
});

test('chats stored before the native session id keep their rows, with a null id and no entries', () => {
  const raw = new DatabaseSync(':memory:');
  migrate(raw, CHAT_ENTRIES_SCHEMA_VERSION - 1);
  const old = chat('old', '2026-09-18T10:00:00Z');
  raw.prepare('INSERT INTO chats (id, created_at, json) VALUES (?, ?, ?)').run('old', old.record.createdAt, JSON.stringify(old.record));
  migrate(raw);
  const row = raw.prepare('SELECT provider, native_session_id FROM chats WHERE id = ?').get('old') as { provider: string; native_session_id: string | null };
  assert.deepEqual({ ...row }, { provider: 'claude-code', native_session_id: null });
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM chat_entries').get() as { n: number }).n, 0);
  // A process still on the old schema inserts without the column
  raw.prepare('INSERT INTO chats (id, created_at, json) VALUES (?, ?, ?)').run('older-writer', old.record.createdAt, JSON.stringify(old.record));
  assert.equal((raw.prepare('SELECT native_session_id FROM chats WHERE id = ?').get('older-writer') as { native_session_id: string | null }).native_session_id, null);
  raw.close();
});

test('the native session id survives a re-save of the chat', () => {
  const db = new Db(tempConfig());
  const c = chat('a', '2026-09-18T10:00:00Z');
  db.saveChats([c], null);
  assert.equal(db.nativeSessionId('a'), null);
  db.setNativeSessionId('a', 'native-1');
  db.saveChats([c], null);
  assert.equal(db.nativeSessionId('a'), 'native-1');
  assert.equal(db.nativeSessionId('missing'), null);
  db.close();
});

test('chat entries append once per seq, read in order, and go with their chat', () => {
  const db = new Db(tempConfig());
  db.saveChats([chat('a', '2026-09-18T10:00:00Z')], null);
  const first = [{ seq: 0, at: '2026-09-18T10:00:01Z', entry: { kind: 'user', text: 'hi' } }, { seq: 1, at: '2026-09-18T10:00:02Z', entry: { kind: 'assistant', text: 'yo' } }];
  assert.equal(db.appendChatEntries('a', first), 2);
  // A second process replaying the same entries, plus one new
  assert.equal(db.appendChatEntries('a', [...first, { seq: 2, at: '2026-09-18T10:00:03Z', entry: { kind: 'user', text: 'again' } }]), 1);
  assert.deepEqual(db.chatEntries('a').map((e) => e.seq), [0, 1, 2]);
  assert.deepEqual(db.chatEntries('a', 1).map((e) => e.seq), [2]);
  assert.deepEqual(db.chatEntries('a')[0]?.entry, { kind: 'user', text: 'hi' });
  db.deleteChat('a');
  assert.deepEqual(db.chatEntries('a'), []);
  db.close();
});

test('pull requests stored before the checks have no fix, and the snapshot table exists', () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = OFF');
  migrate(raw, CHECKS_SCHEMA_VERSION - 1);
  raw
    .prepare(
      `INSERT INTO work_item_pull_requests (id, item_id, project_id, phase, number, branch, base, approved_at, created_at, updated_at)
       VALUES ('old', 'i', 'p', 'open', 12, 'claudio-task/CW-1', 'main', ?, ?, ?)`,
    )
    .run(at(1), at(1), at(1));
  raw
    .prepare(
      `INSERT INTO orchestration_pull_requests (id, orchestration_id, cwd, host, phase, branch, base, created_at, updated_at)
       VALUES ('o', 'o', '/repo', 'gitlab', 'open', 'b', 'main', ?, ?)`,
    )
    .run(at(1), at(1));
  migrate(raw);
  const itemRow = (): PullRequestRow => raw.prepare('SELECT * FROM work_item_pull_requests WHERE id = ?').get('old') as unknown as PullRequestRow;
  const item = pullRequestOf(itemRow());
  assert.deepEqual([item.fixState, item.fixOrigin, item.fixAttempts, item.fixHead], [null, null, 0, null]);
  const orch = orchestrationPullRequestOf(raw.prepare('SELECT * FROM orchestration_pull_requests WHERE id = ?').get('o') as unknown as OrchestrationPullRequestRow);
  assert.deepEqual([orch.fixState, orch.fixOrigin, orch.fixAttempts, orch.fixHead], [null, null, 0, null]);
  raw.prepare("UPDATE work_item_pull_requests SET fix_state = 'awaiting-push', fix_origin = 'decision', fix_attempts = 1, fix_head = 'abc' WHERE id = 'old'").run();
  const fixing = pullRequestOf(itemRow());
  assert.deepEqual([fixing.fixState, fixing.fixOrigin, fixing.fixAttempts, fixing.fixHead], ['awaiting-push', 'decision', 1, 'abc']);
  // A value a later version writes reads as none rather than breaking the row
  assert.equal(pullRequestOf({ ...itemRow(), fix_state: 'later' }).fixState, null);

  raw.prepare("INSERT INTO change_request_snapshots (cr_id, kind, fetched_at) VALUES ('x', 'work-item', ?)").run(at(1));
  const snap = raw.prepare('SELECT head_sha, checks, rollup FROM change_request_snapshots').get() as { head_sha: string | null; checks: string | null; rollup: string | null };
  assert.deepEqual([snap.head_sha, snap.checks, snap.rollup], [null, null, null]);
  raw.close();
});

test('migrate adds the review tables and reads a fix with no kind as checks', () => {
  const raw = new DatabaseSync(':memory:');
  migrate(raw, REVIEWS_SCHEMA_VERSION - 1);
  // The orchestration's own row is not what this test is about
  raw.exec('PRAGMA foreign_keys = OFF');
  const at = (n: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  raw
    .prepare("INSERT INTO orchestration_pull_requests (id, orchestration_id, cwd, host, phase, branch, base, created_at, updated_at) VALUES ('o', 'o', '/repo', 'gitlab', 'open', 'b', 'main', ?, ?)")
    .run(at(1), at(1));
  migrate(raw);
  const orchRow = (): OrchestrationPullRequestRow => raw.prepare('SELECT * FROM orchestration_pull_requests WHERE id = ?').get('o') as unknown as OrchestrationPullRequestRow;
  assert.equal(orchestrationPullRequestOf(orchRow()).fixKind, 'checks');
  raw.prepare("UPDATE orchestration_pull_requests SET fix_kind = 'review' WHERE id = 'o'").run();
  assert.equal(orchestrationPullRequestOf(orchRow()).fixKind, 'review');
  assert.equal(orchestrationPullRequestOf({ ...orchRow(), fix_kind: 'later' }).fixKind, 'checks');

  raw.prepare("INSERT INTO review_drafts (id, cr_id, body, created_at, updated_at) VALUES ('d', 'cr', 'note', ?, ?)").run(at(1), at(1));
  const draft = reviewDraftOf(raw.prepare('SELECT * FROM review_drafts').get() as unknown as ReviewDraftRow);
  assert.deepEqual([draft.path, draft.side, draft.line, draft.startLine, draft.suggestion], [null, null, null, null, false]);
  raw.prepare("UPDATE review_drafts SET path = 'a.ts', side = 'right', line = 4, start_line = 2, suggestion = 1").run();
  const ranged = reviewDraftOf(raw.prepare('SELECT * FROM review_drafts').get() as unknown as ReviewDraftRow);
  assert.deepEqual([ranged.path, ranged.side, ranged.line, ranged.startLine, ranged.suggestion], ['a.ts', 'right', 4, 2, true]);

  raw.prepare("INSERT INTO review_posts (id, cr_id, marker, event, state, detail, created_at, updated_at) VALUES ('p', 'cr', 'm', 'comment', 'partly', ?, ?, ?)").run(
    JSON.stringify({ code: 'review-partly-posted', detail: 'one failed', saved: 2, total: 3 }),
    at(1),
    at(1),
  );
  const post = reviewPostOf(raw.prepare('SELECT * FROM review_posts').get() as unknown as ReviewPostRow);
  assert.deepEqual([post.state, post.remoteId, post.detail], ['partly', null, { code: 'review-partly-posted', detail: 'one failed', saved: 2, total: 3 }]);
  const odd = reviewPostOf({ ...(raw.prepare('SELECT * FROM review_posts').get() as unknown as ReviewPostRow), state: 'later', event: 'later', detail: '{' });
  assert.deepEqual([odd.state, odd.event, odd.detail], ['failed', 'comment', null]);
  raw.close();
});

test('migrate adds the merge audit and reads a row it does not know as a failed merge', () => {
  const raw = new DatabaseSync(':memory:');
  migrate(raw, MERGES_SCHEMA_VERSION - 1);
  migrate(raw);
  raw
    .prepare("INSERT INTO change_request_merges (id, cr_id, action, method, expected_head, requested_at, requested_by, outcome) VALUES ('m', 'cr', 'arm', 'squash', 'abc', ?, 'me', 'armed')")
    .run(new Date(Date.UTC(2026, 0, 1)).toISOString());
  const read = (): ChangeRequestMergeRow => raw.prepare('SELECT * FROM change_request_merges').get() as unknown as ChangeRequestMergeRow;
  const merge = changeRequestMergeOf(read());
  assert.deepEqual([merge.action, merge.method, merge.deleteBranch, merge.outcome, merge.reason, merge.detail], ['arm', 'squash', false, 'armed', null, null]);
  raw.prepare("UPDATE change_request_merges SET delete_branch = 1, reason = 'head-moved', detail = 'x'").run();
  assert.deepEqual([changeRequestMergeOf(read()).deleteBranch, changeRequestMergeOf(read()).reason], [true, 'head-moved']);
  const odd = changeRequestMergeOf({ ...read(), action: 'later', method: 'later', outcome: 'later' });
  assert.deepEqual([odd.action, odd.method, odd.outcome], ['merge', null, 'failed']);
  raw.close();
});

test('migrate adds the issues linked to items, and one issue is never linked twice in a project', () => {
  const raw = new DatabaseSync(':memory:');
  assert.equal(ISSUES_SCHEMA_VERSION, MERGES_SCHEMA_VERSION + 1);
  migrate(raw, ISSUES_SCHEMA_VERSION - 1);
  migrate(raw);
  const insert = (id: string, project: string, key: string) =>
    raw
      .prepare("INSERT INTO work_item_issues (id, project_id, item_id, tracker, key, title, state, imported_at) VALUES (?, ?, 'i', 'github-issues', ?, 't', 'open', ?)")
      .run(id, project, key, at(1));
  insert('a', 'p1', '12');
  assert.throws(() => insert('b', 'p1', '12'), /UNIQUE/);
  insert('c', 'p2', '12');
  const row = raw.prepare("SELECT sync_state, sync_reason, synced_at FROM work_item_issues WHERE id = 'a'").get();
  assert.deepEqual({ ...row }, { sync_state: 'none', sync_reason: null, synced_at: null });
  raw.close();
});

test('migrate gives issue links their scope: old rows keep everything and read no scope yet, and the same number of another repository is another issue', () => {
  const raw = new DatabaseSync(':memory:');
  assert.ok(ISSUE_SCOPE_SCHEMA_VERSION > ISSUES_SCHEMA_VERSION);
  migrate(raw, ISSUE_SCOPE_SCHEMA_VERSION - 1);
  raw
    .prepare("INSERT INTO work_item_issues (id, project_id, item_id, tracker, key, title, state, imported_at, sync_state, sync_reason) VALUES ('old', 'p1', 'i1', 'github-issues', '12', 't', 'open', ?, 'failed', 'unreachable')")
    .run(at(1));
  migrate(raw);
  const old = raw.prepare("SELECT scope, key, item_id, sync_state, sync_reason FROM work_item_issues WHERE id = 'old'").get();
  assert.deepEqual({ ...old }, { scope: '', key: '12', item_id: 'i1', sync_state: 'failed', sync_reason: 'unreachable' });
  const insert = (id: string, scope: string) =>
    raw
      .prepare("INSERT INTO work_item_issues (id, project_id, item_id, tracker, scope, key, title, state, imported_at) VALUES (?, 'p1', 'i', 'github-issues', ?, '12', 't', 'open', ?)")
      .run(id, scope, at(2));
  insert('a', 'acme/a');
  insert('b', 'acme/b');
  assert.throws(() => insert('c', 'ACME/A'), /UNIQUE/, 'a repository path is case-insensitive');
  assert.ok(raw.prepare("SELECT 1 FROM pragma_index_list('work_item_issues') WHERE name = 'work_item_issues_item'").get(), 'the item index is back');
  raw.close();
});

const move = (id: string, fromChat: string, state: 'waiting' | 'moved' = 'waiting'): ProviderMove => ({
  id, at: at(1), subjectKind: 'chat', subjectId: fromChat, projectId: null, fromChat, toChat: null, fromProvider: 'claude-code', toProvider: null,
  fromModel: null, toModel: null, action: 'wait', state, decidedBy: 'setting', decisionId: null, resetsAt: null, reason: null, updatedAt: at(1),
});

test('the provider rotation tables upgrade from the version before, keeping chats and flow runs', () => {
  const raw = new DatabaseSync(':memory:');
  migrate(raw, PROVIDER_ROTATION_SCHEMA_VERSION - 1);
  const old = chat('old', '2026-09-18T10:00:00Z');
  raw.prepare('INSERT INTO chats (id, created_at, json) VALUES (?, ?, ?)').run('old', old.record.createdAt, JSON.stringify(old.record));
  raw.prepare("INSERT INTO flow_runs (id, project_id, item_id, role, agent, model, stage, column_name, state, queued_at) VALUES ('r1', 'p', 'i', 'dev', 'a', 'm', 'work', 'todo', 'ended', ?)").run(at(1));
  migrate(raw);
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM chats').get() as { n: number }).n, 1);
  assert.equal((raw.prepare('SELECT provider FROM flow_runs WHERE id = ?').get('r1') as { provider: string | null }).provider, null);
  assert.ok(raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'provider_moves_open'").get());
  raw.close();
});

test('an older limit reading never overwrites a newer one', () => {
  const db = new Db(tempConfig());
  const reading = (observedAt: string, utilization: number) => ({ provider: 'codex', state: 'near' as const, window: '5h', utilization, resetsAt: null, windows: {}, observedAt, source: 'probe' as const });
  assert.equal(db.upsertProviderLimit(reading(at(10), 0.8)), true);
  assert.equal(db.upsertProviderLimit(reading(at(5), 0.1)), false);
  assert.equal(db.providerLimit('codex')?.utilization, 0.8);
  assert.equal(db.upsertProviderLimit(reading(at(11), 0.9)), true);
  assert.equal(db.providerLimits()[0]?.utilization, 0.9);
  db.close();
});

test('two connections racing one wait claim: one winner; one open wait per chat', () => {
  const config = tempConfig();
  const a = new Db(config);
  const b = new Db(config);
  assert.equal(a.insertProviderMove(move('m1', 'c1')), true);
  assert.equal(b.insertProviderMove(move('m2', 'c1')), false, 'a second open wait for the chat is refused');
  assert.equal(a.claimProviderMove('m1', at(2), at(7)), true);
  assert.equal(b.claimProviderMove('m1', at(3), at(8)), false);
  assert.equal(b.claimProviderMove('m1', at(9), at(14)), true, 'an expired claim can be taken again');
  assert.equal(a.openProviderMoves(at(10)).length, 0);
  assert.equal(a.closeProviderMove('m1', 'resumed', at(15), { toChat: 'c2' }), true);
  assert.equal(b.closeProviderMove('m1', 'cancelled', at(16)), false);
  assert.equal(a.providerMove('m1')?.toChat, 'c2');
  assert.equal(a.insertProviderMove(move('m3', 'c1')), true, 'closed, so the chat may wait again');
  a.close();
  b.close();
});

test('closed moves are pruned and open waits never are', () => {
  const db = new Db(tempConfig());
  db.insertProviderMove(move('old-moved', 'c1', 'moved'));
  db.insertProviderMove(move('old-wait', 'c2'));
  assert.equal(db.pruneProviderMoves(at(30)), 1);
  assert.deepEqual(db.providerMoves().map((m) => m.id), ['old-wait']);
  assert.deepEqual(db.providerMoves({ chatId: 'c2', state: 'waiting' }).map((m) => m.id), ['old-wait']);
  db.close();
});

test('the cost backfill prices only the jev rows that kept tokens and lost their cost', () => {
  const raw = new DatabaseSync(':memory:');
  migrate(raw);
  // A database as the release before the backfill left it
  raw.exec(`PRAGMA user_version = ${String(JEV_COST_SCHEMA_VERSION - 1)}`);
  // What the migrations after it added is not there yet, or migrating again would add it twice
  raw.exec('ALTER TABLE flow_runs DROP COLUMN effort; ALTER TABLE assistant_runs DROP COLUMN effort; ALTER TABLE provider_limits DROP COLUMN overage; DROP TABLE terminal_sessions; DROP TABLE terminal_attachments; DROP TABLE spend_ledger; DROP TABLE spend_alerts; DROP TABLE flow_spend_passes; ALTER TABLE flow_runs DROP COLUMN checks; ALTER TABLE memory_proposals DROP COLUMN target_paths; DROP TABLE chat_compactions; DROP TABLE chat_notes; DROP TABLE guard_events; DROP TABLE review_findings; DROP TABLE review_runs; DROP TABLE review_rounds;');
  const insert = raw.prepare(
    `INSERT INTO decisions (id, point, kind, subject_kind, provider, model, mode, status, state, questions, acted, visible, saved_run, latency_ms, input_tokens, cost_usd, at)
     VALUES (?, 'run.continuation', 'act', 'flow_run', ?, 'm', 'shadow', 'answered', '{}', '[]', 0, 0, 0, 1, ?, ?, '2026-09-30T10:00:00Z')`,
  );
  insert.run('old', 'jev', 1_000_000, null);
  insert.run('no-tokens', 'jev', null, null);
  insert.run('has-cost', 'jev', 1_000_000, 0.5);
  insert.run('cli', 'cli', 1_000_000, null);
  migrate(raw);
  const cost = (id: string) => (raw.prepare('SELECT cost_usd FROM decisions WHERE id = ?').get(id) as { cost_usd: number | null }).cost_usd;
  assert.equal(cost('old'), 0.042);
  assert.equal(cost('no-tokens'), null);
  assert.equal(cost('has-cost'), 0.5);
  assert.equal(cost('cli'), null);
});

test('decision stats sum the jev cost of a window of priced rows', () => {
  const db = new Db(tempConfig());
  const price = 0.042 / 1_000_000;
  // 51 decisions totalling 76,403 input tokens, as the shadow run recorded them
  let left = 76_403;
  for (let i = 0; i < 51; i++) {
    const tokens = i === 50 ? left : 1498;
    left -= tokens;
    db.insertDecision(decisionRow(`j${String(i)}`, { inputTokens: tokens, costUsd: tokens * price }));
  }
  const stats = db.decisionStats(at(0));
  assert.ok(Math.abs(stats.jevCostUsd - 76_403 * price) < 1e-12);
  assert.ok(Math.abs((stats.points[0]?.costUsd ?? 0) - 76_403 * price) < 1e-12);
});

test('values stored under the old product name are read back under Claudio’s after the upgrade', () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const raw = new DatabaseSync(join(config.dataDir, 'wrapper.db'));
  migrate(raw, RENAME_SCHEMA_VERSION - 1);
  const record = (id: string, extra: Record<string, unknown>) =>
    JSON.stringify({ id, name: id, cwd: '/p', workingDir: null, origin: 'agentry', orchestrationId: null, orchestrationTaskId: null, derivedFrom: null, prompt: 'hi', lastText: null, model: null, permissionMode: 'default', permissionPrompts: 'host', createdAt: at(1), updatedAt: at(1), ...extra });
  const chat = raw.prepare("INSERT INTO chats (id, created_at, provider, json) VALUES (?, ?, 'claude-code', ?)");
  chat.run('assistant', at(1), record('assistant', { agentryAssistant: { language: 'es', projectId: null } }));
  chat.run('external', at(2), record('external', { origin: 'external', agentryAssistant: null }));
  chat.run('broken', at(3), '{not json');
  raw.prepare("INSERT INTO audit (at, actor, method, path, status, summary) VALUES (?, 'agentry', 'POST', '/api/tunnel/start', 200, 'Start the tunnel')").run(at(1));
  raw.prepare("INSERT INTO audit (at, actor, method, path, status, summary) VALUES (?, 'token:t1', 'POST', '/api/projects', 201, 'Create')").run(at(2));
  raw.prepare("INSERT INTO change_request_merges (id, cr_id, action, requested_at, requested_by, outcome) VALUES ('m1', 'cr1', 'disarm', ?, 'agentry', 'disarmed')").run(at(1));
  raw.close();

  const db = new Db(config);
  const chats = new Map(db.loadChats().map((c) => [c.record.id, c.record]));
  assert.deepEqual(chats.get('assistant')?.claudioAssistant, { language: 'es', projectId: null });
  assert.equal(chats.get('assistant')?.origin, 'claudio');
  assert.equal('agentryAssistant' in (chats.get('assistant') ?? {}), false);
  assert.equal(chats.get('external')?.origin, 'external', 'another origin is left as it was');
  assert.equal(chats.get('external')?.claudioAssistant, null);
  assert.equal(chats.has('broken'), false, 'an unreadable row neither stops the upgrade nor is invented');
  const sql = (db as unknown as { db: DatabaseSync }).db;
  assert.deepEqual((sql.prepare('SELECT actor FROM audit ORDER BY id').all() as Array<{ actor: string }>).map((r) => r.actor), ['claudio', 'token:t1']);
  assert.equal((sql.prepare("SELECT requested_by FROM change_request_merges WHERE id = 'm1'").get() as { requested_by: string }).requested_by, 'claudio');
  db.close();
});

test('the spend ledger upgrade adds its tables and columns, and backfills the executions that ended today', () => {
  const raw = new DatabaseSync(':memory:');
  assert.ok(SPEND_SCHEMA_VERSION > 0);
  migrate(raw, SPEND_SCHEMA_VERSION - 1);
  const columns = (table: string) => (raw.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).map((c) => c.name);
  assert.deepEqual(columns('spend_ledger'), []);
  assert.ok(!columns('flow_runs').includes('checks'));
  assert.ok(!columns('memory_proposals').includes('target_paths'));

  // The local day, from date parts like the migration: two hours into today, and the day before at noon
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 30).toISOString();
  const lateToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59).toISOString();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59).toISOString();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0).toISOString();
  raw.prepare('INSERT INTO chats (id, created_at, json) VALUES (?, ?, ?)').run('c1', yesterday, '{}');
  const insert = raw.prepare('INSERT INTO executions (id, chat_id, started_at, json) VALUES (?, ?, ?, ?)');
  const doc = (endedAt: string | null, costUsd: number) => JSON.stringify({ endedAt, costUsd });
  insert.run('e-today', 'c1', yesterday, doc(today, 0.25));
  insert.run('e-late', 'c1', yesterday, doc(lateToday, 1.5));
  insert.run('e-yesterday', 'c1', yesterday, doc(yesterday, 2));
  insert.run('e-tomorrow', 'c1', yesterday, doc(tomorrow, 3));
  insert.run('e-free', 'c1', yesterday, doc(today, 0));
  insert.run('e-running', 'c1', yesterday, doc(null, 1));
  insert.run('e-broken', 'c1', yesterday, 'not json');
  migrate(raw);

  assert.deepEqual(columns('spend_ledger'), ['seq', 'at', 'chat_id', 'execution_id', 'usd', 'reported', 'purpose', 'account', 'account_kind', 'project_id', 'orchestration_id']);
  assert.deepEqual(columns('spend_alerts'), ['day', 'level', 'at']);
  assert.ok(columns('flow_runs').includes('checks'));
  assert.ok(columns('memory_proposals').includes('target_paths'));
  assert.ok(raw.prepare("SELECT 1 FROM pragma_index_list('spend_ledger') WHERE name = 'spend_ledger_at'").get(), 'the ledger is indexed by time');

  const rows = raw.prepare('SELECT execution_id, at, usd, reported, purpose, chat_id FROM spend_ledger ORDER BY execution_id').all();
  assert.deepEqual(
    rows.map((r) => ({ ...r })),
    [
      { execution_id: 'e-late', at: lateToday, usd: 1.5, reported: 1, purpose: 'other', chat_id: 'c1' },
      { execution_id: 'e-today', at: today, usd: 0.25, reported: 1, purpose: 'other', chat_id: 'c1' },
    ],
    'one row per execution that ended today with a cost, none for the days around it',
  );

  // The alerts are one row per day and level
  raw.prepare("INSERT INTO spend_alerts (day, level, at) VALUES ('2026-10-15', 'warn', ?)").run(today);
  assert.throws(() => raw.prepare("INSERT INTO spend_alerts (day, level, at) VALUES ('2026-10-15', 'warn', ?)").run(today), /UNIQUE|PRIMARY/);
  raw.close();
});

const compactionClaim = (id: string, leaseUntil: string): HousekeepingClaim => ({
  kind: 'compaction',
  leaseUntil,
  row: { id, origin: 'person', focus: 'the parser', structuredNote: true, flowRunId: null, requestedBy: 'token:t1', requestedAt: at(0) },
});
const noteClaim = (id: string, leaseUntil: string): HousekeepingClaim => ({ kind: 'note', leaseUntil, row: { id, source: 'agent', entryUuid: null, createdAt: at(0) } });

test('a database from the version before context control gains its tables and keeps its chats', () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const raw = new DatabaseSync(join(config.dataDir, 'wrapper.db'));
  migrate(raw, CONTEXT_CONTROL_SCHEMA_VERSION - 1);
  assert.equal(raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'chat_compactions'").get(), undefined);
  raw.prepare("INSERT INTO chats (id, created_at, provider, json) VALUES ('c1', ?, 'claude-code', '{}')").run(at(1));
  raw.close();

  const db = new Db(config);
  const sql = db.connection;
  for (const name of ['chat_compactions', 'chat_notes', 'chat_compactions_open', 'chat_compactions_boundary', 'chat_notes_pending', 'chat_notes_entry']) {
    assert.ok(sql.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name), name);
  }
  assert.equal((sql.prepare('SELECT COUNT(*) AS n FROM chats').get() as { n: number }).n, 1);
  assert.equal((sql.prepare('PRAGMA user_version').get() as { user_version: number }).user_version >= CONTEXT_CONTROL_SCHEMA_VERSION, true);
  db.close();
});

test('a database from the version before the review gate gains its tables and keeps its orchestrations', () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const raw = new DatabaseSync(join(config.dataDir, 'wrapper.db'));
  migrate(raw, REVIEW_GATE_SCHEMA_VERSION - 1);
  assert.equal(raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'review_rounds'").get(), undefined);
  raw.prepare("INSERT INTO orchestrations (id, created_at, json) VALUES ('o1', ?, '{}')").run(at(1));
  raw.close();

  const db = new Db(config);
  const sql = db.connection;
  for (const name of ['review_rounds', 'review_runs', 'review_findings', 'review_rounds_live', 'review_rounds_orch', 'review_runs_round', 'review_findings_round']) {
    assert.ok(sql.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name), name);
  }
  assert.equal((sql.prepare('SELECT COUNT(*) AS n FROM orchestrations').get() as { n: number }).n, 1);
  assert.equal((sql.prepare('PRAGMA user_version').get() as { user_version: number }).user_version >= REVIEW_GATE_SCHEMA_VERSION, true);
  db.close();
});

test('a second connection cannot claim the chat while the first claim is open, and can once its lease has passed', () => {
  const config = tempConfig();
  const first = new Db(config);
  const second = new Db(config);
  try {
    const claimed = first.claimHousekeeping('c1', compactionClaim('k1', at(10)), at(1));
    assert.equal(claimed?.id, 'k1');
    assert.equal(second.claimHousekeeping('c1', compactionClaim('k2', at(20)), at(2)), null, 'open in the other process');
    assert.equal(second.claimHousekeeping('c1', noteClaim('n1', at(20)), at(2)), null, 'a note turn is refused too');
    assert.equal(second.claimHousekeeping('c2', compactionClaim('k3', at(20)), at(2))?.id, 'k3', 'another chat is free');

    const taken = second.claimHousekeeping('c1', compactionClaim('k4', at(30)), at(11));
    assert.equal(taken?.id, 'k4', 'the lease passed');
    const lost = first.compactionById('k1');
    assert.equal(lost?.state, 'failed');
    assert.equal(lost?.failure, 'lost');
    assert.equal(first.openCompaction('c1')?.id, 'k4');
  } finally {
    first.close();
    second.close();
  }
});

test('two claims on one file in a row: exactly one wins', () => {
  const config = tempConfig();
  const a = new Db(config);
  const b = new Db(config);
  try {
    const results = [a.claimHousekeeping('c1', noteClaim('na', at(10)), at(1)), b.claimHousekeeping('c1', noteClaim('nb', at(10)), at(1))];
    assert.equal(results.filter((r) => r !== null).length, 1);
    assert.equal(a.notes('c1').length, 1);
  } finally {
    a.close();
    b.close();
  }
});

test('guarded updates report whether a row changed, so two events cannot both close a compaction', () => {
  const config = tempConfig();
  const db = new Db(config);
  try {
    db.claimHousekeeping('c1', compactionClaim('k1', at(10)), at(1));
    assert.equal(db.updateCompaction('k1', { state: 'running', startedAt: at(2), leaseUntil: at(12) }, { from: ['requested'] }), true);
    assert.equal(db.updateCompaction('k1', { state: 'running' }, { from: ['requested'] }), false, 'no longer requested');
    assert.equal(db.updateCompaction('k1', { state: 'done', boundaryUuid: 'b1', trigger: 'manual', preTokens: 900, postTokens: 90, costUsd: 0.02, endedAt: at(3) }, { from: ['requested', 'running'] }), true);
    assert.equal(db.updateCompaction('k1', { state: 'failed', failure: 'cli' }, { from: ['requested', 'running'] }), false, 'already closed');
    const row = db.compactionByBoundary('b1');
    assert.equal(row?.state, 'done');
    assert.equal(row?.trigger, 'manual');
    assert.equal(row?.structuredNote, true);
    assert.equal(row?.focus, 'the parser');
    assert.equal(row?.postTokens, 90);
    assert.equal(db.openCompaction('c1'), null);
    assert.equal(db.compactions('c1')[0]?.id, 'k1');

    assert.equal(db.claimHousekeeping('c1', noteClaim('n1', at(10)), at(4))?.id, 'n1');
    assert.equal(db.updateNote('n1', { state: 'ready', text: '## Goal\nship', sections: { goal: 'ship' }, readyAt: at(5) }, { from: ['pending'] }), true);
    assert.equal(db.updateNote('n1', { state: 'failed', error: 'late' }, { from: ['pending'] }), false);
    assert.deepEqual(db.notes('c1')[0]?.sections, { goal: 'ship' });
    assert.equal(db.deleteNote('c1', 'n1'), true);
    assert.equal(db.deleteNote('c1', 'n1'), false);
  } finally {
    db.close();
  }
});

test('the boot sweep closes expired rows and leaves one still inside its lease', () => {
  const config = tempConfig();
  const db = new Db(config);
  try {
    db.claimHousekeeping('old', compactionClaim('k1', at(5)), at(1));
    db.claimHousekeeping('live', compactionClaim('k2', at(50)), at(1));
    db.claimHousekeeping('note', noteClaim('n1', at(5)), at(1));
    db.sweepHousekeeping(at(10));
    assert.equal(db.compactionById('k1')?.failure, 'lost');
    assert.equal(db.compactionById('k2')?.state, 'requested');
    assert.equal(db.noteById('n1')?.state, 'failed');
    assert.equal(db.noteById('n1')?.error, 'lost');
  } finally {
    db.close();
  }
});

test('deleting a chat deletes its compactions and notes, and only its own', () => {
  const config = tempConfig();
  const db = new Db(config);
  try {
    db.claimHousekeeping('gone', compactionClaim('k1', at(50)), at(1));
    const note = { id: 'n1', chatId: 'gone', source: 'summary', state: 'ready', text: 'x', sections: null, compactionId: null, entryUuid: 'e1', error: null, createdAt: at(1), readyAt: at(1) } as const;
    assert.equal(db.insertNote(note), true);
    assert.equal(db.insertNote({ ...note, id: 'n2' }), false, 'one note per entry');
    db.claimHousekeeping('kept', compactionClaim('k2', at(50)), at(1));
    db.deleteChat('gone');
    assert.deepEqual(db.compactions('gone'), []);
    assert.deepEqual(db.notes('gone'), []);
    assert.equal(db.compactions('kept').length, 1);
  } finally {
    db.close();
  }
});
