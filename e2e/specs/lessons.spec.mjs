// Lessons (docs/plans/lessons.md, "Tests"): a person denies a command, writes a correction in Spanish
// and the chat ends; the miner (answered by the fake CLI's "@lesson-miner" line) proposes one lesson;
// the Memory tab shows it with the person's quote, approving it makes it active and counted in what is
// handed, a new chat is handed the section, and "Propose for CLAUDE.md" goes through the diff dialog
// and retires the lesson. A phone gets four segments and the lesson actions in a Sheet. Both themes
// are screenshotted for comparison with DesktopMemoria / MobileMemoria, and the run is repeated under
// `[data-motion='off']`.
//
// The plan ends the chat with a short CLAUDIO_IDLE_TIMEOUT_MS; a spec cannot set the server's
// environment, so the chat is stopped through the API, which also ends its run.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { seedProject } from './memory-seed.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

export const fakeCli = true;
export const timeout = 240_000;

const POINT = 'lesson.mine';
const KEY = 'LESSON-E2E-INSTALL';
const NEXT = 'LESSON-E2E-NEXT';
const QUOTE = 'no, usa pnpm siempre';
const TRIGGER = 'When installing dependencies in this project';
const ACTION = 'Use `pnpm` and never npm.';


async function until(condition, label, limit = 30_000) {
  const end = Date.now() + limit;
  for (;;) {
    const value = await condition().catch(() => null);
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await sleep(250);
  }
}

const lessonOf = {
  trigger: TRIGGER,
  action: ACTION,
  signals: ['S1', 'S2', 'S3'],
  quote: QUOTE,
  confidence: 0.8,
  restates: '',
  contradicts: '',
  instructions: 'none',
  mechanical: true,
};

