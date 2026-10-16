// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { EvalDefinition, EvalFileDetail, EvalFileListItem, EvalHead, Team } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { ConfirmProvider } from '@claudio/ui/components/Dialog';
import { ToastProvider } from '@claudio/ui/components/Toast';
import { keys } from '../src/api';
import i18n, { setLanguage } from '../src/i18n';
import { DirtyProvider } from '../src/lib/dirty';
import { EvalEditor } from '../src/pages/team/evals/Editor';
import { EvalList } from '../src/pages/team/evals/List';

// The Evals list and editor in the states of the plan's screens table: loading, empty, not a
// repository, no commit, an invalid file, a list with runs, and the editor over a file.

const PIN = 'a56d826e1c0b0d4c7f1e4f5a8b2d9e3c6f7a1b2c';
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const DEFINITION: EvalDefinition = {
  version: 1,
  title: 'Developer runs the tests',
  target: { kind: 'agent', scope: 'project', name: 'developer' },
  pin: PIN,
  samples: 2,
  cases: [{ id: 'c1', prompt: 'Fix the test', expect: [{ kind: 'called', call: { tool: 'Bash', command: 'pnpm*test*' }, min: 1 }] }],
};

const file = (name: string, over: Partial<EvalFileListItem> = {}): EvalFileListItem => ({
  name,
  path: `.claude/claudio-evals/${name}.json`,
  sha: 'sha',
  definition: DEFINITION,
  problems: [],
  latestRun: null,
  ...over,
});

const HEAD: EvalHead = { git: true, sha: PIN, subject: 'init', uncommitted: [] };
const TEAM: Team = { projectId: 'p', enabled: true, members: [], unassignedAgents: [] };

function page(setup: (client: QueryClient) => void, node: ReactNode): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  setup(client);
  const tree = (
    <TooltipProvider>
      <ToastProvider>
        <ConfirmProvider>
          <DirtyProvider>{node}</DirtyProvider>
        </ConfirmProvider>
      </ToastProvider>
    </TooltipProvider>
  );
  const router = createMemoryRouter([{ path: '*', element: tree }]);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const list = (setup: (client: QueryClient) => void) => page(setup, <EvalList projectId="p" toolbar={<span>switch</span>} onOpen={() => {}} onNew={() => {}} />);

test.beforeEach(async () => {
  setLanguage('en');
  await i18n.changeLanguage('en');
});

test('the list is a skeleton while it loads', () => {
  const html = list(() => {});
  assert.match(html, /skeleton-stack/);
  assert.doesNotMatch(html, /No evals yet/);
});

test('with no evals the list is the empty state with the evals illustration and "New eval"', () => {
  const html = list((client) => {
    client.setQueryData(keys.evals('p'), []);
    client.setQueryData(keys.evalHead('p'), HEAD);
  });
  assert.match(html, /data-illustration="evals"/);
  assert.match(text(html), /No evals yet/);
  assert.match(text(html), /New eval/);
  assert.equal(html.match(/data-illustration/g)?.length, 1, 'one illustration on the screen');
});

test('a project that is not a git repository, or has no commit, gets the reason and no action', () => {
  for (const [head, title] of [
    [{ git: false, sha: null, subject: null, uncommitted: [] }, /This project is not a git repository/],
    [{ git: true, sha: null, subject: null, uncommitted: [] }, /No commit to pin yet/],
  ] as const) {
    const html = list((client) => {
      client.setQueryData(keys.evals('p'), []);
      client.setQueryData(keys.evalHead('p'), head);
    });
    assert.match(html, /data-illustration="projects"/);
    assert.match(html, /il-warn/);
    assert.match(text(html), title);
    assert.doesNotMatch(text(html), /New eval/);
  }
});

