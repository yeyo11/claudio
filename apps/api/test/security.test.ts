import assert from 'node:assert/strict';
import { get } from 'node:http';
import { connect } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { Core, loadConfig } from '@claudio/core';
import { REDACTED, type LoginSession } from '@claudio/shared';
import { buildApp } from '../src/app.ts';
import { FailureBackoff } from '../src/security.ts';

// Each test gets its own wrapper: the auth mode is process-wide state, and a test that closes the
// port must not be able to close it for the next one.
const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

interface Wrapper {
  app: FastifyInstance;
  core: Core;
}

const roots = new Set<string>();
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function wrapper(env: NodeJS.ProcessEnv = {}, root = mkdtempSync(join(tmpdir(), 'claudio-security-'))): Promise<Wrapper> {
  roots.add(root);
  const core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
      ...env,
    }),
  );
  return { app: await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') }), core };
}

/** Puts the wrapper in token mode and answers with the token, which exists only here. */
async function withToken(app: FastifyInstance): Promise<string> {
  const created = await app.inject({ method: 'POST', url: '/api/security/token', ...json({}) });
  assert.equal(created.statusCode, 200);
  const { token } = created.json() as { token: string };
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ mode: 'token' }) })).statusCode, 200);
  return token;
}

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
/** A body and a credential at once: both live in `headers`, so they cannot be spread separately. */
const authed = (token: string, body: unknown) => ({
  payload: JSON.stringify(body),
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
});

test('an install nobody configured is open, exactly as it was', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());

  assert.deepEqual((await app.inject('/api/security/auth')).json(), { mode: 'none', tokenSet: false, readOnly: false, firstRunPending: false, firstRunToken: false });
  assert.equal((await app.inject('/api/overview')).statusCode, 200);
  assert.equal((await app.inject('/api/system')).statusCode, 200);
});

test('with a token every route needs it, and health does not', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  const token = await withToken(app);

  // A probe has to work without a credential, and says nothing about the install
  assert.equal((await app.inject('/api/health')).statusCode, 200);

  const refused = await app.inject('/api/overview');
  assert.equal(refused.statusCode, 401);
  assert.match(refused.headers['www-authenticate'] as string, /^Bearer/);
  // The mode travels with the refusal: it is how the UI knows what to ask for
  assert.equal(refused.json().mode, 'token');

  assert.equal((await app.inject({ url: '/api/overview', ...bearer(token) })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/overview', ...bearer('not-the-token') })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/overview', headers: { authorization: token } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects', ...json({ name: 'x' }) })).statusCode, 401);

  // The reference and the document it renders are part of the API, not of the public shell
  assert.equal((await app.inject('/openapi.json')).statusCode, 401);
  assert.equal((await app.inject('/docs')).statusCode, 401);
  assert.equal((await app.inject({ url: '/openapi.json', ...bearer(token) })).statusCode, 200);

  // The token is never readable back, in any shape
  const config = await app.inject({ url: '/api/security/auth', ...bearer(token) });
  assert.equal(config.payload.includes(token), false);
  assert.deepEqual(config.json(), { mode: 'token', tokenSet: true, readOnly: false, firstRunPending: false, firstRunToken: false });
});

test('the event stream takes the token in the query string, which EventSource cannot avoid', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  const token = await withToken(app);
  const base = await app.listen({ port: 0, host: '127.0.0.1' });

  const open = (url: string) =>
    new Promise<{ status: number; first: string }>((resolve, reject) => {
      const req = get(url, (res) => {
        res.setEncoding('utf8');
        res.once('data', (chunk: string) => {
          req.destroy();
          resolve({ status: res.statusCode ?? 0, first: chunk });
        });
        res.once('end', () => resolve({ status: res.statusCode ?? 0, first: '' }));
      });
      req.on('error', reject);
    });

  const guarded = await open(`${base}/api/events`);
  assert.equal(guarded.status, 401);

  const allowed = await open(`${base}/api/events?token=${encodeURIComponent(token)}`);
  assert.equal(allowed.status, 200);
  assert.match(allowed.first, /retry: 3000/);

  const wrong = await open(`${base}/api/events?token=nope`);
  assert.equal(wrong.status, 401);

  // A transcript export is a download link, which carries no header either. An unknown chat is a
  // 404: what matters is that the guard let it reach the route.
  assert.equal((await app.inject('/api/chats/nope/export')).statusCode, 401);
  assert.equal((await app.inject(`/api/chats/nope/export?format=json&token=${encodeURIComponent(token)}`)).statusCode, 404);
  assert.equal((await app.inject('/api/projects/nope/export')).statusCode, 401);
  assert.equal((await app.inject(`/api/projects/nope/export?token=${encodeURIComponent(token)}`)).statusCode, 404);

  // The other two a browser opens without a header: a chat's own stream and an attachment shown
  // inline. Unknown ids again, so only the guard's answer is under test.
  for (const path of ['/api/chats/nope/stream', '/api/uploads/nope/content']) {
    assert.equal((await app.inject(path)).statusCode, 401, path);
    assert.notEqual((await app.inject(`${path}?token=${encodeURIComponent(token)}`)).statusCode, 401, path);
  }

  // Only the routes a browser cannot put a header on: anything callable with `fetch` may not
  assert.equal((await app.inject(`/api/overview?token=${encodeURIComponent(token)}`)).statusCode, 401);
});

test('an OIDC wrapper refuses a token it cannot check, without reaching for the issuer', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  // 127.0.0.1:1 is a closed port: a JWT that is not even a JWT must fail before any fetch
  const configured = await app.inject({
    method: 'PUT',
    url: '/api/security/auth',
    ...json({ oidc: { issuer: 'http://127.0.0.1:1', audience: 'claudio', clientId: 'ui' }, mode: 'oidc' }),
  });
  assert.equal(configured.statusCode, 200);
  assert.deepEqual(configured.json().oidc, { issuer: 'http://127.0.0.1:1', audience: 'claudio', clientId: 'ui' });

  const refused = await app.inject({ url: '/api/overview', ...bearer('not.a.jwt') });
  assert.equal(refused.statusCode, 401);
  assert.equal(refused.json().mode, 'oidc');
  assert.equal((await app.inject('/api/health')).statusCode, 200);
});

