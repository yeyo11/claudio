import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { Account, AccountLoginSession } from '@claudio/shared';
import { run, type CliIo, type StatusReport } from '../src/cli/run.ts';

const here = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'operator-token-0123456789';

interface Seen {
  method: string;
  path: string;
  auth: string | undefined;
  body: unknown;
}

/** A Claudio that answers the routes `claudio` calls from a script, and records every request. */
async function fakeServer(handle: (req: Seen, res: ServerResponse) => void) {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const entry: Seen = { method: req.method ?? '', path: req.url ?? '', auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null };
      seen.push(entry);
      if (req.headers.authorization !== `Bearer ${TOKEN}` && entry.path !== '/api/ready') return json(res, 401, { error: 'authentication required', mode: 'token' });
      handle(entry, res);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return { url, seen, close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        // A request the command aborted (Ctrl-C) leaves its socket open; close() would wait for it
        server.closeAllConnections();
      }),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

const account = (over: Partial<Account> = {}): Account => ({
  id: 'default',
  kind: 'login',
  alias: null,
  email: 'ops@example.com',
  organization: null,
  plan: 'max',
  enabled: true,
  signedIn: true,
  signInState: 'ok',
  checkedAt: '2026-10-28T10:00:00.000Z',
  limits: null,
  ...over,
});

const session = (over: Partial<AccountLoginSession> = {}): AccountLoginSession => ({
  id: 'login-1',
  accountId: 'default',
  state: 'starting',
  url: null,
  startedAt: '2026-10-28T10:00:00.000Z',
  endedAt: null,
  account: null,
  ...over,
});

const PAGE = 'https://claude.ai/oauth/authorize?code=true';
const waiting = session({ state: 'waiting-for-person', url: PAGE });
const over = (state: AccountLoginSession['state'], extra: Partial<AccountLoginSession> = {}) => session({ state, url: PAGE, endedAt: '2026-10-28T10:01:00.000Z', ...extra });

/** The process side of the command, captured; `code` is what the person types (a function to wait or interrupt). */
function io(opts: { env?: NodeJS.ProcessEnv; code?: (signal: AbortSignal, interrupt: AbortController) => Promise<string | null> } = {}) {
  const interrupt = new AbortController();
  let out = '';
  let err = '';
  const prompts: string[] = [];
  const value: CliIo = {
    env: opts.env ?? { CLAUDIO_AUTH_TOKEN: TOKEN },
    out: (t) => (out += t),
    err: (t) => (err += t),
    readSecret: (prompt, signal) => {
      prompts.push(prompt);
      return (opts.code ?? (() => Promise.resolve('the-code')))(signal, interrupt);
    },
    interrupt: interrupt.signal,
    pollMs: 5,
  };
  return { io: value, interrupt, prompts, out: () => out, err: () => err };
}

/** Waits for `signal` to abort and rejects with its reason, as a prompt the person never answers */
const never = (signal: AbortSignal): Promise<string | null> =>
  new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true }));

/** A sign-in that starts, shows its page after one read, and ends as `final` once a code arrives. */
function signIn(final: () => AccountLoginSession, opts: { codeStatus?: number } = {}) {
  let reads = 0;
  let coded = false;
  let cancelled = false;
  return {
    get cancelled() {
      return cancelled;
    },
    handle(req: Seen, res: ServerResponse) {
      if (req.method === 'POST' && /^\/api\/accounts\/[^/]+\/login$/.test(req.path)) return json(res, 201, session());
      if (req.method === 'GET' && req.path === '/api/accounts/logins/login-1') {
        reads++;
        if (cancelled) return json(res, 200, over('cancelled'));
        if (coded) return json(res, 200, final());
        return json(res, 200, reads === 1 ? session() : waiting);
      }
      if (req.method === 'POST' && req.path === '/api/accounts/logins/login-1/code') {
        coded = true;
        if (opts.codeStatus === 409) return json(res, 409, { error: 'this sign-in is already over' });
        return json(res, 200, waiting);
      }
      if (req.method === 'DELETE' && req.path === '/api/accounts/logins/login-1') {
        cancelled = true;
        return json(res, 200, waiting);
      }
      json(res, 404, { error: 'route not found' });
    },
  };
}

