import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, request as plainRequest, type Server } from 'node:http';
import { request } from 'node:https';
import { connect, type AddressInfo } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { Core, lanCertificateFingerprint, loadConfig } from '@claudio/core';
import type { LanStatus, Project, Terminal, TerminalServerFrame, TerminalTicket } from '@claudio/shared';
import { buildApp } from '../src/app.ts';
import { lanForwarders } from '../src/server.ts';

// The whole wrapper with its second listener on loopback, port 0: nothing here binds the machine's
// LAN addresses or port 8791. The machine is made to look as if it had a LAN address (LAN_IP) by
// replacing what the listener reads of the network, so a request that arrives on the LAN listener
// from loopback carrying LAN_IP in `Host` stands for a device on the network, and `inject` with a
// `remoteAddress` on the same subnet for one whose own address the socket would show.
const LAN_IP = '192.168.77.10';
const LOCAL_NAME = 'testbox.local';
const PHONE = '192.168.77.20';
const LAPTOP = '192.168.77.21';
const DESKTOP_SECRET = 'a-per-launch-secret-of-32-random-bytes';

const json = (body: unknown, headers: Record<string, string> = {}) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

interface Wrapper {
  app: FastifyInstance;
  core: Core;
  /** Hands the app to the LAN listener, as `startServer` does */
  attach: () => void;
  /** Where its data lives, the LAN certificate included */
  dataDir: string;
}

/** `root` is a data home kept between two wrappers, as a restart keeps it; one of its own otherwise */
async function wrapper(t: TestContext, env: NodeJS.ProcessEnv = {}, kept?: string): Promise<Wrapper> {
  const root = kept ?? mkdtempSync(join(tmpdir(), 'claudio-lan-'));
  const core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
      ...env,
    }),
  );
  core.lan.network.wildcard = '127.0.0.1';
  core.lan.network.interfaces = () => ({
    lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }],
    eth0: [{ address: LAN_IP, netmask: '255.255.255.0', family: 'IPv4', mac: '02:00:00:00:00:01', internal: false, cidr: `${LAN_IP}/24` }],
  });
  core.lan.network.localName = () => Promise.resolve({ host: LOCAL_NAME, ip: LAN_IP });
  // Under `mode: none` the real peer check reads this process's ancestors, which may be a chat's
  core.terminals.peer.check = () => 'not-agent';
  const app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  await app.ready();
  t.after(async () => {
    await core.shutdown();
    await app.close();
    if (kept === undefined) rmSync(root, { recursive: true, force: true });
  });
  const { request: onRequest, upgrade } = lanForwarders(app);
  return { app, core, attach: () => core.lan.attach(onRequest, upgrade), dataDir: join(root, 'data') };
}

/** A data home two wrappers share in turn, as one Claudio's restarts do; removed once the test ends */
function keptHome(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'claudio-lan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function withToken(app: FastifyInstance): Promise<string> {
  const { token } = (await app.inject({ method: 'POST', url: '/api/security/token', ...json({}) })).json() as { token: string };
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ mode: 'token' }) })).statusCode, 200);
  return token;
}

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const lan = (w: Wrapper): LanStatus => w.core.lan.status();

async function listening(w: Wrapper): Promise<number> {
  await until(() => lan(w).state === 'listening', 'the LAN listener');
  return lan(w).port;
}

interface LanAnswer {
  status: number;
  body: string;
  /** The SHA-256 of the certificate the listener presented; '' over plain HTTP or when nothing answered */
  fingerprint: string;
  location?: string;
}

/**
 * An HTTPS request on the LAN listener, from loopback, naming whatever `Host` the test gives it. No
 * CA vouches for the listener's certificate, so the client does not check it against one: the tests
 * compare its fingerprint instead, as a pairing hub does.
 */
function onLan(port: number, path: string, headers: Record<string, string>, method = 'GET', body?: string): Promise<LanAnswer> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers, rejectUnauthorized: false, agent: false }, (res) => {
      const fingerprint = (res.socket as TLSSocket).getPeerCertificate().fingerprint256;
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text, fingerprint }));
    });
    req.on('error', () => resolve({ status: 0, body: '', fingerprint: '' }));
    req.end(body);
  });
}

