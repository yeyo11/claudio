// Accessibility of the app's own pages (see a11y-shared.mjs): the contrast of the theme tokens, and
// axe over Home, the chats, the orchestrations, connectors and every Settings tab, in both themes, and
// the context breakdown and the compact confirmation that open over a chat, in both themes and at phone width,
// and the strip of what is running over a chat's composer, open in both themes and as the phone's sheet,
// and Collaborators: its page off and on (with a group and its invite dialog), and a project's Sharing
// section, in both themes and at phone width.
import { a11ySpec, OVERLAY_RULES, scanBothThemes, scanNarrow, SESSION, SETTINGS_TABS, settle, tokenContrast } from './a11y-shared.mjs';

// Two themes and two dozen pages
export const timeout = 300_000;

/**
 * The two overlays context control adds to a chat: the breakdown panel (opened from the inspector's
 * Summary tab, or from the details sheet on a phone) and the confirmation the header's ⋯ opens. The
 * seeded session has no process, so the panel shows the transcript's last count and its note, and the
 * confirmation is whatever the chat offers; an entry the menu disables has no overlay to scan.
 */
async function scanContextOverlays(page, scan, problems, narrow) {
  const where = narrow ? '420px' : 'desktop';
  await settle(page, `/chats/${SESSION}`);
  if (narrow) {
    await page.click('main .chat-head button[aria-label="Chat details"]', undefined, 800);
    await page.waitFor(`return !!document.querySelector('[role=dialog] .insp-context-actions')`, { label: 'the details sheet' });
  }
  const breakdown = '[role=dialog] .insp-context-actions .btn, .chat-inspector .insp-context-actions .btn';
  // The inspector draws the button once the chat's context has loaded, which can come after the page settles
  const hasBreakdown = await page
    .waitFor(`return [...document.querySelectorAll(${JSON.stringify(breakdown)})].some((b) => b.textContent.includes('Breakdown'))`, { label: 'the Breakdown button', timeout: 10_000 })
    .then(() => true, () => false);
  if (hasBreakdown) {
    await page.click(breakdown, 'Breakdown', 900);
    await page.waitFor(`return !!document.querySelector('.ctx-breakdown')`, { label: 'the context panel' });
    await page.sleep(300);
    await scan(page, `${where} context panel`, { rules: OVERLAY_RULES });
    await page.key('Escape');
    await page.waitFor(`return !document.querySelector('.ctx-breakdown')`, { label: 'the context panel closed' });
  } else problems.push(`[${where}] the chat's inspector has no Breakdown button`);
  if (narrow) {
    await page.key('Escape');
    await page.sleep(300);
  }
  // Opened the way a keyboard does: Radix opens a menu on pointerdown, never on a synthetic click
  await page.focus('main .chat-head .chat-more');
  await page.press('Enter');
  await page.waitFor(`return !!document.querySelector('[role=menu], [role=dialog] .sheet-actions')`, { label: 'the header menu' });
  const enabled = await page.eval(`
    const el = [...document.querySelectorAll('[role=menuitem], [role=dialog] .sheet-actions button')].find((e) => e.textContent.includes('Compact the conversation'));
    return !!el && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !el.hasAttribute('data-disabled');`);
  if (enabled) {
    await page.click('[role=menuitem], [role=dialog] .sheet-actions button', 'Compact the conversation', 800);
    await page.waitFor(`return !!document.querySelector('[role=dialog] .compact-form')`, { label: 'the compact confirmation' });
    await page.sleep(300);
    await scan(page, `${where} compact confirmation`, { rules: OVERLAY_RULES });
    await page.key('Escape');
    await page.waitFor(`return !document.querySelector('[role=dialog] .compact-form')`, { label: 'the compact confirmation closed' });
  } else {
    await page.key('Escape');
  }
}

/**
 * The strip of what is running over the composer (plans/tool-rows-and-live-branches.md §3.3) is only
 * on the page while a branch runs, and this spec has no process to run one. The seeded chat has a
 * subagent and the background task it launched, both ended; the page is handed the chat's detail
 * with both still running, so axe judges the strip's own markup: open on a desktop in both themes,
 * and as the phone's sheet.
 */
const RUNNING_BRANCHES = `(() => {
  const native = window.fetch;
  const running = (branch) => ({ ...branch, status: 'running', endedAt: null });
  window.fetch = async (input, init) => {
    const res = await native(input, init);
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    if (!res.ok || (init?.method ?? 'GET') !== 'GET' || !url.pathname.endsWith('/chats/${SESSION}')) return res;
    const body = await res.clone().json().catch(() => null);
    const children = body?.chat?.children;
    if (!children) return res;
    children.subagents = children.subagents.map((sub) => ({ ...running(sub), activity: null, tasks: (sub.tasks ?? []).map(running) }));
    children.backgroundTasks = children.backgroundTasks.map(running);
    // Running branches are live only on a chat something still holds (packages/chat-ui/src/lib/liveness.ts)
    body.chat.alive = true;
    return new Response(JSON.stringify(body), { status: res.status, statusText: res.statusText, headers: res.headers });
  };
})();`;

/**
 * Collaborators on, on the minimal preset the harness gives every wrapper (loopback, no network):
 * the page with one group, the invite dialog it opens, and the project's Sharing section. It is off
 * again, with no group, when the scan ends.
 */
