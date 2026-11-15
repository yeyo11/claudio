import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AccountCreditsUse, AccountLimit, AccountSignInState, AccountsSettings, RotationPolicy } from '@claudio/shared';
import { AccountStore, choose, RESERVE_CAP, SHARED_CONFIG_GROUP, type AccountReserve, type Candidate, type ChooseOptions } from '../src/index.ts';
import { bare } from './bare-choice.ts';
import { chooseBeforeRules, type ChooseOptions as BeforeOptions } from './fixtures/choose-before-rules.ts';

/*
 * The project rules in the account choice (T6 of docs/plans/account-configuration-and-project-rules.md):
 * the rule's preferred account, the reserve another project with work in progress holds, the
 * configuration group as a tie-breaker, and the explanation every choice carries. First of all, the
 * owner's requirement: with no rule configured, the choice is exactly the one made before the rules.
 */

const NOW = Date.parse('2026-11-15T12:00:00Z');
const HOUR = 3600_000;
const sec = (ms: number): number => Math.floor(ms / 1000);

const SETTINGS: AccountsSettings = { rotateOnLimit: true, threshold: 90, hysteresis: 10, cooldownSeconds: 300, strategy: 'least-used', preferred: null, order: [], newAccountConfig: 'shared', credits: {} };
const ACCOUNTS: Candidate[] = ['a', 'b', 'c'].map((id) => ({ id, enabled: true, signedIn: true }));

const room = (u: number | null): AccountLimit => ({
  state: u === null ? 'unknown' : u >= 0.6 ? 'near' : 'ok',
  window: 'five_hour',
  utilization: u,
  resetsAt: new Date(NOW + HOUR).toISOString(),
  windows: {},
  observedAt: new Date(NOW).toISOString(),
  source: 'stream',
});
const out = (resetIn: number): AccountLimit => ({ ...room(1), state: 'exhausted', resetsAt: new Date(NOW + resetIn).toISOString() });

/** A rule for the work's project: today's policy fields plus the rule's */
const rule = (over: Omit<Partial<RotationPolicy>, 'preferred'> & { preferred?: string | null } = {}): ChooseOptions['policy'] => ({ id: 'p1', projects: ['proj-a'], ...over });

// ---------- the default: no rule, the same choice as before ----------

/** A deterministic generator, so a failing case can be told by its seed */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Case {
  accounts: Candidate[];
  limits: Record<string, AccountLimit | null | undefined>;
  settings: AccountsSettings;
  /** What the choice took before the rules, which the choice now takes unchanged */
  opts: BeforeOptions;
}

/**
 * One random situation over everything the choice read before the rules: sign-in states, readings
 * (unknown, near the threshold, spent with or without a reset, in overage with a known spend or none,
 * a spent scoped limit),
 * both strategies, the preferred account and the order, the credits setting and its cap, a policy's
 * allow list and threshold, a pin, a model some accounts cannot run, and failed accounts.
 */
