// Settings → Access & safety → Remote access, and the layered settings in Runs & spend
// (docs/plans/tunnel.md, task `web`; docs/plans/settings-ia.md §6.7, §6.8), and the card "On the local
// network" above the tunnel's (docs/plans/lan-access.md, task `lan-web`).
//
// The suite's wrapper runs with authentication off, and its `tailscale` is the core tests' fake
// (e2e/run.mjs: TAILSCALE_BIN), which reports a ready node. So against the real server the section can
// only say why the tunnel stays closed. The open tunnel and the states of a Tailscale that is not
// ready are a fake too: a script that runs before the app answers `/api/tunnel` (and says the guard
// is on) the way the server does; the section, its QR code and its buttons are the real ones. The LAN
// card's states are a fake the same way: the suite never opens a listener on the machine's network,
// so a script answers `/api/lan` and records what the card sends.

// The section, not the panel: Access & safety has other switches (read-only first) above it
const TAB = '#remote';
const NODE = 'claudio-test.tail0000.ts.net';
const FAKE_URL = `https://${NODE}:8444`;
const READY = { state: 'ready', version: '1.102.4', host: NODE, reason: null };

/** Answers the tunnel's routes from `window.__tunnel`, starting at `initial`; everything else is the server's. */
const fakeTunnel = (initial) => `(() => {
  const real = window.fetch.bind(window);
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  window.__tunnel = ${JSON.stringify(initial)};
  window.__tunnelCalls = [];
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const method = (init.method ?? 'GET').toUpperCase();
    if (url.pathname === '/api/tunnel' && method === 'GET') return json(window.__tunnel);
    if (url.pathname === '/api/tunnel/stop') {
      window.__tunnelCalls.push('stop');
      window.__tunnel = { ...window.__tunnel, state: 'stopped', url: null, since: null };
      return json(window.__tunnel);
    }
    if (url.pathname === '/api/security/auth' && method === 'GET') {
      const res = await real(input, init);
      return json({ ...(await res.json()), mode: 'token' });
    }
    return real(input, init);
  };
})();`;

const LAN_ADDRESSES = [
  { ip: '192.168.0.30', host: null, url: 'http://192.168.0.30:8791' },
  { ip: '192.168.0.30', host: 'yeyo-pc.local', url: 'http://yeyo-pc.local:8791' },
];

/** The LAN status of the server's wording, for a state; the card is drawn from it whole. */
const lanStatus = (state, extra = {}) => ({
  state,
  reason: null,
  port: 8791,
  addresses: state === 'listening' ? LAN_ADDRESSES : [],
  interfaces: [
    { name: 'wlp2s0', ip: '192.168.0.30' },
    { name: 'eth0', ip: '10.0.0.4' },
  ],
  settings: { enabled: state !== 'off', port: 8791, bind: 'all' },
  available: true,
  portTaken: null,
  ...extra,
});

/**
 * Answers the LAN routes from `window.__lan`, starting at `initial`, and says the guard is on. A PUT
 * to the settings is kept in `window.__lanCalls` and applied the way the server would: the switch
 * turns it on or off, a new port ends a taken one. With `onEnable`, turning it on lands in that status
 * instead (a port found taken).
 */
const fakeLan = (initial, onEnable = null) => `(() => {
  const real = window.fetch.bind(window);
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  window.__lan = ${JSON.stringify(initial)};
  window.__lanCalls = [];
  const addresses = ${JSON.stringify(LAN_ADDRESSES)};
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const method = (init.method ?? 'GET').toUpperCase();
    if (url.pathname === '/api/lan' && method === 'GET') return json(window.__lan);
    if (url.pathname === '/api/lan/settings' && method === 'PUT') {
      const body = JSON.parse(init.body);
      window.__lanCalls.push(body);
      if (body.enabled === true && ${JSON.stringify(onEnable)}) {
        window.__lan = ${JSON.stringify(onEnable)};
        return json(window.__lan);
      }
      const settings = { ...window.__lan.settings, ...body };
      const on = settings.enabled === true;
      window.__lan = { ...window.__lan, settings, port: settings.port, state: on ? 'listening' : 'off', addresses: on ? addresses : [], portTaken: null, reason: null };
      return json(window.__lan);
    }
    if (url.pathname === '/api/security/auth' && method === 'GET') {
      const res = await real(input, init);
      return json({ ...(await res.json()), mode: 'token' });
    }
    return real(input, init);
  };
})();`;

