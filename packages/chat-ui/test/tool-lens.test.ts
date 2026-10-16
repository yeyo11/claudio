import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callHint } from '../src/lib/chat-steps';
import {
  agentInBackground,
  agentReport,
  capText,
  checklistOf,
  fieldsOf,
  langOfPath,
  lensOf,
  patchCounts,
  readResult,
  readSearch,
  readText,
  relativePath,
  RESULT_CAP_CHARS,
  searchOptions,
  toolHint,
  treeOf,
  TREE_ITEMS,
} from '../src/lib/tool-lens';

// What an opened tool call reads as (docs/plans/tool-rows-and-live-branches.md §3.2). The result
// texts below are the CLI's own, from the transcript lines in packages/shared/test/fixtures.

const CWD = '/home/user/claudio';

test('each tool of the CLI gets its own lens, and an MCP tool or an unknown one the generic lens', () => {
  const cases: Array<[string | null, string]> = [
    ['Bash', 'bash'],
    ['Read', 'read'],
    ['NotebookRead', 'read'],
    ['Edit', 'edit'],
    ['MultiEdit', 'edit'],
    ['Write', 'edit'],
    ['NotebookEdit', 'edit'],
    ['Grep', 'search'],
    ['Glob', 'search'],
    ['WebFetch', 'fetch'],
    ['WebSearch', 'websearch'],
    ['Agent', 'agent'],
    ['Task', 'agent'],
    ['TodoWrite', 'todo'],
    ['TaskUpdate', 'todo'],
    ['Skill', 'generic'],
    ['AskUserQuestion', 'generic'],
    ['mcp__pando__kb_search_documents', 'generic'],
    ['SomethingNew', 'generic'],
    [null, 'generic'],
  ];
  for (const [name, lens] of cases) assert.equal(lensOf(name), lens, String(name));
});

test("a Read's text loses the CLI's line-number prefixes and keeps the number its first line had", () => {
  const read = readText('1\tref: refs/heads/main\n2\t', { kind: 'file', path: '/x/.git/HEAD', startLine: 1, numLines: 2, totalLines: 2 }, {});
  assert.deepEqual(read, { lines: ['ref: refs/heads/main'], startLine: 1 });
  // Without a detail (an older transcript) the first prefix says where the read started
  const later = readText('    40\tconst a = 1;\n    41\t\tindented();', undefined, { offset: 40 });
  assert.deepEqual(later, { lines: ['const a = 1;', '\tindented();'], startLine: 40 });
  // The arrow the CLI wrote before 2.1
  assert.deepEqual(readText('  7→x\n  8→y', undefined, {}).lines, ['x', 'y']);
  // Text that is not numbered stays as it is
  assert.deepEqual(readText('no prefixes\n2 here', undefined, {}), { lines: ['no prefixes', '2 here'], startLine: 1 });
});

test('the folded line says what each tool was pointed at', () => {
  assert.deepEqual(toolHint('Bash', { command: 'pnpm test', description: 'Run the tests' }, CWD, callHint), { text: 'Run the tests' });
  const long = `echo ${'x'.repeat(200)}`;
  assert.equal(toolHint('Bash', { command: long }, CWD, callHint).text.length, 80);
  assert.deepEqual(toolHint('Read', { file_path: `${CWD}/packages/shared/src/normalize.ts`, offset: 1, limit: 40 }, CWD, callHint), { text: 'packages/shared/src/normalize.ts:1–40' });
  assert.deepEqual(toolHint('Read', { file_path: '/etc/hosts' }, CWD, callHint), { text: '/etc/hosts' });
  assert.deepEqual(toolHint('Grep', { pattern: 'parent_tool_use_id', path: `${CWD}/packages/core` }, CWD, callHint), { text: 'parent_tool_use_id', aside: 'packages/core' });
  assert.deepEqual(toolHint('WebFetch', { url: 'https://docs.claude.com/en/cli', prompt: 'flags' }, CWD, callHint), { text: 'docs.claude.com' });
  assert.deepEqual(toolHint('TodoWrite', { todos: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'completed' }] }, CWD, callHint), { text: '', items: 2 });
  assert.deepEqual(toolHint('TaskCreate', { subject: 'Write the tests' }, CWD, callHint), { text: 'Write the tests' });
  assert.deepEqual(toolHint('mcp__pando__kb_search_documents', { query: 'tool rows' }, CWD, callHint), { text: 'tool rows' });
});

