import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { guardEventNotice, readGuardResult } from '../src/lib/chat-notice';

// What the CLI records for an exit-2 hook (g0 F5): its own prefix, the hook command, then our stderr
const RECORDED =
  'PreToolUse:Bash hook error: [/usr/bin/node /opt/claudio/guard.mjs --event pre-tool-use]: Claudio guard blocked this (push): git push is off in this run\n' +
  'claudio-guard/1 block toolu_01 push push.git-verb\n';

test('a guard block recorded in a tool_result is read into the rule and the reason', () => {
  const notice = readGuardResult(RECORDED, 'git push origin main');
  assert.deepEqual(notice, { kind: 'guard', rule: 'push', detail: 'git push origin main', body: 'git push is off in this run' });
});

test('an ordinary failure is not a guard notice', () => {
  assert.equal(readGuardResult('Error: ENOENT: no such file or directory', 'cat x'), null);
  assert.equal(readGuardResult('PreToolUse:Bash hook error: [/usr/bin/node hook.mjs]: PROBE-BLOCK-REASON: blocked by probe\n', 'echo'), null);
});

test('a live guard event gives the same strip, and a missing one the bad variant', () => {
  const base = { toolUseId: 'toolu_01', toolName: 'Bash', rule: 'secrets' as const, matcher: 'secrets.aws', reason: 'a key', excerpt: 'echo AKIA…' };
  assert.deepEqual(guardEventNotice({ ...base, outcome: 'blocked' }), { kind: 'guard', rule: 'secrets', detail: 'echo AKIA…', body: 'a key' });
  assert.equal(guardEventNotice({ ...base, outcome: 'missing' })?.missing, true);
  assert.equal(guardEventNotice({ ...base, outcome: 'observed' }), null);
});

test('the guard labels exist in both languages', () => {
  for (const lang of ['en', 'es']) {
    const notice = (JSON.parse(readFileSync(new URL(`../src/locales/${lang}/chat.json`, import.meta.url), 'utf8')) as { transcript: { notice: Record<string, string> } }).transcript.notice;
    assert.ok(notice.guard && notice.guardMissing, lang);
  }
});
