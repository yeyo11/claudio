import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Orchestration } from '@claudio/shared';
import { ChatManager, type NewChat } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import { writeGuardFiles } from '../src/guards/files.ts';
import { DEFAULT_LIMITS, type GuardRulesFile } from '../src/guards/input.ts';
import { GuardLauncher, type GuardRequest } from '../src/guards/launch.ts';
import { GuardUnavailableError } from '../src/guards/preflight.ts';
import type { GuardRunKind } from '../src/guards/resolve.ts';
import { GuardSettingsStore } from '../src/guards/settings.ts';
import type { ChatGuardPlan } from '../src/live-chat.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { tempConfig } from './helpers.ts';

// The orchestrator asks the launcher for a plan before every run it starts, and hands the chat what
// comes back. The launcher is a stub here (the real one is tested with the preflight); what these
// tests pin is which runs ask, with what, and that a refusal ends the task before a process exists.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

/** A chat manager that remembers what it was asked to start */
class SpyChats extends ChatManager {
  started: NewChat[] = [];
  override start(opts: NewChat, meta = {}) {
    this.started.push(opts);
    return super.start(opts, meta);
  }
}

function repoWithCommit(): string {
  const repo = mkdtempSync(join(tmpdir(), 'orch-guards-'));
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'README.md'), 'hi\n');
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
  return repo;
}

