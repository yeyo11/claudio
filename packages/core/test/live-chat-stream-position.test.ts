import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatManager } from '../src/chats.ts';
import { LiveChat } from '../src/live-chat.ts';

// A page that reads the transcript and then opens the stream needs to know where the event buffer
// stands and where the current execution began.

test('an execution starts where the buffer stood, and the position follows it', () => {
  const chat = { seq: 0, executionSeq: 0, executions: [], opts: {}, permissionMode: 'default', model: null, account: null, effort: null };
  const begin = () => LiveChat.prototype.beginExecution.call(chat as unknown as LiveChat);
  const manager = { chats: new Map([['c1', chat]]) };
  const position = (id: string) => ChatManager.prototype.streamPosition.call(manager, id);

  begin();
  assert.deepEqual(position('c1'), { seq: 0, executionSeq: 0 });
  chat.seq = 12;
  assert.deepEqual(position('c1'), { seq: 12, executionSeq: 0 });
  begin();
  chat.seq = 15;
  assert.deepEqual(position('c1'), { seq: 15, executionSeq: 12 });
  assert.equal(position('nope'), null);
});
