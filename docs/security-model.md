---
created_at: 2026-10-09T10:00:00Z
updated_at: 2026-10-18T20:00:00Z
tags:
    - security
    - secrets
    - setup
    - docker
---
# Security model: who may open Claudio, and how its secrets are kept

The project's security policy, what is and is not protected and how to report a vulnerability, is
[SECURITY.md](../SECURITY.md) at the root. This page is the knowledge base's map of the model,
pointing at the documents that own each part (several linked to it by name before it existed). The
part written in full is the newest one: how the keys and tokens a person enters during the in-app
setup are kept ([the plan](plans/in-app-setup.md), [setup.md](setup.md)), as built on 2026-10-08.

## Who may open it

- **The auth mode** is `none`, `token` or `oidc` (Settings → Access & safety, `auth.json` in the data
  directory with the hash of the token, mode 0600; `CLAUDIO_AUTH_MODE` only seeds an install that has
  none yet). See [securing.md](securing.md). The setup assistant's Access
  step sets the same thing, and turning Token on makes a token first when the browser holds none, so
  it cannot lock the person out ([setup.md](setup.md#the-web)).
- **The first-run owner token.** A container started with no auth variable makes an owner token on
  its first start and turns token authentication on; it is printed once and kept in
  `/data/first-run-token` (0600) until first used, and the audit log records its generation and first
  use. A 0.6.x container saved as `none` is migrated once; `CLAUDIO_AUTH_MODE=none` or choosing None
  in Settings is respected ([deploy.md](deploy.md#the-first-run-token),
  [decisions/container-owner-token.md](decisions/container-owner-token.md)).
- **The host claim.** `POST /security/allowed-hosts/claim` is the one route the host check lets
  through. It needs an owner credential (refused under `none`, to the desktop and to a chat), its
  wrong tokens count in the sign-in back-off, and a DNS-rebinding page cannot hold the bearer token.
- **Owner-only routes.** `isOwnerActor` (a `token:*` or OIDC actor) guards the claim, the in-app
  server update and the CLI install. `CHAT_FORBIDDEN_SYSTEM` lists them for a chat's token; read-only
  refuses them with `405` ([updates.md](updates.md#who-may-update)).
- **`/app` is root-owned in the image**, so an agent running as `node` in `bypassPermissions` can no
  longer rewrite the server it runs under. Updates live in `/data/app` and are re-verified at every
  boot by a root-owned launcher against root-owned public keys ([updates.md](updates.md#how-it-is-trusted)).
- **Read-only mode** (`CLAUDIO_READ_ONLY`) refuses every write, the setup's included (405).
- **A chat's own token.** A chat Claudio starts gets its own `CLAUDIO_API_TOKEN`
  ([chat-environment.md](chat-environment.md)); it may not change the security settings, open the
  tunnel or touch the setup routes but `GET /setup` (403), since reading a sign-in session would hand
  it the person's device code.
- **Remote access** is tailnet-only (`tailscale serve`, never Funnel), and refuses to open while the
  auth mode is `none` ([tunnel.md](tunnel.md)). The host allowlist is in
  [deploy.md](deploy.md#the-host-allowlist-and-why-a-proxy-has-to-be-told-about-it).

## The secret vault

`packages/core/src/secret-vault.ts`, one document: `<dataDir>/secrets.json`, mode 0600, written
through a temp file created at 0600. It holds only what a CLI reads from its **environment**: Claude
Code's OAuth token or API key, YouTrack's address and token, and one secret no CLI reads at all: the
iroh secret key of an install that turned Collaborators on (see [Collaborators](#collaborators)).
Values are sealed with AES-256-GCM (`SecretBox`) when
there is a key, as `enc:v1:…`.

**The key**, in this order (the plan's decision 3):

1. `CLAUDIO_SECRET_KEY`, 32 bytes as hex. The desktop app makes one and keeps it in a file only the
   operating system's keyring can open (Electron's `safeStorage`, `apps/desktop/src/secret-key.ts`),
   and hands it to its server at launch; an operator can pass one to a container. The server drops it
   from `process.env` once read, so no child inherits it.
2. `<dataDir>/secret.key`, when it already exists.
3. In the Docker image only (`CLAUDIO_DISTRIBUTION=docker`), a new `secret.key`, 32 random bytes as
   hex, mode 0600, made on the first write: `/data/secret.key`, on the same volume as the vault.
4. Otherwise none: a source install, or a desktop app with no keyring, keeps the values plain at
   0600, as before the vault.

A key beside the data protects a copy of the files (a backup, a file sent by mistake), not the
volume: whoever can read `/data` reads both. Settings → Access & safety's Secrets card says which case an
install is in (`GET /setup`'s `secrets`: `sealed`, `keyBeside`), and recommends passing the key in the
environment; [deploy.md](deploy.md#what-the-image-contains) says how. The Helm chart takes it from a
Secret (`secretKey.existingSecret`, rendered as `valueFrom.secretKeyRef`), so it stays out of the
release. A value sealed with another
key reads as absent, so it is entered again rather than misread.

The older plain files, `credentials.json` (Claude Code) and `youtrack-credentials.json`, are moved
into the vault once at start and removed.

## Where a secret may go

The plan's decision 5: **a secret never goes in argv, a log, an event or an answer.**

- **Only to the child processes of the CLI that needs it.** `childEnv(tool)`
  (`packages/core/src/child-env.ts`) lays that tool's vault variables over the inherited environment
  for every spawn of that tool: Claude Code's runs and probes, the
  detector, gh, glab and youtrack-app. Nothing is written to `process.env`, so a project's checks,
  git, or another agent never inherit Claude Code's token. (Before the vault, the Claude store copied
  it into `process.env` and every child got it.)
- **On stdin for a CLI with a login command.** A key for gh or glab goes once to that CLI's
  own login command on stdin (`gh auth login --with-token`, `glab auth login --stdin`), and the CLI stores it (decision 4). The tests assert the spawned argv
  and what the fake CLI read on stdin.
- **Tailscale's auth key through a file.** `tailscale up` takes a key only in argv or as
  `--auth-key=file:<path>`, so the key is written to a file of mode 0600 inside a fresh 0700 folder
  under the system temp directory (`wx`, never over an existing file), the command gets the path,
  and the folder is removed when the command ends, whatever happened. tailscaled keeps the node key
  it gets in exchange, so the auth key is used once and stored nowhere
  ([setup.md](setup.md#tailscale)).
- **Write-only fields.** The key fields in the sign-in panel and YouTrack's token are never filled
  back: no route answers a secret, the field is cleared once sent, and an empty token field keeps
  the saved one.
- **Events carry the URL and the code, nothing else.** A device sign-in reads the CLI's output line
  by line for the verification URL and the one-time code only; `login.updated` carries those and an
  error *code*, never what the CLI printed. Success is decided by re-running the tool's readiness
  probe, not by reading the output.
- **Masked where text leaves the machine.** Every vault value joins Claudio's own secrets
  (`recognizeSecrets`, `packages/core/src/decisions/redact.ts`), masked in a decision's state whatever text surrounds them.

## What a child process inherits

Everything Claudio starts for an agent or a person (a chat's or a worker's Claude Code, the flow,
the assistant, a decision's `cli` run, one-shot runs, the hooks and MCP servers those start, the
setup and sign-in CLIs, the host CLIs, a verification or eval command, the terminal's shell) gets
none of the server's own configuration. `withoutServerEnv` (`packages/shared/src/server-env.ts`) is
the one rule, applied by `childEnv`, by the accounts' `envFor`, by `runCommand` and by the evals'
`commandEnv`:

- `PORT` and `HOST` are dropped;
- `CLAUDIO_*` is an **allow-list**, not a deny-list: only `CLAUDIO_API_URL`, `CLAUDIO_API_TOKEN` and
  `CLAUDIO_CHAT_ID` pass (a chat's are set by `spawnProcess` anyway), plus the `CLAUDIO_FAKE_CLI_*`
  switches of the browser suite's fake Claude Code. A variable the server adds tomorrow is dropped
  without anyone remembering to;
- the terminal is stricter: its shell gets no `CLAUDIO_*` at all (`terminals/env.ts`).

Why: on 2026-10-18 a worker ran `pnpm dev` in its worktree, and the dev server read the desktop's
`CLAUDIO_DATA_DIR` and `PORT` from the worker's environment. It opened the owner's live data
directory, and before it failed to bind the port it took the desktop's tunnel record for a leftover,
ran `tailscale serve --https=8444 off` and closed the owner's tunnel. The exact list a chat gets is
in [chat-environment.md](chat-environment.md#what-a-child-gets-and-what-it-never-gets).

## One server per data directory

A server takes an exclusive lock on its data directory before anything reads or writes it: before
the stores open, the migrations run or the tunnel reconciles (`acquireDataDirLock`,
`packages/core/src/data-dir-lock.ts`, called first in `startServer`, which the dev server, the
container's API and the desktop's server child all go through). A second server on the same
directory prints which directory and which pid hold it, and exits with code 73 having touched
nothing. The launcher (the container's, the desktop's) reads that code as "not the payload's fault":
a trial that ends with it is neither failed nor restarted.

- **How.** Node 22 has no advisory file lock without a native module, so the lock is
  `<data>/server.lock`, created with O_EXCL (`wx`), naming its holder: a random id, the pid, the
  hostname, the process's start time from `/proc/<pid>/stat` and the boot id. It is removed on
  every way out but a crash.
- **Stale locks.** A crash leaves the file behind; it is stale when that pid is gone, when the pid now
  belongs to a process that started later (a reused pid), when it was written before the last boot,
  or when it was written on another host (a container recreated on the same volume gets a new
  hostname, and refusing would keep it from ever starting again). A stale lock is removed under a
  second O_EXCL file (`server.lock.takeover`), and only if it is still the one judged stale, so two
  servers starting at once on a crashed one's directory cannot both win.
- **The tunnel trusts it.** The tunnel's record carries the lock's id. At start only a record written
  under a previous holder's lock is reconciled; one from before the lock existed is left alone while
  something answers at its target. And a server only ever takes away the rule it added itself
  ([tunnel.md](tunnel.md#only-what-claudio-added)).

## What the vendors' CLIs keep in plain text

Some sign-ins are not Claudio's to keep. Where a vendor's CLI has a login command, it owns the
credential and stores it where it always does (decision 4); Claudio does not copy it, seal it or
read it. In the Docker image those homes are on the data volume so a replaced container keeps them,
and a container has no system keyring, so each CLI falls back to the plain-text store it documents
for that case:

| CLI | Where, in the image | What |
|---|---|---|
| gh | `/data/provider-homes/gh/hosts.yml` (`GH_CONFIG_DIR`) | the OAuth or personal token per host; gh's documented fallback when no keyring exists |
| glab | `/data/provider-homes/glab/config.yml` (`GLAB_CONFIG_DIR`), mode 0600 | the token per host; glab says so as it signs in |
| Tailscale | `/data/tailscale/tailscaled.state`, in a 0700 folder | the node's key, which is what keeps it on the tailnet |

Why this is accepted rather than wrapped: sealing another CLI's files would mean reading and
rewriting them behind its back, or handing it a credential it was not built to take, which the one
rule forbids ([CLAUDE.md](../CLAUDE.md)). The CLIs' own fallback is what their vendors document for
a machine with no keyring, and the files sit on the same volume, with the same exposure, as
Claudio's own `secret.key`. The protection for all of them is the volume's: who can read `/data`.
Signing out from Claudio runs each CLI's documented sign-out (`gh auth logout`, `glab auth logout`,
`tailscale logout`), which removes what it stored.

On a person's own machine (a source checkout, the desktop app) the CLIs use the system keyring when
there is one, as they always did; Claudio changes nothing there.

## What a repository can make Claudio run

A repository is not trusted: its `.git/config` and `.gitattributes` can name a `textconv` or external
`diff` driver, which is a program git runs when it builds a diff. Every `git diff` Claudio runs
itself (changes, the diff stat of a failing check, the health probe, the merge state) passes
`--no-textconv --no-ext-diff`, so opening a project never executes code a clone brought along.

## Agents never push

`git push` is denied, as `--disallowedTools`, to every run Claudio starts for an orchestration (workers,
integrator, verification and fixer, planner, workflow, synthesis), to the supervisor, and to every flow
stage. The push of a pull request branch is Claudio's own process, after the person approved.

## The review gate

The review gate ([orchestrations.md](orchestrations.md#the-review-gate)) reads code a worker wrote, so
everything it reads is untrusted, and it fails closed.

- **Confinement.** A reviewer and a verifier run with `--restricted --tools=Read,Grep,Glob`: no
  Bash, no Write, no network, no settings of the user or the project, and the file tools confined to
  the working directory (a `Read` or `Grep` outside it is refused; recorded in the plan's CLI
  facts). They run in a checkout of the integration branch and have a budget and a turn limit. The
  fixer is the only run that writes.
- **The role file cannot widen it.** Claudio supplies the rules, the tools and the model of every
  reviewer. A role file only says what to look for; its `tools`, `disallowedTools` and `model` are
  ignored. Role files are read from the project checkout, never from the integration branch, so a
  worker cannot weaken its own reviewer in the diff under review. The conventions reviewer is shown
  the project rules as they were at the base commit, for the same reason.
- **Text addressed to an agent.** A scan of the added lines flags text that tells a reviewer to
  approve, ignore or skip. It becomes a high finding and goes to a verifier, and the reviewer's own
  rules say the same.
- **Committed secrets block.** A deterministic scan of the added lines, generated and locked files
  included, blocks on a committed secret, and so do conflict markers. The diff is not redacted before
  a reviewer reads it (redacting would hide the very finding); instead every stored finding has its
  evidence masked and cut.
- **Fail closed.** A reviewer that crashes, times out, overspends or answers outside the schema makes
  the gate `incomplete`, and an incomplete gate cannot pass. The pull request stays held while the
  gate is neither passed nor accepted.
- **Only a person accepts.** `POST /orchestrations/:id/review/accept` and
  `POST /projects/:id/review-roles/:role` answer `403` to a chat's token, also under `auth.mode:
  none`, where the chat's label on the request is what refuses it. An acceptance needs a written
  reason, is bound to the head it was given on, and a new commit voids it. Reading the gate and
  asking for a retry stay open to a chat's token: a retry only runs Claudio's own gate again.

## A chat cannot approve its own memory

What a memory proposal writes (`CLAUDE.md`, a memory file, the journal) is read as instructions by every
later run of the project. `POST /memory-proposals/:proposalId/approve` and `/reject` therefore answer
403 to a chat's token, with the same error shape as the other routes closed to it; proposing stays
open, and the person's token decides.

## Lessons and a chat's token

A lesson is read as instructions by every later run of a project, so it is the person's from the
mining to the delivery ([lessons.md](lessons.md)).

- **Chat tokens.** Every route that approves, edits, pins, confirms, retires, restores, deletes,
  promotes, demotes, proposes for `CLAUDE.md`, mines or configures lessons answers 403 to a chat's
  token, as does approving a `lesson` proposal or an `instructions` proposal made from a lesson.
  Reading lessons stays open. Only the miner can create a `lesson` proposal; the flow's own proposal
  targets stay `instructions`, `memory` and `journal`.
- **The miner's confinement.** It runs `--restricted --tools= --setting-sources=` with
  `--no-session-persistence`, `dontAsk` and no `CLAUDIO_API_URL` or token: no tool, no settings file,
  no way back into Claudio. A prompt injection that reaches it can only produce candidates, which a
  person still has to approve.
- **Untrusted text.** What the miner reads and returns is data. Its input and the delivered section are
  inside `pasted()` blocks with `PASTED_NOTE`; the delivery lead sentence, outside the block, is what
  authorises following approved lessons. The validator drops candidates holding a command line, a code
  block, a URL, a secret or an instruction-like phrase, and counts each drop.
- **Redaction** happens at three points: when a signal row is written, in the decision engine's state
  for `lesson.mine`, and in the miner's input (`maskSecrets`, which also covers Claudio's own
  secrets). Evidence keeps at most 1 KiB of the person's words and 500 B of context per row, and 10 rows
  per lesson; deleting a lesson deletes its evidence.
- **Nothing is imported.** Lessons can be downloaded as JSON; no route, file or flag reads them in.

## A chat's token cannot compact a chat

Compacting is a paid turn over the whole context and is the person's to start. A chat's token can
read the breakdown, compactions and session notes (`GET /chats/:id/context`, `/compactions`,
`/notes`), and `POST /chats/:id/compact`, `POST /chats/:id/notes` and `DELETE /chats/:id/notes/:noteId`
answer 403 to it, as does a `/compact` sent as a message, or as the prompt of a resume or a fork. The
served notes pass through `maskSecrets`, which covers Claudio's own secrets too. No note ever reaches a
prompt on its own. See [context-control.md](context-control.md).

## The terminal

The terminal is a shell on the machine that runs Claudio, so it is the most privileged thing the
server offers. The full model is [plans/terminal.md §3](plans/terminal.md#3-security); the rules:

- off until the owner turns it on; with authentication off it opens only from loopback, and off this
  machine only through the tunnel with a token (or any device with a token, if the owner allows it,
  which is the default in a container, where no request is ever from loopback: the owner token
  already starts chats that run any command, so the terminal adds nothing to it);
- a chat's token, the desktop secret and any process a chat started are refused, the last by looking
  up the connection's owner in `/proc`; when that cannot be told, it fails closed under `none`. Known
  limit, accepted by the owner (2026-10-15): with authentication off, an agent that has a shell can
  detach from its chat's process tree and reach the terminal; with token or OIDC authentication it
  cannot. Settings warns about it beside the switch;
- the socket opens with a one-use ticket (30 s, bound to the terminal and the `Origin`), and the
  `Origin` and `Host` are checked before the upgrade;
- **Forwarded requests.** `X-Forwarded-*` is whatever its sender wrote, so it is believed from one
  place only: the dev server on this machine. A request counts as forwarded-but-local when its
  socket peer is loopback, the `Host` it carries is loopback, every hop of `X-Forwarded-For` is
  loopback and `X-Forwarded-Host` is one loopback name (`forwardingOf` in `apps/api/src/security.ts`).
  Anything else that carries a forwarding header, or the standard `Forwarded`, is relayed and needs a
  token. The Vite proxy sets `xfwd: true` for this: without it every LAN device that browsed the dev
  server reached the API as the dev server on loopback and passed for this machine. When the
  forwarding is believed, the ticket and the socket compare the `Origin` with the forwarded
  authority (the page's), not with the `Host` the proxy rewrote; otherwise with the `Host`, as in
  production, where the API serves the page itself and nothing changes;
- **where it opens is confined.** The client sends ids, never a path, and the directory is resolved
  through symlinks and must be inside its root: the project's directory or one of its listed
  worktrees, or the configured workspace (`config.workspaceDir`) for a terminal with no project and
  for a chat outside any project, whose own directory must be inside the workspace. What the person
  does with `cd` afterwards is theirs;
- the shell gets the vault's tool credentials but no `CLAUDIO_*` variable, no `PORT` or `HOST`, and
  none of Claude's own;
- sessions and attachments (including refusals) are audited, never their content.

See [terminal.md](terminal.md).

## The daily spend cap is the person's

A prompt injection holding a chat's token could otherwise lift the cap it is bound by (plan:
[plans/agent-run-improvements.md](plans/agent-run-improvements.md)). The denials are in `apps/api/src/security.ts` and the routes:

- **The cap.** A chat's token that names `dailySpendCapUsd` in `PUT /settings/app` gets `403`
  (`routes/app-settings.ts`).
- **The pass.** `POST /orchestrations/:id/spend-pass` is in `CHAT_FORBIDDEN`: a chat token cannot grant
  a graph today's pass. So is `POST /work-items/:itemId/spend-pass`, the same pass for a flow card the
  cap holds (a row in `flow_spend_passes`, good for the local day it names).
- **The override.** `X-Claudio-Spend-Override: 1` lets a person's request through a `409 spend-cap`.
  On a chat token the header is ignored, so the request still answers `409`.

## Collaborators

Teammates' Claudios share projects read only, peer to peer over iroh
([collaborators.md](collaborators.md), [the plan](plans/collaborators.md)). It is off until the person
turns it on; with it off, no endpoint is bound, no socket is opened, nothing is published and the
native module is not loaded.

**The new surface.** A UDP endpoint, reachable by any peer that knows its id, speaking Claudio's own
protocol (`claudio/collab/1`), never the HTTP API.

- **Identity is the key.** iroh authenticates the endpoint id in the QUIC handshake, so there is no
  token of ours to steal. A request is served only when its id is a member of a group on the chain
  this install holds, for a project shared with that group, of a kind it shares. The only frames
  accepted from a non-member are `join` and, from a member leaving, `leave`.
- **The roster is signed.** One owner key signs a hash chain of member lists, so a forged or reordered
  roster is rejected and a group's id certifies its own genesis. An invite's secret is 128 bits,
  one-time and valid for 7 days; a relayed `join` is sealed to the owner's key, so the member carrying
  it learns nothing.
- **Serving starts nothing.** The serving side gets read-only ports and no run, chat, flow or
  orchestration service, enforced by construction, by a lint rule and by a test. Serving never calls
  Claude, so nobody's quota is spent.
- **A blob is never served by its hash alone.** The hash must be referenced by a shared record of that
  project, and an unknown hash answers like a missing one.
- **The local routes are the owner's.** Every `/collaborators` route, and the project's `sharing`
  routes, are in `CHAT_FORBIDDEN_COLLABORATORS`: a chat's token gets `403`, so a teammate's transcript
  never reaches an agent's context unasked. The copy reads are the one exception, below.
- **The endpoint runs in a child process** (`collab-host.mjs`), so a fault in the native binding
  cannot take the API down.

**Agents that read teammates' copies (changed 2026-10-17).** The first decision closed every
`/collaborators` route to a chat's token, reads included. The owner then chose to let agents read what
teammates share, narrowly ([plans/collaborators-agent-access.md](plans/collaborators-agent-access.md),
R13; [collaborators.md](collaborators.md#agents-that-read-what-teammates-share)). A teammate's text is
input the person does not control, and a model that reads it can be steered by it (prompt injection),
so:

- **Only the copy reads open, and only in scope.** `AGENT_READABLE` in `apps/api/src/security.ts` lists
  them: the shared list, one shared project, its chats, memory, journal, documents, work items and
  artifacts, and its transcripts. On those, a chat's token is let through only when
  `agentReadScope` (`packages/core/src/collab/agent-access.ts`) gives its chat a scope, and the copy
  the route names is in it; otherwise `403` with a `collaborators.agent-read.*` code (`off`,
  `assistant-off`, `no-chat`, `mode`, `no-project`, `project-off`, `copy`) and a sentence the tool
  can repeat. The list itself is filtered by the same scope. Everything else (blobs, links,
  settings, a project's sharing, the audit list) stays closed to chat tokens.
- **Two scopes.** The Claudio assistant, which runs no command, reads every copy while Collaborators
  and its `assistantReads` switch are on (on by default). Any other chat reads only the copies of its
  own project, and only when the project's `agentReads` is on (off by default).
- **Never a chat that acts without asking.** The scope needs the live process to run in `manual`,
  `acceptEdits` or `plan`: `bypassPermissions`, `auto` and `dontAsk` read nothing, so an
  orchestration worker never does. The MCP tools are handed out on the same decision, at every process,
  and the API decides again at every call.
- **The sharer's flag is honoured by the reader.** `agentsMayRead` travels in the catalog; with it off,
  no chat of the reading install gets the copy. Like everything here it is cooperative: a modified
  reader can ignore it.
- **Third-party content, never instructions.** The MCP tools return a teammate's text fenced, under a
  header that names its author and says it is data; names they chose appear only as quoted, cut
  strings. No blob is ever handed to an agent.
- **A read changes nothing.** A chat's read never pulls from the owner (`refresh` is ignored), so an
  agent cannot make this install contact a peer.
- **Audited.** Every read is a `collab_agent_reads` row (chat, tool, copy, kind, record ids; the newest
  20,000 kept), listed in Settings → Access & safety and counted on the copy.

**The vault's new kind of secret.** The iroh secret key is generated once, when Collaborators is
first turned on, and kept in the vault. It is the first vault value that is not handed to a CLI's
environment. It is the install's identity: whoever holds it can speak as that member, so it follows
the vault's rules ([the key](#the-secret-vault)), and losing it means joining again under a new id. An
owner's key is also what signs the group, so losing it freezes the group; ownership can be
transferred beforehand.

**The n0 dependency.** Discovery and the default relays are run by n0. With the defaults n0's
discovery server learns each endpoint id and its addresses, and its relays carry traffic they cannot
read. The Node binding offers no discovery setting, so discovery stays n0's in v1; a custom relay URL
removes the relay part.

**What is cooperative.** What a receiver deletes, stops showing or stops serving after a removal, a
departure or an unshare describes an unmodified Claudio; a modified one keeps what it got.
Transcripts are shared as they are, tool output included, which is the group's trust and is stated in
the UI.

## Guards

Orchestration workers and the flow run with deterministic `PreToolUse` hooks that block skipping git
hooks, any push, destructive commands and secrets written into files, even in `bypassPermissions`
([guards.md](guards.md), [the plan](plans/guards.md)).

- **The guard is the app's.** It ships with the server (`guard.mjs`) and is never resolved from a
  project or a plugin cache. In the image it is root-owned and read-only; preflight refuses an entry
  that is group- or world-writable. It fails closed, and the launch fails when it cannot be armed.
- **A chat cannot weaken it.** A chat's token gets `403` on `PUT /settings/guards` and
  `POST /guards/check`, can read only its own `/guard-events`, and cannot save an override weaker
  than the global rules (project settings, orchestration launch, relaunch, resume, templates).
- **No secret leaves through it.** Reasons name a pattern, not the value; the stored excerpt is
  masked and cut to 240 characters.

**Explicitly not guaranteed.** Guards are not a sandbox. They do not stop a compiled or opaque
program, a Makefile, a script fetched from the network, a secret encoded or assembled at runtime, the
person's shell aliases, or a repository whose own hooks lie. They guarantee that the documented
forms in the bypass corpus are blocked, that every block is visible, and that the guard cannot be
switched off from inside the run without the run being stopped.

## Evals

An instruction eval spends the person's account and runs the commands its file asks for (the setup
command, `command` assertions), and the file may be repository content someone else wrote. So a
run needs the person's consent to that file's exact content, and a chat's token gets `403` on every
eval route that writes or spends: saving or deleting an eval file, consenting to one, starting,
resuming or re-judging a run, accepting a judge, drafting cases and deleting a run's results
(`CHAT_FORBIDDEN_EVALS` in `apps/api/src/security.ts`). Reading, estimating and cancelling stay open
([evals.md](evals.md)).

## Known limits

- A key beside the data does not protect the volume; only a key passed in the environment does.
- Nothing about a copy is enforced on a teammate's machine: a removed member keeps what they already
  received ([Collaborators](#collaborators)).
- A credential is not refused for free: the CLI's `get_usage` answers the same for a bad token, a bad
  key and a network that is down, so a revoked one reads `ready` until a run fails on it or the
  person presses **Send a test message** ([accounts.md](accounts.md#checking-a-credential)).

## Related

[[guards.md]] · [[updates.md]] · [[setup.md]] · [[plans/in-app-setup.md]] · [[deploy.md]] · [[tunnel.md]] · [[code-hosts.md]] ·
[[collaborators.md]] · [[plans/collaborators.md]] · [[plans/collaborators-agent-access.md]] · [[plans/review-gate.md]] · [[lessons.md]] · [[terminal.md]] · [[providers.md]] · [[trackers.md]] · [[chat-environment.md]] · [[desktop.md]] · [[layered-settings.md]] · [[evals.md]]
