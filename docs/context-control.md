---
created_at: 2026-10-16T12:00:00Z
updated_at: 2026-10-16T12:00:00Z
tags:
    - chat
    - context
    - compaction
    - decision-engine
    - claudio
---
# Context control: see what fills a chat, and compact it on purpose

A person sees what fills a chat's context window and can compact the conversation when it makes
sense, instead of waiting for Claude Code to do it in the middle of a task. The plan is
[plans/context-control.md](plans/context-control.md); this is the feature as built. The CLI facts it
depends on are recorded in `packages/core/test/fixtures/recordings/c0-NOTES.md`.

## The one rule

- The breakdown is the CLI's `get_context_usage` control request.
- A compaction is the slash command `/compact`, sent as a user turn over stream-json.
- A compaction is seen through the stream's `system/status` (`compacting`) and
  `system/compact_boundary` events, and the boundary and `isCompactSummary` lines the CLI writes to
  its JSONL transcript.
- No hook is installed (no `PreCompact`), no SDK, no HTTP call to Anthropic, no terminal.

## What the panel shows

`GET /chats/:id/context` answers `{ live, unreported, detail, observedAt, snapshot, breakdown }`.

- **`snapshot`** comes from the transcript and is always there: it feeds the meters.
- **`breakdown`** is the CLI's own: one row per category (system prompt, tools, MCP tools, memory
  files, messages, free space, compaction reserve), per MCP server and per tool.
- **`detail=summary`** is the default and a local estimate. `full` is the person's "Count exactly",
  honoured only while the chat is idle.
- No process, or a CLI that does not answer, is a `200` with `live: false` or `unreported`, never an
  error. Answers are cached for 5 s (`CONTEXT_USAGE_CACHE_MS`).
- Category maths uses the CLI's `kind`, never its English name. The UI translates the names it
  knows and shows an unknown one in mono, untranslated.
- A warning appears when a chat carries too many MCP tools.
- Every context meter follows one rule: neutral below 60 %, warn from 60 %, bad from 75 %
  (`CONTEXT_WARN`, `CONTEXT_FULL` in `packages/shared/src/types.ts`). The CLI's auto-compaction
  point is drawn as a tick on the breakdown bar.

The panel is `apps/web/src/pages/chat/ContextPanel.tsx`, opened from the inspector's context
section. The three design variants are in [design-system.md](design-system.md#context-control-the-breakdown-the-compact-confirmation-and-the-divider).

## Compacting

**Compact now** opens a confirmation that says the turn is paid and about how big. The person may
add a focus (their words, kept as written) and ask for the summary as a session note.
`POST /chats/:id/compact` answers `202` with the compaction row, or `409` with a `code`: `busy`,
`waiting`, `open`, `read-only`, `housekeeping`, `at-limit`, `run`, `unsupported`, `no-history`.

Three things send `/compact`, and only these:

1. the button (`origin: person`);
2. a typed `/compact` in an idle chat, sent as typed and recorded like the button (`typed`);
3. the flow's decision point (`flow`, below).

The CLI's own automatic compaction is recorded too (`cli`) from its boundary event.

Each compaction is a row in `chat_compactions` (a migration appended at the end of `MIGRATIONS`),
with its origin, state, trigger, tokens before and after, duration and the cost the CLI reported
(never estimated). Only one housekeeping turn per chat is open at a time: a unique partial index and
a lease so a crashed process cannot hold it forever.

A compaction or note turn is a **housekeeping turn**: its `result` never reaches the listeners that
act on a chat's result (work links, flow, assistant), and a turn lost to a limit is not replayed.

## The divider

The transcript shows a compaction as a divider ("Compacted · 142k → 18k") with the summary Claude
Code continued from behind a fold, instead of a 15,000-character "user message". Old chats that
compacted look different too: the summary bubble is gone. `GET /chats/:id/compactions` lists them,
newest first, at most 50.

## Session notes

A note is Markdown under fixed English headings: Goal, Done (with evidence), Failed, Not tried yet,
Files in flight, Next step (`SESSION_NOTE_INSTRUCTIONS` in `packages/core/src/context-notes.ts`).

- **From a compaction**: the instructions are appended to `/compact`, so the summary is the note and
  no extra turn is paid.
- **Asked for**: `POST /chats/:id/notes` with `{ from: 'agent' }` is a paid turn the person asks for.
- **Kept**: `{ from: 'summary', entryUuid }` keeps a compaction summary.
- A note whose headings were all found has `sections`; otherwise `sections` is `null` and the text is
  shown whole.
- A note is **never handed to a run automatically**. Copying one into the project journal is a
  person's click, with a preview. Every served note passes through `maskSecrets`, Claudio's own
  secrets included.
- No note is written at a usage limit or when a task gives up: each would be a paid turn nobody
  asked for.

## The flow point `context.compact`

A decision point of kind `act`, scope `project`, **shipped `off`**
([decision-engine.md](decision-engine.md)). One boundary qualifies: a bounce that resumes the
Developer's earlier work chat, because every other stage starts a fresh chat. When the point is
active, the chat can compact and it is at or above 60 % (`FLOW_COMPACT_MIN_SHARE`), the engine is
asked; `compact-first` compacts before the run takes the chat, and a compaction that fails leaves
the run to go on. `watch` only records. The outcome is judged afterwards: right when the CLI
compacted the chat during the run or the run ran out of context. See
[team-and-flow.md](team-and-flow.md).

## Who may do what

- A chat's token can read the breakdown, compactions and notes, and nothing else here. Compacting,
  requesting a note and deleting a note are `403`, and so is a `/compact` sent as a message, or as
  the prompt of a resume or a fork, with such a token. Text like `/compactness` goes through. In
  open mode a chat's token is allowed and the audit labels it `chat:<id>`.
- A flow's compaction keeps that run's permission mode, allowed and denied tools and budget, and
  never uses `--json-schema`.
- See [security-model.md](security-model.md).

## Routes

Six, in the [Chats](rest-api.md#chats) table of the REST API: `GET /chats/:id/context`, `POST /chats/:id/compact`,
`GET /chats/:id/compactions`, `GET` and `POST /chats/:id/notes`, `DELETE /chats/:id/notes/:noteId`.

## Rollback

Revert the change, but keep the migration in `MIGRATIONS` and either remove `context.compact` from
`decisions.json` and every `project.json` or keep the id in the points list: `parsePoints` throws on
an unknown point.

## Related

[[plans/context-control.md]] · [[reports/ecc.md]] · [[decision-engine.md]] · [[team-and-flow.md]] ·
[[security-model.md]] · [[slash-commands.md]] · [[design-system.md]] · [[chat-delivery.md]] ·
[[status.md]]
