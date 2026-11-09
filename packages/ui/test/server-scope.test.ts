import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { activeBase, activeServerId, apiBase, isRemoteServerId, parseScopedPath, routerBasename, scopedHref, scopedKey, setActiveServer } from '../src/lib/server-scope';

afterEach(() => setActiveServer(null));

test('the local scope keeps /api, unprefixed routes and unsuffixed keys', () => {
  assert.equal(apiBase('local'), '/api');
  assert.equal(routerBasename('local'), undefined);
  assert.equal(scopedHref('local', '/chats/c1'), '/chats/c1');
  assert.equal(scopedKey('claudio:project', 'local'), 'claudio:project');
});

test('a remote reaches its API through the hub gateway, with its own prefix and key suffix', () => {
  assert.equal(apiBase('srv_1'), '/api/servers/srv_1/api');
  assert.equal(routerBasename('srv_1'), '/s/srv_1');
  assert.equal(scopedHref('srv_1', '/chats'), '/s/srv_1/chats');
  assert.equal(scopedHref('srv_1', '/'), '/s/srv_1');
  assert.equal(scopedKey('claudio:project', 'srv_1'), 'claudio:project:srv_1');
});

test('the address names the scope; anything that is not a well formed remote id is the local one', () => {
  assert.deepEqual(parseScopedPath('/s/srv_1/chats/c1'), { serverId: 'srv_1', path: '/chats/c1' });
  assert.deepEqual(parseScopedPath('/s/srv_1'), { serverId: 'srv_1', path: '/' });
  assert.equal(parseScopedPath('/chats/c1'), null);
  assert.equal(parseScopedPath('/s'), null);
  // `local` is the hub's own id: `/s/local/…` must not become a second spelling of the hub
  assert.equal(parseScopedPath('/s/local/chats'), null);
  // An id goes into a path and a storage key: nothing that could climb out of its base
  for (const bad of ['..', '.', 'a b', 'a%2fb', 'a/b', '', 'x'.repeat(65), 'é']) assert.equal(isRemoteServerId(bad), false, bad);
  assert.equal(parseScopedPath('/s/../api/chats'), null);
});

test('the page scope is read from the address once and stays', () => {
  setActiveServer('srv_2');
  assert.equal(activeServerId(), 'srv_2');
  assert.equal(activeBase(), '/api/servers/srv_2/api');
  setActiveServer(null);
  // No window in this runtime: the local one
  assert.equal(activeServerId(), 'local');
  assert.equal(scopedKey('k'), 'k');
});