test('a path inside the chat reads relative to it, one outside stays whole', () => {
  assert.equal(relativePath(`${CWD}/a/b.ts`, CWD), 'a/b.ts');
  assert.equal(relativePath(`${CWD}/a/b.ts`, `${CWD}/`), 'a/b.ts');
  assert.equal(relativePath('/home/user/claudio-other/b.ts', CWD), '/home/user/claudio-other/b.ts');
  assert.equal(relativePath('a/b.ts', null), 'a/b.ts');
});

test("a file's language is its extension", () => {
  assert.equal(langOfPath('packages/shared/src/normalize.ts'), 'ts');
  assert.equal(langOfPath('/x/README.MD'), 'md');
  assert.equal(langOfPath('/x/Makefile'), undefined);
  assert.equal(langOfPath('/x/.env'), undefined);
});

test("the generic lens lists a nested input's keys, two levels deep, then JSON", () => {
  const fields = fieldsOf({ query: 'how tool calls are rendered', limit: 8, strict: true, body: 'line one\nline two', filter: { tags: ['plan', 'chat'], deep: { a: { b: 1 } } } });
  assert.deepEqual(
    fields.map((f) => [f.key, f.value.kind]),
    [
      ['query', 'text'],
      ['limit', 'scalar'],
      ['strict', 'scalar'],
      ['body', 'block'],
      ['filter', 'tree'],
    ],
  );
  const filter = fields[4]!.value;
  assert.ok(filter.kind === 'tree');
  assert.deepEqual(filter.nodes, [
    { key: 'tags', size: '[2]', children: [
      { key: '0', leaf: 'plan', tone: 'text' },
      { key: '1', leaf: 'chat', tone: 'text' },
    ] },
    { key: 'deep', size: '{1}', children: [{ key: 'a', leaf: '{"b":1}', tone: 'text' }] },
  ]);
  assert.deepEqual(fieldsOf(null), []);
});

test('a long array lists its first keys and says how many it left out', () => {
  const nodes = treeOf(Array.from({ length: TREE_ITEMS + 7 }, (_, i) => i));
  assert.equal(nodes.length, TREE_ITEMS + 1);
  assert.deepEqual(nodes.at(-1), { more: 7 });
});

test('a result is read as a JSON tree, as Markdown or as plain text', () => {
  const json = readResult('{"count": 8, "results": [{"file_path": "plans/ui-redesign.md", "score": 0.0164}]}');
  assert.equal(json.kind, 'json');
  assert.ok(json.kind === 'json');
  assert.deepEqual(json.nodes[0], { key: 'count', leaf: '8', tone: 'scalar' });
  // A list of hits unfolds each hit's keys: an array's items are not a level of their own
  assert.deepEqual(json.nodes[1], {
    key: 'results',
    size: '[1]',
    children: [{ key: '0', size: '{2}', children: [
      { key: 'file_path', leaf: 'plans/ui-redesign.md', tone: 'text' },
      { key: 'score', leaf: '0.0164', tone: 'scalar' },
    ] }],
  });
  assert.equal(readResult('## Results\n\n- one\n- two').kind, 'markdown');
  assert.equal(readResult('Found these:\n\n1. a\n2. b').kind, 'markdown');
  assert.equal(readResult('```ts\nconst a = 1;\n```').kind, 'markdown');
  assert.equal(readResult('| a | b |\n|---|---|\n| 1 | 2 |').kind, 'markdown');
  assert.equal(readResult('key: value\nother: 2').kind, 'plain');
  assert.equal(readResult('{not json').kind, 'plain');
  // An MCP answer still in its content blocks reads as the text inside them
  assert.deepEqual(readResult('[{"type": "text", "text": "pong"}]'), { kind: 'plain', text: 'pong' });
});