function situation(rand: () => number): Case {
  const pickOne = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const subset = (xs: readonly string[]): string[] => xs.filter(() => rand() < 0.5).sort(() => rand() - 0.5);
  const ids = ['a', 'b', 'c', 'd'].slice(0, 1 + Math.floor(rand() * 4));
  const states: (AccountSignInState | undefined)[] = [undefined, undefined, undefined, 'ok', 'unknown', 'expired', 'incomplete'];
  const accounts: Candidate[] = ids.map((id) => ({ id, enabled: rand() < 0.9, signedIn: rand() < 0.9, ...((s) => (s ? { signInState: s } : {}))(pickOne(states)) }));
  const usedMinor = pickOne([0, 320, 5000]);
  const limitOf = (): AccountLimit | null | undefined => {
    switch (pickOne(['none', 'null', 'unknown', 'room', 'room', 'room', 'out', 'out-unknown-reset', 'past-reset', 'overage', 'scoped'] as const)) {
      case 'none':
        return undefined;
      case 'null':
        return null;
      case 'unknown':
        return room(null);
      case 'room':
        return room(pickOne([0, 0.3, 0.5, 0.79, 0.8, 0.81, 0.85, 0.89, 0.9, 0.95, 0.99]));
      case 'out':
        return out(pickOne([1, 2, 3]) * HOUR);
      case 'out-unknown-reset':
        return { ...out(HOUR), resetsAt: null };
      case 'past-reset':
        return out(-HOUR);
      case 'overage':
        return {
          ...out(HOUR),
          cli: { observedAt: new Date(NOW).toISOString(), plan: 'max', available: true, scoped: [], credits: rand() < 0.2 ? null : { enabled: true, usedMinor, limitMinor: null, currency: 'USD', exponent: 2, limitReached: false, disabledReason: null, everEnabled: true } },
          creditsCover: rand() < 0.8,
        };
      case 'scoped':
        return {
          ...room(pickOne([0.2, 0.85])),
          cli: { observedAt: new Date(NOW).toISOString(), plan: 'max', available: true, scoped: [{ model: 'Fable', window: 'seven_day', utilization: 1, resetsAt: sec(NOW + 5 * HOUR) }], credits: null },
        };
    }
  };
  const limits = Object.fromEntries(ids.map((id) => [id, limitOf()]));
  const credits: AccountsSettings['credits'] = {};
  for (const id of ids) {
    if (rand() < 0.5) credits[id] = { use: pickOne<AccountCreditsUse>(['never', 'last-resort', 'allow']), capMinor: pickOne([null, 1000, 10_000]) };
  }
  const settings: AccountsSettings = {
    ...SETTINGS,
    threshold: pickOne([80, 90, 95]),
    hysteresis: pickOne([0, 10, 20]),
    strategy: pickOne(['least-used', 'order'] as const),
    preferred: rand() < 0.4 ? pickOne([...ids, 'gone']) : null,
    order: subset([...ids, 'gone']),
    credits,
  };
  const known = [...ids, 'gone'];
  const cannot = new Set(subset(ids));
  const policy: RotationPolicy | null =
    rand() < 0.4 ? { id: 'p', projects: ['proj'], ...(rand() < 0.7 ? { order: subset(known) } : {}), ...(rand() < 0.5 ? { threshold: pickOne([70, 85, 95]) } : {}) } : null;
  const opts: BeforeOptions = {
    current: rand() < 0.2 ? null : pickOne(known),
    now: NOW,
    policy,
    ...(rand() < 0.3 ? { pinned: pickOne(known) } : {}),
    ...(rand() < 0.5 ? { model: pickOne(['default', 'opus', 'claude-fable-5']), canRun: (id: string) => !cannot.has(id) } : {}),
    ...(rand() < 0.3 ? { failedOn: subset(ids) } : {}),
  };
  return { accounts, limits, settings, opts };
}

describe('no rule configured', () => {
  const CASES = 20_000;

  it('chooses what the choice before the rules chose, in every generated situation', () => {
    const rand = prng(0x7a6);
    for (let n = 0; n < CASES; n++) {
      const c = situation(rand);
      const before = chooseBeforeRules(c.accounts, c.limits, c.settings, c.opts);
      assert.deepEqual(bare(choose(c.accounts, c.limits, c.settings, c.opts)), before, `case ${n}: ${JSON.stringify({ ...c, opts: { ...c.opts, canRun: undefined } })}`);
    }
  });

  it('still chooses the same when every account is in the shared group and the only reserves are the work\'s own project\'s', () => {
    // What the store passes with every account shared (the default mode), and what core passes for a
    // project that holds a reserve for itself: neither is a rule acting on the work
    const rand = prng(0x5eed);
    for (let n = 0; n < CASES; n++) {
      const c = situation(rand);
      const accounts = c.accounts.map((a) => ({ ...a, configGroup: SHARED_CONFIG_GROUP }));
      const reserved: AccountReserve[] = c.accounts.map((a) => ({ project: 'proj', account: a.id, percent: 20 }));
      const opts: ChooseOptions = { ...c.opts, project: 'proj', reserved, ...(c.opts.policy ? { policy: { ...c.opts.policy, preferred: null, strictConfig: false } } : {}) };
      const before = chooseBeforeRules(c.accounts, c.limits, c.settings, c.opts);
      assert.deepEqual(bare(choose(accounts, c.limits, c.settings, opts)), before, `case ${n}`);
    }
  });

  it('explains every choice, and names no rule or reserve when none acted', () => {
    const rand = prng(0xbeef);
    for (let n = 0; n < 2000; n++) {
      const c = situation(rand);
      const { why, account } = choose(c.accounts, c.limits, c.settings, { ...c.opts, policy: null });
      assert.ok(why.basis, `case ${n}`);
      assert.equal(why.passedOver, undefined, `case ${n}: nothing passed over without a rule`);
      assert.equal(account === null, why.basis === 'none', `case ${n}`);
    }
  });
});

