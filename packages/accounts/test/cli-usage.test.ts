import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AccountLimit } from '@claudio/shared';
import { AccountStore, checkCredential, choose, fold, parseUsage, Readings, readingFromEvent, usageOf, type Reading } from '../src/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, 'fake-claude.mjs');
// The real answer of a Max login, recorded once from CLI 2.1.302 with the personal parts removed
const REAL: unknown = JSON.parse(readFileSync(join(HERE, 'fixtures', 'get-usage-max.json'), 'utf8'));
const NOW = Date.parse('2026-10-17T20:00:00Z');

let root: string;
let defaultDir: string;
let dataDir: string;
const env = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH });

before(() => {
  root = mkdtempSync(join(tmpdir(), 'cli-usage-'));
  defaultDir = join(root, 'default-claude');
  dataDir = join(root, 'data');
  mkdirSync(defaultDir, { recursive: true });
});
after(() => rmSync(root, { recursive: true, force: true }));

describe('parseUsage', () => {
  it('reads the plan, both windows as 0-1 and the model-scoped weekly limit of a real Max answer', () => {
    const r = parseUsage(REAL, NOW);
    assert.equal(r.source, 'cli');
    assert.equal(r.cli?.plan, 'max');
    assert.equal(r.cli?.available, true);
    assert.equal(r.windows.five_hour?.utilization, 0.05);
    assert.equal(r.windows.seven_day?.utilization, 0.27);
    assert.equal(r.windows.seven_day?.resetsAt, Math.floor(Date.parse('2026-10-23T01:59:59.708078Z') / 1000));
    assert.deepEqual(r.cli?.scoped.map((s) => [s.model, s.utilization, s.window]), [['Fable', 0.05, 'seven_day']]);
  });

  it('reads credits that were never enabled as off, with their currency', () => {
    const credits = parseUsage(REAL, NOW).cli?.credits;
    assert.deepEqual(credits, { enabled: false, usedMinor: 0, limitMinor: null, currency: 'USD', exponent: 2, limitReached: false, disabledReason: null, everEnabled: false });
  });

  it('reads enabled credits with a monthly cap and flags a reached cap', () => {
    const base = REAL as { rate_limits: Record<string, unknown> };
    const spend = { used: { amount_minor: 5000, currency: 'EUR', exponent: 2 }, limit: { amount_minor: 5000, currency: 'EUR', exponent: 2 }, enabled: true, disabled_reason: null };
    const extra = { is_enabled: true, spend_limit_reached: true, credits_ever_enabled: true, disabled_reason: null };
    const c = parseUsage({ ...base, rate_limits: { ...base.rate_limits, spend, extra_usage: extra } }, NOW).cli?.credits;
    assert.equal(c?.enabled, true);
    assert.equal(c?.usedMinor, 5000);
    assert.equal(c?.limitMinor, 5000);
    assert.equal(c?.currency, 'EUR');
    assert.equal(c?.limitReached, true);
  });

  it('says an API-key account has no subscription limits', () => {
    const r = parseUsage({ subscription_type: null, rate_limits_available: false }, NOW);
    assert.deepEqual(r.windows, {});
    assert.equal(r.cli?.available, false);
    assert.equal(r.cli?.credits, null);
  });

  it('falls back to limits[] for the windows and to the model-named windows for scoped limits', () => {
    const reset = '2026-10-18T01:00:00+00:00';
    const r = parseUsage({
      subscription_type: 'pro',
      rate_limits_available: true,
      rate_limits: {
        five_hour: null,
        seven_day: null,
        seven_day_opus: { utilization: 80, resets_at: reset },
        limits: [
          { kind: 'session', percent: 12, resets_at: reset, scope: null },
          { kind: 'weekly_all', percent: 40, resets_at: reset, scope: null },
        ],
      },
    }, NOW);
    assert.equal(r.windows.five_hour?.utilization, 0.12);
    assert.equal(r.windows.seven_day?.utilization, 0.4);
    assert.deepEqual(r.cli?.scoped.map((s) => [s.model, s.utilization]), [['Opus', 0.8]]);
  });

  it('refuses an answer that is not an object', () => {
    assert.throws(() => parseUsage(null), /no object/);
  });
});

