// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderLimit, ProviderStatus, ProvidersSettings } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { keys } from '../src/api';
import { TooltipProvider } from '@claudio/ui/components/controls';
import { ConfirmProvider } from '@claudio/ui/components/Dialog';
import { ToastProvider } from '@claudio/ui/components/Toast';
import i18n from '../src/i18n';
import { DirtyProvider } from '../src/lib/dirty';
import { ProvidersTab } from '../src/pages/config/ProvidersTab';
import { limitRows } from '../src/lib/limit-rows';

const status = (id: string, over: Partial<ProviderStatus> = {}): ProviderStatus => ({
  id,
  label: 'Claude Code',
  state: 'ready',
  reason: null,
  version: '1.0.0',
  compatibleRange: '>=1.0.0',
  binaryPath: `/usr/bin/${id}`,
  configHome: null,
  account: id === 'claude-code' ? 'ada@example.com' : null,
  capabilities: [],
  checkedAt: '2026-10-02T10:00:00Z',
  ...over,
});

const settings = (over: Partial<ProvidersSettings> = {}): ProvidersSettings => ({
  providers: { 'claude-code': { enabled: true, binaryPath: null } },
  order: ['claude-code'],
  defaultProvider: null,
  ...over,
});

const limit = (over: Partial<ProviderLimit> = {}): ProviderLimit => ({
  provider: 'claude-code',
  state: 'near',
  window: '5h',
  utilization: 0.72,
  resetsAt: '2099-01-01T14:05:00Z',
  windows: { '7d': { utilization: 0.21, resetsAt: 4_102_444_800 }, '5h': { utilization: 0.72, resetsAt: 4_102_444_800 } },
  observedAt: new Date().toISOString(),
  source: 'stream',
  ...over,
});

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test.beforeEach(async () => {
  await i18n.changeLanguage('en');
});

test('the windows of a limit read 5 h first, then 7 d, then the rest, as percentages', () => {
  const rows = limitRows(limit({ windows: { opus: { utilization: 0.4, resetsAt: 0 }, '7d': { utilization: 0.21, resetsAt: 4_102_444_800 }, '5h': { utilization: 1.4, resetsAt: 4_102_444_800 } } }));
  assert.deepEqual(rows.map((r) => [r.name, r.percent]), [['5h', 100], ['7d', 21], ['opus', 40]]);
  assert.equal(rows[2]?.resetsAt, null);
  // A provider that reports one figure and no windows still shows it
  assert.deepEqual(limitRows(limit({ windows: {}, window: 'primary', utilization: 0.5, resetsAt: null })), [{ name: 'primary', percent: 50, resetsAt: null }]);
  assert.deepEqual(limitRows(limit({ windows: {}, state: 'unknown', utilization: null })), []);
});

function render(page: React.ReactNode, client: QueryClient): string {
  const router = createMemoryRouter([
    {
      path: '*',
      element: (
        <TooltipProvider>
          <ToastProvider>
            <ConfirmProvider>
              <DirtyProvider>{page}</DirtyProvider>
            </ConfirmProvider>
          </ToastProvider>
        </TooltipProvider>
      ),
    },
  ]);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function seeded(): QueryClient {
  const client = new QueryClient();
  client.setQueryData(keys.providers, [status('claude-code', { limit: limit() })]);
  client.setQueryData(keys.providerSettings, settings());
  return client;
}

test('Settings → Providers shows Claude Code with its limit, each window with its word', () => {
  const html = render(<ProvidersTab />, seeded());
  const words = text(html);
  // The limit bars: the thresholds, the percentages and the words next to the colour
  assert.match(words, /Claude Code/);
  assert.match(words, /ada@example\.com/);
  assert.match(words, /Limit .*Near its limit/);
  assert.match(words, /72\s?%/);
  assert.match(html, /aria-label="5 h: 72\s?% used"/);
  // Nothing about moving work to another agent
  assert.doesNotMatch(words, /counterpart|handoff|Model mapping|claude-swap/i);
});

test('a provider with no reading shows no limit', () => {
  const client = seeded();
  client.setQueryData(keys.providers, [status('claude-code')]);
  assert.doesNotMatch(text(render(<ProvidersTab />, client)), /Near its limit/);
});

test('an unknown reading is said, not drawn, even when it still has windows (QA-W m14)', () => {
  const client = seeded();
  client.setQueryData(keys.providers, [status('claude-code', { limit: limit({ state: 'unknown' }) })]);
  const html = render(<ProvidersTab />, client);
  assert.match(text(html), /the limit is not known until a new one arrives/);
  assert.doesNotMatch(html, /aria-label="5 h: 72 % used"/);
});
