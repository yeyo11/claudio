---
created_at: 2026-10-15T15:30:00Z
updated_at: 2026-10-16T16:00:00Z
tags:
    - chat
    - composer
    - mcp
    - connectors
    - decision
---
# The message box: a ProseMirror editor, and servers switched from its "+"

How the box a person writes a chat's messages in works, since 2026-10-15 (branch
`feat/rich-composer`). It replaced a `<textarea>` in the chat page (`Composer`) and on New chat.
Part of [plans/chat-experience.md](plans/chat-experience.md), which studied ChatGPT's web chat;
this builds its composer items (CHAT-4, CHAT-15, CHAT-16) and adds what the person asked for on top:
configuring MCP servers and connectors from the box.

## The editor

`packages/chat-ui/src/composer/editor/RichEditor.tsx` is a ProseMirror view (`prosemirror-model`,
`-state`, `-view`, `-keymap`, `-commands`, `-history`; no wrapper library) over a schema of plain
paragraphs (`editor/text.ts`). A message is still plain text: what leaves the box is its paragraphs,
a line each (`textOf`), and the composer only ever reads and writes strings, so nothing that sends
a message depends on ProseMirror.

What it brings over the textarea:

- **Composition is never cut by Enter.** While an IME or a dead key composes (`event.isComposing`,
  `view.composing`, or `keyCode` 229), Enter belongs to the composition. The textarea sent half a word.
- **Which key sends** (`SubmitKey`): on a keyboard Enter sends and Shift+Enter breaks the line; on a
  touch screen (`pointer: coarse`) and on both start screens (New chat and the Claudio assistant's
  entry), Enter breaks the line and Ctrl/⌘+Enter sends.
  Ctrl/⌘+Enter always sends.
- **Its own undo history** (Ctrl/⌘+Z, Shift+Ctrl/⌘+Z, Ctrl+Y off macOS).
- **Pasting keeps only the words.** Rich text from a page is reduced to its lines; files pasted are
  attachments; a paste over 12,000 characters becomes an attached `pasted-text.txt` instead of a
  wall of text in the box.
- **No measuring per keystroke.** The textarea grew through a layout effect on every character; the
  editor's height is the stylesheet's: up to `min(25dvh, 320px)`, then it scrolls.
- **Room for inline chips later** (mentions, files), which a textarea cannot hold.

The root element is `[role=textbox][aria-multiline=true]` with the box's `aria-label`, an
`aria-placeholder`, and `data-composer-input`, which the e2e specs select. The slash menu's
`aria-autocomplete`/`aria-controls`/`aria-activedescendant` are set on it.

## The start box

New chat and the Claudio assistant's entry ([claudio-assistant.md](claudio-assistant.md)) start a chat
that does not exist yet, and they draw **one** box: `StartComposer` with `layout="start"`
(`packages/chat-ui/src/composer/Composer.tsx`), which renders through the same `ComposerBox` as a
chat's own composer. Before this the assistant had the chat's pill and New chat had a form of its own,
and the two looked like different products.

- **On a keyboard**: a column card with the gradient hairline (it is what the page is about), the
  editor on top, and a foot inside the card with the attach button (only where `files` is given), the
  chips, the key hint as `<kbd>` (`Ctrl ↵`) and the text start button. A `note` slot under the card
  holds New chat's "runs in {dir}" line; errors go there too.
- **On a phone**: the round pill with the send icon beside the editor, the chips in a line over it,
  and the page puts the box at the foot, where the chat's own will be.
- **Where it sits** is the page's: both centre it under the greeting, with what to ask below
  (the assistant's starters, New chat's examples). Once the conversation starts, the chat's own
  composer is at the foot as in any chat.
- **Props**: `files` (attach button, tray, drops and pasted files), `commands`/`skills` (the slash
  menu, from the environment New chat reads for its directory), `submitKey` (`mod-enter` by default:
  a first message is long), `initialText`, `startLabel`, `sendLabel {idle, pending, uploading}`,
  `status`, `error`, `note`, and `editor` so a starter can fill the box. `onStart` gets the trimmed
  text (empty when only files were attached). A screen's own choices (the assistant's project context,
  as a `.composer-status-word` chip beside the chips button) go in `status`.

## What the box keeps

- **Drafts** (`composer/drafts.ts`): the text, never the files (an upload id would point at
  nothing days later), in `localStorage` under `claudio-composer-draft:<chat>:<kind>`, written 300 ms
  after typing rests and when the box goes. A draft older than seven days is dropped. A send clears
  only what was sent, as before ([chat-delivery.md](chat-delivery.md)).
- **History** (`composer/history.ts`): ArrowUp in an empty box, caret at its start, brings back the
  person's last message, then the one before (up to 20, from the transcript); ArrowDown walks back
  to an empty box. Anywhere else the arrows move the caret. Editing a recalled message makes it the
  person's own.
- **Escape on an empty box** stops the turn while the chat works, as the button beside it does.

## The "+" menu

`composer/ComposerMenu.tsx` is a real menu, built with `MoreActions` from `@claudio/ui`: Radix's
dropdown menu on a desktop, a sheet on a phone. One tab stop, arrow keys move inside it, typing
jumps to an item, Escape closes it onto the "+". The button is named "Add and options" and
announces a menu (`aria-haspopup`). Three groups, told apart by space and a heading, not by lines:

- **Add.** *Attach files*, and *Commands and skills*, which starts a `/` in the box. With no commands
  reported the item stays focusable and says why.
