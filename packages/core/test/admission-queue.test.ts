import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { INTERACTIVE_HOLD_MS, InteractiveHold, QUEUE_YIELD_PREFIX, classOfChat, classOfStart } from '../src/admission-queue.ts';
import { ChatRefusal } from '../src/chats.ts';
import { Core } from '../src/index.ts';
import { tempConfig } from './helpers.ts';

const FAKE_CLAUDE = join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');

test('only a person\'s start is interactive, and only an orchestrator task start (which asks again) is a worker', () => {
  assert.equal(classOfStart({ purpose: 'person' }), 'interactive');
  assert.equal(classOfStart({ purpose: 'person', internal: true }), 'other');
  assert.equal(classOfStart({ purpose: 'person', housekeeping: true }), 'other');
  assert.equal(classOfStart({ purpose: 'flow' }), 'other');
  assert.equal(classOfStart({}), 'other');
  // A graph's reviewer or lead says nothing of `queued`: giving way would fail it, not delay it
  assert.equal(classOfStart({ purpose: 'orchestration' }), 'other');
  assert.equal(classOfStart({ purpose: 'orchestration', queued: true }), 'worker');
  assert.equal(classOfChat('claudio'), 'interactive');
  assert.equal(classOfChat('orchestration'), 'other');
});

test('the hold lasts from the refusal for its window, and a person admitted ends it', () => {
  const hold = new InteractiveHold();
  assert.equal(hold.active(0), false);
  hold.hold(1_000);
  assert.equal(hold.active(1_000 + INTERACTIVE_HOLD_MS - 1), true);
  assert.equal(hold.active(1_000 + INTERACTIVE_HOLD_MS), false, 'a person who walked away does not keep a place empty');
  hold.hold(5_000);
  hold.release();
  assert.equal(hold.active(5_001), false);
});

test('a person refused a place is told what they always were, and the next place that frees up waits for their retry before a worker', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const core = new Core(config);
  const cwd = mkdtempSync(join(tmpdir(), 'claudio-queue-'));
  try {
    await core.appSettings.update({ maxConcurrentRuns: 1 });
    const first = core.runtime.start({ prompt: 'FAKE-SLEEP 60000', cwd, purpose: 'person' });

    // The report to the person is the one the count refusal always gave, with the same status
    const refused = (() => {
      try {
        core.runtime.start({ prompt: 'again', cwd, purpose: 'person' });
      } catch (err) {
        return err;
      }
      return null;
    })();
    assert.ok(refused instanceof ChatRefusal);
    assert.match(refused.message, /^Concurrent run limit reached \(1\)$/);
    assert.equal(refused.statusCode, 400);

    // The place frees up: a worker's start gives way to the person who was refused, and says so in the words the orchestrator matches
    core.runtime.stop(first.id);
    await core.runtime.exited(first.id);
    assert.throws(() => core.runtime.start({ prompt: 'work', cwd, purpose: 'orchestration' }, { queued: true }), (err: unknown) => err instanceof ChatRefusal && err.message.startsWith(QUEUE_YIELD_PREFIX) && err.statusCode === 409);
    // What is not a task start is not made to wait: it is only refused for what refuses it
    const reviewer = core.runtime.start({ prompt: 'FAKE-SLEEP 60000', cwd, purpose: 'orchestration' }, { orchestrationId: 'o' });
    core.runtime.stop(reviewer.id);
    await core.runtime.exited(reviewer.id);

    // A graph's task meets the same refusal and stays pending for its retry: it is neither failed nor started
    const graph = core.orchestrator.create({ name: 'waits', cwd, tasks: [{ id: 'a', name: 'a', prompt: 'do it' }] });
    const task = core.orchestrator.get(graph.id)?.tasks[0];
    assert.equal(task?.status, 'pending');
    assert.equal(task?.error ?? null, null, 'a place kept for a person is not a failure of the task');
    assert.equal(task?.runId ?? null, null);

    // The person's retry finds the place, and the hold is over: the worker is refused by the count again, not by the person
    const person = core.runtime.start({ prompt: 'FAKE-SLEEP 60000', cwd, purpose: 'person' });
    assert.ok(person.id);
    assert.throws(() => core.runtime.start({ prompt: 'work', cwd, purpose: 'orchestration' }, { queued: true }), /^Error: Concurrent run limit reached \(1\)$/);
  } finally {
    core.shutdown();
    await new Promise((r) => setTimeout(r, 100));
    rmSync(cwd, { recursive: true, force: true });
    rmSync(join(config.dataDir, '..'), { recursive: true, force: true });
  }
});
