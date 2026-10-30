import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AccountLimit, AccountsSettings } from '@claudio/shared';
import { AccountInUseError, AccountStore, barTone, choose, DEFAULT_ID, fold, isOut, NEAR, parseUsage, readingFromEvent, Readings } from '../src/index.ts';

/*
 * The account behaviour the regression audit of 2026-10-29 (§2) found missing or wrong: the
 * preferred account and the global order, the per-account cooldown, the scoped and overage
 * rejections, a `get_usage` that cannot read the limits, the ghost default, and removing an account
 * a live chat runs on.
 */

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs');
const NOW = Date.parse('2026-10-29T12:00:00Z');
const sec = (ms: number): number => Math.floor(ms / 1000);

let root: string;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'accounts-choice-'));
});
after(() => rmSync(root, { recursive: true, force: true }));

const env = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH });

/** A store whose default dir has a credentials file, so the CLI's own login is a real account */
function store(opts: { liveChatsOn?: (id: string) => string[]; ghost?: boolean } = {}): AccountStore {
  const defaultDir = mkdtempSync(join(root, 'default-'));
  if (!opts.ghost) writeFileSync(join(defaultDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { refreshToken: 'r' } }));
  return new AccountStore({ dataDir: mkdtempSync(join(root, 'data-')), defaultDir, claude: FAKE, env: env(), ...(opts.liveChatsOn ? { liveChatsOn: opts.liveChatsOn } : {}) });
}

const SETTINGS: AccountsSettings = { rotateOnLimit: true, threshold: 90, hysteresis: 10, cooldownSeconds: 300, strategy: 'least-used', preferred: null, order: [] };
const ACCOUNTS = ['a', 'b', 'c'].map((id) => ({ id, enabled: true, signedIn: true }));
const lim = (u: number | null, extra: Partial<AccountLimit> = {}): AccountLimit => ({
  state: u === null ? 'unknown' : u >= 1 ? 'exhausted' : u >= NEAR ? 'near' : 'ok',
  window: 'five_hour',
  utilization: u,
  resetsAt: new Date(NOW + 3600_000).toISOString(),
  windows: {},
  observedAt: new Date(NOW).toISOString(),
  source: 'stream',
  ...extra,
});

