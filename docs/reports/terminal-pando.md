---
created_at: 2026-10-15T16:56:00Z
updated_at: 2026-10-15T16:56:00Z
tags:
    - research
    - terminal
    - pty
    - security
    - claudio
---
# The integrated terminal: how Pando does it, and what it means for Claudio

Research for Claudio's integrated terminal: a real interactive shell per project and per chat,
opened in the project's directory or the chat's worktree, in the web app (desktop and phone) and in
the Electron app. This document studies Pando (`~/Escritorio/pando`, MIT, read at commit
`466e2b6b`) as the reference: its Go backend, its React web UI and its Wails desktop app. Every
`path:line` below points into that checkout unless it names Claudio.

The terminal is the person's own shell. It never drives Claude Code, never reads what Claude Code
prints, and Claude Code never reaches it: Claudio keeps reaching Claude only through its CLI flags,
stream-json and the control protocol. Nothing in this document changes that.

## 1. How Pando does it

Pando has three terminals, and they share one backend library:

| Surface | Where | What it is |
|---|---|---|
| Web UI, interactive | `internal/api/terminal_pty.go`, `internal/api/handlers_terminal_pty.go`, `web-ui/src/components/terminal/TerminalPtyPane.tsx` | A shell in a real PTY, streamed over a WebSocket to xterm.js |
| Web UI, fallback | `internal/api/handlers_terminal.go`, `TerminalInput.tsx`, `TerminalOutput.tsx` | One-shot `POST /api/v1/terminal/exec`, no PTY, used only when the WebSocket cannot open |
| TUI | `internal/tui/components/terminal/terminal.go` | A PTY plus a server-side VT emulator rendered by Bubble Tea |
| Desktop | `desktop/main.go`, `internal/desktop/app.go` | No terminal code of its own: a Wails webview that loads the web UI from the local server, so its terminal is the web one |

