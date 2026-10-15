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
  // The terminal's project page only exists while the feature is on; it is off again when the scan ends
  const terminal = `/terminals?project=${encodeURIComponent(fx.projectId)}`;
  await api.put('/terminal/settings', { enabled: true });
  try {
    await scanBothThemes(page, [...pages, terminal], scan, (theme) => tokenContrast(page, theme, problems));
    await scanNarrow(page, [terminal], scan, problems);
  } finally {
    await api.put('/terminal/settings', { enabled: false }).catch(() => {});
  }
});
