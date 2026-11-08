// A server that cannot be reached is its own screen, not a reload offer and not a wall of widget
// errors (docs/plans/remote-updates.md, D9). The harness has one server that always answers, so the
// outage is made in the page: every request to /api fails the way a phone off its VPN fails (the
// browser cannot reach the host), and lifting the block is the server coming back. The page must go
// on by itself, with no reload.

const SCREEN = '[data-testid=unreachable]';
const BANNER = '[data-testid=reload-banner]';
const API = ['*/api/*'];

// Same trick as reload.spec.mjs: the hello the page hears names another version
const FAKE_DEPLOY = `(() => {
  const Native = window.EventSource;
  window.EventSource = class extends Native {
    addEventListener(type, listener, options) {
      if (type !== 'stream.hello') return super.addEventListener(type, listener, options);
      return super.addEventListener(type, (event) => {
        const hello = JSON.parse(event.data);
        hello.version = '99.0.0';
        listener.call(this, new MessageEvent(type, { data: JSON.stringify(hello), lastEventId: event.lastEventId }));
      }, options);
    }
  };
})();`;

export default async ({ page, check }) => {
  const homeReady = () => page.waitFor(`return document.querySelector('main')?.innerText.trim().length > 10`, { label: 'the app' });
  const screenGone = (label) => page.waitFor(`return !document.querySelector(${JSON.stringify(SCREEN)})`, { label, timeout: 30000 });

  await page.goto('/', 1500);
  await homeReady();
  check(await page.eval(`return !document.querySelector(${JSON.stringify(SCREEN)})`), 'a reachable server shows no unreachable screen');

  // ---- The server stops answering while the app is open ----
  await page.eval(`window.__claudioStay = true; return true`);
  const lift = await page.blockUrls(API);
  try {
    // Any read the page makes now fails at the network; going to Chats makes one
    await page.click('.sidebar a[href="/chats"]');
    await page.waitFor(`return !!document.querySelector(${JSON.stringify(SCREEN)})`, { label: 'the unreachable screen' });

    const shown = await page.eval(`
      const screen = document.querySelector(${JSON.stringify(SCREEN)});
      return {
        title: screen.querySelector('h1')?.innerText,
        mono: screen.querySelector('.mono')?.innerText,
        host: location.host,
        text: screen.innerText,
        button: screen.querySelector('button')?.innerText,
        illustration: !!screen.querySelector('svg'),
        shellHeld: getComputedStyle(document.querySelector('.shell')).display === 'none',
        pageMounted: !!document.querySelector('.shell main .page'),
        focused: document.activeElement === screen,
        label: screen.getAttribute('aria-label'),
        moving: document.getAnimations().filter((a) => a instanceof CSSAnimation && a.playState === 'running' && !screen.contains(a.effect?.target ?? null)).length,
        banner: !!document.querySelector(${JSON.stringify(BANNER)}),
        reloadButtons: [...document.querySelectorAll('button')].filter((b) => b.innerText.trim() === 'Reload').length,
      };`);
    check(shown.title === "Can't reach Claudio", `the screen says the server cannot be reached: ${shown.title}`);
    check(shown.mono === shown.host, `the address is shown, in mono: ${shown.mono} vs ${shown.host}`);
    check(/isn't answering\./.test(shown.text) && /Tailscale/.test(shown.text), `it says what to do: ${shown.text}`);
    check(/Retrying in \d+ s|Retrying…/.test(shown.text), `it counts down to the next try: ${shown.text}`);
    check(shown.button === 'Retry now', `and offers a retry: ${shown.button}`);
    check(shown.illustration, 'with the offline illustration');
    check(shown.shellHeld, 'it stands in for the whole shell: no control acts on nothing, no live row tells of work the server cannot confirm');
    check(shown.pageMounted, 'the page stays mounted but out of sight, so a draft survives and no widget shows an error of its own');
    check(shown.moving === 0, `nothing behind the screen keeps moving: ${shown.moving} animation(s)`);
    check(shown.focused && shown.label === shown.title, `the screen takes focus and is labelled with its title: ${shown.focused} ${shown.label}`);
    check(!shown.banner && shown.reloadButtons === 0, 'no reload is offered: a reload cannot help');
    const mono = await page.eval(`return getComputedStyle(document.querySelector(${JSON.stringify(`${SCREEN} .mono`)})).fontFamily`);
    check(/mono/i.test(mono), `the address is set in Geist Mono: ${mono}`);
    const violations = await page.axe({ include: SCREEN });
    check(violations.length === 0, `the screen has accessibility violations: ${JSON.stringify(violations)}`);

    // The tab says what the screen says, also when the person goes to another page meanwhile
    check((await page.eval(`return document.title`)).startsWith("Can't reach Claudio"), `the tab title follows the screen: ${await page.eval('return document.title')}`);
    // The shell is out of sight, so the route changes the way a link or the back button would
    await page.eval(`history.pushState(null, '', '/usage'); dispatchEvent(new PopStateEvent('popstate')); return true`);
    await page.sleep(1500);
    const during = await page.eval(`return { title: document.title, screen: !!document.querySelector(${JSON.stringify(SCREEN)}) }`);
    check(during.screen && during.title.startsWith("Can't reach Claudio"), `a page opened during the outage does not take the tab title: ${during.title}`);

    // Left alone it keeps trying, and the page is still the same document
    await page.sleep(2500);
    check(await page.eval(`return window.__claudioStay === true`), 'the page never reloads on its own');
    check(await page.eval(`return !!document.querySelector(${JSON.stringify(SCREEN)})`), 'and the screen stays while the server is away');
  } finally {
    await lift();
  }

  // ---- The server comes back: the app goes on, with no reload ----
  await screenGone('the app to resume once the server answers');
  check(await page.eval(`return window.__claudioStay === true`), 'the app resumed without a reload');
  const resumed = await page.waitFor(`return document.querySelector('main')?.innerText.trim().length > 10 && location.pathname === '/usage'`, { label: 'the Usage page' });
  check(resumed, 'the page the person went to is there');
  const title = await page.eval(`return document.title`);
  check(title.startsWith('Usage'), `and the tab is titled for it again, not for the screen or the page before: ${title}`);
  check(await page.eval(`return !document.querySelector(${JSON.stringify(BANNER)})`), 'a server of the same version offers no reload');
  page.takeErrors();

  // ---- "Retry now" does not wait for the back-off ----
  const liftAgain = await page.blockUrls(API);
  try {
    await page.click('.sidebar a[href="/"]');
    await page.waitFor(`return !!document.querySelector(${JSON.stringify(SCREEN)})`, { label: 'the unreachable screen, again' });
  } finally {
    await liftAgain();
  }
  await page.click(`${SCREEN} button`);
  await screenGone('Retry now to bring the app back');
  page.takeErrors();

  // ---- A page opened while the server is away ----
  const liftCold = await page.blockUrls(API);
  try {
    await page.goto('/', 0);
    await page.waitFor(`return !!document.querySelector(${JSON.stringify(SCREEN)})`, { label: 'the unreachable screen on a cold start' });
    check(await page.eval(`return !document.querySelector('#root .boot-failed')`), 'a cold start with the server away is the unreachable screen, not the boot fallback');
  } finally {
    await liftCold();
  }
  await screenGone('the cold start to resume');
  await homeReady();
  page.takeErrors();

  // ---- A menu open when the server goes: the screen is above it, and it acts on nothing ----
  await page.focus('.topbar-new .split-btn-more');
  await page.press('Enter');
  await page.waitFor(`return !!document.querySelector('[role=menu]')`, { label: 'the New chat menu opens' });
  const liftMenu = await page.blockUrls(API);
  try {
    // The browser saying it went offline makes the page look at once (the probe gets no answer)
    await page.eval(`dispatchEvent(new Event('offline')); return true`);
    await page.waitFor(`return !!document.querySelector(${JSON.stringify(SCREEN)})`, { label: 'the unreachable screen over an open menu' });
    const layered = await page.eval(`
      const screen = document.querySelector(${JSON.stringify(SCREEN)});
      const retry = screen.querySelector('button').getBoundingClientRect();
      const item = document.querySelector('[role=menu] [role=menuitem]');
      const box = item?.getBoundingClientRect();
      return {
        retryHit: screen.contains(document.elementFromPoint(retry.x + retry.width / 2, retry.y + retry.height / 2)),
        menuHit: box ? item.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)) : false,
        menuKept: !!item,
        focusInScreen: screen.contains(document.activeElement),
      };`);
    check(layered.retryHit, 'Retry takes the first click, not the menu left open');
    check(!layered.menuHit, 'the menu behind the screen cannot be reached');
    check(layered.focusInScreen, 'the screen holds the focus, not the menu');
    check(layered.menuKept, 'the menu is not torn down: what was open is still there when the server is');

    // A real Escape, before any other input (a browser lets a page refuse to close a dialog only
    // after a user activation): neither the screen nor the menu behind it goes
    await page.key('Escape');
    const afterEscape = await page.eval(`
      const screen = document.querySelector(${JSON.stringify(SCREEN)});
      return { open: !!screen?.open, shown: !!screen && getComputedStyle(screen).display !== 'none', menu: !!document.querySelector('[role=menu]') };`);
    check(afterEscape.open && afterEscape.shown, `Escape does not close the screen and leave a blank window: ${JSON.stringify(afterEscape)}`);
    check(afterEscape.menu, 'nor does it reach the menu behind the screen');

    // A real press on Retry (pointerdown and all) is not a press outside the menu
    await page.realClick(`${SCREEN} button`);
    check(await page.eval(`return !!document.querySelector('[role=menu]')`), 'pressing Retry does not dismiss the menu behind the screen');
  } finally {
    await liftMenu();
  }
  await screenGone('the app to resume after an outage over a menu');
  check(await page.eval(`return !!document.querySelector('[role=menu]')?.contains(document.activeElement)`), 'focus is back in the menu that had it');
  await page.key('Escape');
  page.takeErrors();

  // ---- A server that changed version while it was away ----
  // The update banner is the answer to a new version, and only that: it stays out of the way of the
  // unreachable screen and appears once the server answers
  const removeDeploy = await page.onNewDocument(FAKE_DEPLOY);
  try {
    await page.goto('/', 1500);
    await page.waitFor(`return !!document.querySelector(${JSON.stringify(BANNER)})`, { label: 'the banner for the other version' });
    const liftDeploy = await page.blockUrls(API);
    try {
      await page.click('.sidebar a[href="/chats"]');
      await page.waitFor(`return !!document.querySelector(${JSON.stringify(SCREEN)})`, { label: 'the unreachable screen with an update pending' });
      check(await page.eval(`return !document.querySelector(${JSON.stringify(BANNER)})`), 'the update banner steps aside while the server is unreachable');
    } finally {
      await liftDeploy();
    }
    await screenGone('the app to resume with an update pending');
    const banner = await page.waitFor(`return document.querySelector(${JSON.stringify(BANNER)})?.innerText ?? ''`, { label: 'the update banner after the recovery' });
    check(banner.includes('99.0.0'), `the update banner is back once the server answers: ${banner}`);
  } finally {
    await removeDeploy();
  }
  page.takeErrors();
};
