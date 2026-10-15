---
created_at: 2026-10-15T17:30:00Z
updated_at: 2026-10-15T17:46:01Z
tags:
    - plan
    - terminal
    - security
    - websocket
    - design-system
---
# Plan: the person's own terminal in Claudio

Status: **planned** (2026-10-15). Nothing is built. The owner reviews this plan, answers the open
questions at the end, and then the orchestration in [§7](#7-orchestration) is launched. Its
facts spike (t0) is done: [Facts from t0](#facts-from-t0-2026-10-15).

Claudio (the Claude-Code-only fork, [plans/claude-only-fork.md](claude-only-fork.md)) gets a real
interactive shell per project and per chat, opened in the project's directory or in the chat's
worktree, in a panel of the web app (desktop and phone) and of the Electron app.

Names are written as they will be after stage R of the fork: packages `@claudio/*`, variables
`CLAUDIO_*`, API on `8797`, web dev server on `5181`, e2e on `8809`. Where a file is named, it is
the path in the stage-A checkout (`~/Escritorio/claudio-stage-a`), which keeps its paths through the
rename.

## Decisions (owner, 2026-10-15)

Taken on the open questions of both studies (this plan and `terminal-pando.md`); they override the
sections below where they differ.

1. **Access with authentication off: this machine only.** With `mode: none` the terminal opens only
   from loopback (§3.4); any other device needs token authentication. Rejected: off until a token is
   set; the whole LAN behind an explicit setting.
2. **Phone: only through the tunnel, with a token.** Off this machine the terminal is reachable only
   over the encrypted tunnel with token authentication (`remote: 'tunnel'`, Q1). Rejected: the plain
   LAN address with a warning; no phone in v1.
3. **Environment: a login shell plus the tool credentials.** The shell is the person's login shell
   (§2.11) and, unlike the first draft, it **also gets the vault's tool credentials** (GitHub,
   GitLab, YouTrack…), built the way the code hosts' environment is (`hosts/env.ts`), so `gh`,
   `glab` and the tracker CLIs work in it. Still always removed: every `CLAUDIO_*` variable and
   Claude's own credentials (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`).
   Acceptable because decisions 1 and 2 keep the terminal to this machine or an authenticated tunnel.
   Rejected: no tool credentials; the server's whole environment minus secrets.
4. **Lifetime: survives reloads, not restarts.** v1 shells outlive their socket (idle timeout, cap per
   actor), several devices may attach to the same shell, and every shell ends when the server stops.
   A daemon that survives restarts is a possible v2 (Q3). Rejected: surviving restarts in v1; one tab,
   one shell.

5. **T8-1, an agent that detaches (owner, 2026-10-15): accepted, with a warning.** With authentication
   off, an agent that has a shell can leave its chat's process tree (a detached process) and reach the
   terminal; with token or OIDC authentication it cannot. The card says so beside the switch when the
   mode is `none`. Rejected: a cgroup per chat (peer check reads `/proc/<pid>/cgroup`), and the
   terminal working only once token authentication is on. See
   [the audit](../reports/terminal-security.md#t8-1--under-auth-off-a-detached-agent-passes-the-peer-check-high-within-its-scope-open-owner-decision).

Still open, with this plan's default unless the owner says otherwise: Q2 (re-confirm the token
before opening from another device: default no), Q4 (no `/proc` under auth off: terminal
unavailable), Q5 (no refusal while an agent works in the same worktree), Q6 (a chat without a
worktree gets a terminal in its project directory), Q7 (Docker with auth off: unavailable).

**Found while planning, independent of the terminal:** the server deletes the desktop token and the
secret key from its environment after start, but not the owner's auth token, so a deployment that
seeds it through the environment (Docker, Compose, Helm) hands it to every chat process (§2.11, task
t2a). Agentry has the same gap. Fix it first, even if the terminal waits.

## Facts from t0 (2026-10-15)

Measured in [reports/terminal-t0.md](../reports/terminal-t0.md), each with its command and output.
They correct the sections below, which have been edited to match:

- **PTY package: `node-pty` `1.2.0-beta.15`, exact pin** (Microsoft's `beta` dist-tag), not `1.1.0`.
  `1.1.0` has no Linux prebuild, so pnpm 10 (which skips install scripts) would leave it with no
  binary, and a copy compiled on a recent machine needs its glibc (2.42 here) and fails in the
  bookworm image. The beta ships a Linux x64 prebuild (glibc ≥ 2.28) that loads unchanged on Node 22,
  Electron 44's Node and the `node:26-bookworm-slim` image, from a read-only AppImage mount: no
  compiler, no `@electron/rebuild`, `npmRebuild: false` stays.
- **No `FD_CLOEXEC` patch.** With `1.1.0` a shell holds every other terminal's master; the beta's PTY
  child closes inherited descriptors, so shells hold none. The masters are still inherited by a
  `child_process` the host would start, so **the host never uses `child_process`**. (The patch for
  `1.1.0` is in the report, should the pin ever fall back.)
- **xterm 6.0.0** for the view and the headless screen (`@xterm/headless` 6.0.0,
  `addon-serialize` 0.14.0, `-unicode11` 0.9.0, `-fit` 0.11.0, `-webgl` 0.19.0, `-search` 0.16.0,
  `-web-links` 0.12.0). The serializer drops a half-written sequence, as §2.5 expects.
- **A refused WebSocket upgrade must destroy its socket.** Node stops tracking a socket that asked to
  upgrade, so `forceCloseConnections` never closes one that got an HTTP answer (401, 403, 405, 421…),
  and `app.close()` then never resolves (§2.4).
- **Vite: the socket's proxy entry needs `ws: true` and `changeOrigin: false`.** With
  `changeOrigin: true` the API sees `Host: localhost:8797` beside the page's `Origin`, so the Origin
  check refuses every dev socket, and a LAN device reaching a `--host` dev server would look local
  (§2.4, §3.4).
- **The peer lookup works** for IPv4, IPv6 and v4-mapped peers, on the host and in Docker, but the
  `/proc/*/fd` scan costs 30–40 ms on a desktop; scan only the chats' process trees (§3.5).
- `connect-src 'self'` allows same-origin `ws:` and `wss:` in Chrome 154, Firefox 158 and WebKit 27.2
  and blocks other ports. iOS Safari on a device, `docker build` and `pnpm desktop:dist` are left
  to the integrator, with the commands in the report.

## The rule this feature lives under

The terminal is **the person's own shell**. It is a tool for a human, beside Claude Code, never a
way to reach it:

- Claudio never writes into a terminal on its own, never reads what a terminal prints to decide
  anything, and never starts `claude` in one. No code path from chats, orchestrations, the flow,
  the assistant, the decision engine or the MCP server touches the terminal service. A test asserts
  it (§6.1, "isolation").
- If the person types `claude` in the terminal, that is the person using the CLI interactively, as
  they would in any terminal emulator. Claudio does not parse, record or react to it.
- The server keeps a headless copy of the screen for one purpose only: to repaint it for a client
  that reattaches. That copy is never searched, logged, stored on disk or handed to an agent.

The one rule ([CLAUDE.md](../../CLAUDE.md)) is untouched: Claude Code is still reached only through
its CLI flags, stream-json and the control protocol.

---

## 1. How the reference does it

We studied a reference implementation: an MIT-licensed Electron IDE for parallel agent work, with
a desktop app, a web client, a phone app and a relay for remote machines. What follows describes its
mechanisms; none of its code is copied here, and Claudio re-implements what it takes. Paths and
counts were read from its source on 2026-10-15.

### 1.1 Architecture

```
renderer (xterm.js) ──Electron IPC, JSON strings──▶ Electron main ──NDJSON over a 0600 unix socket──▶ terminal daemon
web / phone client ──WebSocket, binary frames, E2E-encrypted──▶ main ("serve" mode)          ├─ node-pty per shell
                                                                                              └─ @xterm/headless per shell
```

- **The PTYs live in a separate, detached Node process (the "terminal daemon"),** forked with
  `ELECTRON_RUN_AS_NODE=1`, `detached: true`, its cwd in the app's data dir, and on Linux wrapped in
  `systemd-run --user --scope` so stopping the app's service does not kill the shells. It
  **outlives** renderer reloads, app quit, auto-update and main-process crashes: on quit the app
  only disconnects. On the next launch an existing healthy daemon is adopted; a dead one is
  respawned (at most 5 times a minute); if none can start, the app falls back to in-process PTYs
  whose shells die with it. A versioned socket name (protocol v38) and legacy adapters let a newer
  app talk to an older daemon.
- **Every shell has an authoritative headless screen** (`@xterm/headless` + serialize + unicode11)
  in the daemon. Snapshots for a reattaching client are taken from it, never from the renderer.
- **Durable history** on disk per terminal (metadata, a checkpoint, a length-framed append log that
  detects a torn last write, scrollback), files 0600 in 0700 dirs, checkpointed every 5 s for
  changed sessions, so a crash can restore what was on screen.

### 1.2 Libraries and versions

| Library | Version | Use |
|---|---|---|
| `node-pty` | 1.1.0, **with a 1 442-line local patch** | the PTY. Not the prebuilt forks. Rebuilt from source for Electron with `@electron/rebuild`, because "upstream prebuilds can load while missing those patches"; a script switches the binary between the Node and Electron runtimes by test-loading it in a fresh child |
| `@xterm/xterm` | 6.1.0-beta.303, patched (IME hooks, a list fix) | the renderer view |
| `@xterm/headless` | 6.1.0-beta.302 | the daemon's screen mirror |
| addons | fit 0.12, webgl 0.20, search 0.17, web-links 0.13, unicode11 0.10, serialize 0.15 (patched), image 0.10, ligatures 0.11 (patched), all `-beta.300` | no canvas addon (fallback is the DOM renderer), no clipboard addon (OSC 52 is its own, 128 KiB cap) |
| `ws` | ^8.21 | the WebSocket server of the "serve" mode |
| `tweetnacl` | | end-to-end encryption of remote sessions (X25519 + XSalsa20-Poly1305) |

What its `node-pty` patch fixes is the most useful single list in the study:

- the PTY **master fd is not close-on-exec**: `forkpty` leaks every open terminal's master into
  every process spawned later, which keeps a closed terminal's PTY alive and hands a stranger
  process a handle on it;
- after EIO/EOF the fd number is retired (`-1`) so a write or resize can never hit a reused
  descriptor;
- an EAGAIN on write is retried after 1 ms instead of upstream's `setImmediate`, which busy-looped;
- glibc symbol versions pinned for an old-distro floor; Windows ConPTY processes created suspended
  and put in a job object.

### 1.3 Spawning

- Shell: `$SHELL`, then the process's `SHELL`, then a validated fallback list. Login shell, with
  optional wrappers per shell (zsh via `ZDOTDIR`, bash via `--rcfile` replaying the login chain, fish
  via `-C`) that emit OSC 133 prompt marks and private "shell ready" marks. A feature list passed in
  an environment variable that the wrapper deletes at once, so children never inherit it. OSC 7 is
  parsed only when the person's shell emits it. Wrapper files must not be empty: a zero-byte
  `.zshenv` behind `ZDOTDIR` silently skips the person's whole config.
- cwd: the worktree path the caller sends; a default of HOME that refuses root-like directories.
  **The cwd is not confined** to known worktrees.
- Environment: the daemon's environment plus `TERM=xterm-256color`, `COLORTERM=truecolor`,
  `TERM_PROGRAM` / version, `LANG` defaulting to UTF-8. Removed: `ELECTRON_RUN_AS_NODE`, an
  inherited `NO_COLOR`, AppImage runtime variables, a build-mode `NODE_ENV`, its own pane-identity
  variables, inherited history-file variables, and a caller-supplied `envToDelete` list; scrubbed a
  second time after the shell wrapper is prepared.
- Default size 80 × 24 when the request is invalid. Output read as UTF-8 strings (node-pty's
  default); `handleFlowControl` not used, `pause()` / `resume()` instead.

### 1.4 Signals, exit and cleanup

- Resize: fire-and-forget; the headless screen is resized first, then the PTY (`SIGWINCH` to the
  foreground group).
- Close: `SIGHUP` (node-pty's `kill()`), a descendant sweep that `SIGTERM`s every descendant (to
  reach jobs that left the group), then after 5 s `SIGKILL` to every process group whose controlling
  tty is this PTY, never signalling a group the daemon itself is in. Only processes whose pid **and
  start time** still match are killed. On exit, `kill` is replaced by a no-op so a late signal cannot
  hit a recycled pid.
- A Docker fixture proves it: a shell child that calls `setsid` and ignores `SIGTERM` must be dead,
  an unrelated canary alive, and shutdown under 5 s; the same test against an older commit must fail.
- The daemon retires when it has no sessions and no clients; its pid file carries pid, start time
  and a launch nonce.

### 1.5 Transport, back-pressure and replay

- **Desktop:** plain Electron IPC with JSON-cloned strings. Output batched every 2 ms in 16 KiB
  chunks, with a small "interactive lane" so a keystroke's echo is not queued behind bulk output.
- **Acks are cumulative and sent after xterm has parsed the bytes** (the write callback), not on
  receipt. Credit windows: 512 KiB in flight per terminal, 8 MiB in total.
- **Producer pause:** above 256 K characters pending the PTY is paused (the kernel then blocks the
  flooding program), resumed below 32 K; a pause auto-releases after 5 s in case the resume was
  lost, and is re-asserted while the backlog stays high. Daemon side: 4 MiB / 1 MiB per client and
  64 KiB / 32 KiB per session.
- **Background panes are never paused:** their oldest output is dropped down to a kept tail
  (512 KiB per session, 2 MiB in total), replaced by a "gap" marker, and bytes that ask for an
  answer (DA, DSR, OSC queries) are salvaged so the program does not hang.
- **Remote ("serve", web, phone):** a WebSocket (1 MiB max message, 128 connections, 10 s to
  authenticate, 15 s ping) carrying a **binary frame with a 16-byte header** (kind, version, opcode,
  stream id, 64-bit sequence) and opcodes for output, snapshot start/chunk/end, input, resize, ack,
  subscribe, claim viewport and pause. One socket multiplexes up to 128 terminals, drained round
  robin; output batched 5 ms or 64 KiB; acks every 192 KiB; a stream whose backlog passes 256 KiB
  is dropped and replaced by a recovery snapshot. Remote sessions are end-to-end encrypted with a
  paired device key; the local daemon socket is 0600 with a random token.
- **Replay is always a fresh snapshot**, never a resume by sequence number. A phone's snapshot steps
  down through 1 000, 500, 250, 100, 25 and 0 lines of scrollback until it fits 512 KiB.
- **Resize arbitration:** a phone that drives a terminal holds a "presence lock" (desktop resize and
  input are held until the desktop takes it back); among remote desktop viewers the last one to
  claim the viewport wins, and input on the host claims it back.

### 1.6 Frontend

- Defaults: 14 px font, scrollback 5 000 (1 000–50 000), unicode11 plus a provider that counts a ZWJ
  emoji as one cell, kitty keyboard protocol on.
- **Fit:** a `ResizeObserver` starts a `requestAnimationFrame` loop that waits until the proposed
  size is stable (up to 8 frames) before resizing, to stop one-column wobble from sending a storm
  of `SIGWINCH`; a container-level 150 ms debounce; a refit after the renderer changes, since DOM and
  WebGL cells measure differently.
- **WebGL policy:** on by default **except on Linux under Wayland (it wedged input), without WebGL2,
  or on a software GL** (SwiftShader, llvmpipe, virgl). At most 6 live contexts kept for hidden
  views; disposal forces `WEBGL_lose_context`; a context loss falls back to the DOM renderer (at most
  3 losses a minute); glyph-atlas corruption without a loss event is repaired by clearing the atlas.
- **Output pipeline in the view:** a queue drained on a zero-delay macrotask, re-armed from xterm's
  parse callback; synchronized-output frames (DEC 2026) never split; **every write callback is
  guarded, because one exception inside it stalls xterm's write buffer for good.**
- **Hidden tabs** stop rendering (cursor parked, WebGL disposed); after 30 s hidden the xterm
  instance is unmounted and rebuilt from the snapshot on return.
- **Links:** a file-path provider that rebuilds logical lines across wraps and resolves against the
  OSC 7 cwd; web links; OSC 8 hyperlinks. **Search** with case and regex toggles. **Paste:** an
  embedded ESC is replaced (U+241B) so a pasted `ESC[201~` cannot end bracketed paste early, LF
  becomes CR, pastes are chunked (16 KiB), capped (16 MiB) and time-limited. Optional right-click
  copy/paste. A large IME layer with its own test workflow.
- **Keys:** a custom key handler hands the app's shortcuts to the app before xterm sees them.
- **Theme:** separate dark and light terminal themes chosen from the app's theme; a program that
  changes the palette (OSC 4/10/11) is not overwritten by a later theme write.
- **Phone:** xterm inside a web view, a key bar (Esc, Tab, Shift+Tab, Enter, arrows with
  auto-repeat after 400 ms then every 45 ms, Ctrl+C/D/L/Z/R/A/E/W/U, and custom combinations), touch
  gestures turned into mouse reports, and two input modes (a buffered command field, or direct).
- **Tabs and splits** per worktree, the title from OSC 0/1/2 (capped), the bell marking a tab
  unread, an exit overlay with the code and a Restart button.

### 1.7 How it tests and measures

- A daily **terminal performance workflow** (Ubuntu, xvfb, an e2e Electron build) loads 10, 25, 50
  and 100 terminals, injects output through a test hook, holds acks to create pressure, and
  measures: typing latency (a marker key typed, the serialized buffer polled every 5 ms until it
  shows), event-loop timer drift, restore, revisit and scroll times, and the view's queued and peak
  bytes. **Budgets:** median typing 25 ms, worst key 300 ms, revisit 300 ms, timer drift 150 ms,
  scroll 150 ms, restore 1 000 ms, queue ≤ 2 MiB, no dropped backlog.
- Golden e2e specs for rendering: two terminals sharing a WebGL atlas under a glyph storm (page
  budget, evictions, a pixel diff of 0 after reset), an emoji table that keeps its geometry after a
  switch and a scroll, and a file link opened through its popover.
- A smoke test that boots the headless server, creates a terminal through the CLI, sends a nonce
  and polls until it is read back: a "server is up" probe passed while the PTY controller was
  missing.
- About 1 000 unit-test files across the view, the daemon and the relay; serial "performance
  contract" tests for retained memory; micro-benchmarks for batching and frame chunking.
- A documented finding: one-second stalls on Linux CI came from Chromium throttling undrawn frames,
  not from xterm. Headless numbers are noisy.

### 1.8 What it got right, and what to avoid

**Take:**

1. A headless screen beside every PTY, and **replay by snapshot**, not by raw bytes.
2. **Acks after parse**, cumulative, with a producer pause and hysteresis between the watermarks.
3. **pid + start time** for every kill, process-group kill with escalation, a test with a `setsid`
   child that ignores `SIGTERM`.
4. **Close-on-exec on the PTY master** (or keeping masters in a process that spawns nothing else).
5. Stable-size fit before `SIGWINCH`; refit after a renderer switch.
6. A **WebGL policy** that knows Linux: no WebGL on Wayland or software GL, DOM fallback on loss.
7. Guarded write callbacks; swallowing the view's automatic query replies while a snapshot is
   replayed (otherwise DA1/CPR/OSC 11 answers are typed into the shell); replaying at the
   snapshot's own size, then resizing (otherwise the screen rewraps); re-sending a mid-escape tail
   that the serializer drops.
8. Paste sanitising (ESC inside a bracketed paste) and paste limits.
9. Bounded memory everywhere: their daemon keeps **1 000 lines** live per terminal after "100+
   terminals at full depth retained about 1 GB and were OOM-killed".

**Avoid, or not needed in Claudio:**

1. **A detached daemon that survives the app.** It is most of their complexity (socket ownership
   rules written after "23 defects in seven review rounds", protocol versions, adoption, systemd
   scopes, updater escapes). Claudio's v1 ties the shells to the server (open question Q3).
2. **Durable scrollback on disk.** A terminal's output holds secrets; Claudio writes none.
3. **No cwd confinement.** Theirs is a single-user desktop tool; Claudio's API is reachable over the
   network, so the directory is derived from ids.
4. **Shell-integration wrappers** that inject scripts into the person's shell and parse prompt marks:
   not needed for v1, and parsing terminal output is exactly what Claudio must not grow into.
5. **Tracking beta releases and patching xterm and its addons locally.** Claudio pins stable
   releases and patches nothing in the view. `node-pty` is the one exception to "stable": t0 pinned
   its `1.2.0-beta.15`, which ships a Linux prebuild and needs no patch.
6. A plain `!==` for the daemon's token: Claudio's tickets compare hashes with `timingSafeEqual`.
7. One socket multiplexing every terminal with its own credit ledger: right for 128 phone streams
   through a relay, more than Claudio's ≤ 32 terminals need.

---

## 2. The design for Claudio

### 2.1 Shape in one paragraph

A `TerminalService` in `packages/core/src/terminals/` owns every terminal. The PTYs themselves run
in a **terminal host**: one child process of the API server (`child_process.fork`, not detached),
started at the first terminal, that holds `node-pty` and one headless `@xterm/headless` screen per
shell, so a client that reconnects is repainted from a serialized snapshot. The host lives exactly
as long as the server. The API (`apps/api/src/routes/terminals.ts`) exposes REST routes to list,
create and close terminals and a **WebSocket** per terminal for the byte stream. The browser side
is an `xterm.js` view (`apps/web/src/components/terminal/`), lazy-loaded, styled from Night Shift
tokens. The feature is **off by default** and guarded by its own gate (§3).

```
browser (xterm.js) ──ws: binary out / binary in / JSON control──▶ apps/api terminals route + gate
        ▲                                                             │
        └── REST: list, create, ticket, close ───────────────────────▶│
                                                                      ▼
                                                    packages/core TerminalService (API process)
                                                       ├─ registry, limits, idle, tickets, flow control
                                                       ├─ SQLite rows (sessions, attachments)
                                                       └─ IPC (fork channel) ──▶ terminal host (child process)
                                                                                  ├─ node-pty (shell, own session/pgid)
                                                                                  └─ @xterm/headless + serialize + unicode11
```

**Why a host process and not node-pty in the server.** Three reasons, the first learned from the
reference (§1.2):

1. `node-pty` does not mark the PTY master close-on-exec, so every process the server spawns
   after a terminal opened (every `claude` turn, every `git`, `gh`) would inherit the master of the
   person's shell: an agent process would hold a writable handle on it. The host spawns nothing but
   shells, so the masters never reach a chat. (Shells do not inherit each other's masters: t0 found
   that `1.1.0`'s do, while the pinned `1.2.0-beta.15` closes inherited descriptors in the PTY's
   child. The host must still never use `child_process`, whose children would get every master.)
2. A native fault in `node-pty` takes down the host, not the API: the terminals end, the chats and
   orchestrations go on.
3. The headless screens' memory is off the API's heap, and the host's RSS is one number to watch.

Rejected: a **detached daemon** that survives the server (the reference's model; its cost is in
§1.8, and it is open question Q3); node-pty in the server process (above).

### 2.2 Where the code lives

| Piece | Path | Why there |
|---|---|---|
| Service, registry, limits, lifetime | `packages/core/src/terminals/service.ts` | core owns processes, settings and the store; the API stays a thin adapter, as for chats |
| Host client (fork, IPC, restart policy) | `packages/core/src/terminals/host-client.ts` | the service talks to an interface; tests inject an in-process fake host |
| Host entry (the child) | `packages/core/src/terminals/host/main.ts`, bundled as `terminal-host.mjs` | holds `node-pty` and the screens; loads `node-pty` lazily and reports `pty-missing` |
| PTY backend (`node-pty` loader behind an interface) | `packages/core/src/terminals/host/pty.ts` | one place that knows the native module |
| Working directory resolution | `packages/core/src/terminals/cwd.ts` | confinement is a core rule, tested without HTTP |
| Environment | `packages/core/src/terminals/env.ts` | the scrub list sits beside `child-env.ts`, reviewed together |
| Screen mirror and snapshot | `packages/core/src/terminals/host/screen.ts` | `@xterm/headless` + `@xterm/addon-serialize` + `@xterm/addon-unicode11` |
| Flow control | `packages/core/src/terminals/flow.ts` | pure logic, unit-tested with a fake clock |
| Peer-process check | `packages/core/src/terminals/peer.ts` | Linux `/proc` reading, reuses `processes.ts` |
| Settings document | `<data>/terminal.json`, `packages/core/src/terminals/settings.ts` | settings-shaped: JSON (CONTRIBUTING, "Persistence") |
| Rows | `packages/core/src/db.ts` (two new tables, appended to `MIGRATIONS`) | records that accumulate: SQLite |
| Routes and WebSocket | `apps/api/src/routes/terminals.ts`, `apps/api/src/terminal-socket.ts` | HTTP concerns, the upgrade, Origin |
| Gate | `apps/api/src/security.ts` (a `TERMINAL` block) + `terminal-gate.ts` | the guard already decides who is who; the gate adds the terminal's own rules |
| Shared types | `packages/shared/src/types.ts` (a `Terminal` section) | the API contract |
| View | `apps/web/src/components/terminal/` | `TerminalView`, `TerminalTabs`, `KeyBar`, `useTerminalSocket`, `terminal-theme.ts` |
| Pages | `apps/web/src/pages/Terminals.tsx`, a dock in `pages/ChatView.tsx` | §4 |
| Styles | `apps/web/src/styles/terminal.css`, tokens in `packages/ui/src/styles/tokens.css` | one file per area |

`packages/ui` does not get xterm: it is a 300 kB dependency used by one screen, so it stays in
`apps/web` behind `lazyPage()` / a dynamic `import()`, out of the first-paint bundle.

### 2.3 Dependencies

| Package | Where | Notes |
|---|---|---|
| `node-pty` `1.2.0-beta.15` (Microsoft, its `beta` dist-tag), exact pin | `packages/core` (external to esbuild, loaded only by the host) | the only native module Claudio would ship. It carries a Linux x64 prebuild (glibc ≥ 2.28); N-API, so the one binary loads on Node 22, Electron 44's Node and Node 26 (t0). Its install script need not run: list it in `ignoredBuiltDependencies`. `onData` is typed `string` but hands `Buffer`s with `encoding: null` |
| `@xterm/headless` `6.0.0`, `@xterm/addon-serialize` `0.14.0`, `@xterm/addon-unicode11` `0.9.0` | `packages/core` (host) | pure JS, bundled by esbuild (about 390 KB in the host bundle). The headless package's `module` field names a file it lacks, so only `platform: 'node'` bundling (which reads `main` first) works |
| `@fastify/websocket` `^11` (wraps `ws` `^8`) | `apps/api` | pure JS; `bufferutil` / `utf-8-validate` stay uninstalled (optional) |
| `@xterm/xterm` `6.0.0`, `@xterm/addon-fit` `0.11.0`, `-webgl` `0.19.0`, `-search` `0.16.0`, `-web-links` `0.12.0`, `-unicode11` `0.9.0` | `apps/web` | exact pins of the 6.0 release, the same major as the headless screen (t0: 6.0.0 has been stable since 2025-12-22; 5.5's `addon-serialize` peer-depends on `@xterm/xterm` 5), never the betas the reference tracks. 6.0 has no canvas addon; the fallback is the DOM renderer |

Claudio has **no native module today**: the SQLite store is `node:sqlite`, the API ships as a
single esbuild file, `electron-builder.yml` says `npmRebuild: false` and the Docker image carries no
`node_modules`. `node-pty` breaks that property, so it is contained:

- Only the host loads it, with `createRequire(import.meta.url)`, and only once the first terminal is
  asked for, never at start-up. A missing or broken binary makes the host answer `pty-missing`; the
  feature reads **unavailable** with that reason and the loader's error in the server log; nothing
  else in Claudio depends on it. `node-pty`'s own loader reports only the last path it tried, which
  hides the real cause (a glibc mismatch, say), so on failure the host also `require()`s the `.node`
  file it expects and logs that error.
- esbuild bundles the host as a fourth entry point (`terminal-host.mjs`, beside `server.mjs`,
  `api.mjs` and `mcp.mjs` in `apps/api/scripts/bundle.mjs`) and marks `node-pty` external. Each
  distribution ships the module beside the bundles: the Docker image copies `node_modules/node-pty`
  next to `/app/api.mjs`; the desktop app puts it under `<resources>/server/node_modules/node-pty`
  (`extraResources`), where Node's resolution from `terminal-host.mjs` finds it. What ships is
  `package.json`, `lib/` and `prebuilds/linux-x64/pty.node`, 172 KiB, copied with pnpm's symlinks
  dereferenced: the bundle script stages them into `apps/api/dist/node_modules/node-pty`, where the
  existing `from: ../api/dist` entry and the Dockerfile pick them up.
- Nothing compiles: the pinned beta carries the Linux x64 binary (t0). Rejected: `1.1.0`, which
  would need `python3 make g++` in the Docker build stage, `onlyBuiltDependencies`, and a desktop
  build in an old-glibc container (a binary compiled on a recent machine refuses older glibcs);
  `@lydell/node-pty`, a third party's repackaging of the same beta.

### 2.4 Transport: WebSocket, not POST + SSE

Claudio streams chats with SSE (`apps/api/src/sse.ts`). A terminal needs the other direction too,
at keystroke rate. Two options were weighed:

| | POST per input + SSE for output | One WebSocket per terminal |
|---|---|---|
| Keystroke latency | one HTTP request per key or per batch; head-of-line ordering across concurrent `fetch`es must be rebuilt with sequence numbers | one frame on an open socket |
| Browser connection budget | each SSE holds one of the **six HTTP/1.1 connections per origin**; Claudio already holds `/api/events` and a chat stream, so three terminals plus their POSTs starve the page (LAN and the desktop app are plain HTTP/1.1) | WebSockets do not count against that pool |
| Binary output | SSE is text: PTY bytes would be base64'd (+33 %) or decoded to text server-side, splitting multi-byte UTF-8 at chunk edges | binary frames carry raw bytes; xterm decodes UTF-8 across writes |
| Back-pressure | none from the browser: the server only learns of a slow client when TCP fills | `ws.bufferedAmount` on the server, plus explicit acks (§2.7) |
| Proxies | works everywhere | needs `Upgrade` support: Fastify, Vite's proxy (`ws: true`), Tailscale Serve, Caddy and nginx (with the two headers) all carry it |
| Auth | `EventSource` cannot set headers, already solved with `?token=` | the browser's `WebSocket` cannot set headers either: solved with a one-time ticket (§3.6) |

**Decision: a WebSocket per terminal**, at `GET /api/terminals/:id/socket`, through
`@fastify/websocket` on the same Fastify instance and port. Rejected: POST + SSE (connection budget
and latency above); one multiplexed socket for all terminals (a slow terminal's back-pressure would
stall the others, and closing a tab could not simply close its socket).

The `onRequest` hook in `security.ts` runs for the upgrade request (it is a GET through Fastify's
lifecycle), so the host allowlist, read-only and actor resolution apply before the handshake; t0
confirmed it (Fastify 5.12.5, `@fastify/websocket` 11.3.4): the hook sees the full URL and a reply
from it refuses the upgrade before the route's handler runs. An accepted socket is closed by
`@fastify/websocket` on `app.close()`. **A refused one is not:** once a request has asked to
upgrade, Node no longer tracks its socket, so `forceCloseConnections` does not reach it, and
`app.close()` never resolves (t0 reproduced it). Every HTTP answer to an upgrade request (the
guard's 401/405/421, the gate's 403/409, a 404) therefore destroys the socket once written
(`reply.raw.once('finish', () => req.raw.socket.destroy())`), from one `onRequest` hook registered
first; t3 tests it by closing the app after a refused upgrade.

**Dev server.** Vite's proxy carries the upgrade only with `ws: true` (without it the client hangs).
The existing `/api` entry has `changeOrigin: true`, which hands the API `Host: localhost:8797`
beside the page's `Origin: http://localhost:5181`: the Origin check (§3.7) would refuse every dev
socket, and a LAN device reaching a dev server started with `--host` would pass the loopback test
(§3.4). The socket gets its own entry, before `/api`, with `ws: true` and `changeOrigin: false`, so
the API sees the Host the browser dialled.

**Framing.** One socket carries three kinds of frame:

| Direction | Frame | Content |
|---|---|---|
| server → client | binary | PTY output bytes, in order, coalesced (§2.7) |
| client → server | binary | input bytes (keys, paste), UTF-8 |
| both | text | one JSON control message, `TerminalServerFrame` / `TerminalClientFrame` in `types.ts` |

Control messages: client `resize {cols, rows}`, `ack {bytes}`, `focus` (claims the size, §2.8);
server `hello {terminal, cols, rows, snapshot}` (followed by the unfinished tail as a binary
frame, §2.5), `size {cols, rows}`, `exit {code, signal}`, `closed {reason}` (a `TerminalEndReason`
of §5.2, or `evicted-slow`). Input
frames are capped at 64 KiB and a paste at 1 MiB (the view splits a large paste into frames;
anything over the cap is refused in the view with a toast, never truncated silently).

### 2.5 Lifetime, reattach and cleanup

**A terminal lives in the server (in its host), not in the page.** Closing the tab, reloading or losing Wi-Fi
detaches the socket; the shell keeps running. The terminal ends when:

1. the shell exits (the person typed `exit`): state `exited` with its code, kept in the list for
   one hour so the person sees how it ended, then forgotten;
2. the person closes it (`DELETE /terminals/:id`);
3. it has had **no client attached for `idleMinutes`** (default 30, 5–1440);
4. the server stops;
5. the feature is turned off (every terminal is closed, with `closed {reason: 'disabled'}`).

**Ending a terminal** sends `SIGHUP` to its process group (the PTY makes the shell a session
leader, so its jobs are in that group), then `SIGTERM`, then `SIGKILL` after a grace of 3 s to what
still has the same pid and start time. The host reuses `processTable()` / `descendantsOf()` /
`terminateTree()` from `packages/core/src/processes.ts` (bundled into it): a job that left the group
but is still a descendant of the shell is found by ancestry, as the chats' commands are.

**The host's channel.** The service talks to the host over the `fork` IPC channel with
`serialization: 'advanced'` (structured clone, so output travels as `Buffer`, not as JSON strings).
Messages: `spawn`, `write`, `resize`, `pause`, `resume`, `snapshot`, `kill` one way; `ready`,
`data`, `exit`, `snapshot`, `error` the other. The host is started with an empty `process.env`
except what `env.ts` builds per shell (§2.11), so it holds no `CLAUDIO_*` secret either. Under the
desktop app the server runs on Electron's Node, so the host is forked with `process.execPath` and
`ELECTRON_RUN_AS_NODE=1` in **its** environment only (never in the shells').

**Server stop.** `Core.stop()` (the path `SIGTERM` to the server already runs) calls
`terminals.closeAll('server-stopping')` before the chats stop: the host sends each group
`SIGHUP` → `SIGTERM` → `SIGKILL` (3 s grace) and exits.

**Crash.** If the server dies hard (even `SIGKILL`), the host's IPC channel closes; the host's
`disconnect` handler kills every shell's tree the same way and exits, so shells do not outlive
their server. The host itself dying (OOM killer) ends its PTYs: the kernel sends `SIGHUP` to each
shell. For what still survives both, each terminal's row carries `pid`, `pid_started` (start time
from `/proc/<pid>/stat`) and `server_pid`. At start-up, `terminals.reapStrays()` reads rows with
`ended_at IS NULL` from a previous server, kills each tree whose root still has the same pid **and**
start time, and marks the row `ended_reason = 'server-crashed'`. Same idea as the `runtime.strays()`
check `server.ts` already does for chats.

**The host dying while the server lives** ends every terminal with `closed {reason: 'host-failed'}`;
the next `POST /terminals` starts a new host. After 3 failures in 5 minutes the feature reads
unavailable (`reason: 'host-failed'`) until the server restarts or the person turns it off and on.

A process the person deliberately detached (`nohup`, `setsid`, a double fork) leaves the shell's
process group and its ancestry, and survives closing the terminal, as it does in any terminal
emulator. That is the person's choice and stays so; the plan does not hunt it.

**Reattach.** On every socket open the service asks the host for a snapshot: the host stops
forwarding live output for this terminal's new client, flushes pending output into the headless
screen (awaits the write callback), serializes it (`SerializeAddon.serialize({ scrollback })`), and
returns it with the screen's size and the **unfinished tail**: the bytes since the parser was last in
its ground state, which the serializer drops (a sequence cut in half at the snapshot instant). The
server sends `hello`, then the tail, then everything after. The view, in this order:

1. `term.reset()`, then resize to the **snapshot's** cols × rows (replaying at another width rewraps
   the screen);
2. writes the snapshot **with input replies muted**: xterm answers queries it finds in the snapshot
   (DA1, cursor position, OSC 11 colour), and those answers would be typed into the shell. The
   view drops `onData` until the snapshot's write callback fires;
3. writes the tail and the live bytes, then fits to its own panel and sends `resize`.

A reload thus shows the same screen, including the alternate screen of `vim` or `htop` and the
cursor. Raw byte replay was rejected: a ring buffer cut at an arbitrary byte starts in the middle
of an escape sequence or a UTF-8 character and cannot rebuild an alternate screen. Every reattach
takes a fresh snapshot; there is no resume by sequence number (the reference concluded the same).

**Across a server restart** (a desktop update, `docker restart`) terminals do **not** survive in
v1: the shells are children of the server. The view shows the ended terminal with
"Server restarted" and an "Open again" button that creates a new terminal in the same directory.
Keeping shells alive in a separate daemon is open question Q3.

### 2.6 Scrollback

- **Server (host):** the headless screen keeps `scrollbackLines` (default 2 000, 500–10 000) per
  terminal. The reference settled on 1 000 live lines after 100+ terminals at full depth reached
  about 1 GB; Claudio caps terminals at 32, so 2 000 by default and 10 000 at most bound the host to a
  few hundred MB in the worst case and tens of MB normally. t7 measures it.
- **Replay:** `replayLines` (default 1 000) are serialized on reattach, and the snapshot must fit
  **512 KiB**: if it does not, the host steps down (1 000, 500, 250, 100, 0 lines), so `hello` stays
  small on a phone.
- **Client:** xterm's own `scrollback` is 5 000 lines, so a session that stays attached scrolls
  further back than a reattach restores; that difference is expected and invisible in practice.
- Nothing is written to disk: no scrollback file, no SQLite column. A terminal's output can hold
  passwords and tokens the person typed or printed.

### 2.7 Flow control

A runaway command (`cat` of a large file, `yes`) must not grow memory without bound, and a slow
phone must not freeze the shell for the desktop window watching the same terminal.

- **Coalescing:** PTY data is gathered for up to 4 ms or 64 KiB, whichever first, and sent as one
  binary frame; a chunk under 1 KiB arriving after 4 ms of quiet (a keystroke's echo) is sent at
  once. The headless screen gets every chunk as it arrives.
- **Acks:** the view sends `ack {bytes}` after each 64 KiB that **xterm has parsed** (the
  `term.write(data, callback)` callback), not when the frame arrived: a browser that receives fast
  but renders slowly is the case that matters.
- **Watermarks per client:** unacked bytes above 2 MiB → the service asks the host to
  `pty.pause()`; below 512 KiB for every attached client → `resume()`. While paused the shell blocks
  on write, which is exactly what a real terminal does. A pause is re-checked every 5 s, so a
  detached client's stale count can never leave a shell paused: a client that closes takes its
  unacked bytes with it.
- **A client that cannot keep up does not hold others hostage:** a client more than 8 MiB behind,
  or with `ws.bufferedAmount` above 8 MiB, is closed with `closed {reason: 'evicted-slow'}` and
  reattaches from a fresh snapshot. With no client attached, output only feeds the headless screen
  and never pauses (scrollback is bounded by lines).
- `flow.ts` is pure (bytes in, decisions out) and unit-tested with a fake clock.

### 2.8 Size and many clients

- The view runs `@xterm/addon-fit` from a `ResizeObserver`: on a change it starts a
  `requestAnimationFrame` loop that waits until `proposeDimensions()` returns the same size on two
  frames running (at most 8 frames), so a panel being dragged does not send a storm of `SIGWINCH`;
  it sends `resize` only when cols or rows changed, and refits once after the renderer changes
  (WebGL and DOM cells measure differently). The host resizes the headless screen first, then the
  PTY (`SIGWINCH` reaches the foreground job).
- **Several clients on one terminal** (desktop window and phone): the size belongs to the client
  that most recently sent input, focused or resized ("active client"). The others receive
  `size {cols, rows}` and render at that size inside their panel, with the leftover area in
  `--bg-1`; they do not fight. Rejected: smallest-wins (one phone makes the desktop terminal 40
  columns wide for as long as it stays attached).
- Defaults when nothing has measured yet: 80 × 24. Bounds: 2–500 cols, 1–200 rows.

### 2.9 Many terminals

- A terminal belongs to one **scope**: a project (its own checkout or one of its worktrees) or a
  chat (its worktree, or its directory). Several terminals per scope; tabs in the panel.
- `maxTerminals` (default 8, max 32) running at once across the install. Creating one past it
  answers `409 terminal.limit`; the view offers to close the oldest idle one.
- Ids are ours (`term_` + 16 random bytes, base64url), never derived from a pid or a path.
- A terminal's title is what the shell sets with OSC 0/2, rendered in the tab by xterm's
  `onTitleChange` in the view. The server does not parse it.

### 2.10 Working directory: ids in, path out

**The client never sends a path.** `POST /terminals` takes `{ projectId, worktree? }` or
`{ chatId }`, and `cwd.ts` derives the directory:

- `projectId` → `Project.path`; with `worktree`, the value must equal the `path` of one of that
  project's `ProjectWorktree` entries as Claudio lists them (`git worktree list`, the same source
  the project page uses).
- `chatId` → the chat's `worktree.path` when it has one, else the chat's own `cwd`, and in both cases
  the directory must be the chat's project path or one of its worktrees (a chat outside any project
  gets no terminal: `400 terminal.no-project`).
- The result goes through `fs.realpathSync` and is compared with the realpath of the allowed roots,
  so a symlinked worktree cannot point the shell elsewhere; it must exist and be a directory.
- What the person does with `cd` afterwards is theirs: this confines where Claudio **opens** a
  shell, not what a shell may do. The plan says so in the Settings copy.

### 2.11 The shell and its environment

**Shell:** `settings.shell` if set (an absolute path that exists and is listed in `/etc/shells`),
else `$SHELL` of the server, else `os.userInfo().shell`, else `/bin/bash`, else `/bin/sh`. Started as
a login shell (`-l`) when `loginShell` is on (default), so the person's profile, PATH and prompt
load as in their own terminal emulator. Linux and macOS only; Windows is out of scope (Claudio ships
for Linux and Docker).

**Environment** (`env.ts`): built from the server's `process.env`, then:

- **Removed, always:** every `CLAUDIO_*` variable (the API URL, chat id and token, auth token and
  mode, desktop token, secret key, data dir…), `ELECTRON_RUN_AS_NODE` (the desktop server runs on
  Electron's Node; a `node` started from the shell would otherwise behave as Electron),
  `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, the
  dev-time `npm_*` / `PNPM_*` / `INIT_CWD` noise, `NODE_ENV` (the image sets `production`, which
  would make the person's `pnpm install` skip dev dependencies), and the AppImage runtime's
  `APPIMAGE`, `APPDIR`, `ARGV0`, `OWD` and the `LD_LIBRARY_PATH` / `PATH` entries that point into
  its mount. A unit test asserts no `CLAUDIO_` prefix survives.
- **Kept:** `HOME`, `USER`, `PATH`, `LANG` / `LC_*`, `SHELL`, `SSH_AUTH_SOCK`, `DISPLAY`,
  `WAYLAND_DISPLAY`, `XDG_*`, `CLAUDE_CONFIG_DIR` (in Docker it is the image's documented location,
  not a secret), `GH_CONFIG_DIR` / `GLAB_CONFIG_DIR` (paths, not tokens).
- **Added (owner decision 3):** the vault's tool credentials (GitHub, GitLab, YouTrack…), built
  as the code hosts' environment is (`hosts/env.ts`), so the person's `gh`, `glab` and tracker CLIs
  work. Claude's own credentials are never added. A unit test asserts the tool values are present
  and no `CLAUDIO_` prefix or Claude credential survives.
- **Set:** `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=Claudio`,
  `TERM_PROGRAM_VERSION=<version>`, `LANG=C.UTF-8` when no locale is set, and `PWD` to the cwd.
- **Never set:** `CLAUDIO_CHAT_ID`. `processes.ts` finds chat processes by that variable in
  `/proc/*/environ`; a terminal's processes must never be mistaken for a chat's (and the peer check
  of §3.5 relies on it).

**Prerequisite fix found while planning** (task t2a): `apps/api/src/server.ts` deletes
`CLAUDIO_DESKTOP_TOKEN` and `CLAUDIO_SECRET_KEY` from `process.env` after `new Core()`, but **not
`CLAUDIO_AUTH_TOKEN`**. A deployment that seeds the owner's token through the environment (Docker,
Compose, Helm) therefore hands the owner's token to every chat process today, which can then do
anything the owner can. Delete it there too; `AuthStore` has already read it into `config.authEnv`.
This is worth fixing even if the terminal is never built.

### 2.12 Electron

- The desktop server is `server.mjs` on Electron's Node (`ELECTRON_RUN_AS_NODE`, which
  `standalone.ts` deletes from `process.env` at start). The terminal host is forked from it with
  `process.execPath` and `ELECTRON_RUN_AS_NODE=1` set for the host alone (§2.5). `node-pty` is
  N-API, so the same Linux x64 binary loads there: t0 ran a bundled host on Electron 44.5.1 from an
  AppImage stand-in (the real AppImage runtime, a read-only `nosuid,nodev` FUSE mount); the
  integrator confirms it on the AppImage `desktop:dist` builds (report §9). node-pty needs its
  `spawn-helper` on macOS only, not on Linux.
- `electron-builder.yml`: add `terminal-host.mjs` and `node_modules/node-pty/**` to the `server`
  extraResources (staged into `apps/api/dist` by the bundle script, §2.3); `npmRebuild: false`
  stays, since the prebuilt binary loads, and the file says why.
- The window loads the UI from the local server, so the view and the socket are same-origin;
  nothing changes in `preload.ts`. Keyboard: Electron's menu accelerators must not swallow the
  terminal's keys — while a terminal has focus, the shell's `Ctrl+W`, `Ctrl+R` and `Ctrl+Shift+C/V`
  reach it; `apps/desktop/src/menu.ts` keeps its accelerators off those (checked by hand in t5).
- With auth off, the desktop app's window counts as the local machine (§3.4), so the terminal works
  there with nothing to set up once the person turns it on.

### 2.13 Docker

- The image gets `node_modules/node-pty` beside `api.mjs` (copied from the build stage).
  `node:26-bookworm-slim` has `bash`; `procps` is already installed. No compiler is added to either
  stage: the prebuilt binary loads there as user `node` (t0). Inside the container a master reads
  `/dev/pts/ptmx`, not `/dev/ptmx`.
- `HOST=0.0.0.0` and auth `none` by default in the image means every request arrives from the
  bridge, not from loopback, so **with auth off the terminal is unavailable in Docker**
  (`reason: 'needs-auth'`) by construction (§3.4). With a token set it works, in the container as
  user `node`, in `/workspace/...` project paths.
- `CLAUDIO_TERMINAL=off` lets an operator veto the feature for the whole deployment (the layered
  settings rule: the environment wins and the UI shows it read-only). The Helm chart exposes
  `terminal.enabled` defaulting to `off`.
- Reverse proxies need the WebSocket upgrade: `docs/deploy.md` gets the Caddy (works by default) and
  nginx (`proxy_http_version 1.1`, `Upgrade`, `Connection`) lines.

### 2.14 Phone

A terminal on a phone is useful for short things (`git status`, a test, a restart). The layout:

- A full-screen detail route (`/terminals/:id`), like a chat: the tab bar hides, the top bar holds
  the back button, the terminal's title (mono) and a `⋯` `Sheet` (close, new terminal, font size).
- A **key bar** above the on-screen keyboard: `Esc`, `Tab`, `⇧Tab` (`ESC [ Z`), `Ctrl` (sticky,
  one press), `Alt` (sticky), `↑ ↓ ← →` (auto-repeat after 400 ms, then every 45 ms), `|`, `~`, `/`,
  `-`, and one-tap `^C`, `^D`, `^L`, `^R`. Buttons are ≥ 44 px, scroll horizontally, and sit on
  `--keyboard-inset` from `apps/web/src/lib/viewport.ts`, the same measurement the composer uses.
  Direct input only (each key goes to the shell as typed); a buffered "command line" mode is left
  for later.
- xterm's hidden textarea gets `font-size: 16px` so iOS does not zoom on focus; the rendered cell
  font stays at the terminal's own size (13 px desktop, 12 px phone, adjustable).
- Touch: a tap focuses and raises the keyboard; one-finger vertical drag scrolls the scrollback;
  long-press selects (xterm), and the `⋯` sheet offers "Copy selection" and "Paste".
- On a phone the WebGL renderer is skipped (battery, context limits): the DOM renderer is used.

---

## 3. Security

### 3.1 Threat model

A shell reachable over HTTP is remote command execution as the user who runs Claudio. The owner
runs Claudio on the LAN with **authentication off**. The attackers worth naming:

| Who | How they would get in | What stops them |
|---|---|---|
| Anyone on the LAN | `ws://192.168.1.x:8797/api/terminals/...` | with auth off, only the local machine may use the terminal (§3.4) |
| A listener on the LAN | reads the token and keystrokes of a phone using the terminal over plain HTTP | remote use only through the tunnel by default (§3.4.1) |
| A web page the owner visits (cross-site WebSocket hijacking) | JavaScript on `evil.example` opens a socket to the LAN address; browsers do not apply CORS to WebSockets | Origin check on the upgrade (§3.7) and the ticket, which a cross-origin page cannot read (§3.6) |
| DNS rebinding | a name that resolves to 127.0.0.1 | the existing host allowlist (`421`), plus the Origin check |
| A prompt injection in a chat | the agent calls the API with its `CLAUDIO_API_TOKEN`, or with no token at all from loopback | chat tokens refused (§3.3); the peer-process check refuses any connection from a chat's process tree (§3.5) |
| A leaked owner token | the attacker is the owner as far as the API knows | the feature is still off unless turned on; idle limits; audit rows say from where |
| The tunnel | `tailscale serve` forwards to loopback | the tunnel already refuses `mode: none`; through it, requests carry a runtime host and never count as local (§3.4) |

An agent running in `bypassPermissions` already has a shell through its Bash tool. The terminal
must not give **more** than that: a chat in a restricted permission mode must not escape its tool
policy through the terminal, and no agent may type into a shell the **person** has open (input
injection into a session the person trusts).

### 3.2 Off by default, and who may turn it on

- `terminal.json` → `enabled: false` on every new install. `CLAUDIO_TERMINAL=off|on` overrides it
  (layered settings: environment wins, the UI shows it read-only).
- `PUT /terminal/settings` (turning it on or changing limits) is accepted only from an actor that
  could use the terminal under §3.4, is in the chat-forbidden set (§3.3), refused in read-only
  (§3.8), and audited like every write.
- Turning it **off** is always allowed to the owner (it only reduces exposure), and closes every
  terminal at once.

### 3.3 Chat tokens and the desktop secret are always refused

A new `CHAT_FORBIDDEN_TERMINAL` set in `apps/api/src/security.ts` lists **every** terminal route,
reads included (`GET /terminal`, `GET /terminals`, `GET /terminals/:id`, `POST /terminals`,
`POST /terminals/:id/ticket`, `GET /terminals/:id/socket`, `DELETE /terminals/:id`,
`PUT /terminal/settings`, `GET /terminal/history`): `403 "a chat's token cannot open, read or type
into a terminal: the terminal is the person's"`. Reads are included because the list says which
shells the person has open and where.

Under `mode: none` the guard does not refuse a chat token today, it only labels the request
(`security.ts`, "Open mode grants everything"). The terminal gate does refuse it: a request whose
actor resolved to `chat:<id>` is refused whatever the mode. A chat that sends **no** token under
`mode: none` is caught by §3.5 instead.

The desktop app's per-launch secret (`DESKTOP_ACTOR`) only reads, by design; the terminal gate
refuses it too (its tray has no use for a shell).

### 3.4 With auth off: this machine only

The gate (`apps/api/src/terminal-gate.ts`, called by every terminal route and by the upgrade):

1. The feature is enabled and the PTY backend loaded; else `409` with `reason`.
2. Read-only is off; else `405` (§3.8).
3. The actor is not a chat and not the desktop secret (§3.3).
4. **`mode: 'none'`** → the request must come **from the local machine**: the socket's remote
   address is loopback, the `Host` names loopback, it is not a runtime host (a tunnel), and it
   carries no `Forwarded`, `X-Forwarded-For` or runtime client-IP header. This is the existing
   `fromLocalChat()` check of `security.ts`; extract it as `fromLocalMachineStrict()` and use it for
   both. Anything else answers `403 terminal.needs-auth`: "Turn on token authentication in Settings →
   Security to use the terminal from another device." In Docker with auth off this is every request
   (they arrive from the bridge), which is the intent.
5. **`mode: 'token' | 'oidc'`** → the owner's credential (`token:<id>` or an OIDC subject) is
   required. From another device it is allowed **as `settings.remote` says** (§3.4.1).
6. The peer-process check (§3.5) passes.

#### 3.4.1 From another device: only over an encrypted path by default

Claudio on the LAN is plain HTTP (`http://192.168.1.x:8797`). With token auth on, a terminal used
from the phone over that address sends the bearer token, the ticket and **every keystroke** —
including the passwords typed into `sudo` or `ssh` — in clear text to anyone on the network. A
token stops strangers from opening a shell; it does not stop them from reading one. So
`terminal.json` has `remote`:

| `remote` | Another device may use the terminal… | Default |
|---|---|---|
| `off` | never: this machine only, whatever the auth mode | |
| `tunnel` | only through the tunnel (`tailscale serve`: HTTPS inside the tailnet's WireGuard). Told apart by the request's runtime host, which only a running tunnel lends | **yes** |
| `any` | also over the plain LAN address. The Settings card says, beside the switch, that the token and keystrokes then cross the network unencrypted, and recommends the tunnel | |

A reverse proxy that terminates TLS (Caddy in `deploy/`) arrives from its own address with headers
Claudio does not trust, so it counts as `any`, not `tunnel`; `docs/deploy.md` says so. Open
question Q1 asks the owner whether `tunnel` is the right default for the way they use the phone.

### 3.5 Peer-process check (defence in depth)

On Linux, for a connection from loopback, the server can tell which **process** opened it: find the
client's port in `/proc/net/tcp` and `/proc/net/tcp6`, take the socket inode, find the pid that holds
`socket:[inode]` under `/proc/*/fd`, and walk its ancestors. If that process or any ancestor is a
chat's CLI process (`claudioChildren()` in `processes.ts`, found by `CLAUDIO_CHAT_ID` in its
environ), or a descendant of one, the request is refused with `403 terminal.from-agent`, and the
attempt is written to the audit rows.

- This closes the gap no credential can: under `mode: none`, an agent on the same machine that
  calls the API **without** a token looks exactly like the person's browser.
- It runs only on the terminal routes and the upgrade, and the table of chat pids is cached for 1 s.
  Finding the holder of an inode by scanning every `/proc/*/fd` costs 30–40 ms on a desktop (t0), so
  the check scans only the fds of the chat processes and their descendants: if one of them holds the
  client's socket, refuse. That is the same answer as the ancestor walk, at a fraction of the cost.
  A peer seen as `::ffff:127.0.0.1` is an IPv4 socket, found in `/proc/net/tcp`, not `tcp6`.
- "Holder not found" is `unknown`, not "not a chat": a client running as another user has an `fd`
  directory the server cannot read.
- Behind Vite's dev proxy the peer is Vite's Node process: if a chat started the dev server, every
  request through it reads as an agent's and is refused. Correct, and worth a line in Settings.
- Where `/proc` cannot be read (macOS dev, a hardened container), the check reports `unknown` and
  the gate refuses under `mode: none` (fail closed) and allows under `token`/`oidc` (the credential
  already proves the person). Settings says which case applies.
- It does not replace §3.3: a chat token is refused before this runs.

### 3.6 Tickets for the socket

The browser's `WebSocket` cannot send `Authorization`. Rather than add the socket to the
`?token=` list (the owner's long-lived token would land in access logs and history), the socket
takes a **ticket**:

- `POST /terminals/:id/ticket` (bearer-authenticated like any route, through the gate) returns
  `{ ticket, expiresAt }`: 32 random bytes, valid **30 s**, **single use**, bound to the terminal id,
  the actor and the `Origin` that asked for it. Held in memory as a hash, like chat tokens.
- `GET /terminals/:id/socket?ticket=…` is exempt from the bearer check in `security.ts` (like the
  webhook receivers it carries its own proof), but the host allowlist, read-only and the gate still
  run. The ticket is consumed before the handshake completes. A wrong, used or expired ticket
  answers `401` and counts in `FailureBackoff`.
- Fastify's request logging prints `req.url`: add a serializer that removes `ticket=` (and the
  existing `token=`) from logged URLs.
- The view asks for a new ticket on every (re)connect.

### 3.7 Origin and Host

- The upgrade requires an `Origin` header (every browser sends one on a WebSocket) equal to the
  origin the request was dialled on (`<scheme>://<Host>`) or listed in `CLAUDIO_CORS_ORIGIN`. A
  missing or other `Origin` answers `403` before the upgrade. This is what stops cross-site WebSocket
  hijacking from a page the owner visits, which CORS does not.
- The ticket is bound to the `Origin` of the `POST` that minted it, and must match on the socket.
- The existing host allowlist (`421`) runs first, so a rebinding name never reaches the gate.
- CSP: `connect-src 'self'` in `app.ts` covers same-origin `ws:`/`wss:` in current Chrome, Firefox
  and Safari (CSP3). t0 confirmed it for `ws:` from `http:` and `wss:` from `https:` in Chrome 154,
  Firefox 158 and WebKit 27.2, relative URLs (`new WebSocket('/api/…')`) included, with other ports
  still blocked. iOS Safari on the phone is the owner's check; if it fails, `connect-src` gains the
  exact `ws(s)://<host>` of the request, computed per request, never a bare `ws:`.

### 3.8 Read-only mode

Read-only refuses the whole feature: every terminal route, reads included, answers `405`, and the
upgrade is refused. Turning read-only on closes every terminal. Rationale: read-only exists so a
wrapper can be watched without being changed, and a shell is the largest possible change.
`READ_ONLY_ALLOWED` is not widened.

### 3.9 Audit

The existing `audit` table already records every mutating request (create, ticket, close, settings)
with actor and status. Terminal sessions add two tables, appended to `MIGRATIONS` in `db.ts`:

```sql
CREATE TABLE terminal_sessions (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,            -- 'project' | 'chat'
  project_id TEXT, chat_id TEXT,
  cwd TEXT NOT NULL, shell TEXT NOT NULL,
  actor TEXT NOT NULL,            -- who created it
  client TEXT NOT NULL,           -- 'local' or the client address
  pid INTEGER, pid_started INTEGER, server_pid INTEGER NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT,
  ended_reason TEXT,              -- exit | closed | idle | server-stopping | server-crashed | host-failed | disabled | read-only
  exit_code INTEGER
);
CREATE INDEX terminal_sessions_started ON terminal_sessions (started_at);
CREATE TABLE terminal_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  actor TEXT NOT NULL, client TEXT NOT NULL, origin TEXT,
  attached_at TEXT NOT NULL, detached_at TEXT,
  bytes_in INTEGER NOT NULL DEFAULT 0, bytes_out INTEGER NOT NULL DEFAULT 0,
  refused TEXT                     -- the gate's reason when the attempt was refused
);
CREATE INDEX terminal_attachments_session ON terminal_attachments (session_id);
```

- **Never input or output content**, only counts: what is typed in a shell includes passwords.
- Refused attempts (chat token, from-agent, needs-auth, bad ticket, bad origin) are rows with
  `refused` set, so the owner sees an injection that tried.
- Pruned like `audit` (keep the newest 10 000 attachments and 2 000 sessions).
- Settings → Security shows the last sessions and refused attempts (`GET /terminal/history`).

### 3.10 Limits

| Limit | Default | Bounds | Where |
|---|---|---|---|
| From another device | through the tunnel only | `off`, `tunnel`, `any` | `remote` (§3.4.1) |
| Running terminals | 8 | 1–32 | `terminal.json` `maxTerminals` |
| Idle with no client attached | 30 min | 5–1440 | `idleMinutes` |
| Exited terminal kept in the list | 1 h | fixed | |
| Clients attached to one terminal | 4 | fixed | |
| Server scrollback | 2 000 lines | 500–10 000 | `scrollbackLines` |
| Replayed on reattach | 1 000 lines, ≤ 512 KiB | ≤ scrollback | `replayLines` |
| Input frame / paste | 64 KiB / 1 MiB | fixed | |
| Ticket lifetime | 30 s, one use | fixed | |
| Failed tickets | `FailureBackoff` (existing) | | |

### 3.11 What the owner should know (copy for Settings)

The card that turns the terminal on says, in en/es: that it runs commands as the user that runs
Claudio, with access to everything that user can reach; that with authentication off it only works
on this machine; that from another device it goes through the tunnel unless the person allows the
plain LAN address, which sends keystrokes unencrypted; that with authentication off an agent that has a shell can reach it (a detached process leaves its
chat's process tree), while with token or OIDC authentication it cannot (shown as a warning beside the
switch only when the mode is `none`, decision 5); and that what is typed is not recorded, only who
opened what and when.

---

## 4. The UI

Follows [design-system.md](../design-system.md). A reference screen is drawn **before** the view is
built (task t6): `docs/design-system/reference/DesktopTerminal.html`, `MobileTerminal.html`, with
dark and light screenshots, and a "Terminal" section in `design-system.md` and the reference CSS.

### 4.1 Where it goes

- **Chat page** (`pages/ChatView.tsx`): a **bottom dock** under the transcript, toggled by a
  top-bar icon button (`SquareTerminal`, `aria-label` "Terminal") and `Ctrl+\``, resizable by a
  drag handle, height remembered in `localStorage` (`claudio-terminal-dock`). It opens in the
  chat's worktree. Not an inspector tab: the inspector is a narrow column of facts, a shell needs
  width. On a phone the button opens the full-screen route instead.
- **Project scope**: a page `/terminals?project=<id>` with tabs (one per terminal) and a "New
  terminal" split button whose menu picks the checkout or one of the project's worktrees (a
  `Select`, mono paths). Entry points: the project card's `⋯` menu ("Open terminal"), the Home
  header when Home is scoped to a project (`/?project=<id>`), and the command palette ("Open
  terminal in <project>").
- **Phone**: `/terminals/:id`, full screen (§2.14). The More sheet lists open terminals when there
  are any; no fifth tab.
- **Settings → Security**: a "Terminal" card: a `Switch` to turn it on, a `Select` for "From other
  devices" (`off` / through the tunnel / also over the LAN, the last with its warning in `--warn`
  and a word), the three `NumberInput`s (terminals, idle minutes, scrollback), the shell (read-only
  text, mono), whether the peer check runs here, why it may be unavailable, and the history table.
- Hidden entirely (no button anywhere) while the feature is off or unavailable to this client; the
  Settings card is the only place that says why.

### 4.2 Look

- **Surface:** the terminal sits on `--bg-1` in a `.card`-like frame with `--radius-lg` and a
  hairline `--line`; no gradient, no `.grad-border`, no energy border, no `--live`: a shell is not an
  agent working, and Night Shift reserves those for that.
- **Palette:** new tokens in `packages/ui/src/styles/tokens.css`, both themes: `--term-bg`,
  `--term-fg`, `--term-cursor`, `--term-selection`, and `--term-ansi-0` … `--term-ansi-15`. The 16
  ANSI colours are muted to sit with `--sx-*`, each ≥ 4.5:1 on `--term-bg` except black/bright black
  (which are backgrounds by convention), checked by a unit test in both themes. They are content
  colours, **not** status colours; nothing in Claudio's chrome uses them.
- `terminal-theme.ts` reads the tokens with `getComputedStyle(document.documentElement)` and builds
  xterm's `ITheme`; a `MutationObserver` on `data-theme` re-applies it on a theme switch. No hex in
  any stylesheet or component.
- **Type:** Geist Mono (`--mono`), 13 px desktop, 12 px phone, line height 1.2; the view awaits
  `document.fonts.load('13px "Geist Mono Variable"')` before opening xterm, or the cell width is
  measured on the fallback font and every glyph is misplaced. Ligatures off.
- **Motion:** the cursor blinks only at motion level `full` with the tab visible
  (`useDecorativeMotion()` and `document.visibilityState`); under `subtle`, `off`,
  `prefers-reduced-motion` or a hidden tab it is a steady block. `motion.spec.mjs` covers it.
- **Status of a terminal** in its tab and header, always a word and an icon: *Conectado* (ok),
  *Reconectando* (warn, no loop), *Terminó (0)* (neutral) / *Terminó con 1* (bad),
  *Cerrado por inactividad* (warn).
- **Empty state:** the project page with no terminal yet shows the compact empty line with a "New
  terminal" button, not an illustration (the page sits beside the project's content).
- **Controls:** `Tabs` / `TabPanel` for terminal tabs, `Select`, `Switch`, `NumberInput`, `Menu`,
  `Sheet`, `Tooltip` from `packages/ui/src/components/controls`.

### 4.3 Behaviour

- Renderer, an `auto` policy: `@xterm/addon-webgl` only with hardware WebGL2, and **never on Linux
  under Wayland or on a software GL** (SwiftShader, llvmpipe: read from `WEBGL_debug_renderer_info`),
  where the reference saw input wedge and atlas corruption; the DOM renderer otherwise, and on a
  phone. A context loss switches the terminal to DOM for the rest of its life. Only the terminal on
  screen holds a WebGL context; hidden tabs dispose it. A `localStorage` flag
  (`claudio-terminal-renderer=dom`) forces DOM, which the e2e uses to read text.
- Every `term.write(data, callback)` callback is wrapped in a `try`/`catch`: an exception inside
  one stalls xterm's write queue for good.
- Links: `@xterm/addon-web-links` opens `http(s)` URLs in a new tab with `rel=noopener`. File paths
  are **not** linked to an editor (the design system forbids linking to the person's editor).
- Search: `@xterm/addon-search`, `Ctrl+Shift+F` (desktop), a field in the dock header.
- Copy/paste: `Ctrl+Shift+C` / `Ctrl+Shift+V`, and selection copies on right-click; bracketed paste
  is xterm's, so a multi-line paste does not run line by line in a shell that supports it. Before
  pasting, the view replaces every ESC in the text with `␛` (U+241B), so a pasted `ESC[201~` cannot
  end the bracketed paste early and run what follows, and splits the paste into 64 KiB frames. A
  paste over 1 MiB is refused with a toast.
- App shortcuts (the command palette's `Ctrl+K`, `Ctrl+\`` to toggle) are handled before xterm via
  `attachCustomKeyEventHandler`; everything else goes to the shell.
- Hidden terminals (other tabs, a collapsed dock) stay attached but call nothing on xterm; when the
  page is hidden the view keeps receiving (acks keep flowing) but defers rendering to xterm's own
  scheduling.
- Accessibility: `screenReaderMode` follows a Settings toggle; the terminal region has `role` and an
  `aria-label` naming the directory; the dock's resize handle is keyboard-operable.

### 4.4 Copy

Every string goes through i18n with en/es parity under `terminal.*` (`apps/web/src/i18n/locales`).
Spanish from Spain per `GLOSSARY.md`: "Terminal" is feminine ("la terminal"), buttons in infinitive
("Abrir terminal", "Cerrar terminal", "Abrir de nuevo", "Copiar selección", "Pegar"), sentence case.
Add "terminal" to the glossary in the same pull request.

---

## 5. API, types and persistence

### 5.1 Routes

Tag **Terminal** in `apps/api/src/openapi/routes.ts`; a row each in a new "### Terminal" table of
the README's REST API section.

| Method | Route | Summary | Notes |
|---|---|---|---|
| GET | `/terminal` | The terminal feature | `{ enabled, available, reason, settings, sources, peerCheck, running }`; `reason` one of `off`, `disabled-by-env`, `pty-missing`, `host-failed`, `read-only`, `needs-auth`, `remote-off`, `needs-tunnel`, `from-agent`, `chat-token` |
| PUT | `/terminal/settings` | Change the terminal settings | `{ enabled?, remote?, maxTerminals?, idleMinutes?, scrollbackLines?, replayLines?, shell?, loginShell? }`; turning off closes every terminal. Emits `terminal.changed` |
| GET | `/terminal/history` | Terminal sessions and attempts | paged rows of `terminal_sessions` and refused `terminal_attachments` |
| GET | `/terminals` | Open terminals | `?project=` / `?chat=` filters; running and recently exited |
| POST | `/terminals` | Open a terminal | `{ projectId, worktree? }` or `{ chatId }`, optional `cols`, `rows`; `409 terminal.limit`, `400 terminal.no-project`. Emits `terminal.changed` |
| GET | `/terminals/:id` | One terminal | |
| POST | `/terminals/:id/ticket` | A ticket for the terminal's socket | `{ ticket, expiresAt }`, 30 s, one use |
| GET | `/terminals/:id/socket` | The terminal's stream (WebSocket) | `?ticket=`; Origin required; frames in §2.4 |
| DELETE | `/terminals/:id` | Close a terminal | SIGHUP → SIGTERM → SIGKILL to its process group. Emits `terminal.changed` |

`terminal.changed` joins the event kinds of `GET /api/events`, carrying the terminal list's
summary, never output.

### 5.2 Shared types (`packages/shared/src/types.ts`, a `Terminal` section)

```ts
export type TerminalScope = { kind: 'project'; projectId: string; worktree: string | null } | { kind: 'chat'; chatId: string };
export type TerminalState = 'running' | 'exited' | 'closed';
export type TerminalEndReason = 'exit' | 'closed' | 'idle' | 'server-stopping' | 'server-crashed' | 'host-failed' | 'disabled' | 'read-only';
export type TerminalUnavailableReason = 'off' | 'disabled-by-env' | 'pty-missing' | 'host-failed' | 'read-only' | 'needs-auth' | 'remote-off' | 'needs-tunnel' | 'from-agent' | 'chat-token';
export type TerminalRemote = 'off' | 'tunnel' | 'any';
export interface TerminalSettings { enabled: boolean; remote: TerminalRemote; maxTerminals: number; idleMinutes: number; scrollbackLines: number; replayLines: number; shell: string | null; loginShell: boolean; }
export interface TerminalStatus { enabled: boolean; available: boolean; reason: TerminalUnavailableReason | null; settings: TerminalSettings; sources: Record<keyof TerminalSettings, AppSettingSource>; peerCheck: 'on' | 'unknown'; running: number; }
export interface Terminal { id: string; scope: TerminalScope; cwd: string; shell: string; state: TerminalState; cols: number; rows: number; clients: number; startedAt: string; endedAt: string | null; endReason: TerminalEndReason | null; exitCode: number | null; }
export type CreateTerminalRequest = ({ projectId: string; worktree?: string } | { chatId: string }) & { cols?: number; rows?: number };
export type UpdateTerminalSettingsRequest = Partial<TerminalSettings>;
export interface TerminalTicket { ticket: string; expiresAt: string; }
export type TerminalClientFrame = { type: 'resize'; cols: number; rows: number } | { type: 'ack'; bytes: number } | { type: 'focus' };
export type TerminalServerFrame =
  | { type: 'hello'; terminal: Terminal; snapshot: string; cols: number; rows: number }
  | { type: 'size'; cols: number; rows: number }
  | { type: 'exit'; code: number | null; signal: string | null }
  | { type: 'closed'; reason: TerminalEndReason | 'evicted-slow' };
export interface TerminalHistoryEntry { /* one session row, with its attachments and refusals */ }
export interface TerminalHistoryPage { entries: TerminalHistoryEntry[]; total: number; }
```

Regenerate the schemas (`pnpm --filter @claudio/api openapi:schemas`). The control frames are in
`types.ts` so the view and the server share them, even though OpenAPI does not describe a socket's
frames; the route's description links to them.

### 5.3 Persistence

| What | Where | Why |
|---|---|---|
| Feature settings | `<data>/terminal.json`, written atomically (`writeAtomic`) | settings-shaped |
| Sessions and attachments | SQLite rows (§3.9) | accumulating records |
| Live terminals, tickets, flow state | memory | they die with the server by design |
| Scrollback, input, output | **nowhere** | secrets |
| Dock height, renderer flag, font size | `localStorage` (`claudio-terminal-*`) | per-browser preferences |

---

## 6. Tests

### 6.1 Unit (`packages/core/test/terminals-*.test.ts`)

- **cwd:** a project id gives its path; a listed worktree is accepted; an unlisted path, `..`, a
  symlinked worktree pointing outside, a deleted directory and a chat outside any project are
  refused.
- **env:** no `CLAUDIO_*` survives; `ELECTRON_RUN_AS_NODE`, `ANTHROPIC_API_KEY`,
  `CLAUDE_CODE_OAUTH_TOKEN` and a fake vault's values are gone; `TERM`, `COLORTERM`,
  `TERM_PROGRAM` set; `CLAUDIO_CHAT_ID` never set.
- **flow:** pause at the high watermark, resume below the low one for every client, eviction past
  8 MiB, acks counted only from the parse callback (fake clock, fake PTY).
- **screen:** a snapshot after `printf` with colours, after `tput smcup` (alternate screen) and with
  wide characters (emoji, CJK) reproduces the same buffer in a second headless terminal.
- **lifetime (real PTY, skipped when `node-pty` is not loadable):** a shell with `sleep 1000 &`
  ends with both processes gone after `close()`; a child that ignores `SIGTERM` is gone after the
  grace while an unrelated canary process lives; killing the parent of the host with `SIGKILL`
  leaves no shell behind (the host's `disconnect` path); idle expiry with a fake clock;
  `closeAll()` on stop; `reapStrays()` kills a tree recorded by a "previous server" row and leaves a
  reused pid alone.
- **descriptors:** a `claude`-like child spawned by the service after a terminal opened holds no
  `/dev/ptmx` or `/dev/pts/*` in `/proc/<pid>/fd` (the host keeps the masters; in Docker a master
  reads `/dev/pts/ptmx`); a second shell holds no master of the first; the host's own environment
  holds no `CLAUDIO_*`.
- **isolation:** `TerminalService` is imported only by `core/index.ts` and the API's terminal
  routes: a test reads the import graph (no import from chats, orchestrator, flow, assistant,
  decisions, the MCP server).
- **tokens:** the 16 ANSI tokens and the fg/bg pairs meet the contrast floors in both themes.

### 6.2 API (`apps/api/test/terminals.test.ts`)

Fastify `inject` for the REST routes, and a real `listen` on port 0 with a `ws` client for the
socket. The gate matrix, each a test named after the behaviour:

- feature off → `409 off`; `CLAUDIO_TERMINAL=off` → settings read-only, `PUT` refused;
- read-only → every route `405`, upgrade refused, running terminals closed when it turns on;
- `mode: none` from loopback → allowed; with a LAN `Host`, an `X-Forwarded-For`, or a runtime host →
  `403 needs-auth`;
- `mode: token`: no credential `401`; chat token `403` on every route including `GET`; desktop
  secret `403`; owner token from a LAN address → `403 needs-tunnel` under `remote: 'tunnel'`,
  allowed under `any`, `403 remote-off` under `off`; owner token on a runtime (tunnel) host →
  allowed under `tunnel`;
- peer check: a request made from a child process that carries `CLAUDIO_CHAT_ID` (spawned by the
  test) → `403 from-agent` and a refused attachment row; `unknown` under `none` fails closed;
- tickets: single use, 30 s expiry (fake clock), bound to terminal and Origin, wrong one counts in
  the back-off, `ticket=` absent from the logged URL;
- Origin: missing or foreign → `403` before upgrade; same origin → `101`;
- round trip: input `echo hi\r` → output contains `hi`; `resize` reaches the PTY (`stty size`);
  reattach gets `hello` with the earlier output in the snapshot;
- limits: the ninth terminal `409`, the fifth client on one terminal refused;
- audit: create, ticket and close are in `audit`; sessions and attachments rows written, with no
  content;
- the existing "every route has a summary and a tag" test covers the new routes.

### 6.3 Web (`apps/web/test/terminal-*.test.tsx`)

- `terminal-theme.ts` builds a full `ITheme` from tokens in both themes, no hex literal in the
  component or `terminal.css` (the existing token guard test passes);
- `useTerminalSocket` reconnects with a new ticket and backs off; the key bar sends `\x1b`, `\t`,
  and `Ctrl`+letter as the control byte;
- i18n parity for `terminal.*`.

### 6.4 e2e (`e2e/specs/terminal.spec.mjs`)

Against the isolated wrapper (auth `none`, loopback, which is the allowed case), with
`claudio-terminal-renderer=dom`:

1. Turn the feature on through `PUT /terminal/settings`; the project page shows "New terminal".
2. Open one; type `echo $((6*7))` and Enter; wait for `42` in `.xterm-rows`.
3. `pwd` prints the project's path; `env | grep -c '^CLAUDIO_'` prints `0`.
4. Reload: the earlier lines are back (snapshot replay).
5. Chat page: the dock opens in the chat's worktree (`pwd`).
6. Phone width: the route is full screen, the key bar is visible, `Esc` and `Ctrl`+`C` reach the
   shell (`cat` interrupted).
7. Light theme: the terminal background reads `--term-bg` of light.
8. Turn the feature off: the button disappears and the open terminal shows *Cerrado*.

Also: `a11y-core.spec.mjs` visits `/terminals?project=…` in both themes and at phone width;
`motion.spec.mjs` asserts the cursor does not blink under `subtle`.

### 6.5 Performance (`e2e/perf/terminal-perf.mjs`, run by hand and in a non-gating CI job)

- **Throughput, server only:** a PTY running `head -c 64m /dev/zero | tr '\0' 'x' | fold -w 120`
  through the service to a `ws` client that acks as it receives; report MB/s and the server's
  peak RSS. Budget: ≥ 30 MB/s, RSS growth < 40 MB.
- **Throughput, end to end:** in headless Chrome, `seq 1 300000` until the last line renders;
  report seconds and the longest main-thread task (Performance API `longtask`). Budget: < 4 s,
  no task > 200 ms.
- **Keystroke echo:** 200 characters typed into `cat`, time from `keydown` to the glyph in the
  buffer (`term.onWriteParsed`), p50/p95/worst. Budget, borrowed from the reference's daily job:
  median < 25 ms, worst < 300 ms on loopback.
- **Reattach:** time from socket open to `hello` rendered with 1 000 replayed lines. Budget:
  < 300 ms (the reference's revisit budget); a cold page load with the terminal open < 1 000 ms.
- **Event-loop drift** of the API process while one terminal floods: a 50 ms `setInterval`
  never late by more than 150 ms, so chats' SSE streams stay live beside a busy terminal.
- **Back-pressure:** `yes` for 10 s with a client that stops acking: server RSS stays flat, the
  shell is paused, and a second client stays responsive (echo p95 < 50 ms).
- Results go to `docs/reports/terminal-perf.md` with the machine, versions and date. Budgets are
  first guesses; t7 replaces them with measured values plus 50 % headroom, and the job fails only on
  a regression beyond that.

---

## 7. Orchestration

One orchestration, **`claudio-terminal`**, on its own branch from `feat/claude-only` **after stage R**
(the rename touches every file this one does). Code-writing workers run on `claude-sonnet-5-5`;
t0 and the security audit run on `claude-opus-5-5`. Every task runs `pnpm typecheck` and the tests of
the packages it touches; no worker runs `pnpm e2e`. Full `pnpm test`, `pnpm build`, `pnpm e2e` once at
the end.

| Id | Task | dependsOn | Owns | Checks |
|---|---|---|---|---|
| `t0` | **Facts spike** (no product code). Record in `docs/reports/terminal-t0.md`: `node-pty` loads (prebuilt or built) on Node 22 dev, on `node:26-bookworm-slim`, and inside the packaged AppImage under `ELECTRON_RUN_AS_NODE`; `node-pty` with `encoding: null` hands `Buffer`s; whether a shell holds another terminal's master fd (`ls -l /proc/<pid>/fd`), and the `FD_CLOEXEC` patch if it does; which xterm major has a stable `@xterm/headless` + serialize to pin with the view; `@fastify/websocket` upgrade goes through the `onRequest` hook; Vite proxy with `ws: true`; `connect-src 'self'` allows same-origin `ws:` in Chrome, Firefox and iOS Safari; `/proc/net/tcp` peer lookup works for loopback IPv4 and IPv6 and inside Docker. Pick `node-pty` or a prebuilt fork; a fact that contradicts this plan becomes a correction here first | — | `docs/reports/terminal-t0.md`, this plan | the report exists; each fact has a command and its output |
| `t1` | Shared types (§5.2), schemas regenerated | t0 | `packages/shared/src/types.ts`, `apps/api/src/openapi/schemas*` | `pnpm typecheck`, schema drift check |
| `t2a` | Delete `CLAUDIO_AUTH_TOKEN` from `process.env` after `new Core()`, with a test that a chat's environment lacks it | — | `apps/api/src/server.ts`, `apps/api/test/server-env.test.ts` | api tests |
| `t2` | Core: `terminals/` (service, host client, the host entry with the pty loader and screens, env, cwd, flow, peer, settings), `db.ts` migrations and methods, `Core.stop()` hook, `reapStrays()` at start, `terminal.changed` event, `core/index.ts` wiring, unit tests §6.1 | t1 | `packages/core/src/terminals/**`, `packages/core/src/db.ts` (append only), `packages/core/src/index.ts`, `packages/core/src/processes.ts` (export helpers only), `packages/core/test/terminals-*.test.ts`, `packages/core/package.json` | core typecheck + tests |
| `t3` | API: `@fastify/websocket`, `routes/terminals.ts`, `terminal-socket.ts`, `terminal-gate.ts`, tickets, `CHAT_FORBIDDEN_TERMINAL` and the ticket exemption in `security.ts`, URL redaction in logs, OpenAPI docs and tag, README "Terminal" table, tests §6.2 | t2, t2a | `apps/api/src/**` (those files), `apps/api/package.json`, `README.md` (the new table only), `apps/api/test/terminals.test.ts` | api typecheck + tests, openapi summary/tag test |
| `t6` | Design: `DesktopTerminal.html`, `MobileTerminal.html`, dark and light screenshots, "Terminal" section in `design-system.md`, the reference CSS, the `--term-*` tokens in `tokens.css` with the contrast test | t0 | `docs/design-system/**`, `docs/design-system.md`, `packages/ui/src/styles/tokens.css`, `packages/ui/test/term-tokens.test.ts` | ui tests, token guard |
| `t4` | Web: `components/terminal/**`, `pages/Terminals.tsx`, the dock in `ChatView.tsx`, project card and Home entries, palette command, Settings → Security card, `terminal.css`, i18n en/es + glossary, web tests §6.3, `xterm` deps | t3, t6 | `apps/web/src/components/terminal/**`, `apps/web/src/pages/Terminals.tsx`, `apps/web/src/pages/ChatView.tsx`, `apps/web/src/pages/Projects.tsx`, `apps/web/src/pages/Settings*` (the card), `apps/web/src/App.tsx` (routes), `apps/web/src/styles/terminal.css`, `apps/web/src/i18n/**`, `apps/web/package.json`, `apps/web/test/terminal-*.test.tsx` | web typecheck + tests, parity, `night-shift-ui-check` |
| `t5` | Packaging: the `terminal-host.mjs` entry and `node-pty` external in esbuild, `node-pty` copied beside the bundles, `electron-builder.yml`, desktop menu accelerators, Dockerfile, Vite `ws: true`, Helm `terminal.enabled`, `docs/deploy.md`, `docs/desktop.md` | t3 | `apps/api/scripts/bundle.mjs`, `apps/desktop/electron-builder.yml`, `apps/desktop/src/menu.ts`, `docker/Dockerfile`, `apps/web/vite.config.ts`, `deploy/**`, `docs/deploy.md`, `docs/desktop.md` | `pnpm build`, `docker build`, `pnpm desktop:dist` and a manual open of a terminal in the AppImage |
| `t7` | e2e spec and a11y/motion additions (§6.4), perf script and report (§6.5), the feature doc `docs/terminal.md`, `docs/security-model.md` section, `docs/status.md` | t4, t5 | `e2e/specs/terminal.spec.mjs`, `e2e/specs/a11y-core.spec.mjs`, `e2e/specs/motion.spec.mjs`, `e2e/perf/**`, `docs/terminal.md`, `docs/security-model.md`, `docs/reports/terminal-perf.md`, `docs/status.md` | the spec passes alone (`pnpm e2e --only terminal` on `E2E_PORT=8809`) — run by the integrator, not the worker |
| `t8` | **Security audit** (opus): read the gate, tickets, Origin, env scrub, peer check and cleanup against §3; try each attacker of §3.1 against a running build (LAN `Host`, foreign `Origin`, chat token, tokenless child of a chat, replayed ticket); write findings in `docs/reports/terminal-security.md`; blocking findings go back to t3 | t7 | `docs/reports/terminal-security.md` | every row of §3.1 has a test or a manual check with its output |

Launch order: `t0` and `t2a` in parallel; then `t1` and `t6`; then `t2`; `t3`; then `t4` and `t5`
in parallel; `t7`; `t8`; final full checks.

---

## 8. Risks and open questions

### Risks

| Risk | What holds it |
|---|---|
| `node-pty` does not load in one distribution (AppImage, Docker, a dev Node) | a prebuilt binary with a glibc 2.28 floor, which t0 loaded on all three (the AppImage through a stand-in; the integrator checks the real one); the host degrades to `pty-missing` and the rest of Claudio does not depend on it |
| The PTY master leaks into other processes (`node-pty` does not set close-on-exec on it) | PTYs live in the terminal host, which spawns nothing but shells and never uses `child_process`; the pinned `1.2.0-beta.15` closes inherited descriptors in each shell, so shells hold no other terminal's master (t0) |
| A native crash in `node-pty` | it takes down the host, not the API; three failures in 5 min turn the feature unavailable |
| Keystrokes and the token read on the LAN | `remote: 'tunnel'` by default (§3.4.1) |
| Replay types garbage into the shell (query replies), rewraps or loses a half sequence | replies muted during the snapshot, replay at the snapshot's size, the unfinished tail resent (§2.5) |
| A native module returns to a project that had none | contained to one lazily loaded package, external to the bundle, documented in `electron-builder.yml` and the Dockerfile |
| Remote command execution through the LAN with auth off | §3.4: under `mode: none` only the local machine, checked on the socket peer, the `Host` and the forwarding headers |
| An agent uses the terminal to escape its permission mode or type into the person's shell | §3.3 chat tokens refused; §3.5 peer-process check, failing closed under `mode: none` where it cannot run |
| Cross-site WebSocket hijacking | Origin required and matched, ticket bound to Origin (§3.7) |
| The owner's token leaks into access logs | tickets instead of `?token=`, redacted log URLs (§3.6) |
| Shells outlive the server | process-group kill on stop, `reapStrays()` on start (§2.5) |
| A flood of output eats memory or freezes another client | line-bounded scrollback, pause/resume, slow-client eviction (§2.7) |
| Secrets in the shell's environment | §2.11 scrub with a test; the `CLAUDIO_AUTH_TOKEN` gap closed in t2a |
| Phone typing is poor | key bar, sticky modifiers, 16 px hidden textarea; usefulness is for short commands, stated in the copy |
| The feature drifts toward driving Claude Code | §"The rule", the isolation test (§6.1) and the audit (t8) |

### Open questions for the owner

- **Q1. The phone's path.** With token auth on, the plan lets another device in **only through the
  tunnel** by default (`remote: 'tunnel'`), because the plain LAN address sends the token and every
  keystroke unencrypted. Is the tunnel how you want to use it from the phone, or do you want `any`
  (plain LAN, with the warning) as your setting? A third way, Claudio serving HTTPS on the LAN with
  a certificate of its own, is not in this plan.
- **Q2. Re-confirm before opening.** Should opening a terminal from a non-local device ask for the
  token again (a step-up), even when the browser already holds it?
- **Q3. Surviving restarts.** v1 ends every shell when the server stops (a desktop update, a
  container restart). Keeping them alive needs a separate PTY daemon outliving the server, with
  its own socket and authentication: worth a v2?
- **Q4. The peer-process check under `mode: none`.** It fails closed where `/proc` cannot be read
  (macOS dev). Accept that the terminal is unavailable there with auth off, or allow it with a
  warning?
- **Q5. Agents in `bypassPermissions`.** They already have a shell through Bash. Is refusing them the
  terminal enough, or should a terminal also be refused while a chat of the same worktree is running
  (to avoid the person and an agent editing the same files at once)? The plan does not refuse it.
- **Q6. Scope of the chat terminal.** A chat without a worktree gets a terminal in its project
  directory, the same one as the project terminal. Keep it, or offer the chat dock only for chats
  with their own worktree?
- **Q7. Docker with auth off.** The terminal is unavailable there by design. Is that the expected
  behaviour, or should a deployment be able to declare its bridge address "local"? (The plan says
  no: that is what the token is for.)

## Related

[[plans/claude-only-fork.md]] · [[security-model.md]] · [[chat-environment.md]] ·
[[plans/chat-api-token.md]] · [[tunnel.md]] · [[deploy.md]] · [[desktop.md]] · [[design-system.md]] ·
[[phone-layout.md]] · [[layered-settings.md]] · [[projects.md]] · [[terminal.md]]
