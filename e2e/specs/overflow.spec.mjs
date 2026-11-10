// Nothing wider than its pane (docs/plans/agent-messages.md, "Overflow across the app";
// docs/design-system.md, "Truncation and scroll"). The owner found a step card's risk tag running past
// the card, the steps pane scrolling sideways because of it, and diff lines cut at the card's edge
// with no way to read the rest. This walks the screens of that report and the ones listed with it,
// with long data (overflow-seed.mjs) and the Spanish copy, at 1280 × 720, 1906 × 1045 and 390 × 844
// in both themes, and asks e2e/ui/overflow.mjs for the page, the panes and the list rows whose content
// is wider than they are. Blocks wide on purpose (code, diffs, tables, `data-scroll-x`) are left out,
// and the diff is checked for the opposite: its long line must be reachable inside its own block.
import { sidewaysOverflow } from '../ui/overflow.mjs';
import { cleanupOverflow, LONG_FILE, SCREEN, seedOverflow, SESSION, settleOrchestration } from './overflow-seed.mjs';

export const timeout = 900_000;

const SIZES = [
  [1280, 720],
  [1906, 1045],
  [390, 844],
];
const THEMES = ['dark', 'light'];

/** Opens every folded tool step, then every call in them: tool rows and their bodies count too */
async function openToolRows(page) {
  await page.eval(`document.querySelectorAll('.msg-step [aria-expanded=false]').forEach((b)=>b.click());return true`);
  await page.sleep(400);
  await page.eval(`document.querySelectorAll('.msg-step [aria-expanded=false]').forEach((b)=>b.click());return true`);
  await page.sleep(400);
}

