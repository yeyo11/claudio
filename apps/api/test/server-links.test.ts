import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { FastifyInstance, FastifyRequest, InjectOptions } from 'fastify';
import { Core, loadConfig } from '@claudio/core';
import { API_VERSION, API_VERSION_MIN, type ServerLinkCode, type ServerLinkGrant, type ServerMeta } from '@claudio/shared';
import { buildApp } from '../src/app.ts';
import { fromLocalMachineStrict } from '../src/security.ts';
import { clientRefusal } from '../src/terminal-gate.ts';

// The remote side of Servers (docs/plans/claudio-servers.md, §4.1 and §9.2): what any Claudio
// answers to a hub, and what a hub's token may and may not do there.

const roots = new Set<string>();
const cores = new Set<Core>();
after(async () => {
  await Promise.all([...cores].map((core) => core.shutdown()));
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Wrapper {
  app: FastifyInstance;
  core: Core;
  root: string;
}

async function wrapper(env: NodeJS.ProcessEnv = {}, root = mkdtempSync(join(tmpdir(), 'claudio-server-links-'))): Promise<Wrapper> {
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
  cores.add(core);
  return { app: await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') }), core, root };
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
const bearer = (token: string, headers: Record<string, string> = {}) => ({ headers: { authorization: `Bearer ${token}`, ...headers } });
const authed = (token: string, body: unknown, headers: Record<string, string> = {}) => json(body, { authorization: `Bearer ${token}`, ...headers });

async function withToken(app: FastifyInstance): Promise<string> {
  const created = await app.inject({ method: 'POST', url: '/api/security/token', ...json({}) });
  assert.equal(created.statusCode, 200);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ mode: 'token' }) })).statusCode, 200);
  return created.json<{ token: string }>().token;
}

const HUB = { hubInstanceId: 'hub-instance-1', hubName: 'Desk' };

/** A hub paired through the owner's token, as the pasted URL + token way does */
async function paired(app: FastifyInstance, owner: string, hub = HUB): Promise<ServerLinkGrant> {
  const minted = await app.inject({ method: 'POST', url: '/api/server-links', ...authed(owner, hub) });
  assert.equal(minted.statusCode, 200, minted.body);
  return minted.json<ServerLinkGrant>();
}

async function newCode(app: FastifyInstance, owner: string): Promise<string> {
  const issued = await app.inject({ method: 'POST', url: '/api/server-links/code', ...bearer(owner) });
  assert.equal(issued.statusCode, 200, issued.body);
  return issued.json<ServerLinkCode>().code;
}

const redeem = (code: string, extra: Partial<InjectOptions> = {}): InjectOptions => ({ method: 'POST', url: '/api/server-links/redeem', ...json({ code, ...HUB }), ...extra });
const codeOf = (res: { json: () => unknown }): unknown => (res.json() as { code?: unknown }).code;

test('meta is open, on any host, and says only who the server is and what it speaks', async (t) => {
  const { app, core, root } = await wrapper();
  t.after(() => app.close());
  await withToken(app);

  const answer = await app.inject({ url: '/api/meta', headers: { host: 'some-other-name.example' } });
  assert.equal(answer.statusCode, 200);
  const meta = answer.json<ServerMeta>();
  assert.deepEqual(Object.keys(meta).sort(), ['apiVersion', 'capabilities', 'instanceId', 'version']);
  assert.deepEqual(meta.apiVersion, { current: API_VERSION, min: API_VERSION_MIN });
  assert.ok(meta.capabilities.includes('server-links'));
  assert.equal(typeof meta.version, 'string');
  assert.ok(meta.version.length > 0);
  assert.equal(meta.instanceId, core.identity.instanceId);
  const kept = JSON.parse(readFileSync(join(root, 'data', 'instance.json'), 'utf8')) as { instanceId: string };
  assert.equal(kept.instanceId, meta.instanceId);
});

