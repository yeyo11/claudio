---
created_at: 2026-11-15T12:00:00Z
updated_at: 2026-11-16T20:00:00Z
tags:
    - plan
    - study
    - architecture
    - restart
    - desktop
    - updates
    - orchestration
    - in-progress
---
# Study: work that keeps running when Claudio closes, restarts or updates

**Status: in progress. The owner approved approach D on 2026-11-15 ([decisions](#the-owners-decisions-2026-11-15));
the spikes (t2) are done, layer 3 (t1) is built ([t1's outcome](#outcome-of-t1-layer-3-2026-11-15)), and
layer 2 starts and runs parked processes behind a switch ([t3's outcome](#outcome-of-t3-parked-processes-start-and-run-2026-11-16)),
and a restart adopts them ([t4's outcome](#outcome-of-t4-adoption-2026-11-16)).**

## The problem, in the owner's words

On 2026-11-15 the owner wrote (translated):

> When Claudio is closed or restarts (for example after an update) it looks like a catastrophe:
> everything stops — subagents, chats, orchestrations. It cannot be like that: work should keep
> running in the background even if the app is closed. This should be relatively simple, since most
> of it is Claude Code processes, which already allow running in the background. Don't look for a
> patch, look for the real solution.

The study follows his method for studies
([process-isolation.md](process-isolation.md) §1, memory `feedback-target-architecture-not-patches`):

1. Stop the bleeding.
2. Measure.
3. Design the end state, with the local desktop as its degenerate case.
4. Use what the vendor ships first.
5. Name the spikes.

**Confidence.** Every claim carries one of three marks:

- **verified**: read in the code at the cited line, measured, or quoted from the vendor's page.
- **inferred**: deduced, not reproduced.
- **not determined**: the evidence is missing.

## Summary

- **Why everything dies (verified).** Today one process, Claudio's server, owns every Claude Code
  process through its stdin and stdout pipes (`packages/core/src/chats.ts:2545`). The server itself
  is a child of the Electron window process, and closing the window quits the app
  (`apps/desktop/src/main.ts:928`).
  - A clean stop (closing the window, quitting, an update) runs `stopAll`, which ends every CLI on
    purpose (`packages/core/src/index.ts:4139`, `chats.ts:1920`).
  - A crash ends them anyway: the reader of their pipes is gone. Measured with a stand-in, the
    child read EOF on stdin about 100 ms after its parent was killed, and died on its next write.
  - Everything the CLI holds inside a turn goes with it: the in-flight tool call, subagents,
    background Bash, MCP servers. Only the conversation survives, in the transcript, for a later
    `--resume`.
- **The vendor already ships the shape, but not for programs (verified).** Claude Code has its own
  background supervisor (`claude --bg`, `claude agents`, `claude daemon`). It keeps sessions alive
  when the terminal closes and hands them over across its own updates. But `--bg` "can't be combined
  with `-p`", and its job files "are not a stable interface". By the one rule Claudio cannot drive
  it.
  - What the vendor does document for programs is enough to build the same thing:
    - the stream-json protocol over stdin and stdout;
    - re-sending `initialize` "after a transport gap, such as reattaching to a session after a
      disconnect", whose answer carries `pending_permission_requests`;
    - `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` for the turns a restart did cut.
- **The end state (recommended).** Three layers, each covering what the one below cannot:
  1. **A control plane that outlives the window.** The desktop runs Claudio the way the container
     already does: the unreplaceable launcher supervises the server, and Electron becomes only a
     window and a tray that connect to it. Closing or quitting the window stops nothing.
  2. **CLI processes that outlive the server.** Each CLI is started detached, with its stdin a FIFO
     it holds open itself and its stdout an append-only file, in its own systemd scope. A server that
     restarts (an update, a crash) re-attaches: it tails the file from its committed offset, writes
     to the FIFO, and re-sends `initialize`. The CLI never notices.
     - This holds with no runner process at all: measured, the wrapper costs about 2 MB per CLI,
       against about 51 MB for a Node runner.
  3. **A lossless resume** for what cannot survive: a reboot, a dead hand-over, an expired lease.
     The documented `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` continues the cut turn, under the limits
     that already exist.
- **Order.** Layer 3 first, because it stops the bleeding cheaply and is the fallback forever. Then
  layer 2, the foundation; without it, a daemon still dies on each update. Then layer 1. This is
  the parked [process-isolation](process-isolation.md) study's "runner + host-scope provider",
  reached with no runner: the scope per process is its first provider.

## 1. Diagnosis: what dies today, and why

### The process tree (verified, read-only on the owner's machine)

Read on the owner's running app with `ps` and `/proc` (nothing was signalled):

```
/opt/Claudio/claudio                      pid 651124  (Electron main, in app-claudio-651124.scope)
└─ /opt/Claudio/claudio …/server/server.mjs   pid 798679  (ELECTRON_RUN_AS_NODE, stdio pipes + IPC)
   ├─ claude -p --input-format stream-json …  pid 904561  (stdin/stdout: socket pairs owned by 798679)
   │  └─ /opt/Claudio/claudio …/server/mcp.mjs   (Claudio's MCP server, a child of the CLI)
   └─ claude -p …                             pid 907001
```

What this shows:

- **One process group and one session for everything.** All of them share process group and
  session 2813, gnome-shell's.
- **The CLI's stdin and stdout are socket pairs.** libuv's `stdio: 'pipe'` creates them, and the
  server holds the other end (`/proc/904561/fd/0,1`).
- **The CLI ignores SIGPIPE** (`SigIgn` bit 13), which it inherits from Node. With its reader gone,
  a write fails with `EPIPE`, which the CLI then has to handle itself (**not determined**: the vendor
  does not document what it does with it).
- **The user manager lingers** (`Linger=yes`) and runs systemd 259. That matters for a daemon that
  outlives the window (D3).

### What each event does

| Event | Path in the code | What happens to the CLI processes |
|---|---|---|
| **(a) Closing the window** | `window-all-closed` → `app.quit()` (`apps/desktop/src/main.ts:928`); `before-quit` → `shutdown()` → `stopServer()` (`main.ts:920-926`, `880-889`); `ServerProcess.stop()` sends SIGTERM, then SIGKILL after 5 s (`apps/desktop/src/server-process.ts:196`) | The server's SIGTERM handler (`apps/api/src/standalone.ts:31-34`) → `close()` → `core.shutdown()` → `runtime.stopAll()` (`packages/core/src/index.ts:4139`): every chat gets SIGTERM, then its whole tree gets SIGKILL after the grace (`chats.ts:1920-1957`). Pending permission prompts are denied with "the wrapper is shutting down" (`permissions.ts:11`). [desktop.md](../desktop.md) says it in so many words: "Closing the window still quits the app". |
| **(b) Quitting** (tray, menu, logout) | Same `before-quit` path | Same as (a) |
| **(c) An update or restart** | Payload update: `serverUpdates.onRestart` → `close()` → exit 75, and the shell's `PayloadHost` starts the new server (`apps/api/src/server.ts:184-188`, `apps/desktop/src/main.ts:165-216`). Shell update or "restart" from Updates: exit 76 → `relaunchShell()` (`main.ts:209-213`, `450-456`). Container: the launcher restarts on 75 (`packages/core/src/launcher/machine.ts:229-256`) | `close()` → `stopAll`, as in (a). The update routes answer `409 update.live-work` while chats are running and offer "Restart when nothing is running" ([updates.md](../updates.md)). That defers the loss, it does not avoid it. |
| **(d) A server crash** (SIGKILL, OOM, a wedged loop the container's healthcheck kills) | Nothing runs. The desktop shell shows "The Claudio server stopped unexpectedly" and does not restart it (`main.ts:214-216`). The container's launcher returns the code, so the restart policy restarts the whole container (`machine.ts:256`) | The CLI reads EOF on stdin and gets EPIPE on its next stdout line. Measured with a stand-in in §4, M1: dead within about 200 ms. A real CLI that ignores SIGPIPE may live a little longer: Claudio has code for "a CLI process from a previous wrapper is still working on it" (`chats.ts:650-668`, `718-725`) and refuses to resume beside it. But its output has nowhere to go. |
| **Reboot or logout** (without linger) | — | Everything ends. The vendor's own background sessions end too: "Shutting down or restarting your machine stops running background sessions" ([agent view](https://code.claude.com/docs/en/agent-view)). |

### What is recoverable and what is lost (verified unless marked)

| State | Where it lives today | After (a)–(d) |
|---|---|---|
| The conversation | The CLI's transcript `$CLAUDE_CONFIG_DIR/projects/<cwd>/<session>.jsonl` | **Kept.** `--resume <id>` continues it (`providers/claude-code/args.ts:24`) |
| The chat's record, its executions, the orchestration rows, flow runs, waits | SQLite (`db.ts`) | **Kept.** The open execution is closed as `interrupted by a wrapper restart` (`live-chat.ts:761`) |
| The turn in flight | The CLI's memory | **Lost.** The vendor: SIGTERM "leaves the turn that was in progress unfinished and records no result for it" ([headless](https://code.claude.com/docs/en/headless#stop-a-run-with-sigterm)). A person's chat stays `interrupted` until someone writes in it |
| Subagents and background Bash inside the turn | Children of the CLI | **Lost.** The vendor: "Background tasks are automatically cleaned up when Claude Code exits… processes that detached from the task's shell… stop too" ([interactive mode](https://code.claude.com/docs/en/interactive-mode)). On resume they appear only as a note that they did not finish ([sessions](https://code.claude.com/docs/en/sessions)) |
| MCP servers of the chat (stdio) | Children of the CLI | **Lost**, started again with the next process |
| Pending permission prompts | `PermissionBroker`, in memory only (`permissions.ts`) | **Lost**, denied at shutdown |
| The chat's API credential (`CLAUDIO_API_TOKEN`) | `ChatTokenStore`, in memory and on purpose: "a restart of the wrapper revokes every chat token by construction" (`security/chat-tokens.ts:25-33`) | **Lost**, minted again at the next spawn |
| The pending turn of a chat at its limit | Since t8 of [limit-resume-and-credits](limit-resume-and-credits.md#outcome), stored in the wait row | **Kept**, replayed after a restart |
| Graph orchestration tasks | Rows | **Re-run.** The interrupted tasks run again as new attempts, using up `maxAttempts` (`orchestrator.ts:812-850`, `1404`) |
| Workflow orchestrations | Rows | **Stopped.** They wait for `resume()` unless a limit wait holds them (`orchestrator.ts:812-830`) |
| Flow runs | Rows | **Re-queued**, up to `MAX_FLOW_RESTARTS` (`flow.ts:2113-2140`) |
| Terminals (PTYs) | The terminal host, a separate process the server lets go | **Lost** on purpose (`terminals/service.ts:374-390`) |

**What costs the owner money and time.** Every restart re-does the interrupted turn from its last
transcript line, spending tokens again. Long background commands (test suites, builds) are killed
and re-run. Orchestration tasks spend an attempt. A person's chats wait for someone to notice.
Payload updates come often, so this repeats.

## 2. Vendor first: what Claude Code documents (verified on 2026-11-15, CLI 2.1.322)

| Need | Documented? | Source and quote | Usable by the one rule? |
|---|---|---|---|
| Resume a conversation after the process is gone | Yes | `-r, --resume`, `--session-id`, `--fork-session` (`claude --help`); [sessions](https://code.claude.com/docs/en/sessions): restarting your process is a stated reason to resume | Yes (in use) |
| Two processes on one session | Documented as **unsafe**: "both write to one transcript. When you resume that session later, messages from one of them can be missing" ([sessions](https://code.claude.com/docs/en/sessions#branch-a-session)) | — | It rules out a "start a second CLI beside the old one" design |
| Continue a turn a restart cut | Yes: `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` "to automatically resume if the previous session ended mid-turn. Used in SDK mode so the model continues without requiring the SDK to re-send the prompt"; `CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS` bounds it: "Spawn scripts for long-running agents can set this so a restart against an old transcript doesn't re-run a stale prompt" ([env-vars](https://code.claude.com/docs/en/env-vars)) | Env vars | **Yes.** Claudio does not use it today (no match in `packages/core/src`) |
| Re-attach to a **running** CLI after a transport gap | Yes, at the protocol level: `reinitialize()` "Re-sends the `initialize` control request to the running CLI… Use it after a transport gap, such as reattaching to a session after a disconnect, so pending permission requests reach your `canUseTool` callback again" (CLI ≥ 2.1.195). The `initialize` response carries `pending_permission_requests`: "the permission requests that this Claude Code process has issued and not yet resolved" (≥ 2.1.268). A repeated initialize over stdin returns `hooks_applied: true` ([Agent SDK TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript)) | The stream-json control protocol | **Yes.** The transport (who holds stdin and stdout) is the program's, and the SDK's `spawnClaudeCodeProcess` exists "to run Claude Code in VMs, containers, or remote environments" |
| A socket or port to re-attach to a `-p` process | **No** | — | No |
| The CLI's own background supervisor | Documented for people: `--bg` "Start the session in the background and return immediately", `claude attach/logs/stop/respawn/agents`, `claude daemon`. "A separate supervisor process runs them, so you can close agent view, close your shell… and your dispatched work keeps going"; "Session state persists on disk through auto-updates and supervisor restarts" ([agent view](https://code.claude.com/docs/en/agent-view)) | But `--bg` "Can't be combined with `-p`/`--print`" ([CLI reference](https://code.claude.com/docs/en/cli-reference)); `claude agents --json` is "the supported way to read session state from outside"; "The files under `~/.claude/jobs/<id>/` are not a stable interface"; there is no documented way for a program to stream from or write to a background session | **Not for driving.** Watch it: if the vendor documents stream-json input for background sessions, it replaces layer 2 (D10) |
| Inbox socket per session | Documented: `CLAUDE_CODE_MESSAGING_SOCKET`, posts messages into a session ([cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)) | Message delivery, not attach | Not a transport for the stream |
| Signals | SIGTERM: exit 143, the turn unfinished, Bash trees terminated; "To end the turn instead, send SIGINT" ([headless](https://code.claude.com/docs/en/headless#stop-a-run-with-sigterm)). SIGHUP, `nohup` and `setsid`: **not documented** | — | Use only SIGINT and SIGTERM, their documented meanings |
| stdin closing | Only after a turn: "After Claude finishes its turn and stdin has closed, a `claude -p` run can stay open to wait for background work" (10-min ceiling, `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`). Mid-turn: **not documented** | — | Layer 2 must never let stdin close |
| Transcript path | Path documented, format "internal to Claude Code and changes between versions" ([sessions](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored)) | — | As today ([cli-surfaces.md](../cli-surfaces.md)) |

**Conclusion.** No documented feature lets a program leave a `-p` session to the vendor's supervisor.
The documented protocol does let a program keep the process alive itself and re-synchronise after a
gap. That is layer 2, and it needs no new CLI surface: it is the one Claudio already uses, plus a
re-sent `initialize`.

## 3. Prior art and pitfalls

Researched in English, Chinese, Russian, French and Spanish. The non-English searches found nothing
beyond the English sources.

| Who | How they survive a UI or daemon restart | Lesson for Claudio |
|---|---|---|
| **Claude Code's supervisor** ([agent view](https://code.claude.com/docs/en/agent-view)) | One supervisor owns per-session processes. On update it restarts and moves idle sessions over without interrupting working ones. If it dies, "your sessions stop unless a new supervisor connects within about a minute" | The same shape as layer 2, with a bounded hand-over window (D6) |
| Claude Code [#79569](https://github.com/anthropics/claude-code/issues/79569) | Its daemon, run as a user unit, spawned its successor in the same cgroup. systemd's `KillMode=control-group` killed the successor and every worker when the old main pid exited | **Never keep CLIs in the server's or launcher's cgroup.** One scope per CLI (D9) |
| Claude Code [#84468](https://github.com/anthropics/claude-code/issues/84468), [#90867](https://github.com/anthropics/claude-code/issues/90867), [#72413](https://github.com/anthropics/claude-code/issues/72413) | The daemon respawned session hosts without `--resume`, so context was lost. A desktop update relaunch killed 9 sessions. Jobs that were children of the Electron renderer died when it reloaded | The vendor hit the same failures. Layer 3 must always resume; nothing may hang from the window |
| **Docker live-restore** ([docs](https://docs.docker.com/engine/daemon/live-restore/)) | Containers keep running while `dockerd` restarts; a shim holds them. Limits: patch upgrades only, and output goes into a 64 KB FIFO that blocks the container when nobody reads it | The closest model. Version the on-disk contract (D4); prefer a file for stdout over a FIFO, so a long gap does not block the CLI |
| **systemd** ([systemd.kill](https://man.archlinux.org/man/systemd.kill.5.en), [fd store](https://systemd.io/FILE_DESCRIPTOR_STORE)) | `KillMode=control-group` kills the unit's whole cgroup on stop or restart. The fd store keeps fds across a *restart* job, but Node has no `sd_notify` with fds, and the CLIs would still die with the cgroup | The fd store is rejected (§5, F). `systemd-run --user --scope` per CLI escapes the server's cgroup, and the owner's user manager lingers |
| **tmux / Claude Squad / agent-deck / Emdash** | The tmux server is detached from any client; sessions survive the UI but not a reboot. Emdash documents that resume is a separate mechanism ([emdash](https://emdash.com/docs/tmux-sessions)) | tmux holds a TTY. Driving `claude` through it is terminal scraping, which the one rule forbids. The idea of detaching is right; the TTY is not |
| **Superset's terminal daemon** ([write-up](https://paradev.com/cs/blog/terminal-daemon-deep-dive)) | An Electron app moved its PTYs out of Electron main into a detached daemon on Electron's own Node (`ELECTRON_RUN_AS_NODE`), with NDJSON over Unix sockets and separate sockets for control and output. It never kills on disconnect, and keeps history on disk for a "cold restore" | Their lesson: "version the protocol from day one". It matches layer 1, which runs on the same runtime the desktop already uses for the server |
| **VS Code Server, Zed remote** ([#6326](https://github.com/microsoft/vscode-remote-release/issues/6326), [zed](https://zed.dev/docs/remote-development)) | One server per client version in a versioned directory; old ones pile up. Zed requires an exact version match | Version skew is real: the UI may be newer than the daemon. Claudio's payload overlays already live in `<dataDir>/app/<version>`, so keep one while a live CLI references it |
| **Happy** (slopus) | A Node daemon writes its pid, version and port to `daemon.state.json`; after an upgrade with a version mismatch, the fix is to stop and start it (secondary sources: [deepwiki](https://deepwiki.com/slopus/happy-cli/3.2-daemon-system)) | A state file is how the window finds the daemon (layer 1). A version mismatch must be handled automatically, never left to the person |
| **Ollama desktop** ([FAQ](https://docs.ollama.com/faq)) | The tray app manages `ollama serve`; "Restart to update" stops it | The pattern Claudio has today, and the one the owner rejects |
| **pm2** | `pm2 update` replaces its daemon and *restarts* the apps from a dump (**not confirmed**) | A "restore" that restarts is layer 3, not survival |

**Pitfalls to design against:**

- **Orphans when the holder dies.** In this study's own first runner attempt, killing the runner
  left the stand-in CLI running, reparented to the user manager. A holder must end what it holds,
  and only a cgroup catches everything (process-isolation §2).
- **A pipe ties the child's life to its reader.** Node's docs: a detached child survives the parent
  only when its stdio is not connected to the parent
  ([Node](https://nodejs.org/api/child_process.html#optionsdetached)).
- **A pipe read nobody reads blocks the writer at 64 KB.** This is Docker's FIFO limit.
- **Double ownership after a restart.** Two servers writing one CLI's stdin, or two CLIs on one
  session, which the vendor documents as losing messages.
- **The binary replaced under a running daemon.** apt replaces files by rename, so a running
  process keeps its old inodes. A file loaded lazily after the update, though, is the new version's.
  - **AppImage (inferred):** its mount disappears when the AppImage process exits, so a process
    running from the mount can fault. Nothing that outlives the window may run from the mount (S5).
  - **Electron:** `before-quit` and `will-quit` do not always run (SIGINT goes to `app.quit`,
    [electron#5273](https://github.com/electron/electron/issues/5273)).
- **Version skew between the window and the daemon,** and between a running CLI's old `mcp.mjs` and
  a newer API.
- **Paid work with nobody watching.** If the CLIs outlive the control plane, nothing enforces
  budgets, `maxParallel`, the spend cap or permission timeouts.

## 4. Measurements

All run in `/tmp/survive-spike` with a stand-in CLI: a Node script that streams five lines per input
line, 200 ms apart, and logs its stdin, write errors, signals and exit. Every process started was
ended by pid and none was left. The owner's app was only read. No tokens were spent.

**M1. Today's shape: the server owns the pipes.** A parent spawns the stand-in with
`stdio: 'pipe'`, as `chats.ts:2545` does, writes one turn, and is SIGKILLed 0.4 s in.

```
+0 ms    start
+115 ms  stdin end            ← the reader of our stdin died with the parent
+330 ms  stdout error EPIPE   ← the next line of the turn has nowhere to go
+330 ms  got SIGPIPE → exit
```

The turn dies at its next output line. The real CLI ignores SIGPIPE, so it gets only the EPIPE; what
it does then is **not determined**.

**M2. A runner holds the pipes.** The runner is a Node process, started detached in its own session.
It writes each stdout line to a log with a sequence number before relaying it, and serves clients on
a Unix socket. The test:

1. Server 1 started the runner, sent `turn-A` and was SIGKILLed after 1.0 s, at line 3 of 5.
2. Lines 4 and 5 were written with nobody connected.
3. Server 2 connected with cursor 2. It received lines 3–5 from the log, then sent `turn-B` and
   received lines 6–10 live.

Throughout, the CLI kept the same pid (2631612) and started once.

- **Cost:** the runner's RSS was **51 MB** (Node 24); the stand-in's was 5 MB.
- **A pitfall found:** the first version of the runner died when server 1's socket reset, because
  readline re-emits the socket's error and nothing handled it. The CLI went down with the runner. A
  runner must never die of a client.

**M3. No runner: the CLI holds its own FIFO.** The stand-in is started as
`setsid sh -c 'exec 0<>in.fifo; cli >>out.jsonl 2>>err.log; echo $? > exit.code'`. Linux allows a
FIFO opened read-write ([fifo(7)](https://man7.org/linux/man-pages/man7/fifo.7.html)), so the CLI
itself is always a writer of its stdin and never reads EOF. Its stdout is an append-only regular
file, so a write never fails for lack of a reader.

1. The server wrote `turn-A` to the FIFO and was SIGKILLed 0.5 s in.
2. All five lines of `turn-A` reached `out.jsonl` with no server alive.
3. A new writer sent `turn-B`, and its lines followed.

Throughout, the CLI kept one pid, with `fd/0 → in.fifo` and `fd/1 → out.jsonl`. The `sh` waiting for
it used **2 MB** RSS and recorded the exit code when the CLI was stopped.

**M4. How much a CLI writes (upper bound only).** `/proc/<pid>/io` of the owner's two live CLIs
shows `wchar` of 0.35 GB and 6.4 GB over about 11 h. That counts every write the process made:
stdout, the transcript, its pipes to tools and MCP. The stdout share is **not determined**; S6
measures it, because it sizes layer 2's disk use.

## 5. Options

| | What it is | (a) window closed | (b) app quit | (c) update / restart | (d) server crash | Reboot | Complexity | One rule |
|---|---|---|---|---|---|---|---|---|
| **A** | **Daemon:** the launcher supervises the server outside Electron; the window is a client | Survives | Survives (D1) | **Dies**: the server still owns the pipes | **Dies** | Dies | Medium: desktop lifecycle, discovery, credential | No change |
| **B** | **Detached CLIs:** FIFO + append file + scope per CLI; the server re-attaches | Server stops, CLIs park, the lease expires → stopped (today's shell) | Same as (a) | **Survives** if a server re-attaches within the lease | **Survives** if one is restarted within the lease | Dies | High: adoption touches the chat runtime, tokens, admission, the fold | Yes: stream-json plus a re-sent `initialize` (documented) |
| **C** | **Lossless resume:** auto-continue every cut chat with `--resume` + `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` | Dies, continues on the next start | Same | Dies, continues seconds later | Dies, continues when restarted | Continues at the next start | Low | Yes: documented env vars |
| **D = A + B + C** | **Recommended end state** | Survives | Survives | Survives | Survives | Continues (C) | High, in phases | Yes |
| E | Hand sessions to Claude Code's own `--bg` supervisor | — | — | — | — | — | — | **No**: `--bg` excludes `-p`, and program I/O is undocumented |
| F | systemd fd store keeping the pipes across a restart of a server unit | — | — | Survives only with `KillMode=process`, which the man page advises against | — | — | High, plus a native module | Yes, but desktop-only and fragile |
| G | A Node runner holding all pipes (M2) instead of B's FIFOs | as B | as B | as B | as B | — | High; 51 MB, and one process whose death takes every CLI | Yes |

**What is lost in each "survives".** In A, B and D, nothing is lost: the turn, its subagents,
background Bash and MCP servers are the CLI's own and keep running. With C, the cut turn's work is
re-done (tokens again), background Bash and background subagents are lost, as the vendor documents,
and permission prompts are asked again.

**Why not B alone.** With today's shell, closing the window stops the server. Parked CLIs would run
on with nobody enforcing budgets, the spend cap, `maxParallel` or permission timeouts. For paid
automation, a CLI may outlive the control plane only for a bounded hand-over, so B needs A.

**Why not A alone.** The daemon still has to restart on every payload update, and every restart
kills what it owns. The owner's case (c) stays a catastrophe.

**Why C regardless.** A reboot, a lease that expires or a hand-over that fails must not strand work.
And C is the cheapest way to stop the bleeding now.

## 6. The recommended end state (D)

### Layer 1: the control plane outlives the window (A)

- **The desktop takes the container's shape.** The launcher (`packages/core/src/launcher/`,
  `node:*` only, "the part of Claudio an update cannot replace") supervises the server. Electron
  becomes a window and a tray that connect to it.
  - Electron starts the launcher if none answers, in a transient user unit:
    `systemd-run --user --unit=claudio-<data-dir hash> --property=Restart=on-failure`. Without a
    user manager, it starts it with `setsid` (D2).
  - The data-dir lock (`data-dir-lock.ts`) already guarantees one server per data directory.
- **Discovery and credential.** The daemon writes `<dataDir>/daemon.json` (0600): its pid and start
  time, its URL, its version and protocol version, and a desktop credential that replaces today's
  per-launch `CLAUDIO_DESKTOP_TOKEN`.
  - The keyring key (`CLAUDIO_SECRET_KEY`, from Electron's `safeStorage`) can only come from
    Electron. The window hands it to the daemon when it starts it, so a daemon is never started at
    login without the app (D2).
- **Closing the window** leaves the tray and the daemon running.
- **Quitting** asks when work is live (D1): "Keep working in the background" or "Stop all work and
  quit". The tray and a desktop notification say that work goes on.
- **Version skew.** The window shows whatever version the daemon serves, because the page comes
  from the daemon. Shell and daemon check their protocol version in `daemon.json`. A newer shell
  with an older daemon asks the daemon to restart onto its payload; with layer 2 that loses nothing.
- **The port is stable.** Running CLIs carry `CLAUDIO_API_URL` in their environment, so a server
  that adopts processes must bind the URL they hold. Today a taken port makes the server pick
  another (`apps/api/src/server.ts:131`, `portFallback`). With adopted processes it must refuse to
  move instead.

### Layer 2: CLI processes outlive the server (B, "parked processes")

- **Start.** Every CLI process, which `spawnProcess` already starts in one place
  (`chats.ts:2464`), starts through a wrapper:
  `systemd-run --user --scope --unit=claudio-cli-<chat>-<n> -- sh -c 'exec 0<>in.fifo; claude … >>out.jsonl 2>>err.log; echo $? >exit.code'`.
  The files live in `<dataDir>/procs/<id>/`, mode 0700/0600. Without a user manager (the container)
  the wrapper runs under `setsid` (D9).
  - The scope takes the CLI out of the server's cgroup (#79569) and is how it is stopped: the whole
    tree, double forks included. It is also the host-scope provider of
    [process-isolation](process-isolation.md) §5, with no limits, per that study's D1.
- **A row per process.** A SQLite table `cli_processes`, added by a migration in `db.ts`, holds:
  - the chat, the pid and its start time, the scope, the directory;
  - the owner (server id and lease expiry);
  - the stdout offset the fold has committed, and the last stdin sequence;
  - the token hash, the payload dir it references, and the CLI version.

  It holds rows, not a JSON file: two processes (the old and the new server) touch it, and a takeover
  is a guarded update (`UPDATE … WHERE owner = ? AND lease_until < ?`) or a `BEGIN IMMEDIATE`, as
  `flow.ts` does.
- **Running.** The server tails `out.jsonl` (inotify, with polling as the fallback) into the same
  `session.readLine` fold, and writes stdin through the FIFO.
  - Every write also goes to `in.jsonl` with a sequence number, so a successor knows which control
    responses were sent.
  - At each `result` (a turn boundary) the server commits the offset and frees the bytes before it
    with `fallocate --punch-hole`. The file keeps its offsets and the disk holds only the open turn
    (S6).
- **A restart.** `ChatManager.restore` (`chats.ts:650`) adopts each row whose pid and start time
  still match. That replaces today's "stray" path (`chats.ts:656-697`), which refuses to resume
  beside such a process. Adoption:
  1. Take the lease.
  2. Replay `out.jsonl` from the committed offset through the fold. That rebuilds the open turn's
     volatile state: `turnOpen`, the foreground calls, the activity, the branches.
  3. Re-send `initialize`. The answer's `pending_permission_requests` goes to the
     `PermissionBroker`, idempotent per request id, as the vendor asks.
  4. Count the slot in admission, and re-arm the permission timeouts.

  Orchestrations and flows already skip a chat that is busy (`flow.ts:2116`), and `recover()` must
  treat an adopted task as `running`, not `interrupted`.
- **A graceful stop no longer stops chats.** `core.shutdown()` detaches: it ends its tails and
  releases the leases. It stops a chat only when a person asked to "stop all work" or the chat is
  not parkable (D1).
- **The lease.** The wrapper's `sh` also runs a watchdog. When the lease file is older than the
  hand-over window (D6), it sends **SIGINT**, which the vendor documents as ending the turn rather
  than abandoning it, and the chat is then layer 3's.
  - **Only while a turn is open** (S2, [parked-cli-processes](../decisions/parked-cli-processes.md)):
    SIGINT on an idle `-p` CLI ends the process (exit 0). The watchdog acts only when the tail shows
    a turn with no `result` yet; an idle parked CLI waits for the lease like any other.
- **What has to change to keep running across a restart:**
  - **Chat tokens** are in memory by design. Their hashes go to the row, bound to the pid and start
    time, and are revoked when the process ends (D5).
  - **Payload dirs** referenced by a live CLI are kept: `mcp.mjs` comes from the payload's directory
    (`server.ts`, `bundledMcp`).
  - `removeChatExtrasConfigs` at restore (`chats.ts:714`) must spare adopted chats.
  - The guard's hook command is the shell's `guard.mjs` and calls no API (`guards/`). It keeps
    working across the gap (**verified** in S3, 2026-11-15: the second hook line was written after the gap).

### Layer 3: lossless resume for what still dies (C)

- Every cut chat is respawned with `--resume` and
  `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` plus `CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS`.
  Orchestrations and flows keep their existing gates: `maxAttempts`, `MAX_FLOW_RESTARTS`, budget and
  the spend cap. A person's chats follow D7.
- **What it covers:** a reboot, an expired lease, a CLI whose row cannot be adopted (a different
  data-dir layout), and the container whose pod or container restarted. In the container the
  launcher already survives payload restarts, so layer 2 covers those.

### Updates under D

| Update | What restarts | Effect on work |
|---|---|---|
| Payload (in-app, frequent) | The server (exit 75); the launcher restarts it | None. The CLIs park for seconds and are adopted. `409 update.live-work` remains only for open terminals |
| Shell `.deb` (apt) | The window, at the person's convenience. The launcher runs on the old inodes until it restarts onto the new one (protocol check) | None |
| Launcher's own protocol | The launcher. The CLIs sit in their own scopes | None, within the lease |
| Claude Code | Nothing. Running CLIs keep their version (`~/.local/share/claude/versions/<v>`); new processes start on the new one | None, as today |
| Reboot | Everything | Layer 3 |

### What does not change

- **The one rule.** Stream-json over stdin and stdout, as today; `initialize` re-sent, as the
  vendor documents for a transport gap; `--resume` and two documented environment variables.
  [cli-surfaces.md](../cli-surfaces.md) gains two rows: "Re-attach to a running CLI after a server
  restart" and "Continue a turn a restart cut".
- **Paid-automation limits.** Budgets, `maxParallel`, bounces, the spend cap, the denied
  `git push` and the person-only move to Done all live in the control plane, which layers 1 and 2
  keep alive. The lease bounds the time any CLI runs without it.
- **Security.** `procs/` is owner-only. An agent running as the same user could write into another
  chat's FIFO, a new capability, close to the vendor's own inbox socket. `procs/` joins the guards'
  protected paths, and a confined chat never sees the data dir (risk R3).

## 7. Decisions for the owner

**D1. What "keep running" means when the person quits.**

- Options:
  - (a) Always keep running; the tray's Quit offers "Stop all work".
  - (b) Ask on quit when work is live, defaulting to "keep working".
  - (c) A setting.
- **Recommendation: (b).** Closing the window never stops anything.

**D2. Who runs the daemon on the desktop.**

- Options:
  - (a) The window starts the launcher in a transient `systemd-run --user` unit, falling back to
    `setsid`.
  - (b) A user unit the `.deb` enables at login. It would need the keyring key without Electron, so
    the daemon would read the Secret Service itself.
  - (c) Plain `setsid` everywhere.
- **Recommendation: (a).** Nothing to install, and `Restart=on-failure` for free.

**D3. Logout.** The owner's user manager lingers, so a daemon in a user unit outlives logout.

- Options:
  - (a) Work continues after logout.
  - (b) Stop it at the end of the graphical session (layer 3 resumes at the next login).
- **Recommendation: (a)**, since linger is already on and that is the owner's own setting. Reboot
  always ends it.

**D4. How a CLI is held.**

- Options:
  - (a) No runner: FIFO + append file + an `sh` wrapper, 2 MB per CLI (M3).
  - (b) One Node runner per data dir, 51 MB, but its death takes every CLI (M2, G).
  - (c) A Node runner per CLI, 51 MB each.
- **Recommendation: (a).** The on-disk layout is the versioned contract, with a `version` file in
  each `procs/<id>/`.

**D5. Chat tokens across a restart.** They are in memory today on purpose.

- Options:
  - (a) Store the hashes in the process row, bound to its pid and start time, revoked when it ends.
  - (b) An adopted process loses its API: Claudio's MCP tools and the orchestration tools fail
    after every update.
- **Recommendation: (a).** [security-model.md](../security-model.md) is updated with it.

**D6. The hand-over window**: how long a parked CLI runs with no server.

- Options:
  - (a) 5 minutes, then SIGINT (the vendor's own is "about a minute").
  - (b) Until its turn ends.
  - (c) Unlimited.
- **Recommendation: (a)**, with `CLAUDIO_HANDOVER_SECONDS` to change it. Unlimited means paid work
  that nobody limits.

**D7. Person chats cut by something layer 2 could not save.**

- Options:
  - (a) Continue them automatically with `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`, bounded to 1 h of
    age.
  - (b) Keep today's `interrupted`, with a one-click "Continue".
- **Recommendation: (a)** for turns cut less than an hour ago, and (b) beyond that. Orchestrations
  and flows keep their existing restart gates.

**D8. Terminals.**

- Options:
  - (a) They keep dying with the server, as today.
  - (b) The terminal host gets the same layer-1 lifetime later.
- **Recommendation: (a) now**, and (b) as its own study. The host already is a separate process.

**D9. A scope per CLI.**

- Options:
  - (a) `systemd-run --user --scope` per CLI whenever a user manager exists, and `setsid` otherwise.
  - (b) `setsid` only.
- **Recommendation: (a).** It is what keeps CLIs out of a restarted unit's cgroup (#79569), and it
  is phase 1 of the isolation study at no extra cost.

**D10. Re-check the vendor's supervisor.** If Claude Code documents stream-json I/O for `--bg`
sessions, layer 2 should move onto it.

- **Recommendation:** add a check to the CLI version watch (`cliVersionWatch`) notes and re-read
  [agent view](https://code.claude.com/docs/en/agent-view) at each minor version.

## 8. Spikes

The free ones come first. Each is a short task with a pass criterion. All run against a sandbox data
dir and the e2e fake CLI (`e2e/fake-cli/claude.mjs`) or a scratch `CLAUDE_CONFIG_DIR`.

- **S1. Adoption with the fake CLI (free).**
  - Question: can a Claudio server in a sandbox data dir, killed with SIGKILL mid-turn, be
    restarted and adopt the parked process with no gap and no duplicate?
  - Pass: the turn's events arrive once, the chat ends `completed` on the same pid, and the spend
    rows are not double counted.
- **S2. A real CLI behind a FIFO (free, no turn).**
  - Question: does `claude -p --input-format stream-json` accept a FIFO as stdin and a regular file
    as stdout, and answer `initialize` twice from two successive writers, with
    `pending_permission_requests: []`?
  - Run it with a scratch `CLAUDE_CONFIG_DIR` and no credential: `initialize` is a control request,
    with no prompt, no turn and no tokens, which Claudio already relies on for the model list.
- **S3. A pending prompt across the gap (one trivial turn; only with the owner's OK).**
  - Question: with a permission request pending, does SIGKILLing the server, then adopting and
    re-sending `initialize`, deliver the same request again and accept the answer? Do guard hooks
    keep working during the gap?
  - Cost: one `claude -p` turn on Haiku with `--max-budget-usd 0.05`. It needs a signed-in account,
    which is why it waits for the owner's approval.
- **S4. Scopes and restarts (free).**
  - Question: are fake CLIs in `systemd-run --user --scope` units untouched when the launcher's
    transient unit is stopped and restarted? Does `systemctl --user stop` on one scope leave zero
    processes, double forks included?
- **S5. AppImage (free).**
  - Question: does a process started from the AppImage mount, then left running after the
    AppImage's main process exits, fault?
  - Pass decides whether the AppImage launcher copies itself to `<dataDir>/app/` before it detaches.
- **S6. Stdout volume and punching holes (free).**
  - Count the bytes the server reads from each CLI's stdout for a day (a counter; nothing stored).
    *Done as a proxy in t2:* the app must not be touched, so the transcripts' bytes per day were read
    instead (see the Outcome of t2).
  - Check that `fallocate --punch-hole` on an `O_APPEND` file the CLI is writing keeps the CLI's
    writes and offsets intact.

## 9. Tasks

Each task owns its files; a task that needs another's file depends on it. Models: **Opus** for the
tasks that carry design, **Sonnet** for patches with a clear test. Layer 3 comes first (it stops the
bleeding), then the spikes, then layer 2, then layer 1.

| Id | What it does | Depends on | Files it owns | Model |
|---|---|---|---|---|
| `t1` | **Stop the bleeding (layer 3).** Respawn cut chats with `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` and a max age (D7); a person's chat cut less than 1 h ago continues by itself, older ones show "Continue"; workflow orchestrations cut by a restart resume instead of stopping; a row in `cli-surfaces.md` | D7 | `packages/core/src/chats.ts` (restore → respawn), `packages/core/src/live-chat.ts`, `packages/core/src/providers/claude-code/args.ts` (env), `packages/core/src/orchestrator.ts` (`interrupt`, `recover`), `packages/core/test/restart-resume.test.ts` (new), `docs/cli-surfaces.md` | Opus |
| `t2` | Spikes S1, S2, S4, S5, S6 (free); S3 only with the owner's OK; written up as `docs/decisions/parked-cli-processes.md` | — | `docs/decisions/parked-cli-processes.md` (new), scratch scripts outside the repo | Sonnet |
| `t3` | **Parked processes (layer 2, start and run).**<br>- the `cli_processes` migration and its store;<br>- the wrapper (FIFO, append file, exit code, lease watchdog, scope per D9);<br>- the tail reader and FIFO writer behind the driver's `SessionIO`;<br>- `in.jsonl` and the committed offset;<br>- hole punching at turn boundaries | `t2`, D4, D6, D9 | `packages/core/src/db.ts`, `packages/core/src/parked/*.ts` (new), `packages/core/src/chats.ts` (`spawnProcess` only), `packages/core/src/processes.ts`, `packages/core/test/parked.test.ts` (new) | Opus |
| `t4` | **Adoption (layer 2, restart).**<br>- `restore` adopts live rows: lease, replay from the offset, re-sent `initialize`, pending prompts to the broker, admission slots;<br>- `shutdown` detaches instead of `stopAll` unless asked;<br>- `orchestrator.recover`, `flow.recover` and the rotation see adopted chats as running;<br>- the stray path goes away | `t3` | `packages/core/src/chats.ts` (restore, stopAll, strays), `packages/core/src/index.ts` (`shutdownOnce`), `packages/core/src/orchestrator.ts`, `packages/core/src/flow.ts`, `packages/core/src/permissions.ts`, `packages/core/src/admission-queue.ts`, `packages/core/test/adopt.test.ts` (new) | Opus |
| `t5` | What a running CLI holds from its server:<br>- chat token hashes in the row (D5);<br>- a stable port while adopted processes exist;<br>- payload dirs kept while referenced;<br>- `removeChatExtrasConfigs` sparing adopted chats;<br>- `security-model.md` | `t3`, D5 | `packages/core/src/security/chat-tokens.ts`, `apps/api/src/server.ts`, `packages/core/src/launcher/protocol.ts` (overlay retention), `packages/core/src/chat-tools.ts`, `docs/security-model.md`, tests | Sonnet |
| `t6` | **The daemon (layer 1).**<br>- the launcher as the desktop's supervisor in a transient user unit (D2), `daemon.json`, the desktop credential and the key handed at start;<br>- Electron as a client: close keeps working, the quit question (D1), the tray says work goes on;<br>- the shell relaunch no longer restarts the daemon unless its protocol changed;<br>- the crash path restarts the server instead of showing an error | `t4`, `t5`, D1, D2, D3 | `apps/desktop/src/main.ts`, `server-process.ts`, `payload.ts`, `tray.ts`, `packages/core/src/launcher/*`, `apps/desktop/test/*` | Opus |
| `t7` | Updates: payload restarts no longer refuse over live chats (`update.live-work` only for terminals, D8); docs | `t4`, `t6` | `packages/core/src/updates/*`, `apps/web/src/pages/config/UpdatesCard.tsx`, `apps/web/src/lib/updates.ts` (copy, through `claudio-ui`), i18n, `docs/updates.md` | Sonnet |
| `t8` | The browser e2e: a spec that restarts the server mid-turn with the fake CLI, then checks that the chat finishes on the same process and that a graph task is not re-run | `t4` | `e2e/specs/survive-restart.spec.mjs` (new), `e2e/fake-cli/claude.mjs` (if it needs a slow turn) | Sonnet |
| `t9` | Docs: `desktop.md` (window, quit, tray), `deploy.md` (signals table: SIGTERM detaches), `orchestrations.md`, `providers.md`; this plan's Outcome | `t6`, `t7` | the docs named | Sonnet |

`t1` is independent and can start at once. `t3`–`t5` make updates and crashes lossless on every
distribution, the container included. `t6` adds case (a) and (b) on the desktop.

## 10. Risks

- **R1. The fold replay.** Rebuilding a turn's volatile state from its stdout tail assumes the fold
  is deterministic and idempotent for the lines after the committed offset. Spend and journal writes
  must key on something the replay repeats (S1).
- **R2. An undocumented reaction.** What the CLI does on EPIPE or on a stdin that stays open forever
  is undocumented. Layer 2 avoids both conditions, but a CLI change could still surface either.
- **R3. A new capability for same-user agents.** They could write into another chat's FIFO (§6,
  Security).
- **R4. Two writers.** A bug that lets two servers write one FIFO would interleave messages over
  4 KB (`PIPE_BUF`). The lease is the guard; S1 tests a takeover race.
- **R5. Daemon life on other desktops.** A desktop without a systemd user manager loses
  `Restart=on-failure` and the scopes, and falls back to `setsid`, with orphans possible after a hard
  kill. The layer-2 rows let the next start reap them (as `terminals/service.ts:397` does for
  shells).

## 11. What was verified, inferred and not determined

- **Verified:**
  - the process tree, the socket-pair stdio, the CLI's ignored SIGPIPE and the linger setting
    (read-only on the owner's machine);
  - every code path in §1;
  - the vendor quotes in §2 (fetched 2026-11-15, CLI 2.1.322);
  - M1–M3;
  - S3 on the real CLI: the pending request comes back in `pending_permission_requests`, and guard hooks keep firing across the gap.
- **Inferred:**
  - the AppImage fault (S5);
  - pm2's restore behaviour;
  - Happy's daemon details (secondary sources).
- **Not determined:**
  - what the real CLI does on EPIPE;
  - the stdout share of a CLI's writes (S6);
  - whether the vendor will open `--bg` to programs.

## Outcome of t2 (spikes, 2026-11-15)

Written up in [parked-cli-processes](../decisions/parked-cli-processes.md), CLI 2.1.322:

| Spike | Result |
|---|---|
| S1 | Verified with a prototype and the fake CLI: adoption after a `SIGKILL` keeps the pid, applies each event once (effects keyed by process and byte offset, offset committed with the spend row), survives a successor dying mid-replay, and answers a pending prompt through the replay |
| S2 | Verified on the real CLI: FIFO stdin and file stdout work, two writers get `initialize` answers, `pending_permission_requests: []`, no credential needed |
| S3 | Verified later the same day on the real CLI with a scratch signed-in account (account A): the pending request returns in `pending_permission_requests` with its id, both prompts were answered, the turn succeeded, the guard hook fired after the gap; 0.0012 USD |
| S4 | Verified: scopes survive a stop, restart and `SIGKILL` of the launcher's unit; stopping a scope leaves nothing |
| S5 | A stand-in verified the kernel side; the AppImage FUSE fault stays inferred, so the daemon runs from `<dataDir>/app/` |
| S6 | Transcripts: median 68 MB/day, peak 120; hole punching on a file being appended to works on ext4 |

**What the spikes changed in this plan.**

- The lease watchdog sends SIGINT only while a turn is open (S2: it ends an idle CLI). Fixed in §6.
- `pending_permission_requests` sits at `response.pending_permission_requests` of the
  `control_response`, not inside `response.response`; `initialize` answers are about 18 KB, so an
  adoption's own answer is not turn output. A successor must also keep the request ids it answered,
  to rebuild prompts from the replay when the list is empty (t4).
- A wrapper that backgrounds the CLI must give it `<&3` (a held descriptor): a background job in `sh`
  reads `/dev/null` otherwise and the CLI exits (t3). M3's foreground form is unaffected.
- Every `scope` needs `-p TimeoutStopSec` and a `reset-failed` on reaping (t3).
- Still open: the stdout-to-transcript ratio, several simultaneous pending prompts, and the container's `setsid` path.
- **S3 closed (2026-11-15, CLI 2.1.322, Haiku).** After a `SIGKILL` and a 5 s gap, the re-sent `initialize` lists the pending request in `response.pending_permission_requests`, and answering it finishes the turn. For `t4`: rebuild `PermissionBroker`'s prompts from that list first, keep the replay as the fallback for an empty list; guard hooks need nothing across the hand-over. See [parked-cli-processes](../decisions/parked-cli-processes.md#s3-a-pending-prompt-across-the-gap).

## Outcome of t1 (layer 3, 2026-11-15)

What a start does with the work the server before it left cut, by who the work was for:

| Cut work | What the next start does |
|---|---|
| A person's chat (`claudio` or `external`, its execution started for a `person`), cut less than an hour ago | Respawned with `--resume` and `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` (bound: an hour plus five minutes, so the CLI's clock does not overrule Claudio's), nothing written to stdin. The CLI continues the turn, reading `RESTART_CONTINUE_TEXT` (`CLAUDE_CODE_RESUME_PROMPT`), which the page draws as Claudio's line |
| A person's chat cut longer ago, cut more than `MAX_RESTART_CHAIN` (3) times in a row, refused a place, or whose execution recorded no purpose (written before this) | Stays `interrupted`; the chat shows "Claudio restarted while this chat was working" with **Resume** (es "Reanudar", the verb the composer below uses), a warn notice, since the turn was stopped and not failed; it resumes the chat with `RESTART_CONTINUE_TEXT` |
| A workflow orchestration | Resumed from its cache in its own session (`Orchestrator.resumeCutWorkflow`), no task attempt spent; at most `MAX_WORKFLOW_RESTARTS` (3) times |
| A graph's tasks, flow runs, assistant runs | Unchanged: their owners continue them under their existing gates (`maxAttempts`, `MAX_FLOW_RESTARTS`, one restart), as D7 says |
| A chat at its usage limit (an open wait) | The rotation's sweeper (t8 of [limit-resume-and-credits](limit-resume-and-credits.md#outcome)); never continued here |
| `api` chats | Never replayed: the client sends the request again |
| `internal` housekeeping | Ends with the server |

- **Nothing is continued twice.** Each continuation is claimed in a new `restart_continuations`
  table (`INSERT OR IGNORE`, keyed by the cut execution or the workflow lead's cut execution), as
  the sweeper claims a wait. Two servers on one data dir, or a second pass, find the claim taken.
- **A CLI that declines** (the transcript's last message older than the bound, a session not
  mid-turn after all, a CLI before 2.1.211) starts idle, which no line says: a process that shows no
  sign of the turn within `CLAUDIO_CONTINUE_START_MS` (two minutes) is taken as idle and the chat
  waits for the person.
- **The variables never leak.** `resumeEnv` strips every `CLAUDE_CODE_RESUME_*` from any other
  process's environment, so a value in the server's own environment cannot make a plain resume run
  the old turn beside its new prompt.
- **Executions record their purpose and whether a turn is open** (`Execution.purpose`,
  `Execution.turnOpen`, written down the moment a turn opens and at its result). A process outlives
  its turns, so before this every chat that merely had an idle process when the server went away
  read as cut; only an execution cut with `turnOpen: true` is a cut turn, continued or offered. The
  e2e suite's own server restart showed it: idle chats of earlier specs were being "continued".
  Executions recorded before this carry neither field and are left as they were.
- **Vendor facts**, read 2026-11-15 against CLI 2.1.322: [env-vars](https://code.claude.com/docs/en/env-vars)
  (`CLAUDE_CODE_RESUME_INTERRUPTED_TURN`, `_MAX_AGE_MS`: "A positive value bounds every turn… Requires
  Claude Code v2.1.211 or later", `CLAUDE_CODE_RESUME_PROMPT`), and the VS Code page, which documents
  the same continuation happening with no new input. Recorded in [cli-surfaces.md](../cli-surfaces.md).
- **Not verified with a real CLI**: no real turn was spent. That a `-p --input-format stream-json`
  process starts the continued turn before any stdin line is the documented SDK behaviour, and the
  fakes model it; the two-minute fallback covers the case where it does not.
- **Tests:** `packages/core/test/restart-resume.test.ts` (D7 on an injected clock, the respawn over the
  fake CLI with no prompt written, an idle process left alone, the open turn written down, owners
  and limits left alone, one continuation across two servers,
  the chain bound, a CLI that declines, a cut workflow resumed from its cache). The browser spec that
  restarts the server mid-turn is left to t8, which needs the slow fake turn layer 2 also needs.
- **Not built here:** layers 2 and 1 (t2–t9).

## Outcome of t3 (parked processes, start and run, 2026-11-16)

Built in `packages/core/src/parked/`, **off by default** (`CLAUDIO_PARKED_PROCESSES`; the plan left the
default open, and with no adoption a release must behave as before). With it off, nothing changes: no
directory, no row, the CLI on pipes.

| Piece | As built |
|---|---|
| Row | `cli_processes` (migration in `db.ts`, `parked/store.ts`): chat, layout, directory, scope, wrapper and CLI each as pid + start time, owner (the server's pid + start time), `lease_until`, `committed_offset`, `stdin_seq`, `turn_offset`, and empty `token_hash`, `payload_dir`, `cli_version` for t5. Every write but the insert is guarded by the owner |
| Files | `<data>/procs/<id>/` (`0700`, files `0600`, `umask 077`): `version` (layout 1), `run.sh`, `in.fifo`, `in.jsonl` (kind and id of each line written, never the text), `out.jsonl`, `err.log`, `wrapper.log`, `pid`, `exit.code`, `lease` (expiry, epoch seconds), `turn` (offset where the open turn's output starts), `watchdog` (when it fired) |
| Wrapper | `parked/wrapper.ts`, one `sh` script per process with the command in it, so the process table shows `sh …/run.sh` and nothing matching CLIs by argv takes it for a second CLI on the session. fd 4 holds the FIFO read-write, the CLI runs in the background with `<&3` (a read-only fd) as S1 found it must, its pid goes to `pid`, its `wait` status to `exit.code` |
| Scope | `systemd-run --user --scope --quiet --collect --unit=claudio-cli-<id>.scope -p TimeoutStopSec=10` where `systemctl --user is-system-running` answers `running` or `degraded` (D9); `systemd-run` execs in place, so the spawned pid is the wrapper's. Otherwise Node's `detached` (`setsid`). `CLAUDIO_PARKED_SCOPES=off` forces the latter. Reaping runs `reset-failed` on the unit its row names, never a pattern |
| I/O | `ChatProcess` (`chat-process.ts`) is what `ChatManager` drives; a pipe child fits it unchanged, `ParkedProcess` implements it. The server opens the FIFO `O_RDWR \| O_NONBLOCK` before the wrapper exists (never blocks, never `ENXIO`) and writes through a `net.Socket`, so libuv absorbs a full pipe. `FileTail` follows `out.jsonl` and `err.log` from the committed offset with inotify and a 1 s poll; `close` comes only after the CLI is gone and both are read to the end |
| Turn boundaries | `LiveChat.onTurn` fires when the lead's turn opens or ends. Open: `turn` file and `turn_offset`. End: `committed_offset` = the end of the line the fold just read, then `fallocate --punch-hole` below it in whole 4 KiB blocks (S6) |
| Lease and watchdog | The server rewrites every `lease` file and row with now + `CLAUDIO_HANDOVER_SECONDS` (300, D6) every minute (or a fifth of the window). The wrapper's watchdog subshell, every 10 s: lease expired, `turn` present, and no `"type":"result"` in `out.jsonl` after the turn's offset → SIGINT to the CLI, once. An idle CLI is never signalled (S2). It naps in a background `sleep` it ends when the wrapper stops it: a `sleep` left behind held the scope open for up to a tick after the CLI ended |
| Ending | `end()` closes the server's writer and sends the wrapper SIGUSR1, whose trap closes fd 4: the CLI reads EOF, so the idle timeout and one-shot runs behave as on pipes. `kill` signals the CLI by pid (checked against its parent), SIGKILL the whole tree and the scope. On close, the row, directory and failed scope go |
| Start-up | `restore` leaves the CLIs of rows whose owner is gone out of the strays (synchronously, as `server.ts` reads them at once), then `reap()` stops them (scope stop, or SIGTERM then SIGKILL to the checked tree) before it resolves, so layer 3 continues their cut turns as after #150. Directories with no row whose process is gone are removed |

**Where the plan or the spikes were wrong or incomplete.**

- **"The CLI itself is always a writer of its stdin" (M3, D4) is not what was built.** With
  `exec 0<>in.fifo` the CLI can never read EOF, and Claudio relies on EOF: the idle timeout and
  `keepAlive: false` end a process by closing its input, and the CLI documents waiting for
  background work "after stdin has closed". The CLI gets a read-only descriptor and the wrapper holds
  the writer, released on SIGUSR1. The cost: a wrapper killed on its own (only a scope stop or a
  SIGKILL does that) lets the CLI read EOF once no server writes either.
- **"Every write also goes to `in.jsonl`" would put every prompt on disk a second time**, base64
  attachments included. `in.jsonl` keeps the sequence number, the kind and the id (message `uuid` or
  control `request_id`), which is what the plan wanted it for.
- **A watchdog in `sh` cannot read "the tail shows a turn with no result"** without a JSON parser, and
  a server that died mid-turn never removes its marker. It reads the `turn` offset the server wrote
  and greps what follows for a result line, so a turn that ended while no server was there is left
  alone (tested). The lease is an expiry in the file, not the file's age, so the server's clock sets it.
- **The rotation fallback of S6 is not safe.** Truncating a file the CLI appends to races its next
  write; where holes cannot be punched the bytes stay until the process ends.
- **S1's "offset committed with the spend row in one transaction"** is not done: in t3 nothing replays,
  so the commit follows the fold's turn end. t4 must bind them before it replays.
- **`--collect` makes a scope that died of a signal unload by itself**; `reset-failed` is still sent
  on reaping, as S4 asked, for a unit that outlived its server.

**What t4 needs, and finds ready.** Rows with pid + start time for the wrapper and the CLI; the
owner to take over with a guarded `UPDATE`; `committed_offset` (a line end, everything before it
possibly a hole) to replay from with `FileTail`; `turn_offset` to know a turn was open; `in.jsonl` for
the control responses already sent; `ParkedProcess` built from a row (its constructor takes `from`, but
an adopted wrapper is no child of the new server: its exit must come from polling the pid and
`exit.code` instead of `child.on('exit')`); `stopAll` and start-up switched from stop and reap to
detach and adopt; and the e2e of t8. t5: the token hash, payload dir and CLI version columns exist and
are empty.

**Tests.** `packages/core/test/parked.test.ts` (18, over the control fake CLI, which now ends an open
turn on SIGINT and an idle process with exit 0 as the CLI does): FIFO and file descriptors, own session,
the wrapper's clean argv, two turns on one process; file modes; EOF on `end()`; a signal reported as
on pipes; `in.jsonl` without text; commit and holes over 40 turns; the watchdog against an expired
lease, an idle CLI and a held lease, and against a turn that ended without a server; lease renewal on
an injected clock; the owner guard; reaping a gone server's process and an orphan directory, and
leaving a live owner's alone; the scope (cgroup, collected after the end; skipped without a user
manager); the switch's parsing; a chat on a parked process end to end; a chat on pipes with the switch
off; and a start that reaps a parked CLI cut mid-turn and hands its turn to layer 3 as continuable.

**Measured here** (Linux, dash, systemd 259 user manager, tmpfs `/tmp`): `systemd-run --scope` keeps
the pid (the wrapper's argv replaces `systemd-run`'s) and the unit is gone after the process ends; a
100 KB line through the non-blocking FIFO socket arrives whole; SIGUSR1 to the wrapper, then closing
the server's writer, delivers EOF and the CLI's own exit code (7) to `exit.code`. Nothing touched the
owner's running app.

## Outcome of t4 (adoption, 2026-11-16)

Built behind the same switch, which stays **off by default**: with the window's close still quitting
the server, a parked CLI would run on with nobody enforcing budgets until the lease ends it, so the
default changes with t6 (layer 1) and the owner's word, not here. With it off a start reaps and
layer 3 continues, as after t3.

| Piece | As built |
|---|---|
| Shutdown | `ChatManager.detachParked()`, called by `Core.shutdownOnce` before the permission broker denies what waits, and first thing in `stopAll`: every parked process stops being read and written (`ParkedProcess.detach`: tails stopped, the server's FIFO writer closed without SIGUSR1, so the CLI's input stays open), sends no signal, its pending turn end is committed, its row released (`owner` NULL), and its chat written with the execution open. Chats on pipes stop as before |
| Adoption | `restore` → `adoptLeftBehind`: for each row whose owner is gone and whose chat the restore kept with that execution open, `ParkedProcesses.adopt(row)` checks layout, wrapper and CLI by pid and start time and that no `exit.code` exists, then `CliProcessStore.take` (`UPDATE … WHERE owner_pid IS ? AND owner_started IS ?`, the owner it read). The chat's execution is open again, its written messages are not "lost", and `wire()` (split out of `spawnProcess`) attaches the driver with a `SessionAdoption`. The process's end is found by polling the wrapper (500 ms), which is no child of the new server, then `exit.code` as before |
| Replay | From `committed_offset`, through the fold, before `restore` resolves (`ParkedProcess.caughtUp`), so the orchestrator's and the flow's recovery see a turn that ended in the gap as ended. A turn the row or the execution marks open reads `busy` at once |
| Re-attach | After the replay, not waited for: `DriverSession.reattach()` sends `initialize` under a fresh request-id prefix (the old server's ids may still be answered) and reads `response.pending_permission_requests`. Listed requests are asked again; with an empty or missing list, the replay's `can_use_tool` requests with no answer and no cancel are. `in.jsonl`'s `control_response` ids seed the control channel, which never answers or refuses one id twice |
| Spend | A result read from a parked process records `source = <process>:<offset>` in `spend_ledger` (new column, unique where set; `INSERT OR IGNORE`). A turn end's committed offset is written inside the transaction that saves the chat (`Db.saveChats(…, alongside)`), so the offset and the session totals the next cost is measured from never disagree; holes are punched after that commit |
| Orchestrator | `recover()` puts an interrupted task whose chat was adopted back to `running` in a new stamp of the same attempt and settles it on `waitForResult`; a workflow whose lead was adopted is `running` again and followed (`followAdoptedWorkflow`) instead of resumed from its cache |
| Flow, rotation, admission | Unchanged code: `flow.recover` already skips a run whose chat is busy and `chatResult` ends it on the result; the rotation's `recover` takes the wait rows of chats in memory, adopted included; admission counts live chats, adopted included |
| Fallback | A row that cannot be adopted (another layout, wrapper or CLI gone, taken by another server, files unusable) is left to `reap`, and its chat's cut turn to layer 3 (#150). `ChatManager.adopted(id)` says which chats were taken over |

**Where the plan was incomplete.**

- **A plain commit after the result is not enough (R1).** The fold records the spend row, then the
  turn's end, then the chat row; t3 committed the offset at the turn's end, before the chat row. A
  death between the two left a baseline behind the offset, and the next turn would have been billed
  for this one. The commit now rides the chat's own transaction, and the spend row is keyed by where
  it was read, which also covers a death between the ledger row and that transaction. A turn's
  `turns` count can still be added twice in that last window; its cost cannot.
- **The fake CLI** now lists its pending request in its `initialize` answer, beside the inner
  response as S2 saw (`FAKE_CLAUDE_PENDING_LIST=off` stands for an older CLI).
- **The guard's watcher is not re-attached.** An adopted chat has no guard plan in memory, so the
  guard markers are not followed after a restart; the guard's hooks still run in the CLI (S3).

**What t5 and t6 need.** t5: the adopted CLI still carries the old server's `CLAUDIO_API_TOKEN`,
which the new server refuses, so its Claudio MCP calls fail until the token hash is in the row
(`token_hash` stays empty here); `payload_dir` and `cli_version` are untouched; the port must stay
the same for `CLAUDIO_API_URL`; `removeChatExtrasConfigs` already spares adopted chats, which are
alive when it runs. t6: the switch's default, the "stop all work" choice on quit (D1; `stopAll`
detaches whenever parking is on), and the browser spec of t8.

**Tests.** `packages/core/test/adopt.test.ts` (12): a shutdown mid-turn and an adoption that finishes
the turn on the same pid with one CLI start and one spend row; a turn that ended in the gap read from
the replay; a replayed result after a death between the ledger and the chat row counted once; a
pending prompt from the CLI's list, answered after the restart; a prompt rebuilt from the replay when
the list is missing, and an answered one never asked again; the fallback to layer 3; parking off still
stops; two server processes racing for one row (one adopts); the guarded take and release; the
list's shape; a graph task that goes on in the same attempt with one worker start; a detached process
neither written nor signalled. `parked.test.ts`'s reap-at-start test runs with parking switched off.
The browser spec that restarts the sandbox server mid-turn is left to t8.

## Outcome of t5 (what a running CLI holds from its server, 2026-11-16)

Still behind `CLAUDIO_PARKED_PROCESSES` (off). With it off nothing is written or read: the token store
has no stored source to ask, no row exists, the port is the one asked for.

| Piece | As built |
|---|---|
| Token hash | At `ParkedProcesses.start` the row gets `token_hash` = SHA-256 hex of the `CLAUDIO_API_TOKEN` in the process's environment (`chatTokenHash`), nothing else of it. `ChatTokenStore.stored` (a `StoredChatTokens`) is asked when a token is not in memory, in `verify` and in `holds` (masking). `ParkedProcesses.chatForTokenHash` answers only when the row's owner is this server (pid + start time), the CLI of the row runs (pid + start time; its wrapper until the CLI's pid is written) and the row is under `CHAT_TOKEN_MAX_AGE_MS`. The row going (`ended`, `reap`) revokes it. Tokens minted in memory are unchanged, so a non-parked chat behaves as before |
| Port | `ParkedProcesses.apiPort()` reads `<dir>/api-url` (new file, the `CLAUDIO_API_URL` the CLI was given) of every running row: the port most CLIs hold, the newest on a tie. `startServer` listens there, whatever port it was asked for (a warning when it differs), with no fallback, and throws `AdoptedPortTakenError` (`code: EADDRINUSE`, so `index.ts` still names the problem) when it is taken. No setting. The desktop already restarts on the port it remembers, so a normal restart asks for the same one; the headless image and `pnpm dev` ask for a fixed one. No launcher changed |
| Payload dirs | `payload_dir` = the directory of `CLAUDIO_MCP_ENTRY` at the start. `collectOverlays` (`launcher/machine.ts`) keeps an overlay `<data>/app/<version>` that a running row's `payload_dir` is under, reading the rows read-only through `MachineFiles.pinned` (`pinnedPayloads`: `node:sqlite` through `createRequire`, a row counts while its CLI runs by pid + start time; unreadable keeps every overlay). `.staging-*` still goes |
| Chat configs | `restore` ends with `removeChatExtrasConfigs(…, chat => !parked.chatsInUse().has(chat) && !alive)`: the `extra-*` and `overlay-*` files of a chat whose parked CLI runs stay. They go with the chat or the process as before |
| CLI version | `cli_version` = what the core last read from the CLI (`Core.cliVersionSeen`), or null |

**Where t4 and t6 touch this.**

- `chats.ts`: two lines in `restore`: `const held = this.parked.chatsInUse()` beside `leftBehind()`
  (before the first await, since a shut-down core must not query) and the last
  `removeChatExtrasConfigs` call reading it. It holds the chats whose CLI runs under another live
  owner; the chats t4 adopts are spared by the `alive` test and `adoptedChats` in the same call (tested
  in `parked-holds.test.ts`). `index.ts`: two lines after `this.runtime.chatTokens = …`
  (`chatTokens.stored = runtime.parked`, `parked.cliVersion`). `parked/registry.ts`: `start` (derived
  fields in the `insert`, the `api-url` write) and four new methods; `parked/store.ts`: three row fields
  and `byTokenHash`; `parked/wrapper.ts`: the `apiUrl` file name. `db.ts`: nothing (the columns were t3's).
- **With t4 merged**, adoption's guarded `take` makes this server the row's owner, and the token is
  accepted only for a row this server owns: before adoption a chat's old token answers `401`, after it
  the same token works, and `ended()` deleting the row revokes it (tested end to end over an adopted
  chat). Nothing else is called at adoption. A detach (`release`) makes the token unusable until
  the next server takes the row, which is the intended gap.
- **t6 must keep the port** the CLIs hold: the daemon's server is started with the `PORT` the shell
  remembers, and the crash path restarts it the same way. `AdoptedPortTakenError` is an exit with
  `EADDRINUSE`; the supervisor should show it as "the port is taken", not retry in a loop. The
  launcher already collects overlays through `collectOverlays`, so t6's units get the retention.
- Not done: attachments (`uploads/`) have no start-up sweep to spare; a parked CLI's per-run temp dirs
  (`CHAT_TMP`) were not looked at; the old overlay of a CLI is kept only while its row lives, as in the
  plan.

**Tests.** `packages/core/test/parked-holds.test.ts` (the hash only in the row and in no file, the token
accepted by a fresh store over the rows, refused after the process ends, for a different pid or start
time, for a row nobody holds or another server holds, after a day; a token minted in memory unaffected;
the address, payload and version recorded; the port choice; a chat's configs spared by `restore`; the
overlay retention, with nothing pinned and with unreadable pins; the pins read from rows) and
`apps/api/test/adopted-port.test.ts` (a started server listens on the port a running CLI holds, does
not fall back when it is taken, and falls back as before with none). Documents:
[security-model.md](../security-model.md#parked-cli-processes), [chat-environment.md](../chat-environment.md).

## Outcome of t8 (the browser specs, 2026-11-16)

Two specs, each on a wrapper of its own (a harness peer: its data directory, port and fake CLI, restarted
by the spec itself, so no other spec in the shard loses its server). Shared helpers in
`e2e/specs/restart-shared.mjs`. Neither needed a change to the fake CLI: its `hold:` and `ask:` steps,
its `pending_permission_requests` answer (t4) and `CLAUDIO_FAKE_CLI_TURN_COST_USD` were enough.

| Spec | What it proves |
|---|---|
| `restart-parked.spec.mjs` (layer 2, `CLAUDIO_PARKED_PROCESSES=on`, scopes off) | A turn held mid-way survives `peer.restart()` (SIGTERM, then a fresh server on the same data directory and port): the fake logs one start and the turn's result under the **same pid**, the page reads the turn back and shows it finishing, no second CLI and no resume. The chat's token, minted by the old server, is still known to the new one: a command the turn runs from inside the CLI posts to `/guards/check` with `$CLAUDIO_API_TOKEN` and gets `403` (a chat's token is refused there; an unknown token would have been read as the owner's). A permission prompt held across a second restart is asked again in the page, and allowing it reaches the CLI that asked (`answered` logged by the same pid) and finishes the turn. `spend_ledger` has one row per turn and the total is the two costs, not more |
| `restart-continue.spec.mjs` (layer 3, parking off) | Two chats mid-turn, the server killed with SIGKILL (every process whose environment names the wrapper's data directory). While it is down the second chat's cut is aged to three hours in the database. The first chat is respawned with `--resume` on its own session and answers with nothing typed, with no notice; the second shows the warn "Claudio restarted while this chat was working" with Resume, has no process started for it, and Resume starts one on its session and clears the notice |

**What the specs found.**

- **Layer 3 does not apply to a graceful stop.** `Core.shutdown` calls `ChatManager.stopAll`, which
  calls `stop()` on every chat, so a server that is sent SIGTERM (the harness's restart, a desktop
  quit or update, a container stop) closes each execution as `stopped` with `turnOpen: false`.
  Measured here: both chats' executions read `["stopped", false, null]` after `peer.stop()`, and the
  next start continued neither and offered nothing. Layer 3 therefore covers a crash, an out-of-memory
  kill or a power cut, which is why `restart-continue.spec.mjs` kills the server instead of stopping it.
  With parking off, a turn cut by a graceful restart is a stopped turn, as before t1. Whether
  `stopAll` should record shutdown as an interruption (so t1 covers the restarts a person causes) is
  the owner's to decide; it is not changed here.

**Not covered.** Permission prompts and the token are covered end to end only with parking on, as the
fake CLI lists its pending request only then. A real CLI was not run.

## The owner's decisions (2026-11-15)

Taken in the chat that commissioned the study:

- **Approach:** D, all three layers, built in the order of section 9 (C first, then the parked
  processes B, then the desktop daemon A), each task its own pull request.
- **D1:** quitting with live work asks, and keeps working by default.
- **D5:** chat tokens survive a restart as hashes in the process row, bound to the pid, never in clear.
- **S3:** authorised, one Haiku turn capped at 0.05 USD, in a scratch directory.
- **D2, D3, D4, D6, D7, D8, D9, D10:** the recommended option of section 7 (not discussed one by one;
  the owner accepted the plan as recommended).

## Related

[[decisions/parked-cli-processes.md]] · [[plans/process-isolation.md]] · [[plans/limit-resume-and-credits.md]] · [[plans/unified-updates.md]] · [[plans/remote-updates.md]] · [[plans/headless-image.md]] · [[plans/claudio-servers.md]] · [[updates.md]] · [[desktop.md]] · [[deploy.md]] · [[resource-control.md]] · [[providers.md]] · [[cli-surfaces.md]] · [[orchestrations.md]] · [[accounts.md]] · [[security-model.md]] · [[terminal.md]] · [[servers.md]]
