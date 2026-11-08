import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClaudioEvent } from '@claudio/shared';
import { keys } from '../src/api';
import { targetMatches, targetsFor } from '../src/lib/events';

// The Updates card reads the desktop unit once on mount and then only when this event says it moved
// (no polling), so the event must reach exactly the query the card holds.
test('desktop-update.changed refetches the desktop update status the card holds', () => {
  const event = {
    type: 'desktop-update.changed',
    status: { state: 'installed' },
  } as unknown as ClaudioEvent;
  const targets = targetsFor(event);
  assert.ok(targets.some((target) => targetMatches(target, keys.desktopUpdate)));
  assert.ok(!targets.some((target) => targetMatches(target, keys.release)), 'nothing else is read');
});