export default async ({ page, api, check, dirs }) => {
  let seeded = null;
  const problems = [];
  try {
    seeded = await seedOverflow({ api, configDir: dirs.configDir, workspaceDir: dirs.workspaceDir });
    check(!!seeded.projectId && !!seeded.orchestrationId, `the long project and orchestration were created (${seeded.projectId}, ${seeded.orchestrationId})`);
    await settleOrchestration({ api, seeded, sleep: (ms) => page.sleep(ms) });
    const steps = await api.get(`/chats/${SESSION}/changes/steps`);
    check(steps.status === 200 && steps.body.length >= 2 && steps.body.some((step) => step.risk), `the chat has two steps, the first one outside the directory (${steps.status}, ${steps.body?.length})`);

    const orch = `/orchestration/${seeded.orchestrationId}`;
    const routes = [
      ['changes, step by step', `/chats/${SESSION}/changes?lens=steps&step=ovf-write`],
      ['changes, the long line', `/chats/${SESSION}/changes?lens=steps&step=ovf-edit`],
      ['changes, reading', `/chats/${SESSION}/changes?mode=reading&file=${SCREEN}`],
      ['changes, unified', `/chats/${SESSION}/changes?mode=unified&file=${SCREEN}`],
      ['changes, side by side', `/chats/${SESSION}/changes?mode=split&file=${SCREEN}`],
      ['changes, a long file', `/chats/${SESSION}/changes?mode=unified&file=${LONG_FILE}`],
      ['chat', `/chats/${SESSION}`],
      ['home', '/'],
      ['chats', '/chats'],
      ['orchestrations', '/orchestration'],
      ['orchestration', orch],
      ['orchestration task', `${orch}?task=overflow`],
      ['settings', '/settings'],
      ['accounts', '/accounts'],
      ['servers', '/servers'],
      ['projects', '/projects'],
      ['tasks', '/tasks'],
    ];

    await page.goto('/', 600);
    await page.eval(`localStorage.setItem('claudio-language','es');return true`);
    await page.reduceMotion(true);
    for (const theme of THEMES) {
      await page.eval(`localStorage.setItem('claudio-theme', ${JSON.stringify(theme)}); return true`);
      for (const [width, height] of SIZES) {
        await page.viewport(width, height);
        await page.emulateTouch(width < 768);
        for (const [name, route] of routes) {
          await page.goto(route, 900);
          await page
            .waitFor(`const m=document.querySelector('main');return !!m&&m.innerText.trim().length>20&&!m.querySelector('[aria-busy=true], .skeleton')`, { label: name, timeout: 15000 })
            .catch(() => problems.push(`[${theme} ${width} ${name}] the page did not finish loading`));
          await page.eval(`await document.fonts?.ready;return true`);
          if (name === 'chat') await openToolRows(page);
          for (const found of await sidewaysOverflow(page)) problems.push(`[${theme} ${width} ${name}] ${found}`);
        }
      }
    }

    // The report itself, at its own size: the tag stays in its card and the long line is readable
    await page.eval(`localStorage.setItem('claudio-theme', 'dark'); return true`);
    await page.emulateTouch(false);
    await page.viewport(1906, 1045);
    await page.goto(`/chats/${SESSION}/changes?lens=steps&step=ovf-write`, 1200);
    await page.waitFor(`return !!document.querySelector('.edit-step .edit-step-risk') && !!document.querySelector('.edit-step-diff .diff-row')`, { label: 'the step with its risk tag and its patch' });
    const card = await page.eval(
      `const step=document.querySelector('.edit-step.is-current');const tag=step.querySelector('.edit-step-risk');const s=step.getBoundingClientRect(),t=tag.getBoundingClientRect();` +
        `const list=document.querySelector('.edit-steps-scroll');return {inside:t.left>=s.left-0.5&&t.right<=s.right+0.5,listWide:list.scrollWidth-list.clientWidth}`,
    );
    check(card.inside, 'the risk tag stays inside its step card');
    check(card.listWide <= 1, `the steps pane does not scroll sideways (${card.listWide}px)`);
    const diff = await page.eval(
      `const d=document.querySelector('.edit-step-diff');const row=d.querySelector('.diff-row');const code=row.querySelector('.diff-code');` +
        `return {scrolls:/auto|scroll/.test(getComputedStyle(d).overflowX),wider:d.scrollWidth>d.clientWidth+1,rowFits:row.scrollWidth<=row.clientWidth+1,codeFits:code.scrollWidth<=code.clientWidth+1}`,
    );
    check(diff.scrolls && diff.wider, `the diff scrolls sideways inside its own block (${JSON.stringify(diff)})`);
    check(diff.rowFits && diff.codeFits, `a diff row is as wide as its line, so nothing in it is cut (${JSON.stringify(diff)})`);
    // Scrolled to its end, the rails stay on their rows: they move with the code, not apart from it
    const aligned = await page.eval(
      `const d=document.querySelector('.edit-step-diff');d.scrollLeft=d.scrollWidth;await new Promise((r)=>requestAnimationFrame(r));` +
        `return [...d.querySelectorAll('.diff-row')].every((row)=>{const rail=row.querySelector('.diff-line-rail');if(!rail)return true;const a=row.getBoundingClientRect(),b=rail.getBoundingClientRect();return b.top>=a.top-0.5&&b.bottom<=a.bottom+0.5})`,
    );
    check(aligned, 'every rail stays on its row while the diff scrolls');

    // Side by side cuts each half at its column: one long line never pushes the "after" side away
    await page.viewport(1906, 1045);
    await page.goto(`/chats/${SESSION}/changes?mode=split&file=${SCREEN}`, 1200);
    await page.waitFor(`return !!document.querySelector('.diff-split .diff-row')`, { label: 'the side by side diff' });
    const split = await page.eval(`const d=document.querySelector('.diff-split');const seam=d.querySelector('.diff-row:not(.diff-split-head) .diff-split-seam');const b=d.getBoundingClientRect(),s=seam.getBoundingClientRect();return {fits:d.scrollWidth<=d.clientWidth+1,seamInside:s.left>b.left&&s.right<b.right}`);
    check(split.fits && split.seamInside, `side by side keeps both halves in the block (${JSON.stringify(split)})`);
    // A long file is drawn in virtual rows: they widen the block's own scroll the same way
    await page.goto(`/chats/${SESSION}/changes?mode=unified&file=${LONG_FILE}`, 1200);
    await page.waitFor(`return !!document.querySelector('.diff-uni .diff-row')`, { label: 'the long file' });
    const virtual = await page.eval(`const d=document.querySelector('.diff-uni');return {scrolls:/auto/.test(getComputedStyle(d).overflowX),wider:d.scrollWidth>d.clientWidth+1,region:d.getAttribute('role')==='region'&&d.tabIndex===0}`);
    check(virtual.scrolls && virtual.wider && virtual.region, `a long file's diff scrolls sideways in its own focusable region (${JSON.stringify(virtual)})`);
  } finally {
    await page.emulateTouch(false).catch(() => {});
    await page.reduceMotion(false).catch(() => {});
    await page.viewport(1280, 900).catch(() => {});
    await page.eval(`localStorage.removeItem('claudio-theme');localStorage.removeItem('claudio-language');return true`).catch(() => {});
    await cleanupOverflow({ api, seeded });
  }
  check(problems.length === 0, `content wider than its pane (${problems.length}):\n  ${problems.slice(0, 60).join('\n  ')}`);
};
