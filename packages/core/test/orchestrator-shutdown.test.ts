import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Core } from '../src/index.ts';
import { tempConfig } from './helpers.ts';

const FAKE_CLAUDE = join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');

// A launch refused for a slot (the run limit, the machine's memory, a guard self-test still running)
// is tried again 3 s later. That retry used to outlive `Core.shutdown`: it fired on a closed database
// (the spend gate read it first, "database is not open", an uncaught exception) and would have
// started a chat in a wrapper that was going away.
test('a launch retry still pending at shutdown never fires: no closed-database error, no task started', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const core = new Core(config);
  const cwd = mkdtempSync(join(tmpdir(), 'claudio-shutdown-'));
  const uncaught: unknown[] = [];
  const hear = (err: unknown) => void uncaught.push(err);
  process.on('uncaughtException', hear);
  try {
    // A cap makes `schedule` read the spend from the database before anything else
    await core.appSettings.update({ dailySpendCapUsd: 10, maxConcurrentRuns: 1 });
    // The one slot there is, held by a chat that is still working when the graph asks for it
    core.runtime.start({ prompt: 'FAKE-SLEEP 60000', cwd });
    const graph = core.orchestrator.create({ name: 'refused', cwd, tasks: [{ id: 'a', name: 'a', prompt: 'do it' }] });
    const task = core.orchestrator.get(graph.id)?.tasks[0];
    assert.equal(task?.status, 'pending', 'the launch was refused for the slot and waits for its retry');

    core.shutdown();
    await new Promise((r) => setTimeout(r, 3_500));

    assert.deepEqual(uncaught.map(String), []);
    const after = core.orchestrator.get(graph.id)?.tasks[0];
    assert.equal(after?.status, 'pending');
    assert.equal(after?.runId ?? null, null, 'no chat was started for the task after shutdown');
  } finally {
    process.off('uncaughtException', hear);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(join(config.dataDir, '..'), { recursive: true, force: true });
  }
});
