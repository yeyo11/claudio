// Motion is a preference, and the whole point of it is that it is in force before anything has had
// a chance to move: the level is stamped on <html> at import time, the way the theme is. The
// control that changes it lives in Settings → Appearance; what is checked here is the mechanism
// under it, and that the stylesheet — not each component — is what stops the loops.
//
// The second half does it on a real live surface: a work item whose "Work on it" chat is running,
// on the board, the list, its own page and a phone's board. The fake CLI runs the `run:` line of
// the item's description, which is what keeps the chat working while the pages are read.
//
// Orchestration 3 adds one more: a team member working through the flow by column. The template's
// team is taken, the flow switched on, and a card moved into En curso, which starts the Developer's
// run; its `run:` line keeps the member working on the Team tab while it is read.
//
// Orchestration 4 adds the assistant's runs: the project assistant, "Suggest tasks" and "Suggest" on
// the Resources tab, one of each kind at once, each kept reading by a `run:` line in the fake CLI's
// scripts file (their prompts are core's, so the spec cannot type them). A run at work is the one
// energy border of its screen, and it stops like everything else.
//
// The strip of what is running beside a chat (plans/tool-rows-and-live-branches.md §3.4): a chat whose
// background command outlives its turn, and the strip's braille spinner, which holds its still glyph.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const fakeCli = true;
export const timeout = 180_000;

/**
 * Every loop in `root`, itself included, that is still running: an element or its ::before/::after,
 * shown, repeating. The energy border is the run card's own ::before, so the root has to count.
 */
const loops = (root = 'body') => `
  const found = [];
  for (const el of [...document.querySelectorAll('${root}'), ...document.querySelectorAll('${root} *')]) {
    if (el.getClientRects().length === 0) continue;
    for (const pseudo of [null, '::before', '::after']) {
      const s = getComputedStyle(el, pseudo);
      if (s.animationName === 'none') continue;
      const repeats = s.animationIterationCount.split(',').some((c) => c.trim() === 'infinite');
      const running = s.animationPlayState.split(',').some((p) => p.trim() === 'running');
      if (repeats && running) found.push(((el.className && el.className.toString()) || el.tagName).slice(0, 60) + (pseudo ?? ''));
    }
  }
  return found;`;

