import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isTerminalWindowUrl } from '../src/terminal-window.ts';

const ORIGIN = 'http://127.0.0.1:8787';

describe('isTerminalWindowUrl', () => {
  it('allows the detached terminal route on the local server', () => {
    assert.equal(isTerminalWindowUrl(`${ORIGIN}/terminal-window/abc-123`, ORIGIN), true);
    assert.equal(isTerminalWindowUrl(`${ORIGIN}/terminal-window/abc%20d/?x=1`, ORIGIN), true);
  });

  it('refuses another origin, even with the same path', () => {
    assert.equal(isTerminalWindowUrl('https://example.com/terminal-window/abc', ORIGIN), false);
    assert.equal(isTerminalWindowUrl('http://127.0.0.1:9999/terminal-window/abc', ORIGIN), false);
  });

  it('refuses every other path of the local server', () => {
    assert.equal(isTerminalWindowUrl(`${ORIGIN}/`, ORIGIN), false);
    assert.equal(isTerminalWindowUrl(`${ORIGIN}/terminals/abc`, ORIGIN), false);
    assert.equal(isTerminalWindowUrl(`${ORIGIN}/terminal-window/`, ORIGIN), false);
    assert.equal(isTerminalWindowUrl(`${ORIGIN}/terminal-window/a/b`, ORIGIN), false);
  });

  it('refuses anything while the server is not up, and a malformed address', () => {
    assert.equal(isTerminalWindowUrl(`${ORIGIN}/terminal-window/abc`, undefined), false);
    assert.equal(isTerminalWindowUrl('not a url', ORIGIN), false);
  });
});
