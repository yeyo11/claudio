import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AccountLimit, AccountsSettings } from '@agentry/shared';
import { AccountStore, choose, envFor, fold, identify, login, ModelCache, parseInitialize, readCache, readingFromEvent, Readings } from '../src/index.ts';
import { main } from '../src/commands.ts';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs');
const NOW = Date.parse('2026-10-15T12:00:00Z');
const sec = (ms: number): number => Math.floor(ms / 1000);

let root: string;
let defaultDir: string;
let dataDir: string;
const env = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: 'leaked', ANTHROPIC_API_KEY: 'leaked' });

const store = (): AccountStore => new AccountStore({ dataDir, defaultDir, claude: FAKE, env: env() });

before(() => {
  root = mkdtempSync(join(tmpdir(), 'accounts-'));
  defaultDir = join(root, 'default-claude');
  dataDir = join(root, 'data');
  mkdirSync(defaultDir, { recursive: true });
  writeFileSync(join(defaultDir, 'settings.json'), '{}');
});
after(() => rmSync(root, { recursive: true, force: true }));

describe('store, dirs and env', () => {
  it('lists the default account with nothing set up', () => {
    const list = store().list();
    assert.deepEqual(list.map((a) => a.id), ['default']);
    assert.equal(list[0]?.limits, null);
  });

  it('adds a login account with its dir, linking projects/ and shared settings', async () => {
    const s = store();
    const a = await s.add({ kind: 'login' });
    const dir = s.ref(a.id).dir;
    assert.equal(dir, join(dataDir, 'accounts', a.id));
    assert.equal(readlinkSync(join(dir, 'projects')), join(defaultDir, 'projects'));
    assert.equal(readlinkSync(join(dir, 'settings.json')), join(defaultDir, 'settings.json'));
    // Things the default dir does not have are not linked
    assert.throws(() => lstatSync(join(dir, 'CLAUDE.md')));
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });

  it('keeps a token in a 0600 file inside its dir and never in accounts.json', async () => {
    const s = store();
    await assert.rejects(s.add({ kind: 'token', secret: 'sk-x' }), /alias/);
    const a = await s.add({ kind: 'token', alias: 'ci', secret: 'sk-ant-oat-secret' });
    const file = join(s.ref(a.id).dir, 'secret');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(!readFileSync(join(dataDir, 'accounts.json'), 'utf8').includes('sk-ant-oat-secret'));
    assert.ok(!JSON.stringify(s.list()).includes('sk-ant-oat-secret'));
    await assert.rejects(s.add({ kind: 'api-key', alias: 'ci', secret: 'k' }), /already taken/);
  });

  it('envFor carries exactly one account and strips the others', async () => {
    const s = store();
    const token = s.list().find((a) => a.alias === 'ci');
    assert.ok(token);
    const t = envFor(s.ref(token.id), env());
    assert.equal(t.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat-secret');
    assert.equal(t.ANTHROPIC_API_KEY, undefined);
    assert.equal(t.CLAUDE_CONFIG_DIR, s.ref(token.id).dir);
    const d = envFor(s.ref('default'), env());
    assert.equal(d.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(d.ANTHROPIC_API_KEY, undefined);
    assert.equal(d.CLAUDE_CONFIG_DIR, defaultDir);
    const key = await s.add({ kind: 'api-key', alias: 'billing', secret: 'sk-ant-api' });
    const k = envFor(s.ref(key.id), env());
    assert.equal(k.ANTHROPIC_API_KEY, 'sk-ant-api');
    assert.equal(k.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  });

  it('a second store on the same data dir sees the first one\'s accounts', () => {
    assert.ok(store().list().length >= 4);
  });

  it('validates settings and policies, and removing an account takes it out of orders', async () => {
    const s = store();
    await assert.rejects(s.setSettings({ threshold: 10 }), /threshold/);
    assert.equal((await s.setSettings({ threshold: 80 })).threshold, 80);
    const [, first] = s.list();
    assert.ok(first);
    const p = await s.createPolicy({ projects: ['p1'], order: [first.id, 'default'] });
    await assert.rejects(s.createPolicy({ projects: ['p1'] }), /already governed/);
    await assert.rejects(s.createPolicy({ projects: ['p2'], order: ['ghost'] }), /account ids/);
    assert.equal(s.policyFor('p1')?.id, p.id);
    const projects = join(defaultDir, 'projects');
    await s.remove(first.id);
    assert.deepEqual(s.policyFor('p1')?.order, ['default']);
    // Removing an account does not touch the default dir it was linked to
    assert.ok(statSync(projects).isDirectory());
    assert.ok(statSync(join(defaultDir, 'settings.json')).isFile());
    await assert.rejects(s.remove('default'), /cannot be removed/);
  });
});

describe('identify and login against a fake claude', () => {
  it('a signed-out dir reads as signed out; login with a pasted code signs it in', async () => {
    const s = store();
    const a = await s.add({ kind: 'login' });
    const ref = s.ref(a.id);
    assert.equal((await identify(ref, { claude: FAKE, env: env() })).signedIn, false);
    const session = login(ref, { claude: FAKE, env: env() });
    assert.equal(await session.url, 'https://claude.example/authorize?state=x');
    session.submitCode('good-code');
    assert.equal(await session.done, 0);
    const refreshed = await s.refresh(a.id);
    assert.equal(refreshed.signedIn, true);
    assert.equal(refreshed.email, `${a.id}@example.com`);
    assert.equal(refreshed.organization, 'Org');
    assert.equal(refreshed.plan, 'max');
  });

  it('a wrong code fails the login', async () => {
    const s = store();
    const a = await s.add({ kind: 'login' });
    const session = login(s.ref(a.id), { claude: FAKE, env: env() });
    await session.url;
    session.submitCode('nope');
    assert.notEqual(await session.done, 0);
    assert.equal((await s.refresh(a.id)).signedIn, false);
  });

  it('token accounts are signed in with no identity', async () => {
    const s = store();
    const a = s.list().find((x) => x.alias === 'ci');
    assert.ok(a);
    const r = await s.refresh(a.id);
    assert.equal(r.email, null);
    assert.equal(r.signedIn, true);
  });
});

describe('readings', () => {
  const info = (status: string, five: number, seven: number) => ({
    status,
    resetsAt: sec(NOW) + 3600,
    rateLimitType: 'five_hour',
    unifiedWindows: { five_hour: { utilization: five, resetsAt: sec(NOW) + 3600 }, seven_day: { utilization: seven, resetsAt: sec(NOW) + 86400 } },
  });

  it('reads a real-shaped rate_limit_event and binds on the higher window', () => {
    const r = readingFromEvent(info('allowed', 0.68, 0.32), NOW);
    assert.ok(r);
    const l = fold(r, NOW);
    assert.equal(l.window, 'five_hour');
    assert.equal(l.utilization, 0.68);
    assert.equal(l.state, 'ok');
    assert.equal(l.source, 'stream');
    assert.equal(fold(readingFromEvent(info('allowed', 0.2, 0.8), NOW) ?? r, NOW).window, 'seven_day');
    assert.equal(fold(readingFromEvent(info('allowed_warning', 0.2, 0.8), NOW) ?? r, NOW).state, 'near');
  });

  it('a rejected event is exhausted until its reset, then unknown', () => {
    const r = readingFromEvent({ status: 'rejected', resetsAt: sec(NOW) + 600, rateLimitType: 'five_hour' }, NOW);
    assert.ok(r);
    assert.equal(fold(r, NOW).state, 'exhausted');
    assert.equal(fold(r, NOW + 601_000).state, 'unknown');
    assert.equal(readingFromEvent({ status: 'allowed' }, NOW), null);
  });

  it('reads the CLI cache, stamped, and a window past its reset reads unknown', () => {
    const dir = join(root, 'cache-acct');
    mkdirSync(dir, { recursive: true });
    const cache = {
      cachedUsageUtilization: {
        fetchedAtMs: NOW - 60_000,
        utilization: {
          five_hour: { utilization: 9, resets_at: new Date(NOW + 3600_000).toISOString() },
          seven_day: { utilization: 52, resets_at: new Date(NOW + 86400_000).toISOString() },
          seven_day_opus: null,
        },
      },
    };
    writeFileSync(join(dir, '.claude.json'), JSON.stringify(cache));
    const r = readCache(dir);
    assert.ok(r);
    assert.equal(r.at, NOW - 60_000);
    const l = fold(r, NOW);
    assert.equal(l.source, 'cache');
    assert.equal(l.window, 'seven_day');
    assert.equal(l.utilization, 0.52);
    assert.equal(l.observedAt, new Date(NOW - 60_000).toISOString());
    assert.equal(fold(r, NOW + 2 * 86400_000).state, 'unknown');
    assert.equal(readCache(join(root, 'nothing-here')), null);
    writeFileSync(join(dir, '.claude.json'), '{not json');
    assert.equal(readCache(dir), null);
  });

  it('an older reading never replaces a newer one, and the file survives a restart', async () => {
    const file = join(root, 'limits.json');
    const rs = new Readings(file);
    const fresh = readingFromEvent(info('allowed', 0.5, 0.1), NOW);
    const older = { ...(readingFromEvent(info('allowed', 0.9, 0.1), NOW - 5000) ?? assert.fail()), source: 'cache' as const };
    assert.ok(fresh);
    assert.equal(await rs.observe('a', fresh), true);
    assert.equal(await rs.observe('a', older), false);
    assert.equal(new Readings(file).limit('a', NOW)?.utilization, 0.5);
    assert.equal(new Readings(file).limit('b', NOW), null);
  });

  it('the store keeps a stream reading over an older cache one', async () => {
    const s = store();
    const dir = s.ref('default').dir;
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: Date.now() - 10_000, utilization: { five_hour: { utilization: 95, resets_at: new Date(Date.now() + 3600_000).toISOString() } } } }));
    const stream = readingFromEvent({ status: 'allowed', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: sec(Date.now()) + 3600 } } }, Date.now());
    assert.ok(stream);
    await s.observe('default', stream);
    assert.equal(await s.readCachedUsage('default'), false);
    assert.equal(s.get('default').limits?.utilization, 0.1);
  });
});

