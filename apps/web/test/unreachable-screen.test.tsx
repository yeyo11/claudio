/** @jsxRuntime automatic */
// The unreachable-server screen's wiring (docs/plans/remote-updates.md, D9): the request layer feeds
// the store, the screen says it in the words of the cause, the reload banner steps aside, and a chunk
// that failed because of the network is never taken for a new version.
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { api } from '../src/api.ts';
import { loadChunkOnline, ReloadBanner } from '../src/components/ReloadOffer.tsx';
import { secondsUntil, Unreachable } from '../src/components/Unreachable.tsx';
import i18n from '../src/i18n';
import { dismissReloadOffer, noticeChunkFailure, ReloadOffers } from '../src/lib/reload.ts';
import { reachability } from '../src/lib/reachability.ts';

const realFetch = globalThis.fetch;
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** The network as the test wants it: every request, the probe included, is answered by `answer`. */
function network(answer: () => Response | Promise<Response>): { requests: string[] } {
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return answer();
  }) as typeof fetch;
  return { requests };
}
const down = (): never => {
  throw new TypeError('Failed to fetch');
};

test.beforeEach(async () => {
  reachability.reset();
  dismissReloadOffer();
  await i18n.changeLanguage('es');
});
test.afterEach(async () => {
  globalThis.fetch = realFetch;
  reachability.reset();
  dismissReloadOffer();
  await i18n.changeLanguage('en');
});

test('a call that fails as the network does is confirmed with a probe before the screen takes over', async () => {
  const { requests } = network(down);
  await assert.rejects(api.stopTunnel(), { status: 0 });
  await reachability.suspect();
  assert.equal(requests.filter((request) => request.endsWith('/api/health')).length, 1, 'one probe of the health route');
  assert.equal(requests.length, 2, 'the call itself, then the probe');
  assert.equal(reachability.snapshot().unreachable, true);
});

test('a call that fails right after the server answered still brings the screen: the answer just had is not a verdict on the next call', async () => {
  network(() => new Response('{}', { status: 200 }));
  await api.stopTunnel();
  network(down);
  await assert.rejects(api.stopTunnel(), { status: 0 });
  await settle();
  await settle();
  assert.equal(reachability.snapshot().unreachable, true);
});

test('a server that answers badly is reachable: an error status never brings the screen', async () => {
  network(() => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }));
  await assert.rejects(api.stopTunnel(), { status: 500 });
  assert.equal(reachability.snapshot().unreachable, false);
});

test('the first call that is answered ends the screen: the app goes on with no reload', async () => {
  network(down);
  await assert.rejects(api.stopTunnel());
  await reachability.suspect();
  assert.equal(reachability.snapshot().unreachable, true);
  network(() => new Response('{}', { status: 200 }));
  await api.stopTunnel();
  assert.equal(reachability.snapshot().unreachable, false);
});

test('the screen names the address in mono and offers the retry, in Spanish', async () => {
  network(down);
  await reachability.suspect();
  const html = renderToStaticMarkup(<Unreachable address="192.168.0.28:8797" />);
  assert.match(html, /<h1[^>]*>No se puede contactar con Claudio<\/h1>/);
  assert.match(html, /No llega a <span class="mono">192\.168\.0\.28:8797<\/span>\. Si estás fuera de casa, activa Tailscale o conéctate a tu red local\./);
  assert.match(html, /Reintentando en \d+ s/);
  assert.match(html, />Reintentar ahora<\/button>/);
  assert.match(html, /class="[^"]*illustration|<svg/, 'the offline illustration');
  assert.doesNotMatch(html, /Recargar/, 'a reload cannot help here, so it is never offered');
});

