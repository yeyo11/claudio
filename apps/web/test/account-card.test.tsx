/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Account, AccountCredits, AccountLimit } from '@claudio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n, { setLanguage } from '../src/i18n';
import { AccountCard } from '../src/pages/accounts/AccountCard';
import { creditsView, formatCredits, planOf, scopedRows, usageStale } from '../src/lib/accounts';

const NOW = Date.parse('2026-10-17T20:00:00Z');
// The card judges resets against the real clock, so these are relative to it
const later = (s: number): number => Math.floor(Date.now() / 1000) + s;

const credits = (over: Partial<AccountCredits> = {}): AccountCredits => ({ enabled: false, usedMinor: 0, limitMinor: null, currency: 'EUR', exponent: 2, limitReached: false, disabledReason: null, everEnabled: false, ...over });
const limit = (over: Partial<NonNullable<AccountLimit['cli']>> = {}): AccountLimit => ({
  state: 'ok',
  window: 'seven_day',
  utilization: 0.27,
  resetsAt: new Date((later(86_400)) * 1000).toISOString(),
  windows: { five_hour: { utilization: 0.05, resetsAt: later(3600) }, seven_day: { utilization: 0.27, resetsAt: later(86_400) } },
  observedAt: new Date(NOW).toISOString(),
  source: 'cli',
  cli: { observedAt: new Date(NOW).toISOString(), plan: 'max', available: true, scoped: [{ model: 'Fable', window: 'seven_day', utilization: 0.05, resetsAt: later(86_400) }], credits: credits(), ...over },
});
// What a reading with no readout looks like: no windows, only the CLI's note that there are none
const unreadable = (): AccountLimit => ({ ...limit({ available: false, plan: null, scoped: [], credits: null }), state: 'unknown', window: null, utilization: null, resetsAt: null, windows: {} });
const account = (over: Partial<Account> = {}): Account => ({
  id: 'default',
  checkedAt: null,
  kind: 'login',
  alias: null,
  email: 'me@example.com',
  organization: 'Org',
  plan: 'max',
  enabled: true,
  signedIn: true,
  signInState: 'ok',
  limits: limit(),
  ...over,
});
const render = async (a: Account): Promise<string> => {
  setLanguage('en');
  await i18n.changeLanguage('en');
  return renderToStaticMarkup(<AccountCard account={a} current={false} busy={false} onToggle={() => undefined} onRemove={() => undefined} onSignInAgain={() => undefined} />);
};

test('the card names the plan as a tag beside the name, not in the muted line', async () => {
  const html = await render(account());
  assert.match(html, /<span class="badge badge-muted"><span class="badge-text">Max<\/span><\/span>/);
  assert.doesNotMatch(html, /Org · Max/);
});

test('the card draws a bar for the session, the week and each model-scoped weekly limit by its model', async () => {
  const html = await render(account());
  assert.match(html, /5 hours/);
  assert.match(html, />7 days</);
  assert.match(html, /7 days · Fable/);
  assert.equal((html.match(/class="meter-track"/g) ?? []).length, 3);
});

test('credits that were never set up say nothing, and ones that were turned off say so', async () => {
  assert.doesNotMatch(await render(account()), /Credits|credits/);
  assert.match(await render(account({ limits: limit({ credits: credits({ everEnabled: true }) }) })), /No extra credits/);
});

test('enabled credits say what was spent of the monthly cap, in the currency the CLI stated', async () => {
  const html = await render(account({ limits: limit({ credits: credits({ enabled: true, everEnabled: true, usedMinor: 1230, limitMinor: 5000 }) }) }));
  assert.match(html, /Credits · €12\.30 of €50\.00 this month/);
});

test('a reached spend cap is a warn tag with a word', async () => {
  const html = await render(account({ limits: limit({ credits: credits({ enabled: true, everEnabled: true, usedMinor: 5000, limitMinor: 5000, limitReached: true }) }) }));
  assert.match(html, /badge-warn[^>]*>.*Limit reached/);
});

