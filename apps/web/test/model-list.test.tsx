// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ModelOption, Overview } from '@claudio/shared';
import { keys } from '../src/api';
import { ModelListStatus, useModelList, type ModelList } from '../src/components/ui';
import { chatAccount } from '../src/pages/chat/Controls';
import i18n from '../src/i18n';

// The CLI's `initialize` list is the only model list: a picker shows it, says it is loading, or
// says it could not be read. It never fills the gap with names of its own.

const defaults: ModelOption[] = [
  { value: 'default', resolvedModel: 'claude-haiku-5-5', label: 'Default (recommended)', description: 'Haiku 5.5' },
  { value: 'haiku', resolvedModel: 'claude-haiku-5-5', label: 'Haiku', description: 'Haiku 5.5' },
];
const pro: ModelOption[] = [{ value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', label: 'Sonnet', description: 'Sonnet 5.5' }];

function client(overviewModels: ModelOption[] | null, accounts: Record<string, ModelOption[]> = {}): QueryClient {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (overviewModels) queries.setQueryData(keys.overview, { system: { models: overviewModels } } as unknown as Overview);
  for (const [id, models] of Object.entries(accounts)) queries.setQueryData(keys.accountModels(id), models);
  return queries;
}

/** What `useModelList` answers for an account, read through a render as the pickers read it. */
function listOf(queries: QueryClient, account?: string | null): ModelList {
  let seen: ModelList | null = null;
  function Probe() {
    seen = useModelList(account);
    return null;
  }
  renderToStaticMarkup(
    <QueryClientProvider client={queries}>
      <Probe />
    </QueryClientProvider>,
  );
  assert.ok(seen);
  return seen;
}

const status = (list: ModelList): string => renderToStaticMarkup(<ModelListStatus list={list} />);

test.beforeEach(async () => {
  await i18n.changeLanguage('en');
});

test('with no list yet the picker is loading, with no guessed entries', () => {
  const list = listOf(client(null));
  assert.equal(list.state, 'loading');
  assert.deepEqual(list.models, []);
  assert.match(status(list), /Loading models…/);
  const waiting = listOf(client([]));
  assert.equal(waiting.state, 'loading', 'an overview with no models yet waits for the read in progress');
});

test("the default list is the overview's, in the CLI's order, `default` and `haiku` both", () => {
  const list = listOf(client(defaults));
  assert.equal(list.state, 'ready');
  assert.deepEqual(list.models.map((m) => m.value), ['default', 'haiku']);
  assert.equal(status(list), '');
});

test("a chat's picker reads the list of the chat's account, not the default one", () => {
  const queries = client(defaults, { pro });
  assert.deepEqual(listOf(queries, 'pro').models.map((m) => m.value), ['sonnet']);
  assert.equal(chatAccount({ account: 'pro', executions: [] }), 'pro');
  assert.equal(chatAccount({ account: null, executions: [{ account: 'pro' }] as never }), 'pro', 'the account its last process ran on');
  assert.equal(chatAccount({ account: undefined, executions: [] }), null, 'none: the default list stands in');
});

test('a read that came back empty says it could not read the list, with a Retry, in both languages', async () => {
  const list = listOf(client([], { default: [] }));
  assert.equal(list.state, 'failed');
  assert.match(status(list), /Couldn&#x27;t read the CLI&#x27;s list/);
  assert.match(status(list), /<button[^>]*>Retry<\/button>/);
  await i18n.changeLanguage('es');
  assert.match(status(list), /No se ha podido leer la lista del CLI/);
  assert.match(status(list), />Reintentar</);
  assert.match(status(listOf(client(null))), /Cargando modelos…/);
});
