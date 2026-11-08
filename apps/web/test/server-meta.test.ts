import assert from 'node:assert/strict';
import test from 'node:test';
import { compatibility } from '../src/lib/server-meta.ts';

const range = (min: number, current: number) => ({ apiVersion: { min, current } });

test('a server whose range holds this web is compatible, at either edge', () => {
  assert.equal(compatibility(range(1, 1), 1), 'ok');
  assert.equal(compatibility(range(1, 3), 1), 'ok');
  assert.equal(compatibility(range(1, 3), 3), 'ok');
  assert.equal(compatibility(range(2, 3), 2), 'ok');
});

test('a server older than this web must update', () => {
  assert.equal(compatibility(range(1, 1), 2), 'server-too-old');
});

test('a server that dropped what this web uses means this Claudio must update', () => {
  assert.equal(compatibility(range(3, 4), 2), 'web-too-old');
});

test('an answer that is not a sane range is never compatible', () => {
  assert.equal(compatibility(null), 'server-too-old');
  assert.equal(compatibility(undefined), 'server-too-old');
  assert.equal(compatibility({ apiVersion: { min: 1.5, current: 2 } }), 'server-too-old');
  assert.equal(compatibility({ apiVersion: { min: 3, current: 1 } }), 'server-too-old');
  assert.equal(compatibility({ apiVersion: { min: '1', current: '1' } as unknown as { min: number; current: number } }), 'server-too-old');
});