test('login prints the page, sends the code it read without echo, and ends 0 once signed in', async () => {
  const flow = signIn(() => over('succeeded', { account: account() }));
  const server = await fakeServer((req, res) => flow.handle(req, res));
  const c = io();
  try {
    assert.equal(await run(['login', '--url', server.url], c.io), 0);
    assert.ok(c.out().includes(PAGE), c.out());
    assert.match(c.out(), /Signed in as ops@example\.com \(max\)\./);
    assert.deepEqual(c.prompts, ['Code: ']);
    assert.equal(server.seen[0]?.path, '/api/accounts/default/login');
    const code = server.seen.find((r) => r.path.endsWith('/code'));
    assert.deepEqual(code?.body, { code: 'the-code' });
    assert.ok(server.seen.every((r) => r.auth === `Bearer ${TOKEN}`), 'every request carries the token');
    assert.ok(!server.seen.some((r) => r.method === 'DELETE'), 'a finished sign-in is not cancelled');
    assert.ok(!c.out().includes('the-code') && !c.err().includes('the-code'), 'the code is never printed');
  } finally {
    await server.close();
  }
});

test('login --account signs that account in', async () => {
  const flow = signIn(() => over('succeeded', { accountId: 'acc-2', account: account({ id: 'acc-2', email: null, alias: 'Work' }) }));
  const server = await fakeServer((req, res) => flow.handle(req, res));
  const c = io();
  try {
    assert.equal(await run(['login', '--url', server.url, '--account', 'acc-2'], c.io), 0);
    assert.equal(server.seen[0]?.path, '/api/accounts/acc-2/login');
    assert.match(c.out(), /Signed in as Work \(max\)\./);
  } finally {
    await server.close();
  }
});

test('login ends 1 when Claude Code does not accept the code', async () => {
  const flow = signIn(() => over('failed'));
  const server = await fakeServer((req, res) => flow.handle(req, res));
  const c = io();
  try {
    assert.equal(await run(['login', '--url', server.url], c.io), 1);
    assert.match(c.err(), /sign-in failed/);
  } finally {
    await server.close();
  }
});

test('login reads what the sign-in ended as when the code arrives too late (409)', async () => {
  const flow = signIn(() => over('expired'), { codeStatus: 409 });
  const server = await fakeServer((req, res) => flow.handle(req, res));
  const c = io();
  try {
    assert.equal(await run(['login', '--url', server.url], c.io), 1);
    assert.match(c.err(), /expired/);
  } finally {
    await server.close();
  }
});

test('login stops the prompt and ends 1 when the sign-in expires while the person reads the page', async () => {
  let reads = 0;
  const server = await fakeServer((req, res) => {
    if (req.method === 'POST') return json(res, 201, waiting);
    reads++;
    json(res, 200, reads < 3 ? waiting : over('expired'));
  });
  const c = io({ code: never });
  try {
    assert.equal(await run(['login', '--url', server.url], c.io), 1);
    assert.match(c.err(), /expired before a code was entered/);
    assert.ok(!server.seen.some((r) => r.method === 'DELETE'));
  } finally {
    await server.close();
  }
});

test('login ends 1 without a prompt when the CLI fails before it prints a page', async () => {
  const server = await fakeServer((req, res) => (req.method === 'POST' ? json(res, 201, session()) : json(res, 200, session({ state: 'failed', endedAt: '2026-10-28T10:00:01.000Z' }))));
  const c = io();
  try {
    assert.equal(await run(['login', '--url', server.url], c.io), 1);
    assert.deepEqual(c.prompts, []);
  } finally {
    await server.close();
  }
});

test('Ctrl-C at the prompt cancels the sign-in on the server and ends 1', async () => {
  const flow = signIn(() => over('succeeded', { account: account() }));
  const server = await fakeServer((req, res) => flow.handle(req, res));
  const c = io({
    code: (signal, interrupt) => {
      setTimeout(() => interrupt.abort(), 20);
      return never(signal);
    },
  });
  try {
    assert.equal(await run(['login', '--url', server.url], c.io), 1);
    assert.ok(flow.cancelled, 'DELETE /api/accounts/logins/:id was sent');
    assert.match(c.err(), /Cancelled/);
    assert.ok(!server.seen.some((r) => r.path.endsWith('/code')));
  } finally {
    await server.close();
  }
});

test('Ctrl-C while the code is checked cancels too', async () => {
  const c = io();
  const flow = signIn(() => {
    c.interrupt.abort();
    return waiting;
  });
  const server = await fakeServer((req, res) => flow.handle(req, res));
  try {
    assert.equal(await run(['login', '--url', server.url], c.io), 1);
    assert.ok(flow.cancelled);
  } finally {
    await server.close();
  }
});

test('an end of input instead of a code cancels the sign-in and is a usage error', async () => {
  const flow = signIn(() => over('succeeded'));
  const server = await fakeServer((req, res) => flow.handle(req, res));
  const c = io({ code: () => Promise.resolve(null) });
  try {
    assert.equal(await run(['login', '--url', server.url], c.io), 2);
    assert.ok(flow.cancelled);
    assert.match(c.err(), /no code was entered/);
  } finally {
    await server.close();
  }
});

