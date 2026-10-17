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
      navigator: { languages: this.languages, language: this.languages[0] },
      location: { reload: () => void this.reloads++ },
      setTimeout: (fn: () => void) => fn(),
      document: {
        getElementById: (id: string) => (id === 'root' ? root : null),
        createElement: (tag: string) => new FakeElement(tag),
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
  const script = bootGuardScript(SOURCE, { en: { title: '</script>', hint: 'h', action: 'a' }, es: STRINGS.es });
  const page = injectBootGuard(html, script);
  assert.ok(!page.includes(BOOT_GUARD_MARKER));
  assert.equal(page.match(/<\/script>/g)?.length, (html.match(/<\/script>/g)?.length ?? 0) + 1, 'no string closes the element early');
  assert.match(page, /\(window, \{"en":/);
  assert.throws(() => injectBootGuard('<html></html>', script), /no <!-- boot-guard -->/);
  assert.deepEqual(STRINGS.es.action, 'Recargar');
});
