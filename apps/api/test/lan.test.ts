import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { Core, loadConfig } from '@claudio/core';
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
}

async function wrapper(t: TestContext, env: NodeJS.ProcessEnv = {}): Promise<Wrapper> {
  const root = mkdtempSync(join(tmpdir(), 'claudio-lan-'));
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
    rmSync(root, { recursive: true, force: true });
  });
  const { request: onRequest, upgrade } = lanForwarders(app);
  return { app, core, attach: () => core.lan.attach(onRequest, upgrade) };
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

/** A request on the LAN listener, from loopback, naming whatever `Host` the test gives it */
function onLan(port: number, path: string, headers: Record<string, string>, method = 'GET', body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end(body);
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
// hand them over; without that the socket would hang or drop instead of reaching the route
test('an upgrade on the LAN port reaches the terminal socket', async (t) => {
  const w = await wrapper(t, { CLAUDIO_LAN: 'on', CLAUDIO_LAN_PORT: '0' });
  const token = await withToken(w.app);
  w.attach();
  const port = await listening(w);
  const base = `http://127.0.0.1:${String(port)}`;
  const ws = (id: string, ticket: string) => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/api/terminals/${id}/socket?ticket=${ticket}`, { origin: base });
    t.after(() => socket.terminate());
    return socket;
  };

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
    { ip: LAN_IP, host: null, url: `http://${LAN_IP}:${String(port)}` },
    { ip: LAN_IP, host: LOCAL_NAME, url: `http://${LOCAL_NAME}:${String(port)}` },
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

  // A connection a device holds open, as a page's event stream or a terminal's socket would
  const held = connect(port, '127.0.0.1');
  await new Promise((resolve) => held.once('connect', resolve));
  const ended = new Promise<void>((resolve) => held.once('close', () => resolve()));

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
