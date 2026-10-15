import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextTooltipOpen } from '../src/components/controls/Tooltip.tsx';

test('a tooltip with nothing to show never takes an open request', () => {
  // The expanded sidebar's rail items have empty tooltips: hovering them must not leave them open
  assert.equal(nextTooltipOpen(true, true), false);
  assert.equal(nextTooltipOpen(false, true), false);
});

test('a tooltip with content opens and closes as Radix asks', () => {
  assert.equal(nextTooltipOpen(true, false), true);
  assert.equal(nextTooltipOpen(false, false), false);
});
