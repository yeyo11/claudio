#!/usr/bin/env node
// Screenshots and UI invariants of one screen of a running Claudio, through the e2e harness's own
// Chrome driver (docs/plans/claudio-designer.md §2). What the ui-reviewer agent and the
// ui-invariants-fast hook run; the e2e spec ui-invariants.spec.mjs runs the same checks in CI.
//
//   node scripts/ui-check.mjs --route '/settings?tab=decisions'
//     [--widths 320,390,768,1280] [--themes dark,light] [--fast] [--axe] [--no-shots]
//     [--base http://localhost:5181] [--out .ui-captures] [--tag before]
//
// It aims at the web dev server of the checkout under review (`pnpm dev:web`, port 5181, with an API
// behind it on VITE_API_TARGET): that is the code being changed. The desktop app's renderer serves
// its own installed build, not this checkout's. With a token (UI_TOKEN, or CLAUDIO_API_TOKEN when the
// API asks for one) it signs the page in the way the app stores it.
//
// Exit 0 when every invariant holds, 1 when one does not, 2 when the page cannot be reached.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launch } from '../e2e/driver.mjs';
import { pageInvariants, readLayoutShift, settle, startLayoutShift } from '../e2e/ui/invariants.mjs';
import { ROUTES } from '../e2e/ui/routes.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : fallback;
};

const route = option('route');
if (!route) {
  console.error('ui-check: --route is required, e.g. --route /settings?tab=decisions');
  process.exit(2);
}
const fast = flag('fast');
const base = (option('base') ?? process.env.UI_BASE_URL ?? 'http://localhost:5181').replace(/\/$/, '');
const widths = option('widths', fast ? '320,1280' : '320,390,768,1280').split(',').map(Number);
const themes = option('themes', fast ? 'dark' : 'dark,light').split(',');
const token = process.env.UI_TOKEN ?? process.env.CLAUDIO_API_TOKEN ?? '';
const shots = !flag('no-shots') && !fast;
const tag = option('tag') ? `${option('tag')}-` : '';
const outDir = resolve(option('out', '.ui-captures'), route.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'home');

const reachable = await fetch(base).then((r) => r.ok, () => false);
if (!reachable) {
  console.error(`ui-check: nothing answers at ${base}. Start the web dev server of this checkout (pnpm dev:web, with the API on VITE_API_TARGET) or pass --base.`);
  process.exit(2);
}

if (shots) mkdirSync(outDir, { recursive: true });
const browser = await launch({ baseUrl: base, shotsDir: shots ? outDir : undefined });
const { page } = browser;
const problems = [];
const files = [];
try {
  await page.goto('/', 600);
  if (token) await page.eval(`localStorage.setItem('claudio.token', ${JSON.stringify(token)}); return true`);
  await page.reduceMotion(true);
  for (const theme of themes) {
    await page.eval(`localStorage.setItem('claudio-theme', ${JSON.stringify(theme)}); return true`);
    for (const width of widths) {
      await page.viewport(width, 900);
        // Below 768 the page is read the way a phone uses it: with a finger
        await page.emulateTouch(width < 768);
      await page.goto(route, 1200);
      await settle(page);
      for (const found of await pageInvariants(page, { width, fast })) problems.push(`[${theme} ${width}px] ${found}`);
      if (flag('axe') || (!fast && width === 1280)) {
        for (const v of await page.axe()) problems.push(`[${theme} ${width}px] I8 axe ${v.id} (${v.impact}) ×${v.nodes.length}: ${v.help} — ${v.nodes.slice(0, 2).map((n) => n.target).join(' | ')}`);
      }
      if (shots) {
        const name = `${tag}${width}-${theme}`;
        await page.shot(name);
        files.push(join(outDir, `${name}.png`));
      }
    }
  }
  const def = ROUTES.find((r) => r.path === route);
  if (def?.interactions?.length) {
    await page.eval(`localStorage.setItem('claudio-theme', 'dark'); return true`);
    await page.viewport(1280, 900);
    await page.goto(route, 1200);
    await settle(page);
    await startLayoutShift(page);
    for (const act of def.interactions) await act(page);
    await settle(page);
    for (const found of await readLayoutShift(page, route)) problems.push(`[dark 1280px] I4 ${found}`);
  }
  const errors = page.takeErrors();
  if (errors.length) problems.push(...[...new Set(errors)].slice(0, 5).map((e) => `console: ${e}`));
} catch (error) {
  browser.close();
  console.error(`ui-check: ${route} did not render, so nothing was measured.\n${error.message.slice(0, 1500)}`);
  process.exit(2);
} finally {
  browser.close();
}

if (shots) {
  writeFileSync(join(outDir, `${tag}report.txt`), problems.join('\n') + '\n');
  console.log(`screenshots (${files.length}) in ${outDir}`);
}
if (problems.length) {
  console.log(`✗ ${route}: ${problems.length} invariant problem(s)\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`✓ ${route}: invariants hold (${fast ? 'fast' : 'full'}, ${themes.join('+')} × ${widths.join('/')}px)`);
