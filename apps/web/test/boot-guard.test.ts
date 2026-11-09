// The boot guard runs before the bundle, as a plain script inlined into index.html, so it is
// loaded here from the same source and driven with a fake window: a document that finishes
// parsing, session storage that outlives a reload, and a reload that is only counted.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { BOOT_GUARD_MARKER, bootGuardScript, bootStrings, injectBootGuard, type BootStrings } from '../scripts/boot-guard.ts';

const WEB = path.join(import.meta.dirname, '..');
const SOURCE = readFileSync(path.join(WEB, 'boot-guard.js'), 'utf8');
const STRINGS = bootStrings(WEB);

class FakeElement {
  /** A text node is an element with no tag: `textOf` reads it */
  isText = false;
  className = '';
  textContent = '';
  type = '';
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  private readonly listeners = new Map<string, () => void>();
  constructor(readonly tag: string) {}
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  appendChild(child: FakeElement) {
    this.children.push(child);
  }
  replaceChildren(...children: FakeElement[]) {
    this.children.splice(0, this.children.length, ...children);
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, listener);
  }
  click() {
    this.listeners.get('click')?.();
  }
  /** Every element below this one, depth first */
  all(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.all()]);
  }
}

/** One browser tab: its session storage survives `reload()`, everything else is a new document. */
class Tab {
  readonly session = new Map<string, string>();
  reloads = 0;
  storageBlocked = false;
  language: string | null = null;
  languages = ['en-US'];
  now = 1_000_000;
  /** `navigator.onLine`; unset like a browser that does not say */
  onLine: boolean | undefined;
  /** The probe of the health route; absent, the guard has no way to ask and says what it always said */
  fetcher: ((url: string) => Promise<unknown>) | undefined;
  probes: string[] = [];
  host = '192.168.0.28:8797';
  /** Timers with a delay wait here until a test runs them; `setTimeout(fn, 0)` is the document's tick and runs at once */
  delayed: Array<() => void> = [];

  /** Loads a document; `boots` says whether its module graph loaded and the app's first module ran. */
  load({ boots }: { boots: boolean }) {
    let ready: (() => void) | undefined;
    const root = new FakeElement('div');
    const storage = (map: Map<string, string>) => ({
      getItem: (key: string) => {
        if (this.storageBlocked) throw new Error('SecurityError');
        return map.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (this.storageBlocked) throw new Error('SecurityError');
        map.set(key, value);
      },
      removeItem: (key: string) => {
        if (this.storageBlocked) throw new Error('SecurityError');
        map.delete(key);
      },
    });
    const local = new Map<string, string>(this.language ? [['claudio-language', this.language]] : []);
    const win: Record<string, unknown> & { __claudioBooted?: () => void } = {
      sessionStorage: storage(this.session),
      localStorage: storage(local),
      navigator: { languages: this.languages, language: this.languages[0], ...(this.onLine === undefined ? {} : { onLine: this.onLine }) },
      location: { reload: () => void this.reloads++, host: this.host },
      setTimeout: (fn: () => void, ms?: number) => (ms ? void this.delayed.push(fn) : fn()),
      ...(this.fetcher
        ? {
            fetch: (url: string) => {
              this.probes.push(url);
              return this.fetcher?.(url);
            },
          }
        : {}),
      document: {
        getElementById: (id: string) => (id === 'root' ? root : null),
        createElement: (tag: string) => new FakeElement(tag),
        createTextNode: (text: string) => Object.assign(new FakeElement('#text'), { textContent: text, isText: true }),
        addEventListener: (type: string, listener: () => void) => {
          if (type === 'DOMContentLoaded') ready = listener;
        },
      },
    };
    const guard = runInNewContext(SOURCE, { Date: { now: () => this.now }, Number, String }) as (w: unknown, s: BootStrings) => void;
    guard(win, STRINGS);
    // Module scripts run before DOMContentLoaded: the app's first module calls in, or nothing does
    if (boots) win.__claudioBooted?.();
    ready?.();
    return { root, win };
  }
}

