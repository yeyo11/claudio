// Dependency-free browser driver over the Chrome DevTools Protocol (Node 22+: global fetch/WebSocket).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { killGroup } from './processes.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A call to the browser that gets no answer is a hung Chrome: fail it instead of waiting forever */
const CDP_TIMEOUT_MS = 60_000;

// axe-core is a dev dependency of the workspace root; its source is injected into the page
let axeSource;
const axeScript = () => (axeSource ??= readFileSync(join(dirname(createRequire(import.meta.url).resolve('axe-core')), 'axe.min.js'), 'utf8'));

function findChrome() {
  const candidates = [process.env.CHROME_BIN, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].filter(Boolean);
  for (const bin of candidates) if (spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0) return bin;
  throw new Error('Chrome/Chromium not found. Set CHROME_BIN.');
}

/**
 * Chrome picks its own debugging port (`--remote-debugging-port=0`), so a browser left over from an
 * earlier run, or a second suite beside this one, can never be mistaken for ours by a fixed port.
 * It says which port in two places: a `DevTools listening on ws://…` line on stderr, and the
 * `DevToolsActivePort` file in the profile. Either will do, and whichever comes first is taken: on
 * the CI runner the file once did not appear within the wait at all. When neither comes,
 * the error carries the end of what Chrome printed, since that is where it says why.
 */
async function devtoolsEndpoint(profile, chrome, output, wait = 30_000) {
  const file = join(profile, 'DevToolsActivePort');
  for (let waited = 0; waited < wait; waited += 100) {
    const announced = /DevTools listening on ws:\/\/[^:\s]+:(\d+)\//.exec(output.text);
    if (announced) return Number(announced[1]);
    if (existsSync(file)) {
      const [port] = readFileSync(file, 'utf8').split('\n');
      if (Number(port) > 0) return Number(port);
    }
    if (chrome.exitCode !== null || chrome.signalCode !== null) {
      throw new Error(`Chrome exited (${chrome.exitCode ?? chrome.signalCode}) before it exposed a debugging port${tail(output.text)}`);
    }
    await sleep(100);
  }
  throw new Error(`Chrome did not expose a debugging port in ${wait / 1000} s${tail(output.text)}`);
}

const tail = (text) => (text.trim() ? `. Chrome printed:\n${text.trim().split('\n').slice(-15).join('\n')}` : '');

/** How long a failed wait gives the page to describe itself before it is reported as unresponsive */
const DIAGNOSE_WAIT_MS = 5_000;
/** Enough of the root's HTML to tell an empty root from a fallback, an error screen or a page */
const ROOT_HTML_CHARS = 600;
/** Each list a failed wait reports is cut to this many entries, the newest kept */
const DIAGNOSE_LIST = 20;

const keepLast = (list, entry) => {
  list.push(entry);
  if (list.length > DIAGNOSE_LIST) list.shift();
};

/**
 * What one tab's network and console log said since its main frame last began loading a document:
 * the requests that failed or answered an error status, the ones still open, and the console's
 * error and warning entries that are not script errors (a resource that failed to load, a refused
 * script). It is fed every DevTools event; a new document in the main frame starts it over, so the
 * page being left cannot speak for the one that replaced it.
 */