describe('choose', () => {
  const settings: AccountsSettings = { rotateOnLimit: true, threshold: 90, hysteresis: 10, cooldownSeconds: 300, strategy: 'order' };
  const accts = ['a', 'b', 'c'].map((id) => ({ id, enabled: true, signedIn: true }));
  const lim = (u: number | null, extra: Partial<AccountLimit> = {}): AccountLimit => ({
    state: u === null ? 'unknown' : u >= 1 ? 'exhausted' : u >= 0.75 ? 'near' : 'ok',
    window: 'five_hour',
    utilization: u,
    resetsAt: new Date(NOW + 3600_000).toISOString(),
    windows: {},
    observedAt: new Date(NOW).toISOString(),
    source: 'stream',
    ...extra,
  });

  it('skips an account that cannot run the chat\'s model, and waits for one that can', () => {
    const canRun = (id: string): boolean => id === 'c';
    const opts = { current: 'a', now: NOW, model: 'opus', canRun };
    assert.equal(choose(accts, { a: lim(1), b: lim(0), c: lim(0.2) }, settings, opts).account, 'c', 'b is free but has no opus');
    const waits = choose(accts, { a: lim(1), b: lim(1), c: lim(1, { resetsAt: new Date(NOW + 7200_000).toISOString() }) }, settings, opts);
    assert.deepEqual(waits, { account: null, reason: null, waitUntil: NOW + 7200_000 }, 'b is back sooner but cannot run it');
    assert.equal(choose(accts, { a: lim(1), b: lim(0) }, settings, { ...opts, model: 'default' }).account, 'b', 'the default model runs anywhere');
    assert.equal(choose(accts, { a: lim(0), b: lim(0), c: lim(0) }, settings, { ...opts, current: null, pinned: 'b' }).account, 'c', 'a pinned account that cannot run it is not kept');
  });

  it('keeps the current account while under the threshold, even when an earlier one is free', () => {
    const c = choose(accts, { a: lim(0), b: lim(0.5) }, settings, { current: 'b', now: NOW });
    assert.deepEqual(c, { account: 'b', reason: null, waitUntil: null });
  });

  it('moves on over the threshold, to a candidate with hysteresis headroom', () => {
    const limits = { a: lim(0.95), b: lim(0.85), c: lim(0.5) };
    const c = choose(accts, limits, settings, { current: 'a', now: NOW });
    assert.equal(c.account, 'c');
    assert.equal(c.reason, 'threshold');
  });

  it('holds the cooldown unless the current account is exhausted', () => {
    const limits = { a: lim(0.95), b: lim(0.1) };
    const opts = { current: 'a', now: NOW, lastSwitchAt: NOW - 60_000 };
    assert.equal(choose(accts, limits, settings, opts).account, 'a');
    assert.deepEqual(choose(accts, { ...limits, a: lim(1) }, settings, opts), { account: 'b', reason: 'limit', waitUntil: null });
  });

  it('allows an unknown account, ranks it behind a known one under least-used', () => {
    const limits = { a: lim(1), b: lim(null), c: lim(0.2) };
    assert.equal(choose(accts, limits, settings, { current: 'a', now: NOW }).account, 'b');
    assert.equal(choose(accts, limits, { ...settings, strategy: 'least-used' }, { current: 'a', now: NOW }).account, 'c');
  });

  it('skips disabled, signed-out and exhausted accounts; waits when none is left', () => {
    const list = [{ id: 'a', enabled: true, signedIn: true }, { id: 'b', enabled: false, signedIn: true }, { id: 'c', enabled: true, signedIn: false }];
    const reset = NOW + 600_000;
    const c = choose(list, { a: lim(1, { resetsAt: new Date(reset).toISOString() }) }, settings, { current: 'a', now: NOW });
    assert.deepEqual(c, { account: null, reason: null, waitUntil: reset });
    // Past its reset it is usable again
    assert.equal(choose(list, { a: lim(1, { resetsAt: new Date(reset).toISOString() }) }, settings, { current: 'a', now: reset + 1 }).account, 'a');
  });

  it('a policy overrides the order and the threshold; a pinned account keeps it while it can run', () => {
    const policy = { id: 'p', projects: ['x'], order: ['c', 'b'], threshold: 50 };
    const limits = { a: lim(0.1), b: lim(0.1), c: lim(0.1) };
    assert.equal(choose(accts, limits, settings, { current: null, now: NOW, policy }).account, 'c');
    // 60% is over this policy's threshold, and `a` is outside its order
    assert.equal(choose(accts, { ...limits, c: lim(0.6) }, settings, { current: 'c', now: NOW, policy }).account, 'b');
    assert.equal(choose(accts, { ...limits, a: lim(0.99) }, settings, { current: 'b', now: NOW, pinned: 'a' }).account, 'a');
    assert.equal(choose(accts, { ...limits, a: lim(1) }, settings, { current: 'b', now: NOW, pinned: 'a', policy }).account, 'b');
  });
});

