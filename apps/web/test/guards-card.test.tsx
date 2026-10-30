// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_GUARD_SETTINGS, GUARD_RULES, type GuardEvent, type GuardSettingsView } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ApiRequestError } from '../src/api';
import { TooltipProvider } from '@claudio/ui/components/controls';
import i18n from '../src/i18n';
import { en, es } from '../src/i18n/resources';
import { CheckResultLine, GuardsCardView, checkRequest, parseGlobs, type GuardsCardViewProps } from '../src/pages/config/GuardsCard';

const view = (over: Partial<GuardSettingsView['settings']> = {}, status: Partial<GuardSettingsView['status']> = {}): GuardSettingsView => ({
  settings: { ...DEFAULT_GUARD_SETTINGS, rules: { ...DEFAULT_GUARD_SETTINGS.rules }, protectConfigs: [...DEFAULT_GUARD_SETTINGS.protectConfigs], extraRoots: [], ...over },
  status: { available: true, problem: null, cliVersion: '2.1.300', ...status },
  rules: [...GUARD_RULES],
});

const event = (over: Partial<GuardEvent> = {}): GuardEvent => ({
  seq: 1,
  at: '2026-10-16T10:00:00Z',
  chatId: 'chat-1',
  projectId: null,
  orchestrationId: null,
  taskId: null,
  flowRunId: null,
  toolUseId: 'tu-1',
  toolName: 'Bash',
  rule: 'push',
  matcher: 'push.git-verb',
  outcome: 'blocked',
  reason: 'git push is blocked',
  excerpt: 'git push origin main',
  ...over,
});

const noop = () => undefined;
const props = (over: Partial<GuardsCardViewProps> = {}): GuardsCardViewProps => ({
  data: view(),
  loadError: null,
  onRetry: noop,
  readOnly: false,
  events: [],
  eventsError: null,
  saving: false,
  saveError: null,
  onSave: noop,
  checking: false,
  checkResult: undefined,
  checkError: null,
  onCheck: noop,
  ...over,
});