export function networkRecorder() {
  const open = new Map();
  let failed = [];
  let log = [];
  let notes = [];
  const recorder = {
    /** The tab's own frame, whose document requests start a new record; set once the tab is enabled */
    mainFrame: null,
    note: (text) => keepLast(notes, text),
    event(method, params) {
      if (method === 'Network.requestWillBeSent') {
        if (params.type === 'Document' && params.frameId === recorder.mainFrame && !params.redirectResponse) {
          open.clear();
          failed = [];
          log = [];
          notes = [];
        }
        open.set(params.requestId, { method: params.request.method, url: params.request.url, type: params.type ?? 'Other', started: Date.now() });
      } else if (method === 'Network.requestWillBeSentExtraInfo') {
        // The headers went out on a connection: a request open without this is still queued in the browser
        const request = open.get(params.requestId);
        if (request) request.sent = true;
      } else if (method === 'Network.responseReceived') {
        const request = open.get(params.requestId);
        if (!request) return;
        request.status = params.response.status;
        request.fromServiceWorker = params.response.fromServiceWorker === true;
        if (params.response.status >= 400) keepLast(failed, `${params.response.status} ${request.method} ${request.url}${request.fromServiceWorker ? ' (from the service worker)' : ''}`);
      } else if (method === 'Network.loadingFinished') {
        open.delete(params.requestId);
      } else if (method === 'Network.loadingFailed') {
        const request = open.get(params.requestId);
        // Unknown: a request of the document that was left, cancelled as it went
        if (!request) return;
        open.delete(params.requestId);
        const why = [params.errorText, params.blockedReason, params.canceled ? 'canceled' : null].filter(Boolean).join(', ');
        keepLast(failed, `${why} ${request.method} ${request.url}`);
      } else if (method === 'Log.entryAdded') {
        const { level, source, text, url } = params.entry;
        if (level === 'error' || level === 'warning') keepLast(log, `${level} (${source}) ${text}${url && !text.includes(url) ? ` ${url}` : ''}`);
      }
    },
    snapshot(now) {
      return {
        failed: [...failed],
        log: [...log],
        notes: [...notes],
        open: [...open.values()].map((r) => ({ ...r, age: now - r.started })).sort((a, b) => b.age - a.age),
      };
    },
  };
  return recorder;
}

/**
 * The report of a failed wait, as lines under its message. `state` is what the page said about
 * itself, or null when it did not answer in time.
 */
export function describePage({ state, errors, network }) {
  const lines = [];
  if (!state) lines.push(`page: did not answer within ${DIAGNOSE_WAIT_MS / 1000} s (its main thread is busy, or the renderer is gone)`);
  else if (state.threw) lines.push(`page: could not be read (${state.threw})`);
  else {
    lines.push(`page: ${state.href}, readyState ${state.readyState}, title ${JSON.stringify(state.title)}, service worker ${state.worker ?? 'none'}`);
    lines.push(`#root: ${state.root === null ? 'missing' : state.root.replace(/\s+/g, ' ')}`);
    if (state.body) lines.push(`text: ${JSON.stringify(state.body)}`);
  }
  // The newest of what was said, and the oldest of what is still open: those are the stuck ones
  const list = (title, items, keep = (all) => all.slice(-DIAGNOSE_LIST)) => {
    if (items.length) lines.push(`${title}:`, ...keep(items).map((item) => `  ${item}`));
  };
  list('console errors', [...new Set(errors)].map((e) => e.split('\n').slice(0, 4).join(' | ')));
  list('console log', network.log);
  list('failed requests', network.failed);
  list('navigation', network.notes);
  list(
    'still open',
    network.open.map((r) => `${r.method} ${r.url} (${r.type}${r.status ? `, ${r.status}${r.fromServiceWorker ? ' from the service worker' : ''}` : r.sent ? ', sent, no response' : ', not sent'}, ${(r.age / 1000).toFixed(1)} s)`),
    (all) => all.slice(0, DIAGNOSE_LIST),
  );
  return lines.join('\n');
}

/**
 * Starts headless Chrome and returns `{ page, close, pid }`. `close()` is idempotent and also runs
 * from the process's 'exit', so the browser goes down on every way out: the end of the run, a
 * failure, a timeout, a signal turned into an exit, an uncaught error. It is killed by the PID of
 * the process started here (as the leader of its own group, so renderers and helpers go with it),
 * never by matching a name.
 */