The interactive web terminal landed in commit `c75d7314` ("WebUI Terminal now is a real terminal
using xterm.js", July 2026), with its own design note in
`.kb/pando/features/webui_terminal_pty_xterm.md`.

### 1.1 Libraries

| Piece | Library | Version |
|---|---|---|
| PTY | `github.com/creack/pty` | v1.1.24 (`go.mod`) |
| WebSocket server | `github.com/gorilla/websocket` | v1.5.3 (`go.mod`) |
| TUI VT emulator | `github.com/charmbracelet/x/vt` | pseudo-version `v0.0.0-20260305213658` (`go.mod:21`) |
| Desktop shell | `github.com/wailsapp/wails/v2` | v2.16.0 (`go.mod:64`) |
| Terminal widget | `@xterm/xterm` | ^5.5.0 (`web-ui/package.json:26`) |
| Addons | `@xterm/addon-fit` only | ^0.10.0 (`web-ui/package.json:25`) |
| UI state | React ^19, zustand ^5 | `web-ui/package.json:32,39` |

No search, web-links, clipboard, unicode11, WebGL or serialize addon is installed.

### 1.2 PTY backend (web)

`ptySession` (`internal/api/terminal_pty.go:36-51`) is one shell in one PTY, with a replay buffer,
a set of subscriber channels, an exit code and a `done` channel.

- **Shell choice.** `ptyShellCommand` (`terminal_pty.go:56-71`) takes `Shell.Path`/`Shell.Args`
  from the config, else `choosePreferredShell` (`handlers_terminal.go:146-167`: `$SHELL`, then zsh
  on macOS, then bash, sh, zsh, `/bin/sh`). The default argument is `-i`: interactive is right here
  because the shell has a controlling terminal, so job control works and `~/.zshrc` loads. The
  one-shot path uses `-l -c` instead, because an interactive shell without a TTY gets stopped by
  `SIGTTOU` (`handlers_terminal.go:126-133`).
- **Spawn.** `exec.Command(shell, args...)`, `cmd.Dir = cwd`, `cmd.Env = buildShellEnv(os.Environ())`
  and `pty.StartWithSize` (`terminal_pty.go:99-111`). `creack/pty` makes the child a session leader
  with the PTY as its controlling terminal. The comment at `:95-98` records a decision: the user's
  terminal is deliberately **not** sandboxed, unlike every command an agent reaches.
- **Environment.** `buildShellEnv` (`handlers_terminal.go:176-190`) copies the server's whole
  environment and forces `TERM=xterm-256color`. Nothing is stripped. (Pando does remove its child
  token from its own environment at start-up, `cmd/startup_mode.go:56`, so it is not inherited.)
- **Sizing.** `cols`/`rows` from the client are clamped to `[2, 2000]` (`terminal_pty.go:76-88`)
  so `cols*8` and `rows*16` stay inside the `uint16` pixel fields of `pty.Winsize`; resizes go
  through `pty.Setsize` (`:252-264`), which delivers `SIGWINCH`.
- **One reader, fan-out.** `pump` (`:138-155`) is the only reader of the PTY master, 32 KiB at a
  time; `broadcast` (`:157-173`) appends each chunk to the replay buffer and sends it to every
  subscriber channel. EIO on read is the normal shell exit on Linux.
- **Back-pressure by design.** Each subscriber has a 64-chunk channel (`:27-30`). When it is full,
  `broadcast` blocks, which blocks the pump, which stops reading the PTY, which makes the shell
  block on write: the comment argues that dropping bytes would corrupt screen state and a real
  terminal back-pressures too. The cost is that one slow client freezes every client of the same
  shell until its 10 s write deadline closes it.
- **Replay.** The last 256 KiB of raw output (`ptyReplayBytes`, `:22`; `appendReplay`, `:176-182`)
  are kept; `subscribe` (`:216-245`) hands out the replay and the live channel under one lock, so
  no byte is lost or duplicated between them. The cut is at an arbitrary byte, so the replay can
  start in the middle of a UTF-8 sequence or an escape sequence, and a full-screen program
  (`vim`, `htop`) only repaints on its next redraw — the design note lists this as a known gap.
- **Exit.** `finish` (`:184-211`) waits for the process, records the exit code, closes `done` and
  every subscriber, and closes the master.
- **Kill.** `close` (`:266-276`) sends `Process.Kill()` (SIGKILL) to the shell's PID only and
  closes the master. Jobs that run in their own process group, `nohup` and `setsid` children are
  not signalled and can outlive the shell.
- **Lifetime.** `ptyRegistry` (`:290-347`) is a process-global map keyed by a UUID. A shell lives
  until it exits, until a client sends `close`, or until it has had no client for 30 minutes
  (`ptySessionIdleTTL`, `:26`). The reaper runs **only when a new session is added** (`:315-320`),
  so idle shells survive indefinitely if nobody opens another one. There is no cap on the number of
  shells and no explicit cleanup in `Server.Shutdown` (`internal/api/server.go:563`); shells die
  with the process when the PTY masters close.

### 1.3 Transport

One route: `GET /api/v1/terminal/pty` (`internal/api/routes.go:188`), a WebSocket upgrade handled
by `handleTerminalPTY` (`handlers_terminal_pty.go:97-124`).

- **Framing.** Binary frames carry raw terminal bytes in both directions; text frames carry JSON
  control (`ptyControlMessage`, `:26-39`): server → client `ready` (session id, shell, dir,
  reattach) and `exit` (code); client → server `resize` and `close`. Unknown control types are
  ignored so the protocol can grow (`:238-240`).
- **Session selection.** `?cols=&rows=&session_id=` in the query. A known `session_id` reattaches
  and resizes the live shell to the new client; an unknown one silently starts a fresh shell
  (`resolvePTYSession`, `:128-141`; test `TestPTYUnknownSessionStartsFreshShell`).
- **Single writer.** gorilla allows one concurrent writer, so `pumpPTYToClient` (`:145-203`) owns
  every write: `ready`, then the replay as one binary frame, then live chunks and pings.
- **Keep-alive.** Ping every 54 s, read deadline 60 s refreshed by pong and by any message, 10 s
  write deadline (`:16-22`, `:209-213`).
- **Limits.** A client frame is capped at 1 MiB (`ptyMaxClientMessage`, `:21`).
- **Several clients per shell** are allowed: each gets the replay and the live stream, all can type,
  and the last resize wins.
- **Reconnect.** There is no automatic reconnect. If the socket drops after `ready`, the pane writes
  `[disconnected]` and stops (`TerminalPtyPane.tsx:83-91`); reattach happens when the pane mounts
  again (navigating back to the view) or on a page reload, with the session id kept in
  `sessionStorage`. If the socket never reaches `ready`, the tab falls back to the one-shot exec
  path (`TerminalPtyPane.tsx:84-88`, `terminalStore.ts` `fallbackToExec`).
- **Through the project proxy.** A project workspace is a child `pando serve` reverse-proxied by
  the parent, WebSocket included: `handlers_projects_web.go` swaps the browser's token for the
  child's token (`:175-184`) and streams with `FlushInterval: -1` (`:188`); covered by
  `TestProjectsWebProxyWebSocketPTY` (`handlers_projects_web_test.go:193`).

### 1.4 Frontend

- **Store** (`web-ui/packages/pando-client/src/stores/terminalStore.ts`): tabs with
  `mode: 'pty' | 'exec'`, `ptySessionId`, exit code and fallback reason. Tab ids come from
  `crypto.getRandomValues` because they address live shells. Tab id + title + `ptySessionId` are
  persisted in `sessionStorage` (`PTY_TABS_KEY`), never the scrollback: the server replays it.
  Closing a tab is the only action that kills a shell; every other unmount detaches.
- **Connection** (`.../services/terminalPty.ts`): builds `ws(s)://…/api/v1/terminal/pty`, puts the
  API token in `?token=` because the browser WebSocket API cannot set headers (`:64-84`),
  `binaryType = 'arraybuffer'`, and exposes `send`, `resize`, `detach` and `terminate`. A module
  map `tabId → connection` lets the store terminate a shell without reaching into components.
- **Pane** (`web-ui/src/components/terminal/TerminalPtyPane.tsx`): `new Terminal({ cursorBlink,
  fontSize: 13, lineHeight: 1.3, scrollback: 10000 })` plus `FitAddon`; fits **before** connecting
  so the shell starts at the real size (`:61-66`); output goes through a streaming `TextDecoder`
  (`:69-74`) before `terminal.write` (xterm.js also accepts `Uint8Array` directly); a
  `ResizeObserver` re-fits and `onResize` sends `resize`; `fit()` throws on a hidden (zero-size)
  container and is swallowed, then re-run when the tab becomes active (`:132-149`).
- **Tabs** (`TerminalView.tsx`): every PTY pane stays mounted and is hidden with `display: none`
  when inactive, so its screen state survives tab switches (`:99-105`). "Clear" sends `Ctrl+L` to
  the shell instead of wiping the buffer (`:26-35`). Middle-click closes a tab.
- **Theme** (`xtermTheme.ts`): builds the xterm `ITheme` from live CSS variables (`--bg-card`,
  `--fg`, `--accent`, and an ANSI-16 palette `--term-*`) and re-applies it when the theme store
  changes. The ANSI palette is hard-coded hex in `web-ui/src/styles/terminal.css:1-40`, light and
  dark, as the one place the app allows literals.
- **Not there:** link detection, search, a copy/paste key policy beyond xterm.js defaults, a WebGL
  renderer, IME/phone-specific handling, a touch keyboard bar. The view is imported eagerly
  (`web-ui/src/App.tsx:22,138`), so xterm.js is in the main bundle.

### 1.5 Desktop: the same terminal, no IPC

`pando desktop` (`cmd/desktop.go:70-75`) starts the full API server on `localhost`, preferred port
8765 with a fallback, then launches the Wails binary pointed at that URL
(`cmd/desktop.go:266`). The Wails window (`desktop/main.go:43-85`) first shows an embedded loading
page, captures the Wails runtime from it, then navigates to the server origin and re-injects the
runtime into every page (`internal/desktop/app.go:79-120`); `BindingsAllowedOrigins` is set to the
server's origin (`desktop/main.go:78`). The Go bindings cover window controls, tray, dialogs and
downloads — **nothing terminal-related** (`git grep` finds no `pty`/`terminal` in `desktop/`,
`internal/desktop/` or `web-ui/wailsjs/`). The desktop terminal is therefore the web terminal over
the same WebSocket to the same loopback server, with the same token. The only desktop-specific
behaviour that touches it is the working directory: a GUI launch starts in the home directory
rather than `/` (`internal/desktop/workdir.go:32-50`), and on macOS the login shell's `PATH` is
imported (`:52-60`).

### 1.6 Per-directory sessions

There are none inside one server. Every shell starts in `s.config.CWD`, the instance's root
(`handlers_terminal_pty.go:135`); the client cannot choose a directory. Per-project terminals come
from Pando's project workspaces (epic `PANDO-EP-0019`): opening a project spawns a whole child
`pando serve` on loopback in that directory, the parent reverse-proxies it, and the project's tab
hosts the child's own web UI in an iframe — so its terminal opens in the project. The old exec path
let the client pass a relative `dir`, confined with `strings.HasPrefix(candidate, cwd)`
(`handlers_terminal.go:61-73`); without a trailing separator that check also accepts a sibling such
as `/work/proj-other` when the root is `/work/proj`.

### 1.7 Security

- **Authentication.** Every `/api/` path needs the per-process API token, in `X-Pando-Token` or
  `?token=` (`internal/api/server.go:633-639`, `:665-724`). The token is random per process unless
  configured (`server.go:286-292`). Basic auth sits in front once the server is bound to a
  non-loopback host (`internal/api/basicauth.go:46-64`). The chain is
  `cors(basicAuth(auth(routes)))` (`server.go:338`).
- **The token endpoint.** `GET /api/v1/token` hands the token to any caller when the bind is
  loopback (`server.go:661-663`, `:678-681`); that is how the local web UI bootstraps.
- **CORS** answers `Access-Control-Allow-Origin: *` on every non-AG-UI path (`server.go:606-628`).
  Read together with the token endpoint, this appears to let any web page the person visits fetch
  the token from a loopback Pando and then call `POST /terminal/exec`, whose only defence is the
  dangerous-command filter; browsers' private-network-access rules are the only thing in the way.
  Not verified in a browser; the lesson for Claudio stands either way.
- **Origin check on the WebSocket** (`handlers_terminal_pty.go:46-78`): an empty `Origin` is allowed
  (non-browser clients), the same host is allowed, **any loopback origin on any port** is allowed
  (so the Vite dev server works), and project children accept a valid token. There is no `Host`
  allow-list anywhere (`git grep r.Host` finds only the two origin comparisons), so a DNS-rebinding
  page sees itself as same-origin.
- **No command filter on the PTY**, on purpose (`handlers_terminal_pty.go:92-96`, and the design
  note): a PTY carries keystrokes, so a filter is bypassed by aliases, scripts or a shell-out from
  an editor and would only give false assurance. The exec fallback keeps
  `safety.IsDangerousShellCommand` (`handlers_terminal.go:242-245`).
- **Network exposure.** The default bind is `localhost` (`internal/config/config.go:2622`). An
  "external access" toggle rebinds the live listener to `0.0.0.0`, and refuses unless basic auth has
  at least one user, because "an unguarded network bind is remote code execution for the whole LAN"
  (`internal/api/handlers_external_access.go:93-147`). The change is not persisted.
- **Logging.** Only the shell path, launch flags and PID are logged; nothing typed is ever logged
  (`terminal_pty.go:124-131`).

### 1.8 Persistence

Shells live in server memory only. The browser keeps tab ids and session ids in `sessionStorage`
(per browser tab), so a reload reattaches and replays up to 256 KiB. A server restart loses every
shell; nothing goes to SQLite or disk.

### 1.9 Tests

`internal/api/handlers_terminal_pty_test.go` drives a **real shell** through the real handler on an
`httptest` server: interactive echo (`:86`), reattach with replay after a simulated reload
(`:107`), unknown session id starts a fresh shell (`:138`), resize reaches the shell — `tput cols`
reads 132 (`:155`), the origin table (`:175`), and the replay bound (`:228`). The tests bypass
auth and TLS; the design note records a manual end-to-end run against a real `pando serve` and
says the frontend was never exercised in a browser. The only browser test that touches the terminal
is `web-ui/e2e/project-tabs.spec.ts:67-90`, which navigates to it inside a project frame.

### 1.10 The TUI path, for contrast

`internal/tui/components/terminal/terminal.go` reads the PTY into a **server-side VT emulator**
(`vt.NewSafeEmulator`, `:183`; reader goroutine `:237-270`), forwards the emulator's replies (cursor
position reports) back to the PTY (`:275-290`), and renders the emulator's screen at about 30 fps
(`:153`). Holding the screen as state, not as a byte tail, is exactly what the web replay lacks.

