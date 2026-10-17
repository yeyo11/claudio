import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { foldJournal, isSynthesis, journalError, readJournalTasks } from '../src/workflow-journal.ts';
import { readAgentEnd, readSessionWorkflows, readWorkflowAgent, readWorkflowJournal } from '../src/workflows.ts';

// Orchestration f33d7d0b's files, trimmed (R15): t1 and t2 completed, then t3 and the synthesis were
// refused at the account's five-hour limit; `resumed` is the same run after a stop and a resume
const SESSION = '00000000-0000-4000-8000-000000000001';
const RUN = 'wf_fixture-0001';
const transcript = (stage: 'at-limit' | 'resumed') => fileURLToPath(new URL(`./fixtures/workflow-journal/${stage}/${SESSION}.jsonl`, import.meta.url));
const LIMIT_TEXT = "You've hit your session limit · resets 2:40am (Europe/Madrid)";

test('the journal at the limit: finished tasks with their whole result, a failed task and a failed synthesis with what the agent last said', async () => {
  const read = await readJournalTasks(transcript('at-limit'), RUN);
  assert.equal(read.lines, 9);
  assert.deepEqual(
    read.tasks.map((t) => [t.label, t.phase, t.state, t.result]),
    [
      ['t1', 'Tasks', 'completed', 't1 is finished: the change is committed on its branch, tree clean, not pushed.'],
      ['t2', 'Tasks', 'completed', 't2 is finished: the tests it added pass and the work is committed.'],
      ['t3', 'Tasks', 'failed', null],
      ['synthesis', 'Synthesis', 'failed', null],
    ],
  );
  const [, , t3, synthesis] = read.tasks;
  assert.ok(t3 && synthesis);
  assert.equal(journalError(t3), LIMIT_TEXT);
  assert.ok(isSynthesis(synthesis) && !isSynthesis(t3));
  // A limit is told by the fields the CLI records, never by the words: section 2 of the plan reads them
  assert.deepEqual(synthesis.end, { text: LIMIT_TEXT, apiErrorStatus: 429, error: 'rate_limit', rateLimit: { resetsAt: '2026-10-17T00:40:00.000Z', rateLimitType: 'five_hour' } });
  // A completed agent's end has no error on it
  assert.deepEqual(await readAgentEnd(transcript('at-limit'), RUN, 'a0000000000000001'), {
    text: 't1 is finished: the change is committed on its branch, tree clean, not pushed.',
    apiErrorStatus: null,
    error: null,
    rateLimit: null,
  });
});

test('after a resume the latest line of a key wins, and a launch into the same run reads only what it added', async () => {
  const all = await readJournalTasks(transcript('resumed'), RUN);
  assert.equal(all.lines, 13);
  assert.deepEqual(
    all.tasks.map((t) => [t.label, t.state, t.agentId, t.end]),
    [
      ['t1', 'completed', 'a0000000000000001', null],
      ['t2', 'completed', 'a0000000000000002', null],
      ['t3', 'completed', 'a0000000000000005', null],
      ['synthesis', 'completed', 'a0000000000000006', null],
    ],
  );
  assert.equal(all.tasks.at(-1)?.result, '# Final report\n\nEvery task completed.');

  // What the resume added after the 9 lines the run had when it was launched again
  const added = await readJournalTasks(transcript('resumed'), RUN, 9);
  assert.deepEqual(
    added.tasks.map((t) => [t.label, t.state]),
    [
      ['t3', 'completed'],
      ['synthesis', 'completed'],
    ],
  );
  // Only the `started` line names the task: a result whose start came before `from` is nobody's
  assert.deepEqual(foldJournal(await readWorkflowJournal(transcript('resumed'), RUN), 10), [
    { label: 'synthesis', key: `v2:${'4'.repeat(64)}`, agentId: 'a0000000000000006', phase: 'Synthesis', state: 'completed', result: '# Final report\n\nEvery task completed.', end: null },
  ]);
});

test('a resumed call that started again runs, whatever its earlier attempt ended with', () => {
  const tasks = foldJournal([
    { type: 'started', key: 'k', agentId: 'a1', label: 't3', phase: 'Tasks', result: undefined },
    { type: 'failed', key: 'k', agentId: 'a1', label: null, phase: null, result: undefined },
    { type: 'started', key: 'k', agentId: 'a2', label: 't3', phase: 'Tasks', result: undefined },
    // A task may be named like the synthesis: the phase tells them apart
    { type: 'started', key: 's', agentId: 'a3', label: 'synthesis', phase: 'Tasks', result: undefined },
    { type: 'result', key: 's', agentId: 'a3', label: null, phase: null, result: { structured: true } },
  ]);
  assert.deepEqual(
    tasks.map((t) => [t.label, t.state, t.agentId, t.result, isSynthesis(t)]),
    [
      ['t3', 'running', 'a2', null, false],
      ['synthesis', 'completed', 'a3', '{"structured":true}', false],
    ],
  );
});

test('the run and agent readers record a failed agent as failed, not as still going', async () => {
  const [run] = await readSessionWorkflows(transcript('at-limit'), SESSION, true);
  assert.deepEqual(
    run?.agents.map((a) => [a.label, a.state]),
    [
      ['t1', 'done'],
      ['t2', 'done'],
      ['t3', 'error'],
      ['synthesis', 'error'],
    ],
  );
  const t3 = await readWorkflowAgent(transcript('at-limit'), RUN, 'a0000000000000003');
  assert.equal(t3.agent?.state, 'error');
  assert.equal(t3.journalDone, false);
});
