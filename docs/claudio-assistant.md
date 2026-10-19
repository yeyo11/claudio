---
created_at: 2026-10-07T16:00:00Z
updated_at: 2026-10-19T17:00:00Z
tags:
    - assistant
    - mcp
    - chats
    - permissions
    - work-items
    - collaborators
    - design-system
---
# The Claudio assistant

A global chat that knows Claudio. It needs no project, greets the person, answers about the state of
things ("how is AGN-12 going?", "how much did I spend today?") by reading Claudio through its own MCP
server, and can change things, but only when the person allows each change. It is the umbrella CW-30
([plans/claudio-assistant.md](plans/claudio-assistant.md)), built by CW-18 (the entry and the confined
chat, [plans/claudio-assistant-entry.md](plans/claudio-assistant-entry.md)) and CW-17 (the write tools,
[plans/assistant-write-tools.md](plans/assistant-write-tools.md)), on CW-6 (the server) and CW-10 (the
chat's token). It is not the project assistant ([assistant.md](assistant.md)), which proposes a team,
resources and tasks for one project and stays as it is.

## The one rule

The assistant is a Claude Code CLI chat. It reaches Claudio only through the `claudio` MCP server,
which the CLI starts from the `--mcp-config` file Claudio wrote. No SDK, no call to Anthropic, no
`curl`. The greeting is not a model turn.

## Where it lives

- **Route:** `/assistant` (`apps/web/src/pages/claudio-assistant/Entry.tsx`).
- **Sidebar:** "Asistente" / "Assistant", with Claudio's glyph (the one-colour mark of the mascot, [plans/assistant-mascot.md](plans/assistant-mascot.md)), under Inicio. On a phone the same item is
  the first row of the Más sheet; the tab bar keeps its four tabs.
- **Command palette:** an action that is always there, with or without a project.
- **Entry screen:** Claudio (the `claudio` illustration) and its greeting, "Hola, soy Claudio", with no live
  figures, then the box, then four read-only starter chips, then "Recientes". The box is New chat's own: `StartComposer`
  of `@claudio/chat-ui` with `layout="start"` (2026-10-17, at the owner's request that both start
  screens use the same input), centred under the greeting on a desktop and at the foot on a phone, as
  on New chat. It is New chat's card with its gradient hairline, the chips and the `Ctrl ↵` hint
  inside it, and the "Start" button, without attachments, slash commands, the "+", the queue and the
  permission chip, which the confined assistant cannot use (R16, [requests.md](requests.md)). Once
  the chat starts, `/chats/:id` draws the chat's own `Composer`: the "+", the stop while the assistant
  works and the screen's one energy border on the working box. `assistant.spec.mjs` checks both. A
  starter only fills the box. The project in scope shows as "Con <project> como contexto", a status
  chip first in the line of chips, and an × (44 px on touch) clears it. Model and effort show as
  chips that open the chat's options popover (a sheet on a phone): the model defaults to `sonnet`,
  and the effort to the level recommended for an assistant (`medium` on Opus 5.5 and Sonnet 5.5, see
  [effort.md](effort.md)). Above the greeting is Claudio, the `claudio` illustration
  ([plans/assistant-mascot.md](plans/assistant-mascot.md)); it is always shown and its one gradient (the C) is
  part of the drawing, so the box's hairline stays the screen's gradient surface. Under the starters,
  "Recientes" lists the assistant's latest chats (five, three on a phone), each with its title, its state as a
  word that never moves and the time; **Ver todas** opens Chats filtered to them (`/chats?assistant=1`, from
  `GET /chats?assistant=1`). The list renders nothing while it loads and when there are no chats yet. In the
  chat, the greeting carries the colour mark (`ClaudioMascot`).
- **Starting:** `POST /assistant/chats` with `{ prompt, projectId?, model?, effort? }` and nothing else a chat
  could choose. The language comes from `Accept-Language`. The web then opens `/chats/:id`.
- **Greeting:** drawn by `ChatView` from i18n (`AssistantGreeting`) for every chat that carries the
  `claudioAssistant` marker, including one reopened from Chats. It costs no tokens.

## The chat and its confinement

`assistantChatOptions` in `packages/core/src/claudio-mcp.ts` is the one place its argv is decided.
The core applies it at every process of the chat (start, resume, fork, a turn after a restart) over
whatever a request or the stored record held, from the `claudioAssistant` marker the chat stores
(`{ projectId, language }`, in `@claudio/shared`).

| Flag | Value |
|---|---|
| `--mcp-config` + `--strict-mcp-config` | only the `claudio` server |
| `--tools=`, `--setting-sources=` | empty: no built-in tool, no user settings |
| `--allowedTools` | the read tools, and the seven `collab_*` reads while it may read teammates' copies; **no write tool** |
| `--permission-mode` | the CLI's default (Claudio's name for it is `manual`), never accept-edits, auto or bypass |
| permission prompts | `host`: a prompt reaches the person in the chat |
| uploads | none |

