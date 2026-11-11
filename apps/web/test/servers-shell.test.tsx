// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import type { ClaudioServer, ServerHealth, ServersSettings } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { isGroup, isSeparator, type MenuEntry, type MenuGroup, type MenuItem } from '@claudio/ui/components/controls/Menu';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { ToastProvider } from '@claudio/ui/components/Toast';
import { setActiveServer } from '@claudio/ui/lib/server-scope';
import { ServerSelector, selectorEntries } from '../src/components/ServerSelector';
import { MoreServer, StatusBarServer } from '../src/components/shell/CurrentServer';
import i18n from '../src/i18n';
import { serversKeys } from '../src/lib/api/servers';
import { ServerScopeProvider } from '../src/lib/server-scope';
import { ServersCard } from '../src/pages/config/security/ServersCard';

// The shell's part of Servers (docs/plans/claudio-servers.md §12.1, task ui-shell): the selector in
// the top bar, the server named in the status bar and the phone's More sheet, and the Settings card.

const health = (status: ServerHealth['status']): ServerHealth => ({ status, address: 'https://192.168.0.29:8791', version: '0.15.0', apiVersion: 1, latencyMs: 12, checkedAt: '2026-11-09T10:00:00Z' });

const server = (id: string, name: string, extra: Partial<ClaudioServer> = {}): ClaudioServer => ({
  id,
  name,
  color: null,
  monogram: null,
  addresses: [{ url: 'https://192.168.0.29:8791', kind: 'lan' }],
  identity: { instanceId: `inst-${id}`, tlsFingerprint: null },
  createdAt: '2026-11-01T10:00:00Z',
  lastUsedAt: null,
  health: null,
  ...extra,
});

function page(children: React.ReactNode, { settings, servers, path = '/chats' }: { settings?: ServersSettings; servers?: ClaudioServer[]; path?: string } = {}) {
  const client = new QueryClient();
  if (settings) client.setQueryData(serversKeys.settings, settings);
  if (servers) client.setQueryData(serversKeys.list, servers);
  return bare(
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <TooltipProvider>
            <ToastProvider>
              <ServerScopeProvider>{children}</ServerScopeProvider>
            </ToastProvider>
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
}

/** The toast region the provider always draws is not what these tests look at */
const bare = (html: string) => html.replace(/<div class="toasts"[^>]*><\/div>/, '');

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => setActiveServer(null));

const on: ServersSettings = { enabled: true };
const off: ServersSettings = { enabled: false };