## 2. What carries over to Claudio

Claudio is Node ≥ 22, Fastify 5 (`apps/api/package.json`), React/Vite, and Electron 44
(`apps/desktop/package.json`) that runs the bundled API on Electron's own Node through
`ELECTRON_RUN_AS_NODE` (`apps/desktop/src/server-process.ts:62-82`). Today Claudio has **no native
addon** (SQLite is `node:sqlite`) and **no WebSocket**: every stream is SSE.

### Carries over as design

| Pando piece | Claudio equivalent |
|---|---|
| Binary frames for bytes, JSON text frames for control (`ready`/`exit`/`resize`/`close`) | Same protocol over `@fastify/websocket` (which wraps `ws`); Fastify's `onRequest` hooks run before the upgrade, so `registerSecurity` applies |
| One reader per PTY, fan-out to subscribers, replay and subscription taken atomically | Same shape: one `pty.onData` listener, a `Set` of sockets |
| Back-pressure instead of dropping bytes | `ws.bufferedAmount` per socket plus `pty.pause()`/`pty.resume()` (node-pty supports flow control); close a socket that stays above a high-water mark instead of freezing everyone |
| Shell session survives a dropped socket, idle TTL | Same, but reap on a timer, not only on create, and cap shells per actor |
| Fit before connect, re-fit on show, `display: none` for background tabs | Same, with `@xterm/addon-fit` |
| Theme from live CSS variables, re-applied on theme change | Same, reading Claudio's tokens |
| "Clear" sends `Ctrl+L` | Same |
| No dangerous-command filter on an interactive shell | Same reasoning; the boundary is who may open the shell, not what they type |
| Real-shell tests (echo, reattach, resize via `tput cols`) | Same in `node:test`/Vitest against the real route, plus the auth paths Pando's tests skip |
| Desktop reuses the web terminal over the loopback API | Same: Claudio's Electron window already loads the bundled API over `127.0.0.1` |

