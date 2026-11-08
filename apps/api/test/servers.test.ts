import assert from 'node:assert/strict';
import { promises as dns } from 'node:dns';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, type Duplex } from 'node:stream';
import { test, type TestContext } from 'node:test';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { WebSocket } from 'ws';
import { Core, SERVERS_FILE, SERVERS_VAULT_TOOL, ensureLanCertificate, loadConfig, type ServersLookup } from '@claudio/core';
import type {
  AuditPage,
  ClaudioServer,
  Project,
  RemoveServerResult,
  ServerFingerprintConfirmation,
  ServerLink,
  ServerLinkCode,
  ServerMeta,
  ServerTestResult,
  Terminal,
  TerminalServerFrame,
  TerminalTicket,
} from '@claudio/shared';
import { buildApp } from '../src/app.ts';
import { gatewayBodyLimit, gatewayPath, withoutToken } from '../src/routes/servers-gateway.ts';
import { UPLOAD_BODY_LIMIT } from '../src/routes/uploads.ts';
import { lanForwarders } from '../src/server.ts';

// The hub (docs/plans/claudio-servers.md, §4.2, §9.2, R1-R10): two whole Claudios in one process,
// the remote serving its LAN listener over TLS on loopback, the hub listening on a port of its own
// so streams and sockets go through it as a browser's would. Where a remote has to misbehave (a
// redirect, a page, another certificate) a small HTTPS server stands in for it, with a certificate
// made the way the LAN listener makes its own.

const json = (body: unknown, headers: Record<string, string> = {}) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
const bearer = (token: string, headers: Record<string, string> = {}) => ({ headers: { authorization: `Bearer ${token}`, ...headers } });
const authed = (token: string, body: unknown, headers: Record<string, string> = {}) => json(body, { authorization: `Bearer ${token}`, ...headers });
const codeOf = (res: { json: () => unknown }): unknown => (res.json() as { code?: unknown }).code;

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const scratch = (t: TestContext, prefix = 'claudio-servers-'): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

interface Claudio {
  app: FastifyInstance;
  core: Core;
  /** The owner's token */
  token: string;
  dataDir: string;
}

async function claudio(t: TestContext, env: NodeJS.ProcessEnv = {}, prepare?: (core: Core) => void): Promise<Claudio> {
  const root = mkdtempSync(join(tmpdir(), 'claudio-servers-'));
  const core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
      ...env,
    }),
  );
  // Under a guarded mode the terminal's peer check reads this process's ancestors, which may be a chat's
  core.terminals.peer.check = () => 'not-agent';
  prepare?.(core);
  const app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  await app.ready();
  t.after(async () => {
    await app.close();
    await core.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
  const created = await app.inject({ method: 'POST', url: '/api/security/token', ...json({}) });
  assert.equal(created.statusCode, 200);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ mode: 'token' }) })).statusCode, 200);
  return { app, core, token: created.json<{ token: string }>().token, dataDir: join(root, 'data') };
}

interface Remote extends Claudio {
  /** `https://127.0.0.1:<port>`: its LAN listener, TLS with its own kept certificate */
  base: string;
}

/** A whole Claudio reached the way a hub reaches one: its LAN listener, on loopback and port 0 */
async function remote(t: TestContext): Promise<Remote> {
  const w = await claudio(t, { CLAUDIO_LAN: 'on', CLAUDIO_LAN_PORT: '0' }, (core) => {
    core.lan.network.wildcard = '127.0.0.1';
    core.lan.network.interfaces = () => ({ lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }] });
    core.lan.network.localName = () => Promise.resolve(null);
  });
  const { request, upgrade } = lanForwarders(w.app);
  w.core.lan.attach(request, upgrade);
  await until(() => w.core.lan.status().state === 'listening', 'the LAN listener');
  return { ...w, base: `https://127.0.0.1:${String(w.core.lan.status().port)}` };
}

interface Hub extends Claudio {
  /** Where a browser would open it: `http://127.0.0.1:<port>` */
  url: string;
  port: number;
}

async function hub(t: TestContext, options: { enabled?: boolean } = {}): Promise<Hub> {
  const w = await claudio(t);
  await w.app.listen({ host: '127.0.0.1', port: 0 });
  const port = (w.app.server.address() as AddressInfo).port;
  // A test waits seconds, not the minutes a real network may need
  Object.assign(w.core.servers.timeouts, { connectMs: 2_000, probeMs: 2_000, pairMs: 5_000, checkMs: 4_000 });
  w.core.servers.network.timeoutMs = 2_000;
  if (options.enabled !== false) {
    const on = await w.app.inject({ method: 'PUT', url: '/api/servers/settings', ...authed(w.token, { enabled: true }) });
    assert.equal(on.statusCode, 200, on.body);
  }
  return { ...w, url: `http://127.0.0.1:${String(port)}`, port };
}

async function codeFrom(r: Claudio): Promise<string> {
  const issued = await r.app.inject({ method: 'POST', url: '/api/server-links/code', ...bearer(r.token) });
  assert.equal(issued.statusCode, 200, issued.body);
  return issued.json<ServerLinkCode>().code;
}

async function pairByCode(h: Hub, r: Remote, name = 'Studio'): Promise<ClaudioServer> {
  const added = await h.app.inject({ method: 'POST', url: '/api/servers', ...authed(h.token, { name, addresses: [{ url: r.base, kind: 'lan' }], pairing: { kind: 'code', code: await codeFrom(r) } }) });
  assert.equal(added.statusCode, 201, added.body);
  return added.json<ClaudioServer>();
}

/** A request through the hub's gateway, on the hub's own token */
const through = (h: Hub, id: string, method: InjectOptions['method'], path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> =>
  h.app.inject({ method, url: `/api/servers/${id}${path}`, ...(body === undefined ? bearer(h.token, headers) : authed(h.token, body, headers)) });

const serverToken = (h: Hub, id: string): string | undefined => h.core.vault.get(SERVERS_VAULT_TOOL)[id];

/** Everything a hub keeps in its data directory, read as text */
function dataText(dataDir: string): string {
  const read = (dir: string): string =>
    readdirSync(dir, { withFileTypes: true })
      .map((entry) => (entry.isDirectory() ? read(join(dir, entry.name)) : entry.name.endsWith('.json') ? readFileSync(join(dir, entry.name), 'utf8') : ''))
      .join('\n');
  return read(dataDir);
}

// ---- A stand-in remote

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}

