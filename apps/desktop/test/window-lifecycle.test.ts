import assert from 'node:assert/strict';
import test from 'node:test';
import { OPEN_PATH_SWITCH, openPathFromArgv, relaunchArgs, reopenPlan } from '../src/window-lifecycle.ts';

// Closing the window keeps the process for the tray; a second main window in that process rendered
// garbage on Wayland (docs/reports/desktop-reopen-garbled.md), so a reopen starts a fresh process.

test('a reopen raises the open window, opens the first one, and relaunches once the window was closed', () => {
  assert.equal(reopenPlan({ hasWindow: true, windowsCreated: 1, leaving: false }), 'focus');
  assert.equal(reopenPlan({ hasWindow: false, windowsCreated: 0, leaving: false }), 'create');
  assert.equal(reopenPlan({ hasWindow: false, windowsCreated: 1, leaving: false }), 'relaunch');
  assert.equal(reopenPlan({ hasWindow: false, windowsCreated: 3, leaving: false }), 'relaunch');
});

test('a closed window never comes back in the same process, however often it is asked', () => {
  for (let created = 1; created < 5; created += 1) {
    assert.notEqual(reopenPlan({ hasWindow: false, windowsCreated: created, leaving: false }), 'create');
  }
});

test('nothing opens while the app is quitting, updating or already relaunching; an open window is still raised', () => {
  assert.equal(reopenPlan({ hasWindow: false, windowsCreated: 1, leaving: true }), 'none');
  assert.equal(reopenPlan({ hasWindow: false, windowsCreated: 0, leaving: true }), 'none');
  assert.equal(reopenPlan({ hasWindow: true, windowsCreated: 1, leaving: true }), 'focus');
});

test('the relaunched process keeps its arguments and carries the page to open, once', () => {
  assert.deepEqual(relaunchArgs(['.', '--dev'], null), ['.', '--dev']);
  assert.deepEqual(relaunchArgs(['.', '--dev'], '/chats/abc'), ['.', '--dev', `${OPEN_PATH_SWITCH}/chats/abc`]);
  // A process that was itself relaunched for a page does not pass the old page on
  assert.deepEqual(relaunchArgs([`${OPEN_PATH_SWITCH}/chats/old`], '/orchestrations'), [`${OPEN_PATH_SWITCH}/orchestrations`]);
  assert.deepEqual(relaunchArgs([`${OPEN_PATH_SWITCH}/chats/old`], null), []);
});

test('only an in-app path travels to the relaunched process', () => {
  assert.deepEqual(relaunchArgs([], '//evil.example/x'), []);
  assert.deepEqual(relaunchArgs([], 'https://evil.example/'), []);
  assert.equal(openPathFromArgv(['/opt/Claudio/claudio', `${OPEN_PATH_SWITCH}/settings/general#updates`]), '/settings/general#updates');
  assert.equal(openPathFromArgv(['/opt/Claudio/claudio', `${OPEN_PATH_SWITCH}//evil.example`]), null);
  assert.equal(openPathFromArgv(['/opt/Claudio/claudio', `${OPEN_PATH_SWITCH}javascript:alert(1)`]), null);
  assert.equal(openPathFromArgv(['/opt/Claudio/claudio']), null);
});
