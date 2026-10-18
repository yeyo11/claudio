import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { runsElapsedMs, type TranscriptEntry } from '@claudio/shared';
import { toChildren } from '../src/chat-branches.ts';
import { ClaudeBranches } from '../src/providers/claude-code/branches.ts';
import { SessionStore } from '../src/sessions.ts';
import { tempConfig } from './helpers.ts';

// An agent its parent resumed is one agent with several runs, not two agents (docs/chat-tool-rows-and-branches.md)

const line = (o: object) => JSON.stringify(o);
const at = (clock: string) => `2026-10-18T${clock}.000Z`;

const useCall = (id: string, name: string): TranscriptEntry =>
  ({ type: 'assistant', blocks: [{ type: 'tool_use', id, name, input: { description: 'Audit', subagent_type: 'general-purpose' } }] }) as unknown as TranscriptEntry;
const resultFor = (toolUseId: string, isError = false): TranscriptEntry =>
  ({ type: 'user', blocks: [{ type: 'tool_result', toolUseId, content: 'ok', isError }] }) as unknown as TranscriptEntry;

test('an agent resumed with SendMessage stays one record, with a run per start and no phantom left running', () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse(at('15:33:46')) });
  try {
    const chat = new ClaudeBranches();
    chat.message(useCall('toolu_agent', 'Agent'));
    chat.task('task_started', { task_id: 'agent-1', tool_use_id: 'toolu_agent', task_type: 'local_agent', is_backgrounded: true });
    chat.message(resultFor('toolu_agent'));
    mock.timers.setTime(Date.parse(at('15:40:46')));
    chat.task('task_notification', { task_id: 'agent-1', tool_use_id: 'toolu_agent', status: 'completed' });

    // The resume carries the SendMessage call's id, which no subagent was launched under
    mock.timers.setTime(Date.parse(at('16:21:41')));
    chat.task('task_started', { task_id: 'agent-1', tool_use_id: 'toolu_send', task_type: 'local_agent', is_backgrounded: true });
    assert.equal(chat.subagents.size, 1);
    const [during] = chat.subagents.values();
    assert.equal(during?.status, 'running');
    assert.equal(during?.endedAt, null);
    assert.equal(during?.startedAt, at('15:33:46'));

    mock.timers.setTime(Date.parse(at('16:27:41')));
    chat.task('task_notification', { task_id: 'agent-1', tool_use_id: 'toolu_send', status: 'completed' });

    const [agent] = chat.subagents.values();
    assert.equal(chat.subagents.size, 1);
    assert.equal(agent?.status, 'completed');
    assert.equal(agent?.endedAt, at('16:27:41'));
    assert.deepEqual(agent?.runs, [
      { startedAt: at('15:33:46'), endedAt: at('15:40:46') },
      { startedAt: at('16:21:41'), endedAt: at('16:27:41') },
    ]);
    // 7 min + 6 min of work; the 41 min wait between them is not
    assert.equal(runsElapsedMs(agent?.runs ?? [], 0), 13 * 60_000);
  } finally {
    mock.timers.reset();
  }
});

test('a resumed agent runs on its current run, and a chat nothing holds ends that run with it', () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse(at('10:00:00')) });
  try {
    const chat = new ClaudeBranches();
    chat.task('task_started', { task_id: 'agent-2', tool_use_id: 'toolu_a', task_type: 'local_agent', is_backgrounded: true });
    mock.timers.setTime(Date.parse(at('10:05:00')));
    chat.task('task_notification', { task_id: 'agent-2', status: 'completed' });
    mock.timers.setTime(Date.parse(at('11:00:00')));
    chat.task('task_started', { task_id: 'agent-2', tool_use_id: 'toolu_send', task_type: 'local_agent', is_backgrounded: true });

    const live = toChildren({ subagents: [...chat.subagents.values()], tasks: [], workflows: [] }, 's').subagents;
    assert.equal(live.length, 1);
    assert.equal(live[0]?.status, 'running');
    assert.equal(runsElapsedMs(live[0]?.runs ?? [], Date.parse(at('11:02:00'))), 2 * 60_000);

    const settled = toChildren({ subagents: [...chat.subagents.values()], tasks: [], workflows: [] }, 's', at('11:03:00')).subagents;
    assert.equal(settled[0]?.status, 'stopped');
    assert.equal(runsElapsedMs(settled[0]?.runs ?? [], Date.parse(at('12:00:00'))), 8 * 60_000);
  } finally {
    mock.timers.reset();
  }
});

test('two records for one agent id become one child, the one that saw more runs', () => {
  const base = { toolUseId: 't', subagentType: 'Explore', description: 'x', agentId: 'dup' } as const;
  const original = { ...base, status: 'completed' as const, startedAt: at('10:00:00'), endedAt: at('10:05:00'), runs: [{ startedAt: at('10:00:00'), endedAt: at('10:05:00') }, { startedAt: at('11:00:00'), endedAt: at('11:05:00') }] };
  const phantom = { ...base, status: 'running' as const, startedAt: at('11:00:00'), endedAt: null, runs: [{ startedAt: at('11:00:00'), endedAt: null }] };
  const { subagents } = toChildren({ subagents: [phantom, original], tasks: [], workflows: [] }, 's');
  assert.deepEqual(subagents.map((s) => [s.id, s.status]), [['dup', 'completed']]);
});

