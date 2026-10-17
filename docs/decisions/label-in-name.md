---
created_at: 2026-10-17T09:00:00Z
updated_at: 2026-10-17T12:00:00Z
tags:
    - decision
    - decisions
    - accessibility
    - axe
    - i18n
    - design-system
---
# Decision: a control's name holds the words it shows

axe-core 4.14 tightened `label-content-name-mismatch` (WCAG 2.5.3, Label in Name, serious): the
words a control shows must appear, in order and together, in its accessible name, compared word by
word with parentheticals and punctuation dropped. A voice user says what they see ("click Run now")
and a name that reorders or hides those words does not answer. The dev-dependency bump to 4.14 made
the `a11y-*`, `changes-review`, `youtrack` and `schedules` e2e specs fail on it. The app was fixed,
not the checks: no rule is disabled and no spec is weakened.

## The rule

A control is named in one of two ways, and both keep its visible words:

1. **Its own words, starting from what it shows.** When an `aria-label` adds context, it starts with
   or contains the visible text: "New chat here, in shop" for a button that shows "New chat here",
   "Run now: nightly check", "Open memory of shop", "Edit in user scope: github", "Undo: restore
   qa.md", "Terminal: 2 running" for an item that shows "Terminal 2".
2. **What it shows, plus off-screen words.** When the visible text cannot be held by a fixed label
   (an avatar's initials, a status letter, line counts, a ticking clock), the control drops its
   `aria-label`, its decoration stays `aria-hidden`, and the missing words go in a `.sr-only` span:
   "Assignee: " before a property's value, " · modified · seen" after a file's name, "(opens in
   GitHub)" after an issue chip, " · from <owner>" on a nested branch row. The New task form's
   fields already did this (`FieldButton`).

Text in a flex row that sits in sibling elements is joined with nothing between them, by axe and by
a browser's name computation alike, so "workspace" and "default model" read as "workspacedefault
model", and "Terminal" and "2" as "Terminal2". A space text node between them fixes it; a flex
container does not draw it.

A control whose visible words change with the screen takes the second way. The composer's status
line hides the preset's chip on a phone, so a label listing every chip no longer holds what the
phone shows; `StatusChips` says what the button opens ("Run options: ") off screen and lets the
chips that are drawn name it.

A Radix `Select.Item` is named by its `ItemText` alone, which leaves a hint (a project's path, a
model's description) out. An option with a hint drops that `aria-labelledby` and is named by all it
shows (`nameFromContent` in `packages/ui/src/components/controls/Select.tsx`).

## Where it landed

- `Value` and the phone chips of a work item (`pages/tasks/item/Properties.tsx`, `View.tsx`): the
  field name off screen through `FieldName`; `RoleAvatar` takes `decorative` so an assignee's
  squircle is not read beside the name it stands for.
- The file map's rows and the phone's file cells (`components/changes/FileMap.tsx`,
  `pages/ChangesReview.tsx`): `RowDetails`; the row's `title` keeps the whole sentence.
- `IssueChips`, `StatusChips` (chat-ui composer), the branch rows of `LiveBranches`, the phone
  `ModelPicker`, and the strings of the project cards, Settings → Memory, Schedules, the MCP tab,
  the assistant's proposals and the Terminal item.

A second CI run, and a sweep of every `<button>`, `<a>`, `Link` and Radix trigger that has an
`aria-label` beside visible text, added: the provider item of the status bar (named by what it
shows: provider, state, percent, when it resumes), the check rows of a task and of an orchestration
("opens its log" off screen), the edit chips of the transcript, the phone rows of the issue import
and the review-address dialogs (`aria-pressed` says the state), a run row on a phone, the chat
head's checklist count, the live rail's count, a connector button while it starts, the plugin
Install button (its label was hard-coded English), "Cancel: clear the selection", and two Spanish
labels that used another verb than their button ("Empezar el chat", "Quitar {{name}}"). The
pairs test lists every remaining `aria-label` that goes beside a visible word of its own, in both
languages, so a new string that breaks the rule fails a unit test before it reaches an e2e scan.

`apps/web/test/accessible-name.ts` reads server-rendered markup the way the rule does, and
`apps/web/test/label-in-name.test.tsx` holds each of these controls to it in English and Spanish.

## Related

- [[design-system]]
- [[terminal]]
- [[chat-tool-rows-and-branches]]
