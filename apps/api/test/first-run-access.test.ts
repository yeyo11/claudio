import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@claudio/core';
import type { ClaimHostResult, HostRefusal } from '@claudio/shared';
import { buildApp } from '../src/app.ts';
import { CHAT_FORBIDDEN_SYSTEM, hostRefusalPage } from '../src/security.ts';

/*
 * D3 and D5 of docs/plans/container-polish.md: the owner token a container makes on its first start,
 * the refusal of a host nobody listed, and the one route that adds it.
 */

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const bearer = (token: string, extra: Record<string, string> = {}) => ({ headers: { authorization: `Bearer ${token}`, ...extra } });

interface Wrapper {
  app: FastifyInstance;
  core: Core;
  dataDir: string;
}

async function wrapper(t: TestContext, env: NodeJS.ProcessEnv = {}): Promise<Wrapper> {
  const root = mkdtempSync(join(tmpdir(), 'claudio-first-run-'));
  const stdout = process.stdout.write.bind(process.stdout);
  // The first-run block is meant for a log; a test run does not need it
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => (String(chunk).includes('owner token') ? true : (stdout as (...args: unknown[]) => boolean)(chunk, ...rest))) as typeof process.stdout.write;
  const core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
      ...env,
    }),
  );
  process.stdout.write = stdout;
  const app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  t.after(async () => {
    core.shutdown();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { app, core, dataDir: join(root, 'data') };
}

const docker = { CLAUDIO_DISTRIBUTION: 'docker' };

test('a container with no authentication variable asks for the first-run token, and says so in the 401', async (t) => {
  const { app, core, dataDir } = await wrapper(t, docker);
  assert.equal(core.security.mode, 'token');

  const refused = await app.inject('/api/overview');
  assert.equal(refused.statusCode, 401);
  assert.deepEqual(refused.json(), { error: 'authentication required', mode: 'token', firstRunToken: true });

  const file = join(dataDir, 'first-run-token');
  const token = readFileSync(file, 'utf8').trim();
  assert.equal((await app.inject({ url: '/api/overview', ...bearer(token) })).statusCode, 200);
  assert.equal(existsSync(file), false, 'the first request it authenticates deletes the file');

  const after = await app.inject('/api/overview');
  assert.deepEqual(after.json(), { error: 'authentication required', mode: 'token' });
  const audit = (await app.inject({ url: '/api/audit?path=/api/security/token', ...bearer(token) })).json<{ entries: Array<{ summary: string }> }>();
  assert.ok(audit.entries.some((entry) => /Generate the first-run owner token/.test(entry.summary)));
  assert.ok(audit.entries.some((entry) => /used for the first time/.test(entry.summary)));
});

test('outside a container, or with the mode named, no token is made', async (t) => {
  const plain = await wrapper(t);
  assert.equal(plain.core.security.mode, 'none');
  const named = await wrapper(t, { ...docker, CLAUDIO_AUTH_MODE: 'none' });
  assert.equal(named.core.security.mode, 'none');
  assert.equal((await named.app.inject('/api/overview')).statusCode, 200);
});

// ---------- the 421 ----------

test('the 421 says what the app needs to offer a way out', async (t) => {
  const { app } = await wrapper(t, docker);
  const refused = await app.inject({ url: '/api/overview', headers: { host: 'lan.test:8787' } });
  assert.equal(refused.statusCode, 421);
  const body = refused.json<HostRefusal>();
  assert.equal(body.code, 'host-not-allowed');
  assert.equal(body.host, 'lan.test');
  assert.equal(body.mode, 'token');
  assert.equal(body.canClaim, true);
  assert.equal(body.firstRunToken, true);
  assert.match(body.error, /CLAUDIO_ALLOWED_HOSTS/);

  const open = await wrapper(t);
  const none = (await open.app.inject({ url: '/api/overview', headers: { host: 'lan.test' } })).json<HostRefusal>();
  assert.deepEqual([none.mode, none.canClaim, none.firstRunToken], ['none', false, false]);
});

test('a browser typing the URL gets a page, a script gets JSON, and the host is escaped', async (t) => {
  const { app } = await wrapper(t);
  const page = await app.inject({ url: '/docs', headers: { host: 'lan.test', accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' } });
  assert.equal(page.statusCode, 421);
  assert.match(String(page.headers['content-type']), /text\/html/);
  assert.match(page.body, /does not answer to <code>lan\.test<\/code> yet/);
  assert.doesNotMatch(page.body, /<script|<style|<link/);

  const script = await app.inject({ url: '/api/overview', headers: { host: 'lan.test', accept: 'application/json, text/html' } });
  assert.match(String(script.headers['content-type']), /json/);
  const posted = await app.inject({ method: 'POST', url: '/api/projects', headers: { host: 'lan.test', accept: 'text/html', 'content-type': 'application/json' }, payload: '{}' });
  assert.match(String(posted.headers['content-type']), /json/, 'only a GET gets the page');

  const hostile = hostRefusalPage('<img src=x onerror=alert(1)>"&');
  assert.doesNotMatch(hostile, /<img/);
  assert.match(hostile, /&lt;img src=x onerror=alert\(1\)&gt;&quot;&amp;/);
});

// ---------- the claim ----------

test('the owner token adds the host it came in on, and the next request passes', async (t) => {
  const { app, core, dataDir } = await wrapper(t, docker);
  const token = readFileSync(join(dataDir, 'first-run-token'), 'utf8').trim();
  const host = { host: 'lan.test:8787' };

  assert.equal((await app.inject({ url: '/api/overview', ...bearer(token, host) })).statusCode, 421);
  const claimed = await app.inject({ method: 'POST', url: '/api/security/allowed-hosts/claim', ...bearer(token, host) });
  assert.equal(claimed.statusCode, 200, claimed.body);
  assert.deepEqual(claimed.json<ClaimHostResult>(), { host: 'lan.test', allowedHosts: ['lan.test'] });
  assert.deepEqual(core.appSettings.get().allowedHostLayers.file, ['lan.test']);
  assert.equal((await app.inject({ url: '/api/overview', ...bearer(token, host) })).statusCode, 200);

  const again = await app.inject({ method: 'POST', url: '/api/security/allowed-hosts/claim', ...bearer(token, host) });
  assert.deepEqual(again.json<ClaimHostResult>().allowedHosts, ['lan.test'], 'idempotent');
});

test('the claim needs a credential, counts a wrong one, and is refused under none, read-only and to the desktop', async (t) => {
  const { app, dataDir } = await wrapper(t, { ...docker, CLAUDIO_DESKTOP_TOKEN: 'd'.repeat(32) });
  const token = readFileSync(join(dataDir, 'first-run-token'), 'utf8').trim();
  const url = '/api/security/allowed-hosts/claim';
  const host = { host: 'lan.test' };

  assert.equal((await app.inject({ method: 'POST', url, headers: host })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url, ...bearer('not-the-token', host) })).statusCode, 401);
  // From loopback, with the host loopback, the desktop credential is a real one, and is not the owner's
  const desktop = await app.inject({ method: 'POST', url, ...bearer('d'.repeat(32), { host: 'localhost' }) });
  assert.equal(desktop.statusCode, 403);

  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ readOnly: true }), headers: { ...json({}).headers, authorization: `Bearer ${token}` } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url, ...bearer(token, host) })).statusCode, 405);

  const open = await wrapper(t);
  const none = await open.app.inject({ method: 'POST', url, headers: host });
  assert.equal(none.statusCode, 403);
  assert.equal(none.json<{ code: string }>().code, 'host.needs-auth');
});