test('read-only refuses every change but answering a prompt and turning itself back off', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  const created = await app.inject({ method: 'POST', url: '/api/projects', ...json({ name: 'demo' }) });
  assert.equal(created.statusCode, 201);

  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ readOnly: true }) })).statusCode, 200);

  const rejected = await app.inject({ method: 'POST', url: '/api/projects', ...json({ name: 'another' }) });
  assert.equal(rejected.statusCode, 405);
  assert.match(rejected.json().error, /read-only/);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/projects/${created.json().id}` })).statusCode, 405);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/config/settings', ...json({ settings: { model: 'sonnet' } }) })).statusCode, 405);
  // Reading is exactly what read-only is for
  assert.equal((await app.inject('/api/projects')).statusCode, 200);

  // A prompt still gets an answer: 400 because this one does not exist, and not 405
  const answered = await app.inject({ method: 'POST', url: '/api/chats/c1/permissions/p1', ...json({ behavior: 'allow' }) });
  assert.notEqual(answered.statusCode, 405);

  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ readOnly: false }) })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects', ...json({ name: 'another' }) })).statusCode, 201);
});

test('settings hand out the names of their secrets and take the placeholder back unchanged', async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());

  const written = await app.inject({
    method: 'PUT',
    url: '/api/config/settings',
    ...json({ settings: { model: 'sonnet', env: { ANTHROPIC_AUTH_TOKEN: 'sk-real-secret', REGION: 'eu' } } }),
  });
  assert.equal(written.statusCode, 200);
  // Even the answer to the write is redacted: the value never travels back
  assert.deepEqual(written.json().settings.env, { ANTHROPIC_AUTH_TOKEN: REDACTED, REGION: REDACTED });

  const read = await app.inject('/api/config/settings');
  assert.equal(read.json().settings.model, 'sonnet');
  assert.equal(read.payload.includes('sk-real-secret'), false);

  // The panel sends back what it was given, with one field edited
  const edited = read.json().settings as Record<string, unknown>;
  const roundTripped = await app.inject({
    method: 'PUT',
    url: '/api/config/settings',
    ...json({ settings: { ...edited, model: 'opus', env: { ANTHROPIC_AUTH_TOKEN: REDACTED, REGION: 'us' } } }),
  });
  assert.equal(roundTripped.statusCode, 200);

  const onDisk = JSON.parse(readFileSync(join(core.config.configDir, 'settings.json'), 'utf8')) as { model: string; env: Record<string, string> };
  assert.equal(onDisk.model, 'opus');
  assert.equal(onDisk.env.ANTHROPIC_AUTH_TOKEN, 'sk-real-secret', 'the placeholder must not overwrite the stored secret');
  assert.equal(onDisk.env.REGION, 'us');

  // A placeholder standing for nothing is refused rather than written down as itself
  const invented = await app.inject({ method: 'PUT', url: '/api/config/settings', ...json({ settings: { env: { NEW_ONE: REDACTED } } }) });
  assert.equal(invented.statusCode, 400);
  assert.match(invented.json().error, /no stored value behind the placeholder/);
});

test('every write leaves an audit row, with who and what but never the body', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());

  const created = await app.inject({ method: 'POST', url: '/api/projects', ...json({ name: 'audited' }) });
  assert.equal(created.statusCode, 201);
  await app.inject({ method: 'PUT', url: '/api/config/settings', ...json({ settings: { model: 'sonnet' } }) });
  await app.inject({ method: 'DELETE', url: `/api/projects/${created.json().id}` });
  assert.equal((await app.inject('/api/projects')).statusCode, 200); // a read leaves nothing

  const page = (await app.inject('/api/audit')).json();
  assert.equal(page.total, 3);
  assert.equal(page.from, 0);
  const [newest] = page.entries;
  assert.equal(newest.method, 'DELETE');
  assert.match(newest.path, /^\/api\/projects\//);
  assert.equal(newest.actor, 'local');
  assert.equal(newest.status, 200);
  // The summary comes from the route's own documentation, not from anything the caller sent
  assert.equal(newest.summary, 'Remove a project from Claudio');
  // And the route it matched, as ROUTE_DOCS keys it, which is what the web translates the row by
  assert.equal(newest.route, 'DELETE /projects/:id');
  assert.equal(page.entries.some((entry: { summary: string }) => entry.summary === 'Create a project in the workspace'), true);
  assert.equal((await app.inject('/api/audit')).payload.includes('audited'), false, 'no body, and no name from one, is ever recorded');

  const filtered = (await app.inject('/api/audit?path=/api/config')).json();
  assert.equal(filtered.total, 1);
  assert.equal(filtered.entries[0].summary, 'Replace settings.json');

  const paged = (await app.inject('/api/audit?limit=1&from=1')).json();
  assert.equal(paged.entries.length, 1);
  assert.equal(paged.from, 1);
  assert.equal(paged.total, 3);

  const deletes = (await app.inject('/api/audit?method=delete')).json();
  assert.equal(deletes.total, 1);
  assert.equal(deletes.entries[0].method, 'DELETE');
  assert.equal((await app.inject('/api/audit?status=2xx')).json().total, 3);
  assert.equal((await app.inject('/api/audit?status=201')).json().total, 1);
  assert.equal((await app.inject('/api/audit?status=4xx&method=POST')).json().total, 0);
  const refused = await app.inject('/api/audit?status=teapot');
  assert.equal(refused.statusCode, 400);
  assert.match(refused.json().error, /a code such as 404 or a class such as 4xx/);
});

test('a write no route matched is recorded with no route, and its method and path as the summary', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());

  assert.equal((await app.inject({ method: 'POST', url: '/api/nowhere/at-all' })).statusCode, 404);
  const [row] = (await app.inject('/api/audit')).json().entries;
  assert.equal(row.route, null);
  assert.equal(row.summary, 'POST /api/nowhere/at-all');
});

test('the audit page says itself what a page number must be, instead of letting SQLite say it', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());

  for (const query of ['limit=soon', 'limit=1.5', 'limit=-1', 'from=yesterday', 'from=-1']) {
    const refused = await app.inject(`/api/audit?${query}`);
    assert.equal(refused.statusCode, 400, query);
    // NaN used to reach node:sqlite as a binding and come back as `datatype mismatch`
    assert.match(refused.json().error, /must be a non-negative integer/, query);
  }
  // An absent or empty parameter is not a mistake: it means the default page
  assert.equal((await app.inject('/api/audit')).json().from, 0);
  assert.equal((await app.inject('/api/audit?limit=&from=')).json().from, 0);
  assert.equal((await app.inject('/api/audit?limit=1&from=0')).statusCode, 200);
});

test('a write refused for want of a credential is recorded as nobody', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  const token = await withToken(app);

  assert.equal((await app.inject({ method: 'POST', url: '/api/projects', ...json({ name: 'x' }) })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects', ...authed(token, { name: 'named' }) })).statusCode, 201);

  const page = (await app.inject({ url: '/api/audit', ...bearer(token) })).json();
  // The refusal is kept apart, where a flood of them cannot push the log's history out
  assert.equal(page.entries.some((entry: { status: number }) => entry.status === 401), false);
  const refusals = (await app.inject({ url: '/api/audit/refusals', ...bearer(token) })).json();
  const [refused] = refusals.entries;
  assert.equal(refused.status, 401);
  assert.equal(refused.actor, 'anonymous');
  assert.equal(refused.route, 'POST /projects');
  // And what the credential did carries its id, which is how a rotation shows up in the history
  const allowed = page.entries.find((entry: { status: number }) => entry.status === 201);
  assert.match(allowed.actor, /^token:/);
});

test('the environment can hand a fresh install a closed door', async (t) => {
  const { app } = await wrapper({ CLAUDIO_AUTH_TOKEN: 'a-token-from-a-secret', CLAUDIO_READ_ONLY: '1' });
  t.after(() => app.close());

  assert.equal((await app.inject('/api/overview')).statusCode, 401);
  assert.deepEqual((await app.inject({ url: '/api/security/auth', ...bearer('a-token-from-a-secret') })).json(), {
    mode: 'token',
    tokenSet: true,
    readOnly: true,
    firstRunPending: false,
    firstRunToken: false,
  });
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects', ...authed('a-token-from-a-secret', { name: 'x' }) })).statusCode, 405);
});

test('CLAUDIO_AUTH_TOKEN_RESET lets someone who lost the token back in, once, and says so in the log', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'claudio-security-'));
  const first = await wrapper({}, root);
  const lost = await withToken(first.app);
  await first.app.close();

  const reset = { CLAUDIO_AUTH_TOKEN: 'a-recovered-token-from-env', CLAUDIO_AUTH_TOKEN_RESET: '1' };
  const second = await wrapper(reset, root);
  assert.equal((await second.app.inject({ url: '/api/overview', ...bearer(lost) })).statusCode, 401, 'the lost token no longer opens it');
  assert.equal((await second.app.inject({ url: '/api/overview', ...bearer(reset.CLAUDIO_AUTH_TOKEN) })).statusCode, 200);
  const rows = (await second.app.inject({ url: '/api/audit?path=/api/security/token', ...bearer(reset.CLAUDIO_AUTH_TOKEN) })).json();
  const byEnv = rows.entries.filter((entry: { actor: string }) => entry.actor === 'env');
  assert.equal(byEnv.length, 1);
  assert.match(byEnv[0].summary, /CLAUDIO_AUTH_TOKEN_RESET/);
  // Someone rotates it from the UI; a restart with the variable still set must not undo that
  const rotated = (await second.app.inject({ method: 'POST', url: '/api/security/token', ...authed(reset.CLAUDIO_AUTH_TOKEN, {}) })).json() as { token: string };
  await second.app.close();

  const third = await wrapper(reset, root);
  t.after(() => third.app.close());
  assert.equal((await third.app.inject({ url: '/api/overview', ...bearer(rotated.token) })).statusCode, 200);
  assert.equal((await third.app.inject({ url: '/api/overview', ...bearer(reset.CLAUDIO_AUTH_TOKEN) })).statusCode, 401);
  const after = (await third.app.inject({ url: '/api/audit?path=/api/security/token', ...bearer(rotated.token) })).json();
  assert.equal(after.entries.filter((entry: { actor: string }) => entry.actor === 'env').length, 1, 'no second reset row');
});

test('a host nobody configured is refused, which is what stops DNS rebinding', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());

  // Loopback is the install itself, under every spelling a browser or a dual-stack socket produces
  for (const host of ['localhost', 'localhost:8787', '127.0.0.1:8787', '127.1.2.3', '[::1]:8787', '::ffff:127.0.0.1']) {
    assert.equal((await app.inject({ url: '/api/overview', headers: { host } })).statusCode, 200, host);
  }

  // The attack itself: a page on a name whose second lookup answers 127.0.0.1
  const rebound = await app.inject({ url: '/api/overview', headers: { host: 'rebind.evil.test' } });
  assert.equal(rebound.statusCode, 421);
  assert.match(rebound.json().error, /CLAUDIO_ALLOWED_HOSTS/);

  // Every guarded path, not just the API: /docs and the reference serve the same install
  assert.equal((await app.inject({ url: '/openapi.json', headers: { host: 'rebind.evil.test' } })).statusCode, 421);
  const written = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: JSON.stringify({ name: 'x' }),
    headers: { host: 'rebind.evil.test', 'content-type': 'application/json' },
  });
  assert.equal(written.statusCode, 421);
  // A probe stays open whatever it dialled: it says nothing about the install
  assert.equal((await app.inject({ url: '/api/health', headers: { host: 'rebind.evil.test' } })).statusCode, 200);
});

test('CLAUDIO_ALLOWED_HOSTS names the hosts a deployment answers to, port and case aside', async (t) => {
  const { app } = await wrapper({ CLAUDIO_ALLOWED_HOSTS: 'claudio.example.com, claudio.internal' });
  t.after(() => app.close());

  assert.equal((await app.inject({ url: '/api/overview', headers: { host: 'claudio.example.com' } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/overview', headers: { host: 'CLAUDIO.Example.COM:8787' } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/overview', headers: { host: 'claudio.internal:443' } })).statusCode, 200);
  // A name that merely contains one of them is a different name
  assert.equal((await app.inject({ url: '/api/overview', headers: { host: 'claudio.example.com.evil.test' } })).statusCode, 421);
  assert.equal((await app.inject({ url: '/api/overview', headers: { host: 'other.example.com' } })).statusCode, 421);
});

test('a pattern answers to the subdomains of a domain, and to nothing that merely looks like one', async (t) => {
  // What a tunnel needs: its host changes on every start, and only the domain under it is fixed
  const { app } = await wrapper({ CLAUDIO_ALLOWED_HOSTS: '*.tunnel.example, claudio.internal' });
  t.after(() => app.close());

  for (const host of ['a.tunnel.example', 'a-1234.region.tunnel.example', 'A.Tunnel.Example:8787']) {
    assert.equal((await app.inject({ url: '/api/overview', headers: { host } })).statusCode, 200, host);
  }
  // A name alongside the pattern still answers, and the apex is a host of its own
  assert.equal((await app.inject({ url: '/api/overview', headers: { host: 'claudio.internal' } })).statusCode, 200);
  for (const host of ['tunnel.example', 'eviltunnel.example', 'tunnel.example.evil.test']) {
    assert.equal((await app.inject({ url: '/api/overview', headers: { host } })).statusCode, 421, host);
  }
});

test('the host is checked before the credential, so an open install is guarded too', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  const token = await withToken(app);

  // Even holding the credential that opens everything: the authority is refused first
  const refused = await app.inject({ url: '/api/overview', headers: { host: 'rebind.evil.test', authorization: `Bearer ${token}` } });
  assert.equal(refused.statusCode, 421);
  assert.equal(refused.headers['www-authenticate'], undefined);
});

test('a client that keeps guessing the token is asked to wait, and the wait grows', () => {
  let now = 0;
  const backoff = new FailureBackoff(() => now);

  // The first failures are free: a mistyped token must not lock someone out of their own wrapper
  for (let i = 0; i < 9; i += 1) {
    backoff.fail('10.0.0.1');
    assert.equal(backoff.retryAfter('10.0.0.1'), 0, `failure ${i + 1}`);
  }

  backoff.fail('10.0.0.1');
  assert.equal(backoff.retryAfter('10.0.0.1'), 1);
  // Waiting it out and failing again costs twice as long
  now += 1_000;
  assert.equal(backoff.retryAfter('10.0.0.1'), 0);
  backoff.fail('10.0.0.1');
  assert.equal(backoff.retryAfter('10.0.0.1'), 2);
  now += 2_000;
  backoff.fail('10.0.0.1');
  assert.equal(backoff.retryAfter('10.0.0.1'), 4);

  // Capped: a wait that doubled for ever would be a permanent ban on an address
  for (let i = 0; i < 20; i += 1) {
    now += 60_000;
    backoff.fail('10.0.0.1');
  }
  assert.equal(backoff.retryAfter('10.0.0.1'), 60);

  // Another address is another client: one attacker does not close the wrapper for everybody
  assert.equal(backoff.retryAfter('10.0.0.2'), 0);
  // A credential that worked is looked at at once, wherever it comes from, and the guesses beside it
  // still wait: a success wipes nobody's count
  backoff.succeed('the-owners-token');
  assert.equal(backoff.retryAfter('10.0.0.1', 'the-owners-token'), 0);
  assert.equal(backoff.retryAfter('10.0.0.1', 'a-guess'), 60);
  assert.equal(backoff.retryAfter('10.0.0.1'), 60);
  // Once it fails (rotated, revoked) it is a guess like the others
  backoff.fail('10.0.0.1', 'the-owners-token');
  assert.equal(backoff.retryAfter('10.0.0.1', 'the-owners-token'), 60);
});

test('a quiet client is forgotten, and the addresses remembered cannot grow without end', () => {
  let now = 0;
  const backoff = new FailureBackoff(() => now);

  for (let i = 0; i < 12; i += 1) backoff.fail('10.0.0.1');
  assert.ok(backoff.retryAfter('10.0.0.1') > 0);

  // Quiet for the forgetting period: the count starts over instead of resuming where it stopped
  now += 15 * 60_000;
  assert.equal(backoff.retryAfter('10.0.0.1'), 0);
  backoff.fail('10.0.0.1');
  assert.equal(backoff.retryAfter('10.0.0.1'), 0, 'the old count did not come back');

  // A botnet with a fresh address per attempt feeds the map; it stays bounded
  for (let i = 0; i < 5_000; i += 1) {
    now += 1;
    backoff.fail(`10.1.${Math.floor(i / 256)}.${i % 256}`);
  }
  assert.ok(backoff.size > 0 && backoff.size <= 1024, `bounded, got ${backoff.size}`);
  // And the flood does not buy the attacker a clean slate: an address still failing is still counted
  for (let i = 0; i < 10; i += 1) backoff.fail('10.9.9.9');
  assert.ok(backoff.retryAfter('10.9.9.9') > 0);
});

test('the guard answers 429 once an address has failed too often, with a Retry-After', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  const token = await withToken(app);

  for (let i = 0; i < 10; i += 1) {
    assert.equal((await app.inject({ url: '/api/overview', ...bearer('not-the-token') })).statusCode, 401, `attempt ${i + 1}`);
  }

  const throttled = await app.inject({ url: '/api/overview', ...bearer('not-the-token') });
  assert.equal(throttled.statusCode, 429);
  assert.equal(throttled.headers['retry-after'], '1');
  assert.equal(throttled.json().mode, 'token');
  // The real token waits with the rest: the wait is on the address, which is all the guard knows
  assert.equal((await app.inject({ url: '/api/overview', ...bearer(token) })).statusCode, 429);
  // Nothing open is affected, so a container healthcheck survives an attack on its own port
  assert.equal((await app.inject('/api/health')).statusCode, 200);
});

test('a credential that worked skips the wait, and its success hands the guesser beside it nothing', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  const token = await withToken(app);

  assert.equal((await app.inject({ url: '/api/overview', ...bearer(token) })).statusCode, 200);
  for (let i = 0; i < 9; i += 1) {
    assert.equal((await app.inject({ url: '/api/overview', ...bearer('not-the-token') })).statusCode, 401);
  }
  // The owner polling in between does not wipe the count: the tenth guess still starts the wait
  assert.equal((await app.inject({ url: '/api/overview', ...bearer(token) })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/overview', ...bearer('not-the-token') })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/overview', ...bearer('not-the-token') })).statusCode, 429);
  // And the owner is never locked out by it (report §8.5)
  assert.equal((await app.inject({ url: '/api/overview', ...bearer(token) })).statusCode, 200);
});

test('the back-off is per address and dialled name, so guesses on the LAN name leave localhost alone', async (t) => {
  const { app } = await wrapper({ CLAUDIO_ALLOWED_HOSTS: 'lan.example' });
  t.after(() => app.close());
  await withToken(app);
  // Behind socat every client arrives from 127.0.0.1; only the name it dialled tells them apart
  const lan = (credential: string) => ({ url: '/api/overview', remoteAddress: '127.0.0.1', headers: { host: 'lan.example:8443', authorization: `Bearer ${credential}` } });
  for (let i = 0; i < 10; i += 1) await app.inject(lan('not-the-token'));
  assert.equal((await app.inject(lan('not-the-token'))).statusCode, 429);
  const local = { url: '/api/overview', remoteAddress: '127.0.0.1', headers: { host: 'localhost:3000', authorization: 'Bearer another-guess' } };
  assert.equal((await app.inject(local)).statusCode, 401, 'the desktop on localhost has its own allowance');
});

test('a request that carries no credential is refused but never counted, however often it comes', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  await withToken(app);

  // A tray or a stale tab polling without a credential is not guessing the token
  for (let i = 0; i < 40; i += 1) {
    const refused = await app.inject('/api/overview');
    assert.equal(refused.statusCode, 401, `anonymous attempt ${i + 1}`);
    assert.equal(refused.headers['retry-after'], undefined);
  }
  // Nor is an empty bearer, or a `?token=` on a route that never reads one
  assert.equal((await app.inject({ url: '/api/overview', headers: { authorization: 'Bearer ' } })).statusCode, 401);
  assert.equal((await app.inject('/api/overview?token=whatever')).statusCode, 401);
  // A wrong token still has its whole allowance: nothing above spent any of it
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await app.inject({ url: '/api/overview', ...bearer('not-the-token') })).statusCode, 401, `wrong token ${i + 1}`);
  }
  assert.equal((await app.inject({ url: '/api/overview', ...bearer('not-the-token') })).statusCode, 429);
});

test('a wrong token in the query string is a guess like any other', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  await withToken(app);

  for (let i = 0; i < 10; i += 1) {
    assert.equal((await app.inject('/api/chats/x/export?token=not-the-token')).statusCode, 401, `attempt ${i + 1}`);
  }
  assert.equal((await app.inject('/api/chats/x/export?token=not-the-token')).statusCode, 429);
});

test('an address blocked for wrong tokens stays blocked, and anonymous requests are only refused', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  const token = await withToken(app);

  for (let i = 0; i < 10; i += 1) await app.inject({ url: '/api/overview', ...bearer('not-the-token') });
  assert.equal((await app.inject({ url: '/api/overview', ...bearer('not-the-token') })).statusCode, 429);
  assert.equal((await app.inject({ url: '/api/overview', ...bearer(token) })).statusCode, 429);
  // Nothing to check, so nothing to wait for: the answer is the plain refusal
  assert.equal((await app.inject('/api/overview')).statusCode, 401);
  // And going without a credential is not a way to serve the wait sooner
  assert.equal((await app.inject({ url: '/api/overview', ...bearer('not-the-token') })).statusCode, 429);
});

test('the owner is served while something on the same machine polls without a credential', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  const token = await withToken(app);

  // What happened on the desktop: the tray polled every few seconds, all from 127.0.0.1
  for (let round = 0; round < 5; round += 1) {
    for (let i = 0; i < 20; i += 1) {
      assert.equal((await app.inject({ url: i % 2 ? '/api/events' : '/api/overview', remoteAddress: '127.0.0.1' })).statusCode, 401);
    }
    const owner = await app.inject({ url: '/api/overview', remoteAddress: '127.0.0.1', ...bearer(token) });
    assert.equal(owner.statusCode, 200, `round ${round + 1}`);
  }
});

const DESKTOP_SECRET = 'a-per-launch-secret-of-32-random-bytes';

test("the desktop app's own secret lets its tray read from loopback, whatever token the owner chose", async (t) => {
  const { app, core } = await wrapper({ CLAUDIO_DESKTOP_TOKEN: DESKTOP_SECRET });
  t.after(() => app.close());
  await withToken(app);

  // How the tray asks: from 127.0.0.1, to 127.0.0.1
  const local = { remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:43123', authorization: `Bearer ${DESKTOP_SECRET}` } };
  assert.equal((await app.inject({ url: '/api/overview', ...local })).statusCode, 200);
  // The event feed takes it as a header like any other route
  assert.equal((await app.inject({ url: '/api/chats?state=working&limit=10', ...local })).statusCode, 200);

  // It reads and nothing else, and the refusal is written down under its name
  const write = await app.inject({ method: 'POST', url: '/api/projects', ...local, payload: { name: 'x' } });
  assert.equal(write.statusCode, 403);
  const audit = core.db.auditPage({ path: '/api/projects' }).entries[0];
  assert.equal(audit?.actor, 'desktop');

  // No route hands it back
  for (const url of ['/api/security/auth', '/api/system', '/api/overview']) {
    const res = await app.inject({ url, ...local });
    assert.equal(res.body.includes(DESKTOP_SECRET), false, url);
  }
});

test("the desktop app's secret is refused from anywhere but this machine, and a wrong one is a guess", async (t) => {
  const { app } = await wrapper({ CLAUDIO_DESKTOP_TOKEN: DESKTOP_SECRET, CLAUDIO_ALLOWED_HOSTS: 'claudio.example' });
  t.after(() => app.close());
  await withToken(app);
  const withSecret = (secret: string) => ({ authorization: `Bearer ${secret}` });

  // From another address
  assert.equal((await app.inject({ url: '/api/overview', remoteAddress: '10.0.0.5', headers: { host: '127.0.0.1:43123', ...withSecret(DESKTOP_SECRET) } })).statusCode, 401);
  // From loopback, but relayed: a proxy or a tunnel carries the name it was reached on
  assert.equal((await app.inject({ url: '/api/overview', remoteAddress: '127.0.0.1', headers: { host: 'claudio.example', ...withSecret(DESKTOP_SECRET) } })).statusCode, 401);
  // A secret that is not the one this launch was given
  assert.equal((await app.inject({ url: '/api/overview', remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:43123', ...withSecret(`${DESKTOP_SECRET}x`) } })).statusCode, 401);
});

test('without a desktop secret configured, nothing is accepted in its place', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  await withToken(app);
  assert.equal((await app.inject({ url: '/api/overview', ...bearer(DESKTOP_SECRET) })).statusCode, 401);
});

// ---------- a chat's own token (CLAUDIO_API_TOKEN) ----------

/** How a chat on this machine calls the wrapper that started it: loopback peer, loopback name. */
const fromChat = (token: string, extra: Record<string, string> = {}) => ({
  remoteAddress: '127.0.0.1',
  headers: { host: '127.0.0.1:34331', authorization: `Bearer ${token}`, ...extra },
});
const fromChatWith = (token: string, body: unknown) => ({
  remoteAddress: '127.0.0.1',
  payload: JSON.stringify(body),
  headers: { host: '127.0.0.1:34331', 'content-type': 'application/json', authorization: `Bearer ${token}` },
});

test("a chat's token opens a guarded read and a write from loopback, and the write is audited as the chat", async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  const owner = await withToken(app);
  const token = core.security.chatTokens.mint('chat-42');

  assert.equal((await app.inject({ url: '/api/overview', ...fromChat(token) })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/overview', ...fromChat(token, { host: 'localhost:34331' }) })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/overview', remoteAddress: '::1', headers: { host: '[::1]:34331', authorization: `Bearer ${token}` } })).statusCode, 200);
  // A `work` route lets it through the guard: the answer is the route's own, nothing runs on that chat
  const stopped = await app.inject({ method: 'POST', url: '/api/chats/nope/stop', ...fromChatWith(token, {}) });
  assert.equal(stopped.statusCode, 400);
  assert.match(stopped.json().error, /nothing is running on this chat/);

  const [newest] = (await app.inject({ url: '/api/audit', ...bearer(owner) })).json().entries;
  assert.equal(newest.actor, 'chat:chat-42');
  assert.equal(newest.path, '/api/chats/nope/stop');
});

test("a chat's token is refused, like a wrong token, from anywhere that is not a chat on this machine", async (t) => {
  const { app, core } = await wrapper({ CLAUDIO_ALLOWED_HOSTS: 'claudio.example' });
  t.after(() => app.close());
  await withToken(app);
  core.appSettings.runtimeHosts.add('abc123.lhr.life', { clientIpHeader: 'X-Client-Ip' });
  const token = core.security.chatTokens.mint('chat-42');
  const wrong = await app.inject({ url: '/api/overview', ...bearer('not-the-token') });

  const cases: Array<[string, InjectOptions]> = [
    ['a peer that is not loopback', { url: '/api/overview', remoteAddress: '10.0.0.5', headers: { host: '127.0.0.1:34331', authorization: `Bearer ${token}` } }],
    // The tunnel dials 127.0.0.1 too: only the name it carries tells it apart
    ['the tunnel host', { url: '/api/overview', ...fromChat(token, { host: 'abc123.lhr.life' }) }],
    ['an allowed host', { url: '/api/overview', ...fromChat(token, { host: 'claudio.example' }) }],
    ['X-Forwarded-For', { url: '/api/overview', ...fromChat(token, { 'x-forwarded-for': '203.0.113.9' }) }],
    ['Forwarded', { url: '/api/overview', ...fromChat(token, { forwarded: 'for=203.0.113.9' }) }],
    ["a runtime host's client-IP header", { url: '/api/overview', ...fromChat(token, { 'x-client-ip': '203.0.113.9' }) }],
  ];
  for (const [where, request] of cases) {
    const refused = await app.inject(request);
    assert.equal(refused.statusCode, 401, where);
    assert.equal(refused.payload, wrong.payload, `${where}: the same body as a wrong token`);
    assert.equal(refused.headers['www-authenticate'], wrong.headers['www-authenticate'], `${where}: the same challenge`);
  }
});

test("a chat's token used from the wrong place is a guess, and counts toward the wait", async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  await withToken(app);
  const token = core.security.chatTokens.mint('chat-42');
  const outside = { url: '/api/overview', remoteAddress: '10.0.0.5', headers: { host: '127.0.0.1:34331', authorization: `Bearer ${token}` } };
  for (let i = 0; i < 10; i += 1) assert.equal((await app.inject(outside)).statusCode, 401, `attempt ${i + 1}`);
  assert.equal((await app.inject(outside)).statusCode, 429);
});

test("a chat's token is refused once revoked, and by a wrapper started afresh", async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'claudio-security-'));
  const first = await wrapper({}, root);
  await withToken(first.app);
  const token = first.core.security.chatTokens.mint('chat-42');
  const kept = first.core.security.chatTokens.mint('chat-43');
  assert.equal((await first.app.inject({ url: '/api/overview', ...fromChat(token) })).statusCode, 200);
  first.core.security.chatTokens.revoke(token);
  assert.equal((await first.app.inject({ url: '/api/overview', ...fromChat(token) })).statusCode, 401);
  await first.app.close();
  first.core.shutdown();

  // Same data dir, same owner token on disk: only the chat tokens are gone
  const second = await wrapper({}, root);
  t.after(() => second.app.close());
  assert.equal((await second.app.inject({ url: '/api/overview', ...fromChat(kept) })).statusCode, 401);
});

test("a chat's token cannot administer the guard or the tunnel", async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  await withToken(app);
  const token = core.security.chatTokens.mint('chat-42');
  const forbidden: Array<[string, string, unknown]> = [
    ['PUT', '/api/security/auth', { mode: 'none' }],
    ['POST', '/api/security/token', {}],
    ['DELETE', '/api/security/token', undefined],
    ['POST', '/api/tunnel/start', undefined],
    ['PUT', '/api/tunnel/settings', { startWithClaudio: true }],
    // Everything under /tunnel is the person's (C1), closing it included
    ['POST', '/api/tunnel/stop', undefined],
  ];
  for (const [method, url, body] of forbidden) {
    const request = body === undefined ? { method, url, ...fromChat(token) } : { method, url, ...fromChatWith(token, body) };
    const answer = await app.inject(request as InjectOptions);
    assert.equal(answer.statusCode, 403, `${method} ${url}`);
    assert.equal(answer.json().code, 'chat-forbidden');
    assert.match(answer.json().error, /^a chat's token cannot do this \(.+\): it is the person's$/);
  }
  assert.equal(core.security.mode, 'token', 'the guard is still on');
});

test("a chat's token cannot change a project's tracker through the general settings route", async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  const owner = await withToken(app);
  const root = mkdtempSync(join(tmpdir(), 'claudio-security-project-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const imported = await app.inject({ method: 'POST', url: '/api/projects/import', ...authed(owner, { path: root, name: 'Tracked', modules: ['board'] }) });
  assert.equal(imported.statusCode, 201, imported.body);
  const { id } = imported.json() as { id: string };
  const url = `/api/projects/${id}/settings`;
  const tracker = { id: 'github-issues', scope: 'acme/widgets', query: 'is:open', statusMap: { done: 'completed' } };
  const settings = (await app.inject({ url, ...bearer(owner) })).json() as Record<string, unknown>;
  assert.equal((await app.inject({ method: 'PUT', url, ...authed(owner, { ...settings, tracker }) })).statusCode, 200);

  // Under a guard the settings document is the person's whole
  const chat = core.security.chatTokens.mint('chat-42');
  const hijacked = { ...settings, tracker: { ...tracker, scope: 'evil/repo', query: '', statusMap: { done: 'closed' } } };
  assert.equal((await app.inject({ method: 'PUT', url, ...fromChatWith(chat, hijacked) })).statusCode, 403);

  // Open, the token only labels the request, and the route keeps the tracker out of a chat's save
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...authed(owner, { mode: 'none' }) })).statusCode, 200);
  const answer = await app.inject({ method: 'PUT', url, ...fromChatWith(chat, hijacked) });
  assert.equal(answer.statusCode, 200, answer.body);
  assert.deepEqual((answer.json() as { tracker?: unknown }).tracker, tracker);
  assert.deepEqual(((await app.inject({ url, ...bearer(owner) })).json() as { tracker?: unknown }).tracker, tracker);

  // And a chat's document without one cannot clear it
  const { tracker: _gone, ...without } = settings as Record<string, unknown>;
  assert.equal((await app.inject({ method: 'PUT', url, ...fromChatWith(chat, without) })).statusCode, 200);
  assert.deepEqual(((await app.inject({ url, ...bearer(owner) })).json() as { tracker?: unknown }).tracker, tracker);
});

test("read-only and the host allowlist apply to a chat's token as to the owner's", async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  const owner = await withToken(app);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...authed(owner, { readOnly: true }) })).statusCode, 200);
  const token = core.security.chatTokens.mint('chat-42');
  assert.equal((await app.inject({ method: 'POST', url: '/api/chats/nope/stop', ...fromChatWith(token, {}) })).statusCode, 405);
  // Refused before any credential is looked at
  assert.equal((await app.inject({ url: '/api/overview', ...fromChat(token, { host: 'rebound.example' }) })).statusCode, 421);
});

test("a chat's token is honoured under OIDC too, under the same loopback rules", async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  const configured = await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ oidc: { issuer: 'http://127.0.0.1:1', audience: 'claudio', clientId: 'ui' }, mode: 'oidc' }) });
  assert.equal(configured.statusCode, 200);
  const token = core.security.chatTokens.mint('chat-42');
  assert.equal((await app.inject({ url: '/api/overview', ...fromChat(token) })).statusCode, 200);
  // Through the guard to the route's own answer, and a `person` route refused
  assert.match((await app.inject({ method: 'POST', url: '/api/chats/nope/stop', ...fromChatWith(token, {}) })).json().error, /nothing is running on this chat/);
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects', ...fromChatWith(token, { name: 'oidc-chat' }) })).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/overview', ...fromChat(token, { 'x-forwarded-for': '203.0.113.9' }) })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/overview', remoteAddress: '10.0.0.5', headers: { host: '127.0.0.1:34331', authorization: `Bearer ${token}` } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...fromChatWith(token, { mode: 'none' }) })).statusCode, 403);
});

test("an open wrapper stays open and labels a chat's writes as the chat, and a token that is not valid as local", async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  const token = core.security.chatTokens.mint('chat-42');
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects', ...fromChatWith(token, { name: 'open' }) })).statusCode, 201);
  // Nothing guards it, so the chat's token administers nothing either way
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...fromChatWith(token, { readOnly: false }) })).statusCode, 200);
  // The label is all the token does here: a wrong one is not refused, it is `local`
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects', ...fromChatWith('claudio_chat_wrong', { name: 'wrong' }) })).statusCode, 201);
  const entries = (await app.inject('/api/audit')).json().entries as Array<{ actor: string }>;
  assert.deepEqual(entries.map((entry) => entry.actor), ['local', 'chat:chat-42', 'chat:chat-42']);
});

test("a chat's token reads the context routes, compacts and asks for a note, but cannot delete one", async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  const owner = await withToken(app);
  const token = core.security.chatTokens.mint('chat-42');
  // Through the guard: the chat does not exist, which is a 404 and not a 403. A compact or a note is
  // a turn of the chat's work, like the messages a chat's token sends (C1), typed or not
  for (const [method, url, body] of [
    ['GET', '/api/chats/nope/context', undefined],
    ['GET', '/api/chats/nope/compactions', undefined],
    ['GET', '/api/chats/nope/notes', undefined],
    ['POST', '/api/chats/nope/compact', {}],
    ['POST', '/api/chats/nope/notes', { from: 'agent' }],
    ['POST', '/api/chats/nope/messages', { text: '/compact' }],
  ] as const) {
    assert.equal((await app.inject({ method, url, ...(body === undefined ? fromChat(token) : fromChatWith(token, body)) })).statusCode, 404, `${method} ${url}`);
  }
  // Every DELETE is the person's
  const removed = await app.inject({ method: 'DELETE', url: '/api/chats/nope/notes/n1', ...fromChat(token) });
  assert.equal(removed.statusCode, 403);
  assert.equal(removed.json().code, 'chat-forbidden');
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/chats/nope/notes/n1', ...bearer(owner) })).statusCode, 404);
});

test("an open wrapper lets a chat's token compact, labelled as the chat", async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  const token = core.security.chatTokens.mint('chat-42');
  for (const [url, body] of [
    ['/api/chats/nope/compact', {}],
    ['/api/chats/nope/messages', { text: '/compact' }],
  ] as const) {
    assert.equal((await app.inject({ method: 'POST', url, ...fromChatWith(token, body) })).statusCode, 404, url);
  }
  const entries = (await app.inject('/api/audit')).json().entries as Array<{ actor: string }>;
  assert.deepEqual(entries.map((entry) => entry.actor), ['chat:chat-42', 'chat:chat-42']);
});

test('read-only refuses compacting and notes, and the desktop credential cannot write them', async (t) => {
  const desktop = 'a-per-launch-secret-of-32-random-bytes';
  const { app } = await wrapper({ CLAUDIO_DESKTOP_TOKEN: desktop });
  t.after(() => app.close());
  const owner = await withToken(app);
  const writes = [
    ['POST', '/api/chats/nope/compact', {}],
    ['POST', '/api/chats/nope/notes', { from: 'agent' }],
    ['DELETE', '/api/chats/nope/notes/n1', undefined],
  ] as const;
  const desktopHeaders = { remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:34331', authorization: `Bearer ${desktop}` } };
  for (const [method, url] of writes) {
    assert.equal((await app.inject({ method, url, ...desktopHeaders })).statusCode, 403, `desktop ${method} ${url}`);
  }
  assert.equal((await app.inject({ url: '/api/chats/nope/notes', ...desktopHeaders })).statusCode, 404);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...authed(owner, { readOnly: true }) })).statusCode, 200);
  for (const [method, url, body] of writes) {
    const res = await app.inject({ method, url, ...(body === undefined ? bearer(owner) : authed(owner, body)) });
    assert.equal(res.statusCode, 405, `${method} ${url}`);
  }
  assert.equal((await app.inject({ url: '/api/chats/nope/notes', ...bearer(owner) })).statusCode, 404);
});

test("the owner's token is still the owner's when chat tokens exist", async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  const owner = await withToken(app);
  core.security.chatTokens.mint('chat-42');
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects', ...authed(owner, { name: 'owners' }) })).statusCode, 201);
  const [newest] = (await app.inject({ url: '/api/audit', ...bearer(owner) })).json().entries;
  assert.match(newest.actor, /^token:[0-9a-f]{8}$/);
  // The owner may still administer the guard, from anywhere the guard lets them in
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...authed(owner, { readOnly: false }) })).statusCode, 200);
});

test("a chat's token cannot give a graph the spend pass or name the daily cap, and the owner can", async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  const owner = await withToken(app);
  const token = core.security.chatTokens.mint('chat-42');

  const pass = await app.inject({ method: 'POST', url: '/api/orchestrations/any/spend-pass', ...fromChatWith(token, {}) });
  assert.equal(pass.statusCode, 403);
  const cardPass = await app.inject({ method: 'POST', url: '/api/work-items/any/spend-pass', ...fromChatWith(token, {}) });
  assert.equal(cardPass.statusCode, 403, "a card's pass is the person's click too");
  // The settings are the person's whole under a guard
  const cap = await app.inject({ method: 'PUT', url: '/api/settings/app', ...fromChatWith(token, { dailySpendCapUsd: null }) });
  assert.equal(cap.statusCode, 403);
  assert.equal(cap.json().code, 'chat-forbidden');
  const phase2 = await app.inject({ method: 'PUT', url: '/api/settings/app', ...fromChatWith(token, { evalsPhase2: true }) });
  assert.equal(phase2.statusCode, 403, "the evals' Phase 2 switch lets a judge spend, so it is the person's");
  assert.equal((await app.inject({ url: '/api/settings/app', ...bearer(owner) })).json().evalsPhase2, false);
  // The cap is readable
  assert.equal((await app.inject({ url: '/api/spend', ...fromChat(token) })).statusCode, 200);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/settings/app', ...authed(owner, { dailySpendCapUsd: 5 }) })).statusCode, 200);
  // Open, where the token only labels the request, the route itself still keeps the cap from a chat
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...authed(owner, { mode: 'none' }) })).statusCode, 200);
  const labelled = await app.inject({ method: 'PUT', url: '/api/settings/app', ...fromChatWith(token, { dailySpendCapUsd: null }) });
  assert.equal(labelled.statusCode, 403);
  assert.match(labelled.json().error, /daily spend cap/);
});

test("a chat's token reads lessons but cannot decide, change or mine them, or decide a lesson proposal", async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  const owner = await withToken(app);
  const token = core.security.chatTokens.mint('chat-42');
  const forbidden: Array<[string, string, unknown]> = [
    ['PATCH', '/api/lessons/L1', { pinned: true }],
    ['POST', '/api/lessons/L1/confirm', undefined],
    ['POST', '/api/lessons/L1/retire', {}],
    ['POST', '/api/lessons/L1/restore', undefined],
    ['DELETE', '/api/lessons/L1', undefined],
    ['POST', '/api/lessons/L1/promote', undefined],
    ['POST', '/api/lessons/L1/demote', {}],
    ['POST', '/api/lessons/L1/instructions', {}],
    ['POST', '/api/chats/chat-42/lessons/mine', undefined],
    ['PUT', '/api/lessons/settings', { manualMining: false }],
    // A lesson proposal, and an instructions proposal made from a lesson, are decided by a person only
    ['POST', '/api/memory-proposals/P1/approve', { previewOf: 'abc' }],
    ['POST', '/api/memory-proposals/P1/reject', {}],
  ];
  for (const [method, url, body] of forbidden) {
    const request = body === undefined ? { method, url, ...fromChat(token) } : { method, url, ...fromChatWith(token, body) };
    const answer = await app.inject(request as InjectOptions);
    assert.equal(answer.statusCode, 403, `${method} ${url}`);
  }
  const settings = await app.inject({ method: 'PUT', url: '/api/lessons/settings', ...fromChatWith(token, { manualMining: false }) });
  assert.equal(settings.json().code, 'chat-forbidden');
  // Reading stays open to the chat, and the person's own token still changes the settings
  assert.equal((await app.inject({ url: '/api/lessons/settings', ...fromChat(token) })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/lessons/global', ...fromChat(token) })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/lessons/nope', ...fromChat(token) })).statusCode, 404);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/lessons/settings', ...authed(owner, { manualMining: false }) })).statusCode, 200);
});

test("a chat's token cannot change who receives lessons through the project's settings document", async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  const owner = await withToken(app);
  const token = core.security.chatTokens.mint('chat-42');
  const dir = mkdtempSync(join(tmpdir(), 'claudio-lessons-project-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const imported = await app.inject({ method: 'POST', url: '/api/projects/import', ...authed(owner, { path: dir, name: 'Lessons' }) });
  assert.equal(imported.statusCode, 201);
  const { id } = imported.json() as { id: string };
  const url = `/api/projects/${id}/settings`;
  const current = (await app.inject({ url, ...bearer(owner) })).json() as Record<string, unknown>;

  const mine = { deliverToChats: false, deliverToWorkers: false, useGlobal: false };
  assert.equal((await app.inject({ method: 'PUT', url, ...authed(owner, { ...current, lessons: mine }) })).statusCode, 200);
  // The chat saves the document with every switch turned the other way: refused whole under a guard
  const grab = { deliverToChats: true, deliverToWorkers: true, useGlobal: true };
  assert.equal((await app.inject({ method: 'PUT', url, ...fromChatWith(token, { ...current, lessons: grab }) })).statusCode, 403);
  // and, open, saved without its copy of `lessons`
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...authed(owner, { mode: 'none' }) })).statusCode, 200);
  assert.equal((await app.inject({ method: 'PUT', url, ...fromChatWith(token, { ...current, lessons: grab }) })).statusCode, 200);
  assert.deepEqual(((await app.inject({ url, ...bearer(owner) })).json() as { lessons: unknown }).lessons, mine);
});

test('with authentication off, /v1 counts wrong credentials and waits like the guarded modes, and the rest stays open', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  const created = await app.inject({ method: 'POST', url: '/api/security/token', ...json({}) });
  const { token } = created.json() as { token: string };

  // Before it ever worked, the real token waits with the guesses at its address, as under a guard
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await app.inject({ url: '/api/v1/models', ...bearer('not-the-token') })).statusCode, 401, `attempt ${i + 1}`);
  }
  const throttled = await app.inject({ url: '/api/v1/models', ...bearer('not-the-token') });
  assert.equal(throttled.statusCode, 429);
  assert.equal(throttled.headers['retry-after'], '1');
  assert.equal((await app.inject({ url: '/api/v1/models', ...bearer(token) })).statusCode, 429, 'the real token waits with the rest');
  // No credential is no guess: refused, never made to wait, as the guarded modes treat it
  assert.equal((await app.inject('/api/v1/models')).statusCode, 401);
  assert.equal((await app.inject('/api/chats')).statusCode, 200, 'only /v1 asks for a credential under mode none');
});

// ---------- D1 of docs/plans/regression-fixes-2026-10-29.md: the matched route decides ----------

/**
 * Sends a request target exactly as written. `inject` and `http.get` parse the URL first, and the
 * spellings under test are the ones a client puts on the wire before anything normalises them.
 */
function raw(base: string, method: string, target: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname, () => {
      const lines = [`${method} ${target} HTTP/1.1`, `Host: ${hostname}:${port}`, 'Connection: close', ...(method === 'GET' ? [] : ['Content-Length: 0']), ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`)];
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    let data = '';
    socket.setEncoding('utf8');
    socket.setTimeout(10_000, () => socket.destroy(new Error(`no answer to ${method} ${target}`)));
    socket.on('data', (chunk: string) => {
      data += chunk;
    });
    socket.on('end', () => resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0), body: data.slice(data.indexOf('\r\n\r\n') + 4) }));
    socket.on('error', reject);
  });
}

