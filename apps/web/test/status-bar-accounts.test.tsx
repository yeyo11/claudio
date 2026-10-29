// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Account, AccountLimit, ClaudioEvent, ProviderLimit, ProviderStatus } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { formatPercent } from '@claudio/ui/lib/format';
import { keys } from '../src/api';
import { ProviderDots } from '../src/components/shell/ProviderDots';
import { AccountCard, type Connection } from '../src/components/shell/StatusBar';
import i18n from '../src/i18n';
import type { AccountView } from '../src/lib/accounts';
import { targetsFor } from '../src/lib/events';

// The audit's §2.11: the status bar, the account chip, the provider's dot and the phone's cards say
// one fact, the account view's account in use, and never a reading another account sent.

const reading = (state: AccountLimit['state'], utilization: number): AccountLimit => ({
  state,
  window: 'five_hour',
  utilization,
  resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
  windows: { five_hour: { utilization, resetsAt: Math.floor(Date.now() / 1000) + 7200 }, seven_day: { utilization: 0.2, resetsAt: Math.floor(Date.now() / 1000) + 86_400 } },
  observedAt: new Date(Date.now() - 60_000).toISOString(),
  source: 'stream',
});

const account = (id: string, limits: AccountLimit | null): Account => ({
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
  limits,
});

const status: ProviderStatus = {
  id: 'claude-code',
  label: 'Claude Code',
  state: 'degraded',
  reason: 'limit-reached',
  version: '2.1.282',
  compatibleRange: '>=2.1 <3',
  binaryPath: null,
  configHome: null,
  account: null,
  capabilities: ['rateLimitWindows'],
  checkedAt: '2026-10-02T10:00:00Z',
};

// What the provider says: the last `rate_limit_event` of any chat, here acc-a's, which is spent
const providerLimit: ProviderLimit = { provider: 'claude-code', state: 'exhausted', window: '5h', utilization: 1, resetsAt: null, windows: {}, observedAt: new Date().toISOString(), source: 'stream' };

const view = (): AccountView => {
  const accB = account('acc-b', reading('ok', 0.1));
  return {
    inUse: { id: 'acc-b', label: 'acc-b', kind: 'login', signInState: 'ok', checkedAt: null, limit: accB.limits, plan: 'max' },
    inUseReason: null,
    accounts: [account('acc-a', reading('exhausted', 1)), accB],
    atLimit: false,
    nextReset: null,
    settings: { rotateOnLimit: true, threshold: 90, hysteresis: 10, cooldownSeconds: 300, strategy: 'order', preferred: null, order: [] },
  };
};

function seeded(): QueryClient {
  const client = new QueryClient();
  client.setQueryData(keys.providers, [status]);
  client.setQueryData(keys.providerSettings, { providers: { 'claude-code': { enabled: true, binaryPath: null } }, order: ['claude-code'], defaultProvider: null });
  client.setQueryData(keys.overview, { limits: [providerLimit], accounts: view() });
  return client;
}

const draw = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={seeded()}>
      <MemoryRouter>
        <TooltipProvider>{node}</TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

test.beforeEach(async () => {
  await i18n.changeLanguage('en');
});

test("Claude Code's dot shows the account in use, not the spent reading another account sent", () => {
  const v = view();
  const html = draw(<ProviderDots limits={[providerLimit]} inUse={v.inUse} />);
  assert.doesNotMatch(html, /limit reached|statusbar-bad/);
  assert.ok(html.includes(formatPercent(10)));
  // Without accounts the provider's own reading still speaks
  assert.match(draw(<ProviderDots limits={[providerLimit]} />), /limit reached/);
});

test("the phone's card names the account in use with its own windows, and counts the ready ones from the same view", () => {
  const connection: Connection = { tone: 'ok', live: true, healthy: true, title: 'Claude Code', detail: 'Max · acc-b', short: 'acc-b' };
  const now = { overview: { data: { limits: [providerLimit], accounts: view() } }, limits: [providerLimit], todayCost: 0 } as unknown as Parameters<typeof AccountCard>[0]['now'];
  const html = draw(<AccountCard now={now} connection={connection} />);
  const words = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(words, /acc-b/);
  assert.match(words, /Ready · 2 of 2 ready/);
  assert.doesNotMatch(words, /limit reached/);
  assert.ok(html.includes(formatPercent(10)));
});

test('accounts.changed refreshes every account fact on screen: the list and settings, the view, the account in use and the providers', () => {
  const event = { id: 1, type: 'accounts.changed' } as unknown as ClaudioEvent;
  const refreshed = targetsFor(event).map(([key]) => key.join('/'));
  for (const key of [keys.accounts, keys.overview, keys.auth, keys.providers]) assert.ok(refreshed.includes(key.join('/')), key.join('/'));
});
