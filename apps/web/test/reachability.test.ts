// The store behind the "server unreachable" screen (docs/plans/remote-updates.md, D9): what counts as
// the network failing, when one failed call becomes a screen, how it retries and how it recovers.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { ApiRequestError } from '../src/api.ts';
import { BACKOFF_FIRST_MS, BACKOFF_MAX_MS, HEALTH_PATH, isNetworkFailure, Reachability, REACHABLE_TTL_MS, type ReachabilityTarget } from '../src/lib/reachability.ts';

/** A store on a clock and a network the test moves by hand; timers are the runner's mock. */
function harness(t: TestContext, { online = true }: { online?: boolean } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = { clock: 1_000_000, up: false, online, probes: 0, status: 200 };
  const store = new Reachability({
    now: () => state.clock,
    online: () => state.online,
    fetcher: async (input) => {
      assert.equal(String(input), HEALTH_PATH, 'the probe asks the open health route');
      state.probes += 1;
      if (!state.up) throw new TypeError('Failed to fetch');
      return new Response('{}', { status: state.status });
    },
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  /** Time passes: the clock and the timers move together, then the probes that fired finish */
  const advance = async (ms: number) => {
    state.clock += ms;
    t.mock.timers.tick(ms);
    await settle();
  };
  return { state, store, advance, settle };
}

test('only the network failing counts: not a status, not a slow route, not a call someone cancelled', () => {
  assert.ok(isNetworkFailure(new TypeError('Failed to fetch')), 'Chrome');
  assert.ok(isNetworkFailure(new TypeError('Load failed')), 'Safari');
  assert.ok(isNetworkFailure(new TypeError('NetworkError when attempting to fetch resource.')), 'Firefox');
  assert.ok(isNetworkFailure(new ApiRequestError('No se ha podido conectar', 0, 'Failed to fetch')), 'the request layer wraps it with status 0');
  assert.ok(isNetworkFailure(new DOMException('', 'NetworkError')));
  assert.ok(!isNetworkFailure(new ApiRequestError('boom', 500)), 'a server error is an answer');
  assert.ok(!isNetworkFailure(new ApiRequestError('proxy', 502, 'HTTP 502')), 'so is a proxy page');
  assert.ok(!isNetworkFailure(new ApiRequestError('slow', 408)), 'the request timeout is a slow route on a live server');
  assert.ok(!isNetworkFailure(new DOMException('', 'TimeoutError')));
  assert.ok(!isNetworkFailure(new DOMException('', 'AbortError')), 'a cancelled read is nobody failing');
  assert.ok(!isNetworkFailure(new Error('x')));
  assert.ok(!isNetworkFailure(undefined));
});

test('one failed call does not flip the screen when the server still answers the probe', async (t) => {
  const { state, store } = harness(t);
  state.up = true;
  assert.equal(await store.suspect(), true);
  assert.equal(store.snapshot().unreachable, false);
  assert.equal(state.probes, 1);
});

test('any HTTP answer proves the server is there, an error status included', async (t) => {
  const { state, store } = harness(t);
  state.up = true;
  state.status = 503;
  assert.equal(await store.suspect(), true);
  assert.equal(store.snapshot().unreachable, false);
});

test('a probe with no answer puts the screen up, with the first retry two seconds away', async (t) => {
  const { state, store } = harness(t);
  assert.equal(await store.suspect(), false);
  const view = store.snapshot();
  assert.equal(view.unreachable, true);
  assert.equal(view.offline, false, 'the browser thinks it is online: it is this server that does not answer');
  assert.equal(view.nextAttemptAt, state.clock + BACKOFF_FIRST_MS);
});

test('calls that fail together share one probe', async (t) => {
  const { state, store } = harness(t);
  await Promise.all([store.suspect(), store.suspect(), store.suspect()]);
  assert.equal(state.probes, 1);
});

test('a server that answered a moment ago is not probed again, unless a chunk failure asks for a fresh look', async (t) => {
  const { state, store, advance } = harness(t);
  state.up = true;
  await store.suspect();
  await store.suspect();
  assert.equal(state.probes, 1, 'the second suspicion rides on the answer just had');
  await store.suspect(true);
  assert.equal(state.probes, 2, 'fresh asks again');
  await advance(REACHABLE_TTL_MS);
  await store.suspect();
  assert.equal(state.probes, 3, 'and the answer goes stale');
});

test('the retries back off from 2 s, doubling to 30 s', async (t) => {
  const { state, store, advance } = harness(t);
  await store.suspect();
  const waits: number[] = [];
  for (let i = 0; i < 7; i += 1) {
    const view = store.snapshot();
    assert.ok(view.nextAttemptAt !== null);
    const wait = view.nextAttemptAt - state.clock;
    waits.push(wait);
    await advance(wait - 1);
    assert.equal(state.probes, 1 + i, 'nothing is asked before the wait is over');
    await advance(1);
    assert.equal(state.probes, 2 + i, 'the wait over, the server is asked');
  }
  assert.deepEqual(waits, [2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.equal(BACKOFF_MAX_MS, 30_000);
});

test('while a retry is out the screen says so, and the countdown has nothing to count', async (t) => {
  const { state, store, advance } = harness(t);
  await store.suspect();
  // The timer fires, the probe is asked, and the answer has not come yet
  state.clock += BACKOFF_FIRST_MS;
  t.mock.timers.tick(BACKOFF_FIRST_MS);
  assert.equal(store.snapshot().probing, true);
  assert.equal(store.snapshot().nextAttemptAt, null);
  await advance(0);
  assert.equal(store.snapshot().probing, false);
  assert.ok(store.snapshot().nextAttemptAt !== null);
});

test('when the server answers again the app goes on: listeners hear it once and the retrying stops', async (t) => {
  const { state, store, advance } = harness(t);
  let recoveries = 0;
  store.onRecovered(() => void recoveries++);
  const back = store.untilReachable();
  await store.suspect();
  await advance(2000);
  await advance(4000);
  assert.equal(store.snapshot().unreachable, true);
  state.up = true;
  await advance(8000);
  assert.equal(store.snapshot().unreachable, false);
  assert.equal(recoveries, 1);
  await back;
  const asked = state.probes;
  await advance(120_000);
  assert.equal(state.probes, asked, 'no more probes once it is back');
  assert.equal(recoveries, 1);
});

test('any answer to the page\'s own calls ends the screen too, with no probe', async (t) => {
  const { state, store } = harness(t);
  let recoveries = 0;
  store.onRecovered(() => void recoveries++);
  await store.suspect();
  store.answered();
  assert.equal(store.snapshot().unreachable, false);
  assert.equal(recoveries, 1);
  assert.equal(state.probes, 1);
});

test('a browser that says it has no network is told apart in the words, and the probe still decides', async (t) => {
  const { state, store } = harness(t, { online: false });
  assert.equal(await store.suspect(), false);
  assert.equal(state.probes, 1, 'offline is the wording, the probe is the verdict');
  assert.equal(store.snapshot().unreachable, true);
  assert.equal(store.snapshot().offline, true);
  // An answer to one of the page's own calls is the server there, whatever the browser says
  store.answered();
  assert.equal(store.snapshot().unreachable, false);
});

test("with no network at all the desktop app's own server still answers: no screen over a working app", async (t) => {
  // The desktop window talks to 127.0.0.1, which needs no network; Chromium reports offline when
  // only the loopback interface is up (a laptop in flight mode)
  const { state, store } = harness(t, { online: false });
  state.up = true;
  assert.equal(await store.suspect(), true);
  assert.equal(store.snapshot().unreachable, false);
  const win = fakeWindow();
  store.watch(win.target);
  win.fire('offline');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.snapshot().unreachable, false, 'going offline is a reason to look, and the server is there');
});

function fakeWindow() {
  const listeners = new Map<string, Set<() => void>>();
  const documentListeners = new Map<string, Set<() => void>>();
  const hook = (map: Map<string, Set<() => void>>) => ({
    addEventListener: (type: string, listener: () => void) => void (map.get(type) ?? map.set(type, new Set()).get(type))?.add(listener),
    removeEventListener: (type: string, listener: () => void) => void map.get(type)?.delete(listener),
  });
  const document = { visibilityState: 'visible', ...hook(documentListeners) };
  const target: ReachabilityTarget = { ...hook(listeners), document };
  const fire = (type: string, map = listeners) => map.get(type)?.forEach((listener) => listener());
  return { target, document, fire, fireDocument: (type: string) => fire(type, documentListeners), count: () => [...listeners.values(), ...documentListeners.values()].reduce((n, set) => n + set.size, 0) };
}

test('online, focus and a tab shown again retry at once, without waiting for the back-off', async (t) => {
  const { state, store, settle } = harness(t);
  const win = fakeWindow();
  const stop = store.watch(win.target);
  await store.suspect();
  assert.equal(state.probes, 1);

  win.fire('online');
  await settle();
  assert.equal(state.probes, 2, 'online');
  win.fire('focus');
  await settle();
  assert.equal(state.probes, 3, 'focus');
  win.document.visibilityState = 'hidden';
  win.fireDocument('visibilitychange');
  await settle();
  assert.equal(state.probes, 3, 'hiding the tab asks nothing');
  win.document.visibilityState = 'visible';
  win.fireDocument('visibilitychange');
  await settle();
  assert.equal(state.probes, 4, 'showing it again');

  state.up = true;
  win.fire('focus');
  await settle();
  assert.equal(store.snapshot().unreachable, false, 'and the first of them that finds the server ends the screen');
  stop();
  assert.equal(win.count(), 0, 'stopping lets go of every listener');
});

test('those events ask nothing while the server is reachable', async (t) => {
  const { state, store, settle } = harness(t);
  const win = fakeWindow();
  store.watch(win.target);
  win.fire('online');
  win.fire('focus');
  win.fireDocument('visibilitychange');
  await settle();
  assert.equal(state.probes, 0);
});

test('the browser going offline looks at once, puts the screen up in the offline words, and coming back retries', async (t) => {
  const { state, store, settle } = harness(t);
  const win = fakeWindow();
  store.watch(win.target);
  state.online = false;
  win.fire('offline');
  await settle();
  assert.equal(state.probes, 1);
  assert.equal(store.snapshot().unreachable, true);
  assert.equal(store.snapshot().offline, true);
  state.online = true;
  state.up = true;
  win.fire('online');
  await settle();
  assert.equal(store.snapshot().unreachable, false);
});

test('a retry asked for while one is out does not start a second', async (t) => {
  const { state, store, settle } = harness(t);
  await store.suspect();
  store.retryNow();
  store.retryNow();
  await settle();
  assert.equal(state.probes, 2);
});
