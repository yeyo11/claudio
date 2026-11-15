/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Account, AccountConfig, AccountConfigItem, AccountConfigPlan, RotationPolicy } from '@claudio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { accountSwitchText, configCrossing, readNotices } from '@claudio/chat-ui/lib/chat-notice';
import i18n, { setLanguage } from '../src/i18n';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { AccountCard } from '../src/pages/accounts/AccountCard';
import { ConfigPlanBody, planGroups } from '../src/pages/accounts/AccountConfigDialog';
import { requestOf, withAccount } from '../src/pages/accounts/ProjectRuleCard';
import { reservesByAccount, ruleOf } from '../src/lib/accounts';

// The account configuration and project rules screens (T10 of
// docs/plans/account-configuration-and-project-rules.md): each state of an account's configuration
// on its card, the mode switch's plan in words, and the rule edits a project's settings send.

const item = (over: Partial<AccountConfigItem>): AccountConfigItem => ({ name: 'settings.json', kind: 'file', class: 'config', state: 'linked', ...over });
const config = (over: Partial<AccountConfig> = {}): AccountConfig => ({
  mode: 'shared',
  state: 'ok',
  items: [item({}), item({ name: 'agents', kind: 'dir' }), item({ name: 'projects', kind: 'dir', class: 'history' })],
  switching: null,
  keptAside: [],
  ...over,
});
const account = (over: Partial<Account> = {}): Account => ({
  id: 'acc-1',
  checkedAt: null,
  kind: 'token',
  alias: 'work',
  email: null,
  organization: null,
  plan: null,
  enabled: true,
  signedIn: true,
  signInState: 'ok',
  limits: null,
  config: config(),
  ...over,
});

const words = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

async function card(a: Account, language: 'en' | 'es' = 'en'): Promise<string> {
  setLanguage(language);
  await i18n.changeLanguage(language);
  try {
    return renderToStaticMarkup(
      <TooltipProvider>
        <AccountCard account={a} current={false} busy={false} onToggle={() => undefined} onRemove={() => undefined} onSignInAgain={() => undefined} onSwitchConfig={() => undefined} />
      </TooltipProvider>,
    );
  } finally {
    setLanguage('en');
    await i18n.changeLanguage('en');
  }
}

test('an account in sync says its mode and a green word, and lists no item', async () => {
  const html = await card(account());
  assert.match(words(html), /Configuration Shared In sync/);
  assert.match(html, /badge badge-ok/);
  assert.doesNotMatch(html, /account-config-items/);
  assert.doesNotMatch(html, /Repair/);
});

test('an account of its own configuration says Own', async () => {
  assert.match(words(await card(account({ config: config({ mode: 'independent' }) }))), /Configuration Own In sync/);
});

