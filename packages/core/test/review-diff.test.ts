import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileDiff } from '../src/git.ts';
import { CHUNK_BYTES, LIGHT_CHUNK_BYTES, MAX_CHUNKS, classify, collectReviewDiff, hunkRanges, pack } from '../src/review-diff.ts';

interface Repo {
  dir: string;
  git: (...args: string[]) => string;
  write: (path: string, content: string | Buffer) => void;
  commit: (message: string) => string;
}

function repo(): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'claudio-review-diff-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Someone');
  git('config', 'user.email', 'someone@example.com');
  const write = (path: string, content: string | Buffer) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  const commit = (message: string) => {
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD').trim();
  };
  return { dir, git, write, commit };
}

const lines = (n: number, prefix = 'line'): string => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';

/** A base commit holding `files`, then `change` applied and committed */
function span(files: Record<string, string | Buffer>, change: (r: Repo) => void): { r: Repo; base: string; head: string } {
  const r = repo();
  r.write('README.md', 'project\n');
  for (const [path, content] of Object.entries(files)) r.write(path, content);
  const base = r.commit('base');
  change(r);
  const head = r.commit('change');
  return { r, base, head };
}

const collect = (s: { r: Repo; base: string; head: string }, extra: Partial<Parameters<typeof collectReviewDiff>[0]> = {}) =>
  collectReviewDiff({ worktree: s.r.dir, base: s.base, head: s.head, ...extra });

test('a change that leaves the tree as it was has nothing to review', () => {
  const s = span({ 'a.ts': 'one\n' }, () => {});
  const d = collect(s);
  assert.deepEqual(d.files, []);
  assert.deepEqual(d.chunks, []);
  assert.deepEqual(d.empty, { reason: 'nothing to review' });
});

test('base equal to head passes as no change against the base', () => {
  const s = span({}, (r) => r.write('a.ts', 'x\n'));
  assert.deepEqual(collectReviewDiff({ worktree: s.r.dir, base: s.head, head: s.head }).empty, { reason: 'no change against the base' });
  // The same commit under two names is the same commit
  assert.deepEqual(collectReviewDiff({ worktree: s.r.dir, base: s.head, head: 'main' }).empty, { reason: 'no change against the base' });
});

test('a binary file added or modified is listed with an advisory note and sent to no one', () => {
  const s = span({ 'old.bin': Buffer.from([0, 1, 2, 3, 0, 5]) }, (r) => {
    r.write('old.bin', Buffer.from([0, 9, 2, 3, 0, 5, 7]));
    r.write('new.bin', Buffer.from([0, 0, 0, 1]));
  });
  const d = collect(s);
  assert.deepEqual(d.files.map((f) => [f.path, f.class]), [['new.bin', 'binary'], ['old.bin', 'binary']]);
  assert.deepEqual(d.notes.map((n) => [n.kind, n.path]), [['binary', 'new.bin'], ['binary', 'old.bin']]);
  assert.match(d.notes[0]?.message ?? '', /added/);
  assert.match(d.notes[1]?.message ?? '', /modified/);
  assert.deepEqual(d.chunks, []);
  assert.equal(d.empty?.reason, 'nothing to review');
});

test('a pure rename is listed without content; a rename with edits is reviewed under both names', () => {
  const s = span({ 'src/pure.ts': lines(30), 'src/edited.ts': lines(30, 'other') }, (r) => {
    r.git('mv', 'src/pure.ts', 'src/pure-moved.ts');
    r.git('mv', 'src/edited.ts', 'src/edited-moved.ts');
    r.write('src/edited-moved.ts', lines(30, 'other').replace('other 15', 'changed 15'));
  });
  const d = collect(s);
  const pure = d.files.find((f) => f.path === 'src/pure-moved.ts');
  assert.equal(pure?.class, 'renamed-pure');
  assert.equal(pure?.previousPath, 'src/pure.ts');
  const edited = d.files.find((f) => f.path === 'src/edited-moved.ts');
  assert.equal(edited?.class, 'reviewable');
  assert.equal(edited?.previousPath, 'src/edited.ts');
  const items = d.chunks.flatMap((c) => c.items);
  assert.deepEqual(items.map((i) => i.path), ['src/edited-moved.ts']);
  assert.match(items[0]?.text ?? '', /rename from src\/edited\.ts/);
  assert.match(items[0]?.text ?? '', /\+changed 15/);
});

