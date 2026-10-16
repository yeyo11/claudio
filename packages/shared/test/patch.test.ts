import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addedDiff, unifiedOf } from '../src/patch.ts';

test('a structured patch becomes unified hunks, and a created file an all-added diff', () => {
  assert.equal(
    unifiedOf([{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' a', '-b', '+c', '+d'] }, { oldStart: 9, oldLines: 0, newStart: 10, newLines: 1, lines: ['+z'] }]),
    '@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d\n@@ -9,0 +10,1 @@\n+z\n',
  );
  assert.equal(addedDiff('one\ntwo\n'), '@@ -0,0 +1,2 @@\n+one\n+two\n');
  assert.equal(addedDiff('last'), '@@ -0,0 +1,1 @@\n+last\n\\ No newline at end of file\n');
  assert.equal(addedDiff(''), '');
});