/** A plain-HTTP request on the LAN port, as a bookmark from before TLS sends it */
function plainOnLan(port: number, path: string, headers: Record<string, string>): Promise<LanAnswer> {
  return new Promise((resolve) => {
    const req = plainRequest({ host: '127.0.0.1', port, path, headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text, fingerprint: '', location: res.headers.location }));
    });
    req.on('error', () => resolve({ status: 0, body: '', fingerprint: '' }));
    req.end();
  });
}

/** What an upgrade answered, or `101` when it went through */
function outcome(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.once('open', () => resolve(101));
    socket.once('unexpected-response', (_req, res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    socket.once('error', () => resolve(0));
  });
}

// `@fastify/websocket` listens for upgrades on the app's own server only, so the LAN listener has to
// hand them over, from inside TLS now; without that the socket would hang or drop instead of reaching the route
test('an upgrade over TLS on the LAN port reaches the terminal socket, and a plain one is closed', async (t) => {
  const w = await wrapper(t, { CLAUDIO_LAN: 'on', CLAUDIO_LAN_PORT: '0' });
  const token = await withToken(w.app);
  w.attach();
  const port = await listening(w);
  const base = `https://127.0.0.1:${String(port)}`;
  const ws = (id: string, ticket: string, scheme = 'wss') => {
    const socket = new WebSocket(`${scheme}://127.0.0.1:${String(port)}/api/terminals/${id}/socket?ticket=${ticket}`, { origin: base, rejectUnauthorized: false });
    t.after(() => socket.terminate());
    return socket;
  };

  // Plain `ws://` is not served on the LAN port: a socket cannot follow the redirect
  assert.equal(await outcome(ws('term_nothing', 'x', 'ws')), 0);

  // The route's gate answered: the terminal is off
  assert.equal(await outcome(ws('term_nothing', 'x')), 409);
  await w.core.terminals.updateSettings({ enabled: true });
  // And past the gate, the route looked for the terminal and found none
  assert.equal(await outcome(ws('term_nothing', 'x')), 404);

  const auth = { authorization: `Bearer ${token}` };
  const project = (await w.app.inject({ method: 'POST', url: '/api/projects', ...json({ name: 'lan-shell', template: 'software' }, auth) })).json<Project>();
  const opened = await w.app.inject({ method: 'POST', url: '/api/terminals', ...json({ projectId: project.id }, auth) });
  if (opened.statusCode === 409 && /pty-missing|not available/.test(opened.body)) {
    t.diagnostic('node-pty cannot load here: the 101 half is skipped');
    return;
  }
  assert.equal(opened.statusCode, 201, opened.body);
  const terminal = opened.json<Terminal>();
  const minted = await onLan(port, `/api/terminals/${terminal.id}/ticket`, { host: `127.0.0.1:${String(port)}`, origin: base, ...auth }, 'POST');
  assert.equal(minted.status, 200, minted.body);
  const socket = ws(terminal.id, (JSON.parse(minted.body) as TerminalTicket).ticket);
  const frames: TerminalServerFrame[] = [];
  socket.on('message', (data, binary) => {
    if (!binary) frames.push(JSON.parse((data as Buffer).toString('utf8')) as TerminalServerFrame);
  });
  assert.equal(await outcome(socket), 101);
  await until(() => frames.some((frame) => frame.type === 'hello'), 'the hello frame');
});

