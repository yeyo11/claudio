---
created_at: 2026-10-16T05:30:00Z
updated_at: 2026-10-16T05:30:00Z
tags:
    - plan
    - chat
    - transcript
    - subagents
    - background-tasks
    - design-system
    - ux
    - proposed
---
# Plan: readable tool rows, and what is running at a glance

Two things the chat page does badly today. A tool call opens onto its input as a JSON blob and its
result as a wall of raw text, so reading what Claude did means reading function arguments. And the
work Claude delegates — subagents, background commands, workflows — is invisible from the
conversation: a background agent's row turns green the moment it is launched, the inspector's
"Branches" card is off screen, and nothing says what a subagent is doing right now.

Status: **proposed** on 2026-10-16 by the owner, with the design settled in this document before any
code. **Launch blocked until two orchestrations merge**: `claudio-context-control` and
`claudio-agent-run-improvements` (both started 2026-10-16 03:15 from `claudio-stage-a`) own
`normalize.ts`, `Transcript.tsx`, `chat-fold.ts`, `chats.ts`, `types.ts`, `Side.tsx`, the fake CLI and the
design system files this plan touches. A first launch (`bdab32b6`, 03:22) was stopped after seven
minutes for that reason. Relaunch from `main` once both are in, after re-verifying section 2's line
anchors and section 6's file lists against the merged code (the context-control plan adds a
`CompactionDivider` to the transcript and a context panel beside `Side.tsx`; the agent-run plan adds a
risk score to transcript rows). Branch `feat/tool-rows-live-branches` from `main` at `9cedb3142` (which already holds the
chat-experience work, the terminal, the brand kit and the rename to Claudio; nothing else of the chat
is unmerged). Orchestration `claudio-live-branches`, section 6.

This document is written to be implemented **without any other context**. Every file and line was
verified on 2026-10-16 against `9cedb3142`; line numbers drift, so search for the quoted code when a
number no longer matches. Where a task prompt and this plan disagree, the plan wins.

## Contents

