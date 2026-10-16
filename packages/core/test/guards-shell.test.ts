import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type ShellView, readShell } from '../src/guards/shell.ts';

const read = (text: string, cwd: string | null = '/work'): ShellView => readShell(text, { cwd, roots: ['/work'], maxDepth: 4, maxFilesRead: 8, maxScriptBytes: 1024 * 1024 });
const heads = (text: string): string[] => read(text).commands.map((c) => c.argv.map((w) => w.text).join(' '));

describe('guard shell reader', () => {
  it('removes quotes, backslashes and decodes ANSI-C strings', () => {
    assert.deepEqual(heads(`g''it "pu"sh \\x $'a\\x41b'`), ['git push x aAb']);
  });
  it('splits at every separator', () => {
    assert.deepEqual(heads('a; b && c || d | e & f\ng'), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });
  it('reads subshells, groups and control structures', () => {
    assert.deepEqual(heads('(a; b); { c; }; if x; then y; fi; for i in 1 2; do z; done'), ['a', 'b', 'c', 'x', 'y', 'z']);
  });
  it('reads here-docs, here-strings and redirects', () => {
    const view = read('cat >> out.txt 2>&1 <<-EOF\n\tbody\n\tEOF\ncat <<< hi &> all');
    const [first, second] = view.commands;
    assert.equal(first?.redirects.find((r) => r.op === '<<-')?.body, 'body');
    assert.deepEqual(first?.redirects.map((r) => r.op), ['>>', '>&', '<<-']);
    assert.equal(second?.redirects[0]?.body, 'hi');
    assert.equal(second?.redirects[1]?.op, '&>');
  });
  it('reads assignments, also after env', () => {
    const view = read('A=1 env B=2 git status');
    assert.deepEqual(view.commands[0]?.assigns.map((a) => a.name), ['A', 'B']);
  });
  it('follows substitutions and process substitutions', () => {
    const all = heads('echo $(git status) `git log` <(git diff)');
    for (const expected of ['git status', 'git log', 'git diff']) assert.ok(all.includes(expected), expected);
  });
  it('strips wrappers and follows shells, eval and clusters', () => {
    assert.deepEqual(heads('sudo -u me nice -n 5 timeout 30 git status'), ['git status']);
    assert.ok(heads("bash -lc 'git status'").includes('git status'));
    assert.ok(heads('eval git" "log').includes('git log'));
    assert.ok(heads("env -S 'git log -1'").includes('git log -1'));
  });
  it('marks xargs commands and flags find -exec', () => {
    const view = read('x | xargs -n 1 rm -rf; find . -exec rm {} ;');
    assert.equal(view.commands.find((c) => c.argv[0]?.text === 'rm' && c.xargs)?.xargs, true);
    assert.equal(view.commands.find((c) => c.findExec)?.argv[0]?.text, 'rm');
  });
  it('tracks cd, pushd, popd and subshell scope, and loses track on a dynamic cd', () => {
    const cwds = (text: string): (string | null)[] => read(text).commands.filter((c) => c.argv[0]?.text === 'x').map((c) => c.cwd);
    assert.deepEqual(cwds('cd a && x; (cd b; x); x; cd "$D"; x'), ['/work/a', '/work/a/b', '/work/a', null]);
    assert.deepEqual(cwds('pushd /tmp; x; popd; x'), ['/tmp', '/work']);
  });
  it('flags dynamic words', () => {
    const [cmd] = read('rm $A *.o {a,b} ~/x "$B" \'$C\'').commands;
    assert.deepEqual(cmd?.argv.slice(1).map((w) => w.dynamic), [true, true, true, true, true, false]);
  });
  it('fails on unbalanced quotes, an open here-doc and oversized lines', () => {
    assert.equal(read("echo 'x").error, 'unparseable');
    assert.equal(read('cat <<EOF\nx').error, 'unparseable');
    assert.equal(read(`echo ${'a'.repeat(300_000)}`).error, 'unparseable');
  });
  it('fails on more than ten thousand commands', () => {
    assert.equal(read('a;'.repeat(10_001)).error, 'unparseable');
  });
  it('stops at the depth limit', () => {
    let script = 'echo hi';
    for (let i = 0; i < 6; i++) script = `sh -c '${script.replace(/'/g, `'\\''`)}'`;
    assert.equal(read(script).error, 'too-deep');
    assert.equal(read("sh -c 'echo hi'").error, null);
  });
  it('treats a pipe into a shell with an unknown producer as opaque', () => {
    assert.deepEqual(read('curl x | sh').scans.map((s) => s.kind), ['opaque']);
    assert.ok(read("echo 'git push' | sh").commands.some((c) => c.argv[1]?.text === 'push'));
  });
});
