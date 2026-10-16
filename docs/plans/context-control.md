---
created_at: 2026-10-15T21:00:00Z
updated_at: 2026-10-15T21:00:00Z
tags:
    - plan
    - spec
    - chat
    - context
    - compaction
    - flow
    - decision-engine
    - claudio
---
# Plan: context control — see what fills a chat, and compact it on purpose (★4)

Status: **planned** (2026-10-15). Nothing here is built. Branch `feat/claude-only`, worktree
`~/Escritorio/claudio-stage-a`.

A person sees what fills a chat's context window and can compact the conversation when it makes
sense, instead of waiting for Claude Code to do it in the middle of a task. Claudio asks the live
process for its own breakdown (the CLI's `get_context_usage` control request, already implemented in
the driver and never called), shows it in a panel with what each MCP server costs and a warning when
a chat carries too many MCP tools, and offers **Compact now**: a `/compact` turn over stream-json,
optionally focused by the person and shaped as a structured session note. Every compaction, the
person's, a typed `/compact` or the CLI's own automatic one, becomes a divider in the transcript
("Compacted · 142k → 18k") with the summary Claude Code continued from behind a fold, instead of the
15,000-character "user message" Claudio shows today. Compacting between flow stages is a decision
point, `context.compact`, that ships `off`. This plan also absorbs idea 11 of the ECC report, the
structured session note.

Idea credited to ECC ("Everything Claude Code", by Affaan Mustafa, MIT); no ECC code, prompt or hook
is copied.

## Contents