test('items that wait for their link read Needs repair in warn, name them in mono and offer Repair once', async () => {
  const html = await card(account({ config: config({ state: 'repair', items: [item({ name: 'CLAUDE.md', state: 'missing' }), item({ name: 'rules', kind: 'dir', state: 'missing' })] }) }));
  assert.match(html, /badge badge-warn/);
  assert.match(words(html), /Needs repair/);
  assert.match(words(html), /Wait for their links to the shared ones: CLAUDE\.md, rules/);
  assert.match(html, /<span class="mono">CLAUDE\.md, rules<\/span>/);
  assert.equal((html.match(/aria-label="Repair the configuration of work"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /Use shared/);
});

test('a conflict reads in words what the account holds and what the shared one is, with Use shared', async () => {
  const html = await card(
    account({
      config: config({
        state: 'conflict',
        items: [item({ name: 'agent-memory', kind: 'dir', class: 'history', state: 'conflict', reason: 'real-dir' }), item({ name: 'settings.json', state: 'conflict', reason: 'real-file' })],
      }),
    }),
  );
  assert.match(html, /badge badge-bad/);
  const text = words(html);
  assert.match(text, /Conflict/);
  assert.match(text, /agent-memory This account: its own folder Shared: the history every account uses/);
  assert.match(text, /settings\.json This account: its own file Shared: the default account's file/);
  assert.match(html, /aria-label="Use the shared agent-memory on work"/);
  assert.match(html, /aria-label="Use the shared settings\.json on work"/);
  // Nothing waits for a link, so there is nothing to repair
  assert.doesNotMatch(html, /Repair the configuration/);
});

test('a switch left half-way says so and offers Repair to finish it', async () => {
  const html = await card(account({ config: config({ state: 'repair', switching: { to: 'independent', start: 'copy' } }) }));
  assert.match(words(html), /A switch to its own configuration was left half-way: Repair finishes it\./);
  assert.match(html, /Repair the configuration of work/);
});

test('the default account has no mode, so its card says nothing about one', async () => {
  const { config: _none, ...rest } = account({ id: 'default' });
  assert.doesNotMatch(words(await card(rest)), /Configuration/);
});

test('the configuration reads in Spanish from Spain', async () => {
  const html = await card(account({ config: config({ state: 'conflict', items: [item({ name: 'agents', kind: 'dir', state: 'conflict', reason: 'link-elsewhere' })] }) }), 'es');
  const text = words(html);
  assert.match(text, /Configuración Compartida En conflicto/);
  assert.match(text, /Esta cuenta: un enlace a otro sitio Compartida: la carpeta de la cuenta predeterminada/);
  assert.match(text, /Usar la compartida/);
});

test('a card names the projects whose rule keeps headroom on it', async () => {
  setLanguage('en');
  await i18n.changeLanguage('en');
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <AccountCard account={account()} current={false} busy={false} onToggle={() => undefined} onRemove={() => undefined} onSignInAgain={() => undefined} reservedFor="claudio, shipcast" />
    </TooltipProvider>,
  );
  assert.match(words(html), /Keeps headroom for claudio, shipcast while it has work/);
});

// ---------- the mode switch ----------

const plan = (over: Partial<AccountConfigPlan> = {}): AccountConfigPlan => ({ account: 'acc-1', from: 'shared', to: 'independent', start: 'copy', aside: null, steps: [], ...over });

test('a switch plan is read as what is copied, linked, kept aside and left, with history never listed', () => {
  assert.deepEqual(
    planGroups(
      plan({
        steps: [
          { name: 'settings.json', class: 'config', action: 'copy' },
          { name: 'agents', class: 'config', action: 'copy' },
          { name: 'projects', class: 'history', action: 'keep' },
          { name: 'commands', class: 'config', action: 'skip' },
          { name: 'skills', class: 'config', action: 'conflict', reason: 'real-dir' },
        ],
      }),
    ),
    [
      { group: 'copied', names: ['settings.json', 'agents'] },
      { group: 'conflict', names: ['skills'] },
    ],
  );
  // Back to shared: an own item goes aside and the shared one takes its place; history moved aside is said
  assert.deepEqual(
    planGroups(
      plan({
        to: 'shared',
        start: null,
        aside: '.claudio-own/2026-11-15T10-00-00-000Z',
        steps: [
          { name: 'settings.json', class: 'config', action: 'replace' },
          { name: 'themes', class: 'config', action: 'move-aside' },
          { name: 'agent-memory', class: 'history', action: 'replace' },
          { name: 'projects', class: 'history', action: 'link' },
        ],
      }),
    ),
    [
      { group: 'linked', names: ['settings.json', 'agent-memory'] },
      { group: 'aside', names: ['settings.json', 'themes', 'agent-memory'] },
    ],
  );
});

async function body(props: Parameters<typeof ConfigPlanBody>[0], language: 'en' | 'es' = 'en'): Promise<string> {
  await i18n.changeLanguage(language);
  try {
    return renderToStaticMarkup(
      <TooltipProvider>
        <ConfigPlanBody {...props} />
      </TooltipProvider>,
    );
  } finally {
    await i18n.changeLanguage('en');
  }
}

test('the switch to own says what is copied and offers to start empty, with copy chosen', async () => {
  const html = await body({ name: 'work', to: 'independent', start: 'copy', onStart: () => undefined, loading: false, error: null, plan: plan({ steps: [{ name: 'settings.json', class: 'config', action: 'copy' }] }) });
  const text = words(html);
  assert.match(text, /work keeps its settings, instructions, agents and the rest in its own folder/);
  assert.match(text, /Start from A copy of the shared one Empty/);
  assert.match(html, /aria-checked="true"[^>]*>(?:<[^>]+>)*A copy of the shared one/);
  assert.match(text, /Copied into the account settings\.json/);
  assert.match(text, /Chat history and agent memory stay shared in both modes\./);
});

test('the switch to shared says where the account\'s own files are kept, in mono, and offers no start', async () => {
  const html = await body({
    name: 'work',
    to: 'shared',
    start: 'copy',
    onStart: () => undefined,
    loading: false,
    error: null,
    plan: plan({ to: 'shared', start: null, aside: '.claudio-own/2026-11-15T10-00-00-000Z', steps: [{ name: 'CLAUDE.md', class: 'config', action: 'replace' }] }),
  });
  const text = words(html);
  assert.doesNotMatch(text, /Start from/);
  assert.match(text, /Kept aside, never deleted CLAUDE\.md in \.claudio-own\/2026-11-15T10-00-00-000Z/);
  assert.match(html, /<span class="mono">\.claudio-own\/2026-11-15T10-00-00-000Z<\/span>/);
});

test('a plan with nothing to do says so, in Spanish too', async () => {
  const props = { name: 'work', to: 'shared' as const, start: 'copy' as const, onStart: () => undefined, loading: false, error: null, plan: plan({ to: 'shared', steps: [{ name: 'settings.json', class: 'config' as const, action: 'keep' as const }] }) };
  assert.match(words(await body(props)), /Nothing to copy, link or move\./);
  assert.match(words(await body(props, 'es')), /No hay nada que copiar, enlazar ni mover\./);
});

// ---------- project rules ----------

const policy = (over: Partial<RotationPolicy> = {}): RotationPolicy => ({ id: 'p1', projects: ['proj-a'], ...over });
const accounts = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

test('a rule is written back whole, so one change never drops another field', () => {
  assert.deepEqual(requestOf(policy({ threshold: 95, order: ['a', 'b'], preferred: 'a', reserve: { percent: 10 }, strictConfig: true, looseChats: true })), {
    projects: ['proj-a'],
    threshold: 95,
    order: ['a', 'b'],
    preferred: 'a',
    reserve: { percent: 10 },
    strictConfig: true,
    looseChats: true,
  });
  assert.deepEqual(requestOf(policy()), { projects: ['proj-a'] });
});

test('turning an account off a rule with no list allows every other one', () => {
  assert.deepEqual(withAccount({ projects: ['proj-a'] }, accounts, 'b', false), { projects: ['proj-a'], order: ['a', 'c'] });
  assert.deepEqual(withAccount({ projects: ['proj-a'], order: ['a'] }, accounts, 'c', true), { projects: ['proj-a'], order: ['a', 'c'] });
});

test('the preferred account leaves with the account turned off, and the reserve stays while the list names an account', () => {
  assert.deepEqual(withAccount({ projects: ['proj-a'], order: ['a', 'b'], preferred: 'a', reserve: { percent: 5 } }, accounts, 'a', false), {
    projects: ['proj-a'],
    order: ['b'],
    reserve: { percent: 5 },
  });
});

test('the rule of a project and the headroom each account keeps are found from the policies', () => {
  const list = [policy(), policy({ id: 'p2', projects: ['proj-b', 'proj-c'], looseChats: true, order: ['b', 'a'], reserve: { percent: 10 } }), policy({ id: 'p3', projects: ['proj-d'], preferred: 'c', reserve: { percent: 20 } })];
  assert.equal(ruleOf(list, 'proj-c')?.id, 'p2');
  assert.equal(ruleOf(list, 'proj-x'), undefined);
  const names: Record<string, string> = { 'proj-b': 'Beta', 'proj-c': 'Gamma', 'proj-d': 'Delta' };
  const reserves = reservesByAccount(list, (id) => names[id] ?? id, 'chats with no project');
  assert.equal(reserves.get('b'), 'Beta, Gamma, chats with no project');
  assert.equal(reserves.get('c'), 'Delta');
  assert.equal(reserves.has('a'), false);
});

// ---------- the transcript line ----------

test('a switch to an account of another configuration says which one it now runs with', () => {
  const shared = { id: 'a', config: config() };
  const own = { id: 'b', config: config({ mode: 'independent' }) };
  const otherOwn = { id: 'c', config: config({ mode: 'independent' }) };
  assert.equal(configCrossing(shared, { id: 'default' }), undefined, 'the default account is in the shared group');
  assert.equal(configCrossing(shared, own), 'own');
  assert.equal(configCrossing(own, shared), 'shared');
  assert.equal(configCrossing(own, otherOwn), 'own', 'two independent accounts are two groups');
  assert.equal(configCrossing(undefined, own), undefined, 'nothing is said without the list');
  assert.deepEqual(readNotices(accountSwitchText('work', 'own')).notices, [{ kind: 'account', detail: 'work', body: '', config: 'own' }]);
  assert.deepEqual(readNotices(accountSwitchText('work')).notices, [{ kind: 'account', detail: 'work', body: '' }]);
});
