---
created_at: 2026-09-30T21:00:00Z
updated_at: 2026-10-30T12:00:00Z
tags:
    - api
    - web
    - performance
    - desktop
---
# What goes over the wire between the UI and the API

The web UI, the desktop tray and any other client talk to Claudio through two channels:

- **REST with JSON**, the contract being `packages/shared/src/types.ts`, typed in the web by one
  `request<T>()` in `apps/web/src/api.ts` and cached by TanStack Query.
- **Server-Sent Events**: `GET /api/events` for everything that moves, and
  `GET /api/chats/:id/stream` for one chat's transcript. Both resume from an id (`?since=`) and are
  written by `openStream` in `apps/api/src/sse.ts`. An event either writes itself into the cache
  (`patchRun`, `patchActivity`, `patchOrchestrationTask`, `patchSettings` in
  `apps/web/src/lib/events.ts`) or asks for queries to be read again, folded per query by
  `Invalidations`. Polling is only the fallback while the feed is down.

This page records how the payloads were made lighter on 2026-09-30, and what was decided not to
change.

## What was measured

Against a dev server with 17 orchestrations and a few hundred chats, before the change:

| Route | Raw | gzip |
| --- | --- | --- |
| `GET /api/orchestrations` | 1.04 MB | 305 KB |
| `GET /api/chats?limit=50` | 109 KB | 16 KB |
| `GET /api/accounts` | 58 KB | 4.4 KB |
| `GET /api/chats/:id` | 36 KB | 11.5 KB |
| `GET /api/overview` | 22 KB | 4.3 KB |

Nothing was compressed and nothing carried an `ETag`. In the orchestration list, `tasks[].result`
(405 KB), `tasks[].prompt` (224 KB), what the checks printed (212 KB) and `finalResult` (78 KB) were
93 % of the bytes. Home (the live widget and the pulse), the list page, the command palette, the
shell's live strip and the desktop tray all read that list, and every `orchestration.task` event
read it again within 100 ms: about a megabyte per task that moved, per open window.

## What changed

- **The orchestration list serves summaries.** `GET /orchestrations` answers
  `OrchestrationSummary[]` (`summarizeOrchestration` in `packages/core/src/orchestrator.ts`): each
  task without `prompt` and `result`, `hasFinalResult` instead of `finalResult`, and each check
  without its `output`. The verification `report` stays: it is a line, and a card shows it.
  `GET /orchestrations/:id` is unchanged and has everything. This follows what the work-item lists
  already did with descriptions ([work-items.md](work-items.md)). It is a breaking change to the
  list, taken on purpose: no screen that shows the list reads those fields, and the one e2e spec
  that did now reads the graph's own route.
- **A task that moves is moved in the cache.** `patchOrchestrationTask` writes the status, run and
  error an `orchestration.task` event carries into the cached list, and clears the activity of a
  task that ended. The list is then read again after 1 s, like the chat lists, instead of 100 ms.
  The graph's own page is still read at once. `health.changed` for a worker reads the list after
  1 s too.
- **Compression.** `@fastify/compress` with its defaults: brotli at quality 4 or gzip, for answers
  over 1 KB whose type compresses. The event streams are hijacked replies that no hook sees, so
  they are never compressed or buffered.
- **Tags and revalidation.** `@fastify/etag`, weak, computed on the JSON before it is compressed.
  Every `GET` under `/api` that has not set its own caching says `Cache-Control: private,
  no-cache`, so a browser may keep a copy but asks with its tag every time, and an unchanged
  answer is an empty `304`. Attachments keep their `immutable` header.

On the same data, the orchestration list goes from 1.04 MB to 111 KB as summaries, and to 21 KB
once compressed (brotli 4): about fifty times less per read, and a burst of task events now folds
into one read a second.

The tests are in `apps/api/test/wire.test.ts`, `packages/core/test/orchestrator.test.ts` (the
summary) and `apps/web/test/activity-feed.test.ts` (the patch and its delays).

## What was decided not to change

- **SSE stays; no WebSocket.** The traffic is one-way, SSE resumes by id on its own, and it passes
  through proxies and the tunnel as plain HTTP.