test('a request on the LAN port reaches a route under a lent address, and an address nobody lent is refused', async (t) => {
  const w = await wrapper(t, { CLAUDIO_LAN: 'on', CLAUDIO_LAN_PORT: '0' });
  const token = await withToken(w.app);
  w.attach();
  const port = await listening(w);
  const auth = { authorization: `Bearer ${token}` };

  const status = lan(w);
  assert.deepEqual(status.addresses, [
    { ip: LAN_IP, host: null, url: `https://${LAN_IP}:${String(port)}` },
    { ip: LAN_IP, host: LOCAL_NAME, url: `https://${LOCAL_NAME}:${String(port)}` },
  ]);
  assert.deepEqual(status.interfaces, [{ name: 'eth0', ip: LAN_IP }]);
  // Its names join the allowlist while it listens, and loopback is never one of them
  assert.deepEqual(w.core.appSettings.runtimeHosts.list().sort(), [LAN_IP, LOCAL_NAME].sort());
  assert.deepEqual(w.core.appSettings.runtimeHosts.get(LAN_IP), { peerIsClient: true });

  for (const host of [`${LAN_IP}:${String(port)}`, `${LOCAL_NAME}:${String(port)}`]) {
    const res = await onLan(port, '/api/lan', { host, ...auth });
    assert.equal(res.status, 200, host);
    assert.equal((JSON.parse(res.body) as LanStatus).state, 'listening');
  }
  assert.equal((await onLan(port, '/api/lan', { host: `192.168.77.99:${String(port)}`, ...auth })).status, 421, 'an address the listener does not answer on');
  assert.equal((await onLan(port, '/api/lan', { host: 'evil.example', ...auth })).status, 421);
  // A credential is still asked for
  assert.equal((await onLan(port, '/api/lan', { host: `${LAN_IP}:${String(port)}` })).status, 401);

  // Stopped, its names leave and the port no longer answers
  const stopped = await w.app.inject({ method: 'POST', url: '/api/lan/stop', headers: auth });
  assert.equal(stopped.json<LanStatus>().state, 'off');
  assert.deepEqual(w.core.appSettings.runtimeHosts.list(), []);
  assert.equal((await w.app.inject({ url: '/api/lan', remoteAddress: PHONE, headers: { host: `${LAN_IP}:${String(port)}`, ...auth } })).statusCode, 421);
  assert.equal((await onLan(port, '/api/lan', { host: `127.0.0.1:${String(port)}`, ...auth })).status, 0);
  assert.ok(w.core.db.auditPage({ path: '/api/lan' }).entries.some((entry) => entry.summary === `LAN address ${LAN_IP} left the allowlist`));
});

test('no LAN listener without authentication: refused at start and by the route, and it opens once a token is on', async (t) => {
  // `auto` is what the desktop app sets
  const w = await wrapper(t, { CLAUDIO_LAN: 'auto', CLAUDIO_LAN_PORT: '0' });
  w.attach();
  await until(() => lan(w).state === 'refused', 'the refusal');
  assert.equal(lan(w).reason?.code, 'lan.authRequired');
  assert.deepEqual(w.core.appSettings.runtimeHosts.list(), []);
  assert.ok(w.core.db.auditPage({ path: '/api/lan/start' }).entries.some((entry) => entry.actor === 'claudio' && /no sign-in method/.test(entry.summary ?? '')));

  const refused = await w.app.inject({ method: 'POST', url: '/api/lan/start' });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json<{ code: string }>().code, 'lan.authRequired');

  // Turning a guard on is what it waited for
  await withToken(w.app);
  await listening(w);
  assert.ok(w.core.db.auditPage({ path: '/api/lan/start' }).entries.some((entry) => /authentication was turned on/.test(entry.summary ?? '')));
});

test('turning authentication off closes the listener before the change answers, open connections included', async (t) => {
  const w = await wrapper(t, { CLAUDIO_LAN: 'on', CLAUDIO_LAN_PORT: '0' });
  const token = await withToken(w.app);
  w.attach();
  const port = await listening(w);

  // A connection a device holds open, as a page's event stream or a terminal's socket would: one
  // inside TLS, and one that has not sent its first byte yet
  const secure = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false });
  await new Promise((resolve) => secure.once('secureConnect', resolve));
  const held = connect(port, '127.0.0.1');
  await new Promise((resolve) => held.once('connect', resolve));
  const ended = Promise.all([held, secure].map((socket) => new Promise<void>((resolve) => socket.once('close', () => resolve()))));

  const off = await w.app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ mode: 'none' }, { authorization: `Bearer ${token}` }) });
  assert.equal(off.statusCode, 200);
  // Already closed when the answer came back
  assert.equal(lan(w).state, 'refused');
  assert.deepEqual(w.core.appSettings.runtimeHosts.list(), []);
  await ended;
  assert.equal((await onLan(port, '/api/health', { host: `127.0.0.1:${String(port)}` })).status, 0, 'nothing listens there any more');
  assert.ok(w.core.db.auditPage({ path: '/api/lan/stop' }).entries.some((entry) => /authentication was turned off/.test(entry.summary ?? '')));
});

