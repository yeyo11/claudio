// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n';
import {
  desktopUnitErrorCode,
  refusalStatus,
  type DesktopUnitErrorCode,
} from '../src/lib/updates';
import type { DesktopUpdateReasonCode, DesktopUpdateStatus } from '@claudio/shared';
import { DesktopUnitView, UnitDialogBody, UnitDialogFooter, type DesktopUnitViewProps } from '../src/pages/config/UpdatesCard';

// The desktop app's update from any device (docs/plans/remote-updates.md, §4, D4): one state per
// `DesktopUpdateStatus`, a restart that is asked first, and every refusal in words from its code.

const status = (over: Partial<DesktopUpdateStatus> = {}): DesktopUpdateStatus => ({
  state: 'idle',
  installed: '0.14.2',
  running: '0.14.2',
  from: null,
  to: null,
  startedAt: null,
  endedAt: null,
  restartNeeded: false,
  ...over,
});

const noop = () => undefined;
const view = (over: Partial<DesktopUnitViewProps> = {}): DesktopUnitViewProps => ({
  status: status(),
  titled: true,
  primary: false,
  updateAvailable: false,
  releaseUrl: 'https://example.test/release',
  pending: false,
  failure: null,
  restartFailure: null,
  restartAsked: null,
  dialog: null,
  liveSentence: () => '2 chats are working',
  onUpdate: noop,
  onAskRestart: noop,
  onRestart: noop,
  onCloseDialog: noop,
  ...over,
});

async function render(over: Partial<DesktopUnitViewProps> = {}, language = 'en'): Promise<string> {
  await i18n.changeLanguage(language);
  return renderToStaticMarkup(<DesktopUnitView {...view(over)} />);
}
const words = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
const primaries = (html: string) => (html.match(/btn btn-primary/g) ?? []).length;
const buttons = (html: string) => (html.match(/<button/g) ?? []).length;

test.afterEach(() => i18n.changeLanguage('en'));

test('idle offers the update, as the primary only when a newer Claudio is out and the zone may have it', async () => {
  const html = await render();
  assert.match(words(html), /Desktop app/);
  assert.match(words(html), /Update the desktop app/);
  assert.equal(primaries(html), 0);
  // Nothing newer: even a free primary slot is not spent on it
  assert.equal(primaries(await render({ primary: true })), 0);
  assert.equal(primaries(await render({ updateAvailable: true })), 0);
  assert.equal(primaries(await render({ primary: true, updateAvailable: true })), 1);
});

test('up to date says so with a tag and offers no button beside it unless a newer Claudio is out', async () => {
  const done = status({ state: 'up-to-date', from: '0.14.2', to: '0.14.2' });
  const html = await render({ status: done });
  assert.match(html, /badge-ok/);
  assert.match(words(html), /Up to date/);
  assert.equal(buttons(html), 0);
  assert.match(words(await render({ status: done, updateAvailable: true })), /Update the desktop app/);
});

test('installed with nothing to restart is not a dead end: the next update starts from it', async () => {
  const html = await render({ status: status({ state: 'installed', from: '0.14.1', to: '0.14.2' }) });
  assert.match(words(html), /Update the desktop app/);
});

test('installing shows a live verb and no button', async () => {
  const html = await render({ status: status({ state: 'installing', startedAt: '2026-11-08T10:00:00Z' }) });
  assert.match(words(html), /Updating the desktop app…/);
  assert.match(html, /role="status"/);
  assert.equal(buttons(html), 0);
});

test('failed says why from the reason code and offers to try again', async () => {
  const expected = {
    'update.apt-locked': /Another package manager is running/,
    'update.apt-failed': /could not install the update/,
    'update.source-missing': /no longer has Claudio's package repository/,
    'update.start-limited': /Too many updates were started/,
    'update.unit-failed': /update service stopped before it could finish/,
  } as const;
  for (const [code, pattern] of Object.entries(expected)) {
    const html = await render({ status: status({ state: 'failed', reason: { code: code as DesktopUpdateReasonCode } }) });
    assert.match(words(html), pattern, code);
    assert.match(html, /alert-bad/);
    assert.match(html, /badge-bad/);
    assert.match(words(html), /Try again/);
    assert.doesNotMatch(words(html), /Update the desktop app/);
  }
  // A code this build does not know gets the generic sentence, never the server's text
  assert.match(words(await render({ status: status({ state: 'failed', reason: { code: 'update.something-new' as DesktopUpdateReasonCode } }) })), /could not be updated/);
});