- **JSON stays; no MessagePack, Protobuf or CBOR.** Compression already removes most of what a
  binary format would save, and JSON is what the OpenAPI contract, `curl` and the agents that call
  this API read.
- **Settings stay in JSON, not TOML.** TOML's advantage is comments, and Claudio rewrites its
  settings files from the UI (`writeAtomic(JSON.stringify(…))`), which would drop them. The rule in
  CONTRIBUTING (settings-shaped documents in JSON files) stands.
- **LLM-oriented formats (TOON, ZON) are not for the browser.** Where they could matter is what
  Claudio puts in front of a model; that is weighed in
  [plans/agent-wire-format.md](plans/agent-wire-format.md).

## How the cache follows the feed

The regression audit of 2026-10-29 (§10) found the web losing events and asking for what it had.
The wiring was moved to this design, in `apps/web/src/lib/events.ts`:

- **An event never aborts.** `applyEvent` first schedules the stale reads and tells the listeners,
  then runs each cache patcher isolated, so a patcher that throws costs only its own write. Every
  patcher checks the shape it writes (`Array.isArray`) before it does. The reads of an
  orchestration's page (plan, tasks, workflow journal) sit under `['orchestration', id, …]`, outside
  the list's cache prefix, so a patcher for the list can no longer find a detail where it expects an
  array.
- **The MCP servers of a chat** have their own key, `['chat-mcp', id, execution]`, outside the chat's
  scope, with retry off: a chat event no longer asks the CLI again. `health.changed` refreshes it, a
  panel that shows the list reads it as it opens, and a new process has a new key. The server side
  answers `{ live: false }` without a control request when the session has been busy for more than
  2 s ([transcript-listing.md](transcript-listing.md)).
- **A resync is told.** When the feed reports missed events, `onResync` listeners run; notifications
  re-seed the waiting chats then.
- **"Today" is the server's day** (`SpendState.day`, `GET /usage` with no dates), not the browser's:
  `spend.changed` writes the meter and refreshes that day's usage.
- **Polling is the fallback only.** The fixed-interval polls (the checklist, a chat's tail, changes,
  memory, the Accounts page's rotation log) run only while the feed is down. The decision engine and
  the audit log have no event of their own, so they are refreshed on related events; a server event
  for each would be the clean design.
- **The chat list is read in pages.** `GET /chats` takes `limit` (200 by default) and `after`; the web
  reads the pages one after the other and stops when a page comes back short or repeats.
- **A render error is a page.** The root route has an `errorElement` (a localised `Empty` with a
  heading, [design-system.md](design-system.md)) instead of React Router's developer page; the setup
  wizard hides on a failed read only when the web holds no data; `lazyPage` asks a failed chunk once
  more and never pins the fallback for the session; blobs and uploads go through `request()`, so a
  401 or 421 is handled as everywhere else.

## Known gaps

- **Six connections per origin.** Over HTTP/1.1 a browser opens at most six connections to one
  origin, and each tab holds one or two event streams. From the third or fourth tab on the same
  origin, ordinary requests queue behind the streams. The ways out are HTTP/2 (which a browser only
  speaks over TLS, so behind a proxy or the tunnel) or one feed shared between tabs through a
  `SharedWorker` or a `BroadcastChannel`. Not done.

  Pages kept for Back count too: the back/forward cache freezes a page with its streams still
  connected, and the timer that parks a hidden tab's stream is frozen with it. So every stream the
  web opens lets go on `pagehide` and opens again on a `pageshow` from the cache, through
  `onBackForwardCache` (`packages/ui/src/lib/page-cache.ts`); a web test fails on an `EventSource`
  opened without it. Before the chat stream did this, opening a few chats in a row left the one in
  front with no connection to spare, and its next request waited in the browser's queue for half a
  minute.
- **The chat list still carries each chat's `executions`** (45 % of a page). It compresses well, and
  the list is now paged, but the same summary treatment would apply there.

## Related

[[work-items.md]] · [[transcript-listing.md]] · [[plans/regression-fixes-2026-10-29.md]] · [[desktop.md]] · [[tunnel.md]] · [[plans/agent-wire-format.md]] ·
[[plans/claudio-mcp-server.md]] · [[plans/mobile.md]]
