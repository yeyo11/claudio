// Servers, the second half of the visible flow (docs/plans/claudio-servers.md §12.3): the hub drives a
// remote, a second wrapper with a token and its LAN listener on, paired before the spec starts.
//
// The selector lists This server pinned and the remote with its status in words. Picking the remote on
// a list page lands on the same page there; on a page that names a record it stays when the remote has
// that record (a task whose key both have) and goes to the list when it has not. Inside the remote the
// status bar names it and the way back, and neither the selector nor the Servers entry is drawn (one
// hop). A write made there lands on the remote and not on the hub. Test connection reads four checks. On
// a phone the selector is a sheet with fingers' targets. Turning the feature off closes the gateway.
// When the remote goes away its scope is the offline screen with Retry, and it is back without a reload.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openMenu, pairByCode, remoteLan, resetServers, serversOn, serversPeerEnv, until } from './servers-shared.mjs';

export const peers = ['remote'];
export const peerEnv = serversPeerEnv('remote');
export const timeout = 300_000;

const NAME = 'Studio';
const PROJECT = 'e2e-servers-switch';
const SELECTOR = '.server-selector';

export default async ({ page, api, check, dirs, peers: { remote }, capture }) => {
  const lan = await remoteLan(remote);
  const projects = [];
  let server = null;
  let touch = false;

  /** A project and its tasks on one install: both installs name it alike, so their first task shares a key */
  const seed = async (client, where, titles) => {
    const dir = join(where, PROJECT);
    mkdirSync(dir, { recursive: true });
    const imported = await client.post('/projects/import', { path: dir, name: PROJECT, template: 'software' });
    check(imported.status === 201, `the project on ${client.baseUrl} (${imported.status} ${JSON.stringify(imported.body)})`);
    const items = [];
    for (const title of titles) {
      const made = await client.post(`/projects/${imported.body.id}/work-items`, { title });
      check(made.status === 201, `"${title}" was created (${made.status})`);
      items.push(made.body);
    }
    return { project: imported.body, items };
  };
  const at = (path) => `return location.pathname === ${JSON.stringify(path)}`;
  /** Picks the remote in the selector of whatever page is open, the way a person does on a desktop */
  const pickRemote = async () => {
    await openMenu(page, SELECTOR);
    await page.click('[role=menu] [role=menuitemradio]', NAME, 400);
  };

  try {
    const hub = await seed(api, dirs.workspaceDir, ['Hub task one', 'Hub only task']);
    const far = await seed(remote.api, remote.dirs.workspaceDir, ['Remote task one']);
    const [one, two] = hub.items;
    check(one.key === far.items[0].key, `both installs number their first task alike (${one.key} / ${far.items[0].key})`);
    projects.push(hub.project.id);

    check((await serversOn(api)).status === 200, 'Servers is on');
    server = await pairByCode(api, remote, lan, NAME);
    check((await api.post(`/servers/${server.id}/use`)).status === 200, 'the hub took a reading of the remote');

    // ---------- the selector: This server pinned, the remote with its status in a word ----------
    await page.goto('/chats', 1500);
    await page.waitFor(`return !!document.querySelector(${JSON.stringify(SELECTOR)})`, { label: 'the server selector' });
    check((await page.text(SELECTOR)).trim() === 'This server', 'the selector reads This server on the hub');
    await openMenu(page, SELECTOR);
    const items = await page.eval(`return [...document.querySelectorAll('[role=menu] [role=menuitemradio]')].map((el) => ({ text: el.innerText.replace(/\\s+/g, ' ').trim(), checked: el.getAttribute('aria-checked') }))`);
    check(items.length === 2 && items[0].text === 'This server' && items[0].checked === 'true', `This server is first and chosen (${JSON.stringify(items)})`);
    check(items[1]?.text.includes(NAME) && items[1].text.includes('Connected') && items[1].checked === 'false', `the remote follows with its status word (${JSON.stringify(items[1])})`);
    check((await page.text('[role=menu]')).includes('All servers'), 'the menu ends with the way to the page');
    await page.key('Escape');

    // ---------- a list page stays the same page on the remote ----------
    await pickRemote();
    await page.waitFor(at(`/s/${server.id}/chats`), { label: 'the remote, on the same page', timeout: 30_000 });
    await page.waitFor(`return !!document.querySelector('[data-testid=statusbar-server]')`, { label: "the status bar naming the remote" });
    const bar = await page.text('[data-testid=statusbar-server]');
    check(bar.includes(NAME) && bar.includes('Connected'), `the status bar names the remote and says it is connected (${bar})`);
    check(await page.eval(`return !document.querySelector(${JSON.stringify(SELECTOR)}) && !document.querySelector('.sidebar a[href$="/servers"]')`), 'inside the remote there is no selector and no Servers entry: one hop');
    check((await api.get('/servers')).body[0].lastUsedAt !== null, 'picking it recorded the use');

    // ---------- the way back is a link, on the page the person is on ----------
    await page.click('.statusbar a', 'Back to this server', 0);
    await page.waitFor(at('/chats') + ` && !!document.querySelector(${JSON.stringify(SELECTOR)})`, { label: 'back on this server', timeout: 30_000 });

    // ---------- a record both servers have: the page stays ----------
    await page.goto(`/tasks/${one.key}?project=${hub.project.id}`, 1500);
    await page.waitFor(`return document.querySelector('main h1')?.textContent.trim() === 'Hub task one'`, { label: "the hub's task" });
    await pickRemote();
    await page.waitFor(at(`/s/${server.id}/tasks/${one.key}`), { label: 'the same task page on the remote', timeout: 30_000 });
    await page.waitFor(`return document.querySelector('main h1')?.textContent.trim() === 'Remote task one'`, { label: "the remote's own task, under the same key" });

    // ---------- a write there lands on the remote and nowhere else ----------
    await page.click('main .workitem-title .workitem-edit', undefined, 300);
    await page.fill('main .workitem-title-input', 'Renamed through the hub');
    await page.press('Enter');
    await until(async () => (await remote.api.get(`/work-items/by-key/${one.key}`)).body?.title === 'Renamed through the hub', "the remote's task to be renamed");
    check((await api.get(`/work-items/by-key/${one.key}`)).body?.title === 'Hub task one', "the hub's own task is untouched");

    // ---------- a record the remote does not have: the list it belongs to ----------
    await page.click('.statusbar a', 'Back to this server', 0);
    // The link is made without asking the hub, so a page that names a record goes to its list
    await page.waitFor(at('/tasks'), { label: "back on the hub, on the task list", timeout: 30_000 });
    check((await remote.api.get(`/work-items/by-key/${two.key}`)).status === 404, 'the remote has no second task');
    await page.goto(`/tasks/${two.key}?project=${hub.project.id}`, 1500);
    await page.waitFor(`return document.querySelector('main h1')?.textContent.trim() === 'Hub only task'`, { label: "the hub's second task" });
    await pickRemote();
    await page.waitFor(at(`/s/${server.id}/tasks`), { label: "the remote's task list, since it lacks the record", timeout: 30_000 });

    // ---------- Test connection: four checks, each its own ----------
    await page.goto('/servers', 1500);
    await page.waitFor(`return !!document.querySelector('[data-testid=server-row]')`, { label: 'the server row' });
    check((await page.text('[data-testid=server-row]')).includes('Connected'), 'the row says Connected, in a word');
    await page.click('[data-testid=server-test-open]', undefined, 300);
    await page.waitFor(`return document.querySelectorAll('[role=dialog] .server-check[data-ok]').length === 4`, { label: 'the four checks' });
    const checks = await page.eval(`return Object.fromEntries([...document.querySelectorAll('[role=dialog] .server-check')].map((el) => [el.dataset.check, el.dataset.ok]))`);
    check(checks.meta === 'true' && checks.rest === 'true' && checks.events === 'true', `identity, API calls and live updates work (${JSON.stringify(checks)})`);
    check(Object.keys(checks).join() === 'meta,rest,events,socket' && ['true', 'false'].includes(checks.socket), `the socket has its own verdict (${JSON.stringify(checks)})`);
    check((await page.text('[role=dialog]')).includes(lan.url), 'the dialog says which address answered');
    await page.click('[role=dialog] button', 'Close', 300);

    // ---------- a phone: the selector is a sheet, with targets for a finger ----------
    await page.viewport(390, 844);
    await page.emulateTouch(true);
    touch = true;
    await page.goto('/chats', 1500);
    await page.waitFor(`return !!document.querySelector(${JSON.stringify(SELECTOR)})?.getClientRects().length`, { label: 'the selector in the phone top bar' });
    check(await page.eval(`return document.documentElement.scrollWidth <= window.innerWidth`), 'the phone top bar does not overflow sideways');
    await page.click(SELECTOR, undefined, 600);
    await page.waitFor(`return !!document.querySelector('.sheet-actions [data-item="local"]')`, { label: 'the sheet of servers' });
    const sheet = await page.eval(`
      const rows = [...document.querySelectorAll('.sheet-actions button')];
      return { roles: rows.map((b) => b.dataset.item + ':' + (b.getAttribute('role') ?? '') + ':' + b.getAttribute('aria-checked')).join(' '), shortest: Math.min(...rows.map((b) => b.getBoundingClientRect().height)), text: document.querySelector('.sheet-actions').innerText.replace(/\\s+/g, ' ') }`);
    check(sheet.roles.includes('local:radio:true') && sheet.roles.includes(`${server.id}:radio:false`), `the sheet has This server chosen and the remote (${sheet.roles})`);
    check(sheet.shortest >= 44, `every row of the sheet is at least 44 px tall (${sheet.shortest})`);
    check(sheet.text.includes('Connected') && sheet.text.includes('All servers'), `the sheet says the status and ends with All servers (${sheet.text})`);
    await page.click(`.sheet-actions [data-item="${server.id}"]`, undefined, 400);
    await page.waitFor(at(`/s/${server.id}/chats`), { label: 'the remote, picked from the sheet', timeout: 30_000 });
    await page.emulateTouch(false);
    touch = false;
    await page.viewport(1440, 900);

    // ---------- off: the gateway answers as if it did not exist, and the shell forgets servers ----------
    check((await api.put('/servers/settings', { enabled: false })).status === 200, 'Servers turned off');
    check((await api.get(`/servers/${server.id}/api/meta`)).status === 404, 'the gateway is closed while it is off');
    await page.goto('/chats', 1500);
    check(await page.eval(`return !document.querySelector(${JSON.stringify(SELECTOR)}) && !document.querySelector('.sidebar a[href="/servers"]')`), 'off: no selector and no entry');
    check((await api.put('/servers/settings', { enabled: true })).status === 200 && (await api.get('/servers')).body.length === 1, 'on again: the list was kept');

    // ---------- the remote goes away: its scope is an offline screen, and it returns by itself ----------
    remote.stop();
    await page.goto(`/s/${server.id}/chats`, 1500);
    await page.waitFor(`return !!document.querySelector('[data-testid=unreachable][data-remote]')`, { label: 'the offline screen of the remote', timeout: 60_000 });
    const offline = await page.text('[data-testid=unreachable]');
    check(offline.includes(`${NAME} cannot be reached`) && offline.includes(lan.url), `the offline screen names the server and its address (${offline.replaceAll('\n', ' | ')})`);
    check(offline.includes('Retry') && offline.includes('Back to this server'), 'and offers Retry and the way back');
    check(await page.eval(`return !document.querySelector('[data-testid=reload-banner]') && !document.querySelector('.sidebar')`), "it is not the hub's own outage: no banner, and no shell around it");
    await page.goto('/servers', 1500);
    await page.click('[data-testid=server-test-open]', undefined, 300);
    await page.waitFor(`return document.querySelectorAll('[role=dialog] .server-check[data-ok]').length === 4`, { label: 'the four checks, with the remote down' });
    check(await page.eval(`return document.querySelector('[role=dialog] .server-check[data-check=meta]').dataset.ok === 'false'`), 'the test says the remote does not answer');
    await page.click('[role=dialog] button', 'Close', 300);
    await page.waitFor(`return document.querySelector('[data-testid=server-row]')?.dataset.status === 'offline'`, { label: 'the row says Offline' });

    await remote.start();
    await remoteLan(remote);
    await page.goto(`/s/${server.id}/chats`, 1500);
    await page.waitFor(`return !document.querySelector('[data-testid=unreachable]') && !!document.querySelector('.sidebar') && location.pathname === ${JSON.stringify(`/s/${server.id}/chats`)}`, { label: 'the remote back, on its page', timeout: 60_000 });
  } catch (error) {
    await capture('servers-switch').catch(() => {});
    throw error;
  } finally {
    if (touch) await page.emulateTouch(false).catch(() => {});
    await resetServers(api);
    for (const id of projects) await api.del(`/projects/${id}`).catch(() => {});
  }
};