### Does not carry over, and the Node equivalents

| Go piece | Node equivalent | Note |
|---|---|---|
| `creack/pty` (pure Go, no cgo) | `node-pty` (Microsoft) | **A native addon**, Claudio's first. It must load in two runtimes: Node 22 for the API and the Docker image, and Electron 44's Node for the desktop-spawned API. Whether the current `node-pty` release ships N-API prebuilds for linux-x64/arm64 (one binary for both runtimes) or needs `electron-rebuild` and build tools in the image has to be checked before choosing it; forks with prebuilds exist. In the Electron package it must be unpacked from the asar. |
| `pty.StartWithSize` + `cmd.Env` | `pty.spawn(shell, args, { name: 'xterm-256color', cols, rows, cwd, env })` | |
| `pty.Setsize` | `pty.resize(cols, rows)` | Clamp the same way |
| EIO on read = exit | `pty.onExit(({ exitCode, signal }))` | |
| `Process.Kill()` | `pty.kill(signal)` sends to the shell's PID | Prefer `process.kill(-pid, 'SIGHUP')` (the shell is a session leader), then `SIGKILL` after a grace period |
| `gorilla/websocket` single-writer rule | `ws` queues writes itself | Ping/pong and `maxPayload` still to set |
| Goroutines + channels | Event emitters, one listener per socket | Back-pressure is explicit, see above |
| `charmbracelet/x/vt` server-side emulator | `@xterm/headless` + `@xterm/addon-serialize` | Gives a reattaching client the **screen**, not a raw tail cut mid-sequence |
| Wails bindings | Electron preload/IPC | Not needed for the terminal if the desktop reuses the WebSocket |
| Project child instances behind a reverse proxy (per-directory) | Not needed | Claudio's API already knows each project's directory and each chat's worktree (`ChatWorktree`, `packages/shared/src/types.ts:756`); the server resolves the `cwd` from an id |
| Hex ANSI palette in a component stylesheet | ANSI tokens in `packages/ui/src/styles/tokens.css` for both themes | Claudio's "tokens only" rule forbids hex outside tokens.css |
| `JetBrains Mono` | `var(--mono)` (Geist Mono) | Design system |
| `cursorBlink: true` always | Blink only when motion is allowed | Every animation stops under `data-motion` subtle/off, `prefers-reduced-motion` and in a hidden tab |

