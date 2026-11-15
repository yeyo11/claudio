import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { RunEvent } from '@claudio/shared';
import { accountSwitchText, holdsGuardBlock, noRoomNotice, noRoomText, readGuardResult, readNotices, switchedAccount, switchedByRotation, switchedFrom } from '../src/lib/chat-notice';

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

test('the guard labels exist in both languages', () => {
  for (const lang of ['en', 'es']) {
    const notice = (JSON.parse(readFileSync(new URL(`../src/locales/${lang}/chat.json`, import.meta.url), 'utf8')) as { transcript: { notice: Record<string, string> } }).transcript.notice;
    assert.ok(notice.guard && notice.guardMissing, lang);
  }
});

test('a step whose call the guard blocked is held open, and one with an ordinary failure is not', () => {
  const call = (content: string, isError: boolean) => ({ kind: 'call', result: { content, isError } });
  assert.equal(holdsGuardBlock([{ kind: 'thinking' }, call('ok', false), call(RECORDED, true)]), true);
  assert.equal(holdsGuardBlock([call('Error: ENOENT: no such file or directory', true), { kind: 'call', result: null }]), false);
  // The text alone is not a block: the CLI marks the result as an error
  assert.equal(holdsGuardBlock([call(RECORDED, false)]), false);
});

const said = (data: Record<string, unknown>): RunEvent => ({ kind: 'notice', seq: 1, ts: '2026-11-15T10:00:00.000Z', text: 'said in English', data }) as unknown as RunEvent;

test("the rotation's own move at a limit is read as a switch, and its line says the rotation made it", () => {
  const moved = said({ reason: 'rotation', account: 'b', from: 'a', cause: 'limit' });
  assert.deepEqual([switchedAccount(moved), switchedFrom(moved), switchedByRotation(moved)], ['b', 'a', true]);
  const person = said({ reason: 'person', account: 'b', from: 'a' });
  assert.equal(switchedByRotation(person), false);
  assert.equal(switchedAccount(said({ reason: 'credits', account: 'b' })), null, 'a credits notice is not a switch');
  const [read] = readNotices(accountSwitchText('Beta', 'own', true)).notices;
  assert.deepEqual(read, { kind: 'account', detail: 'Beta', body: '', config: 'own', rotated: true });
  assert.equal(readNotices(accountSwitchText('Beta', 'own')).notices[0]?.rotated, undefined);
});

test('a project rule that left no account with room is read from the notice data and named by the project, never its id', () => {
  const rule = noRoomNotice(said({ reason: 'no-room', rule: { project: 'p-123', resetsAt: '2026-11-15T12:00:00.000Z', choices: ['wait', 'once'] } }));
  assert.deepEqual(rule, { project: 'p-123', resetsAt: '2026-11-15T12:00:00.000Z', choices: ['wait', 'once'] });
  assert.ok(rule);
  const [read] = readNotices(noRoomText('Shipcast', rule)).notices;
  assert.deepEqual(read, { kind: 'no-room', detail: 'Shipcast', body: '', until: '2026-11-15T12:00:00.000Z', once: true, loose: false });
  // Chats of no project have a rule of their own, said as such
  const loose = readNotices(noRoomText('ignored', { project: null, resetsAt: null, choices: ['wait'] })).notices[0];
  assert.deepEqual([loose?.detail, loose?.loose, loose?.once], ['', true, false]);
  assert.equal(noRoomNotice(said({ reason: 'person', account: 'b' })), null);
});

test('the no-room and rotation lines have words in both languages', () => {
  for (const lang of ['en', 'es']) {
    const chat = JSON.parse(readFileSync(new URL(`../src/locales/${lang}/chat.json`, import.meta.url), 'utf8')) as { transcript: { notice: Record<string, unknown> } };
    assert.ok(chat.transcript.notice['no-room'] && chat.transcript.notice.accountRotated && chat.transcript.notice.noRoom, lang);
  }
});