describe('usageOf against a fake claude', () => {
  it('reads a login account in its own config dir', async () => {
    const dir = join(root, 'login');
    mkdirSync(dir, { recursive: true });
    const r = await usageOf({ id: 'l', kind: 'login', dir }, { claude: FAKE, env: env() });
    assert.equal(r.cli?.plan, 'max');
    assert.equal(r.cli?.scoped.length, 1);
  });

  it('reads a token account through its token, which the CLI answers with no readout, and a key account the same', async () => {
    const token = join(root, 'token');
    const key = join(root, 'key');
    for (const d of [token, key]) mkdirSync(d, { recursive: true });
    writeFileSync(join(token, 'secret'), 'sk-ant-oat-x\n');
    writeFileSync(join(key, 'secret'), 'sk-ant-api-x\n');
    const t = await usageOf({ id: 't', kind: 'token', dir: token }, { claude: FAKE, env: env() });
    assert.equal(t.cli?.available, false);
    assert.equal(t.cli?.plan, null);
    const k = await usageOf({ id: 'k', kind: 'api-key', dir: key }, { claude: FAKE, env: env() });
    assert.equal(k.cli?.available, false);
  });

  it('gives up on a CLI that never answers, and ends it', async () => {
    const dir = join(root, 'hang');
    mkdirSync(dir, { recursive: true });
    await assert.rejects(usageOf({ id: 'h', kind: 'login', dir }, { claude: FAKE, env: { ...env(), FAKE_USAGE_HANG: '1' }, timeoutMs: 300 }), /did not answer get_usage in time/);
  });
});

const stream = (utilization: number, at: number): Reading =>
  readingFromEvent({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: Math.floor(NOW / 1000) + 3600, utilization }, at) as Reading;

describe('folding a CLI reading', () => {
  it('is the freshest truth when it is newer than the stream reading', async () => {
    const readings = new Readings();
    await readings.observe('a', stream(0.9, NOW - 60_000));
    await readings.observe('a', parseUsage(REAL, NOW));
    const limit = readings.limit('a', NOW);
    assert.equal(limit?.source, 'cli');
    assert.equal(limit?.windows.five_hour?.utilization, 0.05);
  });

  it('keeps the stream windows when they are newer, and still shows the CLI plan, scoped limits and credits', async () => {
    const readings = new Readings();
    await readings.observe('a', parseUsage(REAL, NOW - 60_000));
    await readings.observe('a', stream(0.6, NOW));
    const limit = readings.limit('a', NOW);
    assert.equal(limit?.source, 'stream');
    assert.equal(limit?.windows.five_hour?.utilization, 0.6);
    assert.equal(limit?.cli?.plan, 'max');
    assert.equal(limit?.cli?.scoped[0]?.model, 'Fable');
  });

  it('takes the extras of an older CLI answer without replacing newer windows', async () => {
    const readings = new Readings();
    await readings.observe('a', stream(0.6, NOW));
    assert.equal(await readings.observe('a', parseUsage(REAL, NOW - 60_000)), true);
    const limit = readings.limit('a', NOW);
    assert.equal(limit?.windows.five_hour?.utilization, 0.6);
    assert.equal(limit?.cli?.plan, 'max');
  });

  it('keeps the account-level state on the session and weekly windows, whatever a scoped limit says', () => {
    const r = parseUsage(REAL, NOW);
    const scoped = { ...r, cli: { ...r.cli!, scoped: [{ model: 'Fable', window: 'seven_day', utilization: 1, resetsAt: Math.floor(NOW / 1000) + 7200 }] } };
    const limit = fold(scoped, NOW);
    assert.equal(limit.state, 'ok');
    assert.equal(limit.window, 'seven_day');
  });
});

describe('choosing with a per-model limit', () => {
  const limitWith = (utilization: number): AccountLimit => fold({ ...parseUsage(REAL, NOW), cli: { ...parseUsage(REAL, NOW).cli!, scoped: [{ model: 'Fable', window: 'seven_day', utilization, resetsAt: Math.floor(NOW / 1000) + 7200 }] } }, NOW);
  const accounts = [
    { id: 'a', enabled: true, signedIn: true },
    { id: 'b', enabled: true, signedIn: true },
  ];
  const settings = { rotateOnLimit: true, threshold: 90, hysteresis: 10, cooldownSeconds: 0, strategy: 'order' as const };

  it('skips an account whose Fable limit is spent when the chat runs Fable', () => {
    const limits = { a: limitWith(1), b: limitWith(0.1) };
    assert.equal(choose(accounts, limits, settings, { now: NOW, current: null, model: 'claude-fable-5' }).account, 'b');
  });

  it('does not block the same account for another model', () => {
    const limits = { a: limitWith(1), b: limitWith(0.1) };
    assert.equal(choose(accounts, limits, settings, { now: NOW, current: null, model: 'claude-sonnet-5-5' }).account, 'a');
  });

  it('waits for the scoped reset when every account is out of that model', () => {
    const limits = { a: limitWith(1), b: limitWith(1) };
    const c = choose(accounts, limits, settings, { now: NOW, current: null, model: 'claude-fable-5' });
    assert.equal(c.account, null);
    assert.equal(c.waitUntil, NOW + 7_200_000 - (NOW % 1000));
  });
});