interface Fake {
  base: string;
  port: number;
  /** Where its certificate is kept: a fake on the same `dir` shows the same one */
  dir: string;
  fingerprint: string;
  seen: Seen[];
  state: { instanceId: string; grantFingerprint: string | null; route: ((req: IncomingMessage, res: ServerResponse) => boolean) | null };
  close: () => Promise<void>;
}

const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

/**
 * An HTTPS server that answers as a Claudio as far as a hub asks one: its meta, a grant for the
 * pasted-token pairing, the revoke, and whatever `route` a test gives it. Its certificate is made in
 * `dir` as the LAN listener makes its own, so two fakes on one `dir` show the same one.
 */
async function fake(t: TestContext, options: { dir?: string; port?: number; ips?: string[]; instanceId?: string; upgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void } = {}): Promise<Fake> {
  const dir = options.dir ?? scratch(t, 'claudio-fake-');
  const { certificate } = await ensureLanCertificate(dir, { ips: options.ips ?? ['127.0.0.1'], dns: [] });
  const seen: Seen[] = [];
  const state: Fake['state'] = { instanceId: options.instanceId ?? 'fake-remote', grantFingerprint: certificate.fingerprint, route: null };
  const server: HttpsServer = createHttpsServer({ key: certificate.key, cert: certificate.cert }, (req, res) => {
    const url = req.url ?? '';
    seen.push({ method: req.method ?? '', url, headers: req.headers });
    req.resume();
    if (url === '/api/meta') return send(res, 200, { instanceId: state.instanceId, version: '9.9.9', apiVersion: { current: 1, min: 1 }, capabilities: ['server-links'] } satisfies ServerMeta);
    if (req.method === 'POST' && url === '/api/server-links') return send(res, 200, { token: 'fake-server-token', tokenId: 'fake-1', instanceId: state.instanceId, tlsFingerprint: state.grantFingerprint });
    if (req.method === 'DELETE' && url === '/api/server-links/self') {
      res.writeHead(204).end();
      return;
    }
    if (state.route?.(req, res)) return;
    send(res, 200, { ok: true });
  });
  // Only when asked: with no listener, Node answers an upgrade as a plain request, which the others rely on
  if (options.upgrade) server.on('upgrade', options.upgrade);
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  t.after(close);
  return { base: `https://127.0.0.1:${String(port)}`, port, dir, fingerprint: certificate.fingerprint, seen, state, close };
}

/**
 * The pasted-token way as a person goes through it (D13): the first call only reads the certificate
 * and asks for it to be confirmed, the second carries the fingerprint and pairs.
 */
async function pairByToken(h: Hub, addresses: Array<{ url: string; kind: string }>, token: string, extra: Record<string, unknown> = {}): Promise<ClaudioServer> {
  const body = { name: 'Fake', addresses, ...extra };
  const asked = await h.app.inject({ method: 'POST', url: '/api/servers', ...authed(h.token, { ...body, pairing: { kind: 'token', token } }) });
  assert.equal(asked.statusCode, 409, asked.body);
  const { code, fingerprint } = asked.json<ServerFingerprintConfirmation>();
  assert.equal(code, 'servers.confirm-fingerprint');
  const added = await h.app.inject({ method: 'POST', url: '/api/servers', ...authed(h.token, { ...body, pairing: { kind: 'token', token, expectedFingerprint: fingerprint } }) });
  assert.equal(added.statusCode, 201, added.body);
  return added.json<ClaudioServer>();
}

const pairWithFake = (h: Hub, addresses: Array<{ url: string; kind: string }>, name = 'Fake'): Promise<ClaudioServer> => pairByToken(h, addresses, 'the-remote-owner-token', { name });