## 3. Comparison with the other reference

The other reference's study (`terminal.md`) did not exist when this document was finished, so the
side-by-side is not written yet; it belongs in a follow-up once both studies are in. The
recommendations below are Claudio's position on each point from Pando alone, with the reason, so
the comparison has a fixed side to check against.

| Point | Pando | Recommendation for Claudio | Why |
|---|---|---|---|
| Transport | One WebSocket, binary data + JSON control | Same, through `@fastify/websocket` on the API port; no second port, no SSE+POST split | Keystroke latency and binary bytes need a duplex channel; one port keeps the tunnel, the host allow-list and the desktop working unchanged |
| Auth on the socket | Long-lived API token in `?token=` | A short-lived, single-use **ticket**: `POST /api/terminals/:id/ticket` with the normal `Authorization` header, then `?ticket=` on the upgrade | Claudio deliberately keeps `?token=` to five routes (`apps/api/src/security.ts` `QUERY_TOKEN`) because query strings end up in logs |
| Directory | Server root only; per-project via child servers | `cwd` resolved server-side from a project id or a chat id (its worktree), never from a client path | Removes path-traversal and prefix bugs like `handlers_terminal.go:69` |
| Lifetime | Survives disconnect, 30 min idle TTL reaped on create, no cap | Survives disconnect; idle TTL on a timer; a cap per actor; killed with its chat's worktree when that is removed; all killed on shutdown | Keeps a reload painless without leaking shells |
| Kill | SIGKILL to the shell PID | SIGHUP to the process group, SIGKILL after a grace | Background jobs get the hang-up a closed terminal normally sends |
| Replay | 256 KiB raw tail | Server-side `@xterm/headless` per shell; on attach send a serialized snapshot | A raw tail repaints `vim` badly and can start mid-sequence |
| Back-pressure | Block the pump; slow client freezes all | Pause the PTY on `bufferedAmount`, drop (close) a client that stays behind | One phone on a bad network must not freeze the desktop's view |
| Reconnect | None after `ready`; reattach on remount/reload | Automatic reconnect with backoff to the same shell id, plus reattach on reload | Phones drop sockets on every app switch |
| Persistence | `sessionStorage` tab ids; shells in memory | Shell ids in memory on the server; the open-terminal list per project/chat from the API, not from browser storage | Lets the phone and the desktop see the same shells |
| UI | Tabs with hidden panes, fit addon, theme from tokens | Same, plus web-links (opening only `http(s)`), search, Geist Mono, ANSI tokens, motion rules, a phone key bar (Esc, Tab, Ctrl, arrows) and 16 px input | Design system and phone rules |
| Performance | xterm in the main bundle | Lazy-load the terminal chunk; consider the WebGL addon on desktop only | Most sessions never open a terminal |
| Desktop | Same web terminal over loopback | Same; no node-pty in Electron's main process | One code path; the native addon only loads in the API process |

