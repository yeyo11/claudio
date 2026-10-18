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
