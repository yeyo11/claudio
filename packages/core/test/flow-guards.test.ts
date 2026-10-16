import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import test from 'node:test';
import type { ProjectSettings } from '@claudio/shared';
import { Db } from '../src/db.ts';
import { EventBus } from '../src/events.ts';
import { FlowService, type FlowLaunch } from '../src/flow.ts';
import { GuardUnavailableError } from '../src/guards/preflight.ts';
import { WorkItemService } from '../src/work-items.ts';
import { tempConfig } from './helpers.ts';

// A flow run whose guard cannot run never gets a chat: the run fails as "not started", and its
// error names the guard and the problem, for the card and for the person who reads it.

const SETTINGS: ProjectSettings = {
  modules: ['board', 'team', 'memory', 'documents'],
  template: 'software',
  keyPrefix: 'AGN',
  board: { types: ['epic', 'story', 'task', 'bug'], columnLimits: {} },
  team: { members: [{ agent: 'developer', role: 'developer', model: 'sonnet', responsibility: 'Implements' }] },
  flow: { enabled: true, columns: { in_progress: 'developer' }, maxBounces: 2 },
};

function setup(launch: (launch: FlowLaunch, onStart: (chatId: string) => void) => Promise<void>) {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(config);
  const bus = new EventBus();
  const items = new WorkItemService({ db, project: (id) => (id === 'p1' ? { keyPrefix: 'AGN', columnLimits: {} } : null), emit: (e) => bus.emit(e) });
  const flow = new FlowService({
    db,
    items,
    project: (id) => (id === 'p1' ? { path: '/nowhere/p1', settings: SETTINGS } : null),
    handoff: () => '# Project journal',
    propose: () => undefined,
    tie: async () => undefined,
    launch,
    chatBusy: () => false,
    limitHeld: () => false,
    cost: () => null,
    uncommitted: () => [],
    language: () => 'en',
    stop: () => undefined,
    emit: (e) => bus.emit(e),
  });
  bus.observe((e) => flow.observe(e));
  flow.recover();
  return { items, flow };
}

test('a flow run whose guard cannot run fails as not started, naming the guard and the problem', async () => {
  const { items, flow } = setup(async () => {
    throw new GuardUnavailableError('entry-untrusted', '/work/guard.mjs is under a project');
  });
  const created = items.create('p1', { title: 'Fix the cart', status: 'in_progress', type: 'task' });
  await flow.settled();
  const run = flow.itemRuns(created.id)[0];
  assert.equal(run?.outcome, 'failed');
  assert.equal(run?.cause, 'not-started');
  assert.match(run?.error ?? '', /^guard-unavailable \(entry-untrusted\): Guards cannot start \(entry-untrusted\)/);
  assert.equal(run?.chatId, null);
});