// ---------- allowed accounts ----------

describe("a project's allowed accounts", () => {
  it('names the accounts the rule kept the work off, and never takes one, not on a pin nor on its credits', () => {
    const settings: AccountsSettings = { ...SETTINGS, credits: { c: { use: 'last-resort', capMinor: null } } };
    const overage: AccountLimit = { ...out(HOUR), creditsCover: true };
    const limits = { a: out(HOUR), b: out(2 * HOUR), c: overage };
    const policy = rule({ order: ['a', 'b'] });
    const c = choose(ACCOUNTS, limits, settings, { current: 'a', now: NOW, policy, project: 'proj-a', pinned: 'c' });
    assert.equal(c.account, null, 'c is out of the rule: not for the pin, not on its credits');
    assert.equal(c.waitUntil, NOW + HOUR, 'the wait is for an allowed account');
    assert.deepEqual(c.why, { basis: 'none', passedOver: [{ account: 'c', because: 'not-allowed', project: 'proj-a' }] });
    // Without the rule, the same situation runs on c's credits
    assert.equal(choose(ACCOUNTS, limits, settings, { current: 'a', now: NOW }).account, 'c');
  });
});

// ---------- the rule's preferred account ----------

describe("a rule's preferred account", () => {
  it("replaces the person's preferred account within the project, with the same threshold and hysteresis", () => {
    const settings = { ...SETTINGS, preferred: 'a' };
    const limits = { a: room(0.1), b: room(0.5), c: room(0.2) };
    assert.equal(choose(ACCOUNTS, limits, settings, { current: null, now: NOW }).account, 'a', "the person's preference elsewhere");
    const inProject = choose(ACCOUNTS, limits, settings, { current: null, now: NOW, policy: rule({ preferred: 'b' }), project: 'proj-a' });
    assert.equal(inProject.account, 'b');
    assert.deepEqual(inProject.why, { basis: 'project-preferred', project: 'proj-a' });
    // Coming back to it needs the hysteresis; staying on it only the threshold
    assert.equal(choose(ACCOUNTS, { ...limits, b: room(0.85) }, settings, { current: 'c', now: NOW, policy: rule({ preferred: 'b' }) }).account, 'c', 'no coming back inside the margin');
    assert.equal(choose(ACCOUNTS, { ...limits, b: room(0.85) }, settings, { current: 'b', now: NOW, policy: rule({ preferred: 'b' }) }).account, 'b', 'staying under the threshold');
    assert.equal(choose(ACCOUNTS, { ...limits, b: room(0.95) }, settings, { current: 'b', now: NOW, policy: rule({ preferred: 'b' }) }).account, 'a', 'over it the strategy takes over');
  });

  it("a rule with no preferred account leaves the person's, and a preferred account the rule forbids is not taken", () => {
    const settings = { ...SETTINGS, preferred: 'a' };
    const limits = { a: room(0.4), b: room(0.1), c: room(0.2) };
    assert.equal(choose(ACCOUNTS, limits, settings, { current: null, now: NOW, policy: rule({ preferred: null }) }).why.basis, 'preferred');
    const forbidden = choose(ACCOUNTS, limits, settings, { current: null, now: NOW, policy: rule({ order: ['b', 'c'], preferred: 'a' }) });
    assert.equal(forbidden.account, 'b');
    assert.equal(forbidden.why.basis, 'least-used');
  });
});