export default async ({ page, api, check, dirs, fakeCli }) => {
  await page.goto('/', 1200);
  check((await page.eval(`return document.documentElement.dataset.motion`)) === 'full', 'everything moves by default');
  check((await page.eval(`return document.documentElement.dataset.hidden`)) === 'false', 'a tab being looked at is marked as such');

  // What is stored is in force from the first paint, not after a flash of movement
  await page.eval(`localStorage.setItem('claudio-motion', 'subtle');`);
  await page.goto('/', 1200);
  check((await page.eval(`return document.documentElement.dataset.motion`)) === 'subtle', 'the stored level is in force');

  // At `subtle` nothing repeats, and it holds for anything the page adds later
  const looping = await page.eval(`
    const el = document.createElement('div');
    el.className = 'live-rail';
    document.body.append(el);
    const before = getComputedStyle(el, '::before');
    const value = { name: before.animationName, count: before.animationIterationCount };
    el.remove();
    return value;
  `);
  check(looping.name === 'none' || looping.count === '1', `a live rail does not loop at subtle (${looping.name}, ${looping.count})`);

  await page.eval(`localStorage.setItem('claudio-motion', 'off');`);
  await page.goto('/', 1200);
  check((await page.eval(`return document.documentElement.dataset.motion`)) === 'off', 'nothing moves at off');

  // A value nobody wrote is not obeyed
  await page.eval(`localStorage.setItem('claudio-motion', 'sparkly');`);
  await page.goto('/', 1200);
  check((await page.eval(`return document.documentElement.dataset.motion`)) === 'full', 'a stored level that is not one falls back to full');

  // ---- the ecosystem's live surfaces: a card, a row and a work item whose chat is running ----
  let projectId = null;
  let chatId = null;
  let terminalId = null;
  const flowChats = [];
  const assistantRuns = [];
  try {
    const dir = join(dirs.workspaceDir, 'e2e-motion');
    mkdirSync(dir, { recursive: true });
    // Something to read, or the assistant has nothing to do and starts no chat
    writeFileSync(join(dir, 'README.md'), '# e2e-motion\n');
    const imported = await api.post('/projects/import', { path: dir, name: 'e2e-motion', template: 'software' });
    check(imported.status === 201, `a project with its board (${imported.status})`);
    projectId = imported.body.id;
    const made = await api.post(`/projects/${projectId}/work-items`, { title: 'Keep a chat working', description: 'run: sleep 120' });
    check(made.status === 201, `the item was created (${made.status})`);
    const item = made.body;
    const work = await api.post(`/work-items/${item.id}/work`, {});
    check(work.status === 201 || work.status === 200, `Work on it started a chat (${work.status} ${JSON.stringify(work.body)})`);
    chatId = work.body.chat.id;

    // A member at work: the card is placed while the flow is off, then moved into the column its role answers for
    const team = await api.post(`/projects/${projectId}/team/from-template`, {});
    check(team.status === 200 || team.status === 201, `the template's team (${team.status})`);
    const flowItem = (await api.post(`/projects/${projectId}/work-items`, { title: 'Keep a member working', status: 'todo', description: 'run: sleep 120' })).body;
    const settings = (await api.get(`/projects/${projectId}/settings`)).body;
    const on = await api.put(`/projects/${projectId}/settings`, {
      ...settings,
      flow: { ...(settings.flow ?? {}), enabled: true, columns: { backlog: 'product-owner', todo: 'product-owner', in_progress: 'developer', in_review: 'qa' }, maxBounces: 3 },
    });
    check(on.status === 200, `the flow is on (${on.status})`);
    await api.post(`/work-items/${flowItem.id}/move`, { status: 'in_progress' });
    for (let i = 0; i < 40; i++) {
      const flow = (await api.get(`/projects/${projectId}/flow`)).body;
      for (const run of flow?.running ?? []) if (run.chatId && !flowChats.includes(run.chatId)) flowChats.push(run.chatId);
      if (flowChats.length > 0) break;
      await page.sleep(500);
    }
    check(flowChats.length > 0, 'the Developer is working on the card');

    // The assistant at work, one run of each kind: every one reads until it is stopped
    const reading = 'run: sleep 120';
    const readingScripts = {
      'project "e2e-motion"': reading,
      'the next work items: what is missing or broken': reading,
      '`resources`: agents, skills and commands that would help': reading,
    };
    writeFileSync(fakeCli.scripts, JSON.stringify(readingScripts));
    for (const kind of ['project', 'work-items', 'resources']) {
      const started = await api.post(`/projects/${projectId}/assistant/runs`, { kind });
      check(started.status === 201 || started.status === 200, `an assistant run of kind ${kind} (${started.status} ${JSON.stringify(started.body)})`);
      check(started.body.status === 'running', `the ${kind} run is reading (${started.body.status})`);
      assistantRuns.push(started.body.id);
    }

    const board = `/tasks?project=${projectId}`;
    // Each page, and what shows its live thing: a rail on a row, or the energy border of a run
    const rail = 'main .live-rail';
    const energy = '.suggestion-run.is-live.live-energy';
    const pages = [
      [board, rail],
      [`${board}&view=list`, rail],
      [`/tasks/${item.key}?project=${projectId}`, rail],
      [`/?project=${projectId}&view=team`, rail],
      [`/projects/${projectId}/assistant`, `main ${energy}`],
      [`${board}&suggest=1`, `[role=dialog] ${energy}`],
      [`/?project=${projectId}&view=resources`, `main ${energy}`],
    ];
    const open = async (path, live = rail) => {
      await page.goto(path, 1200);
      await page.waitFor(`return !!document.querySelector(${JSON.stringify(live)})`, { label: `${path} shows something live` });
      await page.sleep(300);
    };

    // Full: the live things are what moves, and a run's screen has one energy border
    await page.eval(`localStorage.setItem('claudio-motion', 'full');`);
    for (const [path, live] of pages) {
      await open(path, live);
      const moving = await page.eval(loops(live === rail ? 'main' : live));
      check(moving.length > 0, `${path}: what is at work moves at full`);
      if (live !== rail) {
        const borders = await page.eval(`return document.querySelectorAll('.live-energy').length`);
        check(borders === 1, `${path}: one energy border (${borders})`);
      }
      // Nobody is looking: a hidden tab pauses every one of them
      await page.eval(`document.documentElement.dataset.hidden = 'true';`);
      const hidden = await page.eval(loops());
      check(hidden.length === 0, `${path}: a hidden tab runs no loop (${hidden.join(', ')})`);
    }

    for (const level of ['subtle', 'off']) {
      await page.eval(`localStorage.setItem('claudio-motion', '${level}');`);
      for (const [path, live] of pages) {
        await open(path, live);
        const still = await page.eval(loops());
        check(still.length === 0, `${path}: nothing repeats at ${level} (${still.join(', ')})`);
      }
    }

    // The system setting stops them too, with the stored level back at full
    await page.eval(`localStorage.setItem('claudio-motion', 'full');`);
    await page.reduceMotion();
    for (const [path, live] of pages) {
      await open(path, live);
      const still = await page.eval(loops());
      check(still.length === 0, `${path}: nothing repeats under prefers-reduced-motion (${still.join(', ')})`);
    }
    await page.reduceMotion(false);

    // A phone's board is a list, and its live row stops the same way
    await page.viewport(390, 844);
    await page.eval(`localStorage.setItem('claudio-motion', 'subtle');`);
    await open(board);
    const phone = await page.eval(loops());
    check(phone.length === 0, `the phone's board: nothing repeats at subtle (${phone.join(', ')})`);
    // …and so does the phone's list of members, with one at work
    await open(`/?project=${projectId}&view=team`);
    const members = await page.eval(loops());
    check(members.length === 0, `the phone's team: nothing repeats at subtle (${members.join(', ')})`);
    // …and the phone's assistant, whose run card is the screen
    await open(`/projects/${projectId}/assistant`, `main ${energy}`);
    const assistant = await page.eval(loops());
    check(assistant.length === 0, `the phone's assistant: nothing repeats at subtle (${assistant.join(', ')})`);

    // ---- a chat compacting: live while the CLI summarises, and still at subtle and off ----
    // The fake holds `/compact` for half a minute with FAKE-COMPACT-SLOW in its focus; the cleanup stops the chat
    await page.viewport(1440, 900);
    // Compaction is refused to a chat with no history, which the fake leaves only when it writes a transcript
    writeFileSync(fakeCli.scripts, JSON.stringify({ ...readingScripts, '@transcript': true }));
    const compacting = await api.post('/chats', { prompt: 'a short chat to compact', cwd: dir });
    check(compacting.status === 201, `a chat to compact (${compacting.status})`);
    flowChats.push(compacting.body.id);
    for (let i = 0; i < 40; i++) {
      if ((await api.get(`/chats/${compacting.body.id}`)).body?.chat?.state === 'idle') break;
      await page.sleep(250);
    }
    const asked = await api.post(`/chats/${compacting.body.id}/compact`, { focus: 'FAKE-COMPACT-SLOW', structuredNote: false });
    check(asked.status === 202, `the compaction was accepted (${asked.status} ${JSON.stringify(asked.body)})`);
    for (const level of ['full', 'subtle', 'off']) {
      await page.eval(`localStorage.setItem('claudio-motion', '${level}');`);
      await open(`/chats/${compacting.body.id}`, '.chat-head');
      await page.waitFor(`return /Compacting/.test(document.querySelector('main')?.innerText ?? '')`, { label: `the page says the chat is compacting at ${level}` });
      if (level !== 'full') {
        const running = await page.eval(loops('main'));
        check(running.length === 0, `a chat compacting: nothing repeats at ${level} (${running.join(', ')})`);
      }
    }
    await page.eval(`localStorage.setItem('claudio-motion', 'full');`);

    // ---- what is running beside a chat: the strip's braille spinner turns at full, holds still at subtle and off ----
    // The fake's `background:` line leaves a command running after the turn; the cleanup stops the chat, and it with it
    writeFileSync(fakeCli.scripts, JSON.stringify({ 'MOTION-BRANCHES': 'background: sleep 120\nsay: The watcher runs.' }));
    const watching = await api.post('/chats', { prompt: 'MOTION-BRANCHES: start the watcher', cwd: dir });
    check(watching.status === 201, `a chat with a background command (${watching.status})`);
    flowChats.push(watching.body.id);
    // Four reads of the glyph a beat apart (not a multiple of the ten-frame turn): a spinner that turns
    // shows more than one, and a still one shows the still glyph (SPINNER_STILL) every time
    const glyphs = `
      const read = () => document.querySelector('.chat-branches-bar .spinner-glyph')?.textContent ?? null;
      const seen = [read()];
      for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 330)); seen.push(read()); }
      return seen;`;
    for (const level of ['full', 'subtle', 'off']) {
      await page.eval(`localStorage.setItem('claudio-motion', '${level}');`);
      await open(`/chats/${watching.body.id}`, '.chat-branches-bar .spinner-glyph');
      const seen = await page.eval(glyphs);
      if (level === 'full') {
        check(new Set(seen).size > 1, `the strip's spinner turns at full (${seen.join(' ')})`);
      } else {
        check(seen.every((glyph) => glyph === '⠿'), `the strip's spinner holds still at ${level} (${seen.join(' ')})`);
        const running = await page.eval(loops('main'));
        check(running.length === 0, `a chat with a branch running: nothing repeats at ${level} (${running.join(', ')})`);
      }
    }
    await page.eval(`localStorage.setItem('claudio-motion', 'full');`);

    // ---- the terminal: its cursor blinks at full and sits still at subtle and off ----
    // The terminal is the person's own shell, not a live agent: it never earns a loop of its own
    await page.viewport(1440, 900);
    await page.eval(`localStorage.setItem('claudio-terminal-renderer', 'dom');`);
    await api.put('/terminal/settings', { enabled: true });
    const shell = await api.post('/terminals', { projectId });
    check(shell.status === 201, `a terminal was opened (${shell.status})`);
    terminalId = shell.body?.id ?? null;
    const cursor = `
      const el = document.querySelector('.term .xterm-rows .xterm-cursor');
      return { cursor: !!el, blink: !!document.querySelector('.term .xterm-cursor-blink') };`;
    for (const level of ['full', 'subtle', 'off']) {
      await page.eval(`localStorage.setItem('claudio-motion', '${level}');`);
      // The panel is the only desktop surface of a terminal: the status bar's item opens it
      await open(`/?project=${projectId}`, '.statusbar-btn');
      if (!(await page.eval(`return !!document.querySelector('.term-dock')`))) await page.click('.statusbar-btn', undefined, 800);
      // xterm draws the cursor of a focused screen only, and a reloaded panel does not take the keyboard
      await page.waitFor(`return !!document.querySelector('.term .xterm-helper-textarea')`, { label: 'the panel attaches a terminal' });
      await page.emulateFocus();
      await page.focus('.term .xterm-helper-textarea');
      await page.waitFor(`return !!document.querySelector('.term .xterm-rows .xterm-cursor')`, { label: 'the panel draws the cursor' });
      const seen = await page.eval(cursor);
      check(seen.cursor, `the terminal draws its cursor at ${level}`);
      if (level === 'full') {
        check(seen.blink, 'the cursor blinks at full');
      } else {
        check(!seen.blink, `the cursor is steady at ${level}`);
        const running = await page.eval(loops('.term'));
        check(running.length === 0, `the terminal: nothing repeats at ${level} (${running.join(', ')})`);
      }
    }
  } finally {
    await page.emulateFocus(false).catch(() => {});
    await page.reduceMotion(false).catch(() => {});
    await page.viewport(1440, 900).catch(() => {});
    await page.eval(`localStorage.removeItem('claudio-motion');`).catch(() => {});
    for (const id of assistantRuns) await api.post(`/assistant/runs/${id}/stop`).catch(() => {});
    if (projectId) {
      // Off first, so stopping the member's run starts nothing after it
      const settings = (await api.get(`/projects/${projectId}/settings`).catch(() => ({ body: null }))).body;
      if (settings?.flow) await api.put(`/projects/${projectId}/settings`, { ...settings, flow: { ...settings.flow, enabled: false } }).catch(() => {});
    }
    for (const id of flowChats) {
      await api.post(`/chats/${id}/stop`).catch(() => {});
      for (let i = 0; i < 40; i++) {
        if ((await api.del(`/chats/${id}`).catch(() => ({ status: 0 }))).status === 200) break;
        await page.sleep(250);
      }
    }
    if (chatId) {
      await api.post(`/chats/${chatId}/stop`).catch(() => {});
      for (let i = 0; i < 40; i++) {
        if ((await api.del(`/chats/${chatId}`).catch(() => ({ status: 0 }))).status === 200) break;
        await page.sleep(250);
      }
    }
    if (terminalId) await api.del(`/terminals/${terminalId}`).catch(() => {});
    await api.put('/terminal/settings', { enabled: false }).catch(() => {});
    await page.eval(`localStorage.removeItem('claudio-terminal-renderer'); localStorage.removeItem('claudio-terminal-bar');`).catch(() => {});
    if (projectId) await api.del(`/projects/${projectId}`).catch(() => {});
  }
};