describe('claudio-accounts', () => {
  const run = async (args: string[], stdin = '') => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      ['--data-dir', join(root, 'cli-data'), ...args],
      { out: (t) => out.push(t), err: (t) => err.push(t), stdin: async () => stdin, prompt: async () => 'good-code' },
      { env: { ...env(), CLAUDE_CONFIG_DIR: defaultDir }, claude: FAKE },
    );
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  it('adds, lists as JSON, signs in, picks, runs with the account environment, removes', async () => {
    assert.equal((await run(['add', '--token', '-', '--alias', 'bot'], 'sk-ant-oat-zzz\n')).code, 0);
    assert.equal((await run(['add', '--token', 'sk-inline', '--alias', 'bad'])).code, 1);
    assert.equal((await run(['add'])).code, 0);
    const list = JSON.parse((await run(['list', '--json'])).out) as { id: string; kind: string; alias: string | null }[];
    assert.deepEqual(list.map((a) => a.kind), ['login', 'token', 'login']);
    const empty = list[2];
    assert.ok(empty);

    const signedIn = await run(['login', empty.id]);
    assert.equal(signedIn.code, 0, signedIn.err);
    assert.match(signedIn.out, /authorize\?state=x/);

    const status = JSON.parse((await run(['status', '--json'])).out) as { id: string; signedIn: boolean; email: string | null }[];
    assert.equal(status.find((a) => a.id === empty.id)?.email, `${empty.id}@example.com`);

    await run(['alias', empty.id, 'work']);
    await run(['disable', 'bot']);
    const pick = JSON.parse((await run(['pick', '--json'])).out) as { account: string };
    assert.notEqual(pick.account, list[1]?.id);

    const ran = await run(['run', 'work', '--', '-p', 'hi']);
    assert.equal(ran.code, 0);
    assert.equal((await run(['remove', 'work'])).code, 0);
    assert.equal((await run(['remove', 'work'])).code, 1);
  });
});