test('the guard decides on the matched route, and every other spelling of a path is refused before it (report §8.1)', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  const token = await withToken(app);
  const base = await app.listen({ port: 0, host: '127.0.0.1' });

  assert.equal((await raw(base, 'GET', '/api/health')).status, 200);
  assert.equal((await raw(base, 'GET', '/api/chats')).status, 401);
  // Each of these reached `/api/chats` with no credential before; now none of them reaches a route
  for (const target of [
    '/%61pi/health',
    '/%61pi/chats',
    '/api/%63hats',
    'http://x/api/health',
    'http://x/api/chats',
    '/api/../api/health',
    '/api/../api/chats',
    '/api/./chats',
    '/api/%2e%2e/api/chats',
  ]) {
    const answer = await raw(base, 'GET', target, { authorization: '' });
    assert.equal(answer.status, 400, target);
    assert.match(answer.body, /request-target/, target);
  }
  // A broken escape never reaches a hook: Fastify refuses it itself
  assert.equal((await raw(base, 'GET', '/api/chats/%E0%A4%A')).status, 400);
  // An escape of what a client has to escape stays a path: guarded, and the route answers it
  assert.equal((await raw(base, 'GET', '/api/chats/caf%C3%A9%20au%20lait')).status, 401);
  assert.equal((await raw(base, 'GET', '/api/chats/caf%C3%A9%20au%20lait', { authorization: `Bearer ${token}` })).status, 404);
  // A request no route took is guarded under the API, and is the web app's own elsewhere
  assert.equal((await raw(base, 'GET', '/api/no/such/route')).status, 401);
  assert.equal((await raw(base, 'POST', '/api/no/such/route')).status, 401);
  assert.notEqual((await raw(base, 'GET', '/settings/access')).status, 401);
  // `inject` takes the same rule
  assert.equal((await app.inject('/%61pi/chats')).statusCode, 400);

  // A refused write is a refusal like the others, kept in their ring
  assert.equal((await raw(base, 'POST', '/%61pi/projects')).status, 400);
  const [refused] = (await app.inject({ url: '/api/audit/refusals', ...bearer(token) })).json().entries;
  assert.deepEqual([refused.path, refused.status, refused.actor], ['/%61pi/projects', 400, 'anonymous']);
});