// ---------- the reserve ----------

describe("another project's reserve", () => {
  const reserve = (percent: number, account = 'a', project = 'proj-b'): AccountReserve[] => [{ project, account, percent }];

  it('moves other work off the reserved account earlier, and says so', () => {
    const limits = { a: room(0.65), b: room(0.4), c: room(0.5) };
    const opts: ChooseOptions = { current: 'a', now: NOW, project: 'proj-a', reserved: reserve(30) };
    assert.equal(choose(ACCOUNTS, limits, SETTINGS, { current: 'a', now: NOW }).account, 'a', 'without it, 65 % is under 90 %');
    const c = choose(ACCOUNTS, limits, SETTINGS, opts);
    assert.equal(c.account, 'b');
    assert.equal(c.reason, 'reserve', 'under its own threshold, only the reserve moved it');
    assert.deepEqual(c.why, { basis: 'least-used', passedOver: [{ account: 'a', because: 'reserved', project: 'proj-b' }] });
  });

  it("never holds back the reserving project's own work", () => {
    const limits = { a: room(0.65), b: room(0.4), c: room(0.5) };
    const c = choose(ACCOUNTS, limits, SETTINGS, { current: 'a', now: NOW, project: 'proj-b', reserved: reserve(30) });
    assert.equal(c.account, 'a');
    assert.deepEqual(c.why, { basis: 'current' });
  });

  it('is capped at 30 points, and the largest of two reserves on one account counts', () => {
    const limits = { a: room(0.55), b: room(0.1), c: room(0.1) };
    assert.equal(RESERVE_CAP, 30);
    // 90 − 30 = 60: an account at 55 % stays; 90 − 50 would have been 40
    assert.equal(choose(ACCOUNTS, limits, SETTINGS, { current: 'a', now: NOW, reserved: reserve(50) }).account, 'a', 'capped');
    const two: AccountReserve[] = [...reserve(10), ...reserve(30, 'a', 'proj-c')];
    const c = choose(ACCOUNTS, { ...limits, a: room(0.7) }, SETTINGS, { current: 'a', now: NOW, reserved: two });
    assert.equal(c.account, 'b');
    assert.deepEqual(c.why.passedOver, [{ account: 'a', because: 'reserved', project: 'proj-c' }]);
  });

  it('diverts work onto any other account that is not out, over its threshold too, before the reserved headroom', () => {
    const limits = { a: room(0.7), b: room(0.95), c: out(HOUR) };
    const c = choose(ACCOUNTS, limits, SETTINGS, { current: 'a', now: NOW, reserved: reserve(30) });
    assert.equal(c.account, 'b');
    assert.equal(c.reason, 'reserve');
    assert.equal(c.why.basis, 'over-threshold');
    assert.equal(choose(ACCOUNTS, limits, SETTINGS, { current: null, now: NOW, reserved: reserve(30) }).account, 'b', 'new work too');
  });

  it('is released when every other account is out: running beats waiting', () => {
    const limits = { a: room(0.7), b: out(HOUR), c: out(2 * HOUR) };
    const stays = choose(ACCOUNTS, limits, SETTINGS, { current: 'a', now: NOW, reserved: reserve(30) });
    assert.equal(stays.account, 'a');
    assert.equal(stays.reason, null);
    assert.deepEqual(stays.why, { basis: 'reserve-released', project: 'proj-b' });
    const moves = choose(ACCOUNTS, limits, SETTINGS, { current: 'b', now: NOW, reserved: reserve(30) });
    assert.equal(moves.account, 'a');
    assert.equal(moves.reason, 'limit', 'the reason is why it left b');
    assert.deepEqual(moves.why, { basis: 'reserve-released', project: 'proj-b' });
  });

  it('leaves alone the work it does not need to move: an account well under the lowered threshold is kept, and a pin wins', () => {
    const limits = { a: room(0.3), b: room(0.1), c: room(0.1) };
    assert.deepEqual(choose(ACCOUNTS, limits, SETTINGS, { current: 'a', now: NOW, reserved: reserve(30) }).why, { basis: 'current' }, 'nothing passed over at 30 %');
    const pinned = choose(ACCOUNTS, { ...limits, a: room(0.8) }, SETTINGS, { current: 'b', now: NOW, pinned: 'a', reserved: reserve(30) });
    assert.equal(pinned.account, 'a', "a pin is a person's choice");
    assert.equal(pinned.why.basis, 'pin');
  });
});