test('a deleted file shows its first 200 lines and says how many more were removed', () => {
  const s = span({ 'gone.ts': lines(260) }, (r) => r.git('rm', '-q', 'gone.ts'));
  const d = collect(s);
  assert.equal(d.files[0]?.class, 'deleted');
  const text = d.chunks[0]?.items[0]?.text ?? '';
  assert.equal(text.split('\n').filter((l) => l.startsWith('-line')).length, 200);
  assert.match(text, /^-line 200$/m);
  assert.doesNotMatch(text, /^-line 201$/m);
  assert.match(text, /… 60 more lines removed/);
});

test('a submodule pointer is an advisory note with both short ids, never content', () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  // `git add -A` would drop a gitlink with no directory behind it, so these commits skip it
  const r = repo();
  r.write('README.md', 'project\n');
  const base = r.commit('base');
  const point = (sha: string) => {
    r.git('update-index', '--add', '--cacheinfo', `160000,${sha},vendor-sub`);
    r.git('commit', '-q', '-m', 'pointer');
    return r.git('rev-parse', 'HEAD').trim();
  };
  const first = point(a);
  const moved = point(b);
  const added = collectReviewDiff({ worktree: r.dir, base, head: first });
  assert.equal(added.files[0]?.class, 'submodule');
  assert.match(added.notes[0]?.message ?? '', /submodule moved from nothing to aaaaaaaa; its contents were not reviewed/);
  const second = collectReviewDiff({ worktree: r.dir, base: first, head: moved });
  assert.deepEqual(second.files[0]?.submodule, { from: 'aaaaaaaa', to: 'bbbbbbbb' });
  assert.match(second.notes[0]?.message ?? '', /moved from aaaaaaaa to bbbbbbbb/);
  assert.deepEqual(second.chunks, []);
});