test('the English words mirror the Spanish ones', async () => {
  await i18n.changeLanguage('en');
  network(down);
  await reachability.suspect();
  const html = renderToStaticMarkup(<Unreachable address="claudio.local" />);
  assert.match(html, /Can&#x27;t reach Claudio/);
  assert.match(html, /<span class="mono">claudio\.local<\/span> isn&#x27;t answering\./);
  assert.match(html, /Retry now/);
});

test('with no connection at all the screen says so and does not blame the address', async () => {
  const navigatorOnLine = Object.getOwnPropertyDescriptor(globalThis.navigator, 'onLine');
  Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true });
  try {
    await reachability.suspect();
    const html = renderToStaticMarkup(<Unreachable address="192.168.0.28:8797" />);
    assert.match(html, /<h1[^>]*>Sin conexión<\/h1>/);
    assert.match(html, /Este dispositivo no tiene conexión a internet\./);
    assert.doesNotMatch(html, /192\.168\.0\.28/);
  } finally {
    if (navigatorOnLine) Object.defineProperty(globalThis.navigator, 'onLine', navigatorOnLine);
    else Reflect.deleteProperty(globalThis.navigator, 'onLine');
  }
});

test('a restart asked for says "restarting" with the spinner beside the verb, in both languages, and offers no retry', async () => {
  network(down);
  await reachability.suspect();
  reachability.expectRestart();
  let html = renderToStaticMarkup(<Unreachable address="claudio.local" />);
  assert.match(html, /<h1[^>]*>Reiniciando Claudio…<\/h1>/);
  assert.match(html, /data-testid="unreachable-restarting"/);
  assert.match(html, /spinner-glyph/, 'the braille spinner');
  assert.doesNotMatch(html, /Reintentar ahora|No se puede contactar/);
  await i18n.changeLanguage('en');
  html = renderToStaticMarkup(<Unreachable address="claudio.local" />);
  assert.match(html, /<h1[^>]*>Restarting Claudio…<\/h1>/);
});

test('the countdown never reads zero while a wait is on', () => {
  assert.equal(secondsUntil(10_000, 0), 10);
  assert.equal(secondsUntil(10_000, 9_001), 1);
  assert.equal(secondsUntil(10_000, 12_000), 1);
});

test('the reload banner steps aside while the server cannot be reached, and comes back with it', async () => {
  network(() => new Response('{}', { status: 200 }));
  await noticeChunkFailure();
  assert.match(renderToStaticMarkup(<ReloadBanner />), /data-testid="reload-banner"/, 'a chunk that is gone with the server there is a new version');
  network(down);
  await reachability.suspect(true);
  assert.equal(renderToStaticMarkup(<ReloadBanner />), '', 'no reload offer while unreachable');
  network(() => new Response('{}', { status: 200 }));
  reachability.answered();
  assert.match(renderToStaticMarkup(<ReloadBanner />), /data-testid="reload-banner"/);
});

test('a chunk that failed because the network did is not a new version', async () => {
  const offers = new ReloadOffers('1.0.0');
  await noticeChunkFailure({ suspect: async () => false }, offers);
  assert.equal(offers.current(), null);
  await noticeChunkFailure({ suspect: async () => true }, offers);
  assert.deepEqual(offers.current(), { reason: 'stale' });
});

test('a version change heard while unreachable is offered once the server is back', () => {
  const offers = new ReloadOffers('1.0.0');
  // The reopened feed's hello arrives after the recovery, naming the version the server runs now
  offers.serverVersion('1.1.0');
  assert.deepEqual(offers.current(), { reason: 'updated', version: '1.1.0' });
});

const gone = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module: https://a.test/assets/Chats-Aa11.js'));

test('a route opened while the server is out of reach loads once it is back, instead of ending on the stale page', async () => {
  let attempts = 0;
  let back!: () => void;
  const reach = {
    suspect: async () => false,
    untilReachable: () => new Promise<void>((resolve) => (back = resolve)),
  };
  const loading = loadChunkOnline(
    () => (++attempts <= 2 ? gone() : Promise.resolve('page')),
    reach,
    async () => {},
  );
  await settle();
  assert.equal(attempts, 2, 'asked twice, then it waits for the server rather than giving up');
  back();
  assert.equal(await loading, 'page');
});

test('a chunk that is gone while the server answers is stale, as before', async () => {
  const reach = { suspect: async () => true, untilReachable: async () => {} };
  assert.equal(await loadChunkOnline(gone, reach, async () => {}), null);
});
