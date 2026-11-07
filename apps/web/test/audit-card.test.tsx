// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuditEntry, AuditPage } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { api, keys } from '../src/api';
import i18n from '../src/i18n';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { AuditRefusals, AuditTable } from '../src/pages/config/security/AuditCard';

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  id: '1',
  at: '2026-10-20T14:32:05Z',
  actor: 'desktop',
  method: 'PUT',
  path: '/api/chats/1f3a9c2e-5b7d-4e1f-9a0b-c3d4e5f60718/claudio-mcp',
  status: 200,
  summary: "Switch Claudio's own MCP server on or off in a live chat",
  route: 'PUT /chats/:id/claudio-mcp',
  ...over,
});

async function render(entries: AuditEntry[], language = 'en'): Promise<string> {
  await i18n.changeLanguage(language);
  try {
    return renderToStaticMarkup(
      <TooltipProvider>
        <AuditTable entries={entries} />
      </TooltipProvider>,
    );
  } finally {
    await i18n.changeLanguage('en');
  }
}

const decode = (text: string): string => text.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/** The text of every `tag` whose class list holds all of `classes`, when that text has no markup inside */
function texts(html: string, tag: string, ...classes: string[]): string[] {
  const out: string[] = [];
  for (const match of html.matchAll(new RegExp(`<${tag} [^>]*class="([^"]*)"[^>]*>([^<]*)</${tag}>`, 'g'))) {
    const list = (match[1] ?? '').split(' ');
    if (classes.every((c) => list.includes(c))) out.push(decode(match[2] ?? ''));
  }
  return out;
}

/** The markup of each phone row */
const rows = (html: string): string[] => [...html.matchAll(/<li class="audit-row">(.*?)<\/li>/g)].map((m) => m[1] ?? '');

test('a row with a route reads in Spanish; one without keeps the English the server stored', async () => {
  const html = await render(
    [
      entry(),
      entry({ id: '2', route: null, actor: 'claudio', method: 'POST', path: '/api/tunnel/stop', summary: 'Stop the tunnel: authentication was turned off' }),
      entry({ id: '3', route: 'POST /no/such/route', summary: 'Something this build does not know' }),
    ],
    'es',
  );
  const expected = [
    'Activar o desactivar el servidor MCP de Claudio en un chat en directo',
    'Stop the tunnel: authentication was turned off',
    'Something this build does not know',
  ];
  assert.deepEqual(texts(html, 'td', 'audit-summary'), expected);
  // The phone rows say the same thing
  assert.deepEqual(texts(html, 'p', 'audit-row-what'), expected);
});

test('a request no route matched says so in words, not as its path again', async () => {
  const unmatched = entry({ route: null, method: 'POST', path: '/api/nowhere', summary: 'POST /api/nowhere' });
  assert.deepEqual(texts(await render([unmatched]), 'td', 'audit-summary'), ['No route matched this request']);
  assert.deepEqual(texts(await render([unmatched], 'es'), 'td', 'audit-summary'), ['Ninguna ruta coincide con esta petición']);
});

test('English reads the route line, which is the summary', async () => {
  const html = await render([entry()]);
  assert.deepEqual(texts(html, 'td', 'audit-summary'), ["Switch Claudio's own MCP server on or off in a live chat"]);
});

test('actors that are words are words in sans; ids stay literal in mono', async () => {
  const words = ['local', 'desktop', 'env', 'claudio', 'anonymous'];
  const ids = ['token:abcd1234', 'chat:c-42', 'auth0|subject'];
  const html = await render([...words, ...ids].map((actor, i) => entry({ id: String(i), actor })), 'es');
  const spoken = ['Acceso local', 'Aplicación de escritorio', 'Entorno', 'Claudio', 'Anónimo'];
  // Once in the table and once in the phone rows, never in mono
  assert.deepEqual(texts(html, 'span', 'audit-actor'), [...spoken, ...spoken]);
  assert.ok(!/class="[^"]*mono[^"]*audit-actor/.test(html) && !/class="audit-actor[^"]*mono/.test(html));
  assert.deepEqual(texts(html, 'span', 'mono', 'audit-literal').filter((t) => !t.startsWith('/')), [...ids, ...ids]);
  for (const word of words) assert.ok(!texts(html, 'span', 'mono').includes(word), `${word} is not shown raw`);
});

test('the method is mono, not bold, and the table keeps the classes the specs select', async () => {
  const html = await render([entry()]);
  assert.deepEqual(texts(html, 'span', 'mono', 'audit-method'), ['PUT']);
  assert.ok(!html.includes('class="strong"'));
  assert.match(html, /<div class="table-wrap is-paged" role="group" aria-label="Audit log" tabindex="0"><table class="table audit-table"/);
});

test('a phone row folds a long path to its tail behind a button, and leaves a short one as text', async () => {
  const html = await render([entry(), entry({ id: '2', path: '/api/tunnel/stop', route: 'POST /tunnel/stop', method: 'POST' })]);
  const [long = '', short = ''] = rows(html);
  assert.match(long, /<button type="button" class="mono audit-row-request audit-row-path" aria-expanded="false" aria-label="PUT …\/[^"]*· Show the full path">PUT …\//);
  assert.ok(!short.includes('<button'));
  assert.deepEqual(texts(short, 'span', 'audit-row-request'), ['POST /api/tunnel/stop']);
  // Time, actor and result share the first line
  assert.match(long, /<div class="audit-row-head">.*Desktop app.*class="badge/);
});

test('the table cuts a long path in the middle, keeps its end, and lets a keyboard reach the whole of it', async () => {
  const html = await render([entry(), entry({ id: '2', path: '/api/tunnel/stop', route: 'POST /tunnel/stop', method: 'POST' })]);
  const paths = texts(html, 'span', 'mono', 'audit-path');
  assert.equal(paths.length, 2);
  const [long = '', short = ''] = paths;
  assert.ok(long.startsWith('/api/') && long.endsWith('/claudio-mcp') && long.includes('…'), long);
  assert.equal(short, '/api/tunnel/stop');
  // Only the cut one is a stop of its own, the tooltip with the whole path hanging from it
  assert.match(html, /<span class="mono audit-literal audit-path" tabindex="0"[^>]*>[^<]*…/);
  assert.doesNotMatch(html, /<span class="mono audit-literal audit-path" tabindex="0"[^>]*>\/api\/tunnel\/stop/);
});

// ---------- the refusals ring (GET /audit/refusals) ----------

const refused = (over: Partial<AuditEntry> = {}): AuditEntry =>
  entry({ actor: 'anonymous', method: 'POST', path: '/api/projects', status: 401, summary: 'Create a project', route: 'POST /projects', ...over });

/** The refusals card drawn from a cache that already holds `page`, as a fetched page would leave it */
async function renderRefusals(page: AuditPage | null, language = 'en'): Promise<string> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (page) client.setQueryData(keys.auditRefusals({ from: 0 }), page);
  await i18n.changeLanguage(language);
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <AuditRefusals />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  } finally {
    await i18n.changeLanguage('en');
  }
}

const words = (html: string): string => decode(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));

