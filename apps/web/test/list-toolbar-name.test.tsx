// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ListToolbar } from '@claudio/ui/components/ListToolbar';
import i18n from '../src/i18n';

// WCAG 2.5.3 (axe label-content-name-mismatch): the filters button's name must contain the words it
// shows. Its visible text is "Filters" and the count; with nothing between them they read as one
// word, "Filters1", which "Filters, 1 active" does not contain.
const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

for (const lng of ['en', 'es']) {
  test(`the filters button's name contains its visible words with a filter in force (${lng})`, async () => {
    await i18n.changeLanguage(lng);
    const html = renderToStaticMarkup(
      <ListToolbar search={{ value: '', onChange: () => {} }} filters={{ count: 1, children: null }} />,
    );
    const button = html.match(/<button[^>]*class="[^"]*list-toolbar-filters[^"]*"[^>]*>([\s\S]*?)<\/button>/);
    assert.ok(button, 'the filters button renders');
    const name = /aria-label="([^"]*)"/.exec(button[0])?.[1] ?? '';
    const visible = words(button[1]!.replace(/<[^>]+>/g, ''));
    assert.ok(visible.includes(' '), `"${visible}" keeps the label and the count apart`);
    assert.ok(words(name).includes(visible), `"${name}" contains "${visible}"`);
  });
}

test('a filter chip draws its content but is still named by its label', () => {
  const html = renderToStaticMarkup(
    <ListToolbar
      search={{ value: '', onChange: () => {} }}
      chips={[{ id: 'models', label: 'Model: claude-opus-5', content: <span className="mono">claude-opus-5</span>, onRemove: () => {} }]}
    />,
  );
  const chip = html.match(/<button[^>]*class="[^"]*filter-chip[^"]*"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(chip, 'the chip renders');
  assert.ok(/aria-label="[^"]*Model: claude-opus-5/.test(chip[0]), 'the accessible name carries the label');
  assert.ok(chip[1]!.includes('<span class="mono">claude-opus-5</span>'), 'the visible text is the content, with the id in mono');
});
