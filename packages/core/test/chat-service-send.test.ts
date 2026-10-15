import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatService, type ChatServiceDeps } from '../src/chat-service.ts';
import { tempConfig } from './helpers.ts';

// A send to a chat whose process is ours must not wait for the CLI's agent list (a `claude agents
// --json` spawn when the cached list is stale); a chat that is not ours still gets the full read.

type Pids = { pid: number | null };

function service(runtime: Pids | null) {
  let listed = 0;
  const sent: string[] = [];
  const record = runtime && {
    id: 'c1',
    name: 'chat',
    prompt: 'hi',
    executions: [],
    pid: runtime.pid,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const deps = {
    config: tempConfig(),
    runtime: {
      get: () => record,
      sendMessage: async (_id: string, text: string) => {
        sent.push(text);
        return { id: 'm1', status: 'sent' };
      },
      atLimit: () => false,
      list: () => [],
    },
    sessions: { summary: async () => null, listSessions: async () => [] },
    place: () => ({ project: null, worktree: null }),
    orchestrator: { list: () => [] },
  } as unknown as ChatServiceDeps;
  const chats = new ChatService(deps);
  (chats as unknown as { cliSessions: () => Promise<never[]> }).cliSessions = async () => {
    listed++;
    return [];
  };
  return { chats, listed: () => listed, sent };
}

test('a send to a chat with a process of ours does not read the CLI list', async () => {
  const { chats, listed, sent } = service({ pid: 4242 });
  await chats.send('c1', { text: 'again' });
  assert.deepEqual(sent, ['again']);
  assert.equal(listed(), 0);
});

test('a send to a chat without a process of ours reads the CLI list', async () => {
  const { chats, listed } = service({ pid: null });
  await chats.send('c1', { text: 'again' }).catch(() => undefined);
  assert.ok(listed() > 0);
});
