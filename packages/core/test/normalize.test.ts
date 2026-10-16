import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { entrySearchText, entryText, normalizeMessage } from '@claudio/shared';

test('normalizes a stream-json assistant event', () => {
  const entry = normalizeMessage({
    type: 'assistant',
    uuid: 'u1',
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      model: 'claude-haiku',
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: 'hello' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      ],
    },
  });
  assert.ok(entry);
  assert.equal(entry.role, 'assistant');
  assert.equal(entry.model, 'claude-haiku');
  assert.equal(entry.isSidechain, false);
  assert.deepEqual(entry.blocks.map((b) => b.type), ['text', 'tool_use']); // empty thinking dropped
  assert.equal(entryText(entry), 'hello');
});

test('normalizes tool results, including array content and truncation', () => {
  const entry = normalizeMessage({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'out' }], is_error: true },
        { type: 'tool_result', tool_use_id: 't2', content: 'x'.repeat(30_000) },
      ],
    },
  });
  assert.ok(entry);
  const [first, second] = entry.blocks;
  assert.deepEqual(first, { type: 'tool_result', toolUseId: 't1', content: 'out', isError: true });
  assert.ok(second?.type === 'tool_result' && second.content.endsWith('[truncated]') && second.content.length < 21_000);
});

test('flags subagent messages and skips non-messages', () => {
  const side = normalizeMessage({ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { content: 'hi' } });
  assert.equal(side?.isSidechain, true);
  assert.equal(side?.parentToolUseId, 'toolu_1');
  assert.equal(normalizeMessage({ type: 'system', subtype: 'init' }), null);
  assert.equal(normalizeMessage({ type: 'user', isMeta: true, message: { content: 'x' } }), null);
  assert.equal(normalizeMessage({ type: 'user', message: { content: '' } }), null);
});

test("reads a slash command's output, which the CLI writes as a system line", () => {
  const content = '<local-command-stdout>## Context Usage\n\n**Tokens:** 11.8k</local-command-stdout>';
  const entry = normalizeMessage({ type: 'system', subtype: 'local_command', uuid: 'c1', timestamp: '2026-09-25T18:13:43.794Z', isSidechain: false, isMeta: false, content });
  assert.ok(entry);
  assert.equal(entry.role, 'user');
  assert.equal(entry.uuid, 'c1');
  assert.equal(entry.model, null);
  assert.equal(entryText(entry), content);
  assert.equal(normalizeMessage({ type: 'system', subtype: 'local_command', content: '' }), null);
  assert.equal(normalizeMessage({ type: 'system', subtype: 'local_command', isMeta: true, content }), null);
});

// Compaction (docs/plans/context-control.md): the recordings are Claude Code 2.1.300's own lines
const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const lines = (path: string) =>
  readFileSync(join(fixtures, path), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

const camel = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const camelKeys = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [camel(k), v]));

test('a boundary from stdout and the same boundary from the file give the same entry', () => {
  const stdout = lines('replay/compact-manual.jsonl').find((l) => l.subtype === 'compact_boundary');
  assert.ok(stdout);
  const { compact_metadata, ...rest } = stdout;
  const file = { ...rest, compactMetadata: camelKeys(compact_metadata as Record<string, unknown>), timestamp: '2026-10-16T03:17:15.731Z' };
  const a = normalizeMessage(stdout);
  const b = normalizeMessage(file);
  assert.ok(a && b);
  assert.deepEqual({ ...a, timestamp: null }, { ...b, timestamp: null });
  assert.equal(a.compaction?.part, 'boundary');
  assert.deepEqual(a.blocks, []);
  assert.equal(a.role, 'user');
  assert.equal(a.compaction?.trigger, 'manual');
  assert.equal(a.compaction?.preTokens, 18517);
  assert.equal(a.compaction?.postTokens, 1655);
  assert.equal(a.compaction?.durationMs, 7063);
});

test('a recorded file boundary keeps its numbers; a missing post_tokens stays null', () => {
  const boundaries = lines('recordings/claude/compacted.jsonl').filter((l) => l.subtype === 'compact_boundary');
  assert.ok(boundaries.length >= 2);
  for (const line of boundaries) {
    const entry = normalizeMessage(line);
    assert.ok(entry?.compaction);
    assert.equal(entry.uuid, line.uuid);
    assert.equal(typeof entry.compaction.preTokens, 'number');
  }
  const without = boundaries.find((l) => (l.compactMetadata as Record<string, unknown>).postTokens === undefined);
  if (without) assert.equal(normalizeMessage(without)?.compaction?.postTokens, null);
  assert.equal(normalizeMessage({ type: 'system', subtype: 'compact_boundary', uuid: 'b', compact_metadata: { trigger: 'auto', pre_tokens: 9 } })?.compaction?.postTokens, null);
  assert.equal(normalizeMessage({ type: 'system', subtype: 'compact_boundary', uuid: 'b' })?.compaction?.trigger, null);
});

test('a summary line is a summary entry, never a message the person typed', () => {
  const fromFile = lines('recordings/claude/compacted.jsonl').filter((l) => l.isCompactSummary === true);
  assert.ok(fromFile.length >= 2);
  for (const line of fromFile) {
    const entry = normalizeMessage(line);
    assert.equal(entry?.compaction?.part, 'summary');
    assert.equal(entry?.role, 'user');
    assert.ok(entryText(entry).startsWith('This session is being continued'));
  }
  // The stream sends it as a synthetic message without the flag (F11)
  const fromStream = lines('replay/compact-manual.jsonl').find((l) => l.type === 'user' && l.isSynthetic === true);
  assert.ok(fromStream);
  assert.equal(normalizeMessage(fromStream)?.compaction?.part, 'summary');
  // Hidden in the file only is no proof of anything
  const hidden = normalizeMessage({ type: 'user', uuid: 'h', isVisibleInTranscriptOnly: true, message: { content: 'hello' } });
  assert.equal(hidden?.compaction, undefined);
  const typed = normalizeMessage({ type: 'user', uuid: 't', message: { content: 'This session is being continued from a previous conversation, said the person' } });
  assert.equal(typed?.compaction, undefined);
});

test('isMeta lines are still skipped, boundary or not', () => {
  assert.equal(normalizeMessage({ type: 'user', isMeta: true, isCompactSummary: true, message: { content: 'x' } }), null);
});

test('a boundary has no search text and a summary has', () => {
  const boundary = normalizeMessage({ type: 'system', subtype: 'compact_boundary', uuid: 'b' });
  assert.ok(boundary);
  assert.equal(entrySearchText(boundary), '');
  const summary = normalizeMessage({ type: 'user', uuid: 's', isCompactSummary: true, message: { content: 'The summary mentions rhubarb' } });
  assert.ok(summary);
  assert.match(entrySearchText(summary), /rhubarb/);
});