test('lockfiles, build output, generated headers, the attribute and the graph exclusions are excluded with a reason', () => {
  const s = span({}, (r) => {
    r.write('pnpm-lock.yaml', 'lock\nmore\n');
    r.write('pkg/dist/out.js', 'x\n');
    r.write('pkg/gen.ts', '// @generated by tool\nconst a = 1;\n');
    r.write('pkg/api.ts', '// DO NOT EDIT\nconst a = 1;\n');
    r.write('pkg/attr.ts', 'const a = 1;\n');
    r.write('.gitattributes', 'pkg/attr.ts linguist-generated=true\n');
    r.write('docs/big.md', 'notes\n');
    r.write('pkg/real.ts', 'const real = 1;\n');
  });
  const d = collect(s, { exclude: ['docs/'] });
  const byPath = Object.fromEntries(d.files.map((f) => [f.path, f]));
  assert.equal(byPath['pnpm-lock.yaml']?.excludedBy, 'lockfile');
  assert.match(byPath['pkg/dist/out.js']?.excludedBy ?? '', /generated output/);
  assert.match(byPath['pkg/gen.ts']?.excludedBy ?? '', /generated file header/);
  assert.match(byPath['pkg/api.ts']?.excludedBy ?? '', /generated file header/);
  assert.match(byPath['pkg/attr.ts']?.excludedBy ?? '', /linguist-generated/);
  assert.match(byPath['docs/big.md']?.excludedBy ?? '', /excluded by the graph: docs\//);
  assert.equal(byPath['pkg/real.ts']?.class, 'reviewable');
  assert.deepEqual(d.chunks.flatMap((c) => c.items.map((i) => i.path)), ['.gitattributes', 'pkg/real.ts']);
  assert.ok(d.notes.some((n) => n.kind === 'lockfile' && /2 dependency lines changed in pnpm-lock\.yaml/.test(n.message)));
  assert.equal(d.skipped.filter((x) => x.kind === 'excluded').length, 6);
});

test('only excluded files changed passes with that reason, and a blocking hit from the scan keeps the round going', () => {
  const s = span({}, (r) => {
    r.write('yarn.lock', 'a\n');
    r.write('dist/x.js', 'secret\n');
  });
  const quiet = collect(s);
  assert.match(quiet.empty?.reason ?? '', /^only excluded files changed: dist\/x\.js, yarn\.lock$/);
  // The scan sees the added lines of excluded files too
  const seen: string[] = [];
  const loud = collect(s, {
    scan: (files) => {
      seen.push(...files.map((f) => `${f.path}:${f.class}:${f.added.map((a) => a.text).join('|')}`));
      return [{ blocking: true }];
    },
  });
  assert.deepEqual(seen, ['dist/x.js:excluded:secret', 'yarn.lock:excluded:a']);
  assert.equal(loud.empty, null);
  assert.equal(loud.hits.length, 1);
});

test('a source and its test share a chunk, packages stay together, and the chunks follow path order', () => {
  const s = span({}, (r) => {
    r.write('packages/b/src/x.ts', lines(3));
    r.write('packages/a/src/z.ts', lines(3));
    r.write('packages/b/test/x.test.ts', lines(3));
    r.write('packages/a/src/y.ts', lines(3));
    r.write('packages/b/src/x.spec.ts', lines(3));
  });
  const one = collect(s);
  assert.deepEqual(one.chunks.map((c) => c.items.map((i) => i.path)), [
    ['packages/a/src/y.ts', 'packages/a/src/z.ts', 'packages/b/src/x.ts', 'packages/b/src/x.spec.ts', 'packages/b/test/x.test.ts'],
  ]);
  // With room for two files, the source and its test go together and the file before them stands alone
  const hunk = (c: string) => `@@ -1 +1 @@\n${c.repeat(100)}\n`;
  const files = [
    { path: 'p/q/a.ts', header: 'h\n', hunks: [hunk('a')] },
    { path: 'p/q/b.ts', header: 'h\n', hunks: [hunk('b')] },
    { path: 'p/q/b.test.ts', header: 'h\n', hunks: [hunk('t')] },
  ];
  const packed = pack(files, 260).chunks.map((c) => c.items.map((i) => i.path));
  assert.deepEqual(packed, [['p/q/a.ts'], ['p/q/b.ts', 'p/q/b.test.ts']]);
});

test('a file larger than a chunk is split at hunk boundaries into parts', () => {
  const original = lines(400);
  const edited = original.split('\n').map((l, i) => (i % 100 === 50 ? `${l} CHANGED` : l)).join('\n');
  const s = span({ 'big.ts': original }, (r) => r.write('big.ts', edited));
  const d = collect(s, { chunkBytes: 700 });
  const parts = d.chunks.flatMap((c) => c.items);
  assert.ok(parts.length > 1, 'split into more than one part');
  assert.deepEqual(parts.map((p) => p.part), parts.map((_, i) => ({ index: i + 1, of: parts.length })));
  for (const p of parts) {
    assert.match(p.text, /^diff --git/);
    assert.ok(p.bytes <= 700);
  }
  // Each of the four changed lines appears once as removed and once as added
  assert.equal(parts.map((p) => p.text.match(/CHANGED/g)?.length ?? 0).reduce((a, b) => a + b, 0), 4);
  assert.equal(d.files[0]?.notReviewable, undefined);
});

test('one hunk over the chunk limit makes the file not reviewable and the round incomplete', () => {
  const s = span({ 'huge.ts': 'x\n' }, (r) => r.write('huge.ts', lines(200)));
  const d = collect(s, { chunkBytes: 500 });
  assert.equal(d.files[0]?.notReviewable, 'a single change is larger than a review chunk');
  assert.deepEqual(d.chunks, []);
  assert.deepEqual(d.skipped, [{ path: 'huge.ts', kind: 'not-reviewable', reason: 'a single change is larger than a review chunk' }]);
  assert.equal(d.stats.notReviewable, 1);
  assert.equal(d.empty, null);
});

test('past MAX_CHUNKS the files left are not reviewable', () => {
  assert.equal(MAX_CHUNKS, 8);
  const s = span({}, (r) => {
    for (let i = 0; i < 12; i++) r.write(`pkg${String(i).padStart(2, '0')}/a/f.ts`, lines(40, `file${i}`));
  });
  // One file per chunk: each is about 600 bytes and the limit leaves no room for a second
  const d = collect(s, { chunkBytes: 900 });
  assert.equal(d.chunks.length, MAX_CHUNKS);
  const dropped = d.files.filter((f) => f.notReviewable);
  assert.equal(dropped.length, 4);
  assert.ok(dropped.every((f) => f.notReviewable === "over the review's size budget"));
  assert.deepEqual(dropped.map((f) => f.path), ['pkg08/a/f.ts', 'pkg09/a/f.ts', 'pkg10/a/f.ts', 'pkg11/a/f.ts']);
});

test('light packs chunks twice as large', () => {
  assert.equal(LIGHT_CHUNK_BYTES, CHUNK_BYTES * 2);
  const s = span({}, (r) => {
    r.write('a/b/one.ts', lines(10));
    r.write('c/d/two.ts', lines(10));
  });
  const size = Math.max(...collect(s).chunks.flatMap((c) => c.items.map((i) => i.bytes)));
  // Room for one file at the full size, for both at twice that
  const limit = Math.floor(size * 1.5);
  assert.equal(collect(s, { chunkBytes: limit }).chunks.length, 2);
  assert.equal(collect(s, { chunkBytes: limit * 2 }).chunks.length, 1);
});

test('hunk ranges for anchors cover the old and the new side', () => {
  const original = lines(60);
  const edited = original.replace('line 10\n', 'ten\nten b\n').replace('line 50\n', '');
  const s = span({ 'a.ts': original }, (r) => r.write('a.ts', edited));
  const d = collect(s);
  assert.deepEqual(d.anchors['a.ts'], d.files[0]?.hunks);
  assert.deepEqual(d.anchors['a.ts'], { old: [{ start: 5, count: 11 }, { start: 45, count: 11 }], new: [{ start: 5, count: 12 }, { start: 46, count: 10 }] });
  assert.deepEqual(d.files[0]?.added.map((a) => [a.line, a.text]), [[10, 'ten'], [11, 'ten b']]);
  // A header without a count means one line
  assert.deepEqual(hunkRanges('@@ -3 +3,0 @@\n-x\n'), { old: [{ start: 3, count: 1 }], new: [{ start: 3, count: 0 }] });
});

test('classify gives submodule before binary and a rename of 100 as pure', () => {
  assert.equal(classify({ status: 'M', oldMode: '160000', newMode: '160000' }, true, false), 'submodule');
  assert.equal(classify({ status: 'R100', oldMode: '100644', newMode: '100644' }, false, false), 'renamed-pure');
  assert.equal(classify({ status: 'R087', oldMode: '100644', newMode: '100644' }, false, false), 'reviewable');
  assert.equal(classify({ status: 'D', oldMode: '100644', newMode: '000000' }, false, true), 'excluded');
});

test('paths with spaces and non-ASCII characters come out as written', () => {
  const s = span({}, (r) => {
    r.write('módulo núcleo/ñandú file.ts', 'const a = 1;\n');
    r.write('tab\tname.ts', 'const b = 2;\n');
  });
  const d = collect(s);
  assert.deepEqual(d.files.map((f) => f.path).sort(), ['módulo núcleo/ñandú file.ts', 'tab\tname.ts']);
  assert.equal(d.chunks.flatMap((c) => c.items).length, 2);
  assert.ok(d.files.every((f) => f.added.length === 1));
});

test('a repository that points a textconv driver at a script never runs it, in the review or in fileDiff', () => {
  const r = repo();
  const stamp = `${process.pid}-${Date.now()}`;
  const marker = join(r.dir, '..', `textconv-ran-${stamp}`);
  const script = join(r.dir, '..', `textconv-${stamp}.sh`);
  writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\ncat "$1"\n`, { mode: 0o755 });
  r.write('README.md', 'project\n');
  r.write('data.evil', 'one\n');
  r.write('.gitattributes', '*.evil diff=evil\n');
  r.git('config', 'diff.evil.textconv', script);
  r.git('config', 'diff.external', script);
  const base = r.commit('base');
  r.write('data.evil', 'two\n');
  const head = r.commit('change');
  const d = collectReviewDiff({ worktree: r.dir, base, head });
  assert.equal(d.files.find((f) => f.path === 'data.evil')?.class, 'reviewable');
  assert.match(d.chunks[0]?.items.find((i) => i.path === 'data.evil')?.text ?? '', /^\+two$/m);
  assert.match(fileDiff(r.dir, base, head, ['data.evil']), /^\+two$/m);
  assert.equal(existsSync(marker), false);
});
