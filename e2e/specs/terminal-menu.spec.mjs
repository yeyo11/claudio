// The terminal's context menu: a right click on the screen opens a menu at the pointer (Copy, Paste,
// Search, with their shortcuts), Shift + right click leaves the browser's own, Escape closes it and
// gives the keyboard back to the terminal, and a copy from it says so with a toast. The clipboard is
// stubbed so the copied text can be read back and a paste has something to read.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const fakeCli = true;
export const timeout = 240_000;

const RENDERER = 'claudio-terminal-renderer';
const SCREEN = `document.querySelector('.term .xterm-rows')?.innerText ?? ''`;

export default async ({ page, api, check, dirs }) => {
  let projectId = null;
  const path = join(dirs.workspaceDir, 'e2e-terminal-menu');
  mkdirSync(path, { recursive: true });

  const onScreen = (text) => page.waitFor(`return (${SCREEN}).includes(${JSON.stringify(text)})`, { label: `"${text}" on the terminal's screen`, timeout: 30_000 });
  const run = async (line) => {
    await page.focus('.term .xterm-helper-textarea');
    await page.type(line);
    await page.key('Enter');
  };
  /** A right click as the browser dispatches it; says whether the page took it over (`preventDefault`) */
  const rightClick = (shift, at = { fx: 0.4, fy: 0.3 }) =>
    page.eval(`
      const screen = document.querySelector('.term .term-screen');
      const r = screen.getBoundingClientRect();
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, shiftKey: ${shift}, clientX: r.left + r.width * ${at.fx}, clientY: r.top + r.height * ${at.fy} });
      screen.querySelector('.xterm-screen').dispatchEvent(event);
      return { taken: event.defaultPrevented, x: event.clientX, y: event.clientY };`);
  const menu = () =>
    page.eval(`
      const m = document.querySelector('[role=menu]');
      if (!m) return null;
      const box = m.getBoundingClientRect();
      const frame = document.querySelector('.term').getBoundingClientRect();
      return {
        name: m.getAttribute('aria-label'),
        items: [...m.querySelectorAll('[role=menuitem]')].map((i) => ({ text: i.querySelector('.menu-item-text > span')?.textContent, key: i.querySelector('.menu-item-key')?.textContent ?? null, disabled: i.getAttribute('aria-disabled') === 'true', why: i.querySelector('.menu-item-why')?.textContent ?? null })),
        inside: box.left >= frame.left - 1 && box.right <= frame.right + 1 && box.top >= frame.top - 1 && box.bottom <= frame.bottom + 1,
        box: { left: Math.round(box.left), top: Math.round(box.top), bottom: Math.round(box.bottom) },
      };`);
  const closed = () => page.waitFor(`return !document.querySelector('[role=menu]')`, { label: 'the menu closed' });
  const toast = () => page.eval(`return [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | ')`);

  try {
    const imported = await api.post('/projects/import', { path, name: 'e2e-terminal-menu' });
    check(imported.status === 201, `the project was imported (${imported.status})`);
    projectId = imported.body.id;

    await page.goto('/', 800);
    await page.eval(`localStorage.setItem(${JSON.stringify(RENDERER)}, 'dom'); localStorage.removeItem('claudio-theme'); return true`);
    const on = await api.put('/terminal/settings', { enabled: true });
    check(on.status === 200, `the feature was turned on (${on.status} ${JSON.stringify(on.body)})`);
    await page.goto(`/?project=${encodeURIComponent(projectId)}`, 1500);
    await page.waitFor(`return !!document.querySelector('.statusbar-btn')`, { label: 'the status bar Terminal item' });
    await page.click('.statusbar-btn', undefined, 800);
    await page.waitFor(`return !!document.querySelector('.term .xterm-helper-textarea') && (${SCREEN}).trim().length > 0`, { label: 'a terminal with a prompt', timeout: 30_000 });

    // A clipboard the page can read back, and one a paste can read
    await page.eval(`
      window.__copied = null;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__copied = text; }, readText: async () => 'echo pasted$((6*8))' } });
      return true`);
    await run('echo menu$((6*7))');
    await onScreen('menu42');

    // ---- 1. a right click with nothing selected: the menu, Copy off with its reason ----
    const first = await rightClick(false);
    check(first.taken, 'a right click on the screen is taken over (the browser draws no menu)');
    await page.waitFor(`return !!document.querySelector('[role=menu]')`, { label: 'the context menu' });
    const open = await menu();
    check(
      JSON.stringify(open?.items.map((i) => [i.text, i.key])) === JSON.stringify([['Copy selection', 'Ctrl+Shift+C'], ['Paste', 'Ctrl+Shift+V'], ['Search', 'Ctrl+Shift+F']]),
      `the menu has Copy, Paste and Search with their shortcuts (${JSON.stringify(open?.items)})`,
    );
    check(open?.items[0]?.disabled === true && open.items[0].why === 'Select some text first', `Copy is off and says why (${JSON.stringify(open?.items[0])})`);
    check(open?.items[1]?.disabled === false && open.items[2]?.disabled === false, 'Paste and Search are on');
    check(open?.inside === true, `the menu opens inside the terminal's frame (${JSON.stringify(open?.box)})`);
    // Below the pointer, or above it when the panel is too short to hold the menu under it
    const nearY = open ? Math.min(Math.abs(open.box.top - first.y), Math.abs(open.box.bottom - first.y)) : Infinity;
    check(Math.abs((open?.box.left ?? 0) - first.x) <= 12 && nearY <= 12, `the menu opens at the pointer (${JSON.stringify(open?.box)} vs ${first.x},${first.y})`);
    await page.shot('terminal-context-menu-dark');

    // ---- 2. Escape closes it and the keyboard is back in the terminal ----
    await page.press('Escape');
    await closed();
    check(await page.eval(`return document.activeElement?.classList.contains('xterm-helper-textarea') === true`), 'Escape closed the menu and the terminal has the keyboard again');

    // ---- 3. Shift + right click keeps the browser's own menu ----
    const shifted = await rightClick(true);
    await page.sleep(300);
    check(shifted.taken === false && (await menu()) === null, 'Shift + right click is left to the browser: no menu of ours, the event is not cancelled');

    // ---- 4. Paste from the menu sends the clipboard's text to the shell ----
    await rightClick(false);
    await page.waitFor(`return !!document.querySelector('[role=menu]')`, { label: 'the context menu again' });
    await page.click('[role=menu] [role=menuitem]', 'Paste', 400);
    await closed();
    await page.focus('.term .xterm-helper-textarea');
    await page.key('Enter');
    await onScreen('pasted48');
    check(true, 'Paste in the menu typed the clipboard into the shell');

    // ---- 5. with a selection, Copy is on and its toast says so ----
    // A triple click on the line the shell answered on selects it, as xterm's own handler reads it
    await page.eval(`
      const rows = [...document.querySelectorAll('.term .xterm-rows > div')];
      const row = rows.find((r) => r.textContent.trim() === 'menu42');
      const r = row.getBoundingClientRect();
      const target = document.querySelector('.term .xterm-screen');
      const at = { bubbles: true, cancelable: true, button: 0, clientX: r.left + 6, clientY: r.top + r.height / 2 };
      target.dispatchEvent(new MouseEvent('mousedown', { ...at, detail: 3 }));
      document.dispatchEvent(new MouseEvent('mouseup', { ...at, detail: 3 }));
      return true`);
    await rightClick(false, { fx: 0.5, fy: 0.5 });
    await page.waitFor(`return !!document.querySelector('[role=menu]')`, { label: 'the menu with a selection' });
    const withSelection = await menu();
    check(withSelection?.items[0]?.disabled === false && withSelection.items[0].why === null, `with text selected Copy is on (${JSON.stringify(withSelection?.items[0])})`);
    await page.click('[role=menu] [role=menuitem]', 'Copy selection', 500);
    await closed();
    check((await page.eval('return window.__copied')) === 'menu42' || String(await page.eval('return window.__copied')).includes('menu42'), `Copy put the selection on the clipboard (${JSON.stringify(await page.eval('return window.__copied'))})`);
    check((await toast()).includes('Copied the selection'), `the copy says so with the usual toast (${await toast()})`);
    check(await page.eval(`return document.activeElement?.classList.contains('xterm-helper-textarea') === true`), 'the keyboard is back in the terminal after a copy');

    // ---- 6. Search from the menu opens the field, which keeps the keyboard ----
    await rightClick(false);
    await page.waitFor(`return !!document.querySelector('[role=menu]')`, { label: 'the menu for Search' });
    await page.click('[role=menu] [role=menuitem]', 'Search', 400);
    await closed();
    await page.waitFor(`return document.activeElement?.classList.contains('term-search') === true`, { label: 'the search field with the keyboard' });
    check(true, 'Search in the menu opened the search field and it kept the keyboard');
    await page.press('Escape');

    // ---- 6b. a second right click while the menu is open moves it, and the browser draws nothing ----
    await rightClick(false, { fx: 0.3, fy: 0.3 });
    await page.waitFor(`return !!document.querySelector('[role=menu]')`, { label: 'the menu to move' });
    const again = await rightClick(false, { fx: 0.7, fy: 0.3 });
    check(again.taken, 'a second right click is taken over as well, not left to the browser');
    await page.waitFor(`const m = document.querySelector('[role=menu]'); return !!m && Math.abs(m.getBoundingClientRect().left - ${again.x}) <= 12`, { label: 'the menu at the second point' });
    // Radix hands the focus back a tick after a menu unmounts: the moved menu must still be there, with the focus inside it
    await page.sleep(300);
    const kept = await page.eval(`const m = document.querySelector('[role=menu]'); return { open: !!m, focusInside: !!m && m.contains(document.activeElement) }`);
    check(kept.open && kept.focusInside, `the moved menu stays open and keeps the focus (${JSON.stringify(kept)})`);
    await page.press('Escape');
    await closed();

    // ---- 7. the light theme ----
    await page.eval(`localStorage.setItem('claudio-theme', 'light'); return true`);
    await page.goto(`/?project=${encodeURIComponent(projectId)}`, 1500);
    await page.waitFor(`return !!document.querySelector('.term .xterm-helper-textarea') && (${SCREEN}).trim().length > 0`, { label: 'the terminal in the light theme', timeout: 30_000 });
    await rightClick(false);
    await page.waitFor(`return !!document.querySelector('[role=menu]')`, { label: 'the menu in the light theme' });
    const paint = await page.eval(`
      const m = document.querySelector('[role=menu]');
      const probe = document.createElement('i'); probe.style.background = 'var(--bg-2)'; document.body.append(probe);
      const token = getComputedStyle(probe).backgroundColor; probe.remove();
      return { menu: getComputedStyle(m).backgroundColor, token, theme: document.documentElement.dataset.theme };`);
    check(paint.theme === 'light' && paint.menu === paint.token, `the menu reads --bg-2 of the light theme (${JSON.stringify(paint)})`);
    await page.shot('terminal-context-menu-light');
    await page.press('Escape');
    await page.eval(`localStorage.removeItem('claudio-theme'); return true`);
  } finally {
    await page.eval(`localStorage.removeItem(${JSON.stringify(RENDERER)}); localStorage.removeItem('claudio-theme'); return true`).catch(() => {});
    await api.put('/terminal/settings', { enabled: false }).catch(() => {});
    if (projectId) await api.del(`/projects/${projectId}`).catch(() => {});
  }
};
