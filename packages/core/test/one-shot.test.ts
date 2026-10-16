import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatRuntime, NewChat, RunResult } from '../src/chats.ts';
import { NO_TOOLS_POLICY, oneShotChat, runOneShot, type OneShotRuntime, type OneShotSpec } from '../src/one-shot.ts';

const ok: RunResult = { isError: false, result: '', structuredOutput: { lessons: [] }, costUsd: 0.002 };

function stub(wait: () => Promise<RunResult>, opts: { startThrows?: boolean } = {}) {
  const calls: string[] = [];
  const started: NewChat[] = [];
  const runtime: OneShotRuntime = {
    start: (o) => {
      if (opts.startThrows) throw new Error('no cli');
      started.push(o);
      return { id: 'chat-1' } as unknown as ChatRuntime;
    },
    waitForResult: () => wait(),
    stop: () => calls.push('stop'),
    exited: () => Promise.resolve(),
    remove: () => {
      calls.push('remove');
      return true;
    },
  };
  return { runtime, calls, started };
}

const spec = (over: Partial<OneShotSpec> = {}): OneShotSpec => ({
  prompt: 'p',
  name: 'n',
  purpose: 'other',
  model: 'haiku',
  effort: null,
  maxBudgetUsd: 0.05,
  jsonSchema: { type: 'object' },
  deadlineMs: 1000,
  signal: new AbortController().signal,
  ...over,
});

test('a result comes back and the chat is stopped and removed', async () => {
  const s = stub(() => Promise.resolve(ok));
  const out = await runOneShot(s.runtime, spec());
  assert.deepEqual(out, { kind: 'result', result: ok });
  assert.deepEqual(s.calls, ['stop', 'remove']);
});

test('a deadline cuts the wait, and the chat is still disposed of', async () => {
  const s = stub(() => new Promise(() => undefined));
  const out = await runOneShot(s.runtime, spec({ deadlineMs: 20 }));
  assert.equal(out.kind, 'timeout');
  assert.deepEqual(s.calls, ['stop', 'remove']);
});

test('an abort during the wait is a timeout; one before the start never starts a chat', async () => {
  const during = new AbortController();
  const s = stub(() => new Promise(() => undefined));
  const pending = runOneShot(s.runtime, spec({ deadlineMs: 60_000, signal: during.signal }));
  during.abort();
  assert.equal((await pending).kind, 'timeout');
  assert.deepEqual(s.calls, ['stop', 'remove']);

  const before = new AbortController();
  before.abort();
  const none = stub(() => Promise.resolve(ok));
  assert.equal((await runOneShot(none.runtime, spec({ signal: before.signal }))).kind, 'timeout');
  assert.equal(none.started.length, 0);
});

test('a start that throws and a wait that throws are failures', async () => {
  const noStart = stub(() => Promise.resolve(ok), { startThrows: true });
  assert.equal((await runOneShot(noStart.runtime, spec())).kind, 'failed');
  assert.deepEqual(noStart.calls, [], 'nothing was started, so nothing is disposed of');
  const noWait = stub(() => Promise.reject(new Error('boom')));
  assert.equal((await runOneShot(noWait.runtime, spec())).kind, 'failed');
  assert.deepEqual(noWait.calls, ['stop', 'remove']);
});

test('the chat is started confined, with no tool, no API and no kept session', () => {
  const chat = oneShotChat(spec({ model: 'haiku', effort: 'low', provider: 'claude-code' }));
  assert.equal(chat.internal, true);
  assert.equal(chat.api, false);
  assert.equal(chat.uploads, false);
  assert.equal(chat.keepAlive, false);
  assert.deepEqual(chat.confine, { tools: [], settingSources: [] });
  assert.equal(chat.permissionMode, 'dontAsk');
  assert.equal(chat.permissionPrompts, 'none');
  assert.deepEqual(chat.toolConfig?.policy, NO_TOOLS_POLICY);
  assert.deepEqual(chat.toolConfig?.allowedTools, []);
  assert.equal(chat.effort, 'low');
  assert.equal(oneShotChat(spec()).effort, undefined, 'no effort when the settings name none');
});
