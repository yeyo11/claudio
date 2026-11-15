import assert from 'node:assert/strict';
import test from 'node:test';
import { creditsNotice, creditsText, readNotices } from '@claudio/chat-ui/lib/chat-notice';

// Claude Code writes a few things into the transcript as `user` messages. Read wrong they show as
// the person speaking XML; read here they become the system's own line, and a real message that
// happens to carry one keeps its words.

test('a background task notification says how it ended and what it was', () => {
  const { prose, notices } = readNotices(
    '<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n<summary>Background command "Run the tests" completed (exit code 0)</summary>\n<output-file>/tmp/abc.output</output-file>\n</task-notification>',
  );
  assert.equal(prose, '');
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0], {
    kind: 'task',
    status: 'completed',
    detail: 'Background command "Run the tests" completed (exit code 0)',
    body: '/tmp/abc.output',
  });
});

test('a message keeps its own words and hands over the reminder stapled to it', () => {
  const { prose, notices } = readNotices('Ship it\n<system-reminder>\nThe user is typing\nand this is the rest\n</system-reminder>');
  assert.equal(prose, 'Ship it');
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.kind, 'reminder');
  assert.equal(notices[0]?.detail, 'The user is typing');
  assert.equal(notices[0]?.body, 'and this is the rest');
});

test('an interrupted turn is a notice of its own, not a line of the conversation', () => {
  const { prose, notices } = readNotices('[Request interrupted by user]');
  assert.equal(prose, '');
  assert.deepEqual(notices, [{ kind: 'interrupt', detail: 'Request interrupted by user', body: '' }]);
});

test('a slash command shows the command, with what it expanded to behind it', () => {
  const { prose, notices } = readNotices('<command-name>/review</command-name>\n<command-args>--fix</command-args>\n<command-message>review the diff</command-message>');
  assert.equal(prose, '');
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.kind, 'command');
  assert.equal(notices[0]?.detail, '/review --fix');
  assert.equal(notices[0]?.body, 'review the diff');
});

test('an ordinary message has nothing in it to read', () => {
  const { prose, notices } = readNotices('Fix the chat page, the keyboard covers the composer');
  assert.equal(prose, 'Fix the chat page, the keyboard covers the composer');
  assert.deepEqual(notices, []);
});

test("Claudio's own line for a turn on credits reads as paid, or as stopped before it paid, with the account's name", () => {
  const paid = readNotices(creditsText('work', false));
  assert.deepEqual([paid.prose, paid.notices], ['', [{ kind: 'credits', detail: 'work', body: '' }]]);
  const stopped = readNotices(creditsText('work', true));
  assert.deepEqual(stopped.notices, [{ kind: 'credits-stopped', detail: 'work', body: '' }]);
});

test('a notice of the server about credits names its account and whether the turn was stopped; any other notice is not one', () => {
  const at = { seq: 1, ts: '2026-11-15T00:00:00Z' };
  assert.deepEqual(creditsNotice({ ...at, kind: 'notice', text: 'x', data: { reason: 'credits', account: 'acc-1', stopped: 'never' } }), { account: 'acc-1', stopped: true });
  assert.deepEqual(creditsNotice({ ...at, kind: 'notice', text: 'x', data: { reason: 'credits', account: 'acc-1', usedMinor: 3 } }), { account: 'acc-1', stopped: false });
  assert.equal(creditsNotice({ ...at, kind: 'notice', text: 'x', data: { reason: 'person', account: 'acc-1' } }), null);
});
