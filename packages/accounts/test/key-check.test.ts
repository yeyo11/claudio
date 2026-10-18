import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AccountStore, checkApiKey, checkCredential } from '../src/index.ts';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs');
const KEY = 'sk-ant-api03-key-never-to-be-kept';

let root: string;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'claudio-key-check-'));
});
after(() => rmSync(root, { recursive: true, force: true }));

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const models = (): Response => json(200, { data: [], has_more: false, first_id: null, last_id: null });
const refused = (): Response => json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });

/** A transport that answers with `answer` and remembers what it was asked */
function transport(answer: () => Response | Error): { fetch: typeof fetch; seen: { url: string; key: string | null }[] } {
  const seen: { url: string; key: string | null }[] = [];
  const fake = (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    seen.push({ url: String(input), key: new Headers(init?.headers).get('x-api-key') });
    const r = answer();
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  };
  return { fetch: fake as typeof fetch, seen };
}

function store(): AccountStore {
  return new AccountStore({ dataDir: mkdtempSync(join(root, 'data-')), defaultDir: mkdtempSync(join(root, 'default-')), claude: FAKE, env: { PATH: process.env.PATH } });
}

describe('checkApiKey', () => {
  it('asks models.list for one model with the key: 200 is valid, 401 refused', async () => {
    const ok = transport(models);
    assert.equal(await checkApiKey(KEY, { fetch: ok.fetch }), 'valid');
    assert.equal(ok.seen.length, 1);
    assert.match(ok.seen[0]?.url ?? '', /^https:\/\/api\.anthropic\.com\/v1\/models\?limit=1$/);
    assert.equal(ok.seen[0]?.key, KEY);
    assert.equal(await checkApiKey(KEY, { fetch: transport(refused).fetch }), 'refused');
  });

  it('is unknown for a network error and for any other status, and does not retry', async () => {
    const down = transport(() => new TypeError('fetch failed'));
    assert.equal(await checkApiKey(KEY, { fetch: down.fetch }), 'unknown');
    assert.equal(down.seen.length, 1);
    for (const status of [403, 429, 500, 529]) assert.equal(await checkApiKey(KEY, { fetch: transport(() => json(status, { type: 'error' })).fetch }), 'unknown', String(status));
  });
});

describe('checkCredential for an account whose runs get a key', () => {
  it('judges an api-key account and the default account with a key in its environment', async () => {
    const s = store();
    const acc = await s.add({ kind: 'api-key', alias: 'key', secret: KEY });
    assert.equal(await checkCredential(s.ref(acc.id), { claude: FAKE, env: {}, fetch: transport(models).fetch }), 'valid');
    assert.equal(await checkCredential(s.ref('default'), { claude: FAKE, env: { ANTHROPIC_API_KEY: KEY }, fetch: transport(refused).fetch }), 'refused');
  });

  it('leaves a key it cannot judge alone: another backend; a login is asked of the CLI, not of Anthropic', async () => {
    const s = store();
    const acc = await s.add({ kind: 'api-key', alias: 'key', secret: KEY });
    for (const other of [{ ANTHROPIC_BASE_URL: 'https://gateway.example' }, { CLAUDE_CODE_USE_BEDROCK: '1' }, { CLAUDE_CODE_USE_VERTEX: '1' }]) {
      const t = transport(refused);
      assert.equal(await checkCredential(s.ref(acc.id), { claude: FAKE, env: other, fetch: t.fetch }), 'unknown');
      assert.equal(t.seen.length, 0, JSON.stringify(other));
    }
    const t = transport(refused);
    assert.equal(await checkCredential(s.ref('default'), { claude: FAKE, env: { PATH: process.env.PATH }, fetch: t.fetch }), 'valid');
    assert.equal(t.seen.length, 0);
  });
});

describe('AccountStore.check with a key', () => {
  it('confirms a key that is accepted and marks one that is refused as expired', async () => {
    const s = store();
    const acc = await s.add({ kind: 'api-key', alias: 'key', secret: KEY });
    assert.equal(s.usesApiKey(acc.id), true);
    assert.equal(s.get(acc.id).checkedAt, null);
    assert.equal(await s.check(acc.id, { fetch: transport(models).fetch }), 'valid');
    assert.ok(s.get(acc.id).checkedAt);
    assert.equal(await s.check(acc.id, { fetch: transport(refused).fetch }), 'refused');
    assert.equal(s.get(acc.id).signInState, 'expired');
    assert.equal(s.get(acc.id).signedIn, false);
    assert.equal(await s.check(acc.id, { fetch: transport(models).fetch }), 'valid');
    assert.notEqual(s.get(acc.id).signInState, 'expired');
  });

  it('changes nothing on an unknown answer', async () => {
    const s = store();
    const acc = await s.add({ kind: 'api-key', alias: 'key', secret: KEY });
    assert.equal(await s.check(acc.id, { fetch: transport(() => new TypeError('offline')).fetch }), 'unknown');
    assert.equal(s.get(acc.id).checkedAt, null);
    assert.notEqual(s.get(acc.id).signInState, 'expired');
  });

  it('lists a changed key as never checked, and stores only a hash of the key', async () => {
    const dataDir = mkdtempSync(join(root, 'data-'));
    const s = new AccountStore({ dataDir, defaultDir: mkdtempSync(join(root, 'default-')), claude: FAKE, env: { PATH: process.env.PATH } });
    const acc = await s.add({ kind: 'api-key', alias: 'key', secret: KEY });
    await s.check(acc.id, { fetch: transport(models).fetch });
    assert.ok(s.get(acc.id).checkedAt);
    writeFileSync(join(s.ref(acc.id).dir, 'secret'), 'sk-ant-api03-another\n');
    assert.equal(s.get(acc.id).checkedAt, null);
    const doc = readFileSync(join(dataDir, 'accounts.json'), 'utf8');
    assert.match(doc, /"checkedFingerprint": "[0-9a-f]{64}"/);
    assert.ok(!doc.includes(KEY));
  });

  it('checks the default account on the key of the environment it runs in', async () => {
    const s = new AccountStore({
      dataDir: mkdtempSync(join(root, 'data-')),
      defaultDir: mkdtempSync(join(root, 'default-')),
      claude: FAKE,
      env: { PATH: process.env.PATH },
      defaultEnv: () => ({ PATH: process.env.PATH, ANTHROPIC_API_KEY: KEY }),
    });
    assert.equal(s.usesApiKey('default'), true);
    const t = transport(models);
    assert.equal(await s.check('default', { fetch: t.fetch }), 'valid');
    assert.equal(t.seen[0]?.key, KEY);
    assert.ok(s.get('default').checkedAt);
  });

  it('lists an OAuth token account unconfirmed until something confirms it, and never asks Anthropic about it', async () => {
    const s = store();
    const acc = await s.add({ kind: 'token', alias: 'tok', secret: 'sk-ant-oat01-invalid' });
    assert.equal(s.usesApiKey(acc.id), false);
    assert.equal(s.get(acc.id).checkedAt, null);
    await s.confirm(acc.id);
    assert.ok(s.get(acc.id).checkedAt);
  });
});
