// Settings search (docs/plans/settings-ia.md §5): accents and case do not matter, every word is a
// prefix, labels beat keywords beat consequences, ties go by group order, and Spanish searches Spanish.
import assert from 'node:assert/strict';
import test from 'node:test';
import i18n from '../src/i18n';
import { fold, matchSettings, MAX_SETTING_RESULTS, searchableSettings, translator } from '../src/pages/config/search/match';
import { entryHref } from '../src/pages/config/search/reveal';
import { SETTINGS_INDEX } from '../src/pages/config/settingsIndex';

async function search(language: 'en' | 'es', query: string): Promise<string[]> {
  await i18n.changeLanguage(language);
  return matchSettings(searchableSettings(translator(i18n.t)), query).map((item) => item.entry.id);
}

test('folding drops case and accents', () => {
  assert.equal(fold('Auditoría ÉXITO'), 'auditoria exito');
});

test('accents and case do not matter, either way round', async () => {
  assert.equal((await search('es', 'auditoria'))[0], 'audit');
  assert.equal((await search('es', 'AUDITORÍA'))[0], 'audit');
  assert.ok((await search('es', 'suscripcion')).includes('sign-in.account'));
  assert.ok((await search('es', 'tunel')).includes('remote.tunnel'));
});

test('every word of the query is the start of a word, in any order', async () => {
  assert.equal((await search('en', 'spe ca'))[0], 'spend-cap');
  assert.equal((await search('en', 'cap spend'))[0], 'spend-cap');
  assert.deepEqual(await search('en', 'pend'), [], 'the middle of a word is not a match');
  assert.deepEqual(await search('en', '   '), []);
});

test('label matches first, then keywords, then consequences; ties by group order', async () => {
  const token = await search('en', 'token');
  // "API token" is the only label: it comes first though Access is the last group
  assert.equal(token[0], 'access.token');
  // Then keyword matches, in group order: Claude Code's sign-in before Connections' tracker
  assert.ok(token.indexOf('sign-in.panel') < token.indexOf('trackers.youtrack'));
  assert.ok(token.indexOf('sign-in.panel') > 0);
  // "slot" is only in the consequence of concurrent runs
  assert.deepEqual(await search('en', 'slot'), ['runs.concurrent']);
});

test('Spanish searches the Spanish words', async () => {
  assert.equal((await search('es', 'tema'))[0], 'appearance.theme');
  assert.equal((await search('es', 'gasto'))[0], 'spend-cap');
  assert.equal((await search('es', 'quién responde'))[0], 'engine');
  // An English word that is only in the English copy finds nothing in Spanish
  assert.deepEqual(await search('es', 'appearance'), []);
  assert.equal((await search('en', 'appearance'))[0], 'appearance');
});

test('at most twelve results, and a decision point found by its name', async () => {
  assert.ok((await search('en', 'a')).length <= MAX_SETTING_RESULTS);
  assert.ok((await search('en', 'supervisor')).includes('point-supervisor-intervene'));
});

test('a result opens its detail, or its anchor on the group screen', () => {
  const byId = (id: string) => SETTINGS_INDEX.find((entry) => entry.id === id)!;
  assert.equal(entryHref(byId('spend-cap.daily')), '/settings/runs#spend-cap');
  assert.equal(entryHref(byId('skills.list')), '/settings/extensions/skills');
  assert.equal(entryHref(byId('point-supervisor-intervene')), '/settings/decisions#point-supervisor-intervene');
});
