import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { WebSocket } from 'ws';
import { Core, loadConfig, type PeerVerdict } from '@claudio/core';
import type { Project, Terminal, TerminalHistoryPage, TerminalServerFrame, TerminalStatus, TerminalTicket } from '@claudio/shared';
import { buildApp, redactUrl } from '../src/app.ts';
import { TICKET_TTL_MS, TerminalTickets } from '../src/terminal-socket.ts';

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const bearer = (token: string, extra: Record<string, string> = {}) => ({ headers: { authorization: `Bearer ${token}`, ...extra } });

interface Wrapper {
  app: FastifyInstance;
  core: Core;
  projectId: string;
}

/**
 * A wrapper of its own with the terminal turned on. The peer check is answered by the test: under
 * `mode: none` the real one reads this very process's ancestors, which on a machine where a chat
 * runs the tests are a chat's, and every request would be an agent's.
 */
async function wrapper(t: TestContext, options: { env?: NodeJS.ProcessEnv; enabled?: boolean; verdict?: PeerVerdict } = {}): Promise<Wrapper> {
  const root = mkdtempSync(join(tmpdir(), 'claudio-terminals-'));
  const veto = process.env.CLAUDIO_TERMINAL;
  const { CLAUDIO_TERMINAL, ...env } = options.env ?? {};
  if (CLAUDIO_TERMINAL !== undefined) process.env.CLAUDIO_TERMINAL = CLAUDIO_TERMINAL;
  else delete process.env.CLAUDIO_TERMINAL;
  const core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
      ...env,
    }),
  );
  // The settings read the variable on every call, so it stays set for the test's whole life
  t.after(() => {
    if (veto === undefined) delete process.env.CLAUDIO_TERMINAL;
    else process.env.CLAUDIO_TERMINAL = veto;
  });
  core.terminals.peer.check = () => options.verdict ?? 'not-agent';
  const app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  t.after(async () => {
    core.shutdown();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  if (options.enabled !== false && CLAUDIO_TERMINAL === undefined) await core.terminals.updateSettings({ enabled: true });
  const created = await app.inject({ method: 'POST', url: '/api/projects', ...json({ name: 'shell-project', template: 'software' }) });
  assert.equal(created.statusCode, 201);
  return { app, core, projectId: created.json<Project>().id };
}

/** The token mode, and the owner's token */
async function withToken(app: FastifyInstance): Promise<string> {
  const created = await app.inject({ method: 'POST', url: '/api/security/token', ...json({}) });
  const { token } = created.json() as { token: string };
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ mode: 'token' }) })).statusCode, 200);
  return token;
}

const ROUTES: Array<[string, string]> = [
  ['GET', '/api/terminal'],
  ['PUT', '/api/terminal/settings'],
  ['GET', '/api/terminal/history'],
  ['GET', '/api/terminals'],
  ['POST', '/api/terminals'],
  ['GET', '/api/terminals/term_x'],
  ['POST', '/api/terminals/term_x/ticket'],
  ['GET', '/api/terminals/term_x/socket'],
  ['DELETE', '/api/terminals/term_x'],
];

const call = (app: FastifyInstance, method: string, url: string, options: Partial<InjectOptions> = {}) =>
  app.inject({ method: method as 'GET', url, ...(method === 'PUT' || method === 'POST' ? json({}) : {}), ...options });

// ---------- the gate ----------

test('with the feature off every route but the status and the settings answers 409 off, and the status says why', async (t) => {
  const { app, core } = await wrapper(t, { enabled: false });
  const status = (await app.inject('/api/terminal')).json<TerminalStatus>();
  assert.deepEqual([status.enabled, status.available, status.reason], [false, false, 'off']);
  for (const [method, url] of ROUTES.filter(([m, u]) => !['/api/terminal', '/api/terminal/settings', '/api/terminal/history'].includes(u) && !(m === 'GET' && u.endsWith('/socket')))) {
    const res = await call(app, method, url);
    assert.equal(res.statusCode, 409, `${method} ${url}`);
    assert.equal(res.json<{ reason: string }>().reason, 'off');
  }
  assert.equal(core.terminals.running(), 0);
  // Turning it on is the one thing it answers
  assert.equal((await call(app, 'PUT', '/api/terminal/settings', json({ enabled: true }))).statusCode, 200);
  assert.equal((await app.inject('/api/terminal')).json<TerminalStatus>().available, true);
});