const status = (state, extra = {}) => ({
  state,
  url: state === 'active' ? FAKE_URL : null,
  since: state === 'active' ? new Date().toISOString() : null,
  reason: null,
  enabled: true,
  managed: false,
  tailscale: READY,
  port: 8444,
  portSource: 'default',
  portTaken: null,
  settings: { startWithClaudio: false, port: 8444 },
  ...extra,
});

export default async ({ page, api, check }) => {
  // A new document each time, so the fake injected with onNewDocument runs: from the same path, an
  // address that differs only in its #section is a same-document navigation that loads nothing
  const openRemote = async () => {
    await page.goto('/settings', 0);
    await page.goto('/settings/access#remote', 1500);
  };

  // ---- The real server, with the guard open ----
  const refused = await api.post('/tunnel/start');
  check(refused.status === 409, `the server refuses a tunnel while authentication is off (got ${refused.status})`);
  const real = (await api.get('/tunnel')).body;
  check(real.tailscale?.state === 'ready' && real.tailscale.host === NODE, `the server read the fake tailscale (${JSON.stringify(real.tailscale)})`);

  await page.goto('/settings/access#remote', 1500);
  await page.waitFor(`return !!document.querySelector('[data-testid=tunnel-auth-required]')`, { label: 'the authentication warning' });
  const open = await page.text(TAB);
  check(open.includes('Turn on authentication first'), 'the section says why the tunnel stays closed');
  check(!(await page.eval(`return !!document.querySelector('[data-testid=tunnel-start]')`)), 'no start button while the guard is open');
  check(/closed/i.test(open), 'the state is said in words');
  await page.click(`${TAB} a`, 'Go to Access', 1200);
  check((await page.eval('return location.pathname + location.hash')) === '/settings/access#access', 'the warning leads to Access, on the same screen');

  // "Start with Claudio" is saved, and a change made elsewhere reaches the page through the feed
  const before = (await api.get('/tunnel')).body.settings.startWithClaudio;
  try {
    await openRemote();
    await page.click(`${TAB} [role=switch]`, undefined, 800);
    check((await api.get('/tunnel')).body.settings.startWithClaudio === !before, 'the switch saved the setting');
    await api.put('/tunnel/settings', { startWithClaudio: before });
    await page.waitFor(`return document.querySelector('${TAB} [role=switch]')?.getAttribute('aria-checked') === ${JSON.stringify(String(before))}`, {
      label: 'the switch following tunnel.changed',
    });
  } finally {
    await api.put('/tunnel/settings', { startWithClaudio: before });
  }

  // ---- A fake open tunnel ----
  let remove = await page.onNewDocument(fakeTunnel(status('active')));
  try {
    await openRemote();
    await page.waitFor(`return !!document.querySelector('[data-testid=tunnel-address]')`, { label: 'the open address' });
    const url = await page.eval(`return document.querySelector('[data-testid=tunnel-url]')?.textContent ?? ''`);
    check(url === FAKE_URL, `the address is shown (got ${url})`);
    check(await page.eval(`return getComputedStyle(document.querySelector('[data-testid=tunnel-url]')).fontFamily.includes('Mono')`), 'the address is in mono');
    check(await page.eval(`return !!document.querySelector('${TAB} svg.qr[role=img][aria-label*="ts.net:8444"]')`), 'a QR code of the address is drawn, and named');
    check(await page.eval(`return !!document.querySelector('${TAB} button[aria-label="Copy address"]')`), 'the address can be copied');
    check(/open/i.test(await page.text(`${TAB} .card-head .badge`)), 'the state reads open');
    await page.click('[data-testid=tunnel-stop]', undefined, 800);
    await page.waitFor(`return !!document.querySelector('[data-testid=tunnel-start]')`, { label: 'the start button after closing' });
    check((await page.eval('return window.__tunnelCalls.join()')) === 'stop', 'the stop button asked the server once');
    check(!(await page.eval(`return !!document.querySelector('[data-testid=tunnel-address]')`)), 'the address is gone once closed');
  } finally {
    await remove();
  }

  // ---- A machine without Tailscale ----
  const missing = { state: 'missing', version: null, host: null, reason: { code: 'tunnel.tailscaleMissing', text: 'No tailscale' } };
  remove = await page.onNewDocument(fakeTunnel(status('stopped', { tailscale: missing })));
  try {
    await openRemote();
    await page.waitFor(`return !!document.querySelector('${TAB} [data-testid=tunnel-tailscale-missing] .state-illustrated')`, { label: 'the not-installed state' });
    const text = await page.text(TAB);
    check(text.includes('Tailscale is not installed'), 'the section says Tailscale is missing');
    check(await page.eval(`return !!document.querySelector('${TAB} a[href="https://tailscale.com/download"]')`), 'and links to where it is installed');
    check(!(await page.eval(`return !!document.querySelector('${TAB} [data-testid=tunnel-start], ${TAB} [role=switch]')`)), 'and offers neither the start button nor the start-with-Claudio switch');
  } finally {
    await remove();
  }

  // ---- Tailscale installed but signed out ----
  const signedOut = { state: 'loggedOut', version: '1.102.4', host: null, reason: { code: 'tunnel.tailscaleLoggedOut', text: 'Signed out' } };
  remove = await page.onNewDocument(fakeTunnel(status('stopped', { tailscale: signedOut })));
  try {
    await openRemote();
    await page.waitFor(`return !!document.querySelector('${TAB} [data-testid=tunnel-tailscale-loggedOut]')`, { label: 'the signed-out state' });
    const text = await page.text(TAB);
    check(text.includes('Tailscale is not signed in') && text.includes('tailscale up'), 'the section says to run tailscale up');
    check(!(await page.eval(`return !!document.querySelector('${TAB} .state-illustrated')`)), 'with no illustration beside the warning');
  } finally {
    await remove();
  }

  // ---- On the local network: the real server, with the guard open ----
  const lan = (await api.get('/lan')).body;
  check(lan.state === 'off' || lan.state === 'refused', `the suite's server is not listening on the network (${lan.state})`);
  await page.goto('/settings/access#remote', 1500);
  await page.waitFor(`return !!document.querySelector('[data-setting="lan.enabled"] [role=switch]')`, { label: 'the local network card' });
  check((await page.text(TAB)).includes('On the local network'), 'the section opens with the local network card');
  check(
    await page.eval(`return document.querySelector('${TAB} .card')?.textContent.includes('On the local network') === true`),
    'the local network card comes before the tunnel',
  );
  check(await page.eval(`return document.querySelector('[data-setting="lan.enabled"] [role=switch]').disabled`), 'the switch is disabled while the guard is open');
  for (const id of ['lan.enabled', 'lan.port', 'lan.bind']) {
    check(await page.eval(`return !!document.querySelector('[data-setting="${id}"] .pref-row-change')`), `${id} has its Changed · Reset slot`);
  }
  check(!(await page.eval(`return !!document.querySelector('[data-testid=lan-addresses], [data-testid=lan-http-notice]')`)), 'nothing is offered or warned about while it is not listening');

  // ---- A fake LAN listener: the addresses, one QR at a time, and the notice ----
  let removeLan = await page.onNewDocument(fakeLan(lanStatus('listening')));
  try {
    await openRemote();
    await page.waitFor(`return !!document.querySelector('[data-testid=lan-addresses]')`, { label: 'the LAN addresses' });
    const urls = await page.eval(`return [...document.querySelectorAll('[data-testid=lan-url]')].map((a) => a.textContent)`);
    check(urls.join() === 'http://192.168.0.30:8791,http://yeyo-pc.local:8791', `both addresses are listed (${urls})`);
    check(await page.eval(`return [...document.querySelectorAll('[data-testid=lan-url]')].every((a) => getComputedStyle(a).fontFamily.includes('Mono'))`), 'the addresses are in mono');
    check(/listening/i.test(await page.text(`${TAB} .card-head .badge`)), 'the state reads listening');
    check(await page.eval(`return !!document.querySelector('[data-testid=lan-http-notice]')`), 'the plain HTTP notice is on screen');
    check((await page.text('[data-testid=lan-http-notice]')).includes('Tailscale'), 'and sends a phone to Tailscale');
    check(await page.eval(`return document.querySelectorAll('${TAB} button[aria-label^="Copy http://"]').length === 2`), 'each address can be copied');
    check(!(await page.eval(`return !!document.querySelector('[data-testid=lan-qr]')`)), 'no QR code before one is asked for');
    await page.click('[data-testid=lan-qr-toggle]', undefined, 500);
    check(await page.eval(`return document.querySelectorAll('.sheet [data-testid=lan-qr] svg.qr[role=img][aria-label*="192.168.0.30:8791"]').length === 1`), 'the QR code of the first address is drawn in a sheet, and named');
    await page.eval(`document.querySelectorAll('[data-testid=lan-qr-toggle]')[1].click(); return true`);
    await page.waitFor(`return document.querySelectorAll('[data-testid=lan-qr]').length === 1 && !!document.querySelector('[data-testid=lan-qr] svg.qr[aria-label*="yeyo-pc.local"]')`, { label: 'the second QR replacing the first' });
    check(true, 'only one QR is open at a time');
    // Not a notification: the card's three settings are all there
    check(await page.eval(`return !!document.querySelector('[data-testid=lan-port]') && !!document.querySelector('[data-testid=lan-bind]')`), 'the port and the interfaces are on the card');
  } finally {
    await removeLan();
  }

  // ---- A fake LAN listener, off, turned on from the switch ----
  removeLan = await page.onNewDocument(fakeLan(lanStatus('off')));
  try {
    await openRemote();
    await page.waitFor(`return !!document.querySelector('[data-setting="lan.enabled"] [role=switch]')`, { label: 'the switch' });
    check(/off/i.test(await page.text(`${TAB} .card-head .badge`)), 'the state reads off');
    check(!(await page.eval(`return !!document.querySelector('[data-testid=lan-addresses], [data-testid=lan-http-notice]')`)), 'no address and no notice while it is off');
    await page.click('[data-setting="lan.enabled"] [role=switch]', undefined, 600);
    await page.waitFor(`return !!document.querySelector('[data-testid=lan-addresses]')`, { label: 'the addresses once on' });
    check((await page.eval('return JSON.stringify(window.__lanCalls)')) === '[{"enabled":true}]', 'the switch sent the one setting that moved');
    check(await page.eval(`return !!document.querySelector('[data-testid=lan-http-notice]')`), 'the notice shows with the card on');
  } finally {
    await removeLan();
  }

  // ---- A fake LAN listener, Needs a sign-in method ----
  removeLan = await page.onNewDocument(fakeLan(lanStatus('refused', { reason: { code: 'lan.authRequired', text: 'x' } })));
  try {
    await openRemote();
    await page.waitFor(`return !!document.querySelector('[data-testid=lan-auth-required]')`, { label: 'the refused state' });
    check(/sign-in method/i.test(await page.text(`${TAB} .card-head .badge`)), 'the state says it needs a sign-in method');
    check(await page.eval(`return !document.querySelector('[data-setting="lan.enabled"] [role=switch]').disabled`), 'the switch is on and can still be turned off');
    check(await page.eval(`return !!document.querySelector('[data-testid=lan-auth-required] a[href="/settings/access#access"]')`), 'and the card links to Access');
    check(!(await page.eval(`return !!document.querySelector('[data-testid=lan-http-notice]')`)), 'no notice: nothing travels');
  } finally {
    await removeLan();
  }

  // ---- A fake LAN listener, Port in use: the field is focused, and the next free port is one press away ----
  const taken = lanStatus('port-in-use', { portTaken: { port: 8791, holder: '0.0.0.0:8791', nextFree: 8792 } });
  // Off until the person turns it on and the listener finds the port taken: the move the card follows
  removeLan = await page.onNewDocument(fakeLan(lanStatus('off'), taken));
  try {
    await openRemote();
    await page.waitFor(`return !!document.querySelector('[data-setting="lan.enabled"] [role=switch]')`, { label: 'the switch' });
    await page.click('[data-setting="lan.enabled"] [role=switch]', undefined, 600);
    await page.waitFor(`return !!document.querySelector('[data-testid=lan-port-in-use]')`, { label: 'the port in use state' });
    const text = await page.text('[data-testid=lan-port-in-use]');
    check(text.includes('Another program holds port 8791') && text.includes('0.0.0.0:8791'), 'it names the port and what holds it');
    check(await page.eval(`return getComputedStyle(document.querySelector('[data-testid=lan-port-holder] code')).fontFamily.includes('Mono')`), 'the holder is in mono');
    check(/port in use/i.test(await page.text(`${TAB} .card-head .badge`)), 'the state is said in words');
    check(await page.eval(`return document.activeElement === document.querySelector('[data-testid=lan-port] input')`), 'the port field is focused');
    await page.click('[data-testid=lan-use-next-port]', undefined, 600);
    await page.waitFor(`return !!document.querySelector('[data-testid=lan-addresses]')`, { label: 'listening on the next port' });
    check((await page.eval('return JSON.stringify(window.__lanCalls)')) === '[{"enabled":true},{"port":8792}]', 'Use the next free port sent the port, and only that');
  } finally {
    await removeLan();
  }

  // ---- A fake LAN listener, Failed: the error in mono ----
  const failed = lanStatus('failed', { reason: { code: 'lan.listenFailed', params: { detail: 'EACCES: permission denied' }, text: 'x' } });
  removeLan = await page.onNewDocument(fakeLan(failed));
  try {
    await openRemote();
    await page.waitFor(`return !!document.querySelector('[data-testid=lan-failed]')`, { label: 'the failed state' });
    check(await page.eval(`return getComputedStyle(document.querySelector('[data-testid=lan-failed] code')).fontFamily.includes('Mono')`), 'the error is in mono');
    check((await page.text('[data-testid=lan-failed]')).includes('EACCES: permission denied'), 'it says what the system said');
    check(await page.eval(`return !!document.querySelector('[data-testid=lan-retry]') && !!document.querySelector('[data-testid=lan-http-notice]')`), 'it offers a retry, and the notice stays');
  } finally {
    await removeLan();
  }

  // ---- The phone: the card stacks, the QR opens in a sheet, and every target is 44 px ----
  removeLan = await page.onNewDocument(fakeLan(lanStatus('listening')));
  try {
    await page.viewport(390, 844);
    await page.emulateTouch(true);
    await openRemote();
    await page.waitFor(`return !!document.querySelector('[data-testid=lan-addresses]')`, { label: 'the LAN addresses on a phone' });
    const small = await page.eval(
      `return [...document.querySelectorAll('[data-setting="lan.enabled"] [role=switch], [data-testid=lan-addresses] .lan-address-url, [data-testid=lan-addresses] .btn, [data-testid=lan-addresses] .icon-btn, [data-testid=lan-bind] .segment, [data-testid=lan-port] .btn')].filter((el) => { const r = el.getBoundingClientRect(); return r.height < 44 && r.width > 0 }).map((el) => el.className + ' ' + Math.round(el.getBoundingClientRect().height))`,
    );
    check(small.length === 0, `a phone's targets are 44 px (${small})`);
    check(await page.eval(`return document.documentElement.scrollWidth <= window.innerWidth`), 'the card does not scroll sideways');
    await page.click('[data-testid=lan-qr-toggle]', undefined, 700);
    check(await page.eval(`return !!document.querySelector('.sheet [data-testid=lan-qr] svg.qr')`), 'the QR code opens in a sheet');
    check(await page.eval(`return document.querySelectorAll('svg.qr').length === 1`), 'and it is the only one');
  } finally {
    await page.emulateTouch(false);
    await page.viewport(1280, 900);
    await removeLan();
  }

  // ---- The layered settings in Runs & spend ----
  const settings = (await api.get('/settings/app')).body;
  check(Array.isArray(settings.allowedHosts) && typeof settings.sources === 'object', 'the settings come with their sources');
  if (settings.sources.maxConcurrentRuns !== 'env') {
    const next = settings.maxConcurrentRuns === 5 ? 6 : 5;
    try {
      await page.goto('/settings/runs#runs', 1500);
      const field = '[role=tabpanel] input[aria-label="Runs at once"]';
      await page.fill(field, String(next));
      // The Runs section's own save, in the form that holds the field
      await page.eval(`document.querySelector('${field}').closest('form').querySelector('button[type=submit]').click(); return true`);
      await page.waitFor(`return fetch('/api/settings/app').then(r => r.json()).then(s => s.maxConcurrentRuns === ${next})`, { label: 'the new run limit saved' });
      check(true, 'the run limit was saved from Runs & spend');
    } finally {
      await api.put('/settings/app', { maxConcurrentRuns: settings.maxConcurrentRuns });
    }
  }
};
