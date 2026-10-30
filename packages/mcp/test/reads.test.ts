import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { SUMMARY_CLIP_CHARS } from '../src/fields.ts';
import { seed, writeTranscript, type Seeded, type TranscriptLine } from './fixture.ts';

/*
 * The read tools' safe defaults and paging (report §4.2, §4.6, §4.8): a chat is a projection with a
 * page of its transcript, a list has a default size, a document is read a page of lines at a time,
 * the documents tree has a depth, and usage without dates is the server's today.
 */

let s: Seeded;
before(async () => {
  s = await seed();
});
after(() => s.close());

/** A turn that runs a command with a long output, as a real chat is mostly made of */
const turn = (i: number): TranscriptLine[] => [
  { role: 'user', content: `step ${i}` },
  { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 's' }, { type: 'tool_use', id: `tu-${i}`, name: 'Bash', input: { command: `echo ${'c'.repeat(900)}` } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-${i}`, content: `out ${i} ${'r'.repeat(3_000)}` }] },
  { role: 'assistant', content: [{ type: 'text', text: `done ${i}` }] },
];

interface ChatAnswer {
  id: string;
  executions: { total: number; last: unknown[] };
  children: Record<string, number>;
  permissions: unknown;
  transcript: { from: number; total: number; olderBefore?: number; entries: Array<{ i: number; role: string; blocks: Array<Record<string, unknown>> }> };
}

test('get_chat answers a projection with the last 10 entries, tool inputs and results cut, and pages back with before', async () => {
  writeTranscript(s.core, s.project.path, 'chat-page', Array.from({ length: 10 }, (_, i) => turn(i)).flat());
  const first = await s.call('get_chat', { chatId: 'chat-page' });
  assert.equal(first.isError, false, first.text);
  const chat = first.json as ChatAnswer;
  assert.equal(chat.id, 'chat-page');
  assert.deepEqual(Object.keys(chat.children).sort(), ['backgroundTasks', 'running', 'subagents', 'workflows']);
  assert.deepEqual(chat.permissions, []);
  assert.equal(chat.transcript.total, 40);
  assert.equal(chat.transcript.entries.length, 10);
  assert.deepEqual(chat.transcript.entries.map((e) => e.i), [30, 31, 32, 33, 34, 35, 36, 37, 38, 39]);
  assert.equal(chat.transcript.olderBefore, 30);
  const blocks = chat.transcript.entries.flatMap((e) => e.blocks);
  const result = blocks.find((b) => b.type === 'tool_result');
  assert.equal(String(result?.content).length, SUMMARY_CLIP_CHARS + 1, 'a tool result is cut at 500 characters');
  const call = blocks.find((b) => b.type === 'tool_use') as { input: { command: string } } | undefined;
  assert.equal(call?.input.command.length, SUMMARY_CLIP_CHARS + 1, "a tool's input keeps its shape, its strings cut");
  assert.equal(blocks.some((b) => b.type === 'thinking'), false, 'a summary drops thinking');
  // Not the chat's page: no environment, no list of every execution or child
  assert.equal('environment' in chat, false);

  const older = (await s.call('get_chat', { chatId: 'chat-page', before: chat.transcript.olderBefore, limit: 4 })).json as ChatAnswer;
  assert.deepEqual(older.transcript.entries.map((e) => e.i), [26, 27, 28, 29]);

  const full = (await s.call('get_chat', { chatId: 'chat-page', limit: 4, entries: 'full' })).json as ChatAnswer;
  const fullBlocks = full.transcript.entries.flatMap((e) => e.blocks);
  assert.ok(String(fullBlocks.find((b) => b.type === 'tool_result')?.content).length > 3_000, 'full keeps the result');
  assert.ok(fullBlocks.some((b) => b.type === 'thinking'), 'full keeps thinking');
});

test('list_chats asks for 25 chats when no limit is given', async () => {
  for (let i = 0; i < 30; i++) writeTranscript(s.core, s.project.path, `listed-${String(i).padStart(2, '0')}`, [{ role: 'user', content: `question ${i}` }]);
  const from = s.seen.length;
  const out = await s.call('list_chats', {});
  assert.equal(out.isError, false, out.text);
  assert.equal(new URL(s.seen[from]?.url ?? '').searchParams.get('limit'), '25');
  assert.equal((out.json as unknown[]).length, 25);
  assert.equal(((await s.call('list_chats', { limit: 3 })).json as unknown[]).length, 3);
});

test("get_usage without dates is the server's day, taken from GET /spend, never all of history", async () => {
  const day = ((await s.app.inject('/api/spend')).json() as { day: string }).day;
  const from = s.seen.length;
  const out = await s.call('get_usage', {});
  assert.equal(out.isError, false, out.text);
  assert.deepEqual([(out.json as { from: string }).from, (out.json as { to: string }).to], [day, day]);
  const asked = s.seen.slice(from).map((r) => new URL(r.url));
  for (const url of asked.filter((u) => u.pathname.startsWith('/api/usage'))) assert.deepEqual([url.searchParams.get('from'), url.searchParams.get('to')], [day, day]);
  // One bound given: the other is today
  const since = (await s.call('get_usage', { from: '2026-01-01' })).json as { from: string; to: string };
  assert.deepEqual([since.from, since.to], ['2026-01-01', day]);
});

test('read_document reads 200 lines at a time and says where the next page starts', async () => {
  const lines = Array.from({ length: 450 }, (_, i) => `line ${i + 1}`);
  writeFileSync(join(s.project.path, 'docs', 'long.md'), `# Long\n${lines.join('\n')}`);
  const page = (await s.call('read_document', { projectId: s.project.id, path: 'docs/long.md' })).json as { lines: { from: number; to: number; total: number }; content: string; nextOffset?: number };
  assert.deepEqual(page.lines, { from: 1, to: 200, total: 451 });
  assert.equal(page.nextOffset, 200);
  assert.equal(page.content.split('\n').length, 200);
  const last = (await s.call('read_document', { projectId: s.project.id, path: 'docs/long.md', offset: 400, limit: 100 })).json as { lines: { from: number; to: number }; content: string; nextOffset?: number };
  assert.deepEqual(last.lines, { from: 401, to: 451, total: 451 });
  assert.equal(last.nextOffset, undefined);
  assert.match(last.content, /^line 400\nline 401/);
});

test('list_documents lists two folder levels unless depth says otherwise, and marks what is below', async () => {
  mkdirSync(join(s.project.path, 'docs', 'a', 'b', 'c'), { recursive: true });
  writeFileSync(join(s.project.path, 'docs', 'a', 'b', 'c', 'deep.md'), '# Deep\n');
  type Node = { path: string; children?: Node[]; more?: boolean };
  const find = (nodes: Node[], path: string): Node | undefined => {
    for (const node of nodes) {
      if (node.path === path) return node;
      const inner = find(node.children ?? [], path);
      if (inner) return inner;
    }
    return undefined;
  };
  const shallow = (await s.call('list_documents', { projectId: s.project.id })).json as { tree: Node[] };
  const a = find(shallow.tree, 'docs/a');
  assert.ok(a, JSON.stringify(shallow.tree));
  assert.equal(find(shallow.tree, 'docs/a/b')?.more, true, 'the second level says there is more below it');
  assert.equal(find(shallow.tree, 'docs/a/b/c/deep.md'), undefined);
  const deep = (await s.call('list_documents', { projectId: s.project.id, depth: 16 })).json as { tree: Node[] };
  assert.ok(find(deep.tree, 'docs/a/b/c/deep.md'));
});
