import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContentBlock, Health, HealthSignal, TranscriptEntry } from '@claudio/shared';
import { cancellable, checklistProgress, describeCall, healthWord, lastEventAt, totalsOf } from '../src/lib/observe.ts';

const entry = (uuid: string, blocks: ContentBlock[], extra: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  uuid,
  role: 'assistant',
  timestamp: '2026-05-01T10:00:00.000Z',
  model: null,
  isSidechain: false,
  parentToolUseId: null,
  blocks,
  ...extra,
});
const call = (id: string, name: string, input: unknown): ContentBlock => ({ type: 'tool_use', id, name, input });
const result = (toolUseId: string): ContentBlock => ({ type: 'tool_result', toolUseId, content: 'ok', isError: false });

test('totals add the lines of every file', () => {
  const file = (additions: number, deletions: number) => ({ path: 'p', status: 'modified' as const, additions, deletions });
  assert.deepEqual(totalsOf([file(3, 1), file(10, 0)]), { additions: 13, deletions: 1 });
  assert.deepEqual(totalsOf([]), { additions: 0, deletions: 0 });
});

test('a call is described by what it acts on', () => {
  assert.equal(describeCall('Bash', { command: 'pnpm  test\n--filter x' }), 'pnpm test --filter x');
  assert.equal(describeCall('Edit', { file_path: '/a/b.ts', old_string: 'x' }), '/a/b.ts');
  assert.equal(describeCall('Grep', { pattern: 'TODO' }), 'TODO');
  assert.equal(describeCall('Mystery', { size: 3 }), 'Mystery');
  assert.equal(describeCall('Mystery', null), 'Mystery');
  assert.ok(describeCall('Bash', { command: 'x'.repeat(500) }).length <= 120);
});

test('the quiet time counts from the newest entry of the main agent', () => {
  const entries = [
    entry('1', [call('a', 'Read', { file_path: '/x.ts' })]),
    entry('2', [result('a')], { role: 'user', timestamp: '2026-05-01T10:00:05.000Z' }),
    entry('3', [call('s', 'Bash', { command: 'inner' })], { isSidechain: true, timestamp: '2026-05-01T10:00:20.000Z' }),
  ];
  assert.equal(lastEventAt(entries), '2026-05-01T10:00:05.000Z');
  assert.equal(lastEventAt([]), null);
});

const health = (level: Health['level'], kinds: HealthSignal['kind'][]): Pick<Health, 'level' | 'signals'> => ({
  level,
  signals: kinds.map((kind) => ({ kind, level: level === 'ok' ? 'warn' : level, reason: kind })),
});

test('a health verdict is named: ok, slow, stuck, or looping when it repeats itself', () => {
  assert.equal(healthWord(health('ok', [])), 'ok');
  assert.equal(healthWord(health('warn', ['silence'])), 'slow');
  assert.equal(healthWord(health('bad', ['hung-command'])), 'stuck');
  assert.equal(healthWord(health('bad', ['hung-command', 'repeat-stall'])), 'looping');
  assert.equal(healthWord(health('bad', ['loop'])), 'looping');
  // A warning that repeats is still only slow: looping asks for something a warning does not
  assert.equal(healthWord(health('warn', ['loop'])), 'slow');
});

test('only a command that is still running can be cancelled', () => {
  const signal = (kind: HealthSignal['kind'], toolUseId?: string): HealthSignal => ({ kind, level: 'bad', reason: 'r', ...(toolUseId ? { toolUseId } : {}) });
  assert.equal(cancellable(signal('hung-command', 'toolu_1')), true);
  assert.equal(cancellable(signal('repeat-stall', 'toolu_2')), true);
  assert.equal(cancellable(signal('hung-command')), false);
  // A weakened test names the edit that did it, and that call is long finished
  assert.equal(cancellable(signal('weakened-test', 'toolu_3')), false);
});

test('a checklist reports what is done and what is being worked on', () => {
  const progress = checklistProgress([
    { text: 'a', status: 'completed' },
    { text: 'b', status: 'in_progress' },
    { text: 'c', status: 'pending' },
  ]);
  assert.equal(progress.done, 1);
  assert.equal(progress.total, 3);
  assert.equal(progress.current?.text, 'b');
  assert.equal(checklistProgress([]).current, null);
});