export async function launch({ baseUrl, port = 0, shotsDir }) {
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'claudio-e2e-chrome-'));
  // Its own process group, so the renderers and helpers go down with it and none outlives the run
  const chrome = spawn(
    findChrome(),
    ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--lang=en-US', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--window-size=1440,900', 'about:blank'],
    // Specs click buttons by their English text; on a non-English host locale (LANG/LANGUAGE),
    // Chrome otherwise reports navigator.language from the OS regardless of --lang.
    { stdio: ['ignore', 'ignore', 'pipe'], detached: true, env: { ...process.env, LANGUAGE: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' } },
  );
  // Read for the port, and kept draining for the browser's whole life: a pipe nobody reads fills up
  // and blocks Chrome on its next write. Only the start is kept, which is where the port and any
  // reason it could not start are
  const output = { text: '' };
  chrome.stderr.setEncoding('utf8');
  chrome.stderr.on('data', (chunk) => {
    if (output.text.length < 64_000) output.text += chunk;
  });
  // The pipe must not keep the harness alive on its own: the browser's lifetime is `close()`'s business
  chrome.stderr.unref?.();
  // A Chrome that cannot start emits 'error' (nothing to kill then); without a listener it would be an uncaught one
  chrome.on('error', () => {});
  let closed = false;
  /** Every tab's socket, the first one's included, closed with the browser */
  const sockets = new Set();
  const close = () => {
    if (closed) return;
    closed = true;
    for (const ws of sockets) {
      try {
        ws.close();
      } catch {
        // the socket is gone with the browser
      }
    }
    killGroup(chrome.pid);
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  };
  process.once('exit', close);
  let debuggingPort;
  let page;
  try {
    debuggingPort = port || (await devtoolsEndpoint(profile, chrome, output));
    let target;
    for (let i = 0; i < 60 && !target; i++) {
      try {
        target = (await (await fetch(`http://127.0.0.1:${debuggingPort}/json`)).json()).find((t) => t.type === 'page');
      } catch {
        await sleep(250);
      }
    }
    if (!target) throw new Error('Chrome did not expose a debugging target');
    page = await connectTab(target.webSocketDebuggerUrl, { baseUrl, shotsDir, sockets });
  } catch (error) {
    close();
    throw error;
  }

  /**
   * A second tab of the same browser, at `tabBaseUrl`: two people's screens open side by side, so one
   * page stays loaded while the other acts. Its `close()` closes the tab; the browser's closes them all.
   */
  const openTab = async (tabBaseUrl = baseUrl) => {
    // PUT: Chrome refuses a GET on /json/new
    const created = await fetch(`http://127.0.0.1:${debuggingPort}/json/new?about:blank`, { method: 'PUT' });
    if (!created.ok) throw new Error(`Chrome did not open a tab (${created.status})`);
    const target = await created.json();
    const tab = await connectTab(target.webSocketDebuggerUrl, { baseUrl: tabBaseUrl, shotsDir, sockets });
    return Object.assign(tab, {
      async close() {
        await fetch(`http://127.0.0.1:${debuggingPort}/json/close/${target.id}`).catch(() => {});
      },
    });
  };
  return { page, close, pid: chrome.pid, openTab };
}

