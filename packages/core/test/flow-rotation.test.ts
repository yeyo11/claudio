import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { AgentryEvent, FlowRun, FlowRunEvent, ProjectSettings } from '@agentry/shared';
import { Core } from '../src/index.ts';
import { tempConfig } from './helpers.ts';

// The flow through the real core, the fake Claude (`FAKE-LIMIT-ONCE`) (`FAKE-LIMIT-ONCE`):
// what happens to a run at a usage limit.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
process.env.FAKE_CLAUDE_LOGGED_IN = '1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-flow-rotation-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# Shop\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'shop', scripts: { test: 'node --test' } }));
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  return dir;
}

async function until<T>(read: () => T, done: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 1200; i++) {
    const value = read();
    if (done(value)) return value;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A core whose data directory already says how long a run waits at a limit. */
function configWith() {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(join(config.dataDir, 'providers.json'), JSON.stringify({ rotation: { onLimit: { action: 'wait', allowed: ['wait'], maxWaitHours: 6 } } }));
  return config;
}

async function flowProject(core: Core, dir: string, change: (s: ProjectSettings) => ProjectSettings = (s) => s) {
  const project = await core.importProject({ path: dir, name: 'shop', template: 'software', modules: ['board', 'team', 'documents'] });
  await core.team.fromTemplate(project.id, { roles: ['product-owner', 'developer', 'qa'] });
  const settings = await core.projectSettings(project.id);
  await core.saveProjectSettings(project.id, change({ ...settings, flow: { ...settings.flow!, enabled: true, maxParallel: 1, columns: { in_progress: 'developer' } } }));
  return project;
}

/** The `flow.run` events of an action, as they reach a client */
function flowEvents(core: Core, action: FlowRunEvent['action']): () => FlowRunEvent[] {
  const seen: AgentryEvent[] = [];
  core.events.subscribe((e) => seen.push(e));
  return () => seen.filter((e): e is FlowRunEvent => e.type === 'flow.run' && e.action === action);
}

const WORK = { summary: 'Implemented', memoryProposals: [], documents: [] };
const limited = (title: string) => ({ title, status: 'in_progress' as const, type: 'task' as const, description: `FAKE-LIMIT-ONCE\nFAKE-RESULT-WORK ${JSON.stringify(WORK)}` });
const workRun = (core: Core, projectId: string, title?: string): FlowRun | undefined =>
  core.flow.runs(projectId).find((r) => r.stage === 'work' && (!title || r.item?.title === title));

test('a flow run at its limit waits for the reset, and a person can stop waiting', async () => {
  const core = new Core(configWith());
  try {
    const waits = flowEvents(core, 'waiting');
    const project = await flowProject(core, repo(), (s) => ({ ...s, flow: { ...s.flow!, maxCostUsd: 5 } }));
    core.workItems.create(project.id, limited('Fix the cart'));
    // The second card waits for a place: `maxParallel` is 1 and the waiting run keeps its own
    const second = core.workItems.create(project.id, { title: 'Fix the cart again', status: 'in_progress', type: 'task', description: `FAKE-RESULT-WORK ${JSON.stringify(WORK)}` });
    const run = await until(() => workRun(core, project.id, 'Fix the cart'), (r) => !!r?.chatId, 'the run to start');
    const wait = await until(() => core.db.providerMoves({ subjectKind: 'flow_run', subjectId: run!.id })[0], (m) => !!m, 'the wait to be recorded');
    assert.equal(wait?.action, 'wait');
    assert.equal(wait?.state, 'waiting');
    assert.equal(wait?.toChat, null);
    // Still running, in the same chat, on Claude; it holds its place while the other card waits
    const waiting = core.flow.runs(project.id).find((r) => r.id === run!.id);
    assert.equal(waiting?.state, 'running');
    assert.equal(waiting?.chatId, run!.chatId);
    assert.equal(waiting?.provider, 'claude-code');
    assert.equal(waiting?.waiting?.moveId, wait?.id);
    // ... and the board hears it: a `flow.run` update with the provider and when its limit resets
    assert.equal(waits().length, 1);
    assert.equal(waits()[0]?.runId, run!.id);
    assert.equal(waits()[0]?.provider, 'claude-code');
    assert.ok(waits()[0] && 'resetsAt' in waits()[0]!);
    await sleep(300);
    const other = core.flow.itemRuns(second.id)[0];
    assert.equal(other?.state, 'queued', 'a waiting run holds its place under maxParallel');

    // A person stops waiting: the run fails saying so, and the next card gets its place
    assert.equal(core.rotation.cancel(wait!.id), true);
    const ended = await until(() => core.flow.runs(project.id).find((r) => r.id === run!.id), (r) => r?.state === 'ended', 'the run to end');
    assert.equal(ended?.outcome, 'failed');
    assert.equal(ended?.cause, 'stopped');
    await until(() => core.flow.itemRuns(second.id)[0]?.state, (s) => s === 'running' || s === 'ended', 'the second run to take the place');
  } finally {
    core.shutdown();
  }
});
