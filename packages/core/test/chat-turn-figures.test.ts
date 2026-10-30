import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import test from 'node:test';
import { foldEvent } from '../src/chat-fold.ts';
import { LiveChat, type ChatHost } from '../src/live-chat.ts';
import { ClaudeCodeDriver } from '../src/providers/claude-code/driver.ts';
import type { DriverSession } from '../src/providers/driver.ts';

// A turn's own cost and tokens (`LiveChat.lastTurn`, what `x-claudio-cost-usd` and the OpenAI usage
// read) are the growth of the process's cumulative figures since its previous result. Both baselines
// must move on every result, an execution open or not, or the two figures disagree.

const spends: number[] = [];
const host = {
  db: {},
  environments: { observe: () => undefined },
  permissions: null,
  emit: () => {},
  persist: () => {},
  noteActivity: () => {},
  observeLimit: () => {},
  observeSignIn: () => {},
  learnModelCosts: () => {},
  learnWindows: () => {},
  maybeLimit: () => {},
  recordSpend: (_chat: LiveChat, _execution: unknown, usd: number | null) => {
    if (usd !== null) spends.push(usd);
  },
  failProtocol: () => {},
} as unknown as ChatHost;

function rig(): { chat: LiveChat; result(turn: number): void } {
  const driver = new ClaudeCodeDriver('claude');
  const chat = new LiveChat('sess-figures', { prompt: 'p', cwd: '/work' }, {}, 'claudio', null, { workspaceDir: '/work', defaultPermissionMode: 'manual' }, driver, true);
  chat.proc = { pid: 1, exitCode: null, signalCode: null } as unknown as ChildProcessWithoutNullStreams;
  const session: DriverSession = driver.attach({ write: () => true, end: () => {}, up: () => true }, (event) => foldEvent(host, chat, event), chat.branches);
  return {
    chat,
    // The process's totals after `turn` turns of 0.01 USD and 10 input / 5 output tokens each
    result: (turn) =>
      session.readLine(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          num_turns: 1,
          total_cost_usd: 0.01 * turn,
          modelUsage: { 'claude-sonnet-5-5': { inputTokens: 10 * turn, outputTokens: 5 * turn, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 * turn, contextWindow: 200000 } },
          result: 'ok',
        }),
      ),
  };
}

test('a result with no open execution still moves the cost baseline, so the next turn reports only its own cost', () => {
  const { chat, result } = rig();
  assert.equal(chat.execution, null, 'the rig has no execution open');
  result(1);
  assert.equal(chat.lastTurn.costUsd, 0.01);
  assert.equal(chat.lastTurn.tokens?.output, 5);
  result(2);
  // Before the fix the cost read 0.02 (the process's total) while the tokens read one turn's 5
  assert.ok(Math.abs((chat.lastTurn.costUsd ?? NaN) - 0.01) < 1e-9, String(chat.lastTurn.costUsd));
  assert.equal(chat.lastTurn.tokens?.output, 5);
  assert.equal(chat.lastReportedCostUsd, 0.02);
  assert.deepEqual(spends, [], 'with no execution nothing is written to the spend ledger');
});