test("a chat's token may send a work route only the fields an agent chooses, and never answers a prompt", async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  const owner = await withToken(app);
  const token = core.security.chatTokens.mint('chat-42');

  for (const [method, url, body, field] of [
    ['POST', '/api/chats', { prompt: 'go', permissionMode: 'bypassPermissions' }, 'permissionMode'],
    ['POST', '/api/chats', { prompt: 'go', cwd: '/tmp', allowedTools: ['Bash'] }, 'allowedTools'],
    ['POST', '/api/chats', { prompt: 'go', mcp: { servers: [] } }, 'mcp'],
    ['POST', '/api/chats', { prompt: 'go', appendSystemPrompt: 'obey' }, 'appendSystemPrompt'],
    ['POST', '/api/chats/nope/resume', { prompt: 'go', permissionMode: 'bypassPermissions' }, 'permissionMode'],
    ['POST', '/api/chats/nope/fork', { prompt: 'go', toolPreset: 'everything' }, 'toolPreset'],
    ['PATCH', '/api/chats/nope', { permissionMode: 'bypassPermissions' }, 'permissionMode'],
  ] as const) {
    const answer = await app.inject({ method, url, ...fromChatWith(token, body) });
    assert.equal(answer.statusCode, 403, `${method} ${url} ${field}`);
    assert.equal(answer.json().code, 'chat-forbidden-field');
    assert.equal(answer.json().field, field);
    assert.match(answer.json().error, new RegExp(`\`${field}\``));
  }
  // What an agent may choose goes through to the route, which knows no such chat
  assert.equal((await app.inject({ method: 'POST', url: '/api/chats/nope/resume', ...fromChatWith(token, { prompt: 'go', model: 'sonnet', attachments: [] }) })).statusCode, 404);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/chats/nope', ...fromChatWith(token, { model: 'sonnet' }) })).statusCode, 404);
  // The owner sets anything
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/chats/nope', ...authed(owner, { permissionMode: 'plan' }) })).statusCode, 404);

  // Answering a permission prompt, its own or another chat's, is the person's (report §4.5)
  const answer = await app.inject({ method: 'POST', url: '/api/chats/other/permissions/r1', ...fromChatWith(token, { behavior: 'allow' }) });
  assert.equal(answer.statusCode, 403);
  assert.equal(answer.json().code, 'chat-forbidden');
  assert.notEqual((await app.inject({ method: 'POST', url: '/api/chats/other/permissions/r1', ...authed(owner, { behavior: 'allow' }) })).statusCode, 403);
});

