import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FlowControl, HIGH_WATERMARK, LOW_WATERMARK, STALL_EVICT_MS } from '../src/terminals/flow.ts';

/*
 * Findings of the terminal's security audit that live in the core (docs/reports/terminal-security.md).
 * A `todo` test is a finding not fixed yet: it states what §2.7 promises, and passes once it holds.
 * (None is open now: T8-3 is fixed, T8-1 was accepted by the owner and is pinned in the API's tests.)
 */

/** Drives a stalled client and one that keeps up until the shell is paused, on a clock the test moves */
function pausedByStalled(clock: { at: number }) {
  const flow = new FlowControl({}, () => clock.at);
  flow.add('stalled');
  flow.add('desktop');
  // The PTY keeps producing until the pause: a little over the high watermark, to both
  const chunk = 64 * 1024;
  let paused = false;
  for (let sent = 0; sent <= HIGH_WATERMARK + chunk && !paused; sent += chunk) {
    flow.sent('stalled', chunk);
    paused = flow.sent('desktop', chunk).pause || flow.isPaused;
    flow.acked('desktop', chunk);
  }
  assert.equal(paused, true, 'the stalled client paused the shell');
  return flow;
}

test('a client that stops acknowledging does not freeze the shell for a client that keeps up', () => {
  const clock = { at: 1000 };
  const flow = pausedByStalled(clock);
  // Within the limit the shell stays paused, however often it is re-checked
  clock.at += STALL_EVICT_MS - 1;
  assert.deepEqual(flow.recheck().evict, []);
  assert.equal(flow.isPaused, true);
  // Past it the stalled client is let go, and the shell runs again for the one that kept up
  clock.at += 1;
  const decision = flow.recheck();
  assert.deepEqual(decision.evict, ['stalled']);
  assert.equal(decision.resume, true);
  assert.equal(flow.isPaused, false);
});

test('a lone client that stops acknowledging keeps the shell paused and is not let go', () => {
  const clock = { at: 0 };
  const flow = new FlowControl({}, () => clock.at);
  flow.add('only');
  flow.sent('only', HIGH_WATERMARK + 1);
  assert.equal(flow.isPaused, true);
  clock.at += STALL_EVICT_MS * 10;
  assert.deepEqual(flow.recheck().evict, []);
  assert.equal(flow.isPaused, true);
});

test('with two clients both behind, neither is let go for the stall alone', () => {
  const clock = { at: 0 };
  const flow = new FlowControl({}, () => clock.at);
  flow.add('a');
  flow.add('b');
  flow.sent('a', HIGH_WATERMARK + 1);
  flow.sent('b', LOW_WATERMARK + 1);
  clock.at += STALL_EVICT_MS * 2;
  assert.deepEqual(flow.recheck().evict, []);
});
