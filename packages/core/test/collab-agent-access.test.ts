import assert from 'node:assert/strict';
import test from 'node:test';
import { PERMISSION_MODES, type PermissionMode } from '@claudio/shared';
import { agentReadScope, copyInScope, AGENT_READ_MODES, type AgentReadChat } from '../src/collab/agent-access.ts';
import { catalogAllowsAgents } from '../src/collab/client.ts';
import { CollabStore, Db, KEEP_AGENT_READS, pruneAgentReads } from '../src/db.ts';
import { parseSharing } from '../src/project-settings.ts';
import { tempConfig } from './helpers.ts';

const on = { enabled: true, assistantReads: true };
const assistant: AgentReadChat = { assistant: true, projectId: null, permissionMode: 'manual' };
const projectChat = (permissionMode: PermissionMode = 'acceptEdits', projectId: string | null = 'p1'): AgentReadChat => ({ assistant: false, projectId, permissionMode });
const optedIn = (id: string) => id === 'p1';

test('the assistant reads every copy while Collaborators and its switch are on', () => {
  assert.deepEqual(agentReadScope(assistant, on, optedIn), { scope: { kind: 'assistant' } });
  // In scope of some project or none, it is still the assistant
  assert.deepEqual(agentReadScope({ ...assistant, projectId: 'p2' }, on, optedIn), { scope: { kind: 'assistant' } });
  assert.deepEqual(agentReadScope(assistant, { enabled: true, assistantReads: false }, optedIn), { refusal: 'assistant-off' });
  assert.deepEqual(agentReadScope(assistant, { enabled: false, assistantReads: true }, optedIn), { refusal: 'off' });
});

test("a project's chat reads only with its project opted in", () => {
  assert.deepEqual(agentReadScope(projectChat(), on, optedIn), { scope: { kind: 'project', projectId: 'p1' } });
  assert.deepEqual(agentReadScope(projectChat('acceptEdits', 'p2'), on, optedIn), { refusal: 'project-off' });
  assert.deepEqual(agentReadScope(projectChat('acceptEdits', null), on, optedIn), { refusal: 'no-project' });
  assert.deepEqual(agentReadScope(projectChat(), { enabled: false, assistantReads: true }, optedIn), { refusal: 'off' });
  // The assistant's switch is the assistant's alone
  assert.deepEqual(agentReadScope(projectChat(), { enabled: true, assistantReads: false }, optedIn), { scope: { kind: 'project', projectId: 'p1' } });
});

test('only a chat that asks before running a command reads: never bypassPermissions, auto or dontAsk', () => {
  assert.deepEqual([...AGENT_READ_MODES].sort(), ['acceptEdits', 'manual', 'plan']);
  for (const mode of PERMISSION_MODES) {
    const expected = AGENT_READ_MODES.includes(mode);
    assert.equal('scope' in agentReadScope(projectChat(mode), on, optedIn), expected, mode);
    assert.equal('scope' in agentReadScope({ ...assistant, permissionMode: mode }, on, optedIn), expected, `assistant ${mode}`);
  }
  assert.deepEqual(agentReadScope(projectChat('bypassPermissions'), on, optedIn), { refusal: 'mode' });
  // An orchestration worker in an opted-in project is still refused
  assert.deepEqual(agentReadScope(projectChat('bypassPermissions', 'p1'), on, () => true), { refusal: 'mode' });
});

test('a chat Claudio has no record of reads nothing', () => {
  assert.deepEqual(agentReadScope(null, on, optedIn), { refusal: 'no-chat' });
  assert.deepEqual(agentReadScope({ ...assistant, permissionMode: null }, on, optedIn), { refusal: 'no-chat' });
});

test("a copy is in a project's scope by its link, or by its key when it has none; the sharer's flag wins over both", () => {
  const project = { kind: 'project', projectId: 'p1' } as const;
  const copy = { agentsMayRead: true, matches: ['p1'], linkedProjectId: null };
  assert.equal(copyInScope(project, copy), true);
  assert.equal(copyInScope(project, { ...copy, matches: ['p2'] }), false);
  assert.equal(copyInScope(project, { ...copy, matches: [], linkedProjectId: 'p1' }), true);
  // Linked elsewhere, a key match no longer brings it in
  assert.equal(copyInScope(project, { ...copy, linkedProjectId: 'p2' }), false);
  assert.equal(copyInScope({ kind: 'assistant' }, { ...copy, matches: [] }), true);
  assert.equal(copyInScope(project, { ...copy, agentsMayRead: false }), false);
  assert.equal(copyInScope({ kind: 'assistant' }, { ...copy, agentsMayRead: false }), false);
});

test("the sharer's flag: absent on the wire is on, anything but true otherwise is off", () => {
  assert.equal(catalogAllowsAgents({}), true);
  assert.equal(catalogAllowsAgents({ agentsMayRead: true }), true);
  assert.equal(catalogAllowsAgents({ agentsMayRead: false }), false);
  assert.equal(catalogAllowsAgents({ agentsMayRead: 'yes' as unknown as boolean }), false);
});

test("a project's sharing keeps both switches, and refuses one that is not a boolean", () => {
  const key = 'github.com/acme/shop';
  assert.deepEqual(parseSharing({ groups: [], shareKey: key }), { groups: [], shareKey: key });
  assert.deepEqual(parseSharing({ groups: [], shareKey: key, agentsMayRead: false, agentReads: true }), { groups: [], shareKey: key, agentsMayRead: false, agentReads: true });
  assert.throws(() => parseSharing({ groups: [], shareKey: key, agentReads: 'on' }), /agentReads/);
  assert.throws(() => parseSharing({ groups: [], shareKey: key, agentsMayRead: 1 }), /agentsMayRead/);
});

test('every agent read is a row: listed newest first, filtered by copy, chat and time, and pruned to the newest', () => {
  const db = new Db(tempConfig());
  try {
    const store = new CollabStore(db.connection);
    const owner = 'e'.repeat(64);
    const read = (at: string, chatId: string, shareId: string) =>
      store.appendAgentRead({ at, chatId, tool: 'collab_read_chats', owner, shareKey: `key/${shareId}`, shareId, kind: 'chats', recordIds: ['c1', 'c2'] });
    const first = read('2026-10-17T08:00:00.000Z', 'chat-a', 's1');
    read('2026-10-17T09:00:00.000Z', 'chat-b', 's1');
    read('2026-10-17T10:00:00.000Z', 'chat-a', 's2');
    assert.deepEqual(first, { id: first.id, at: '2026-10-17T08:00:00.000Z', chatId: 'chat-a', tool: 'collab_read_chats', owner, shareKey: 'key/s1', shareId: 's1', kind: 'chats', recordIds: ['c1', 'c2'] });
    assert.deepEqual(store.agentReads().map((r) => r.at.slice(11, 13)), ['10', '09', '08']);
    assert.deepEqual(store.agentReads({ owner, shareId: 's1' }).map((r) => r.chatId), ['chat-b', 'chat-a']);
    assert.deepEqual(store.agentReads({ chatId: 'chat-a' }).map((r) => r.shareId), ['s2', 's1']);
    assert.equal(store.agentReads({ since: '2026-10-17T09:00:00.000Z' }).length, 2);
    assert.equal(store.agentReads({ limit: 1 }).length, 1);
    assert.equal(KEEP_AGENT_READS > 0, true);
    assert.equal(pruneAgentReads(db.connection, 1), 2);
    assert.deepEqual(store.agentReads().map((r) => r.shareId), ['s2']);
  } finally {
    db.close();
  }
});