async function render(over: Partial<GuardsCardViewProps> = {}, language = 'en'): Promise<string> {
  await i18n.changeLanguage(language);
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <MemoryRouter>
          <GuardsCardView {...props(over)} />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const words = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('the copy of the card has the same keys and placeholders in both languages', () => {
  const holes = (s: string) => [...s.matchAll(/{{(\w+)}}/g)].map((m) => m[1]).sort().join();
  const flat = (o: Record<string, unknown>, at = ''): Array<[string, string]> =>
    Object.entries(o).flatMap(([k, v]) => (typeof v === 'string' ? [[`${at}${k}`, v] as [string, string]] : flat(v as Record<string, unknown>, `${at}${k}.`)));
  const english = flat((en.config as { security: { guards: Record<string, unknown> } }).security.guards);
  const spanish = new Map(flat((es.config as { security: { guards: Record<string, unknown> } }).security.guards));
  for (const [key, value] of english) {
    const other = spanish.get(key);
    assert.ok(other, `es ${key}`);
    assert.equal(holes(value), holes(other), key);
  }
  assert.equal(spanish.size, english.length);
});

test('loading draws skeleton rows and no switches', async () => {
  const html = await render({ data: undefined });
  assert.match(html, /skeleton/);
  assert.doesNotMatch(html, /role="switch"/);
});

test('a failed read says so, with the reason and a Retry button', async () => {
  const html = await render({ data: undefined, loadError: new ApiRequestError('boom', 500) });
  assert.match(html, /role="alert"/);
  assert.match(words(html), /Could not load the guard settings boom Retry/);
});

test('an unavailable guard names its problem and what to do, in both languages', async () => {
  const unavailable = view({}, { available: false, problem: 'cli-unsupported' });
  assert.match(words(await render({ data: unavailable })), /Not available: Update Claude Code to 2\.1\.300 or later\./);
  assert.match(words(await render({ data: unavailable }, 'es')), /No disponibles: Actualiza Claude Code a la 2\.1\.300 o posterior\./);
});

test('an active guard shows the count of rules on, integrity among them with a switch of its own', async () => {
  const html = await render();
  const text = words(html);
  assert.match(text, /Active for automated runs · 5 rules on/);
  assert.doesNotMatch(text, /Always on/);
  // one Switch per rule, integrity included, the automated one and "Observe only"
  assert.equal((html.match(/role="switch"/g) ?? []).length, 1 + 6 + 1);
  assert.match(html, /data-rule="integrity" data-setting="guards.rule.integrity"[^>]*>[\s\S]*?role="switch"[\s\S]*?data-rule="no-verify"/);
  assert.match(html, /<code class="mono small muted">no-verify<\/code>/);
});

test('with every rule off the card says no run is guarded, and never tags it Active (D6)', async () => {
  const none = Object.fromEntries(Object.keys(DEFAULT_GUARD_SETTINGS.rules).map((id) => [id, false])) as typeof DEFAULT_GUARD_SETTINGS.rules;
  const html = await render({ data: view({ rules: none }) });
  assert.match(words(html), /No rule is on, so no run is guarded: switch a rule on/);
  assert.doesNotMatch(words(html), /\bactive\b/i);
  assert.match(words(await render({ data: view({ rules: none }) }, 'es')), /Ninguna regla activada, así que no se protege ninguna ejecución/);
  // The automated switch and "Observe only" have nothing to act on: disabled, while every rule stays switchable
  const disabled = (html.match(/<button[^>]*role="switch"[^>]*>/g) ?? []).filter((tag) => /disabled/.test(tag));
  assert.equal(disabled.length, 2);
  // One rule on is a guard again, counted in the singular
  assert.match(words(await render({ data: view({ rules: { ...none, integrity: true } }) })), /Active for automated runs · 1 rule on/);
});

test('observe mode is a warn line, and protect-configs shows its globs only when the rule is on', async () => {
  const observing = await render({ data: view({ mode: 'observe' }) });
  assert.match(words(observing), /Observe mode: nothing is blocked/);
  assert.doesNotMatch(observing, /data-testid="guard-configs"/);
  const on = await render({ data: view({ rules: { ...DEFAULT_GUARD_SETTINGS.rules, 'protect-configs': true } }) });
  assert.match(on, /data-testid="guard-configs"/);
  assert.match(on, /\.pre-commit-config\.yaml/);
  assert.match(words(on), /Restore defaults/);
});

test('read-only mode disables every switch and says why', async () => {
  const html = await render({ readOnly: true });
  const switches = html.match(/<button[^>]*role="switch"[^>]*>/g) ?? [];
  assert.equal(switches.length, 8);
  assert.ok(switches.every((tag) => /disabled/.test(tag)));
  assert.match(words(html), /Claudio is in read-only mode, so guards cannot be changed here\./);
});

test('a chat token that tries to write sees "Only a person can change guards."', async () => {
  const html = await render({ saveError: new ApiRequestError('forbidden', 403) });
  assert.match(words(html), /Only a person can change guards\./);
  assert.doesNotMatch(words(html), /Could not save the guard settings/);
});

test('any other failed save is named with the server reason', async () => {
  const text = words(await render({ saveError: new ApiRequestError('disk full', 500) }));
  assert.match(text, /Could not save the guard settings disk full/);
});

test('the glob list repeats the reasons the server refuses for', () => {
  assert.deepEqual(parseGlobs('a\n\n  a \nb').globs, ['a', 'b']);
  assert.deepEqual(parseGlobs('/etc/passwd\n../x\nC:\\x\nok').problems, [
    { key: 'absolute', glob: '/etc/passwd' },
    { key: 'parent', glob: '../x' },
    { key: 'absolute', glob: 'C:\\x' },
  ]);
  assert.deepEqual(parseGlobs('x'.repeat(301)).problems, [{ key: 'tooLong', glob: 'x'.repeat(301) }]);
  assert.deepEqual(parseGlobs(Array.from({ length: 201 }, (_, i) => `g${i}`).join('\n')).problems, [{ key: 'tooMany' }]);
  assert.deepEqual(parseGlobs('.eslintrc*\nci/**').problems, []);
});

test('a 400 from the server shows under the globs', async () => {
  const html = await render({
    data: view({ rules: { ...DEFAULT_GUARD_SETTINGS.rules, 'protect-configs': true } }),
    saveError: new ApiRequestError('protectConfigs: a glob cannot be empty', 400),
  });
  assert.match(words(html), /protectConfigs: a glob cannot be empty/);
  assert.match(html, /aria-invalid="true"/);
});

test('"Try a command" builds the call for each tool', () => {
  assert.equal(checkRequest('Bash', '   ', ''), null);
  assert.deepEqual(checkRequest('Bash', ' git push ', ''), { tool: 'Bash', input: { command: 'git push' } });
  assert.deepEqual(checkRequest('Write', '.env', 'KEY=1'), { tool: 'Write', input: { file_path: '.env', content: 'KEY=1' } });
  assert.deepEqual(checkRequest('Edit', 'a.ts', 'x'), { tool: 'Edit', input: { file_path: 'a.ts', old_string: '', new_string: 'x' } });
});

test('"Try a command" answers in a polite live region: the verdict, the rule and the reason', async () => {
  const blocked = await render({ checkResult: { verdict: 'block', rule: 'push', matcher: 'push.git-verb', reason: 'git push is blocked' } });
  assert.match(blocked, /aria-live="polite"[^>]*data-testid="guard-result"|data-testid="guard-result"[^>]*aria-live="polite"/);
  assert.match(words(blocked), /Would be blocked push git push is blocked/);
  const passed = await render({ checkResult: { verdict: 'pass' } });
  assert.match(words(passed), /Passes/);
  const failed = await render({ checkError: new ApiRequestError('unreachable', 0) });
  assert.match(words(failed), /unreachable/);
  assert.match(renderToStaticMarkup(<CheckResultLine result={{ verdict: 'pass' }} />), /Passes/);
  assert.match(words(await render({}, 'es')), /Probar un comando/);
});

test('recent blocks list time, rule, outcome, excerpt and a link to the chat, or a plain line when empty', async () => {
  const html = await render({ events: [event(), event({ seq: 2, outcome: 'missing', rule: 'integrity', excerpt: 'rm -rf x' })] });
  assert.match(html, /href="\/chats\/chat-1"/);
  assert.match(words(html), /Recent blocks[\s\S]*push Blocked git push origin main/);
  assert.match(words(html), /integrity No guard ran rm -rf x/);
  assert.match(words(await render({ events: [] })), /No blocks yet/);
  assert.doesNotMatch(await render({ events: [] }), /illustration/);
});
