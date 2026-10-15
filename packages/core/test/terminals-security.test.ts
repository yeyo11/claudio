import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FlowControl, HIGH_WATERMARK } from '../src/terminals/flow.ts';

/*
 * Findings of the terminal's security audit that live in the core (docs/reports/terminal-security.md).
 * A `todo` test is a finding not fixed yet: it states what §2.7 promises, and passes once it holds.
 */

test(
  'a client that stops acknowledging does not freeze the shell for a client that keeps up',
  { todo: 'finding T8-3 in docs/reports/terminal-security.md: the shell pauses at 2 MiB, so the 8 MiB eviction never fires' },
  () => {
    const flow = new FlowControl();
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
    // The desktop is fully caught up; however long the re-check runs, the shell stays paused for it
    let evicted: string[] = [];
    for (let i = 0; i < 100; i += 1) evicted = evicted.concat(flow.recheck().evict);
    assert.ok(evicted.includes('stalled') || !flow.isPaused, 'the stalled client is let go, or the shell runs again for the others');
  },
);