async function settle(orchestrator: Orchestrator, id: string): Promise<Orchestration> {
  for (let i = 0; i < 300; i++) {
    const orch = orchestrator.get(id);
    if (orch && orch.status !== 'running') return orch;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the orchestration never finished');
}

const GUARD_ENTRY = fileURLToPath(new URL('../src/guards/main.ts', import.meta.url));

/** Real guard files, so the fake CLI arms the way the real one does */
function realPlan(dataDir: string, root: string): ChatGuardPlan {
  const rules: GuardRulesFile = {
    version: 1,
    mode: 'enforce',
    rules: ['integrity', 'push'],
    roots: [root],
    mainCheckout: null,
    hooksPathDir: null,
    dataDir,
    guardDir: join(GUARD_ENTRY, '..'),
    claudeConfigDirs: [],
    protectConfigs: [],
    knownSecretSha256: [],
    limits: { ...DEFAULT_LIMITS },
  };
  const files = writeGuardFiles(dataDir, rules, { execPath: process.execPath, entry: GUARD_ENTRY, electron: false, nodeVersion: process.versions.node });
  return { rules: rules.rules, mode: 'enforce', settingsPath: files.settingsPath, rulesSha256: files.rulesSha256 };
}

/** Records what it is asked and answers with `answer` (a plan, null, or an error to throw) */
function stubLauncher(answer: (request: GuardRequest) => ChatGuardPlan | null | Error) {
  const requests: GuardRequest[] = [];
  const launcher = {
    prepareNow(request: GuardRequest) {
      requests.push(request);
      const result = answer(request);
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as GuardLauncher;
  return { launcher, requests };
}

function setup(answer: (request: GuardRequest, plan: ChatGuardPlan) => ChatGuardPlan | null | Error) {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const plan = realPlan(config.dataDir, config.workspaceDir);
  const db = new Db(config);
  const runs = new SpyChats(config, db);
  const orchestrator = new Orchestrator(config, runs, db);
  const stub = stubLauncher((request) => answer(request, plan));
  const guardPlan = plan;
  orchestrator.guards = stub.launcher;
  return { orchestrator, runs, db, plan: guardPlan, ...stub };
}

test('a worker and the synthesis ask for a guard and carry the plan to their chat', async () => {
  const { orchestrator, runs, requests, db, plan } = setup((_request, plan) => plan);
  const repo = repoWithCommit();
  const started = orchestrator.create({
    name: 'guarded',
    cwd: repo,
    worktree: true,
    synthesize: true,
    guards: { rules: { push: true } },
    tasks: [{ id: 'a', name: 'A', prompt: 'FAKE-WRITE a.txt one' }],
  });
  const orch = await settle(orchestrator, started.id);
  assert.equal(orch.status, 'completed');
  const kinds = requests.map((r) => r.kind);
  assert.ok(kinds.includes('worker'));
  assert.ok(kinds.includes('synthesis'));
  // The graph's override and its checkout reach the resolution; the worker's own worktree is its root
  const worker = requests.find((r) => r.kind === 'worker');
  assert.deepEqual(worker?.graph, { rules: { push: true } });
  assert.equal(worker?.mainCheckout, orch.cwd);
  assert.ok(worker?.worktree && worker.worktree !== orch.cwd);
  assert.ok(runs.started.length >= 2);
  assert.ok(runs.started.every((opts) => opts.guards === plan));
  // The prompt's own line stays beside the hook
  assert.match(runs.started[0]?.prompt ?? '', /push/i);
  db.close();
});

test('a run kind the resolution leaves unguarded starts without a plan', async () => {
  const { orchestrator, runs, db } = setup(() => null);
  const repo = repoWithCommit();
  const started = orchestrator.create({ name: 'open', cwd: repo, tasks: [{ id: 'a', name: 'A', prompt: 'FAKE-WRITE a.txt one' }] });
  const orch = await settle(orchestrator, started.id);
  assert.equal(orch.status, 'completed');
  assert.ok(runs.started.length >= 1);
  assert.ok(runs.started.every((opts) => opts.guards === undefined));
  db.close();
});

test('a guard that cannot run fails the task before any CLI is spawned, with the code and the problem', async () => {
  const { orchestrator, runs, db } = setup(() => new GuardUnavailableError('self-test-failed', '`git push origin main` ended with 0, expected 2'));
  const repo = repoWithCommit();
  const started = orchestrator.create({ name: 'refused', cwd: repo, maxAttempts: 1, tasks: [{ id: 'a', name: 'A', prompt: 'FAKE-WRITE a.txt one' }] });
  const orch = await settle(orchestrator, started.id);
  const task = orch.tasks.find((t) => t.id === 'a');
  assert.equal(task?.status, 'failed');
  assert.match(task?.error ?? '', /^guard-unavailable \(self-test-failed\): could not start the worker: /);
  assert.equal(runs.started.length, 0);
  assert.equal(task?.runId, null);
  db.close();
});

test('a worker with no worktree of its own is guarded in its working directory', async () => {
  const { orchestrator, requests, db } = setup((_request, plan) => plan);
  const repo = repoWithCommit();
  const started = orchestrator.create({ name: 'plain', cwd: repo, tasks: [{ id: 'a', name: 'A', prompt: 'FAKE-WRITE a.txt one' }] });
  await settle(orchestrator, started.id);
  const worker = requests.find((r) => r.kind === 'worker');
  assert.equal(worker?.worktree, null);
  assert.equal(worker?.cwd, repo);
  db.close();
});

test('the resolution table: automated kinds are guarded, confined and internal kinds are not, chats only when the project opted in', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-table-'));
  const launcher = new GuardLauncher({ dataDir: dir, settings: new GuardSettingsStore(dir), capabilities: () => [] });
  const guarded = (kind: GuardRunKind, extra: Partial<GuardRequest> = {}) => launcher.resolve({ kind, cwd: dir, ...extra }) !== null;
  for (const kind of ['worker', 'integration', 'synthesis', 'verification-fixer', 'checks-fix', 'workflow', 'flow'] as const) assert.equal(guarded(kind), true, kind);
  for (const kind of ['planner', 'supervisor', 'assistant', 'decision', 'project-docs', 'lesson'] as const) assert.equal(guarded(kind), false, kind);
  assert.equal(guarded('chat'), false);
  assert.equal(guarded('chat', { project: { guards: { chats: true } } }), true);
  // A graph can switch its own guard off, and the run is then unguarded
  assert.equal(guarded('worker', { graph: { enabled: false } }), false);
  // A run that can neither run commands nor edit has nothing to guard
  assert.equal(guarded('worker', { policy: { commands: false, edits: false } }), false);
  assert.equal(guarded('worker', { policy: { commands: true, edits: false } }), true);
});