describe('the store', () => {
  it('lists the plan the CLI stated for an account whose sign-in names none, and records a fetched reading', async () => {
    const s = new AccountStore({ dataDir, defaultDir, claude: FAKE, env: env() });
    const a = await s.add({ kind: 'login' });
    assert.equal(a.plan, null);
    const reading = await s.fetchUsage(a.id);
    await s.observe(a.id, reading);
    const after = s.get(a.id);
    assert.equal(after.plan, 'max');
    assert.equal(after.limits?.source, 'cli');
  });
});

describe('checkCredential', () => {
  it('reads every recorded answer for a refused credential as unknown: it cannot tell refused from unreachable', () => {
    for (const name of ['oauth-token', 'api-key', 'signed-out', 'offline']) {
      const raw = JSON.parse(readFileSync(join(HERE, 'fixtures', `get-usage-refused-${name}.json`), 'utf8')) as { rate_limits_available: boolean };
      assert.equal(raw.rate_limits_available, false, name);
      assert.equal(parseUsage(raw).cli?.available, false, name);
    }
  });

  it('is valid for a login whose limits come back, unknown for a token the CLI gives none for', async () => {
    const store = new AccountStore({ dataDir: mkdtempSync(join(root, 'check-')), defaultDir, claude: FAKE, env: env() });
    assert.equal(await checkCredential(store.ref('default'), { claude: FAKE, env: env() }), 'valid');
    const token = await store.add({ kind: 'token', alias: 'tok', secret: 'sk-ant-oat01-invalid' });
    assert.equal(await checkCredential(store.ref(token.id), { claude: FAKE, env: env() }), 'unknown');
  });

  it('is unknown when the CLI cannot be run at all', async () => {
    assert.equal(await checkCredential({ id: 'x', kind: 'login', dir: root }, { claude: join(root, 'missing') }), 'unknown');
  });
});

describe('check and hasCredential', () => {
  it('records checkedAt and clears a failed sign-in on a valid check; an unknown one changes nothing', async () => {
    const store = new AccountStore({ dataDir: mkdtempSync(join(root, 'check-')), defaultDir, claude: FAKE, env: env() });
    assert.equal(store.get('default').checkedAt, null);
    await store.markAuthFailed('default');
    assert.equal(store.get('default').signInState, 'expired');
    assert.equal(await store.check('default'), 'valid');
    const checked = store.get('default');
    assert.notEqual(checked.signInState, 'expired');
    assert.ok(checked.checkedAt);
    const token = await store.add({ kind: 'token', alias: 'tok', secret: 'sk-ant-oat01-invalid' });
    assert.equal(await store.check(token.id), 'unknown');
    assert.equal(store.get(token.id).checkedAt, null);
  });

  it('lists the default account only while it has a credential', async () => {
    const empty = mkdtempSync(join(root, 'empty-'));
    const store = new AccountStore({ dataDir: mkdtempSync(join(root, 'vis-')), defaultDir: empty, claude: FAKE, env: env() });
    const login = await store.add({ kind: 'login' });
    assert.deepEqual(store.listed().map((a) => a.id), [login.id]);
    assert.equal(store.get('default').id, 'default');
    writeFileSync(join(empty, '.credentials.json'), '{}');
    assert.deepEqual(store.listed().map((a) => a.id), ['default', login.id]);
  });

  it('keeps an expired default in the list and counts a credential from the environment', async () => {
    const empty = mkdtempSync(join(root, 'empty-'));
    const store = new AccountStore({ dataDir: mkdtempSync(join(root, 'vis-')), defaultDir: empty, claude: FAKE, env: env() });
    assert.equal(store.hasCredential('default'), false);
    await store.markAuthFailed('default');
    assert.equal(store.hasCredential('default'), true);
    const viaEnv = new AccountStore({ dataDir: mkdtempSync(join(root, 'vis-')), defaultDir: empty, claude: FAKE, env: env(), defaultEnvCredential: () => true });
    assert.equal(viaEnv.listed()[0]?.id, 'default');
  });
});
