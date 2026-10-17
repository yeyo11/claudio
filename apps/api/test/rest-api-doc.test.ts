import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ROUTE_DOCS } from '../src/openapi/routes.ts';

// docs/rest-api.md is the page a person reads for the route list; ROUTE_DOCS is what the server
// documents (api.test.ts checks every registered route is in it). The two drifting apart is how the
// README's tables once lost rows without anybody noticing, so this keeps them equal.
const PAGE = new URL('../../../docs/rest-api.md', import.meta.url);
const METHOD = /^(GET|POST|PUT|PATCH|DELETE)$/;

/** Every `METHOD /route` a table row of the page names, without the query string */
function documentedRows(markdown: string): string[] {
  const rows: string[] = [];
  for (const line of markdown.split('\n')) {
    // A `\|` inside a cell is a literal pipe (`?format=markdown\|json`), not a column break
    const cells = line.split(/(?<!\\)\|/).map((cell) => cell.trim());
    // `| GET / PUT | `/x?y=` | … |` splits into ['', 'GET / PUT', '`/x?y=`', …]
    const methods = (cells[1] ?? '').split('/').map((m) => m.trim());
    const route = /^`(\/[^`]*)`$/.exec(cells[2] ?? '')?.[1];
    if (!route || !methods.every((m) => METHOD.test(m))) continue;
    for (const method of methods) rows.push(`${method} ${route.replace(/\?.*$/, '')}`);
  }
  return rows;
}

test('every documented route has a row in docs/rest-api.md, and every row is a documented route', () => {
  const rows = documentedRows(readFileSync(PAGE, 'utf8'));
  const documented = new Set(Object.keys(ROUTE_DOCS));
  const listed = new Set(rows);
  const missing = [...documented].filter((route) => !listed.has(route));
  const unknown = [...listed].filter((route) => !documented.has(route));
  assert.deepEqual(missing, [], `routes with no row in docs/rest-api.md:\n${missing.join('\n')}`);
  assert.deepEqual(unknown, [], `rows in docs/rest-api.md naming no documented route:\n${unknown.join('\n')}`);
});

test('a route has one row in docs/rest-api.md, not two that could disagree', () => {
  const rows = documentedRows(readFileSync(PAGE, 'utf8'));
  const twice = rows.filter((route, i) => rows.indexOf(route) !== i);
  assert.deepEqual(twice, []);
});

test('the row reader takes several methods in one cell and drops the query string', () => {
  assert.deepEqual(documentedRows('| GET / PUT | `/x/:id?format=a\\|b` | Read or replace it |\n| Keys | `j` | Next |'), ['GET /x/:id', 'PUT /x/:id']);
});
