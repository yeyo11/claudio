import assert from 'node:assert/strict';
import test from 'node:test';
import { decide } from '../src/guards/decide.ts';
import { DEFAULT_LIMITS, type GuardRuleId, type GuardRulesFile } from '../src/guards/input.ts';

// `integrity` is a rule like the others (D6 of docs/plans/regression-fixes-2026-10-29.md): the
// decision runs the rules the file names and no other, so a guard whose person switched integrity
// off neither refuses the lines it cannot read nor keeps writes off its own files.

const rulesFile = (rules: GuardRuleId[]): GuardRulesFile => ({
  version: 1,
  mode: 'enforce',
  rules,
  roots: ['/work'],
  mainCheckout: null,
  hooksPathDir: null,
  tmpDir: null,
  allowDir: null,
  dataDir: '/data/claudio',
  guardDir: '/opt/claudio/guards',
  claudeConfigDirs: [],
  protectConfigs: [],
  knownSecretSha256: [],
  limits: { ...DEFAULT_LIMITS },
});

const bash = (command: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: '/work' });

test('with integrity on, a line the reader cannot parse and a write to Claudio\'s own files are blocked', () => {
  const on = rulesFile(['integrity', 'push']);
  assert.deepEqual([decide(on, bash("echo 'unbalanced")).verdict, decide(on, bash("echo 'unbalanced")).rule], ['block', 'integrity']);
  assert.equal(decide(on, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/data/claudio/guards.json', content: '{}' }, cwd: '/work' }).verdict, 'block');
});

test('with integrity off, neither is blocked, and the rules that are on still are', () => {
  const off = rulesFile(['push']);
  assert.equal(decide(off, bash("echo 'unbalanced")).verdict, 'pass');
  assert.equal(decide(off, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/data/claudio/guards.json', content: '{}' }, cwd: '/work' }).verdict, 'pass');
  const pushed = decide(off, bash('git push origin main'));
  assert.deepEqual([pushed.verdict, pushed.rule], ['block', 'push']);
});

test('a declared policy arms its rule by being there, whatever the list says', () => {
  const declared: GuardRulesFile = { ...rulesFile([]), declared: { tools: ['Read'], alwaysAllow: [], allowPrefixes: [], root: '/work', attachments: [] } };
  assert.equal(decide(declared, bash('ls')).verdict, 'block');
});