test('CLAUDIO_TERMINAL=off makes the settings read-only and refuses turning it on', async (t) => {
  const { app } = await wrapper(t, { env: { CLAUDIO_TERMINAL: 'off' } });
  const status = (await app.inject('/api/terminal')).json<TerminalStatus>();
  assert.equal(status.reason, 'disabled-by-env');
  assert.equal(status.sources.enabled, 'env');
  const put = await call(app, 'PUT', '/api/terminal/settings', json({ enabled: true }));
  assert.equal(put.statusCode, 409);
  assert.equal(put.json<{ code: string }>().code, 'terminal.env-locked');
  assert.equal((await call(app, 'POST', '/api/terminals', json({ projectId: 'x' }))).statusCode, 409);
});

test('read-only answers 405 on every route, reads included, and refuses the upgrade', async (t) => {
  const { app } = await wrapper(t);
  assert.equal((await call(app, 'PUT', '/api/security/auth', json({ readOnly: true }))).statusCode, 200);
  for (const [method, url] of ROUTES) {
    const res = await call(app, method, url, method === 'GET' && url.endsWith('/socket') ? { headers: { upgrade: 'websocket', connection: 'upgrade' } } : {});
    // Writes are refused by the guard before the gate; the answer is the same
    assert.equal(res.statusCode, 405, `${method} ${url}`);
  }
});

test('under mode none a request from this machine is allowed, and anything relayed or from elsewhere needs a token', async (t) => {
  const { app, core } = await wrapper(t, { env: { CLAUDIO_ALLOWED_HOSTS: 'lan.test' } });
  core.appSettings.runtimeHosts.add('node.ts.net');
  assert.equal((await app.inject('/api/terminals')).statusCode, 200);
  const needsAuth = async (options: InjectOptions) => {
    const res = await app.inject({ url: '/api/terminals', ...options });
    assert.equal(res.statusCode, 403, JSON.stringify(options));
    assert.equal(res.json<{ reason: string }>().reason, 'needs-auth');
  };
  await needsAuth({ remoteAddress: '192.168.1.9', headers: { host: 'lan.test' } });
  await needsAuth({ headers: { host: 'localhost', 'x-forwarded-for': '203.0.113.7' } });
  await needsAuth({ headers: { host: 'localhost', forwarded: 'for=203.0.113.7' } });
  await needsAuth({ headers: { host: 'node.ts.net' } });
  // The status is an answer rather than an error: the person on another device is told why
  const status = await app.inject({ url: '/api/terminal', remoteAddress: '192.168.1.9', headers: { host: 'lan.test' } });
  assert.equal(status.statusCode, 200);
  assert.deepEqual([status.json<TerminalStatus>().available, status.json<TerminalStatus>().reason], [false, 'needs-auth']);
});

/** What the dev server's `xfwd: true` adds (apps/web/vite.config.ts), with its `changeOrigin: true` Host */
const proxied = (client: string, page: string, extra: Record<string, string> = {}) => ({
  headers: { host: '127.0.0.1:8798', 'x-forwarded-for': client, 'x-forwarded-host': page, origin: `http://${page}`, ...extra },
});

