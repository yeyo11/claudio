// The screens under the UI invariants, and the real interactions the layout-shift check (I4) runs
// on each. Add a screen here when it gets a reference in docs/design-system/reference/. The edit
// hook and scripts/ui-check.mjs read `.claude/designer/route-map.json` to go from a file to these.
//
// An interaction is `(page) => Promise`, with the page of e2e/driver.mjs. Interactions that filter
// or replace content move rows on purpose and do not belong here: I4 is about a control that makes
// its neighbours jump (a button whose label changes width, a message that appears without room).

/** The long name the spec gives this Claudio, so the selector and its sheet carry one everywhere */
export const LOCAL_NAME = 'A name for this Claudio long enough to need its ellipsis';

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
  {
    path: '/tasks',
    interactions: [
      // Selection mode: the head's Select is pressed and the selection bar comes up below; the board keeps its place
      async (page) => page.click('.workitem-select'),
      async (page) => page.click('.workitem-select'),
    ],
  },
  { path: '/orchestration' },
  { path: '/accounts' },
  { path: '/usage' },
  { path: '/schedules' },
  { path: '/collaborators' },
  // Servers are on in the spec, with a long name of this Claudio's own (ui-invariants.spec.mjs): the
  // name's Save keeps its place while it shows and hides, so typing must move nothing (a 0.003 shift
  // at 320 before it did)
  {
    path: '/servers',
    interactions: [
      async (page) => page.fill('[data-testid="server-local-name"]', 'Another name for this Claudio'),
      async (page) => page.fill('[data-testid="server-local-name"]', LOCAL_NAME),
    ],
  },
  // General on a desktop, the eight groups on a phone
  { path: '/settings' },
  { path: '/settings/claude-code' },
  { path: '/settings/connections' },
  {
    path: '/settings/decisions',
    interactions: [
      // An invalid cap swaps its consequence for the error in the same line, and the save bar appears below
      async (page) => page.fill('[data-setting="engine.cap"] input', '9'),
      // Discard puts the draft back: the bar goes, nothing above it moves
      async (page) => page.click('.dp-foot .btn:not(.dp-save)'),
    ],
  },
  { path: '/settings/runs' },
  { path: '/settings/access' },
];

export const WIDTHS = [320, 390, 768, 1280];
export const THEMES = ['dark', 'light'];
