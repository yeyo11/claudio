// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sparkle } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ClaudioGlyph, ClaudioMascot } from '@claudio/ui/components/icons';
import type { NavItem } from '../src/components/shell/nav';

// Claudio's two marks (design system §4, "Claudio's marks"): the colour one where the assistant
// speaks, the one-colour glyph in icon slots.

const rootTag = (html: string) => html.match(/^<svg[^>]*>/)?.[0] ?? '';

test('ClaudioMascot is a still, hidden 24 px mark painted by classes, never by hex', () => {
  const html = renderToStaticMarkup(<ClaudioMascot />);
  const root = rootTag(html);
  assert.match(root, /class="mascot-mark"/);
  assert.match(root, /width="24" height="24" viewBox="0 0 24 24"/);
  assert.match(root, /aria-hidden="true"/);
  assert.match(root, /focusable="false"/);
  assert.equal(html.match(/class="mascot-body"/g)?.length, 1);
  assert.equal(html.match(/class="mascot-eye"/g)?.length, 2);
  assert.equal(html.match(/class="mascot-spark"/g)?.length, 1);
  assert.doesNotMatch(html, /#[0-9a-f]{3,6}\b|<style|animation/i);
  assert.match(renderToStaticMarkup(<ClaudioMascot size={32} />), /width="32" height="32"/);
});

test('ClaudioGlyph is one colour, honours size and className, and cuts its eyes out', () => {
  const html = renderToStaticMarkup(<ClaudioGlyph />);
  const root = rootTag(html);
  assert.match(root, /width="16" height="16" viewBox="0 0 16 16"/);
  assert.match(root, /fill="currentColor"/);
  assert.match(html, /fill-rule="evenodd"/);
  assert.doesNotMatch(html, /#[0-9a-f]{3,6}\b/i);
  const small = rootTag(renderToStaticMarkup(<ClaudioGlyph size={14} className="x" aria-hidden />));
  assert.match(small, /width="14" height="14"/);
  assert.match(small, /class="x"/);
  assert.match(small, /aria-hidden="true"/);
  // A filled character: the slot's stroke width does not reach the markup
  assert.doesNotMatch(rootTag(renderToStaticMarkup(<ClaudioGlyph strokeWidth={1.75} />)), /stroke-width/);
});

test('ClaudioGlyph takes the place of a LucideIcon in a nav item', () => {
  const item: NavItem = { to: '/assistant', label: 'Asistente', icon: ClaudioGlyph };
  const stroke: NavItem = { ...item, icon: Sparkle };
  assert.notEqual(item.icon, stroke.icon);
});
