// Servers, when the remote is no longer who was paired (docs/plans/claudio-servers.md §12.2 E3, §12.3).
//
// The remote is reinstalled: its data is the same but its identity file is gone, so the machine at the
// address answers as someone else. The hub says so in a word, offers Pair again instead of Open, and
// pairs in place with a new code: the server keeps its id, name, colour and address. Then the remote's
// own Servers page revokes the hub (Connected hubs → Revoke), the row says Pair again and why, and this
// time the person pairs with the owner token, comparing the certificate first, as in Add.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { grouped, pairByCode, remoteLan, resetServers, serversOn, serversPeerEnv, signIn, until } from './servers-shared.mjs';

export const peers = ['remote'];
export const peerEnv = serversPeerEnv('remote');
export const timeout = 300_000;

const NAME = 'Studio';

export default async ({ page, api, check, peers: { remote }, capture }) => {
  const lan = await remoteLan(remote);
  const token = remote.env.CLAUDIO_AUTH_TOKEN;
  const remoteTab = await remote.openTab();
  const row = () => `[data-testid=server-row]`;
  const status = () => page.eval(`return document.querySelector('[data-testid=server-row]')?.dataset.status ?? null`);
  /** A reading, taken the way the page takes one: Test connection, then closing it */
  const read = async () => {
    await page.click('[data-testid=server-test-open]', undefined, 300);
    await page.waitFor(`return document.querySelectorAll('[role=dialog] .server-check[data-ok]').length === 4`, { label: 'the four checks' });
    await page.click('[role=dialog] button', 'Close', 300);
  };

  try {
    check((await serversOn(api)).status === 200, 'Servers is on');
    await pairByCode(api, remote, lan, NAME);
    await page.goto('/servers', 1500);
    await page.waitFor(`return !!document.querySelector(${JSON.stringify(row())})`, { label: 'the server row' });
    await read();
    await page.waitFor(`return document.querySelector('[data-testid=server-row]')?.dataset.status === 'connected'`, { label: 'Connected' });
    check(await page.eval(`return !!document.querySelector('[data-testid=server-open]') && !document.querySelector('[data-testid=server-pair-again]')`), 'a connected server offers Open');

    // ---------- the remote is reinstalled: same data, a new identity ----------
    remote.stop();
    rmSync(join(remote.dirs.dataDir, 'instance.json'), { force: true });
    await remote.start();
    await remoteLan(remote);
    await read();
    await page.waitFor(`return document.querySelector('[data-testid=server-row]')?.dataset.status === 'identity-changed'`, { label: 'Identity changed', timeout: 30_000 });
    const changed = await page.text(row());
    check(changed.includes('Identity changed') && changed.includes('not the one that was paired'), `the row says so in words, and why (${changed.replaceAll('\n', ' | ')})`);
    check(await page.eval(`return !document.querySelector('[data-testid=server-open]') && !!document.querySelector('[data-testid=server-pair-again]')`), 'Pair again replaces Open');
    const before = (await api.get('/servers')).body[0];

    // ---------- pair again in place, with a new code ----------
    await page.click('[data-testid=server-pair-again]', undefined, 500);
    await page.waitFor(`return !!document.querySelector('[role=dialog] [data-testid=server-code]')`, { label: 'the Pair again dialog' });
    check((await page.text('[role=dialog]')).includes('may have been reinstalled'), 'the dialog says what happened');
    const code = (await remote.api.post('/server-links/code')).body.code;
    await page.fill('[data-testid=server-code]', code);
    await page.click('[data-testid=server-pair-again-submit]', undefined, 800);
    await page.waitFor(`return !document.querySelector('[role=dialog]')`, { label: 'the dialog closed' });
    const after = (await api.get('/servers')).body;
    check(after.length === 1 && after[0].id === before.id, 'the server keeps its id: it was paired again, not added');
    check(after[0].name === before.name && after[0].color === before.color && after[0].monogram === before.monogram, 'and its name, colour and initials');
    check(JSON.stringify(after[0].addresses) === JSON.stringify(before.addresses), 'and its addresses');
    check(after[0].identity.instanceId !== before.identity.instanceId, 'but it now holds the new identity');
    await read();
    await page.waitFor(`return document.querySelector('[data-testid=server-row]')?.dataset.status === 'connected'`, { label: 'Connected again' });
    check((await remote.api.get('/server-links')).body.length === 1, 'the remote holds one token of this hub, not two');

    // ---------- revoked from the remote's own page ----------
    check((await remote.api.put('/servers/settings', { enabled: true })).status === 200, "the remote's own Servers is on, as its page needs");
    await signIn(remoteTab, token, '/servers');
    await remoteTab.waitFor(`return document.querySelectorAll('[data-testid=server-hub]').length === 1`, { label: 'Connected hubs lists the hub' });
    await remoteTab.click('[data-testid=server-hub-revoke]', undefined, 500);
    await remoteTab.click('[role=dialog] button', 'Revoke', 800);
    await remoteTab.waitFor(`return document.querySelectorAll('[data-testid=server-hub]').length === 0`, { label: 'the hub revoked' });
    check((await remote.api.get('/server-links')).body.length === 0, 'the remote lists no hub now');

    await read();
    await page.waitFor(`return document.querySelector('[data-testid=server-row]')?.dataset.status === 'needs-pairing'`, { label: 'Pair again, for a revoked token' });
    check((await page.text(row())).includes('no longer accepted'), 'the row says the token is no longer accepted');

    // ---------- pair again with the owner token: the certificate is compared first ----------
    await page.click('[data-testid=server-pair-again]', undefined, 500);
    await page.waitFor(`return !!document.querySelector('[role=dialog] [role=tab]')`, { label: 'the Pair again dialog' });
    check((await page.text('[role=dialog]')).includes('was revoked or is no longer accepted'), 'the dialog says the token was revoked');
    await page.click('[role=dialog] [role=tab]', 'Owner token', 300);
    await page.fill('[data-testid=server-token]', token);
    await page.click('[data-testid=server-pair-again-submit]', undefined, 600);
    await page.waitFor(`return !!document.querySelector('[data-testid=server-confirm]')`, { label: 'the certificate to compare' });
    check((await page.text('[data-testid=server-fingerprint]')).replace(/\s+/g, ' ').trim() === grouped(lan.fingerprint), 'the dialog shows the certificate the address presented');
    check((await remote.api.get('/server-links')).body.length === 0, 'nothing is sent before the person says yes');
    await page.click('[data-testid=server-confirm-pair]', undefined, 800);
    await page.waitFor(`return !document.querySelector('[role=dialog]')`, { label: 'the dialog closed' });
    await until(async () => (await remote.api.get('/server-links')).body.length === 1, 'the remote to hold a new token');
    check((await api.get('/servers')).body[0].id === before.id, 'still the same server');
    await read();
    await page.waitFor(`return document.querySelector('[data-testid=server-row]')?.dataset.status === 'connected'`, { label: 'Connected again' });
    check((await status()) === 'connected', 'paired again, and Open is back');
  } catch (error) {
    await capture('servers-pair-again').catch(() => {});
    throw error;
  } finally {
    await resetServers(api);
    await remote.api.put('/servers/settings', { enabled: false }).catch(() => {});
  }
};
