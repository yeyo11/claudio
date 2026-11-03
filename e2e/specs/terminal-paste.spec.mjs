// Paste on a phone: the page often has no `navigator.clipboard` (plain HTTP on a LAN address), so the
// terminal's Paste opens a sheet with a field instead of doing nothing. At phone width, with a finger
// as the pointer: the `⋯` menu's Paste opens a bottom sheet whose 16 px field has the keyboard, with
// Send to terminal as the primary action and Cancel beside it, both 44 px targets; the text goes to
// the shell; Cancel sends nothing; and a copy with nothing selected says how to select. The browser's
// clipboard is removed from the page, as on HTTP, and the sheet is shot in both themes. On a desktop
// with a mouse, the ⋯ menu's Paste opens a dialog whose field keeps the keyboard.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const fakeCli = true;
export const timeout = 240_000;

const RENDERER = 'claudio-terminal-renderer';
const SCREEN = `document.querySelector('.term .xterm-rows')?.innerText ?? ''`;

export default async ({ page, api, check, dirs }) => {
  let projectId = null;
  let dropClipboard = null;
  const path = join(dirs.workspaceDir, 'e2e-terminal-paste');
  mkdirSync(path, { recursive: true });

  const onScreen = (text) => page.waitFor(`return (${SCREEN}).includes(${JSON.stringify(text)})`, { label: `"${text}" on the terminal's screen`, timeout: 30_000 });
  const sheet = () =>
    page.eval(`
      const s = document.querySelector('.sheet');
      if (!s) return null;
      const field = s.querySelector('textarea');
      const buttons = [...s.querySelectorAll('.sheet-foot .btn')].map((b) => ({ text: b.textContent.trim(), primary: b.classList.contains('btn-primary'), disabled: b.disabled, height: Math.round(b.getBoundingClientRect().height) }));
      const box = s.getBoundingClientRect();
      return {
        title: s.querySelector('.sheet-title')?.textContent ?? null,
        help: s.querySelector('.term-paste .muted')?.textContent ?? null,
        fontSize: field ? parseFloat(getComputedStyle(field).fontSize) : null,
        focused: document.activeElement === field,
        described: field?.getAttribute('aria-describedby') === s.querySelector('.term-paste .muted')?.id,
        buttons,
        bottom: Math.round(box.bottom),
        viewport: window.innerHeight,
      };`);
  const closed = () => page.waitFor(`return !document.querySelector('.sheet')`, { label: 'the sheet closed' });
  const toast = () => page.eval(`return [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | ')`);
  const openPaste = async () => {
    await page.click('.term-head [aria-label="Terminal actions"]', undefined, 500);
    await page.waitFor(`return !!document.querySelector('.sheet-actions')`, { label: 'the ⋯ sheet' });
    await page.click('.sheet-actions .btn', 'Paste', 600);
    await page.waitFor(`return !!document.querySelector('.sheet textarea')`, { label: 'the paste sheet' });
  };

  try {
    const imported = await api.post('/projects/import', { path, name: 'e2e-terminal-paste' });
    check(imported.status === 201, `the project was imported (${imported.status})`);
    projectId = imported.body.id;
    const on = await api.put('/terminal/settings', { enabled: true });
    check(on.status === 200, `the feature was turned on (${on.status})`);

    await page.viewport(390, 844);
    await page.emulateTouch(true);
    // The clipboard a plain-HTTP page does not have
    dropClipboard = await page.onNewDocument(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });`);
    const opened = await api.post('/terminals', { projectId, cols: 40, rows: 20 });
    check(opened.status === 201, `a terminal was opened (${opened.status})`);
    await page.goto('/', 800);
    await page.eval(`localStorage.setItem(${JSON.stringify(RENDERER)}, 'dom'); localStorage.removeItem('claudio-theme'); return true`);
    await page.goto(`/terminals/${opened.body.id}`, 1500);
    await page.waitFor(`return !!document.querySelector('.term .xterm-helper-textarea') && (${SCREEN}).trim().length > 0`, { label: 'a terminal with a prompt', timeout: 30_000 });
    check(await page.eval(`return navigator.clipboard === undefined`), 'the page has no clipboard, as on plain HTTP');

    // ---- 1. Paste opens the sheet, with its field ready and its actions in reach ----
    await openPaste();
    await page.sleep(500);
    const first = await sheet();
    check(first?.title === 'Paste into the terminal', `the sheet is named for what it does (${JSON.stringify(first?.title)})`);
    check(first?.help === 'Press and hold the box, then choose Paste.', `the helper line says how, with no key (${JSON.stringify(first?.help)})`);
    check(first?.fontSize >= 16, `the field is 16 px or more, so iOS does not zoom into it (${first?.fontSize})`);
    check(first?.focused === true, 'the field has the keyboard when the sheet opens');
    check(first?.described === true, 'the helper line describes the field');
    const [cancel, send] = first?.buttons ?? [];
    check(cancel?.text === 'Cancel' && send?.text === 'Send to terminal' && send.primary === true && cancel.primary === false, `Cancel and Send to terminal, the second the primary action (${JSON.stringify(first?.buttons)})`);
    check(send?.disabled === true, 'Send to terminal is off while the field is empty');
    check(first?.buttons.every((b) => b.height >= 44 - 1), `both actions are 44 px targets (${JSON.stringify(first?.buttons.map((b) => b.height))})`);
    check(first?.bottom <= first?.viewport, `the sheet is inside the screen (${first?.bottom} of ${first?.viewport})`);
    await page.shot('terminal-paste-sheet-dark');

    // ---- 2. what is typed in the field goes to the shell, cleaned as any paste ----
    await page.fill('.sheet textarea', 'echo pasted$((6*8))');
    check((await sheet())?.buttons[1].disabled === false, 'Send to terminal is on once there is text');
    await page.click('.sheet-foot .btn-primary', undefined, 500);
    await closed();
    await page.focus('.term .xterm-helper-textarea');
    await page.key('Enter');
    await onScreen('pasted48');
    check(true, 'the text of the field reached the shell');

    // ---- 3. Cancel sends nothing ----
    await openPaste();
    await page.fill('.sheet textarea', 'echo nothere$((7*7))');
    await page.click('.sheet-foot .btn', 'Cancel', 500);
    await closed();
    await page.focus('.term .xterm-helper-textarea');
    await page.key('Enter');
    await page.sleep(600);
    check(!(await page.eval(`return ${SCREEN}`)).includes('nothere49'), 'Cancel sent nothing to the shell');

    // ---- 4. a copy with nothing selected says how to select, with a long press ----
    await page.click('.term-head [aria-label="Terminal actions"]', undefined, 500);
    await page.click('.sheet-actions .btn', 'Copy selection', 600);
    check((await toast()).includes('Press and hold the text to select it'), `the toast says how to select on a phone (${await toast()})`);

    // ---- 5. the light theme ----
    await page.eval(`localStorage.setItem('claudio-theme', 'light'); return true`);
    await page.goto(`/terminals/${opened.body.id}`, 1500);
    await page.waitFor(`return !!document.querySelector('.term .xterm-helper-textarea') && (${SCREEN}).trim().length > 0`, { label: 'the terminal in the light theme', timeout: 30_000 });
    await openPaste();
    await page.sleep(500);
    const light = await page.eval(`
      const s = document.querySelector('.sheet');
      const probe = document.createElement('i'); probe.style.background = 'var(--bg-elev)'; document.body.append(probe);
      const token = getComputedStyle(probe).backgroundColor; probe.remove();
      return { sheet: getComputedStyle(s).backgroundColor, token, theme: document.documentElement.dataset.theme };`);
    check(light.theme === 'light' && light.sheet === light.token, `the sheet reads --bg-elev of the light theme (${JSON.stringify(light)})`);
    await page.shot('terminal-paste-sheet-light');
    await page.click('.sheet-foot .btn', 'Cancel', 500);
    await closed();

    // ---- 6. a desktop with a mouse: the ⋯ menu's Paste opens a dialog whose field keeps the keyboard ----
    // The menu gives the focus back to its trigger a tick after it closes; the field takes it after that
    await page.emulateTouch(false);
    await page.viewport(1280, 900);
    await page.goto(`/terminals/${opened.body.id}`, 1500);
    await page.waitFor(`return !!document.querySelector('.term .xterm-helper-textarea') && (${SCREEN}).trim().length > 0`, { label: 'the terminal on a desktop', timeout: 30_000 });
    await page.realClick('.term-head [aria-label="Terminal actions"]', 500);
    await page.click('[role=menu] [role=menuitem]', 'Paste', 800);
    await page.waitFor(`return !!document.querySelector('.dialog textarea')`, { label: 'the paste dialog' });
    check(await page.eval(`return document.activeElement === document.querySelector('.dialog textarea')`), `the dialog's field has the keyboard, not the ⋯ behind it (${await page.eval(`return document.activeElement?.outerHTML.slice(0, 80) ?? null`)})`);
    await page.click('.dialog .btn', 'Cancel', 500);
    await page.waitFor(`return !document.querySelector('.dialog')`, { label: 'the dialog closed' });
  } finally {
    await dropClipboard?.().catch(() => {});
    await page.emulateTouch(false).catch(() => {});
    await page.viewport(1440, 900).catch(() => {});
    await page.eval(`localStorage.removeItem(${JSON.stringify(RENDERER)}); localStorage.removeItem('claudio-theme'); return true`).catch(() => {});
    await api.put('/terminal/settings', { enabled: false }).catch(() => {});
    if (projectId) await api.del(`/projects/${projectId}`).catch(() => {});
  }
};