export default async ({ page, api, check, dirs, fakeCli: fake }) => {
  const savedScripts = existsSync(fake.scripts) ? readFileSync(fake.scripts, 'utf8') : null;
  writeFileSync(
    fake.scripts,
    JSON.stringify({
      '@transcript': true,
      '@lesson-miner': `json: ${JSON.stringify({ lessons: [lessonOf] })}`,
      [KEY]: 'ask: npm install\nsay: Stopped.',
      [NEXT]: 'say: Heard.',
    }),
  );
  let projectId = null;
  const chatIds = [];
  let pointBefore = null;
  try {
    // ---- 1. a project with the Memory module on, consent given and lesson.mine active ----
    const project = await seedProject({ api, check, dirs }, 'e2e-lessons');
    projectId = project.id;
    const info = (await api.get('/decisions/points')).body.find((p) => p.id === POINT);
    check(!!info, `the catalogue lists ${POINT}`);
    const settings = (await api.get('/decisions/settings')).body;
    pointBefore = settings.points?.[POINT] ?? null;
    const consent = await api.put(`/decisions/points/${POINT}/consent`, { granted: true, stateVersion: info.stateVersion, providers: ['cli'] });
    check(consent.status === 200, `consent was given (${consent.status} ${JSON.stringify(consent.body)})`);
    const { jev, ...update } = (await api.get('/decisions/settings')).body;
    const active = await api.put('/decisions/settings', { ...update, points: { ...update.points, [POINT]: { mode: 'active', threshold: info.defaultThreshold, consent: null } } });
    check(active.status === 200, `${POINT} is active (${active.status} ${JSON.stringify(active.body)})`);

    // ---- 2. a chat asks to run npm install and is denied with a reason ----
    // Prompts reach a person only when the chat asks for it; the API's default answers them with a deny
    const created = await api.post('/chats', { prompt: `${KEY} install the dependencies`, cwd: dirs.workspaceDir + '/e2e-lessons', permissionPrompts: 'host' });
    check(created.status === 200 || created.status === 201, `the chat started (${created.status} ${JSON.stringify(created.body)})`);
    const chatId = created.body.id;
    chatIds.push(chatId);
    const request = await until(async () => (await api.get(`/chats/${chatId}/permissions`)).body[0], 'the chat asks for permission');
    const denied = await api.post(`/chats/${chatId}/permissions/${request.id}`, { behavior: 'deny', message: 'use pnpm' });
    check(denied.status === 200, `the command was denied (${denied.status})`);
    await until(async () => (await api.get(`/chats/${chatId}`)).body?.chat?.state === 'idle', 'the denied turn ended');

    // ---- 3. the person writes the correction, then the chat ends ----
    const said = await api.post(`/chats/${chatId}/messages`, { text: QUOTE });
    check(said.status === 200 || said.status === 202, `the correction was sent (${said.status})`);
    await until(async () => (await api.get(`/chats/${chatId}`)).body?.chat?.state === 'idle', 'the correction was heard');
    await api.post(`/chats/${chatId}/stop`);

    // ---- 4. one lesson proposal waits in the Memory tab, with the Spanish quote ----
    const proposed = await until(
      async () => (await api.get(`/projects/${projectId}/memory/proposals?status=pending`)).body.find((p) => p.target.kind === 'lesson'),
      'the miner proposed a lesson',
      60_000,
    );
    check(proposed.target.kind === 'lesson', 'the proposal is a lesson');
    await page.viewport(1440, 1000);
    await page.goto(`/?project=${projectId}&view=memory`, 1500);
    await page.waitFor(`return document.querySelectorAll('.memory-proposals .memory-proposal').length === 1`, { label: 'one proposal waits' });
    const card = await page.text('.memory-proposal');
    check(card.includes(QUOTE), `the proposal shows the person's words (${card.slice(0, 200)})`);
    check(card.includes('lessons'), 'the proposal says where it will be written: lessons');
    check(card.includes('pnpm'), 'the proposal shows the lesson');
    await page.shot('lessons-proposal-dark');

    await page.click('.memory-proposal .memory-approve', 'Approve', 1000);
    const lessons = await until(async () => {
      const list = (await api.get(`/projects/${projectId}/lessons`)).body;
      return list.lessons?.length === 1 ? list : null;
    }, 'the lesson is active');
    const lesson = lessons.lessons[0];
    check(lesson.status === 'active', 'approving makes the lesson active');
    const handed = (await api.get(`/projects/${projectId}/journal`)).body.handed;
    check(handed.lessons === 1, `the journal reports one lesson handed (${JSON.stringify(handed)})`);

    // The Lessons card lists it: a desktop shows the card beside the others, only a phone has a Lessons segment
    await page.waitFor(`return !!document.querySelector('.lesson-row')`, { label: 'the lesson row' });
    const row = await page.text('.lesson-row');
    check(row.includes(lesson.key) && row.includes('pnpm'), `the row shows the lesson (${row.slice(0, 160)})`);
    check(/delivered/i.test(row), 'the row says it is delivered');

    // ---- 5. a new chat is handed the section ----
    const next = await api.post('/chats', { prompt: `${NEXT} hello`, cwd: dirs.workspaceDir + '/e2e-lessons' });
    chatIds.push(next.body.id);
    const logged = await until(async () => {
      const lines = readFileSync(fake.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      // The chat's own process, by the session id Claudio imposes on it: another chat starting meanwhile (an assistant's, a housekeeping run) is not it
      return lines.reverse().find((e) => e.event === 'started' && e.argv.includes('--session-id') && e.argv[e.argv.indexOf('--session-id') + 1] === next.body.id && e.argv.includes('--append-system-prompt'));
    }, 'the new chat started with a system prompt addition');
    const appended = logged.argv[logged.argv.indexOf('--append-system-prompt') + 1] ?? '';
    check(appended.includes('## Lessons') && appended.includes('pnpm'), `the new chat is handed the Lessons section (${appended.slice(0, 120)})`);

    // ---- 7. a phone: four segments, the lesson actions in a Sheet, 44 px targets ----
    await page.viewport(390, 844);
    await page.goto(`/?project=${projectId}&view=memory`, 1500);
    await page.waitFor(`return document.querySelectorAll('.memory-phone [role=radio]').length === 4`, { label: 'four segments' });
    await page.click('.memory-phone [role=radio]', 'Lessons', 800);
    await page.waitFor(`return !!document.querySelector('.memory-phone .lesson-row')`, { label: 'the lesson on a phone' });
    await page.click(`.lesson-row [aria-label^="More actions for"]`, undefined, 600);
    await page.waitFor(`return !!document.querySelector('[role=dialog]')`, { label: 'the actions Sheet' });
    const small = await page.eval(
      `return [...document.querySelectorAll('.memory-phone [role=radio], .memory-phone .btn, [role=dialog] button')].filter((el) => el.offsetParent && el.getBoundingClientRect().height < 44).map((el) => el.textContent.trim())`,
    );
    check(small.length === 0, `phone targets are at least 44 px (${JSON.stringify(small)})`);
    await page.shot('lessons-phone-dark');
    await page.key('Escape');
    await sleep(500);

    // ---- 8. light theme and motion off, on the desktop ----
    await page.viewport(1440, 1000);
    await page.goto(`/?project=${projectId}&view=memory`, 1500);
    await page.waitFor(`return !!document.querySelector('.memory-grid .lesson-row')`, { label: 'the lesson row on the desktop again' });
    await page.eval(`document.documentElement.setAttribute('data-theme', 'light'); return true`);
    await sleep(300);
    await page.shot('lessons-light');
    await page.eval(`document.documentElement.setAttribute('data-motion', 'off'); return true`);
    await sleep(300);
    check(await page.eval(`return !!document.querySelector('.lesson-row')`), 'the lesson shows in the light theme with motion off');
    await page.shot('lessons-light-motion-off');
    await page.eval(`document.documentElement.setAttribute('data-theme', 'dark'); document.documentElement.removeAttribute('data-motion'); return true`);

    // ---- 6. "Propose for CLAUDE.md": the diff dialog, then CLAUDE.md and Retired ----
    // The desktop's menu opens from the keyboard, like orchestration-v2's: a synthetic click does not open it
    await page.focus(`.memory-grid .lesson-row [aria-label^="More actions for"]`);
    await page.press('Enter');
    await page.waitFor(`return !!document.querySelector('[role=menu]')`, { label: 'the lesson menu' });
    await page.click('[role=menu] [role=menuitem]', 'Propose for CLAUDE.md', 1200);
    await until(async () => (await api.get(`/projects/${projectId}/memory/proposals?status=pending`)).body.find((p) => p.target.kind === 'instructions'), 'the instructions proposal exists');
    // The lesson's own menu opens the diff at once; the Approve of the proposal list would open a second one
    await page.waitFor(`return !!document.querySelector('.instr-diff .instr-diff-view')`, { label: 'the diff dialog shows the diff' });
    check((await page.text('.instr-diff')).includes('Lessons'), 'the diff names the Lessons section');
    await page.shot('lessons-diff-dark');
    await page.click('.instr-diff-foot .memory-approve', undefined, 1200);
    await until(async () => (await api.get(`/config/instructions?project=${projectId}&variant=shared`)).body.content?.includes('## Lessons'), 'CLAUDE.md has a Lessons section');
    const claudeMd = (await api.get(`/config/instructions?project=${projectId}&variant=shared`)).body.content;
    check(claudeMd.includes('pnpm'), 'CLAUDE.md holds the lesson');
    const retired = await until(async () => {
      const all = (await api.get(`/projects/${projectId}/lessons?status=retired`)).body;
      return all.lessons?.length === 1 ? all : null;
    }, 'the lesson moved to Retired');
    check(retired.lessons[0].id === lesson.id, 'approving the instructions proposal retired the lesson');
  } finally {
    for (const id of chatIds) await api.post(`/chats/${id}/stop`).catch(() => {});
    await page.viewport(1440, 900);
    await page.eval(`document.documentElement.removeAttribute('data-motion'); document.documentElement.setAttribute('data-theme', 'dark'); return true`).catch(() => {});
    if (projectId) await api.del(`/projects/${projectId}`).catch(() => {});
    if (pointBefore) {
      const { jev, ...update } = (await api.get('/decisions/settings')).body;
      await api.put('/decisions/settings', { ...update, points: { ...update.points, [POINT]: { ...pointBefore, consent: null } } }).catch(() => {});
    }
    if (savedScripts === null) writeFileSync(fake.scripts, '{}');
    else writeFileSync(fake.scripts, savedScripts);
  }
};
