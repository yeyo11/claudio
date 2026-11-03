// The dock closes with its last terminal. Closing one of several keeps it; a terminal of another
// scope (here the workspace's) keeps it; an empty first load does not hide it (it opens a shell); and
// when the last one goes the dock hides, the status bar's item offers it again and the keyboard is back
// on the page, not on a panel that no longer exists.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const fakeCli = true;
export const timeout = 240_000;

const RENDERER = 'claudio-terminal-renderer';

export default async ({ page, api, check, dirs }) => {
  let projectId = null;
  const path = join(dirs.workspaceDir, 'e2e-terminal-autoclose');
  mkdirSync(path, { recursive: true });
  const ITEM = '.statusbar-btn';
  const hasDock = () => page.eval(`return !!document.querySelector('.term-dock')`);
  const tabs = () => page.eval(`return document.querySelectorAll('.term-tab').length`);
  const ready = () =>
    page.waitFor(`return !!document.querySelector('.term .xterm-helper-textarea') && !!document.querySelector('.term-status')`, { label: 'a terminal attached in the dock', timeout: 30_000 });
  const running = async () => (await api.get('/terminals')).body.filter((each) => each.state === 'running');

  try {
    const imported = await api.post('/projects/import', { path, name: 'e2e-terminal-autoclose' });
    check(imported.status === 201, `the project was imported (${imported.status})`);
    projectId = imported.body.id;
    await page.goto('/', 800);
    await page.eval(`localStorage.setItem(${JSON.stringify(RENDERER)}, 'dom'); localStorage.removeItem('claudio-theme'); localStorage.removeItem('claudio-terminal-bar'); return true`);
    const on = await api.put('/terminal/settings', { enabled: true });
    check(on.status === 200, `the feature was turned on (${on.status})`);
    await page.goto(`/?project=${encodeURIComponent(projectId)}`, 1500);
    await page.waitFor(`return !!document.querySelector('${ITEM}')`, { label: 'the status bar Terminal item' });

    // An empty first load opens its shell and stays: the dock is not hidden for having had no terminal
    await page.click(ITEM, undefined, 800);
    await ready();
    await page.sleep(600);
    check((await hasDock()) && (await tabs()) === 1 && (await running()).length === 1, 'opening the dock with no terminal opened one shell and the dock stayed');

    // One of two: the dock stays and the other tab takes the front
    await page.click('.term-plus', undefined, 800);
    await page.waitFor(`return document.querySelectorAll('.term-tab').length === 2`, { label: 'two tabs' });
    await page.click('.term-tab.on .x', undefined, 800);
    await page.waitFor(`return document.querySelectorAll('.term-tab').length === 1`, { label: 'one tab after closing one of two' });
    await page.sleep(600);
    check(await hasDock(), 'closing one of two terminals kept the dock');

    // A terminal of another scope (the workspace's) is still in the dock's list, so it keeps the dock too
    const other = await api.post('/terminals', { workspace: true, cols: 40, rows: 20 });
    check(other.status === 201, `a terminal was opened in the workspace (${other.status})`);
    await page.waitFor(`return document.querySelectorAll('.term-tab').length === 2`, { label: 'the workspace terminal as a second tab', timeout: 30_000 });
    await page.click('.term-tab.on .x', undefined, 800);
    await page.waitFor(`return document.querySelectorAll('.term-tab').length === 1`, { label: 'one tab after closing the first of the two' });
    await page.sleep(600);
    check(await hasDock(), 'a terminal of another project kept the dock open');

    // The last one: the dock hides, remembers it, and the keyboard is back on the item that opened it
    await ready();
    await page.click('.term-tab.on .x', undefined, 800);
    await page.waitFor(`return !document.querySelector('.term-dock')`, { label: 'the dock hidden with its last terminal' });
    check((await running()).length === 0, 'no terminal is left running');
    check(await page.eval(`return localStorage.getItem('claudio-terminal-bar') === '0'`), 'the dock remembers it is closed');
    check(await page.eval(`return document.querySelector('${ITEM}')?.getAttribute('aria-expanded') === 'false'`), 'the status bar item says the panel is collapsed');
    const focused = await page.eval(`return document.activeElement?.className ?? null`);
    check(String(focused).includes('statusbar-btn'), `the keyboard went back to the page, to the item that opened the dock (${focused})`);

    // The item opens it again with its usual first shell
    await page.click(ITEM, undefined, 800);
    await ready();
    check((await hasDock()) && (await running()).length === 1, 'the item opened the dock again with a first shell');
  } finally {
    for (const each of (await api.get('/terminals').catch(() => ({ body: [] }))).body) await api.del(`/terminals/${each.id}`).catch(() => {});
    await page.eval(`localStorage.removeItem(${JSON.stringify(RENDERER)}); localStorage.removeItem('claudio-terminal-bar'); return true`).catch(() => {});
    await api.put('/terminal/settings', { enabled: false }).catch(() => {});
    if (projectId) await api.del(`/projects/${projectId}`).catch(() => {});
  }
};