// ---------- configuration groups ----------

describe('the configuration group as a tie-breaker', () => {
  // a and c share the default's configuration; b is independent
  const grouped: Candidate[] = [
    { id: 'a', enabled: true, signedIn: true, configGroup: SHARED_CONFIG_GROUP },
    { id: 'b', enabled: true, signedIn: true, configGroup: 'independent:b' },
    { id: 'c', enabled: true, signedIn: true, configGroup: SHARED_CONFIG_GROUP },
  ];

  it('moves work to an account with the same configuration before the strategy, and says so', () => {
    const limits = { a: room(0.95), b: room(0.1), c: room(0.3) };
    const c = choose(grouped, limits, SETTINGS, { current: 'a', now: NOW });
    assert.equal(c.account, 'c', 'least-used would take b');
    assert.equal(c.reason, 'threshold');
    assert.deepEqual(c.why, { basis: 'same-config' });
    assert.equal(choose(grouped, limits, { ...SETTINGS, strategy: 'order' }, { current: 'a', now: NOW, policy: rule({ order: ['a', 'b', 'c'] }) }).account, 'c', 'over the order too');
  });

  it('never over room: an account of another group with room beats one of the same group without it', () => {
    const limits = { a: room(0.95), b: room(0.1), c: room(0.85) };
    const c = choose(grouped, limits, SETTINGS, { current: 'a', now: NOW });
    assert.equal(c.account, 'b');
    assert.deepEqual(c.why, { basis: 'only-one' });
  });

  it('changes nothing for new work, which has no configuration to keep', () => {
    const limits = { a: room(0.5), b: room(0.1), c: room(0.3) };
    assert.equal(choose(grouped, limits, SETTINGS, { current: null, now: NOW }).account, 'b');
  });

  it('a strict rule rotates only within the group: it waits rather than cross', () => {
    const limits = { a: out(HOUR), b: room(0.1), c: out(2 * HOUR) };
    const policy = rule({ strictConfig: true });
    assert.equal(choose(grouped, limits, SETTINGS, { current: 'a', now: NOW }).account, 'b', 'a tie-breaker only');
    const c = choose(grouped, limits, SETTINGS, { current: 'a', now: NOW, policy, project: 'proj-a' });
    assert.equal(c.account, null);
    assert.equal(c.waitUntil, NOW + HOUR, "the earliest reset in the work's group");
    assert.deepEqual(c.why, { basis: 'none', passedOver: [{ account: 'b', because: 'other-config', project: 'proj-a' }] });
    assert.equal(choose(grouped, limits, SETTINGS, { current: 'a', now: NOW, policy, pinned: 'b' }).account, 'b', 'a pin is not a rotation');
  });
});

// ---------- the store ----------

describe("the store's choice", () => {
  let root: string;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'accounts-rules-'));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("passes each account's configuration group from its stored mode", async () => {
    const defaultDir = mkdtempSync(join(root, 'default-'));
    writeFileSync(join(defaultDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { refreshToken: 'r' } }));
    const s = new AccountStore({ dataDir: mkdtempSync(join(root, 'data-')), defaultDir, claude: '/nonexistent', env: { PATH: process.env.PATH } });
    const shared = await s.add({ kind: 'login' });
    await s.setSettings({ newAccountConfig: 'independent' });
    const own = await s.add({ kind: 'login' });
    assert.equal(s.configGroupOf('default'), SHARED_CONFIG_GROUP);
    assert.equal(s.configGroupOf(shared.id), SHARED_CONFIG_GROUP);
    assert.equal(s.configGroupOf(own.id), `independent:${own.id}`);
    await s.setConfigMode(own.id, 'shared');
    assert.equal(s.configGroupOf(own.id), SHARED_CONFIG_GROUP, 'back to shared');
  });
});
