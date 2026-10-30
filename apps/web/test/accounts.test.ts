import assert from 'node:assert/strict';
import test from 'node:test';
import type { Account, AccountLimit } from '@claudio/shared';
import { accountName, accountReading, accountUsable, canSignInAgain, connectionOf, type ConnectionFacts, readyCount, rotationOrder, signInProblem, sortAccounts, usagePct, windowRows } from '../src/lib/accounts.ts';

const limit = (state: AccountLimit['state'], utilization: number | null): AccountLimit => ({
  state,
  window: 'five_hour',
  utilization,
  resetsAt: null,
  windows: { seven_day: { utilization: 0.2, resetsAt: 0 }, five_hour: { utilization: 0.5, resetsAt: 1_900_000_000 } },
  observedAt: '2026-01-01T00:00:00Z',
  source: 'stream',
});

const account = (id: string, over: Partial<Account> = {}): Account => ({
  id,
  checkedAt: null,
  kind: 'login',
  alias: null,
  email: `${id}@example.com`,
  organization: null,
  plan: null,
  enabled: true,
  signedIn: true,
  signInState: 'ok',
  limits: null,
  ...over,
});

test('an account is named by its alias, else its email, else its id', () => {
  assert.equal(accountName(account('a', { alias: 'work' })), 'work');
  assert.equal(accountName(account('a')), 'a@example.com');
  assert.equal(accountName(account('a', { email: null, kind: 'token' })), 'a');
});

test('usage is a whole percent of the binding window, null when nothing was read', () => {
  assert.equal(usagePct(limit('ok', 0.456)), 46);
  assert.equal(usagePct(limit('ok', null)), null);
  assert.equal(usagePct(null), null);
});

test('usable accounts come first and exhausted ones last, keeping the server order', () => {
  const list = [account('x', { limits: limit('exhausted', 1) }), account('off', { enabled: false }), account('b'), account('c')];
  assert.deepEqual(sortAccounts(list).map((a) => a.id), ['b', 'c', 'off', 'x']);
  assert.equal(accountUsable(account('off', { signedIn: false })), false);
});

test('windows are drawn five hours first, then seven days', () => {
  assert.deepEqual(windowRows(limit('ok', 0.5)).map((w) => [w.key, w.pct]), [['five_hour', 50], ['seven_day', 20]]);
});

test('an expired or incomplete sign-in is a problem to sign in again, and takes the account out of use', () => {
  const expired = account('a', { signedIn: false, signInState: 'expired' });
  const incomplete = account('b', { signedIn: false, signInState: 'incomplete' });
  assert.equal(signInProblem(expired), 'expired');
  assert.equal(signInProblem(incomplete), 'incomplete');
  assert.equal(signInProblem(account('c')), null);
  assert.equal(signInProblem(account('d', { signInState: 'unknown' })), null);
  assert.equal(accountUsable(expired), false);
  assert.deepEqual(sortAccounts([expired, account('e')]).map((a) => a.id), ['e', 'a']);
});

test('only a login account can sign in again', () => {
  assert.equal(canSignInAgain(account('a')), true);
  assert.equal(canSignInAgain(account('b', { kind: 'token' })), false);
});

// ---------- the connection: signed in, at a limit and "could not check" are different words ----------

const facts = (over: Partial<ConnectionFacts> = {}): ConnectionFacts => ({
  cliInstalled: true,
  inUse: { signInState: 'ok' },
  accounts: [{ enabled: true, signedIn: true }],
  provider: { state: 'ready', reason: null },
  ...over,
});

test('connectionOf: ready, and a missing CLI before anything else', () => {
  assert.equal(connectionOf(facts()), 'ready');
  assert.equal(connectionOf(facts({ provider: null })), 'ready', 'before the providers are read');
  assert.equal(connectionOf(facts({ cliInstalled: false, inUse: null, accounts: [] })), 'no-cli');
});

test('connectionOf: a limit or a failed probe never reads as signed out while an account is signed in', () => {
  assert.equal(connectionOf(facts({ inUse: { signInState: 'ok', limit: limit('near', 0.65) } })), 'near');
  assert.equal(connectionOf(facts({ inUse: { signInState: 'ok', limit: limit('exhausted', 1) } })), 'limit');
  assert.equal(connectionOf(facts({ provider: { state: 'unknown', reason: 'probe-timeout' } })), 'unchecked');
  assert.equal(connectionOf(facts({ inUse: null, inUseReason: 'limit' })), 'limit', 'every account exhausted: the server says why');
  assert.equal(connectionOf(facts({ inUse: null, inUseReason: null, provider: { state: 'unknown', reason: 'spawn-failed' } })), 'unchecked', 'no reason, but an account has a credential');
});

test("connectionOf: the account in use's own reading decides, never the provider's reading of whichever account ran last", () => {
  // The audit's §2.11: "acc-B · Near the limit" because acc-A had reached 60 %
  assert.equal(connectionOf(facts({ inUse: { signInState: 'ok', limit: limit('ok', 0.1) }, provider: { state: 'degraded', reason: 'limit-near' } })), 'ready');
  assert.equal(connectionOf(facts({ inUse: { signInState: 'ok', limit: limit('ok', 0.1) }, provider: { state: 'degraded', reason: 'limit-reached' } })), 'ready');
  // A provider without accounts still speaks for its own limit
  assert.equal(connectionOf(facts({ inUse: null, inUseReason: null, provider: { state: 'degraded', reason: 'limit-near' } })), 'near');
  assert.equal(connectionOf(facts({ inUse: null, inUseReason: null, provider: { state: 'degraded', reason: 'limit-reached' } })), 'limit');
  assert.equal(connectionOf(facts({ provider: { state: 'degraded', reason: 'version-above-range' } })), 'unready');
});

test('connectionOf: signed out only when no account has a credential, or the sign-in expired', () => {
  assert.equal(connectionOf(facts({ inUse: null, inUseReason: 'signed-out', accounts: [] })), 'signed-out');
  assert.equal(connectionOf(facts({ inUse: null, accounts: [{ enabled: false, signedIn: true }] })), 'signed-out', 'a disabled account does not count');
  assert.equal(connectionOf(facts({ inUse: null, accounts: [] })), 'signed-out', 'an old server gives no reason');
  assert.equal(connectionOf(facts({ inUse: { signInState: 'expired' } })), 'expired');
  assert.equal(connectionOf(facts({ provider: { state: 'signed-out', reason: 'missing-credentials' } })), 'unready', "the provider's word is not the account's");
});

// ---------- the account view (C4) ----------

test('rotationOrder lists every enabled account once: the saved order first, then the rest in list order', () => {
  const accounts = [account('a'), account('b'), account('c'), account('off', { enabled: false })];
  assert.deepEqual(rotationOrder([], accounts), ['a', 'b', 'c']);
  assert.deepEqual(rotationOrder(['c', 'a'], accounts), ['c', 'a', 'b']);
  // A removed or held-out id drops out, and a duplicate counts once
  assert.deepEqual(rotationOrder(['gone', 'off', 'b', 'b'], accounts), ['b', 'a', 'c']);
});

test("accountReading is the account's binding window as the status bar says it, and silent on an unknown one", () => {
  assert.deepEqual(accountReading(limit('near', 0.654)), { state: 'near', percent: 65, resetsAt: null, window: 'five_hour' });
  assert.equal(accountReading(limit('unknown', 0.5)), null);
  assert.equal(accountReading(null), null);
  assert.equal(readyCount([account('a'), account('b', { enabled: false }), account('c', { signedIn: false })]), 1);
});
