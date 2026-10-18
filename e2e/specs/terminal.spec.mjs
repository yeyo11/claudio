// The person's own terminal: a real shell in the project's directory, in the panel above the status
// bar (opened from the status bar's Terminal item, the only desktop entry point) and on a phone's
// screens (More -> Terminals and one terminal's own screen). The wrapper runs with authentication off
// on loopback, which is the one case the terminal allows without a token. The renderer is forced to
// the DOM, so the text of the screen can be read from `.xterm-rows`. Nothing here starts Claude Code
// in a terminal.
//
// Output is told from the echo of what was typed by arithmetic: `echo m$((6*7))` echoes as typed, and
// only the shell's answer reads `m42`.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const fakeCli = true;
export const timeout = 240_000;

const RENDERER = 'claudio-terminal-renderer';
const SCREEN = `document.querySelector('.term .xterm-rows')?.innerText ?? ''`;

export default async ({ page, api, check, dirs, serverLog }) => {
  let projectId = null;
  const path = join(dirs.workspaceDir, 'e2e-terminal');
  mkdirSync(path, { recursive: true });

  const screen = () => page.eval(`return ${SCREEN}`);
  const onScreen = (text, label = text) => page.waitFor(`return (${SCREEN}).includes(${JSON.stringify(text)})`, { label: `"${label}" on the terminal's screen`, timeout: 30_000 });
  // Ready is the shell's prompt on the screen: input typed while the socket is still attaching is dropped
  const ready = async (step) => {
    try {
      await page.waitFor(`return !!document.querySelector('.term .xterm-helper-textarea') && !!document.querySelector('.term-status') && (${SCREEN}).trim().length > 0`, { label: 'a terminal with its status and a prompt', timeout: 30_000 });
    } catch (error) {
      // The page's own report stops at the sidebar: what the panel shows and what the server holds say which half is missing
      const shown = await page
        .eval(`const d = document.querySelector('.term-dock, .term-space, .term'); return { dock: d ? d.outerHTML.replace(/<svg[\\s\\S]*?<\\/svg>/g, '').slice(0, 1500) : null, status: [...document.querySelectorAll('.term-status')].map((e) => e.textContent), screen: (${SCREEN}).slice(0, 300) }`)
        .catch((e) => `unreadable: ${e.message}`);
      const held = projectId ? await terminalsOf().catch((e) => e.message) : null;
      // No panel at all is either the feature refused (GET /terminal) or the panel remembered closed
      const feature = (await api.get('/terminal').catch((e) => ({ body: e.message }))).body;
      const remembered = await page.eval(`return { bar: localStorage.getItem('claudio-terminal-bar'), item: !!document.querySelector('.statusbar-btn') }`).catch((e) => e.message);
      error.message += `\nGET /terminal: ${JSON.stringify(feature)}\nremembered: ${JSON.stringify(remembered)}`;
      // A prompt that comes late is a slow shell; one that only an Enter brings is output that never reached the screen
      const late = await page.waitFor(`return (${SCREEN}).trim().length > 0`, { timeout: 30_000 }).then(() => 'yes', () => 'no');
      let afterEnter = 'not tried';
      if (late === 'no' && (await page.eval(`return !!document.querySelector('.term .xterm-helper-textarea')`).catch(() => false))) {
        await page.focus('.term .xterm-helper-textarea').catch(() => {});
        await page.key('Enter').catch(() => {});
        afterEnter = await page.waitFor(`return (${SCREEN}).trim().length > 0`, { timeout: 10_000 }).then(() => page.eval(`return (${SCREEN}).trim().slice(0, 120)`), () => 'still blank');
      }
      error.message += `\nprompt within 30 s more: ${late}; after an Enter: ${afterEnter}`;
      error.message += `\nstep: ${step}\npanel: ${JSON.stringify(shown)}\nterminals: ${JSON.stringify(held)}\nserver log: ${serverLog(/terminal|pty|socket/i).slice(-10).join(' | ')}`;
      throw error;
    }
  };
  /** Types a line into the shell as a person does: into xterm's own textarea, then Enter */
  const run = async (line) => {
    await page.focus('.term .xterm-helper-textarea');
    await page.type(line);
    await page.key('Enter');
  };
  const terminalsOf = async () => (await api.get(`/terminals?project=${encodeURIComponent(projectId)}`)).body;

  // Every POST that opens a shell, in every document, with when and from where: what a check that
  // counts the shells reports when there is one too many
  const removeOpens = await page.onNewDocument(
    `window.__opens = []; const real = window.fetch; window.fetch = (input, init) => { if ((init?.method ?? 'GET') === 'POST' && String(input).endsWith('/api/terminals')) window.__opens.push({ at: Math.round(performance.now()), stack: new Error().stack.split('\\n').slice(2, 9).join(' < ') }); return real(input, init); };`,
  );
  try {
    const imported = await api.post('/projects/import', { path, name: 'e2e-terminal' });
    check(imported.status === 201, `the project was imported (${imported.status})`);
    projectId = imported.body.id;

    // The renderer flag is read by the view; every spec starts on about:blank, whose storage is out of reach
    await page.goto('/', 800);
    await page.eval(`localStorage.setItem(${JSON.stringify(RENDERER)}, 'dom'); localStorage.removeItem('claudio-theme'); return true`);

    // The project chosen in the top bar is what the panel's first shell opens in
    const home = `/?project=${encodeURIComponent(projectId)}`;
    const ITEM = '.statusbar-btn';
    const item = () => page.eval(`const b=document.querySelector('${ITEM}'); return { count: b?.querySelector('.tnum')?.textContent ?? '0', expanded: b?.getAttribute('aria-expanded'), name: b?.getAttribute('aria-label') }`);
    const hasPanel = () => page.eval(`return !!document.querySelector('.term-dock')`);

    // ---- 1. off by default: no item; on through the settings, the status bar offers the Terminal item ----
    const before = await api.get('/terminal');
    check(before.status === 200 && before.body.available === false && before.body.reason === 'off', `the terminal is off by default (${before.body.reason})`);
    await page.goto(home, 1500);
    check(!(await page.eval(`return !!document.querySelector('${ITEM}')`)), 'with the feature off, the status bar has no Terminal item');

    // A container (the harness says it is one) opens the terminal to the local network by default, and the choice is there before the switch is on
    check(before.body.settings.remote === 'any', `a container defaults to opening the terminal over the local network (${before.body.settings.remote})`);
    await page.goto('/settings/access', 1500);
    await page.waitFor(`return document.querySelector('#terminal-remote')?.textContent.includes('Also over the local network')`, { label: 'the "From other devices" choice, with the terminal still off', timeout: 30_000 });
    check(!(await page.eval(`return !!document.querySelector('[role=tabpanel] .alert-warn[data-testid=terminal-refusal]')`)), 'no refusal is shown for a terminal that is only off');

    const on = await api.put('/terminal/settings', { enabled: true });
    check(on.status === 200, `the feature was turned on (${on.status} ${JSON.stringify(on.body)})`);
    check((await api.get('/terminal')).body.available === true, 'the terminal is available from loopback with authentication off');
    await page.goto(home, 1500);
    await page.waitFor(`return !!document.querySelector('${ITEM}')`, { label: 'the status bar Terminal item' });
    const idle = await item();
    check(idle.expanded === 'false' && idle.count === '0' && /Terminal/.test(idle.name ?? ''), `the item is a closed button named for the terminal, counting none (${JSON.stringify(idle)})`);

    // ---- 2. open the panel from the item; a command's answer reaches the screen ----
    await page.click(ITEM, undefined, 800);
    await ready('2, the panel opened from the item');
    check((await item()).expanded === 'true', 'the item says the panel is expanded');
    check(await page.eval(`return !!document.querySelector('section.term-dock[aria-label]')`), 'the panel is a labelled region');
    // Opening the panel is the person's doing, so the keyboard is in the shell once it has attached
    check(await page.eval(`return document.activeElement?.classList.contains('xterm-helper-textarea') === true`), 'the opened panel gave the keyboard to its terminal');
    await run('echo m$((6*7))');
    await onScreen('m42');
    check(true, 'a typed command ran in the shell and its output reached the screen');
    check((await page.text('.term-status')).length > 0, 'the status says a word, not only a colour');

    // ---- 3. the shell is in the project's directory and carries nothing of Claudio's ----
    await run('echo "cwd:$(pwd -P)"');
    await page.waitFor(`return /cwd:\\//.test(${SCREEN})`, { label: 'pwd printed' });
    const printed = (await screen()).match(/cwd:(\/\S*)/g)?.map((m) => m.slice(4)) ?? [];
    const open = (await terminalsOf())[0];
    check(open?.state === 'running', `the API lists the terminal as running (${open?.state})`);
    const shells = await terminalsOf();
    check(shells.length === 1, `opening the panel with a project chosen opened one shell (${JSON.stringify(shells.map(({ id, startedAt }) => ({ id, startedAt })))}; the page asked ${JSON.stringify(await page.eval('return window.__opens'))})`);
    check(printed.some((p) => p.endsWith('/e2e-terminal')) && Boolean(open?.cwd.endsWith('e2e-terminal')), `pwd prints the project's directory (${printed.join(', ')} vs ${open?.cwd})`);
    await run('echo env$(env | grep -c "^CLAUDIO_")');
    await onScreen('env0');
    check(true, 'no CLAUDIO_* variable reaches the shell');
    await run('echo key$(env | grep -cE "^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=")');
    await onScreen('key0');
    check(true, "Claude's own credentials do not reach the shell");

    // ---- 4. a reload brings the screen back from the server's snapshot (the panel remembers it is open) ----
    await page.goto(home, 1500);
    await ready('4, after a reload');
    await onScreen('m42', 'the earlier output after a reload');
    const afterReload = await terminalsOf();
    check(afterReload.length === 1, `the reload attached to the same shell, it did not open another (${JSON.stringify(afterReload.map(({ id, state, startedAt, endedAt, endReason, clients }) => ({ id, state, startedAt, endedAt, endReason, clients })))}; this page asked ${JSON.stringify(await page.eval('return window.__opens'))})`);

    // ---- 5. the panel's "+", its bounded height, X, Esc ----
    await page.click('.term-plus', undefined, 800);
    await page.waitFor(`return document.querySelectorAll('.term-tab').length === 2`, { label: 'two tabs' });
    check((await terminalsOf()).length === 2 && (await item()).count === '2', 'the "+" opened a second shell in the chosen project and the item counts two');
    // The strip scrolls along only when tabs overflow: no vertical scroll and no bar, not even by a pixel
    const strip = await page.eval(`const e=document.querySelector('.term-tabs'); const c=getComputedStyle(e); return { over: e.scrollHeight - e.clientHeight, bar: e.offsetWidth - e.clientWidth, y: c.overflowY, w: c.scrollbarWidth }`);
    check(strip.over <= 0 && strip.bar === 0 && strip.y === 'hidden' && strip.w === 'none', `the tab strip has no vertical scroll and no scrollbar (${JSON.stringify(strip)})`);
    const dock = await page.eval(`const r=document.querySelector('.term-dock').getBoundingClientRect(); return { height: r.height, handle: !!document.querySelector('.term-dock-handle') }`);
    check(dock.handle && dock.height >= 160, `the panel has its resize handle and a usable height (${dock.height}px)`);
    // The screen is bounded by the panel: it neither grows nor shrinks on its own (a loop between the fit and the layout did)
    const sized = () => page.eval(`const s=document.querySelector('.term-screen').getBoundingClientRect(); const d=document.querySelector('.term-dock').getBoundingClientRect(); return { screen: Math.round(s.height), dock: Math.round(d.height) }`);
    const first = await sized();
    await page.sleep(900);
    const later = await sized();
    check(first.screen === later.screen && later.screen < later.dock, `the terminal screen keeps a bounded height (${JSON.stringify(first)} then ${JSON.stringify(later)})`);
    // X closes the tab and the terminal is gone from the list, not left behind as "closed"
    await page.click('.term-tab.on .x', undefined, 800);
    await page.waitFor(`return document.querySelectorAll('.term-tab').length === 1`, { label: 'one tab after X' });
    check((await terminalsOf()).length === 1, 'X removed the terminal from the API list');
    // Esc hides the panel when the focus is not in a terminal, and is the shell's when it is
    await page.focus('.term .xterm-helper-textarea');
    await page.key('Escape');
    await page.sleep(300);
    check(await hasPanel(), 'Esc inside the terminal does not hide the panel');
    await page.eval(`document.activeElement?.blur(); return true`);
    await page.key('Escape');
    await page.waitFor(`return !document.querySelector('.term-dock')`, { label: 'the panel hidden by Esc' });
    check(await page.eval(`return localStorage.getItem('claudio-terminal-bar') === '0'`), 'the panel remembers it is closed');
    // The item opens it again, on the shell that is still running
    await page.click(ITEM, undefined, 800);
    await ready('5, shown again after Esc');
    check((await terminalsOf()).length === 1, 'showing the panel again reused the running shell');

    // ---- 5a. full screen: the frame fills the screen, the terminal refits, Esc or the button leaves ----
    const FULL = '.term-head [aria-label="Full screen"]';
    await page.waitFor(`return !!document.querySelector('${FULL}')`, { label: 'the full screen button' });
    const inFrame = (await page.eval(`const s=document.querySelector('.term-screen').getBoundingClientRect(); return Math.round(s.height)`));
    await page.realClick(FULL, 600);
    await page.waitFor(`return document.fullscreenElement?.classList.contains('term') === true`, { label: 'the terminal frame in full screen' });
    await page.waitFor(`return !!document.querySelector('.term-head [aria-label="Exit full screen"][aria-pressed="true"]')`, { label: 'the button offering to leave' });
    await page.waitFor(`return document.querySelector('.term-screen').getBoundingClientRect().height > ${inFrame} + 100`, { label: 'the screen refitted to the full window' });
    check(true, 'the full screen button put the terminal frame in full screen and the screen grew with it');
    // The resize makes the shell redraw its prompt and the first key typed after it is eaten, so an Enter goes first
    await page.sleep(1000);
    await page.eval(`document.activeElement?.blur(); return true`);
    await page.focus('.term .xterm-helper-textarea');
    await page.key('Enter');
    await page.sleep(500);
    await run('echo fs$((20+22))');
    await onScreen('fs42');
    check(true, 'the shell still answers in full screen');
    await page.realClick('.term-head [aria-label="Exit full screen"]', 600);
    await page.waitFor(`return document.fullscreenElement === null`, { label: 'full screen left' });
    await page.waitFor(`return Math.abs(document.querySelector('.term-screen').getBoundingClientRect().height - ${inFrame}) <= 2`, { label: 'the screen back to the panel size' });
    check(true, 'the same button leaves full screen and the screen refits to the panel');

    // ---- 5c. a window of its own: the button asks for the route, the panel says where the terminal is, and the route is that terminal alone ----
    const shellId = (await terminalsOf())[0].id;
    await page.eval(`window.__opened = []; window.open = (...args) => { window.__opened.push(args); return {}; }; return true`);
    await page.click('.term-head [aria-label="Open in a window"]', undefined, 600);
    const opened = await page.eval(`return window.__opened`);
    check(opened.length === 1 && opened[0][0] === '/terminal-window/' + shellId && opened[0][1] === 'claudio-terminal-' + shellId, `the detach button opened the terminal's route in a window named for it (${JSON.stringify(opened[0])})`);
    await page.waitFor(`return !!document.querySelector('.term-detached') && !document.querySelector('.term-screen')`, { label: 'the panel saying the terminal is in another window' });
    check((await page.text('.term-detached')).includes('In another window'), 'the panel says the terminal is in another window');
    await page.shot('terminal-detached');
    check((await page.text('.term-tab.on .term-status')).includes('In another window'), "the tab's status says it too, in words");
    await page.click('.term-detached .btn', undefined, 600);
    await ready('5c, brought back from the window');
    check(!(await page.eval(`return !!document.querySelector('.term-detached')`)), '"Bring it here" showed the terminal in the panel again');
    // The window's route, as the other window would load it: the terminal alone, attached to the same shell
    await page.goto(`/terminal-window/${shellId}`, 1500);
    await ready('5c, the window route');
    check(await page.eval(`return !document.querySelector('.statusbar') && !document.querySelector('.sidebar') && !document.querySelector('.term-dock') && !document.querySelector('.term-detach, .term-head [aria-label="Open in a window"]')`), 'the window route has no app shell, no panel and no detach button');
    check((await page.eval(`return document.title`)).startsWith('Terminal'), 'the window is titled for the terminal');
    check(await page.eval(`return !!document.querySelector('.term-head [aria-label="Full screen"]')`), 'the window offers full screen too');
    await onScreen('m42', 'the shell\'s earlier output');
    await run('echo win$((30+12))');
    await onScreen('win42');
    check((await terminalsOf()).length === 1, 'the window attached to the same shell, it did not open another');
    await page.goto(home, 1500);
    await ready('5c, back home');
    await onScreen('win42', "what was typed in the window, back in the panel");

    // ---- 5b. the page that used to hold the terminals is gone on a desktop: an old bookmark shows the panel and goes home ----
    await page.click(ITEM, undefined, 600);
    check(!(await hasPanel()), 'the item hides the panel');
    await page.goto(`/terminals?project=${encodeURIComponent(projectId)}`, 1500);
    await page.waitFor(`return location.pathname === '/'`, { label: 'the old terminals page redirected home' });
    await ready('5b, the old terminals page');
    check(await hasPanel(), '/terminals on a desktop opens the status bar panel');
    for (const each of await terminalsOf()) await api.del(`/terminals/${each.id}`).catch(() => {});

    // ---- 6. a phone: the route is a screen, the key bar sends Esc and Ctrl+C ----
    await page.viewport(420, 900);
    const phoneTerminal = await api.post('/terminals', { projectId, cols: 40, rows: 20 });
    check(phoneTerminal.status === 201, `a terminal was opened for the phone (${phoneTerminal.status})`);
    // More -> Terminals is the phone's list: the open terminals as rows, and a way to open another
    await page.goto('/terminals', 1500);
    await page.waitFor(`return !!document.querySelector('.term-row')`, { label: 'the terminal row on the phone list' });
    check((await page.text('main')).includes('New terminal'), "the phone's list offers New terminal");
    await page.click('.term-row', undefined, 1500);
    await page.waitFor(`return location.pathname === '/terminals/${phoneTerminal.body.id}'`, { label: "the row opened the terminal's own screen" });
    await ready('6, the phone screen');
    const keys = await page.eval(`const bar=document.querySelector('.term-keys'); const r=bar?.getBoundingClientRect(); return { shown: !!bar && r.height > 0, tabBar: [...document.querySelectorAll('.tab-bar, .tabbar')].some((e) => e.getClientRects().length > 0) }`);
    check(keys.shown, 'the key bar is visible at phone width');
    check(!keys.tabBar, "the terminal's screen hides the tab bar");
    const small = await page.eval(`return [...document.querySelectorAll('.term-key')].every((k) => { const r = k.getBoundingClientRect(); return r.height >= 44 - 1 })`);
    check(small, 'every key of the bar is a 44 px touch target');
    await run('cat');
    await page.click('.term-key[aria-label="Ctrl+C"]', undefined, 600);
    await run('echo after$((10+11))');
    await onScreen('after21');
    check(true, 'Ctrl+C from the key bar interrupted cat and the prompt came back');
    // `cat -v` prints what it receives, so the check does not depend on how the person's shell binds Esc
    // (zsh and bash read Esc followed by a letter as Meta and would eat the next command's first byte)
    await run('cat -v');
    await page.click('.term-key[aria-label="Esc"]', undefined, 300);
    await page.key('Enter');
    await onScreen('^[', 'the Esc byte echoed by cat -v');
    await page.click('.term-key[aria-label="Ctrl+C"]', undefined, 600);
    await run('echo esc$((3+4))');
    await onScreen('esc7');
    check(true, 'Esc from the key bar reached the shell as the Esc byte');
    await page.shot('terminal-phone');

    // ---- 7. the light theme paints the terminal with the light --term-bg ----
    await page.viewport(1440, 900);
    await page.eval(`localStorage.setItem('claudio-theme', 'light'); return true`);
    // The panel comes back as it was left, but only once the feature's status and its own code have
    // loaded: deciding from whether it is on screen yet raced that, and a click on an item already
    // opening the panel closed it again. What it was left as is read instead.
    const remembered = await page.eval(`return localStorage.getItem('claudio-terminal-bar') === '1'`);
    await page.goto(home, 1500);
    if (!remembered) await page.click(ITEM, undefined, 800);
    await ready('7, the light theme');
    const paint = await page.eval(`
      const probe = document.createElement('div');
      probe.style.background = 'var(--term-bg)';
      document.body.append(probe);
      const token = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const screen = document.querySelector('.term-screen .xterm .xterm-viewport') ?? document.querySelector('.term .xterm-viewport');
      return { token, screen: screen ? getComputedStyle(screen).backgroundColor : null, theme: document.documentElement.dataset.theme };`);
    check(paint.screen === paint.token, `the screen reads --term-bg of the light theme (${paint.screen} vs ${paint.token})`);
    await page.shot('terminal-light');
    await page.eval(`localStorage.removeItem('claudio-theme'); return true`);

    // ---- 8. turned off: the item and the panel go ----
    const off = await api.put('/terminal/settings', { enabled: false });
    check(off.status === 200, `the feature was turned off (${off.status})`);
    await page.waitFor(`return !document.querySelector('${ITEM}')`, { label: 'the Terminal item gone', timeout: 30_000 });
    check(!(await hasPanel()), 'the Terminal item and the panel disappeared');
    // With the feature off every terminal route answers 409 (the gate), so nothing can be listed or reached
    const listed = await api.get(`/terminals?project=${encodeURIComponent(projectId)}`);
    check(listed.status === 409 || (Array.isArray(listed.body) && listed.body.every((t) => t.state !== 'running')), `no terminal is reachable once the feature is off (${listed.status})`);
  } catch (error) {
    // Whatever failed, the shells the server holds and the POSTs this page sent for them say whether one too many was opened, and by whom
    const held = projectId ? await terminalsOf().catch((e) => e.message) : null;
    const asked = await page.eval('return window.__opens ?? null').catch((e) => e.message);
    error.message += `\nshells: ${JSON.stringify(Array.isArray(held) ? held.map(({ id, state, startedAt, clients }) => ({ id, state, startedAt, clients })) : held)}\nPOST /terminals from this page: ${JSON.stringify(asked)}`;
    throw error;
  } finally {
    await removeOpens().catch(() => {});
    await page.viewport(1440, 900).catch(() => {});
    await page.eval(`localStorage.removeItem(${JSON.stringify(RENDERER)}); localStorage.removeItem('claudio-theme'); return true`).catch(() => {});
    await api.put('/terminal/settings', { enabled: false }).catch(() => {});
    if (projectId) await api.del(`/projects/${projectId}`).catch(() => {});
  }
};