/** An event stream opened on the hub as a browser's `EventSource` opens it: the hub's token in `?token=` */
function openStream(url: string, headers: Record<string, string> = {}): Promise<{ req: ClientRequest; res: IncomingMessage; text: () => string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers: { accept: 'text/event-stream', ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('error', () => undefined);
      resolve({ req, res, text: () => text });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---- The tests

test('the gateway path stays under /api/ however it is decoded, and the hub token leaves the query', () => {
  const id = '0123456789ab';
  const ok = (url: string) => gatewayPath(url, id);
  assert.deepEqual(ok(`/api/servers/${id}/api/chats?limit=5`), { path: '/api/chats', query: 'limit=5' });
  assert.deepEqual(ok(`/api/servers/${id}/api/uploads/a%20b/content`), { path: '/api/uploads/a%20b/content', query: '' });
  const refused = (url: string) => {
    const answer = gatewayPath(url, id);
    return 'code' in answer ? answer.code : null;
  };
  assert.equal(refused(`/api/servers/${id}/apix/chats`), 'servers.path-refused');
  assert.equal(refused(`/api/servers/other/api/chats`), 'servers.path-refused');
  assert.equal(refused(`/api/servers/${id}/api/chats%2f..%2f..%2fsecurity`), 'servers.path-refused', 'an encoded slash');
  assert.equal(refused(`/api/servers/${id}/api/chats%5c..`), 'servers.path-refused', 'an encoded backslash');
  assert.equal(refused(`/api/servers/${id}/api/x/%252e%252e/y`), 'servers.path-refused', 'a dot segment once decoded twice');
  assert.deepEqual(ok(`/api/servers/${id}/api/x%252e%252e/y`), { path: '/api/x%252e%252e/y', query: '' }, 'dots inside a name are a name');
  assert.equal(refused(`/api/servers/${id}/api/%252e%252e%252fsecurity`), 'servers.path-refused');
  assert.equal(refused(`/api/servers/${id}/api//chats`), 'servers.path-refused');
  assert.equal(refused(`/api/servers/${id}/api/chats/%E0%A4%A`), 'servers.path-refused', 'a malformed escape');
  assert.equal(refused(`/api/servers/${id}/api/servers`), 'servers.one-hop');
  assert.equal(refused(`/api/servers/${id}/api/Servers/abc/api/meta`), 'servers.one-hop');
  assert.equal(refused(`/api/servers/${id}/api/server-links/code`), 'servers.one-hop');
  assert.equal(refused(`/api/servers/${id}/api/%2573ervers`), 'servers.one-hop', 'one hop however it is spelled');

  assert.equal(withoutToken('since=4&token=abc&x=1'), '?since=4&x=1');
  assert.equal(withoutToken('%74oken=abc'), '', 'Fastify reads an encoded key as `token` too');
  assert.equal(withoutToken('token'), '');
  assert.equal(withoutToken(''), '');
  assert.equal(withoutToken('ticket=t'), '?ticket=t');
});

test('Servers are off by default: an empty list, no adding, the gateway is 404, and meta says it can be a hub', async (t) => {
  const h = await hub(t, { enabled: false });
  assert.deepEqual((await h.app.inject({ url: '/api/servers/settings', ...bearer(h.token) })).json(), { enabled: false });
  assert.deepEqual((await h.app.inject({ url: '/api/servers', ...bearer(h.token) })).json(), []);
  const add = await h.app.inject({ method: 'POST', url: '/api/servers', ...authed(h.token, { name: 'x', addresses: [{ url: 'https://192.168.0.2', kind: 'lan' }], pairing: { kind: 'code', code: 'ABCDEFGH' } }) });
  assert.equal(add.statusCode, 409);
  assert.equal(codeOf(add), 'servers.disabled');
  assert.equal((await through(h, '0123456789ab', 'GET', '/api/meta')).statusCode, 404);
  const meta = (await h.app.inject({ url: '/api/meta' })).json<ServerMeta>();
  assert.ok(meta.capabilities.includes('gateway'));
  assert.ok(meta.capabilities.includes('lan-tls'));
  const settings = await h.app.inject({ method: 'PUT', url: '/api/servers/settings', ...authed(h.token, { enabled: 'yes' }) });
  assert.equal(settings.statusCode, 400);
});

test('pairing by code pins the identity seen in the TLS handshake, and keeps the token in the vault only', async (t) => {
  const r = await remote(t);
  const h = await hub(t);
  // A wrong code is the remote's refusal, with the remote's own code, and costs nothing here
  const wrong = await h.app.inject({ method: 'POST', url: '/api/servers', ...authed(h.token, { name: 'Wrong', addresses: [{ url: r.base, kind: 'lan' }], pairing: { kind: 'code', code: 'ZZZZZZZZ' } }) });
  assert.equal(wrong.statusCode, 400, wrong.body);
  assert.equal(codeOf(wrong), 'server-links.code-invalid');
  const server = await pairByCode(h, r);
  assert.match(server.id, /^[a-f0-9]{12}$/);
  assert.equal(server.identity.instanceId, r.core.identity.instanceId);
  assert.equal(server.identity.tlsFingerprint, r.core.lan.tlsFingerprint());
  assert.equal(server.health?.status, 'connected');
  assert.equal(server.health?.address, r.base);

  const token = serverToken(h, server.id);
  assert.ok(token);
  assert.equal(readFileSync(join(h.dataDir, SERVERS_FILE), 'utf8').includes(token), false);
  assert.equal(JSON.stringify((await h.app.inject({ url: '/api/servers', ...bearer(h.token) })).json()).includes(token), false, 'never in an answer');
  const [link] = r.core.security.serverTokens;
  assert.equal(link?.hubInstanceId, h.core.identity.instanceId);

  // The same server twice would replace the remote's token for this hub and orphan the first entry
  const again = await h.app.inject({ method: 'POST', url: '/api/servers', ...authed(h.token, { name: 'Again', addresses: [{ url: r.base, kind: 'lan' }], pairing: { kind: 'code', code: await codeFrom(r) } }) });
  assert.equal(again.statusCode, 409);
  assert.equal(codeOf(again), 'servers.already-paired');
});

test('pairing by the owner token keeps the minted token, never the owner token', async (t) => {
  const r = await remote(t);
  const h = await hub(t);
  const fingerprint = r.core.lan.tlsFingerprint();
  assert.ok(fingerprint);
  const wrongToken = await h.app.inject({
    method: 'POST',
    url: '/api/servers',
    ...authed(h.token, { name: 'Bad', addresses: [{ url: r.base, kind: 'lan' }], pairing: { kind: 'token', token: 'not-the-owner-token', expectedFingerprint: fingerprint } }),
  });
  assert.equal(wrongToken.statusCode, 400, wrongToken.body);
  assert.equal(codeOf(wrongToken), 'servers.token-invalid');
  const server = await pairByToken(h, [{ url: r.base, kind: 'lan' }], r.token, { name: 'Headless', color: 'violet', monogram: 'HL' });
  assert.equal(server.identity.tlsFingerprint, fingerprint, 'the fingerprint confirmed is the one the LAN card shows');
  assert.equal(server.color, 'violet');
  assert.equal(server.monogram, 'HL');
  assert.equal(dataText(h.dataDir).includes(r.token), false, "the remote owner's token is nowhere in the hub's data");
  assert.notEqual(serverToken(h, server.id), r.token);
});

test('a pasted owner token leaves the hub only for the certificate the person confirmed (D13)', async (t) => {
  const h = await hub(t);
  const f = await fake(t);
  const add = (pairing: Record<string, unknown>, addresses = [{ url: f.base, kind: 'lan' }]) =>
    h.app.inject({ method: 'POST', url: '/api/servers', ...authed(h.token, { name: 'Studio', addresses, pairing: { kind: 'token', token: 'the-owner-token', ...pairing } }) });

  // No fingerprint: the hub only shook hands, and answers what it saw for the person to compare
  const asked = await add({});
  assert.equal(asked.statusCode, 409, asked.body);
  const confirmation = asked.json<ServerFingerprintConfirmation>();
  assert.equal(confirmation.code, 'servers.confirm-fingerprint');
  assert.equal(confirmation.fingerprint, f.fingerprint);
  assert.equal(confirmation.address, f.base);
  assert.deepEqual(f.seen, [], 'not a single request, so neither the token nor even a probe reached it');

  // Another certificate than the one typed: refused before anything is sent
  const other = await add({ expectedFingerprint: Array.from({ length: 32 }, () => 'AB').join(':') });
  assert.equal(other.statusCode, 409, other.body);
  assert.equal(codeOf(other), 'servers.fingerprint-unexpected');
  assert.equal(other.json<ServerFingerprintConfirmation>().fingerprint, f.fingerprint);
  assert.deepEqual(f.seen, []);
  const malformed = await add({ expectedFingerprint: 'not-a-fingerprint' });
  assert.equal(malformed.statusCode, 400);
  assert.equal(codeOf(malformed), 'servers.pairing-invalid');

  // An impostor on the address between the confirmation and the call that carries it gets nothing
  const port = f.port;
  await f.close();
  const impostor = await fake(t, { port });
  const swapped = await add({ expectedFingerprint: confirmation.fingerprint });
  assert.equal(codeOf(swapped), 'servers.fingerprint-unexpected', swapped.body);
  assert.deepEqual(impostor.seen, []);
  await impostor.close();

  // The fingerprint as a person copies it (lower case, no colons) pairs, and only then is the token sent
  const real = await fake(t, { dir: f.dir, port });
  const added = await add({ expectedFingerprint: confirmation.fingerprint.replace(/:/g, '').toLowerCase() });
  assert.equal(added.statusCode, 201, added.body);
  assert.equal(added.json<ClaudioServer>().identity.tlsFingerprint, f.fingerprint);
  const minted = real.seen.findIndex((each) => each.method === 'POST' && each.url === '/api/server-links');
  assert.ok(minted >= 0);
  assert.equal(real.seen[minted]?.headers.authorization, 'Bearer the-owner-token');
  assert.ok(real.seen.slice(0, minted).every((each) => each.headers.authorization === undefined), 'nothing before the pairing carried a credential');
});

test('over plain HTTP on loopback there is no certificate to confirm, and the token pairs at once', async (t) => {
  const r = await claudio(t);
  await r.app.listen({ host: '127.0.0.1', port: 0 });
  const port = (r.app.server.address() as AddressInfo).port;
  const h = await hub(t);
  const added = await h.app.inject({ method: 'POST', url: '/api/servers', ...authed(h.token, { name: 'Here', addresses: [{ url: `http://127.0.0.1:${String(port)}`, kind: 'other' }], pairing: { kind: 'token', token: r.token } }) });
  assert.equal(added.statusCode, 201, added.body);
  assert.equal(added.json<ClaudioServer>().identity.tlsFingerprint, null);
});

test('a certificate that is not the one the grant names is refused, and the token is given back', async (t) => {
  const h = await hub(t);
  const f = await fake(t);
  f.state.grantFingerprint = 'AB:CD:EF:01';
  const added = await h.app.inject({
    method: 'POST',
    url: '/api/servers',
    ...authed(h.token, { name: 'Impostor', addresses: [{ url: f.base, kind: 'lan' }], pairing: { kind: 'token', token: 'owner', expectedFingerprint: f.fingerprint } }),
  });
  assert.equal(added.statusCode, 502);
  assert.equal(codeOf(added), 'servers.fingerprint-mismatch');
  assert.ok(f.seen.some((each) => each.method === 'DELETE' && each.url === '/api/server-links/self' && each.headers.authorization === 'Bearer fake-server-token'));
  assert.deepEqual((await h.app.inject({ url: '/api/servers', ...bearer(h.token) })).json(), []);
});

test('link-local, metadata and loopback by a name are never dialled', async (t) => {
  const h = await hub(t);
  const f = await fake(t);
  const table: Record<string, string> = { 'metadata.test': '169.254.169.254', 'sneaky.test': '127.0.0.1' };
  const lookup: ServersLookup = (name) => (table[name] ? Promise.resolve([{ address: table[name] ?? '', family: 4 }]) : dns.lookup(name, { all: true }));
  h.core.servers.network.lookup = lookup;
  const attempt = async (url: string) =>
    h.app.inject({ method: 'POST', url: '/api/servers', ...authed(h.token, { name: 'X', addresses: [{ url, kind: 'other' }], pairing: { kind: 'token', token: 'owner', expectedFingerprint: f.fingerprint } }) });
  for (const url of ['https://169.254.169.254', 'https://[fe80::1]:8791', `https://metadata.test:${String(f.port)}`, `https://sneaky.test:${String(f.port)}`]) {
    const answer = await attempt(url);
    assert.equal(answer.statusCode, 400, `${url}: ${answer.body}`);
    assert.equal(codeOf(answer), 'servers.address-refused', url);
  }
  assert.equal(codeOf(await attempt('http://192.168.0.29:8791')), 'servers.address-insecure');
  assert.equal(f.seen.length, 0, 'nothing reached the port behind the refused names');
  // The same port is reached when the address was recorded as loopback
  assert.equal((await attempt(`https://localhost:${String(f.port)}`)).statusCode, 201);
});

test("the hub's credentials never reach the remote, and what the remote answers cannot act on the hub's origin", async (t) => {
  const h = await hub(t);
  const f = await fake(t);
  f.state.route = (req, res) => {
    if (!req.url?.startsWith('/api/page')) return false;
    send(res, 200, '<script>alert(1)</script>', { 'content-type': 'text/html', 'set-cookie': 'claudio=stolen', 'access-control-allow-origin': '*', 'strict-transport-security': 'max-age=1', 'x-total-count': '3', 'clear-site-data': '"storage"' });
    return true;
  };
  const server = await pairWithFake(h, [{ url: f.base, kind: 'lan' }]);
  f.seen.length = 0;

  const answer = await through(h, server.id, 'GET', `/api/echo?since=5&token=${h.token}&x=1`, undefined, {
    cookie: 'claudio=1',
    'x-forwarded-for': '10.0.0.9',
    'x-forwarded-host': 'evil.example',
    'x-forwarded-proto': 'https',
    forwarded: 'for=10.0.0.9',
    'x-real-ip': '10.0.0.9',
    'sec-fetch-site': 'same-origin',
    'last-event-id': '7',
    'x-claudio-spend-override': '1',
    origin: h.url,
  });
  assert.equal(answer.statusCode, 200, answer.body);
  const [got] = f.seen;
  assert.ok(got);
  assert.equal(got.url, '/api/echo?since=5&x=1', '`?token=` is taken off, every other parameter kept');
  assert.equal(got.headers.authorization, 'Bearer fake-server-token');
  assert.equal(got.headers.host, `127.0.0.1:${String(f.port)}`);
  assert.equal(got.headers.origin, f.base, "the remote's own origin");
  assert.equal(got.headers['last-event-id'], '7');
  assert.equal(got.headers['x-claudio-spend-override'], '1');
  for (const name of ['cookie', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'sec-fetch-site']) assert.equal(got.headers[name], undefined, name);
  assert.equal(JSON.stringify(f.seen).includes(h.token), false, "the hub's token reached the remote");

  const page = await through(h, server.id, 'GET', '/api/page');
  assert.equal(page.statusCode, 200);
  assert.equal(page.headers['content-type'], 'application/octet-stream');
  assert.equal(page.headers['content-disposition'], 'attachment');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['x-total-count'], '3');
  for (const name of ['set-cookie', 'access-control-allow-origin', 'strict-transport-security', 'clear-site-data']) assert.equal(page.headers[name], undefined, name);

  // `?token=` stands for the hub's token only on the paths a browser cannot send a header to
  const queryOnly = (path: string) => h.app.inject({ url: `/api/servers/${server.id}${path}${path.includes('?') ? '&' : '?'}token=${h.token}` });
  assert.equal((await queryOnly('/api/echo')).statusCode, 401);
  assert.equal((await queryOnly('/api/events')).statusCode, 200);
  assert.equal((await queryOnly('/api/chats/c1/stream')).statusCode, 200);
});

test('a redirect from the remote is never followed, and never handed to the browser', async (t) => {
  const h = await hub(t);
  const f = await fake(t);
  f.state.route = (req, res) => {
    if (req.url !== '/api/go') return false;
    res.writeHead(307, { location: '/api/security/token' }).end();
    return true;
  };
  const server = await pairWithFake(h, [{ url: f.base, kind: 'lan' }]);
  f.seen.length = 0;
  const answer = await through(h, server.id, 'POST', '/api/go', { a: 1 });
  assert.equal(answer.statusCode, 502);
  assert.equal(codeOf(answer), 'servers.redirect-refused');
  assert.equal(answer.headers.location, undefined);
  assert.deepEqual(
    f.seen.map((each) => each.url),
    ['/api/go'],
  );
});

test('paths that leave /api/ or reach the remote’s own servers are refused before anything is sent', async (t) => {
  const h = await hub(t);
  const f = await fake(t);
  const server = await pairWithFake(h, [{ url: f.base, kind: 'lan' }]);
  f.seen.length = 0;
  // Sent as written, on the socket: an injected request is normalised before it reaches the server
  const raw = (path: string, method = 'GET'): Promise<number> =>
    new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: h.port, path, method, headers: { authorization: `Bearer ${h.token}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
  const prefix = `/api/servers/${server.id}`;
  const answers = await Promise.all([
    raw(`${prefix}/api/%2e%2e/%2e%2e/api/security/token`),
    raw(`${prefix}/api/../../security/token`),
    raw(`${prefix}/api/chats%2f..%2f..%2fsecurity`),
    raw(`${prefix}/api/x/%252e%252e/%252e%252e/security/token`),
    raw(`${prefix}/%61pi/chats`),
    raw(`${prefix}/api/servers/abc/api/meta`),
    raw(`${prefix}/api/server-links/code`, 'POST'),
  ]);
  assert.deepEqual(answers, [400, 400, 400, 400, 400, 403, 403]);
  assert.equal(f.seen.length, 0);
  // A chat's token is not the person's
  const chat = h.core.security.chatTokens.mint('chat-1');
  assert.equal((await h.app.inject({ url: `/api/servers/${server.id}/api/meta`, ...bearer(chat) })).statusCode, 403);
  assert.equal(f.seen.length, 0);
});

test("a write through the gateway lands on the remote, as the hub's server actor, and not on the hub", async (t) => {
  const r = await remote(t);
  const h = await hub(t);
  const server = await pairByCode(h, r);
  const created = await through(h, server.id, 'POST', '/api/projects', { name: 'remote-only', template: 'software' });
  assert.ok(created.statusCode < 300, created.body);
  const onRemote = (await r.app.inject({ url: '/api/projects', ...bearer(r.token) })).json<Project[]>();
  const onHub = (await h.app.inject({ url: '/api/projects', ...bearer(h.token) })).json<Project[]>();
  assert.ok(onRemote.some((each) => each.name === 'remote-only'));
  assert.equal(
    onHub.some((each) => each.name === 'remote-only'),
    false,
  );
  // Read back through the gateway too
  const listed = (await through(h, server.id, 'GET', '/api/projects')).json<Project[]>();
  assert.ok(listed.some((each) => each.name === 'remote-only'));
  // A body is streamed through as it arrives: twice the hub's own 1 MiB limit, and the remote's limit applies
  const file = Buffer.alloc(2 * 1024 * 1024, 7);
  const uploaded = await h.app.inject({ method: 'POST', url: `/api/servers/${server.id}/api/uploads?name=big.bin`, payload: file, headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/octet-stream' } });
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  const { id: uploadId } = uploaded.json<{ id: string }>();
  const content = await r.app.inject({ url: `/api/uploads/${uploadId}/content`, ...bearer(r.token) });
  assert.equal(content.rawPayload.length, file.length, 'the whole file landed on the remote');
  const remoteAudit = (await r.app.inject({ url: '/api/audit?path=/api/projects', ...bearer(r.token) })).json<AuditPage>();
  assert.ok(remoteAudit.entries.some((row) => row.method === 'POST' && row.actor.startsWith('server:')), JSON.stringify(remoteAudit));
  const hubAudit = (await h.app.inject({ url: '/api/audit?path=/api/projects', ...bearer(h.token) })).json<AuditPage>();
  assert.ok(hubAudit.entries.some((row) => row.route === 'POST /servers/:id/api/*'), JSON.stringify(hubAudit));
});

test('a body larger than the API takes as an upload of its own is refused with 413, streamed and never held (D16)', async (t) => {
  // The cap is the larger of the file and workspace-archive limits; the archive one lowered here, so 52 MiB is streamed, not 101
  const h = await hub(t);
  assert.equal(gatewayBodyLimit(h.core), Math.max(UPLOAD_BODY_LIMIT, h.core.workspaces.settings.maxCompressedBytes));
  Object.assign(h.core.workspaces.settings, { maxCompressedBytes: 1024 * 1024 });
  assert.equal(gatewayBodyLimit(h.core), UPLOAD_BODY_LIMIT);
  const f = await fake(t);
  // What the remote got of each upload, and whether that body ended or was cut
  const uploads: Array<{ received: number; ended: boolean; closed: boolean }> = [];
  f.state.route = (req, res) => {
    if (!req.url?.startsWith('/api/uploads')) return false;
    const upload = { received: 0, ended: false, closed: false };
    uploads.push(upload);
    req.on('data', (chunk: Buffer) => (upload.received += chunk.length));
    req.on('end', () => {
      upload.ended = true;
      send(res, 201, { id: 'up-1' });
    });
    req.on('close', () => (upload.closed = true));
    return true;
  };
  const server = await pairWithFake(h, [{ url: f.base, kind: 'lan' }]);
  const url = `/api/servers/${server.id}/api/uploads?name=big.bin`;
  const headers = { authorization: `Bearer ${h.token}`, 'content-type': 'application/octet-stream' };

  // A declared length over the cap: refused before the remote is dialled
  const before = f.seen.length;
  const declared = await h.app.inject({ method: 'POST', url, payload: 'x', headers: { ...headers, 'content-length': String(UPLOAD_BODY_LIMIT + 1) } });
  assert.equal(declared.statusCode, 413, declared.body);
  assert.equal(codeOf(declared), 'servers.body-too-large');
  assert.equal(f.seen.length, before, 'the remote was not asked');

  // No declared length: the body streams to the remote and is cut where it passes the cap
  const MiB = 1024 * 1024;
  // Well past the cap, so a hub that read the whole body would be seen pulling all of it
  const chunks = UPLOAD_BODY_LIMIT / MiB + 32;
  let pulled = 0;
  const body = Readable.from(
    (function* () {
      for (; pulled < chunks; pulled += 1) yield Buffer.alloc(MiB, 1);
    })(),
  );
  const streamed = await h.app.inject({ method: 'POST', url, payload: body, headers: { ...headers, 'transfer-encoding': 'chunked' } });
  assert.equal(streamed.statusCode, 413, streamed.body);
  assert.equal(codeOf(streamed), 'servers.body-too-large');
  await until(() => uploads[0]?.closed === true, "the remote's request ending");
  const cut = uploads[0];
  assert.ok(cut && cut.received <= UPLOAD_BODY_LIMIT, `the remote got ${String(cut?.received)} bytes, more than the cap`);
  assert.equal(cut.ended, false, 'the remote never saw a whole body');
  assert.ok(pulled < chunks, 'the hub stopped reading the body once it passed the cap');
  const listed = (await h.app.inject({ url: '/api/servers', ...bearer(h.token) })).json<ClaudioServer[]>();
  assert.equal(listed.find((each) => each.id === server.id)?.health?.reason, undefined, "the remote's health is not blamed for the browser's body");

  // A body under the cap goes through whole
  const whole = await h.app.inject({ method: 'POST', url, payload: Buffer.alloc(2 * MiB, 2), headers });
  assert.equal(whole.statusCode, 201, whole.body);
  assert.deepEqual(uploads.slice(1).map((each) => [each.received, each.ended]), [[2 * MiB, true]]);
});

test('a WebSocket upgrade through the gateway passes on what the browser sent with its head, read from the server’s own upgrade event (D16)', async (t) => {
  const h = await hub(t);
  const fromBrowser: Buffer[] = [];
  const f = await fake(t, {
    upgrade: (req, socket, head) => {
      if (!req.url?.startsWith('/api/terminals/t1/socket')) {
        socket.destroy();
        return;
      }
      if (head.length) fromBrowser.push(head);
      socket.on('data', (chunk: Buffer) => fromBrowser.push(chunk));
      socket.on('error', () => undefined);
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: fake-accept\r\n\r\nFROM-REMOTE');
    },
  });
  f.state.route = (req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/terminals/t1/ticket') return false;
    send(res, 200, { ticket: 'tkt-1', expiresAt: new Date(Date.now() + 30_000).toISOString() });
    return true;
  };
  const server = await pairWithFake(h, [{ url: f.base, kind: 'lan' }]);
  const minted = await through(h, server.id, 'POST', '/api/terminals/t1/ticket', {}, { origin: h.url });
  assert.equal(minted.statusCode, 200, minted.body);

  // The head and the first frame in one write, as a client that does not wait for the 101 sends them
  const socket = connect(h.port, '127.0.0.1');
  t.after(() => socket.destroy());
  let toBrowser = '';
  socket.on('data', (chunk: Buffer) => (toBrowser += chunk.toString('latin1')));
  socket.on('error', () => undefined);
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  socket.write(
    [
      `GET /api/servers/${server.id}/api/terminals/t1/socket?ticket=tkt-1 HTTP/1.1`,
      `Host: 127.0.0.1:${String(h.port)}`,
      `Origin: ${h.url}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      '',
      'EARLY-BYTES',
    ].join('\r\n'),
  );
  await until(() => toBrowser.includes('FROM-REMOTE'), 'the remote’s 101 and its first bytes');
  assert.match(toBrowser, /^HTTP\/1\.1 101 /);
  assert.match(toBrowser, /sec-websocket-accept: fake-accept/i);
  await until(() => Buffer.concat(fromBrowser).toString('latin1').includes('EARLY-BYTES'), 'the bytes sent with the head reaching the remote');
  socket.write('LATER-BYTES');
  await until(() => Buffer.concat(fromBrowser).toString('latin1') === 'EARLY-BYTESLATER-BYTES', 'the later bytes, after the early ones and once');
});

