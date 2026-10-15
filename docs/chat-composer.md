---
created_at: 2026-10-15T15:30:00Z
updated_at: 2026-10-15T15:30:00Z
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
  touch screen (`pointer: coarse`) and on New chat, Enter breaks the line and Ctrl/⌘+Enter sends.
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

## What the box keeps

- **Drafts** (`composer/drafts.ts`): the text, never the files (an upload id would point at
  nothing days later), in `localStorage` under `agentry-composer-draft:<chat>:<kind>`, written 300 ms
  after typing rests and when the box goes. A draft older than seven days is dropped. A send clears
  only what was sent, as before ([chat-delivery.md](chat-delivery.md)).
- **History** (`composer/history.ts`): ArrowUp in an empty box, caret at its start, brings back the
  person's last message, then the one before (up to 20, from the transcript); ArrowDown walks back
  to an empty box. Anywhere else the arrows move the caret. Editing a recalled message makes it the
  person's own.
- **Escape on an empty box** stops the turn while the chat works, as the button beside it does.

## The "+" menu

`composer/ComposerMenu.tsx` replaces the paperclip. It opens as a popover (a sheet on a phone) with:

- **Attach files.**
- **Commands and skills** (when the CLI reported any): starts a `/` in the box, which opens the
  slash menu.
- **Servers and connectors.** For a chat with a live process, its MCP servers as the process
  reports them now, claude.ai connectors included, each with its status, its tool count and a
  switch. A connector waiting for its authorisation links to the Connectors page, which says how to
  give it. For a resume or a fork, a button opens the run options, where the servers are chosen for
  the execution that starts (`ChatToolsPicker`, unchanged).

## Switching servers on a live chat

The CLI's stream-json control protocol has `mcp_status` and `mcp_toggle` (in the Agent SDK's
`sdk.d.ts`). Agentry sent neither before. Both were confirmed on the CLI 2.1.300 on 2026-10-15,
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
  so `@agentry/chat-ui` never names a vendor (its boundaries test guards that).
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
  empties the box, ArrowUp/ArrowDown, the "+" menu's two servers, the connector's link, and the
  switch reaching the process.
- The fake CLI answers `mcp_status` and `mcp_toggle` ([e2e/fake-cli/README.md](../e2e/fake-cli/README.md)).
- The e2e driver's `fill` writes into a contenteditable through `execCommand('insertText')`, and
  the specs that read the box (`chat`, `chat-page`, `chats`, `paging`, `slash-menu`,
  `chat-audit-delivery`) read its paragraphs.

## Rejected

- **Tiptap or Lexical.** Both wrap the same idea with more weight and their own conventions; the box
  needs plain paragraphs and a keymap, which ProseMirror's own modules give directly.
- **`mcp_set_servers`** (replace the dynamically added servers) for a live chat. It does not touch
  the servers from settings files, and how it meets `--strict-mcp-config` and Agentry's own config
  file is untested. Switching what the process already has covers the person's request.

## Related

[[plans/chat-experience.md]] · [[chat-delivery.md]] · [[chat-environment.md]] · [[design-system.md]] · [[plans/sdk-driver-improvements.md]]
