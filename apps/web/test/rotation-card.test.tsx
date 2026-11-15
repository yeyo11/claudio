// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Account, AccountsSettings } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { ToastProvider } from '@claudio/ui/components/Toast';
import i18n from '../src/i18n';
import { moveInOrder } from '../src/pages/accounts/AccountOrderList';
import { RotationCard } from '../src/pages/accounts/RotationCard';

const account = (id: string, over: Partial<Account> = {}): Account => ({
  id,
  kind: 'login',
  alias: id,
  email: null,
  organization: null,
  plan: 'max',
  enabled: true,
  signedIn: true,
  signInState: 'ok',
  checkedAt: null,
  limits: null,
  ...over,
});

const settings = (over: Partial<AccountsSettings> = {}): AccountsSettings => ({
  rotateOnLimit: true,
  threshold: 90,
  hysteresis: 10,
  cooldownSeconds: 300,
  strategy: 'order',
  preferred: null,
  order: [],
  newAccountConfig: 'shared',
  credits: {},
  ...over,
});

const draw = (s: AccountsSettings, accounts: Account[]) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <TooltipProvider>
          <ToastProvider>
            <RotationCard settings={s} accounts={accounts} />
          </ToastProvider>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
const words = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test.beforeEach(async () => {
  await i18n.changeLanguage('en');
});

test('with switching at the limit off, the threshold, hysteresis and cooldown are read-only and say when they apply', () => {
  const off = draw(settings({ rotateOnLimit: false }), [account('a'), account('b')]);
  assert.equal((words(off).match(/Applies when switching at the limit is on/g) ?? []).length, 3);
  assert.match(off, /aria-disabled="true"[^>]*class="slider"/);
  assert.equal((off.match(/<input type="number"[^>]*disabled=""/g) ?? []).length, 2);
  const on = draw(settings(), [account('a'), account('b')]);
  assert.doesNotMatch(words(on), /Applies when switching at the limit is on/);
});

test('"In order" lists every enabled account once, the saved order first, with up and down buttons', () => {
  const html = draw(settings({ order: ['b'] }), [account('a'), account('b'), account('off', { enabled: false })]);
  const list = /<ol[^>]*>(.*?)<\/ol>/.exec(html)?.[1] ?? '';
  assert.deepEqual([...list.matchAll(/class="break">([^<]+)</g)].map((m) => m[1]), ['b', 'a']);
  assert.match(list, /Move b earlier|aria-label="[^"]*b[^"]*"/);
  // The global order is not an allow-list: nothing can be taken out of it
  assert.doesNotMatch(list, /Remove/);
  // Least used has no order to show
  assert.doesNotMatch(draw(settings({ strategy: 'least-used' }), [account('a'), account('b')]), /<ol/);
});

test('the strategy says what it decides once a preferred account is full, and the order is a row of its own', () => {
  const html = draw(settings(), [account('a'), account('b')]);
  assert.match(words(html), /Next account In order Least used Where work goes when the preferred account is full/);
  assert.match(html, /class="rotation-order"/);
});

test('moveInOrder swaps one entry with its neighbour, and does nothing at an edge', () => {
  assert.deepEqual(moveInOrder(['a', 'b', 'c'], 1, -1), ['b', 'a', 'c']);
  assert.deepEqual(moveInOrder(['a', 'b', 'c'], 1, 1), ['a', 'c', 'b']);
  assert.deepEqual(moveInOrder(['a', 'b'], 0, -1), ['a', 'b']);
});

test('usage credits are offered per account only where they were ever set up, and say what each use means', () => {
  const withCredits = account('paid', { limits: { state: 'ok', window: null, utilization: 0.1, resetsAt: null, windows: {}, observedAt: '2026-11-15T00:00:00Z', source: 'cli', cli: { observedAt: '2026-11-15T00:00:00Z', plan: 'max', available: true, scoped: [], credits: { enabled: true, usedMinor: 0, limitMinor: 4000, currency: 'USD', exponent: 2, limitReached: false, disabledReason: null, everEnabled: true } } } });
  const none = draw(settings(), [account('a'), account('b')]);
  assert.doesNotMatch(words(none), /Usage credits/, 'no account has credits: the setting would change nothing');
  const html = draw(settings({ credits: { paid: { use: 'last-resort', capMinor: 1000 } } }), [account('a'), withCredits]);
  assert.match(words(html), /Usage credits/);
  assert.match(html, /aria-label="Usage credits of paid"/);
  assert.doesNotMatch(html, /aria-label="Usage credits of a"/);
  // The cap in the account's own currency, as Intl writes it for the language
  assert.match(words(html), /Spent only when no account has plan quota left · up to .{0,6}10[.,]00.{0,6} a month/);
  assert.match(html, /aria-label="Monthly cap on the credits of paid"/);
});