describe('the preferred account and the order', () => {
  it('a pin wins, then the preferred account while it has room, then the strategy', () => {
    const limits = { a: lim(0.1), b: lim(0.5), c: lim(0.2) };
    const preferB = { ...SETTINGS, preferred: 'b' };
    assert.equal(choose(ACCOUNTS, limits, SETTINGS, { current: null, now: NOW }).account, 'a', 'least-used without a preference');
    assert.equal(choose(ACCOUNTS, limits, preferB, { current: null, now: NOW }).account, 'b', 'the preference beats the emptier account');
    assert.equal(choose(ACCOUNTS, limits, preferB, { current: null, now: NOW, pinned: 'c' }).account, 'c', 'a pin beats the preference');
    assert.equal(choose(ACCOUNTS, { ...limits, b: lim(0.95) }, preferB, { current: null, now: NOW }).account, 'a', 'a preferred account over the threshold has no room');
    assert.equal(choose(ACCOUNTS, { ...limits, b: lim(1) }, preferB, { current: null, now: NOW }).account, 'a', 'nor one that is out');
  });

  it('stays on the preferred account under the threshold, and comes back to it only under the margin', () => {
    const preferB = { ...SETTINGS, preferred: 'b' };
    assert.deepEqual(choose(ACCOUNTS, { a: lim(0.1), b: lim(0.85) }, preferB, { current: 'b', now: NOW }), { account: 'b', reason: null, waitUntil: null });
    assert.equal(choose(ACCOUNTS, { a: lim(0.1), b: lim(0.85) }, preferB, { current: 'a', now: NOW }).account, 'a', 'at 85 % it is not taken back: the hysteresis holds');
    assert.deepEqual(choose(ACCOUNTS, { a: lim(0.1), b: lim(0.7) }, preferB, { current: 'a', now: NOW }), { account: 'b', reason: 'person', waitUntil: null });
  });

  it('a project policy that does not list the preferred account wins over it', () => {
    const preferB = { ...SETTINGS, preferred: 'b' };
    const policy = { id: 'p', projects: ['x'], order: ['c', 'a'] };
    assert.equal(choose(ACCOUNTS, {}, preferB, { current: null, now: NOW, policy }).account, 'c');
    assert.equal(choose(ACCOUNTS, {}, preferB, { current: null, now: NOW, policy: { ...policy, order: ['c', 'b'] } }).account, 'b', 'one that lists it allows it');
  });

  it('the order strategy follows settings.order, and an account it does not name goes after', () => {
    const ordered = { ...SETTINGS, strategy: 'order' as const, order: ['c', 'a'] };
    assert.equal(choose(ACCOUNTS, {}, ordered, { current: null, now: NOW }).account, 'c');
    assert.equal(choose(ACCOUNTS, { c: lim(1) }, ordered, { current: 'c', now: NOW }).account, 'a');
    assert.equal(choose(ACCOUNTS, { c: lim(1), a: lim(1) }, ordered, { current: 'c', now: NOW }).account, 'b', 'b was never ordered: it comes last');
  });

  it('PUT-shaped settings: preferred must be an enabled account, order every enabled account once', async () => {
    const s = store();
    const a = await s.add({ kind: 'token', alias: 'a', secret: 'sk-a' });
    const b = await s.add({ kind: 'token', alias: 'b', secret: 'sk-b' });
    assert.equal((await s.setSettings({ preferred: a.id })).preferred, a.id);
    await assert.rejects(s.setSettings({ preferred: 'acc-nope' }), /is none/);
    await s.setEnabled(b.id, false);
    await assert.rejects(s.setSettings({ preferred: b.id }), /disabled/);
    await assert.rejects(s.setSettings({ order: [a.id] }), /every enabled account; default is missing/);
    await assert.rejects(s.setSettings({ order: [a.id, a.id, DEFAULT_ID] }), /once/);
    assert.deepEqual((await s.setSettings({ order: [a.id, DEFAULT_ID] })).order, [a.id, DEFAULT_ID], 'a disabled one may be left out');
    assert.deepEqual((await s.setSettings({ order: [] })).order, [], 'empty is the listed order');
    assert.equal((await s.setSettings({ preferred: null })).preferred, null);
    // Stored only once set, like every other key
    await s.setSettings({ preferred: a.id, order: [DEFAULT_ID, a.id] });
    const file = JSON.parse(readFileSync(join(s.ref(a.id).dir, '..', '..', 'accounts.json'), 'utf8')) as { settings: AccountsSettings };
    assert.equal(file.settings.preferred, a.id);
    assert.deepEqual(file.settings.order, [DEFAULT_ID, a.id]);
    assert.equal(s.pick({ current: null }).account, a.id, 'the store chooses the preferred account');
  });

  it('removing the preferred account clears it and drops it from the order', async () => {
    const s = store();
    const a = await s.add({ kind: 'token', alias: 'a', secret: 'sk-a' });
    await s.setSettings({ preferred: a.id, order: [a.id, DEFAULT_ID] });
    await s.remove(a.id);
    assert.equal(s.settings().preferred, null);
    assert.deepEqual(s.settings().order, [DEFAULT_ID]);
  });
});

describe('removing an account a live chat runs on', () => {
  it('is refused with 409 account-in-use and the chat ids, and goes through once no chat runs on it', async () => {
    const live = new Map<string, string[]>();
    const s = store({ liveChatsOn: (id) => live.get(id) ?? [] });
    const a = await s.add({ kind: 'token', alias: 'a', secret: 'sk-a' });
    live.set(a.id, ['chat-1', 'chat-2']);
    const refused = await s.remove(a.id).then(
      () => assert.fail('removed under a live chat'),
      (e: unknown) => e,
    );
    assert.ok(refused instanceof AccountInUseError);
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.reason, 'account-in-use');
    assert.deepEqual(refused.chats, ['chat-1', 'chat-2']);
    assert.ok(s.find(a.id), 'still there');
    live.clear();
    await s.remove(a.id);
    assert.equal(s.find(a.id), null, 'a nullable lookup: no throw for an account that is gone');
  });
});

describe('the credential-less default', () => {
  it('is out of the list and of every choice, not only of "in use"', async () => {
    const s = store({ ghost: true });
    assert.deepEqual(s.list().map((a) => a.id), []);
    assert.equal(s.pick({ current: null }).account, null, 'no ghost to start work on');
    const a = await s.add({ kind: 'token', alias: 'a', secret: 'sk-a' });
    assert.equal(s.pick({ current: a.id, failedOn: [a.id] }).account, null, 'nor to move to');
    assert.equal(s.find(DEFAULT_ID), null);
  });
});

describe('the reload of a file another process wrote', () => {
  it('tells the listeners, so a wait wakes for an account added from the terminal', async () => {
    const dataDir = mkdtempSync(join(root, 'shared-'));
    const defaultDir = mkdtempSync(join(root, 'default-'));
    const s = new AccountStore({ dataDir, defaultDir, claude: FAKE, env: env() });
    await s.setSettings({ threshold: 85 });
    let heard = 0;
    s.onChange(() => void heard++);
    s.reload();
    assert.equal(heard, 0, 'the same file is no change');
    const terminal = new AccountStore({ dataDir, defaultDir, claude: FAKE, env: env() });
    await terminal.add({ kind: 'token', alias: 'from-terminal', secret: 'sk-t' });
    s.reload();
    assert.equal(heard, 1);
  });
});

