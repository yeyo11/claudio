// Context control (docs/plans/context-control.md), against the fake CLI: the breakdown panel with its
// categories and the MCP warning, a compaction with a focus (the divider, the meter, the fold, the
// session note), a compaction that fails, the header's refusal while the chat works, a chat with no
// process that compacts by resuming, a typed `/compact`, and the phone's sheets with their 44 px targets.
//
// The fake plays the CLI's own recordings (e2e/fake-cli/README.md): `"@context"` makes the chats
// report a context worth watching, `"@transcript"` makes it write the session file the divider is read
// from, `FAKE-COMPACT-FAIL` in a focus makes that compaction fail.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const fakeCli = true;
export const timeout = 240_000;

const CONTEXT_TOKENS = 150_000;
const SUMMARY_START = 'This session is being continued';

export default async ({ page, api, check, dirs, fakeCli: fake }) => {
  const savedScripts = existsSync(fake.scripts) ? readFileSync(fake.scripts, 'utf8') : null;
  writeFileSync(fake.scripts, JSON.stringify({ '@transcript': true, '@context': CONTEXT_TOKENS, 'CTX-WORK': 'run: true\nhold: ctx-work.hold\nsay: Done.' }));
  const started = [];

  const until = async (condition, label, ms = 20_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = await condition();
      if (value) return value;
      if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
      await page.sleep(200);
    }
  };
  const startChat = async (prompt) => {
    const res = await api.post('/chats', { prompt, cwd: dirs.workspaceDir });
    check(res.status === 201, `the chat "${prompt}" started (${res.status} ${JSON.stringify(res.body)})`);
    started.push(res.body.id);
    return res.body.id;
  };
  const detail = async (id) => (await api.get(`/chats/${id}`)).body;
  const idle = (id) => until(async () => (await detail(id))?.chat?.state === 'idle', `chat ${id} to be idle`);
  const compactions = async (id) => (await api.get(`/chats/${id}/compactions`)).body ?? [];
  const settled = (id, count) => until(async () => (await compactions(id)).filter((c) => ['done', 'failed', 'cancelled'].includes(c.state)).length >= count, `${count} compaction(s) of ${id} to end`, 45_000);
  const open = async (id) => {
    await page.goto(`/chats/${id}`, 1200);
    await page.waitFor(`return !!document.querySelector('.composer [data-composer-input]')`, { label: 'the composer' });
  };
  const dialogText = () => page.eval(`return document.querySelector('[role=dialog]')?.innerText ?? ''`);
  const closeDialog = async () => {
    await page.key('Escape');
    await page.waitFor(`return document.querySelector('[role=dialog]') === null`, { label: 'the dialog closed' });
  };
  const openMenu = async () => {
    // Opened the way a keyboard does: Radix opens a menu on pointerdown, never on a synthetic click
    await page.focus('main .chat-head .chat-more');
    await page.press('Enter');
    await page.waitFor(`return !!document.querySelector('[role=menu], [role=dialog] .sheet-actions')`, { label: 'the header menu' });
  };
  // The compact entry of the header's menu (a menu on a desktop, a sheet's buttons on a phone)
  const compactEntry = `
    const items = [...document.querySelectorAll('[role=menuitem], [role=dialog] .sheet-actions button')];
    const el = items.find((e) => e.textContent.includes('Compact the conversation') || e.textContent.includes('Compacting'));
    if (!el) return null;
    return { disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled'), text: el.closest('[role=menu], .sheet-actions')?.innerText ?? el.textContent };`;
  const openCompactDialog = async () => {
    await openMenu();
    await page.click('[role=menuitem], [role=dialog] .sheet-actions button', 'Compact the conversation', 700);
    await page.waitFor(`return !!document.querySelector('[role=dialog] .compact-form')`, { label: 'the compact confirmation' });
  };
  const confirmCompact = async () => {
    await page.click('[role=dialog] .btn-strong', 'Compact', 800);
  };

  try {
    await page.viewport(1440, 900);
    await page.goto('/', 800);

    // ---------- the panel: categories, deferred group and the MCP warning ----------
    const id = await startChat('CTX one: say hello');
    await idle(id);
    const served = (await api.get(`/chats/${id}/context?detail=summary`)).body;
    check(served?.live === true && served?.breakdown?.mcp?.loadedTools === 93, `the API serves the live breakdown with 93 loaded MCP tools (${JSON.stringify(served?.breakdown?.mcp)})`);
    await open(id);
    await page.click('.chat-inspector .insp-context-actions .btn', 'Breakdown', 900);
    await page.waitFor(`return /MCP tools/.test(document.querySelector('[role=dialog]')?.innerText ?? '')`, { label: 'the panel with its categories' });
    const panel = await dialogText();
    for (const category of ['System prompt', 'System tools', 'MCP tools', 'Skills', 'Messages', 'Free space']) check(panel.includes(category), `the panel lists "${category}"`);
    check(panel.includes('Outside the window'), 'the deferred categories are a group of their own, outside the window');
    // A badge is set in capitals by the design system, so the words are read from its text, not innerText
    const warnings = await page.eval(`return document.querySelector('[role=dialog] .ctx-warnings')?.textContent ?? ''`);
    check(warnings.includes('Many MCP tools (93)'), `the panel warns of the 93 MCP tools, in words (${warnings})`);
    const warned = await page.eval(`return !!document.querySelector('[role=dialog] .ctx-warnings svg')`);
    check(warned, 'the warning carries an icon beside its words');
    check((await page.eval(`return document.querySelectorAll('[role=dialog] .ctx-server').length`)) === 2, 'the two MCP servers are listed');
    check(await page.eval(`return !!document.querySelector('[role=dialog] .bar-mark')`), 'the bar carries the CLI’s auto-compaction tick');
    await closeDialog();

    // ---------- compact with a focus: divider, meter, fold and note ----------
    await openCompactDialog();
    const form = await dialogText();
    check(form.includes('0 / 500'), 'the confirmation counts the focus out of 500');
    await page.fill('[role=dialog] .compact-focus', 'the plan and the failing test');
    check((await dialogText()).includes('29 / 500'), 'the counter follows what is typed');
    const noteSwitch = await page.eval(`const s = document.querySelector('[role=dialog] [role=switch]'); return s ? s.getAttribute('aria-checked') : null`);
    check(noteSwitch === 'true', `the note switch is on by default (${noteSwitch})`);
    await confirmCompact();
    await page.waitFor(`return !document.querySelector('[role=dialog] .compact-form')`, { label: 'the confirmation closed' });
    await settled(id, 1);
    const done = (await compactions(id))[0];
    check(done?.state === 'done' && done.focus === 'the plan and the failing test', `the compaction is done with its focus (${JSON.stringify(done)})`);
    await page.waitFor(`return !!document.querySelector('.transcript .compaction-divider')`, { label: 'the divider in the transcript', timeout: 30_000 });
    const label = await page.text('.transcript .compaction-divider');
    check(/Compacted/.test(label) && /by hand/.test(label) && /→/.test(label), `the divider says what happened and from what to what (${label})`);
    const after = (await detail(id)).chat.context;
    check(after?.compactedSince?.postTokens === 1655, `the meter reads the boundary’s figure, not the old response (${JSON.stringify(after?.compactedSince)})`);
    // `used` stays the last response's figure until the next one; the meter reads `compactedSince`, and
    // the fake reports no model window, so the share is compared as the tokens it is a share of
    check(after.used === CONTEXT_TOKENS && (after.compactedSince?.postTokens ?? Infinity) < after.used, `the share fell (${after.compactedSince?.postTokens} from ${after.used})`);
    // The inspector redraws from the chat's next event, which can land after the API already answers
    await page.waitFor(`return /1\\.7k|1,655|1\\.6k/.test(document.querySelector('.chat-inspector .insp-context-note')?.innerText ?? '')`, { label: 'the inspector says what the compaction left', timeout: 15_000 });
    check(true, 'the inspector says what the compaction left');
    check(!(await page.eval(`return [...document.querySelectorAll('.transcript .msg-user')].some((m) => m.innerText.includes(${JSON.stringify(SUMMARY_START)}))`)), 'the summary is not a message of the person’s');
    // The fold: closed by default, the summary inside
    check(!(await page.text('.transcript')).includes(SUMMARY_START), 'the summary is folded');
    await page.click('.transcript .compaction-fold-title, .transcript .compaction-fold button', undefined, 500);
    await page.waitFor(`return (document.querySelector('.transcript .compaction-summary')?.innerText ?? '').includes(${JSON.stringify(SUMMARY_START)})`, { label: 'the summary in the fold' });
    // The note the switch asked for, in the inspector
    await page.waitFor(`return document.querySelectorAll('.chat-inspector .insp-notes .note-item').length > 0`, { label: 'the session note in the inspector', timeout: 30_000 });
    // Section titles are set in capitals by the design system: read the words, not the rendered case
    check((await page.eval(`return document.querySelector('.chat-inspector .insp-notes')?.textContent ?? ''`)).includes('Session notes'), 'the inspector has a Session notes section with the note');

    // ---------- a compaction that fails: the notice, and the button comes back ----------
    await openCompactDialog();
    await page.fill('[role=dialog] .compact-focus', 'FAKE-COMPACT-FAIL');
    await confirmCompact();
    await settled(id, 2);
    const failed = (await compactions(id)).find((c) => c.state === 'failed');
    check(failed?.failure === 'cli' && /aborted/i.test(failed.error ?? ''), `the failed compaction keeps the CLI’s words (${JSON.stringify(failed)})`);
    await page.waitFor(`return /Compaction failed/.test(document.body.innerText)`, { label: 'the notice that it failed' });
    await page.waitFor(`const b = [...document.querySelectorAll('.chat-inspector .insp-context-actions .btn')].find((e) => e.textContent.includes('Compact now')); return !!b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled`, { label: 'Compact now offered again' });
    check((await detail(id)).chat.state === 'idle', 'the chat is idle after the failure');

    // ---------- a typed /compact is a divider too ----------
    const dividers = await page.eval(`return document.querySelectorAll('.transcript .compaction-divider').length`);
    await page.fill('.composer [data-composer-input]', '/compact');
    await page.click('.composer-send', undefined, 500);
    await until(async () => (await page.eval(`return document.querySelectorAll('.transcript .compaction-divider').length`)) > dividers, 'the typed /compact to leave a divider', 30_000);
    check((await compactions(id)).some((c) => c.origin === 'typed' && c.state === 'done'), 'the typed /compact is recorded like the button’s');

    // ---------- the header says why not while the chat works ----------
    const working = await startChat('CTX-WORK keep busy');
    await until(async () => (await detail(working))?.chat?.state === 'working', 'the chat to be working');
    await open(working);
    const refused = (await detail(working)).chat.compact;
    check(refused?.available === false && refused.refusal === 'busy', `a working chat refuses (${JSON.stringify(refused)})`);
    await openMenu();
    const entry = await page.eval(compactEntry);
    check(entry?.disabled === true, `Compact the conversation is disabled while the chat works (${JSON.stringify(entry)})`);
    check(/working/i.test(entry?.text ?? ''), `the menu says why (${entry?.text})`);
    await page.key('Escape');
    writeFileSync(join(dirs.workspaceDir, 'ctx-work.hold'), '');
    await idle(working);

    // ---------- a chat with no process compacts by resuming ----------
    await api.post(`/chats/${id}/stop`);
    await until(async () => (await api.get(`/chats/${id}/context`)).body?.live === false, 'the process to be gone');
    const resumed = await api.post(`/chats/${id}/compact`, { structuredNote: false });
    check(resumed.status === 202, `compacting a chat with no process is accepted (${resumed.status} ${JSON.stringify(resumed.body)})`);
    await until(async () => (await compactions(id)).filter((c) => c.state === 'done').length >= 2, 'the resumed compaction to finish', 45_000);

    // ---------- phone width: sheets and 44 px targets ----------
    await page.viewport(420, 900);
    await open(id);
    await page.click('main .chat-head button[aria-label="Chat details"]', undefined, 800);
    await page.waitFor(`return !!document.querySelector('[role=dialog] .insp-context-actions')`, { label: 'the details sheet' });
    await page.click('[role=dialog] .insp-context-actions .btn', 'Breakdown', 900);
    await page.waitFor(`return document.querySelectorAll('[role=dialog]').length > 0 && /MCP tools/.test(document.body.innerText)`, { label: 'the panel as a sheet' });
    const small = await page.eval(`
      const sheet = [...document.querySelectorAll('[role=dialog]')].pop();
      const bad = [...sheet.querySelectorAll('button:not([disabled]), label.check')].filter((b) => b.getClientRects().length).map((b) => { const r = b.getBoundingClientRect(); return { text: b.textContent.trim().slice(0, 30), h: Math.round(r.height), w: Math.round(r.width) }; }).filter((r) => r.h < 44 || r.w < 44);
      return { bad };`);
    check(small.bad.length === 0, `the panel’s targets are 44 px on a phone (${JSON.stringify(small.bad)})`);
    // The 44 px is a switch's invisible hit box: the track drawn inside stays a 34 × 20 pill, never a round blob
    const tracks = await page.eval(`
      const sheet = [...document.querySelectorAll('[role=dialog]')].pop();
      return [...sheet.querySelectorAll('[role=switch]')].filter((s) => s.getClientRects().length).map((s) => {
        const t = getComputedStyle(s, '::before'); const r = s.getBoundingClientRect();
        const w = r.width - parseFloat(t.left) - parseFloat(t.right); const h = r.height - parseFloat(t.top) - parseFloat(t.bottom);
        return { w: Math.round(w), h: Math.round(h) };
      });`);
    check(tracks.length > 0 && tracks.every((t) => t.w >= 30 && t.w <= 40 && t.h >= 16 && t.h <= 24), `every switch in the sheet keeps its 34 × 20 track (${JSON.stringify(tracks)})`);
    await page.key('Escape');
    await page.waitFor(`return !document.querySelector('.ctx-breakdown')`, { label: 'the panel closed' });
    await page.key('Escape');
    await page.sleep(300);
    await page.goto(`/chats/${id}`, 1000);
    await openCompactDialog();
    const phone = await page.eval(`
      const d = document.querySelector('[role=dialog]');
      const bad = [...d.querySelectorAll('button:not([disabled]), label.check, textarea')].filter((b) => b.getClientRects().length).map((b) => { const r = b.getBoundingClientRect(); const s = parseFloat(getComputedStyle(b).fontSize); return { text: (b.textContent || b.tagName).trim().slice(0, 30), h: Math.round(r.height), font: s, field: b.tagName === 'TEXTAREA' }; }).filter((r) => r.h < 44 || (r.field && r.font < 16));
      return bad;`);
    check(phone.length === 0, `the confirmation’s targets are 44 px and its field 16 px on a phone (${JSON.stringify(phone)})`);
    await closeDialog();
  } finally {
    await page.viewport(1440, 900).catch(() => {});
    await page.key('Escape').catch(() => {});
    writeFileSync(join(dirs.workspaceDir, 'ctx-work.hold'), '');
    for (const chat of started) {
      await api.post(`/chats/${chat}/stop`).catch(() => {});
      for (let i = 0; i < 40; i++) {
        if ((await api.del(`/chats/${chat}`).catch(() => ({ status: 0 }))).status === 200) break;
        await page.sleep(250);
      }
    }
    if (savedScripts === null) writeFileSync(fake.scripts, '{}');
    else writeFileSync(fake.scripts, savedScripts);
  }
};
