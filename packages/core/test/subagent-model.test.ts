import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentLaunch, type TranscriptEntry } from '@claudio/shared';
import { toChildren } from '../src/chat-branches.ts';
import { ClaudeBranches } from '../src/providers/claude-code/branches.ts';
import { SessionStore } from '../src/sessions.ts';
import { tempConfig } from './helpers.ts';

// A subagent's card names the model it runs on and the effort its launch named, and nothing it would have to guess (docs/chat-tool-rows-and-branches.md)

const line = (o: object) => JSON.stringify(o);

const launch = (id: string, input: Record<string, unknown>): TranscriptEntry =>
  ({ type: 'assistant', role: 'assistant', blocks: [{ type: 'tool_use', id, name: 'Agent', input: { description: 'Audit', subagent_type: 'general-purpose', ...input } }] }) as unknown as TranscriptEntry;
const sidechain = (parent: string, model: string | null): TranscriptEntry =>
  ({ role: 'assistant', model, isSidechain: true, parentToolUseId: parent, blocks: [{ type: 'text', text: 'hi' }] }) as unknown as TranscriptEntry;

const served = (chat: ClaudeBranches) => toChildren({ subagents: [...chat.subagents.values()], tasks: [], workflows: [] }, 's').subagents;

test('a launch that names a model and an effort is served with both', () => {
  const chat = new ClaudeBranches();
  chat.message(launch('toolu_a', { model: 'opus', effort: 'high' }));
  const [agent] = served(chat);
  assert.equal(agent?.model, 'opus');
  assert.equal(agent?.effort, 'high');
});

test('a launch that inherits serves no model and no effort, not a guess', () => {
  const chat = new ClaudeBranches();
  chat.message(launch('toolu_a', {}));
  chat.message(launch('toolu_b', { model: 'inherit', effort: '' }));
  for (const agent of served(chat)) {
    assert.equal(agent.model, null);
    assert.equal(agent.effort, null);
  }
});

test('the model the subagent own messages report wins over the one its launch asked for', () => {
  const chat = new ClaudeBranches();
  chat.message(launch('toolu_a', { model: 'sonnet' }));
  chat.message(launch('toolu_b', {}));
  chat.message(sidechain('toolu_a', 'claude-opus-5-5'));
  chat.message(sidechain('toolu_b', 'claude-haiku-5-5'));
  // A placeholder the CLI stamps on a message it made up is no model
  chat.message(sidechain('toolu_b', '<synthetic>'));
  const byId = new Map(served(chat).map((agent) => [agent.id, agent]));
  assert.equal(byId.get('toolu_a')?.model, 'claude-opus-5-5');
  assert.equal(byId.get('toolu_b')?.model, 'claude-haiku-5-5');
});

test('agentLaunch reads absent what the call left to inherit', () => {
  assert.deepEqual(agentLaunch({ model: ' opus ', effort: 'max' }), { requestedModel: 'opus', effort: 'max' });
  assert.deepEqual(agentLaunch({ model: 'inherit', effort: 3 }), { requestedModel: null, effort: null });
});

test('read from disk, a subagent has its launch call model and effort, and the model its transcript ran on', async () => {
  const config = tempConfig();
  const project = join(config.projectsDir, '-work-model');
  const sid = 'ffff-6666';
  const agents = join(project, sid, 'subagents');
  mkdirSync(agents, { recursive: true });
  const call = (id: string, input: Record<string, unknown>) =>
    line({ type: 'assistant', uuid: `c-${id}`, timestamp: '2026-11-13T10:00:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input }] } });
  writeFileSync(
    join(project, `${sid}.jsonl`),
    [
      line({ type: 'user', uuid: 'u0', timestamp: '2026-11-13T09:59:00.000Z', message: { role: 'user', content: 'Go' } }),
      call('toolu_asked', { description: 'Asked', model: 'opus', effort: 'xhigh' }),
      call('toolu_inherit', { description: 'Inherits' }),
      call('toolu_ran', { description: 'Ran', model: 'sonnet' }),
    ].join('\n'),
  );
  const agent = (id: string, toolUseId: string, ranOn: string | null) => {
    writeFileSync(join(agents, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: id, toolUseId }));
    const rows = [line({ type: 'user', uuid: `u-${id}`, cwd: '/work', message: { role: 'user', content: 'Do it' } })];
    if (ranOn) rows.push(line({ type: 'assistant', uuid: `a-${id}`, message: { role: 'assistant', model: ranOn, content: [{ type: 'text', text: 'ok' }] } }));
    writeFileSync(join(agents, `agent-${id}.jsonl`), rows.join('\n'));
  };
  agent('asked', 'toolu_asked', null);
  agent('inherit', 'toolu_inherit', 'claude-opus-5-5');
  agent('ran', 'toolu_ran', 'claude-haiku-5-5');

  const store = new SessionStore(config);
  const byId = new Map(toChildren({ subagents: await store.subagents(sid), tasks: [], workflows: [] }, sid).subagents.map((s) => [s.id, s]));
  // Launch named both, and its transcript has not said anything yet
  assert.equal(byId.get('asked')?.model, 'opus');
  assert.equal(byId.get('asked')?.effort, 'xhigh');
  // Launch named nothing: what it ran on is all there is
  assert.equal(byId.get('inherit')?.model, 'claude-opus-5-5');
  assert.equal(byId.get('inherit')?.effort, null);
  // Launch named sonnet, and it ran on haiku
  assert.equal(byId.get('ran')?.model, 'claude-haiku-5-5');

  const detail = await store.agentTranscript(sid, 'asked');
  assert.equal(detail?.model, 'opus');
  assert.equal(detail?.effort, 'xhigh');
  assert.equal((await store.agentTranscript(sid, 'ran'))?.model, 'claude-haiku-5-5');
});
