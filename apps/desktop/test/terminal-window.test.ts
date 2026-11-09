import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isTerminalWindowUrl, navigationFor, scopeOf } from '../src/terminal-window.ts';

const ORIGIN = 'http://127.0.0.1:8787';

describe('isTerminalWindowUrl', () => {
  it('allows the detached terminal route on the local server', () => {
    assert.equal(isTerminalWindowUrl(`${ORIGIN}/terminal-window/abc-123`, ORIGIN), true);
    assert.equal(isTerminalWindowUrl(`${ORIGIN}/terminal-window/abc%20d/?x=1`, ORIGIN), true);
  });

  it('allows it under a remote server’s scope, on the same origin (E2)', () => {
    assert.equal(isTerminalWindowUrl(`${ORIGIN}/s/0123456789ab/terminal-window/7`, ORIGIN), true);
    assert.equal(isTerminalWindowUrl(`${ORIGIN}/s/srv_1-x/terminal-window/7/`, ORIGIN), true);
    assert.equal(isTerminalWindowUrl(`https://example.com/s/0123456789ab/terminal-window/7`, ORIGIN), false);
  });

  it('refuses a scope that is not one: the reserved local, a malformed id, a second prefix', () => {
    assert.equal(isTerminalWindowUrl(`${ORIGIN}/s/local/terminal-window/7`, ORIGIN), false);
    assert.equal(isTerminalWindowUrl(`${ORIGIN}/s/a.b/terminal-window/7`, ORIGIN), false);
    assert.equal(isTerminalWindowUrl(`${ORIGIN}/s/${'x'.repeat(65)}/terminal-window/7`, ORIGIN), false);
    assert.equal(isTerminalWindowUrl(`${ORIGIN}/s/a/s/b/terminal-window/7`, ORIGIN), false);
    assert.equal(isTerminalWindowUrl(`${ORIGIN}/s/terminal-window/7`, ORIGIN), false);
    assert.equal(isTerminalWindowUrl(`${ORIGIN}/s/a/terminals/7`, ORIGIN), false);
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

describe('scopeOf', () => {
  it('reads a remote’s prefix and nothing else', () => {
    assert.equal(scopeOf('/s/srv_1/chats'), '/s/srv_1');
    assert.equal(scopeOf('/s/srv_1'), '/s/srv_1');
    assert.equal(scopeOf('/chats/c1'), '');
    assert.equal(scopeOf('/s/local/chats'), '');
    assert.equal(scopeOf('/sx/srv_1/chats'), '');
  });
});

describe('navigationFor', () => {
  it('drives the page’s own router when the path is of the scope the page is in', () => {
    assert.deepEqual(navigationFor(`${ORIGIN}/chats`, '/chats/c1', ORIGIN), { kind: 'ipc', path: '/chats/c1' });
    // The router of a remote scope has `/s/<id>` as its basename: it is given the path inside it
    assert.deepEqual(navigationFor(`${ORIGIN}/s/srv_1/chats`, '/s/srv_1/chats/c1?x=1', ORIGIN), { kind: 'ipc', path: '/chats/c1?x=1' });
    assert.deepEqual(navigationFor(`${ORIGIN}/s/srv_1/chats`, '/s/srv_1', ORIGIN), { kind: 'ipc', path: '/' });
  });

  it('loads the address afresh when the path is of another scope, so a hub path never lands in a remote (E2)', () => {
    assert.deepEqual(navigationFor(`${ORIGIN}/s/srv_1/chats`, '/settings/general#updates', ORIGIN), { kind: 'load', url: `${ORIGIN}/settings/general#updates` });
    assert.deepEqual(navigationFor(`${ORIGIN}/chats`, '/s/srv_1/chats/c1', ORIGIN), { kind: 'load', url: `${ORIGIN}/s/srv_1/chats/c1` });
    assert.deepEqual(navigationFor(`${ORIGIN}/s/srv_1/chats`, '/s/srv_2/chats', ORIGIN), { kind: 'load', url: `${ORIGIN}/s/srv_2/chats` });
  });

  it('never drives a page that is not the local server’s', () => {
    assert.deepEqual(navigationFor('https://example.com/chats', '/chats/c1', ORIGIN), { kind: 'load', url: `${ORIGIN}/chats/c1` });
    assert.deepEqual(navigationFor('file:///splash.html', '/chats/c1', ORIGIN), { kind: 'load', url: `${ORIGIN}/chats/c1` });
    assert.deepEqual(navigationFor('', '/chats/c1', ORIGIN), { kind: 'load', url: `${ORIGIN}/chats/c1` });
  });
});