test('behind the dev proxy, a LAN client is refused and a client on this machine is let in and gets a ticket', async (t) => {
  const w = await wrapper(t);
  const { app } = w;
  const terminal = await openTerminal(t, w);
  const refused = async (options: InjectOptions) => {
    const res = await app.inject({ url: '/api/terminals', ...options });
    assert.equal(res.statusCode, 403, JSON.stringify(options));
    assert.equal(res.json<{ reason: string }>().reason, 'needs-auth');
  };
  // A phone on the LAN browsing the dev server: the proxy is on loopback, the client is not
  await refused(proxied('192.168.1.50', '192.168.1.184:5180'));
  // The same page with a client that claims to be local while the page's own name is the LAN's
  await refused(proxied('127.0.0.1', '192.168.1.184:5180'));
  // A hop in the middle that is not loopback
  await refused(proxied('127.0.0.1, 192.168.1.50', 'localhost:5180'));
  // A forged chain from a peer that is not loopback is not believed, whatever it says
  await refused({ ...proxied('127.0.0.1', 'localhost:5180'), remoteAddress: '192.168.1.50' });
  // The standard header is never parsed: its presence is enough to refuse
  await refused({ ...proxied('127.0.0.1', 'localhost:5180', { forwarded: 'for=127.0.0.1' }) });
  // Forwarded host with no forwarded client says nothing a loopback client would write
  await refused({ headers: { host: '127.0.0.1:8798', 'x-forwarded-host': 'localhost:5180' } });

  for (const [client, page] of [['127.0.0.1', 'localhost:5180'], ['::1', '127.0.0.1:5180'], ['::ffff:127.0.0.1', '[::1]:5180']] as const) {
    assert.equal((await app.inject({ url: '/api/terminals', ...proxied(client, page) })).statusCode, 200, `${client} on ${page}`);
  }
  if (!terminal) return;
  // The ticket compares the Origin with the page's authority the proxy forwarded, not with the Host it rewrote
  const ticket = await app.inject({ method: 'POST', url: `/api/terminals/${terminal.id}/ticket`, ...proxied('127.0.0.1', 'localhost:5180') });
  assert.equal(ticket.statusCode, 200, ticket.body);
  const foreign = await app.inject({ method: 'POST', url: `/api/terminals/${terminal.id}/ticket`, ...proxied('127.0.0.1', 'localhost:5180', { origin: 'http://evil.test' }) });
  assert.equal(foreign.statusCode, 403);
  assert.equal(foreign.json<{ code: string }>().code, 'terminal.bad-origin');
});

