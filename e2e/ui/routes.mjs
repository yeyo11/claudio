// The screens under the UI invariants, and the real interactions the layout-shift check (I4) runs
// on each. Add a screen here when it gets a reference in docs/design-system/reference/. The edit
// hook and scripts/ui-check.mjs read `.claude/designer/route-map.json` to go from a file to these.
//
// An interaction is `(page) => Promise`, with the page of e2e/driver.mjs. Interactions that filter
// or replace content move rows on purpose and do not belong here: I4 is about a control that makes
// its neighbours jump (a button whose label changes width, a message that appears without room).

export const ROUTES = [
  {
    path: '/',
    interactions: [
      // The palette opens over the page and closes again: nothing under it may move
      async (page) => page.key('k', 2),
      async (page) => page.key('Escape'),
    ],
  },
  { path: '/chats' },
  {
    path: '/chats/new',
    interactions: [
      async (page) => page.focus('.ProseMirror, textarea'),
      async (page) => page.type('A first prompt long enough to wrap onto a second line of the composer, which grows downwards'),
    ],
  },
  { path: '/projects' },
  { path: '/tasks' },
  { path: '/orchestration' },
  { path: '/accounts' },
  { path: '/usage' },
  { path: '/schedules' },
  { path: '/connectors' },
  { path: '/collaborators' },
  { path: '/settings' },
  { path: '/settings?tab=decisions' },
  { path: '/settings?tab=providers' },
  { path: '/settings?tab=appearance' },
];

export const WIDTHS = [320, 390, 768, 1280];
export const THEMES = ['dark', 'light'];
