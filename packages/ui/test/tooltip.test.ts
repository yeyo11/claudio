import assert from 'node:assert/strict';
import { test } from 'node:test';
import { focusOpensTooltip, nextTooltipOpen } from '../src/components/controls/Tooltip.tsx';

test('a tooltip with nothing to show never takes an open request', () => {
  // The expanded sidebar's rail items have empty tooltips: hovering them must not leave them open
  assert.equal(nextTooltipOpen(true, true), false);
  assert.equal(nextTooltipOpen(false, true), false);
});

test('a tooltip with content opens and closes as Radix asks', () => {
  assert.equal(nextTooltipOpen(true, false), true);
  assert.equal(nextTooltipOpen(false, false), false);
});

test('a focus right after Tab or an arrow key opens the tooltip, as keyboard users expect', () => {
  assert.equal(focusOpensTooltip(3, true), true);
  assert.equal(focusOpensTooltip(900, true), true);
});

test('a focus the app placed never opens the tooltip: a dialog autofocusing or giving focus back', () => {
  // No navigation key since the last pointer press, Escape or Enter: the dialog moved focus itself
  assert.equal(focusOpensTooltip(Number.POSITIVE_INFINITY, true), false);
  // A navigation key long ago, then the app moved focus (a dialog opened after a timer)
  assert.equal(focusOpensTooltip(5000, true), false);
  // Focus after a click is not :focus-visible
  assert.equal(focusOpensTooltip(3, false), false);
});