describe('models from initialize', () => {
  it('parses models[] into options with the id, description and effort levels', async () => {
    const dir = join(root, 'models-a');
    mkdirSync(dir, { recursive: true });
    const opts = { claude: FAKE, env: env() };
    const cache = new ModelCache(join(root, 'model-cache'), opts);
    const entry = await cache.entry({ id: 'a', kind: 'login', dir });
    assert.deepEqual(entry.models.map((m) => m.value), ['default', 'opus', 'haiku']);
    const opus = entry.models.find((m) => m.value === 'opus');
    assert.equal(opus?.resolvedModel, 'claude-opus-5-5');
    assert.equal(opus?.label, 'Opus');
    assert.equal(opus?.tier, 'strong');
    assert.deepEqual(opus?.supportedEffortLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.equal(entry.models.find((m) => m.value === 'haiku')?.supportsEffort, false);
    assert.equal(entry.account.subscriptionType, 'Claude Max');
    assert.equal(entry.cliVersion, '2.1.300 (Claude Code)');
  });

  it('keeps one list per account: a token account lacks what the Max one has', async () => {
    const root2 = join(root, 'accts');
    const s = new AccountStore({ dataDir: root2, defaultDir, claude: FAKE, env: env() });
    const t = await s.add({ kind: 'token', alias: 'pro', secret: 'sk-ant-oat-x' });
    const pro = (await s.models(t.id)).map((m) => m.value);
    const max = (await s.models('default')).map((m) => m.value);
    assert.ok(!pro.includes('opus'));
    assert.ok(max.includes('opus'));
  });

  it('serves the cache until the CLI version or the plan moves', async () => {
    const dir = join(root, 'models-b');
    mkdirSync(dir, { recursive: true });
    const ref = { id: 'b', kind: 'login' as const, dir };
    const count = (): number => readFileSync(join(dir, 'initialize-count'), 'utf8').length;
    const at = (version: string): ModelCache => new ModelCache(join(root, 'model-cache-b'), { claude: FAKE, env: { ...env(), FAKE_CLAUDE_VERSION: version } });
    await at('1.0.0').models(ref);
    await at('1.0.0').models(ref, { plan: 'max' });
    assert.equal(count(), 1);
    await at('1.0.1').models(ref);
    assert.equal(count(), 2);
    await at('1.0.1').models(ref, { plan: 'pro' });
    assert.equal(count(), 3);
    await at('1.0.1').models(ref, { refresh: true });
    assert.equal(count(), 4);
  });

  it('refuses an answer that is not an object', () => {
    assert.throws(() => parseInitialize(null), /no object/);
    assert.deepEqual(parseInitialize({}).models, []);
  });
});
