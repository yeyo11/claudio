import type { Account } from '@claudio/shared';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountEntries, accountItem, accountReason, filterRows, SUBMENU_MAX } from '../src/composer/account-menu.tsx';
import { accountRow, type AccountRow } from '../src/lib/account-choice.ts';

const t = (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key);

const account = (id: string, patch: Partial<Account> = {}): Account =>
  ({ id, alias: id, email: null, plan: 'Max', enabled: true, signedIn: true, signInState: 'ok', limits: null, ...patch }) as unknown as Account;

const chat = { account: 'one', model: null };
const rowsOf = (accounts: Account[]): AccountRow[] => accounts.map((a) => accountRow(a, chat, undefined));
const noop = () => {};

test('an account that cannot be chosen says why, and the chat’s own does not', () => {
  const [own, off] = rowsOf([account('one'), account('two', { enabled: false })]);
  assert.equal(accountReason(own as AccountRow, null, t), undefined);
  assert.equal(accountReason(off as AccountRow, null, t), 'composerMenu.account.disabled');
});

test('the choices are a radio group on the chat’s account, with the unusable ones disabled and reasoned', () => {
  const rows = rowsOf([account('one'), account('two'), account('three', { signedIn: false })]);
  const [group] = accountEntries({ rows, model: null, pending: undefined, t, onChoose: noop, onCancel: noop });
  assert.ok(group && 'items' in group && group.radio);
  assert.equal(group.radio.value, 'one');
  const three = group.items.find((i) => i.id === 'three');
  assert.equal(three?.disabled, true);
  assert.equal(three?.disabledReason, 'composerMenu.account.signedOut');
  assert.equal(group.items.find((i) => i.id === 'two')?.disabled, false);
});

test('choosing the account already in use does nothing', () => {
  const chosen: string[] = [];
  const rows = rowsOf([account('one'), account('two')]);
  const [group] = accountEntries({ rows, model: null, pending: undefined, t, onChoose: (id) => chosen.push(id), onCancel: noop });
  assert.ok(group && 'items' in group && group.radio);
  group.radio.onChange('one');
  group.radio.onChange('two');
  assert.deepEqual(chosen, ['two']);
});

test('a switch that waits adds a Cancel switch item that names where the chat is going', () => {
  const rows = rowsOf([account('one'), account('two')]);
  const pending = rows[1];
  const entries = accountEntries({ rows, model: null, pending, t, onChoose: noop, onCancel: noop });
  const cancel = entries.flatMap((e) => ('items' in e ? e.items : [])).find((i) => i.id === 'cancel');
  assert.equal(cancel?.label, 'composerMenu.account.cancel');
  assert.match(String(cancel?.meta), /two/);
  assert.equal(accountEntries({ rows, model: null, pending: undefined, t, onChoose: noop, onCancel: noop }).length, 1);
});

test('with fewer than two accounts there is nothing to choose and no Account item', () => {
  const item = accountItem({ rows: rowsOf([account('one')]), model: null, pending: undefined, t, onChoose: noop, onCancel: noop, onOpenChange: noop, onPicker: noop, picker: () => null });
  assert.equal(item, null);
});

test('a handful of accounts open as a submenu and many open a picker instead', () => {
  const few = Array.from({ length: SUBMENU_MAX }, (_, i) => account(i === 0 ? 'one' : `a${i}`));
  const many = [...few, account('extra')];
  const build = (accounts: Account[]) => accountItem({ rows: rowsOf(accounts), model: null, pending: undefined, t, onChoose: noop, onCancel: noop, onOpenChange: noop, onPicker: noop, picker: () => null });
  assert.ok(build(few)?.submenu);
  assert.equal(build(few)?.detail, undefined);
  assert.equal(build(many)?.submenu, undefined);
  assert.ok(build(many)?.detail);
});

test('the picker filters by name, email or plan and shows everything while the field is blank', () => {
  const rows = rowsOf([account('work', { plan: 'Team' }), account('home', { plan: 'Pro', email: 'me@home.test' }), account('one')]);
  assert.equal(filterRows(rows, '  ').length, 3);
  assert.deepEqual(filterRows(rows, 'TEAM').map((r) => r.account.id), ['work']);
  assert.deepEqual(filterRows(rows, 'home.test').map((r) => r.account.id), ['home']);
  assert.deepEqual(filterRows(rows, 'nothing'), []);
});