test('a token the remote revoked shows as needs-pairing, never as the hub’s own sign-in lapsing', async (t) => {
  const r = await remote(t);
  const h = await hub(t);
  const server = await pairByCode(h, r);
  const token = serverToken(h, server.id);
  assert.ok(token);
  assert.notEqual(await r.core.security.revokeServerCredential(token), null);
  const answer = await through(h, server.id, 'GET', '/api/projects');
  assert.equal(answer.statusCode, 409);
  assert.equal(codeOf(answer), 'servers.needs-pairing');
  const listed = (await h.app.inject({ url: '/api/servers', ...bearer(h.token) })).json<ClaudioServer[]>();
  assert.equal(listed[0]?.health?.status, 'needs-pairing');
  const tested = (await h.app.inject({ method: 'POST', url: `/api/servers/${server.id}/test`, ...bearer(h.token) })).json<ServerTestResult>();
  assert.equal(tested.meta.ok, true);
  assert.equal(tested.rest.code, 'servers.needs-pairing');
  assert.equal((await h.app.inject({ method: 'POST', url: `/api/servers/${server.id}/use`, ...bearer(h.token) })).json<ClaudioServer>().health?.status, 'needs-pairing');
});

test("the remote's owner cuts a hub off: its token is 401 there, and the hub shows the server as needing pairing (D14)", async (t) => {
  const r = await remote(t);
  const h = await hub(t);
  const server = await pairByCode(h, r);
  const token = serverToken(h, server.id);
  assert.ok(token);
  assert.equal((await through(h, server.id, 'GET', '/api/projects')).statusCode, 200);

  const links = await r.app.inject({ url: '/api/server-links', ...bearer(r.token) });
  assert.equal(links.statusCode, 200, links.body);
  const link = links.json<ServerLink[]>().find((each) => each.hubInstanceId === h.core.identity.instanceId);
  assert.ok(link);
  assert.equal(links.body.includes(token), false);
  assert.equal((await r.app.inject({ method: 'DELETE', url: `/api/server-links/${link.tokenId}`, ...bearer(r.token) })).statusCode, 204);

  assert.equal((await r.app.inject({ url: '/api/security/auth', ...bearer(token) })).statusCode, 401, 'the remote no longer takes the token');
  const answer = await through(h, server.id, 'GET', '/api/projects');
  assert.equal(answer.statusCode, 409);
  assert.equal(codeOf(answer), 'servers.needs-pairing');
  assert.equal((await h.app.inject({ url: '/api/servers', ...bearer(h.token) })).json<ClaudioServer[]>()[0]?.health?.status, 'needs-pairing');
});

