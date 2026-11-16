import assert from 'node:assert/strict';
import test from 'node:test';
import { NATIVE_NOTICE, nativeQuitDialog, parseQuitAnswer, quitAction, quitPlan } from '../src/quit.ts';

// The quit question (D1 of docs/plans/survive-restarts.md): with work live it asks and keeps working
// by default; with nothing live, quitting stops the server as it always did.

const idle = { working: 0, waiting: 0, running: 0, terminals: 0 };

test('quitting with work live asks; with nothing live it stops; with no daemon there is nothing to do', () => {
  assert.equal(quitPlan({ ...idle, working: 1 }), 'ask');
  assert.equal(quitPlan({ ...idle, waiting: 2 }), 'ask');
  assert.equal(quitPlan({ ...idle, running: 1 }), 'ask');
  assert.equal(quitPlan({ ...idle, terminals: 1 }), 'ask');
  assert.equal(quitPlan(idle), 'stop-work');
  assert.equal(quitPlan(null), 'leave');
});

test('each answer maps to what the window does with the daemon; cancel keeps the app open', () => {
  assert.equal(quitAction('keep'), 'keep');
  assert.equal(quitAction('stop'), 'stop-work');
  assert.equal(quitAction('cancel'), null);
});

test("the page's answer is checked: anything unreadable cancels, which loses nothing", () => {
  assert.deepEqual(parseQuitAnswer({ answer: 'keep', notice: { title: 'Claudio sigue trabajando', body: 'El trabajo continúa.' } }), {
    answer: 'keep',
    notice: { title: 'Claudio sigue trabajando', body: 'El trabajo continúa.' },
  });
  assert.deepEqual(parseQuitAnswer({ answer: 'stop' }), { answer: 'stop', notice: null });
  assert.deepEqual(parseQuitAnswer({ answer: 'quit-everything' }), { answer: 'cancel', notice: null });
  assert.deepEqual(parseQuitAnswer(null), { answer: 'cancel', notice: null });
  assert.equal(parseQuitAnswer({ answer: 'keep', notice: { title: 'x'.repeat(301), body: 'b' } }).notice, null, 'an overlong notice is not shown');
});

test('the native fallback keeps working by default, and its escape is a cancel', () => {
  const dialog = nativeQuitDialog({ ...idle, working: 2, running: 1 });
  assert.equal(dialog.answers[dialog.defaultId], 'keep');
  assert.equal(dialog.answers[dialog.cancelId], 'cancel');
  assert.equal(dialog.buttons.length, dialog.answers.length);
  assert.match(dialog.detail, /2 working · 1 orchestration/);
  assert.ok(NATIVE_NOTICE.title.length > 0);
});
