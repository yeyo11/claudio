// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ServerUpdateStatus } from '@claudio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n';
import { en, es } from '../src/i18n/resources';
import { serverUpdateRefetchMs } from '../src/lib/updates';
import { ServerUpdateView, type ServerUpdateViewProps } from '../src/pages/config/UpdatesCard';

// The Updates card of a container (docs/plans/container-polish.md, D4), state by state, from a
// `ServerUpdateStatus`: one primary action at most, and every refusal in words with its way out.

const status = (over: Partial<ServerUpdateStatus> = {}): ServerUpdateStatus => ({
  unsupportedReason: null,
  image: '0.6.0',
  running: '0.6.0',
  source: 'image',
  state: 'idle',
  target: null,
  progress: null,
  error: null,
  needsImage: null,
  lastRollback: null,
  base: 'image',
  shell: null,
  needsShell: null,
  offer: null,
  ...over,
});

const noop = () => undefined;
const view = (over: Partial<ServerUpdateViewProps> = {}): ServerUpdateViewProps => ({
  status: status(),
  latest: '0.7.0',
  updateAvailable: true,
  steps: <i data-testid="host-steps" />,
  pending: false,
  failure: null,
  busy: null,
  liveSentence: () => '2 chats are working',
  rollbackDismissed: false,
  onDismissRollback: noop,
  onDownload: noop,
  onRestart: noop,
  onRevert: noop,
  onCancel: noop,
  onCloseBusy: noop,
  ...over,
});

async function render(over: Partial<ServerUpdateViewProps> = {}, language = 'en'): Promise<string> {
  await i18n.changeLanguage(language);
  return renderToStaticMarkup(<ServerUpdateView {...view(over)} />);
}
const words = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
const primaries = (html: string) => (html.match(/btn btn-primary/g) ?? []).length;

test.afterEach(() => i18n.changeLanguage('en'));

test('an update is offered as the one primary action', async () => {
  const html = await render();
  assert.match(words(html), /Download Claudio 0\.7\.0/);
  assert.equal(primaries(html), 1);
});

test('up to date offers nothing to do', async () => {
  const html = await render({ updateAvailable: false });
  assert.doesNotMatch(html, /<button/);
});