const fallbackOf = (root: FakeElement) => root.children.find((el) => el.className.includes('boot-failed'));

test('a page whose module graph loaded is left alone', () => {
  const tab = new Tab();
  const { root } = tab.load({ boots: true });
  assert.equal(tab.reloads, 0);
  assert.equal(root.children.length, 0, 'the app owns #root');
});

test('a page whose module graph failed reloads once, and the reloaded page that boots clears the retry', () => {
  const tab = new Tab();
  tab.load({ boots: false });
  assert.equal(tab.reloads, 1, 'the blank page reloads itself');
  tab.load({ boots: true });
  assert.equal(tab.session.size, 0, 'a boot forgets the retry');
  // The next failure, even right away, is a new one and gets its own reload
  tab.load({ boots: false });
  assert.equal(tab.reloads, 2);
});

test('a second failure in a row shows the fallback instead of reloading again, so it never loops', () => {
  const tab = new Tab();
  tab.load({ boots: false });
  const { root } = tab.load({ boots: false });
  assert.equal(tab.reloads, 1, 'only the first failure reloads');
  const fallback = fallbackOf(root);
  assert.ok(fallback, 'the page says it could not start');
  assert.equal(fallback.attributes.get('role'), 'alert');
  const texts = fallback.all().map((el) => el.textContent);
  assert.ok(texts.includes(STRINGS.en.title) && texts.includes(STRINGS.en.hint));
  // The person's own reload may try once more on its own
  const button = fallback.all().find((el) => el.tag === 'button');
  assert.equal(button?.textContent, STRINGS.en.action);
  button?.click();
  assert.equal(tab.reloads, 2);
  assert.equal(tab.session.size, 0);
  tab.load({ boots: false });
  assert.equal(tab.reloads, 3, 'after a reload the person asked for, a failure reloads once again');
});

test('a failure a minute after the last retry is a new one and reloads', () => {
  const tab = new Tab();
  tab.load({ boots: false });
  tab.now += 61_000;
  tab.load({ boots: false });
  assert.equal(tab.reloads, 2);
});

test('without session storage the guard cannot count its reloads, so it shows the fallback at once', () => {
  const tab = new Tab();
  tab.storageBlocked = true;
  const { root } = tab.load({ boots: false });
  assert.equal(tab.reloads, 0);
  assert.ok(fallbackOf(root));
});

test('the fallback speaks the stored language, then the browser’s', () => {
  const spanish = new Tab();
  spanish.languages = ['de-DE', 'es-ES'];
  spanish.storageBlocked = true;
  assert.ok(fallbackOf(spanish.load({ boots: false }).root)?.all().some((el) => el.textContent === STRINGS.es.title));
  const stored = new Tab();
  stored.language = 'es';
  stored.load({ boots: false });
  const { root } = stored.load({ boots: false });
  assert.ok(fallbackOf(root)?.all().some((el) => el.textContent === STRINGS.es.action));
});

