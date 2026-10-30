---
created_at: 2026-10-30T02:30:00Z
updated_at: 2026-10-30T02:30:00Z
tags:
    - performance
    - chats
    - sessions
    - api
---
# Transcript listing

How Claudio lists the Claude transcripts on the machine and the views built on them (`GET /overview`,
`/chats`, `/projects`, `/usage*`) without reading every transcript on every request. Built by the
`perf-listing` task of [the regression fixes of 2026-10-29](plans/regression-fixes-2026-10-29.md)
(D8, C7), from the evidence of [the audit's §9.1](reports/regression-audit-2026-10-29.md): on the
owner's machine (1 439 transcripts, 3.5 GB) those four routes re-listed and re-checked every transcript
once or twice per call, never shared a listing in flight, started a `claude agents --json` every 1.5 to
10 s, ran synchronous git on the request path, and after a restart parsed all 3.5 GB on the main thread.

## The listing (`packages/core/src/sessions.ts`)

`SessionStore.listSessions()` keeps what it learned of every transcript (`Listed`: inode, size, mtime,
the offset past the last complete line, the 64 bytes before it, and the summary fold over the lines up
to there) and looks at the disk in one of three ways:

- **Watched, nothing reported**: no I/O at all. The `SessionsWatcher` (`event-sources.ts`, a
  recursive `fs.watch` of the projects directory, on while anyone follows `/events`) hands every path
  it sees to `noteChanged()` before folding them into one `sessions.changed`.
- **Watched, something reported**: only the transcripts named (`<dir>/<session>.jsonl`) are looked
  at, and only the project directories named (`<dir>`) are listed again. A sidecar path (subagents,
  tool results) is ignored: the listing never reads sidecars.
- **Unwatched, or the watch could not say** (it started, stopped, errored, or reported no name): every
  directory is listed and every transcript is `stat`ed — one `stat` each, where the old code opened,
  `fstat`ed and closed each one — and only the ones whose inode, size or mtime changed are read.

While watched, a full look still runs every 60 s in the background (`SWEEP_EVERY_MS`), because an
inotify queue that overflows misses events without saying so. Callers that arrive while a look runs
share it (`refresh()`); a change reported during a look is read before that caller's answer.

A transcript that changed is read **only past where its last pass stopped**, when the 64 bytes before
that offset are still there (the file grew or was touched); one that shrank or was replaced is read
again whole. A half-written last line counts in the summary when it parses but stays out of the fold.
`summary(id)` (every `GET /chats/:id`, every send) answers from the same state, with no I/O while the
watcher says the file is current.

`generation` rises whenever what the listing returns changes; the usage routes key on it.

Paging a chat (`getSession`) keeps its own per-file index of entry offsets (`Paged`), for the 32
transcripts read most recently: the listing no longer holds an offset index of every transcript.

### `transcript_folds` (`db.ts`, `transcript-folds.ts`)

`transcript_folds (path PRIMARY KEY, ino, size, mtime_ms, end_offset, fingerprint, summary_json,
updated_at)` keeps each transcript's pass, so **a restart reads rows, not transcripts**: a file whose
stat matches its row and whose fold reached its end is not opened; one that grew is read from
`end_offset`. Rows are written on the next tick in one transaction (a cold start writes hundreds), and
only when the fold advanced; a row of a transcript that disappeared while the server was down is
deleted by the first full look. Refinements of C7: a `fingerprint` column (the 64 bytes before
`end_offset`, so a file rewritten in place is never continued) and `ino`/`mtime_ms` stored as `REAL`
(an inode past 2^53 reads back as the same JavaScript number). `summary_json` carries a version and the
server's time zone (spend is bucketed by local day); a row of another version or zone is folded again.

To keep a fold small enough to store, `UsageFold` (`usage.ts`) keeps only the newest 64 messages one
by one (`OPEN_MESSAGES`): the CLI writes the blocks of one message consecutively, so an older message
is final and goes into per-model and per-day totals. `toJSON()`/`fromJSON()` round-trip it exactly.

The first start of this build parses each transcript once (there are no rows yet); after that the
main thread parses only what was appended since the last pass.

## Who holds a session (`cliSessions`)

On Linux the CLI's sessions come from the record each CLI process keeps of itself,
`$CLAUDE_CONFIG_DIR/sessions/<pid>.json` (pid, session, cwd, kind, status), kept only while
`/proc/<pid>/stat` shows the start time the record names (`procStart`) in the same pid namespace
(`pidDomain`, `linux:<machine-id>:pid:[…]`): what `claude agents --json` reads, read without starting a
CLI (`processes.ts` `cliSessionRecords`). Elsewhere, or with a CLI that keeps no such folder, it is
`claude agents --json`. A read from the records is kept 1 s (served stale up to 5 s while a new one
runs); a spawned one 30 s (60 s). `forgetHolders()` drops it whenever a chat of ours starts or ends.
This refines C7's single "30 s TTL": the 30 s applies to the spawn; the records are cheap enough to
stay as fresh as the process table.

## The routes

- **`GET /overview`** (`Core.overview`): the chats' part — the counts of the list and the newest ten
  chats (`ChatService.glance`, which assembles only those ten) and what runs under the chats — is read
  once for every caller for 2 s and dropped by any bus event but `chat.activity` and
  `subagent.activity`. Running background commands, subagents and workflows are counted from the
  runtime for the chats with a process of ours (`ChatService.runningCounts`, through `toChildren`, as
  the inbox counts them) and from the files only for terminal-held sessions, which stream nothing to
  Claudio. The accounts and limits are read fresh on every call: they are the stores' own and cheap.
- **`GET /chats`**: every filter (origin, state, workers, assistant, project) is decided before a chat
  is assembled — the project from the chat's placement — and only the page is assembled
  (`ChatService.page`). A page is 200 chats unless `limit` says otherwise, 1 000 at most, newest
  activity first with the id breaking ties; `after=<updatedAt>~<id>` continues from a page's last chat,
  `x-next-cursor` carries it while there are more, `x-total-count` counts the matches. The web
  (`api.chats`) reads a list without a limit a page at a time and keeps one cache entry per filter.
- **`GET /projects`**: chats are counted from their placements (`ChatService.placements`), never
  assembled; project settings documents are parsed again only when their file changed
  (`ProjectSettingsStore.docOf`, judged by stat, dropped on write); `RepoIndex.configOf` and
  `RepoIndex.real` cache a repository's `[core]` keys and resolved paths.
- **`GET /usage`, `/usage/series`, `/usage/breakdown`** share one reading of what every chat spent
  per listing generation, dropped by `run.*`, `orchestration.*` and `project.*` events.
- **`GET /chats/:id/mcp`** answers `{ live: false }` without a control request while the chat's turn
  has run for more than 2 s: the CLI answers control requests between its own steps, and asking then
  held the request for as long as a step took (the 15 s maxima of the audit).

## No synchronous git on a request path

`repoFromGit` (`repos.ts`) is asynchronous. A directory only git can place is served from its stored
`repo_places` row (or as unknown) while git is asked in the background, once per directory at a time;
the next list reads the answer. `RepoIndex.remoteOf` does the same for a config the reader leaves to
git. The health monitor's working-tree fingerprint (`health-service.ts`) is read with async git off the
read that needed it: `read()` answers with what it knew, and the monitor's next pass sees the result.

## The thread pool

libuv's pool (four threads by default) queued every listing's file reads behind each other.
`UV_THREADPOOL_SIZE=16` is set, unless the environment names one, by the container's launcher and the
desktop shell when they start the server (`withServerThreadpool`, `launcher/protocol.ts`), by the
server's own entries (`apps/api/src/threadpool.ts`, imported first: in a bundle nothing runs before it)
and by the API's `dev` and `start` scripts, since under tsx the module graph is loaded through the pool
before any module runs (measured on 2026-10-30: an entry whose TypeScript imports go through tsx's
loader kept the default pool, while a bundle-like entry that sets the variable got 16 threads).

## Measuring

`node scripts/listing-bench.mjs` writes a corpus (1 400 transcripts of 200 lines in 660 directories, 20
git projects with a worktree each), starts an isolated server on it (its own data and config dirs, a
free port, the fake CLI, nothing of the person's install), and times each route: the first request,
warm sequential requests, the four at once, and the first request after a restart on the same data dir.
By default a client follows `/events`, as the web and the tray do (so the watch is on); `--unwatched`
measures a server nobody follows, and `--root <checkout>` runs another checkout's server on the same
corpus. `/chats*` is every chat read a page at a time, as the web reads a list without a limit.

On 2026-10-30, base 0.11.0 (`810925e99`) against this change, run one after the other on the same
machine under the same load (a load average of 42 to 46 from other work), with a client on `/events`,
in milliseconds:

| Route | before warm p50 / p95 | after warm p50 / p95 | before first after restart | after first after restart |
|---|---|---|---|---|
| `/overview` | 1 819 / 4 784 | 9 / 56 | 5 522 | 181 |
| `/chats` (one page; before: every chat) | 1 282 / 3 446 | 49 / 104 | 543 | 59 |
| `/chats*` (every chat) | 1 579 / 2 972 | 214 / 568 | 504 | 300 |
| `/projects` | 2 329 / 3 898 | 47 / 150 | 661 | 66 |
| `/usage` | 1 199 / 3 266 | 12 / 105 | 234 | 34 |

The four at once: p50 5 022 ms before, 129 ms after. The machine's load made single runs vary by up
to five times; over five runs of this change `/overview`'s warm p50 stayed between 6 and 46 ms with a
client on `/events` and between 6 and 266 ms without one, against the 150 ms of the plan's Checklist.
The corpus is 1 400 transcripts of 154 MB; the owner's 3.5 GB widens the gap after a restart, where
the old listing parsed every byte again.

## Related

[[plans/regression-fixes-2026-10-29.md]] · [[reports/regression-audit-2026-10-29.md]] · [[cli-surfaces.md]] · [[rest-api.md]] · [[api-wire.md]] · [[desktop.md]]
