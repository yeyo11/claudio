---
created_at: 2026-10-15T12:30:00Z
updated_at: 2026-10-15T15:30:00Z
tags:
    - plan
    - chat
    - streaming
    - performance
    - ux
    - proposed
---
# Plan: a chat that feels as good as ChatGPT's

Make Agentry's chat feel as fast and smooth as ChatGPT's web chat: the first token sooner, text that
flows instead of jumping, no flicker when a block ends, a question that stays in view while it is
answered, and a composer that never loses what was typed.

Status: **proposed** on 2026-10-15. Nothing here is built yet. Branch: `docs/chat-experience-plan`.

This document is written to be implemented **without any other context**. Every work item says
what is wrong (with file and line, verified on 2026-10-15 against commit `1174f6b98`), what to
change, a code sketch, what must not break, the tests to write and how to know it is done. Line
numbers drift: search for the quoted code when a number no longer matches.

## Contents

1. [Ground rules for whoever implements this](#ground-rules-for-whoever-implements-this)
2. [How this was found](#how-this-was-found)
3. [Part A — what ChatGPT does (reference)](#part-a--what-chatgpt-does-reference)
4. [Part B — how Agentry's chat works today](#part-b--how-agentrys-chat-works-today)
5. [Part C — the work items](#part-c--the-work-items)
6. [Order, pull requests and checks](#order-pull-requests-and-checks)
7. [Decisions taken and rejected](#decisions-taken-and-rejected)
8. [Open questions](#open-questions)

---

## Ground rules for whoever implements this

- **Techniques only, never OpenAI.** Nothing in this plan talks to ChatGPT, OpenAI or any of their
  endpoints. ChatGPT was studied to learn *how* a good chat behaves; Agentry keeps reaching Claude
  only through the Claude Code CLI ([CLAUDE.md](../../CLAUDE.md), "The one rule"). Do not copy
  ChatGPT's code: the bundles are minified, proprietary and not ours. Re-implement the behaviour.
- Read [CLAUDE.md](../../CLAUDE.md) and [CONTRIBUTING.md](../../CONTRIBUTING.md) first. TypeScript
  strict, no `any`, `noUncheckedIndexedAccess`, comments say *why*, everything technical in English.
- UI copy goes through i18n (`packages/chat-ui/src/locales/{en,es}`), both languages, same keys.
- UI controls come from `packages/ui/src/components/controls`. Run the `night-shift-ui-check`
  skill before finishing any UI change (both themes, phone layout, motion levels, accessibility).
- Respect the motion levels (`packages/ui/src/lib/motion.ts`: `full` / `subtle` / `off`, with
  `prefers-reduced-motion` forcing `off`). Every animation added here must be off at `off` and
  must not loop at `subtle`, and must stop in a hidden tab. Use `useMotionLevel()` in React code.
  `e2e/specs/motion.spec.mjs` stays green.
- **Design system tokens only** ([docs/design-system.md](../design-system.md), and CLAUDE.md
  "Design system"): no hex, `rgb()`, pixel radius or millisecond value in any stylesheet other than
  `packages/ui/src/styles/tokens.css`; durations and easings in CSS come from tokens
  (`--dur-*`, `--ease-*`). The CSS sketches below follow this; where a sketch needs a new duration
  (e.g. the 0.7 s word fade), add a token to `tokens.css` and document it in `design-system.md` in
  the same PR. Millisecond constants in TypeScript are fine.
- Do not break the invariants of [chat-delivery.md](../chat-delivery.md) (every message has a
  page-chosen UUID, a retry keeps it, the composer clears only what was sent, cards for queued
  messages) and of [decisions/stray-scroll-back-to-end.md](../decisions/stray-scroll-back-to-end.md)
  (a scroll up that is not the reader's is undone while following).
- If a route or a shared type changes, use the `add-rest-route` skill: `packages/shared/src/types.ts`,
  then `pnpm --filter @agentry/api openapi:schemas`, summary and tag in
  `apps/api/src/openapi/routes.ts`, README tables.
- Commits are Conventional Commits (`feat(chat-ui): …`, `perf(core): …`). Never edit `CHANGELOG.md`.
- Each work item ends by updating **this** document: set its status line to built, with the date
  and the PR number, and add what changed from the plan under it. Update `docs/status.md` when a
  phase lands. The knowledge base (pando) re-indexes `docs/`; a new document is added with
  `kb_add_document`, an edited one only has its `updated_at` bumped.
- Checks before every pull request: `pnpm typecheck`, `pnpm test`, and for UI work
  `pnpm build && pnpm e2e` (headless Chrome over CDP, see `e2e/`).

---

## How this was found

On 2026-10-15 the ChatGPT web app (chatgpt.com, Chrome 154, logged in, Linux) was studied with
[REA](https://github.com/morluto/rea) (`rea-agents` 6.5.0, MCP server registered in Claude Code),
and Agentry's chat was read end to end.

| Source | What it gave | Confidence |
|---|---|---|
| `inspect_web_page` with a 90 s passive window while a message was sent (Evidence `ev_67aeeda3…526b48`) | The network sequence of one send, request/response JSON *shapes* (values are redacted by REA), the initiator script | **Observed** |
| `analyze_web_bundle` (Evidence `ev_30d1aaa6…d2ff6`) | 145 webpack chunks, React, endpoint candidates | Observed (static) |
| Static reading of the 145 public JS chunks and 22 CSS files, downloaded from `chatgpt.com/cdn/assets/` | Rendering, smoothing, markdown, scroll, composer, styles, error handling | **Observed in code** (file + offset below); behaviour at runtime is inferred from code |
| `capture_web_screenshot` | Visual layout | Observed |
| Reading Agentry's code (`packages/chat-ui`, `packages/ui`, `packages/core`, `apps/web`, `apps/api`) | Part B | Observed in code; no profiling was done |

Limits: the SSE response body of ChatGPT was not captured (REA's passive capture omits raw bodies),
so the stream's event sequence comes from the code that parses it. Two live coverage windows were
armed but no message was sent inside them, so "which functions run per frame" was not measured.
The downloaded build mixes ChatGPT's thread with Codex code; some findings come from shared modules.
Offsets like `731863 @5348` mean "chunk `731863.*.js`, character offset 5348" in that build
(2026-10-15); they are evidence pointers, not something to open.

---

## Part A — what ChatGPT does (reference)

### A1. The network path of one message (observed)

When Send is pressed, the page issues, in this order (all `POST` with JSON unless noted):

| # | Endpoint | Purpose | Body shape (observed) |
|---|---|---|---|
| 1 | `/backend-api/sentinel/chat-requirements/prepare` | anti-abuse handshake | `{ p: string }` |
| 2 | `/backend-api/sentinel/chat-requirements/finalize` | anti-abuse: proof of work + Turnstile | req `{ prepare_token, proofofwork, turnstile }` → res `{ token, expire_at, expire_after, persona }` |
| 3 | `/backend-api/f/conversation/prepare` (sent twice, while typing and at send) | **pre-warm**: the server gets the half-typed message before it is sent and returns an `x-conduit-token` that the real send carries | `{ action, conversation_id, parent_message_id, model, partial_query: { id, author: { role }, content: { content_type, parts[] } }, client_prepare_state, client_prepare_source, client_prepare_dispatch, local_function_names[], is_do_not_remember, timezone, timezone_offset_min }` |
| 4 | **`/backend-api/f/conversation`** → `text/event-stream` | the send; the answer streams back as SSE on the same response | `{ action, conversation_id, parent_message_id, model, messages: [{ id, author: { role, name, metadata }, content: { content_type, parts[] }, create_time, metadata, recipient, status, weight, channel, end_turn, update_time }], supported_encodings: ["v1"], client_prepare_state, client_contextual_info: { app_name, app_surface, has_web_push_capabilities, web_push_notification_permission }, genui_state_snapshots[], is_do_not_remember, local_function_names[], timezone, timezone_offset_min, turn_attribution: { turn_trigger } }` |
| 5 | `GET /backend-api/conversations/{id}?num_turns=10&include_has_versions=true` | after the stream, re-read the last turns | — |
| — | `/ces/v1/rgstr`, `/ces/statsc/flush`, `/ces/v1/telemetry/intake`, `/backend-api/bazaar/event` | telemetry (Statsig, Datadog) | — |

Every one of these was initiated from the same client module (`399565.*.js`, line 3, column 47156):
one HTTP client for the whole app. **No WebSocket** is opened for chat. The conversation is a
**tree**: every message names its `parent_message_id`, which is how edit and regenerate branch.

What Agentry takes from this: (a) streaming over the response of the send itself; (b) pre-warming
while the person types; (c) a tree of messages. Agentry already has (a) in spirit (a long-lived SSE
per chat) and has its own reasons not to do (c) now (see [Open questions](#open-questions)). (b)
becomes CHAT-3 and CHAT-13.

### A2. The stream protocol (observed in code)

- **Delta encoding "v1"** (chunk `418851` @982000). The client asks for it with
  `supported_encodings: ["v1"]`. The stream starts with an event `delta_encoding` whose data is
  `"v1"`, then many `delta` events. Each delta is a JSON-Patch-like operation on a per-channel JSON
  document, with short keys: `c` channel, `p` path (JSON Pointer, `~1` = `/`, `~0` = `~`), `o` op,
  `v` value. Ops: `add`, `replace`, `remove`, `append` (concatenate to a string or push to an
  array, or shallow-merge an object), `truncate` (cut a string/array to `v` length), `patch` (`v` is
  a list of ops applied at that path). **Missing `c`, `p` or `o` are taken from the previous
  delta**, so the typical token event is just `{"v":" word"}`: append to the same path.
  The decoder keeps the last full value per channel and yields it after every delta.
- **End of stream**: events `message_stream_complete` and `main_stream_complete` (with the
  `conversation_id`); a `title` event names a new conversation (chunk `698524` @134316).
- **Idle and retry** (chunks `514085` @35911, `698524`): if no byte arrives for 60 s
  (`stream_idle_timeout`) the request is aborted and retried with backoff
  (`minDelayMs: 300`, `maxDelayMs: 5000`, `maxRetryCount: 12`). Retries happen on
  `!navigator.onLine`, timeouts and HTTP 408/409/425/502/504, never on `can_retry: false`, a model
  cap or a rate limit.
- **Resume** (chunk `698524` @507035): a stream that was lost is resumed with
  `POST /backend-api/f/conversation/resume` carrying a resume token; the client attaches to the
  same server-side stream instead of starting a new answer.

### A3. How text reaches the screen (observed in code) — the biggest difference

- **An adaptive character buffer** (chunk `731863` @5348). Network chunks are not painted as they
  arrive. They go into a buffer that releases characters at a smoothed rate:
  - it keeps an exponential moving average of the arrival rate:
    `rate = max(1, observed * 0.1 + rate * 0.9)`;
  - it releases text in steps tied to 50 ms of that rate, speeding up when the backlog grows and
    slowing down when it is about to run dry, so the text never stalls and never bursts;
  - it publishes at most **once per animation frame** (`requestAnimationFrame`), with a 50 ms
    timer to keep ticking, and React reads it through `useSyncExternalStore`;
  - it only buffers while the tab is visible and is **off with reduced motion** (text then shows as
    it arrives).
- **Word fade-in** (chunk `731863` @~107000, module `pn4` @181771): the newly revealed text is
  split into words with `new Intl.Segmenter(undefined, { granularity: 'word' })`; each new word is
  a keyed span with class `FadeIn` and a `--fade-delay`; finished words go into `settledKeys` and
  are never animated again. Streaming fade duration is
  `--animation-duration-streaming-text: .7s`; the fade curve is
  `cubic-bezier(.37,.55,.86,.88)`. **There is no blinking cursor**: the fade is the "alive" signal.
- **A second smoothing path** (chunk `146419` @1585363, `SmoothedMarkdown`, used by a newer
  renderer): reveal in a 16 ms rAF loop, slower near the end, outliers beyond 2 standard deviations
  dropped from the rate estimate, half-written markdown auto-closed, and a ResizeObserver overlay
  that wipes new lines in (`@keyframes smoothing-move { from { transform: translate(-66%) } to { transform: none } }`).
- **State**: React Compiler everywhere (≈990 `memo_cache_sentinel` hits in one chunk), markdown
  components wrapped in `memo`, TanStack Query for server data, a Jotai-style atom store for UI state.
- **Streamed and stored text use the same renderer**; there is no separate "streaming" component
  that is swapped out at the end.

### A4. Markdown while it streams (observed in code)

- Library: **`marked`** (lexer + custom React token renderer, chunk `447351` @243370,
  `731863` @121566). `react-markdown` + `remark-gfm` only in a couple of side components.
- **Only the tail is re-lexed**: the text is cut at the last blank line that is outside code
  fences, lists and `:::` blocks; the tokens of everything before it are cached (a Map keyed by
  prefix, at most 100 entries) and only the tail is lexed again.
- **Incomplete markdown is repaired before rendering** (module `vNu` @147552): a half-written image
  `![…` is dropped, an unclosed `[link` shows as its text, an unterminated private marker is cut,
  `*` and `**` are balanced, and an open code fence is reported so the renderer shows a growing code
  block. Mermaid shows a placeholder until its fence closes.
- Math: KaTeX, loaded lazily (`strict: "ignore"`), errors hidden while streaming.
- Code: `react-syntax-highlighter` (Prism light build), languages registered on demand; React error
  boundaries named `StreamingMarkdown` and `Markdown` with a retry fallback.

### A5. Scroll (observed in code)

- **The new question goes to the top** (chunk `558861` @~62500, a class with `place`,
  `consumeGrowth`, `trimTo`). On send, a spacer is placed below the turn so the user's bubble sits
  near the top of the viewport; as the answer grows, the spacer shrinks by the same amount, so the
  reader never has to chase the end while reading the start of the answer. Skipped with reduced
  motion.
- The scroller has `overflow-anchor: none`, `overscroll-behavior-y: contain`,
  `scroll-padding-bottom: var(--thread-scroll-padding-bottom)`. A ResizeObserver follows growth
  only while pinned; a wheel up sets the direction "away" and stops following. Programmatic
  scrolls use ease-out-cubic over 260 ms.
- The scroll-to-bottom button shows when the distance from the bottom is more than spacer + 24 px.
- Long threads are virtualized (measured heights per turn, anchored to the bottom, overscan 2) and
  turns use `content-visibility: auto; contain-intrinsic-size: auto 240px`.

### A6. Composer (observed in code)

- ProseMirror editor; before it hydrates, a plain `<textarea id="pending-home-input">` captures
  keystrokes and IME so nothing typed in the first second is lost.
- Height grows up to `min(25dvh, var(--composer-editor-max-height, 25dvh))`, minimum 2.5rem.
- Submit key setting: `enter`, `newline`, `cmdAlways`, `cmdIfMultiline`; on touch devices Enter
  inserts a newline.
- **IME guard**: `if (event.isComposing || view.composing || event.keyCode === 229) return false`.
- **Drafts persist** in localStorage (`chatgpt-conversation-prompt-drafts-v2`), keyed by user,
  account, conversation (or "new-conversation") and surface, written with a 250 ms debounce.
- **Prompt history**: 20 entries per scope; ArrowUp recalls only when the composer is empty.
- **Optimistic send**: the user message is inserted at once with `isOptimistic: true` and the box
  empties immediately.
- Stop: `POST /stop_conversation`; Escape stops. Regenerate modes `next`, `continue`, `variant`.
- Attachments: paste and drop at the form level, chunked upload with per-part progress, 512 MB cap.

### A7. Styles (observed in CSS)

| Thing | ChatGPT |
|---|---|
| Thread width | `--thread-content-max-width` (48rem in some windows, 40rem when the container is under 53.5rem), `--chat-max-width: 800px` |
| Fonts | system stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`), mono `ui-monospace, "SFMono-Regular", …` |
| Text | `--text-base: 14px/1.5`, markdown `--leading-relaxed: 1.625`; `p { margin: 1em 0 }`; h1 1.75em, h2 1.5em (2rem/1rem margins) |
| User message | a bubble, `--user-message-background-color` (5 % black light / 8 % white dark), radius 22px, at most 70 % wide, right-aligned |
| Assistant message | plain text, no bubble, no avatar |
| Inline code | 4 % background, 1px 8 % inset ring, radius .25rem, padding 1px .3rem, .875em, weight 500 |
| Code block | padding `14px 40px 14px 16px`, line-height 1.5em, `--gray-25` background |
| Composer | pill, radius `--radius-4xl`, shadow `0 0 0 1px #0000000a, 0 2px 8px #0000000a, 0 4px 80px 8px #00000006` |
| Motion | fade-in `var(--duration, .15s) cubic-bezier(.37,.55,.86,.88)`, `token-pulsing-dot 1.25s`, `loading-shimmer`; 183 `prefers-reduced-motion` rules and an app setting `:root[data-reduced-motion=true]` |

The screenshot showed: a centred column about 770px wide, the user's message as a blue pill on the
right, the answer as plain text with headings, a floating "scroll to bottom" circle above a pill
composer, and a soft fade where the text meets the composer.

### A8. Errors (observed in code)

Copy: "Something went wrong. Please try again", "Connection interrupted. Waiting for the complete
answer", "Message delivery timed out. Please try again". Buttons: Retry, "Use default model" (on a
usage cap), "Start new chat" (conversation gone). A partial answer stays on screen with the error
under it (inferred).

---

## Part B — how Agentry's chat works today

All verified in code on 2026-10-15.

### B1. Sending a message

1. `Composer` (`packages/chat-ui/src/composer/Composer.tsx`) keeps the text in local state
   (line 179). `send()` (line 230) builds a UUID with `messageId()` (line 28) and calls
   `submit.mutate` → `client.sendMessage(chat.id, { text, attachments, id })` (line 193), i.e.
   `POST /chats/:id/messages`.
2. **The box keeps the text until the server answers**: `onSuccess` removes only what was sent
   (line 202) and the send button is disabled while pending (line 311). Nothing is drawn in the
   transcript yet.
3. Server: `ChatService.send` (`packages/core/src/chat-service.ts:809`) serializes sends per chat,
   then `await this.summaryOf(id)` (line 813) → `facts()` (line 351) → `cliSessions()` (line 269).
   That list is cached 1.5 s (`CLI_FRESH_MS`, line 91) and served stale up to 10 s
   (`CLI_STALE_MS`, line 92); **after 10 s the send waits for a fresh `claude agents --json`
   process** (`readCliSessions` line 293 → `listActiveCliSessions`, `packages/core/src/cli.ts:113`).
   Only then `runtime.sendMessage` writes to the CLI's stdin. The response calls `require(id)`
   (line 885), which is `summaryOf` again.
4. Yet the answer of that check is already known when the process is ours:
   `sessionHolder` (`packages/core/src/chat-model.ts:92`) returns `'agentry'` whenever
   `ownProcess` is true, and `chatControl` (line 115) then returns `interactive` (unless the chat
   belongs to an orchestration). The CLI list cannot change the outcome for our own live process.
5. The CLI process: one long-lived
   `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages`
   per chat. After a turn it waits; **after 10 min idle it is ended**
   (`IDLE_TIMEOUT_MS`, `packages/core/src/chat-fold.ts:27`, armed at line 286). The next message
   then goes through `POST /chats/:id/resume`, which runs `summaryOf(id, true)` (always a fresh CLI
   list, `chat-service.ts:739`) and **cold-starts** `claude --resume` (MCP servers included).
   `resume` requires a prompt (`packages/core/src/chats.ts:551`), so a process cannot be warmed
   without a message.

### B2. Events to the browser

- Per-chat SSE: `GET /chats/:id/stream?since=` (`apps/api/src/routes/chats.ts:198`), opened through
  `openStream` (`apps/api/src/sse.ts`): `retry: 3000`, heartbeat comment every 15 s,
  `X-Accel-Buffering: no`. Stored events carry `id: seq`; the route subscribes first, then replays
  `chats.events(id, since)` (`packages/core/src/chats.ts:505`) from an in-memory buffer of up to
  5000 events per chat (`MAX_EVENTS_PER_RUN`, `live-chat.ts:34`).
- Event kinds (`RunEvent`, `packages/shared/src/types.ts:333`): `message` (one stored entry),
  `status`, `result`, `delivery`, `notice`, … and **`partial`**.
- **`partial` carries the whole text of the current block so far**, not what is new:
  `chat.partial.text += event.text` (`chat-fold.ts:110`) then `emitPartial()`
  (`live-chat.ts:653`) sends `text: this.partial.text`. Bytes per block grow with the square of its
  length.
- **Throttle on the trailing edge**: `emitPartial` sets a 50 ms timer (`PARTIAL_THROTTLE_MS`,
  `live-chat.ts:66`) and only emits when it fires, so even the first token of a block waits 50 ms.
  Partials have no SSE id and are never replayed.
- An app-wide feed (`apps/web/src/lib/events.ts`) receives `run.updated` while a chat works. When
  the status did not change (`previousStatus === null`), it **refetches the chat's transcript
  pages** (`transcriptOf`, line 169, used at line 245): this runs on every coalesced update while
  text streams, on top of the chat stream's own reads.

### B3. The client stream

`useChatStream` (`packages/chat-ui/src/lib/chats.ts:215`):

- Opens `EventSource(streamUrl(id, lastSeq || Number.MAX_SAFE_INTEGER))` (line 333). **The first
  connection starts past every stored event.** For a resumed or new chat the stream only opens when
  a refetch shows `chat.execution` (`apps/web/src/pages/ChatView.tsx:83`), so every event pushed
  before that, including the person's own `message` event, is never seen; it only shows up when a
  later transcript read lands.
- `partial` → stored in `next` and applied once per animation frame into `ChatStreamStore`
  (`packages/chat-ui/src/lib/chat-stream.ts:199`) (lines 285–292). Only `LiveTail`
  (`ChatView.tsx:50`) subscribes through `useSyncExternalStore`, so the page does not re-render per
  frame. **This part is good and stays.**
- `message` → `appendStreamed` (`chat-stream.ts:60`) splices the entry into the React Query cache,
  dedupes by `uuid` in the last 50 entries, then `scheduleConfirm()`: a tail read
  (`GET /chats/:id?limit=…`, merged by `spliceTail`, `chat-stream.ts:127`) 1 s after the last
  stored message and at least every 4 s (`CONFIRM_AFTER_MS`, `CONFIRM_AT_LEAST_EVERY_MS`, lines
  189–191).
- Turn end (`result`, or a status other than busy) → after 400 ms **invalidates everything under
  `['chat', id]`** (line 327), which includes permissions, steps, work items and the transcript. The
  global feed's `run.updated` with a status change invalidates `keys.chatScope(id)` too
  (`events.ts:246`), so this happens twice.
- Every read hands back **new objects for the last entries**, even unchanged ones: `spliceTail`
  replaces the region with `fresh.entries` (line 171). `ChatView` recomputes
  `transcriptRows(items)` (`ChatView.tsx:176`; `packages/chat-ui/src/lib/chat-steps.ts:89`) which
  builds new row objects every time, so the memoized `EntryView`/`StepView` of every visible row
  render again.

### B4. Rendering

- The transcript is a `VirtualList` (`packages/ui/src/components/VirtualList.tsx`,
  `@tanstack/react-virtual`, `anchorTo: 'end'`, overscan 8) with heights estimated from text length
  (`estimateRow`, `packages/chat-ui/src/components/Transcript.tsx:608`).
- **The block being written lives outside the list**: `LiveTail` renders `StreamingEntry`
  (`Transcript.tsx:569`) *after* the `Transcript` (`ChatView.tsx:363`). When the block is stored,
  the stored entry appears as a **new row inside the list** (`EntryView`, `Transcript.tsx:250`) and
  `LiveTail` clears in the same layout effect (`ChatView.tsx:108`, `stream.settle()`). The new row
  is rendered by a different component tree (`RichText` without `streaming` → one full parse,
  `packages/ui/src/components/Markdown.tsx:137`), **starts at an estimated height and is then
  measured**, so the list and the scroll correct themselves in front of the reader: this is the
  flicker/jump at the end of every block.
- Markdown: `@tanstack/markdown` with `streamingMarkdownExtension` (drops half-written headings and
  list items) and an autolink extension (`Markdown.tsx:67`). While streaming, the text is cut into
  top-level blocks (`splitMarkdownBlocks`, `packages/ui/src/lib/markdown-blocks.ts`); finished
  blocks are `memo`ized and keyed by start offset, only the last one is parsed again
  (`Markdown.tsx:98`). A long code fence is a single block, so it is re-parsed whole on every frame.
  Finished answers are parsed once into an LRU of 200 (`Markdown.tsx:122`). Nothing balances `**`,
  `` ` `` or half links.
- The renderer is lazy (`Transcript.tsx:32`); **its Suspense fallback is the raw text**
  (`Transcript.tsx:42`), so the first answer of a session flashes unformatted and then re-flows.
- Code: `CodeBlock` (`packages/ui/src/components/CodeBlock.tsx`) highlights with `@tanstack/highlight`
  (shiki fallback, lazy per language) **120 ms after the code stops changing** (line 40, the timer
  is cleared on every change). Partials arrive every 50 ms, so **a code block stays uncoloured for
  as long as it streams**. Results are cached in an LRU of 300.

### B5. Scroll

`useStickToBottom` (`packages/chat-ui/src/composer/stick-to-bottom.ts:55`): follows the end with a
ResizeObserver on every child of the scroller plus a MutationObserver; only the reader's own input
(wheel up, up keys, finger dragging down, within 1.2 s) lets go; near-end threshold 80 px; glides
when the end is within 2 screens, jumps otherwise; "Jump to latest" button with a fade
(`ChatView.tsx:366`). On send it only calls `setFollow(true)`. **There is no "put the new
question at the top"**. The scroller `.run-scroll` (`packages/chat-ui/src/styles/chat.css:450`) has
a `mask-image` gradient at both edges.

### B6. Composer

Plain `<textarea>` auto-growing to 220 px with a `useLayoutEffect` per keystroke
(`Composer.tsx:223`). **Enter sends with no `isComposing` check** (`Composer.tsx:295`; only the slash
menu checks it, `SlashMenu.tsx:76`), so an IME user (accents composed with dead keys on some
layouts, Japanese, Chinese, Korean) can send half a word. **No draft persistence** (plain
`useState`, the composer is keyed by chat in `ChatView.tsx:447`). No prompt history. No edit or
regenerate (only "continue a copy", a fork). Attachments by button, paste and drop. Interrupt button
while working.

### B7. Styles and motion

| Thing | Agentry | Where |
|---|---|---|
| Column | 740 px (padding trick) | `chat.css:457` |
| Composer | max 780 px | `chat.css:555` |
| Base text | 14px/1.5, Geist (`var(--sans)`) | `apps/web/src/styles/base.css:29` |
| Markdown | line-height 1.65 | `packages/chat-ui/src/styles/transcript.css:197` |
| Composer text | 14.5 px | `chat.css:611` |
| User message | bubble on the right, max 78 %, `--bg-3`, 1px line, asymmetric radius | `transcript.css:105` |
| Streaming caret | glowing block, blinking (`box-shadow: 0 0 6px var(--live), 0 0 14px var(--live-soft)`) | `transcript.css:415` |
| New block | `.streaming-text > *:last-child { animation: fade-in }` | `transcript.css:1020` |
| Composer while working | animated conic "energy" border (`live-energy`, an `@property --energy-angle` animation) | `Composer.tsx:275`, `packages/ui/src/styles/motion.css:183` |
| Scroller | `mask-image` gradient top and bottom | `chat.css:463` |

### B8. What is already good (keep it)

The external store + rAF + `useSyncExternalStore` for partials; the block-split streaming markdown;
virtualization; the delivery model by id; reconnect with `Last-Event-ID`, backoff and hidden-tab
release; the stick-to-bottom rules; the motion levels; restore of undelivered messages. Several of
the items below build on these instead of replacing them.

---

## Part C — the work items

Ranked by effect on how the chat feels, cheapest first inside each phase. Ids `CHAT-n` are this
plan's; create tracker items with these titles if the project tracks them.

| Id | Title | Phase | Size | Effect |
|---|---|---|---|---|
| CHAT-1 | Optimistic user message | 1 | M | the message shows at once |
| CHAT-2 | Open the stream where the read ends | 1 | S | own message and early events never lost |
| CHAT-3 | Send without waiting for `claude agents` | 1 | S | first token up to a process spawn sooner |
| CHAT-4 | IME guard on Enter | 1 | XS | no half-words sent |
| CHAT-5 | First partial at once (leading-edge throttle) | 1 | XS | −50 ms per block |
| CHAT-6 | Colour code while it streams | 1 | S | code blocks no longer grey while written |
| CHAT-7 | Load the Markdown renderer before it is needed | 1 | XS | no raw-text flash |
| CHAT-8 | Smooth text reveal | 2 | M | text flows instead of jumping |
| CHAT-9 | Fade new words in | 2 | M | the "alive" feeling without a blinking caret |
| CHAT-10 | No jump when a block is stored | 2 | M | no flicker at the end of blocks |
| CHAT-11 | Fewer reads and renders | 2 | M | less jank while streaming |
| CHAT-12 | Partials as appends | 3 | M | O(n) bytes instead of O(n²) |
| CHAT-13 | Keep the process warm while the chat is open | 3 | M | no cold resume after 10 min of reading |
| CHAT-14 | The new question goes to the top | 4 | M | read the answer from its start |
| CHAT-15 | Drafts survive | 4 | S | nothing typed is lost |
| CHAT-16 | Prompt history with ArrowUp | 4 | S | resend/edit last prompt quickly |
| CHAT-17 | Repair half-written markdown | 4 | S | no `**` flashing, no broken links |
| CHAT-18 | Calmer motion while text streams | 4 | S | less paint, cleaner look |
| CHAT-19 | Reading typography | — | S | owner decision first |

---

### CHAT-1 — Optimistic user message

Status: proposed.

**Problem.** After Send the words stay in the box and nothing appears in the conversation until the
POST returns and, later, the stream's `message` event arrives (B1.2, B3). On a resume or a cold
start that is seconds.

**Goal.** The moment Send is pressed: the box empties and the person's message is drawn at the end
of the conversation, with the same UUID the server will use. If the send fails, the row is removed
and the words and files go back into the box with the error shown.

**Where.** `packages/chat-ui/src/composer/Composer.tsx`, `packages/chat-ui/src/lib/chat-stream.ts`,
`apps/web/src/pages/ChatView.tsx`, test in `packages/chat-ui/test/`.

**Rules (from [chat-delivery.md](../chat-delivery.md), must hold).**

- The UUID chosen by the page is the entry's `uuid` everywhere; a retry of the same words and files
  reuses it (`attempt` ref, `Composer.tsx:189`).
- A message the server answers `written` or `held` becomes a card over the composer
  (`useQueuedMessages`) and must not also be a row: ChatView already filters rows with `isPending`
  (`ChatView.tsx:91`).
- The composer clears only what was sent: text typed while the request is out stays.

**Steps.**

1. In `chat-stream.ts`, add an optimistic marker and two helpers next to `appendStreamed`:

   ```ts
   /** Entries the page drew on Send, before the server said anything: removed again if the send fails. */
   const optimistic = new WeakSet<TranscriptEntry>();

   /** The person's message as the page draws it on Send; the server's copy has the same uuid. */
   export function optimisticEntry(id: string, text: string, attachments: ChatPendingAttachment[], now = new Date()): TranscriptEntry {
     const entry: TranscriptEntry = {
       uuid: id,
       role: 'user',
       timestamp: now.toISOString(),
       model: null,
       isSidechain: false,
       parentToolUseId: null,
       // Build the blocks the way the server's user entry carries text and files: read how
       // `entryText` and `splitAttached` (components/Attachments.tsx) read a user entry, and
       // produce the same shape so the row renders identically before and after confirmation
       blocks: [{ type: 'text', text }],
     };
     optimistic.add(entry);
     return entry;
   }

   export const isOptimistic = (entry: TranscriptEntry): boolean => optimistic.has(entry);

   /** `page` without the optimistic entry `id` (its send failed). */
   export function dropOptimistic(page: ChatDetail, id: string): ChatDetail {
     const entries = page.entries.filter((e) => !(e.uuid === id && optimistic.has(e)));
     return entries.length === page.entries.length ? page : { ...page, entries, total: page.total - 1 };
   }
   ```

   Then insert it with the existing `appendStreamed(page, entry)` so it is marked `streamed` and
   `spliceTail` keeps it until a read confirms it by uuid (that logic exists: `readBack`, line 85).
   If attachments need a block shape that is not obvious, show text only optimistically and let
   the confirmed entry (same uuid) bring the files: the row then updates in place.

2. In `appendStreamed`, when an incoming entry has the same `uuid` as an optimistic one, **replace
   the optimistic object in place** instead of returning `present`, so the server's copy (with its
   real timestamp and blocks) takes over without moving the row:

   ```ts
   if (entry.uuid) {
     for (let i = page.entries.length - 1; i >= Math.max(0, page.entries.length - DEDUPE_WINDOW); i--) {
       const held = page.entries[i];
       if (held?.uuid !== entry.uuid) continue;
       if (!optimistic.has(held)) return { page, outcome: 'present' };
       streamed.set(entry, { mark: ++appended, at: streamed.get(held)?.at ?? now });
       streamed.delete(held);
       const entries = page.entries.slice();
       entries[i] = entry;
       return { page: { ...page, entries }, outcome: 'present' };
     }
   }
   ```

   Keep the "older than the page's end → skipped" check from firing for this case: run the uuid
   search **before** the timestamp check, or exempt optimistic matches from it (the optimistic
   timestamp is the page's clock, the server's may be slightly earlier).

3. A resume (`kind === 'resume'`) has no `id` in its request (`ResumeChatRequest`,
   `packages/shared/src/types.ts:1088`), so the server's entry gets another uuid. For resume, match
   by words: in `appendStreamed`, if `entry.role === 'user'` and an optimistic entry in the window
   has `entryText(held).trim() === entryText(entry).trim()`, replace it the same way. (`spliceTail`
   already matches unconfirmed user messages by words, `readBack` line 102.) Do **not** do this for
   `fork` (it navigates to another chat).

4. In `Composer.tsx` add a prop
   `onSending?: (message: { id: string | null; text: string; attachments: ChatPendingAttachment[] }) => (() => void) | void`
   — it returns an undo function. In `send()`, for `kind !== 'fork'` and **only when the chat is
   not working** (`!working`: a message to a working chat is taken as `written` and becomes a card,
   which already appears on response), call it right before `submit.mutate`, then clear the sent
   text from the box immediately (same rule as `onSuccess` line 202: remove `typed` from the start
   of what is held). Keep the undo in a ref. In `onSuccess`, do not clear the text again if it was
   already cleared (check that `held.startsWith(sent.typed)` is false and leave it). Add `onError`:
   call the undo, and put the words back exactly like `restore` does (line 217: append after what
   is half-typed, separated by a blank line) and `files.restore(sent.attachments)`.
   For `kind === 'resume'` pass `id: null` (matched by words, step 3).

5. In `ChatView.tsx`, implement `onSending` on the main `Composer` (line 446):

   ```ts
   const onSending = useCallback(({ id: messageId, text, attachments }) => {
     const uuid = messageId ?? `optimistic-${crypto.getRandomValues(new Uint32Array(1))[0]}`;
     const entry = optimisticEntry(uuid, text, attachments);
     for (const key of [keys.chat(id, false), keys.chat(id, true)]) {
       queryClient.setQueryData<ChatDetail>(key, (page) => (page ? appendStreamed(page, entry).page : page));
     }
     setFollow(true); // CHAT-14 replaces this with "put it at the top"
     return () => {
       for (const key of [keys.chat(id, false), keys.chat(id, true)]) {
         queryClient.setQueryData<ChatDetail>(key, (page) => (page ? dropOptimistic(page, uuid) : page));
       }
     };
   }, [id, queryClient, setFollow]);
   ```

   `keys` is `chatKeys` from `packages/chat-ui/src/lib/context.tsx:90`. Export the new helpers from
   `chat-stream.ts` (it is already in `package.json` exports as `./lib/chat-stream`).

6. The row's entrance animation (`.msg.is-fresh`, `fresh` from `justStreamed`) already plays for a
   streamed user entry; the optimistic one goes through `appendStreamed` so it gets it too.

**Must not break.** A send to a working chat still shows a card and no row. A retry after a timeout
reuses the id (the optimistic row of the first attempt was removed on error; the retry adds a new
one with the same id). A message merged by the CLI with others (one prompt, last id) is still
confirmed by `readBack`. The `chat-audit-delivery` and `chat` e2e specs pass.

**Tests.** In `packages/chat-ui/test/chat-stream.test.ts` (new, `node:test` + `assert/strict` like
`stick-to-bottom.test.ts`): (a) optimistic then server entry with the same uuid → one entry, the
server's object, same index; (b) optimistic then a tail read that holds it → `spliceTail` confirms
and keeps one; (c) `dropOptimistic` removes only optimistic entries; (d) resume: optimistic with a
synthetic uuid, server entry with other uuid and same text → replaced. E2E: in `e2e/specs/chat.spec.mjs`
assert that the user row is visible before the POST resolves (delay the route with the harness's
fixture server if available, otherwise assert the box is empty right after the click).

**Done when** the message appears and the box empties within one frame of Send, and a failed send
puts everything back with the error box.

---

### CHAT-2 — Open the stream where the read ends

Status: proposed.

**Problem.** The first `EventSource` asks for `since = Number.MAX_SAFE_INTEGER` (B3), so anything
pushed between the transcript read and the stream opening is lost until a later read; for a resume
or new chat that includes the person's own message and the first assistant blocks.

**Goal.** The client knows, with each transcript read, the `seq` the server had reached and the
`seq` at which the current execution started, and opens the stream from there.

**Steps.**

1. `packages/core/src/live-chat.ts`: add a field `executionSeq = 0` next to `seq` (line 292) and in
   `beginExecution()` (line 550) set `this.executionSeq = this.seq;` before pushing.
2. `packages/core/src/chats.ts`: next to `events()` (line 505) add

   ```ts
   /** Where a chat's event buffer stands, for a page that reads the transcript and then opens the stream. */
   streamPosition(id: string): { seq: number; executionSeq: number } | null {
     const chat = this.chats.get(id);
     return chat ? { seq: chat.seq, executionSeq: chat.executionSeq } : null;
   }
   ```

3. `packages/shared/src/types.ts`, `ChatDetail` (line 905): add

   ```ts
   /** The chat's stream position when this page was read: open the stream from `seq` to miss nothing
    *  said after the read, or from `executionSeq` to see the whole live execution. Null without a live chat. */
   stream: { seq: number; executionSeq: number } | null;
   ```

   Fill it in `ChatService.detail` (`packages/core/src/chat-service.ts:572`) from
   `this.deps.runtime.streamPosition(id)` — **read it before the transcript is read**, so the window
   between the two is covered by the replay (duplicates are harmless: `appendStreamed` dedupes by
   uuid). Add `streamPosition` to the deps' runtime type if it is a `Pick`. Regenerate OpenAPI
   (`pnpm --filter @agentry/api openapi:schemas`).
4. `packages/chat-ui/src/lib/chats.ts`, `connect()` (line 331): replace the URL with

   ```ts
   const page = client.getQueryData<ChatDetail>(keys.chat(id, false));
   const startedAt = page?.chat.execution?.startedAt;
   // A live execution that began a moment ago is replayed whole: the person's own message and the
   // first blocks were pushed before this page could open the stream
   const recent = startedAt !== undefined && Date.now() - Date.parse(startedAt) < FRESH_EXECUTION_MS;
   const since = lastSeq || (page?.stream ? (recent ? page.stream.executionSeq : page.stream.seq) : Number.MAX_SAFE_INTEGER);
   const es = new EventSource(server.streamUrl(id, since));
   ```

   with `const FRESH_EXECUTION_MS = 120_000;` near the other constants (line 188). `ChatDetail` type
   import from `@agentry/shared`.
5. Check `apps/desktop/src/sse.ts` and `apps/desktop/src/live-monitor.ts`: they consume the global
   feed, not this route; no change expected. Confirm with a grep for `/stream?since`.

**Must not break.** Replays never duplicate rows (uuid dedupe), a page opened mid-execution of a
long chat starts at `stream.seq` (not a replay of thousands of events). Reconnects keep using
`lastSeq`.

**Tests.** Core: `streamPosition` reflects `seq` and `executionSeq` across two executions. API: the
detail response carries `stream`. Client: unit-test the `since` choice by extracting it into a pure
function `streamSince(lastSeq, page, now)` exported from `chats.ts`.

**Done when** resuming a chat shows the person's message and the first answer block from the
stream, without waiting for a transcript read.

---

### CHAT-3 — Send without waiting for `claude agents`

Status: proposed.

**Problem.** `ChatService.send` awaits `summaryOf(id)`, which waits for a fresh
`claude agents --json` process when the cached list is older than 10 s (B1.3), though for a chat
whose process is ours the answer is fixed (B1.4).

**Steps.** In `packages/core/src/chat-service.ts`:

```ts
/**
 * The chat as a send needs it. A process of ours makes the chat interactive whatever the CLI's list
 * says (`sessionHolder` → 'agentry'), so the send does not wait for that list, which can mean
 * spawning `claude agents --json`. Anything else takes the full read.
 */
private async summaryForSend(id: string): Promise<ChatSummary | null> {
  const runtime = this.deps.runtime.get(id);
  if (runtime?.pid == null) return this.summaryOf(id);
  return this.summaryWith(id, { transcripts: new Map(), cli: new Map(), processes: [], orchestrations: this.chatOrchestrations() });
}
```

Use it in `send()` instead of `summaryOf(id)` (line 813) and for the response instead of
`require(id)` (line 829): add `private async requireForSend(id)` that throws `'chat not found'` like
`require` does (line 885). Check the `Facts` type for the exact field names and that `standing()`
(line 363) reads `own` from `runtime.pid` (it does: `const own = runtime?.pid != null`).

**Must not break.** A chat of an orchestration stays read-only (`chatOrchestrations()` is still
read, it is in memory). A chat whose process is not ours still gets the full, fresh decision.

**Tests.** `packages/core/test/`: a send to a chat with a live process of ours must not call
`listActiveCliSessions`. Build the service the way the existing tests that construct `ChatService`
do (search the tests for `ChatService`), stub the CLI listing and assert it is not invoked; a send
to a chat with no process of ours still invokes it.

**Done when** a follow-up typed after reading for a minute reaches the CLI with no extra process
spawned.

---

### CHAT-4 — IME guard on Enter

Status: **built** on 2026-10-15 in branch `feat/rich-composer`, by the ProseMirror editor that replaced the textarea (`RichEditor`'s `handleKeyDown` checks `isComposing`, `view.composing` and `keyCode` 229). See [chat-composer.md](../chat-composer.md).

`packages/chat-ui/src/composer/Composer.tsx:295`, change

```ts
if (e.key === 'Enter' && !e.shiftKey) {
```

to

```ts
// A composition in progress (dead keys, Japanese, Chinese, Korean) ends with Enter: that Enter picks
// the word and must not send it half-written. 229 is what some browsers report during composition
if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
```

`keyCode` is deprecated in the types: use `(e.nativeEvent as KeyboardEvent).keyCode` if the linter
complains. Test: none at unit level is practical; add a line to the e2e chat spec that dispatches a
`keydown` Enter with `isComposing: true` and asserts nothing was sent.

---

### CHAT-5 — First partial at once (leading-edge throttle)

Status: built 2026-10-15 (no PR yet). As sketched (`emitPartial` / `sendPartial` in
`live-chat.ts`); test in `packages/core/test/chat-partial.test.ts`.

`packages/core/src/live-chat.ts:653`. Emit at once when the last emit is older than the throttle,
otherwise schedule the trailing emit for the remainder:

```ts
private partialSentAt = 0;

/** Streams the in-progress block to live subscribers only: not stored, not replayed, seq untouched. */
emitPartial(): void {
  this.activityAt = now();
  if (this.partialTimer) return;
  // The first token of a block goes out at once; after that at most one frame per throttle
  const wait = PARTIAL_THROTTLE_MS - (Date.now() - this.partialSentAt);
  if (wait <= 0) return this.sendPartial();
  this.partialTimer = setTimeout(() => {
    this.partialTimer = null;
    this.sendPartial();
  }, wait);
}

private sendPartial(): void {
  if (!this.partial) return;
  this.partialSentAt = Date.now();
  this.emitter.emit('event', { seq: this.seq, ts: now(), kind: 'partial', block: this.partial.block, text: this.partial.text } satisfies RunEvent);
}
```

Keep `partialTimer` cleanup wherever it is cleared today (search `partialTimer`). Test in
`packages/core/test/` with fake timers or by calling `emitPartial` twice and counting emitted
events: the first emits synchronously, the second within 50 ms does not, the trailing one carries
the latest text.

---

### CHAT-6 — Colour code while it streams

Status: proposed.

**Problem.** `useHighlight` (`packages/ui/src/components/CodeBlock.tsx:22`) restarts a 120 ms timer
on every change, so it never fires while partials arrive every 50 ms (B4).

**Change.** Throttle instead of debounce: at most one highlight per 250 ms while the code grows,
plus a trailing run on the final code. Replace the effect with:

```ts
const FIRST_MS = 60;
const STREAMING_MS = 250;
/** Past this a block is coloured only once it stops changing: tokenising it on every pass costs more than it shows. */
const STREAMING_MAX_CHARS = 20_000;

function useHighlight(code: string, lang: string | undefined, enabled: boolean) {
  const [done, setDone] = useState<{ code: string; tokens: Tokens } | null>(null);
  const cached = enabled && lang ? coloured.get(cacheKey(lang, code)) : undefined;
  const latest = useRef(code);
  latest.current = code;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; clearTimeout(timer.current); }, []);

  useEffect(() => {
    if (!enabled || !lang || cached !== undefined || timer.current !== undefined) return;
    const run = () => {
      timer.current = undefined;
      const snapshot = latest.current;
      import('./highlight')
        .then((m) => m.highlight(snapshot, lang))
        .then((tokens) => {
          if (!tokens || !live.current) return;
          if (snapshot.length <= MAX_CACHED_CHARS) coloured.set(cacheKey(lang, snapshot), tokens);
          setDone({ code: snapshot, tokens });
          // The code moved on while this pass ran: one more, so the last version is coloured too
          if (latest.current !== snapshot && timer.current === undefined) {
            timer.current = setTimeout(run, latest.current.length > STREAMING_MAX_CHARS ? 120 : STREAMING_MS);
          }
        })
        .catch(() => {});
    };
    timer.current = setTimeout(run, done ? (code.length > STREAMING_MAX_CHARS ? 120 : STREAMING_MS) : FIRST_MS);
  }, [code, lang, enabled, cached, done]);

  if (cached) return { tokens: cached, rest: '' };
  if (!done || !code.startsWith(done.code)) return null;
  return { tokens: done.tokens, rest: code.slice(done.code.length) };
}
```

For blocks over `STREAMING_MAX_CHARS`, make the timer restart on change (old debounce behaviour) so
huge blocks are not tokenised repeatedly: when `code.length > STREAMING_MAX_CHARS`, clear and
reschedule on every change. Keep the existing `rest` logic (the coloured prefix plus the plain
tail). Test: `packages/ui/test/` with a fake `highlight` module is awkward; instead extract the
scheduling into a tiny pure class `HighlightScheduler` (next delay given `{ hasResult, length }`)
and unit-test it. Manually: stream a 60-line code block and watch it colour as it grows.

---

### CHAT-7 — Load the Markdown renderer before it is needed

Status: proposed.

`packages/chat-ui/src/components/Transcript.tsx:32`:

```ts
const loadMarkdown = () => import('@agentry/ui/components/Markdown');
const Markdown = lazy(loadMarkdown);
/** Starts loading the renderer, so the first answer on the page is never drawn as raw text first. */
export const preloadMarkdown = (): void => void loadMarkdown();
```

In `apps/web/src/pages/ChatView.tsx`, at the top of `ChatView()` (before the `isLoading` return):
`useEffect(() => preloadMarkdown(), []);`. Also call it where the chats list renders (e.g. on
pointer enter of a chat row) if a list component is easy to find; not required. Keep the raw-text
fallback (it is the right fallback if the chunk fails). Done when opening a chat after a reload
never shows unformatted markdown.

---

### CHAT-8 — Smooth text reveal

Status: built 2026-10-15 (no PR yet). Depends on nothing; pairs with CHAT-9 and CHAT-10.

Changes from the plan: `SmoothReveal` drains a backlog with a time constant of `lagMs / 4`
(a proportional catch-up only approaches zero, so `lagMs` itself would take about 1.5 s to drain a
burst) and `finish()` drains at a fixed pace so it is done within 150 ms. `useSmoothText` takes a
4th argument, `onRevealing`, which feeds `ChatStreamStore.setRevealing`; `settle()` holds back
while a stored block is still revealing and runs once it has caught up. `LiveTail` renders text
blocks through a `SmoothEntry` keyed by `partial.since`. The `outcome === 'present'` path in
`chats.ts` still clears the partial at once (the stored row is already on screen); CHAT-10 owns that swap.

**Problem.** The text of a block appears in bursts: up to 50 ms worth of tokens at a time, and
bursty whenever the model or the network is. ChatGPT reveals characters at a steady, adaptive rate
(A3).

**Design.** A per-block reveal buffer between `ChatStreamStore` and the renderer.

New file `packages/chat-ui/src/lib/smooth-text.ts`:

```ts
/**
 * Reveals a growing text at a steady pace instead of in the bursts it arrives in. The pace follows
 * how fast text has been arriving (a moving average) and speeds up as the backlog grows, so the
 * display trails the stream by a fraction of a second and never stalls or jumps. Pure apart from the
 * clock, which is passed in, so it is tested without frames.
 */
export class SmoothReveal {
  private target = '';
  private shown = 0;
  /** Characters per millisecond, a moving average of arrivals */
  private rate = 0;
  private lastPushAt = 0;
  private finishing = false;

  constructor(private readonly opts = { lagMs: 250, maxLagChars: 600, minRate: 0.02 }) {}

  /** The whole text so far. A text that does not continue the last one (a rewrite) starts over. */
  push(text: string, at: number): void {
    if (!text.startsWith(this.target.slice(0, this.shown))) this.shown = commonPrefix(text, this.target);
    const added = text.length - this.target.length;
    if (added > 0 && this.lastPushAt > 0) {
      const dt = Math.max(1, at - this.lastPushAt);
      this.rate = this.rate === 0 ? added / dt : (added / dt) * 0.1 + this.rate * 0.9;
    }
    this.lastPushAt = at;
    this.target = text;
  }

  /** The block was stored: show the rest quickly (within ~150 ms) instead of at the stream's pace. */
  finish(): void { this.finishing = true; }

  /** Advances by `dt` ms of display time; returns the text to show now. */
  step(dt: number): string {
    const backlog = this.target.length - this.shown;
    if (backlog <= 0) return this.target;
    if (backlog > this.opts.maxLagChars) this.shown = this.target.length - this.opts.maxLagChars;
    const catchUp = (this.target.length - this.shown) / (this.finishing ? 150 : this.opts.lagMs);
    const speed = Math.max(this.rate, catchUp, this.opts.minRate);
    this.shown = Math.min(this.target.length, this.shown + Math.max(1, Math.round(speed * dt)));
    return this.target.slice(0, this.shown);
  }

  get done(): boolean { return this.shown >= this.target.length; }
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
```

Then a hook in the same file:

```ts
/**
 * `text` revealed smoothly, re-rendering at most once a frame. Off (the text as it arrives) when
 * motion is off or the tab is hidden: nobody is watching the pace then, and a hidden tab gets no frames.
 */
export function useSmoothText(text: string, enabled: boolean, ended: boolean): string {
  // one SmoothReveal per block: the caller remounts this (key) when a new block starts
  // - push(text, performance.now()) in an effect whenever `text` changes
  // - a requestAnimationFrame loop running while !reveal.done: step(dt), setState(shown) if changed
  // - when `ended` becomes true, call finish()
  // - when !enabled or document.hidden: return `text` directly and stop the loop
}
```

Wire it in `ChatView.tsx` `LiveTail` (line 50): compute
`const shown = useSmoothText(partial.text, motion !== 'off' && partial.block === 'text', stream.ending)`
inside a small child component keyed by `partial.since` (so a new block gets a new buffer), and pass
`shown` to `StreamingEntry`. Thinking blocks keep showing raw (they are already truncated to the
last 1200 characters). `stream.ending` is the store's getter; expose it through the snapshot
(add `ending: boolean` to `StreamSnapshot` and set it in `endPartial`/`clearPartial`) so the
component re-renders when it flips.

**Interaction with the end of a block.** Today the stored row replaces `LiveTail` as soon as the
transcript shows the entry (`stream.settle()`, `ChatView.tsx:108`). With a buffer, the reveal may
still be behind. Make `settle()` wait for the reveal: give `ChatStreamStore` a `revealing` flag set
by the hook while `!done`, and in `settle()` keep the partial while `revealing` is true (bounded:
`finish()` drains in ~150 ms, and keep the existing quiet fallback). CHAT-10 makes the swap itself
invisible.

**Tests.** `packages/chat-ui/test/smooth-text.test.ts`: steady arrivals → shown trails by about
`lagMs × rate` characters; a burst of 500 characters → drained within ~`lagMs` without exceeding
`maxLagChars` backlog; `finish()` → done within 150 ms of steps; a rewrite (text not continuing)
→ restarts at the common prefix; `step` never returns more than `target`.

**Done when** a long answer scrolls in as an even flow at motion `full` and `subtle`, and appears
exactly as received at `off`.

---

### CHAT-9 — Fade new words in

Status: proposed. After CHAT-8.

**Design.** Fade the freshest characters of the streaming block without touching React's DOM, with
the CSS Custom Highlight API (Chromium, which the web app and the Electron desktop app use;
feature-detect and do nothing elsewhere).

1. CSS (`packages/chat-ui/src/styles/transcript.css`):

   ```css
   /* The newest words of the block being written arrive faded and settle in three steps */
   ::highlight(stream-fresh-1) { color: color-mix(in srgb, currentColor 35%, transparent); }
   ::highlight(stream-fresh-2) { color: color-mix(in srgb, currentColor 65%, transparent); }
   ```

   (`::highlight` takes `color`, not `opacity`; it cannot animate, so the fade is stepped by moving
   ranges between the two highlights each frame.)
2. In the streaming component, a `useLayoutEffect` after every render of the shown text: walk the
   text nodes of the streaming container (`TreeWalker`, `NodeFilter.SHOW_TEXT`) to get the rendered
   text length; keep a list of `(renderedLength, time)` checkpoints; characters rendered in the last
   0–120 ms belong to `stream-fresh-1`, 120–240 ms to `stream-fresh-2`, older are normal. Build
   `Range`s from the end of the rendered text backwards (fresh text is always at the end while
   streaming; if the rendered length shrinks, clear the checkpoints) and set
   `CSS.highlights.set('stream-fresh-1', new Highlight(...ranges))`.
3. Run only at motion `full`, only for `block === 'text'`, and clear both highlights on unmount and
   when the block ends.
4. Remove the blinking caret (`transcript.css:415`, `.streaming-text > :last-child::after`) when the
   fade is active: add a class `has-fade` on the streaming container and scope the caret rule to
   `:not(.has-fade)`. Keep the caret at `subtle` (no fade there) but without the glow (CHAT-18).

**Tests.** The range computation as a pure function
`freshRanges(checkpoints, now, renderedLength) → [{ from, to, level }]` in
`packages/chat-ui/src/lib/smooth-text.ts`, unit-tested. Manual check in both themes.

---

### CHAT-10 — No jump when a block is stored

Status: built 2026-10-15 (no PR yet). Deviations: the height is written through an `onHeight` prop of
`StreamingEntry` (a `ResizeObserver` on its `<article>`, wired in `SmoothEntry`) into
`ChatStreamStore.lastBlockHeight`; `chats.ts` moves it to `streamedHeight` only when the entry was
appended (not `present`) and resets it. `EntryView` takes `streamedCopy` for the streaming markup.
No e2e spec written; the frame-by-frame check is left to the verification phase.

**Problem.** B4: the stored row starts at an *estimated* height, then is measured, and the list and
scroll correct in front of the reader; the streamed element is replaced by a new tree in the same
frame.

**Design.** Hand the measured height of the streaming element to the list, so the new row's first
size is exact, and keep the two renderings identical.

1. `packages/ui/src/components/VirtualList.tsx`: accept an optional
   `sizeHint?: (item: T) => number | undefined`; in `estimateSize` (line 117) return the hint when it
   is defined before falling back to `estimate`. (`@tanstack/react-virtual` uses the estimate until
   the row is measured, so an exact estimate means no correction.)
2. `packages/chat-ui/src/lib/chat-stream.ts`: a module-level `const heights = new Map<string, number>()`
   keyed by entry uuid is not possible (the partial has no uuid). Instead keep the last streamed
   block's height in the store: `ChatStreamStore.lastBlockHeight: number | null`, written by
   `StreamingEntry` through a `ResizeObserver`/`useLayoutEffect` on its `<article>`
   (`offsetHeight`), read once when the stored entry arrives.
3. When `appendStreamed` adds an **assistant** entry from the stream (the event that finalises the
   partial, `chats.ts:299`), record `streamedHeight.set(entry, store.lastBlockHeight)` in a
   `WeakMap<TranscriptEntry, number>` exported from `chat-stream.ts`. In `Transcript.tsx`, pass
   `sizeHint={(row) => row.kind === 'entry' ? streamedHeight.get(row.entry) : undefined}` to
   `VirtualList` (rows are `TranscriptRow`; for a `step` row return undefined). Note the
   VirtualList measures the wrapper `div`, and the list's `gap` is applied by the virtualizer, so the
   article height is the right number; verify in devtools that the first measured size equals the
   hint (±1 px) and add the row's vertical padding if not.
4. Render the stored copy of a just-streamed answer with the **same markup**: `RichText` for an
   entry with `justStreamed(entry)` should use `streaming` mode (block-split), which produces the
   same DOM structure as the streaming copy; switch to the parsed-once path when the row is
   re-mounted later (it no longer is `justStreamed` after 1.2 s). In `Transcript.tsx` `Block`
   (line 85) the assistant text renders `<RichText text={text} />`; pass
   `streaming={fresh}` from `EntryView` (it already receives `fresh` for user rows; compute
   `justStreamed(entry)` for assistant rows too, but **do not** add the `is-fresh` entrance
   animation to assistant rows).
5. Keep the swap in one frame (it is: `useLayoutEffect(() => stream.settle(), [lastKey])`).

**Tests.** E2E: stream an answer with several paragraphs (the e2e harness has a fake CLI; see
`e2e/` and `create-ai-stream.spec.mjs` for how streamed answers are produced) and record
`scrollTop` and the transcript's bounding box on every animation frame around the moment the block
is stored; assert no frame moves the last row by more than 2 px while following.

**Done when** the end of a block is invisible: no flicker, no jump, code blocks keep their colours.

---

### CHAT-11 — Fewer reads and renders

Status: proposed.

Four independent changes; do them in this order and measure with the React profiler after each.

1. **Skip the global feed's transcript refetch while the chat's own stream is open.**
   `packages/chat-ui/src/lib/chats.ts`: a module-level registry

   ```ts
   const liveStreams = new Set<string>();
   /** The chat's page holds an open stream: it keeps the transcript current by itself. */
   export const hasLiveStream = (chatId: string): boolean => liveStreams.has(chatId);
   ```

   `liveStreams.add(id)` in `es.onopen`, `liveStreams.delete(id)` in `disconnect()` and in the
   effect cleanup. In `apps/web/src/lib/events.ts:244`:
   `return event.previousStatus === null ? (hasLiveStream(event.runId) ? [] : transcriptOf(event.runId)) : …`.
   (`apps/web` may import from `@agentry/chat-ui`; the boundaries test,
   `packages/chat-ui/test/boundaries.test.ts`, guards the other direction.)
2. **One invalidation at turn end, not two.** `chats.ts:327` invalidates `keys.chatScope(id)` 400 ms
   after a turn ends; the global feed already invalidates `keys.chatScope(runId)` on the status
   change (`events.ts:246`). Replace the turn-end timer body with `confirmNow()` (only the two
   transcript keys, exact). Keep it when the global feed is down? The chat page already has
   `refetchInterval` as a fallback (`useChatTranscript`, line 169), so no.
3. **Keep unchanged entries as the same objects.** In `spliceTail` (`chat-stream.ts:171`), when
   pushing each `fresh` entry, reuse the held object if it is the same entry:

   ```ts
   const heldByUuid = new Map(region.map((e) => [e.uuid, e]));
   const same = (a: TranscriptEntry, b: TranscriptEntry) => a.timestamp === b.timestamp && a.blocks.length === b.blocks.length && JSON.stringify(a.blocks) === JSON.stringify(b.blocks);
   for (const entry of fresh.entries) {
     const held = heldByUuid.get(entry.uuid);
     const kept = held && !streamed.has(held) && same(held, entry) ? held : entry;
     entries.push(kept, ...(after.get(entry.uuid) ?? []));
   }
   ```

   (The stringify runs over at most `TAIL_READ` entries per read, a few times a second at most.)
   Check `streamed.delete` bookkeeping above still runs for replaced entries.
4. **Keep unchanged rows as the same objects.** `transcriptRows` (`chat-steps.ts:89`) builds new
   rows every call. Add an optional `previous?: readonly TranscriptRow[]` parameter: index previous
   rows by key; when a new row has the same key and (entry rows) the same `entry` object and
   `continued`, or (step rows) entries that are element-wise identical, return the previous row
   object. In `ChatView.tsx:176` keep the last rows in a ref and pass them. `rowOf` compares
   entries by identity and keeps working.

**Tests.** `chat-stream.test.ts`: a tail read with identical entries returns the same objects;
`chat-steps` test: rows are reused when entries are reused. Profile before/after: count `EntryView`
renders during one streamed answer of ~10 blocks; record the numbers in this document.

---

### CHAT-12 — Partials as appends

Status: proposed. Protocol change: shared type, API, client.

**Design.** The first partial of a block, and the first one any subscriber receives, carries the
whole text; after that the server sends only what is new, with where it starts.

1. `packages/shared/src/types.ts`, `RunEvent`: add
   `/** For \`partial\` events after the first of a block: text to append at \`at\` (the length the client must hold) */ append?: string; at?: number;`
2. `packages/core/src/live-chat.ts`: track `private partialSentLength = 0` and the block it belongs
   to. In `sendPartial()` (CHAT-5): if the block changed or nothing was sent for it yet, emit
   `{ kind: 'partial', block, text }` and set `partialSentLength = text.length`; else emit
   `{ kind: 'partial', block, append: text.slice(partialSentLength), at: partialSentLength }`.
   Reset `partialSentLength = 0` where `chat.partial` is set to a new block or null
   (`chat-fold.ts:99`, `:116`).
3. A subscriber that connects mid-block must get a snapshot: in the stream route
   (`apps/api/src/routes/chats.ts:207-208`), after the replay, write
   `chats.partialSnapshot(id)` if it returns one (`{ seq, ts, kind: 'partial', block, text }` from the
   live chat's current `partial`). Add `partialSnapshot` next to `events()` in `chats.ts`.
4. Client, `chats.ts:285`: keep the current text per block in the hook (`let current = ''`); on
   `text` → `current = text`; on `append` → if `at === current.length` then `current += append`,
   else ignore it and keep showing `current` (the next block or the next connection brings a
   snapshot). Then `next = { block, text: current, since }` as today.
5. Every consumer of `partial` must handle `append`: grep the repo for `'partial'` and
   `kind === 'partial'` (desktop app, tests, e2e harness).

**Tests.** Core: a block of 5 deltas yields one `text` then appends with increasing `at`; a new
block restarts with `text`. Route: a late subscriber receives a snapshot. Client: pure function
`applyPartial(current, event) → current` unit-tested, including a mismatched `at`.

---

### CHAT-13 — Keep the process warm while the chat is open

Status: proposed.

**Problem.** A chat idle for 10 minutes loses its process (B1.5). Someone reading a long answer
for 11 minutes then pays a cold `--resume` (with MCP start-up) for their next message.

**Design.** While at least one page holds the chat's stream open, the idle timer re-arms instead of
ending the process, up to a ceiling; a start refused by the concurrent-run limit first frees such
idle processes.

1. `packages/core/src/live-chat.ts`: `viewers = 0`, `idleSince: number | null`.
2. `packages/core/src/chats.ts` `subscribe()` (line 524): `chat.viewers++` and, in the returned
   unsubscribe, `chat.viewers--`. The stream route is the only caller that represents a person; if
   internal code calls `subscribe`, add a parameter `{ viewer: true }` and pass it only from the
   route (`apps/api/src/routes/chats.ts:207`).
3. `packages/core/src/chat-fold.ts:286`: replace the timer with

   ```ts
   const VIEWED_IDLE_MAX_MS = Number(process.env.AGENTRY_VIEWED_IDLE_MAX_MS ?? 60 * 60_000);
   chat.idleSince = Date.now();
   const onIdle = () => {
     // Someone has the chat open: their next message should not wait for a cold start. Bounded, so a
     // tab forgotten open does not hold a process for ever (a hidden tab lets go of its stream after 30 s anyway)
     if (chat.viewers > 0 && Date.now() - (chat.idleSince ?? 0) < VIEWED_IDLE_MAX_MS) {
       chat.idleTimer = setTimeout(onIdle, IDLE_TIMEOUT_MS);
       chat.idleTimer.unref();
       return;
     }
     chat.session?.endInput();
   };
   chat.idleTimer = setTimeout(onIdle, IDLE_TIMEOUT_MS);
   chat.idleTimer.unref();
   ```

   Set `chat.idleSince = null` wherever the idle timer is cleared because work resumed
   (`chat-fold.ts:159`, `:236`, `:283`; `chats.ts:1136`, `:1157`).
4. `packages/core/src/chats.ts` `admit()` (line 617): before throwing
   `Concurrent run limit reached`, end the input of chats that are alive, idle (`status === 'idle'`,
   no `written()` messages) and past `IDLE_TIMEOUT_MS` since `idleSince`, oldest first, until under
   the limit; if still at the limit, throw as today. Ending input lets the process exit as it would
   have after 10 min; `activeCount()` counts `alive`, so re-check after the processes exit or count
   the ones being ended as free (they exit within moments; prefer making `admit` count chats whose
   input was ended as not active).

**Must not break.** `keepAlive: false` chats still end after their turn. Without viewers nothing
changes. The limit still holds.

**Tests.** Core: an idle chat with a viewer survives past `IDLE_TIMEOUT_MS` (use a small env value
in the test) and ends after `VIEWED_IDLE_MAX_MS`; without viewers it ends as before; `admit` frees a
warm idle chat when at the limit.

---

### CHAT-14 — The new question goes to the top

Status: proposed. After CHAT-1 (it needs the optimistic row).

**Design.** On Send, scroll so the new user row sits near the top of the viewport, with a spacer
under the conversation that fills the rest of the viewport. Because the spacer exactly fills the
viewport, "the end of the scroller" is the position where the question is at the top, so the
existing stick-to-bottom logic keeps working unchanged: following the end keeps the question in
place, and once the answer is taller than the viewport the spacer is zero and following behaves as
today.

1. `Transcript.tsx` `EntryView` (line 284): add `data-entry-id={entry.uuid}` to the `<article>`.
2. `ChatView.tsx`: state `const [anchor, setAnchor] = useState<string | null>(null)` (uuid of the
   question); set it in `onSending` (CHAT-1) instead of `setFollow(true)`, and call
   `setFollow(true)`; clear it when `id` changes (the effect at line 97).
3. Render `<div className="turn-spacer" aria-hidden style={{ height: spacer }} />` as the last child
   of `.run-scroll`, after `LimitStopped` (line 364).
4. Compute `spacer` in a hook `useTurnSpacer(scroller, anchor)` in
   `packages/chat-ui/src/composer/turn-spacer.ts`:
   - find `scroller.querySelector(`[data-entry-id="${CSS.escape(anchor)}"]`)`; if missing (row not
     rendered yet, or virtualized away), spacer 0;
   - `rowTop = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop`;
   - `contentEnd = scroller.scrollHeight - currentSpacer` (the spacer's own height excluded);
   - `spacer = Math.max(0, scroller.clientHeight - TOP_GAP - (contentEnd - rowTop) - paddingBottom)`
     with `TOP_GAP = 16` and `paddingBottom` the scroller's computed bottom padding;
   - recompute on a `ResizeObserver` over the scroller and its children (reuse the pattern in
     `stick-to-bottom.ts:190`) and after every render in a `useLayoutEffect`;
   - write the height directly to the spacer element (`ref.style.height`) instead of React state, to
     avoid a render per frame while streaming.
5. When the spacer first becomes positive, the existing `setFollow(true)` glide takes the view to
   the end, which is now "question at the top". Glide is smooth within 2 screens
   (`stick-to-bottom.ts:75`), instant beyond or with reduced motion: that is already the right
   behaviour.
6. Add `overflow-anchor: none;` to `.run-scroll` (`chat.css:450`): the browser's own scroll
   anchoring would otherwise move the view when the spacer shrinks. Run the paging e2e specs
   (`paging.spec.mjs`, `paging-held.spec.mjs`) to confirm the virtual list (which does its own
   anchoring) is unaffected; see
   [decisions/stray-scroll-back-to-end.md](../decisions/stray-scroll-back-to-end.md).
7. The "Jump to latest" button keeps its rule (`!follow`).

**Must not break.** A send to a working chat (a card, no row) sets no anchor. Opening a chat starts
at its end as today (no anchor). Phone layout: the composer covers part of the viewport; use the
scroller's `clientHeight`, which already excludes it.

**Tests.** E2E: send in a long chat; after the glide, the user row's top is within 16–40 px of the
scroller's top; stream a long answer and assert the row moves up only once the answer exceeds the
viewport. Unit-test the spacer formula as a pure function.

---

### CHAT-15 — Drafts survive

Status: **built** on 2026-10-15 in branch `feat/rich-composer`, as planned (`composer/drafts.ts`), written 300 ms after typing rests and when the box goes. See [chat-composer.md](../chat-composer.md).

`packages/chat-ui/src/composer/Composer.tsx`:

- Key: `agentry-composer-draft:${chat.id}:${kind}`. Value: `{ text: string; at: number }` JSON.
- Initial state: `useState(() => readDraft(key))` — read with `try/catch`, ignore drafts older than
  7 days (delete them).
- Write with a 300 ms debounce on `text` change (`setTimeout` in an effect, cleared on change);
  `removeItem` when the text is empty.
- Clear on successful send: after `setText` in `onSuccess` (or at Send with CHAT-1), write what
  remains (usually empty → remove).
- A `restore` (`Composer.tsx:213`) merges into the draft as it does into the text.
- Files are not persisted (their upload ids expire).
- Put the storage helpers in `packages/chat-ui/src/composer/drafts.ts` with unit tests (inject a
  `Storage`-like object).

---

### CHAT-16 — Prompt history with ArrowUp

Status: **built** on 2026-10-15 in branch `feat/rich-composer`, as planned (`composer/history.ts`); ArrowDown also works from the start of a recalled message, where ArrowUp leaves the caret. See [chat-composer.md](../chat-composer.md).

- `ChatView.tsx`: `const history = useMemo(() => transcript.items.filter((e) => e.role === 'user' && !e.isSidechain).map((e) => entryText(e).trim()).filter(Boolean).slice(-20), [transcript.items]);`
  (skip entries that are only tool results: `entryText` of those is empty). Pass `history` to the
  main `Composer`.
- `Composer.tsx` `onKeyDown` (line 293), after `slash.onKeyDown(e)`: `ArrowUp` when the box is empty
  **or** holds exactly the history entry being shown, and the caret is at position 0 → show the
  previous entry (index walks back), `preventDefault`; `ArrowDown` walks forward and past the newest
  back to empty; any typing resets the index. Respect `isComposing`.
- Put the index logic in a pure function in `packages/chat-ui/src/composer/history.ts`, tested.

---

### CHAT-17 — Repair half-written markdown

Status: proposed.

`packages/ui/src/lib/markdown-repair.ts` (new), applied in `StreamingMarkdown`
(`packages/ui/src/components/Markdown.tsx:107`) to the **last** piece only
(`index === starts.length - 1`), before it is passed to `Block`:

```ts
/**
 * The end of a growing answer made renderable: what the model has opened and not yet closed would
 * otherwise show as raw marks until it does. Only ever applied to the last block of a streaming answer.
 */
export function repairTail(text: string): string {
  if (insideOpenFence(text)) return text;            // a growing code block renders as one already
  let out = text
    .replace(/!\[[^\]]*$/, '')                        // half an image: `![alt`
    .replace(/!\[[^\]]*\]\([^)]*$/, '')               // `![alt](url`
    .replace(/\[([^\]]*)\]\([^)]*$/, '$1')            // `[text](url` → text
    .replace(/\[([^\]]*)$/, '$1');                    // `[text` → text
  const code = countUnescaped(out, '`') % 2 === 1;
  if (code) return `${out}\``;                        // inside inline code: close it, nothing else applies
  if (countMarker(out, '**') % 2 === 1) out += '**';
  if (countSingle(out, '*') % 2 === 1) out += '*';
  if (countSingle(out, '_') % 2 === 1 && /(^|\s)_\S[^_]*$/.test(out)) out += '_';
  return out;
}
```

Write the helpers (`insideOpenFence`: count lines starting with ``` or ~~~ outside of other fences;
`countUnescaped`; `countMarker` counting `**` pairs not inside inline code; `countSingle` counting
single `*`/`_` that are not part of `**`, list bullets at line start, or inside words for `_`).
Unit tests in `packages/ui/test/markdown-repair.test.ts`: `"**bold"`, `"a *b"`, `` "`code" ``,
`"see [docs](http"`, `"![img"`, `"- item"` (a bullet is not emphasis), `"snake_case word"`
(unchanged), an open fence (unchanged). The `streamingMarkdownExtension` stays; this complements it.

---

### CHAT-18 — Calmer motion while text streams

Status: proposed. Run `night-shift-ui-check`.

1. **Composer energy border**: `Composer.tsx:275` adds `live-energy` while the chat works. Keep it
   while the agent is running tools, drop it while **text** streams (the reader's eyes are on the
   text, and the conic `@property` animation repaints every frame): pass `writing` (ChatView has
   it, line 85) to `Composer` as a prop and use
   `className={\`composer ${working ? (writing ? 'is-working' : 'live-energy is-working') : ''}\`}`.
   The design system says the energy border goes on "the working composer"; this narrows *when*,
   so add one sentence to `docs/design-system.md` ("…while the agent works, and not while its
   answer is being written: the text is the live surface then") in the same PR. If the owner
   disagrees in review, drop this step and keep the others.
2. **Caret glow**: in `transcript.css:415` remove the `box-shadow` of the caret (a blurred shadow
   re-rasterised on every blink). With CHAT-9 the caret is hidden at motion `full` anyway.
3. **Scroller edge fade**: replace the `mask-image` on `.run-scroll` (`chat.css:463-464`) with two
   overlays on `.run-stage` (its parent; make it `position: relative` if it is not):

   ```css
   .run-stage::before,
   .run-stage::after {
     content: '';
     position: absolute;
     left: 0;
     right: 0;
     height: 14px;
     pointer-events: none;
     z-index: 1;
   }
   .run-stage::before { top: 0; background: linear-gradient(var(--bg), transparent); }
   .run-stage::after { bottom: 0; background: linear-gradient(transparent, var(--bg)); }
   ```

   Use the token the scroller actually sits on (check `--mask-ink`'s intent and the page background
   token in `packages/ui/src/styles`); both themes; the scrollbar must stay usable (overlays must not
   cover it: inset `right` by the scrollbar width or limit them to the column).

---

### CHAT-19 — Reading typography (owner decision first)

Status: **needs a decision**; do not implement without the owner's approval.

ChatGPT's measured CSS uses 14px base and 1.625 markdown leading, close to Agentry's 14px/1.65. The
screenshot looked larger (≈16px rendered text). Options to try behind a quick A/B in the browser:
`.md { font-size: 15px; line-height: 1.7 }` and paragraph spacing `1em`, user bubble max 70 %. Ask
the owner before changing tokens; follow `docs/design-system.md`.

---

## Order, pull requests and checks

One pull request per line; each is independent unless noted.

1. **PR 1 (phase 1, small):** CHAT-4, CHAT-5, CHAT-7.
2. **PR 2:** CHAT-3.
3. **PR 3:** CHAT-6.
4. **PR 4:** CHAT-2 (shared type + OpenAPI).
5. **PR 5:** CHAT-1 (then CHAT-14 can start).
6. **PR 6:** CHAT-11.
7. **PR 7:** CHAT-8, then **PR 8:** CHAT-10, then **PR 9:** CHAT-9.
8. **PR 10:** CHAT-12 (shared type + OpenAPI).
9. **PR 11:** CHAT-13.
10. **PR 12:** CHAT-14. **PR 13:** CHAT-15 + CHAT-16. **PR 14:** CHAT-17. **PR 15:** CHAT-18.

Every PR: `pnpm typecheck`, `pnpm test`; UI PRs also `pnpm build && pnpm e2e` and the
`night-shift-ui-check` skill; i18n keys in `en` and `es`; update this document's item status.

How to check the result by hand: open a chat in the web app, ask for "a 40-line TypeScript example
with an explanation of each part, then a table comparing three options". Watch for: the message
appearing at once, the first token, the flow of text, the code colouring while written, no jump
when each block ends, the question staying at the top, the composer keeping a draft across a reload.

## Decisions taken and rejected

- **Taken: re-implement behaviours, never call or copy ChatGPT.** The one rule of
  [CLAUDE.md](../../CLAUDE.md) and the code's licence both forbid more.
- **Taken: keep EventSource and the per-chat stream.** ChatGPT streams on the response of the send
  (`fetch` + `ReadableStream`), which allows a POST body and custom headers. Agentry's chat outlives
  a single send (queued messages, other tabs, the desktop app), and the per-chat stream with
  `Last-Event-ID` already gives resume. Switching transport would not change how it feels.
- **Rejected for now: ChatGPT's full JSON-Patch delta protocol.** Agentry streams one text block at
  a time; `append` (CHAT-12) gives the same byte savings with a fraction of the complexity.
- **Rejected for now: a conversation tree (edit, regenerate, variants).** The Claude Code CLI
  transcript is linear and Agentry reaches it only through the CLI; branching would need a CLI
  capability to rewind a session. See open questions.
- **Rejected: a pre-hydration textarea like ChatGPT's.** Agentry's composer is a plain textarea that
  is interactive as soon as the chat page renders; there is no editor to wait for.

## Open questions

1. Edit and regenerate: does the Claude Code CLI offer a supported way to continue a session from
   an earlier message (a rewind or a fork at a message id)? If so, a "regenerate" could be built on
   `fork`. Research before planning.
2. CHAT-13: is a 60-minute ceiling for warm viewed chats right, given memory per CLI process and
   MCP servers? The owner chooses; it is an environment variable either way.
3. CHAT-19: typography, owner decision.
4. The submit-key setting (Enter vs Ctrl+Enter, and Enter = newline on touch screens) is in ChatGPT;
   Agentry's phone layout blurs the box after sending instead. Worth a setting?

## Related

[[chat-delivery.md]] · [[chat-composer.md]] · [[decisions/stray-scroll-back-to-end.md]] · [[design-system.md]] · [[phone-layout.md]] · [[plans/paging-long-tasks.md]] · [[reports/chat-audit/README.md]] · [[providers.md]] · [[knowledge-base.md]]
