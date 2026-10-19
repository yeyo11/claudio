---
created_at: 2026-10-17T12:00:00Z
updated_at: 2026-10-19T12:00:00Z
tags:
    - rest-api
    - api
    - openapi
    - reference
    - convention
---
# REST API

Every route Claudio serves, one table row each, grouped by the OpenAPI tag it carries. This page is
the contract for the route list: **a route added or changed in `apps/api` gets its row here in the
same change**, and `apps/api/test/rest-api-doc.test.ts` fails when a route documented in
[`apps/api/src/openapi/routes.ts`](../apps/api/src/openapi/routes.ts) has no row, or a row names a
route that does not exist. Until 2026-10-17 these tables were the README's; why they moved is in
[decisions/rest-api-contract.md](decisions/rest-api-contract.md).

A row starts with the method (or several, separated by `/`) and the route without the `/api`
prefix, in backticks, with any query string after a `?`. One route per row: the test reads the
route cell literally.

**Interactive reference: <http://localhost:8797/docs>** (Scalar) · OpenAPI 3.1 document at
`/openapi.json`. Component schemas are generated from the shared TypeScript types
(`pnpm --filter @claudio/api openapi:schemas` after changing `packages/shared/src/types.ts`), route
docs live in [`apps/api/src/openapi/routes.ts`](../apps/api/src/openapi/routes.ts), and a test fails
when a route is added without documentation. The reference is self-hosted: Scalar's cloud
features and telemetry are disabled.

All routes are under `/api` and speak JSON. A refusal is `{ "error": "…" }` with a 4xx status and a
message meant to be read. Anything that fails for a reason nobody planned for is
`500 { "error": "internal error" }` — the detail goes to the server log with the URL, never to the
caller. Two refusals come from the guard rather than from a route: `421` when the `Host` is one this
wrapper does not answer to, and `429` with `Retry-After` after repeated failed credentials (a request with none is only `401`).
Types live in [`packages/shared/src/types.ts`](../packages/shared/src/types.ts).

## System

| Method | Route | Description |
| --- | --- | --- |
| GET | `/health` | `{ ok, cli, loggedIn }` — the CLI and login state as the last authenticated read left it. It spawns nothing, so it is a liveness probe and not a login check |
| GET | `/system?refresh=1` | CLI detection, auth status, paths. Cached for 30 s, and a value just past that is served while the refresh runs; `?refresh=1` always takes a fresh reading. Callers arriving together share one detection |
| GET | `/system/cli-version` | Claude Code in use, the version the image pins and the newest published, as the last check left it (never reads the registry) |
| POST | `/system/cli-version/check` | Check the npm registry for a newer Claude Code now (also done once a day) |
| GET | `/system/release` | Claudio in use, the newest release, how this server was installed (`distribution`), as the last check left it (never asks GitHub) |
| POST | `/system/release/check` | Check GitHub for a newer Claudio release now (also done once a day) |
| POST | `/system/cli-version/install` | Owner only, in the Linux x64 container: install a newer Claude Code (`{ version? }`) from the npm registry's native package, checked against its integrity, into `/data/cli`; answers 202 and `install` follows it |
| DELETE | `/system/cli-version/install` | Owner only: go back to the image's Claude Code (removes `/data/cli/current`) |
| GET | `/system/server-update` | In-app updates of the payload, in the container or under the desktop app (`CLAUDIO_LAUNCHER=desktop`): why they are not offered, the base (`image` or `shell`) and its version, the running version, the desktop shell's facts, a download's state, `needsImage`, `needsShell`, the newest release's `offer` (`installable`, or `blocked` by `no-bundle`, `unverified`, `needs-image`, `needs-shell`, `failed-before`), the launcher's last rollback |
| POST | `/system/server-update/download` | Owner only, or the desktop shell's own credential under `CLAUDIO_LAUNCHER=desktop`: download the newest release's signed server bundle (`{ version? }`), checked before it is unpacked into `<dataDir>/app`; 202, `412 update.needs-image`, `412 update.needs-shell` |
| POST | `/system/server-update/apply` | Owner only, or the desktop shell: restart onto the downloaded bundle (`{ force?, whenIdle? }`); `409 update.live-work` with the live counts (chats, orchestrations, terminals) unless `force` |
| DELETE | `/system/server-update/scheduled` | Owner only, or the desktop shell: call off a restart that waits for idleness |
| POST | `/system/server-update/revert` | Owner only, or the desktop shell: restart onto the base version, the image's or the desktop app's own (`{ force?, whenIdle? }`) |
| GET | `/system/storage` | In a Docker install, whether the Claude config dir, the data dir and the workspace sit on a persistent volume or would be lost when the container is replaced (`persistent`, `anonymous`, `container`, `temporary`); `atRisk` says whether any would |
| GET | `/system/load` | What the machine is doing now (load average, memory, PSI of CPU, memory and I/O) and whether it admits a new chat; read from `/proc`, Linux only |
| GET | `/system/processes` | What each live chat's process tree uses: processes, resident memory (MB) and CPU seconds so far; read from `/proc`, Linux only |
| GET | `/system/history` | The machine's stored readings, oldest first, one a minute for 7 days: `?since=&until=&limit=&bucket=<seconds>` folds a long range into a few hundred points |
| GET | `/overview` | Everything the dashboard needs in one call |

## Account credentials

The account can be configured at runtime instead of (or on top of) the container environment.
The credential is kept in the secret vault (`secrets.json` in the data volume, mode 600, sealed when
there is a key; see [docs/setup.md](setup.md)), handed to every new `claude` process in its
environment and to no other, and never returned by any endpoint.

| Method | Route | Description |
| --- | --- | --- |
| GET | `/auth` | Fresh auth status, including where the credential comes from and `inUse`: the account new work would start on (`id`, `label`, `kind`, `signInState`, `checkedAt`), null when none can take work |
| PUT | `/auth/credentials` | `{ oauthToken }` or `{ apiKey }` (exactly one). `oauthToken` is deprecated: the UI signs in with `POST /accounts/default/login` instead, but a script that sends it keeps working |
| DELETE | `/auth/credentials` | Remove the stored credential; falls back to the container environment |
| POST | `/auth/verify` | Sends a minimal real request (one short message, which counts against the plan) on the account in use and records `checkedAt`. `claude auth status` only reports what is configured, and `get_usage` cannot refuse a credential, so this is the check that proves a login or an OAuth token (an API key is checked for free by `POST /accounts/:id/refresh`) |

## Setup

The first setup, from the app: what is signed in and what is not, and the sign-ins that do the rest
through each tool's own documented surface. A key is write-only and never in argv, a log, an event
or an answer; every write, and reading a sign-in, is refused to a chat's token. See
[docs/setup.md](setup.md).

| Method | Route | Description |
| --- | --- | --- |
| GET | `/setup` | `{ seen, access, providers, hosts, youtrack, tailscale, methods, secrets }`: the auth mode, each enabled agent's readiness and whether a key is kept for it, each code host's CLI and the hosts it is signed in to, YouTrack, the Tailscale behind Remote access (offered, run by Claudio, its readiness and node name), the sign-in methods per tool, and whether the vault is sealed and its key sits beside the data |
| POST | `/setup/seen` | Record that the setup assistant was finished or skipped (`setupSeen` in `app-settings.json`); `409` when the environment sets it off |
| POST | `/setup/logins` | `{ tool, method: 'key' \| 'device', host?, secret?, variable? }`. A key goes on stdin to the CLI's own login (gh, glab), into a 0600 file named in `tailscale up --auth-key=file:` and removed after (Tailscale), or into the vault (Claude Code, YouTrack), and the answer comes once it ended. A device sign-in answers at once; `login.updated` carries the URL and the code (Tailscale's login URL has none), then the end, decided by the tool's readiness probe. Expires after 15 minutes. Tailscale only where Claudio runs its daemon (the image), `409` elsewhere |
| GET | `/setup/logins/:id` | One sign-in: state, URL and code, `error` code, readiness after it ended |
| DELETE | `/setup/logins/:id` | Cancel it; the command's process group is killed |
| DELETE | `/setup/credentials/:tool?host=` | Sign out: `gh`/`glab auth logout --hostname`, `claude auth logout` plus the vault, `tailscale logout` after the tunnel closes, or the vault alone |

## Security

Authentication is off by default (`mode: none`), which is what a local install on loopback wants.
With `token` every route needs `Authorization: Bearer …`; with `oidc` it needs a JWT the issuer's
JWKS validates (`aud` and `exp` are checked). `GET /api/health` stays open, `/docs` does not, and
only the six GETs a browser makes without headers — `/events`, `/chats/:id/stream`,
`/uploads/:id/content`, `/chats/:id/export`, `/projects/:id/export` and `/eval-runs/:runId/export` — also accept the credential
as `?token=`. Only the SHA-256 of a token is stored; the token itself exists once, in the answer
that created it. Lost it? `CLAUDIO_AUTH_TOKEN` with `CLAUDIO_AUTH_TOKEN_RESET=1` replaces it on the
next start, audited with actor `env` (see [Securing it](securing.md)).

