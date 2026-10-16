import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Account, ModelOption } from '@claudio/shared';
import { accountSwitchText, readNotices } from '../src/lib/chat-notice';
import { accountLabel, accountRow, canChoose } from '../src/lib/account-choice';

const account = (patch: Partial<Account> = {}): Account => ({ id: 'a', kind: 'login', alias: null, email: 'a@x.dev', organization: null, plan: 'max', enabled: true, signedIn: true, signInState: 'ok', limits: null, ...patch });
const limits = (patch: Partial<NonNullable<Account['limits']>> = {}): NonNullable<Account['limits']> => ({
  state: 'ok',
  window: 'five_hour',
  utilization: 0.42,
  resetsAt: '2026-10-16T16:00:00Z',
  windows: {},
  observedAt: '2026-10-16T12:00:00Z',
  source: 'stream',
  ...patch,
});
const chat = { account: 'b', model: 'opus' };
const option = (value: string, ids?: string[]) => ({ value, ...(ids ? { ids } : {}) }) as ModelOption;

test('an account is named by its alias, then its email, then its id', () => {
  assert.equal(accountLabel(account({ alias: 'work' })), 'work');
  assert.equal(accountLabel(account()), 'a@x.dev');
  assert.equal(accountLabel(account({ email: null })), 'a');
});

test("the chat's own account is in use, and a chat with none ran on the default one", () => {
  assert.equal(accountRow(account({ id: 'b' }), chat, undefined).state, 'current');
  assert.equal(accountRow(account({ id: 'default' }), { account: null, model: null }, undefined).state, 'current');
});

test('the reason an account cannot be chosen goes in this order: off, signed out, exhausted', () => {
  assert.equal(accountRow(account({ enabled: false, signedIn: false }), chat, undefined).state, 'disabled');
  assert.equal(accountRow(account({ signedIn: false, limits: limits({ state: 'exhausted' }) }), chat, undefined).state, 'signed-out');
  const exhausted = accountRow(account({ limits: limits({ state: 'exhausted', utilization: 1 }) }), chat, undefined);
  assert.equal(exhausted.state, 'exhausted');
  assert.equal(exhausted.pct, 100);
  assert.equal(exhausted.resetsAt, '2026-10-16T16:00:00Z');
  assert.equal(canChoose(exhausted), false);
});

test('a model the account does not list refuses it; an unread list does not', () => {
  assert.equal(accountRow(account(), chat, [option('sonnet')]).state, 'model-unavailable');
  assert.equal(accountRow(account(), chat, undefined).state, 'ok');
  assert.equal(accountRow(account(), chat, []).state, 'ok');
  assert.equal(accountRow(account(), { account: 'b', model: 'claude-opus-4' }, [option('opus', ['claude-opus-4'])]).state, 'ok');
  assert.equal(canChoose(accountRow(account(), chat, undefined)), true);
});

test('the line of a person\'s account switch reads as a notice, not as their message', () => {
  const read = readNotices(accountSwitchText('work'));
  assert.equal(read.prose, '');
  assert.deepEqual(read.notices, [{ kind: 'account', detail: 'work', body: '' }]);
});