test('a server whose identity changed is not reached, a renewed certificate on the same key is', async (t) => {
  const h = await hub(t);
  const dir = scratch(t, 'claudio-fake-');
  const first = await fake(t, { dir });
  const server = await pairWithFake(h, [{ url: first.base, kind: 'lan' }]);
  assert.equal((await through(h, server.id, 'GET', '/api/x')).statusCode, 200);

  // The remote gained an address: a new certificate on the same key, which the pinned key still knows
  await first.close();
  const renewed = await ensureLanCertificate(dir, { ips: ['127.0.0.1', '10.9.9.9'], dns: [] });
  assert.equal(renewed.generated, true);
  const second = await fake(t, { dir, port: first.port });
  assert.notEqual(second.fingerprint, first.fingerprint);
  const afterRenewal = await through(h, server.id, 'GET', '/api/x');
  assert.equal(afterRenewal.statusCode, 200, afterRenewal.body);
  await until(async () => (await h.app.inject({ url: '/api/servers', ...bearer(h.token) })).json<ClaudioServer[]>()[0]?.identity.tlsFingerprint === second.fingerprint, 'the renewed fingerprint pinned');

  // Another machine on the address: another key, refused before a byte of the request is written
  await second.close();
  const other = await fake(t, { port: first.port });
  const blocked = await through(h, server.id, 'GET', '/api/x');
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(codeOf(blocked), 'servers.identity-changed');
  assert.equal(other.seen.length, 0, 'the impostor never saw a request');
  assert.equal((await h.app.inject({ url: '/api/servers', ...bearer(h.token) })).json<ClaudioServer[]>()[0]?.health?.status, 'identity-changed');

  // The same certificate answering as another Claudio is refused by its meta
  await other.close();
  const reinstalled = await fake(t, { dir, port: first.port, instanceId: 'someone-else' });
  const used = (await h.app.inject({ method: 'POST', url: `/api/servers/${server.id}/use`, ...bearer(h.token) })).json<ClaudioServer>();
  assert.equal(used.health?.status, 'identity-changed');
  assert.equal(codeOf(await through(h, server.id, 'GET', '/api/x')), 'servers.identity-changed');
  assert.equal(
    reinstalled.seen.some((each) => each.url !== '/api/meta'),
    false,
    'only its meta was asked',
  );
});