test('a port another program holds is a state with the next free port, and moving to that one listens', async (t) => {
  // Unset `CLAUDIO_LAN`: off until the person turns it on, so the default port is never tried
  const w = await wrapper(t, { CLAUDIO_LAN_BIND: '127.0.0.1' });
  const token = await withToken(w.app);
  w.attach();
  assert.equal(lan(w).state, 'off');
  const holder: Server = createServer();
  await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => holder.close(() => resolve())));
  const taken = (holder.address() as AddressInfo).port;
  const auth = { authorization: `Bearer ${token}` };

  const put = await w.app.inject({ method: 'PUT', url: '/api/lan/settings', ...json({ enabled: true, port: taken }, auth) });
  assert.equal(put.statusCode, 200, put.body);
  const status = put.json<LanStatus>();
  assert.equal(status.state, 'port-in-use');
  assert.equal(status.reason?.code, 'lan.portInUse');
  assert.equal(status.portTaken?.port, taken);
  assert.equal(status.portTaken?.holder, `127.0.0.1:${String(taken)}`);
  const next = status.portTaken?.nextFree;
  assert.ok(typeof next === 'number' && next > taken, 'a free port above it');

  const moved = await w.app.inject({ method: 'PUT', url: '/api/lan/settings', ...json({ port: next }, auth) });
  assert.equal(moved.json<LanStatus>().state, 'listening');
  assert.equal(moved.json<LanStatus>().port, next);
  assert.equal((await onLan(next, '/api/health', { host: `127.0.0.1:${String(next)}` })).status, 200);
});

