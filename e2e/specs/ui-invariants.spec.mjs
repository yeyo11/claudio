// The UI invariants (docs/plans/claudio-designer.md §2) over the main screens, at every width of
// e2e/ui/routes.mjs and in both themes. The content is seeded long on purpose, the bundle's "stress"
// fixture without a fixture mode in the app: a chat whose first prompt (its title) is long and holds
// a word with no break in it, and a project with a long name, so a row that lacks `min-width: 0` or
// a literal that lacks `overflow-wrap` shows up as an overflow here instead of on someone's phone.
// Findings are gathered and reported together, so one run says everything that is wrong.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pageInvariants, readLayoutShift, settle, startLayoutShift } from '../ui/invariants.mjs';
import { ROUTES, THEMES, WIDTHS } from '../ui/routes.mjs';

export const timeout = 900_000;

const SESSION = 'e2e-ui-invariants-0000-000000000000';
const PROJECT = '-work-ui-invariants';
const UNBROKEN = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ';
const PROMPT = `Review the migration of packages/frontend/src/screens/settings/decisions/DecisionsScreen.tsx and check ${UNBROKEN} is never logged`;

function transcript() {
  const base = { cwd: '/work/ui-invariants', version: '2.1.0', sessionId: SESSION };
  const at = (s) => new Date(Date.UTC(2026, 0, 3, 9, 0, s)).toISOString();
  return [
    { ...base, uuid: 'uinv-1', timestamp: at(0), type: 'user', message: { role: 'user', content: PROMPT } },
    { ...base, uuid: 'uinv-2', timestamp: at(1), type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: `Checked /Users/someone/workspace/claudio/packages/frontend/src/screens/settings/decisions/DecisionsScreen.tsx: ${UNBROKEN} appears nowhere.` }] } },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n');
}

export default async ({ page, api, check, dirs }) => {
  const dir = join(dirs.configDir, 'projects', PROJECT);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${SESSION}.jsonl`), transcript());
  const workspace = join(tmpdir(), `claudio-ui-invariants-${process.pid}`);
  mkdirSync(workspace, { recursive: true });
  const imported = await api.post('/projects/import', { path: workspace, name: 'A project whose name is long enough to need its ellipsis everywhere', template: 'software' });
  check(imported.status === 201, `the project was imported (${imported.status})`);
  const projectId = imported.body.id;

  const problems = [];
  try {
    await page.reduceMotion(true);
    for (const theme of THEMES) {
      await page.goto('/', 400);
      await page.eval(`localStorage.setItem('claudio-theme', ${JSON.stringify(theme)}); return true`);
      // Light at the phone's and the desktop's width: the layout is the theme's business only through colour
      for (const width of theme === 'dark' ? WIDTHS : [390, 1280]) {
        await page.viewport(width, 900);
        // Below 768 the page is read the way a phone uses it: with a finger
        await page.emulateTouch(width < 768);
        for (const route of [...ROUTES.map((r) => r.path), `/chats/${SESSION}`]) {
          await page.goto(route, 900);
          await settle(page);
          for (const found of await pageInvariants(page, { width })) problems.push(`[${theme} ${width}px ${route}] ${found}`);
        }
      }
    }
    // I4 once per route, dark and desktop: the interactions are the same in every theme
    await page.emulateTouch(false);
    await page.eval(`localStorage.setItem('claudio-theme', 'dark'); return true`);
    await page.viewport(1280, 900);
    for (const route of ROUTES.filter((r) => r.interactions?.length)) {
      await page.goto(route.path, 900);
      await settle(page);
      await startLayoutShift(page);
      for (const act of route.interactions) await act(page);
      await settle(page);
      for (const found of await readLayoutShift(page, route.path)) problems.push(`[I4] ${found}`);
    }
  } finally {
    await page.emulateTouch(false).catch(() => {});
    await page.reduceMotion(false);
    await page.eval(`localStorage.removeItem('claudio-theme'); return true`).catch(() => {});
    if (projectId) await api.del(`/projects/${projectId}`).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
  // The whole list, for whoever fixes them: the assertion below shows only the first 80
  if (problems.length) writeFileSync(join(tmpdir(), 'claudio-ui-invariants.txt'), `${problems.join('\n')}\n`);
  check(problems.length === 0, `UI invariants (${problems.length}):\n  ${problems.slice(0, 80).join('\n  ')}${problems.length > 80 ? `\n  … and ${problems.length - 80} more` : ''}`);
};
