import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { normalizeMessage, splitCwdNotice, toolResultDetail, withoutStderrTail, type ContentBlock, type ToolResultDetail } from '../src/index.ts';

/** One real transcript line per kind of result, from CLI 2.1.286–2.1.300, with personal paths replaced */
const fixtures = new Map<string, Record<string, unknown>>(
  readFileSync(new URL('./fixtures/tool-use-results.jsonl', import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const { fixture, line } = JSON.parse(l) as { fixture: string; line: Record<string, unknown> };
      return [fixture, line];
    }),
);

function fixture(name: string): Record<string, unknown> {
  const line = fixtures.get(name);
  assert.ok(line, `fixture ${name}`);
  return line;
}

type ToolResult = Extract<ContentBlock, { type: 'tool_result' }>;

function resultOf(line: unknown): ToolResult {
  const entry = normalizeMessage(line);
  assert.ok(entry);
  const result = entry.blocks.find((b): b is ToolResult => b.type === 'tool_result');
  assert.ok(result);
  return result;
}

const detailOf = (name: string): ToolResultDetail | undefined => resultOf(fixture(name)).detail;

test('a Read keeps where the file starts and how long it is, not the file again', () => {
  assert.deepEqual(detailOf('read'), { kind: 'file', path: '/home/user/claude-wrapper/.git/HEAD', startLine: 1, numLines: 2, totalLines: 2 });
});

test('an Edit carries its hunks as unified text', () => {
  assert.deepEqual(detailOf('edit'), {
    kind: 'patch',
    path: '/home/user/trading-bot/docs/plans/repo-skeleton.md',
    patch:
      '@@ -1,6 +1,6 @@\n ---\n created_at: 2026-10-03T13:30:00Z\n-updated_at: 2026-10-03T13:30:00Z\n+updated_at: 2026-10-03T16:00:00Z\n tags:\n     - spec\n     - skeleton\n',
    created: false,
  });
});

test('a Write that created a file has no hunks: every line is added', () => {
  assert.deepEqual(detailOf('write-create'), { kind: 'patch', path: '/home/user/ai-video-generator/CLAUDE.md', patch: '@@ -0,0 +1,1 @@\n+@AGENTS.md\n', created: true });
});