test('the address in use moves only after failures in a row, and stays where it moved', async (t) => {
  const h = await hub(t);
  const dir = scratch(t, 'claudio-fake-');
  const a = await fake(t, { dir });
  const b = await fake(t, { dir });
  const server = await pairWithFake(h, [
    { url: a.base, kind: 'lan' },
    { url: b.base, kind: 'tailscale' },
  ]);
  assert.equal(server.health?.address, a.base);
  await a.close();
  const first = await through(h, server.id, 'GET', '/api/x');
  assert.equal(first.statusCode, 502);
  assert.equal((await h.app.inject({ url: '/api/servers', ...bearer(h.token) })).json<ClaudioServer[]>()[0]?.health?.status, 'reconnecting');
  assert.equal((await through(h, server.id, 'GET', '/api/x')).statusCode, 502, 'a second failure before moving');
  b.seen.length = 0;
  assert.equal((await through(h, server.id, 'GET', '/api/x')).statusCode, 200, 'the next request found the second address');
  assert.ok(b.seen.some((each) => each.url === '/api/x'));
  // The first address comes back; streams stay where they are
  const back = await fake(t, { dir, port: a.port });
  assert.equal((await through(h, server.id, 'GET', '/api/y')).statusCode, 200);
  assert.equal(back.seen.length, 0);
  assert.ok(b.seen.some((each) => each.url === '/api/y'));
});

