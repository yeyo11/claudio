// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppSettings, AuthConfig } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { keys } from '../src/api';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { ConfirmProvider } from '@claudio/ui/components/Dialog';
import { ToastProvider } from '@claudio/ui/components/Toast';
import i18n, { setLanguage } from '../src/i18n';
import { en, es } from '../src/i18n/resources';
import { RunsCard } from '../src/pages/config/AppSettingsCards';
import { Access } from '../src/pages/config/groups/Access';
import { SaveButton } from '../src/pages/config/groups/Block';
import { Runs } from '../src/pages/config/groups/Runs';
import { sectionsOf } from '../src/pages/config/settingsGroups';
import { SETTINGS_INDEX } from '../src/pages/config/settingsIndex';

// Settings → Runs & spend and Access & safety (docs/plans/settings-ia.md §6.7, §6.8): the sections
// in the plan's order with no card titles of their own, every row the search registry names marked
// where it lives, the two logs as a preview and a row to their detail, and each consequence live.

const APP: AppSettings = {
  allowedHosts: ['claudio.example.com'],
  maxConcurrentRuns: 8,
  defaultPermissionMode: 'manual',
  setupSeen: true,
  dailySpendCapUsd: null,
  evalsPhase2: false,
  openaiToolCallTimeoutMinutes: 10,
  sources: { allowedHosts: 'file', maxConcurrentRuns: 'default', defaultPermissionMode: 'default', setupSeen: 'default', dailySpendCapUsd: 'default', evalsPhase2: 'default', openaiToolCallTimeoutMinutes: 'default' },
  allowedHostLayers: { env: [], file: ['claudio.example.com'], runtime: [] },
};
const AUTH: AuthConfig = { mode: 'token', tokenSet: true, readOnly: false, oidc: null } as unknown as AuthConfig;