describe('stream readings', () => {
  it('a rejection with no reset leaves the account out for the cooldown, and no cooldown records nothing', () => {
    assert.equal(readingFromEvent({ status: 'rejected' }, NOW), null);
    const r = readingFromEvent({ status: 'rejected', rateLimitType: 'five_hour' }, NOW, { cooldownMs: 300_000 });
    assert.ok(r);
    const l = fold(r, NOW);
    assert.deepEqual([l.state, l.window, l.utilization, l.resetsAt], ['exhausted', null, null, new Date(NOW + 300_000).toISOString()]);
    assert.equal(isOut(l, NOW), true);
    assert.equal(fold(r, NOW + 300_001).state, 'unknown', 'back once the cooldown is over');
    // Under `choose`, the account is skipped until then and gives that time to wait for
    const c = choose([{ id: 'a', enabled: true, signedIn: true }], { a: l }, SETTINGS, { current: 'a', now: NOW });
    assert.deepEqual(c, { account: null, reason: null, waitUntil: NOW + 300_000 });
  });

  it('a scoped rejection goes to the model\'s limit, never to the account\'s windows', () => {
    const reset = sec(NOW) + 86_400;
    const r = readingFromEvent({ status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: reset, unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: sec(NOW) + 3600 } } }, NOW);
    assert.ok(r);
    const l = fold(r, NOW);
    assert.equal(l.state, 'ok', 'the account still runs Sonnet');
    assert.deepEqual(Object.keys(l.windows), ['five_hour']);
    assert.deepEqual(l.cli?.scoped, [{ model: 'Opus', window: 'seven_day', utilization: 1, resetsAt: reset }]);
    const accounts = [{ id: 'a', enabled: true, signedIn: true }, { id: 'b', enabled: true, signedIn: true }];
    assert.equal(choose(accounts, { a: l }, SETTINGS, { current: 'a', now: NOW, model: 'claude-opus-5-5' }).account, 'b');
    assert.equal(choose(accounts, { a: l }, SETTINGS, { current: 'a', now: NOW, model: 'claude-sonnet-5-5' }).account, 'a');
  });

  it('an overage rejection leaves the account out without writing a spent window', () => {
    const r = readingFromEvent({ status: 'rejected', rateLimitType: 'five_hour', isUsingOverage: true, resetsAt: sec(NOW) + 1800, unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: sec(NOW) + 1800 } } }, NOW);
    assert.ok(r);
    assert.equal(r.rejected, undefined);
    const l = fold(r, NOW);
    assert.equal(l.state, 'exhausted');
    assert.equal(l.window, null, 'no window is named spent');
    assert.equal(l.windows.five_hour?.utilization, 0.4, 'and the window keeps the use it reported');
    const overage = readingFromEvent({ status: 'rejected', rateLimitType: 'overage' }, NOW, { cooldownMs: 60_000 });
    assert.equal(overage ? fold(overage, NOW).resetsAt : null, new Date(NOW + 60_000).toISOString());
  });

  it('a get_usage with rate_limits_available false keeps an exhausted state', async () => {
    const rs = new Readings(null);
    const rejected = readingFromEvent({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: sec(NOW) + 3600 }, NOW);
    assert.ok(rejected);
    await rs.observe('a', rejected);
    const unavailable = parseUsage({ rate_limits_available: false }, NOW + 1000);
    assert.equal(await rs.observe('a', unavailable), true);
    const l = rs.limit('a', NOW + 2000);
    assert.equal(l?.state, 'exhausted', 'the network may be down: the answer says nothing of the windows');
    assert.equal(l?.cli?.available, false);
  });
});

describe('thresholds', () => {
  it('near, the bars and "out" agree', () => {
    assert.equal(NEAR, 0.6);
    assert.deepEqual([barTone(0.59), barTone(0.6), barTone(0.75), barTone(0.1, true)], ['neutral', 'warn', 'bad', 'bad']);
    assert.equal(isOut(lim(1), NOW), true);
    assert.equal(isOut(lim(1, { resetsAt: null }), NOW), true, 'a reset nobody gave is still out');
    assert.equal(isOut(lim(1, { resetsAt: new Date(NOW - 1).toISOString() }), NOW), false);
    assert.equal(isOut(lim(0.9), NOW), false);
  });
});
