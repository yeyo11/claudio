import assert from 'node:assert/strict';
import test from 'node:test';
import { API_VERSION, API_VERSION_MIN } from '@claudio/shared';
import { compatibility, isNewerVersion } from '../src/lib/server-meta.ts';

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

test('without a version given, this web is judged at the shared API version', () => {
  assert.ok(API_VERSION_MIN <= API_VERSION);
  assert.equal(compatibility(range(API_VERSION_MIN, API_VERSION)), 'ok');
  assert.equal(compatibility(range(API_VERSION + 1, API_VERSION + 1)), 'web-too-old');
  assert.equal(compatibility(range(API_VERSION - 1, API_VERSION - 1)), 'server-too-old');
});

test('a release is newer by its numbers, not by its text', () => {
  assert.equal(isNewerVersion('0.16.0', '0.15.0'), true);
  assert.equal(isNewerVersion('0.10.0', '0.9.9'), true, 'compared as numbers, not as strings');
  assert.equal(isNewerVersion('1.0.0', '0.99.0'), true);
  assert.equal(isNewerVersion('0.15.0', '0.16.0'), false);
  assert.equal(isNewerVersion('0.16.0', '0.16.0'), false);
  assert.equal(isNewerVersion('v0.16.1', '0.16.0'), true);
  assert.equal(isNewerVersion('0.16.0-rc.1', '0.15.9'), true);
});

test('a version that does not read as one is never newer', () => {
  assert.equal(isNewerVersion(null, '0.15.0'), false);
  assert.equal(isNewerVersion('0.16.0', ''), false);
  assert.equal(isNewerVersion('dev', '0.15.0'), false);
  assert.equal(isNewerVersion('0.16', '0.15.0'), false);
});