test('each reason a container cannot update itself says so above the host commands', async () => {
  const sentences: Array<[ServerUpdateStatus['unsupportedReason'], RegExp]> = [
    ['needs-auth', /protect access with a token/],
    ['read-only', /Read-only mode is on/],
    ['no-launcher', /started without Claudio's launcher/],
    ['no-keys', /started without Claudio's launcher/],
  ];
  for (const [unsupportedReason, pattern] of sentences) {
    const html = await render({ status: status({ unsupportedReason }) });
    assert.match(words(html), pattern, String(unsupportedReason));
    assert.match(html, /host-steps/);
    assert.equal(primaries(html), 0);
  }
});

test('a release that needs a newer image warns, names it, and keeps the host commands', async () => {
  const html = await render({ status: status({ needsImage: { version: '0.8.0', minImage: '0.7.5' } }) });
  assert.match(words(html), /Claudio 0\.8\.0 needs a newer image \(0\.7\.5 or later\)/);
  assert.match(html, /alert-warn/);
  assert.match(html, /host-steps/);
  assert.equal(primaries(html), 0);
});

test('downloading shows the progress bar at the server’s fraction', async () => {
  const html = await render({ status: status({ state: 'downloading', target: '0.7.0', progress: 0.4 }) });
  assert.match(html, /role="progressbar"[^>]*aria-valuenow="40"/);
  assert.match(html, /progress-seg is-running/);
  assert.match(words(html), /Downloading Claudio 0\.7\.0/);
  assert.equal(primaries(html), 0);
});

test('verifying says the signature is being checked', async () => {
  const html = await render({ status: status({ state: 'verifying', target: '0.7.0' }) });
  assert.match(words(html), /Checking the signature/);
});

test('ready offers the restart as the one primary action', async () => {
  const html = await render({ status: status({ state: 'ready', target: '0.7.0' }) });
  assert.match(words(html), /Restart to update to 0\.7\.0/);
  assert.equal(primaries(html), 1);
});

test('scheduled says when it will restart and offers Cancel, quietly', async () => {
  const html = await render({ status: status({ state: 'scheduled', target: '0.7.0' }) });
  assert.match(words(html), /Claudio 0\.7\.0 will restart onto the update when nothing is running/);
  assert.match(words(html), /Cancel/);
  assert.equal(primaries(html), 0);
});

test('restarting says the page reloads on its own', async () => {
  const html = await render({ status: status({ state: 'restarting', target: '0.7.0' }) });
  assert.match(words(html), /Restarting… this page reloads on its own/);
});

test('a failed download says why, in words, and offers to try again', async () => {
  const expected = {
    'bad-signature': /no valid signature and was discarded/,
    'bad-manifest': /manifest is not valid/,
    'fetch-failed': /Could not download the update/,
    disk: /not enough space in \/data/,
  } as const;
  for (const [error, pattern] of Object.entries(expected)) {
    const html = await render({ status: status({ state: 'failed', error: error as keyof typeof expected }) });
    assert.match(words(html), pattern, error);
    assert.match(html, /alert-bad/);
    assert.match(words(html), /Try again/);
  }
});

test('a rollback is said once, and can be dismissed', async () => {
  const lastRollback = { from: '0.7.0', to: '0.6.0', at: '2026-10-18T10:00:00Z' };
  const html = await render({ status: status({ lastRollback }) });
  assert.match(words(html), /Claudio 0\.7\.0 did not start, so the container went back to 0\.6\.0/);
  assert.match(html, /alert-warn/);
  assert.doesNotMatch(words(await render({ status: status({ lastRollback }), rollbackDismissed: true })), /did not start/);
});

test('running an update offers the way back to the image’s version, and the image alone does not', async () => {
  const overlay = await render({ status: status({ source: 'overlay', running: '0.7.0' }), updateAvailable: false });
  assert.match(words(overlay), /Go back to the image's version \(0\.6\.0\)/);
  assert.doesNotMatch(words(await render({ updateAvailable: false })), /Go back/);
});

test('the Spanish card says the same things', async () => {
  const html = await render({ status: status({ state: 'ready', target: '0.7.0' }) }, 'es');
  assert.match(words(html), /Reiniciar para actualizar a 0\.7\.0|Reiniciar/);
  const failed = await render({ status: status({ state: 'failed', error: 'bad-signature' }) }, 'es');
  assert.match(words(failed), /firma válida/);
  assert.match(words(failed), /Reintentar/);
});

test('the copy of the container’s update has the same keys in both languages', () => {
  const flat = (o: Record<string, unknown>, at = ''): string[] =>
    Object.entries(o).flatMap(([k, v]) => (typeof v === 'string' ? [`${at}${k}`] : flat(v as Record<string, unknown>, `${at}${k}.`)));
  const section = (lang: typeof en, key: 'updates' | 'cli') => flat((lang.config as Record<string, Record<string, unknown>>)[key] as Record<string, unknown>).sort();
  assert.deepEqual(section(en, 'updates'), section(es, 'updates'));
  assert.deepEqual(section(en, 'cli'), section(es, 'cli'));
});

test('the card asks again soon only while the server is doing something', () => {
  assert.equal(serverUpdateRefetchMs(undefined), false);
  assert.equal(serverUpdateRefetchMs({ state: 'idle' }), false);
  assert.equal(serverUpdateRefetchMs({ state: 'ready' }), false);
  for (const state of ['downloading', 'verifying', 'restarting'] as const) assert.equal(serverUpdateRefetchMs({ state }), 2000);
});

// ---- Unified updates (docs/plans/unified-updates.md): not installable, errors by code, the shell as base ----

const shell = { version: '0.6.0', package: 'appimage' as const, shellInputs: 'x', aptManaged: false };

test('a release published without a bundle offers no download, says so, and keeps the host commands', async () => {
  const offer = { version: '0.7.0', installable: false, blocked: 'no-bundle' as const };
  const html = await render({ status: status({ offer }) });
  assert.doesNotMatch(html, /Download Claudio/);
  assert.match(words(html), /Claudio 0\.7\.0 cannot be installed from here: it was published without an in-app update/);
  assert.match(html, /host-steps/);
  assert.equal(primaries(html), 0);
  assert.match(words(await render({ status: status({ offer }) }, 'es')), /Claudio 0\.7\.0 no se puede instalar desde aquí/);
});

test('a release that could not be checked, or that failed to start here before, says so and offers nothing', async () => {
  const unverified = await render({ status: status({ offer: { version: '0.7.0', installable: false, blocked: 'unverified' } }) });
  assert.match(words(unverified), /Claudio 0\.7\.0 could not be checked, so it is not offered\. Check again later/);
  assert.doesNotMatch(unverified, /host-steps/);
  const before = await render({ status: status({ offer: { version: '0.7.0', installable: false, blocked: 'failed-before' } }) });
  assert.match(words(before), /did not start here before, so it is not offered again/);
  for (const html of [unverified, before]) {
    assert.doesNotMatch(html, /<button/);
    assert.equal(primaries(html), 0);
  }
});

test('an installable offer keeps the download button', async () => {
  const html = await render({ status: status({ offer: { version: '0.7.0', installable: true, blocked: null } }) });
  assert.match(words(html), /Download Claudio 0\.7\.0/);
  assert.equal(primaries(html), 1);
});

test('a release that needs a newer desktop app warns, names it, and drops the zone’s own primary', async () => {
  const needsShell = { version: '0.8.0', minShell: '0.7.5' };
  const html = await render({ status: status({ base: 'shell', shell, needsShell, offer: { version: '0.8.0', installable: false, blocked: 'needs-shell' } }), steps: null });
  assert.match(words(html), /Claudio 0\.8\.0 needs a newer desktop app \(0\.7\.5 or later\)\. Update the desktop app first; Claudio follows on its own/);
  assert.match(html, /alert-warn/);
  assert.equal(primaries(html), 0);
  assert.doesNotMatch(html, /Try again/);
  assert.match(words(await render({ status: status({ base: 'shell', shell, needsShell }), steps: null }, 'es')), /necesita una aplicación de escritorio más reciente \(0\.7\.5 o posterior\)/);
});

test('a needs-shell failure has a way out in the desktop app, and no Try again', async () => {
  const html = await render({ status: status({ state: 'failed', error: 'needs-shell', needsShell: { version: '0.8.0', minShell: '0.7.5' } }) });
  assert.match(html, /server-update-needs-shell/);
  assert.doesNotMatch(html, /Try again/);
  assert.doesNotMatch(html, /server-update-failed/);
});

test('a refusal is worded from its code, never from the server’s text', async () => {
  const cases: Array<[string, RegExp]> = [
    ['update.needs-auth', /protect access with a token/],
    ['update.not-owner', /Only the owner can update Claudio/],
    ['update.unsupported', /cannot update itself/],
    ['update.no-release', /no installable release/],
    ['update.busy', /Another step of the update is running/],
    ['update.not-ready', /not ready to install yet/],
    ['update.not-overlay', /already running the version it came with/],
  ];
  for (const [code, pattern] of cases) {
    const html = await render({ failure: Object.assign(new Error('the release 0.6.1 has no server bundle'), { code }) });
    assert.match(words(html), pattern, code);
    assert.doesNotMatch(words(html), /has no server bundle/, code);
  }
  // The owner saw the server's English text in a Spanish page
  const es = await render({ failure: Object.assign(new Error('the release 0.6.1 has no server bundle'), { code: 'update.no-release' }) }, 'es');
  assert.match(words(es), /No hay ninguna versión instalable/);
  assert.doesNotMatch(words(es), /has no server bundle/);
});

test('a refusal this build does not know shows the generic sentence, never the server’s text', async () => {
  const html = await render({ failure: Object.assign(new Error('something odd happened'), { code: 'update.invented' }) });
  assert.match(words(html), /The update did not go through/);
  assert.doesNotMatch(words(html), /something odd/);
});

test('a refusal that another try cannot change offers no Try again', async () => {
  const html = await render({ failure: Object.assign(new Error('x'), { code: 'update.not-owner' }) });
  assert.doesNotMatch(html, /Try again/);
});

test('under the desktop app the zone speaks of the app: restarting, rollback and the way back', async () => {
  const restarting = await render({ status: status({ base: 'shell', shell, state: 'restarting', target: '0.7.0' }) });
  assert.match(words(restarting), /Restarting Claudio… the window reloads on its own/);
  const rolled = await render({ status: status({ base: 'shell', shell, lastRollback: { from: '0.7.0', to: '0.6.0', at: 'x' } }) });
  assert.match(words(rolled), /Claudio 0\.7\.0 did not start, so the app went back to 0\.6\.0/);
  const overlay = await render({ status: status({ base: 'shell', shell, source: 'overlay', running: '0.7.0' }), updateAvailable: false });
  assert.match(words(overlay), /Go back to the desktop app's version \(0\.6\.0\)/);
});

test('a desktop app that cannot update itself says so in its own words, not the container’s', async () => {
  const off = await render({ status: status({ base: 'shell', shell, unsupportedReason: 'no-launcher' }), steps: null });
  assert.match(words(off), /Updating Claudio from here is turned off/);
  assert.doesNotMatch(words(off), /container/);
  assert.match(words(await render({ status: status({ base: 'shell', shell, unsupportedReason: 'development' }), steps: null })), /runs from a checkout/);
});

test('the busy dialog counts the open terminals, and the Spanish plural agrees', async () => {
  await i18n.changeLanguage('en');
  assert.equal(i18n.t('updates.live.terminals', { ns: 'config', count: 1 }), '1 terminal is open');
  assert.equal(i18n.t('updates.live.terminals', { ns: 'config', count: 3 }), '3 terminals are open');
  await i18n.changeLanguage('es');
  assert.equal(i18n.t('updates.live.terminals', { ns: 'config', count: 1 }), '1 terminal está abierta');
  assert.equal(i18n.t('updates.live.terminals', { ns: 'config', count: 2 }), '2 terminales están abiertas');
});
