import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { WebSocket } from 'ws';
import { Core, loadConfig, type PeerVerdict } from '@claudio/core';
import type { Project, Terminal, TerminalHistoryPage, TerminalStatus, TerminalTicket } from '@claudio/shared';
import { buildApp } from '../src/app.ts';

/*
 * The security audit of the terminal (docs/reports/terminal-security.md): one group per attacker of
 * docs/plans/terminal.md §3.1, each trying what that attacker would try. `terminals.test.ts` holds the
 * gate's own matrix; these are the attacks it does not already make.
 */

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const bearer = (token: string, extra: Record<string, string> = {}) => ({ headers: { authorization: `Bearer ${token}`, ...extra } });
const upgrade = { upgrade: 'websocket', connection: 'upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' };

interface Wrapper {
  app: FastifyInstance;
  core: Core;
  projectId: string;
}

/** A wrapper with the terminal on. The peer check answers what the test says, unless it asks for the real one. */
async function wrapper(t: TestContext, options: { env?: NodeJS.ProcessEnv; verdict?: PeerVerdict | 'real' } = {}): Promise<Wrapper> {
  const root = mkdtempSync(join(tmpdir(), 'claudio-terminal-security-'));
  const veto = process.env.CLAUDIO_TERMINAL;
  const cors = process.env.CLAUDIO_CORS_ORIGIN;
  delete process.env.CLAUDIO_TERMINAL;
  t.after(() => {
    if (veto === undefined) delete process.env.CLAUDIO_TERMINAL;
    else process.env.CLAUDIO_TERMINAL = veto;
    if (cors === undefined) delete process.env.CLAUDIO_CORS_ORIGIN;
    else process.env.CLAUDIO_CORS_ORIGIN = cors;
  });
  const core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
      ...options.env,
    }),
  );
  const verdict = options.verdict ?? 'not-agent';
  if (verdict !== 'real') core.terminals.peer.check = () => verdict;
  const app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  t.after(async () => {
    core.shutdown();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  await core.terminals.updateSettings({ enabled: true });
  const created = await app.inject({ method: 'POST', url: '/api/projects', ...json({ name: 'audit-project', template: 'software' }) });
  assert.equal(created.statusCode, 201);
  return { app, core, projectId: created.json<Project>().id };
}

async function withToken(app: FastifyInstance): Promise<string> {
  const { token } = (await app.inject({ method: 'POST', url: '/api/security/token', ...json({}) })).json<{ token: string }>();
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ mode: 'token' }) })).statusCode, 200);
  return token;
}

/** Every terminal route, the socket's upgrade included, with what each needs to get past the body parser */
const ROUTES: Array<[string, string]> = [
  ['GET', '/api/terminal/history'],
  ['GET', '/api/terminals'],
  ['POST', '/api/terminals'],
  ['GET', '/api/terminals/term_x'],
  ['POST', '/api/terminals/term_x/ticket'],
  ['GET', '/api/terminals/term_x/socket'],
  ['DELETE', '/api/terminals/term_x'],
  ['PUT', '/api/terminal/settings'],
];

function call(app: FastifyInstance, method: string, url: string, options: InjectOptions = {}) {
  const headers = { ...(method === 'PUT' || method === 'POST' ? { 'content-type': 'application/json' } : {}), ...(url.endsWith('/socket') ? upgrade : {}), ...options.headers };
  return app.inject({ ...options, method: method as 'GET', url, headers, ...(method === 'PUT' || method === 'POST' ? { payload: method === 'PUT' ? '{"enabled":true}' : '{}' } : {}) });
}

const reasonOf = (res: { statusCode: number; body: string }): string | null => {
  try {
    return (JSON.parse(res.body) as { reason?: string }).reason ?? null;
  } catch {
    return null;
  }
};

// ---------- a real listener on loopback, for the socket ----------

interface Open {
  base: string;
  port: number;
  ws(id: string, query: string, headers: Record<string, string>): WebSocket;
}

async function listen(t: TestContext, app: FastifyInstance): Promise<Open> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${String(port)}`,
    port,
    ws: (id, query, headers) => {
      const { origin, ...rest } = headers;
      const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/api/terminals/${id}/socket${query}`, { ...(origin ? { origin } : {}), headers: rest });
      t.after(() => socket.terminate());
      return socket;
    },
  };
}

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

