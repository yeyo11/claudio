// What is running at a glance (docs/plans/tool-rows-and-live-branches.md §3.3), against the fake CLI:
// one turn launches a background subagent and a background command. The strip over the composer
// appears folded with the count, opens onto a row per branch with the subagent's own line, the step
// keeps a card per branch, and once both end the rows say "done", leave, and the strip goes; a
// reload shows the cards with their final words.
//
// The fake's `agent:` and `background:` lines (e2e/fake-cli/README.md) play what the CLI streams.
// Hold files keep each part going for as long as the spec reads it: the subagent's Read stays open
// (a subagent's activity is its open call), the command loops until its file exists, and the turn
// itself waits, because a turn that ends clears what the subagents were doing.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const fakeCli = true;
export const timeout = 150_000;

const KEY = 'BRANCHES-LIVE';
const READ = 'e2e-branches-notes.md';
const HOLDS = { agent: 'e2e-branches-agent.hold', task: 'e2e-branches-task.hold', turn: 'e2e-branches-turn.hold' };
const STORAGE = 'claudio-chat-branches';

export default async ({ page, api, check, dirs, fakeCli: fake }) => {
  const savedScripts = existsSync(fake.scripts) ? readFileSync(fake.scripts, 'utf8') : null;
  const work = dirs.workspaceDir;
  const files = [READ, ...Object.values(HOLDS)].map((name) => join(work, name));
  for (const file of files) rmSync(file, { force: true });
  writeFileSync(join(work, READ), '# Notes\n\nWhat the subagent reads.\n');
  writeFileSync(
    fake.scripts,
    JSON.stringify({
      '@transcript': true,
      [KEY]: [
        `agent: background: Explore the notes | read: ${READ}; hold: ${HOLDS.agent}`,
        `background: until [ -e ${HOLDS.task} ]; do sleep 0.1; done`,
        `hold: ${HOLDS.turn}`,
        'say: Both are under way.',
      ].join('\n'),
    }),
  );
  let chatId = null;

  const state = () =>
    page.eval(`
      const strip = document.querySelector('.chat-branches');
      const bar = strip?.querySelector('.chat-branches-bar');
      return {
        strip: !!strip,
        expanded: bar?.getAttribute('aria-expanded') ?? null,
        count: strip?.querySelector('.chat-branches-count')?.textContent.trim() ?? '',
        now: strip?.querySelector('.chat-branches-now')?.textContent.trim() ?? '',
        rows: [...(strip?.querySelectorAll('.chat-branch-row') ?? [])].map((r) => ({
          cls: r.className,
          kind: r.querySelector('.chat-branch-kind')?.textContent.trim() ?? '',
          act: r.querySelector('.chat-branch-act')?.textContent.trim() ?? '',
          word: r.querySelector('.word')?.textContent.trim() ?? '',
        })),
      };`);
  const cards = () =>
    page.eval(`return [...document.querySelectorAll('.transcript .chat-launch')].map((c) => ({
      cls: c.className,
      name: c.querySelector('.chat-launch-name')?.textContent.trim() ?? '',
      status: c.querySelector('.chat-launch-status')?.textContent.trim() ?? '',
      open: !!c.querySelector('.chat-launch-open'),
    }))`);

  try {
    await page.viewport(1440, 900);
    await page.goto('/', 800);
    await page.eval(`localStorage.removeItem(${JSON.stringify(STORAGE)}); return true`);

    const res = await api.post('/chats', { prompt: `${KEY}: look through the notes while the watcher runs`, cwd: work });
    check(res.status === 201, `the chat started (${res.status} ${JSON.stringify(res.body)})`);
    chatId = res.body.id;
    await page.goto(`/chats/${chatId}`, 1200);
    await page.waitFor(`return !!document.querySelector('.composer [data-composer-input]')`, { label: 'the chat page' });

    // ---- folded by default: one line with the count, the list not on the page ----
    await page.waitFor(`return document.querySelector('.chat-branches .chat-branches-count')?.textContent.trim() === '1 agent · 1 background task'`, {
      label: 'the strip counts one agent and one background task',
    });
    let seen = await state();
    check(seen.expanded === 'false', `the strip starts folded (aria-expanded=${seen.expanded})`);
    check(seen.rows.length === 0, `a folded strip shows no rows (${seen.rows.length})`);
    const order = await page.eval(`
      const strip = document.querySelector('.chat-branches');
      const composer = document.querySelector('.composer');
      return !!strip && !!composer && !!(strip.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING);`);
    check(order, 'the strip sits above the composer');

    // ---- open: a row per branch, the subagent saying what it reads ----
    await page.click('.chat-branches-bar');
    await page.waitFor(`return document.querySelectorAll('.chat-branches .chat-branch-row').length === 2`, { label: 'the strip opens onto two rows' });
    check((await page.eval(`return localStorage.getItem(${JSON.stringify(STORAGE)})`)) === 'open', 'the open strip is remembered');
    await page.waitFor(`return [...document.querySelectorAll('.chat-branches .chat-branch-row .chat-branch-act')].some((a) => /reading/i.test(a.textContent) && a.textContent.includes(${JSON.stringify(READ)}))`, {
      label: "the subagent's row says what it reads",
    });
    seen = await state();
    const agentRow = seen.rows.find((r) => r.kind === 'Explore');
    const taskRow = seen.rows.find((r) => r.kind === 'bash');
    check(Boolean(agentRow) && Boolean(taskRow), `one row for the agent, one for the command (${JSON.stringify(seen.rows)})`);
    check(seen.now.includes('Explore') && /reading/i.test(seen.now), `the bar says what the subagent is doing (${seen.now})`);
    check(seen.rows.every((r) => r.cls.includes('is-running')), 'both rows are running');

    // ---- the step keeps a card per branch, running with its rail ----
    await page.waitFor(`return document.querySelectorAll('.transcript .chat-launch.is-running').length === 2`, { label: 'two running cards under the step' });
    let shown = await cards();
    const agentCard = shown.find((c) => c.cls.includes('is-agent'));
    const taskCard = shown.find((c) => c.cls.includes('is-task'));
    check(agentCard?.name === 'Explore the notes' && agentCard.status === 'working', `the agent's card is running (${JSON.stringify(agentCard)})`);
    check(Boolean(taskCard) && taskCard.status === 'working', `the command's card is running (${JSON.stringify(taskCard)})`);
    check(shown.every((c) => c.cls.includes('live-rail') && !c.cls.includes('grad-border')), 'a running card carries the live rail and no gradient');
    check(shown.every((c) => c.open), 'each card offers to open its branch');

    // ---- both end: the rows say done, then leave, and the strip goes ----
    writeFileSync(join(work, HOLDS.turn), '');
    writeFileSync(join(work, HOLDS.task), '');
    writeFileSync(join(work, HOLDS.agent), '');
    await page.waitFor(
      `const rows = [...document.querySelectorAll('.chat-branches .chat-branch-row')];
       return rows.length === 2 && rows.every((r) => r.classList.contains('is-completed') && r.querySelector('.word')?.textContent.trim() === 'done');`,
      { label: 'both rows say done', timeout: 15_000 },
    );
    await page.waitFor(`return !document.querySelector('.chat-branches')`, { label: 'the strip leaves once its rows have', timeout: 15_000 });
    shown = await cards();
    check(shown.length === 2 && shown.every((c) => c.status === 'done' && !c.cls.includes('is-running')), `the cards keep their final word (${JSON.stringify(shown)})`);

    // ---- a reload shows the same record ----
    await page.goto(`/chats/${chatId}`, 1500);
    await page.waitFor(`return document.querySelectorAll('.transcript .chat-launch').length === 2`, { label: 'the cards after a reload' });
    shown = await cards();
    check(shown.every((c) => c.status === 'done'), `after a reload the cards say done (${JSON.stringify(shown)})`);
    check(!(await page.eval(`return !!document.querySelector('.chat-branches')`)), 'after a reload nothing is running, and there is no strip');
  } finally {
    await page.eval(`localStorage.removeItem(${JSON.stringify(STORAGE)}); return true`).catch(() => {});
    if (chatId) {
      await api.post(`/chats/${chatId}/stop`).catch(() => {});
      for (let i = 0; i < 40; i++) {
        if ((await api.del(`/chats/${chatId}`).catch(() => ({ status: 0 }))).status === 200) break;
        await page.sleep(250);
      }
    }
    for (const file of files) rmSync(file, { force: true });
    if (savedScripts === null) rmSync(fake.scripts, { force: true });
    else writeFileSync(fake.scripts, savedScripts);
  }
};