test('the client asks the refusals ring with the same paging and filters as the log', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(String(input));
    return new Response(JSON.stringify({ entries: [], total: 0, from: 25 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  await api.auditRefusals({ limit: 25, from: 25, status: '4xx' });
  assert.equal(asked.length, 1);
  const url = new URL(asked[0] ?? '', 'http://x');
  assert.equal(url.pathname, '/api/audit/refusals');
  assert.deepEqual(Object.fromEntries(url.searchParams), { limit: '25', from: '25', status: '4xx' });
  // Under the audit's prefix, so what refreshes the log (every event, lib/events) refreshes the ring
  assert.deepEqual(keys.auditRefusals({ from: 25 }).slice(0, keys.auditAll.length), [...keys.auditAll]);
  assert.notDeepEqual(keys.auditRefusals({ from: 0 }), keys.audit({ from: 0 }));
});

test('the refusals card lists the anonymous writes in a table and phone rows of its own, with no Who column', async () => {
  const html = await renderRefusals({
    entries: [refused(), refused({ id: '2', status: 421, method: 'PUT', path: '/api/security/auth', route: 'PUT /security/auth', summary: 'Change the auth mode or read-only' })],
    total: 2,
    from: 0,
  });
  assert.match(html, /<h2>Refused before identification<\/h2>/);
  // Through the formatter, whose grouping follows the locale the test runs in
  assert.match(words(html), /the newest 1\S?000,/, 'the intro says how many rows the ring keeps');
  // Its own accessible name, so the log's specs never select it by mistake
  assert.match(html, /<div class="table-wrap is-paged" role="group" aria-label="Refused before identification"/);
  assert.match(html, /<ul class="audit-rows" aria-label="Refused before identification">/);
  assert.equal(rows(html).length, 2);
  // Every row is anonymous, so the word is not repeated on each one
  assert.ok(!html.includes('audit-col-actor') && !html.includes('audit-who') && !html.includes('audit-row-actor'));
  assert.ok(!words(html).includes('Anonymous'));
  // Worded from the route, as the log's rows are
  assert.deepEqual(texts(html, 'td', 'audit-summary'), ['Create a project in the workspace', 'Change the auth mode or read-only']);
  assert.match(html, /401 · not allowed/);
  assert.match(html, /421 · rejected/);
  assert.ok(words(html).includes('1–2 of 2'), 'the pager says where the page sits');
});

test('the log keeps its Who column and its own name', async () => {
  const html = await render([entry()]);
  assert.match(html, /class="audit-col-actor"/);
  assert.match(html, /<ul class="audit-rows" aria-label="Audit log">/);
  assert.equal(rows(html).length, 1);
  assert.ok(rows(html)[0]?.includes('audit-row-actor'));
});

test('an empty ring says so in both languages, with no table', async () => {
  const empty = { entries: [], total: 0, from: 0 };
  const english = await renderRefusals(empty);
  assert.ok(words(english).includes('Nothing refused'));
  assert.ok(words(english).includes('A write refused before its caller was identified will appear here.'));
  assert.ok(!english.includes('<table'));
  const spanish = await renderRefusals(empty, 'es');
  assert.match(spanish, /<h2>Rechazadas antes de identificar<\/h2>/);
  assert.ok(words(spanish).includes('Nada rechazado'));
  assert.match(words(spanish), /las 1\S?000 más recientes/);
});

test('while the first page is on its way the card holds placeholder rows, not an empty state', async () => {
  const html = await renderRefusals(null);
  assert.match(html, /class="skeleton-stack"/);
  assert.ok(!words(html).includes('Nothing refused'));
});
