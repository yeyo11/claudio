// The person's own terminal: a real shell in the project's directory, on the project page, in the
// chat's dock and on a phone's screen. The wrapper runs with authentication off on loopback, which is
// the one case the terminal allows without a token. The renderer is forced to the DOM, so the text of
// the screen can be read from `.xterm-rows`. Nothing here starts Claude Code in a terminal.
//
// Output is told from the echo of what was typed by arithmetic: `echo m$((6*7))` echoes as typed, and
// only the shell's answer reads `m42`.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const fakeCli = true;
export const timeout = 240_000;

const RENDERER = 'claudio-terminal-renderer';
const SCREEN = `document.querySelector('.term .xterm-rows')?.innerText ?? ''`;

export default async ({ page, api, check, dirs }) => {
  let projectId = null;
  let chatId = null;
  const path = join(dirs.workspaceDir, 'e2e-terminal');
  mkdirSync(path, { recursive: true });

  const screen = () => page.eval(`return ${SCREEN}`);
  const onScreen = (text, label = text) => page.waitFor(`return (${SCREEN}).includes(${JSON.stringify(text)})`, { label: `"${label}" on the terminal's screen`, timeout: 30_000 });
  const ready = () => page.waitFor(`return !!document.querySelector('.term .xterm-helper-textarea') && !!document.querySelector('.term-status')`, { label: 'a terminal with its status', timeout: 30_000 });
  /** Types a line into the shell as a person does: into xterm's own textarea, then Enter */
  const run = async (line) => {
    await page.focus('.term .xterm-helper-textarea');
    await page.type(line);
    await page.key('Enter');
  };
  const terminalsOf = async () => (await api.get(`/terminals?project=${encodeURIComponent(projectId)}`)).body;

  try {
    const imported = await api.post('/projects/import', { path, name: 'e2e-terminal' });
    check(imported.status === 201, `the project was imported (${imported.status})`);
    projectId = imported.body.id;

    // The renderer flag is read by the view; every spec starts on about:blank, whose storage is out of reach
    await page.goto('/', 800);
    await page.eval(`localStorage.setItem(${JSON.stringify(RENDERER)}, 'dom'); localStorage.removeItem('claudio-theme'); return true`);

    // ---- 1. off by default; on through the settings, the page offers "New terminal" ----
    const before = await api.get('/terminal');
    check(before.status === 200 && before.body.available === false && before.body.reason === 'off', `the terminal is off by default (${before.body.reason})`);
    await page.goto(`/terminals?project=${encodeURIComponent(projectId)}`, 1500);
    check(!(await page.text('main')).includes('New terminal'), 'with the feature off, the page offers no terminal');

    const on = await api.put('/terminal/settings', { enabled: true });
    check(on.status === 200, `the feature was turned on (${on.status})`);
    check((await api.get('/terminal')).body.available === true, 'the terminal is available from loopback with authentication off');
    await page.goto(`/terminals?project=${encodeURIComponent(projectId)}`, 1500);
    await page.waitFor(`return [...document.querySelectorAll('main button')].some((b) => b.textContent.includes('New terminal'))`, { label: 'the New terminal button' });

    // ---- 2. open one; a command's answer reaches the screen ----
    await page.click('main button', 'New terminal', 800);
    await ready();
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
    check(printed.some((p) => p.endsWith('/e2e-terminal')) && Boolean(open?.cwd.endsWith('e2e-terminal')), `pwd prints the project's directory (${printed.join(', ')} vs ${open?.cwd})`);
    await run('echo env$(env | grep -c "^CLAUDIO_")');
    await onScreen('env0');
    check(true, 'no CLAUDIO_* variable reaches the shell');
    await run('echo key$(env | grep -cE "^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=")');
    await onScreen('key0');
    check(true, "Claude's own credentials do not reach the shell");

    // ---- 4. a reload brings the screen back from the server's snapshot ----
    await page.goto(`/terminals?project=${encodeURIComponent(projectId)}`, 1500);
    await ready();
    await onScreen('m42', 'the earlier output after a reload');
    check((await terminalsOf()).length === 1, 'the reload attached to the same shell, it did not open another');

    // ---- 5. the chat page: the dock opens in the chat's directory ----
    const chat = await api.post('/chats', { prompt: 'e2e-terminal chat', cwd: path });
    check(chat.status === 201, `a chat started in the project (${chat.status})`);
    chatId = chat.body.id;
    await page.goto(`/chats/${chatId}`, 1500);
    await page.waitFor(`return !!document.querySelector('.chat-head h1')`, { label: 'the chat header' });
    await page.click('.chat-head button[aria-label="Terminal"]', undefined, 800);
    await ready();
    await page.waitFor(`return !!document.querySelector('.term-dock .term')`, { label: 'the dock' });
    await run('echo dock$((5*5))');
    await onScreen('dock25');
    const mine = (await api.get(`/terminals?chat=${encodeURIComponent(chatId)}`)).body[0];
    check(mine?.scope?.kind === 'chat' && mine.cwd.endsWith('e2e-terminal'), `the dock's terminal belongs to the chat and opens in its directory (${mine?.cwd})`);
    const dock = await page.eval(`const r=document.querySelector('.term-dock').getBoundingClientRect(); return { height: r.height, handle: !!document.querySelector('.term-dock-handle') }`);
    check(dock.handle && dock.height >= 160, `the dock has its resize handle and a usable height (${dock.height}px)`);
    await page.click('.chat-head button[aria-label="Terminal"]', undefined, 600);
    check(!(await page.eval(`return !!document.querySelector('.term-dock')`)), 'the header button closes the dock');
    await api.del(`/terminals/${mine.id}`).catch(() => {});

    // ---- 6. a phone: the route is a screen, the key bar sends Esc and Ctrl+C ----
    await page.viewport(420, 900);
    const phoneTerminal = await api.post('/terminals', { projectId, cols: 40, rows: 20 });
    check(phoneTerminal.status === 201, `a terminal was opened for the phone (${phoneTerminal.status})`);
    await page.goto(`/terminals/${phoneTerminal.body.id}`, 1500);
    await ready();
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
    await page.click('.term-key[aria-label="Esc"]', undefined, 300);
    await run('echo esc$((3+4))');
    await onScreen('esc7');
    check(true, 'Esc from the key bar reached the shell without breaking the line');
    await page.shot('terminal-phone');

    // ---- 7. the light theme paints the terminal with the light --term-bg ----
    await page.viewport(1440, 900);
    await page.eval(`localStorage.setItem('claudio-theme', 'light'); return true`);
    await page.goto(`/terminals?project=${encodeURIComponent(projectId)}`, 1500);
    await ready();
    const paint = await page.eval(`
      const probe = document.createElement('div');
      probe.style.background = 'var(--term-bg)';
      document.body.append(probe);
      const token = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const screen = document.querySelector('.term .xterm-viewport');
      return { token, screen: screen ? getComputedStyle(screen).backgroundColor : null, theme: document.documentElement.dataset.theme };`);
    check(paint.screen === paint.token, `the screen reads --term-bg of the light theme (${paint.screen} vs ${paint.token})`);
    await page.shot('terminal-light');
    await page.eval(`localStorage.removeItem('claudio-theme'); return true`);

    // ---- 8. turned off: the button goes, the open terminal says it is closed ----
    await page.goto(`/terminals?project=${encodeURIComponent(projectId)}`, 1500);
    await ready();
    const off = await api.put('/terminal/settings', { enabled: false });
    check(off.status === 200, `the feature was turned off (${off.status})`);
    await page.waitFor(`return ![...document.querySelectorAll('main button')].some((b) => b.textContent.includes('New terminal'))`, { label: 'the New terminal button gone', timeout: 30_000 });
    check(true, 'the New terminal button disappeared');
    check((await terminalsOf()).every((t) => t.state !== 'running'), 'no terminal is running once the feature is off');
    const status = await page.text('main');
    check(/Closed|Cerrado/.test(status) || status.includes('not available'), `the page says the terminal is closed or unavailable (${status.slice(0, 120).replace(/\s+/g, ' ')})`);
  } finally {
    await page.viewport(1440, 900).catch(() => {});
    await page.eval(`localStorage.removeItem(${JSON.stringify(RENDERER)}); localStorage.removeItem('claudio-theme'); return true`).catch(() => {});
    await api.put('/terminal/settings', { enabled: false }).catch(() => {});
    if (chatId) {
      await api.post(`/chats/${chatId}/stop`).catch(() => {});
      for (let i = 0; i < 40; i++) {
        if ((await api.del(`/chats/${chatId}`).catch(() => ({ status: 0 }))).status === 200) break;
        await page.sleep(250);
      }
    }
    if (projectId) await api.del(`/projects/${projectId}`).catch(() => {});
  }
};
