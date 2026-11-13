import assert from 'node:assert/strict';
import test from 'node:test';
import type { DriverEvent } from '../src/providers/driver.ts';
import { foldEvent } from '../src/chat-fold.ts';
import type { ChatHost, LiveChat } from '../src/live-chat.ts';

// A command's recorded duration is what "usual" is measured on. Every call of one message carries
// the message's time, and a call that waited for a sibling of its batch used to be timed from there.

const SECOND = 1000;
const at = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

type Block = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } | { type: 'tool_result'; toolUseId: string; isError: boolean; content: string };
const message = (ts: string, blocks: Block[]) => ({ ts, kind: 'message', entry: { role: 'assistant', parentToolUseId: null, blocks } });
const use = (id: string, command: string): Block => ({ type: 'tool_use', id, name: 'Bash', input: { command } });

/** What the fold reads of a chat to note one command ending; the rest of a `LiveChat` is not touched by it */
function rig(events: unknown[], open: Array<[string, string]>) {
  const recorded: Array<{ toolUseId: string; durationMs: number }> = [];
  const chat = {
    id: 'chat-1',
    events,
    execution: { startedAt: at(60 * SECOND) },
    heartbeats: new Map(),
    cancelled: new Set<string>(),
    openCommands: new Map(open.map(([id, startedAt]) => [id, { command: 'npm test', kind: 'npm', startedAt }])),
  } as unknown as LiveChat;
  const host = { db: { recordCommand: (run: { toolUseId: string; durationMs: number }) => recorded.push(run) } } as unknown as ChatHost;
  const end = (toolUseId: string): number | undefined => {
    foldEvent(host, chat, { kind: 'command-ended', toolUseId, isError: false } satisfies DriverEvent);
    return recorded.find((r) => r.toolUseId === toolUseId)?.durationMs;
  };
  return { end };
}

test("a late sibling of a parallel batch is timed from its own clock, not from its message's time", () => {
  // Two commands in one message ten seconds ago; the first ended four seconds ago, so the second only ran for those four
  const sent = at(10 * SECOND);
  const { end } = rig([message(sent, [use('a', 'npm test'), use('b', 'npm test')]), message(at(4 * SECOND), [{ type: 'tool_result', toolUseId: 'a', isError: false, content: 'ok' }])], [
    ['a', sent],
    ['b', sent],
  ]);
  const second = end('b');
  assert.ok(second !== undefined && second >= 3_500 && second < 6_000, `took ${String(second)} ms`);
});

test('a command with no sibling in front of it keeps the time of its message', () => {
  const sent = at(10 * SECOND);
  const { end } = rig([message(sent, [use('a', 'npm test')])], [['a', sent]]);
  const only = end('a');
  assert.ok(only !== undefined && only >= 9_500 && only < 12_000, `took ${String(only)} ms`);
});