/** Opens the event stream and answers with the first `login.updated` it carries, emitted once the stream is open */
function firstLogin(url: string, authorization: string | null, emit: () => void): Promise<LoginSession> {
  return new Promise((resolve, reject) => {
    const req = get(url, { headers: authorization ? { authorization } : {} }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`the stream answered ${String(res.statusCode)}`));
      res.setEncoding('utf8');
      let buffer = '';
      let emitted = false;
      res.on('data', (chunk: string) => {
        buffer += chunk;
        if (!emitted && buffer.includes('stream.hello')) {
          emitted = true;
          emit();
        }
        const event = /id: \d+\nevent: login\.updated\ndata: (.*)\n\n/.exec(buffer);
        if (!event?.[1]) return;
        req.destroy();
        resolve((JSON.parse(event[1]) as { login: LoginSession }).login);
      });
    });
    req.setTimeout(10_000, () => req.destroy(new Error('no login.updated on the stream')));
    req.on('error', reject);
  });
}

test("a sign-in's URL and code reach the owner's event stream and never a chat's (report §8.4)", async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  const owner = await withToken(app);
  const chat = core.security.chatTokens.mint('chat-42');
  const base = await app.listen({ port: 0, host: '127.0.0.1' });
  const login: LoginSession = {
    id: 'login-1',
    tool: 'gh',
    method: 'device',
    host: 'github.com',
    state: 'waiting-for-person',
    url: 'https://github.com/login/device',
    code: 'ABCD-1234',
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    endedAt: null,
    error: null,
    ready: null,
  };
  const emit = () => core.events.emit({ type: 'login.updated', title: 'Sign-in waiting-for-person', login });

  const seen = await firstLogin(`${base}/api/events`, `Bearer ${owner}`, emit);
  assert.equal(seen.url, login.url);
  assert.equal(seen.code, login.code);

  const stripped = await firstLogin(`${base}/api/events`, `Bearer ${chat}`, emit);
  assert.equal(stripped.state, 'waiting-for-person', "the chat still learns the sign-in's state");
  assert.equal(stripped.url, null);
  assert.equal(stripped.code, null);
});