test('the instance id survives a restart, and so do the hub tokens, kept only as hashes', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'claudio-server-links-'));
  const first = await wrapper({}, root);
  const owner = await withToken(first.app);
  const grant = await paired(first.app, owner);
  const id = first.core.identity.instanceId;
  assert.equal(grant.instanceId, id);
  assert.equal(grant.tlsFingerprint, null, 'no certificate on the LAN listener yet');
  const onDisk = readFileSync(join(root, 'data', 'auth.json'), 'utf8');
  assert.equal(onDisk.includes(grant.token), false);
  const stored = (JSON.parse(onDisk) as { serverTokens: Array<Record<string, unknown>> }).serverTokens;
  assert.equal(stored.length, 1);
  assert.deepEqual(Object.keys(stored[0] ?? {}).sort(), ['createdAt', 'hubInstanceId', 'id', 'lastUsedAt', 'name', 'tokenHash']);
  assert.equal(stored[0]?.name, 'Desk');
  assert.equal(stored[0]?.hubInstanceId, 'hub-instance-1');
  await first.app.close();
  await first.core.shutdown();

  const second = await wrapper({}, root);
  t.after(() => second.app.close());
  assert.equal(second.core.identity.instanceId, id);
  assert.equal((await second.app.inject({ url: '/api/overview', ...bearer(grant.token) })).statusCode, 200);
  const [info] = second.core.security.serverTokens;
  assert.equal(info?.id, grant.tokenId);
  assert.notEqual(info?.lastUsedAt, null, 'a use is written down');
});

test('a code pairs once: the hub gets a token that acts as the owner, and the code is spent', async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  const owner = await withToken(app);
  const code = await newCode(app, owner);

  const redeemed = await app.inject(redeem(code));
  assert.equal(redeemed.statusCode, 200, redeemed.body);
  const grant = redeemed.json<ServerLinkGrant>();
  assert.deepEqual(Object.keys(grant).sort(), ['instanceId', 'tlsFingerprint', 'token', 'tokenId']);
  assert.equal(grant.instanceId, core.identity.instanceId);

  const again = await app.inject(redeem(code));
  assert.equal(again.statusCode, 403);
  assert.equal(codeOf(again), 'server-links.code-invalid');

  // Full control: an owner-only write goes through, and the audit names the hub's token
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...authed(grant.token, { readOnly: false }) })).statusCode, 200);
  const entries = (await app.inject({ url: '/api/audit', ...bearer(owner) })).json<{ entries: Array<{ actor: string; path: string }> }>().entries;
  assert.equal(entries.find((entry) => entry.path === '/api/security/auth')?.actor, `server:${grant.tokenId}`);
  assert.equal(entries.find((entry) => entry.path === '/api/server-links/redeem')?.actor, `server:${grant.tokenId}`);
});

test('a new code replaces the unused one, and a hub cannot make codes or tokens of its own', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  const owner = await withToken(app);
  const first = await newCode(app, owner);
  const second = await newCode(app, owner);
  if (first !== second) assert.equal((await app.inject(redeem(first))).statusCode, 403);
  const grant = (await app.inject(redeem(second))).json<ServerLinkGrant>();

  const code = await app.inject({ method: 'POST', url: '/api/server-links/code', ...bearer(grant.token) });
  assert.equal(code.statusCode, 403);
  assert.equal(codeOf(code), 'server-links.not-owner');
  const minted = await app.inject({ method: 'POST', url: '/api/server-links', ...authed(grant.token, { hubInstanceId: 'hub-2', hubName: 'Chain' }) });
  assert.equal(minted.statusCode, 403);
  assert.equal(codeOf(minted), 'server-links.not-owner');
});