test('without a proxy the ticket still compares the Origin with the Host, and a forwarded host is not believed from elsewhere', async (t) => {
  const w = await wrapper(t);
  const { app } = w;
  const terminal = await openTerminal(t, w);
  if (!terminal) return;
  const url = `/api/terminals/${terminal.id}/ticket`;
  assert.equal((await app.inject({ method: 'POST', url, headers: { host: 'localhost:8797', origin: 'http://localhost:8797' } })).statusCode, 200);
  // Same-origin by the Host the API sees, with no proxy: the page is on another port
  assert.equal((await app.inject({ method: 'POST', url, headers: { host: '127.0.0.1:8798', origin: 'http://localhost:5180' } })).statusCode, 403);
  // A forwarded host written by a client that is not on loopback must not turn a foreign Origin into the page's own
  const forged = await app.inject({ method: 'POST', url, remoteAddress: '192.168.1.50', headers: { host: '127.0.0.1:8798', 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': 'evil.test', origin: 'http://evil.test' } });
  assert.equal(forged.statusCode, 403);
  assert.equal(forged.json<{ reason: string }>().reason, 'needs-auth');
});

test('under a token a proxied request is judged by its credential as before', async (t) => {
  const { app } = await wrapper(t);
  const token = await withToken(app);
  const res = await app.inject({ url: '/api/terminals', ...proxied('192.168.1.50', '192.168.1.184:5180'), headers: { ...proxied('192.168.1.50', '192.168.1.184:5180').headers, authorization: `Bearer ${token}` } });
  // `remote` defaults to the tunnel: the owner's token from the LAN is told to use it
  assert.equal(res.statusCode, 403);
  assert.equal(res.json<{ reason: string }>().reason, 'needs-tunnel');
});

test('under a token: no credential is 401, a chat token and the desktop secret are 403 on every route, reads too', async (t) => {
  const { app, core } = await wrapper(t, { env: { CLAUDIO_DESKTOP_TOKEN: 'a-per-launch-secret-of-32-random-bytes' } });
  const token = await withToken(app);
  const chat = core.security.chatTokens.mint('chat-1');
  for (const [method, url] of ROUTES) {
    // The socket carries its own proof, a ticket that a chat can never mint (the ticket route refuses it)
    if (url.endsWith('/socket')) continue;
    if (!url.endsWith('/socket')) assert.equal((await call(app, method, url)).statusCode, 401, `${method} ${url} without a credential`);
    const asChat = await call(app, method, url, bearer(chat));
    assert.equal(asChat.statusCode, 403, `${method} ${url} as a chat`);
    assert.equal(asChat.json<{ reason: string }>().reason, 'chat-token');
    if (url.endsWith('/socket')) continue;
    const asDesktop = await call(app, method, url, bearer('a-per-launch-secret-of-32-random-bytes', { host: '127.0.0.1:43123' }));
    assert.equal(asDesktop.statusCode, 403, `${method} ${url} as the desktop`);
  }
  assert.equal((await app.inject({ url: '/api/terminals', ...bearer(token) })).statusCode, 200);
  // What a chat tried is in the history, for the owner to see
  const history = (await app.inject({ url: '/api/terminal/history', ...bearer(token) })).json<TerminalHistoryPage>();
  assert.ok(history.entries.some((entry) => entry.attachments.some((a) => a.refused === 'chat-token' && a.actor === 'chat:chat-1')));
});

test('under mode none a chat that names itself is refused whatever the mode', async (t) => {
  const { app, core } = await wrapper(t);
  const chat = core.security.chatTokens.mint('chat-2');
  const res = await app.inject({ url: '/api/terminals', ...bearer(chat) });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json<{ reason: string }>().reason, 'chat-token');
});

test('the owner from another device follows `remote`: tunnel only by default, any over the LAN, off nowhere', async (t) => {
  const { app, core } = await wrapper(t, { env: { CLAUDIO_ALLOWED_HOSTS: 'lan.test' } });
  core.appSettings.runtimeHosts.add('node.ts.net');
  const token = await withToken(app);
  const lan = { remoteAddress: '192.168.1.9', ...bearer(token, { host: 'lan.test' }) };
  const tunnel = { remoteAddress: '127.0.0.1', ...bearer(token, { host: 'node.ts.net' }) };
  const reason = async (options: InjectOptions) => {
    const res = await app.inject({ url: '/api/terminals', ...options });
    return [res.statusCode, res.statusCode === 403 ? res.json<{ reason: string }>().reason : null];
  };

  assert.deepEqual(await reason(lan), [403, 'needs-tunnel']);
  assert.deepEqual(await reason(tunnel), [200, null]);
  // The name alone is not the tunnel: it has to arrive from the process that forwards it
  assert.deepEqual(await reason({ remoteAddress: '192.168.1.9', ...bearer(token, { host: 'node.ts.net' }) }), [403, 'needs-tunnel']);

  await core.terminals.updateSettings({ remote: 'any' });
  assert.deepEqual(await reason(lan), [200, null]);
  await core.terminals.updateSettings({ remote: 'off' });
  assert.deepEqual(await reason(lan), [403, 'remote-off']);
  assert.deepEqual(await reason(tunnel), [403, 'remote-off']);
  // This machine is always allowed, with the token
  assert.equal((await app.inject({ url: '/api/terminals', ...bearer(token) })).statusCode, 200);
});

test('a request from a chat process is refused as from-agent and written down; an unknown peer fails closed only under none', async (t) => {
  const none = await wrapper(t, { verdict: 'agent' });
  const refused = await none.app.inject('/api/terminals');
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.json<{ reason: string }>().reason, 'from-agent');
  assert.ok(none.core.terminals.history().entries.some((entry) => entry.attachments.some((a) => a.refused === 'from-agent')));

  const unknown = await wrapper(t, { verdict: 'unknown' });
  const closed = await unknown.app.inject('/api/terminals');
  assert.deepEqual([closed.statusCode, closed.json<{ reason: string }>().reason], [403, 'needs-auth']);
  const token = await withToken(unknown.app);
  assert.equal((await unknown.app.inject({ url: '/api/terminals', ...bearer(token) })).statusCode, 200);
});

test('turning the terminal off is allowed to the owner however they came, and closes nothing it should not', async (t) => {
  const { app, core } = await wrapper(t, { env: { CLAUDIO_ALLOWED_HOSTS: 'lan.test' } });
  const token = await withToken(app);
  const lan = { remoteAddress: '192.168.1.9', ...authed(token, { enabled: true }, { host: 'lan.test' }) };
  // Turning it on from the network is refused; turning it off is not
  assert.equal((await app.inject({ method: 'PUT', url: '/api/terminal/settings', ...lan })).statusCode, 403);
  const off = await app.inject({ method: 'PUT', url: '/api/terminal/settings', remoteAddress: '192.168.1.9', ...authed(token, { enabled: false }, { host: 'lan.test' }) });
  assert.equal(off.statusCode, 200);
  assert.equal(core.terminals.status().enabled, false);
});

function authed(token: string, body: unknown, extra: Record<string, string> = {}) {
  return { payload: JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...extra } };
}