1. [Decisions](#decisions)
2. [Goals and non-goals](#goals-and-non-goals)
3. [What the code does today](#what-the-code-does-today)
4. [Facts about the CLI](#facts-about-the-cli)
5. [Design](#design)
6. [Edge cases and failure modes](#edge-cases-and-failure-modes)
7. [Security and privacy](#security-and-privacy)
8. [Performance and cost](#performance-and-cost)
9. [Telemetry and health](#telemetry-and-health)
10. [Tests](#tests)
11. [Docs to update](#docs-to-update)
12. [Task graph](#task-graph)
13. [Rollout and rollback](#rollout-and-rollback)
14. [Open questions](#open-questions)

## Decisions

The first four come from the owner's answers in [reports/ecc.md](../reports/ecc.md#decisions-2026-10-15)
and win over the sketch in §3 "★4 Context control" of that report wherever they differ. The rest
are this plan's architecture decisions; workers follow them.

| # | Decision | Why |
| --- | --- | --- |
| D1 | **Compaction is only offered to the person**: a "Compact now" action and a `compact_boundary` divider in the transcript. Claudio never sends `/compact` on its own in a chat, an orchestration or the workflow engine | Owner, decision 4. The sketch's "the lead is told to compact between phases" is dropped |
| D2 | **Compacting automatically before a flow stage is a decision point, `context.compact`, shipped `off`** (kind `act`, scope `project`). Only one boundary qualifies: a bounce that resumes the Developer's earlier work chat (`flow.ts:1430`), because every other stage starts a fresh chat | Owner, decision 4; the code: `resumeChatId` is non-null only for `stage === 'work'` |
| D3 | Order ★4 first, one line of credit, nothing in the README about ECC | Owner, decisions 6 and 7 |
| D4 | The one rule holds as follows: the breakdown is the control request `get_context_usage`; compaction is the slash command `/compact` sent as a user turn over stream-json; compaction is seen through the stream's `system/status` and `system/compact_boundary` events and the lines the CLI writes to its JSONL transcript. **No hook is installed** (no `PreCompact`), no SDK, no HTTP call to Anthropic, no terminal | CONTRIBUTING "The one rule"; README `How it talks to Claude` (`README.md:191`). Guard hooks are ★3's plan, not this one |
| D5 | Every fact about the CLI that the code depends on comes from a recording committed under `packages/core/test/fixtures/` (task x0). The schema strings in the shipped binary and the one local transcript cited below are leads, not contracts | CONTRIBUTING (trackers' rule, applied to Claude Code too); `driver-reads.test.ts:76` today tests an invented shape `{ totalTokens, maxTokens }` |
| D6 | Persistence: compactions and session notes are **SQLite rows** (two new tables, one migration appended at the end of `MIGRATIONS`, `db.ts:60`). No new JSON document: the decision point's mode lives in the existing `decisions.json` / `project.json` | CONTRIBUTING "Persistence"; they accumulate per chat and two processes share the data directory |
| D7 | One open housekeeping turn per chat (a compaction or a requested note), held by a unique partial index and claimed under `BEGIN IMMEDIATE`, with a lease so a crashed process cannot hold it forever | The pattern of `provider_moves_open` (`db.ts`, migration for phase 4) and `flow.ts:2004` |
| D8 | A compaction turn and a note turn are **housekeeping turns**: their `result` never reaches the listeners that act on a chat's result (`index.ts:1009-1013`): work links, flow, assistant. Nor do they count as a turn lost to a limit (no replay, `chats.ts:1396`) | `work-links.ts:426` moves a "Work on it" item to `in_review` on any successful result; `flow.ts` would end a running run on it |
| D9 | The session note is **the compaction summary itself**, shaped by fixed English instructions appended to `/compact`; it costs no extra turn. A separate "Write a session note" (no compaction) is a paid turn the person asks for. A note is never handed to a run automatically; copying it into the project journal is a person's click with a preview | ECC §5 lesson (mined text is untrusted; memory-poisoning chain); `journal.ts:37` caps the handoff at 16 KiB and hands it to every run |
| D10 | The breakdown is read with `detail: 'summary'` by default (local estimate, no extra calls) and `'full'` only on the person's "Count exactly", and only while the chat is idle | The shipped schema describes `full` as counting each category with the token-count API |
| D11 | Category names stay the CLI's: math uses `kind`, never the English name; the UI translates the names it knows through a key table and shows an unknown one in mono, untranslated | The shipped schema says "Classify on this, never on the English name"; precedent: the composer shows the CLI's own MCP status word untranslated (`design-system.md` "The box and its + menu") |
| D12 | A chat's token can read the breakdown, compactions and notes, and can do nothing else here: compacting, requesting a note, deleting a note are refused with 403 | Decision D1 ("offered to the person"); precedent `CHAT_FORBIDDEN_*` sets in `apps/api/src/security.ts:162` |

## Goals and non-goals

**Goals**

- G1. From any chat with a live process, see the context window as Claude Code counts it: total and
  window, each category, memory files, agents, skills, messages, and the tokens per MCP server.
- G2. Warn, in words and an icon, when a chat loads more than 80 MCP tools into the window or MCP
  takes more than 20 % of it, and let the person switch servers off from the same place.
- G3. "Compact now" on an idle chat (live or resumable), with an optional focus line and the
  structured-note shape on by default; a confirmation that says it is a paid turn.
- G4. Every compaction (button, typed `/compact`, the CLI's automatic one) is a divider in the
  transcript, live and on reload, with the before and after tokens and the summary behind a fold;
  the meter drops at once, not at the next response.
- G5. Session notes per chat: kept as rows, listed in the inspector, copyable, deletable, and
  addable to the project journal by a person's click.
- G6. The flow point `context.compact`, `off` by default, with shadow accuracy like every other
  point.

**Non-goals**

- No automatic compaction anywhere else: not in chats, orchestration workers, fixers, the workflow
  engine's lead, the assistant or the supervisor (D1).
- No `PreCompact` / `PostCompact` hook of Claudio's (D4). The person's own hooks keep working; the
  settings editor already lists them (`apps/web/src/pages/config/settingsModel.ts:81`).
- No note written automatically at a usage limit or when an orchestration task gives up (idea 11's
  other triggers): see [Open questions](#open-questions).
- No change to how the CLI decides to auto-compact (`/autocompact`, `DISABLE_COMPACT`): Claudio
  shows the threshold the CLI reports and does not set it.
- No change to `CONTEXT_WARN` / `CONTEXT_FULL` (`types.ts:548-549`) in this plan: see
  [Open questions](#open-questions).
- No rewind UI. The API's `resumeSessionAt` keeps working; its behaviour across a boundary is
  recorded (F16) and documented.
- No tool in Claudio's own MCP server (`packages/mcp`) for any of this: an agent never compacts a
  chat (D1, D12).

## What the code does today

Verified on `feat/claude-only` on 2026-10-15.

| Where | What it does |
| --- | --- |
| `packages/core/src/providers/claude-code/driver.ts:77-79` | `contextUsage()` sends `{ subtype: 'get_context_usage' }` and returns the raw answer. **Nothing calls it** (`git grep contextUsage` finds only the driver, the interface and one test) |
| `packages/core/src/providers/driver.ts:164-165` | `DriverSession.contextUsage?()`: optional, "between turns" |
| `packages/core/src/providers/claude-code/control.ts:5` | `CONTROL_TIMEOUT_MS = 15_000`; a timeout rejects with a plain `Error` ("did not answer … in time"), which the API's handler would map to 400 (`apps/api/src/app.ts:129`) |
| `packages/core/test/driver-reads.test.ts:76-93` | Tests `contextUsage` against an invented answer `{ totalTokens: 1234, maxTokens: 200000 }` |
| `packages/core/src/providers/claude-code/stream.ts:140-143` | A `system/status` event with a `permissionMode` becomes `mode-changed` and **returns**: a compaction status that carried the mode would be swallowed |
| `stream.ts:264` | Every other event, `compact_boundary` included, is dropped ("Any other protocol event is one Claudio has no use for") |
| `packages/shared/src/normalize.ts:68-90` | `normalizeMessage` skips only `isMeta` lines: the CLI's post-compaction summary (`isCompactSummary: true`, a `user` line) is read as **a message the person typed**. In the local transcript cited in F7 it is 15,318 characters long |
| `packages/core/src/usage.ts:138` | `UsageFold.context()` is the last main response's `input + cache`, so a compaction shows only at the next response (`context-cost.test.ts:78`) |
| `packages/core/src/chat-model.ts:257-263` | Health signal `context` at ≥ 80 % (`warn`) and ≥ 92 % (`bad`), worded "Claude Code compacts the conversation when it fills" |
| `packages/chat-ui/src/components/ChatBadges.tsx:135` | `ContextMeter` is exported but no screen renders it; the chat page uses `ContextGauge` (`apps/web/src/pages/chat/Side.tsx:130`) inside `UsageCard` (`Side.tsx:50`), and lists use `ContextBar` / `ContextRing` |
| `packages/chat-ui/src/composer/ComposerMenu.tsx:115` | `LiveServers`: the live process's MCP servers with a `Switch` each (`GET`/`PUT /chats/:id/mcp`, `chats.ts:942-960`) |
| `packages/chat-ui/src/lib/chat-notice.ts:11` | Notices (`task`, `reminder`, `command`, `output`, `interrupt`) are read out of `user` text; a typed `/compact` already shows as a `command` notice |
| `packages/core/src/index.ts:1009-1013` | Every `chat-result` goes to `workLinks`, `flow` and `assistant` |
| `packages/core/src/work-links.ts:426-437` | A successful result moves a "Work on it" item to `in_review` |
| `packages/core/src/index.ts:2048-2112` | `launchFlowRun`: a bounce resumes the Developer's chat with `keepAlive: false` and the run's `--json-schema`; `onStart` ties the chat to the run **before** the resume |
| `packages/core/src/decisions/points.ts:106`, `settings.ts:22` | The catalogue and the id list; `parsePoints` (`settings.ts:136`) throws on an unknown id in `decisions.json` |
| `e2e/fake-cli/claude:181` | The e2e fake already lists `compact` in `slash_commands`, and answers any unknown control request with an error (`:572`) |

## Facts about the CLI

Status words: **recorded** (a capture exists, cited), **shipped schema** (read from the message and
control schemas bundled in the installed CLI 2.1.300, `~/.local/share/claude/versions/2.1.300`;
leads only, D5), **unknown** (nothing seen). Task x0 turns every row into a recording, or into a
written "not reproducible" with the reason. Fields marked `@internal` in the shipped schema are never
read by Claudio.

| # | Fact | Status | What x0 captures |
| --- | --- | --- | --- |
| F1 | Request: `{ subtype: 'get_context_usage', detail?: 'summary' \| 'full' }`, `full` by default. `full` "counts each category with the token-count API"; `summary` "answers from the last response's usage and local estimates" | shipped schema | Both answers on a chat with two MCP servers and a CLAUDE.md, the time each takes, and whether an unknown `detail` value is refused |
| F2 | Response: `categories[{ name, tokens, color, isDeferred?, kind }]`, `totalTokens`, `maxTokens`, `rawMaxTokens`, `percentage`, `gridRows`, `model`, `memoryFiles[{ path, type, tokens }]`, `mcpTools[{ name, serverName, tokens, isLoaded? }]`, `deferredBuiltinTools?`, `systemTools?`, `systemPromptSections?`, `agents[{ agentType, source, tokens }]`, `slashCommands?{ totalCommands, includedCommands, tokens }`, `skills?{ totalSkills, includedSkills, tokens, skillFrontmatter[] }`, `autoCompactThreshold?`, `isAutoCompactEnabled`, `messageBreakdown?{ toolCallTokens, toolResultTokens, attachmentTokens, assistantMessageTokens, userMessageTokens, redirectedContextTokens, unattributedTokens, toolCallsByType[], attachmentsByType[] }`, `apiUsage` (nullable) | shipped schema | The full answer, scrubbed, as `context-usage-full.json` and `context-usage-summary.json` |
| F3 | `kind` is one of `used`, `free`, `buffer` (the compaction reserve), `deferred` (tool schemas out of the window, "excluded from usage math"); rows may carry zero tokens | shipped schema | The category `name`s the CLI uses today, for the key table (D11) |
| F4 | An unknown control subtype is answered `{ subtype: 'error', error: 'Unsupported control request subtype: <x>' }` | the core fake mirrors it (`fake-claude-control.mjs:182`); real CLI unknown | The real answer to an invented subtype, so "this CLI lacks it" can be told from other errors |
| F5 | Live event: `{ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual' \| 'auto', pre_tokens, post_tokens?, duration_ms?, preserved_segment?, … }, uuid, session_id }` | shipped schema | The stdout of a `/compact` turn, line by line, as `replay/compact-manual.jsonl` and `replay/compact-focus.jsonl` |
| F6 | JSONL line: `{ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', level: 'info', parentUuid: null, logicalParentUuid, compactMetadata: { trigger, preTokens, postTokens, cumulativeDroppedTokens, durationMs, preCompactDiscoveredTools, preservedSegment, preservedMessages }, uuid, timestamp, sessionId, version }`. Field names are **camelCase** in the file and **snake_case** on stdout | **recorded**: `~/.claude/projects/-home-yeyo-Escritorio-claude-wrapper/84af1508-….jsonl` line 6426, CLI 2.1.286, `entrypoint: sdk-cli`, `trigger: auto`, 967,248 → 7,587 tokens in 50 s | A scrubbed copy of a manual and an automatic boundary into `recordings/claude/compacted.jsonl` |
| F7 | After the boundary the file holds `attachment` lines (`instructions`, `session_context`, `date`, `file`…, `compact_file_reference`) and then one `user` line with `isCompactSummary: true`, `isVisibleInTranscriptOnly: true` and a string content that starts "This session is being continued from a previous conversation…" | **recorded**: same file, lines 6427-6434; the summary is 15,318 characters | The same, scrubbed (the summary text replaced by a placeholder of similar length) |
| F8 | Status event: `{ type: 'system', subtype: 'status', status: 'compacting' \| 'requesting' \| null, permissionMode?, compact_result?: 'success' \| 'failed', compact_error?, uuid, session_id }` | shipped schema; the core fake already sends `status: null` with `permissionMode` (`fake-claude-control.mjs:178`) | The order of `status` events around a compaction, whether they carry `permissionMode`, and a `failed` one (F13) |
| F9 | `/compact` is a local command with `supportsNonInteractive: true`, an optional argument "custom summarization instructions", disabled when `DISABLE_COMPACT` is set | shipped CLI command table | Whether `init.slash_commands` lists `compact`, and lists it no longer under `DISABLE_COMPACT=1`; what `/compact` answers then; whether a multi-line argument reaches the summariser whole |
| F10 | While compacting the CLI emits `status: 'compacting'` on a timer | shipped code (a `setInterval` emitting `sdk_status: compacting`) | The interval, so the health signal "silent while working" (3 min) cannot fire during a long compaction |
| F11 | Whether the `isCompactSummary` user line is also streamed on stdout during a live compaction, and with which flags (`isReplay`?) | unknown | Present or absent in the stream of F5 |
| F12 | Whether a `/compact` turn ends with a `result`, and whether its `total_cost_usd` and `modelUsage` include the summarising call; what `result.result` says | unknown | The `result` line of F5 |
| F13 | `/compact` on a session with no messages, and any other failure path | unknown | The stream, to fix the `failed` fixture `replay/compact-failed.jsonl` |
| F14 | `interrupt` during a compaction | unknown | Stream and transcript: is the session left uncompacted? |
| F15 | A user message written to stdin while compacting | unknown | Is it queued (`queued_command`) and read after the compaction, or refused? |
| F16 | `--resume-session-at <uuid>` where the uuid is before the latest boundary | unknown | Does the CLI continue from the full history before it, refuse, or something else |
| F17 | `--fork-session` of a compacted session | unknown | Does the fork's transcript carry the boundary and the summary; what does its first `get_context_usage` say |
| F18 | `get_context_usage` while a turn is running | unknown | Answered or held until the turn ends; latency of `summary` and `full` with ~100k tokens in context |
| F19 | Documentation status: `SDKCompactBoundaryMessage`, the `compacting` status and the context-usage control request in the published TypeScript types of `@anthropic-ai/claude-agent-sdk`, and `/compact` in the SDK's "slash commands" page | to verify | The type names and doc URLs, written into `c0-NOTES.md`; if any surface is not documented, x0 stops and says so (the one rule) |
| F20 | An automatic compaction during a live turn: the turn goes on and its `result` is the real one | partly recorded (F6, from the file) | Opportunistic only: the code must handle it without a live capture, from the JSONL shape |

## Design

### Overview

```text
person ──"Compact now"──▶ POST /chats/:id/compact ──▶ ChatService.compact
                                                     ├─ refuse (409 + code) ─────────────▶ UI says why
                                                     └─ claim row (BEGIN IMMEDIATE) ──▶ live idle?  write "/compact <args>" (purpose: compact)
                                                                                         resumable? resume with prompt "/compact <args>"
CLI stdout ──▶ ClaudeStream ──▶ status:compacting ─▶ activity "compacting", row → running
                              ├─ compact_boundary ─▶ entry {compaction: boundary} → transcript divider, row → done (pre/post tokens)
                              ├─ user isCompactSummary ─▶ entry {compaction: summary} → divider's fold; note captured when structured
                              ├─ status compact_result:failed ─▶ row → failed, notice in the stream
                              └─ result (purpose: compact) ─▶ cost on the row; NOT fanned out to work links / flow / assistant
```

### Data model

#### Shared types (`packages/shared/src/types.ts`)

New section "Context control (docs/plans/context-control.md)", placed after `ChatContext`
(`types.ts:552`). Comments explain why, as the file does.

```ts
/** A share of the window above which a chat's MCP servers deserve a look (G2) */
export const MCP_SHARE_WARN = 0.2;
/** More MCP tools than this in the window, and the model's choice of tool gets worse (ECC's rule of thumb) */
export const MCP_TOOLS_WARN = 80;
/** The person's focus line for a compaction: one or two sentences, never a document */
export const COMPACT_FOCUS_MAX = 500;
/** The flow's code-side gate for `context.compact`: below this share nothing is asked */
export const FLOW_COMPACT_MIN_SHARE = 0.6;

/** How the CLI classifies a row of its breakdown; math uses this, never the row's English name */
export type ContextCategoryKind = 'used' | 'free' | 'buffer' | 'deferred';

/** The names Claudio knows how to translate; anything else is shown as the CLI wrote it */
export type ContextCategoryKey =
  | 'system-prompt' | 'system-tools' | 'mcp-tools' | 'custom-agents' | 'memory-files'
  | 'skills' | 'slash-commands' | 'messages' | 'free-space' | 'autocompact-buffer';
// The final list comes from x0's recording (F3); a name not recorded is not keyed.

export interface ContextCategory {
  /** The CLI's own label */
  name: string;
  key: ContextCategoryKey | null;
  kind: ContextCategoryKind;
  tokens: number;
}

export interface ContextMcpServerWeight {
  /** `serverName` as the CLI reports it, which is what `PUT /chats/:id/mcp/:name` takes */
  server: string;
  tools: number;
  /** Tools whose schema sits in the window now; a deferred tool costs nothing until it is loaded */
  loadedTools: number;
  tokens: number;
}

export type ContextMcpWarning = 'many-tools' | 'large-share';

export interface ContextBreakdown {
  model: string;
  totalTokens: number;
  /** What the share is measured against: the CLI's compaction window, which can be smaller than the model's */
  rawMaxTokens: number;
  maxTokens: number;
  /** As the CLI rounds it; may pass 100 */
  percentage: number;
  autoCompact: { enabled: boolean; thresholdTokens: number | null };
  /** `totalTokens - rawMaxTokens` when positive, else null */
  overBy: number | null;
  /** Rows with zero tokens are dropped here, as the CLI's own renderer does */
  categories: ContextCategory[];
  /** Per server, most tokens first; never per tool, which can be hundreds of rows */
  mcp: { servers: ContextMcpServerWeight[]; loadedTools: number; tokens: number; share: number; warnings: ContextMcpWarning[] };
  memoryFiles: Array<{ path: string; type: string; tokens: number }>;
  agents: Array<{ name: string; source: string; tokens: number }>;
  skills: { total: number; included: number; tokens: number } | null;
  slashCommands: { total: number; included: number; tokens: number } | null;
  messages: { toolCalls: number; toolResults: number; attachments: number; assistant: number; user: number; other: number } | null;
}

export type ContextDetail = 'summary' | 'full';
/** Why there is no breakdown; the transcript's snapshot is still there */
export type ContextUnreported = 'no-process' | 'unsupported' | 'timeout' | 'refused';

/** `GET /chats/:id/context` */
export interface ChatContextUsage {
  /** A process of this Claudio runs the chat */
  live: boolean;
  unreported: ContextUnreported | null;
  detail: ContextDetail | null;
  observedAt: string;
  /** From the transcript, always: what the meters show */
  snapshot: ChatContext | null;
  breakdown: ContextBreakdown | null;
}

export type CompactionOrigin = 'person' | 'typed' | 'flow' | 'cli';
export type CompactionState = 'requested' | 'running' | 'done' | 'failed' | 'cancelled';
export type CompactionFailure = 'cli' | 'interrupted' | 'stopped' | 'process-ended' | 'limit' | 'budget' | 'lost' | 'not-started';

export interface ChatCompaction {
  id: string;
  chatId: string;
  origin: CompactionOrigin;
  state: CompactionState;
  /** The CLI's word, once its boundary is seen */
  trigger: 'manual' | 'auto' | null;
  /** The person's words, as written */
  focus: string | null;
  /** The summary was asked for in the session-note shape */
  structuredNote: boolean;
  flowRunId: string | null;
  preTokens: number | null;
  postTokens: number | null;
  durationMs: number | null;
  /** What the CLI reported for the turn; null when it reported none (never estimated) */
  costUsd: number | null;
  failure: CompactionFailure | null;
  /** The CLI's text for a failure, or Claudio's for one the CLI did not explain */
  error: string | null;
  boundaryUuid: string | null;
  noteId: string | null;
  requestedAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

/** `POST /chats/:id/compact` */
export interface CompactChatRequest {
  focus?: string;
  /** Defaults to true */
  structuredNote?: boolean;
}

/** Why Compact now is not offered; the same codes the 409 carries as `code` */
export type CompactRefusal =
  | 'busy' | 'waiting' | 'open' | 'read-only' | 'housekeeping' | 'at-limit' | 'run' | 'unsupported' | 'no-history';

export interface ChatCompactAvailability {
  available: boolean;
  refusal: CompactRefusal | null;
  /** The open compaction or note turn, while there is one */
  open: ChatCompaction | null;
}

/** A compaction as the transcript records it: the CLI's marker, or the summary it continued from */
export interface TranscriptCompaction {
  part: 'boundary' | 'summary';
  trigger: 'manual' | 'auto' | null;
  preTokens: number | null;
  postTokens: number | null;
  durationMs: number | null;
}

export type SessionNoteSection = 'goal' | 'done' | 'failed' | 'not-tried' | 'files' | 'next';
export type ChatNoteSource = 'compaction' | 'agent' | 'summary';
export type ChatNoteState = 'pending' | 'ready' | 'failed';

export interface ChatSessionNote {
  id: string;
  chatId: string;
  /** `compaction`: kept from a structured compaction; `agent`: asked for with no compaction; `summary`: a person saved a summary */
  source: ChatNoteSource;
  state: ChatNoteState;
  /** Markdown, as Claude wrote it; null while pending */
  text: string | null;
  /** The headings it was asked for, when they were all found; null otherwise */
  sections: Partial<Record<SessionNoteSection, string>> | null;
  compactionId: string | null;
  /** The transcript entry it came from */
  entryUuid: string | null;
  error: string | null;
  createdAt: string;
  readyAt: string | null;
}

/** `POST /chats/:id/notes` */
export type CreateChatNoteRequest = { from: 'agent' } | { from: 'summary'; entryUuid: string };
```

Changes to existing types:

| Type | Change | Consumers to check |
| --- | --- | --- |
| `TranscriptEntry` (`:237`) | `compaction?: TranscriptCompaction`. A boundary entry has `role: 'user'`, `blocks: []`; a summary entry has `role: 'user'` and one text block | every `entry.role === 'user'` reader: `sessions.ts:77` (first prompt), `sessions.ts:75` (`messageCount`), `chat-export.ts`, `Transcript.tsx:174` (`readEntry`), `search.ts:27`, `agents.ts:70`, `edit-steps.ts`, `chat-branches`; x1 audits with `timeout 30 git grep -n "role === 'user'"` |
| `ChatContext` (`:552`) | `compactedSince?: { at: string; trigger: 'manual' \| 'auto'; preTokens: number; postTokens: number \| null }`, set only while the newest boundary is later than the last main response | `contextShare` (`chat-ui/src/lib/chat-model.ts:6`) uses `postTokens` when it is set; health (`chat-model.ts:257`) the same |
| `ChatActivity.kind` (`:860`) | adds `'compacting'` | `apps/web/src/lib/shell-live.ts:43`, `packages/ui/src/lib/live.ts:58` (`activityVerb`), `chat-ui/src/lib/chat-live.ts:42` |
| `Chat` (`:888`) | `compact?: ChatCompactAvailability` | `ChatSummary` (`:982`) adds `'compact'` to its `Omit`: the list does not pay for the flow lookup |
| `DecisionPointId` (`:6916`) | adds `'context.compact'` | `settings.ts:22`, `points.ts`, `resolve.ts`, `DecisionsTab.tsx:49` and `:81` |
| `RunEvent` (`:388`) | no new kind: a failed compaction is a `notice` with `data: { code: 'compaction.failed', failure, error }`, which is "Claudio's own words" by its own comment | `chat-ui` notice rendering |

#### Transcript normalisation (`packages/shared/src/normalize.ts`)

- `normalizeMessage` maps `{ type: 'system', subtype: 'compact_boundary' }` (both the stdout shape,
  `compact_metadata` snake_case, and the file shape, `compactMetadata` camelCase, F5/F6) to an entry
  with `compaction.part = 'boundary'`, `blocks: []`, the line's `uuid` and `timestamp`.
- A `user` line with `isCompactSummary: true` becomes an entry with `compaction.part = 'summary'` and
  its text block, never a plain person's message. `isVisibleInTranscriptOnly` alone changes nothing.
- `entrySearchText` (`search.ts`): a boundary has no text; a summary is searchable.
- Indices: the boundary becomes an entry, so `from` / `total` of transcript pages count it. Every
  reader uses `normalizeMessage`, and the caches are in memory (`jsonl-cache.ts`), so they agree after
  a restart; no persisted index needs a version bump (`chat_entries` holds only non-Claude providers).

#### SQLite (`packages/core/src/db.ts`)

One migration, appended **after the last entry** of `MIGRATIONS` (today
`ALTER TABLE provider_limits ADD COLUMN overage TEXT;`), with a comment saying why, and an exported
`CONTEXT_CONTROL_SCHEMA_VERSION` found by `findIndex` as the others are (`db.ts:814-840`).

```sql
-- Context control (docs/plans/context-control.md). One row per compaction Claudio saw or asked for;
-- the unique partial index holds one open housekeeping turn per chat across the processes sharing
-- the data directory, and lease_until frees it if the process that claimed it died.
CREATE TABLE chat_compactions (
  id            TEXT PRIMARY KEY,
  chat_id       TEXT NOT NULL,
  origin        TEXT NOT NULL,
  state         TEXT NOT NULL,
  trigger_kind  TEXT,
  focus         TEXT,
  structured    INTEGER NOT NULL DEFAULT 1,
  flow_run_id   TEXT,
  requested_by  TEXT,
  boundary_uuid TEXT,
  pre_tokens    INTEGER,
  post_tokens   INTEGER,
  duration_ms   INTEGER,
  cost_usd      REAL,
  failure       TEXT,
  error         TEXT,
  note_id       TEXT,
  requested_at  TEXT NOT NULL,
  started_at    TEXT,
  ended_at      TEXT,
  lease_until   TEXT NOT NULL
);
CREATE INDEX chat_compactions_chat ON chat_compactions (chat_id, requested_at);
CREATE UNIQUE INDEX chat_compactions_open ON chat_compactions (chat_id) WHERE state IN ('requested', 'running');
CREATE UNIQUE INDEX chat_compactions_boundary ON chat_compactions (boundary_uuid) WHERE boundary_uuid IS NOT NULL;
CREATE TABLE chat_notes (
  id            TEXT PRIMARY KEY,
  chat_id       TEXT NOT NULL,
  source        TEXT NOT NULL,
  state         TEXT NOT NULL,
  text          TEXT,
  sections      TEXT,
  compaction_id TEXT,
  entry_uuid    TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL,
  ready_at      TEXT,
  lease_until   TEXT
);
CREATE INDEX chat_notes_chat ON chat_notes (chat_id, created_at);
CREATE UNIQUE INDEX chat_notes_pending ON chat_notes (chat_id) WHERE state = 'pending';
CREATE UNIQUE INDEX chat_notes_entry ON chat_notes (chat_id, entry_uuid) WHERE entry_uuid IS NOT NULL;
```

`trigger` is an SQL keyword, hence `trigger_kind`. `sections` is JSON of one small object, read and
written whole; the note itself is a row. Db methods (all in `db.ts`, next to `deleteChat`):

- `claimHousekeeping(chatId, row, now)`: one `BEGIN IMMEDIATE` transaction that closes the chat's
  open compaction or pending note whose `lease_until` has passed (`failed`, `lost`), refuses when
  another open one remains (returns null → refusal `open`), and inserts the new row. The unique
  indexes are the second line of defence: a `SQLITE_CONSTRAINT` is read as `open`.
- `updateCompaction(id, patch, { from: CompactionState[] })`: a guarded `UPDATE … WHERE id = ? AND
  state IN (…)`; returns whether it changed a row, so two events racing cannot both close it.
- `compactions(chatId, limit = 50)`, `openCompaction(chatId)`, `compactionByBoundary(uuid)`.
- `insertNote`, `updateNote` (guarded the same way), `notes(chatId, limit = 50)`, `deleteNote(chatId, id)`.
- `deleteChat` (`db.ts:1297`) also deletes the chat's `chat_compactions` and `chat_notes` rows in the
  same transaction.
- `sweepHousekeeping(now)`: at boot, closes rows whose lease has passed as `failed` / `lost`. A row
  still inside its lease may belong to the other process and is left alone.

Leases: `COMPACTION_LEASE_MS = 15 * 60_000` from `requested_at`, refreshed on every
`status: compacting` (F10) so a long compaction is not taken for a lost one.

No JSON document changes, except that `decisions.json` and `project.json` may now carry
`points['context.compact']` through the existing parsers.

### Core

#### The stream (`packages/core/src/providers/claude-code/stream.ts`)

- `system/status`: read `status`, `compact_result` and `compact_error` **before** the
  `permissionMode` branch (`:140`), and emit `mode-changed` only when `permissionMode` is present, so a
  compaction status that carries the mode is no longer swallowed:
  - `status: 'compacting'` → `{ kind: 'compacting', active: true }`;
  - `status: null` (or `'requesting'`) after compacting → `{ kind: 'compacting', active: false }`;
  - `compact_result: 'failed'` → `{ kind: 'compact-failed', error: compact_error ?? null }`.
- `system/compact_boundary` → `{ kind: 'compacted', entry, uuid, trigger, preTokens, postTokens,
  durationMs, run: { kind: 'message', entry } }`, where `entry` comes from `normalizeMessage`, so the
  live stream and the file give the same entry.
- The summary `user` line (if F11 says it is streamed) already flows through the `message` branch
  (`:163`) and arrives with `compaction.part = 'summary'`.
- New `DriverEvent` kinds in `packages/core/src/providers/driver.ts` (`:262-322`): `compacting`,
  `compacted`, `compact-failed`.

#### The driver

- `contextUsage(detail?: ContextDetail)` on `DriverSession` (`driver.ts:164`) and in the Claude
  session (`claude-code/driver.ts:77`): sends `{ subtype: 'get_context_usage', detail }` only when
  `detail` is given.
- New pure module `packages/core/src/providers/claude-code/context-usage.ts`:
  `parseContextUsage(raw: Record<string, unknown>): ContextBreakdown`, tolerant of missing optional
  fields, dropping zero rows, keying names from a table built from x0's recording, aggregating
  `mcpTools` per `serverName` (counting `isLoaded !== false` as loaded and excluding `deferred` rows
  from `share`), and setting `warnings` from `MCP_TOOLS_WARN` and `MCP_SHARE_WARN`. A value of the
  wrong type is read as absent, never thrown.
- `control.ts:19`: the comment lists `get_context_usage` already; nothing else changes in the channel.

#### The runtime (`packages/core/src/chats.ts`) and the service (`chat-service.ts`)

- **Housekeeping turns.** The live chat gains `purpose: 'compact' | 'note' | null` for the turn it
  runs. `sendMessage` (`chats.ts:763`) takes an optional `purpose`; `spawnProcess` for a resume passes
  it to the first turn. The purpose clears on the turn's `result`, on interrupt, and on exit.
  - `RunResult` gains `purpose?: 'compact' | 'note'`. The `chat-result` listeners in `index.ts:1009`
    return early when it is set (D8). The stream's `result` event still reaches the page and the
    execution's turns and cost, which are real.
  - The limit replay (`chats.ts:1396`, `:1420`, `:1444`) skips a housekeeping turn: a compaction lost
    to a limit fails with `limit` and is not replayed on another account.
  - A person typing `/compact` (text matching `^/compact(\s|$)`) into an **idle** chat goes through
    the same path with origin `typed`; typed while the chat works, it is an ordinary queued message
    (F15 decides what the CLI does with it) and only the boundary, if any, is recorded.
- **Activity.** `ChatActivityTracker` (`packages/core/src/chat-activity.ts:100`) gains
  `compacting(active, at)`; while it is set the activity is `{ kind: 'compacting', since }`, beaten
  only by a permission prompt.
- **New module `packages/core/src/context-control.ts`**, class `ContextControl`, constructed in
  `index.ts` next to the chat service, with deps `{ db, runtime, chats, flowOwns(chatId),
  assistantOwns(chatId), notes, emit }`:
  - `usage(chatId, detail)`: no live process → `{ live: false, unreported: 'no-process', snapshot }`.
    Otherwise calls `session.contextUsage(detail)`. Answers in the error text of F4 → `unsupported`;
    the channel's timeout → `timeout`; any other CLI error → `refused`. One request in flight per chat
    and detail (single flight), and an answer reused for `CONTEXT_USAGE_CACHE_MS = 5_000` so several
    tabs do not each ask. `full` while the chat works is downgraded to `summary` (D10) and says so in
    `detail`.
  - `availability(chat)`: the first refusal that applies, in this order: `housekeeping` (origin
    `internal`), `read-only` (`control.mode === 'readOnly'`), `no-history` (no `context` and no
    message), `unsupported` (the chat's `environment.slashCommands` lacks `compact`; an environment not
    known yet does not refuse), `at-limit` (`atLimit` or an open rotation wait), `run` (a running flow
    run or assistant run owns the chat), `open` (an open housekeeping row), `waiting` (a permission
    prompt is pending), `busy` (`state === 'working'` or a turn is starting).
  - `compact(chatId, request, actor)`: validates the body (`focus` a string of at most
    `COMPACT_FOCUS_MAX` characters after trim, empty read as absent; `structuredNote` a boolean),
    refuses with `ContextRefusal` (a `409` carrying `reason`, which the API turns into `code`,
    `app.ts:129`), claims the row, then:
    - **live and idle**: `runtime.sendMessage(chatId, compactText(focus, structured), [], undefined,
      'compact')`;
    - **resumable**: `chats.resume(chatId, { prompt: compactText(…) }, { purpose: 'compact' })`, with
      the options of the chat's last execution, so a confined or assistant chat stays confined
      (`ChatService.resume`, `chat-service.ts:753`). A resume that fails closes the row `failed` /
      `not-started` and rethrows.
    - returns the row (`202`).
  - `onEvent(chatId, event)`, fed by the runtime for every driver event of a chat:
    - `compacting active` → row `running`, `started_at`, lease refreshed;
    - `compacted` → if an open row exists: `done` with the boundary's figures and uuid; if none (the
      CLI's own, or a typed `/compact` while working): insert a `done` row with origin `cli` (trigger
      `auto`) or `typed` (trigger `manual`). Emits `run.updated` so the chat's `context` and
      `compact` are read again;
    - `compact-failed` → `failed` / `cli` with the CLI's error, and a `notice` event on the chat's
      stream;
    - the housekeeping `result` → its `total_cost_usd` on the row; an error result with no boundary
      seen → `failed` with `budget` (`error_max_budget_usd`), `limit` (rate limited) or `cli`;
    - interrupt → `cancelled` / `interrupted`; stop → `cancelled` / `stopped`; process exit with the
      row still open → `failed` / `process-ended`.
  - `compactAndWait(chatId, opts)` for the flow: the same claim and resume (origin `flow`,
    `flowRunId`), resolving when the row closes or after `COMPACTION_LEASE_MS`; never rejects (the
    caller goes on uncompacted).
- **Session notes, `packages/core/src/context-notes.ts`**:
  - `SESSION_NOTE_INSTRUCTIONS`, the fixed English text appended to `/compact` when `structuredNote`
    is on, and `NOTE_REQUEST_PROMPT` for a note without compaction. Both are load-bearing, so they are
    fixed here:

    ```text
    Write the summary as a session note for whoever continues this work, in English, under exactly
    these Markdown headings and in this order: "## Goal", "## Done (with evidence)", "## Failed",
    "## Not tried yet", "## Files in flight", "## Next step". Under "Done", give the evidence for each
    item: a test that passed, a command and its result, a commit. Under "Files in flight", list every
    path changed and not committed yet. Keep every decision the person made and every constraint they
    stated. Never copy a secret, token, key or password.
    ```

    `compactText(focus, structured)` is `/compact` followed, on the same line, by the person's focus
    as written (prefixed "Keep in particular: ") and then the instructions above. Whether a newline in
    the argument is safe is F9; until x0 says so, everything is joined with single spaces.
  - `parseSessionNote(text)`: finds the six headings in order; `sections` only when all six are
    found, otherwise null and the text is kept whole.
  - `ChatNotes` service: `list`, `requestFromAgent(chatId, actor)` (a housekeeping turn with purpose
    `note`, refusals as for compaction, the turn's final text stored at its `result`, `failed` on an
    error result or exit), `fromSummary(chatId, entryUuid)` (reads the summary entry from the
    transcript, `400` when the uuid is not a summary entry of this chat, `409` when it is already
    saved), `remove`.
  - A structured compaction stores its summary entry as a `compaction` note when the summary entry is
    seen (stream, F11) or, failing that, on the next read of the transcript after the boundary.
- **Usage** (`packages/core/src/usage.ts:64`): `UsageFold.add` notes the newest boundary entry of
  the main conversation; `context()` sets `compactedSince` when it is newer than the last response.
  `chat-service.ts:417` passes it through.
- **Sessions** (`packages/core/src/sessions.ts:49`, `foldLine`): a compaction entry counts neither as
  a message nor as a prompt.
- **Export** (`packages/core/src/chat-export.ts`): Markdown renders a boundary as a line
  `— Compacted (manual) · 142,000 → 18,000 tokens —` and a summary inside `<details>`; JSON is
  unchanged (it is every raw event).

#### The flow and the decision point `context.compact`

- **Catalogue** (`packages/core/src/decisions/points.ts:106`):

  ```ts
  point({ id: 'context.compact', kind: 'act', scope: 'project', primitives: ['choice'], maxStateBytes: 1024,
          fields: ['stage', 'share', 'usedTokens', 'window', 'bounces', 'rejectionChars'] }, () => [
    choice('compact', 'A developer is about to continue its own earlier conversation after QA sent the card back. Should that conversation be compacted first?', [
      ['compact-first', 'Compact first: the context is full enough that the next round would likely be compacted mid-task anyway'],
      ['continue', 'Continue as it is: there is room, and compacting would lose detail the next round needs'],
    ]),
  ]),
  ```

  The state carries numbers only; no transcript, no item text. `DECISION_POINT_IDS`
  (`settings.ts:22`) gains the id; it is not in `GLOBAL_ONLY_POINTS`.
- **Call site** (`packages/core/src/flow.ts`, in `start`, `:1417`): after `resumeChatId` (`:1430`)
  and only when `stage === 'work' && resumeChatId && !continuing`:
  1. the code gate: the chat's snapshot share (`compactedSince.postTokens` when set) is at least
     `FLOW_COMPACT_MIN_SHARE`, the chat's environment lists `compact`, and the chat has no open
     housekeeping row;
  2. `this.stance('context.compact', projectId)`: `off` → nothing is asked; otherwise
     `this.ask('context.compact', …)` (`flow.ts:1203`);
  3. `active` with the answer `compact-first` at or above the point's threshold → the launch carries
     `compactFirst: true`; `shadow` records only.
- **Launch** (`FlowLaunch`, `flow.ts:200`, gains `compactFirst: boolean`; `index.ts:2048`): before the
  resume branch (`:2097`) and **before `onStart`**, so the run never sees the compaction's chat, result
  or exit: `await this.context.compactAndWait(chatId, { origin: 'flow', flowRunId: run.id, options })`
  where `options` are the run's own (model, permission mode, allowed and disallowed tools,
  `maxBudgetUsd`, the member's `agent`), **without** `jsonSchema`, and with `keepAlive: false`. The
  stage policy is the run's, so `git push` stays denied. A compaction that fails or times out is
  logged and the run goes on uncompacted.
- **Safety of paid automation.** The compaction runs inside the run's claimed slot (`maxParallel` is
  untouched), its process is capped with the run's own `--max-budget-usd`, bounces are counted as
  before, and the move to Done stays the person's.
- **Shadow accuracy** (`packages/core/src/decisions/resolve.ts`): a resolver for `context.compact`
  that waits for the run to end, then reads `chat_compactions` for the run's chat between its
  `started_at` and `ended_at`: an `auto` compaction during the run, or a run that failed on a context
  error, agrees with `compact-first`; a run that passed with none agrees with `continue`; anything
  else is null (unresolved).
- **Web** (`apps/web/src/pages/config/DecisionsTab.tsx`): `POINT_KEY['context.compact'] =
  'contextCompact'` and the point in the `flow` area (`:81`); its copy in `decisions.json` en/es.

### API

All routes under `/api`, tag `Chats`, a summary and description each in
`apps/api/src/openapi/routes.ts` next to `GET /chats/:id/mcp` (`:456`), a row each in the README's
chat table next to `README.md:1025`, the shared types regenerated
(`pnpm --filter @claudio/api openapi:schemas`). Handlers in `apps/api/src/routes/chats.ts` next to
`:180`.

| Method | Path | Request | Response | Errors |
| --- | --- | --- | --- | --- |
| GET | `/chats/:id/context` | query `detail=summary\|full` (default `summary`) | `200 ChatContextUsage` | `404` unknown chat; `400` bad `detail` |
| POST | `/chats/:id/compact` | `CompactChatRequest` | `202 ChatCompaction` | `404`; `400` `focus` not a string or too long, `structuredNote` not a boolean; `409` with `code` one of `CompactRefusal` and the sentence a person reads |
| GET | `/chats/:id/compactions` | — | `200 ChatCompaction[]`, newest first, at most 50 | `404` |
| GET | `/chats/:id/notes` | — | `200 ChatSessionNote[]`, newest first, at most 50 | `404` |
| POST | `/chats/:id/notes` | `CreateChatNoteRequest` | `202 ChatSessionNote` (`from: 'agent'`, pending) or `201 ChatSessionNote` (`from: 'summary'`, ready) | `404`; `400` bad body or an `entryUuid` that is not a summary of this chat; `409` a refusal code, or `saved` when that summary already is a note |
| DELETE | `/chats/:id/notes/:noteId` | — | `204` | `404` unknown chat or note (the same body for a note of another chat, as permissions do) |

Notes:

- `GET /chats/:id/context` with no live process is `200` with `live: false`: a state, not an error.
  A CLI that does not answer is `200` with `unreported`, never a `4xx` or `5xx`: the panel draws it.
- The `Chat` returned by `GET /chats/:id` carries `compact`; `ChatSummary` does not.
- "Add to journal" needs no new route: the page prefills the existing `POST /projects/:id/journal`
  (`kind: 'note'`, `itemId` when the chat is linked to one item), whose 8,000-character limit
  (`journal.ts:39`) and validation apply.

**Auth modes** (`apps/api/src/security.ts`):

| Caller | GET routes | POST compact, POST notes, DELETE note |
| --- | --- | --- |
| Owner token, OIDC, open mode (`none`) | allowed | allowed |
| Desktop app's own credential | allowed | `403` already (`security.ts:528`, reads only) |
| A chat's token (`CLAUDIO_API_TOKEN` of a chat) | allowed | `403` "a chat's token cannot compact a chat or ask it for a note: that is the person's click", from a new `CHAT_FORBIDDEN_CONTEXT` set checked like the others (`security.ts:536-584`) |
| Read-only mode | allowed | `405` already (`security.ts:594`) |
| Open mode with a chat token | allowed; the actor is labelled `chat:<id>` (`:589`) | allowed, labelled: open mode grants everything by definition |

The audit log records the three mutating routes like every other (`onResponse`, `security.ts`).

### Web

Every string through i18n with `en`/`es` parity; the `es` copy follows
`apps/web/src/i18n/GLOSSARY.md` ("el contexto", `:347`; "compactar" in prose, `/compact` literal,
`:445-449`). New glossary rows: *breakdown* → "desglose", *session note* → "nota de sesión",
*compaction* → "compactación". Tokens only, both themes, controls from
`packages/ui/src/components/controls`, motion levels respected.

#### Where things go

| Place | File | What changes |
| --- | --- | --- |
| Inspector, Summary tab, context section | `apps/web/src/pages/chat/Side.tsx:59` (`UsageCard`) | The section header gains two actions: **Desglose** (`.btn.btn-small`, opens the panel) and **Compactar ahora** (`.btn.btn-small`, neutral, never the gradient: it is paid and not what the screen is about). Disabled with a `Tooltip` saying why (`CompactRefusal` → sentence). While a compaction runs the button reads "Compactando…" with the braille spinner. After one, a quiet line under the figures: "Compactado hace 3 min · 142k → 18k" |
| The context ring | `Side.tsx:130` (`ContextGauge`) | Shares come from `contextShare`, which reads `compactedSince.postTokens`; nothing else |
| Inspector, Summary tab, new section | new `apps/web/src/pages/chat/SessionNotes.tsx`, mounted in `Inspector.tsx:168` after `UsageCard` | "Notas de sesión" (`Section`): each note a `Collapsible` with its date, source word and first line; inside, the Markdown (`RichText`, `packages/chat-ui/src/components/Transcript.tsx:43`), a `CopyButton`, **Añadir al diario** (only with a project; opens the journal composer prefilled, with `maskSecrets` applied and the 8,000-character counter) and **Eliminar** in `MoreActions`. A pending note shows the ring spinner and "Escribiendo la nota…"; a failed one the bad tag and the error. **Escribir una nota** (`.btn.btn-small`) under the list, disabled with the same refusals. Empty: one `.small.muted` sentence, no illustration (a panel beside content) |
| Breakdown panel | new `apps/web/src/pages/chat/ContextPanel.tsx` | A `Dialog` on desktop, a `Sheet` on a phone (stacked over the inspector's sheet through `modal-stack.ts`). Details below |
| Compact confirmation | new `apps/web/src/pages/chat/CompactDialog.tsx` | A `Dialog` / `Sheet`. Details below |
| Header ⋯ menu | `apps/web/src/pages/chat/Header.tsx:147` | An item **Compactar la conversación** (icon `Minimize2` or the nearest in `ICON_*`) in the `chat` group, `disabledReason` from `compact.refusal`; opens the confirmation. On a phone `MoreActions` makes it a `Sheet` row |
| Health card | `Side.tsx:297` (`HealthCard`) | For the `context` signal, a **Compactar ahora** action beside it, when `compact.available` |
| Transcript | `packages/chat-ui/src/components/Transcript.tsx` (new `CompactionDivider.tsx` beside it) | A boundary entry renders as the divider; the summary entry that follows it is folded into the divider, not drawn as a message. Details below |
| Composer live verb | `packages/ui/src/lib/live.ts:58` and `primitives.json` | `activityVerb` returns `compacting` → "Compacting" / "Compactando", with the braille spinner like every verb |
| Shell live list | `apps/web/src/lib/shell-live.ts:43` | `compacting` is a live activity |
| Client | `apps/web/src/api.ts` (next to `chatMcp`, `:532`), `apps/web/src/lib/chat-ui.tsx:23`, `packages/chat-ui/src/lib/context.tsx:47` | `chatContext(id, detail)`, `compactChat(id, body)`, `chatCompactions(id)`, `chatNotes(id)`, `createChatNote(id, body)`, `deleteChatNote(id, noteId)`; query keys under `chatKeys.chatScope` |

#### The breakdown panel

- **Head.** The model in mono; "N de M tokens" in mono, tabular; the share as a usage `.bar`
  (neutral below 60 %, warn from 60 %, bad from 75 % or over the window, design system §2 "Usage
  thresholds"), and the CLI's auto-compact threshold as a tick on the bar (new variant `.bar-mark`,
  `aria-hidden`, with the same fact in words beside it: "Claude Code compacta solo al 92 %"; "La
  compactación automática está desactivada" when the CLI says so). Over the window: the bar full, bad,
  and the words "N tokens por encima".
- **Categories.** A table (`caption` for screen readers): name (translated by `key`, else the CLI's
  name in mono), tokens, share. `free` and `buffer` rows last and muted; `deferred` rows in their own
  muted group "Fuera de la ventana" and outside every sum.
- **MCP.** One row per server, most tokens first: the name, loaded tools / tools and tokens in mono,
  and the server's `Switch` when the chat is live (the same mutation and cache key as
  `ComposerMenu`'s `mcpKey`), with the sentence that the switch also applies to new chats in the
  folder (`composerMenu.serversPersist`). Warnings above the list, each a `Tag tone="warn"` with the
  triangle icon and a word: "Muchas herramientas MCP (93)", "MCP ocupa el 27 % del contexto". More
  than 12 servers: the rest behind a `Collapsible` "N servidores más".
- **Memory, agents, skills, commands, messages.** Small `kv` lists; a memory file's path in mono,
  cut in the middle with the whole path in the copy button's label.
- **Foot.** "Contado con estimación" or "Contado con exactitud" and **Contar con exactitud**
  (`detail=full`; disabled while the chat works, with the reason), and **Compactar ahora**, the panel's
  one primary action (`.btn.btn-primary`, not the gradient).
- Nothing in the panel moves; a figure that changes on refetch does not animate.

#### The compact confirmation

- Title "Compactar la conversación". One paragraph: Claude Code summarises the conversation and
  continues from the summary; the messages stay visible here, but Claude no longer sees them in full;
  it is a turn paid like any other, about the size of the context now ("unos 142k tokens").
- **Qué conservar (opcional)**: a native `textarea` (allowed by CONTRIBUTING), 16 px on touch, a
  counter to 500 in mono, the placeholder an example ("el plan y el test que falla").
- **Guardar el resumen como nota de sesión**: a `Switch`, on.
- Buttons: **Cancelar** and **Compactar** (primary). On a `409` the dialog stays and shows the
  sentence in an `ErrorBox`; on success it closes and a toast says "Compactando…".

#### The divider

- `.compaction-divider`, `role="separator"` with an `aria-label` that says the whole line: a hairline
  across the column with a centred label in Geist Mono 11, `--text-muted`: "Compactado · a mano ·
  142k → 18k tokens · 14:02" (`automático` for `auto`; "142k →" alone when the CLI gave no
  `postTokens`). No status colour (it is not a status) and no motion.
- Under it, when a summary entry follows, a `Collapsible` "Ver el resumen con el que sigue Claude"
  with the summary rendered as Markdown, and, when `structured` sections are found, the six headings
  as they are. Inside the fold, **Guardar como nota** (a `.btn.btn-small`; hidden when it is already a
  note). The divider is never a message: no message menu, no "create a task", no copy-as-message.
- A failed compaction is a `notice` row (`bad`, with the icon and the words "No se pudo compactar"
  and the CLI's error behind the fold), the existing `NoticeRow` with a new notice kind
  `compaction-failed`.
- A search hit inside a summary opens the fold.

#### States

| State | Inspector section | Panel | Header item / health action | Transcript |
| --- | --- | --- | --- | --- |
| Loading | figures from the chat as today | `Skeleton` rows | — | — |
| Chat never answered (`context: null`) | "aún sin contexto" | not offered | disabled, `no-history` | — |
| Idle, live process | both actions on | breakdown, exact count on | enabled | — |
| Working | "Desglose" on, "Compactar" disabled (`busy`) | breakdown with `summary`, exact count disabled | disabled with reason | energy border on the composer as today |
| Waiting on a permission | compact disabled (`waiting`) | breakdown | disabled | prompt as today |
| No process (resumable) | both on | snapshot only and "El desglose lo da Claude Code mientras la conversación está abierta" | enabled (compaction resumes it) | — |
| Read-only (held by a terminal, a running worker) | compact disabled with `control.reason` | snapshot or breakdown | disabled | — |
| CLI does not report (`unsupported`, `refused`) | unchanged | the snapshot and one sentence; no retry for `unsupported` | unchanged | — |
| CLI timeout | unchanged | the snapshot, the sentence and **Reintentar** | unchanged | — |
| HTTP error | unchanged | `ErrorBox` | — | — |
| CLI without `/compact` | compact disabled (`unsupported`) | compact disabled | disabled | a typed `/compact` behaves as the CLI decides |
| Compaction in progress | "Compactando…" with the braille spinner | primary action replaced by the same | disabled (`open`) | composer verb "Compactando"; dots for nothing else |
| Compaction done | "Compactado hace…" line; meter dropped | refetched once | enabled | divider and fold |
| Compaction failed | toast (bad) | — | enabled | `compaction-failed` notice |
| At a limit | compact disabled (`at-limit`) | breakdown | disabled | limit block as today |
| Flow or assistant run on the chat | compact disabled (`run`) | breakdown | disabled | — |
| Unknown window | no share, tokens only (as `ContextMeter` does) | bar without share, tokens only | as above | divider without share |
| Very large window (1M) | `formatTokens` ("967k", "1.2M") | figures in the locale's grouping (`formatNumber`), mono, tabular; shares under 1 % read "<1 %" | — | "967k → 7.6k" |
| Very small window or over it | bad bar, "por encima" | over-the-window words | — | — |
| Phone | sections stack; actions full width, 44 px | `Sheet`, rows ≥ 44 px, the table becomes a list | `MoreActions` sheet | divider wraps to two lines |
| Dark / light | tokens only | tokens only | — | `--text-muted` on both, contrast ≥ 4.5:1 |
| Motion `subtle` / `off`, reduced motion, hidden tab | the spinner holds still / stops | nothing animates | — | nothing animates |

#### Design-system additions

New variants, added to `docs/design-system.md` (§2, a subsection "Context control: the breakdown,
the compact confirmation and the divider") and to `docs/design-system/claudio-ds.css` in the same PR:
`.compaction-divider`, `.ctx-breakdown` (the panel's layout), `.bar-mark` (a threshold tick on a
usage bar). Styles go in `apps/web/src/styles/chat.css` (panel, notes) and the chat-ui transcript
stylesheet (divider), with their reduced-motion variants beside them. `apps/web/test/fixtures/class-names.json`
and `module-graph.json` gain the new classes and modules.

## Edge cases and failure modes

| # | Case | What happens | Where it is enforced |
| --- | --- | --- | --- |
| E1 | Two clicks, two tabs, two processes on one data directory | One open row per chat: the second gets `409 open` | `claimHousekeeping` under `BEGIN IMMEDIATE` + `chat_compactions_open` |
| E2 | Compact while a turn runs | Refused `busy`; the person can interrupt first | `availability` |
| E3 | A message sent during a compaction | Queued like any message sent mid-turn (`docs/chat-delivery.md`); what the CLI does with it is F15. The composer stays usable | runtime, unchanged |
| E4 | Typed `/compact` while idle | Same as the button, origin `typed`, no note unless the person asked in words | `sendMessage` text match |
| E5 | Typed `/compact` while working | Not intercepted; a boundary, if it comes, gets a `typed` row | `onEvent` |
| E6 | The CLI compacts on its own mid-turn | Divider live and on reload, a `cli` row; the turn's result is fanned out as usual (it is not housekeeping) | `onEvent`, D8 only for purposes |
| E7 | CLI version without `get_context_usage` | `unreported: 'unsupported'`; the snapshot still shows | `usage` + F4 |
| E8 | CLI version without `/compact` in `-p`, or `DISABLE_COMPACT` set | `compact` not in `slash_commands` → refusal `unsupported`; if the environment is unknown the request goes, and a CLI refusal fails the row `cli` | `availability`, F9 |
| E9 | Control request times out (15 s) | `unreported: 'timeout'`, Retry | `usage` |
| E10 | Process exits during compaction (crash, OOM, idle timeout) | Row `failed` / `process-ended`; the transcript has a boundary or not, and the page shows what the file says | `onEvent` exit |
| E11 | Claudio restarts during compaction | The process dies with it; the row's lease runs out and `sweepHousekeeping` closes it `lost` at the next boot | lease + sweep |
| E12 | Interrupt during compaction | Row `cancelled` / `interrupted`; F14 tells whether the session was compacted | `onEvent` |
| E13 | Stop during compaction | Row `cancelled` / `stopped` | `onEvent` |
| E14 | Compaction on an empty or one-message session | `no-history` refusal when there is no context; otherwise the CLI's answer (F13) fails the row `cli` | `availability`, F13 |
| E15 | Usage limit hit by the compaction turn | Row `failed` / `limit`, no replay, the chat's limit block as for any turn | D8, `chats.ts:1396` |
| E16 | Chat with `--max-budget-usd` exhausted by the compaction | Row `failed` / `budget` | `result` subtype `error_max_budget_usd` (`stream.ts:14`) |
| E17 | Chat waiting at a limit, or moved to another account by the rotation | Refused `at-limit` while waiting; after a move, the chat resumes on the new account as any resume does | `availability`; rotation unchanged |
| E18 | Resumed session | A resumable chat compacts by resuming; the boundary lands in the same session file | `ChatService.resume` |
| E19 | Fork of a compacted chat | The fork's transcript is what the CLI writes (F17); the divider shows if the boundary is there; rows stay with the source | normalise; rows keyed by chat |
| E20 | Rewind (`resumeSessionAt`) to before a boundary | Behaviour of the CLI recorded (F16) and documented in the route's description; no extra refusal unless F16 shows the CLI breaks | x0, docs |
| E21 | Flow run running on the chat | Refused `run` (flow and work links would otherwise read the compaction's result, `work-links.ts:426`) | `availability` via `flowOwns` |
| E22 | Flow bounce with `context.compact` active | Compacts before `onStart`; failure → run continues uncompacted; a restart mid-compaction leaves the run `running` with no chat, which the flow's restart path requeues or fails (`restartDecided`, `flow.ts:1954`); a requeued run asks the point again, and the gate sees the post-compaction share if the compaction landed | `launchFlowRun` |
| E23 | Orchestration worker chat | Running: read-only → refused. Ended: resumable → allowed; a later fixer resume continues the compacted session | `availability` |
| E24 | Project assistant run chat | Refused `run` while the run is `running` (`assistant_runs.status`) | `assistantOwns` |
| E25 | Claudio assistant chat (`claudioAssistant`) | Allowed; a resume re-applies its confinement (`types.ts` `ClaudioAssistantMarker`) | `ChatService.resume` |
| E26 | Housekeeping chat (origin `internal`) | Refused `housekeeping` | `availability` |
| E27 | Terminal chat held by a terminal | Read-only → refused. Not held → resumable → compaction adopts it, as a resume does (documented) | `ChatService.resume` |
| E28 | Confined chat (no setting sources) | Same as any chat; F9 records whether `/compact` is listed there | x0 |
| E29 | Huge MCP list (50 servers, 800 tools) | Aggregated per server in core; the response is per server; the page shows 12 and folds the rest | `parseContextUsage`, panel |
| E30 | Deferred MCP tools (tool search) | Count as tools, not loaded; excluded from the share and from the warning | `parseContextUsage` |
| E31 | Many tabs open on a big context | Single flight + 5 s reuse; `full` only on click and only idle | `usage` |
| E32 | `full` asked while working | Downgraded to `summary` and labelled | `usage` |
| E33 | Boundary without `post_tokens` | Divider without the after figure; the meter falls back to the next response | normalise, `compactedSince.postTokens: null` |
| E34 | The summary is not streamed (F11 absent) | The divider shows at once, the fold appears on the next transcript read; the note is captured then | `ChatNotes` |
| E35 | A summary whose headings are not all there | `sections: null`, the text kept whole | `parseSessionNote` |
| E36 | Note longer than the journal's 8,000 characters | "Añadir al diario" shows the counter and blocks saving over the limit; the person trims | journal create (`journal.ts:226`) |
| E37 | Chat deleted | Its rows go in the same transaction | `deleteChat` |
| E38 | Spanish chat | The instructions are English (records in English); the focus line stays as the person wrote it; the summary is in whatever language Claude writes (asked for English) | `context-notes.ts` |
| E39 | Numbers in Spanish | `formatNumber` / `formatTokens` follow the app language ("142.000", "1,2 M"), tabular mono | `@claudio/ui/lib/format` |
| E40 | Decision settings that name `context.compact` read by an older build | `parsePoints` throws on unknown ids (`settings.ts:141`): see Rollback | rollback step |
| E41 | `run.updated` storm while compacting | `status: compacting` heartbeats refresh the lease but emit no event; only the state changes do | `onEvent` |
| E42 | Silence health signal during a long compaction | The `compacting` activity counts as live (heartbeat F10) | health `live.lastEventAt` |

## Security and privacy

- **The one rule.** Only `get_context_usage`, `/compact` over stdin, stream events and the JSONL
  file (D4). x0 verifies each is in the published SDK types or docs (F19) before any code is merged.
- **Chat tokens** cannot compact, request a note or delete one (D12): a prompt injection inside a
  chat could otherwise spend money on every chat or wipe the notes. Reads stay open to them like
  `GET /chats/:id/mcp`. The desktop credential and read-only mode keep refusing writes as they do.
- **Notes are untrusted text.** They are model output that may carry what a web page or an MCP
  server said (ECC §5, the memory-poisoning chain). They are never handed to a run, never put in a
  prompt by Claudio, rendered through the app's sanitising Markdown, and reach the journal only by a
  person's click after a preview, where the journal's own `pasted` wrapper applies at handoff
  (`journal.ts:207`, `prompt-rules.ts:116`). The prefill runs `maskSecrets`
  (`decisions/redact.ts:71`).
- **The focus line** is the person's own words to their own agent; length-capped, stored as written,
  and only an authenticated person (not a chat token) can send it.
- **The decision point** sends numbers only (no text): the consent preview shows six figures.
- **Data at rest.** Rows live in the same data directory as the transcripts they copy; deleting a
  chat deletes them; a note can be deleted alone.
- **Paths.** The breakdown lists memory-file paths, as `chat.environment.memoryPaths` already does;
  nothing new leaves the machine except to the authenticated client.
- **Flow automation.** A flow compaction runs with the run's policy (push denied), the run's budget,
  inside the run's slot (D2, "Safety of paid automation").

## Performance and cost

- `get_context_usage` with `summary` makes no model call; `full` calls the token-count API from the
  CLI (free of charge, rate-limited by Anthropic): only on click, only idle, single flight, 5 s reuse.
- A compaction is a **paid** model call over roughly the whole context. Claudio shows only the cost
  the CLI reports for the turn (F12) on the row and the divider's tooltip, and never estimates it
  (README, "Out of reach of the CLI"). The confirmation says it is paid and how big the context is.
- The breakdown response is per server, so its size is bounded by servers, not tools.
- The divider and the fold are inside the transcript's existing virtualised list; a 15k-character
  summary is rendered only when the fold opens.
- No polling: the panel reads on open and after a compaction ends; the chat's stream drives
  everything else.

## Telemetry and health

Claudio sends no telemetry. What is kept locally:

- `chat_compactions` rows: origin, outcome, tokens, duration and cost of every compaction seen,
  which `GET /chats/:id/compactions` lists.
- The decision engine's records for `context.compact` and its shadow accuracy, in the existing
  Decisions tab.
- Server log lines (`warn`) for a failed or lost compaction and a flow compaction that fell through.
- Health: the existing `context` signal reads the post-compaction figure, so it clears as soon as
  the boundary lands; the inspector's health card offers "Compactar ahora" beside it. No new signal.

## Tests

Workers run only the unit and API tests of the packages they touch (single files with
`node scripts/test-tmp.mjs npx tsx --test <file>` from the repo root, per CONTRIBUTING), never e2e,
a Docker build or `desktop:dist`.

| Package | File | Cases |
| --- | --- | --- |
| core | `test/normalize.test.ts` | a stdout boundary and a file boundary give the same entry; a summary line is a `summary` entry, not a person's message; `isMeta` still skipped; a boundary without `post_tokens` |
| core | `test/context-usage.test.ts` (new) | the recorded `full` and `summary` answers parse; zero rows dropped; deferred excluded from share; per-server aggregation; `many-tools` at 81 loaded, not at 80; `large-share` at 20 %; unknown names unkeyed; wrong types read as absent |
| core | `test/driver-reads.test.ts` | replaces the invented shape with the recording; `detail` sent only when given; F4's error text maps to `unsupported` |
| core | `test/stream-golden.test.ts` + `fixtures/golden/stream-compact.json` | replaying `replay/compact-manual.jsonl` and `compact-failed.jsonl`: events, activity, entries, result; a status with `permissionMode` during compaction still emits `mode-changed` and the compaction event |
| core | `test/chat-compaction.test.ts` (new, with `fake-claude-control.mjs` extended from the recordings) | live idle compaction end to end; resumable compaction resumes; refusals in order; typed `/compact` idle vs working; interrupt, stop, exit, limit, budget; the result does not reach work links, flow or assistant; no limit replay; lease expiry and boot sweep; a `cli` row for an automatic boundary |
| core | `test/chat-notes.test.ts` (new) | structured summary → note with six sections; missing heading → `sections: null`; agent note pending → ready / failed; from-summary twice → `409`; delete |
| core | `test/usage.test.ts`, `test/context-cost.test.ts` | `compactedSince` set after a boundary, cleared by the next response, ignores sidechains |
| core | `test/sessions.test.ts` | a summary is never the first prompt; boundaries and summaries do not count as messages |
| core | `test/chat-activity.test.ts` | `compacting` wins over writing, loses to a permission prompt |
| core | `test/db.test.ts` | the migration applies on a fresh database and upgrades from the version before (`CONTEXT_CONTROL_SCHEMA_VERSION - 1`); two connections cannot both open a row; `deleteChat` removes rows |
| core | `test/flow.test.ts` | `context.compact` off: never asked, never compacts; shadow: asked, no compaction; active + `compact-first`: compacts before `onStart` and the run gets the real result; compaction failure → run continues; only on a bounce, never on `continuing` or other stages; share below 60 % → not asked |
| core | `test/decision-settings.test.ts`, `test/decision-points-runtime.test.ts`, `test/decision-resolve.test.ts` | the id is accepted globally and per project; the state has only the six fields; the resolver's three outcomes |
| core | `test/usage-series.test.ts` (holds the export tests today, `:145`) | divider line and `<details>` summary in `chatToMarkdown` |
| api | `test/context.test.ts` (new) | each route's success, `404`, `400`, every `409` code with its `code` field, `202` vs `201` for notes; `GET` context with no process → `live: false` |
| api | `test/security.test.ts` | chat token: GETs allowed, three writes `403`; desktop credential: writes `403`; read-only: writes `405` |
| api | OpenAPI coverage test (existing) | every new route has a summary and a tag; schemas regenerated |
| web | `test/chat-model.test.ts` | `contextShare` uses `postTokens` |
| web | `test/context-panel.test.tsx` (new) | every row of the States table that the panel owns; deferred group; warnings with words and icons; 12-server fold |
| web | `test/compact-dialog.test.tsx` (new) | counter, 500 limit, switch default on, 409 shown inline |
| web | `test/session-notes.test.tsx` (new) | pending, ready, failed, empty; Add to journal hidden without a project, prefill masked, counter |
| web | `test/compaction-divider.test.tsx` (new) | label for manual/auto, with and without post tokens, fold contains the summary, not a message row, failed notice |
| web | `test/i18n.test.ts`, `test/hardcoded-strings.test.ts`, `test/design-tokens.test.ts`, `test/class-inventory.test.ts`, `test/module-graph.test.ts` | stay green with the new keys, classes and modules |
| e2e | `e2e/fake-cli/claude.test.mjs` | the fake answers `get_context_usage` with the recorded shape, and plays `/compact` (status, boundary, summary, result) and a failing `/compact` from a script |
| e2e | `e2e/specs/context-control.spec.mjs` (new, `fakeCli = true`) | open the panel, see categories and an MCP warning; compact with a focus, see the divider and the meter drop, open the fold, find the note in the inspector; a failing compaction shows the notice and the button returns; working chat shows the disabled reason in the header menu; a resumable chat compacts; typed `/compact` gives a divider; phone width: sheets and 44 px targets |
| e2e | `e2e/specs/a11y-core.spec.mjs` | the panel and the confirmation as overlays, both themes, phone width |
| e2e | `e2e/specs/motion.spec.mjs` | the compacting spinner stops under `subtle`/`off` |

Fixtures to record (x0): `packages/core/test/fixtures/recordings/c0-NOTES.md`,
`recordings/claude/context-usage-summary.json`, `recordings/claude/context-usage-full.json`,
`recordings/claude/compacted.jsonl` (file lines), `replay/compact-manual.jsonl`,
`replay/compact-focus.jsonl`, `replay/compact-failed.jsonl`; all scrubbed (paths, emails, session
ids, summary text replaced by placeholders of similar length).

## Docs to update

| Document | Change |
| --- | --- |
| `README.md` `How it talks to Claude` (`:191`) | Rows: "Context breakdown — the `get_context_usage` control request (`detail: summary` unless asked)"; "Compaction — `/compact` sent as a user turn over stream-json; `system/status` (`compacting`) and `system/compact_boundary` events; the boundary and `isCompactSummary` lines of the transcript" |
| `README.md` REST API (`:1025`) | Six rows, one per route, in the chats table |
| `docs/context-control.md` (new) | The feature as built: what the panel shows, how compaction works, notes, the flow point, the refusals; links back here |
| `docs/slash-commands.md` | A typed `/compact` is recorded like the button |
| `docs/decision-engine.md` (points table, `:117`) | A row for `context.compact` |
| `docs/team-and-flow.md` | A bounce may compact the Developer's chat first when the point is active |
| `docs/security-model.md` | The new chat-token refusals |
| `docs/design-system.md` + `docs/design-system/claudio-ds.css` | The three variants |
| `apps/web/src/i18n/GLOSSARY.md` | Three rows |
| `e2e/fake-cli/README.md` | `get_context_usage` and `/compact` |
| `packages/core/test/fixtures/recordings/README.md` | `c0` |
| `docs/status.md` | The row for this plan |
| `docs/reports/ecc.md` | ★4 links to this plan and to the built doc |
| This plan | Status, and an "Outcome" section when built |

## Task graph

Model for every worker: **`claude-sonnet-5-5`**, except x0 (fact recording) and x9 (security
review), **`claude-opus-5-5`**. No worker runs e2e, a Docker build or `desktop:dist`; the integrator
runs `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm e2e` once at the end. Every task commits
its own work with a Conventional Commit and writes English.

```text
x0 ─▶ x1 ─┬─▶ x2 ─┐
          ├─▶ x3 ─┼─▶ x4 ─┬─▶ x5 ─┬─▶ x7 ─▶ x10 ─┐
          └─▶ x6 ─┼───────┼───────┘               ├─▶ x9 ─▶ x11
                  │       └─▶ x8 ─────────────────┘
```

### x0 — Record what the CLI does

- **dependsOn:** none. **Model:** `claude-opus-5-5`.
- **Files:** `packages/core/test/fixtures/recordings/c0-NOTES.md`,
  `packages/core/test/fixtures/recordings/claude/*`, `packages/core/test/fixtures/replay/compact-*.jsonl`,
  `packages/core/test/fixtures/recordings/README.md`. No source file.
- **Prompt.** Record facts F1-F20 of `docs/plans/context-control.md` with the installed Claude Code
  CLI (`claude --version`, write it down). Work in a throwaway directory from `mkdtemp`, never in a
  checkout, with `--model haiku` and `--max-budget-usd 0.50` on every process; stop if a run would
  cost more. Drive `claude -p --input-format stream-json --output-format stream-json --verbose` from
  a small Node script kept outside the repository, writing stdin lines yourself. Configure two MCP
  servers for the session with `--mcp-config` (a local stdio server you write, exposing ten trivial
  tools, and a second one with one tool) and a short CLAUDE.md. Capture, in order: `get_context_usage`
  with no `detail`, `summary`, `full` and an invalid value, idle and mid-turn, with timings; an
  invented control subtype; a short conversation then `/compact`, then `/compact` with a one-line and
  a multi-line argument; `/compact` on a fresh session; an `interrupt` sent during a compaction; a user
  message written during a compaction; `--resume-session-at` a uuid before the boundary;
  `--fork-session` of the compacted session; `DISABLE_COMPACT=1` (the `init` and the answer). For each,
  keep the stdout lines and the session's JSONL lines. Read the published TypeScript types of
  `@anthropic-ai/claude-agent-sdk` (npm, read-only) and the SDK docs for slash commands and write the
  exact type names and URLs (F19). Scrub: home paths → `/home/user`, emails, session ids → fixed
  uuids, summary text → `<summary: N chars>`. Write `c0-NOTES.md` with one section per fact: the
  command, what was seen, and the fixture file; a fact you could not reproduce says why. If any
  surface is not documented, say so at the top: the plan's one-rule check fails there.
- **Acceptance criteria.**
  - [ ] `c0-NOTES.md` has a section for each of F1-F20, each with "seen", "fixture" or "not
    reproduced: reason", and the CLI version.
  - [ ] The six fixture files exist, are valid JSON / JSONL, and contain no home path, email or real
    session id (`git grep -n "/home/yeyo\|@" packages/core/test/fixtures/recordings/claude` is empty
    except placeholders).
  - [ ] F19 names the SDK types and doc URLs, or states plainly which surface is undocumented.
  - [ ] Total spend written down and under 0.50 US$.

### x1 — Shared contract and transcript normalisation

- **dependsOn:** x0. **Model:** `claude-sonnet-5-5`.
- **Files:** `packages/shared/src/types.ts`, `packages/shared/src/normalize.ts`,
  `packages/shared/src/search.ts`, `apps/api/src/openapi/schemas.json` (regenerated),
  `packages/core/test/normalize.test.ts`.
- **Prompt.** Add the section "Context control" to `types.ts` exactly as in the plan's
  "Shared types", with the category keys taken from x0's recorded names, and the changes to
  `TranscriptEntry`, `ChatContext`, `ChatActivity`, `Chat`, `ChatSummary` and `DecisionPointId`. Teach
  `normalizeMessage` the boundary (both field spellings, F5/F6) and the summary line (F7), and
  `entrySearchText` the two parts. Audit every reader of `role === 'user'` and of `entry.blocks[0]`
  with `timeout 30 git grep` and list in the commit body which ones need x4/x6 to handle
  `compaction`. Regenerate the schemas with `pnpm --filter @claudio/api openapi:schemas`. Add the
  normalise tests of the plan's Tests table.
- **Acceptance criteria.**
  - [ ] `pnpm --filter @claudio/shared typecheck` and the core `normalize.test.ts` pass.
  - [ ] A recorded boundary from stdout and from the file produce equal entries apart from `timestamp`.
  - [ ] A summary line never yields an entry without `compaction`.
  - [ ] The schemas file is regenerated and committed.

### x2 — Stream, driver and the breakdown parser

- **dependsOn:** x1. **Model:** `claude-sonnet-5-5`.
- **Files:** `packages/core/src/providers/claude-code/stream.ts`,
  `packages/core/src/providers/claude-code/driver.ts`, `packages/core/src/providers/driver.ts`,
  new `packages/core/src/providers/claude-code/context-usage.ts`,
  `packages/core/test/fixtures/fake-claude-control.mjs`, `packages/core/test/driver-reads.test.ts`,
  new `packages/core/test/context-usage.test.ts`, `packages/core/test/stream-golden.test.ts`,
  new `packages/core/test/fixtures/golden/stream-compact.json`.
- **Prompt.** Implement the plan's "The stream" and "The driver" sections. Restructure the `status`
  branch so compaction fields are read before `permissionMode` and nothing is swallowed. Add the three
  `DriverEvent` kinds. Write `parseContextUsage` as a pure function from the recorded answers. Teach
  the core fake CLI `get_context_usage` (the recorded answer) and `/compact` (replaying the recorded
  lines; a scripted failure), and nothing the recordings do not show. Replace the invented shape in
  `driver-reads.test.ts`. Generate the golden file with `UPDATE_GOLDEN=1` once and review it by hand.
- **Acceptance criteria.**
  - [ ] Every case of the Tests table rows for these files passes.
  - [ ] Existing goldens (`stream-agent-turn`, `stream-budget-stop`, `stream-interrupt`) are byte-identical.
  - [ ] The fake emits only line shapes present in x0's fixtures.

### x3 — Persistence

- **dependsOn:** x1. **Model:** `claude-sonnet-5-5`.
- **Files:** `packages/core/src/db.ts`, `packages/core/test/db.test.ts`.
- **Prompt.** Append the plan's migration as the **last** entry of `MIGRATIONS`, with its comment,
  and export `CONTEXT_CONTROL_SCHEMA_VERSION` by `findIndex`. Add the Db methods of the plan's
  "SQLite" section, with `claimHousekeeping` in one `BEGIN IMMEDIATE` transaction and guarded updates
  that return whether a row changed. Extend `deleteChat`. Test the upgrade from the previous version,
  the two-connection race (two `DatabaseSync` on one file), lease expiry, and deletion.
- **Acceptance criteria.**
  - [ ] No existing migration is edited or reordered (`git diff` of `MIGRATIONS` only adds at the end).
  - [ ] A second claim on the same chat from another connection returns null while the first is open
    and succeeds after its lease passes.
  - [ ] `db.test.ts` passes.

### x4 — Runtime, service, notes and usage

- **dependsOn:** x2, x3. **Model:** `claude-sonnet-5-5`.
- **Files:** `packages/core/src/chats.ts`, `packages/core/src/chat-service.ts`,
  `packages/core/src/chat-activity.ts`, new `packages/core/src/context-control.ts`, new
  `packages/core/src/context-notes.ts`, `packages/core/src/usage.ts`, `packages/core/src/sessions.ts`,
  `packages/core/src/chat-export.ts`, `packages/core/src/index.ts` (construction and the
  `chat-result` fan-out only), new tests `chat-compaction.test.ts`, `chat-notes.test.ts`, and
  `usage.test.ts`, `context-cost.test.ts`, `sessions.test.ts`, `chat-activity.test.ts`,
  `usage-series.test.ts` (export).
- **Prompt.** Implement the plan's "The runtime and the service" section: housekeeping purposes,
  the fan-out guard (D8), the limit-replay exclusion, the activity, `ContextControl` (usage with
  single flight and reuse, availability in the stated order, compact, `onEvent`, `compactAndWait`,
  boot sweep), `ContextRefusal` as a 409 with `reason`, the notes service with the two fixed English
  texts copied verbatim from the plan, `compactedSince` in `UsageFold`, and the sessions and export
  changes. Do not touch `flow.ts` (x8) or the API (x5).
- **Acceptance criteria.**
  - [ ] A compaction's successful result moves no "Work on it" item and ends no flow or assistant run
    (tested).
  - [ ] Every refusal code is reachable in a test, in the stated precedence.
  - [ ] An automatic boundary from a replay creates a `cli` row and a divider entry.
  - [ ] `SESSION_NOTE_INSTRUCTIONS` and `NOTE_REQUEST_PROMPT` equal the plan's text.
  - [ ] The listed core tests pass.

### x5 — API routes

- **dependsOn:** x4. **Model:** `claude-sonnet-5-5`.
- **Files:** `apps/api/src/routes/chats.ts`, `apps/api/src/openapi/routes.ts`,
  `apps/api/src/security.ts`, `README.md` (REST rows and the `How it talks to Claude` rows),
  `apps/api/src/openapi/schemas.json` (regenerated), new `apps/api/test/context.test.ts`,
  `apps/api/test/security.test.ts`.
- **Prompt.** Add the six routes of the plan's API table with the exact status codes, a summary,
  description and the `Chats` tag each, and the README rows. Add `CHAT_FORBIDDEN_CONTEXT` with the
  three write routes and its sentence. Validate bodies and the `detail` query in the handler, as
  `PUT /chats/:id/mcp/:name` does. Write the API tests of the plan's Tests table.
- **Acceptance criteria.**
  - [ ] The OpenAPI coverage test passes; schemas regenerated.
  - [ ] Each `409` carries `code`; `GET /chats/:id/context` never answers 4xx/5xx for a CLI that
    does not report.
  - [ ] Chat token `403`, desktop `403`, read-only `405` on the three writes; GETs allowed to all.

### x6 — The transcript divider (chat-ui)

- **dependsOn:** x1. **Model:** `claude-sonnet-5-5`.
- **Files:** `packages/chat-ui/src/components/Transcript.tsx`, new
  `packages/chat-ui/src/components/CompactionDivider.tsx`, `packages/chat-ui/src/lib/chat-notice.ts`,
  `packages/chat-ui/src/lib/chat-model.ts` (`contextShare`), `packages/chat-ui/src/lib/chat-live.ts`,
  `packages/chat-ui/src/lib/context.tsx` (client interface), `packages/chat-ui/src/locales/{en,es}/chat.json`,
  `packages/ui/src/lib/live.ts`, `packages/ui/src/locales/{en,es}/primitives.json`, the chat-ui
  transcript stylesheet, new `apps/web/test/compaction-divider.test.tsx`, `apps/web/test/chat-model.test.ts`.
- **Prompt.** Implement "The divider" and the composer verb. A boundary entry renders the divider; a
  summary entry directly after a boundary folds into it; a summary with no boundary before it (a page
  that starts mid-way) renders as a lone fold. "Guardar como nota" is a callback the app passes; the
  package never calls the API itself except through the client interface. Add the
  `compaction-failed` notice kind. Follow the Night Shift rules (tokens only, no motion on the
  divider, mono 11 label, `role="separator"`).
- **Acceptance criteria.**
  - [ ] No summary is ever drawn as a person's message bubble (tested with the x0 fixture).
  - [ ] `en`/`es` parity; no hard-coded strings; no raw colour or duration.
  - [ ] The listed web tests pass.

### x7 — Web: inspector, panel, confirmation, notes, header

- **dependsOn:** x5, x6. **Model:** `claude-sonnet-5-5`.
- **Files:** `apps/web/src/pages/chat/Side.tsx`, `Inspector.tsx`, `Header.tsx`, new
  `ContextPanel.tsx`, `CompactDialog.tsx`, `SessionNotes.tsx`, `apps/web/src/api.ts`,
  `apps/web/src/lib/chat-ui.tsx`, `apps/web/src/lib/shell-live.ts`,
  `apps/web/src/i18n/locales/{en,es}/*.json`, `apps/web/src/i18n/GLOSSARY.md`,
  `apps/web/src/styles/chat.css`, `docs/design-system.md`, `docs/design-system/claudio-ds.css`,
  `apps/web/test/fixtures/class-names.json`, `apps/web/test/fixtures/module-graph.json`, new tests
  `context-panel.test.tsx`, `compact-dialog.test.tsx`, `session-notes.test.tsx`.
- **Prompt.** Build the "Web" section: the places table, the panel, the confirmation, notes and the
  full States table. Open the chat page's reference in `docs/design-system/reference/` first and
  compare in dark and light. Controls only from `packages/ui/src/components/controls`; Dialog on
  desktop, Sheet on a phone; 44 px targets on touch; status colour always with a word or icon; the
  compact buttons are never the gradient. Reuse `ComposerMenu`'s MCP mutation and cache key for the
  panel's switches. Add the three design-system variants to the doc and to `claudio-ds.css`. Run the
  night-shift checklist (§7) before finishing.
- **Acceptance criteria.**
  - [ ] Every row of the States table is covered by a component test or listed for x10's e2e.
  - [ ] `i18n`, `hardcoded-strings`, `design-tokens`, `class-inventory` and `module-graph` tests pass.
  - [ ] At most two gradient surfaces on the chat page; one energy border.
  - [ ] Design-system doc and `claudio-ds.css` describe `.compaction-divider`, `.ctx-breakdown`,
    `.bar-mark`.

### x8 — The flow decision point `context.compact`

- **dependsOn:** x4. **Model:** `claude-sonnet-5-5`.
- **Files:** `packages/core/src/decisions/points.ts`, `settings.ts`, `resolve.ts`,
  `packages/core/src/flow.ts`, `packages/core/src/index.ts` (`launchFlowRun` only),
  `apps/web/src/pages/config/DecisionsTab.tsx`, `apps/web/src/i18n/locales/{en,es}/decisions.json`,
  `docs/decision-engine.md`, tests `flow.test.ts`, `decision-settings.test.ts`,
  `decision-points-runtime.test.ts`, `decision-resolve.test.ts`.
- **Prompt.** Implement "The flow and the decision point". The point ships `off` (absent from
  `decisions.json` reads as `off`). Compaction happens in `launchFlowRun` before `onStart`, through
  `ContextControl.compactAndWait`, with the run's own options minus `jsonSchema`, and never fails the
  run. Add the resolver. Keep every flow limit as it is.
- **Acceptance criteria.**
  - [ ] With the point absent or `off`, a bounce makes no decision call and no compaction (tested).
  - [ ] With `active` and `compact-first`, the compaction ends before the run's chat is tied to it,
    and the run's own result ends the run.
  - [ ] `maxParallel`, bounces, budget and the denied push are unchanged (existing flow tests green).
  - [ ] The decisions table in `docs/decision-engine.md` lists the point.

### x9 — Security and safety review

- **dependsOn:** x5, x7, x8. **Model:** `claude-opus-5-5`.
- **Files:** tests only (`apps/api/test/security.test.ts`, `packages/core/test/chat-compaction.test.ts`,
  `packages/core/test/flow.test.ts`), and fixes where a test fails.
- **Prompt.** Review the integrated branch against the plan's "Security and privacy" and D1, D4, D8,
  D9, D12: the chat-token matrix, read-only and desktop modes; that nothing sends `/compact` except
  the three entry points (button, typed, flow point); that no note reaches a prompt; that the journal
  prefill masks secrets; that the flow compaction keeps the run's policy and budget; that no SDK,
  HTTP call or hook was added (`git grep` for `@anthropic-ai/`, `fetch(`, `PreCompact` in new code).
  Add a test for every gap and fix it in place.
- **Acceptance criteria.**
  - [ ] A written list in the commit body of each check and its result.
  - [ ] Every gap found has a failing-then-passing test.

### x10 — e2e fake and spec

- **dependsOn:** x7. **Model:** `claude-sonnet-5-5`.
- **Files:** `e2e/fake-cli/claude`, `e2e/fake-cli/claude.test.mjs`, `e2e/fake-cli/README.md`, new
  `e2e/specs/context-control.spec.mjs`, `e2e/specs/a11y-core.spec.mjs`, `e2e/specs/motion.spec.mjs`.
- **Prompt.** Teach the e2e fake `get_context_usage` (the recorded shape, with 93 MCP tools across
  two servers so the warning shows) and `/compact` (success and a scripted failure), from x0's
  fixtures only, and test it with `node --test e2e/fake-cli/claude.test.mjs` (that is the only test
  you run). Write the spec scenarios of the plan's Tests table and add the overlays to the a11y and
  motion specs. Do **not** run `pnpm e2e`: the integrator runs it once.
- **Acceptance criteria.**
  - [ ] `node --test e2e/fake-cli/claude.test.mjs` passes.
  - [ ] The spec covers each scenario listed, with `export const fakeCli = true`.

### x11 — Documents

- **dependsOn:** x9, x10. **Model:** `claude-sonnet-5-5`.
- **Files:** every row of "Docs to update" not done by an earlier task.
- **Prompt.** Write `docs/context-control.md` (front matter, tags, a `## Related` list) for the
  feature as built, update the documents listed, set this plan's status to "built" with an "Outcome"
  section naming what differs from the plan and why.
- **Acceptance criteria.**
  - [ ] Each document of the table is updated or explicitly marked "no change needed" in the commit body.
  - [ ] Every new document has `created_at`, `updated_at`, `tags` and `## Related`.

## Rollout and rollback

- **Rollout.** One integration branch, one pull request, squash-merged. There is no feature flag:
  every action is a person's click, and the only automation (`context.compact`) ships `off`. The
  first release note says the transcript now shows compactions as dividers, which changes how old
  chats that compacted look (the summary bubble goes away).
- **Order inside the PR.** The migration lands with x3; until x4 nothing writes the tables, so a
  partial merge would be inert.
- **Rollback.** Revert the PR, with two rules:
  - the migration stays in `MIGRATIONS` (a reverted build sees a higher `user_version` and skips,
    `db.ts:863`; never reuse its index for another migration);
  - `parsePoints` throws on an unknown point (`settings.ts:141`): before or with the revert, either
    remove `context.compact` from `decisions.json` and every `project.json`, or keep the id in the
    list in the revert. A project override is already tolerated through `REMOVED_POINTS`
    (`settings.ts:51`, `:194`); the global document is not.
- **Fork note.** Claudio appends migrations on `feat/claude-only`; any later merge from upstream
  must keep Claudio's migrations after upstream's at the end, never interleaved.

## Resolved questions (2026-10-15)

Answered by the integrator on the owner's behalf. Where an answer differs from a section above,
the answer wins, and the task that builds the affected part follows it.

1. **Context thresholds: one rule everywhere.** Every context meter (the meter, the ring, the
   list's `ContextBar`, the new breakdown bar) follows the design system: neutral below 60 %, warn
   from 60 %, bad from 75 %. `CONTEXT_WARN` / `CONTEXT_FULL` (`types.ts:548-549`) move to 0.60 /
   0.75, and the context health signal follows them. The CLI's auto-compaction point, which the
   breakdown now reports, is drawn as a tick on the bar with its own label, so the person still
   sees where the CLI will compact. Task x7 owns the change; x1 updates the constants and their
   tests; `design-system.md` gains a line saying context bars carry the auto-compaction tick.
2. **No automatic session notes.** Confirmed: no note at a usage limit nor when a task gives up.
   Each would be a paid turn nobody asked for. They can come later, each as a decision point
   shipped `off`; nothing in this plan builds them.

## Related

[[reports/ecc.md]] · [[plans/sdk-driver-improvements.md]] · [[plans/claude-only-fork.md]] ·
[[plans/chat-experience.md]] · [[decision-engine.md]] · [[team-and-flow.md]] · [[security-model.md]] ·
[[chat-delivery.md]] · [[slash-commands.md]] · [[design-system.md]] · [[plans/chat-api-token.md]] ·
[[plans/decision-engine.md]] · [[status.md]]