/** The page API over one tab's DevTools socket */
async function connectTab(wsUrl, { baseUrl, shotsDir, sockets }) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('could not connect to Chrome over the DevTools socket'));
  });
  sockets.add(ws);

  let id = 0;
  const pending = new Map();
  // A browser that dies mid-run answers nothing: fail what is waiting now instead of after the CDP timeout
  ws.onclose = () => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error('Chrome closed the DevTools connection'));
    }
    pending.clear();
  };
  const errors = [];
  const network = networkRecorder();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      const { resolve, timer } = pending.get(d.id);
      clearTimeout(timer);
      resolve(d);
      pending.delete(d.id);
    } else if (d.method === 'Runtime.exceptionThrown') {
      errors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
    } else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') {
      errors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
    } else if (d.method) {
      network.event(d.method, d.params);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      const timer = setTimeout(() => {
        pending.delete(i);
        reject(new Error(`Chrome did not answer ${method} within ${CDP_TIMEOUT_MS / 1000}s`));
      }, CDP_TIMEOUT_MS);
      pending.set(i, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send('Page.enable');
  await send('Runtime.enable');
  // Neither fails a spec: they are what a failed wait reports, so a page that stayed blank says why
  await send('Log.enable');
  await send('Network.enable');
  network.mainFrame = (await send('Page.getFrameTree')).result?.frameTree?.frame?.id ?? null;
  // E2E_CPU_THROTTLE=N runs every tab N times slower: how a flaky wait is met on a machine that is not loaded
  const throttle = Number(process.env.E2E_CPU_THROTTLE ?? 0);
  if (throttle > 1) await send('Emulation.setCPUThrottlingRate', { rate: throttle });

  const page = {
    baseUrl,
    sleep,
    /**
     * Leaves the app and forgets what it stored (localStorage, sessionStorage, IndexedDB, cookies),
     * so a spec starts from a fresh browser and not from what the specs before it left behind: the
     * notification centre, for one, keeps every finished chat in localStorage.
     */
    async reset() {
      // Blank first: the page being left would otherwise write its state back, and its event stream would go on
      await send('Page.navigate', { url: 'about:blank' });
      await send('Storage.clearDataForOrigin', { origin: new URL(baseUrl).origin, storageTypes: 'local_storage,session_storage,indexeddb,cookies' });
      // What a spec emulates lives on the tab, which every spec of a shard shares: a reduced motion
      // left on by one turned the next one's animations off. Each spec starts at the defaults, the
      // 1440 × 900 window included, whatever the one before it forgot to undo
      await send('Emulation.setEmulatedMedia', { features: [] });
      await send('Emulation.setFocusEmulationEnabled', { enabled: false });
      await send('Emulation.clearDeviceMetricsOverride', {});
    },
    /**
     * Runs `source` in every document loaded from now on, before any of the page's own scripts,
     * which is the only way to stand between the app and what it opens on load (its event stream).
     * Returns what removes it again, which a spec must call so the next one gets an untouched page.
     */
    async onNewDocument(source) {
      const added = await send('Page.addScriptToEvaluateOnNewDocument', { source });
      const identifier = added.result.identifier;
      return () => send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    },
    /**
     * Makes every request whose URL matches one of `patterns` (`*` wildcards) fail, the way a file
     * a deploy removed fails, and skips the service worker so its cache cannot answer instead.
     * Returns what lifts the block, which a spec must call before it finishes.
     */
    async blockUrls(patterns) {
      await send('Network.setBypassServiceWorker', { bypass: true });
      await send('Network.setBlockedURLs', { urls: patterns });
      return async () => {
        await send('Network.setBlockedURLs', { urls: [] });
        await send('Network.setBypassServiceWorker', { bypass: false });
      };
    },
    /** Console errors and uncaught exceptions seen so far; `takeErrors()` also clears them. */
    takeErrors: () => errors.splice(0),
    async goto(path, wait = 1200) {
      const navigated = await send('Page.navigate', { url: `${baseUrl}${path}` });
      // A protocol error (an address Chrome will not open) or a navigation that failed (errorText)
      const failed = navigated.error?.message ?? navigated.result?.errorText;
      // Kept, not thrown: a navigation the page itself interrupted is aborted and still lands
      if (failed) network.note(`Page.navigate to ${path} answered ${failed}`);
      // Page.navigate answers once the new document is committed, so the tab is on the app now unless
      // the navigation never got there. Left on about:blank or an error page, every read of storage
      // that follows fails with a SecurityError that says nothing of the navigation: say it here
      const origin = await this.eval('return self.origin').catch(() => null);
      if (origin !== null && origin !== new URL(baseUrl).origin) {
        const at = await this.eval('return location.href').catch(() => 'unknown');
        throw Object.assign(new Error(`the navigation to ${path} did not reach the app${failed ? ` (${failed})` : ''}: the tab is on ${at}\n${await this.diagnose()}`), { diagnosed: true });
      }
      await sleep(wait);
    },
    /**
     * What a failed wait is reported with: where the page is, whether its document finished loading,
     * what its root holds, the service worker in control, and what the console and the network said
     * since the document loaded (failed requests, error responses, requests still open). A renderer
     * too busy to answer is a finding of its own, and the network half is still reported.
     */
    async diagnose() {
      const probe =
        `const root=document.getElementById('root');` +
        `return {href:location.href,readyState:document.readyState,title:document.title,` +
        `worker:navigator.serviceWorker?.controller?.scriptURL??null,` +
        `root:root?root.outerHTML.slice(0,${ROOT_HTML_CHARS}):null,body:document.body?document.body.innerText.trim().slice(0,200):null}`;
      const state = await Promise.race([
        send('Runtime.evaluate', { expression: `(()=>{${probe}})()`, returnByValue: true }).then((r) => r.result?.result?.value ?? { threw: r.result?.exceptionDetails?.text ?? 'no value' }),
        sleep(DIAGNOSE_WAIT_MS).then(() => null),
      ]).catch((error) => ({ threw: error.message }));
      return describePage({ state, errors: [...errors], network: network.snapshot(Date.now()) });
    },
    async eval(body) {
      const r = await send('Runtime.evaluate', { expression: `(async()=>{${body}})()`, awaitPromise: true, returnByValue: true });
      if (r.result.exceptionDetails) {
        const description = r.result.exceptionDetails.exception?.description ?? 'eval failed';
        // Storage refused is a document with an opaque origin (about:blank, an error page), never the
        // app: where the tab is, and how it got there, is what the failure needs to say
        if (description.startsWith('SecurityError')) {
          const at = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }).then((h) => h.result?.result?.value ?? 'unknown', () => 'unknown');
          const notes = network.snapshot(Date.now()).notes;
          throw new Error(`${description}\n(the tab is on ${at}${notes.length ? `; navigation: ${notes.join('; ')}` : ''})`);
        }
        throw new Error(description);
      }
      return r.result.result.value;
    },
    /** Polls until `body` (a JS function body) returns something truthy. */
    // Generous by default: pages are code-split and CI runners are slow
    async waitFor(body, { timeout = 20000, label = body } = {}) {
      const end = Date.now() + timeout;
      // Kept for the report: a wait that never came true because the page threw or had gone (a
      // renderer that crashed, a document that never loaded) says so instead of a bare timeout
      let lastError = null;
      for (;;) {
        const value = await this.eval(body).then(
          (v) => ((lastError = null), v),
          (error) => ((lastError = error), null),
        );
        if (value) return value;
        if (Date.now() > end) {
          const where = await this.eval('return location.href').catch(() => 'unknown');
          const page = await this.diagnose().catch((error) => `the page could not be described: ${error.message}`);
          // `diagnosed`: the report already carries the console errors, so the runner does not repeat them
          throw Object.assign(new Error(`timed out waiting for: ${label} (at ${where}${lastError ? `; the last check threw: ${lastError.message}` : ''})\n${page}`), { diagnosed: true });
        }
        await sleep(150);
      }
    },
    /**
     * Clicks the first element matching `selector`; with `text`, the one whose text equals or
     * contains it. Waits for the element: pages are code-split, so they appear asynchronously.
     */
    async click(selector, text, wait = 500) {
      const expression =
        `const els=[...document.querySelectorAll(${JSON.stringify(selector)})];const t=${JSON.stringify(text ?? null)};` +
        `const el=t?els.find(e=>e.textContent.trim()===t)||els.find(e=>e.textContent.includes(t)):els[0];` +
        `if(!el)return false;el.scrollIntoView({block:'center'});el.click();return true;`;
      await this.waitFor(expression, { label: `click ${selector}${text ? ` "${text}"` : ''}` });
      await sleep(wait);
    },
    /**
     * A click made with real mouse input, which the browser counts as a user gesture: what the
     * Fullscreen API and pop-ups require, and a synthetic `click()` is not.
     */
    async realClick(selector, wait = 500) {
      await this.waitFor(`const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;el.scrollIntoView({block:'center'});return true;`, { label: `find ${selector}` });
      const at = await this.eval(`const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}`);
      const base = { x: at.x, y: at.y, button: 'left', clickCount: 1 };
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
      await sleep(wait);
    },
    /**
     * Picks `optionText` in a themed Select: clicks its trigger, then the matching [role=option]
     * in the portalled menu. A synthetic click takes Radix's touch path, which opens and selects.
     */
    async select(triggerSelector, optionText) {
      await this.click(triggerSelector, undefined, 300);
      await this.click('[role=listbox] [role=option]', optionText, 400);
    },
    /**
     * Sets an input/textarea value the way React expects, or replaces the text of a contenteditable
     * box (the composer's ProseMirror editor) through the browser's own editing command, which the
     * editor reads as typing. Waits for the element.
     */
    async fill(selector, value) {
      await this.waitFor(
        `const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;` +
          `if(el.isContentEditable){el.focus();const r=document.createRange();r.selectNodeContents(el);const s=getSelection();s.removeAllRanges();s.addRange(r);` +
          `document.execCommand(${JSON.stringify(value)}===''?'delete':'insertText',false,${JSON.stringify(value)});return true;}` +
          `const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;` +
          `Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});` +
          `el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true;`,
        { label: `fill ${selector}` },
      );
      await sleep(150);
    },
    async focus(selector) {
      await this.waitFor(`const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;el.focus();return true;`, { label: `focus ${selector}` });
    },
    /** Types into the focused element (real input events; works with CodeMirror). */
    async type(text) {
      await send('Input.insertText', { text });
      await sleep(150);
    },
    /** modifiers: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift */
    async key(key, modifiers = 0) {
      const base = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, modifiers, windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : { Enter: 13, Escape: 27, Tab: 9, ArrowUp: 38, ArrowDown: 40 }[key] };
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await sleep(250);
    },
    /**
     * A key press as a keyboard sends it, with the character that follows: this is what activates a
     * focused link or button (Enter) or presses it (Space). `key()` sends the bare event, enough for
     * handlers of keydown but not for the browser's own default actions.
     */
    async press(key, modifiers = 0) {
      const codes = { Enter: [13, '\r'], ' ': [32, ' '], Tab: [9, undefined], Escape: [27, undefined], ArrowUp: [38, undefined], ArrowDown: [40, undefined], ArrowLeft: [37, undefined], ArrowRight: [39, undefined], Home: [36, undefined], End: [35, undefined] };
      const [windowsVirtualKeyCode, text] = codes[key] ?? [key.toUpperCase().charCodeAt(0), key];
      const base = { key, code: key === ' ' ? 'Space' : key.length === 1 ? `Key${key.toUpperCase()}` : key, modifiers, windowsVirtualKeyCode };
      await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text } : {}) });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await sleep(250);
    },
    /** A headless page is never the focused one, and xterm draws its cursor only on a focused screen. */
    async emulateFocus(on = true) {
      await send('Emulation.setFocusEmulationEnabled', { enabled: on });
    },
    /** Animations and transitions collapse to nothing, so a scan never sees a page half faded in. */
    async reduceMotion(on = true) {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: on ? 'reduce' : 'no-preference' }] });
    },
    /**
     * Runs axe-core on the page, or on the elements matching `include`, and returns the violations
     * trimmed to what is needed to fix them. `rules` is axe's own `{ id: { enabled } }` map.
     */
    async axe({ include, rules = {} } = {}) {
      const loaded = await send('Runtime.evaluate', { expression: `typeof window.axe === 'object'`, returnByValue: true });
      if (!loaded.result.result.value) {
        const injected = await send('Runtime.evaluate', { expression: axeScript() });
        if (injected.result.exceptionDetails) throw new Error(`axe-core did not load: ${injected.result.exceptionDetails.exception?.description ?? injected.result.exceptionDetails.text}`);
      }
      const options = { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, resultTypes: ['violations'], rules };
      const body =
        `const result = await Promise.race([axe.run(${include ? JSON.stringify({ include: [include] }) : 'document'}, ${JSON.stringify(options)}), ` +
        `new Promise((_, reject) => setTimeout(() => reject(new Error('axe did not finish within 30s')), 30000))]);` +
        `return result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => ({ target: n.target.join(' '), html: n.html.slice(0, 140), why: n.failureSummary?.replace(/\\s+/g, ' ').slice(0, 260) ?? '' })) }));`;
      return this.eval(body);
    },
    text: (selector = 'body') => page.eval(`return document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`),
    // `scale` below 1 makes the screenshot smaller than the page (a recording of 800 px of a 1280 px page)
    async viewport(width, height, scale = 1) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
      await sleep(200);
    },
    async shot(name) {
      if (!shotsDir) return;
      const r = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(shotsDir, `${name}.png`), Buffer.from(r.result.data, 'base64'));
    },
  };
  return page;
}