test('wrong guesses on the claim route count in the same back-off', async (t) => {
  const { app } = await wrapper(t, docker);
  const url = '/api/security/allowed-hosts/claim';
  let last = 0;
  for (let i = 0; i < 12; i += 1) last = (await app.inject({ method: 'POST', url, ...bearer(`wrong-${String(i)}`, { host: 'lan.test' }) })).statusCode;
  assert.equal(last, 429);
});

test('a chat token may not claim a host, update Claudio or install a CLI', async (t) => {
  const { app, core, dataDir } = await wrapper(t, docker);
  const token = readFileSync(join(dataDir, 'first-run-token'), 'utf8').trim();
  await app.inject({ url: '/api/overview', ...bearer(token) });
  const chat = core.security.chatTokens.mint('chat-42');
  const claim = await app.inject({ method: 'POST', url: '/api/security/allowed-hosts/claim', ...bearer(chat) });
  assert.equal(claim.statusCode, 403);
  assert.deepEqual([...CHAT_FORBIDDEN_SYSTEM].sort(), [
    'DELETE /api/system/cli-version/install',
    'DELETE /api/system/server-update/scheduled',
    'POST /api/security/allowed-hosts/claim',
    'POST /api/system/cli-version/install',
    'POST /api/system/server-update/apply',
    'POST /api/system/server-update/download',
    'POST /api/system/server-update/revert',
  ]);
});

// ---------- the terminal in a container ----------

test('in a container the owner token opens the terminal from another device, a chat token does not, and a saved tunnel wins', async (t) => {
  const { app, core, dataDir } = await wrapper(t, { ...docker, CLAUDIO_ALLOWED_HOSTS: 'lan.test' });
  const token = readFileSync(join(dataDir, 'first-run-token'), 'utf8').trim();
  assert.equal(core.terminals.settings().remote, 'any');
  await core.terminals.updateSettings({ enabled: true });

  const lan = { remoteAddress: '172.17.0.1', ...bearer(token, { host: 'lan.test', 'content-type': 'application/json' }) };
  const reasons = ['needs-auth', 'needs-tunnel', 'remote-off'];
  const opened = await app.inject({ method: 'POST', url: '/api/terminals', payload: '{}', ...lan });
  const reason = (opened.json() as { reason?: string }).reason ?? '';
  assert.ok(!reasons.includes(reason), `${String(opened.statusCode)} ${opened.body}`);

  const chat = core.security.chatTokens.mint('chat-42');
  const chatTry = await app.inject({ method: 'POST', url: '/api/terminals', payload: '{}', remoteAddress: '172.17.0.1', ...bearer(chat, { host: 'lan.test', 'content-type': 'application/json' }) });
  assert.equal(chatTry.statusCode, 401, 'a chat token is not looked at from another peer');

  await core.terminals.updateSettings({ remote: 'tunnel' });
  const tunnelled = await app.inject({ method: 'POST', url: '/api/terminals', payload: '{}', ...lan });
  assert.equal((tunnelled.json() as { reason?: string }).reason, 'needs-tunnel');
});
