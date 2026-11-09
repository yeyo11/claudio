import assert from 'node:assert/strict';
import test from 'node:test';
import { addressOnServer, isHubOnly, isHubOnlySection, mapRoute, recordOf, routeOnServer, type RecordExists } from '../src/lib/server-routes.ts';

test('the Servers page, the LAN and tunnel card and the sign-in cards are hub-only', () => {
  assert.equal(isHubOnly('/servers'), true);
  assert.equal(isHubOnly('/servers/'), true);
  assert.equal(isHubOnly('/servers/abc'), true);
  assert.equal(isHubOnly('/settings/access#remote'), true);
  assert.equal(isHubOnly('/settings/access#access'), true);
  assert.equal(isHubOnlySection('remote'), true);
  assert.equal(isHubOnlySection('access'), true);
  assert.equal(isHubOnlySection('servers'), true, 'the switch of Servers is the hub’s, one hop only');
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

test('without asking the other server, a page that names a record goes to its list, and an unknown page to Home', () => {
  const lists: Array<[string, string]> = [
    ['/chats/c1', '/chats'],
    ['/chats/c1/changes', '/chats'],
    ['/tasks/ABC-1', '/tasks'],
    ['/orchestration/o1/changes', '/orchestration'],
    ['/orchestration/o1/tasks/t1/changes', '/orchestration'],
    ['/projects/p1/assistant', '/projects'],
    ['/schedules/s1/edit', '/schedules'],
    ['/terminals/7', '/terminals'],
    ['/collaborators/shared/peer/share', '/collaborators'],
  ];
  for (const [path, list] of lists) assert.equal(mapRoute(path, 'srv_1'), list, path);
  for (const path of ['/nowhere', '/chats/c1/elsewhere', '/projects/p1']) assert.equal(mapRoute(path, 'srv_1'), '/', path);
});

test('each record page names the read that says whether a server has it', () => {
  assert.deepEqual(recordOf('/chats/c1?x=1'), { page: '/chats/c1', list: '/chats', read: '/chats/c1?limit=1' });
  assert.equal(recordOf('/tasks/AGN-12/changes')?.read, '/work-items/by-key/AGN-12');
  assert.equal(recordOf('/orchestration/o1/tasks/t1/changes')?.read, '/orchestrations/o1');
  assert.equal(recordOf('/projects/p1/assistant')?.read, '/projects/p1/docs');
  assert.equal(recordOf('/schedules/s1/edit')?.read, '/schedules/s1');
  assert.equal(recordOf('/terminals/7')?.read, '/terminals/7');
  assert.equal(recordOf('/collaborators/shared/peer/share')?.read, null);
  // An id goes back as one encoded segment, never as a way out of the record's route
  assert.equal(recordOf('/chats/a%20b')?.read, '/chats/a%20b?limit=1');
  assert.equal(recordOf('/chats/%2E%2E')?.read, null);
  assert.equal(recordOf('/chats/%E0%A4%A')?.read, null);
  for (const path of ['/chats', '/chats/new', '/tasks/milestones', '/schedules/new', '/projects/new', '/']) assert.equal(recordOf(path), null, path);
});

/** A server that has the records `have` (API paths) and is asked once per switch */
function serverWith(have: string[]): { exists: RecordExists; asked: Array<{ base: string; path: string }> } {
  const asked: Array<{ base: string; path: string }> = [];
  return {
    asked,
    exists: (base, path) => {
      asked.push({ base, path });
      return have.includes(path) ? Promise.resolve(true) : Promise.reject(new Error('404'));
    },
  };
}

test('a record page stays on the other server when that server has the record, read once through its own base (E1)', async () => {
  const remote = serverWith(['/chats/c1?limit=1']);
  assert.equal(await routeOnServer('/chats/c1', 'srv_1', remote.exists), '/chats/c1');
  assert.deepEqual(remote.asked, [{ base: '/api/servers/srv_1/api', path: '/chats/c1?limit=1' }]);
  const hub = serverWith(['/orchestrations/o1']);
  assert.equal(await routeOnServer('/orchestration/o1/changes?tab=x', 'local', hub.exists), '/orchestration/o1/changes');
  assert.deepEqual(hub.asked, [{ base: '/api', path: '/orchestrations/o1' }]);
});

test('a record the other server lacks sends the switch to its list; a page with no record is not read at all', async () => {
  const remote = serverWith([]);
  assert.equal(await routeOnServer('/tasks/AGN-1', 'srv_1', remote.exists), '/tasks');
  assert.equal(await routeOnServer('/collaborators/shared/peer/share', 'srv_1', remote.exists), '/collaborators');
  assert.equal(await routeOnServer('/chats', 'srv_1', remote.exists), '/chats');
  assert.equal(await routeOnServer('/servers', 'srv_1', remote.exists), '/');
  assert.equal(await routeOnServer('/nowhere', 'srv_1', remote.exists), '/');
  assert.deepEqual(
    remote.asked.map((each) => each.path),
    ['/work-items/by-key/AGN-1'],
  );
});

test('a server that does not say within the budget gets the list, and the read is told to stop', async () => {
  let signal: AbortSignal | null = null;
  const silent: RecordExists = (_base, _path, given) => {
    signal = given;
    return new Promise<boolean>(() => undefined);
  };
  const started = Date.now();
  assert.equal(await routeOnServer('/chats/c1', 'srv_1', silent, 50), '/chats');
  assert.ok(Date.now() - started < 1_000);
  assert.equal((signal as AbortSignal | null)?.aborted, true);
});

test('a hub-only page goes to the remote’s Home; query and hash do not travel', () => {
  assert.equal(mapRoute('/servers', 'srv_1'), '/');
  assert.equal(mapRoute('/settings/access#remote', 'srv_1'), '/settings/access');
  assert.equal(mapRoute('/chats?project=p1', 'srv_1'), '/chats');
});

test('the browser address carries the scope prefix of the target, and none for the hub', () => {
  assert.equal(addressOnServer('/chats', 'srv_1'), '/s/srv_1/chats');
  assert.equal(addressOnServer('/chats/c1', 'srv_1'), '/s/srv_1/chats');
  assert.equal(addressOnServer('/nowhere', 'srv_1'), '/s/srv_1');
  assert.equal(addressOnServer('/chats', 'local'), '/chats');
});