function render(children: ReactNode, path = '/settings/access') {
  const client = new QueryClient();
  client.setQueryData(keys.appSettings, APP);
  client.setQueryData(keys.securityAuth, AUTH);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <TooltipProvider>
          <ToastProvider>
            <ConfirmProvider>{children}</ConfirmProvider>
          </ToastProvider>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const sectionIds = (html: string) => [...html.matchAll(/<section id="([^"]+)" class="settings-section"/g)].map((m) => m[1]);
const settingIds = (html: string) => new Set([...html.matchAll(/data-setting="([^"]+)"/g)].map((m) => m[1]));

const speak = async (language: 'en' | 'es') => {
  setLanguage(language);
  await i18n.changeLanguage(language);
};

test.beforeEach(() => speak('en'));
test.after(async () => {
  setLanguage('en');
  await i18n.changeLanguage('en');
});

test('both screens draw their sections in the order of §3', () => {
  // Machine is a row that opens its own screen: it has no heading, so it is not one of the headed sections
  const runs = render(<Runs />, '/settings/runs');
  assert.deepEqual(sectionIds(runs), sectionsOf('runs').filter((id) => id !== 'machine'));
  assert.match(runs, /<section id="machine" class="settings-row-section"/);
  assert.deepEqual(sectionIds(render(<Access />)), [...sectionsOf('access')]);
});

test('every row the search registry names is marked on its screen or its detail', () => {
  const screens = { runs: render(<Runs />, '/settings/runs'), access: render(<Access />) };
  const details = { audit: render(<Access detail="audit" />, '/settings/access/audit'), 'agent-reads': render(<Access detail="agent-reads" />, '/settings/access/agent-reads') };
  for (const entry of SETTINGS_INDEX) {
    if (entry.group !== 'runs' && entry.group !== 'access') continue;
    // A section's own entry is its anchor; the shell scrolls to it
    if (entry.id === entry.section) continue;
    // The rows inside the guards and terminal cards draw once the card has read its settings: a static render holds their skeleton
    if (/^(guards\.(mode|automated|rule\.)|terminal\.(?!enabled$))/.test(entry.id)) continue;
    // The Machine detail is a lazy chunk the static render cannot draw: its row on the group's screen stands for it
    const html = entry.detail && entry.detail !== 'machine' ? details[entry.detail as keyof typeof details] : screens[entry.group];
    assert.ok(settingIds(html).has(entry.id), `${entry.id} is marked`);
  }
});

test('the sections carry no card title of their own: the section heading names each one', () => {
  const html = render(<Access />);
  assert.doesNotMatch(html, /<div class="card-head"><h2>/);
  assert.equal((html.match(/id="guards"/g) ?? []).length, 1, 'the guards card no longer repeats the anchor');
  // Access holds three parts, each named a level under the section's heading, with its state in words
  assert.match(html, /<h4 class="settings-block-title">Authentication mode<\/h4><span class="badge badge-ok">.*?<span class="badge-text">token/);
  assert.match(html, /<h4 class="settings-block-title">Token<\/h4>/);
  assert.match(html, /<h4 class="settings-block-title">Read-only mode<\/h4>/);
  assert.ok(text(html).includes('Turn it on to show the panel without letting anyone change it.'));
});

test('the logs show their latest rows here and open their detail from one row', () => {
  const html = render(<Access />);
  assert.match(html, /href="\/settings\/access\/audit"[^>]*>.*See the whole log/);
  assert.match(html, /href="\/settings\/access\/agent-reads"[^>]*>.*See every read/);
  // The detail owns the filters; the group's screen has none
  assert.doesNotMatch(html, /aria-label="Filter by path"/);
  assert.match(render(<Access detail="audit" />, '/settings/access/audit'), /aria-label="Filter by path"/);
});

test('the run defaults say what each value does, live', () => {
  const html = text(render(<RunsCard saved={APP} />, '/settings/runs'));
  assert.ok(html.includes('Each tool asks before it runs.'));
  assert.ok(html.includes('Up to 8 runs at once; a new chat past them is refused.'));
  const one = text(render(<RunsCard saved={{ ...APP, maxConcurrentRuns: 1, defaultPermissionMode: 'plan' }} />, '/settings/runs'));
  assert.ok(one.includes('Claude plans and changes nothing.'));
  assert.ok(one.includes('Up to 1 run at once; a new chat past it is refused.'));
});

test('a quiet section saves with a plain button that keeps its width while saving', () => {
  const html = render(<Runs />, '/settings/runs');
  assert.doesNotMatch(html, /btn-primary/, 'no gradient until a section has changes');
  assert.match(
    html,
    /<button type="submit" class="btn" disabled="" data-states="idle\|loading" data-state="idle"><span class="btn-states"><span class="btn-state-idle">Save<\/span><span class="btn-state-loading">Saving…<\/span>/,
  );
});

test('a save takes the gradient only while it has changes it can send', () => {
  const save = (dirty: boolean, disabled: boolean) => render(<SaveButton label="Save" savingLabel="Saving…" dirty={dirty} pending={false} disabled={disabled} />);
  assert.match(save(true, false), /class="btn btn-primary"/);
  // Token picked with no token set: changed, but nothing it could save
  assert.match(save(true, true), /class="btn" disabled=""/);
  assert.match(save(false, false), /class="btn" disabled=""/);
});

test('the hosts say how many names answer besides localhost', () => {
  assert.ok(text(render(<Access />)).includes('Answers to 1 name besides localhost.'));
});

test('every permission mode has its consequence, in both languages', () => {
  const modes = (resources: typeof en) => Object.keys(resources.config.appSettings.runs.modeConsequence).sort();
  assert.deepEqual(modes(es), modes(en));
  assert.deepEqual(modes(en), ['acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'manual', 'plan']);
});

test('Spanish: the consequences in the glossary words', async () => {
  await speak('es');
  const html = text(render(<RunsCard saved={APP} />, '/settings/runs'));
  assert.ok(html.includes('Cada herramienta pregunta antes de ejecutarse.'));
  assert.ok(html.includes('Hasta 8 ejecuciones a la vez; un chat nuevo por encima se rechaza.'));
});