// ---------- tickets, origin, the log ----------

test('a ticket is single use, lasts 30 seconds, and is bound to its terminal and its Origin', () => {
  let now = 1_000_000;
  const tickets = new TerminalTickets(() => now);
  const origin = 'http://localhost:8797';

  const first = tickets.mint('term_a', 'local', origin);
  assert.equal(tickets.consume(first.ticket, 'term_a', origin), 'local');
  assert.equal(tickets.consume(first.ticket, 'term_a', origin), null, 'used');

  const late = tickets.mint('term_a', 'token:1', origin);
  now += TICKET_TTL_MS;
  assert.equal(tickets.consume(late.ticket, 'term_a', origin), null, 'expired');

  const bound = tickets.mint('term_a', 'local', origin);
  assert.equal(tickets.consume(bound.ticket, 'term_b', origin), null, 'another terminal');
  assert.equal(tickets.consume(bound.ticket, 'term_a', origin), null, 'spent by the wrong try');

  const foreign = tickets.mint('term_a', 'local', origin);
  assert.equal(tickets.consume(foreign.ticket, 'term_a', 'http://evil.example'), null, 'another origin');
  const none = tickets.mint('term_a', 'local', null);
  assert.equal(tickets.consume(none.ticket, 'term_a', null), null, 'a ticket minted with no Origin opens nothing');
  assert.equal(tickets.consume('', 'term_a', origin), null);
});

test('the logged URL has no ticket and no token in it', () => {
  assert.equal(redactUrl('/api/terminals/term_a/socket?ticket=abc_DEF-123'), '/api/terminals/term_a/socket?ticket=[redacted]');
  assert.equal(redactUrl('/api/events?token=secret&x=1'), '/api/events?token=[redacted]&x=1');
  assert.equal(redactUrl('/api/events?x=1&token=secret'), '/api/events?x=1&token=[redacted]');
  assert.equal(redactUrl('/api/projects'), '/api/projects');
});

// ---------- the socket, against a real listener ----------

interface Open {
  base: string;
  ws: (id: string, query: string, origin: string | null) => WebSocket;
}

async function listen(t: TestContext, app: FastifyInstance): Promise<Open> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${String(port)}`;
  return {
    base,
    ws: (id, query, origin) => {
      const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/api/terminals/${id}/socket${query}`, origin === null ? {} : { origin });
      t.after(() => socket.terminate());
      return socket;
    },
  };
}

const sameOrigin = (open: Open) => ({ host: open.base.slice('http://'.length), origin: open.base });

/** What an upgrade that was refused answered, or `101` when it went through */
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

async function ticketFor(app: FastifyInstance, open: Open, id: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: `/api/terminals/${id}/ticket`, headers: sameOrigin(open) });
  assert.equal(res.statusCode, 200, res.body);
  return res.json<TerminalTicket>().ticket;
}

/** A shell to talk to, or a skipped test where node-pty cannot load */
async function openTerminal(t: TestContext, w: Wrapper): Promise<Terminal | null> {
  const res = await w.app.inject({ method: 'POST', url: '/api/terminals', ...json({ projectId: w.projectId }) });
  if (res.statusCode === 409 && /pty-missing|not available/.test(res.body)) {
    t.skip('node-pty cannot load here');
    return null;
  }
  assert.equal(res.statusCode, 201, res.body);
  return res.json<Terminal>();
}