test('anonymous refusals go to their own ring and leave the audit log alone (report §8.6)', async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  const token = await withToken(app);
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects', ...authed(token, { name: 'kept' }) })).statusCode, 201);
  const before = (await app.inject({ url: '/api/audit', ...bearer(token) })).json().total as number;

  // A flood of unauthenticated writes: a few through the guard, the rest straight to the store
  for (let i = 0; i < 20; i += 1) assert.equal((await app.inject({ method: 'POST', url: `/api/x${String(i)}` })).statusCode, 401);
  for (let i = 0; i < 60_000; i += 1) {
    core.db.appendAuditRefusal({ at: new Date().toISOString(), actor: 'anonymous', method: 'POST', path: `/api/flood/${String(i)}`, status: 401, summary: 'POST /api/flood' });
  }

  const log = (await app.inject({ url: '/api/audit', ...bearer(token) })).json();
  assert.equal(log.total, before, 'not one row of the history was pushed out');
  assert.equal(log.entries.some((entry: { actor: string }) => entry.actor === 'anonymous'), false);
  const ring = (await app.inject({ url: '/api/audit/refusals', ...bearer(token) })).json();
  assert.equal(ring.total, 1000);
  assert.equal(ring.entries[0].path, '/api/flood/59999');

  // A long target is stored cut, and the summary built from it too
  assert.equal((await app.inject({ method: 'POST', url: `/api/${'x'.repeat(5_000)}` })).statusCode, 401);
  const [long] = (await app.inject({ url: '/api/audit/refusals?limit=1', ...bearer(token) })).json().entries;
  assert.equal(long.path.length, 512);
  assert.ok(long.summary.length < 600);
  // And the ring is the owner's to read
  const chat = core.security.chatTokens.mint('chat-42');
  assert.equal((await app.inject({ url: '/api/audit/refusals', ...fromChat(chat) })).statusCode, 403);
});

