// The message box: an editor that sends plain text (Shift+Enter breaks the line, Enter sends), keeps
// a draft across a reload, brings back what was sent with the arrow keys, and has a "+" menu whose
// switches turn the live chat's MCP servers on and off (the fake CLI's `mcp_status`/`mcp_toggle`).
// An answer being written above it reads at 4.5:1 in both themes, as it does once stored (R16), and
// the box sits right under the last message, with no blank room held between them (R16 b).
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const fakeCli = true;

const BOX = 'main .composer [data-composer-input]';
/** The box's text as it is sent: its paragraphs, a line each */
const text = `(e=>e&&[...e.querySelectorAll('p')].map(p=>p.textContent).join('\\n'))(document.querySelector(${JSON.stringify(BOX)}))`;
const textOf = `return ${text}`;
const SHIFT = 8;

/**
 * The page's own measure of how the text of the last `selector` reads: every element holding text,
 * its colour with the opacity of everything above it, over the first opaque background behind it.
 * The hover-only copy bar of a code block is left out; it is a control, not the answer.
 */
const legibility = (selector) => `
  const parse = (text) => { const m = /rgba?\\(([^)]+)\\)/.exec(text); if (!m) return null; const [r, g, b, a = '1'] = m[1].split(/[ ,/]+/).filter(Boolean); return [Number(r), Number(g), Number(b), Number(a)]; };
  const lum = (c) => { const [r, g, b] = c.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const over = (f, b, alpha) => f.slice(0, 3).map((v, i) => v * alpha + b[i] * (1 - alpha));
  const backdrop = (el) => { for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c[3] >= 1) return c; } return parse(getComputedStyle(document.body).backgroundColor) ?? [0, 0, 0, 1]; };
  const opacity = (el) => { let o = 1; for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };
  const all = document.querySelectorAll(${JSON.stringify(selector)});
  const root = all[all.length - 1];
  const low = [];
  let checked = 0;
  for (const el of root ? root.querySelectorAll('*') : []) {
    if (el.closest('.code-block-bar') || !el.getClientRects().length) continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    const fg = parse(getComputedStyle(el).color);
    if (!fg) continue;
    const bg = backdrop(el);
    const got = ratio(over(fg, bg, fg[3] * opacity(el)), bg);
    checked++;
    if (got < 4.5) low.push({ text: el.textContent.trim().slice(0, 40), ratio: Math.round(got * 100) / 100 });
  }
  return { checked, low };`;

/**
 * How the end of the conversation meets the box, measured at the scroller's end: the blank room
 * between the bottom of the last thing written (any child of the scroller with text or media; an
 * empty block reserving room is the defect, so it does not count) and the top of the box.
 */
const composerGap = `
  const scroller = document.querySelector('.run-scroll');
  const box = document.querySelector('main .composer');
  if (!scroller || !box) return null;
  scroller.scrollTop = scroller.scrollHeight;
  const written = [...scroller.children].filter((e) => e.getClientRects().length && getComputedStyle(e).position !== 'absolute' && (e.textContent.trim() || e.querySelector('img, svg')));
  const last = Math.max(...written.map((e) => e.getBoundingClientRect().bottom));
  return { gap: Math.round(box.getBoundingClientRect().top - last), scrolled: scroller.scrollTop };`;

