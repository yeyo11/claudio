---
created_at: 2026-10-17T12:00:00Z
updated_at: 2026-10-18T12:00:00Z
tags:
    - limitations
    - known-gaps
    - security
    - operations
---
# Known limitations

What Claudio does not do, or does only partly, and why. These are decisions with their reasons, not
a backlog: what was considered and refused is under
[Decided against, for now](../ROADMAP.md#decided-against-for-now), and each feature's own gaps are in
the Known gaps of its page. Until 2026-10-17 this list was the README's.

## Limitations

- Authentication is off by default, and there is one credential for everyone who holds it: no
  per-user isolation, no per-user permissions. Claudio does not terminate TLS (see
  [securing.md](securing.md)) and does not sign anyone in with OIDC: it only validates a JWT.
- `GET /api/health` reports the CLI and login state observed by the last authenticated read, and
  measures nothing itself. In a container with a probe and no client traffic it keeps reporting what
  it saw at boot, which is what a liveness probe wants and is not a way to notice a token expiring.
  `GET /api/system` is what takes a reading.
- Run metadata is persisted and conversations are rebuilt from the session transcripts after a
  restart, and so are background tasks and subagents, which are read back from the files the CLI
  writes. What exists only in a run's live stream is lost: its stderr, and the rate-limit notice.
  Workers do not survive a restart either: a task caught by one is `interrupted` (not `stopped`,
  which is someone's decision), and its chat goes on in a new execution once the wrapper is back,
  while the task has attempts left. A stopped task is never continued on its own, and a workflow
  or a graph caught while integrating waits for `resume`, except a workflow whose lead was waiting
  for a limit to reset: the wait outlives the restart and the workflow is followed again.
- A background task's output lives in the CLI's temp dir, which a reboot clears. Its command,
  status and summary stay in the transcript.
- Running the API with a file watcher (`pnpm dev`) while an orchestration edits this same repo
  restarts it mid-flight. Use `worktree: true`, or serve with `pnpm start`.
- Secrets in MCP `env` and `headers` are not returned, but they are stored in the CLI's own files as
  the CLI needs them, and copied into a mode 600 config file for a chat that picks its servers.
- A chat's own MCP selection covers the servers in the CLI's files. Plugin and claude.ai connector
  servers are not in any file Claudio can read, and `--strict-mcp-config` drops them, so they cannot be
  picked. A resume that picks no servers writes the config file again from the current definitions of
  the same ones, so a server removed since is simply left out.
- Usage: days are the server's own, weeks start on Monday, and a cost the CLI never reported (a chat
  started from a terminal, or an execution older than the per-model figure) is missing, not zero.
- Verification, health and the changes views need what they read: the checks need `worktree: true`
  on the graph engine, cancelling a command needs Linux, and "what it is doing now" is read from
  the last unanswered tool call in the transcript, so the time since its last event keeps growing
  during a long command that is alive.
- The supervisor answers each occurrence of a signal once (the call it is about, or when it
  started), and its hint reaches a worker only while that worker's process is up. A hint about a
  subagent goes to the lead, which has to relay it: nothing documented writes to one subagent. What it costs
  is spent whether or not the answer is used, and lands on the graph when the worker is a task.
- A project's export has no date range: it carries every chat of the project, and a chat's cost is
  its whole cost.
- Web Push needs a secure origin. On `http://<lan-ip>:8797` the browser gives the page no service
  worker at all, so there is no push and no cached shell; the app can still be added to a home
  screen, and Settings names the origin instead of offering a switch that does nothing. On iPhone and
  iPad a push only reaches an app on the Home Screen, never a Safari tab. The Linux desktop app
  registers no worker either — its port changes every launch — so push is for a browser or a phone
  pointed at a server.
- A push subscription belongs to an install, not to a person. Claudio has one credential for everyone
  who holds it, so every device that turned push on is sent the same notifications, whoever the chat
  was started by, and anyone who can reach Settings can test or remove another device's registration.
  Turning it on on a shared phone tells whoever is holding it that a chat is waiting.
- The tunnel reaches only your own tailnet, through Tailscale: the phone needs the Tailscale app
  signed in to it, and a code host on the internet cannot deliver webhooks there, so webhooks have
  no address to register (polling carries the pull requests). The tailnet needs MagicDNS and HTTPS
  certificates on, and the node's user must be its Tailscale operator to change Serve settings.
  Every request through it shares one failed-login wait, so a guess from another tailnet device can
  make your phone wait.
- A subscription token is meant for your own individual use; use an API key for anything
  shared or multi-user.
- Rotation between accounts sees what the CLI ships for programs and nothing else. Refresh asks the
  CLI itself (`get_usage`), which states the credits and the weekly limits scoped to one model, but
  nothing polls it: an idle account's usage is as fresh as its last Refresh (the button, or opening
  Accounts when the reading is over 10 minutes old), else the CLI's own cache of it, and the
  protocol is not a contract, so a renamed key reads as no data. A running `claude` is never moved
  to another account: the next launch is. See [accounts.md](accounts.md),
  [decisions/get-usage-control-request.md](decisions/get-usage-control-request.md) and decision 8 of
  [plans/claude-only-fork.md](plans/claude-only-fork.md).

## What is not reachable

claude.ai cloud data (web artifacts, claude.ai chat memory and projects) has no public API and
no CLI command, so the wrapper does not expose it. What Claude Code itself can reach from a
session — claude.ai connectors such as Docs, Gmail or Calendar, listed on the Connectors page and
shown in the effective environment — is available to any chat. A connector waiting for its sign-in
can be started from the Connectors page, which hands the CLI's own sign-in link to your browser
(`POST /connectors/:id/authorise`); otherwise authorising one happens in an interactive `claude`
session (`/mcp`) or in claude.ai's connector settings.

## Related

[[securing.md]] · [[security-model.md]] · [[accounts.md]] · [[tunnel.md]] · [[notifications.md]] · [[pwa.md]] · [[status.md]]