/** Everything a socket says, as it arrives */
class Session {
  readonly frames: TerminalServerFrame[] = [];
  text = '';
  constructor(readonly socket: WebSocket) {
    socket.on('message', (data, binary) => {
      if (binary) this.text += (data as Buffer).toString('utf8');
      else this.frames.push(JSON.parse((data as Buffer).toString('utf8')) as TerminalServerFrame);
    });
  }
  async until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) assert.fail(`timed out waiting for ${what}; output so far: ${JSON.stringify(this.text.slice(-300))}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  type(data: string): void {
    this.socket.send(Buffer.from(data));
  }
  get hello(): Extract<TerminalServerFrame, { type: 'hello' }> | undefined {
    return this.frames.find((f): f is Extract<TerminalServerFrame, { type: 'hello' }> => f.type === 'hello');
  }
}

async function attach(app: FastifyInstance, open: Open, id: string): Promise<Session> {
  const socket = open.ws(id, `?ticket=${await ticketFor(app, open, id)}`, open.base);
  assert.equal(await outcome(socket), 101);
  const session = new Session(socket);
  await session.until(() => session.hello !== undefined, 'hello');
  return session;
}

test('the Origin must be the page’s own: missing or foreign is 403 before the upgrade, the same origin is 101', async (t) => {
  const w = await wrapper(t);
  const open = await listen(t, w.app);
  const terminal = await openTerminal(t, w);
  if (!terminal) return;

  const noOrigin = open.ws(terminal.id, `?ticket=${await ticketFor(w.app, open, terminal.id)}`, null);
  assert.equal(await outcome(noOrigin), 403);
  const foreign = open.ws(terminal.id, `?ticket=${await ticketFor(w.app, open, terminal.id)}`, 'http://evil.example');
  assert.equal(await outcome(foreign), 403);
  // The refusal did not spend a ticket it never looked at, and it is in the history
  const ok = open.ws(terminal.id, `?ticket=${await ticketFor(w.app, open, terminal.id)}`, open.base);
  assert.equal(await outcome(ok), 101);
  assert.ok(w.core.terminals.history().entries.some((entry) => entry.attachments.some((a) => a.refused === 'bad-origin')));
  // A ticket for a page this wrapper did not serve is not given
  const minted = await w.app.inject({ method: 'POST', url: `/api/terminals/${terminal.id}/ticket`, headers: { ...sameOrigin(open), origin: 'http://evil.example' } });
  assert.equal(minted.statusCode, 403);
});

test('a wrong, used or missing ticket is 401, and enough of them make the address wait', async (t) => {
  const w = await wrapper(t);
  const open = await listen(t, w.app);
  const terminal = await openTerminal(t, w);
  if (!terminal) return;

  assert.equal(await outcome(open.ws(terminal.id, '', open.base)), 401);
  const ticket = await ticketFor(w.app, open, terminal.id);
  assert.equal(await outcome(open.ws(terminal.id, `?ticket=${ticket}`, open.base)), 101);
  assert.equal(await outcome(open.ws(terminal.id, `?ticket=${ticket}`, open.base)), 401, 'a ticket opens once');
  for (let i = 0; i < 9; i += 1) assert.equal(await outcome(open.ws(terminal.id, `?ticket=wrong-${String(i)}`, open.base)), 401);
  assert.equal(await outcome(open.ws(terminal.id, `?ticket=wrong-again`, open.base)), 429, 'the failures counted');
});

test('a socket for no terminal, or from a request that is not an upgrade, is refused', async (t) => {
  const w = await wrapper(t);
  const open = await listen(t, w.app);
  assert.equal(await outcome(open.ws('term_nothing', '?ticket=x', open.base)), 404);
  assert.equal((await w.app.inject({ url: '/api/terminals/term_nothing/socket' })).statusCode, 426);
});

test('closing the server resolves after a refused upgrade', async (t) => {
  const w = await wrapper(t);
  const open = await listen(t, w.app);
  assert.equal(await outcome(open.ws('term_nothing', '?ticket=x', null)), 403);
  assert.equal(await outcome(open.ws('term_nothing', '?ticket=x', 'http://evil.example')), 403);
  await Promise.race([w.app.close(), new Promise((_, reject) => setTimeout(() => reject(new Error('app.close() never resolved')), 8000).unref())]);
});

test('input reaches the shell, a resize reaches the PTY, and a reload is repainted from the snapshot', async (t) => {
  const w = await wrapper(t);
  const open = await listen(t, w.app);
  const terminal = await openTerminal(t, w);
  if (!terminal) return;

  const first = await attach(w.app, open, terminal.id);
  assert.equal(first.hello?.terminal.id, terminal.id);
  first.type('echo hi-$((6*7))\r');
  await first.until(() => first.text.includes('hi-42'), 'the echo');

  first.socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
  first.type('stty size\r');
  await first.until(() => first.text.includes('30 100'), 'stty size');
  first.socket.send(JSON.stringify({ type: 'ack', bytes: first.text.length }));
  first.socket.close();
  await new Promise((r) => setTimeout(r, 200));

  const second = await attach(w.app, open, terminal.id);
  assert.ok(second.hello?.snapshot.includes('hi-42'), 'the earlier output is in the snapshot');
  assert.deepEqual([second.hello?.cols, second.hello?.rows], [100, 30]);
});

test('the ninth terminal is refused, and so is the fifth client on one', async (t) => {
  const w = await wrapper(t);
  const open = await listen(t, w.app);
  await w.core.terminals.updateSettings({ maxTerminals: 2 });
  const first = await openTerminal(t, w);
  if (!first) return;
  assert.equal((await openTerminal(t, w))?.state, 'running');
  const third = await w.app.inject({ method: 'POST', url: '/api/terminals', ...json({ projectId: w.projectId }) });
  assert.equal(third.statusCode, 409);
  assert.equal(third.json<{ code: string }>().code, 'terminal.limit');

  const sessions: Session[] = [];
  for (let i = 0; i < 4; i += 1) sessions.push(await attach(w.app, open, first.id));
  const fifth = open.ws(first.id, `?ticket=${await ticketFor(w.app, open, first.id)}`, open.base);
  assert.equal(await outcome(fifth), 409);
});

test('DELETE removes a terminal from the list and from every route, and a second DELETE finds nothing', async (t) => {
  const w = await wrapper(t);
  const terminal = await openTerminal(t, w);
  if (!terminal) return;
  assert.deepEqual((await w.app.inject('/api/terminals')).json<Terminal[]>().map((x) => x.id), [terminal.id]);
  assert.equal((await w.app.inject({ method: 'DELETE', url: `/api/terminals/${terminal.id}` })).statusCode, 200);
  assert.deepEqual((await w.app.inject('/api/terminals')).json<Terminal[]>(), []);
  assert.equal((await w.app.inject(`/api/terminals/${terminal.id}`)).statusCode, 404);
  assert.equal((await w.app.inject({ method: 'DELETE', url: `/api/terminals/${terminal.id}` })).statusCode, 404);
});

test('create, ticket and close are audited, and the rows hold counts and never content', async (t) => {
  const w = await wrapper(t);
  const open = await listen(t, w.app);
  const terminal = await openTerminal(t, w);
  if (!terminal) return;
  const session = await attach(w.app, open, terminal.id);
  session.type('echo super-secret-password\r');
  await session.until(() => session.text.includes('super-secret-password'), 'the echo');
  session.socket.close();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await w.app.inject({ method: 'DELETE', url: `/api/terminals/${terminal.id}` })).statusCode, 200);

  const audit = w.core.db.auditPage({}).entries.map((entry) => `${entry.method} ${entry.path}`);
  assert.ok(audit.includes('POST /api/terminals'));
  assert.ok(audit.includes(`POST /api/terminals/${terminal.id}/ticket`));
  assert.ok(audit.includes(`DELETE /api/terminals/${terminal.id}`));

  const history = w.core.terminals.history();
  const entry = history.entries.find((e) => e.id === terminal.id);
  assert.ok(entry);
  assert.equal(entry.endReason, 'closed');
  const attachment = entry.attachments[0];
  assert.ok(attachment && attachment.bytesIn > 0 && attachment.bytesOut > 0);
  assert.equal(JSON.stringify(history).includes('super-secret-password'), false);
});

test('a request from a chat’s own process is refused as from-agent through the real peer check', async (t) => {
  const w = await wrapper(t);
  // The test's own verdict is put back: the check this asks for is the real one
  w.core.terminals.peer.check = Object.getPrototypeOf(w.core.terminals.peer).check.bind(w.core.terminals.peer) as typeof w.core.terminals.peer.check;
  const open = await listen(t, w.app);
  const script = `fetch(process.argv[1] + '/api/terminals').then(async (r) => { process.stdout.write(String(r.status) + ' ' + (await r.text())); process.exit(0); }, () => process.exit(1));`;
  const child = spawn(process.execPath, ['-e', script, open.base], { env: { ...process.env, CLAUDIO_CHAT_ID: 'chat-from-agent' }, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => child.kill('SIGKILL'));
  let out = '';
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
  await new Promise((done) => child.once('close', done));
  assert.match(out, /^403 .*from-agent/);
  assert.ok(w.core.terminals.history().entries.some((entry) => entry.attachments.some((a) => a.refused === 'from-agent')));
});