async function scanCollaborators(page, api, scan, problems, projectId) {
  let groupId = null;
  try {
    const on = await api.put('/collaborators', { enabled: true, displayName: 'Ana' });
    if (on.status !== 200) {
      problems.push(`Collaborators could not be turned on (${on.status} ${JSON.stringify(on.body)})`);
      return;
    }
    if (on.body?.unavailable) {
      problems.push(`Collaborators is unavailable here: ${JSON.stringify(on.body.unavailable)}`);
      return;
    }
    // An invite needs the endpoint's ticket
    for (let i = 0; i < 80 && ['off', 'starting'].includes((await api.get('/collaborators')).body?.connection); i++) await page.sleep(250);
    const group = await api.post('/collaborators/groups', { name: 'Backend' });
    groupId = group.body?.id ?? null;
    if (!groupId) {
      problems.push(`no group for the Collaborators scan (${group.status})`);
      return;
    }
    const pages = ['/collaborators', `/?project=${projectId}&view=settings`];
    for (const theme of ['dark', 'light']) {
      await page.eval(`localStorage.setItem('claudio-theme', ${JSON.stringify(theme)}); return true`);
      for (const path of pages) {
        await settle(page, path);
        await scan(page, `${theme} ${path} (Collaborators on)`);
      }
      await settle(page, '/collaborators');
      await page.click('button[data-testid=collab-invite]', undefined, 800);
      await page.waitFor(`return !!document.querySelector('[role=dialog] div[data-testid=collab-invite] textarea')?.value`, { label: 'the invite dialog' });
      await page.sleep(300);
      await scan(page, `${theme} invite dialog`, { rules: OVERLAY_RULES });
      await page.key('Escape');
      await page.waitFor(`return !document.querySelector('[role=dialog]')`, { label: 'the invite dialog closed' });
    }
    await page.eval(`localStorage.setItem('claudio-theme', 'dark'); return true`);
    await scanNarrow(page, pages, scan, problems);
    await page.viewport(1440, 900);
  } finally {
    if (groupId) await api.del(`/collaborators/groups/${groupId}`).catch(() => {});
    await api.put('/collaborators', { enabled: false }).catch(() => {});
  }
}

async function scanBranchStrip(page, scan, problems) {
  const remove = await page.onNewDocument(RUNNING_BRANCHES);
  try {
    await page.eval(`localStorage.setItem('claudio-chat-branches', 'open'); return true`);
    for (const theme of ['dark', 'light']) {
      await page.eval(`localStorage.setItem('claudio-theme', ${JSON.stringify(theme)}); return true`);
      await settle(page, `/chats/${SESSION}`);
      const open = await page.eval(`return document.querySelectorAll('.chat-branches .chat-branch-row').length`);
      if (open === 0) {
        problems.push(`[${theme}] the chat with running branches shows no open strip`);
        continue;
      }
      await scan(page, `${theme} chat with the branch strip open`);
    }
    await page.eval(`localStorage.setItem('claudio-theme', 'dark'); return true`);
    await page.viewport(420, 900);
    await settle(page, `/chats/${SESSION}`);
    if (await page.eval(`return !!document.querySelector('.chat-branches .chat-branches-bar')`)) {
      await page.click('.chat-branches .chat-branches-bar', undefined, 800);
      await page.waitFor(`return !!document.querySelector('[role=dialog] .chat-branch-row')`, { label: 'the branch sheet' });
      await scan(page, '420px branch sheet', { rules: OVERLAY_RULES });
      await page.key('Escape');
      await page.waitFor(`return !document.querySelector('[role=dialog]')`, { label: 'the branch sheet closed' });
    } else problems.push('[420px] the chat with running branches shows no strip');
  } finally {
    await remove();
    await page.viewport(1440, 900);
    await page.eval(`localStorage.removeItem('claudio-chat-branches'); return true`);
  }
}

export default a11ySpec(async ({ page, api, problems, scan, fx }) => {
  const pages = [
    '/',
    '/chats',
    '/chats/new',
    `/chats/${SESSION}`,
    '/projects',
    '/orchestration',
    `/orchestration/${fx.orchestrationId}`,
    // Off: the page is its illustration and the one action that turns it on
    '/collaborators',
    ...SETTINGS_TABS,
  ];
  // A terminal's own screen (what a phone opens) and the phone's list only exist while the feature is on; it
  // is off again when the scan ends. On a desktop /terminals redirects to the status bar's panel.
  await api.put('/terminal/settings', { enabled: true });
  const shell = await api.post('/terminals', { projectId: fx.projectId });
  const screen = shell.body?.id ? `/terminals/${shell.body.id}` : null;
  try {
    await scanBothThemes(page, screen ? [...pages, screen] : pages, scan, (theme) => tokenContrast(page, theme, problems));
    await scanNarrow(page, screen ? ['/terminals', screen] : ['/terminals'], scan, problems);
    // The overlays of context control, in both themes at desktop width and in the dark theme on a phone
    // scanNarrow leaves the phone's width behind it
    await page.viewport(1440, 900);
    for (const theme of ['dark', 'light']) {
      await page.eval(`localStorage.setItem('claudio-theme', ${JSON.stringify(theme)}); return true`);
      await scanContextOverlays(page, (p, w, o) => scan(p, `${theme} ${w}`, o), problems, false);
    }
    await page.eval(`localStorage.setItem('claudio-theme', 'dark'); return true`);
    await page.viewport(420, 900);
    await scanContextOverlays(page, scan, problems, true);
    await page.viewport(1440, 900);
    await scanBranchStrip(page, scan, problems);
    await scanCollaborators(page, api, scan, problems, fx.projectId);
  } finally {
    if (shell.body?.id) await api.del(`/terminals/${shell.body.id}`).catch(() => {});
    await api.put('/terminal/settings', { enabled: false }).catch(() => {});
  }
});
