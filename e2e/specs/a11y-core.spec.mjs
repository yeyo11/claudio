// Accessibility of the app's own pages (see a11y-shared.mjs): the contrast of the theme tokens, and
// axe over Home, the chats, the orchestrations, connectors and every Settings tab, in both themes, and
// the context breakdown and the compact confirmation that open over a chat, in both themes and at phone width.
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

export default a11ySpec(async ({ page, api, problems, scan, fx }) => {
  const pages = [
    '/',
    '/chats',
    '/chats/new',
    `/chats/${SESSION}`,
    '/projects',
    '/orchestration',
    `/orchestration/${fx.orchestrationId}`,
    '/connectors',
    ...SETTINGS_TABS.map((tab) => `/settings?tab=${tab}`),
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
  } finally {
    if (shell.body?.id) await api.del(`/terminals/${shell.body.id}`).catch(() => {});
    await api.put('/terminal/settings', { enabled: false }).catch(() => {});
  }
});
