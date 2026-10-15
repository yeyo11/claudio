import assert from 'node:assert/strict';
import test from 'node:test';
import { COALESCE_BYTES, Coalescer, EVICT_BYTES, FlowControl, HIGH_WATERMARK, LOW_WATERMARK, type CoalescerClock } from '../src/terminals/flow.ts';

const KIB = 1024;
const MIB = 1024 * KIB;

test('the PTY pauses above the high watermark and resumes below the low one for every client', () => {
  const flow = new FlowControl();
  flow.add('phone');
  flow.add('desk');
  assert.equal(flow.sent('phone', HIGH_WATERMARK).pause, false, 'at the mark, not above it');
  flow.sent('desk', 100);
  assert.equal(flow.sent('phone', 1).pause, true);
  assert.equal(flow.isPaused, true);
  // One client catching up is not enough while another is still behind
  flow.sent('desk', 3 * MIB);
  assert.equal(flow.acked('phone', HIGH_WATERMARK + 1).resume, false);
  assert.equal(flow.acked('desk', 3 * MIB + 100 - LOW_WATERMARK + 1).resume, true);
  assert.equal(flow.isPaused, false);
});

test('only what the client acknowledges counts, never more than was sent', () => {
  const flow = new FlowControl();
  flow.add('a');
  flow.sent('a', 3 * MIB);
  assert.equal(flow.unacked('a'), 3 * MIB);
  flow.acked('a', 100 * MIB);
  assert.equal(flow.unacked('a'), 0);
  flow.acked('a', -5);
  flow.acked('a', Number.NaN);
  assert.equal(flow.unacked('a'), 0);
});

test('a client more than 8 MiB behind is evicted, and the others are not held hostage by it', () => {
  const flow = new FlowControl();
  flow.add('slow');
  flow.add('fast');
  flow.sent('fast', 1000);
  flow.acked('fast', 1000);
  const decision = flow.sent('slow', EVICT_BYTES + 1);
  assert.deepEqual(decision.evict, ['slow']);
  // It is out of the count, so the shell does not stay paused for it
  assert.equal(flow.unacked('slow'), 0);
  assert.equal(flow.isPaused, decision.pause);
  assert.equal(flow.recheck().resume, decision.pause);
});

test("a socket's own send buffer past 8 MiB evicts too", () => {
  const flow = new FlowControl();
  flow.add('a');
  assert.deepEqual(flow.buffered('a', EVICT_BYTES).evict, []);
  assert.deepEqual(flow.buffered('a', EVICT_BYTES + 1).evict, ['a']);
});

test("a client that leaves takes its unacknowledged bytes with it, and a stale pause is lifted by the re-check", () => {
  const flow = new FlowControl();
  flow.add('gone');
  flow.add('stays');
  flow.sent('gone', 3 * MIB);
  assert.equal(flow.isPaused, true);
  assert.equal(flow.remove('gone').resume, true);
  assert.equal(flow.isPaused, false);
  flow.add('also');
  flow.sent('also', 3 * MIB);
  assert.equal(flow.isPaused, true);
  // No client behind: the periodic re-check resumes what nothing else would
  flow.acked('also', 3 * MIB);
  assert.equal(flow.isPaused, false);
});

test('with no client attached nothing ever pauses', () => {
  const flow = new FlowControl();
  assert.deepEqual(flow.recheck(), { pause: false, resume: false, evict: [] });
  assert.equal(flow.isPaused, false);
});

function fakeClock() {
  let now = 0;
  const timers: Array<{ at: number; run: () => void; live: boolean }> = [];
  const clock: CoalescerClock = {
    now: () => now,
    after: (ms, run) => {
      const timer = { at: now + ms, run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const timer of timers) {
      if (timer.live && timer.at <= now) {
        timer.live = false;
        timer.run();
      }
    }
  };
  return { clock, advance };
}

test('output is coalesced for 4 ms, and a keystroke echo after a quiet spell goes at once', () => {
  const { clock, advance } = fakeClock();
  const frames: string[] = [];
  const coalescer = new Coalescer(clock, (frame) => frames.push(frame.toString()));
  advance(100);
  coalescer.push(Buffer.from('a'));
  assert.deepEqual(frames, ['a'], 'an echo after quiet is not held');
  advance(1);
  coalescer.push(Buffer.from('b'));
  coalescer.push(Buffer.from('c'));
  assert.deepEqual(frames, ['a'], 'a burst is gathered');
  advance(4);
  assert.deepEqual(frames, ['a', 'bc']);
});

test('64 KiB sends the frame without waiting, and a flush sends what is held', () => {
  const { clock, advance } = fakeClock();
  const frames: number[] = [];
  const coalescer = new Coalescer(clock, (frame) => frames.push(frame.length));
  advance(100);
  coalescer.push(Buffer.alloc(2 * KIB));
  assert.deepEqual(frames, [], 'over 1 KiB is not an echo');
  coalescer.push(Buffer.alloc(COALESCE_BYTES));
  assert.deepEqual(frames, [2 * KIB + COALESCE_BYTES]);
  coalescer.push(Buffer.alloc(3 * KIB));
  coalescer.flush();
  assert.deepEqual(frames, [2 * KIB + COALESCE_BYTES, 3 * KIB]);
  advance(10);
  assert.equal(frames.length, 2, 'the timer was cancelled by the flush');
  coalescer.push(Buffer.alloc(3 * KIB));
  coalescer.discard();
  advance(10);
  assert.equal(frames.length, 2, 'a discarded frame is never sent');
});
