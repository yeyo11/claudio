// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderStatus, ProvidersSettings } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { keys } from '../src/api';
import { TooltipProvider } from '@claudio/ui/components/controls';
import { ConfirmProvider } from '@claudio/ui/components/Dialog';
import { ToastProvider } from '@claudio/ui/components/Toast';
import i18n from '../src/i18n';
import { en, es } from '../src/i18n/resources';
import { DirtyProvider } from '../src/lib/dirty';
import { entryOf, latestCheck, orderedIds, withEntry } from '../src/lib/provider-settings';
import { ProvidersTab } from '../src/pages/config/ProvidersTab';
import { resolveSettingsAddress, sectionsOf } from '../src/pages/config/settingsGroups';

const status = (id: string, over: Partial<ProviderStatus> = {}): ProviderStatus => ({
  id,
  label: 'Claude Code',
  state: 'ready',
  reason: null,
  version: '1.0.0',
  compatibleRange: '>=1.0.0',
  binaryPath: `/usr/bin/${id}`,
  configHome: null,
  account: null,
  capabilities: [],
  checkedAt: '2026-09-30T10:00:00Z',
  ...over,
});

const settings = (over: Partial<ProvidersSettings> = {}): ProvidersSettings => ({
  providers: { 'claude-code': { enabled: true, binaryPath: '/opt/claude' } },
  order: ['claude-code'],
  defaultProvider: null,
  ...over,
});

const LIST = [status('claude-code')];
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('the list follows the settings, then what the settings have not met, and drops strangers', () => {
  assert.deepEqual(orderedIds(LIST, settings({ order: ['ghost', 'claude-code', 'claude-code'] })), ['claude-code']);
  assert.deepEqual(orderedIds(LIST, settings({ order: [] })), ['claude-code']);
});

test('a provider the settings never mention is on and searched for', () => {
  assert.deepEqual(entryOf(settings({ providers: {} }), 'claude-code'), { enabled: true, binaryPath: null });
});

test('changing the binary sends the whole document', () => {
  const next = withEntry(settings(), ['claude-code'], 'claude-code', { binaryPath: '/usr/local/bin/claude' });
  assert.deepEqual(next.order, ['claude-code']);
  assert.deepEqual(next.providers['claude-code'], { enabled: true, binaryPath: '/usr/local/bin/claude' });
  assert.equal(withEntry(settings(), ['claude-code'], 'claude-code', { binaryPath: null }).providers['claude-code']?.binaryPath, null);
});

test('the newest detection is the one that is shown', () => {
  assert.equal(latestCheck([]), null);
  assert.equal(latestCheck([status('a', { checkedAt: '2026-09-30T10:00:00Z' }), status('b', { checkedAt: '2026-09-30T10:05:00Z' })]), '2026-09-30T10:05:00Z');
});

test('Provider is a section of Claude Code, right after Sign-in', () => {
  const sections = sectionsOf('claude-code');
  assert.equal(sections.indexOf('provider'), sections.indexOf('sign-in') + 1);
  assert.equal(resolveSettingsAddress('?tab=providers', ''), '/settings/claude-code#provider');
});

test('the copy of the tab exists in both languages with the same placeholders', () => {
  const holes = (s: string) => [...s.matchAll(/{{(\w+)}}/g)].map((m) => m[1]).sort().join();
  const flat = (o: Record<string, unknown>, at = ''): Array<[string, string]> =>
    Object.entries(o).flatMap(([k, v]) => (typeof v === 'string' ? [[`${at}${k}`, v] as [string, string]] : flat(v as Record<string, unknown>, `${at}${k}.`)));
  const spanish = new Map(flat(es.providers));
  for (const [key, value] of flat(en.providers)) {
    const other = spanish.get(key);
    assert.ok(other, `es ${key}`);
    assert.equal(holes(value), holes(other), key);
  }
  assert.equal(spanish.size, flat(en.providers).length);
});

function renderProvider(list: ProviderStatus[]): string {
  const client = new QueryClient();
  client.setQueryData(keys.providers, list);
  client.setQueryData(keys.providerSettings, settings());
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RouterProvider
        router={createMemoryRouter([
          {
            path: '*',
            element: (
              <TooltipProvider>
                <ToastProvider>
                  <ConfirmProvider>
                    <DirtyProvider>
                      <ProvidersTab />
                    </DirtyProvider>
                  </ConfirmProvider>
                </ToastProvider>
              </TooltipProvider>
            ),
          },
        ])}
      />
    </QueryClientProvider>,
  );
}

test('the section shows Claude Code with its state, when it was checked and the way to read it again', async () => {
  await i18n.changeLanguage('en');
  const html = renderProvider(LIST);
  const words = text(html);
  assert.match(words, /Claude Code/);
  assert.match(words, /Ready/);
  assert.match(words, /Checked/);
  assert.match(words, /Check again/);
  // One agent: no order to change, no default to choose, no switch, and no card around it
  assert.equal((html.match(/class="prov-grip"/g) ?? []).length, 0);
  assert.equal((html.match(/role="switch"/g) ?? []).length, 0);
  assert.doesNotMatch(words, /Default provider/);
  assert.doesNotMatch(html, /class="card/);
  assert.match(html, /data-provider="claude-code"[^>]*data-state="ready"/);
  // Search lands on the row, its limits and its own Check again
  for (const id of ['provider.binary', 'provider.limits', 'provider.check']) assert.match(html, new RegExp(`data-setting="${id.replace('.', '\\.')}"`), id);
});

test('signing in is the Sign-in section’s: the row links there and opens no panel of its own', async () => {
  await i18n.changeLanguage('en');
  const html = renderProvider([status('claude-code', { state: 'signed-out', reason: null })]);
  assert.match(html, /<a[^>]*data-action="sign-in"[^>]*href="\/settings\/claude-code#sign-in"/);
  assert.doesNotMatch(html, /aria-pressed/);
  assert.doesNotMatch(html, /signin-/);
});

test('a state that offers Retry does not offer Check again beside it', async () => {
  await i18n.changeLanguage('en');
  const words = text(renderProvider([status('claude-code', { state: 'unknown', reason: null })]));
  assert.match(words, /Retry/);
  assert.doesNotMatch(words, /Check again/);
});
