// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n';
import {
  desktopUnitErrorCode,
  desktopUnitRefetchMs,
  refusalStatus,
  type DesktopUnitStatus,
} from '../src/lib/updates';
import { DesktopUnitView, UnitDialogBody, UnitDialogFooter, type DesktopUnitViewProps } from '../src/pages/config/UpdatesCard';

// The desktop app's update from any device (docs/plans/remote-updates.md, §4, D4): one state per
// `DesktopUpdateStatus`, a restart that is asked first, and every refusal in words from its code.

const status = (over: Partial<DesktopUnitStatus> = {}): DesktopUnitStatus => ({
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

test('idle offers the update, quietly unless the card has no other primary', async () => {
  const html = await render();
  assert.match(words(html), /Desktop app/);
  assert.match(words(html), /Update the desktop app/);
  assert.equal(primaries(html), 0);
  assert.equal(primaries(await render({ primary: true })), 1);
});

test('up to date says so with a tag and still lets the person check again', async () => {
  const html = await render({ status: status({ state: 'up-to-date', from: '0.14.2', to: '0.14.2' }) });
  assert.match(html, /badge-ok/);
  assert.match(words(html), /Up to date/);
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
  } as const;
  for (const [code, pattern] of Object.entries(expected)) {
    const html = await render({ status: status({ state: 'failed', reason: { code } }) });
    assert.match(words(html), pattern, code);
    assert.match(html, /alert-bad/);
    assert.match(html, /badge-bad/);
    assert.match(words(html), /Try again/);
    assert.doesNotMatch(words(html), /Update the desktop app/);
  }
  // A code this build does not know gets the generic sentence, never the server's text
  assert.match(words(await render({ status: status({ state: 'failed', reason: { code: 'update.something-new' } }) })), /could not be updated/);
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
  assert.equal(buttons(html), 0);
  // Without a release page, the sentence stands alone
  assert.doesNotMatch(await render({ status: status({ state: 'unavailable' }), releaseUrl: null }), /<a /);
});

test('installed with a restart needed names both versions and offers Restart as the primary action', async () => {
  const html = await render({ status: status({ state: 'installed', installed: '0.14.3', running: '0.14.2', restartNeeded: true }) });
  assert.match(words(html), /Desktop app 0\.14\.3 is installed, and Claudio still runs 0\.14\.2/);
  assert.match(words(html), /Restart pending/);
  assert.match(html, /badge-idle/);
  assert.match(words(html), /Restart/);
  assert.equal(primaries(html), 1);
  // The update button gives way: the restart is the one next step
  assert.doesNotMatch(words(html), /Update the desktop app/);
});

test('a package that apt upgraded while idle also asks for the restart', async () => {
  const html = await render({ status: status({ state: 'idle', installed: '0.14.3', running: '0.14.2', restartNeeded: true }) });
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
  assert.match(words(busy), /2 chats are working\. Restarting now stops them/);
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
});

test('the card reads the status again soon only while something is under way', () => {
  const idle = { state: 'idle' as const, restartNeeded: false };
  assert.equal(desktopUnitRefetchMs(undefined, null), false);
  assert.equal(desktopUnitRefetchMs(idle, null), false);
  assert.equal(desktopUnitRefetchMs({ state: 'installing', restartNeeded: false }, null), 2000);
  assert.equal(desktopUnitRefetchMs({ state: 'installed', restartNeeded: true }, 'now'), 2000);
  assert.equal(desktopUnitRefetchMs({ state: 'installed', restartNeeded: true }, 'when-idle'), 5000);
  // Once the new process answers, a scheduled restart needs no more polling
  assert.equal(desktopUnitRefetchMs(idle, 'when-idle'), false);
});

test('codes are read with or without their prefix, and an unknown one is null', () => {
  assert.equal(desktopUnitErrorCode('update.needs-login'), 'needs-login');
  assert.equal(desktopUnitErrorCode({ code: 'apt-locked' }), 'apt-locked');
  assert.equal(desktopUnitErrorCode({ code: 'update.nope' }), null);
  assert.equal(desktopUnitErrorCode(new Error('x')), null);
  assert.equal(refusalStatus({ status: 412 }), 412);
  assert.equal(refusalStatus(new Error('x')), null);
});
