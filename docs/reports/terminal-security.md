---
created_at: 2026-10-15T21:30:00Z
updated_at: 2026-10-15T21:30:00Z
tags:
    - report
    - terminal
    - security
    - audit
---
# Terminal security audit

Task t8 of [the terminal plan](../plans/terminal.md#7-orchestration). Its owner decisions of 2026-10-15
are the standard this audit checks against:

- with auth off, the terminal works on this machine only;
- from another device, only through the tunnel and with a token;
- the shell is a login shell plus the vault's tool credentials, and never gets `CLAUDIO_*` or
  Claude's credentials;
- shells survive reloads, not restarts.

It audits the branch at `4cb3ca2f1` (t0 to t7 merged).

**Method.** I read the code first:

- `apps/api/src/terminal-gate.ts`, `terminal-socket.ts`, `routes/terminals.ts`;
- the terminal parts of `security.ts` and `app.ts`;
- `packages/core/src/terminals/{peer,env,cwd,flow,service,host-client}.ts` and `processes.ts`.

Then I tried each attacker of §3.1 as a test: Fastify `inject`, plus a real listener on `127.0.0.1:0`
for the socket and for the peer check, which needs a real socket. Nothing listened beyond loopback.
The new tests are in `apps/api/test/terminal-security.test.ts` and
`packages/core/test/terminals-security.test.ts`. They add to the gate matrix that t3 and t2 already
wrote in `terminals.test.ts` and `terminals-*.test.ts`.

A finding that is not fixed yet is a `todo` test. It states what the plan promises, and it passes once
the promise holds.

## Verdict

The gate holds against every attacker that has no shell on this machine:

- anyone on the LAN;
- a listener on the LAN;
- a cross-site page;
- DNS rebinding;
- a chat's token;
- the tunnel.

It also refuses a chat's process tree when that tree has no token.

One finding is open and serious within its scope (**T8-1**). With auth off, an agent that has a Bash
tool can leave its chat's process tree and type into a shell the person has open. No small fix
exists: it needs an owner decision.

Two small findings were fixed in t3's files (**T8-4**, **T8-5**). One finding for the core is open
(**T8-3**, the flow-control freeze t7 measured). The rest are low.

## §3.1, attacker by attacker

| Attacker (§3.1) | Tried | Result |
|---|---|---|
| Anyone on the LAN | `terminal-security.test.ts` "LAN, auth off" ×3. LAN peers `192.168.1.9`, `::ffff:192.168.1.9` and `fe80::1` write `Host: localhost` and a same-origin `Origin` on every route and on the upgrade. Settings that also turn something on (`{enabled:false, remote:'any'}`). The refusal row. Plus the existing `terminals.test.ts` "under mode none… needs a token". | `403 needs-auth` everywhere, because the socket's peer is read and the `Host` is not trusted. `{enabled:false, …}` is not the turn-off path. The row records `client: 192.168.1.77`. **Holds** |
| A listener on the LAN | "LAN listener" ×2: a new install defaults to `remote: 'tunnel'`. A ticket minted through the tunnel is replayed from a LAN address, with the tunnel's `Host` and `Origin` and with the LAN's. Plus the existing "the owner from another device follows `remote`". | `403 needs-tunnel`: the socket runs the gate itself, so a stolen ticket does not carry where it was minted. **Holds** (keystrokes over `remote: 'any'` are plain HTTP, by design and with a warning) |
| A web page the owner visits (CSWSH) | "cross-site page" ×3. A ticket asked for with `Origin` set to `http://evil.example`, `null`, another local port (`:5181`, `:1`), `file://` or `ws://<host>`. A socket opened with a good ticket from those origins. A ticket minted with no `Origin` and then used. `CLAUDIO_CORS_ORIGIN=*`. A `text/plain` POST, which needs no preflight. Plus the existing "the Origin must be the page's own". | Every ticket is `403`, every socket `403`, and a ticket with no `Origin` opens nothing (`401`). `*` never admits a socket. The `text/plain` POST answered **500** before T8-4 and `400` now. **Holds** |
| DNS rebinding | "DNS rebinding": `Host: rebind.evil.example` from loopback, on every route and the upgrade, under `none` and under a token. | `421` before any credential or gate. **Holds** |
| A prompt injection in a chat (with its token) | "prompt injection" ×2: a chat token on the upgrade, as `Authorization` and as `?token=`, under `none` and under a token. Plus the existing "a chat token… 403 on every route, reads too". | `403 chat-token` under `none`. `?token=` is no credential on the socket. Under a token, the socket asks for a ticket that a chat cannot mint. **Holds** |
| A prompt injection in a chat (no token, from its process tree) | "a grandchild of a chat that dropped `CLAUDIO_CHAT_ID`" through the **real** peer check. Plus the existing "a request from a chat's own process…". | `403 from-agent`, and the attempt is a row. **Holds** |
| The same, after the chat process detaches | `todo` test "a chat process that detaches…", plus the manual check below. | **Fails under `mode: none`: T8-1** |
| A leaked owner token | "leaked token" ×4: with the feature off, a LAN request with the token opens nothing and cannot turn it on. A session opened from another device names the address. Rotating the token, or narrowing `remote`, while a socket is attached. | Feature off: `409`. Turning it on: `403 needs-tunnel`. The session row has `client: 192.168.1.42`. Before T8-5 an attached socket **stayed open** after rotation, and a ticket minted with the old token still opened one for 30 s. Both now end. **Holds after the fix** |
| The tunnel | "tunnel, auth off": the runtime host on every route and the upgrade, and the tunnel's client-IP header on a loopback name. Plus the existing "tunnel only by default", where the tunnel name from a LAN peer is refused. | `403 needs-auth` under `none`. Under a token it is allowed only from a loopback peer on the runtime name. **Holds** |

The last paragraph of §3.1 asks for two things:

- **A restricted chat must not escape its tool policy through the terminal.** It holds for the
  chat's own tools: its token is refused, and its tree is refused. It does not hold through a
  process Claudio starts on the chat's behalf outside that tree (T8-2).
- **No agent may type into a shell the person has open.** It holds unless the agent has a shell of
  its own and detaches (T8-1).

## Findings

### T8-1 — Under auth off, a detached agent passes the peer check (high within its scope, open, owner decision)

**What.** §3.5 finds the client's socket among the file descriptors of the chats' processes and their
descendants. A chat's process is one that carries `CLAUDIO_CHAT_ID`, and a descendant is found by
following `ppid`. A process can leave both: it drops the variable and detaches (`setsid -f`, a double
fork), and is reparented out of the chat's tree. Under `mode: none` it then reads `not-agent` and
goes through the gate like the person's browser. `Origin` cannot stop it: it is not a browser and
writes whatever `Origin` it likes.

**Manual check** (a throwaway script in the worktree, removed after, run on 2026-10-15):

- a real listener on `127.0.0.1:0` and the real peer check;
- the person's terminal opened from this process;
- a "chat" process with `CLAUDIO_CHAT_ID`, whose child starts a detached grandchild without the
  variable and exits.

The grandchild then:

1. lists the terminals;
2. mints a ticket with `Origin: <base>`;
3. opens the socket;
4. sends `touch <marker>\r`.

```
the person opened: term_bcjv97SNK9kb1HKI8KR3MQ
the person’s terminal: running
file the agent typed `touch` for exists: true
attachments: [{"actor":"local","client":"local","refused":null}]
```

The `todo` test reproduces the first step with the real check: `actual: '200 []'`.

**Scope.**

- Under a token or OIDC it does not apply: the agent holds no owner credential, and a chat token is
  refused.
- An agent without a Bash tool cannot do this itself; T8-2 is how it could do it indirectly.
- Under `mode: none` the rest of the API is just as open to such a process, which could, for
  example, start a `bypassPermissions` chat. What the terminal adds is typing into a session the
  person is using.

**Why no small fix.** Under `mode: none` nothing the person holds is secret from a process running as
the same user. Options for the owner:

- **(a)** Run each chat's CLI in a cgroup of its own (for example `systemd-run --user --scope`), and
  have the peer check read the holder's `/proc/<pid>/cgroup`. A detached process stays in its cgroup,
  although a user who owns the delegated subtree can still move it out.
- **(b)** Scan every process's file descriptors for the holder, which costs 30–40 ms (t0), and refuse
  a holder whose session or cgroup is not the person's.
- **(c)** Revisit decision 1: under `mode: none`, the terminal works only after the person has turned
  token authentication on.

The Settings card should say, beside the switch, that with auth off an agent that has a shell can
reach it. §3.11 currently says "agents can never use it", which is not true under `mode: none`.

### T8-2 — Processes Claudio starts outside a chat's tree are not checked (medium, open, core)

`runCommand` in `packages/core/src/verification.ts` runs an orchestration's verification commands
(`pnpm test`…) with `sh -c` in the worktree an agent just wrote. Its process is detached and carries
no `CLAUDIO_CHAT_ID`, so the peer check never looks at it.

A chat with only `Edit`/`Write` can therefore put code in a test file, and the verification phase
runs that code as a process that passes the peer check under `mode: none` (the same reach as T8-1).

Recommendation (core, t2's files): mark every process Claudio starts on an agent's behalf with a
variable of its own, for example `CLAUDIO_AGENT_RUN=<item>`, and have `PeerCheck` scan those trees
as well. A separate variable is better than `CLAUDIO_CHAT_ID`, which the chat lists read.

### T8-3 — A client that stops acknowledging freezes the shell for every client (medium, open, core)

t7 measured this, and the audit confirms it in the code:

- `FlowControl` pauses the PTY when any client is 2 MiB behind;
- it evicts a client only when it is 8 MiB behind;
- once the PTY is paused, nothing more is sent, so no client ever reaches 8 MiB;
- `recheck()` evaluates the same counts and has no clock.

So a phone that stops reading holds every other client's shell until it disconnects. That breaks
§2.7 ("does not hold others hostage"), and any attached client can do it on purpose.

The `todo` test in `packages/core/test/terminals-security.test.ts` states the promise. The fix is
in `flow.ts`: evict a client that has held the pause for some seconds while every other client is
under the low watermark, or set the eviction threshold below the pause.

### T8-4 — A cross-site `text/plain` POST answered 500 (low, fixed in t3's files)

Fastify also parses `text/plain`, and a cross-site form can send it without a preflight. On
`POST /terminals` such a body is a string, and `resolveTerminalCwd` threw a `TypeError`, which the
route answered as 500. No terminal could be opened this way.

The route now answers `400 terminal.bad-request` when the body is not a JSON object
(`apps/api/src/routes/terminals.ts`).

### T8-5 — Rotating the token or narrowing `remote` left attached sockets open (medium, fixed in t3's files)

The gate runs when a socket opens and never again. Before the fix:

- After `POST /security/token` (a new token, the owner's answer to a leak), a socket the old token
  had opened kept its shell.
- A ticket minted with the old token still opened a socket for up to 30 s, because the socket
  re-checks only that the ticket's actor is not a chat or the desktop. It does not check that
  `token:<id>` is still valid.
- The same held after `DELETE /security/token`, after a change of auth mode, and after
  `PUT /terminal/settings` narrowed `remote`.

The fix, in `terminal-socket.ts`:

- `TerminalTickets` now tracks the sockets it opened.
- `revokeTerminalAccess(core)` spends every ticket and closes every socket with `4001
  terminal.reauthenticate`.
- `routes/security.ts` calls it after a change to the auth config, after `POST /security/token` and
  after `DELETE /security/token`.
- `routes/terminals.ts` calls `revoke()` when `remote` changes.

The shells keep running. The view reconnects on any close that carries no `closed` frame, with a
new ticket and through the gate as it is now, so the person sees a reconnect and the attacker sees a
`401`/`403`.

Tested by "rotating the token… ends the sockets" and "narrowing `remote`…".

### T8-6 — Low, noted

- **The ticket back-off is shared on loopback.** Under `mode: none` every local process counts in
  the `127.0.0.1` bucket, so ten wrong tickets make the person wait. An agent in its chat's tree is
  refused before the ticket is looked at; a detached one (T8-1) could do this.
- **Refusal rows can be flooded.** Under `mode: none`, a LAN client on an allowed `Host` writes one
  `terminal_attachments` row per refused request, and the table keeps the newest 10 000. A flood
  pushes older attempts out of what the owner sees. A rate limit per address on refusal rows would
  bound it.
- **Through the tunnel the audit `client` is `127.0.0.1`.** Tailscale Serve's client-IP header is
  not trusted (`TUNNEL_HOST_OPTIONS`), so a tunnel session reads like any loopback relay. Recording
  `tunnel:<host>` in `clientOf` would make the history say where a session came from.
- **Tailscale Funnel.** `remote: 'tunnel'` trusts the runtime host lent by `tailscale serve`. If the
  person turns Funnel on for the same port, the terminal is on the internet behind the token. Claudio
  never turns Funnel on; `docs/tunnel.md` could say so.
- **Other Claude credentials.** `env.ts` removes the three variables of decision 3. Bedrock and Vertex
  credentials (`AWS_*`, `CLAUDE_CODE_USE_BEDROCK`, `ANTHROPIC_VERTEX_*`) set in the server's
  environment pass through as the person's own. That is consistent with the decision, and worth one
  line in `docs/terminal.md`.

## Read and found sound

- **The gate's order** (`terminal-gate.ts`): feature, read-only, actor, where from, peer. Turning the
  terminal off is the one way to bypass where-from, and only for exactly `{enabled: false}`.
- **Where from.** `fromLocalMachineStrict` reads the socket's peer (not `req.ip`) and needs a
  loopback `Host` that is not a runtime host, with no `Forwarded`, no `X-Forwarded-For` and no
  runtime client-IP header.
- **Tickets.** 32 random bytes, kept as SHA-256 hashes, valid 30 s and spent on the first try, even a
  wrong one. Each is bound to its terminal, its actor and a non-null `Origin`. The table is capped at
  1 024. A wrong ticket counts in `FailureBackoff`.
- **Origin.** Required on the upgrade. It must be the dialled host or one listed in
  `CLAUDIO_CORS_ORIGIN`, never `*`.
- **Upgrade refusals.** The first `onRequest` hook destroys the socket after every refused upgrade,
  and `app.close()` resolves (existing test).
- **Logs and audit.** `redactUrl` takes `ticket=` and `token=` out of logged URLs, and the audit rows
  drop the query string.
- **Read-only.** Every route answers `405`, and turning read-only on closes every terminal.
- **The shell's environment.** No `CLAUDIO_*`, no Claude credentials, no `ELECTRON_RUN_AS_NODE`, no
  AppImage paths. Vault entries go through the same filter. The host is forked with an empty
  environment (except `ELECTRON_RUN_AS_NODE` under Electron) and never uses `child_process`.
- **The working directory.** Ids come in and a path goes out. The path is resolved through
  `realpath`, and a symlinked worktree cannot point outside the project.
- **Cleanup.** SIGHUP, then SIGTERM, then SIGKILL to the shell's group and its descendants. The host
  ends its shells when its channel closes. `reapStrays()` matches pid and start time. All of this
  ran against a real PTY in `terminals-lifetime.test.ts`, with no test skipped.
- **Isolation.** Nothing outside `core/index.ts` imports the terminal service, and the MCP server does
  not know about it (`terminals-isolation.test.ts`).

## Checks run (2026-10-15)

- `pnpm typecheck` (root): exit 0.
- `pnpm --filter @claudio/api test`: 352 tests, 351 pass, 0 fail, 1 todo (T8-1).
- `pnpm --filter @claudio/core test`: 2 245 tests, 2 239 pass, 0 fail, 5 skipped, 1 todo (T8-3).
  - The skips are conformance cases the Claude Code harness has no rig for. None is a terminal test.
- No process was left running. The detached child in the T8-1 test ends itself after 5 s.

## Related

[[plans/terminal.md]] · [[terminal.md]] · [[security-model.md]] · [[reports/terminal-perf.md]] ·
[[reports/terminal-t0.md]] · [[tunnel.md]]