## 4. Security lessons

A shell over HTTP is remote command execution by definition: whoever can open the socket owns the
machine as the person running Claudio. The owner runs Claudio on the LAN with authentication
**off** (`mode: 'none'`), where today the API already runs Claude Code and other commands and the
server warns that "whoever reaches the port owns the machine" (`apps/api/src/server.ts:83-89`). A
terminal does not create that exposure, but it removes the last friction: no permission prompt, no
tool policy, no transcript, no audit of what was typed.

What Pando gets right and Claudio should keep:

1. **No command filter.** It is theatre on a PTY; spend the effort on who may connect.
2. **Refuse a network bind without a credential** — Pando refuses to expose itself without basic
   auth (`handlers_external_access.go:93-131`).
3. **Never log keystrokes or output.**

What Pando shows not to do:

4. **No credential from an open endpoint, no wildcard CORS.** Pando's loopback token endpoint plus
   `Access-Control-Allow-Origin: *` is the shape of a drive-by attack from any web page. Claudio is
   already right here (CORS opt-in, `apps/api/src/origins.ts`); keep it so.
5. **Check `Host` and `Origin` on the upgrade.** WebSockets are not covered by CORS. Claudio's
   `Host` allow-list (421 in `registerSecurity`) already stops DNS rebinding; add an `Origin` check
   on the terminal upgrade (same origin, or `CLAUDIO_CORS_ORIGIN`), and do **not** copy Pando's
   "any loopback origin" exception: any page served from `localhost` on any port would pass it. In
   dev, Vite proxies `/api` with `ws: true`, so the origin stays the app's own.