test('an API-key account is tagged as one and says it has no limits', async () => {
  const html = await render(account({ kind: 'api-key', alias: 'ci', email: null, plan: null, limits: unreadable() }));
  assert.match(html, /badge-text">API key</);
});

test('a token account the CLI cannot read says so, rather than calling itself an API key', async () => {
  const html = await render(account({ kind: 'token', alias: 'ci', email: null, plan: null, limits: unreadable() }));
  assert.match(html, /The CLI gives no usage for a token/);
  assert.doesNotMatch(html, /An API key has no usage limits/);
});

test('plans are named in words: known ones by key, others as the CLI wrote them', () => {
  assert.deepEqual(planOf({ kind: 'login', plan: 'Claude Max' }), { key: 'max' });
  assert.deepEqual(planOf({ kind: 'token', plan: 'pro' }), { key: 'pro' });
  assert.deepEqual(planOf({ kind: 'login', plan: 'free' }), { raw: 'Free' });
  assert.deepEqual(planOf({ kind: 'api-key', plan: null }), { key: 'apiKey' });
  assert.equal(planOf({ kind: 'token', plan: null }), null);
});

test('credit amounts use the currency and decimal places of the CLI', () => {
  setLanguage('en');
  assert.equal(formatCredits(1230, { currency: 'USD', exponent: 2 }), '$12.30');
  assert.equal(formatCredits(1500, { currency: 'JPY', exponent: 0 }), '¥1,500');
  assert.equal(formatCredits(250, { currency: null, exponent: 2 }), '2.50');
  assert.equal(creditsView(null), null);
  assert.equal(creditsView(credits({ enabled: true, everEnabled: true, usedMinor: 100 }))?.limit, null);
});

test('a scoped limit whose reset passed is not drawn', () => {
  const l = limit({ scoped: [{ model: 'Fable', window: 'seven_day', utilization: 0.9, resetsAt: later(-60) }] });
  assert.deepEqual(scopedRows(l), []);
});

test('opening Accounts reads the CLI when an account has no answer from it or an old one', () => {
  const fresh = account();
  assert.equal(usageStale([fresh], NOW + 5 * 60_000), false);
  assert.equal(usageStale([fresh], NOW + 11 * 60_000), true);
  assert.equal(usageStale([account({ limits: null })], NOW), true);
  assert.equal(usageStale([account({ limits: null, signedIn: false })], NOW), false, 'a signed-out account cannot answer');
  assert.equal(usageStale([account({ limits: null, enabled: false })], NOW), false);
});

// ---------- the Accounts page items of assistant-everything §6 and C4's preference ----------

const renderWith = async (a: Account, props: { preferred?: boolean; onPrefer?: () => void } = {}): Promise<string> => {
  setLanguage('en');
  await i18n.changeLanguage('en');
  return renderToStaticMarkup(<AccountCard account={a} current={false} busy={false} onToggle={() => undefined} onRemove={() => undefined} onSignInAgain={() => undefined} {...props} />);
};
const words = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('the organisation and the kind are one line with a separator between them', async () => {
  assert.match(words(await render(account())), /Org · Claude account/);
  setLanguage('es');
  await i18n.changeLanguage('es');
  const es = words(renderToStaticMarkup(<AccountCard account={account()} current={false} busy={false} onToggle={() => undefined} onRemove={() => undefined} onSignInAgain={() => undefined} />));
  assert.match(es, /Org · Cuenta de Claude/);
});

test('Hold out is the card\'s own button and is not in its menu again', async () => {
  const html = await render(account({ id: 'work' }));
  assert.equal((words(html).match(/Hold out/g) ?? []).length, 1);
  // The default account cannot be removed, so it has no menu at all
  assert.doesNotMatch(await render(account()), /account-more/);
});

test('Use this account sets the preference; the preferred one carries the tag instead', async () => {
  const offered = await renderWith(account({ id: 'work' }), { onPrefer: () => undefined });
  assert.match(words(offered), /Use this account/);
  assert.doesNotMatch(words(offered), /Preferred/);
  const chosen = await renderWith(account({ id: 'work' }), { preferred: true, onPrefer: () => undefined });
  assert.doesNotMatch(words(chosen), /Use this account/);
  assert.match(chosen, /<span class="badge badge-muted"><span class="badge-text">Preferred<\/span><\/span>/);
  // An account that cannot take work cannot be preferred
  assert.doesNotMatch(words(await renderWith(account({ id: 'off', enabled: false }), { onPrefer: () => undefined })), /Use this account/);
});

test('a fresh reading does not repeat the page\'s "read … ago"; an old one says how old it is', async () => {
  const fresh = { ...limit(), observedAt: new Date().toISOString() };
  assert.doesNotMatch(words(await render(account({ limits: fresh }))), /read from/);
  const old = { ...limit(), observedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() };
  assert.match(words(await render(account({ limits: old }))), /read from the CLI/);
});

test('a window running high is a warn tag even when its bar is bad; only a spent window is bad', async () => {
  const high = { ...limit(), windows: { five_hour: { utilization: 0.8, resetsAt: later(3600) } } };
  const html = await render(account({ limits: high }));
  assert.match(html, /badge-warn[^>]*>(<[^>]+>)*[^<]*running high/);
  assert.doesNotMatch(html, /badge-bad/);
});