test('the selector is a quiet button in the project selector’s shape, with the separator that leads to the project', () => {
  const html = page(<ServerSelector />, { settings: on, servers: [server('a', 'Studio')] });
  // Named by what it shows, with a hidden "Server:" before it: no aria-label that could leave out
  // the visible text (a remote's mark letters), so a voice user can say what they see
  assert.match(html, /<button type="button" class="select-trigger project-selector server-selector"[^>]*><span class="sr-only">Server: <\/span>/);
  assert.doesNotMatch(html, /server-selector"[^>]*aria-label/);
  assert.match(html, /This server/);
  assert.match(html, /class="crumb-sep"/);
});

test('it draws nothing while Servers is off or before the switch is known', () => {
  assert.equal(page(<ServerSelector />, { settings: off, servers: [server('a', 'Studio')] }), '');
  assert.equal(page(<ServerSelector />, { servers: [server('a', 'Studio')] }), '', 'the hub has not answered yet');
});

test('inside a remote’s scope the selector names that remote with its mark, so a phone with no status bar still says where the page writes', () => {
  setActiveServer('a');
  const html = page(<ServerSelector />, { settings: on, servers: [server('a', 'Studio', { color: 'violet' }), server('b', 'Beta')] });
  assert.match(html, /<span class="sr-only">Server: <\/span>[\s\S]*class="monogram"[^>]*>ST<[\s\S]*>Studio</);
  assert.doesNotMatch(html, /This server/, 'the button is the remote’s, not the hub’s');
});

test('inside a remote the menu is still the hub’s list, with the remote chosen; This server goes back, and choosing the same one reloads nothing', () => {
  const servers = [
    server('a', 'Alpha', { lastUsedAt: '2026-11-01T10:00:00Z' }),
    server('b', 'Beta', { lastUsedAt: '2026-11-05T10:00:00Z' }),
    server('c', 'Gamma', { lastUsedAt: '2026-11-04T10:00:00Z' }),
    server('d', 'Delta', { lastUsedAt: '2026-11-03T10:00:00Z' }),
  ];
  const { switchTo, go, calls } = actions();
  const entries = selectorEntries(servers, t, { switchTo, go }, 'a');
  const listed = group(entries);
  assert.equal(listed.radio?.value, 'a');
  assert.deepEqual(listed.items.map((item) => item.id), ['local', 'a', 'b', 'c'], 'the server in use is listed even when three were used after it');
  listed.radio?.onChange('a');
  listed.radio?.onChange('local');
  assert.deepEqual(calls, ['switch:local']);
});

const t = i18n.getFixedT('en', 'shell');
const actions = () => {
  const calls: string[] = [];
  return { calls, switchTo: (id: string) => calls.push(`switch:${id}`), go: (path: string) => calls.push(`go:${path}`) };
};
const group = (entries: MenuEntry[]): MenuGroup => {
  const found = entries.find(isGroup);
  assert.ok(found, 'a group of servers');
  return found;
};
const items = (entries: MenuEntry[]) => entries.filter((entry): entry is MenuItem => !isGroup(entry) && !isSeparator(entry));

test('the menu pins This server, lists the three used last and ends with the way to the page', () => {
  const servers = [
    server('a', 'Alpha', { lastUsedAt: '2026-11-01T10:00:00Z' }),
    server('b', 'Beta', { lastUsedAt: '2026-11-05T10:00:00Z', health: health('connected') }),
    server('c', 'Gamma', { lastUsedAt: '2026-11-04T10:00:00Z', health: health('offline') }),
    server('d', 'Delta', { lastUsedAt: '2026-11-03T10:00:00Z', health: health('reconnecting') }),
  ];
  const { switchTo, go, calls } = actions();
  const entries = selectorEntries(servers, t, { switchTo, go });
  const listed = group(entries);
  assert.deepEqual(listed.items.map((item) => item.id), ['local', 'b', 'c', 'd'], 'This server first, then the three most recent; Alpha is only on the page');
  assert.equal(listed.radio?.value, 'local', 'the hub is the one chosen');
  const words = listed.items.map((item) => renderToStaticMarkup(<>{item.label}{item.meta}</>));
  assert.match(words[0] ?? '', /This server/);
  assert.match(words[1] ?? '', /Beta[\s\S]*tone-ok[\s\S]*Connected/);
  assert.match(words[2] ?? '', /Gamma[\s\S]*tone-bad[\s\S]*Offline/);
  assert.match(words[3] ?? '', /Delta[\s\S]*tone-warn[\s\S]*Reconnecting/, 'the spinner sits beside the verb');
  assert.deepEqual(items(entries).map((item) => item.id), ['all']);

  listed.radio?.onChange('c');
  items(entries)[0]?.onSelect?.();
  assert.deepEqual(calls, ['switch:c', 'go:/servers']);
});

test('the name this Claudio gave itself takes the place of This server, in the menu as on the button', () => {
  const entries = selectorEntries([server('a', 'Alpha')], t, actions(), 'local', 'Portátil');
  const local = group(entries).items[0];
  assert.equal(local?.text, 'Portátil');
  const label = renderToStaticMarkup(<>{local?.label}</>);
  assert.match(label, /Portátil/);
  assert.doesNotMatch(label, /This server/);
  assert.match(renderToStaticMarkup(<>{group(selectorEntries([], t, actions(), 'local', null)).items[0]?.label}</>), /This server/, 'no name is the default');
});

test('with no server yet the menu offers to add one, straight into the dialog', () => {
  const { switchTo, go, calls } = actions();
  const entries = selectorEntries([], t, { switchTo, go });
  assert.deepEqual(group(entries).items.map((item) => item.id), ['local']);
  assert.deepEqual(items(entries).map((item) => item.id), ['add']);
  items(entries)[0]?.onSelect?.();
  assert.deepEqual(calls, ['go:/servers?add=1']);
});

test('the same menu speaks Spanish', async () => {
  await i18n.changeLanguage('es');
  const entries = selectorEntries([server('a', 'Estudio')], i18n.getFixedT('es', 'shell'), actions());
  assert.match(renderToStaticMarkup(<>{group(entries).items[0]?.label}</>), /Este servidor/);
  assert.equal(items(entries)[0]?.label, 'Todos los servidores');
});

test('inside a remote’s scope the status bar names it with its status and offers the way back to this page on the hub', () => {
  setActiveServer('a');
  const servers = [server('a', 'Mac studio', { color: 'violet', health: health('connected') })];
  const html = page(<StatusBarServer />, { servers, path: '/chats' });
  assert.match(html, /data-testid="statusbar-server"/);
  assert.match(html, /Mac studio/);
  assert.match(html, /tone-ok[\s\S]*Connected/);
  assert.match(html, /<a href="\/chats" class="statusbar-item">Back to this server<\/a>/);
});

test('on the hub the status bar and the phone’s More sheet say nothing new; a remote not read yet says nothing either', () => {
  const servers = [server('a', 'Mac studio', { health: health('connected') })];
  assert.equal(page(<StatusBarServer />, { servers }), '');
  assert.equal(page(<MoreServer />, { servers }), '');
  setActiveServer('b');
  assert.equal(page(<StatusBarServer />, { servers }), '', 'the list has no such server');
});

test('the phone’s More sheet carries the same: a card with the name, the status and the way back', () => {
  setActiveServer('a');
  const html = page(<MoreServer />, { servers: [server('a', 'Mac studio', { health: health('needs-update') })], path: '/usage' });
  assert.match(html, /<a href="\/usage" class="more-connection more-server"/);
  assert.match(html, /Mac studio/);
  assert.match(html, /tone-warn[\s\S]*Needs an update/);
  assert.match(html, /Back to this server/);
});

test('Settings → Servers: the row is the same in both states, so turning it on moves nothing; only the switch changes', () => {
  const offHtml = page(<ServersCard />, { settings: off });
  assert.match(offHtml, /data-setting="servers\.enabled"/);
  assert.match(offHtml, /role="switch"[^>]*aria-checked="false"/);
  const onHtml = page(<ServersCard />, { settings: on });
  assert.match(onHtml, /role="switch"[^>]*aria-checked="true"/);
  for (const html of [offHtml, onHtml]) {
    assert.match(html, /Off disconnects every server and keeps the list/);
    assert.match(html, /<a class="btn btn-small" href="\/servers"[^>]*>Manage servers<\/a>/);
  }
  const shape = (html: string) => html.replace(/aria-checked="\w+"|data-state="\w+"|checked=""/g, '').replace(/\s+/g, ' ');
  assert.equal(shape(offHtml), shape(onHtml));
});

test('a Claudio that is never a hub has no card', () => {
  // Opened again, a failed read is asked again; this one is read as it stands, which is what a mounted card sees
  const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  // What a 404 from the headless profile leaves in the cache
  client.getQueryCache().build(client, { queryKey: serversKeys.settings }).setState({ status: 'error', error: new Error('404'), fetchStatus: 'idle' });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>
          <ToastProvider>
            <ServersCard />
          </ToastProvider>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  assert.equal(bare(html), '');
});
