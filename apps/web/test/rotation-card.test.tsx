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

const settings = (over: Partial<AccountsSettings> & { preferred?: string | null; order?: string[] } = {}): AccountsSettings => ({
  rotateOnLimit: true,
  threshold: 90,
  hysteresis: 10,
  cooldownSeconds: 300,
  strategy: 'order',
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

test('the strategy is named for what it decides once a preferred account is full', () => {
  assert.match(words(draw(settings(), [account('a'), account('b')])), /Where work goes when the preferred account is full/);
});

test('moveInOrder swaps one entry with its neighbour, and does nothing at an edge', () => {
  assert.deepEqual(moveInOrder(['a', 'b', 'c'], 1, -1), ['b', 'a', 'c']);
  assert.deepEqual(moveInOrder(['a', 'b', 'c'], 1, 1), ['a', 'c', 'b']);
  assert.deepEqual(moveInOrder(['a', 'b'], 0, -1), ['a', 'b']);
});
