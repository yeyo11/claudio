import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AccountCredits, AccountLimit, AccountsSettings } from '@claudio/shared';
import { accountState, AccountStore, choose, fold, isOut, parseUsage, readingFromEvent, Readings, type Reading } from '../src/index.ts';

/*
 * The `overage` state and the credits setting (t6 of docs/plans/limit-resume-and-credits.md, on the
 * ground docs/decisions/credits-in-the-stream.md lays): `get_usage`'s `extra_usage` says whether
 * credits can cover sends, the stream's overage fields are hints only, and credits are never spent
 * unless the account's setting says so (D3). Every reading here is built from the shapes the SDK types
 * and the recorded fixtures show; no turn is run.
 */

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs');
const NOW = Date.parse('2026-11-14T12:00:00Z');
const sec = (ms: number): number => Math.floor(ms / 1000);
const HOUR = 3600_000;

const SETTINGS: AccountsSettings = { rotateOnLimit: true, threshold: 90, hysteresis: 10, cooldownSeconds: 300, strategy: 'order', preferred: null, order: [], newAccountConfig: 'shared', credits: {} };
const ACCOUNTS = ['a', 'b', 'c'].map((id) => ({ id, enabled: true, signedIn: true }));

/** A `get_usage` answer: the windows as given, and `extra_usage` with credits on or off */
function usage(at: number, opts: { five?: number; enabled: boolean; used?: number; cap?: number | null; spendEnabled?: boolean }): Reading {
  return parseUsage(
    {
      subscription_type: 'pro',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: opts.five ?? 10, resets_at: new Date(at + HOUR).toISOString() },
        seven_day: { utilization: 20, resets_at: new Date(at + 72 * HOUR).toISOString() },
        extra_usage: { is_enabled: opts.enabled, monthly_limit: opts.cap === undefined ? 4000 : opts.cap, used_credits: opts.used ?? 320, utilization: null, currency: 'USD' },
        ...(opts.spendEnabled !== undefined ? { spend: { used: { amount_minor: opts.used ?? 320, currency: 'USD', exponent: 2 }, limit: null, enabled: opts.spendEnabled } } : {}),
      },
    },
    at,
  );
}

/** A stream event whose five-hour window reads spent while the CLI still allows the turn: credits took over */
const spentAllowed = (at: number, extra: Record<string, unknown> = {}): Reading => {
  const r = readingFromEvent({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: sec(at + HOUR), utilization: 1, unifiedWindows: { five_hour: { utilization: 1, resetsAt: sec(at + HOUR) } }, ...extra }, at);
  assert.ok(r);
  return r;
};

async function readingsOf(...rs: Reading[]): Promise<AccountLimit> {
  const kept = new Readings(null);
  for (const r of rs) await kept.observe('a', r);
  return kept.limit('a', NOW) ?? assert.fail('no reading');
}

const credits = (over: Partial<AccountCredits> = {}): AccountCredits => ({ enabled: true, usedMinor: 320, limitMinor: 4000, currency: 'USD', exponent: 2, limitReached: false, disabledReason: null, everEnabled: true, ...over });

/** A folded limit whose plan is spent, covered by credits or not */
const spent = (cover: boolean, c: AccountCredits = credits()): AccountLimit => ({
  state: 'exhausted',
  window: 'five_hour',
  utilization: 1,
  resetsAt: new Date(NOW + HOUR).toISOString(),
  windows: { five_hour: { utilization: 1, resetsAt: sec(NOW + HOUR) } },
  observedAt: new Date(NOW).toISOString(),
  source: 'stream',
  cli: { observedAt: new Date(NOW - 1000).toISOString(), plan: 'pro', available: true, scoped: [], credits: c },
  creditsCover: cover,
});
const room = (u: number): AccountLimit => ({ state: u >= 0.6 ? 'near' : 'ok', window: 'five_hour', utilization: u, resetsAt: new Date(NOW + HOUR).toISOString(), windows: {}, observedAt: new Date(NOW).toISOString(), source: 'stream' });
const out = (resetIn: number): AccountLimit => ({ ...spent(false), resetsAt: new Date(NOW + resetIn).toISOString(), creditsCover: false });