- **Account** (with two or more accounts). One item, "Account · alias · 42 %" (tabular), that
  opens a submenu of radio items: name, plan and use on one line, the chat's own checked. A second
  line appears only for an account that cannot be chosen, with the reason ("Exhausted until 16:00",
  "Sign-in expired", "Doesn't offer the model"): it stays focusable and inert. Choosing one on an idle
  chat moves it at once; on a working chat it waits for the turn to end, the Account item says
  where the chat is going, and a "Cancel switch" item undoes it. An error is a toast, since the menu
  has closed. With more than six accounts the item opens a picker instead (a side panel on a
  desktop, a step of the sheet on a phone): a search field over the same radio list. The accounts'
  models are read only when the submenu or the picker opens (`useChatAccounts`, `AccountPicker.tsx`;
  the builders are in `account-menu.tsx`, the states in `lib/account-choice.ts`). The switch is
  described in [accounts.md](accounts.md) and [plans/chat-account-switch.md](plans/chat-account-switch.md).
- **Servers.** One item, "Servers and connectors · 3 of 5 on", that opens the list in a panel
  (`ServersPanel.tsx`): live switches do not belong inside a menu. For a chat with a live process,
  its MCP servers as the process reports them now, claude.ai connectors included, each with its
  status, tool count, switch and, for a connector waiting for authorisation, a link to the Connectors
  page. For a resume or a fork, a button opens the run options, where the servers are chosen for the
  execution that starts (`ChatToolsPicker`, unchanged). The list is read when the menu opens.

On a phone the sheet keeps the group headings, rows are 44 px, and Account and Servers are a second
step in the same sheet with a back button: never a sheet inside a sheet. The menu's new pieces
(`submenu`, radio groups, `meta`, `detail`) are in `Menu` and `MoreActions`
(`packages/ui/src/components/controls`).

The palette (Ctrl K) has no hook for actions scoped to the open chat, so "Switch the chat's
account" is not a palette command yet.

## Switching servers on a live chat

The CLI's stream-json control protocol has `mcp_status` and `mcp_toggle` (in the Agent SDK's
`sdk.d.ts`). Claudio sent neither before. Both were confirmed on the CLI 2.1.300 on 2026-10-15,
without sending a message:

- `mcp_status` answers `{ mcpServers: [{ name, status, scope, source, config, serverInfo?, tools? }] }`.
  Connectors come with scope `claudeai` and names starting `claude.ai `.
- `mcp_toggle { serverName, enabled }` switches it in the running process **and writes the choice
  to the folder's `disabledMcpServers` in `~/.claude.json`**, as `/mcp` does in a terminal. Later
  chats in that folder start with it too. The menu says so under the list.

The path:

- `DriverSession.mcpStatus?()` / `mcpToggle?()` (`packages/core/src/providers/driver.ts`), built by
  the Claude Code session (`providers/claude-code/driver.ts`). The answer is read by `liveMcpServers`
  (`providers/claude-code/mcp.ts`), which drops each server's `config` (it can hold tokens and
  headers) and marks connectors `kind: 'connector'` with a `label` without the `claude.ai ` prefix,
  so `@claudio/chat-ui` never names a vendor (its boundaries test guards that).
- `ChatManager.mcpServers` / `toggleMcpServer` (`packages/core/src/chats.ts`), through `ChatService`.
- `GET /chats/:id/mcp` → `ChatMcpServers` (`live: false` without a process of ours) and
  `PUT /chats/:id/mcp/:name` with `ChatMcpToggle { enabled }` (`400` without a live process).
- `ChatClient.chatMcp` / `toggleChatMcp` in the web.

The status line's live hint (`status.liveHint`) no longer says the servers are fixed for a live
chat; the tool preset still is.

## Tests

- `packages/core/test/chat-mcp.test.ts`: the parser on the CLI's real answer, unknown statuses and
  malformed entries, and the two control requests the session writes.
- `packages/chat-ui/test/composer.test.ts`: text ↔ paragraphs, caret offsets across paragraphs,
  pasted slices, drafts (per chat and kind, blank, expiry) and history steps.
- `e2e/specs/composer.spec.mjs` (fake CLI): Shift+Enter, the draft after a reload, Enter sends and
  empties the box, ArrowUp/ArrowDown, the "+" menu (its name and `aria-haspopup`), its two servers, the connector's link, and the
  switch reaching the process.
- `packages/chat-ui/test/account-choice.test.ts`: the order of an account row's states.
- `packages/chat-ui/test/account-menu.test.ts`: the account submenu (radio group, reasons, Cancel
  switch), submenu versus picker, and the picker's filter.
- `packages/ui/test/menu-entries.test.ts`: radio groups never report a disabled option, and a
  sheet keeps the group headings.
- `e2e/specs/chat-account-switch.spec.mjs` (fake CLI): the Account submenu, an idle switch, a
  switch queued while the chat works (and its Cancel switch item), and the exhausted account
  disabled with its reason.
- The fake CLI answers `mcp_status` and `mcp_toggle` ([e2e/fake-cli/README.md](../e2e/fake-cli/README.md)).
- The e2e driver's `fill` writes into a contenteditable through `execCommand('insertText')`, and
  the specs that read the box (`chat`, `chat-page`, `chats`, `paging`, `slash-menu`,
  `chat-audit-delivery`) read its paragraphs.

## Rejected

- **Tiptap or Lexical.** Both wrap the same idea with more weight and their own conventions; the box
  needs plain paragraphs and a keymap, which ProseMirror's own modules give directly.
- **`mcp_set_servers`** (replace the dynamically added servers) for a live chat. It does not touch
  the servers from settings files, and how it meets `--strict-mcp-config` and Claudio's own config
  file is untested. Switching what the process already has covers the person's request.

## Related

[[plans/chat-experience.md]] · [[claudio-assistant.md]] · [[plans/claudio-assistant-entry.md]] · [[chat-delivery.md]] · [[chat-environment.md]] · [[design-system.md]] · [[plans/sdk-driver-improvements.md]]
