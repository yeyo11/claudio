import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { toolRisk, type ToolRisk, type ToolRiskFactor } from '@claudio/shared';
import { riskFactorWords, riskReason, riskTagOf } from '../src/lib/tool-risk-tag';

const locale = (lang: string): { risk: { level: Record<string, string>; factor: Record<string, string>; reason: string } } =>
  JSON.parse(readFileSync(new URL(`../src/locales/${lang}/chat.json`, import.meta.url), 'utf8'));

/** A `t` over the real strings of one language, with `{{x}}` filled in */
const translator = (lang: string) => {
  const strings = locale(lang).risk;
  return (key: string, options: Record<string, string | number> = {}): string => {
    const path = key.replace(/^risk\./, '').split('.');
    let node: unknown = strings;
    for (const part of path) node = (node as Record<string, unknown>)[part];
    assert.equal(typeof node, 'string', `${lang} has ${key}`);
    return (node as string).replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(options[name]));
  };
};

const ctx = { cwd: '/work/app' };
const bash = (command: string) => toolRisk({ name: 'Bash', input: { command } }, ctx);

// One call per factor that is high on its own, and the word its tag shows
const HIGH: Array<[string, ToolRisk, ToolRiskFactor, string]> = [
  ['irreversible', bash('git reset --hard HEAD~3'), 'irreversible', 'Irreversible'],
  ['history-rewrite', bash('git push --force origin main'), 'history-rewrite', 'Rewrites history'],
  ['leaves-machine', bash('git push origin main'), 'leaves-machine', 'Leaves this machine'],
  ['privilege', bash('sudo systemctl restart nginx'), 'privilege', 'Privileged'],
  ['outside-workdir', toolRisk({ name: 'Write', input: { file_path: '/etc/hosts' } }, ctx), 'outside-workdir', 'Outside the working directory'],
];

for (const [name, risk, factor, word] of HIGH) {
  test(`a high ${name} call is a bad tag with the shield and its word`, () => {
    assert.equal(risk.level, 'high');
    const view = riskTagOf(risk);
    assert.deepEqual(view && [view.tone, view.shield, view.level, view.factor], ['bad', true, 'high', factor]);
    assert.equal(translator('en')(`risk.factor.${view?.factor}`), word);
  });
}

test('a medium call is a muted tag, without the shield', () => {
  const risk = toolRisk({ name: 'Edit', input: { file_path: '/work/app/.github/workflows/ci.yml' } }, ctx);
  assert.equal(risk.level, 'medium');
  const view = riskTagOf(risk);
  assert.deepEqual(view && [view.tone, view.shield, view.level], ['muted', false, 'medium']);
  assert.equal(translator('en')('risk.factor.sensitive-path'), 'Sensitive file');
});

test('a low call, and no call at all, draw nothing', () => {
  assert.equal(riskTagOf(bash('ls -la')), null);
  assert.equal(riskTagOf(toolRisk({ name: 'Read', input: { file_path: '/work/app/src/a.ts' } }, ctx)), null);
  assert.equal(riskTagOf(null), null);
  assert.equal(riskTagOf(undefined), null);
  assert.equal(riskReason(translator('en'), bash('ls')), '');
});

test('the reason says the level, then every factor that fired, heaviest first', () => {
  const risk = bash('sudo git push --force origin main');
  const t = translator('es');
  assert.equal(riskFactorWords(t, risk), risk.factors.map((f) => locale('es').risk.factor[f]).join(', '));
  assert.match(riskReason(t, risk), /^Riesgo alto: /);
  assert.match(riskReason(translator('en'), risk), /^High risk: .*Rewrites history/);
});

test('en and es have the same risk keys, and a word for every factor', () => {
  const en = locale('en').risk;
  const es = locale('es').risk;
  const keys = (o: Record<string, unknown>): string[] => Object.keys(o).sort();
  assert.deepEqual(keys(en), keys(es));
  assert.deepEqual(keys(en.factor), keys(es.factor));
  assert.deepEqual(keys(en.level), keys(es.level));
  const factors: ToolRiskFactor[] = ['irreversible', 'history-rewrite', 'leaves-machine', 'privilege', 'outside-workdir', 'secrets', 'sensitive-path', 'wide-scope'];
  for (const factor of factors) {
    assert.ok(en.factor[factor], `en ${factor}`);
    assert.ok(es.factor[factor], `es ${factor}`);
  }
});