test('the build inlines the guard where index.html marks it, with the locales’ words, and refuses a page without the marker', () => {
  const html = readFileSync(path.join(WEB, 'index.html'), 'utf8');
  assert.ok(html.indexOf(BOOT_GUARD_MARKER) < html.indexOf('<script type="module"'), 'the guard comes before the app');
  const script = bootGuardScript(SOURCE, { en: { ...STRINGS.en, title: '</script>' }, es: STRINGS.es });
  const page = injectBootGuard(html, script);
  assert.ok(!page.includes(BOOT_GUARD_MARKER));
  assert.equal(page.match(/<\/script>/g)?.length, (html.match(/<\/script>/g)?.length ?? 0) + 1, 'no string closes the element early');
  assert.match(page, /\(window, \{"en":/);
  assert.throws(() => injectBootGuard('<html></html>', script), /no <!-- boot-guard -->/);
  assert.deepEqual(STRINGS.es.action, 'Recargar');
});

const settle = () => new Promise((resolve) => setImmediate(resolve));
const textOf = (el: FakeElement | undefined) =>
  el
    ?.all()
    .filter((node) => node.isText || node.children.length === 0)
    .map((node) => node.textContent)
    .join('');

/** The tab that failed once already, so its next failure is the one that shows the fallback */
async function secondFailure(setup: (tab: Tab) => void) {
  const tab = new Tab();
  tab.load({ boots: false });
  setup(tab);
  const { root } = tab.load({ boots: false });
  await settle();
  return { tab, root };
}

test('a bundle that failed to load with no network says there is no connection, in the screen’s words', async () => {
  const { root } = await secondFailure((tab) => {
    tab.onLine = false;
    tab.fetcher = () => Promise.reject(new TypeError('Failed to fetch'));
  });
  const fallback = fallbackOf(root);
  assert.ok(fallback);
  const texts = fallback.all().map((el) => el.textContent);
  assert.ok(texts.includes(STRINGS.en.offline.title) && texts.includes(STRINGS.en.offline.hint));
  assert.equal(STRINGS.es.offline.title, 'Sin conexión');
  assert.equal(fallback.all().find((el) => el.tag === 'button')?.textContent, STRINGS.en.offline.action);
});

test("with no network, a server that still answers (the desktop app's own, on 127.0.0.1) means the bundle is broken", async () => {
  const { tab, root } = await secondFailure((t) => {
    t.onLine = false;
    t.fetcher = () => Promise.resolve({ ok: true });
  });
  assert.deepEqual(tab.probes, ['/api/health'], 'offline is no reason to skip the probe');
  const fallback = fallbackOf(root);
  assert.ok(fallback);
  assert.ok(fallback.all().some((el) => el.textContent === STRINGS.en.title), 'the bundle’s own words, not "no connection"');
});

test('a bundle that failed because the server does not answer names the address in mono', async () => {
  const { tab, root } = await secondFailure((t) => {
    t.fetcher = () => Promise.reject(new TypeError('Failed to fetch'));
  });
  assert.deepEqual(tab.probes, ['/api/health']);
  const fallback = fallbackOf(root);
  assert.ok(fallback);
  assert.ok(fallback.all().some((el) => el.textContent === STRINGS.en.unreachable.title));
  const mono = fallback.all().find((el) => el.className === 'mono');
  assert.equal(mono?.textContent, '192.168.0.28:8797');
  assert.match(textOf(fallback) ?? '', /192\.168\.0\.28:8797 isn't answering\./);
  const button = fallback.all().find((el) => el.tag === 'button');
  assert.equal(button?.textContent, STRINGS.en.unreachable.action);
  button?.click();
  assert.equal(tab.reloads, 2, 'the person’s retry reloads');
});

test('the same words in Spanish', async () => {
  const { root } = await secondFailure((t) => {
    t.language = 'es';
    t.fetcher = () => Promise.reject(new TypeError('Failed to fetch'));
  });
  const fallback = fallbackOf(root);
  assert.ok(fallback?.all().some((el) => el.textContent === 'No se puede contactar con Claudio'));
  assert.match(textOf(fallback) ?? '', /No llega a 192\.168\.0\.28:8797\. Si estás fuera de casa, activa Tailscale/);
});

test('a server that answers the probe means the files are what is broken: the bundle’s own words', async () => {
  const { root } = await secondFailure((t) => {
    t.fetcher = () => Promise.resolve({ ok: true });
  });
  const fallback = fallbackOf(root);
  assert.ok(fallback);
  assert.ok(fallback.all().some((el) => el.textContent === STRINGS.en.title));
  assert.equal(fallback.all().find((el) => el.tag === 'button')?.textContent, STRINGS.en.action);
});

test('a probe that hangs does not leave the page blank: after its wait the server is taken as out of reach', async () => {
  const tab = new Tab();
  tab.load({ boots: false });
  tab.fetcher = () => new Promise(() => {});
  const { root } = tab.load({ boots: false });
  await settle();
  assert.equal(fallbackOf(root), undefined, 'still waiting for the probe');
  tab.delayed.forEach((fn) => fn());
  assert.ok(fallbackOf(root)?.all().some((el) => el.textContent === STRINGS.en.unreachable.title));
});