| Method | Route | Description |
| --- | --- | --- |
| GET | `/security/auth` | Mode, whether a token is set, the OIDC fields, read-only and `firstRunPending` (the container's first-run token is still unused). Never the token |
| POST | `/security/allowed-hosts/claim` | Adds the host the request was dialled on to the allowlist's file layer (the one Settings edits) and answers `{ host, allowedHosts }`. The one route exempt from the host check. Needs the owner's token: `403 host.needs-auth` under `none`, `403 host.not-owner` for the desktop credential or a chat's token, `400 host.invalid`, `405` in read-only mode, `401` (counted by the back-off) otherwise |
| PUT | `/security/auth` | `{ mode?, oidc?, readOnly? }`. A mode that would lock everyone out is refused; stays reachable in read-only mode, because it is the switch |
| POST | `/security/token` | Set or rotate the bearer token — `{ token? }`, generated when omitted. Returned once |
| DELETE | `/security/token` | Remove it; refused while the mode is `token` |
| GET | `/settings/guards` | Guard settings (`mode`, `automated`, `rules`, `protectConfigs`, `extraRoots`), whether the guard can run here and why not, and the rule list. A chat's token may read it |
| PUT | `/settings/guards` | Only the keys that change; `rules` merges over the stored ones. `integrity` cannot be switched. Applies to the next process spawned. `400` for an unknown key, a non-boolean, a bad mode, more than 200 globs, an absolute glob or one with `..`, or an `extraRoots` entry that is not an existing absolute directory (not `/`, the home folder or the data dir). `403` for a chat's token |
| GET | `/guard-events?chatId=&orchestrationId=&flowRunId=&projectId=&rule=&outcome=&before=&limit=` | What the guards did, newest first, with `next` as the `before` cursor of the following page. `limit` is 1–200 (default 50). A chat's token reads only its own `chatId`, else `403` |
| POST | `/guards/check` | `{ tool, input, rules?, roots? }` → `{ verdict, rule?, matcher?, reason? }` through the decision engine, nothing run or recorded. `403` for a chat's token |
| GET | `/audit?limit=&from=&path=&method=&status=` | Mutating requests, newest first: when, actor (token id, OIDC subject, `local`, or `env` for a token reset from the environment), method, path, status and a one-line summary from the route. `path` matches anywhere and literally, `method` exactly, `status` a code (`404`) or a class (`4xx`). `limit` and `from` must be non-negative integers, or the answer is a `400` saying so. Bodies are never recorded |

## Remote access

| Method | Route | Description |
| --- | --- | --- |
| GET | `/tunnel` | `{ state, url, since, reason, checking, enabled, managed, tailscale, port, settings }`: `url` and `since` only while `active`, `reason` (with a `code`) only while `failed`, or `active` with `tunnel.tailscaleNotAnswering` after ten minutes without an answer from the CLI, `checking` true while the last readings got no answer (the tunnel stays `active`), `enabled` false where the deploy does not offer the tunnel (`CLAUDIO_TUNNEL`), `managed` true where Claudio runs the `tailscaled` itself (the image) and signs it in from the setup, `tailscale` whether the CLI is installed, signed in, connected and has HTTPS on (`state`, `version`, `host`, `reason`), read again from the CLI at most every two seconds |
| PUT | `/tunnel/settings` | `{ startWithClaudio }`, off by default. Emits `tunnel.changed` |
| POST | `/tunnel/start` | Adds Claudio's `tailscale serve` rule on `port`; `409` while the auth mode is `none` or where `enabled` is false, `failed` with the reason when Tailscale is not ready or the port serves something else. The address shows, and the node's exact name joins the allowlist, once the rule reads back from the Serve config |
| POST | `/tunnel/stop` | Takes the name off the allowlist and removes only Claudio's Serve rule; turning the auth mode to `none` does it first |

## Usage limits and waiting

At a usage limit Claudio first moves the work to another Claude account with quota left (see
[Accounts](#accounts) and [accounts.md](accounts.md)), and waits for the reset only when no account
has any; it never sends the work to another vendor.

- **A person's chat** at a limit with no account to move to, or with `rotateOnLimit` off, raises a
  banner (`limit-hit`); a click on wait calls `POST /chats/:id/wait`.
- **Automated work** (flow runs, orchestration tasks, the assistant) waits on its own.
- **A wait** is a row, so two processes on one data directory replay a turn once and a restart picks
  it up again; with no reset time known it ends at `maxWaitHours`.

| Method | Route | Description |
| --- | --- | --- |
| GET | `/limits/waits?chatId=&projectId=&state=&limit=` | Waits, newest first; `waiting` and `resuming` rows are the open waits |
| POST | `/limits/waits/:id/cancel` | Stop waiting: a flow run or task then ends `stopped`. `409` when the wait is over. Not open to a chat's token |
| POST | `/limits/waits/:id/run-now` | Run now: the wait closes `resumed` and its turn goes on at once in the same chat, on an account a newer reading gives room (or, failing that, one the turn failed on whose reading does not say it is out) → `{ move, account }`. `404` unknown wait; `409` with `code` `wait-over`, `not-owned` or `no-room`. Not open to a chat's token |

## Projects

| Method | Route | Description |
| --- | --- | --- |
| GET | `/projects` | The projects you imported, each with its repository, its worktrees (the main checkout first, each with who made it; `createdBy` now carries a `kind`), `removedWorktrees`, `insideWorktreeOf` and the number of chats under it |
| GET | `/projects/candidates` | Directories chats have run in that are not projects yet, the busiest first: what a first start offers to import |
| GET | `/projects/templates` | The five built-in project templates: the modules each switches on, its board's work item types and column limits, and the team it offers |
| GET | `/projects/inspect` | `?path=` — what a path is before it is imported: whether it exists, its git repository, the path Import would record, the conflict that would refuse it (`linked-worktree`, `already-a-project`), another clone of the same remote that is a project, and how many worktrees its repository has. 400 without `path` |
| POST | `/projects/import` | `{ path, name?, template?, modules? }` — import a directory; every chat under it is adopted, retroactively. A path inside a linked worktree is refused (400 `linked-worktree`, `detail` is the main checkout plus subdir), and so is a repository and subdir that already is a project (409 `already-a-project`, `detail` is its id). Without a template or modules every module is off; a directory that was a project before gets its settings back. Emits `project.created` |
| POST | `/projects` | `{ name, gitUrl?, template?, modules? }` — create an empty project in the workspace or clone a repository into it, and import it. Emits `project.created` |
| PATCH | `/projects/:id` | `{ name?, key?, modules?, path? }` — rename a project, change its work item key prefix or the modules that are on, or re-point it inside its own repository (`path`, a directory of the same repository's main checkout; 400 `not-a-repository`, `not-a-directory`, `linked-worktree`, `other-repository`, 409 `already-a-project`; the id stays and `project.updated` lists `path`). Switching a module off hides it and keeps its data |
| GET | `/projects/:id/review-roles` | The review gate's reviewers for the project: file, `source` (`builtin` or `project`), `sha`, size and `problem`; `404` for an unknown project |
| POST | `/projects/:id/review-roles/:role` | Write Claudio's default role file where none exists → `ReviewRoleInfo` (`201`); `409` `role-exists`, `404`. `403` to a chat token |
| GET | `/projects/:id/settings` | The project's settings document (modules, template, key prefix, board). Created on first read with every module off |
| PUT | `/projects/:id/settings` | Replace the settings document whole, validated. Emits `project.updated` |
| GET | `/projects/:id/export?format=markdown\|json` | Download every chat of the project, streamed. `markdown` (default): a header with the dates, models and the cost the CLI reported, then each chat, oldest first, as `/chats/:id/export` renders it. `json`: a `ProjectExport` |
| DELETE | `/projects/:id` | Remove a project from Claudio. Harmless: nothing on disk changes, and its settings and work items are kept for when it is imported again. Emits `project.removed` |
| DELETE | `/projects/:id/state` | Purge everything Claude Code keeps about a project (`claude project purge`). Irreversible, and separate from removing the project |

## Team

A project's team (Team module). Each member is a Claude Code agent file in the project's
`.claude/agents/`, so it also works from a terminal, plus the role, model, responsibility and write
paths Claudio keeps in the project's settings. Claudio writes a starting agent file only where there
is none, and never overwrites one a person wrote or edited: that member is reported as `drifted` (or
`missing` when the file was deleted). Changes need the module on (409 otherwise) and emit
`team.changed`.

| Method | Route | Description |
| --- | --- | --- |
| GET | `/projects/:id/team` | The members, each with its agent file's state, the columns it answers for under the flow and its flow runs, and the agent files no member uses |
| POST | `/projects/:id/team/from-template` | `{ roles? }` — add the template's roles the person accepted, each with its agent file (an existing file is kept); without `roles` only the template's team, and its optional roles (`optionalTeam`) only when named. 201 when it added a member, 200 when nothing changed |
| PUT | `/projects/:id/team/:agent` | `{ role, model, responsibility, writes?, commands?, createFile? }` — create or replace a member's metadata. Two members may not share a role. `commands` bounds the shell of its work runs (`[]` is none, absent is unrestricted). The file itself goes through `/config/resources/agents/:name?project=` |
| DELETE | `/projects/:id/team/:agent` | Take a member off the team; its agent file stays |
| GET | `/projects/:id/flow` | The flow by column's runs going and queued, each with its item, role, stage and chat; `enabled` and the per-project cap `maxParallel` |
| GET | `/projects/:id/flow/runs` | The team's activity: every flow run, newest first, paged (`limit`, `cursor`), filtered by `agent`, `role`, `status` (or `outcome`), `itemId` and `before`; each failed or cancelled run carries its `cause` |
| GET | `/projects/:id/flow/waiting` | The cards waiting for the flow: not epics nor done, in a column with a responsible member, with no run queued or running (`{ total, columns }`; 0 while the flow is off) |
| POST | `/projects/:id/flow/start-waiting` | Queue one run per waiting card in board order, as a person (`queuedBy: "person"`); answers `{ queued, startingNow, waiting }`, 409 while the flow is off |
| GET | `/work-items/:itemId/runs` | Every flow run of a work item, newest first, whatever its state |
| POST | `/work-items/:itemId/spend-pass` | Let a card whose flow run the daily spend cap holds start today: records the pass for the server's local day and answers `{ itemId, day }`. Refused to a chat's token with `403` |
| POST | `/flow-runs/:runId/retry` | Queue a failed run's step again while its item is still in the run's column (409 otherwise); counts as a person's move |

## Assistant

The project assistant. A run is a read-only Claude Code chat in the project's directory (`Read`,
`Grep`, `Glob`, and `Bash` only for `git log`, `git status` and `ls`, in `dontAsk`) that answers
through `--json-schema`. It proposes a team, resources and work items, and writes nothing: each
proposal is accepted or discarded on its own, and only an accept writes, through the team, the
resources or the board. One run at a time per project and kind (409 otherwise). Runs emit
`assistant.run`, decisions `assistant.proposal`.

| Method | Route | Description |
| --- | --- | --- |
| POST | `/projects/:id/assistant/runs` | `{ kind, model?, description?, resourceKind?, supersede? }` — start a `project`, `work-items` or `resources` run (`sonnet` by default). A project with nothing to read and no description starts no chat and is offered its template's team |
| GET | `/projects/:id/assistant/runs` | `?kind=` — the runs, latest first, with what each read, found and proposed |
| GET | `/assistant/runs/:runId` | A run with every proposal it made |
| POST | `/assistant/runs/:runId/stop` | Stop a running run; it proposes nothing |
| POST | `/assistant/proposals/:proposalId/accept` | `{ member?, resource?, workItem? }` — write the proposal with the person's edits: a member through the team, a resource saved at its scope, a work item created in Backlog with its reason as first comment |
| POST | `/assistant/chats` | `{ prompt, projectId?, model?, effort? }` — start a chat with the Claudio assistant (`sonnet` by default, at the effort recommended for an assistant unless one is given), answering what `POST /chats` answers: 201 with the chat; 400 for an empty prompt, 404 for an unknown project. The chat reads Claudio only through its own MCP server (`claudio`), has no built-in tool, no settings file and no uploads directory, and keeps that confinement when resumed, forked or picked up after a restart. The project is context, not a requirement; the answer language is read from `Accept-Language` |
| POST | `/assistant/proposals/:proposalId/discard` | Discard a pending proposal; nothing is written |
| POST | `/assistant/proposals/:proposalId/restore` | Restore a discarded proposal |

## Work items

A project's board. Changing anything needs the project imported and its **Board** module on (409
otherwise); what a project holds stays readable with the module off, so nothing looks lost. The
server writes each item's history, one entry per field that changed, and every change reaches the
event feed. Filters take comma-separated lists: `status`, `type`, `priority`, `labels`, `assignee`
(`person`, `none`, `role:<role>`), `epicId`, `milestoneId` and `q` (title, description and key).

| Method | Route | Description |
| --- | --- | --- |
| GET | `/projects/:id/work-items?status=&type=&…` | The project's work items in board order, filtered, descriptions left out (`hasDescription`) |
| GET | `/projects/:id/work-items/page?…&limit=&cursor=` | The same list a page at a time (100 by default, 500 at most): `{ items, total, nextCursor }` |
| POST | `/projects/:id/work-items` | `{ title, type?, description?, status?, priority?, labels?, assignee?, epicId?, milestoneId?, acceptanceCriteria? }` — create one; it takes the next number of the project, never reused. Emits `workitem.created` |
| GET | `/projects/:id/work-items/board?…&doneLimit=` | The five columns, each with its limit, its real count, whether it is over the limit, and the items that pass the filter in rank order, descriptions left out. Done holds its newest `doneLimit` items (20 by default) and `more` counts the rest |
| POST | `/projects/:id/work-items/triage` | `{ title, description? }` — what `board.triage` would prefill for a draft: `{ triage: { type, priority, duplicate, decisionId } \| null }`, null unless the point is active and answered in time. Creates nothing |
| POST | `/projects/:id/work-items/orchestrate` | `{ itemIds }` — a draft orchestration to review, not launched: one node per item, `dependsOn` from `blocks` inside the selection, and the blockers left outside it. `POST /orchestrations` launches it |
| GET | `/projects/:id/milestones` | The project's milestones, each with its progress derived from its items |
| POST | `/projects/:id/milestones` | `{ name, description? }` — create a milestone, open, with no date. Emits `milestone.changed` |
| GET | `/work-items?…` | Every work item of the imported projects with the Board module on: the All projects view, descriptions left out |
| GET | `/work-items/page?…&limit=&cursor=` | The All projects list a page at a time: `{ items, total, nextCursor }` |
| GET | `/work-items/board?…&doneLimit=` | The All projects board, with no column limits; Done paged as on a project's board |
| GET | `/work-items/by-key/:key` | The item a key names (`AGN-12`, any case), as `/work-items/:itemId` answers it; 404 when none has it |
| GET | `/work-items/:itemId` | One item with its children, links, comments and history |
| PATCH | `/work-items/:itemId` | Change any field but the status; `acceptanceCriteria` replaces the checklist, keeping the check of entries sent with their `id`. Emits `workitem.updated` |
| DELETE | `/work-items/:itemId` | Delete an item for good; its number is not reused. Emits `workitem.removed` |
| POST | `/work-items/:itemId/move` | `{ status, afterId? }` — move to a column, right after `afterId` (`null` first, absent last). Over the column's limit is allowed and reported. Emits `workitem.moved` |
| PATCH | `/work-items/:itemId/criteria/:criterionId` | `{ checked }` — check or uncheck one acceptance criterion |
| GET | `/work-items/:itemId/comments` | The item's comments, oldest first |
| POST | `/work-items/:itemId/comments` | `{ body }` — comment as the person |
| POST | `/work-items/:itemId/relations` | `{ type: blocks\|blocked_by, itemId }` — relate two items of the project; the item itself (400) and a cycle of `blocks` (409) are refused |
| DELETE | `/work-items/:itemId/relations/:otherId` | Remove the relation between two items |
| GET | `/work-items/:itemId/links` | The chats, orchestration tasks and documents tied to the item, with their state |
| POST | `/work-items/:itemId/links` | `{ kind, role, chatId?, orchestrationId?, taskId?, documentPath? }` — tie a chat, an orchestration task or a document of the documents folder to the item |
| DELETE | `/work-items/:itemId/links/:linkId` | Untie it; the chat, orchestration or file is not touched |
| GET | `/work-items/:itemId/history` | Every change to the item, oldest first, with who made it and why |
| POST | `/work-items/:itemId/work` | "Work on it": a chat prompted with the item, in its own worktree on `claudio-task/<key>` (made again if it was deleted by hand), with the options a new chat takes, each checked for its type (400). The item enters `in_progress` when a turn starts and `in_review` when one ends well. An epic is refused (400), and so are an item in `done`, one already being worked on and a plain directory where its worktree goes (409) |
| POST | `/work-items/:itemId/pull-request` | The person's approval: Claudio commits what is left, merges `origin/<default>` into `claudio-task/<key>`, pushes it and opens the pull or merge request with the project's host CLI (202; 200 with it already open). A conflict pushes nothing and sends the item back to `in_progress` for the Developer. 400 for an epic; 409 with a `code` when the item is not in review, is being worked on, has nothing to propose, or the project cannot open them (`reason` names why, with the host and a remedy) |
| POST | `/work-items/:itemId/pull-request/refresh` | Ask the host for the item's open PR or MR now: its CI state, a merge (the item moves to Done) or a close |
| GET | `/work-items/:itemId/changes` | What the item's branch changed: commits, files and what is not committed yet. The branch is the last chat's or orchestration node's that worked on the item. `?commit=`/`?uncommitted=1` scope it as `/chats/:id/changes` does |
| GET | `/work-items/:itemId/changes/diff?path=` | One file's diff on the item's branch, with `?context=`, `?commit=` and `?uncommitted=1` as `/chats/:id/changes/diff` takes them |
| POST | `/chats/:id/work-items` | `{ text, title?, type?, priority? }` — create a task in `backlog` from a chat's message, linked to the chat |
| GET | `/chats/:id/work-items` | The work items a chat works on or was the origin of, descriptions left out |
| GET | `/milestones/:milestoneId` | One milestone with its progress |
| PATCH | `/milestones/:milestoneId` | `{ name?, description?, state? }` — edit, close or reopen a milestone |
| DELETE | `/milestones/:milestoneId` | Delete a milestone; its items stay, without it |

## Documents

A project's documents folder, `documents.path` in its settings (`docs` by default): its Markdown
files, and the work items each is tied to. A `path` is relative to the project and `/`-separated,
and is refused (400) when it is absolute, climbs with `..`, has a hidden part, is not Markdown, or
lies outside the folder, symbolic links included. Changing anything needs the **Documents** module
on (409 otherwise); reading does not.

| Method | Route | Description |
| --- | --- | --- |
| GET | `/projects/:id/documents` | The folder's tree, directories first, each file with its title, size, time and ties |
| GET | `/projects/:id/documents/file?path=` | One file's content and ties |
| PUT | `/projects/:id/documents/file?path=` | `{ content, baseUpdatedAt? }` — create or replace a file; a file changed since `baseUpdatedAt` is refused (409). Emits `document.changed` |
| DELETE | `/projects/:id/documents/file?path=` | Delete a file and untie it from every item. Emits `document.changed` |
| POST | `/work-items/:itemId/documents` | `{ path, kind? }` — tie a file on disk to the item, role `reference`: the shorthand of `POST /work-items/:itemId/links` with `kind: document`. Emits `document.changed` and `workitem.updated` |

## Events

One Server-Sent Events stream for the whole app, so a client never has to poll.

| Method | Route | Description |
| --- | --- | --- |
| GET | `/events?since=ID` | Every change as an `ClaudioEvent` (`id:`, `event: <type>`, `data: <json>`): runs created, updated, ended and removed; prompts waiting for a person (`run.waiting`, `permission.requested`/`resolved`); rate limits and account rotation; background tasks, subagents and workflows starting and ending; orchestration, task and merge-conflict changes (`orchestration.updated` also carries `verificationStatus` while the checks run); `changes.updated` when a running task's or the integration branch's commits or uncommitted files move; `chat.activity` when what a chat's live execution is doing changes (a tool call, a block being written or thought, a prompt blocking it), at most once per chat per second; `subagent.activity` when what a running subagent is doing changes (its open tool call, or `null` once it has none), at most once per subagent per second; `health.changed` when a chat's health changes; `supervisor.proposed` when the supervisor answers one with a hint; `schedule.changed` (created, updated, enabled, disabled, deleted, rescheduled) and `schedule.fired` (every run row written or moved); `workitem.created`, `workitem.updated` (naming the fields that changed), `workitem.moved` (with the previous column and whether the new one is over its limit) and `workitem.removed`; `milestone.changed` (created, updated, closed, reopened, deleted); `team.changed` (created, updated, removed, template); `flow.run` (queued, started, ended, with its outcome); `journal.changed` (added, removed); `memory.proposal` (created, approved, rejected); `document.changed` (written, removed, tied, untied); `assistant.run` (started, read, ended, failed) and `assistant.proposal` (accepted, discarded, restored); `project.created` and `project.removed` (a project imported, created or removed); `project.updated` (name, key, modules or settings); `sessions.changed`; `login.updated` when a sign-in of the setup starts, shows its device code or ends (the URL and the code only, never the key or the CLI's output); `system.release` once per newer Claudio release a check finds (not a notification); `collaborators.changed` (settings, roster, links or sharing), `collaborators.peer` (a teammate's install online or offline, and its path), `collaborators.synced` (a kind of a shared project copied from its owner) `collaborators.join-request` (on the owner's install, a join waiting for an answer, which also notifies the owner) `collaborators.join-answered` (that join accepted, denied or dropped, which clears the notification) and `collaborators.join-ended` (on the joiner's install, its join denied by the owner or its invite expired before an answer). Opens with `stream.hello`, which carries the server's `version`; honours `Last-Event-ID` against a bounded in-memory buffer and sends `stream.resync` when that id is gone (refetch everything). A `: ping` comment every 15 s |

```bash
curl -N localhost:8797/api/events
```

## Providers

The agents Claudio can drive, as detection finds them on this machine: one cache with one 5-minute TTL, refreshed by watchers and on demand, with `providers.changed` on the event stream when a status differs. A chat's token gets `403` on the settings write and the refresh.

| Method | Route | Description |
| --- | --- | --- |
| GET | `/providers` | Every provider's status (state, reason, version, binary, config home, account, capabilities, the permission modes its driver honours, and what its handshake or first session confirmed), from the cache |
| GET | `/providers/:id` | One status; `404` for an unknown id |
| GET | `/providers/:id/models` | The provider's model catalog, with tiers, as its last handshake listed it (kept in `provider-catalogs.json`); `404` for a provider with no driver |
| POST | `/providers/refresh` | Detect again now. Not open to a chat's token |
| GET | `/providers/settings` | The document from `providers.json`: enabled and binary override per provider, order, default |
| PUT | `/providers/settings` | Replace it, validated; providers are detected again in the background. Not open to a chat's token |

The routes for what a provider does at its usage limit are under [Usage limits and waiting](#usage-limits-and-waiting). Each status carries its `limit` (state, binding window, use, reset and how old the reading is), and `GET /overview` all of them as `limits`.

## Accounts

The Claude accounts of this machine, one config dir (`CLAUDE_CONFIG_DIR`) each, chosen per process: who they are, the usage each reported (the CLI's own `get_usage` answer on Refresh, the run's stream while a chat runs, or the CLI's cache for an account never refreshed and idle; the newest reading wins, stamped with its age), the sign-in of a `login` account and the settings and policies that decide when work moves to another account. A `token` or `api-key` account's secret is kept in a 0600 file of its dir and is in no response, log or event. Every write, and reading a sign-in, is refused to a chat's token with `403`.

| Method | Route | Description |
| --- | --- | --- |
| GET | `/accounts` | The CLI's own login (`default`, left out while it has no credential at all: no credentials file and no key or token in the environment, unless it expired) and the accounts added here: identity, `enabled`, `signedIn` and the last usage reading (windows, `limits.cli`: plan, per-model limits, credits) |
| POST | `/accounts` | Add a `login` account and start `claude auth login` in its dir; `201` with the sign-in (`url` for the person to open). `{ alias?, email? }` |
| POST | `/accounts/refresh` | Read the real usage of every enabled account from the CLI (`get_usage`, no tokens), one at a time with a 30 s timeout each: `{ accounts, failed }`; a failing account keeps its last reading and is named in `failed` |
| POST | `/accounts/:id/refresh` | The same for one account; answers the account; `404` for an unknown one, `502 accounts.check-failed` when the CLI could not answer. A `get_usage` that comes back with the plan's limits confirms the credential and records `checkedAt`. For an API key (an `api-key` account, or the default one with `ANTHROPIC_API_KEY`) it also asks Anthropic with the SDK's free `models.list`: a `401` answers the account as `expired` |
| POST | `/accounts/:id/login` | Sign an existing `login` account in again (expired or incomplete sign-in): `claude auth login` in its dir (`default` is the CLI's own config dir, and a successful sign-in there drops a token Claudio kept); `201` with the sign-in, followed like `POST /accounts`'s, which ends `expired` when nobody finishes it in 15 minutes. The account is kept whatever the outcome; `400` for a token or api-key account |
| POST | `/accounts/token` | Add a `token` or `api-key` account (`kind: 'token'` is deprecated, kept for scripts): `{ kind, alias, secret }`; the secret is write-only. `201` with the account |
| GET | `/accounts/logins/:id` | One sign-in's state (`starting`, `waiting-for-person`, `succeeded`, `failed`, `expired`, `cancelled`); `404` for an unknown one |
| POST | `/accounts/logins/:id/code` | Hand the CLI the code the page showed, when its browser could not open: `{ code }`; `409` when the sign-in is over |
| DELETE | `/accounts/logins/:id` | Cancel a sign-in; an account that never signed in is removed |
| PATCH | `/accounts/:id` | `{ alias?, enabled? }`; a disabled account is never chosen for new work |
| DELETE | `/accounts/:id` | Remove an account and its dir; `400` for `default` |
| GET | `/accounts/settings` | `rotateOnLimit`, `threshold`, `hysteresis`, `cooldownSeconds` and `strategy` from `accounts.json` |
| PUT | `/accounts/settings` | Change them, validated |
| GET | `/accounts/:id/models` | The models an account can run, from the CLI's `initialize` (no tokens), cached per account; `?refresh=true` reads it again; `404` for an unknown account |
| GET | `/accounts/model-fallbacks` | The accepted `{ from, to, origin, at }` model fallbacks from `model-fallbacks.json` |
| PUT | `/accounts/model-fallbacks` | Replace the list: `{ fallbacks: [{ from, to, origin? }] }`, validated |
| POST | `/accounts/model-fallbacks/suggest` | `{ model }` — the `account.model-fallback` point: `{ candidates, suggestion, confidence, decisionId }`; `suggestion` is null when the point is off or unsure. Saves nothing |
| GET | `/accounts/policies` | Per-project rotation policies: the accounts allowed, their order and a threshold |
| POST | `/accounts/policies` | Create one: `{ projects, order?, threshold?, looseChats? }`; `201` |
| PUT | `/accounts/policies/:id` | Replace one; `404` for an unknown policy |
| DELETE | `/accounts/policies/:id` | Delete one |
| GET | `/accounts/usage-history` | The `usage_history` rows, oldest first: `?account=&window=five_hour\|seven_day&since=&until=&limit=` |
| GET | `/accounts/events` | The `rotation_events` rows, oldest first (each switch or wait): `?limit=&since=` |

## Code hosts

The hosts Claudio opens pull and merge requests on, GitHub through `gh` and GitLab through `glab`, as detection finds them on this machine: one cache with one 5-minute TTL, refreshed by watchers and on demand, with `hosts.changed` on the event stream when a status differs. A chat's token gets `403` on the settings write and the refresh.

| Method | Route | Description |
| --- | --- | --- |
| GET | `/hosts` | Every code host's status (state, reason, version, binary, the host names its CLI knows), from the cache |
| GET | `/hosts/:id` | One status (`github` or `gitlab`); `404` for another id |
| POST | `/hosts/refresh` | Detect again now. Not open to a chat's token |
| GET | `/hosts/settings` | The document from `hosts.json`: enabled and binary override per host |
| PUT | `/hosts/settings` | Replace it, validated; hosts are detected again in the background and every project's readiness is read again. Not open to a chat's token |
| GET | `/trackers` | Every issue tracker's status: GitHub and GitLab Issues follow their code host; YouTrack runs `youtrack-app` with the address and token Claudio keeps |
| GET | `/trackers/:id` | One status; `404` for another id |
| POST | `/trackers/refresh` | Detect again now. Not open to a chat's token |
| GET | `/trackers/settings` | The document from `trackers.json`: enabled and binary override per tracker |
| PUT | `/trackers/settings` | Replace it, validated; trackers are detected again in the background. Not open to a chat's token |
| GET | `/trackers/youtrack/credentials` | The YouTrack address, whether a token is saved and whether it is encrypted; never the token. Not open to a chat's token |
| PUT | `/trackers/youtrack/credentials` | `{ host, token? }` — save the address and a permanent token (in the secret vault, 0600, sealed when there is a key); YouTrack is detected again before the answer. Not open to a chat's token |
| DELETE | `/trackers/youtrack/credentials` | Forget them. Not open to a chat's token |
| GET | `/projects/:id/tracker` | The project's tracker (`id`, `scope`, `query`, `statusMap`), or null |
| PUT | `/projects/:id/tracker` | Replace the tracker, validated, leaving the rest of the settings; a null body clears it. Not open to a chat's token |
| GET | `/projects/:id/tracker/issues` | `?query=&page=` — a page of the tracker's own query, each issue marked with the item it was imported as |
| POST | `/projects/:id/tracker/import` | `{ keys }` — one work item per issue, its body a quoted source block; `{ imported, skipped }`. Needs the Board module. Not open to a chat's token |
| POST | `/work-items/:itemId/issues` | `{ key }` — link an issue of the project's tracker to the item. Not open to a chat's token |
| DELETE | `/work-items/:itemId/issues/:key` | Unlink it (`?tracker=` and `?scope=` when a key is linked under two trackers or two repositories). Not open to a chat's token |
| POST | `/work-items/:itemId/issues/:key/sync` | One more write to the tracker for the item's column, never retried; the result is on the issue's `syncState`. Not open to a chat's token |
| GET | `/change-requests/:id` | One change request by the row id of a work item's or an orchestration's: kind, owner, host, `ref`, phase, CI rollup and the fix state |
| GET | `/change-requests/:id/checks` | The checks of the head commit (state, allowed failure, required, rerunnable, has a log), cached 30 s; `?refresh=1` reads the host now; `limitedUntil` while rate-limited |
| GET | `/change-requests/:id/checks/:checkId/log` | The tail of one check's log, cleaned and redacted, with its annotations; `noOutputYet` for a job that has printed nothing; `409 log-unavailable` for a check with no log |
| POST | `/change-requests/:id/checks/rerun` | Run the failed jobs, one job or everything again (`{ scope: 'failed' \| 'check' \| 'all', checkId? }`), then read the list again. Not open to a chat's token |
| POST | `/change-requests/:id/checks/cancel` | Cancel what is running, then read the list again. Not open to a chat's token |
| POST | `/change-requests/:id/checks/:checkId/run` | Play a GitLab manual job, then read the list again. Not open to a chat's token |
| POST | `/change-requests/:id/checks/fix` | Fix the failing checks: the item's Developer (or a chat in an orchestration's integration worktree) gets each failure's log tail → `{ started, prompt, worktree, pullRequest }`; `409` with a `code` when nothing can be fixed now. Not open to a chat's token |
| POST | `/change-requests/:id/push-fix` | Push a finished fix that waits for the person (a plain push, never forced); a failure keeps it waiting for a retry. Not open to a chat's token |
| GET | `/change-requests/:id/threads` | Review threads of the head commit with their comments, cached 30 s (`?refresh=1` reads the host now); outdated and resolved ones are marked |
| GET | `/change-requests/:id/review-drafts` | The person's draft review: notes on lines or general, kept as rows |
| POST | `/change-requests/:id/review-drafts` | Add a note (`path`, `side`, `line`, `startLine`, `body`, `suggestion`) → `201`. Not open to a chat's token |
| PUT | `/change-requests/:id/review-drafts/:draftId` | Change a note. Not open to a chat's token |
| DELETE | `/change-requests/:id/review-drafts/:draftId` | Delete a note. Not open to a chat's token |
| GET | `/change-requests/:id/review-posts` | The attempts to post a review, newest first, and what a partly posted one still has saved on the host, so a stopped review is known after a reload |
| POST | `/change-requests/:id/reviews` | Post the drafts as one review (`{ event: 'comment' \| 'approve', body, headSha? }`; approve is GitLab only; `headSha` is the head the person looked at, refused with `head-moved` when it moved); `409` with a `code`, and a `postId` for `review-partly-posted`. Not open to a chat's token |
| POST | `/change-requests/:id/reviews/:postId/publish-saved` | GitLab: publish the notes a partly posted review saved. Not open to a chat's token |
| POST | `/change-requests/:id/reviews/:postId/discard-saved` | GitLab: discard them (only the notes Claudio saved). Not open to a chat's token |
| POST | `/change-requests/:id/threads/:threadId/reply` | Reply to a thread (`{ body }`) → the thread as the host has it. Not open to a chat's token |
| POST | `/change-requests/:id/threads/:threadId/resolve` | Resolve a thread (idempotent). Not open to a chat's token |
| POST | `/change-requests/:id/threads/:threadId/unresolve` | Reopen a thread (idempotent). Not open to a chat's token |
| GET | `/change-requests/:id/approval` | Whether the viewer approved, approvals left, who approved; `canApprove` and `canRevoke` are GitLab only |
| POST | `/change-requests/:id/approval` | GitLab: approve on the head you looked at (`{ sha }`); `409 head-moved` if it moved. Not open to a chat's token |
| DELETE | `/change-requests/:id/approval` | GitLab: revoke the approval. Not open to a chat's token |
| GET | `/change-requests/:id/reviewers` | The requested reviewers, the review decision and the unresolved count |
| POST | `/change-requests/:id/reviewers` | Request reviewers (`{ add, remove? }`), then read back what the host says. Not open to a chat's token |
| POST | `/change-requests/:id/address` | Address review threads with an agent (`{ threadIds }`, all unresolved when empty) on the fix path of the checks; nothing is replied or resolved by Claudio → `{ started, prompt, worktree, pullRequest }`. Not open to a chat's token |
| GET | `/change-requests/:id/merge` | The merge state: allowed methods and the default, the branch box's default, `canMerge`, the first blocker and the others (code, the host's words, one action), the auto-merge state, `waitingForPipeline`, `autoMergeOff` (Claudio turned auto-merge off for a push or an update, until it is armed again), `canRebaseOnHost` with `rebaseOnHostWhy` and `headSha`; `?refresh=1` reads the host now |
| POST | `/change-requests/:id/merge` | Merge (`{ method, expectedHead, deleteBranch, subject?, body? }`) on the head the person saw → `{ state, merged, branchDeleted }`; `409 head-moved` merges nothing. The person's click: not open to a chat's token |
| POST | `/change-requests/:id/auto-merge` | Arm the host's auto-merge (`{ method, expectedHead }`) → the merge state. Not open to a chat's token |
| DELETE | `/change-requests/:id/auto-merge` | Turn auto-merge off, confirmed by a re-read → the merge state. Not open to a chat's token |
| POST | `/change-requests/:id/update-branch` | Update the branch from its base (Claudio's merge, or the host's rebase on a GitLab `ff` project) → `{ state, conflicts, via }`; the host's rebase is offered only for a clean checkout with nothing unpushed, and a rebase that conflicts falls back to Claudio's merge; `409 conflicts` names the paths and pushes nothing; `409 busy` while a chat or a run works in the checkout. Not open to a chat's token |
| POST | `/change-requests/:id/ready` | Mark ready for review or back to a draft (`{ ready }`) → the merge state. Not open to a chat's token |
| GET | `/projects/:id/code-host` | Whether the project can open pull and merge requests (the readiness, with its reason and remedy) and its parsed `origin`; `404` for an unknown project |

## Webhooks

Where GitHub and GitLab deliver for a hook Claudio registered (tag `Webhooks`). Unauthenticated by design and signature-checked: GitHub's `X-Hub-Signature-256`, or GitLab's `X-Gitlab-Token` plus its `webhook-signature` when it carries one, is verified over the raw body, in constant time, before anything is parsed. A delivery never changes a change request; it only moves the next read of the ones it names to now.

| Method | Route | Description |
| --- | --- | --- |
| POST | `/webhooks/github/:registrationId` | A GitHub delivery. `204` at once (a replayed delivery id or signed body too); `401` with no detail for an unknown registration or a bad signature; `429` past 60 verified deliveries a minute; `413` over 5 MiB |
| POST | `/webhooks/gitlab/:registrationId` | A GitLab delivery, checked by `X-Gitlab-Token` and, when present, `webhook-signature`; answers as above |
| GET | `/projects/:id/webhooks` | A project's registrations plus `available`, the `reason` when not (`no-public-url`; `no-remote`), the `publicUrl`, the `events` and `canRedeliver` (always `false`). The secret is never returned |
| POST | `/projects/:id/webhooks` | Register the repository's hook, on GitHub or GitLab (adopts an Claudio hook already there, never touches another) → `201` with the registration; `409` `no-public-url`, `no-remote`, `already-registered`; `403 hook-no-permission`; `502 hook-unreachable`. Not open to a chat's token |
| POST | `/projects/:id/webhooks/:registrationId/test` | Ping the hook (GitLab: a push test) and read the host's answer back → the registration; `502` when the host did not report an answered delivery. Not open to a chat's token |
| DELETE | `/projects/:id/webhooks/:registrationId` | Delete the hook on the host and its secret here → the registration, now `removed`. Not open to a chat's token |
| GET | `/projects/:id/docs` | The project's Claude Docs registry: id, link, title, `createdBy`, `status` (`unread`, `ok`, `unavailable`), `checkedAt`. Starts no session |
| POST | `/projects/:id/docs` | `{ url }` or `{ create: { title, body } }` → `201` with the entry; one confined `claude` session with the Docs connector opens or creates it. `409` when the connector is missing or not connected, or the document is already there. Not open to a chat's token |
| POST | `/projects/:id/docs/refresh` | Read every title again; one that no longer resolves is marked `unavailable`, not dropped. Not open to a chat's token |
| DELETE | `/projects/:id/docs/:docId` | Drop the entry (the document on claude.ai is never touched) → `204`. Not open to a chat's token |
| POST | `/projects/:id/docs/:docId/ask` | Open a chat in the project about the document → `201` with the chat. Not open to a chat's token |

## Evals

Instruction-compliance evals (Team module): a committed file in the project's
`.claude/claudio-evals/<name>.json` holds prompts and deterministic expectations about the tool calls,
the final text and the resulting files, and a run measures an agent file, skill, rule or `CLAUDE.md`
in up to three variants (`pinned` at a commit, `current` on disk, `proposed` as sent). Only a
person's click starts a run, and the start must repeat the cost ceiling the estimate showed
(`confirmMaxCostUsd`). A chat's token may read and cancel but is refused (403) on writing, consent,
starting, resuming, re-judging, drafting cases and deleting; Phase 2 answers 409 `evals-phase2-off` until `evalsPhase2` is on in the app settings; read-only mode refuses every write (405). Errors carry `code`.

| Method | Route | Description |
| --- | --- | --- |
| GET | `/projects/:id/evals` | The eval files, each with its parse problems and the newest run of that eval. 404 project; 409 `team-off` |
| GET | `/projects/:id/evals/:name` | One file: definition, problems, SHA and whether this content has the person's consent. 400 name; 404 |
| PUT | `/projects/:id/evals/:name` | `{ definition, ifMatch }` — write the file after a strict parse; `ifMatch` is the SHA that was read (`null` for a new file). 400 with the field paths; 409 `changed-on-disk`; 413 over 256 KiB |
| DELETE | `/projects/:id/evals/:name` | Remove the file and its consent; the run history stays. 404; 409 `eval-running` |
| POST | `/projects/:id/evals/:name/estimate` | `EvalRunRequest` → `EvalEstimate` (samples, ceiling, typical cost, commands to consent to, warnings). Starts nothing. 422 `pin-missing`, `target-missing`, `not-git`, `no-commit`, `lanes-root-contaminated`, `user-scope-proposal` |
| POST | `/projects/:id/evals/:name/consent` | `{ sha }` — record consent for that content. 409 `changed-on-disk` when the SHA is not the file's now |
| POST | `/projects/:id/evals/:name/runs` | `EvalRunRequest` — start a run (201). 409 `eval-running`, `cost-not-confirmed`; 412 `consent-needed`; 422 as in estimate |
| GET | `/projects/:id/eval-head` | The checkout's repository state `{ git, sha, subject, uncommitted }`, for "Pin to HEAD" and the "Not committed" mark. 404 |
| GET | `/projects/:id/eval-runs` | History, newest first: `?eval=&before=&limit=` (≤ 50) → `{ runs, next }`. 404 |
| GET | `/eval-runs/:runId` | A run with its variants, samples and checks (calls left out). 404 |
| GET | `/eval-runs/:runId/samples/:sampleId` | A sample with its calls, checks and final text. 404 |
| GET | `/eval-runs/:runId/compare?base=&other=` | `EvalComparison` of two variants of the run (`current` and `proposed` by default). 400 when a variant is not in the run; 404 |
| POST | `/eval-runs/:runId/cancel` | Cancel a live run; idempotent. 404 |
| POST | `/eval-runs/:runId/resume` | `{ confirmMaxCostUsd }` — re-queue the unscored samples of an `interrupted` or `capped` run under a new ceiling (spent plus what is left). 409 `not-resumable`, `cost-not-confirmed`, `eval-running`; 412 `consent-needed` |
| GET | `/eval-runs/:runId/gate` | Phase 2: the promotion gate of a run with `current` and `proposed` (`EvalGate`: `promotable`, `regressed` or `incomplete`). 404; 409 `evals-phase2-off` |
| POST | `/eval-runs/:runId/rejudge` | Phase 2: judge again the `unjudged` samples from their stored calls, without re-running them → `{ rejudged, unjudged }`. 409 `eval-running`, `evals-phase2-off` |
| POST | `/eval-runs/:runId/accept-judge` | Phase 2: `{ caseId, idx }` — accept a judge that disagreed with its calibration examples → the recomputed `EvalGate`. 400; 404; 409 `evals-phase2-off` |
| POST | `/projects/:id/evals/:name/draft-cases` | Phase 2: start an assistant run (`kind: evals`) that proposes up to five cases; `{ model?, effort? }` → `AssistantRun`. 404; 409 `evals-phase2-off`, `spend-cap` |
| DELETE | `/eval-runs/:runId` | Remove an ended run's rows. 404; 409 while it is live |
| GET | `/eval-runs/:runId/export?format=json\|markdown` | Download the run (`content-disposition: attachment`); accepts `?token=`. 400 format; 404 |

## Decisions

The decision engine: a decision point puts typed questions to a provider (the Claude CLI, or TypeSafe's Jev with its own key) and runs today's behaviour whenever the answer is missing or below its threshold. Every point is off by default. A point sends nothing until the owner consents to it after previewing its state, and consent names the providers it covers. A chat's token gets `403` on the settings, credentials and consent routes. `lesson.mine` gates the lesson miner ([docs/lessons.md](lessons.md)); it ships `off` like every other point.

| Method | Route | Description |
| --- | --- | --- |
| GET | `/decisions/settings` | The global settings from `decisions.json`; the Jev key is never returned, only `keySet` and `keyHint` |
| PUT | `/decisions/settings` | Replace them whole, validated. Consent is kept as it was. Not open to a chat's token |
| PUT | `/decisions/credentials` | `{ key }` — save the Jev key (mode 600); the answer carries the general privacy notice. Not open to a chat's token |
| DELETE | `/decisions/credentials` | Remove the key; points on `jev` fall back to off-behaviour. Not open to a chat's token |
| POST | `/decisions/test` | `{ provider }` — one small fixed question: `{ ok, latencyMs, model, reason }`. Nothing is recorded |
| GET | `/decisions/points` | The catalogue with the settings in force, optionally for `?projectId=` |
| GET | `/decisions/points/:point/preview` | The exact state of the point's last request, or the fields it may carry, built locally and not sent |
| PUT | `/decisions/points/:point/consent` | `{ granted, stateVersion, providers }` — grant or withdraw consent for what was previewed (`409` when the state changed since). Not open to a chat's token |
| GET | `/decisions` | History, newest first, filtered by `point`, `projectId`, `subjectKind`, `subjectId`, `visible`, `provider`, `mode`, `status`, `since`, `until` and paged with `cursor` and `limit` |
| DELETE | `/decisions` | Delete the rows matching the same filter (every row when none) |
| GET | `/decisions/stats` | Per-point metrics plus Jev cost and Claude runs saved, over `?days=` (30) or `?since=` |
| GET | `/decisions/:id` | One decision: state, questions, answers with probabilities, provider and outcome |
| POST | `/decisions/:id/feedback` | `{ feedback: "useful" \| "not_useful" }` — the person's word on it |
| POST | `/decisions/:id/palette-action` | `{ commandId: string \| null }` — what the palette did with a `palette.intent` proposal: the row records `proposed`, `other` or `dismissed`; the first report wins. `404` unknown id, `400` another point's row or a malformed `commandId`. Not open to a chat's token |
| POST | `/decisions/notification-opened` | `{ key }` — the app was opened from the push with that key; sets `openedAt` on the newest `notification.urgency` row: `{ decisionId }`, null when none matches. Not open to a chat's token |
| DELETE | `/decisions/:id` | Delete one row |
| POST | `/decisions/palette` | `{ query, commands: [{ id, title }] }` — the `palette.intent` point: `{ commandId, confidence, decisionId }`, with `commandId` null when the point is off, unavailable or unsure |

## Push

Web Push over VAPID, signed and sent by this server: a chat that stops for a permission prompt reaches a phone whose app is closed. The keypair is made on first use and kept as `push.json` in the data directory (mode 600); the private half never leaves the server, and there is no third-party push account. What is worth a notification is decided by the same function the browser runs on the same event, so the in-page toast and the notification on a lock screen cannot disagree.

| Method | Route | Description |
| --- | --- | --- |
| GET | `/push/key` | The VAPID public key to subscribe with, and whether push is configured at all |
| GET | `/push/subscriptions` | The registered installs. Endpoints are truncated: a full push endpoint URL is a capability to notify that install |
| POST | `/push/subscriptions` | Register or refresh one — body is the browser's `PushSubscription` JSON plus `kinds` (every kind when omitted), a `level` (`all`, `important`, `urgent` or `silent`; `important` when omitted) and a `label` for the list. An endpoint already registered is refreshed, keeping its `createdAt` |
| DELETE | `/push/subscriptions` | Unregister by `endpoint` (what a browser turning the switch off knows) or by `id` (what the list shows) |
| POST | `/push/test` | Send one test notification to an install by `endpoint` or `id`, or to every registered one. An endpoint the push service reports as gone (404/410) is deleted |

## Terminal

The person's own shell, in a project's directory or a chat's worktree. Off until it is turned on, and never for an agent: a chat's token is refused on every route below, reads included, and so is a request from a chat's process. With authentication off it opens only from this machine; from another device it needs the owner's token and, by default, the tunnel. Read-only mode refuses all of it. What is typed and printed is never recorded.

| Method | Route | Description |
| --- | --- | --- |
| GET | `/terminal` | `{ enabled, available, reason, settings, sources, peerCheck, running }`; `reason` is one of `off`, `disabled-by-env`, `pty-missing`, `host-failed`, `needs-auth`, `remote-off`, `needs-tunnel`, `from-agent`. Answers while the feature is off. `405` in read-only mode, `403` to a chat's token |
| PUT | `/terminal/settings` | `{ enabled?, remote?, maxTerminals?, idleMinutes?, scrollbackLines?, replayLines?, shell?, loginShell? }`; turning it off closes every terminal. Emits `terminal.changed` |
| GET | `/terminal/history?limit=&offset=` | Sessions and the attempts that were refused, newest first: who, from where, when and how many bytes, never content |
| GET | `/terminals?project=&chat=` | The open terminals and those that ended in the last hour |
| POST | `/terminals` | `{ projectId, worktree? }`, `{ chatId }` or `{ workspace: true }` (the configured workspace, with no project), optional `cols` and `rows`: ids in, directory out. A chat outside any project opens in its own directory, confined to the workspace. `409 terminal.limit`, `400 terminal.no-project` (the chat's project is gone), `400 terminal.bad-cwd` (outside its project or the workspace). Emits `terminal.changed` |
| GET | `/terminals/:id` | One terminal |
| POST | `/terminals/:id/ticket` | `{ ticket, expiresAt }`: valid 30 seconds, one use, bound to the terminal and the `Origin` that asked |
| GET | `/terminals/:id/socket?ticket=` | The stream, as a WebSocket: binary frames carry the bytes, text frames the JSON control messages (`TerminalClientFrame`, `TerminalServerFrame`). The `Origin` must be the page's own |
| DELETE | `/terminals/:id` | Closes it: SIGHUP, SIGTERM, then SIGKILL after 3 seconds. Emits `terminal.changed` |

## Collaborators

Teammates' Claudios sharing projects read only, peer to peer over iroh ([plan](plans/collaborators.md)). A chat's token is refused on every route below, reads included, so a teammate's transcript never reaches an agent's context unasked. The one exception ([plan](plans/collaborators-agent-access.md)) is the copy reads (the shared list, one shared project, its kinds and transcripts; never a blob): the Claudio assistant's token reads every copy while Collaborators and its `assistantReads` switch are on, and the token of another chat reads only its own project's copies when that project's `agentReads` is on; never a chat in `bypassPermissions`, `auto` or `dontAsk`, and never a copy whose sharer turned `agentsMayRead` off. Such a refusal is 403 with a `collaborators.agent-read.*` code, a chat's read never pulls from the owner (`refresh` is ignored), and every read is a row of `GET /collaborators/agent-reads`. A share key holds `/` and `#`, so a shared project is named in a path by its `shareId` (`sha256(shareKey)`, 32 hex characters). Refusals carry a `code`: `off`, `unavailable` (503), `not-ready`, `not-found` (404), `not-owner` (403), `invalid` and `expired` (400), `refused`, `conflict`, `unreachable` (502); the rest are 409.

| Method | Route | Description |
| --- | --- | --- |
| GET | `/collaborators` | On or off, the settings, this install's endpoint id, the connection (`off`, `starting`, `online`, `no-relay`, `offline`) and `unavailable` with its reason when the module cannot load |
| PUT | `/collaborators` | `{ enabled?, displayName?, label?, relayUrl?, assistantReads? }`; turning it on generates the key once and binds the endpoint. Emits `collaborators.changed` |
| GET | `/collaborators/groups` | The groups, each with its roster head, members and whether it is frozen, and the joins this install sent that wait for an owner |
| POST | `/collaborators/groups` | `{ name }`: this install becomes the owner |
| DELETE | `/collaborators/groups/:id` | Leave: deletes the copies and tells the owner. An owner with members transfers first (409) |
| POST | `/collaborators/groups/:id/invites` | Owner: a one-time invite, valid 7 days, as the text to paste |
| POST | `/collaborators/join` | `{ invite }`: `joined`, or `pending` while a member holds the request for an offline owner |
| DELETE | `/collaborators/join/:groupId` | Stop waiting for a pending join, or dismiss one the owner denied or whose invite expired |
| GET | `/collaborators/groups/:id/join-requests` | Owner: joins relayed while it was offline |
| POST | `/collaborators/groups/:id/join-requests/:from/accept` | Owner: sign the joiner in |
| POST | `/collaborators/groups/:id/join-requests/:from/deny` | Owner: drop the request; the joiner is told, directly or through a member |
| DELETE | `/collaborators/groups/:id/members/:endpointId` | Owner: remove a member; the copies it holds stay with it |
| PUT | `/collaborators/groups/:id/owner` | Owner: `{ endpointId }`, hand the group to another member |
| GET | `/projects/:id/sharing` | The groups the project is shared with, its share key and `shareId`, the remotes to compute it from and `keyInUse` |
| PUT | `/projects/:id/sharing` | `{ groups?, shareKey?, remote?, agentsMayRead?, agentReads? }`; 409 `share-key-in-use` with the other project's `projectId` and `projectName` |
| GET | `/collaborators/shared` | What teammates share with this install, with each project's `shareId`, sync state, matching local projects and link |
| GET | `/collaborators/shared/:owner/:shareId` | One shared project as the list gives it, for the read-only view of a project not cloned here; 404 once it is no longer shared |
| PUT | `/collaborators/shared/:owner/:shareId/link` | `{ projectId }`: show the shared project inside a local one |
| DELETE | `/collaborators/shared/:owner/:shareId/link` | Undo the link |
| GET | `/collaborators/shared/:owner/:shareId/chats?refresh=1` | The copies held (chats); `refresh=1` pulls from the owner first |
| GET | `/collaborators/shared/:owner/:shareId/memory?refresh=1` | The copies held (memory); `refresh=1` pulls from the owner first |
| GET | `/collaborators/shared/:owner/:shareId/journal?refresh=1` | The copies held (the journal); `refresh=1` pulls from the owner first |
| GET | `/collaborators/shared/:owner/:shareId/documents?refresh=1` | The copies held (documents); `refresh=1` pulls from the owner first |
| GET | `/collaborators/shared/:owner/:shareId/work-items?refresh=1` | The copies held (the board); `refresh=1` pulls from the owner first |
| GET | `/collaborators/shared/:owner/:shareId/artifacts?refresh=1` | The copies held (artifacts); `refresh=1` pulls from the owner first |
| GET | `/collaborators/shared/:owner/:shareId/chats/:chatId/transcript?limit=&before=` | A copied transcript, paged as `GET /chats/:id` pages a local one |
| GET | `/collaborators/shared/:owner/:shareId/chats/:chatId/subagents/:agentId?workflow=&limit=&before=` | A copied subagent's (or workflow agent's) transcript, pulled with its chat's |
| GET | `/collaborators/agent-reads?owner=&shareId=&chatId=&since=&limit=` | What agents read of teammates' copies, newest first: chat, tool, copy, kind and record ids |
| GET | `/collaborators/shared/:owner/:shareId/blobs/:sha256` | A document's or an upload's content, fetched from the owner on first open; a hash no copied record names is 404 |

## Chats

A chat is one Claude Code conversation, and its id is the session id: however many times it is
resumed, and whoever started it, it is one chat. Each time Claudio has a `claude -p` process working
on it, that is an **execution** of the chat, with its own outcome, cost and turns. `state` says what
is happening (`working`, `waiting` for a person, `idle`) and `control` what can be done with the chat
now: `interactive` (Claudio has a live execution), `resumable` (nothing holds it), or `readOnly` with
the reason and the way forward (`fork`, or `hint` for a task an orchestration is still running).

**Health.** Every chat with a process of Claudio's, and every running orchestration task, carries a
`health` of `ok`, `warn` or `bad` (the UI words them ok, slow, stuck and looping) with the signals
behind it, each with a one-line reason and a suggested hint text. The signals are a `hung-command`
(a command past its usual time), a `repeat-stall` (the same kind of command hanging or failing again),
`no-progress` (busy with no commit or change), a `loop`, a `weakened-test` (an existing test edited
until it asserts less), `silence`, a `budget` close to its limit, and facts such as a failed last
execution or a nearly full context. "Longer than usual" is measured against the last runs of that
kind of command on this machine (`pnpm e2e`, `cargo test`…), with a fixed 3 minutes until there are
five; the rules prefer silence to a false alarm, so a changed expected value or a deleted test is not
"bent to pass". A change of health is a `health.changed` event and a notification. Every reason and
hint also carries a stable `reasonCode` / `hintCode` and the figures it was built from (`params`), so
a client can say the same sentence in another language instead of showing the server's English. To
step in without ending the turn, `POST /chats/:id/commands/:toolUseId/cancel` kills that one
command's process tree (found under the CLI's pid, never by matching a command line; Linux only),
and `POST /chats/:id/hint` sends a message the worker reads at its next step. With the supervisor
(the `supervisor.intervene` point) not off, a worker that turns `bad` also gets a proposed hint on `health.proposal`, to send, edit or
dismiss.

| Method | Route | Description |
| --- | --- | --- |
| GET | `/chats?project=&loose=1&origin=&workers=0&state=&limit=` | Chats, newest first. Workers of an orchestration and housekeeping chats are left out unless `origin` (comma-separated: `claudio`, `external`, `orchestration`, `internal`) asks for them; `workers=0` keeps an orchestration's synthesis but not its workers; `loose=1` lists those under no project |
| GET | `/usage?from=&to=` | What the chats spent, per day, per project and per orchestration (`from`/`to` are days, `YYYY-MM-DD`, inclusive). Tokens come from the transcripts, per model; the cost is what the CLI reported, so it is `null` for chats started from a terminal and `chatsWithoutCost` says how many a total leaves out |
| GET | `/usage/series?bucket=&from=&to=` | Cost and tokens over time: one point per `day` (default) or `week` (Monday-based) of the range, empty ones included so a chart has no gaps. `costUsd` is the CLI's figure and `null` where none was reported; at most 1000 points |
| GET | `/usage/breakdown?from=&to=` | The same range cut by project and by model, most spent first. The cost per model is the CLI's own `modelUsage[model].costUSD`; nothing is priced from token counts |
| GET | `/spend` | Today's spend against the daily cap (`SpendState`): spent, cap, `share`, `level` (`off`, `ok`, `warn` from 60 %, `bad` from 75 %, `exhausted`), `blocked`, when it resets, results without a cost, the breakdowns by purpose and account kind, and what waits. Only the cost the CLI reports is summed. A chat's token may read it |
| POST | `/chats` | Start a chat. Body: `NewChatRequest` (`prompt` required; `cwd`, `model`, `permissionMode`, `effort`, `appendSystemPrompt`, `allowedTools`, `disallowedTools`, `toolPreset`, `mcp`, `jsonSchema`, `maxBudgetUsd`, `worktree`, `permissionPrompts`, `account`, `attachments`). `toolPreset` (an id from `GET /config/tool-presets`) becomes `--allowedTools` / `--disallowedTools`, and an explicit list wins over the preset's; `mcp: { servers: [...] }` starts the chat with only those servers (`--mcp-config` with `--strict-mcp-config`), an empty list with none. Naming neither tools nor a preset takes the default preset from `GET /config/tool-presets`, and `toolPreset: null` opts out into the CLI's own defaults |
| GET | `/chats/:id` | The chat with its branches, environment and `health` (`ok`, `warn` or `bad`, each signal with a one-line reason: a command running past 3 min, a working chat silent for 3 min, and facts of the chat such as a failed last execution, a full context or a failed branch), `tools` (the preset and MCP servers it was started with, `null` for a chat Claudio did not configure), and a window of its transcript: the newest 200 entries, or `?limit=` of them, with `from` and `total`; `?before=` the `from` of a page reads the one before it (`?sidechains=1` adds subagent messages) |
| GET | `/chats/:id/search?q=&sidechains=1` | Search the whole transcript, pages not loaded included: the matching entries' indices (the space of `from`/`total`) with a snippet each, case-insensitive; at most 500, the newest, with `truncated` |
| GET | `/chats/:id/changes` | What the chat changed on disk: for one in a git worktree its `summary` (branch, base, commits, files with `+/−`, uncommitted files, and `working`: every file that differs from the base in the working tree), and for any chat the `touched` files of its `Write`/`Edit`/`NotebookEdit` calls, read from the transcript. `?commit=<sha>` narrows the files to one commit of the branch (400 for any other), `?uncommitted=1` to the working tree against `HEAD` |
| GET | `/chats/:id/changes/diff?path=` | The unified diff of one file of a chat in a worktree against its base, uncommitted work included. `?context=` sets the unchanged lines around each change (0–500, or `full` for the whole file; `full: true` says it was honoured, never past 20 000 lines), and `?commit=`/`?uncommitted=1` scope it as the summary does |
| GET | `/chats/:id/changes/steps` | Every successful `Edit`, `MultiEdit`, `Write` and `NotebookEdit` of the chat's main transcript, oldest first, each with its unified patch, its `+/−`, the sentence Claude wrote before it (`intent`) and the transcript entry that holds it (`entryIndex`); a call still waiting for its result is the last step, `pending`, while the chat runs |
| GET | `/chats/:id/checklist` | The chat's own plan, from its `TaskCreate`/`TaskUpdate`/`TodoWrite` calls: `{ items[{ text, status }], updatedAt }` |
| GET | `/chats/:id/export?format=markdown\|json` | Download the whole transcript. `markdown` (default) is for reading: cost and models in a header, turns, each tool call folded with its result, subagents left out. `json` is every event, subagents included, nothing cut |
| GET | `/chats/:id/stream?since=SEQ` | Server-Sent Events, one `RunEvent` per message (honours `Last-Event-ID`). Includes ephemeral `partial` events with the text generated so far (token streaming); they are never replayed |
| POST | `/chats/:id/resume` | Body: `ResumeChatRequest` (`prompt`, same options as a new chat). Adds an execution to the same chat, which keeps its id. Decided on the server at this moment from the CLI's own session list and the process table: a chat born in a terminal that nothing holds is adopted and stays `external`; one a terminal holds, or that belongs to an orchestration, is refused with `409` and the reason. A resume that names no `mcp` writes the `--mcp-config` file again from the current definition of the same servers, so an edited URL or a rotated token is picked up |
| POST | `/chats/:id/fork` | Body: `ForkChatRequest`. Continues in a copy: a new chat with the same history that records `derivedFrom` and leaves the original untouched. Allowed on any chat. The copy inherits the source's preset, tools and MCP servers unless the request picks others, so it cannot quietly gain what the source was denied |
| POST | `/chats/:id/account` | A person moves a chat to another account (`{accountId}` → `{chat, pending}`): at once when idle, after the turn when working; the current account cancels a pending switch. `404` unknown chat or account, `409` with `code` (`disabled`, `sign-in-expired`, `signed-out`, `exhausted`, `model-unavailable`, `same-account`). Not open to a chat's token |
| POST | `/chats/:id/wait` | A person chooses to wait for the reset: opens a wait (`ProviderMove`), `409` when the chat is not at a limit or is waiting already. Not open to a chat's token |
| POST | `/chats/:id/messages` | `{ text, attachments?, id? }` — another turn for a chat with a live execution (`409` otherwise: resume it). `attachments` are upload ids from `POST /uploads`; `id` is a UUID the client chooses, so a retry is written once. Answers the chat with `message`: its id and how it was taken (`written` into the running turn, `started`, `held` for the next process). The stream says when the agent takes it or when it is lost (`delivery` events), and the chat lists what still waits (`pending`). A `/compact` sent with a chat's token, here or as the prompt of a resume or a fork, is `403`: compacting is the person's |
| POST | `/chats/:id/stop` | Stop what is working on it: the execution Claudio runs, or a background session the CLI holds (`claude stop`). The conversation is kept |
| POST | `/chats/:id/interrupt` | End the turn in progress and keep the process, which reads what waits for it. `{ messageId? }` is "Send now": `409` once the agent has read that message, and nothing is interrupted |
| POST | `/chats/:id/hint` | `{ text }` — a nudge for a chat whose process is up, delivered as its next user message; the signals of `health` carry a suggested text |
| POST | `/chats/:id/commands/:toolUseId/cancel` | Kill one shell command's process tree without ending the turn: the worker gets a failed result for that call and carries on. Optional `{ reason }`; Linux only |
| GET | `/settings/supervisor` | **Deprecated**: the Supervisor is the `supervisor.intervene` decision point; read `GET /decisions/settings`. Answers `{ enabled, model, autoSend, maxCostUsd }` derived from it: `enabled` is the point's mode not being `off`, `autoSend` its mode being `active`, `model` and `maxCostUsd` the engine's `cli.model` and `cli.maxCostUsd` |
| PUT | `/settings/supervisor` | **Deprecated**: set the point's mode through `PUT /decisions/settings`. Maps `enabled` / `autoSend` onto the mode (off; shadow, which proposes hints for a person to send; active, which sends them on its own, and under Jev only when the engine expects a hint to help) and ignores `model` and `maxCostUsd`. When the point is not off, a worker whose health turns `bad` wakes the Supervisor once per signal: a read-only housekeeping chat reads the signal and the worker's last steps and proposes a hint, on `health.proposal` and as `supervisor.proposed`. Refused to a chat's token (`403`) |
| POST | `/chats/:id/supervisor/:proposalId/send` | Send the supervisor's proposal through the hint route and mark it `sent` (`409` once sent or dismissed, or with no live process) |
| POST | `/chats/:id/supervisor/:proposalId/dismiss` | Mark the proposal `dismissed`; nothing reaches the worker |
| PATCH | `/chats/:id` | `{ permissionMode?, model? }` — a live process switches at once; an ended one on its next execution |
| GET | `/chats/:id/mcp` | The live process's MCP servers, claude.ai connectors included (scope `claudeai`): `{ live, servers: [{ name, status, scope, tools, error }] }`, from the CLI's `mcp_status`. `live: false` without a process of ours |
| GET | `/chats/:id/context?detail=` | What fills the chat's window: `{ live, unreported, detail, observedAt, snapshot, breakdown }`, the breakdown from the CLI's `get_context_usage` (`detail=summary`, the default, or `full`, honoured only while the chat is idle). No process, or a CLI that does not answer, is a `200` with `live: false` or `unreported`, never an error. `404` unknown chat, `400` bad `detail` |
| POST | `/chats/:id/compact` | `{ focus?, structuredNote? }` — send `/compact` as a user turn (a paid call over the whole context). `202` with the compaction row; `400` bad body; `409` with a `code` (`busy`, `waiting`, `open`, `read-only`, `housekeeping`, `at-limit`, `run`, `unsupported`, `no-history`). Not open to a chat's token |
| GET | `/chats/:id/compactions` | The compactions of the chat, Claudio's and the CLI's own, newest first, at most 50 |
| GET | `/chats/:id/notes` | The session notes of the chat, newest first, at most 50 |
| POST | `/chats/:id/notes` | `{ from: 'agent' }` asks the chat for a note (`202`, pending), `{ from: 'summary', entryUuid }` keeps a compaction summary (`201`, ready). `400` bad body or an entry that is not a summary of this chat; `409` with a `code` (a compaction refusal, or `saved`). Not open to a chat's token |
| DELETE | `/chats/:id/notes/:noteId` | Delete a note. `204`; `404` unknown chat or note. Not open to a chat's token |
| PUT | `/chats/:id/mcp/:name` | `{ enabled }` — switch one server on or off in the running process (the CLI's `mcp_toggle`); the CLI keeps the choice for the chat's folder. `400` without a live process |
| DELETE | `/chats/:id` | Delete the transcript, its sidecar files and Claudio's record (`409` while something is running on it) |
| GET | `/chats/:id/logs` | A background session's recent terminal output (`claude logs`) |
| GET | `/chats/:id/permissions` | What the chat is waiting on: tool calls, questions (`AskUserQuestion`) and plans (`ExitPlanMode`). Only for chats started with `permissionPrompts: "host"` |
| POST | `/chats/:id/permissions/:requestId` | `{ behavior: "allow" \| "deny", message?, updatedInput?, updatedPermissions? }` — answer one. A question is answered by allowing it with `updatedInput.answers` (question → chosen labels); `updatedPermissions` takes the request's `suggestions` to remember them. The request must belong to this chat: one from another chat answers `404` with the same body as an id that never existed. Unanswered requests are denied after ten minutes |
| GET | `/chats/:id/subagents` | Subagents of the chat: branches of it, whose messages live in its transcript |
| GET | `/chats/:id/subagents/:agentId` | One subagent: prompt, outcome, token usage and full transcript (`?after=` to append) |
| GET | `/chats/:id/tasks` | Commands the chat sent to the background, with `ownerId` for those a subagent launched |
| GET | `/chats/:id/tasks/:taskId/output` | What one of them printed: the last 64 KiB, or with `?offset=` only what came after that byte |
| GET | `/chats/:id/workflows` | Workflow runs (the Workflow tool) of the chat, with the progress of every agent they launched |
| GET | `/chats/:id/workflows/:workflowId/agents/:agentId` | The same as a subagent's, for an agent a workflow launched |
| GET | `/environments?cwd=` | What Claude actually loaded (tools, MCP status, agents, skills, plugins, commands, memory paths) per directory, from the latest chat started there |
| GET | `/tasks` | Commands sent to the background (monitors and remote agents too), each with the chat that sent it, from Claudio's chats and from terminal ones live or ended in the last day. The inbox sees a hung command wherever it is. Survives a restart |
| GET | `/subagents` | Subagents of every chat, foreground or background, each with its chat. Survives a restart |
| GET | `/workflows` | Workflow runs of every chat, each with its chat |
| GET | `/workflows/saved?cwd=` | Saved workflows in the project's `.claude/workflows/` and the user's |
| POST | `/workflows/saved/run` | `{ name, cwd?, args?, model? }` — start a chat that runs a saved workflow |

```bash
curl -X POST localhost:8797/api/chats -H 'content-type: application/json' \
  -d '{"prompt":"Summarize this repo","cwd":"/workspace/my-project","model":"sonnet"}'
curl -N localhost:8797/api/chats/<id>/stream
```

## Orchestration

An orchestration is a DAG of tasks; each task runs in its own Claude worker. Independent
tasks run in parallel (up to `concurrency`), results of dependencies are passed to dependent
tasks, and an optional final worker synthesizes a report.

A worker runs with nobody at the keyboard, so set how it gets permission: `permissionPrompts:
"host"` sends its prompts to the run page for you to answer, `allowedTools` pre-authorises tools.
With neither, anything that would prompt is denied. `worktree: true` gives every task its own git
worktree and branch through `claude --worktree`.

A worktree graph delivers one branch: when it finishes, every completed task's branch is merged, in
dependency order, into `claudio/<name>-<id>` from the commit the graph started on. A merge conflict
is handed to an integrator agent in that branch's worktree, and its result is checked rather than
trusted. Nothing is pushed until you ask for a pull request.

The same graph runs on one of two engines (`engine`). `graph`, the default, is the one above: a
process per task. `workflow` runs every task as a subagent of a single Claude Code session, through
a workflow script (Claude Code's Workflow tool) Claudio generates from the graph — the same prompts, dependencies,
concurrency and synthesis. It is cheaper, and a resume replays the tasks that had finished from the
CLI's cache, but every task works in the project directory, so it cannot take `worktree`. The
planner picks it only when no task changes the repository (analysis, review, research), and only
when the CLI has the Workflow tool; the draft shows why it chose either, and you can switch.

**Limits.** A task, or the whole graph as a default, takes `limits: { maxMinutes?, maxCostUsd? }`. The
cost limit goes to the CLI as `--max-budget-usd` (a retry gets only what is left, because the
CLI's ceiling is per process); the time limit is Claudio's own clock, which tells the worker to wrap
up at 80 % and ends the task with that reason at the limit. A workflow graph refuses limits rather
than ignoring them.

**Verification.** `verification: { commands, fixer, maxAttempts, maxCostUsd?, install?, failGraph?,
model?, timeoutMinutes? }` runs the checks once, on the integration branch, after the merge and
before the synthesis and the pull request, and needs `worktree: true` on the graph engine. Each
command runs alone under its timeout (default 20 min), and a hung one has its whole process tree
killed. With `fixer: true` a failing command goes to an agent whose rules Claudio writes: every long
command under `timeout`, existing assertions never loosened (a behaviour that changed on purpose is
stated as such), at most `maxAttempts` per command, and at most `maxCostUsd` over all of them —
passed to the CLI as `--max-budget-usd` with what is left after each attempt, because the CLI's
ceiling is per process. When the attempts or the money run out it stops and reports.

Unless `install` says otherwise, Claudio finds the nearest lockfile from the graph's directory up to
the integration worktree and installs before the checks (`pnpm-lock.yaml` → `pnpm install
--frozen-lockfile`, `package-lock.json` → `npm ci`, `yarn.lock` → `yarn install --frozen-lockfile`),
as its own row in the state; `install: null` disables it and a string replaces it. The outcome is on
the orchestration — `passed`, `fixed` (with the fixer's commits and what it spent) or `failed` (with
the report and the checks that never ran) — and shown before a pull request is offered. By default it
does not turn the graph itself `failed`, because the graph's status is about its tasks;
`failGraph: true` says the opposite, and the graph then ends `failed` with the checks as its error
and no pull request offered. Every worker's prompt also gets the split of checks: run the type check
and the unit tests, leave the browser suite to the verification, run long commands under `timeout`.
`POST /orchestrations/:id/verify` runs the checks by hand; with `verification.review` it also runs
the review gate once the checks pass, and `GET /orchestrations/:id/review` reads it.

**Revising a graph.** Any task of a finished graph on the graph engine can be **re-run**: it starts
over with everything that depends on it, each in a new chat and a worktree rebuilt from what it now
depends on, and the integration branch is rebuilt from the base. It is refused while the graph runs,
for a workflow, and once the branch went into a pull request (relaunch instead). **Relaunch** makes a
new orchestration from the spec the graph actually ran with, overridden by a partial spec and
optionally a new task list, and records `relaunchedFrom`; the original stays as it was.
**Templates** save a graph or a draft as a named, editable spec (`orchestration-templates.json`) that
launches on a new objective and directory and records `templateId`.

**What a worker really did.** A running task shows its branch and base, its commits, the files it
changed with `+/−`, its uncommitted work, its own checklist (the `TaskCreate` /
`TaskUpdate` / `TodoWrite` calls) and its health, measured from where its own branch was cut. The
integration branch has the same summary, and both open the review screen
(`/orchestration/:id/tasks/:taskId/changes`, `/orchestration/:id/changes`). Changes are announced by a `changes.updated` event, checked
every 3 s and only while a client listens.

| Method | Route | Description |
| --- | --- | --- |
| GET | `/orchestrations` | List, each graph as a summary: task prompts and results, the synthesis and check output are left to `GET /orchestrations/:id` |
| POST | `/orchestrations` | Launch. Body: `OrchestrationSpec`; a task naming a `workItemId` is linked to that item, which follows its status |
| POST | `/orchestrations/plan/start` | `{ objective, cwd?, model?, maxTasks? }` → the planner chat (housekeeping), returned at once so it can be streamed at `/chats/:id/stream` |
| GET | `/orchestrations/plans` | Plans generated but not launched; each is kept when its planner finishes |
| GET | `/orchestrations/plans/:runId` | The draft `OrchestrationSpec` a planner chat produced (`:runId` is the planner chat's id) |
| POST | `/orchestrations/plan` | Same as `plan/start` but waits for the draft — holds the request open for minutes |
| GET | `/orchestrations/:id` | State of every task, results, cost |
| GET | `/orchestrations/:id/timings` | Where the graph's time went, computed on read: phases, time after the last task, parallelism, the critical path with its waits, slot/limit/retry waits, every verification run and fixer attempt; `missing` names what an older graph did not record. `node scripts/orchestration-timings.mjs` prints it as Markdown tables against `CLAUDIO_API_URL` |
| POST | `/orchestrations/:id/spend-pass` | Let a graph run past today's spend cap: sets `spendPass` to the server's local day and answers the orchestration. Refused to a chat's token with `403` |
| POST | `/orchestrations/:id/stop` | Stop all workers |
| POST | `/orchestrations/:id/resume` | Also accepted on a graph `waiting` for a decision, unless a person is still working by hand in one of its tasks' chats (`409`). Run again every task that did not complete (each in its own chat, as a new execution), keeping the results of those that did. Optional body `{ worktree?, permissionPrompts?, allowedTools?, permissionMode?, limits?, maxAttempts? }` corrects the settings the graph failed with. `limits` as an object replaces the graph's default and leaves the ceilings individual tasks were given; as `null` it lifts every ceiling, those included, which is what a graph stopped by its own budget needs |
| POST | `/orchestrations/:id/tasks/:taskId/retry` | Run a task that failed for good, or was stopped, again, in its own chat and worktree, told what went wrong; the tasks blocked behind it go back to waiting for their turn |
| POST | `/orchestrations/:id/tasks/:taskId/retry-clean` | Start a failed or stopped task over: a new chat, its worktree rebuilt from the base commit |
| POST | `/orchestrations/:id/tasks/:taskId/rerun` | Run a task of a finished graph again with everything that depends on it, each in a new chat and worktree, then integrate and synthesise again; the integration branch is rebuilt from the base |
| POST | `/orchestrations/:id/tasks/:taskId/skip` | Give a failed, stopped or blocked task up, with every task that depends on it, so the graph can finish without them |
| POST | `/orchestrations/:id/tasks/:taskId/hint` | `{ text }` — a nudge for a worker whose task is still running; a finished task takes none (fork its chat) |
| POST | `/orchestrations/:id/tasks/:taskId/supervisor/:proposalId/send` | Send the supervisor's proposal for a worker through the task hint route and mark it `sent`. What the supervisor cost is already on the graph's `costUsd` |
| POST | `/orchestrations/:id/tasks/:taskId/supervisor/:proposalId/dismiss` | Mark the proposal `dismissed` |
| POST | `/orchestrations/:id/relaunch` | `{ spec?, tasks? }` — the same graph with corrections (`spec` overrides settings, `tasks` replaces the list) as a new orchestration that records `relaunchedFrom`; the original is left as it was. Each node keeps its `workItemId`, checked as a launch checks it |
| GET | `/orchestrations/templates` | Saved graphs, by name (a JSON file in the data directory) |
| POST | `/orchestrations/templates` | `{ name, description?, spec? , fromOrchestration? }` — save a draft plan or an orchestration's graph as a template; its nodes' work items are left out |
| GET | `/orchestrations/templates/:templateId` | One template |
| PATCH | `/orchestrations/templates/:templateId` | `{ name?, description?, spec? }` |
| DELETE | `/orchestrations/templates/:templateId` | Delete a template; orchestrations launched from it are unaffected |
| POST | `/orchestrations/templates/:templateId/launch` | `{ objective?, cwd?, name?, model? }` — launch the template on a new objective and directory; recorded as `templateId` |
| GET | `/orchestrations/:id/tasks/:taskId/changes` | What a task changed: `{ branch, base, ahead, commits[], files[{ path, status, additions, deletions }], uncommitted[], working[] }`, measured from where its branch was cut, with `?commit=` and `?uncommitted=1` as for a chat. Announced by a `changes.updated` event while it runs |
| GET | `/orchestrations/:id/tasks/:taskId/changes/diff?path=` | The unified diff of one file of the task against its base, uncommitted work included, with `?context=`, `?commit=` and `?uncommitted=1` as for a chat |
| GET | `/orchestrations/:id/tasks/:taskId/changes/steps` | The task's edits step by step, read through its chat, as `/chats/:id/changes/steps` |
| GET | `/orchestrations/:id/tasks/:taskId/checklist` | The worker's own plan, from its `TaskCreate`/`TaskUpdate`/`TodoWrite` calls |
| GET | `/orchestrations/:id/integration/changes` | The same summary for the integration branch, against the graph's base commit, with the same scopes |
| GET | `/orchestrations/:id/integration/changes/diff?path=` | The unified diff of one file of the integration branch, with the same `?context=` and scopes |
| DELETE | `/orchestrations/:id` | Delete a graph that is not running, with its worktrees; refused while a worktree holds uncommitted work |
| POST | `/orchestrations/:id/integrate` | Merge the task branches into the integration branch again: after resolving by hand, or for a graph that predates integration |
| POST | `/orchestrations/:id/verify` | `{ verification? }` — run the graph's checks (`verification.commands`, where an entry that is a list runs its commands in parallel, then a fixer if asked) on the integration branch, or again after it changed; outcome on `verification`: `passed`, `fixed` or `failed`. With `verification.review` the review gate runs after the checks pass; its bounds are validated (`400`). Returns at once |
| GET | `/orchestrations/:id/review` | The review gate: `{ state, rounds, findings, totalFindings }`. `?round=` (default the latest), `?blocking=1`, `?limit=` (1–500, default 100), `?offset=`; `400` out of bounds, `404` for an unknown graph or one without a review. Open to a chat token |
| POST | `/orchestrations/:id/review/retry` | Run the review again on a head whose checks passed → the orchestration, at once; `409` with `code` `review-running`, `checks-not-passed`, `head-moved` or `review-not-acceptable` (no review). Open to a chat token |
| POST | `/orchestrations/:id/review/accept` | `{ reason }` — a person accepts a blocked gate, or an incomplete one after a retry also ended incomplete; bound to the head, voided by a new commit. `400` bad reason, `409` `review-not-acceptable`. `403` to a chat token |
| POST | `/orchestrations/:id/pull-request` | Check the project's readiness, push the integration branch and open a pull or merge request with the host CLI → `{ branch, url, detail, pullRequest }`; `409` with the reason when the project cannot open one or the branch has nothing to propose |
| GET | `/orchestrations/:id/workflow` | The graph as a workflow script → `{ path, script }` |
| POST | `/orchestrations/:id/workflow/save` | `{ name?, overwrite? }` — copy that script into the project's `.claude/workflows/` |
| POST | `/orchestrations/:id/worktrees/prune` | `{ force? }` — remove the graph's worktrees; branches are always kept |

```json
{
  "name": "audit",
  "objective": "Audit the project and propose fixes",
  "cwd": "/workspace/my-project",
  "concurrency": 3,
  "synthesize": true,
  "worktree": true,
  "permissionPrompts": "host",
  "tasks": [
    { "id": "deps", "name": "Dependencies", "prompt": "Review outdated dependencies…" },
    { "id": "tests", "name": "Tests", "prompt": "Assess test coverage…" },
    { "id": "plan", "name": "Fix plan", "prompt": "Write a prioritized fix plan.", "dependsOn": ["deps", "tests"] }
  ]
}
```

## Uploads

Files attached to a chat's first message (`NewChatRequest.attachments`) or to a later turn. The file is
the request body as is, not multipart. Images are capped at 5 MB, PDFs at 32 MB, anything else at
50 MB, and the files live in `uploads/` under the data directory.

| Method | Route | Description |
| --- | --- | --- |
| POST | `/uploads?name=` | Body: the raw file, `Content-Type: application/octet-stream` → `201` with the `Attachment` (`id`, `name`, `mediaType`, `kind`, `sizeBytes`…) |
| GET | `/uploads/:id` | The `Attachment` metadata |
| GET | `/uploads/:id/content` | The bytes. Images and PDFs are served inline, everything else as a download |

```bash
id=$(curl -s -X POST 'localhost:8797/api/uploads?name=diagram.png' \
  -H 'content-type: application/octet-stream' --data-binary @diagram.png | jq -r .id)
curl -X POST localhost:8797/api/chats -H 'content-type: application/json' \
  -d "{\"prompt\":\"Explain this diagram\",\"attachments\":[\"$id\"]}"
```

## Schedules

Recurring chats and orchestrations on a five-field cron expression (`minute hour day-of-month month
day-of-week`, with lists, ranges, steps, month and weekday names, and `@hourly`, `@daily`, `@weekly`,
`@monthly`, `@yearly`) read in an IANA time zone, the server's when none is given. The definitions
live in `schedules.json` in the data directory; the history is rows in `wrapper.db`. A slot is claimed
by a unique key, so it never fires twice, across restarts or across two processes on one data dir. A
slot that passed while Claudio was not running is **skipped, not run late**, and the history says so.

**Overlap.** A slot that fires while the schedule's last run is still going (its chat `working` or
waiting on a person, its orchestration `running`) follows the schedule's `overlap`: `parallel`
starts it anyway (the default, and what every schedule did before there was a choice), `skip`
writes an `overlapped` run and starts nothing, `queue` writes a `queued` run that starts when the
previous one ends — one pending at most, a newer slot replacing it, and the run it becomes keeps
the slot it answers. The queued row is in the database, not in memory, so a restart does not lose
it and two processes on one data directory cannot both start it. Every change and every run row is
announced on the feed (`schedule.changed`, `schedule.fired`), so a list never has to poll.

| Method | Route | Description |
| --- | --- | --- |
| GET | `/schedules` | Every schedule, with its `overlap` policy, `lastRunAt` and `nextRunAt` (null while disabled) |
| GET | `/schedules/preview?cron=&timezone=&count=` | What an expression will do: `valid`, the `error` naming the wrong field, a `description` in words and the next fires. Saves nothing |
| POST | `/schedules` | `{ name, cron, timezone?, target, enabled?, overlap? }` where `target` is `{ kind: 'chat', chat: NewChatRequest }` or `{ kind: 'orchestration', spec: OrchestrationSpec }`, and `overlap` is `parallel` (default), `skip` or `queue` → `201` |
| GET | `/schedules/:id` | One schedule |
| PATCH | `/schedules/:id` | Edit any field, `enabled` included. A new expression or zone, or switching it on, starts its clock afresh |
| DELETE | `/schedules/:id` | Deletes it and its history; what it already started is not touched |
| POST | `/schedules/:id/enable` | Switch on |
| POST | `/schedules/:id/disable` | Switch off |
| POST | `/schedules/:id/run` | Run now, even while disabled → `201` with the `ScheduleRun`; a target that fails to start is `status: 'failed'` with its `error` |
| GET | `/schedules/:id/runs?limit=` | History, newest first: `started` with the `chatId` or `orchestrationId` it produced, `failed` with its `error`, `skipped` for a slot that passed while Claudio was down, `overlapped` for one the policy did not take, and `queued` for one waiting on the run before it |

## Configuration (user and project scope)

Every `/config` route accepts `?project=<projectId>` (the `id` from `GET /projects`). Without it
the **user scope** is used (the Claude config dir); with it, that **project's** own files. Only
projects known to the wrapper are accepted, so the API cannot be pointed at arbitrary paths.
Claude Code precedence is local > project > user.

| Method | Route | Description |
| --- | --- | --- |
| GET / PUT | `/config/settings?project=&variant=shared\|local` | `settings.json`, or `settings.local.json` with `variant=local` (project only) — body `{ settings }`. Values in `env` are a placeholder on read, with the same round trip as MCP |
| GET / PUT | `/config/instructions?project=&variant=shared\|local` | `CLAUDE.md` / `CLAUDE.local.md` — body `{ content }` |
| GET | `/config/mcp?project=` | MCP servers tagged by scope. Project scope returns `local` + `project` (`.mcp.json`) + inherited `user` servers. Values in `env` and `headers` come back as a placeholder; sending it back unchanged on a write keeps the stored value |
| PUT | `/config/mcp/:name?project=` | Create or replace — body `{ config, scope? }`, e.g. `{"type":"http","url":"…"}` or `{"command":"npx","args":["-y","pkg"],"env":{}}` |
| DELETE | `/config/mcp/:name?project=&scope=` | Remove |
| GET | `/config/mcp/health?project=` | Real connection checks (`claude mcp list`); slow, call on demand |
| GET | `/config/resources/:kind?project=` | `kind` = `agents` \| `skills` \| `commands` \| `output-styles` \| `rules` \| `workflows` |
| GET | `/config/tool-presets` | `{ defaultPresetId, presets }`: named `--allowedTools` / `--disallowedTools` sets (`read-only`, `no-network`, `everything` ship as editable defaults) and the one a new chat takes when it picks no tools |
| PUT | `/config/tool-presets/default` | `{ defaultPresetId }` — the preset a new chat takes when it names neither `toolPreset` nor `allowedTools` (`toolPreset: null` opts out); `null` clears it |
| POST | `/config/tool-presets/restore` | Rewrite the three shipped presets as they ship; every other preset and the default are left alone |
| PUT / DELETE | `/config/tool-presets/:id` | Create, replace or delete a preset — body `{ name, description?, allowedTools, disallowedTools? }` |
| GET / PUT | `/settings/app` | Settings that change without a restart (`app-settings.json`): `{ allowedHosts, maxConcurrentRuns, defaultPermissionMode, setupSeen, dailySpendCapUsd, sources, allowedHostLayers }`, where each source is `env`, `file` or `default`. `allowedHosts` adds the hosts saved here to those of `CLAUDIO_ALLOWED_HOSTS`, and `allowedHostLayers` splits them into `env`, `file` and `runtime` (a running tunnel's host, read-only). The `PUT` body names only what changes; a setting the environment set is refused, except `allowedHosts`, which replaces the saved hosts; a pattern such as `*.com` is refused. `dailySpendCapUsd` is the daily spend cap in USD (above 0, up to 100000, `null` for none; `CLAUDIO_DAILY_SPEND_CAP_USD`): over it new automated work waits and a person's chat start answers `409 spend-cap` until they send `X-Claudio-Spend-Override: 1`; a chat's token cannot name it in a `PUT` (`403`). Emits `settings.changed` |
| GET / PUT / DELETE | `/dashboard/layout?project=<id\|all>` | The layout of one Home, per project and one for All projects (`dashboard-layouts.json`): `{ project, layout }`, `layout` being `null` while the default applies. `PUT` takes the whole layout `{ version: 1, widgets: [{ id, type, size, config? }] }` in drawing order and answers 400 for an unknown or misplaced widget type, a size the type does not offer or a repeated id, 404 for an unknown project; `DELETE` resets it. A chat's token cannot write (403). Emits `dashboard.layout` |
| GET / PUT / DELETE | `/config/resources/:kind/:name?project=` | Markdown content (a script for `workflows`, whose `format` is `javascript`) — body `{ content }` |

## Config file explorer

Generic editor for everything else under a scope's Claude dir (`~/.claude` or
`<project>/.claude`): hook scripts, extra skill files, keybindings, memory… `root` is `user` or a
project id. Paths are confined to the root (symlinks included); CLI runtime state and secrets
(`.credentials.json`, `.claude.json`, transcripts, caches) are hidden and refused. Text files up to 1 MB.

| Method | Route | Description |
| --- | --- | --- |
| GET | `/config/files/roots` | Available roots |
| GET | `/config/files/tree?root=` | Nested tree |
| GET | `/config/files/content?root=&path=` | Read a file |
| PUT | `/config/files/content` | Create or overwrite — body `{ root, path, content, executable? }` |
| DELETE | `/config/files/content?root=&path=` | Delete a file or directory |

## Memory

Claude Code's persistent memory is local: markdown files in
`<configDir>/projects/<projectId>/memory/`, one fact per file plus the `MEMORY.md` index that is
loaded into every session of that project.

| Method | Route | Description |
| --- | --- | --- |
| GET | `/memory` | Imported projects with their memory file counts |
| GET | `/memory/:project` | Memory files of a project (index first), with parsed `description` and `type` |
| PUT | `/memory/:project/:name` | Create or overwrite `name.md` — body `{ content }` |
| DELETE | `/memory/:project/:name` | Delete a memory file |

## Project journal and memory proposals

A project's journal is Claudio's record of decisions taken and items closed, handed to every flow run
(the newest entries, up to 16 KiB). Team members propose what the team should remember; nothing is
written to `CLAUDE.md`, the CLI's memory or the journal until a person approves it. Changes need the
project's Memory module on.

| Method | Route | Description |
| --- | --- | --- |
| GET | `/projects/:id/journal?limit=&before=` | The journal, newest first, paged, with what a flow run is handed |
| POST | `/projects/:id/journal` | Write a decision or a note by hand — body `{ text, kind?, itemId?, documentPath? }` |
| DELETE | `/journal/:entryId` | Delete a journal entry |
| GET | `/projects/:id/memory/proposals?status=` | The team's memory proposals, newest first, by status |
| POST | `/memory-proposals/:proposalId/approve` | Approve a proposal, optionally with edited `text` (and, for a `rule` target, another `file`), and write it to its target: `CLAUDE.md`, a memory file, the journal, or a path-scoped rule in `.claude/rules/<file>` (new, appended when its paths are the same, 409 when they differ); a chat's token gets 403 |
| POST | `/memory-proposals/:proposalId/reject` | Reject a proposal, with an optional `reason`; nothing is written; a chat's token gets 403 |
| GET | `/projects/:id/lessons?status=` | A project's lessons (`active` by default, or `proposed`, `retired`, `rejected`, `superseded`, `all`) and what a run is handed now (`handed`) |
| GET | `/projects/:id/lessons/export` | Every lesson of the project, any status, as a JSON download; nothing reads lessons back in |
| GET | `/projects/:id/lessons/jobs?limit=` | The project's lesson mining jobs, newest first (20 by default, 100 at most) |
| GET | `/lessons/global?status=` | Global lessons, with what a chat outside any project is handed |
| GET | `/lessons/settings` | The global lesson settings (`lessons.json`) |
| PUT | `/lessons/settings` | Change them, with a partial body; 400 names a field out of range; a chat's token gets 403 |
| GET | `/lessons/:lessonId` | One lesson, with its evidence |
| PATCH | `/lessons/:lessonId` | Edit its `trigger` and `action`, or pin it — body `{ trigger?, action?, pinned? }`; a chat's token gets 403 |
| POST | `/lessons/:lessonId/confirm` | Say it still holds; a chat's token gets 403 |
| POST | `/lessons/:lessonId/retire` | Stop handing it to runs; a chat's token gets 403 |
| POST | `/lessons/:lessonId/restore` | Hand a retired lesson again; a chat's token gets 403 |
| DELETE | `/lessons/:lessonId` | Delete a lesson that is not waiting for a decision; a chat's token gets 403 |
| POST | `/lessons/:lessonId/promote` | Make an active project lesson global; answers the global one; a chat's token gets 403 |
| POST | `/lessons/:lessonId/demote` | Move a global lesson back to its project — body `{ projectId? }`; a chat's token gets 403 |
| POST | `/lessons/:lessonId/instructions` | Propose the lesson for `CLAUDE.md` as an `instructions` proposal — body `{ section? }`; a chat's token gets 403 |
| POST | `/memory-proposals/:proposalId/preview` | The diff an `instructions` proposal would make to `CLAUDE.md`, with its sha256 to send back as `previewOf` on approve — body `{ text? }` |
| POST | `/chats/:id/lessons/mine` | Look for lessons in a chat now, 202 with the job; one run per chat per 10 minutes; a chat's token gets 403 |

## Plugins

Delegated to `claude plugin`; actions return the CLI output as `{ ok, output }` and can take a while.

| Method | Route | Description |
| --- | --- | --- |
| GET | `/plugins` | Installed plugins and configured marketplaces |
| GET | `/plugins/available?q=` | Search the marketplaces (max 100 results) |
| GET | `/plugins/details?plugin=` | Component inventory of a plugin |
| POST | `/plugins/install` | Install a plugin — body `{ plugin, scope? }` (`name@marketplace`) |
| POST | `/plugins/uninstall` | Uninstall a plugin — body `{ plugin, scope? }` (`name@marketplace`) |
| POST | `/plugins/enable` | Enable a plugin — body `{ plugin, scope? }` (`name@marketplace`) |
| POST | `/plugins/disable` | Disable a plugin — body `{ plugin, scope? }` (`name@marketplace`) |
| POST | `/plugins/marketplaces` | Add — body `{ source }` (GitHub `owner/repo`, URL or path) |
| POST | `/plugins/marketplaces/update` | Body `{ name? }` — all when omitted |
| DELETE | `/plugins/marketplaces/:name` | Remove |

## Connectors

The claude.ai connectors of the signed-in account, as the CLI reports them. A connector waiting for its sign-in is authorised with `POST /connectors/:id/authorise`, which returns the CLI's sign-in link for the person's browser; the answer also says what a person does by hand (`/mcp` in an interactive session, or claude.ai's connector settings).

| Method | Route | Description |
| --- | --- | --- |
| GET | `/connectors?refresh=` | The claude.ai connectors (Docs, Gmail, Calendar) as the CLI's `mcp_status` reports them (with their tool count; `claude mcp list` is the fallback), with prepared prompts, what a person must do to authorise one and what has no CLI surface (web artifacts, claude.ai memory). The authorisation steps, the link labels and the out-of-reach reasons carry a stable code and their params beside the English, so a client can translate them. Cached for a minute |
| POST | `/connectors/:id/authorise` | Starts the sign-in of a connector that needs it (`:id` as listed, e.g. `claude.ai Gmail`): a short-lived CLI process answers `mcp_authenticate` and the `{ authUrl, requiresUserAction, callbackExpected }` comes back for the person's browser; Claudio never fetches or logs the link. `404` unknown connector, `409` not waiting for authorisation, `502` the CLI could not start it. Not open to a chat's token |

## Related

[[decisions/rest-api-contract.md]] · [[api-wire.md]] · [[securing.md]] · [[configuration.md]] · [[accounts.md]] · [[setup.md]] · [[collaborators.md]] · [[team-and-flow.md]] · [[work-items.md]] · [[projects.md]]