describe('the overage-included window', () => {
  it('an overage window is not a scoped model limit', () => {
    const r = readingFromEvent(
      {
        status: 'allowed',
        rateLimitType: 'seven_day_overage_included',
        resetsAt: sec(NOW + 48 * HOUR),
        utilization: 0.61,
        unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: sec(NOW + HOUR) }, seven_day_overage_included: { utilization: 0.61, resetsAt: sec(NOW + 48 * HOUR) } },
      },
      NOW,
    );
    assert.ok(r);
    const l = fold(r, NOW);
    assert.equal(l.cli, undefined, 'no scoped "Overage_included" model');
    assert.deepEqual(Object.keys(l.windows), ['five_hour'], 'nor a window the state is folded from');
    assert.equal(l.state, 'ok');
    assert.deepEqual(l.overageHints?.included, { utilization: 0.61, resetsAt: sec(NOW + 48 * HOUR) }, 'kept apart, to show');
  });

  it('a rejection of the overage-included window leaves the account out without naming a model', () => {
    const r = readingFromEvent({ status: 'rejected', rateLimitType: 'seven_day_overage_included', resetsAt: sec(NOW + 2 * HOUR) }, NOW);
    assert.ok(r);
    const l = fold(r, NOW);
    assert.equal(l.state, 'exhausted');
    assert.equal(l.window, null);
    assert.equal(l.cli, undefined);
    assert.equal(l.resetsAt, new Date(NOW + 2 * HOUR).toISOString());
  });
});

describe('the stream\'s overage fields', () => {
  it('are kept on the reading as hints, and carried over a later event that has none', async () => {
    const hinted = readingFromEvent(
      { status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: sec(NOW + HOUR), unifiedWindows: { five_hour: { utilization: 0.8, resetsAt: sec(NOW + HOUR) } }, isUsingOverage: false, overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled', overageEnabled: false },
      NOW - 2000,
    );
    assert.ok(hinted);
    const plain = readingFromEvent({ status: 'allowed', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.81, resetsAt: sec(NOW + HOUR) } } }, NOW - 1000);
    assert.ok(plain);
    const l = await readingsOf(hinted, plain);
    assert.deepEqual(l.overageHints, { observedAt: new Date(NOW - 2000).toISOString(), using: false, status: 'rejected', disabledReason: 'org_level_disabled', enabled: false });
    assert.equal(l.utilization, 0.81, 'the windows follow the newer event');
  });

  it('of a recorded event (CLI 2.1.278, credits off) are kept as they came', () => {
    // packages/core/test/fixtures/recordings/claude-hooks/2.1.278/a-big/stdout.jsonl, line 5
    const info = { status: 'allowed', resetsAt: 1792156200, rateLimitType: 'five_hour', overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled', isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 0.31, resetsAt: 1792156200 }, seven_day: { utilization: 0.19, resetsAt: 1792425600 } } };
    const at = 1792156200_000 - HOUR;
    const l = fold(readingFromEvent(info, at) ?? assert.fail(), at);
    assert.equal(l.state, 'ok');
    assert.equal(l.creditsCover, undefined);
    assert.deepEqual(l.overageHints, { observedAt: new Date(at).toISOString(), using: false, status: 'rejected', disabledReason: 'org_level_disabled' });
  });

  it('alone never make an account the overage state', () => {
    const l = fold(spentAllowed(NOW, { isUsingOverage: true, overageStatus: 'allowed' }), NOW);
    assert.equal(l.state, 'exhausted');
    assert.equal(l.creditsCover, false, 'no get_usage says credits can cover sends');
    assert.equal(accountState(l), 'exhausted');
    assert.equal(l.overageHints?.using, true, 'the hint is still there for whoever looks again');
  });

  it('a credits_required rejection is out with no credits, whatever an older get_usage said', async () => {
    const rejected = readingFromEvent({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: sec(NOW + HOUR), errorCode: 'credits_required', canUserPurchaseCredits: true }, NOW);
    assert.ok(rejected);
    const l = await readingsOf(usage(NOW - 60_000, { enabled: true }), rejected);
    assert.equal(l.state, 'exhausted');
    assert.equal(l.creditsCover, false);
    assert.equal(l.overageHints?.creditsRequired, true);
  });
});

