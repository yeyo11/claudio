// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { MemoryProposalTarget } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ApiRequestError } from '../src/api';
import i18n, { setLanguage } from '../src/i18n';
import { rulePaths } from '../src/pages/assistant/model';
import { isRuleNameTaken, RenameRule, TargetLine } from '../src/pages/home/memory/Proposals';

// Idea 15 of docs/plans/agent-run-improvements.md: a `rule` memory proposal says where it will be
// written and for which paths, and a rule file that is taken asks for another name.

const wrap = (children: ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>,
  );
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const rule = (paths: string[] | null, file: string | null = 'migrations.md'): MemoryProposalTarget => ({ kind: 'rule', file, section: null, paths });

for (const [lang, label, rename, taken] of [
  ['en', 'Rule', 'Approve with this name', '.claude/rules/migrations.md exists with other paths. Approve it under another name.'],
  ['es', 'Regla', 'Aprobar con este nombre', '.claude/rules/migrations.md ya existe con otras rutas. Apruébala con otro nombre.'],
] as const) {
  test(`${lang}: the target line reads "${label} · .claude/rules/<file> · <paths>" in mono`, async () => {
    setLanguage(lang);
    await i18n.changeLanguage(lang);
    const html = wrap(<TargetLine target={rule(['packages/core/src/db.ts', 'apps/**/*.tsx'])} />);
    assert.ok(text(html).endsWith(`${label} · .claude/rules/migrations.md · packages/core/src/db.ts, apps/**/*.tsx`), text(html));
    assert.match(html, /<span class="mono">/);
  });

  test(`${lang}: paths beyond three are folded into a count`, async () => {
    setLanguage(lang);
    await i18n.changeLanguage(lang);
    const words = text(wrap(<TargetLine target={rule(['a/**', 'b/**', 'c/**', 'd/**', 'e/**'])} />));
    assert.match(words, lang === 'en' ? /a\/\*\*, b\/\*\*, c\/\*\*, \+2 more$/ : /a\/\*\*, b\/\*\*, c\/\*\*, \+2 más$/);
    assert.doesNotMatch(words, /d\/\*\*/);
  });

  test(`${lang}: a taken rule file asks for another name, prefilled, and approves under it`, async () => {
    setLanguage(lang);
    await i18n.changeLanguage(lang);
    const html = wrap(<RenameRule proposal={{ id: 'm1', target: rule(['src/**']) }} name="migrations-2.md" onName={() => undefined} onCancel={() => undefined} onSubmit={() => undefined} />);
    assert.ok(text(html).includes(taken), text(html));
    assert.match(html, /role="alert"/);
    assert.match(html, /<input id="rename-m1" class="mono"[^>]*value="migrations-2\.md"/);
    assert.ok(text(html).includes(rename));
    assert.doesNotMatch(html, /disabled/);
    // An empty name cannot be approved
    assert.match(wrap(<RenameRule proposal={{ id: 'm1', target: rule(['src/**']) }} name="  " onName={() => undefined} onCancel={() => undefined} onSubmit={() => undefined} />), /<button type="submit"[^>]*disabled/);
  });
}

test('only the 409 a rule answers when its file has other paths turns into the rename', () => {
  const taken = new ApiRequestError('.claude/rules/migrations.md exists with other paths; approve it under another name', 409);
  assert.equal(isRuleNameTaken(taken, rule(['src/**'])), true);
  assert.equal(isRuleNameTaken(new ApiRequestError('the proposal was decided meanwhile', 409), rule(['src/**'])), false);
  assert.equal(isRuleNameTaken(new ApiRequestError('boom', 500), rule(['src/**'])), false);
  assert.equal(isRuleNameTaken(taken, { kind: 'instructions', file: null, section: null }), false);
  assert.equal(isRuleNameTaken(new Error('exists with other paths'), rule(['src/**'])), false);
});

test("a proposed rule's paths are read from its front matter, in each list form", () => {
  assert.deepEqual(rulePaths('---\npaths:\n  - "packages/core/src/db.ts"\n  - apps/**\n---\nText\n'), ['packages/core/src/db.ts', 'apps/**']);
  assert.deepEqual(rulePaths('---\npaths: [src/**, "test/**"]\n---\nText\n'), ['src/**', 'test/**']);
  assert.deepEqual(rulePaths('---\ndescription: Applies everywhere\n---\nText\n'), []);
  assert.deepEqual(rulePaths('no front matter'), []);
});