test('a file that does not parse is a row with "Invalid file", and an uncommitted one says so', () => {
  const html = list((client) => {
    client.setQueryData(keys.evals('p'), [file('broken', { definition: null, problems: ['version: unsupported', 'cases: must be a list'] }), file('good')]);
    client.setQueryData(keys.evalHead('p'), { ...HEAD, uncommitted: ['good'] });
  });
  assert.match(text(html), /broken Invalid file 2 problems/);
  assert.match(text(html), /Developer runs the tests Not committed/);
  assert.match(text(html), /1 case/);
  assert.match(text(html), /Never run/);
  assert.doesNotMatch(html, /data-illustration/, 'the page has content: no illustration');
});

test('the newest run is a word with an icon, "n/m cases", when and cost', () => {
  const html = list((client) => {
    client.setQueryData(keys.evals('p'), [
      file('good', {
        latestRun: {
          id: 'r', projectId: 'p', evalName: 'good', definitionSha: 'x', variants: ['current'], samplesPerCase: 2, account: null, state: 'ended', outcome: 'completed', reason: null,
          resetsAt: null, maxCostUsd: 1, costUsd: 0.42, counts: { passed: 1, failed: 1 }, scored: { current: { passed: 1, of: 2 } },
          createdAt: '2026-10-16T10:00:00Z', startedAt: '2026-10-16T10:00:00Z', endedAt: '2026-10-16T10:05:00Z',
        },
      }),
    ]);
    client.setQueryData(keys.evalHead('p'), HEAD);
  });
  assert.match(html, /badge badge-bad/);
  assert.match(text(html), /Failed/);
  assert.match(text(html), /1\/2 cases/);
  assert.match(text(html), /\$0\.42/);
});

test('the Spanish list says the same in the glossary\'s words', async () => {
  setLanguage('es');
  await i18n.changeLanguage('es');
  const html = list((client) => {
    client.setQueryData(keys.evals('p'), []);
    client.setQueryData(keys.evalHead('p'), HEAD);
  });
  assert.match(text(html), /Aún no hay evaluaciones/);
  assert.match(text(html), /Nueva evaluación/);
});

const detail = (over: Partial<EvalFileDetail> = {}): EvalFileDetail => ({ name: 'good', path: '.claude/claudio-evals/good.json', sha: 'abcdef1234', definition: DEFINITION, problems: [], consented: false, ...over });

const editor = (name: string | null, setup: (client: QueryClient) => void) =>
  page(setup, <EvalEditor projectId="p" team={TEAM} name={name} existing={['good']} onBack={() => {}} onSaved={() => {}} />);

test('the editor is a skeleton while the file loads, and the problems of a file that does not parse otherwise', () => {
  assert.match(editor('good', () => {}), /skeleton-stack/);
  const html = editor('broken', (client) => {
    client.setQueryData(keys.evalHead('p'), HEAD);
    client.setQueryData(keys.evalFile('p', 'broken'), detail({ name: 'broken', definition: null, problems: ['version: unsupported-version'] }));
  });
  assert.match(text(html), /This file cannot run/);
  assert.match(text(html), /version: unsupported-version/);
  assert.match(text(html), /Delete/);
});

test('the editor shows the file as a form: target, run as, pin with its subject, limits and cases', () => {
  const html = editor('good', (client) => {
    client.setQueryData(keys.evalHead('p'), HEAD);
    client.setQueryData(keys.evalFile('p', 'good'), detail());
  });
  const words = text(html);
  for (const part of ['What it measures', 'Run as', 'Commit', 'Samples and limits', '1 case', 'Pin to HEAD', 'code on this machine.', 'Developer runs the tests']) {
    assert.ok(words.includes(part), part);
  }
  assert.match(html, /value="a56d826e1c0b0d4c7f1e4f5a8b2d9e3c6f7a1b2c"/);
  assert.match(words, /a56d826 · init/);
  assert.match(html, /aria-label="Editor view"/);
  assert.match(html, /JSON/);
  // Save waits for a change
  assert.match(html, /<button[^>]*disabled=""[^>]*>[^<]*<svg[^>]*>.*?Save/s);
});

test('a new eval asks for a file name beside the title', () => {
  const html = editor(null, (client) => client.setQueryData(keys.evalHead('p'), HEAD));
  assert.match(text(html), /New eval/);
  assert.match(text(html), /File name/);
  assert.match(html, /claudio-evals\//);
});