async function openTerminal(t: TestContext, w: Wrapper, options: InjectOptions = {}): Promise<Terminal | null> {
  const res = await w.app.inject({ method: 'POST', url: '/api/terminals', ...json({ projectId: w.projectId }), ...options, headers: { 'content-type': 'application/json', ...options.headers } });
  if (res.statusCode === 409 && /pty-missing|not available/.test(res.body)) {
    t.skip('node-pty cannot load here');
    return null;
  }
  assert.equal(res.statusCode, 201, res.body);
  return res.json<Terminal>();
}

const closedWithin = (socket: WebSocket, ms: number): Promise<boolean> =>
  new Promise((resolve) => {
    if (socket.readyState === socket.CLOSED) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

// ---------- anyone on the LAN, with authentication off ----------

test('LAN, auth off: a LAN peer that writes Host: localhost is still another device, on every route and the upgrade', async (t) => {
  const { app } = await wrapper(t);
  for (const remoteAddress of ['192.168.1.9', '::ffff:192.168.1.9', 'fe80::1']) {
    for (const [method, url] of ROUTES) {
      const res = await call(app, method, url, { remoteAddress, headers: { host: 'localhost:8797', origin: 'http://localhost:8797' } });
      assert.equal(res.statusCode, 403, `${method} ${url} from ${remoteAddress}: ${res.body}`);
      assert.equal(reasonOf(res), 'needs-auth', `${method} ${url} from ${remoteAddress}`);
    }
  }
});

test('LAN, auth off: settings that also turn something on are not the "turn it off" the owner may always do', async (t) => {
  const { app, core } = await wrapper(t, { env: { CLAUDIO_ALLOWED_HOSTS: 'lan.test' } });
  const lan = { remoteAddress: '192.168.1.9', headers: { host: 'lan.test', 'content-type': 'application/json' } };
  for (const body of [{ enabled: false, remote: 'any' }, { enabled: false, shell: '/bin/sh' }, { remote: 'any' }]) {
    const res = await app.inject({ method: 'PUT', url: '/api/terminal/settings', ...lan, payload: JSON.stringify(body) });
    assert.equal(res.statusCode, 403, JSON.stringify(body));
  }
  assert.deepEqual([core.terminals.settings().enabled, core.terminals.settings().remote], [true, 'tunnel']);
});

test('LAN, auth off: each refusal is a row that names the address it came from', async (t) => {
  const { app, core } = await wrapper(t, { env: { CLAUDIO_ALLOWED_HOSTS: 'lan.test' } });
  await app.inject({ method: 'POST', url: '/api/terminals', remoteAddress: '192.168.1.77', ...json({}), headers: { host: 'lan.test', 'content-type': 'application/json' } });
  const rows = core.terminals.history().entries.flatMap((entry) => entry.attachments);
  assert.ok(rows.some((row) => row.refused === 'needs-auth' && row.client === '192.168.1.77'), JSON.stringify(rows));
});

// ---------- a listener on the LAN, with a token ----------

test('LAN listener: a new install lets another device in only through the tunnel', async (t) => {
  const { core } = await wrapper(t);
  assert.equal(core.terminals.settings().remote, 'tunnel');
});

test('LAN listener: a ticket minted through the tunnel does not open the socket from the LAN address', async (t) => {
  const w = await wrapper(t, { env: { CLAUDIO_ALLOWED_HOSTS: 'lan.test' } });
  w.core.appSettings.runtimeHosts.add('node.ts.net');
  const token = await withToken(w.app);
  const terminal = await openTerminal(t, w, bearer(token));
  if (!terminal) return;
  const minted = await w.app.inject({ method: 'POST', url: `/api/terminals/${terminal.id}/ticket`, remoteAddress: '127.0.0.1', ...bearer(token, { host: 'node.ts.net', origin: 'https://node.ts.net' }) });
  assert.equal(minted.statusCode, 200, minted.body);
  const { ticket } = minted.json<TerminalTicket>();
  // Read off the wire and replayed from the LAN, with the Host and Origin the tunnel's page had
  const replayed = await w.app.inject({ url: `/api/terminals/${terminal.id}/socket?ticket=${ticket}`, remoteAddress: '192.168.1.9', headers: { ...upgrade, host: 'node.ts.net', origin: 'https://node.ts.net' } });
  assert.equal(replayed.statusCode, 403);
  assert.equal(reasonOf(replayed), 'needs-tunnel');
  const lan = await w.app.inject({ url: `/api/terminals/${terminal.id}/socket?ticket=${ticket}`, remoteAddress: '192.168.1.9', headers: { ...upgrade, host: 'lan.test', origin: 'http://lan.test' } });
  assert.equal(lan.statusCode, 403);
  assert.equal(reasonOf(lan), 'needs-tunnel');
});

// ---------- a web page the owner visits (cross-site WebSocket hijacking) ----------

test('cross-site page: no Origin, a foreign one, `null` and another local port get no ticket and no socket', async (t) => {
  const w = await wrapper(t);
  const open = await listen(t, w.app);
  const terminal = await openTerminal(t, w);
  if (!terminal) return;
  const host = `127.0.0.1:${String(open.port)}`;
  for (const origin of ['http://evil.example', 'null', 'http://127.0.0.1:5181', 'http://localhost:1', 'file://', `ws://${host}`]) {
    const minted: { statusCode: number } = await w.app.inject({ method: 'POST', url: `/api/terminals/${terminal.id}/ticket`, headers: { host, origin } });
    assert.equal(minted.statusCode, 403, `ticket for ${origin}`);
  }
  // A ticket asked for with no Origin at all (curl, a script) is minted, and opens nothing
  const bare = await w.app.inject({ method: 'POST', url: `/api/terminals/${terminal.id}/ticket`, headers: { host } });
  assert.equal(bare.statusCode, 200);
  assert.equal(await outcome(open.ws(terminal.id, `?ticket=${bare.json<TerminalTicket>().ticket}`, { origin: open.base })), 401);
  for (const origin of ['http://evil.example', 'null', 'http://127.0.0.1:5181']) {
    const good: TerminalTicket = (await w.app.inject({ method: 'POST', url: `/api/terminals/${terminal.id}/ticket`, headers: { host, origin: open.base } })).json<TerminalTicket>();
    assert.equal(await outcome(open.ws(terminal.id, `?ticket=${good.ticket}`, { origin })), 403, `socket from ${origin}`);
  }
});

test('cross-site page: CLAUDIO_CORS_ORIGIN=* invites reads, never a terminal socket', async (t) => {
  const w = await wrapper(t);
  process.env.CLAUDIO_CORS_ORIGIN = '*';
  const open = await listen(t, w.app);
  const terminal = await openTerminal(t, w);
  if (!terminal) return;
  const minted = await w.app.inject({ method: 'POST', url: `/api/terminals/${terminal.id}/ticket`, headers: { host: `127.0.0.1:${String(open.port)}`, origin: 'http://evil.example' } });
  assert.equal(minted.statusCode, 403);
});

test('cross-site page: a form-style POST (text/plain, no preflight) opens no terminal and is not a server error', async (t) => {
  const w = await wrapper(t);
  for (const [url, payload] of [
    ['/api/terminals', JSON.stringify({ projectId: w.projectId })],
    ['/api/terminals', 'projectId=x'],
  ] as const) {
    const res = await w.app.inject({ method: 'POST', url, payload, headers: { 'content-type': 'text/plain', origin: 'http://evil.example' } });
    assert.ok(res.statusCode >= 400 && res.statusCode < 500, `${url} with ${payload}: ${String(res.statusCode)} ${res.body}`);
  }
  assert.equal(w.core.terminals.running(), 0);
});

// ---------- DNS rebinding ----------

test('DNS rebinding: a name that resolves to 127.0.0.1 is 421 on every terminal route, under both modes', async (t) => {
  const w = await wrapper(t);
  for (const [method, url] of ROUTES) {
    const res = await call(w.app, method, url, { headers: { host: 'rebind.evil.example:8797', origin: 'http://rebind.evil.example:8797' } });
    assert.equal(res.statusCode, 421, `${method} ${url} under none`);
  }
  const token = await withToken(w.app);
  for (const [method, url] of ROUTES) {
    const res = await call(w.app, method, url, bearer(token, { host: 'rebind.evil.example:8797', origin: 'http://rebind.evil.example:8797' }));
    assert.equal(res.statusCode, 421, `${method} ${url} under a token`);
  }
});

// ---------- a prompt injection in a chat ----------

test('prompt injection: a chat token on the upgrade is refused under none, by header or as ?token=', async (t) => {
  const w = await wrapper(t);
  const chat = w.core.security.chatTokens.mint('chat-inj');
  const byHeader = await w.app.inject({ url: '/api/terminals/term_x/socket?ticket=x', headers: { ...upgrade, authorization: `Bearer ${chat}`, origin: 'http://localhost' } });
  assert.equal(byHeader.statusCode, 403);
  assert.equal(reasonOf(byHeader), 'chat-token');
  // `?token=` is honoured only by the five EventSource routes: on the socket it is no credential at all
  const byQuery = await w.app.inject({ url: `/api/terminals/term_x/socket?token=${chat}`, headers: { ...upgrade, origin: 'http://localhost' } });
  assert.notEqual(byQuery.statusCode, 101);
  assert.notEqual(byQuery.statusCode, 200);
});

test('prompt injection: under a token, a chat token on the upgrade is not a credential, and the socket still wants a ticket', async (t) => {
  const w = await wrapper(t);
  await withToken(w.app);
  const chat = w.core.security.chatTokens.mint('chat-inj');
  const res = await w.app.inject({ url: '/api/terminals/term_x/socket', headers: { ...upgrade, authorization: `Bearer ${chat}`, origin: 'http://localhost' } });
  assert.ok([401, 403, 404].includes(res.statusCode), String(res.statusCode));
  assert.notEqual(res.statusCode, 101);
});

/**
 * Runs a request as the grandchild of a process carrying CLAUDIO_CHAT_ID, the way a chat's Bash tool
 * would, with the variable dropped; `detach` also leaves the chat's tree the way `setsid -f` does (the
 * middle process exits, and the grandchild is reparented). Returns what the request got.
 */
async function fromChatTree(t: TestContext, base: string, options: { detach: boolean }): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'claudio-peer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = join(dir, 'result');
  // Detached, it waits for its parent to be gone before it calls
  // It ends itself whatever happens: a detached process is out of reach of the test's cleanup
  const grandchild = `const fs = require('node:fs'); setTimeout(() => process.exit(0), 5000).unref(); setTimeout(() => fetch(process.argv[1] + '/api/terminals').then(async (r) => fs.writeFileSync(process.argv[2], String(r.status) + ' ' + (await r.text())), (e) => fs.writeFileSync(process.argv[2], 'error ' + e.message)), ${options.detach ? 500 : 0});`;
  const middle = `
    const { spawn } = require('node:child_process');
    const env = { ...process.env }; delete env.CLAUDIO_CHAT_ID;
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}, ...process.argv.slice(1)], { env, detached: ${String(options.detach)}, stdio: 'ignore' });
    ${options.detach ? 'child.unref();' : "child.on('close', () => process.exit(0));"}
  `;
  // The "chat" outlives the call, so the real check finds it in the process table
  const chat = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(middle)}, ...process.argv.slice(1)], { stdio: 'ignore' }); setTimeout(() => process.exit(0), 6000);`;
  // A runner that is itself an agent run's verification command marks every child with
  // CLAUDIO_AGENT_RUN, which the peer check rightly refuses: the tree here is a chat's, nothing else
  const ambient = { ...process.env };
  delete ambient.CLAUDIO_AGENT_RUN;
  const root = spawn(process.execPath, ['-e', chat, base, result], { env: { ...ambient, CLAUDIO_CHAT_ID: 'chat-audit' }, stdio: 'ignore' });
  t.after(() => root.kill('SIGKILL'));
  const end = Date.now() + 6000;
  while (Date.now() < end) {
    try {
      const out = readFileSync(result, 'utf8');
      if (out !== '') return out;
    } catch {
      // not written yet
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return 'timeout';
}

test('prompt injection: a grandchild of a chat that dropped CLAUDIO_CHAT_ID is still the chat’s, through the real peer check', async (t) => {
  const w = await wrapper(t, { verdict: 'real' });
  const open = await listen(t, w.app);
  const out = await fromChatTree(t, open.base, { detach: false });
  assert.match(out, /^403 .*from-agent/);
});

// T8-1, accepted by the owner on 2026-10-15 (plans/terminal.md, Decisions): under `none` nothing the
// person holds is secret from a process running as the same user, so a detached process is not caught.
// The test pins that, so fixing it later (a cgroup per chat) fails here and the warning in Settings goes
// with it. Under a token or OIDC it is refused anyway: it holds no credential.
test('prompt injection: under none, a chat process that detaches and drops CLAUDIO_CHAT_ID reads like the person (T8-1, accepted and warned in Settings)', async (t) => {
  const w = await wrapper(t, { verdict: 'real' });
  const open = await listen(t, w.app);
  const out = await fromChatTree(t, open.base, { detach: true });
  assert.match(out, /^200 /);
});

// The reviewer's finding of 2026-10-18: from an agent's shell, `PUT /api/terminal/settings` got
// through about once in six, and more often in bursts. Each request here is a new process the chat
// starts after the previous one ended, as a `curl` from a Bash tool is.
test('prompt injection: a burst of 50 requests, each from a new process of a chat\'s tree, is refused every time', async (t) => {
  const w = await wrapper(t, { verdict: 'real' });
  const open = await listen(t, w.app);
  const dir = mkdtempSync(join(tmpdir(), 'claudio-peer-burst-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = join(dir, 'result');
  const request = `fetch(process.argv[1] + '/api/terminal/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"enabled":true}' }).then(async (r) => console.log(String(r.status) + ' ' + ((await r.json()).reason ?? '')), (e) => console.log('error ' + e.message));`;
  // Half the requests drop the variable and are only the chat's descendants
  const chat = `
    const { spawnSync } = require('node:child_process');
    const lines = [];
    for (let i = 0; i < 50; i++) {
      const env = { ...process.env };
      if (i % 2 === 0) delete env.CLAUDIO_CHAT_ID;
      lines.push(spawnSync(process.execPath, ['-e', ${JSON.stringify(request)}, process.argv[1]], { env, encoding: 'utf8' }).stdout.trim());
    }
    require('node:fs').writeFileSync(process.argv[2], lines.join('\\n'));
  `;
  const ambient = { ...process.env };
  delete ambient.CLAUDIO_AGENT_RUN;
  const root = spawn(process.execPath, ['-e', chat, open.base, result], { env: { ...ambient, CLAUDIO_CHAT_ID: 'chat-burst' }, stdio: 'ignore' });
  t.after(() => root.kill('SIGKILL'));
  await new Promise<void>((resolve) => root.once('exit', () => resolve()));
  const lines = readFileSync(result, 'utf8').split('\n');
  assert.equal(lines.length, 50);
  assert.deepEqual(new Set(lines), new Set(['403 from-agent']), lines.join(', '));
});

// ---------- a leaked owner token ----------

test('leaked token: with the feature off the token opens nothing, and turning it on from another device is refused', async (t) => {
  const w = await wrapper(t, { env: { CLAUDIO_ALLOWED_HOSTS: 'lan.test' } });
  const token = await withToken(w.app);
  await w.app.inject({ method: 'PUT', url: '/api/terminal/settings', ...bearer(token, { 'content-type': 'application/json' }), payload: '{"enabled":false}' });
  const lan = { remoteAddress: '192.168.1.9', ...bearer(token, { host: 'lan.test', 'content-type': 'application/json' }) };
  const opened = await w.app.inject({ method: 'POST', url: '/api/terminals', ...lan, payload: JSON.stringify({ projectId: w.projectId }) });
  assert.equal(opened.statusCode, 409);
  const on = await w.app.inject({ method: 'PUT', url: '/api/terminal/settings', ...lan, payload: '{"enabled":true}' });
  assert.equal(on.statusCode, 403);
  assert.equal(reasonOf(on), 'needs-tunnel');
});

test('leaked token: a session opened from another device says where from in the history', async (t) => {
  const w = await wrapper(t, { env: { CLAUDIO_ALLOWED_HOSTS: 'lan.test' } });
  const token = await withToken(w.app);
  await w.core.terminals.updateSettings({ remote: 'any' });
  const terminal = await openTerminal(t, w, { remoteAddress: '192.168.1.42', ...bearer(token, { host: 'lan.test' }) });
  if (!terminal) return;
  const history = (await w.app.inject({ url: '/api/terminal/history', ...bearer(token) })).json<TerminalHistoryPage>();
  const entry = history.entries.find((e) => e.id === terminal.id);
  assert.equal(entry?.client, '192.168.1.42');
});

test('leaked token: rotating the token, or changing the mode, ends the sockets it opened, and the tickets it minted', async (t) => {
  const w = await wrapper(t);
  const open = await listen(t, w.app);
  const token = await withToken(w.app);
  const terminal = await openTerminal(t, w, bearer(token));
  if (!terminal) return;
  const host = `127.0.0.1:${String(open.port)}`;
  const ticket = async () => {
    const res = await w.app.inject({ method: 'POST', url: `/api/terminals/${terminal.id}/ticket`, ...bearer(token, { host, origin: open.base }) });
    assert.equal(res.statusCode, 200, res.body);
    return res.json<TerminalTicket>().ticket;
  };
  const attached = open.ws(terminal.id, `?ticket=${await ticket()}`, { origin: open.base });
  assert.equal(await outcome(attached), 101);
  const spare = await ticket();

  // The owner learns the token leaked and sets a new one
  assert.equal((await w.app.inject({ method: 'POST', url: '/api/security/token', ...bearer(token, { 'content-type': 'application/json' }), payload: '{}' })).statusCode, 200);
  assert.equal(await closedWithin(attached, 3000), true, 'the socket the old token opened is closed');
  assert.equal(await outcome(open.ws(terminal.id, `?ticket=${spare}`, { origin: open.base })), 401, 'a ticket the old token minted opens nothing');
  // The shell itself is the person's and keeps running
  assert.equal(w.core.terminals.get(terminal.id)?.state, 'running');
});

test('leaked token: narrowing `remote` ends the sockets it no longer allows', async (t) => {
  const w = await wrapper(t);
  const open = await listen(t, w.app);
  const token = await withToken(w.app);
  const terminal = await openTerminal(t, w, bearer(token));
  if (!terminal) return;
  const res = await w.app.inject({ method: 'POST', url: `/api/terminals/${terminal.id}/ticket`, ...bearer(token, { host: `127.0.0.1:${String(open.port)}`, origin: open.base }) });
  const attached = open.ws(terminal.id, `?ticket=${res.json<TerminalTicket>().ticket}`, { origin: open.base });
  assert.equal(await outcome(attached), 101);
  const put = await w.app.inject({ method: 'PUT', url: '/api/terminal/settings', ...bearer(token, { 'content-type': 'application/json' }), payload: '{"remote":"off"}' });
  assert.equal(put.statusCode, 200);
  assert.equal(await closedWithin(attached, 3000), true);
});

// ---------- the tunnel ----------

test('tunnel, auth off: the tunnel name is another device on every route and the upgrade', async (t) => {
  const { app, core } = await wrapper(t);
  core.appSettings.runtimeHosts.add('node.ts.net', { clientIpHeader: 'x-real-ip' });
  for (const [method, url] of ROUTES) {
    const res = await call(app, method, url, { remoteAddress: '127.0.0.1', headers: { host: 'node.ts.net', origin: 'https://node.ts.net' } });
    assert.equal(res.statusCode, 403, `${method} ${url}`);
    assert.equal(reasonOf(res), 'needs-auth');
  }
  // The tunnel's client-address header on a loopback name is a relay too
  const relayed = await app.inject({ url: '/api/terminals', headers: { host: 'localhost', 'x-real-ip': '100.64.0.9' } });
  assert.equal(reasonOf(relayed), 'needs-auth');
  const status = (await app.inject({ url: '/api/terminal', headers: { host: 'node.ts.net' } })).json<TerminalStatus>();
  assert.deepEqual([status.available, status.reason], [false, 'needs-auth']);
});
