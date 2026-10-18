// Every dialog, drawer and sheet fits the window it is in (docs/plans/claudio-designer.md §2,
// `overlayFit` in e2e/ui/invariants.mjs): at a phone's width with a finger, on a desktop, and in the
// desktop app (the shell's `is-desktop` class, which keeps overlays below the window controls). Two
// kinds of overlay are looked at: the markup Dialog and Sheet render, filled with the content that
// broke them (a title that is one long name, ids with no break in them, a body to scroll, three
// actions with long labels), and the real ones a seeded project and chat open. A title that pushes
// the close button out, a footer that is cut, a control an `overflow` ancestor clips, or a button
// under the window controls fails here, not on someone's phone.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { overlayFit, settle } from '../ui/invariants.mjs';
import { OVERLAY_KINDS, overlayMarkup } from '../ui/overlays.mjs';

export const timeout = 600_000;

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/core/test/fixtures');
const PROJECT_DIR = '-work-ui-overlays';
const SESSION = 'e2e-ui-overlays-session';
const AGENT = 'a1b2c3d4e5f60718';
const UNBROKEN = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ';
const DESCRIPTION = `Survey the build scripts and report every single thing that looks wrong, including ${UNBROKEN}`;

/** A phone, a desktop and the desktop app, each as the pointer and the shell see it */
const SCREENS = [
  { name: '320px', width: 320, touch: true },
  { name: '390px', width: 390, touch: true },
  { name: 'desktop', width: 1280, touch: false },
  { name: 'desktop app', width: 1280, touch: false, app: true },
];

export default async ({ page, api, check, dirs }) => {
  const at = new Date().toISOString();
  const projectDir = join(dirs.configDir, 'projects', PROJECT_DIR);
  const sessionDir = join(projectDir, SESSION);
  const workspace = join(dirs.workspaceDir, 'e2e-ui-overlays');
  let projectId = null;
  const problems = [];
  const scan = async (label, screen) => {
    for (let i = 0; i < 40; i++) {
      const ready = await page.eval(
        `const d=[...document.querySelectorAll('[role=dialog]')].pop();return !!d&&d.innerText.trim().length>12&&!d.querySelector('.spinner,[aria-busy=true]')`,
      );
      if (ready) break;
      await page.sleep(250);
    }
    await page.sleep(300);
    const open = await page.eval(`return document.querySelectorAll('[role=dialog]').length`);
    if (!open) return problems.push(`[${screen.name}] ${label}: no dialog opened`);
    for (const found of await overlayFit(page, { touch: screen.touch })) problems.push(`[${screen.name}] ${label}: ${found}`);
  };

  try {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(projectDir, `${SESSION}.jsonl`),
      [
        { type: 'user', uuid: 'o1', timestamp: at, cwd: '/work/ui-overlays', version: '2.1.0', message: { role: 'user', content: `Review the migration and check ${UNBROKEN} is never logged` } },
        {
          type: 'assistant',
          uuid: 'o2',
          timestamp: at,
          message: { role: 'assistant', id: 'msg-overlays', model: 'claude-sonnet-5', content: [{ type: 'tool_use', id: 'toolu_explore01', name: 'Task', input: { description: DESCRIPTION, prompt: 'List the build scripts' } }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
        },
        { type: 'user', uuid: 'o3', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_explore01', content: 'ok' }] }, toolUseResult: { agentId: AGENT } },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n'),
    );
    cpSync(join(FIXTURES, 'agent-session'), sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'subagents', `agent-${AGENT}.meta.json`), JSON.stringify({ agentType: 'Explore', description: DESCRIPTION, toolUseId: 'toolu_explore01', spawnDepth: 1, requestShape: 'foreground', requestNonInteractive: true }));

    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });
    const imported = await api.post('/projects/import', { path: workspace, name: `A project whose name is long enough to need its ellipsis everywhere ${UNBROKEN.slice(0, 30)}`, template: 'software' });
    check(imported.status === 201, `the project was imported (${imported.status})`);
    projectId = imported.body.id;
    const made = await api.post(`/projects/${projectId}/work-items`, { title: `A story whose title never ends ${UNBROKEN}`, type: 'story', status: 'todo', description: `The description holds ${UNBROKEN}` });
    check(made.status === 201, `a work item was created (${made.status})`);
    const board = `/tasks?project=${projectId}`;

    await page.reduceMotion(true);
    await page.eval(`localStorage.setItem('claudio-theme', 'dark'); return true`);
    for (const screen of SCREENS) {
      await page.viewport(screen.width, 900);
      await page.emulateTouch(screen.touch);
      // The desktop app stamps `is-desktop` before the first paint, from what its preload exposes
      const removeApp = screen.app ? await page.onNewDocument(`window.claudioDesktop = { platform: 'win32', version: 'e2e' };`) : null;
      try {
        // The primitives with the hostile content, one at a time, over a page that is loaded
        await page.goto('/chats', 600);
        await settle(page);
        for (const kind of OVERLAY_KINDS) {
          await page.eval(`document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(overlayMarkup(kind))}); return true`);
          await scan(`${kind} with a long title, a long body and three actions`, screen);
          await page.eval(`document.querySelectorAll('.overlay, .sheet-scrim, .sheet').forEach((el) => el.remove()); return true`);
        }
        // The real ones
        const real = [
          ['New task', `${board}&new=1`],
          ['Suggest tasks', `${board}&suggest=1`],
          ['Create with AI', `/?project=${projectId}&view=resources&ai=1`],
          ['the chat panel', `/chats?detail=${encodeURIComponent(`chat:${SESSION}`)}`],
          ['the subagent panel', `/chats/${SESSION}?detail=${encodeURIComponent(`subagent:${SESSION}:${AGENT}`)}`],
          // A work item opens as a page on a phone, as a drawer beside the board elsewhere
          ...(screen.touch ? [] : [['the work item panel', `${board}&item=${made.body.key}`]]),
        ];
        for (const [label, path] of real) {
          await page.goto(path, 700);
          await scan(label, screen);
        }
      } finally {
        if (removeApp) await removeApp();
      }
    }
  } finally {
    await page.emulateTouch(false).catch(() => {});
    await page.reduceMotion(false);
    await page.eval(`localStorage.removeItem('claudio-theme'); return true`).catch(() => {});
    if (projectId) await api.del(`/projects/${projectId}`).catch(() => {});
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
  check(problems.length === 0, `Overlay fit (${problems.length}):\n  ${problems.slice(0, 60).join('\n  ')}${problems.length > 60 ? `\n  … and ${problems.length - 60} more` : ''}`);
};
