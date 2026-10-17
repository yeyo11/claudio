// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Account } from '@claudio/shared';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountList } from '@claudio/chat-ui/composer/AccountList';
import { accountRow } from '@claudio/chat-ui/lib/account-choice';
import { setLanguage } from '../src/i18n';

// The account field of a new chat is the radio list of the composer's "+" menu: the same rows, the
// same reasons, and a search field only once there are more than a submenu holds.

// tsx compiles the packages' files with the classic runtime too, and they do not import React
(globalThis as { React?: typeof React }).React = React;

const account = (id: string, patch: Partial<Account> = {}): Account =>
  ({ id, alias: id, email: null, plan: 'Max', enabled: true, signedIn: true, signInState: 'ok', limits: null, ...patch }) as unknown as Account;

const render = (accounts: Account[], chosen: string) => {
  setLanguage('en');
  const rows = accounts.map((a) => accountRow(a, { account: chosen, model: null }, undefined));
  return renderToStaticMarkup(<AccountList rows={rows} model={null} chosen={chosen} auto="Automatic" label="Account" onChoose={() => {}} />);
};

test('automatic is the first row and is the one chosen until an account is', () => {
  const html = render([account('work'), account('home')], '');
  assert.match(html, /role="radiogroup"/);
  assert.match(html, /aria-checked="true"[^>]*>(?:(?!<\/button>).)*Automatic/);
  assert.doesNotMatch(html, /type="search"/, 'two accounts need no search');
});

test('an account that cannot be chosen says why under its row', () => {
  const html = render([account('work'), account('gone', { signedIn: false })], 'work');
  assert.match(html, /account-picker-why/);
  assert.match(html, /aria-disabled="true"/);
});

test('past six accounts the list has a search field', () => {
  const many = Array.from({ length: 7 }, (_, i) => account(`acc-${i}`));
  assert.match(render(many, ''), /type="search"/);
});
