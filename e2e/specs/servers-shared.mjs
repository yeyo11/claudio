// What the Servers specs share (this file is not a spec: the runner only picks `*.spec.mjs`).
//
// The hub is the main wrapper, open (auth mode `none`) like every wrapper of the suite. The remote is a
// peer the harness starts with auth on and its LAN listener on, bound to one real address of the
// machine on a free port, so the hub reaches it the way a hub reaches a Claudio on the LAN: over TLS,
// with the certificate pinned. A listener never binds loopback, so the machine needs one non-loopback
// IPv4 address; any private one does, and the spec says so when there is none.
//
// The hub is shared by the whole shard: what a spec turns on or pairs, it takes away again.
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

/** The first non-loopback IPv4 address of the machine, a private one when there is a choice */
export function lanAddress() {
  const found = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.'))
    .map((entry) => entry.address);
  const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return found.find(isPrivate) ?? found[0] ?? null;
}

/**
 * `export const peerEnv = serversPeerEnv('remote')`: the remote is guarded by a token of this spec's own,
 * and listens on the local network at one address and one free port. Claudio's listener refuses to open
 * under auth mode `none`, so the token is what lets it listen at all.
 */
export function serversPeerEnv(name) {
  const token = randomBytes(24).toString('hex');
  return {
    [name]: async ({ freePort }) => {
      const ip = lanAddress();
      if (!ip) throw new Error('the Servers specs need an IPv4 address that is not loopback: Claudio\'s LAN listener never binds 127.0.0.1');
      return { CLAUDIO_AUTH_MODE: 'token', CLAUDIO_AUTH_TOKEN: token, CLAUDIO_LAN: 'on', CLAUDIO_LAN_PORT: String(await freePort('tcp')), CLAUDIO_LAN_BIND: ip };
    },
  };
}

/** Polls `probe` until it returns something truthy; the wait is a state of the app, never a pause */
export async function until(probe, what, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

/**
 * Waits for the remote's LAN listener to be up with a certificate, and returns what a hub dials:
 * its `https://` address and the certificate's fingerprint. The harness has started it with the
 * variables above, so `GET /lan` says `listening` once the certificate is made and the port bound.
 */
export async function remoteLan(peer) {
  const status = await until(async () => {
    const { body } = await peer.api.get('/lan');
    return body?.state === 'listening' && body.fingerprint ? body : null;
  }, "the remote's LAN listener");
  return { url: `https://${peer.env.CLAUDIO_LAN_BIND}:${peer.env.CLAUDIO_LAN_PORT}`, fingerprint: status.fingerprint };
}

/** The hub's Servers feature on, as Settings turns it on; the specs that start from the switch use the page instead */
export async function serversOn(api) {
  return api.put('/servers/settings', { enabled: true });
}

/**
 * Leaves the hub as it found it: every server forgotten (forced, since a remote that is gone cannot
 * give the token back), the switch off, so the next spec of the shard sees a Claudio that never heard of Servers.
 */
export async function resetServers(api) {
  await api.put('/servers/settings', { enabled: true }).catch(() => {});
  const { body } = await api.get('/servers').catch(() => ({ body: null }));
  for (const server of Array.isArray(body) ? body : []) await api.del(`/servers/${encodeURIComponent(server.id)}?force=true`).catch(() => {});
  await api.put('/servers/settings', { enabled: false }).catch(() => {});
}

/** A one-time code from the remote and the hub's `POST /servers` with it: the setup of a spec that is not about pairing */
export async function pairByCode(api, peer, lan, name = 'Studio') {
  const code = await peer.api.post('/server-links/code');
  if (code.status !== 200 && code.status !== 201) throw new Error(`the remote made no pairing code (${code.status} ${JSON.stringify(code.body)})`);
  const added = await api.post('/servers', { name, color: 'teal', monogram: 'ST', addresses: [{ url: lan.url, kind: 'lan' }], pairing: { kind: 'code', code: code.body.code } });
  if (added.status !== 201) throw new Error(`the hub did not pair (${added.status} ${JSON.stringify(added.body)})`);
  return added.body;
}

/**
 * Opens the menu behind a trigger the way a keyboard does: Radix opens on pointerdown, which a
 * synthetic click does not send.
 */
export async function openMenu(page, selector) {
  await page.focus(selector);
  await page.press('Enter');
  await page.waitFor(`return !!document.querySelector('[role=menu]')`, { label: `the menu of ${selector}` });
}

/** Signs the browser in to the guarded remote it is looking at: the token is what the sign-in screen would store */
export async function signIn(tab, token, path) {
  await tab.goto('/', 300);
  await tab.eval(`localStorage.setItem('claudio.token', ${JSON.stringify(token)}); return true`);
  await tab.goto(path, 1200);
}

/** The grouped fingerprint the way the pages write it, from `AB:CD:…` */
export const grouped = (fingerprint) => (fingerprint.replace(/[^0-9a-f]/gi, '').toUpperCase().match(/.{1,4}/g) ?? []).join(' ');