describe('the overage state', () => {
  it('a spent plan whose credits are on and under their cap is the overage state, and still out by default', async () => {
    const l = await readingsOf(usage(NOW - 60_000, { enabled: true }), spentAllowed(NOW));
    assert.equal(l.state, 'exhausted', 'what does not read creditsCover sees an account that is out');
    assert.equal(l.creditsCover, true);
    assert.equal(accountState(l), 'overage');
    assert.equal(isOut(l, NOW), true);
    assert.equal(l.resetsAt, new Date(NOW + HOUR).toISOString(), 'the plan\'s reset is still the one to wait for');
  });

  it('credits that are off, at their cap or never read leave the plan exhausted', async () => {
    assert.equal((await readingsOf(usage(NOW - 60_000, { enabled: false }), spentAllowed(NOW))).creditsCover, false, 'off');
    assert.equal((await readingsOf(usage(NOW - 60_000, { enabled: true, used: 4000, cap: 4000 }), spentAllowed(NOW))).creditsCover, false, 'at their cap');
    assert.equal((await readingsOf(spentAllowed(NOW))).creditsCover, false, 'never read');
  });

  it('get_usage\'s typed is_enabled decides over the observed spend.enabled', async () => {
    assert.equal(fold(usage(NOW, { enabled: true, spendEnabled: false }), NOW).cli?.credits?.enabled, true);
    assert.equal(fold(usage(NOW, { enabled: false, spendEnabled: true }), NOW).cli?.credits?.enabled, false);
  });

  it('a rejection after the credits were read means they did not cover it; one before them does not', async () => {
    const rejectedAt = (at: number): Reading => readingFromEvent({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: sec(NOW + HOUR) }, at) ?? assert.fail();
    assert.equal((await readingsOf(usage(NOW - 60_000, { enabled: true }), rejectedAt(NOW))).creditsCover, false, 'refused with credits on: they cover nothing');
    // The credits were turned on after the refusal, and get_usage reads the plan spent
    const after = await readingsOf(rejectedAt(NOW - 60_000), usage(NOW - 1000, { enabled: true, five: 100 }));
    assert.equal(after.state, 'exhausted');
    assert.equal(after.creditsCover, true);
  });

  it('an account with room says nothing of its credits', async () => {
    const l = await readingsOf(usage(NOW, { enabled: true }));
    assert.equal(l.state, 'ok');
    assert.equal(l.creditsCover, undefined);
    assert.equal(accountState(l), 'ok');
  });
});

describe('choose and the credits setting', () => {
  const withCredits = (use: 'never' | 'last-resort' | 'allow', capMinor: number | null = null, id = 'a'): AccountsSettings => ({ ...SETTINGS, credits: { [id]: { use, capMinor } } });

  it('never, the default: an account in overage is out, and its plan reset is the one to wait for', () => {
    const limits = { a: spent(true), b: out(2 * HOUR), c: out(3 * HOUR) };
    assert.deepEqual(choose(ACCOUNTS, limits, SETTINGS, { current: 'a', now: NOW }), { account: null, reason: null, waitUntil: NOW + HOUR });
    assert.deepEqual(choose(ACCOUNTS, limits, withCredits('never'), { current: 'a', now: NOW }), { account: null, reason: null, waitUntil: NOW + HOUR });
    assert.equal(choose(ACCOUNTS, limits, SETTINGS, { current: null, now: NOW, pinned: 'a' }).account, null, 'a pin does not spend credits either');
  });

  it('last-resort: taken only when no account has plan quota left', () => {
    const settings = withCredits('last-resort');
    assert.equal(choose(ACCOUNTS, { a: spent(true), b: room(0.95), c: out(HOUR) }, settings, { current: 'a', now: NOW }).account, 'b', 'an account over the threshold still has plan quota');
    assert.deepEqual(choose(ACCOUNTS, { a: spent(true), b: out(2 * HOUR), c: out(HOUR) }, settings, { current: 'b', now: NOW }), { account: 'a', reason: 'limit', waitUntil: null, credits: true });
    assert.deepEqual(choose(ACCOUNTS, { a: spent(true), b: out(2 * HOUR), c: out(HOUR) }, settings, { current: 'a', now: NOW }), { account: 'a', reason: null, waitUntil: null, credits: true }, 'it stays where it runs');
  });

  it('allow: taken after the accounts with room, before waiting, and kept while it runs there', () => {
    const settings = withCredits('allow');
    assert.equal(choose(ACCOUNTS, { a: spent(true), b: room(0.2), c: out(HOUR) }, settings, { current: 'a', now: NOW }).account, 'b', 'plan quota first');
    assert.deepEqual(choose(ACCOUNTS, { a: spent(true), b: room(0.95), c: out(HOUR) }, settings, { current: 'a', now: NOW }), { account: 'a', reason: null, waitUntil: null, credits: true }, 'as an account over the threshold stays');
    assert.deepEqual(choose(ACCOUNTS, { a: spent(true), b: out(2 * HOUR), c: out(HOUR) }, settings, { current: 'c', now: NOW }), { account: 'a', reason: 'limit', waitUntil: null, credits: true });
    assert.deepEqual(choose(ACCOUNTS, { a: spent(true), b: out(2 * HOUR), c: out(HOUR) }, settings, { current: null, now: NOW, pinned: 'a' }), { account: 'a', reason: 'person', waitUntil: null, credits: true }, 'a pinned chat keeps it');
  });

  it('no setting spends credits that do not cover: off, at the claude.ai cap, or at Claudio\'s cap', () => {
    const limits = (a: AccountLimit) => ({ a, b: out(2 * HOUR), c: out(3 * HOUR) });
    for (const use of ['last-resort', 'allow'] as const) {
      assert.equal(choose(ACCOUNTS, limits(spent(false)), withCredits(use), { current: null, now: NOW }).account, null, `${use}: credits that do not cover`);
      assert.equal(choose(ACCOUNTS, limits(spent(true, credits({ usedMinor: 2000 }))), withCredits(use, 2000), { current: null, now: NOW }).account, null, `${use}: Claudio's cap reached`);
      assert.equal(choose(ACCOUNTS, limits(spent(true, credits({ usedMinor: 1999 }))), withCredits(use, 2000), { current: null, now: NOW }).account, 'a', `${use}: under Claudio's cap`);
    }
    assert.equal(choose(ACCOUNTS, { a: spent(true), b: out(HOUR), c: out(HOUR) }, withCredits('allow', null, 'b'), { current: null, now: NOW }).account, null, 'the setting is the account\'s own');
  });

  it('an account the turn died on is no candidate, whatever its credits', () => {
    assert.equal(choose(ACCOUNTS, { a: spent(true), b: out(HOUR), c: out(HOUR) }, withCredits('allow'), { current: 'a', now: NOW, failedOn: ['a'] }).account, null);
  });
});

