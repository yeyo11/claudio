import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOP_GAP, turnSpacerHeight } from '../src/composer/turn-spacer';

const base = { clientHeight: 800, rowTop: 5000, paddingBottom: 12 };

test('the spacer fills what the question and its answer leave of the viewport', () => {
  assert.equal(turnSpacerHeight({ ...base, contentEnd: 5100 }), 800 - TOP_GAP - 100 - 12);
});

test('the spacer is zero once the answer is taller than the viewport', () => {
  assert.equal(turnSpacerHeight({ ...base, contentEnd: 6000 }), 0);
});

test('with the spacer, the end of the scroller puts the question at the top', () => {
  const contentEnd = 5200;
  const spacer = turnSpacerHeight({ ...base, contentEnd });
  const maxScroll = contentEnd + spacer + base.paddingBottom - base.clientHeight;
  assert.equal(base.rowTop - maxScroll, TOP_GAP);
});
