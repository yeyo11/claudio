import assert from 'node:assert/strict';
import { test } from 'node:test';
import { repairTail } from '../src/lib/markdown-repair.ts';

test('closes bold, italic and inline code left open', () => {
  assert.equal(repairTail('**bold'), '**bold**');
  assert.equal(repairTail('a *b'), 'a *b*');
  assert.equal(repairTail('`code'), '`code`');
  assert.equal(repairTail('x **a** and *b'), 'x **a** and *b*');
  assert.equal(repairTail('_note here'), '_note here_');
});

test('shows only the text of a link or image that is not finished', () => {
  assert.equal(repairTail('see [docs](http'), 'see docs');
  assert.equal(repairTail('see [docs'), 'see docs');
  assert.equal(repairTail('look ![img'), 'look ');
  assert.equal(repairTail('look ![img](ur'), 'look ');
  assert.equal(repairTail('see [docs](http://x.dev)'), 'see [docs](http://x.dev)');
});

test('leaves what is not emphasis alone', () => {
  assert.equal(repairTail('- item'), '- item');
  assert.equal(repairTail('* item'), '* item');
  assert.equal(repairTail('snake_case word'), 'snake_case word');
  assert.equal(repairTail('a *b* and `c*d`'), 'a *b* and `c*d`');
  assert.equal(repairTail('**done** text'), '**done** text');
});

test('leaves an open code fence as it is', () => {
  const open = 'text\n```ts\nconst a = "**x";\nlet b = `c';
  assert.equal(repairTail(open), open);
  assert.equal(repairTail('~~~\n*a'), '~~~\n*a');
});

test('repairs again after a fence has closed', () => {
  assert.equal(repairTail('```\ncode\n```\nthen **bold'), '```\ncode\n```\nthen **bold**');
});