test('a bad request does not spend the code, and a server cannot pair with itself', async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  const owner = await withToken(app);
  const code = await newCode(app, owner);
  assert.equal((await app.inject({ method: 'POST', url: '/api/server-links/redeem', ...json({ code, hubInstanceId: 'hub-1' }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/server-links/redeem', ...json({ code, hubInstanceId: 'bad id/../x', hubName: 'Desk' }) })).statusCode, 400);
  const self = await app.inject({ method: 'POST', url: '/api/server-links/redeem', ...json({ code, hubInstanceId: core.identity.instanceId, hubName: 'Me' }) });
  assert.equal(self.statusCode, 400);
  assert.equal(codeOf(self), 'server-links.self');
  assert.equal((await app.inject(redeem(code))).statusCode, 200);
});

test('wrong codes count in the peer back-off, and the right code waits with them', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  const owner = await withToken(app);
  const code = await newCode(app, owner);
  const wrong = code === 'ZZZZZZZZ' ? 'YYYYYYYY' : 'ZZZZZZZZ';
  const fromA = { remoteAddress: '192.168.1.20', headers: { host: '192.168.1.5:8791', 'content-type': 'application/json' } };

  for (let i = 0; i < 10; i += 1) {
    const refused = await app.inject(redeem(wrong, fromA));
    assert.equal(refused.statusCode, 403, `attempt ${String(i + 1)}`);
  }
  const throttled = await app.inject(redeem(code, fromA));
  assert.equal(throttled.statusCode, 429);
  assert.equal(throttled.headers['retry-after'], '1');
  assert.equal(codeOf(throttled), 'server-links.too-many');

  // Another peer has its own allowance, and the code survived the first one's guesses
  const fromB = { remoteAddress: '192.168.1.21', headers: { host: '192.168.1.5:8791', 'content-type': 'application/json' } };
  assert.equal((await app.inject(redeem(code, fromB))).statusCode, 200);
});

test('a flood of wrong codes from many peers voids the live code', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  const owner = await withToken(app);
  const code = await newCode(app, owner);
  const wrong = code === 'ZZZZZZZZ' ? 'YYYYYYYY' : 'ZZZZZZZZ';
  for (let i = 0; i < 20; i += 1) {
    await app.inject(redeem(wrong, { remoteAddress: `10.0.0.${String(i + 1)}` }));
  }
  assert.equal((await app.inject(redeem(code, { remoteAddress: '10.0.1.1' }))).statusCode, 403);
});

test('with access open nothing pairs: this server cannot be a remote', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  for (const request of [redeem('ABCDEFGH'), { method: 'POST' as const, url: '/api/server-links/code' }, { method: 'POST' as const, url: '/api/server-links', ...json(HUB) }]) {
    const refused = await app.inject(request);
    assert.equal(refused.statusCode, 409, String(request.url));
    assert.equal(codeOf(refused), 'server-links.auth-required');
  }
  assert.equal((await app.inject('/api/meta')).statusCode, 200);
});

test('read-only refuses pairing, but a hub may still give its token back', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  const owner = await withToken(app);
  const grant = await paired(app, owner);
  const code = await newCode(app, owner);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...authed(owner, { readOnly: true }) })).statusCode, 200);
  assert.equal((await app.inject(redeem(code))).statusCode, 405);
  assert.equal((await app.inject({ method: 'POST', url: '/api/server-links', ...authed(owner, { hubInstanceId: 'hub-2', hubName: 'Other' }) })).statusCode, 405);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/server-links/self', ...bearer(grant.token) })).statusCode, 204);
});

test('a hub revokes its own token, which is 401 from then on; nothing else can call that route', async (t) => {
  const { app } = await wrapper({ CLAUDIO_ALLOWED_HOSTS: 'claudio.example' });
  t.after(() => app.close());
  const owner = await withToken(app);
  const grant = await paired(app, owner);
  const other = await paired(app, owner, { hubInstanceId: 'hub-2', hubName: 'Laptop' });

  const byOwner = await app.inject({ method: 'DELETE', url: '/api/server-links/self', ...bearer(owner) });
  assert.equal(byOwner.statusCode, 403);
  assert.equal(codeOf(byOwner), 'server-links.not-server');

  assert.equal((await app.inject({ method: 'DELETE', url: '/api/server-links/self', ...bearer(grant.token) })).statusCode, 204);
  const revoked = await app.inject({ url: '/api/overview', ...bearer(grant.token, { host: 'claudio.example' }) });
  assert.equal(revoked.statusCode, 401);
  // Only the caller's own token goes
  assert.equal((await app.inject({ url: '/api/overview', ...bearer(other.token) })).statusCode, 200);
});

