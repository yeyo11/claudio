import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@claudio/core';
import { buildApp } from '../src/app.ts';
import { standInGuard } from './fixtures/declared-guard.ts';
import { ClientToolRegistry } from '../src/routes/openai-tools.ts';
import { signInDefault } from './helpers.ts';

// What /v1 answers when the account is at its usage limit (docs/plans/limit-resume-and-credits.md,
// t4): 429 `rate_limit_exceeded` with `Retry-After` counted to the reset the CLI reported, in both APIs.

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude-openai.mjs', import.meta.url));

let root: string;
let core: Core;
let app: FastifyInstance;
let base: string;
let token: string;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'claudio-api-openai-limit-'));
  signInDefault(join(root, 'claude'));
  core = new Core(
    loadConfig({
      CLAUDE_BIN: FAKE,
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
    }),
  );
  standInGuard(core, join(root, 'guard'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui'), clientTools: new ClientToolRegistry() });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${String(address.port)}`;
  core.runtime.apiUrl = `${base}/api`;
  token = (await core.security.setToken({})).token;
});

afterEach(async () => {
  core.runtime.stopAll();
  await new Promise((r) => setTimeout(r, 50));
});

after(async () => {
  await core.shutdown();
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${base}/api/v1/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

interface ErrorBody {
  error: { message: string; type: string; code: string | null };
}

test('a chat completion at the usage limit is a 429 whose Retry-After counts to the reset the CLI reported', async () => {
  const res = await post('chat/completions', { model: 'sonnet', messages: [{ role: 'user', content: 'LIMIT 3600' }] });
  assert.equal(res.status, 429, await res.clone().text());
  const wait = Number(res.headers.get('retry-after'));
  assert.ok(wait > 3500 && wait <= 3600, `Retry-After was ${String(wait)}`);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.error.code, 'rate_limit_exceeded');
  assert.equal(body.error.type, 'rate_limit_error');
});

test('a response at the usage limit is a 429 with the same Retry-After', async () => {
  const res = await post('responses', { model: 'sonnet', input: 'LIMIT 1800' });
  assert.equal(res.status, 429, await res.clone().text());
  const wait = Number(res.headers.get('retry-after'));
  assert.ok(wait > 1700 && wait <= 1800, `Retry-After was ${String(wait)}`);
});

test('a usage limit with no reset reported retries after the cooldown its account is out for', async () => {
  const res = await post('chat/completions', { model: 'sonnet', messages: [{ role: 'user', content: 'LIMIT 0' }] });
  assert.equal(res.status, 429, await res.clone().text());
  // A rejection without a reset leaves the account out for its cooldown (300 s by default), which is when it is looked at again
  const wait = Number(res.headers.get('retry-after'));
  assert.ok(wait > 250 && wait <= 300, `Retry-After was ${String(wait)}`);
  assert.equal(((await res.json()) as ErrorBody).error.code, 'rate_limit_exceeded');
});