test('needs-login explains the one log out and in, and offers no button that would be refused', async () => {
  const html = await render({ status: status({ state: 'needs-login' }) });
  assert.match(words(html), /Log out of the computer that runs Claudio and back in once/);
  assert.match(html, /alert-warn/);
  assert.equal(buttons(html), 0);
});

test('unavailable says how to get the unit and links the release', async () => {
  const html = await render({ status: status({ state: 'unavailable', reason: { code: 'update.unit-missing' } }) });
  assert.match(words(html), /no update service/);
  assert.match(words(html), /Install the newest desktop app package once/);
  assert.match(html, /href="https:\/\/example\.test\/release"/);
  // Information, not a warning: nothing is wrong, this install just has no unit
  assert.match(html, /alert-info/);
  assert.doesNotMatch(html, /alert-warn/);
  assert.equal(buttons(html), 0);
  // Without a release page, the sentence stands alone
  assert.doesNotMatch(await render({ status: status({ state: 'unavailable' }), releaseUrl: null }), /<a /);
});

test('"Up to date" is shown only while no newer Claudio exists', async () => {
  const upToDate = status({ state: 'up-to-date' });
  assert.match(words(await render({ status: upToDate, updateAvailable: false })), /Up to date/);
  const newer = await render({ status: upToDate, updateAvailable: true });
  assert.doesNotMatch(words(newer), /Up to date/);
  assert.match(words(newer), /Update the desktop app/);
});

test('installed with a restart needed names both versions and offers Restart as the primary action', async () => {
  const html = await render({ status: status({ state: 'installed', installed: '0.14.3', running: '0.14.2', restartNeeded: true }), primary: true });
  assert.match(words(html), /Desktop app 0\.14\.3 is installed, and Claudio still runs 0\.14\.2/);
  assert.match(words(html), /Restart pending/);
  assert.match(html, /badge-idle/);
  assert.match(words(html), /Restart/);
  assert.equal(primaries(html), 1);
  // The update button gives way: the restart is the one next step
  assert.doesNotMatch(words(html), /Update the desktop app/);
});

test('Restart gives the card’s primary to the Claudio zone when that has an action of its own', async () => {
  const html = await render({ status: status({ state: 'installed', installed: '0.14.3', running: '0.14.2', restartNeeded: true }), primary: false });
  assert.equal(primaries(html), 0);
  assert.match(words(html), /Restart/);
});

test('a package that apt upgraded while idle also asks for the restart', async () => {
  const html = await render({ status: status({ state: 'idle', installed: '0.14.3', running: '0.14.2', restartNeeded: true }), primary: true });
  assert.equal(primaries(html), 1);
  assert.doesNotMatch(words(html), /Update the desktop app/);
});

test('a restart asked now shows progress and takes the button away; when idle says it waits', async () => {
  const needed = status({ state: 'installed', installed: '0.14.3', running: '0.14.2', restartNeeded: true });
  const now = await render({ status: needed, restartAsked: 'now' });
  assert.match(words(now), /Restarting Claudio…/);
  assert.equal(buttons(now), 0);
  const idle = await render({ status: needed, restartAsked: 'when-idle' });
  assert.match(words(idle), /Claudio restarts when nothing is running/);
  assert.equal(buttons(idle), 0);
});

test('a start refused for the login, or for a package manager at work, is worded from its code', async () => {
  const cases: Array<[string, RegExp]> = [
    ['update.needs-login', /permission applies from your next login/],
    ['update.unit-missing', /no update service/],
    ['update.busy', /already running/],
  ];
  for (const [code, pattern] of cases) {
    const html = await render({ failure: { status: 409, code } });
    assert.match(words(html), pattern, code);
    assert.doesNotMatch(words(html), /Error/);
  }
  assert.match(words(await render({ failure: new Error('boom') })), /could not be updated/);
});