test('an event stream goes through as it is written, and the remote stops serving it when the browser leaves', async (t) => {
  const r = await remote(t);
  const h = await hub(t);
  const server = await pairByCode(h, r);
  const before = r.core.events.subscribers;
  const stream = await openStream(`${h.url}/api/servers/${server.id}/api/events?token=${encodeURIComponent(h.token)}`, { origin: h.url });
  assert.equal(stream.res.statusCode, 200);
  assert.match(stream.res.headers['content-type'] ?? '', /text\/event-stream/);
  assert.equal(stream.res.headers['content-encoding'], undefined, 'nothing compressed on the hop');
  await until(() => stream.text().includes('stream.hello'), 'the remote greeting');
  assert.equal(r.core.events.subscribers, before + 1);
  stream.req.destroy();
  await until(() => r.core.events.subscribers === before, "the remote's stream ending with the browser's");
});

test('turning Servers off closes the gateway and its streams and keeps the list', async (t) => {
  const r = await remote(t);
  const h = await hub(t);
  const server = await pairByCode(h, r);
  const before = r.core.events.subscribers;
  const stream = await openStream(`${h.url}/api/servers/${server.id}/api/events?token=${encodeURIComponent(h.token)}`);
  await until(() => stream.text().includes('stream.hello'), 'the remote greeting');
  const ended = new Promise<void>((resolve) => {
    stream.res.once('close', resolve);
  });
  assert.equal((await h.app.inject({ method: 'PUT', url: '/api/servers/settings', ...authed(h.token, { enabled: false }) })).statusCode, 200);
  await ended;
  await until(() => r.core.events.subscribers === before, 'the remote stream closed');
  assert.equal((await through(h, server.id, 'GET', '/api/meta')).statusCode, 404);
  assert.deepEqual((await h.app.inject({ url: '/api/servers', ...bearer(h.token) })).json(), []);
  assert.ok(readFileSync(join(h.dataDir, SERVERS_FILE), 'utf8').includes(server.id), 'the list is kept');
  assert.ok(serverToken(h, server.id), 'and the token');
  await h.app.inject({ method: 'PUT', url: '/api/servers/settings', ...authed(h.token, { enabled: true }) });
  assert.equal((await through(h, server.id, 'GET', '/api/meta')).statusCode, 200);
});