describe('the credits setting in accounts.json', () => {
  let root: string;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'accounts-credits-'));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  function store(dataDir = mkdtempSync(join(root, 'data-'))): AccountStore {
    const defaultDir = mkdtempSync(join(root, 'default-'));
    writeFileSync(join(defaultDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { refreshToken: 'r' } }));
    return new AccountStore({ dataDir, defaultDir, claude: FAKE, env: { PATH: process.env.PATH } });
  }

  it('defaults to never for every account, and is not written until a person sets it', async () => {
    const s = store();
    assert.deepEqual(s.settings().credits, {});
    await s.setSettings({ threshold: 80 });
    assert.equal(s.storedSettingKeys().has('credits'), false);
  });

  it('keeps what a person sets for an account, refuses what breaks a rule, and resets to never', async () => {
    const dataDir = mkdtempSync(join(root, 'data-'));
    const s = store(dataDir);
    const id = s.list()[0]?.id ?? assert.fail('no account');
    await s.setSettings({ credits: { [id]: { use: 'last-resort', capMinor: 2000 } } });
    assert.deepEqual(store(dataDir).settings().credits, { [id]: { use: 'last-resort', capMinor: 2000 } }, 'read back from accounts.json');
    const file = JSON.parse(readFileSync(join(dataDir, 'accounts.json'), 'utf8')) as { settings: { credits?: unknown } };
    assert.deepEqual(file.settings.credits, { [id]: { use: 'last-resort', capMinor: 2000 } });
    await assert.rejects(() => s.setSettings({ credits: { [id]: { use: 'always' as 'allow', capMinor: null } } }), /credits/);
    await assert.rejects(() => s.setSettings({ credits: { [id]: { use: 'allow', capMinor: -1 } } }), /credits/);
    await assert.rejects(() => s.setSettings({ credits: { nobody: { use: 'allow', capMinor: null } } }), /nobody/);
    await s.resetSettings([['credits']]);
    assert.deepEqual(s.settings().credits, {});
  });

  it('a setting the file holds for an account that is gone is dropped on read', () => {
    const dataDir = mkdtempSync(join(root, 'data-'));
    writeFileSync(join(dataDir, 'accounts.json'), JSON.stringify({ settings: { credits: { 'acc-gone': { use: 'allow', capMinor: null }, default: { use: 'bogus' } } }, accounts: [] }));
    assert.deepEqual(store(dataDir).settings().credits, {}, 'an unknown use is no setting either');
  });
});