1. [Ground rules](#1-ground-rules)
2. [What is wrong today](#2-what-is-wrong-today)
3. [The design](#3-the-design)
4. [Data and protocol](#4-data-and-protocol)
5. [Tests](#5-tests)
6. [Orchestration](#6-orchestration)
7. [Decisions taken and rejected](#7-decisions-taken-and-rejected)
8. [Related](#related)

---

## 1. Ground rules

- **The one rule.** Everything here reads what the Claude Code CLI already ships: the `tool_use_result`
  field of its stream-json `user` events, the `toolUseResult` field of its transcript lines, the
  sidechain `assistant`/`user` events it streams with `parent_tool_use_id`, and its `task_*` system
  events. No second process, no scraping, no new flag.
- **Night Shift** ([design-system.md](../design-system.md)): tokens only, dark first and both themes,
  Geist Mono for ids, paths, commands, counts and times, status colour always with a word or an icon,
  `--live` (cyan) and loops only for what is working now, one energy border per screen (it stays on
  the composer), at most two gradient surfaces (this plan adds none), 44 px targets and `Sheet`s on a
  phone, every animation stopped under `subtle`, `off`, `prefers-reduced-motion` and a hidden tab.
- **Copy** through i18n with `en`/`es` parity; `es` follows
  [`GLOSSARY.md`](../../apps/web/src/i18n/GLOSSARY.md). The chat package's strings live in
  `packages/chat-ui/src/locales/{en,es}/chat.json`, the primitives' in
  `packages/ui/src/locales/{en,es}/primitives.json`.
- **The dependency direction** `apps/web → @claudio/chat-ui → @claudio/ui → @claudio/shared` holds
  (`packages/chat-ui/test/boundaries.test.ts`). `DiffView` lives in `apps/web/src/components/changes/`
  and is handed to the chat package as a slot, never imported from it.
- **Keep what the specs select.** `e2e/specs/chat-page.spec.mjs` reads `.msg-step`, `.step-tools .badge`,
  `.msg-step .call-row`, `.call-row.is-error` and the word "failed" in it, and the `⋯` menu entries.
  `apps/web/test/class-inventory.test.ts` fails on any class added or lost until
  `pnpm exec tsx scripts/class-inventory.ts --write` (run inside `apps/web`) regenerates `apps/web/test/fixtures/class-names.json`:
  regenerate it, never edit it.
- **Generated files are regenerated**, never edited: `pnpm --filter @claudio/api openapi:schemas`
  after any change to `packages/shared/src/types.ts`; the class fixture above; the module-graph
  fixture if a test asks for it.
- Never edit `CHANGELOG.md`. Conventional Commits.

## 2. What is wrong today

All verified in code on 2026-10-16.

**Tool rows.** A tool call is a `CallRow` (`packages/chat-ui/src/components/Transcript.tsx`, search
`function CallRow`). Its folded line is already right: the tool's icon, its name in mono, a hint
(`callHint`, `packages/chat-ui/src/lib/chat-steps.ts`) and a rail coloured by outcome. Opening it
shows `.call-body`: the input as `JSON.stringify(call.input, null, 2)` in a JSON `CodeBlock`, and the
result as the raw text in a `CodeBlock` (`ResultBlock`, cut at 6 000 characters). So an `Edit` reads as
`"old_string": "…\n…"` escaped on one line, a `Bash` as a quoted command, a `Read` as `1\t…` lines, and
an MCP tool's answer as whatever text its server returned. A bare `tool_result` outside a step (the
`Block` switch, `case 'tool_result'`) does the same. `packages/shared/src/normalize.ts` flattens the
result to text and drops everything structured the CLI wrote beside it.

**Live branches.** `chat.children` (`ChatChildren`: `subagents`, `backgroundTasks`, `workflows`)
already carries every delegation with its status and times, and `apps/web/src/lib/events.ts` already
refetches the chat detail on `subagent.*` and `task.*` events. But:

- A foreground `Agent` call shows a spinner only while it is inside the current step. A background
  one returns "Async agent launched" at once, so its row reads as done while the agent runs.
- A `Bash` with `run_in_background` does the same; nothing more is seen until the
  `<task-notification>` arrives as a notice row (`packages/chat-ui/src/lib/chat-notice.ts`).
- A subagent's own messages are hidden unless "Subagent messages" is switched on in the `⋯` menu,
  and then they are mixed into the conversation.
- The only live list is the "Branches" card of the inspector (`apps/web/src/pages/chat/Side.tsx`,
  `BranchesCard`), a side panel that is closed on narrow screens and far from the composer.
- Nothing says what a subagent is doing: `feedActivity` in `packages/core/src/chat-fold.ts` returns
  on `entry.isSidechain`, so `ChatActivityTracker` (`packages/core/src/chat-activity.ts`) only knows
  the main agent; `ChatSubagent` has `lastActivityAt` and no activity.
- A `Task`/`Agent` call is matched to its subagent by description and type (`subagentFor`,
  `chat-steps.ts`): two agents with the same description match neither.

**What the protocol already gives** (verified with `claude -p --output-format stream-json --verbose`,
CLI 2.1.300, on 2026-10-16, and in the `.jsonl` files under `~/.claude/projects`):

- Every `user` event that carries a `tool_result` block also carries **`tool_use_result`** (stream) /
  **`toolUseResult`** (transcript file), an object per tool:

  | Tool | Keys seen |
  |---|---|
  | `Read` | `type: 'text'`, `file: { filePath, content, numLines, startLine, totalLines }` |
  | `Edit`, `MultiEdit` | `filePath`, `oldString`, `newString`, `replaceAll`, `originalFile`, `structuredPatch` (hunks), `userModified` |
  | `Write` | `type: 'create' \| 'update'`, `filePath`, `content`, `structuredPatch` |
  | `Bash` | `stdout`, `stderr`, `interrupted`, `isImage`, `noOutputExpected`, `returnCodeInterpretation`; `backgroundTaskId` when sent to the background |
  | `Grep`, `Glob` | `mode`, `filenames`, `numFiles` (files mode) or `content`, `numLines` (content mode), `numMatches` (count mode) — confirm against a transcript before relying on a key |
  | `WebFetch` | `bytes`, `code`, `codeText`, `result`, `url` |
  | `Agent`, `Task` | `agentId`, `description`, `prompt`, `resolvedModel`, `status` (`async_launched` for a background one), `isAsync`; a foreground one carries `content` and usage |
  | `TaskStop`, `Monitor`, `AskUserQuestion` | `task_id`/`message`, `taskId`/`timeoutMs`/`persistent`, `questions`/`answers` |
  | a failed call | a **string** (the error), not an object |

  `packages/core/src/sessions.ts` (`ACTIVITY_FOLD`) and `packages/core/src/edit-steps.ts`
  (`unifiedOf`, `addEditEntry`) already read some of it from the file; nothing reads it from the
  stream, and nothing reaches the web.
- Sidechain messages arrive on the stream as `assistant`/`user` events with `parent_tool_use_id`
  set; `normalizeMessage` marks them `isSidechain` with `parentToolUseId`. Their token deltas
  (`stream_event`) are dropped at `packages/core/src/providers/claude-code/stream.ts`
  (`if (raw.parent_tool_use_id != null) return;`), so a subagent's activity can be derived from its
  calls and results, not from its text blocks.
- `system` events `task_started` (`task_type` `local_bash` / `local_agent` / `local_workflow`,
  `tool_use_id`, `is_backgrounded`, `owned_by_subagent`), `task_updated`, `task_progress`,
  `task_notification` (`status`, `summary`) and `background_tasks_changed` are folded by
  `packages/core/src/providers/claude-code/branches.ts` into `ClaudeBranches`.

---

## 3. The design

### 3.1 Principles and the space budget

The conversation column (740 px, `.run-scroll` in `packages/chat-ui/src/styles/chat.css`) is the
reader's. Everything this plan adds either lives **inside a row the reader opened** (tool bodies,
branch cards under a step) or in **one line above the composer** that the reader can fold and that
disappears by itself when nothing runs. Nothing new is always on.

- **Nothing opens on its own.** A step opens while it is current, as today; a tool body is seen only
  when the reader opens the row; the live strip starts folded and remembers the reader's choice.
- **One line per thing.** Folded, the strip is 32 px on a desktop and 44 px on a phone. A branch
  card under a step is two lines. A tool body is capped and offers "show all".
- **Live colour stays scarce.** `--live` on the spinners, the live rail and the activity verb. The
  energy border stays on the composer. No gradient is added; the workflow card loses its
  `grad-border` (decision 7.4).
- **Status with a word.** `ok` "done", `bad` "failed", `warn` "stopped", always beside an icon and a
  word; a row never says its state by colour alone.
- **Mono for the machine's words**: tool names, paths, commands, counts, clocks, agent kinds.

### 3.2 Tool rows: the body reads as what happened

The folded line does not change (icon · tool name · hint · "failed" when it failed · the rail). What
changes is `.call-body`, which becomes **a lens chosen by the tool**. Every lens has the same frame:
one or two zones, each headed by a Geist Mono 11 section label (`.call-label`, the `.section-label`
style), and a quiet `Raw` toggle at the end of the frame (`.call-raw`, a `.btn-ghost.btn-small`) that
swaps the lens for the JSON of the input and the raw text of the result, for whoever needs it.

| Tool | Hint (folded) | Zone "Call" | Zone "Result" |
|---|---|---|---|
| `Bash` | the `description`, else the command's first 80 characters | the command in a `CodeBlock lang="bash"`; `timeout` and "in the background" as a mono meta line when set | stdout as a terminal block (`.call-term`, mono 12, `--bg-1`, no syntax); `stderr` under it in its own block headed "Errors" when the detail has one; `interrupted` as a warn `Tag` "interrupted"; a backgrounded call reads "Launched in the background" and links its task (3.3) instead of output |
| `Read`, `NotebookRead` | the path relative to the chat's cwd (as `activityTarget` does) with `:offset–end` when `offset`/`limit` were given | nothing (the hint says it) | the file as a `CodeBlock` with the language of its extension and line numbers starting at `startLine`; the `N\t` prefixes of the text are stripped; capped at 120 lines with "Show all {{count}} lines" |
| `Edit`, `MultiEdit`, `Write`, `NotebookEdit` | the path | one zone "Change": the unified diff drawn by the app's diff slot (3.2.1) in Unified mode, `trimEdges`; a `Write` that created the file shows the added diff; `replace_all` as a meta line | when the call failed, "Result" holds the error text as today |
| `Grep`, `Glob` | the pattern, then `path` in muted mono | the pattern and the options that were set (`glob`, `type`, `-i`, `output_mode`) as a mono meta line | files mode: a list (`.call-files`, one `li` per path, mono, each a relative path); content mode: a `CodeBlock` of the matching lines; count mode: "{{count}} matches" |
| `WebFetch` | the host | the URL (mono, full) and the prompt in prose | the answer as Markdown (`RichText`); a meta line "{{status}} · {{bytes}}" when the detail has them |
| `WebSearch` | the query | the query | the answer as Markdown |
| `Agent`, `Task` | the `description` | kind (`subagent_type`) and model as `Tag`s, "in the background" when `run_in_background`; the prompt as Markdown behind a `Collapsible` "Prompt" (closed) | a foreground one: the report as Markdown; a background one: "Launched in the background" and its branch card (3.3). The sentence "This tool result is internal metadata…" is never shown |
| `TodoWrite`, `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet` | the subject, or "{{count}} items" | the list as a checklist: one row per item, its status icon and word (`pending`, `in progress`, `done`) | nothing beyond the raw |
| `Skill`, `ToolSearch`, `AskUserQuestion`, `ExitPlanMode`, `EnterPlanMode`, `BashOutput`, `KillShell`, `TaskStop`, `Monitor`, `StructuredOutput` | the first string field, as `callHint` already picks | the generic lens | the generic lens |
| `mcp__<server>__<tool>` and anything unknown | `callHint` | **the generic lens**: the input as a field list (`.call-fields`: key in mono 11 muted, a short value inline, a multi-line string as a `CodeBlock`, an object or array as a nested list two levels deep, then JSON) | the text, read for what it is: JSON parses → a collapsible key tree (`.call-tree`, same look as the fields); looks like Markdown (a heading, a list, a fence) → `RichText`; else a preformatted block (YAML, tables, logs). Capped at 6 000 characters with "Show all" as today |

**3.2.1 The diff slot.** `ChatUiConfig.slots` (`packages/chat-ui/src/lib/context.tsx`) gains
`Diff: ComponentType<{ path: string; patch: string }>`. `apps/web` provides it where it builds
the config (`apps/web/src/lib/chat-ui.tsx`): a thin wrapper that parses the unified text with
`apps/web/src/lib/diff.ts` and draws `DiffView` in `mode="unified"` with `trimEdges` and `wrap` on a
phone, inside `.call-diff` (max height 360 px, inner scroll, "Show all" past it). The change-review
rules of design system §5 apply: only what changed carries colour.

**3.2.2 Classes.** New: `.call-label`, `.call-zone`, `.call-raw`, `.call-meta` (the mono meta line),
`.call-term`, `.call-stderr`, `.call-files`, `.call-fields`, `.call-field`, `.call-field-key`,
`.call-tree`, `.call-diff`, `.call-more` (the "show all" ghost button), `.call-checklist`. Kept:
`.call-row`, `.call-body`, `.call-open`, `.call-outcome`, `.is-ok/.is-error/.is-running`.

**3.2.3 Copy** (`chat.json`, namespace `transcript.call`):

| key | en | es |
|---|---|---|
| `input` | Call | Llamada |
| `output` | Result | Resultado |
| `change` | Change | Cambio |
| `raw` / `lens` | Raw / Readable | En bruto / Legible |
| `showAll` | Show all {{count}} lines | Mostrar las {{count}} líneas |
| `errors` | Errors | Errores |
| `interrupted` | interrupted | interrumpido |
| `background` | in the background | en segundo plano |
| `launched` | Launched in the background | Lanzado en segundo plano |
| `prompt` | Prompt | Instrucciones |
| `matches` | {{count}} matches | {{count}} coincidencias |
| `items` | {{count}} items | {{count}} elementos |
| `status.pending` / `inProgress` / `completed` | pending / in progress / done | pendiente / en curso / hecho |

### 3.3 What is running: the strip, the cards, and a subagent's own line

**3.3.1 The strip** (`.chat-branches`). One block between the conversation and the composer, drawn
only while the chat has a branch that is running, or ended fewer than 5 s ago. Order of the column
top to bottom: `.run-stage` · **the strip** · the queued card (`.chat-queued`) · the limit banner
(`.lim`) · the composer. It is neutral: `--bg-2`, a hairline top (`--line`), the column's width, no
gradient, no energy.

*Folded* (the default, and what is remembered): one line, `.chat-branches-bar`, a real `<button
aria-expanded>` the full width, 32 px tall on a desktop and 44 px on a phone:

```
⠋  2 agents · 1 background task      Explore · reading packages/core/src/chats.ts · 0:42        ⌄
```

- the braille `Spinner` in `--live` (still glyph under `subtle`/`off`);
- the count in 13 px sans (`.chat-branches-count`): the running agents, tasks and workflows,
  joined with " · ", only the kinds that are not zero;
- `.chat-branches-now`, mono 12 `--text-faint`, ellipsised: the newest activity among the running
  subagents (its kind, then the `ActivityTicker` verb and target, then its clock), or, when no
  subagent reports one, the newest running branch's description and clock;
- the chevron (`.collapsible-chevron`), rotated when open.

*Open*: `.chat-branches-list`, under the bar, at most 168 px tall with its own vertical scroll, one
`.chat-branch-row` per branch, 28 px (36 px on a phone, where the list is a `Sheet` titled "Running
now" with 48 px rows instead of an inline list). A row, left to right:

1. its state: the braille spinner while running; `Check` in `--ok` with "done", `CircleAlert` in
   `--bad` with "failed", `CircleStop` in `--warn` with "stopped" during the 5 s it stays after ending;
2. the kind as a mono `badge` (`.chat-branch-kind`): the agent's type (`Explore`,
   `general-purpose`…), `bash` for a command, `workflow`;
3. the description, ellipsised (`.chat-branch-desc`); a command shows its description, else its
   first 60 characters in mono;
4. for a subagent with an activity, `ActivityTicker` without its own clock (`.chat-branch-act`);
   for a workflow, "{{done}}/{{total}} agents · phase {{n}}";
5. the clock since it started, mono tabular (`.chat-branch-time`);
6. the whole row is a `<button>` that opens the branch's panel (`useDetailPanel().open` with
   `{ kind: 'subagent' | 'task' | 'workflow-agent' }`, as `BranchesCard` does today), with
   `aria-label` "Open {{description}}".

A branch a subagent launched (`ownerId` set, or `fromSubagent`) sits under its owner with
`.is-nested` (indented 20 px, a hairline on the left). The list is ordered oldest first so rows do not
jump; a finished row leaves after 5 s with the `Collapsible` transition.

The fold is remembered in `localStorage` under `claudio-chat-branches` (`'open' | 'closed'`,
default closed; a new key, so `apps/web/src/lib/legacy-storage.ts` has nothing to carry over). When the strip has nothing to show it is not in the DOM.

Screen readers: the bar's text is the live region (`role="status"`, throttled to one announcement
per 5 s with `ActivityTicker`'s `useThrottled`); the list has `aria-label` "Running now".

**3.3.2 Cards under the step** (`.chat-launch`, generalised). Today a `Workflow` call draws a
`LaunchCard` under its step. The same card now draws every branch a step started: a subagent
(`.chat-launch.is-agent`), a background command (`.is-task`) and a workflow (`.is-workflow`).
Matching is exact where the data allows it: an `Agent` call's `detail.agentId` (4.1) to
`ChatSubagent.id`; a `Bash` call's `detail.backgroundTaskId` to `ChatBackgroundTask.id`; a
`Workflow` call by time as today. The description fallback (`subagentFor`) stays for transcripts
written by a CLI that did not record the id.

The card: the mark (two letters for a workflow as today; the `Bot` icon for an agent, `Terminal` for
a command), the name or description in 13 px semibold, a state line (`Spinner` + status word in its
tone + facts: kind, the clock, for a command the command in mono ellipsised), an "Open" button
(`.chat-launch-open`) to the panel, and the segmented bar only for a workflow. Running, the card
carries the live rail (`.live-rail`), never the energy border. The card stays once the branch has
ended, with its final word and duration: it is the conversation's record.

**3.3.3 A subagent's own line.** Core keeps one `ChatActivityTracker` per running sidechain (4.2), so
`ChatSubagent.activity` says "reading `packages/core/src/chats.ts`" the way `chat.activity` does for
the main agent. It is what the strip's bar and rows show, what the inspector's Branches card shows
under each subagent (one `ActivityTicker` per running one), and what the subagent panel's header
shows. A subagent with no open call has `activity: null` and reads "working" with its clock.

**3.3.4 Copy** (`chat.json`, namespace `branches`):

| key | en | es |
|---|---|---|
| `title` | Running now | En marcha |
| `agents_one` / `agents_other` | {{count}} agent / {{count}} agents | {{count}} agente / {{count}} agentes |
| `tasks_one` / `tasks_other` | {{count}} background task / … tasks | {{count}} tarea en segundo plano / … tareas en segundo plano |
| `workflows_one` / `workflows_other` | {{count}} workflow / {{count}} workflows | {{count}} workflow / {{count}} workflows |
| `show` / `hide` | Show what is running / Hide | Ver lo que está en marcha / Ocultar |
| `open` | Open {{what}} | Abrir {{what}} |
| `state.running` / `completed` / `failed` / `stopped` | working / done / failed / stopped | trabajando / terminado / ha fallado / detenido |
| `nested` | from {{owner}} | de {{owner}} |
| `workflowFacts` | {{done}}/{{total}} agents · phase {{n}} | {{done}}/{{total}} agentes · fase {{n}} |

The transcript's existing `launch.*` keys are folded into `branches.*`.

### 3.4 Motion, themes, accessibility

- Loops: the braille spinner only. Under `[data-motion='subtle']` it holds `SPINNER_STILL`; under
  `off` and `prefers-reduced-motion` nothing animates; `data-hidden` pauses it. The list's open and
  close is the `Collapsible` transition. `e2e/specs/motion.spec.mjs` gains the strip.
- Both themes: every colour through tokens; the strip's bar and rows pass 4.5:1 for text (the
  `--text-faint` mono on `--bg-2` must be checked in light; if it fails, `--text-muted`).
- Keyboard: the bar and every row are buttons; `Enter`/`Space` toggle; focus visible; the `Sheet`
  traps focus as every sheet does. `a11y-core.spec.mjs` scans the chat with the strip open.
- Phone (390 px): the bar is 44 px, the list is a `Sheet`, the cards wrap their facts on a second
  line, tool bodies wrap long lines (`wrap` on the diff, `white-space: pre-wrap` on terminal blocks),
  nothing scrolls sideways.

### 3.5 Reference screens (task `d1`)

Drawn in `docs/design-system/reference/`, generated by a new `tools/live.py` built on `common.py`,
dark and light screenshots with `tools/shoot.py`, and checked with `tools/check.mjs`:

- `DesktopChatEnMarcha.html` / `MobileChatEnMarcha.html`: a working chat with two subagents (one
  nested), one background `pnpm test`, the strip **open** on the desktop screen and **folded** on the
  phone (plus the phone `Sheet` as `MobileChatEnMarchaLista.html`), two branch cards under their
  steps (one running with the live rail, one done), the composer with the energy border.
- `DesktopChatLlamadas.html` / `MobileChatLlamadas.html`: an idle chat with one step open onto six
  rows, each open: `Bash` (stdout + stderr), `Read`, `Edit` (unified diff), `Grep` (files), `Agent`
  (background, with its card), and an MCP tool (`kb_search_documents`, generic lens with the JSON
  tree), the `Raw` toggle visible on one.
- `claudio-ds.css` gains a last section, "Tool rows and live branches", numbered after the one before it with every class of 3.2.2 and
  3.3; `design-system.md` §2 maps them to the app's classes, and a subsection "Tool rows and live
  branches" under the chat sections says the rules of 3.1–3.4 in the document's own voice.

---

## 4. Data and protocol

### 4.1 The structured result reaches the web

`packages/shared/src/types.ts`, beside `ContentBlock` (search `export type ContentBlock`):

```ts
/**
 * What the CLI recorded beside a tool result (`tool_use_result` on its stream, `toolUseResult` in
 * its transcript), kept only where it says something the result's text does not: the text stays
 * the record, this tells the page how to read it.
 */
export type ToolResultDetail =
  /** `Read`: the text is the file with `N\t` line prefixes */
  | { kind: 'file'; path: string; startLine: number; numLines: number; totalLines: number }
  /** `Edit`, `MultiEdit`, `Write`, `NotebookEdit`: the patch as unified text (`''` when the CLI kept none); `created` for a new file */
  | { kind: 'patch'; path: string; patch: string; created: boolean }
  /** `Bash`: the text is stdout; `backgroundTaskId` when the command was sent to the background */
  | { kind: 'command'; stderr: string; interrupted: boolean; backgroundTaskId: string | null }
  /** `Grep`, `Glob` */
  | { kind: 'matches'; mode: 'files' | 'content' | 'count'; total: number }
  /** `WebFetch` */
  | { kind: 'fetch'; status: number | null; bytes: number | null }
  /** `Agent`, `Task`: the CLI's id of the agent, which names its transcript and its `ChatSubagent` */
  | { kind: 'agent'; agentId: string; background: boolean; model: string | null }
  /** Anything else that was an object, when its JSON is under 8 000 characters */
  | { kind: 'data'; value: unknown };
```

and `tool_result` gains `detail?: ToolResultDetail`:

```ts
| { type: 'tool_result'; toolUseId: string; content: string; isError: boolean; detail?: ToolResultDetail };
```

`packages/shared/src/normalize.ts`: `normalizeMessage(raw)` already receives the whole line on both
paths (the stream event in `stream.ts`, the file line in `sessions.ts`), so one function,
`toolResultDetail(raw.tool_use_result ?? raw.toolUseResult)`, exported and pure, decides the kind
from the **shape** (the line does not say the tool's name): `file.filePath` → `file`;
`structuredPatch` or `oldString` or `type: 'create'|'update'` with `filePath` → `patch` (the hunks
through `unifiedOf`, a created file through `addedDiff`, both **moved** from
`packages/core/src/edit-steps.ts` into a new `packages/shared/src/patch.ts` that core imports);
`stdout` a string → `command`; `filenames` or `numFiles` or `numMatches` or (`mode` with `content`)
→ `matches`; `code` a number with `bytes` → `fetch`; `agentId` a string → `agent`
(`background: isAsync === true || status === 'async_launched'`, `model: resolvedModel ?? null`); a
string → no detail; any other object → `data`, dropping `originalFile`, `content`, `stdout`,
`result`, `file` first and only when the remaining JSON is under 8 000 characters. The detail is
attached to the line's single `tool_result` block; a line with several blocks gets none. `isError`
lines get none.

The API changes nothing but the type: `GET /chats/:id` pages, the `message` events of
`GET /chats/:id/stream`, `GET /chats/:id/subagents/:agentId` and the JSON export carry `detail` where
the CLI wrote one. Regenerate `apps/api/src/openapi/schemas*`. `edit-steps.ts` keeps reading
`toolUseResult` itself (it needs `originalFile`); it now imports `unifiedOf`/`addedDiff` from shared.
`GET /chats/:id/search` is unchanged (it matches the text).

The chat package reads `detail` in `partsOf` (`chat-steps.ts`): `StepCall.result` becomes
`{ content, isError, detail? }`.

### 4.2 A subagent's activity

`packages/shared/src/types.ts`:

```ts
export interface ChatSubagent {
  …
  /** What it is doing right now, from its latest calls; null while it has no open call or has ended */
  activity: ChatActivity | null;
}

/** A running subagent's activity moved. At most one per subagent per second, like `chat.activity`. */
export interface SubagentActivityEvent extends ClaudioEventBase, ActivityEventRef {
  type: 'subagent.activity';
  toolUseId: string;
  agentId: string | null;
  activity: ChatActivity | null;
}
```

added to the `ClaudioEvent` union (search `export type ClaudioEvent =`) and to the `/events`
description in `apps/api/src/openapi/routes.ts` ("what each subagent is doing, `subagent.activity`").
`ChatSubagentEntry` carries it through `ChatSubagent`.

Core:

- `packages/core/src/live-chat.ts`: `LiveChat` gets `branchActivity: Map<string, ChatActivityTracker>`
  keyed by the sidechain's `parentToolUseId` (the launching call's id), and
  `branchActivityKeys: Map<string, string>` for the announce.
- `packages/core/src/chat-fold.ts`, `feedActivity`: a sidechain entry with `parentToolUseId` feeds
  (creating on first use, with the chat's working dir as `cwd`) its own tracker's `called` and
  `answered`, exactly as the main agent's. The main agent's `tool_result` for that
  `parentToolUseId`, and a `task_notification` that ends the agent (`branches.ts`,
  `updateAgentTask`), delete the tracker and announce `null`. `turnEnded` and `clear` clear them all.
- `packages/core/src/chat-branches.ts`, `toChatSubagent`: `activity` from the tracker keyed by
  `sub.toolUseId` (`current()`), `null` otherwise. The `ChatSubagent` of a chat read from disk
  (no live process) has `activity: null`.
- `packages/core/src/chats.ts` (search `activityKey(chat.alive`): beside the main agent's announce,
  one per tracker: when a subagent's key changed, the publisher is told
  (`packages/core/src/event-sources.ts`): the same one-second window as `chat.activity`, keyed
  `${runId}:${toolUseId}`, emitting `subagent.activity` with `runRef(run)`, the `toolUseId`, the
  `agentId` the branch tracker knows, and the activity. Lists (`GET /chats`, the overview) are not
  patched: only the chat's detail and the subagents list carry subagents.

Web (`apps/web/src/lib/events.ts`): `'subagent.activity': true` in the listened set; it refetches
nothing; a `patchSubagentActivity(client, event)` writes the activity into
`keys.chat(id, false|true)` → `detail.chat.children.subagents[i].activity` (matched by `toolUseId`
or `agentId` against `ChatSubagent.id`, which is the agent id when known and the call id until
then) and into `keys.subagents` lists, in place, as `patchActivity` does for the chat.

### 4.3 What the fake CLI must speak (task `e1`)

`e2e/fake-cli/claude` gains two script lines, documented in its README and covered by
`claude.test.mjs`:

- `agent: <description> | <sidechain script>` — one `Agent` call: the `assistant` `tool_use`
  (`name: 'Agent'`, `input: { description, subagent_type: 'Explore', prompt: 'Look around' }`), a
  `system` `task_started` (`task_type: 'local_agent'`, `task_id`, `tool_use_id`, `is_backgrounded: false`),
  then the sidechain: for each `;`-separated step of `<sidechain script>` (`read: <path>` or
  `run: <command>`, held 400 ms like the main ones) an `assistant` and a `user` event with
  `parent_tool_use_id` set to the call's id and `isSidechain: true`; then the `user` `tool_result` of
  the `Agent` call with `tool_use_result: { agentId, description, status: 'completed', prompt }`, and a
  `task_notification` (`status: 'completed'`, `summary`). With `background: ` as the first word of the
  description the call answers at once (`status: 'async_launched'`, `isAsync: true`,
  `is_backgrounded: true`) and the sidechain and the notification follow after the next step of the
  main script, so a spec can see the branch running.
- `background: <command>` — a `Bash` call with `run_in_background: true`: its `tool_result` at once
  (`tool_use_result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId }`), a
  `task_started` (`local_bash`, `is_backgrounded: true`), the command run as today, and a
  `task_notification` when it ends.
- Every `read:`/`run:` result the fake already emits now carries `tool_use_result` in the real
  shapes of section 2 (`{ type: 'text', file: {…} }`, `{ stdout, stderr, interrupted: false }`).
- A written transcript (`@transcript`) records the same lines with `toolUseResult` and the sidechain
  lines with `isSidechain: true` and `parentToolUseID`, plus the agent's own
  `<session>/subagents/agent-<agentId>.jsonl` with the sidechain's lines, so a reload shows the
  same thing.

---

## 5. Tests

| Where | What |
|---|---|
| `packages/shared/test/normalize.test.ts` (new or extended) | `toolResultDetail` on one real line per kind of section 2 (fixtures pasted from a transcript, secrets removed), a string result, a `data` under and over the cap, two `tool_result` blocks in one line → no detail; `unifiedOf`/`addedDiff` tests moved with them |
| `packages/core/test/chat-activity*.test.ts` | a sidechain entry feeds its own tracker; the main agent's tracker ignores it; the parent's `tool_result` and a `task_notification` clear it; `turnEnded` clears all; `toChatSubagent` carries `activity` |
| `packages/core/test/event-sources*.test.ts` | `subagent.activity` is throttled per subagent to one per second and never repeats an unchanged key |
| `apps/api` openapi tests | the summary/tag test passes; schema drift check clean |
| `packages/chat-ui/test/tool-lens.test.ts` | the pure lens model: which lens each tool gets, the `Read` prefix stripping, the generic fields from a nested input, JSON/Markdown/plain detection of a result, the caps |
| `apps/web/test/live-branches.test.tsx` | the strip is absent with nothing running; folded by default and remembered; the bar's count and newest activity; rows, nested rows, the 5 s grace; `patchSubagentActivity` writes into both sidechain caches |
| `apps/web/test/transcript-lenses.test.tsx` | `CallRow` open on a `Bash`, `Read`, `Edit` (with a stub slot), `Grep`, `Agent` and an MCP result shows the labelled zones and no `{"` of JSON; `Raw` shows it; the error row keeps "failed" |
| `apps/web/test/i18n.test.ts`, `hardcoded-strings.test.ts`, `design-tokens.test.ts`, `class-inventory.test.ts` | pass with the fixture regenerated |
| `e2e/specs/chat-page.spec.mjs` | open the seeded step's `Bash` row: the body has the "Call" and "Result" labels and the command in a `code`; no raw JSON |
| `e2e/specs/chat-live-branches.spec.mjs` (new, `fakeCli`) | a turn with `agent: background: …` and `background: sleep 2`: the strip appears folded with "1 agent · 1 background task", opens, a row shows the agent's activity ("reading …"), the card under the step is running; when both end the rows say "done" then leave and the strip goes; a reload shows the cards with their final words |
| `e2e/specs/motion.spec.mjs`, `a11y-core.spec.mjs` | the strip's spinner holds still under `subtle`; the chat with the strip open passes axe |

---

## 6. Orchestration

One orchestration, **`claudio-live-branches`**, `cwd` a worktree of `feat/tool-rows-live-branches`,
`worktree: true`, concurrency 3, `maxAttempts` 2, `synthesize` on. Code-writing workers run on
`claude-opus-5-5`; `x1` (prose only) on `claude-sonnet-5-5`. Verification on the merged branch:
`pnpm typecheck`, `pnpm -r test`, the OpenAPI drift check, `pnpm build`, with the fixer on
`claude-opus-5-5`, and the `e2e-specs` task Claudio adds for the specs the work touches. No worker
runs `pnpm e2e`, `docker build` or `pnpm desktop:dist`.

Three stages in series: `d1 · c1 · c2` → `w1 · w2` → `e1 · x1`.

| Id | Task | dependsOn | Owns | Checks |
|---|---|---|---|---|
| `d1` | **Design**: the four reference screens and the phone sheet of 3.5, `tools/live.py` and the screenshots, `claudio-ds.css` (its new last section), `design-system.md` (§2 rows, the "Tool rows and live branches" subsection). Every class name of 3.2.2 and 3.3 appears in the HTML exactly as the web will use it. Both themes checked with `tools/check.mjs` | — | `docs/design-system/reference/DesktopChatEnMarcha.html`, `MobileChatEnMarcha.html`, `MobileChatEnMarchaLista.html`, `DesktopChatLlamadas.html`, `MobileChatLlamadas.html`, `reference/tools/live.py`, `reference/screenshots/*EnMarcha*`, `*Llamadas*`, `docs/design-system/claudio-ds.css` (append the section), `docs/design-system.md` | `node docs/design-system/reference/tools/check.mjs`, contrast ≥ 4.5:1 read from the screenshots in both themes |
| `c1` | **Structured results** (4.1): `ToolResultDetail`, `detail` on `tool_result`, `toolResultDetail` in `normalize.ts`, `packages/shared/src/patch.ts` (moved `unifiedOf`/`addedDiff`, core re-imports), schemas regenerated, the `message` event doc line in `routes.ts` if it lists fields, tests of section 5 | — | `packages/shared/src/types.ts` (the `ContentBlock` region only), `packages/shared/src/normalize.ts`, `packages/shared/src/patch.ts`, `packages/shared/test/**`, `packages/core/src/edit-steps.ts` (imports only), `apps/api/src/openapi/schemas*` | `pnpm typecheck`, shared + core + api tests, schema drift |
| `c2` | **Subagent activity** (4.2): the types (`ChatSubagent.activity`, `SubagentActivityEvent`, the union), the per-sidechain trackers in `live-chat.ts`/`chat-fold.ts`, the announce in `chats.ts` and the throttled `subagent.activity` in `event-sources.ts`, `toChatSubagent`, the `/events` description, schemas regenerated, tests | — | `packages/shared/src/types.ts` (the `ChatSubagent` and the events regions only), `packages/core/src/live-chat.ts`, `chat-fold.ts`, `chat-branches.ts`, `chats.ts`, `event-sources.ts`, `packages/core/test/**`, `apps/api/src/openapi/routes.ts` (the `/events` description), `apps/api/src/openapi/schemas*` | `pnpm typecheck`, core + api tests, schema drift |
| `w1` | **Tool lenses** (3.2): `packages/chat-ui/src/lib/tool-lens.ts` (pure model), `components/ToolBody.tsx` (the frame, the lenses, `Raw`), `CallRow` and the bare `tool_result` case use it, `StepCall.result.detail`, the `Diff` slot in `context.tsx` and its provider in `apps/web`, `transcript.css`, i18n en/es, the class fixture regenerated, tests | `c1`, `d1` | `packages/chat-ui/src/components/Transcript.tsx` (the `CallRow`, `ResultBlock`, `Block` tool cases), `packages/chat-ui/src/components/ToolBody.tsx`, `packages/chat-ui/src/lib/tool-lens.ts`, `packages/chat-ui/src/lib/chat-steps.ts` (`StepCall`, `partsOf`, `callHint`), `packages/chat-ui/src/lib/context.tsx` (`slots.Diff`), `packages/chat-ui/src/styles/transcript.css`, `packages/chat-ui/src/locales/**`, `packages/chat-ui/test/tool-lens.test.ts`, `apps/web/src/lib/chat-ui.tsx`, `apps/web/src/components/changes/DiffSlot.tsx` (new), `apps/web/test/transcript-lenses.test.tsx`, `apps/web/test/fixtures/class-names.json` (regenerated) | `pnpm typecheck`, chat-ui + web tests, `night-shift-ui-check` |
| `w2` | **Live branches** (3.3, 3.4): `components/LiveBranches.tsx` (the strip, the `Sheet` on a phone, the storage key), `BranchCard` generalised from `LaunchCard` with exact matching by `detail`, the `subagent.activity` patch in `events.ts`, `ActivityTicker` per running subagent in `Side.tsx`'s Branches card and the subagent panel header, `ChatView.tsx` placement, `chat.css`, i18n en/es, the class fixture regenerated, tests | `c2`, `d1` | `packages/chat-ui/src/components/LiveBranches.tsx`, `packages/chat-ui/src/components/Transcript.tsx` (`LaunchCard`→`BranchCard`, `launchesOf`, the `StepView` props), `packages/chat-ui/src/lib/chat-branches.ts` (new pure model: running set, grace, nesting, counts, newest activity), `packages/chat-ui/src/styles/chat.css`, `packages/chat-ui/src/locales/**`, `apps/web/src/pages/ChatView.tsx`, `apps/web/src/pages/chat/Side.tsx`, `apps/web/src/components/DetailPanel.tsx` (the header line only), `apps/web/src/lib/events.ts`, `apps/web/test/live-branches.test.tsx`, `apps/web/test/fixtures/class-names.json` (regenerated) | `pnpm typecheck`, chat-ui + web tests, `night-shift-ui-check` |
| `e1` | **Fake CLI and specs** (4.3, section 5): the `agent:` and `background:` lines with `tool_use_result` and the sidechain, its README and `claude.test.mjs`; `chat-live-branches.spec.mjs`; the `chat-page.spec.mjs` addition; the `motion` and `a11y-core` additions. Run each spec alone with `pnpm e2e <name>` (as `e2e/run.mjs` documents) on an `E2E_PORT` of its own | `w1`, `w2` | `e2e/fake-cli/**`, `e2e/specs/chat-live-branches.spec.mjs`, `e2e/specs/chat-page.spec.mjs`, `e2e/specs/motion.spec.mjs`, `e2e/specs/a11y-core.spec.mjs` | the fake's own test; each touched spec green alone |
| `x1` | **Docs** (sonnet): the feature document `docs/chat-tool-rows-and-branches.md` (what a reader sees, the lenses table, the strip's rules, the protocol fields read, the storage key), the "Landed" notes in `design-system.md` where the app settled a detail differently, this plan's **Outcome** section, the `docs/status.md` row, the README's feature list line; stored with `kb_add_document` | `w1`, `w2` | `docs/chat-tool-rows-and-branches.md`, `docs/plans/tool-rows-and-live-branches.md` (Outcome only), `docs/design-system.md` (Landed only), `docs/status.md`, `README.md` (one line) | links resolve; `kb_add_document` answers with no unresolved link this plan did not intend |

Two tasks edit `packages/shared/src/types.ts` in different regions and both regenerate the schemas:
the integrator resolves the generated files by regenerating them, never by hand.

---

## 7. Decisions taken and rejected

1. **Structured results from the protocol, not reconstructed in the browser** (option B of the
   owner's choice, 2026-10-16). The CLI already writes the patch, the stderr and the agent id; a
   browser-side diff of `old_string`/`new_string` would be a guess and `MultiEdit` would be wrong.
   Rejected: a renderer-only change (option A) as the end state; it is the fallback where a transcript
   predates this CLI.
2. **`detail` carries only what the text lacks.** The result text stays the record every reader,
   search and export already use; `Read`'s content is not sent twice; `Bash`'s stdout is the text.
3. **The strip is folded by default and remembered** (owner, 2026-10-16: "minimise what is in
   progress", "optimise the chat's space"). Rejected: a strip that opens itself when something starts.
4. **No gradient on branch cards, and the workflow card loses its `grad-border`.** A chat with four
   subagents would have four gradient surfaces; the rule is two. The live rail says "running".
5. **Nested branches are shown**, indented under their owner: a glance should show everything that
   runs, and the data (`ownerId`, `fromSubagent`) is there.
6. **Both the strip and the cards.** The strip answers "what is running now" wherever the scroll is;
   the cards keep the record where the delegation happened. Rejected: cards alone (lost twenty steps
   up) and strip alone (no history in the conversation).
7. **A subagent's activity comes from its calls only.** Its text deltas are not on the stream
   (`parent_tool_use_id` events are dropped before the deltas); feeding them would mean a protocol
   change for a "writing" verb nobody needs on a subagent row.
8. **One generic lens for every MCP tool**, with `Raw` behind it, rather than lenses per server. The
   owner's servers (Pando, REA, Docs) answer in three different text shapes; the generic lens reads
   JSON, Markdown and plain text, which covers them, and a per-server lens would be code about
   servers Claudio does not ship.
9. **Lenses live in `@claudio/chat-ui`; the diff is a slot.** The package draws the conversation
   and must not import `apps/web`'s comparator; the app hands it `DiffView` the way it hands the
   client and the start options.
10. **The main agent's working line (`.chat-now`) stays.** It is the main agent; the strip is the
    branches. Two live lines when both exist, each saying a different thing.

---

## Related

[[plans/chat-experience.md]] · [[plans/ui-redesign.md]] · [[plans/changes-review.md]] ·
[[design-system.md]] · [[chat-delivery.md]] · [[providers.md]] · [[status.md]]
