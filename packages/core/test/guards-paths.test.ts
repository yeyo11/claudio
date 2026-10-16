import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { expandBraces, isInside, matchesGlob, realResolve, resolveLexical, staticPrefix } from '../src/guards/paths.ts';

describe('guard paths', () => {
  let base: string;
  before(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'guards-paths-')));
    mkdirSync(join(base, 'root', 'real'), { recursive: true });
    symlinkSync(join(base, 'root', 'real'), join(base, 'root', 'link'));
    symlinkSync('/', join(base, 'root', 'escape'));
  });
  after(() => rmSync(base, { recursive: true, force: true }));

  it('folds dots and refuses relative paths from an unknown directory', () => {
    assert.equal(resolveLexical('../x/./y', '/a/b'), '/a/x/y');
    assert.equal(resolveLexical('x', null), null);
    assert.equal(resolveLexical('/a//b/', null), '/a/b');
  });
  it('resolves the longest existing prefix, through symlinks', () => {
    assert.equal(realResolve(join(base, 'root', 'link', 'new', 'f'), true), join(base, 'root', 'real', 'new', 'f'));
  });
  it('keeps a final symlink unless a trailing slash or follow asks', () => {
    assert.equal(realResolve(join(base, 'root', 'escape'), false), join(base, 'root', 'escape'));
    assert.equal(realResolve(join(base, 'root', 'escape'), true), '/');
    assert.equal(realResolve(join(base, 'out'), false, [[join(base, 'out'), '/']]), join(base, 'out'));
    assert.equal(realResolve(join(base, 'out'), true, [[join(base, 'out'), '/']]), '/');
  });
  it('tests containment on whole segments', () => {
    assert.ok(isInside('/a/b', '/a') && isInside('/a', '/a') && !isInside('/ab', '/a') && isInside('/x', '/'));
  });
  it('takes the static prefix of globs and expands literal braces', () => {
    assert.equal(staticPrefix('node_modules/*'), 'node_modules/');
    assert.deepEqual(expandBraces('a/{b,c}/d'), ['a/b/d', 'a/c/d']);
    assert.equal(expandBraces('a/{1..3}'), null);
  });
  it('matches config globs', () => {
    assert.ok(matchesGlob('sub/.eslintrc.json', '.eslintrc*'));
    assert.ok(matchesGlob('.github/workflows/ci.yml', '.github/workflows/**'));
    assert.ok(!matchesGlob('src/.github/workflows/ci.yml', '.github/workflows/**'));
    assert.ok(matchesGlob('.golangci.yaml', '.golangci.y*ml'));
  });
});