test('a long text is cut at a line break under the cap, and says how many lines the whole has', () => {
  const text = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
  const cut = capText(text);
  assert.ok(cut.cut);
  assert.ok(cut.text.length <= RESULT_CAP_CHARS);
  assert.ok(!cut.text.endsWith('\n'));
  assert.equal(cut.lines, 2000);
  assert.deepEqual(capText('short'), { text: 'short', cut: false, lines: 1 });
});

test("Grep and Glob read in the mode they answered in, without the CLI's summary lines", () => {
  const files = readSearch('Grep', { pattern: 'x', output_mode: 'files_with_matches' }, `Found 2 files\n${CWD}/a.ts\n${CWD}/b.ts`, { kind: 'matches', mode: 'files', total: 2 }, CWD);
  assert.deepEqual(files, { mode: 'files', files: ['a.ts', 'b.ts'] });
  assert.deepEqual(readSearch('Glob', { pattern: '*.md' }, 'No files found', { kind: 'matches', mode: 'files', total: 0 }, CWD), { mode: 'files', files: [] });
  const count = readSearch('Grep', { pattern: 'x', output_mode: 'count' }, 'apps/api/src/openapi/routes.ts:36\n\nFound 36 total occurrences across 1 file.', { kind: 'matches', mode: 'count', total: 36 }, CWD);
  assert.deepEqual(count, { mode: 'count', total: 36, text: 'apps/api/src/openapi/routes.ts:36' });
  // Without a detail, the call's own output_mode says how to read it
  assert.equal(readSearch('Grep', { pattern: 'x', output_mode: 'content' }, 'a.ts:1:x', undefined, CWD).mode, 'content');
  assert.deepEqual(searchOptions({ pattern: 'x', path: '/p', glob: '*.ts', '-i': true, '-n': false, output_mode: 'files_with_matches' }), ['glob *.ts', '-i', 'output_mode files_with_matches']);
});

test('a planning tool reads as a checklist with each status as a word key', () => {
  assert.deepEqual(
    checklistOf('TodoWrite', { todos: [{ content: 'Read the plan', status: 'completed' }, { content: 'Write the lens', status: 'in_progress' }, { content: 'Test it', status: 'pending' }] }),
    [
      { text: 'Read the plan', status: 'completed' },
      { text: 'Write the lens', status: 'inProgress' },
      { text: 'Test it', status: 'pending' },
    ],
  );
  assert.deepEqual(checklistOf('TaskUpdate', { taskId: '3', subject: 'Ship', status: 'completed' }), [{ text: 'Ship', status: 'completed' }]);
  assert.deepEqual(checklistOf('TaskList', {}), []);
});

test("an agent's report drops the id line and the usage block the CLI appends for the model", () => {
  const text = 'The stream drops sidechain deltas.\n\nagentId: acba2d79f4c39afe2 (for resuming)\n<usage>total_tokens: 12</usage>';
  assert.equal(agentReport(text), 'The stream drops sidechain deltas.');
  assert.equal(agentReport('Just the report'), 'Just the report');
  assert.equal(agentInBackground({}, { kind: 'agent', agentId: 'a1', background: true, model: null }), true);
  assert.equal(agentInBackground({ run_in_background: true }, undefined), true);
  assert.equal(agentInBackground({}, undefined), false);
});

test('a patch counts its added and removed lines, not its headers', () => {
  assert.deepEqual(patchCounts('--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d\n'), { additions: 2, deletions: 1 });
});