test('an empty line asks for the code again', async () => {
  const flow = signIn(() => over('succeeded', { account: account() }));
  const server = await fakeServer((req, res) => flow.handle(req, res));
  const typed = ['', '  ', ' the-code '];
  const c = io({ code: () => Promise.resolve(typed.shift() ?? null) });
  try {
    assert.equal(await run(['login', '--url', server.url], c.io), 0);
    assert.equal(c.prompts.length, 3);
    assert.deepEqual(server.seen.find((r) => r.path.endsWith('/code'))?.body, { code: 'the-code' });
  } finally {
    await server.close();
  }
});

test('a refused token is a usage error that names the fix, for both commands', async () => {
  const server = await fakeServer((req, res) => (req.path === '/api/ready' ? json(res, 200, { ready: true }) : json(res, 500, {})));
  try {
    for (const command of ['login', 'status']) {
      const c = io({ env: { CLAUDIO_AUTH_TOKEN: 'wrong' } });
      assert.equal(await run([command, '--url', server.url], c.io), 2, command);
      assert.match(c.err(), /refused the credential \(401\).*--token/, command);
    }
  } finally {
    await server.close();
  }
});

test('a server that is down is a connection error (2), for both commands', async () => {
  const server = await fakeServer((_req, res) => json(res, 500, {}));
  const { url } = server;
  await server.close();
  for (const command of ['login', 'status']) {
    const c = io();
    assert.equal(await run([command, '--url', url], c.io), 2, command);
    assert.match(c.err(), new RegExp(`cannot reach Claudio at ${url.replace(/\./g, '\\.')}: ECONNREFUSED`), command);
  }
});

test('a login for an account that does not exist fails with the server\'s words', async () => {
  const server = await fakeServer((_req, res) => json(res, 404, { error: 'account nope not found' }));
  const c = io();
  try {
    assert.equal(await run(['login', '--url', server.url, '--account', 'nope'], c.io), 1);
    assert.match(c.err(), /account nope not found/);
  } finally {
    await server.close();
  }
});

/** A server whose readiness and account are given */
function statusServer(ready: { status: number; body: unknown }, opts: { inUse?: boolean; limits?: Account['limits'] } = {}) {
  return fakeServer((req, res) => {
    if (req.path === '/api/ready') return json(res, ready.status, ready.body);
    if (req.path === '/api/system') {
      return json(res, 200, {
        version: '0.11.0',
        profile: 'headless',
        cli: { installed: true, version: '2.1.302', path: '/usr/bin/claude' },
        auth: {
          loggedIn: opts.inUse !== false,
          tokenSource: 'none',
          inUse: opts.inUse === false ? null : { id: 'default', label: 'ops@example.com', kind: 'login', signInState: 'ok', checkedAt: '2026-10-28T10:00:00.000Z' },
        },
      });
    }
    if (req.path === '/api/accounts') return json(res, 200, [account({ limits: opts.limits ?? null })]);
    json(res, 404, { error: 'route not found' });
  });
}

test('status says ready with the account and its usage, and ends 0', async () => {
  const limits: Account['limits'] = { state: 'ok', window: 'five_hour', utilization: 0.42, resetsAt: '2026-10-28T15:00:00.000Z', windows: {}, observedAt: '2026-10-28T10:00:00.000Z', source: 'cli' };
  const server = await statusServer({ status: 200, body: { ready: true } }, { limits });
  const c = io();
  try {
    assert.equal(await run(['status', '--url', server.url], c.io), 0);
    const out = c.out();
    assert.match(out, /^Claudio 0\.11\.0 \(headless\) at http:\/\/127\.0\.0\.1:\d+$/m);
    assert.match(out, /^Ready: yes$/m);
    assert.match(out, /^Claude Code: 2\.1\.302$/m);
    assert.match(out, /^Account: ops@example\.com \(max\), sign-in ok/m);
    assert.match(out, /^Usage: 42% used of the five_hour window, ok, resets 2026-10-28T15:00:00\.000Z/m);
  } finally {
    await server.close();
  }
});

test('status --json prints the readiness, the account and its last usage reading; not ready ends 1', async () => {
  const server = await statusServer({ status: 503, body: { ready: false, reason: 'signed-out' } }, { inUse: false });
  const c = io();
  try {
    assert.equal(await run(['status', '--url', server.url, '--json'], c.io), 1);
    const report = JSON.parse(c.out()) as StatusReport;
    assert.deepEqual(report, {
      url: server.url,
      ready: false,
      reason: 'signed-out',
      version: '0.11.0',
      profile: 'headless',
      cli: { installed: true, version: '2.1.302' },
      account: null,
      usage: null,
    });
    assert.ok(!server.seen.some((r) => r.path === '/api/accounts'), 'no account to read');
  } finally {
    await server.close();
  }
});

