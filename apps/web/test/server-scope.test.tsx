// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { setActiveServer } from '@claudio/ui/lib/server-scope';
import { api, createApi } from '../src/api';
import { setChallenge, setToken, useAuthChallenge, confirmHubSession, probeAuth } from '../src/lib/auth';
import { storageKey } from '../src/lib/list-params';
import { readSeen, writeSeen, type KeyValueStore } from '../src/lib/review-state';
import { serverKeyHash } from '../src/lib/server-keys';
import { terminalWindowName } from '../src/components/terminal/terminal-window';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  setActiveServer(null);
  setToken(null);
  setChallenge(null);
});

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** Records what the app asks for, and answers each request with `answer(url)` */
function record(answer: (url: string) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return answer(url);
  }) as typeof fetch;
  return calls;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function Challenge() {
  return <i>{useAuthChallenge() ?? 'open'}</i>;
}
const challenge = () => renderToStaticMarkup(<Challenge />).replace(/<\/?i>/g, '');

test('the hub client reads /api, and a remote client reads through the gateway of the hub', async () => {
  const calls = record(() => json({}));
  await createApi('/api').overview();
  await createApi('/api/servers/srv_1/api').overview();
  assert.deepEqual(
    calls.map((call) => call.url),
    ['/api/overview', '/api/servers/srv_1/api/overview'],
  );
});

test('the page-wide client follows the scope of the page, read at each call', async () => {
  const calls = record(() => json({}));
  await api.overview();
  setActiveServer('srv_1');
  await api.overview();
  assert.deepEqual(
    calls.map((call) => call.url),
    ['/api/overview', '/api/servers/srv_1/api/overview'],
  );
});

test('a remote call only ever goes to the hub, which holds the remote credential: the browser sends the hub token to the hub gateway and to no other address', async () => {
  setToken('hub-token');
  const calls = record(() => json({}));
  const remote = createApi('/api/servers/srv_1/api');
  await remote.overview();
  await remote.auth();
  assert.ok(calls.length >= 2);
  for (const call of calls) {
    assert.match(call.url, /^\/api\/servers\/srv_1\/api\//, 'a relative address on the hub origin, under the gateway');
    assert.equal(call.headers['authorization'], 'Bearer hub-token');
  }
});

test('export and upload links are built on the scope’s base', () => {
  setToken(null);
  assert.equal(createApi('/api').chatExportUrl('c 1', 'markdown'), '/api/chats/c%201/export?format=markdown');
  assert.equal(createApi('/api/servers/srv_1/api').chatExportUrl('c1', 'markdown'), '/api/servers/srv_1/api/chats/c1/export?format=markdown');
  assert.equal(createApi('/api/servers/srv_1/api').projectExportUrl('p1', 'json'), '/api/servers/srv_1/api/projects/p1/export?format=json');
  assert.equal(createApi('/api/servers/srv_1/api').lessonsExportUrl('p1'), '/api/servers/srv_1/api/projects/p1/lessons/export');
});

test('a 401 from the hub brings its sign-in screen', async () => {
  record(() => json({ error: 'authentication required', mode: 'token' }, 401));
  await assert.rejects(createApi('/api').overview());
  assert.equal(challenge(), 'token');
});

test('a 401 that came through the gateway is the remote’s: the hub is asked, and its sign-in appears only if the hub itself refuses', async () => {
  // The remote revoked this hub's token; the hub's own session is fine
  const calls = record((url) => (url === '/api/security/auth' ? json({ mode: 'token' }) : json({ error: 'token revoked', mode: 'token' }, 401)));
  await assert.rejects(createApi('/api/servers/srv_1/api').overview());
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(challenge(), 'open');
  assert.ok(calls.some((call) => call.url === '/api/security/auth'), 'the hub was asked about its own session');

  // The hub's session is the one that ended
  record(() => json({ error: 'authentication required', mode: 'oidc' }, 401));
  await confirmHubSession();
  assert.equal(challenge(), 'oidc');
});

test('the hub’s own auth checks stay on the hub whatever the scope', async () => {
  setActiveServer('srv_1');
  const calls = record(() => json({}));
  await probeAuth(globalThis.fetch);
  await confirmHubSession();
  assert.deepEqual(
    calls.map((call) => call.url),
    ['/api/security/auth', '/api/security/auth'],
  );
});

test('a 421 through the gateway is not the hub’s host screen', async () => {
  record(() => json({ error: 'host not allowed', code: 'host-not-allowed', host: 'x' }, 421));
  await assert.rejects(createApi('/api/servers/srv_1/api').overview());
  assert.equal(renderToStaticMarkup(<Challenge />), '<i>open</i>');
});

test('per-server browser keys: the hub’s are as they were, a remote’s end with its id', () => {
  assert.equal(storageKey('chats', 'p1'), 'claudio:filters:chats:p1');
  assert.equal(terminalWindowName('t1'), 'claudio-terminal-t1');
  setActiveServer('srv_1');
  assert.equal(storageKey('chats', 'p1'), 'claudio:filters:chats:p1:srv_1');
  assert.equal(terminalWindowName('t1'), 'claudio-terminal-t1:srv_1');
});

test('review marks of the same source on two servers do not meet', () => {
  const data = new Map<string, string>();
  const store: KeyValueStore = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
  const seen = { 'a.ts': { hash: 'h', at: 1 } } as unknown as Parameters<typeof writeSeen>[1];
  writeSeen('chat:c1', seen, store);
  setActiveServer('srv_1');
  assert.deepEqual(readSeen('chat:c1', store), {}, 'the remote does not see the hub’s marks');
  writeSeen('chat:c1', seen, store);
  assert.deepEqual([...data.keys()].sort(), ['claudio-review-seen:v1', 'claudio-review-seen:v1:chat:c1', 'claudio-review-seen:v1:chat:c1:srv_1', 'claudio-review-seen:v1:srv_1']);
});

test('the cache tells two servers’ reads of the same key apart, and an invalidation still matches by prefix', async () => {
  const key = ['chats', 'all'] as const;
  assert.notEqual(serverKeyHash('local')(key), serverKeyHash('srv_1')(key));
  assert.equal(serverKeyHash('srv_1')(key), serverKeyHash('srv_1')(key));

  const hub = new QueryClient({ defaultOptions: { queries: { queryKeyHashFn: serverKeyHash('local') } } });
  hub.setQueryData(key, ['hub chat']);
  await hub.invalidateQueries({ queryKey: ['chats'] });
  assert.equal(hub.getQueryState(key)?.isInvalidated, true);
  assert.deepEqual(hub.getQueryData(['chats', 'all']), ['hub chat']);
});