test('a Write over a file carries its hunks', () => {
  const detail = detailOf('write-update');
  assert.equal(detail?.kind, 'patch');
  if (detail?.kind !== 'patch') return;
  assert.equal(detail.created, false);
  assert.match(detail.patch, /^@@ -1,10 \+1,10 @@\n \{\n- {2}"throughputMbPerSecond": 30,\n- {2}"rssGrowthMb": 40,\n\+ {2}"throughputMbPerSecond": 7,/);
});

test('a Bash result is its stdout: the detail says stderr, interruption and the background task', () => {
  assert.deepEqual(detailOf('bash'), { kind: 'command', stderr: '', cwdReset: null, interrupted: false, backgroundTaskId: null });
  assert.deepEqual(detailOf('bash-background'), { kind: 'command', stderr: '', cwdReset: null, interrupted: false, backgroundTaskId: 'by5dpofq6' });
});

test('the CLI\'s cwd notice leaves stderr and becomes cwdReset; other stderr stays', () => {
  const recorded = { stdout: '/tmp', stderr: '\nShell cwd was reset to /tmp/g0/b-state/work', interrupted: false };
  assert.deepEqual(toolResultDetail(recorded), { kind: 'command', stderr: '', cwdReset: '/tmp/g0/b-state/work', interrupted: false, backgroundTaskId: null });
  assert.deepEqual(splitCwdNotice('warn: x\nShell cwd was reset to /w'), { stderr: 'warn: x', cwdReset: '/w' });
  assert.deepEqual(splitCwdNotice('Shell is now elsewhere'), { stderr: 'Shell is now elsewhere', cwdReset: null });
  assert.equal(withoutStderrTail('/tmp\nShell cwd was reset to /w', ''), '/tmp');
  assert.equal(withoutStderrTail('out\nwarn: x\nShell cwd was reset to /w', 'warn: x'), 'out');
  assert.equal(withoutStderrTail('out\nunrelated', 'warn: x'), 'out\nunrelated');
});

test('a failed call has no detail: the CLI writes its error as a string and the block is an error', () => {
  const result = resultOf(fixture('bash-failed'));
  assert.equal(result.isError, true);
  assert.equal(result.detail, undefined);
  assert.equal(toolResultDetail('Error: Exit code 1'), null);
});

test('an error result gets no detail even when the CLI wrote an object beside it', () => {
  const line = structuredClone(fixture('bash'));
  const blocks = (line.message as { content: Record<string, unknown>[] }).content;
  blocks[0] = { ...blocks[0], is_error: true };
  assert.equal(resultOf(line).detail, undefined);
});

test('Grep in its three modes and Glob read as matches, counted the way each mode counts', () => {
  assert.deepEqual(detailOf('grep-files'), { kind: 'matches', mode: 'files', total: 0 });
  assert.deepEqual(detailOf('grep-content'), { kind: 'matches', mode: 'content', total: 0 });
  assert.deepEqual(detailOf('grep-count'), { kind: 'matches', mode: 'count', total: 36 });
  assert.deepEqual(detailOf('glob'), { kind: 'matches', mode: 'files', total: 0 });
  assert.deepEqual(toolResultDetail({ filenames: ['a.ts', 'b.ts'], durationMs: 3, truncated: false }), { kind: 'matches', mode: 'files', total: 2 });
});

test('a WebFetch keeps its status and size', () => {
  assert.deepEqual(detailOf('webfetch'), { kind: 'fetch', status: 404, bytes: 0 });
});

test('an Agent names the agent it ran, and says whether it went to the background', () => {
  assert.deepEqual(detailOf('agent-background'), { kind: 'agent', agentId: 'a30b043ff2a268f12', background: true, model: 'claude-sonnet-5-5' });
  assert.deepEqual(detailOf('agent-foreground'), { kind: 'agent', agentId: 'acba2d79f4c39afe2', background: false, model: 'claude-opus-5-5[1m]' });
});

test('any other object is data; an MCP server content array is the text itself', () => {
  assert.deepEqual(detailOf('skill'), { kind: 'data', value: { success: true, commandName: 'workflow-authoring' } });
  assert.equal(detailOf('mcp'), undefined);
});

test('data leaves out what the text already holds, and is dropped past its cap', () => {
  assert.deepEqual(toolResultDetail({ result: 'the answer', content: 'x', durationSeconds: 2 }), { kind: 'data', value: { durationSeconds: 2 } });
  assert.equal(toolResultDetail({ content: 'only the text' }), null);
  assert.deepEqual(toolResultDetail({ questions: ['q'.repeat(7_900)] })?.kind, 'data');
  assert.equal(toolResultDetail({ questions: ['q'.repeat(8_000)] }), null);
});

test('the stream spells it tool_use_result and is read the same', () => {
  const file = fixture('bash-background');
  const { toolUseResult, ...rest } = file;
  const streamed = { ...rest, session_id: 'sess', parent_tool_use_id: null, tool_use_result: toolUseResult };
  assert.deepEqual(resultOf(streamed).detail, detailOf('bash-background'));
});

test('a line with two results says nothing of whose the detail is', () => {
  const line = {
    type: 'user',
    uuid: 'u1',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'one' },
        { type: 'tool_result', tool_use_id: 'b', content: 'two' },
      ],
    },
    toolUseResult: { stdout: 'one', stderr: '', interrupted: false },
  };
  const entry = normalizeMessage(line);
  assert.ok(entry);
  for (const block of entry.blocks) assert.equal(block.type === 'tool_result' ? block.detail : undefined, undefined);
});

test('a huge patch keeps whole hunks under the cap, and a huge new file is cut at a line', () => {
  const hunk = (start: number) => ({ oldStart: start, oldLines: 1, newStart: start, newLines: 1, lines: [`-${'a'.repeat(6_000)}`, `+${'b'.repeat(6_000)}`] });
  const edit = toolResultDetail({ filePath: '/x', oldString: 'a', structuredPatch: [hunk(1), hunk(10), hunk(20)] });
  assert.equal(edit?.kind, 'patch');
  if (edit?.kind === 'patch') assert.equal(edit.patch.match(/^@@/gm)?.length, 1);
  const created = toolResultDetail({ type: 'create', filePath: '/y', content: `${'line\n'.repeat(5_000)}`, structuredPatch: [] });
  assert.equal(created?.kind, 'patch');
  if (created?.kind !== 'patch') return;
  const header = /^@@ -0,0 \+1,(\d+) @@\n/.exec(created.patch);
  assert.ok(header);
  assert.equal(created.patch.split('\n').filter((l) => l.startsWith('+')).length, Number(header[1]));
  assert.ok(Number(header[1]) < 5_000);
});