6. **Don't reuse the long-lived token in a URL.** Use a ticket (section 3).

What is new in Claudio's case and Pando does not face:

7. **Authentication off on the LAN.** Recommended: the terminal is **disabled unless a credential is
   configured**, or, if the owner wants it with auth off, only from loopback (`fromLocalMachine`)
   and behind an explicit setting that says "anyone on this network gets a shell". The phone on the
   LAN then needs the token to use the terminal.
8. **The tunnel.** Claudio can publish itself through a tunnel. A terminal must never be reachable
   through it unless a credential is set; better, never through a runtime host at all.
9. **Chat tokens.** A chat's `CLAUDIO_API_TOKEN` must not open a terminal. Otherwise a prompt
   injection inside a chat gets an unrestricted shell that bypasses the chat's permission mode and
   tool policy. Add the terminal routes to the chat-forbidden set in `apps/api/src/security.ts`.
10. **The desktop's read-only credential.** `DESKTOP_METHODS` allows `GET`, and a WebSocket upgrade
    is a `GET` (`apps/api/src/security.ts:331,525`). The terminal route must reject the desktop
    actor explicitly, or the read-only credential silently becomes a shell.
11. **The shell's environment.** Pando passes the server's whole environment. Claudio already
    deletes the desktop secret and the vault key from `process.env` at start-up
    (`apps/api/src/server.ts:52-55`), but the auth keys listed in
    `packages/core/src/paths.ts:11-21` (`CLAUDIO_AUTH_TOKEN`, OIDC settings…) can still be in the
    environment of a server started with them. Build the shell's environment by removing every
    `CLAUDIO_*` credential (and `CLAUDIO_API_URL`/`CLAUDIO_CHAT_ID`/`CLAUDIO_API_TOKEN`, which
    belong to chats), the way `chats.ts` removes `CLAUDIO_API_TOKEN` before a spawn, and test it.
    Whether vault credentials (`childEnv`) should reach the person's shell is an open question.
12. **Read-only mode** (`CLAUDIO_READ_ONLY`) must refuse the terminal: a shell is a write.
13. **Audit** one line per shell opened and closed (actor, project/chat, cwd, pid, exit code), never
    the content.
14. **Limits**: shells per actor, frame size, resize clamp, idle TTL — a shell endpoint is also a
    cheap way to exhaust PIDs and memory.

## 5. Open questions for the owner

1. With authentication off on the LAN, should the terminal be **off** until a token is set, be
   allowed only from this machine (loopback), or be allowed for the whole LAN behind an explicit
   setting?
2. Through the tunnel: never, or only with a credential?
3. Does the shell get the person's full environment minus Claudio's own secrets, or a clean login
   environment (`$SHELL -l -i` from `HOME`, `PATH` and a short allow-list)? And should the vault's
   tool credentials (GitHub, GitLab…) reach it?
4. Lifetime: should a shell outlive its socket, and for how long (Pando: 30 min)? Should closing or
   archiving a chat, or removing its worktree, kill its shells?
5. Shared or private: may two devices (desktop and phone) attach to the same shell at once, both
   typing, as in Pando?
6. Replay fidelity: is a server-side headless emulator (exact screen on reattach) worth the memory
   per shell, or is a raw tail enough?
7. Should a shell survive an API restart? (Neither Pando nor a plain `node-pty` design does; it would
   need something like `tmux`/`dtach` underneath.)
8. Native dependency: is a first native addon (`node-pty`) acceptable in the Docker image and the
   Electron package, given it must load on both Node 22 and Electron's Node?
9. Placement: a panel inside the chat and project pages, a separate page, or both? On the phone, a
   full-screen sheet with a key bar?
10. Should the terminal be a feature that a fresh install shows at all, or something the owner turns
    on in settings?

## Related

[[plans/claude-only-fork.md]] · [[plans/claudio-rebrand.md]] · [[security-model.md]] · [[desktop.md]] ·
[[plans/tunnel.md]] · [[design-system.md]] · [[plans/mobile.md]] · [[plans/chat-api-token.md]] ·
[[plans/terminal.md]]
