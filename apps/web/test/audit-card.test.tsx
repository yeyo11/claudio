// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuditEntry } from '@claudio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { AuditTable } from '../src/pages/config/security/AuditCard';

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