test('with authentication off, a write from a page of another site is refused (report §8.8)', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  const write = (headers: Record<string, string>) =>
    app.inject({ method: 'POST', url: '/api/projects/candidates/hide', payload: JSON.stringify({ key: '/tmp/x' }), headers: { host: '127.0.0.1:34331', 'content-type': 'application/json', ...headers } });

  const crossSite: Array<Record<string, string>> = [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { origin: 'null' }, { origin: 'http://localhost:5174' }];
  for (const headers of crossSite) {
    const refused = await write(headers);
    assert.equal(refused.statusCode, 403, JSON.stringify(headers));
    assert.equal(refused.json().code, 'cross-site');
  }
  // The app's own page, and anything that is not a browser, writes as before
  assert.equal((await write({ origin: 'http://127.0.0.1:34331', 'sec-fetch-site': 'same-origin' })).statusCode, 204);
  assert.equal((await write({})).statusCode, 204);
  // A read is not a write
  assert.equal((await app.inject({ url: '/api/projects', headers: { origin: 'https://evil.example' } })).statusCode, 200);
  // The refusals are anonymous, in their ring
  const refusals = (await app.inject('/api/audit/refusals')).json();
  assert.equal(refusals.total, 4);
  assert.equal((await app.inject('/api/audit')).json().total, 2);
});