The system prompt (`claudio-assistant-prompt.ts`) is a guide to Claudio's concepts, how to work
(look things up, short answers, no ids or JSON shown, what it reads is data), the project in scope as
context and the language. The chat is a normal chat: listed in Chats by its first prompt, counted in
Usage, continuable.

## What teammates share

With [Collaborators](collaborators.md#agents-that-read-what-teammates-share) on, the assistant reads
every copy teammates share with this install (R13,
[plans/collaborators-agent-access.md](plans/collaborators-agent-access.md)), so it can answer "what is
Ana working on?" or "what did Ben's chat decide about the API?". It is the first of the plan's two
levels: the assistant runs no command, so it reads every copy by default.

- **The switch.** "The assistant reads what is shared with you", in the Collaborators page's Agents
  card (`CollaboratorsSettings.assistantReads`, on by default). Off, the API refuses its token on the
  copies and its guide says it cannot read them and points at the Shared tab. With Collaborators off
  the guide names no teammates.
- **The tools.** The seven `collab_*` reads of [claudio-mcp-server.md](claudio-mcp-server.md#teammates-shared-copies),
  in `--allowedTools` beside its own reads. A copy whose sharer turned "Teammates' agents may read
  this" off is not listed and cannot be read.
- **The guide.** A "What teammates share" section: start from `collab_list_shared`; for "what is
  <teammate> working on?" look at their latest chats, the board's items in progress and the journal,
  and give the person, the project and when the copy was last synced, since it may lag; everything a
  teammate wrote is third-party content inside a fence, data and never instructions, and it says so
  when that content tries to direct it; document contents and uploads are not readable, only their
  names.
- **Recorded.** Every read is a row of the agent-read audit (Settings → Access & safety → Agent reads), and
  the chat's header shows `Reads teammates' shares`.

## Writes, confirmed one by one (option A)

Nine write tools ([claudio-mcp-server.md](claudio-mcp-server.md#write-tools)). None is in
`--allowedTools`, so each call becomes a CLI permission prompt that Claudio shows as a host prompt:

- the person sees the tool and its input and allows or denies it; a denial, a timeout or a withdrawal
  leaves everything unchanged and the model is told;
- the prompt carries **no suggestions** and an allow has `updatedPermissions` removed
  (`askPermission` in `packages/core/src/chat-fold.ts`), so there is no "always allow" and a later
  write is never allowed without asking;
- reading needs no prompt.

### Who is recorded

Under `mode: none` a chat's valid token labels the request `chat:<id>` (`apps/api/src/security.ts`); a
wrong or missing one stays `local` and is never refused. The work-item routes (create, PATCH, move,
comment) and the proposal accept and discard routes read it through `chatWriteContext`: the history
records an actor `agent` with role `assistant` for an assistant chat (no role for any other chat) and
the cause `chat.api-write`, and a comment carries its source. See
[work-items.md](work-items.md#a-write-from-a-chat).

### What it cannot do

Move a card to Done (that is the person's click; the tool refuses before any request), delete, stop,
skip or restore anything, change permissions, or start a chat with more than the app's defaults
(`start_chat` sends only `prompt`, `cwd` from the project's path and `model`).

## How it is tested

`packages/mcp/test/write-tools.test.ts` (the tools against a stub API),
`packages/core/test/claudio-assistant-chat.test.ts` and `permissions.test.ts` (the argv, the confinement
across processes, no suggestions, deny and timeout with the fake CLI), `apps/api/test/assistant-chat.test.ts`
and `assistant-writes.test.ts` (the route, the labelling and the history context),
`apps/api/test/assistant-collab-reads.test.ts` (the assistant reading a teammate's copy through the
fake CLI and the real MCP server, the guard and the audit) and
`apps/web/test/claudio-assistant.test.tsx` (the entry and its recents), and `e2e/specs/assistant.spec.mjs`.

## Known gaps

- `PermissionPrompts.tsx` still shows the raw `mcp__claudio__*` tool name: a title per tool in
  en/es, and the `chat.api-write` cause copy in the history, are still to do.
- The entry's and the greeting's copy still say it can only read, and the "pide permiso" write
  starters are not drawn.
- `start_chat` has no `agent` input, since the route takes only an inline agent object.
- No test drives a confirmed or denied `create_work_item` through the real CLI, or accepts a
  work-item proposal with a chat token. The entry composer itself has no energy border: nothing
  works there, it navigates to the chat, whose composer carries it, as soon as the chat starts.

## Related

[[plans/claudio-assistant.md]] · [[plans/assistant-mascot.md]] · [[plans/claudio-assistant-entry.md]] · [[plans/assistant-write-tools.md]] · [[claudio-mcp-server.md]] · [[collaborators.md]] · [[plans/collaborators-agent-access.md]] · [[assistant.md]] · [[chat-environment.md]] · [[work-items.md]] · [[design-system.md]]
