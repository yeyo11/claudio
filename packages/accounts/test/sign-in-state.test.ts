import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AccountSignInState, AccountsSettings } from '@claudio/shared';
import { AccountStore, choose, readCredentials, type Candidate } from '../src/index.ts';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs');
const NOW = Date.parse('2026-10-15T12:00:00Z');
const REFRESH = 'rt-value-never-to-be-kept';
const ACCESS = 'at-value-never-to-be-kept';

let root: string;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'sign-in-'));
});
after(() => rmSync(root, { recursive: true, force: true }));

const credentials = (dir: string, oauth: Record<string, unknown> | null, mtimeMs?: number): void => {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, '.credentials.json');
  writeFileSync(file, JSON.stringify(oauth ? { claudeAiOauth: oauth } : {}));
  if (mtimeMs !== undefined) utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
};
const complete = { accessToken: ACCESS, refreshToken: REFRESH };

async function fresh(): Promise<{ s: AccountStore; id: string; dir: string; dataDir: string }> {
  const dataDir = mkdtempSync(join(root, 'data-'));
  const env = { PATH: process.env.PATH };
  const s = new AccountStore({ dataDir, defaultDir: mkdtempSync(join(root, 'default-')), claude: FAKE, env });
  const a = await s.add({ kind: 'login' });
  await s.refresh(a.id);
  return { s, id: a.id, dir: s.ref(a.id).dir, dataDir };
}

describe('sign-in state', () => {
  it('is unknown with no credentials file to look at, and ok with a complete one on a signed-in login', async () => {
    const { s, id, dir } = await fresh();
    assert.equal(s.get(id).signInState, 'unknown');
    // The fake CLI says the dir is signed in once it has credentials
    credentials(dir, complete);
    await s.refresh(id);
    const a = s.get(id);
    assert.equal(a.signInState, a.signedIn ? 'ok' : 'unknown');
    assert.equal(s.find('default'), null, 'the default dir has no credential at all: it is no account');
  });

  it('keeps a login with no credentials file signed in and chosen: a keychain, a token or env sign-in is not signed out', async () => {
    const { s, id, dir } = await fresh();
    // The CLI says the dir is signed in (its own marker, not a credentials file), as with a keychain
    writeFileSync(join(dir, 'fake-login.json'), JSON.stringify({ email: 'keychain@example.com', org: 'o' }));
    await s.refresh(id);
    const a = s.get(id);
    assert.deepEqual([a.signedIn, a.signInState, a.authFailedAt], [true, 'unknown', undefined]);
    assert.equal(s.pick({ current: null, now: NOW }).account, id);
    // The CLI's own dir with no file and no key or token in its environment is a ghost, which no
    // path chooses (2026-10-29: only "in use" left it out, and the rotation could still move work onto it)
    assert.equal(s.find('default'), null);
    assert.equal(s.pick({ current: id, failedOn: [id], now: NOW }).account, null);
    // With a credential it is the account it always was: assumed signed in until read
    credentials(s.defaultDir, complete);
    const d = s.get('default');
    assert.deepEqual([d.signedIn, d.signInState], [true, 'ok']);
    await s.setEnabled(id, false);
    assert.equal(s.pick({ current: null, now: NOW }).account, 'default');
  });

  it('flags a file with no, or an empty, refreshToken as incomplete and signed out; a fixed file is read again', async () => {
    const { s, id, dir } = await fresh();
    credentials(dir, { accessToken: ACCESS });
    assert.equal(s.get(id).signInState, 'incomplete');
    assert.equal(s.get(id).signedIn, false);
    credentials(dir, { accessToken: ACCESS, refreshToken: '' }, NOW);
    assert.equal(s.get(id).signInState, 'incomplete');
    credentials(dir, complete, NOW + 10_000);
    assert.notEqual(s.get(id).signInState, 'incomplete');
  });

  it('does not judge a file without an OAuth block', async () => {
    const { s, id, dir } = await fresh();
    credentials(dir, null);
    assert.equal(s.get(id).signInState, 'unknown');
  });

  it('marks an account expired and signed out, stores it, and answers false when marked already', async () => {
    const { s, id, dataDir } = await fresh();
    assert.equal(await s.markAuthFailed(id, NOW), true);
    assert.equal(await s.markAuthFailed(id, NOW + 1000), false);
    const again = new AccountStore({ dataDir, defaultDir: s.defaultDir, claude: FAKE, env: { PATH: process.env.PATH } });
    for (const view of [s.get(id), again.get(id)]) {
      assert.equal(view.signInState, 'expired');
      assert.equal(view.signedIn, false);
      assert.equal(view.authFailedAt, new Date(NOW).toISOString());
    }
  });

  it('marks and clears the default account too', async () => {
    const { s } = await fresh();
    assert.equal(await s.markAuthFailed('default', NOW), true);
    assert.equal(s.get('default').signInState, 'expired');
    assert.equal(await s.clearAuthFailed('default'), true);
    // Cleared, a default dir with no credential is a ghost again
    assert.equal(s.find('default'), null);
  });

  it('clears on a later success, and says false when there was nothing to clear', async () => {
    const { s, id } = await fresh();
    assert.equal(await s.clearAuthFailed(id), false);
    await s.markAuthFailed(id, NOW);
    assert.equal(await s.clearAuthFailed(id), true);
    assert.equal(s.get(id).authFailedAt, undefined);
    assert.notEqual(s.get(id).signInState, 'expired');
  });

  it('clears when the credentials file is newer than the failure, and a failure after that marks again', async () => {
    const { s, id, dir } = await fresh();
    credentials(dir, complete, NOW - 3600_000);
    await s.markAuthFailed(id, NOW);
    assert.equal(s.get(id).signInState, 'expired', 'the file is older than the failure');
    credentials(dir, complete, NOW + 60_000);
    assert.notEqual(s.get(id).signInState, 'expired', 'a new sign-in rewrote the file');
    assert.equal(s.get(id).authFailedAt, undefined);
    assert.equal(await s.markAuthFailed(id, NOW + 120_000), true);
    assert.equal(s.get(id).signInState, 'expired');
    await s.refresh(id);
    assert.equal(s.get(id).signInState, 'expired', 'a refresh keeps a mark nothing has signed in since');
  });

  it('drops a stale mark from accounts.json on refresh', async () => {
    const { s, id, dir, dataDir } = await fresh();
    await s.markAuthFailed(id, NOW);
    credentials(dir, complete, NOW + 60_000);
    await s.refresh(id);
    const doc = JSON.parse(readFileSync(join(dataDir, 'accounts.json'), 'utf8')) as { accounts: Array<{ authFailedAt?: string }> };
    assert.equal(doc.accounts[0]?.authFailedAt, undefined);
  });

  it('a token account is never incomplete; it is expired until a success clears it', async () => {
    const { s } = await fresh();
    const t = await s.add({ kind: 'token', alias: 'ci', secret: 'sk-secret' });
    assert.equal(s.get(t.id).signInState, 'ok');
    await s.markAuthFailed(t.id, NOW);
    assert.equal(s.get(t.id).signInState, 'expired');
    await s.clearAuthFailed(t.id);
    assert.equal(s.get(t.id).signInState, 'ok');
  });

  it('pick never takes an expired or incomplete account', async () => {
    const { s, id, dir } = await fresh();
    const t = await s.add({ kind: 'token', alias: 'ci', secret: 'sk-secret' });
    await s.setEnabled('default', false);
    assert.equal(s.pick({ current: null, now: NOW }).account, t.id);
    await s.markAuthFailed(t.id, NOW);
    assert.equal(s.pick({ current: null, now: NOW }).account, null, 'nobody is usable');
    await s.clearAuthFailed(t.id);
    await s.setEnabled(t.id, false);
    credentials(dir, { accessToken: ACCESS });
    assert.equal(s.pick({ current: id, now: NOW }).account, null, 'an incomplete copy is not taken');
  });

  it('keeps no token value past the presence check, and logs none', async () => {
    const { s, id, dir, dataDir } = await fresh();
    credentials(dir, complete);
    const logged: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => mock.method(console, m, (...a: unknown[]) => void logged.push(a.map(String).join(' '))));
    try {
      const reading = readCredentials(dir);
      await s.markAuthFailed(id, NOW);
      await s.refresh(id);
      const everything = JSON.stringify([reading, s.list(), s.get(id)]) + readFileSync(join(dataDir, 'accounts.json'), 'utf8');
      for (const secret of [REFRESH, ACCESS]) {
        assert.ok(!everything.includes(secret), 'no value in a reading, a list or accounts.json');
        assert.ok(!logged.join('\n').includes(secret), 'no value logged');
      }
      assert.deepEqual(Object.keys(reading ?? {}).sort(), ['complete', 'mtimeMs']);
    } finally {
      for (const spy of spies) spy.mock.restore();
    }
  });
});