test('the terminal socket goes through on a ticket the hub saw minted, and the remote’s own rule decides', async (t) => {
  const r = await remote(t);
  const h = await hub(t);
  const server = await pairByCode(h, r);
  const project = (await r.app.inject({ method: 'POST', url: '/api/projects', ...authed(r.token, { name: 'remote-shell', template: 'software' }) })).json<Project>();

  // Test connection: the upgrade reaches the remote's socket route, which says the terminal is off
  const tested = (await h.app.inject({ method: 'POST', url: `/api/servers/${server.id}/test`, ...bearer(h.token) })).json<ServerTestResult>();
  assert.equal(tested.address, r.base);
  assert.deepEqual([tested.meta.ok, tested.rest.ok, tested.events.ok, tested.socket.ok], [true, true, true, true], JSON.stringify(tested));
  assert.match(tested.socket.code ?? '', /^terminal\./);

  // D10: a hub is a remote peer, so the remote's default keeps its terminal closed to it
  await r.core.terminals.updateSettings({ enabled: true });
  const closed = await through(h, server.id, 'POST', '/api/terminals', { projectId: project.id });
  assert.equal(closed.statusCode, 403, closed.body);
  assert.match(String(codeOf(closed)), /^terminal\./);

  await r.core.terminals.updateSettings({ remote: 'any' });
  const opened = await through(h, server.id, 'POST', '/api/terminals', { projectId: project.id });
  if (opened.statusCode === 409 && /pty-missing|not available/.test(opened.body)) {
    t.diagnostic('node-pty cannot load here: the 101 half is skipped');
    return;
  }
  assert.equal(opened.statusCode, 201, opened.body);
  const terminal = opened.json<Terminal>();
  const socketUrl = (ticket: string) => `ws://127.0.0.1:${String(h.port)}/api/servers/${server.id}/api/terminals/${terminal.id}/socket?ticket=${ticket}`;
  const outcome = (socket: WebSocket): Promise<number> =>
    new Promise((resolve) => {
      socket.once('open', () => resolve(101));
      socket.once('unexpected-response', (_req, res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      socket.once('error', () => resolve(0));
    });

  // A ticket the hub never relayed opens nothing, and the remote is not asked
  const stranger = new WebSocket(socketUrl('made-up'), { origin: h.url });
  t.after(() => stranger.terminate());
  assert.equal(await outcome(stranger), 401);

  const minted = await through(h, server.id, 'POST', `/api/terminals/${terminal.id}/ticket`, {}, { origin: h.url });
  assert.equal(minted.statusCode, 200, minted.body);
  const { ticket } = minted.json<TerminalTicket>();
  // A socket from another page is refused
  const elsewhere = new WebSocket(socketUrl(ticket), { origin: 'http://evil.example' });
  t.after(() => elsewhere.terminate());
  assert.equal(await outcome(elsewhere), 403);

  const again = (await through(h, server.id, 'POST', `/api/terminals/${terminal.id}/ticket`, {}, { origin: h.url })).json<TerminalTicket>();
  const socket = new WebSocket(socketUrl(again.ticket), { origin: h.url });
  t.after(() => socket.terminate());
  const frames: TerminalServerFrame[] = [];
  socket.on('message', (data, binary) => {
    if (!binary) frames.push(JSON.parse((data as Buffer).toString('utf8')) as TerminalServerFrame);
  });
  assert.equal(await outcome(socket), 101);
  await until(() => frames.some((frame) => frame.type === 'hello'), 'the remote terminal greeting');
  const reused = new WebSocket(socketUrl(again.ticket), { origin: h.url });
  t.after(() => reused.terminate());
  assert.equal(await outcome(reused), 401, 'a ticket opens one socket');

  // Removing the server ends the socket it relays
  const gone = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  assert.equal((await h.app.inject({ method: 'DELETE', url: `/api/servers/${server.id}`, ...bearer(h.token) })).statusCode, 200);
  await gone;
});

test('removing a server gives its token back; one that cannot be told stays unless forced', async (t) => {
  const r = await remote(t);
  const h = await hub(t);
  const server = await pairByCode(h, r);
  const removed = await h.app.inject({ method: 'DELETE', url: `/api/servers/${server.id}`, ...bearer(h.token) });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.deepEqual(removed.json<RemoveServerResult>(), { revoked: true });
  assert.equal(r.core.security.serverTokens.length, 0, 'no orphan token on the remote');
  assert.equal(serverToken(h, server.id), undefined);
  assert.equal((await h.app.inject({ method: 'DELETE', url: `/api/servers/${server.id}`, ...bearer(h.token) })).statusCode, 404);

  const f = await fake(t);
  const unreachable = await pairWithFake(h, [{ url: f.base, kind: 'lan' }]);
  await f.close();
  const refused = await h.app.inject({ method: 'DELETE', url: `/api/servers/${unreachable.id}`, ...bearer(h.token) });
  assert.equal(refused.statusCode, 502);
  assert.equal(codeOf(refused), 'servers.revoke-failed');
  assert.equal((await h.app.inject({ url: '/api/servers', ...bearer(h.token) })).json<ClaudioServer[]>().length, 1, 'kept');
  const forced = await h.app.inject({ method: 'DELETE', url: `/api/servers/${unreachable.id}?force=true`, ...bearer(h.token) });
  assert.equal(forced.statusCode, 200);
  const result = forced.json<RemoveServerResult>();
  assert.equal(result.revoked, false);
  assert.ok(result.reason?.code);
  assert.deepEqual((await h.app.inject({ url: '/api/servers', ...bearer(h.token) })).json(), []);
});

test('a new address must prove the identity; a hub cannot drive another hub’s gateway (one hop)', async (t) => {
  const r = await remote(t);
  const h = await hub(t);
  const server = await pairByCode(h, r);
  const f = await fake(t);
  const patched = await h.app.inject({ method: 'PATCH', url: `/api/servers/${server.id}`, ...authed(h.token, { name: 'Renamed', addresses: [{ url: r.base, kind: 'lan' }, { url: f.base, kind: 'tunnel' }] }) });
  assert.equal(patched.statusCode, 400);
  assert.equal(codeOf(patched), 'servers.address-identity');
  const renamed = await h.app.inject({ method: 'PATCH', url: `/api/servers/${server.id}`, ...authed(h.token, { name: 'Renamed', color: 'accent-2' }) });
  assert.equal(renamed.json<ClaudioServer>().name, 'Renamed');
  assert.equal((await h.app.inject({ method: 'PATCH', url: `/api/servers/${server.id}`, ...authed(h.token, { color: '#ff0000' }) })).statusCode, 400);

  // The remote turns its own Servers on: the hub's token there is still not the person's
  assert.equal((await r.app.inject({ method: 'PUT', url: '/api/servers/settings', ...authed(r.token, { enabled: true }) })).statusCode, 200);
  const token = serverToken(h, server.id) ?? '';
  const hop = await r.app.inject({ url: '/api/servers/0123456789ab/api/meta', ...bearer(token) });
  assert.equal(hop.statusCode, 403);
  assert.equal(codeOf(hop), 'servers.one-hop');
});