test('a hub that pairs again replaces its earlier token', async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  const owner = await withToken(app);
  const old = await paired(app, owner);
  const fresh = await paired(app, owner);
  assert.equal((await app.inject({ url: '/api/overview', ...bearer(old.token) })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/overview', ...bearer(fresh.token) })).statusCode, 200);
  assert.equal(core.security.serverTokens.length, 1);
});

test("a hub's token is accepted on any host the listener serves; nothing else is (R10)", async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  const owner = await withToken(app);
  const grant = await paired(app, owner);
  const host = { host: 'claudio-b.home.example:8791' };

  assert.equal((await app.inject({ url: '/api/overview', ...bearer(grant.token, host) })).statusCode, 200);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...authed(grant.token, { readOnly: false }, host) })).statusCode, 200);
  // Unauthenticated, wrongly authenticated or the owner's own: refused as before
  assert.equal((await app.inject({ url: '/api/overview', headers: host })).statusCode, 421);
  assert.equal((await app.inject({ url: '/api/overview', ...bearer('not-a-token', host) })).statusCode, 421);
  assert.equal((await app.inject({ url: '/api/overview', ...bearer(owner, host) })).statusCode, 421);
});

test("under OIDC a hub's token is checked before the issuer is ever asked", async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  const owner = await withToken(app);
  const grant = await paired(app, owner);
  // 127.0.0.1:1 is a closed port: reaching the verifier with this token could only fail
  const configured = await app.inject({ method: 'PUT', url: '/api/security/auth', ...authed(owner, { oidc: { issuer: 'http://127.0.0.1:1', audience: 'claudio', clientId: 'ui' }, mode: 'oidc' }) });
  assert.equal(configured.statusCode, 200);
  assert.equal((await app.inject({ url: '/api/overview', ...bearer(grant.token) })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/overview', ...bearer('not.a.jwt') })).statusCode, 401);
});

/** A request shaped as far as the local checks read it */
const fakeRequest = (actor: string, host: string): FastifyRequest => ({ actor, headers: { host }, socket: { remoteAddress: '127.0.0.1', remotePort: 40_000, localPort: 8797 } }) as unknown as FastifyRequest;

test("a hub's token is never this machine, even through loopback (R9)", async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  const runtime = core.appSettings.runtimeHosts;
  assert.equal(fromLocalMachineStrict(fakeRequest('token:abc', '127.0.0.1:8797'), runtime), true);
  assert.equal(fromLocalMachineStrict(fakeRequest('server:abc', '127.0.0.1:8797'), runtime), false);
  assert.equal(fromLocalMachineStrict(fakeRequest('server:abc', 'localhost:8797'), runtime), false);
});

test("the terminal treats a hub as a remote peer, never local and never the tunnel (D10)", async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  await withToken(app);
  core.terminals.peer.check = () => 'not-agent';
  core.appSettings.runtimeHosts.add('node.tail.ts.net');
  assert.equal(core.terminals.settings().remote, 'tunnel');

  for (const host of ['127.0.0.1:8797', 'node.tail.ts.net']) {
    assert.equal(await clientRefusal(core, fakeRequest('token:abc', host), { actor: true }), null, `the owner on ${host}`);
    const refused = await clientRefusal(core, fakeRequest('server:abc', host), { actor: true });
    assert.equal(refused?.reason, 'needs-tunnel', `a hub on ${host}`);
  }
});
