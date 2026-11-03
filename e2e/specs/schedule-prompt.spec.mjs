// The permission prompt of a schedule the assistant asks to create (docs/plans/terminal-menu-schedules-v1-tools.md
// §2.3). A schedule spends money while nobody watches, so before the person answers the prompt says, in
// their words: what it is called, its expression and zone, what each fire starts, and then, read from
// `GET /schedules/preview`, the expression in words and its next fires, beside the monospace input block
// and never inside it. Allowing it answers the call. Shot in both themes and at phone width.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

export const fakeCli = true;
export const timeout = 180_000;

const KEY = 'SCHEDULE-PROMPT-E2E';
const INPUT = {
  name: 'Nightly digest',
  cron: '0 3 * * *',
  timezone: 'Europe/Madrid',
  target: { kind: 'chat', prompt: 'Summarise what changed yesterday' },
  overlap: 'skip',
  enabled: true,
};

async function until(condition, label, limit = 30_000) {
  const end = Date.now() + limit;
  for (;;) {
    const value = await condition().catch(() => null);
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await sleep(250);
  }
}

const PROMPT = `
  const p = document.querySelector('.permission');
  if (!p) return null;
  const input = p.querySelector('.permission-input');
  const allow = p.querySelector('.permission-actions .btn-primary');
  return {
    head: p.querySelector('.permission-head')?.innerText ?? '',
    input: input?.innerText ?? '',
    inputFont: input ? getComputedStyle(input).fontFamily : '',
    beside: [...p.querySelectorAll(':scope > p.muted')].map((e) => ({ text: e.innerText, font: getComputedStyle(e).fontFamily })),
    allowTop: allow ? Math.round(allow.getBoundingClientRect().top) : null,
    allowHeight: allow ? Math.round(allow.getBoundingClientRect().height) : null,
    width: Math.round(p.getBoundingClientRect().right),
    viewport: window.innerWidth,
  };`;

export default async ({ page, api, check, dirs, fakeCli: fake }) => {
  const savedScripts = existsSync(fake.scripts) ? readFileSync(fake.scripts, 'utf8') : null;
  writeFileSync(fake.scripts, JSON.stringify({ '@transcript': true, [KEY]: `ask: mcp__claudio__create_schedule ${JSON.stringify(INPUT)}\nsay: Scheduled.` }));
  let chatId = null;
  try {
    await page.viewport(1440, 900);
    await page.goto('/', 800);
    await page.eval(`localStorage.removeItem('claudio-theme'); return true`);
    // Prompts reach a person only when the chat asks for it; the API's default answers them with a deny
    const created = await api.post('/chats', { prompt: `${KEY} schedule a nightly digest`, cwd: dirs.workspaceDir, permissionPrompts: 'host' });
    check(created.status === 201, `the chat started (${created.status} ${JSON.stringify(created.body)})`);
    chatId = created.body.id;
    await until(async () => (await api.get(`/chats/${chatId}/permissions`)).body[0], 'the chat asks to create a schedule');

    // ---- 1. the prompt says the schedule in the person's words, and the preview beside the input ----
    await page.goto(`/chats/${chatId}`, 1200);
    await page.waitFor(`return !!document.querySelector('.permission .permission-actions .btn-primary')`, { label: 'the permission prompt' });
    const loading = await page.eval(PROMPT);
    const ready = await until(async () => {
      const now = await page.eval(PROMPT);
      return now?.beside.some((line) => line.text.startsWith('Next fires:')) ? now : null;
    }, 'the preview of the expression');
    check(ready.head.includes('Create the schedule Nightly digest'), `the head names the schedule (${JSON.stringify(ready.head)})`);
    for (const line of ['Expression: 0 3 * * *', 'Zone: Europe/Madrid', 'Starts: a chat', 'Summarise what changed yesterday']) {
      check(ready.input.includes(line), `the input block says "${line}" (${JSON.stringify(ready.input)})`);
    }
    check(!ready.input.includes('Next fires') && !ready.input.includes('In words'), 'the preview is not inside the monospace input block');
    const words = ready.beside.find((line) => line.text.startsWith('In words:'));
    const next = ready.beside.find((line) => line.text.startsWith('Next fires:'));
    check(!!words && /3/.test(words.text), `the expression is said in words (${JSON.stringify(words?.text)})`);
    check(!!next && next.text.split('·').length === 3, `the next three fires are listed (${JSON.stringify(next?.text)})`);
    check(ready.beside.every((line) => !/mono/i.test(line.font)), `the preview lines are not in mono (${JSON.stringify(ready.beside.map((l) => l.font))})`);
    // Measured, not asserted: the preview arrives with a local read, before a person can aim at Allow
    console.log(`  Allow moved ${String((ready.allowTop ?? 0) - (loading?.allowTop ?? ready.allowTop ?? 0))} px when the preview arrived`);
    await page.shot('schedule-prompt-dark');

    // ---- 2. the light theme ----
    await page.eval(`localStorage.setItem('claudio-theme', 'light'); return true`);
    await page.goto(`/chats/${chatId}`, 1200);
    await page.waitFor(`return [...document.querySelectorAll('.permission > p.muted')].some((e) => e.innerText.startsWith('Next fires:'))`, { label: 'the prompt with its preview, light' });
    check(await page.eval(`return document.documentElement.dataset.theme === 'light'`), 'the page is in the light theme');
    await page.shot('schedule-prompt-light');

    // ---- 3. a phone: the prompt fits the screen, its actions are 44 px targets ----
    await page.viewport(390, 844);
    await page.emulateTouch(true);
    await page.goto(`/chats/${chatId}`, 1200);
    await page.waitFor(`return [...document.querySelectorAll('.permission > p.muted')].some((e) => e.innerText.startsWith('Next fires:'))`, { label: 'the prompt with its preview, phone' });
    const phone = await page.eval(PROMPT);
    check(phone.width <= phone.viewport, `the prompt fits the phone (${phone.width} of ${phone.viewport})`);
    check(phone.allowHeight >= 44 - 1, `Allow is a 44 px target on a phone (${phone.allowHeight})`);
    await page.shot('schedule-prompt-phone-light');

    // ---- 4. allowing it answers the call ----
    await page.click('.permission .permission-actions .btn-primary', undefined, 800);
    await until(async () => (await api.get(`/chats/${chatId}/permissions`)).body.length === 0, 'the prompt was answered');
    const answered = await until(async () => {
      const log = readFileSync(fake.log, 'utf8');
      return log.includes('"answered"') ? log : null;
    }, 'the fake CLI heard the answer');
    check(/"answered"[^\n]*"allowed":true/.test(answered), 'the call was allowed');
  } finally {
    if (chatId) await api.post(`/chats/${chatId}/stop`).catch(() => {});
    await page.emulateTouch(false).catch(() => {});
    await page.viewport(1440, 900).catch(() => {});
    await page.eval(`localStorage.removeItem('claudio-theme'); return true`).catch(() => {});
    if (savedScripts === null) rmSync(fake.scripts, { force: true });
    else writeFileSync(fake.scripts, savedScripts);
  }
};