test('a restart the server cannot do says whether no desktop shell runs it or it just failed', async () => {
  assert.match(words(await render({ restartFailure: { status: 412, code: 'update.no-shell' } })), /not run by the desktop app/);
  assert.match(words(await render({ restartFailure: { status: 500 } })), /could not be restarted/);
});

test('the confirmation asks first and restarts at once; with live work it only offers to wait', async () => {
  await i18n.changeLanguage('en');
  const confirm = renderToStaticMarkup(
    <>
      <UnitDialogBody live={null} installed="0.14.3" liveSentence={() => ''} />
      <UnitDialogFooter live={null} pending={false} onCancel={noop} onRestart={noop} />
    </>,
  );
  assert.match(words(confirm), /restarts on the computer that runs it to start desktop app 0\.14\.3/);
  assert.match(words(confirm), /Cancel/);
  assert.equal(primaries(confirm), 1);
  assert.doesNotMatch(words(confirm), /now/i);

  const busy = renderToStaticMarkup(
    <>
      <UnitDialogBody live={{ working: 2, waiting: 0, running: 0, terminals: 0 }} installed="0.14.3" liveSentence={() => '2 chats are working'} />
      <UnitDialogFooter live={{ working: 2, waiting: 0, running: 0, terminals: 0 }} pending={false} onCancel={noop} onRestart={noop} />
    </>,
  );
  assert.match(words(busy), /2 chats are working, and a restart now would stop them\. Claudio can restart once nothing is running/);
  assert.match(words(busy), /Restart when nothing is running/);
  assert.equal(primaries(busy), 1);
});

test('the Spanish card says the same things', async () => {
  const restart = await render({ status: status({ state: 'installed', installed: '0.14.3', running: '0.14.2', restartNeeded: true }) }, 'es');
  assert.match(words(restart), /Reinicio pendiente/);
  assert.match(words(restart), /Reiniciar/);
  const login = await render({ status: status({ state: 'needs-login' }) }, 'es');
  assert.match(words(login), /vuelve a iniciarla una vez/);
  const failed = await render({ status: status({ state: 'failed', reason: { code: 'update.apt-locked' } }) }, 'es');
  assert.match(words(failed), /Otro gestor de paquetes/);
  assert.match(words(failed), /Reintentar/);
  const limited = await render({ status: status({ state: 'failed', reason: { code: 'update.start-limited' } }) }, 'es');
  assert.match(words(limited), /demasiadas actualizaciones/);
});

test('every reason code the contract declares has its own words, except start-failed, which is the generic one', () => {
  // A Record over the shared union: a code added to the contract fails to compile here until it is listed
  const declared: Record<DesktopUpdateReasonCode, DesktopUnitErrorCode | null> = {
    'update.unit-missing': 'unit-missing',
    'update.needs-login': 'needs-login',
    'update.apt-locked': 'apt-locked',
    'update.apt-failed': 'apt-failed',
    'update.source-missing': 'source-missing',
    'update.start-limited': 'start-limited',
    'update.unit-failed': 'unit-failed',
    'update.start-failed': null,
  };
  for (const [code, known] of Object.entries(declared)) assert.equal(desktopUnitErrorCode(code), known, code);
});

test('codes are read with or without their prefix, and an unknown one is null', () => {
  assert.equal(desktopUnitErrorCode('update.needs-login'), 'needs-login');
  assert.equal(desktopUnitErrorCode({ code: 'apt-locked' }), 'apt-locked');
  assert.equal(desktopUnitErrorCode({ code: 'update.nope' }), null);
  assert.equal(desktopUnitErrorCode(new Error('x')), null);
  assert.equal(refusalStatus({ status: 412 }), 412);
  assert.equal(refusalStatus(new Error('x')), null);
});
