// Servers, the first half of the visible flow (docs/plans/claudio-servers.md §12.3): two wrappers, the
// hub (the main one, open) and a remote with a token and its LAN listener on, reached over TLS.
//
// The person turns the feature on in Settings, and the shell grows an entry: the sidebar's Servers
// before Projects and the selector before the project's, which offers "Add a server" while there is
// none. They pair with an owner token: the dialog shows the certificate the address presented, the
// person compares it with the fingerprint on the remote's own LAN card (a wrong one blocks the pairing),
// and only then does the token leave. They remove the server, which gives the token back (the remote's
// Connected hubs is empty again), and pair once more with the code the remote's own Servers page shows,
// with its countdown. The hub never holds the owner token, and no answer carries a secret.
import { grouped, openMenu, remoteLan, resetServers, serversPeerEnv, signIn, until } from './servers-shared.mjs';

export const peers = ['remote'];
export const peerEnv = serversPeerEnv('remote');
// Two wrappers booting, a certificate, and two pairings
export const timeout = 240_000;

const SERVERS_SWITCH = '[role=switch][aria-label="Use servers"]';
const NAME = 'Studio';

export default async ({ page, api, check, peers: { remote }, capture }) => {
  const lan = await remoteLan(remote);
  const token = remote.env.CLAUDIO_AUTH_TOKEN;
  const hubs = async () => (await remote.api.get('/server-links')).body ?? [];
  // The remote's own page, a tab of its own so it stays loaded while the hub's moves
  const remoteTab = await remote.openTab();

  try {
    // ---------- off by default: nothing in the shell mentions servers ----------
    await page.goto('/settings/access#servers', 1500);
    await page.waitFor(`return !!document.querySelector(${JSON.stringify(SERVERS_SWITCH)})`, { label: 'the Servers switch in Access & safety' });
    check((await page.eval(`return document.querySelector(${JSON.stringify(SERVERS_SWITCH)}).getAttribute('aria-checked')`)) === 'false', 'Servers is off by default');
    check(await page.eval(`return !document.querySelector('.sidebar a[href="/servers"]') && !document.querySelector('.server-selector')`), 'off: no sidebar entry and no selector');

    // ---------- the switch turns it on, and the shell follows ----------
    await page.click(SERVERS_SWITCH, undefined, 300);
    await page.waitFor(`return document.querySelector(${JSON.stringify(SERVERS_SWITCH)})?.getAttribute('aria-checked') === 'true'`, { label: 'the switch on' });
    check((await api.get('/servers/settings')).body?.enabled === true, 'the switch reached the API');
    await page.waitFor(`return !!document.querySelector('.sidebar a[href="/servers"]') && !!document.querySelector('.server-selector')`, { label: 'the sidebar entry and the selector' });
    check(
      await page.eval(`
        const servers = document.querySelector('.sidebar a[href="/servers"]');
        const projects = document.querySelector('.sidebar a[href="/projects"]');
        return !!servers && !!projects && !!(servers.compareDocumentPosition(projects) & Node.DOCUMENT_POSITION_FOLLOWING)`),
      'the sidebar lists Servers before Projects',
    );
    check(
      await page.eval(`
        const selector = document.querySelector('.server-selector');
        const project = document.querySelector('.project-selector:not(.server-selector)');
        return !!selector && (!project || !!(selector.compareDocumentPosition(project) & Node.DOCUMENT_POSITION_FOLLOWING))`),
      "the server selector comes before the project's",
    );

    // ---------- with no server yet the selector offers to add one ----------
    await openMenu(page, '.server-selector');
    const menu = await page.text('[role=menu]');
    check(menu.includes('This server'), `the menu pins This server (${menu.replaceAll('\n', ' | ')})`);
    check(menu.includes('Add a server') && !menu.includes('All servers'), 'with no server the way on is Add a server');
    await page.click('[role=menu] [role=menuitem]', 'Add a server', 800);
    await page.waitFor(`return location.pathname === '/servers' && !!document.querySelector('[data-testid=server-add-form]')`, { label: 'the Add a server dialog, opened by the selector' });

    // ---------- the remote's own LAN card says what its certificate is ----------
    await signIn(remoteTab, token, '/settings/access#remote');
    await remoteTab.waitFor(`return !!document.querySelector('[data-testid=lan-fingerprint] .lan-fingerprint-value')`, { label: "the remote's LAN card fingerprint" });
    const card = await remoteTab.text('[data-testid=lan-fingerprint] .lan-fingerprint-value');
    check(card.replace(/\s+/g, ' ').trim() === grouped(lan.fingerprint), `the LAN card shows the certificate's fingerprint, in groups (${card})`);
    check(await remoteTab.eval(`return document.querySelector('[data-testid=lan-fingerprint] .lan-fingerprint-value').classList.contains('mono')`), 'the fingerprint is in mono: a machine-read literal');
    const cardText = await remoteTab.text('main');
    check(cardText.includes('HTTPS with a self-signed certificate') && cardText.includes('Traffic on this network is encrypted'), 'the LAN card says HTTPS with a self-signed certificate');
    check(!/unencrypted|not encrypted/i.test(cardText), 'and no longer says the connection is unencrypted');

    // ---------- pair with an owner token: the certificate is compared first ----------
    await page.click('[role=dialog] [role=tab]', 'Owner token', 300);
    await page.fill('[data-testid=server-address-row] input', lan.url);
    await page.fill('[data-testid=server-token]', token);
    await page.fill('[data-testid=server-name]', NAME);
    await page.click('[data-testid=server-add-submit]', undefined, 600);
    await page.waitFor(`return !!document.querySelector('[data-testid=server-confirm]')`, { label: 'the certificate to compare' });
    const shown = await page.text('[data-testid=server-fingerprint]');
    check(shown.replace(/\s+/g, ' ').trim() === grouped(lan.fingerprint), `the dialog shows the certificate the address presented (${shown})`);
    check((await api.get('/servers')).body.length === 0, 'nothing is paired before the person says yes');
    check((await hubs()).length === 0, 'and the remote has not given a token yet');
    check(await page.eval(`return !document.querySelector('[data-testid=server-confirm-authority]')`), 'a LAN address does not claim a public authority signed it');

    // A fingerprint that differs blocks the pairing
    await page.fill('[data-testid=server-fingerprint-typed]', 'AAAA BBBB CCCC DDDD');
    await page.waitFor(`return document.querySelector('[data-testid=server-compare]')?.classList.contains('tone-bad')`, { label: 'the differing fingerprint flagged' });
    check(await page.eval(`return document.querySelector('[data-testid=server-confirm-pair]').disabled`), 'a fingerprint that differs disables the pairing');
    // The one on the remote's card matches
    await page.fill('[data-testid=server-fingerprint-typed]', card.trim());
    await page.waitFor(`return document.querySelector('[data-testid=server-compare]')?.classList.contains('tone-ok')`, { label: 'the matching fingerprint accepted' });
    await page.click('[data-testid=server-confirm-pair]', undefined, 800);
    await page.waitFor(`return !document.querySelector('[role=dialog]') && !!document.querySelector('[data-testid=server-row]')`, { label: 'the paired server in the list' });
    const row = await page.eval(`
      const el = document.querySelector('[data-testid=server-row]');
      return { name: el.querySelector('.server-row-name').innerText, id: el.dataset.serverId, mono: !!el.querySelector('.server-row-address .mono') }`);
    check(row.name === NAME, `the row carries the name that was typed (${row.name})`);
    const listed = (await api.get('/servers')).body;
    check(listed.length === 1 && listed[0].id === row.id, 'the hub has one server');
    check(JSON.stringify(listed).includes(token) === false, "the hub's list never carries the owner token");
    check(listed[0].addresses[0].url === lan.url, 'its address is the remote LAN address over https');
    const links = await hubs();
    check(links.length === 1 && !JSON.stringify(links).includes(token), `the remote lists one hub, with no secret (${JSON.stringify(links)})`);

    // ---------- remove: the token is given back on the remote ----------
    await openMenu(page, `button[aria-label="Actions for ${NAME}"]`);
    await page.click('[role=menu] [role=menuitem]', 'Remove', 600);
    await page.waitFor(`return document.querySelector('[role=dialog]')?.innerText.includes('gives back its token')`, { label: 'the Remove confirmation, which says the token is revoked' });
    await page.click('[role=dialog] button', 'Remove', 800);
    await page.waitFor(`return !document.querySelector('[data-testid=server-row]')`, { label: 'the row gone' });
    check((await api.get('/servers')).body.length === 0, 'the hub forgot the server');
    check((await hubs()).length === 0, "removing it revoked the hub's token on the remote: Connected hubs is empty");

    // ---------- pair with the code the remote's own page shows ----------
    check((await remote.api.put('/servers/settings', { enabled: true })).status === 200, "the remote's own Servers is on, as its page needs");
    await remoteTab.goto('/servers', 1200);
    await remoteTab.click('[data-testid=server-link-show]', undefined, 800);
    await remoteTab.waitFor(`return !!document.querySelector('[data-testid=server-link-code-value]')?.innerText.trim()`, { label: 'the pairing code' });
    const code = (await remoteTab.text('[data-testid=server-link-code-value]')).trim();
    check(/^[A-Z2-9]{4} [A-Z2-9]{4}$/.test(code), `the code is eight characters in two groups of four (${code})`);
    check((await remoteTab.text('[data-testid=server-link-countdown]')).includes('Valid for'), 'the code counts down its 5 minutes');
    check(await remoteTab.eval(`return document.querySelector('[data-testid=server-link-code-value]').classList.contains('mono')`), 'the code is mono');
    check(await remoteTab.eval(`return !!document.querySelector('.server-connect [data-testid=lan-fingerprint]')`), "the page shows this Claudio's fingerprint below the code, to compare");

    await page.goto('/servers', 1200);
    await page.click('[data-testid=servers-add-empty]', undefined, 600);
    await page.fill('[data-testid=server-address-row] input', lan.url);
    await page.fill('[data-testid=server-code]', code);
    await page.fill('[data-testid=server-name]', NAME);
    await page.click('[data-testid=server-add-submit]', undefined, 600);
    await page.waitFor(`return !document.querySelector('[role=dialog]') && !!document.querySelector('[data-testid=server-row]')`, { label: 'the server paired by code' });
    check((await api.get('/servers')).body.length === 1, 'the code paired it');
    // A code is single use: the same one again is refused, and nothing is added
    const again = await api.post('/servers', { name: 'Again', addresses: [{ url: lan.url, kind: 'lan' }], pairing: { kind: 'code', code: code.replace(' ', '') } });
    check(again.status >= 400 && (await api.get('/servers')).body.length === 1, `a code works once (${again.status})`);

    // The remote's page now lists the hub that holds a token of it
    await remoteTab.goto('/servers', 1200);
    await remoteTab.waitFor(`return document.querySelectorAll('[data-testid=server-hub]').length === 1`, { label: 'Connected hubs lists the hub' });
    await until(async () => (await hubs()).length === 1, 'the remote to hold the hub');
  } catch (error) {
    await capture('servers-pairing').catch(() => {});
    throw error;
  } finally {
    await resetServers(api);
    await remote.api.put('/servers/settings', { enabled: false }).catch(() => {});
  }
};
