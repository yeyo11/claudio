import assert from 'node:assert/strict';
import test from 'node:test';
import { addressOnServer, isHubOnly, isHubOnlySection, mapRoute } from '../src/lib/server-routes.ts';

test('the Servers page, the LAN and tunnel card and the sign-in cards are hub-only', () => {
  assert.equal(isHubOnly('/servers'), true);
  assert.equal(isHubOnly('/servers/'), true);
  assert.equal(isHubOnly('/servers/abc'), true);
  assert.equal(isHubOnly('/settings/access#remote'), true);
  assert.equal(isHubOnly('/settings/access#access'), true);
  assert.equal(isHubOnlySection('remote'), true);
  assert.equal(isHubOnlySection('access'), true);
});

test('what describes the selected server itself is not hub-only', () => {
  for (const path of ['/', '/chats', '/chats/c1', '/settings', '/settings/access', '/settings/access#hosts', '/settings/general#updates', '/serversfoo']) {
    assert.equal(isHubOnly(path), false, path);
  }
  assert.equal(isHubOnlySection('guards'), false);
  // A page that is not Settings has no such sections
  assert.equal(isHubOnly('/chats#remote'), false);
});

test('a page that names no record keeps its address on the other server', () => {
  assert.equal(mapRoute('/chats', 'srv_1'), '/chats');
  assert.equal(mapRoute('/tasks/', 'srv_1'), '/tasks');
  assert.equal(mapRoute('/settings/access', 'srv_1'), '/settings/access');
  assert.equal(mapRoute('/settings/runs/machine?x=1#a', 'local'), '/settings/runs/machine');
});

test('a page that names a record goes to Home: ids belong to one server', () => {
  for (const path of ['/chats/c1', '/tasks/ABC-1', '/orchestration/o1/changes', '/projects/p1/assistant', '/nowhere']) {
    assert.equal(mapRoute(path, 'srv_1'), '/', path);
  }
});

test('a hub-only page goes to the remote’s Home; query and hash do not travel', () => {
  assert.equal(mapRoute('/servers', 'srv_1'), '/');
  assert.equal(mapRoute('/settings/access#remote', 'srv_1'), '/settings/access');
  assert.equal(mapRoute('/chats?project=p1', 'srv_1'), '/chats');
});

test('the browser address carries the scope prefix of the target, and none for the hub', () => {
  assert.equal(addressOnServer('/chats', 'srv_1'), '/s/srv_1/chats');
  assert.equal(addressOnServer('/chats/c1', 'srv_1'), '/s/srv_1');
  assert.equal(addressOnServer('/chats', 'local'), '/chats');
});
