// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
// The older Home and board defects of R16 (docs/plans/ci-and-regression-open.md), each where it was
// measured: the board's column names cut at 1280 px, the setup's Tailscale row cut on a phone, and
// Home's "Import your first project" link, 17 px tall and told apart from its sentence by colour alone.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { ConfirmProvider } from '@claudio/ui/components/Dialog';
import { ToastProvider } from '@claudio/ui/components/Toast';
import { keys } from '../src/api';
import { TailscaleRow } from '../src/components/setup/TailscaleRow';
import i18n from '../src/i18n';
import { ProjectsWidget } from '../src/pages/dashboard/widgets/live';

const css = (name: string) => readFileSync(fileURLToPath(new URL(`../src/styles/${name}`, import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of every rule whose selector list holds `selector` exactly, later rules winning. */
function rule(sheet: string, selector: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (match[1] ?? '').split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (!selectors.includes(selector)) continue;
    for (const part of (match[2] ?? '').split(';')) {
      const colon = part.indexOf(':');
      if (colon > 0) found.set(part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim());
    }
  }
  return found;
}

function html(node: ReactNode, client = new QueryClient()): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ToastProvider>
          <ConfirmProvider>
            <TooltipProvider>{node}</TooltipProvider>
          </ConfirmProvider>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test.beforeEach(async () => {
  await i18n.changeLanguage('en');
});

test("a board column's name keeps its room: the spacer beside it starts at nothing", () => {
  // `.grow` asks for 200 px (base.css), which took a 180 px column's head and cut "Backlog" to "B…"
  assert.equal(rule(css('base.css'), '.grow').get('flex'), '1 1 200px');
  assert.equal(rule(css('board.css'), '.workitem-col-head > .grow').get('flex-basis'), '0');
  // A column too narrow for the name and what follows it (a project's head, 1024 px) wraps instead of cutting the name
  const head = rule(css('board.css'), '.workitem-col-head');
  assert.equal(head.get('flex-wrap'), 'wrap');
  assert.equal(head.get('height'), undefined, 'a fixed height would clip the second line');
  assert.equal(rule(css('board.css'), '.workitem-col-add').get('margin-left'), 'auto');
});

test("the phone board's jump keeps the chosen column's name for screen readers where it does not fit", () => {
  const board = readFileSync(fileURLToPath(new URL('../src/styles/board.css', import.meta.url)), 'utf8');
  assert.match(board, /\.workitem-jump \{[^}]*container: workitem-jump \/ inline-size;/);
  // Visually hidden, never display: none, so the chosen chip still says its name aloud
  assert.match(board, /@container workitem-jump \(max-width: 329px\) \{\s*\.workitem-jump-name \{[^}]*clip-path: inset\(50%\);/);
  assert.doesNotMatch(board, /\.workitem-jump-name \{[^}]*display: none/);
});

test("Tailscale's node line is a sentence that wraps, with only the node's name in mono", async () => {
  const out = html(<TailscaleRow summary={{ enabled: true, managed: false, state: 'ready', host: 'claudio-test.tail0000.ts.net' }} phone open={false} onToggle={() => undefined} />);
  assert.match(out, /<span class="prov-meta is-prose">On the tailnet as <span class="mono">claudio-test\.tail0000\.ts\.net<\/span><\/span>/);
  // The phone cell cut it with an ellipsis; a prose line is never cut
  assert.doesNotMatch(out, /prov-meta[^"]*ellipsis/);
  assert.equal(rule(css('providers.css'), '.prov-meta.is-prose').get('font-family'), 'var(--sans)');
  assert.ok(rule(css('providers.css'), '.prov-cell-head .prov-meta:not(.is-prose)').get('text-overflow'), 'the ellipsis stays for literals alone');
  await i18n.changeLanguage('es');
  const es = html(<TailscaleRow summary={{ enabled: true, managed: false, state: 'ready', host: 'n.ts.net' }} phone={false} open={false} onToggle={() => undefined} />);
  assert.match(es, /En la tailnet como <span class="mono">n\.ts\.net<\/span>/);
});

test('with no project yet, Home offers a button to import one, not a link inside the sentence', () => {
  const client = new QueryClient();
  client.setQueryData(keys.projects, []);
  const out = html(<ProjectsWidget project={null} size="m" title="Projects" id="projects" />, client);
  assert.match(out, /<div class="form-actions"><a class="btn btn-small"[^>]*href="\/projects"[^>]*>Import your first project<\/a><\/div>/);
  assert.doesNotMatch(out, /lives on its page\. <a/);
});

test("a finger on the lower edge of a card's ⋯ opens its menu, never the task under it", () => {
  // The target sticks out of the card's 16 px top row, and the title link, later in the card,
  // painted over its lower edge: the "⋯" stands above it, as the phone row's does
  for (const selector of ['.workitem-card-more', '.workitem-mrow-more']) {
    const declared = rule(css('board.css'), selector);
    assert.equal(declared.get('position'), 'relative', `${selector} is positioned`);
    assert.equal(declared.get('z-index'), '1', `${selector} stands over the title`);
  }
});