test('status in words names why it is not ready', async () => {
  const server = await statusServer({ status: 503, body: { ready: false, reason: 'sign-in-expired' } });
  const c = io();
  try {
    assert.equal(await run(['status', '--url', server.url], c.io), 1);
    assert.match(c.out(), /^Ready: no, the sign-in expired; run `claudio login`$/m);
  } finally {
    await server.close();
  }
});

test('the token comes from --token, else CLAUDIO_AUTH_TOKEN, else the first-run token file', async () => {
  const server = await statusServer({ status: 200, body: { ready: true } });
  const data = mkdtempSync(join(tmpdir(), 'claudio-cli-'));
  try {
    writeFileSync(join(data, 'first-run-token'), `${TOKEN}\n`);
    assert.equal(await run(['status', '--url', server.url], io({ env: { CLAUDIO_DATA_DIR: data } }).io), 0, 'the first-run file');
    assert.equal(await run(['status', '--url', server.url, '--token', TOKEN], io({ env: { CLAUDIO_AUTH_TOKEN: 'wrong' } }).io), 0, '--token wins');
    assert.equal(await run(['status', '--url', server.url], io({ env: { CLAUDIO_AUTH_TOKEN: 'wrong', CLAUDIO_DATA_DIR: data } }).io), 2, 'the variable comes before the file');
    assert.equal(await run(['status', '--url', server.url], io({ env: {} }).io), 2, 'no token at all is sent as none');
    assert.equal(server.seen.at(-1)?.auth, undefined);
  } finally {
    rmSync(data, { recursive: true, force: true });
    await server.close();
  }
});

test('the default URL is this machine on $PORT', async () => {
  const server = await statusServer({ status: 200, body: { ready: true } });
  try {
    const port = new URL(server.url).port;
    assert.equal(await run(['status'], io({ env: { CLAUDIO_AUTH_TOKEN: TOKEN, PORT: port } }).io), 0);
  } finally {
    await server.close();
  }
});

test('usage errors end 2 with the usage; --help ends 0', async () => {
  for (const argv of [[], ['logout'], ['login', 'extra'], ['status', '--bogus'], ['login', '--json'], ['status', '--account', 'x'], ['status', '--url', 'ftp://host'], ['status', '--url', 'not a url'], ['login', '--account', ' ']]) {
    const c = io();
    assert.equal(await run(argv, c.io), 2, argv.join(' '));
    assert.match(c.err(), /Usage:/, argv.join(' '));
  }
  const c = io();
  assert.equal(await run(['--help'], c.io), 0);
  assert.match(c.out(), /claudio login +\[--url URL\] \[--token TOKEN\] \[--account default\]/);
});

// The process side: the entry reads the code from a pipe and cancels on SIGINT
const main = resolve(here, '../src/cli/main.ts');

function spawnCli(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['--import', 'tsx', main, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
  child.stderr.on('data', (c: Buffer) => (out += c.toString('utf8')));
  return { child, out: () => out, exit: once(child, 'exit') as Promise<[number | null, string | null]> };
}

test('the command reads the code from a pipe and exits with the answer', { timeout: 60_000 }, async () => {
  const flow = signIn(() => over('succeeded', { account: account() }));
  const server = await fakeServer((req, res) => flow.handle(req, res));
  try {
    const cli = spawnCli(['login', '--url', server.url], { CLAUDIO_AUTH_TOKEN: TOKEN });
    cli.child.stdin.end('piped-code\n');
    const [code] = await cli.exit;
    assert.equal(code, 0, cli.out());
    assert.deepEqual(server.seen.find((r) => r.path.endsWith('/code'))?.body, { code: 'piped-code' });
  } finally {
    await server.close();
  }
});

test('SIGINT at the prompt cancels the sign-in and exits 1', { timeout: 60_000 }, async () => {
  const flow = signIn(() => over('succeeded'));
  const server = await fakeServer((req, res) => flow.handle(req, res));
  try {
    const cli = spawnCli(['login', '--url', server.url], { CLAUDIO_AUTH_TOKEN: TOKEN });
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`no prompt: ${cli.out()}`)), 30_000);
      cli.child.stdout.on('data', () => {
        if (!cli.out().includes('Code: ')) return;
        clearTimeout(timer);
        done();
      });
    });
    cli.child.kill('SIGINT');
    const [code] = await cli.exit;
    assert.equal(code, 1, cli.out());
    assert.ok(flow.cancelled);
  } finally {
    await server.close();
  }
});