describe('choose and the sign-in state', () => {
  const settings: AccountsSettings = { rotateOnLimit: true, threshold: 90, hysteresis: 10, cooldownSeconds: 300, strategy: 'order', preferred: null, order: [] };
  const two = (a: AccountSignInState | undefined, b: AccountSignInState | undefined, pinned?: string): ReturnType<typeof choose> => {
    const accounts: Candidate[] = [
      { id: 'a', enabled: true, signedIn: true, ...(a ? { signInState: a } : {}) },
      { id: 'b', enabled: true, signedIn: true, ...(b ? { signInState: b } : {}) },
    ];
    return choose(accounts, {}, settings, { current: 'a', now: NOW, ...(pinned ? { pinned } : {}) });
  };

  it('allows ok, unknown and an absent state', () => {
    assert.equal(two('ok', 'ok').account, 'a');
    assert.equal(two('unknown', 'ok').account, 'a');
    assert.equal(two(undefined, undefined).account, 'a');
  });

  it('moves off an expired or incomplete current account as a sign-out', () => {
    assert.deepEqual(two('expired', 'ok'), { account: 'b', reason: 'signed-out', waitUntil: null });
    assert.deepEqual(two('incomplete', 'ok'), { account: 'b', reason: 'signed-out', waitUntil: null });
  });

  it('never picks one, and gives nothing to wait for when none is usable', () => {
    assert.equal(two('ok', 'expired').account, 'a');
    assert.deepEqual(two('expired', 'incomplete'), { account: null, reason: null, waitUntil: null });
  });

  it('does not keep a pinned account that is expired', () => {
    assert.equal(two('expired', 'ok', 'a').account, 'b');
  });
});
