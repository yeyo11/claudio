import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { Execution } from '@claudio/shared';
import type { StoredChat } from '../src/chat-records.ts';
import { ChatRetention, type RetainedChat } from '../src/chat-retention.ts';
import { Db } from '../src/db.ts';
import { Core } from '../src/index.ts';
import { headlessStartProblems, loadConfig, type HeadlessStart } from '../src/paths.ts';
import { runsIn, SUBSYSTEMS, type Subsystem } from '../src/subsystems.ts';
import { tempConfig } from './helpers.ts';

const DAY = 24 * 60 * 60 * 1000;

test('the profile is the app unless CLAUDIO_PROFILE says headless, and a value naming no profile stops the start', () => {
  const dirs = { CLAUDIO_DATA_DIR: tempConfig().dataDir, CLAUDIO_WORKSPACE_DIR: tempConfig().workspaceDir };
  assert.equal(loadConfig(dirs).profile, 'full');
  assert.equal(loadConfig({ ...dirs, CLAUDIO_PROFILE: '' }).profile, 'full');
  assert.equal(loadConfig({ ...dirs, CLAUDIO_PROFILE: ' Headless ' }).profile, 'headless');
  assert.throws(() => loadConfig({ ...dirs, CLAUDIO_PROFILE: 'lite' }), /CLAUDIO_PROFILE: 'lite'/);
});

test('a chat that names no budget gets CLAUDIO_CHAT_BUDGET_USD, one dollar by default; retention is 30 days by default', () => {
  const dirs = { CLAUDIO_DATA_DIR: tempConfig().dataDir, CLAUDIO_WORKSPACE_DIR: tempConfig().workspaceDir };
  const config = loadConfig(dirs);
  assert.equal(config.chatBudgetUsd, 1);
  assert.equal(config.chatRetentionDays, 30);
  assert.equal(loadConfig({ ...dirs, CLAUDIO_CHAT_BUDGET_USD: '0.25' }).chatBudgetUsd, 0.25);
  assert.equal(loadConfig({ ...dirs, CLAUDIO_CHAT_RETENTION_DAYS: '7' }).chatRetentionDays, 7);
  assert.throws(() => loadConfig({ ...dirs, CLAUDIO_CHAT_BUDGET_USD: '0' }), /CLAUDIO_CHAT_BUDGET_USD/);
  assert.throws(() => loadConfig({ ...dirs, CLAUDIO_CHAT_BUDGET_USD: 'lots' }), /CLAUDIO_CHAT_BUDGET_USD/);
  assert.throws(() => loadConfig({ ...dirs, CLAUDIO_CHAT_RETENTION_DAYS: '1.5' }), /CLAUDIO_CHAT_RETENTION_DAYS/);
  assert.throws(() => loadConfig({ ...dirs, CLAUDIO_CHAT_RETENTION_DAYS: '0' }), /CLAUDIO_CHAT_RETENTION_DAYS/);
});

test('a headless start is refused open off loopback, without a spend cap, and in any mode but dontAsk', () => {
  const ok: HeadlessStart = { authMode: 'token', host: '0.0.0.0', defaultPermissionMode: 'dontAsk', envSpendCapUsd: 5 };
  assert.deepEqual(headlessStartProblems(ok), []);
  // Open is allowed where only the machine itself reaches it
  assert.deepEqual(headlessStartProblems({ ...ok, authMode: 'none', host: '127.0.0.1' }), []);
  assert.deepEqual(headlessStartProblems({ ...ok, authMode: 'none', host: '::1' }), []);
  const open = headlessStartProblems({ ...ok, authMode: 'none' });
  assert.equal(open.length, 1);
  assert.match(open[0] ?? '', /CLAUDIO_AUTH_MODE=none on 0\.0\.0\.0/);
  assert.match(headlessStartProblems({ ...ok, envSpendCapUsd: null })[0] ?? '', /CLAUDIO_DAILY_SPEND_CAP_USD is not set/);
  assert.match(headlessStartProblems({ ...ok, defaultPermissionMode: 'bypassPermissions' })[0] ?? '', /'bypassPermissions'.*dontAsk/);
  assert.equal(headlessStartProblems({ authMode: 'none', host: '0.0.0.0', defaultPermissionMode: 'acceptEdits', envSpendCapUsd: null }).length, 3, 'every problem at once, not one per attempt');
});

const constructorSubsystems = (Object.keys(SUBSYSTEMS) as Subsystem[]).filter(
  // Started by the server once it listens, not by the core; the supervisor is woken, never started
  (name) => !['cliVersionWatch', 'releaseWatch', 'providersWatch', 'codeHostsWatch', 'tunnel', 'supervisor'].includes(name),
);