test('the listener speaks HTTPS with the certificate it keeps, naming its addresses, with a key only its owner reads', async (t) => {
  const w = await wrapper(t, { CLAUDIO_LAN: 'on', CLAUDIO_LAN_PORT: '0' });
  const token = await withToken(w.app);
  // No certificate before it ever listened
  assert.equal(lan(w).fingerprint, null);
  assert.equal(w.core.lan.tlsFingerprint(), null);
  assert.equal(lanCertificateFingerprint(w.dataDir), null);
  w.attach();
  const port = await listening(w);
  const fingerprint = lan(w).fingerprint;
  assert.match(fingerprint ?? '', /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  // The one the grant reads (the listener's own, or the files') is the one the status shows and the one the handshake presents
  assert.equal(w.core.lan.tlsFingerprint(), fingerprint);
  assert.equal(lanCertificateFingerprint(w.dataDir), fingerprint);
  const res = await onLan(port, '/api/lan', { host: `${LAN_IP}:${String(port)}`, authorization: `Bearer ${token}` });
  assert.equal(res.status, 200, res.body);
  assert.equal(res.fingerprint, fingerprint);
  assert.equal((JSON.parse(res.body) as LanStatus).fingerprint, fingerprint);

  const dir = join(w.dataDir, 'lan-tls');
  const cert = new X509Certificate(readFileSync(join(dir, 'cert.pem')));
  assert.equal(cert.fingerprint256, fingerprint);
  assert.equal(cert.checkIP(LAN_IP), LAN_IP);
  assert.equal(cert.checkHost(LOCAL_NAME), LOCAL_NAME);
  const own = `${hostname().trim().toLowerCase().split('.')[0] ?? ''}.local`;
  if (/^[a-z0-9-]+\.local$/.test(own)) assert.equal(cert.checkHost(own), own, 'the machine name, whether mDNS answers for it or not');
  assert.equal(cert.checkIP('127.0.0.1'), undefined, 'loopback is not a LAN address');
  assert.equal(cert.ca, false);
  assert.equal(statSync(join(dir, 'key.pem')).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o077, 0, 'the directory is its owner’s only');
});

test('the certificate outlives restarts and is made again only when an address it does not name is served', async (t) => {
  const home = keptHome(t);
  const first = await wrapper(t, { CLAUDIO_LAN: 'on', CLAUDIO_LAN_PORT: '0' }, home);
  await withToken(first.app);
  first.attach();
  await listening(first);
  const made = lan(first).fingerprint;
  assert.ok(made);
  const key = readFileSync(join(first.dataDir, 'lan-tls', 'key.pem'), 'utf8');

  // A stop and a start in the same process
  await first.core.lan.stop();
  await first.core.lan.start();
  assert.equal(lan(first).fingerprint, made);
  // Stopped, it is still this server's identity: a grant made while it is off hands the same one
  await first.core.lan.stop();
  assert.equal(first.core.lan.tlsFingerprint(), made);
  // The history lives in the data dir too, so the second process sees the first one's rows
  const certificateRows = (w: Wrapper) => w.core.db.auditPage({ path: '/api/lan' }).entries.filter((entry) => /new LAN certificate/.test(entry.summary ?? '')).length;
  const madeBefore = certificateRows(first);
  assert.ok(madeBefore > 0);
  await first.core.shutdown();

  // A new process on the same data: the status shows it before listening, and listening keeps it
  const second = await wrapper(t, { CLAUDIO_LAN: 'on', CLAUDIO_LAN_PORT: '0' }, home);
  assert.equal(lan(second).fingerprint, made);
  second.attach();
  const port = await listening(second);
  assert.equal((await onLan(port, '/api/health', { host: `127.0.0.1:${String(port)}` })).fingerprint, made);
  assert.equal(certificateRows(second), madeBefore, 'no certificate made on the restart');

  // An address that leaves does not change it: a name too many is harmless, a new fingerprint breaks every pairing
  second.core.lan.network.interfaces = () => ({});
  second.core.lan.network.localName = () => Promise.resolve(null);
  assert.equal((await second.core.lan.refresh()).fingerprint, made);

  // A new lease is served, so the certificate must name it: made again, with the same key
  const NEW_IP = '192.168.77.11';
  second.core.lan.network.interfaces = () => ({
    eth0: [{ address: NEW_IP, netmask: '255.255.255.0', family: 'IPv4', mac: '02:00:00:00:00:01', internal: false, cidr: `${NEW_IP}/24` }],
  });
  const renewed = await second.core.lan.refresh();
  assert.ok(renewed.fingerprint && renewed.fingerprint !== made);
  assert.equal(lanCertificateFingerprint(second.dataDir), renewed.fingerprint);
  assert.equal(new X509Certificate(readFileSync(join(second.dataDir, 'lan-tls', 'cert.pem'))).checkIP(NEW_IP), NEW_IP);
  assert.equal(readFileSync(join(second.dataDir, 'lan-tls', 'key.pem'), 'utf8'), key, 'the key is kept');
  // New connections get it at once
  assert.equal((await onLan(port, '/api/health', { host: `127.0.0.1:${String(port)}` })).fingerprint, renewed.fingerprint);
});

test('plain HTTP on the LAN port gets a 301 to the same path on https://, under the Host it named', async (t) => {
  const w = await wrapper(t, { CLAUDIO_LAN: 'on', CLAUDIO_LAN_PORT: '0' });
  const token = await withToken(w.app);
  w.attach();
  const port = await listening(w);
  const host = `${LAN_IP}:${String(port)}`;

  const moved = await plainOnLan(port, '/chats/abc?tab=files', { host, authorization: `Bearer ${token}` });
  assert.equal(moved.status, 301);
  assert.equal(moved.location, `https://${host}/chats/abc?tab=files`);
  // Nothing of the app answered: no route ran, whatever the credential
  assert.doesNotMatch(moved.body, /"state"|"error"/);
  assert.equal((await plainOnLan(port, '/api/lan', { host: `${LOCAL_NAME}:${String(port)}` })).location, `https://${LOCAL_NAME}:${String(port)}/api/lan`);
  // A Host that is not a bare name or address is not echoed into Location
  for (const bad of ['evil.example/path', 'a b', 'user@evil.example']) {
    const res = await plainOnLan(port, '/', { host: bad });
    assert.equal(res.status, 400, bad);
    assert.equal(res.location, undefined);
  }
  // And the loopback listener still speaks plain HTTP: it is untouched
  assert.equal((await w.app.inject({ url: '/api/health' })).statusCode, 200);
});

test('each device on the network waits out its own wrong tokens', async (t) => {
  const w = await wrapper(t, { CLAUDIO_LAN: 'on', CLAUDIO_LAN_PORT: '0' });
  const token = await withToken(w.app);
  w.attach();
  const port = await listening(w);
  const from = (address: string, credential: string) => ({ url: '/api/overview', remoteAddress: address, headers: { host: `${LAN_IP}:${String(port)}`, authorization: `Bearer ${credential}` } });

  for (let i = 0; i < 10; i += 1) assert.equal((await w.app.inject(from(PHONE, 'a-guess'))).statusCode, 401, `guess ${String(i + 1)}`);
  assert.equal((await w.app.inject(from(PHONE, 'a-guess'))).statusCode, 429);
  // Another device on the same address is not the one guessing
  assert.equal((await w.app.inject(from(LAPTOP, 'another-guess'))).statusCode, 401);
  assert.equal((await w.app.inject(from(LAPTOP, token))).statusCode, 200);
  // Nor is the desktop on loopback
  assert.equal((await w.app.inject({ url: '/api/overview', remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:43123', authorization: 'Bearer yet-another' } })).statusCode, 401);

  // Through the listener itself, inside TLS: the bucket is still the TCP peer's address (loopback
  // here), which the TLS socket reports as the raw one did, never the name in `Host`
  const over = { host: `${LAN_IP}:${String(port)}`, authorization: 'Bearer a-tls-guess' };
  for (let i = 0; i < 10; i += 1) assert.equal((await onLan(port, '/api/overview', over)).status, 401, `TLS guess ${String(i + 1)}`);
  assert.equal((await onLan(port, '/api/overview', over)).status, 429);
  assert.equal((await w.app.inject({ url: '/api/overview', remoteAddress: '127.0.0.1', headers: over })).statusCode, 429, 'the same peer under the same name is the same bucket');
  assert.equal((await w.app.inject({ url: '/api/overview', remoteAddress: LAPTOP, headers: { host: over.host, authorization: `Bearer ${token}` } })).statusCode, 200, 'another device is not');
});

test("the desktop app's secret is refused from a LAN peer, and from loopback under a LAN name", async (t) => {
  const w = await wrapper(t, { CLAUDIO_LAN: 'on', CLAUDIO_LAN_PORT: '0', CLAUDIO_DESKTOP_TOKEN: DESKTOP_SECRET });
  await withToken(w.app);
  w.attach();
  const port = await listening(w);
  const secret = { authorization: `Bearer ${DESKTOP_SECRET}` };

  // A device on the network, whatever name it dialled
  for (const host of [`${LAN_IP}:${String(port)}`, `${LOCAL_NAME}:${String(port)}`]) {
    assert.equal((await w.app.inject({ url: '/api/overview', remoteAddress: PHONE, headers: { host, ...secret } })).statusCode, 401, host);
  }
  // The LAN listener's own socket, carrying the LAN address: what a forwarder in front of it would send
  assert.equal((await onLan(port, '/api/overview', { host: `${LAN_IP}:${String(port)}`, ...secret })).status, 401);
  // This machine dialling its own loopback is still this machine, on either listener
  assert.equal((await onLan(port, '/api/overview', { host: `127.0.0.1:${String(port)}`, ...secret })).status, 200);
});

// docs/reports/lan-access-security.md, F1: the tunnel's name is a runtime host whose traffic shares
// one bucket, since it all arrives from loopback; a device on the network can write that name in
// `Host` too, and must not spend the tunnel's budget with it
test("a device on the network naming the tunnel's host spends its own budget, never the tunnel's", async (t) => {
  const w = await wrapper(t, { CLAUDIO_LAN: 'on', CLAUDIO_LAN_PORT: '0' });
  const token = await withToken(w.app);
  w.attach();
  await listening(w);
  const tunnelHost = 'node.tail0000.ts.net';
  w.core.appSettings.runtimeHosts.add(tunnelHost, {});
  const from = (address: string, credential: string) => ({ url: '/api/overview', remoteAddress: address, headers: { host: tunnelHost, authorization: `Bearer ${credential}` } });

  for (let i = 0; i < 10; i += 1) assert.equal((await w.app.inject(from(PHONE, 'a-guess'))).statusCode, 401, `guess ${String(i + 1)}`);
  assert.equal((await w.app.inject(from(PHONE, 'a-guess'))).statusCode, 429, 'the guessing device waits');
  // What the tunnel relays arrives from loopback: neither a wrong guess nor the owner signing in again waits
  assert.equal((await w.app.inject(from('127.0.0.1', 'a-tunnel-guess'))).statusCode, 401);
  assert.equal((await w.app.inject(from('127.0.0.1', token))).statusCode, 200);
});

// F2: the hook closes the listener before the mode turns to none, but a start queued behind that
// close ran while the mode was still `token` and opened it again under `none`
test('a start that races authentication being turned off never leaves the listener open', async (t) => {
  const w = await wrapper(t, { CLAUDIO_LAN: 'on', CLAUDIO_LAN_PORT: '0' });
  await withToken(w.app);
  w.attach();
  const port = await listening(w);

  const off = w.core.security.update({ mode: 'none' });
  const start = w.core.lan.start().catch(() => null);
  await off;
  await start;
  // Whatever order the two took, nothing listens under `none` once both answered
  assert.equal(w.core.security.mode, 'none');
  assert.notEqual(lan(w).state, 'listening');
  assert.deepEqual(w.core.appSettings.runtimeHosts.list(), []);
  const now = lan(w).port;
  assert.equal((await onLan(now, '/api/health', { host: `127.0.0.1:${String(now)}` })).status, 0, `port ${String(now)} (was ${String(port)})`);
});

// F3: `0.0.0.0` is an IPv4 address, so the list took it: the listener then bound every interface
// while its addresses list and the allowlist named only `0.0.0.0`
test('the unspecified address is not an interface: refused in the setting and in CLAUDIO_LAN_BIND', async (t) => {
  const w = await wrapper(t, { CLAUDIO_LAN_PORT: '0' });
  const token = await withToken(w.app);
  const put = await w.app.inject({ method: 'PUT', url: '/api/lan/settings', ...json({ bind: ['0.0.0.0'] }, { authorization: `Bearer ${token}` }) });
  assert.equal(put.statusCode, 400, put.body);
  assert.throws(() => loadConfig({ CLAUDE_BIN: '/nonexistent/claude', CLAUDIO_LAN_BIND: '0.0.0.0' }), /CLAUDIO_LAN_BIND/);
});

// D8 from the device's side: a peer on the network that writes a loopback name in `Host`, and a
// forwarding header that says loopback, is still not this machine
test("a device on the network writing a loopback Host is neither the desktop app nor a chat", async (t) => {
  const w = await wrapper(t, { CLAUDIO_LAN: 'on', CLAUDIO_LAN_PORT: '0', CLAUDIO_DESKTOP_TOKEN: DESKTOP_SECRET });
  await withToken(w.app);
  w.attach();
  await listening(w);
  const chat = w.core.security.chatTokens.mint('chat-lan');
  for (const credential of [DESKTOP_SECRET, chat]) {
    for (const host of ['127.0.0.1:43123', 'localhost', '[::1]:43123']) {
      const res = await w.app.inject({ url: '/api/overview', remoteAddress: PHONE, headers: { host, 'x-forwarded-for': '127.0.0.1', authorization: `Bearer ${credential}` } });
      assert.equal(res.statusCode, 401, `${credential === chat ? 'chat' : 'desktop'} under ${host}`);
    }
  }
});

test('the terminal stays refused over the LAN unless its remote setting is `any`', async (t) => {
  const w = await wrapper(t, { CLAUDIO_LAN: 'on', CLAUDIO_LAN_PORT: '0' });
  const token = await withToken(w.app);
  w.attach();
  const port = await listening(w);
  await w.core.terminals.updateSettings({ enabled: true, remote: 'tunnel' });
  const auth = { authorization: `Bearer ${token}` };
  const host = `${LAN_IP}:${String(port)}`;

  const fromPhone = await w.app.inject({ url: '/api/terminals', remoteAddress: PHONE, headers: { host, ...auth } });
  assert.equal(fromPhone.statusCode, 403);
  assert.equal(fromPhone.json<{ reason: string }>().reason, 'needs-tunnel');
  // A process on this machine dialling the LAN name through loopback is not the tunnel either
  const throughLoopback = await onLan(port, '/api/terminals', { host, ...auth });
  assert.equal(throughLoopback.status, 403);
  assert.equal((JSON.parse(throughLoopback.body) as { reason: string }).reason, 'needs-tunnel');

  await w.core.terminals.updateSettings({ remote: 'any' });
  assert.equal((await w.app.inject({ url: '/api/terminals', remoteAddress: PHONE, headers: { host, ...auth } })).statusCode, 200);
});

test('the LAN routes are the person’s, the environment’s values are read-only, and CLAUDIO_LAN=off offers nothing', async (t) => {
  const w = await wrapper(t, { CLAUDIO_LAN: 'on', CLAUDIO_LAN_PORT: '0', CLAUDIO_LAN_BIND: '127.0.0.1' });
  const token = await withToken(w.app);
  const auth = { authorization: `Bearer ${token}` };
  const put = (body: unknown) => w.app.inject({ method: 'PUT', url: '/api/lan/settings', ...json(body, auth) });

  for (const [body, code] of [
    [{ enabled: false }, 'lan.enabledFromEnv'],
    [{ port: 9000 }, 'lan.portFromEnv'],
    [{ bind: 'all' }, 'lan.bindFromEnv'],
  ] as const) {
    const res = await put(body);
    assert.equal(res.statusCode, 409, JSON.stringify(body));
    assert.equal(res.json<{ code: string }>().code, code);
  }
  for (const body of [{ port: 80 }, { bind: ['not-an-ip'] }, { bind: [] }, { enabled: 'yes' }, { other: 1 }]) assert.equal((await put(body)).statusCode, 400, JSON.stringify(body));

  const state = await w.app.inject({ url: '/api/settings/state', headers: auth });
  const rows = state.json<{ settings: Record<string, { source: string }> }>().settings;
  assert.deepEqual([rows['lan.enabled']?.source, rows['lan.port']?.source, rows['lan.bind']?.source], ['env', 'env', 'env']);

  const chat = w.core.security.chatTokens.mint('chat-x');
  for (const [method, url] of [['GET', '/api/lan'], ['PUT', '/api/lan/settings'], ['POST', '/api/lan/start'], ['POST', '/api/lan/stop']] as const) {
    const res = await w.app.inject({ method, url, remoteAddress: '127.0.0.1', ...json({}, { host: '127.0.0.1:43123', authorization: `Bearer ${chat}` }) });
    assert.equal(res.statusCode, 403, `${method} ${url}`);
  }

  const off = await wrapper(t, { CLAUDIO_LAN: 'off' });
  const offToken = await withToken(off.app);
  off.attach();
  assert.equal(lan(off).available, false);
  const start = await off.app.inject({ method: 'POST', url: '/api/lan/start', headers: { authorization: `Bearer ${offToken}` } });
  assert.equal(start.statusCode, 409);
  assert.equal(start.json<{ code: string }>().code, 'lan.disabled');
});

test('settings saved from the app apply on the next start, and a reset gives the launcher its default back', async (t) => {
  const w = await wrapper(t, { CLAUDIO_LAN: 'auto', CLAUDIO_LAN_BIND: '127.0.0.1' });
  const token = await withToken(w.app);
  const auth = { authorization: `Bearer ${token}` };
  // Saved before the listener is handed the app, so the default port is never tried
  const holder: Server = createServer();
  await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
  const free = (holder.address() as AddressInfo).port;
  await new Promise<void>((resolve) => holder.close(() => resolve()));
  assert.equal((await w.app.inject({ method: 'PUT', url: '/api/lan/settings', ...json({ port: free, enabled: false }, auth) })).statusCode, 200);
  w.attach();
  assert.equal(lan(w).state, 'off');

  const rows = (await w.app.inject({ url: '/api/settings/state', headers: auth })).json<{ settings: Record<string, { source: string; changed: boolean; default: unknown }> }>().settings;
  assert.deepEqual([rows['lan.enabled']?.changed, rows['lan.enabled']?.default], [true, true]);
  assert.deepEqual([rows['lan.port']?.changed, rows['lan.port']?.default], [true, 8791]);

  // The launcher said `auto`: back to it, it listens
  const reset = await w.app.inject({ method: 'DELETE', url: '/api/settings/state/lan.enabled', headers: auth });
  assert.equal(reset.statusCode, 200, reset.body);
  await listening(w);
  assert.equal(lan(w).port, free);
});
