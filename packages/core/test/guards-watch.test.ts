import assert from 'node:assert/strict';
import test from 'node:test';
import type { DriverEvent } from '../src/providers/driver.ts';
import { GUARD_MARK, GuardWatch } from '../src/providers/claude-code/guard-watch.ts';

// Which tool results without a guard marker are faults (`guard-missing`) and which are the CLI's own
// answers to an interrupt. The excuse is per call (report §1.7 of
// docs/reports/regression-audit-2026-10-29.md): an interrupt that ended no turn leaves nothing behind
// that could hide a real `missing` later.

const SHA = 'a'.repeat(64);

function watch() {
  const events: DriverEvent[] = [];
  const guard = new GuardWatch((event) => events.push(event), SHA);
  const missing = () => events.filter((e) => e.kind === 'guard-missing').map((e) => (e.kind === 'guard-missing' ? e.guard.toolUseId : null));
  const pass = (id: string) => guard.hookResponse({ hook_event: 'PreToolUse', stderr: `${GUARD_MARK}pass ${id} integrity integrity.ok\n` });
  return { guard, missing, pass };
}

test('a result with no marker before it is missing', () => {
  const { guard, missing, pass } = watch();
  guard.toolUse('t1', 'Bash', { command: 'ls' });
  pass('t1');
  guard.toolResult('t1');
  guard.toolUse('t2', 'Bash', { command: 'ls' });
  guard.toolResult('t2');
  assert.deepEqual(missing(), ['t2']);
});

test('the calls awaited when an interrupt is asked for, and those shown while it is answered, are excused', () => {
  const { guard, missing } = watch();
  guard.toolUse('t1', 'Bash', { command: 'sleep 60' });
  guard.interrupting();
  // A call the model had already written streams after the request: the CLI answers it itself too
  guard.toolUse('t2', 'Read', { file_path: '/x' });
  guard.interruptAnswered();
  guard.toolResult('t1');
  guard.toolResult('t2');
  assert.deepEqual(missing(), []);
});

test('an interrupt that ended no turn hides nothing later: a call made after it is judged as any other', () => {
  const { guard, missing, pass } = watch();
  // Asked between turns, with nothing awaited: the CLI answers and no result follows
  guard.interrupting();
  guard.interruptAnswered();
  // The next real turn: one call passes, one runs without the guard
  guard.toolUse('t1', 'Bash', { command: 'ls' });
  pass('t1');
  guard.toolResult('t1');
  guard.toolUse('t2', 'Bash', { command: 'rm -rf build' });
  guard.toolResult('t2');
  assert.deepEqual(missing(), ['t2']);
});

test('an excused call that got its marker after all is forgotten, and its id excuses nothing later', () => {
  const { guard, missing, pass } = watch();
  guard.toolUse('t1', 'Bash', { command: 'ls' });
  guard.interrupting();
  guard.interruptAnswered();
  pass('t1');
  guard.toolResult('t1');
  assert.deepEqual(missing(), []);
});