test('a headless core starts only what the headless profile keeps, and never what it drops', async (t) => {
  const core = new Core({ ...tempConfig(), claudeBin: '/nonexistent/claude', profile: 'headless' });
  t.after(() => core.shutdown());
  await core.restored;
  const expected = constructorSubsystems.filter((name) => runsIn('headless', name));
  assert.deepEqual([...core.started].sort(), expected.sort());
  for (const dropped of ['sampler', 'lessonQueue', 'lessons', 'schedules', 'pullRequestWatcher', 'collaborators', 'serverUpdates', 'flow', 'orchestrationRecovery'] as const) {
    assert.equal(core.started.has(dropped), false, dropped);
  }
  for (const kept of ['spend', 'healthMonitor', 'rotation', 'accountsWatch', 'guardSelfTest', 'chatRetention'] as const) {
    assert.equal(core.started.has(kept), true, kept);
  }
  assert.equal(core.profile, 'headless');
  assert.equal((await core.system()).profile, 'headless');
});

test('the app starts what it always did, and no retention sweeper', async (t) => {
  const core = new Core({ ...tempConfig(), claudeBin: '/nonexistent/claude' });
  t.after(() => core.shutdown());
  await core.restored;
  const expected = constructorSubsystems.filter((name) => runsIn('full', name));
  assert.deepEqual([...core.started].sort(), expected.sort());
  assert.equal(core.started.has('chatRetention'), false);
  assert.equal((await core.system()).profile, 'full');
});

test('the retention sweeper deletes idle chats, and keeps recent ones, live ones and one that refuses', async () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  const ago = (days: number) => new Date(now - days * DAY).toISOString();
  const chats: RetainedChat[] = [
    { id: 'old', lastActivityAt: ago(31), alive: false },
    { id: 'recent', lastActivityAt: ago(29), alive: false },
    { id: 'old-but-live', lastActivityAt: ago(90), alive: true },
    { id: 'old-refuses', lastActivityAt: ago(40), alive: false },
    { id: 'unreadable', lastActivityAt: 'not a date', alive: false },
  ];
  const removed: string[] = [];
  const logs: string[] = [];
  const retention = new ChatRetention({
    days: 30,
    now: () => now,
    chats: () => chats,
    remove: async (id) => {
      if (id === 'old-refuses') throw new Error('Something is running on this chat');
      removed.push(id);
    },
    log: (line) => logs.push(line),
  });
  assert.deepEqual(await retention.sweep(), ['old']);
  assert.deepEqual(removed, ['old']);
  assert.match(logs[0] ?? '', /old-refuses was not deleted/);
});

const execution = (id: string, startedAt: string): Execution => ({
  id,
  startedAt,
  endedAt: startedAt,
  outcome: 'completed',
  error: null,
  permissionMode: 'dontAsk',
  model: null,
  maxBudgetUsd: null,
  costUsd: 0.01,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
  turns: 1,
});

const stored = (id: string, cwd: string, at: string): StoredChat => ({
  record: {
    id,
    name: id,
    cwd,
    workingDir: null,
    origin: 'api',
    orchestrationId: null,
    orchestrationTaskId: null,
    derivedFrom: null,
    prompt: 'hi',
    lastText: 'ok',
    model: null,
    permissionMode: 'dontAsk',
    permissionPrompts: 'none',
    createdAt: at,
    updatedAt: at,
  },
  executions: [execution(`${id}-1`, at)],
});

test('a headless Claudio deletes a chat idle past its retention, its row and the CLI session files, and keeps a recent one', async (t) => {
  const config = { ...tempConfig(), claudeBin: '/nonexistent/claude', profile: 'headless' as const };
  const cwd = config.workspaceDir;
  const old = new Date(Date.now() - 45 * DAY).toISOString();
  const recent = new Date(Date.now() - 2 * DAY).toISOString();
  // What the CLI writes for a session: the transcript and its sidecar folder, in the one projects dir
  const projectDir = join(config.projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  for (const [id, at] of [['old-chat', old], ['recent-chat', recent]] as const) {
    mkdirSync(join(projectDir, id, 'subagents'), { recursive: true });
    writeFileSync(join(projectDir, `${id}.jsonl`), `${JSON.stringify({ type: 'user', uuid: `${id}-u`, timestamp: at, cwd, sessionId: id, isSidechain: false, message: { role: 'user', content: 'hi' } })}\n`);
    writeFileSync(join(projectDir, id, 'subagents', 'agent-a.jsonl'), '{}\n');
  }
  const db = new Db(config);
  db.saveChats([stored('old-chat', cwd, old), stored('recent-chat', cwd, recent)], null);
  db.close();

  const core = new Core(config);
  t.after(() => core.shutdown());
  await core.restored;
  // The sweep runs right after the restore; bounded, so a sweeper that never runs fails here
  const until = Date.now() + 10_000;
  while (existsSync(join(projectDir, 'old-chat.jsonl')) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(existsSync(join(projectDir, 'old-chat.jsonl')), false, 'the transcript is gone');
  assert.equal(existsSync(join(projectDir, 'old-chat')), false, 'and its sidecar folder');
  assert.deepEqual(core.db.loadChats().map((c) => c.record.id), ['recent-chat']);
  assert.equal(existsSync(join(projectDir, 'recent-chat.jsonl')), true);
});