test('stopped and killed agents are stopped, not failed', () => {
  const chat = new ClaudeBranches();
  for (const [id, status] of [['a-stopped', 'stopped'], ['a-killed', 'killed'], ['a-failed', 'failed']] as const) {
    chat.task('task_started', { task_id: id, tool_use_id: `t-${id}`, task_type: 'local_agent', is_backgrounded: true });
    chat.task('task_notification', { task_id: id, status });
  }
  const byId = Object.fromEntries([...chat.subagents.values()].map((s) => [s.agentId, s.status]));
  assert.deepEqual(byId, { 'a-stopped': 'stopped', 'a-killed': 'stopped', 'a-failed': 'failed' });
});

test('the same replay read from disk gives the same one record with two runs', async () => {
  const config = tempConfig();
  const project = join(config.projectsDir, '-work-resume');
  const sid = 'eeee-5555';
  const agents = join(project, sid, 'subagents');
  mkdirSync(agents, { recursive: true });
  const notify = (id: string, status: string, when: string) =>
    line({ type: 'user', uuid: `n-${when}`, timestamp: when, message: { role: 'user', content: `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n</task-notification>` } });
  writeFileSync(
    join(project, `${sid}.jsonl`),
    [
      line({ type: 'user', uuid: 'u0', timestamp: at('15:33:00'), message: { role: 'user', content: 'Go' } }),
      line({ type: 'user', uuid: 'l1', timestamp: at('15:33:46'), toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'abc' } }),
      notify('abc', 'completed', at('15:40:46')),
      line({ type: 'user', uuid: 'r1', timestamp: at('16:21:41'), toolUseResult: { success: true, resumedAgentId: 'abc' } }),
      notify('abc', 'completed', at('16:27:41')),
    ].join('\n'),
  );
  writeFileSync(join(agents, 'agent-abc.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Audit', toolUseId: 'toolu_agent', requestShape: 'background' }));
  const file = join(agents, 'agent-abc.jsonl');
  writeFileSync(file, line({ type: 'assistant', uuid: 'a', cwd: '/work', message: { role: 'assistant', content: [] } }));
  utimesSync(file, new Date(at('16:27:40')), new Date(at('16:27:40')));

  const [agent] = await new SessionStore(config).subagents(sid);
  assert.equal(agent?.status, 'completed');
  assert.equal(agent?.startedAt, at('15:33:46'));
  assert.equal(agent?.endedAt, at('16:27:41'));
  assert.deepEqual(agent?.runs, [
    { startedAt: at('15:33:46'), endedAt: at('15:40:46') },
    { startedAt: at('16:21:41'), endedAt: at('16:27:41') },
  ]);
  const transcript = await new SessionStore(config).agentTranscript(sid, 'abc');
  assert.equal(transcript?.durationMs, 13 * 60_000);
  assert.equal(transcript?.runs.length, 2);
});

test('a resumed agent that has not stopped again reads as running on a new run', async () => {
  const config = tempConfig();
  const project = join(config.projectsDir, '-work-resume2');
  const sid = 'ffff-6666';
  const agents = join(project, sid, 'subagents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(
    join(project, `${sid}.jsonl`),
    [
      line({ type: 'user', uuid: 'l1', timestamp: at('10:00:00'), toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'abc' } }),
      line({ type: 'user', uuid: 'n1', timestamp: at('10:05:00'), message: { role: 'user', content: '<task-notification><task-id>abc</task-id><status>completed</status></task-notification>' } }),
      line({ type: 'user', uuid: 'r1', timestamp: at('11:00:00'), toolUseResult: { resumedAgentId: 'abc' } }),
    ].join('\n'),
  );
  writeFileSync(join(agents, 'agent-abc.meta.json'), JSON.stringify({ agentType: 'fork', description: 'x' }));
  const file = join(agents, 'agent-abc.jsonl');
  writeFileSync(file, line({ type: 'assistant', uuid: 'a', message: { role: 'assistant', content: [] } }));
  utimesSync(file, new Date(at('10:04:00')), new Date(at('10:04:00')));

  const [agent] = await new SessionStore(config).subagents(sid);
  assert.equal(agent?.status, 'running');
  assert.equal(agent?.endedAt, null);
  assert.deepEqual(agent?.runs, [
    { startedAt: at('10:00:00'), endedAt: at('10:05:00') },
    { startedAt: at('11:00:00'), endedAt: null },
  ]);
});

test('a notification that lists several tasks stops each, and skips the orphan summary marker', async () => {
  const config = tempConfig();
  const project = join(config.projectsDir, '-work-orphan');
  const sid = 'gggg-7777';
  const agents = join(project, sid, 'subagents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(
    join(project, `${sid}.jsonl`),
    [
      line({ type: 'user', uuid: 'l1', timestamp: at('10:00:00'), toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'second' } }),
      line({
        type: 'user',
        uuid: 'n1',
        timestamp: at('10:09:00'),
        message: {
          role: 'user',
          content:
            '<task-notification>\n<task-id>first</task-id>\n<task-id>second</task-id>\n<task-id>__orphan_summary__:shell</task-id>\n<status>killed</status>\n</task-notification>',
        },
      }),
    ].join('\n'),
  );
  writeFileSync(join(agents, 'agent-second.meta.json'), JSON.stringify({ agentType: 'fork', description: 'x' }));
  const file = join(agents, 'agent-second.jsonl');
  writeFileSync(file, line({ type: 'assistant', uuid: 'a', message: { role: 'assistant', content: [] } }));
  utimesSync(file, new Date(at('10:08:00')), new Date(at('10:08:00')));

  const [agent] = await new SessionStore(config).subagents(sid);
  // Named second in the list, and killed is stopped (warn), not failed
  assert.equal(agent?.status, 'stopped');
  assert.equal(agent?.endedAt, at('10:09:00'));
});
