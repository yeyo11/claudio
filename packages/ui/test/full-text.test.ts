import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCut } from '../src/lib/full-text.ts';

test('a label whose text fits its box carries no title', () => {
  assert.equal(isCut({ scrollWidth: 120, clientWidth: 120, scrollHeight: 18, clientHeight: 18 }), false);
});

test('a label cut by an ellipsis is told apart by its overflowing width', () => {
  assert.equal(isCut({ scrollWidth: 121, clientWidth: 120, scrollHeight: 18, clientHeight: 18 }), true);
});

test('a label cut by a line clamp is told apart by its overflowing height', () => {
  assert.equal(isCut({ scrollWidth: 120, clientWidth: 120, scrollHeight: 54, clientHeight: 36 }), true);
});

test('a label a fraction of a pixel short of its text is cut, though its whole-pixel sizes match', () => {
  assert.equal(isCut({ scrollWidth: 117, clientWidth: 117, scrollHeight: 18, clientHeight: 18, contentWidth: 117.02, innerWidth: 116.81 }), true);
});

test('a label whose unrounded text fits its box carries no title', () => {
  assert.equal(isCut({ scrollWidth: 117, clientWidth: 117, scrollHeight: 18, clientHeight: 18, contentWidth: 116.8, innerWidth: 116.81 }), false);
});
