// Accessibility of the app's own pages (see a11y-shared.mjs): the contrast of the theme tokens, and
// axe over Home, the chats, the orchestrations, connectors and every Settings tab, in both themes.
import { a11ySpec, scanBothThemes, scanNarrow, SESSION, SETTINGS_TABS, tokenContrast } from './a11y-shared.mjs';

// Two themes and two dozen pages
export const timeout = 300_000;

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
  } finally {
    if (shell.body?.id) await api.del(`/terminals/${shell.body.id}`).catch(() => {});
    await api.put('/terminal/settings', { enabled: false }).catch(() => {});
  }
});