export default async ({ page, api, dirs, check }) => {
  const created = await api.post('/chats', { prompt: 'hello', cwd: dirs.workspaceDir });
  check(created.status === 201, `the chat was created (${created.status})`);
  const id = created.body.id;
  const waitForReply = (text) =>
    page.waitFor(`return document.querySelector('.transcript')?.innerText.includes(${JSON.stringify(text)})`, { label: `the reply "${text}"` });
  try {
    await page.goto(`/chats/${id}`, 1200);
    await waitForReply('Heard: hello');
    await page.waitFor(`return !!document.querySelector(${JSON.stringify(BOX)})`, { label: 'the message box' });

    // Shift+Enter breaks the line; what the box holds is the text, a line per paragraph
    await page.focus(BOX);
    await page.type('line one');
    await page.key('Enter', SHIFT);
    await page.type('line two');
    check((await page.eval(textOf)) === 'line one\nline two', `Shift+Enter breaks the line (${JSON.stringify(await page.eval(textOf))})`);

    // A reload keeps what was typed and not sent
    await page.sleep(600);
    await page.goto(`/chats/${id}`, 1200);
    await page.waitFor(`return !!document.querySelector(${JSON.stringify(BOX)})`, { label: 'the box after a reload' });
    check((await page.eval(textOf)) === 'line one\nline two', `the draft survives a reload (${JSON.stringify(await page.eval(textOf))})`);

    // Enter sends it, and the box empties
    await page.focus(BOX);
    await page.key('Enter');
    await waitForReply('Heard: line one');
    await page.waitFor(`return ${text} === ''`, { label: 'the box to empty' });

    // ArrowUp brings back what was sent, newest first; ArrowDown walks back to an empty box
    await page.focus(BOX);
    await page.key('ArrowUp');
    check((await page.eval(textOf)) === 'line one\nline two', `ArrowUp recalls the last message (${JSON.stringify(await page.eval(textOf))})`);
    await page.key('ArrowUp');
    check((await page.eval(textOf)) === 'hello', `ArrowUp again recalls the one before (${JSON.stringify(await page.eval(textOf))})`);
    await page.key('ArrowDown');
    await page.key('ArrowDown');
    check((await page.eval(textOf)) === '', 'ArrowDown walks back to an empty box');

    // The "+" is a menu of three groups; Servers opens the live process's list, the connector by its own name
    // Opened the way a keyboard does: Radix opens a menu on pointerdown, never on a synthetic click
    await page.focus('main .composer-plus');
    await page.press('Enter');
    await page.waitFor(`return document.querySelectorAll('[role=menu] [role=group]').length >= 2`, { label: 'the menu and its groups' });
    check(
      await page.eval(`const b = document.querySelector('main .composer-plus'); return b?.getAttribute('aria-haspopup') === 'menu' && b.getAttribute('aria-label') === 'Add and options'`),
      'the "+" is named "Add and options" and announces a menu',
    );
    await page.eval(`[...document.querySelectorAll('[role=menu] [role=menuitem]')].find((i) => i.innerText.includes('Servers and connectors'))?.click(); return true`);
    await page.waitFor(`return document.querySelectorAll('.composer-server').length === 2`, { label: 'the two servers in the menu' });
    const rows = await page.eval(`return [...document.querySelectorAll('.composer-server')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim().toLowerCase())`);
    check(rows[0]?.startsWith('docs') && rows[0].includes('connected') && rows[0].includes('2 tools'), `the local server, connected with its tools (${rows[0]})`);
    check(rows[1]?.startsWith('calendar') && rows[1].includes('needs authorisation') && rows[1].includes('connector'), `the connector, waiting for its authorisation (${rows[1]})`);
    check(await page.eval(`return !!document.querySelector('.composer-server a[href="/settings/connections#connectors"]')`), 'a connector waiting for authorisation links to how to give it');
    await page.shot('composer-menu');

    // Its switch turns the server off in the running process
    await page.click('.composer-server button[role=switch]');
    await page.waitFor(`return document.querySelector('.composer-server')?.classList.contains('is-off')`, { label: 'the server switched off' });
    const after = await api.get(`/chats/${id}/mcp`);
    check(after.body.live === true && after.body.servers[0]?.status === 'disabled', `the process reports it disabled (${JSON.stringify(after.body.servers[0])})`);

    // R16 (a): an answer being written reads as well as the stored one. The fake types half of it
    // (a paragraph and a code block) and holds the rest, so the page shows it mid-stream
    const released = join(dirs.workspaceDir, 'streaming-legible-release');
    rmSync(released, { force: true });
    const typed = 'type: Here is the fix, readable while it streams:\\n\\n```ts\\nconst answer = 42;\\nconst label = "answer";\\n```\\n\\nThe rest of this answer arrives once the hold is released, with enough words after it to keep the code block in the first half.';
    const sent = await api.post(`/chats/${id}/messages`, { text: `${typed}\nhold: streaming-legible-release` });
    check(sent.status === 200 || sent.status === 202, `the streaming turn was sent (${sent.status})`);
    await page.waitFor(`return !!document.querySelector('.msg-streaming .streaming-text .code-block')`, { label: 'the streaming answer with its code block' });
    const settled = await page.eval(`await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null))); return true`);
    check(settled, 'the entrance animations of the streaming answer finished');
    const streamingDark = await page.eval(legibility('.msg-streaming'));
    check(streamingDark.checked > 0, `the streaming answer has text to measure (${streamingDark.checked})`);
    check(streamingDark.low.length === 0, `dark: the streaming answer keeps 4.5:1 (${JSON.stringify(streamingDark.low)})`);
    await page.eval(`document.documentElement.setAttribute('data-theme', 'light'); return true`);
    const streamingLight = await page.eval(legibility('.msg-streaming'));
    check(streamingLight.low.length === 0, `light: the streaming answer keeps 4.5:1 (${JSON.stringify(streamingLight.low)})`);
    await page.eval(`document.documentElement.setAttribute('data-theme', 'dark'); return true`);
    check(await page.eval(`return document.querySelectorAll('.msg-streaming .streaming-text').length === 1`), 'the live caret still marks the answer as it is written');
    await page.shot('composer-streaming-legible');

    // R16 (b): in a conversation taller than the view, the box sits right under the answer being
    // written: nothing keeps the question at the top by filling the view below a short answer
    const GAP_MAX = 48;
    await page.viewport(1440, 560);
    const streamingGap = await page.eval(composerGap);
    check(streamingGap && streamingGap.scrolled > 0, `the conversation is taller than the view (${JSON.stringify(streamingGap)})`);
    check(streamingGap && streamingGap.gap <= GAP_MAX, `while it streams, the box sits right under the last message (${JSON.stringify(streamingGap)})`);
    await page.shot('composer-no-gap-streaming');

    // Released, the same answer is stored and reads the same
    writeFileSync(released, '');
    await waitForReply('enough words after it');
    await page.waitFor(`return !document.querySelector('.msg-streaming')`, { label: 'the streaming answer stored' });
    const stored = await page.eval(legibility('.msg-assistant:has(.code-block)'));
    check(stored.checked > 0 && stored.low.length === 0, `after the turn the answer keeps 4.5:1 (${JSON.stringify(stored.low)})`);
    const storedGap = await page.eval(composerGap);
    check(storedGap && storedGap.gap <= GAP_MAX, `after the turn, the box sits right under the last message (${JSON.stringify(storedGap)})`);
    await page.viewport(1440, 900);
    rmSync(released, { force: true });
  } finally {
    await page.viewport(1440, 900);
    await api.post(`/chats/${id}/stop`);
    for (let i = 0; i < 40; i++) {
      if ((await api.del(`/chats/${id}`)).status === 200) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
};
