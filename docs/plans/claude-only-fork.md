---
created_at: 2026-10-15T09:00:00Z
updated_at: 2026-10-15T14:00:00Z
tags:
    - plan
    - fork
    - accounts
    - rotation
    - branding
---
# Claudio: the Claude-only fork

Status: **built** (2026-10-15). Stages S, A and R are merged into `feat/claude-only`.

Claudio is a fork of Agentry at `d1ee00514` (release 0.37.1). Agentry grew from a wrapper around
Claude Code into an orchestrator that drives several vendors' agents
([plans/multi-provider.md](multi-provider.md)), and in its phase 4 (#188) it retired claude-swap in
favour of moving work between vendors. Claudio goes back to the original idea: **it drives Claude
Code only, and it rotates between several Claude accounts**, with a package of its own,
`@claudio/accounts`, that does what claude-swap (`cswap`) did for Agentry before #188 without
claude-swap and without its undocumented endpoints. Everything
else Agentry built after the fork point that is not about other vendors stays: the assistant and its
MCP server, code hosts and trackers, the decision engine, effort, the setup flow, Home widgets, the
message tracking of CW-37, and so on.

## Decisions (owner, 2026-10-15)

1. **Start from Agentry's `main` and remove, not from an older commit.** Rejected: forking from
   `8c52aef25` (just before #188) and porting 46 later commits by hand; forking from before #150 and
   losing about 80 pull requests of unrelated work.
2. **Keep the provider driver interface** (`packages/core/src/providers/driver.ts`, #155) with a
   single driver, Claude Code. Rejected: flattening it back into `chats.ts`, which touches the whole
   core for no behavioural gain. The conformance suite keeps testing the one driver.
3. **A separate product with its own data.** New repository, product name **Claudio**, its own data
   directory, ports, desktop identity and update channel, so it runs beside an installed Agentry.
4. **At a usage limit: switch account first, then wait.** Claudio moves to another account with
   quota and the turn is replayed in the same chat. When no account has quota, the work waits for
   the reset. The wait half of `rotation.ts` stays; handoff and restart go. Rejected: only switching
   (a limit with every account exhausted fails the run); waiting only for automated work.
5. **A person's chat switches account on its own, per the setting** (`rotateOnLimit`, as before
   #188). Agentry's rule P4-2 (never move a person's chat without a click) existed because a move
   could spend on another vendor; an account switch stays on Claude, so it does not apply. Rejected:
   a banner that asks; never switching a person's chat.
6. **Total separation from Agentry.** Everything is renamed: the package scope `@agentry/*` becomes
   `@claudio/*`, `AGENTRY_*` variables become `CLAUDIO_*`, the MCP server, the branch prefixes, the
   browser storage keys, the docs and the copy. The changelog starts fresh. Rejected: renaming only
   what collides at runtime to keep cherry-picks from Agentry cheap; a `BRAND` constant. Claudio does
   not plan to take changes from Agentry.
7. **No claude-swap: an accounts package of Claudio's own** (owner, 2026-10-15). Claudio does not
   install, pin or call claude-swap. Rejected: restoring the claude-swap integration of
   `8c52aef25`; porting claude-swap faithfully. A faithful port would break the one rule: claude-swap
   refreshes OAuth tokens at `platform.claude.com/v1/oauth/token` with Claude Code's own client id,
   and reads `api.anthropic.com/api/oauth/profile` and `api.anthropic.com/api/oauth/usage`, none of
   them documented for programs. Going through claude-swap's CLI kept Agentry within the rule only
   because the calls were a third-party tool's.
8. **One config directory per account; the account is chosen per process.** Each account is a
   `CLAUDE_CONFIG_DIR` of its own, signed in once with `claude auth login` and refreshed by the CLI
   itself; an account may instead be a `claude setup-token` token or an API key, passed in the
   environment. Claudio never copies or rewrites a credential, so there is no global "active
   account", no swap of `~/.claude/.credentials.json`, and no need for Claude Code's lock
   directories. Usage per account comes from the `rate_limit_event` Claude already emits. Rejected:
   setup tokens only (no email, a renewal by hand every year).
9. **A library with a CLI of its own.** `packages/accounts` (`@claudio/accounts`), used by core,
   with a `claudio-accounts` binary for the terminal. Rejected: a module inside core with no CLI; a
   separate repository.

**The one rule stays**, narrowed back to its first form: Claudio reaches Claude Code only through its
CLI (flags, subcommands, stream-json, the control protocol, the files it writes, the documented
environment variables). No SDK, no HTTP call to Anthropic, no OAuth flow of its own, no terminal
scraping.

Rotating between several subscriptions to go past a usage limit is a question for Anthropic's terms
of use, which the owner checks before Claudio is published.

A note on the name: Anthropic's brand guidelines, cited in decision 2 of
[plans/multi-provider.md](multi-provider.md), restrict how third-party products use "Claude".
"Claudio" is fine for a personal or private tool; check it again before publishing a release.

## What changes

### 1. Other vendors removed

- **Core:** delete `providers/{acp,codex,copilot,gemini,opencode}/**`, `providers/gh-fallback.ts`,
  `candidates.ts`, `model-map.ts`, `chat-entries.ts`, `catalogs.ts`, `handoff.ts`,
  `work-provider.ts`, `decisions/provider-points.ts`, `cswap-retirement.ts`.
  `PROVIDER_MANIFESTS = [claudeCodeManifest]`; the detector keeps `probeClaude`, readiness and the
  watchers; `providers.json` keeps only Claude's `enabled` and `binaryPath` and ignores unknown keys
  of an old file. `setup/methods.ts`, `setup/logins.ts`, `setup/device-patterns.ts`,
  `secret-vault.ts` and `paths.ts` (`PROVIDER_HOME_ENV`, keeping `GH_CONFIG_DIR` and
  `GLAB_CONFIG_DIR`) lose the other vendors. `SETUP_TOOLS` narrows to Claude, gh, glab, YouTrack and
  Tailscale.
- **Work starts on Claude directly:** `WorkProviders.choose` (assistant, flow, orchestrator) becomes a
  constant start on `claude-code`; `task.chain` and the chain cost sum go; `task.provider` and
  `flow_runs.provider` stay, always `claude-code`. The decision engine's `cli` route stops using
  candidates: Claude, or `unavailable: 'rate-limited'` when every account is exhausted.
- **Decision points** `provider.on-limit`, `provider.pick` and `provider.model-map` are removed from
  the catalogue, the settings, the resolvers and the web.
- **Kept as types**, because Claude still uses them: `ProviderId`, `ProviderStatus`,
  `ProviderLimit`, `Chat.provider`. `policy-judge.ts` stays (typed through `driver.ts`, never reached
  by Claude).
- **API:** `GET /providers/candidates`, the model-map routes, the three `cswap-retirement` routes,
  `GET /chats/:id/handoff` and `POST /chats/:id/move` are removed. `GET /providers`,
  `POST /providers/refresh`, `GET`/`PUT /providers/settings`, `GET /providers/:id`,
  `POST /chats/:id/wait` and the waits (`GET /providers/moves`, `POST /providers/moves/:id/cancel`,
  renamed `/limits/waits` and `/limits/waits/:id/cancel`) stay.
- **Web:** `ProviderChain`, `MoveSheet`, `HandoffCard`, `FlowMoved`, `ModelMapEditor`, `OnLimitCard`,
  `ProjectProviders`, both retirement notices, the provider picker in New chat, and the `providers`
  group of the Decisions tab go. Settings → Providers becomes a Claude card (status, binary, limit
  bars). The limit banner keeps only waiting and stopping the wait. `ProviderMark`, `BrandMark` and
  the tokens lose the Codex, Copilot, Gemini and OpenCode marks.
- **Tests and fixtures:** the vendor drivers' tests, the fake Codex and ACP servers, `e2e/fake-providers/`,
  about 500 recordings under `packages/core/test/fixtures/recordings/{codex,copilot,gemini,opencode}`,
  the login fixtures, and `isolate-providers.ts` go.
- **Docker:** the image stops installing Codex, Gemini CLI, Copilot and OpenCode and their homes.
- **Design references:** 32 screens (Codex and Copilot chats, continued chats, rotation, equivalences,
  retirement) with their 64 screenshots and 8 generator tools are removed; 21 screens about providers,
  first run and limits are redrawn for Claude alone.

**SQLite:** `MIGRATIONS` in `db.ts` is append-only (the array index is the schema version), so no
entry is removed. `chats.provider`, `chat_entries`, `provider_limits`, `provider_moves` (now the wait
queue) and `flow_runs.provider` stay. `chat_entries` goes unused.

### 2. Several Claude accounts, with `@claudio/accounts`

What claude-swap did for Agentry, rebuilt on what Claude Code ships for programs. Its study is in
`~/Escritorio/claude-swap` (MIT, © 2026 Onur Cetinkol); Claudio re-implements the ideas, it copies
no code, and credits claude-swap in the package's README.

**An account** is one of three kinds:

| Kind | How it is added | What a `claude` process gets | Identity |
|---|---|---|---|
| `login` | `claude auth login [--email]` run with `CLAUDE_CONFIG_DIR=<account dir>` | `CLAUDE_CONFIG_DIR=<account dir>`; the CLI refreshes its own tokens there | `claude auth status --json` in that dir: email, organisation, plan |
| `token` | a `claude setup-token` token pasted once | `CLAUDE_CODE_OAUTH_TOKEN` | the alias the person gives it |
| `api-key` | an API key pasted once | `ANTHROPIC_API_KEY` | the alias; no usage limits to read |

- **The default account** is the CLI's own config dir (`CLAUDE_CONFIG_DIR` or `~/.claude`), so a
  fresh install works with nothing to set up. A token saved through setup (#228) becomes a `token`
  account.
- **Account dirs** live under `<data>/accounts/<id>/`, made the way Agentry's `account-config.ts`
  made them at `8c52aef25`: `settings.json`, `CLAUDE.md`, `keybindings.json`, `agents`, `commands`
  and `skills` symlinked from the default dir, and **`projects/` always linked**, so every account
  writes its transcripts where Claudio reads them and a session started on one account resumes on
  another with `--resume`.
- **Secrets** of `token` and `api-key` accounts are a `0600` file inside the account's own dir, the
  same protection Claude Code gives its own `.credentials.json`. Claudio never reads, copies or
  writes a `login` account's credentials: only the CLI does.
- **Nothing is global.** Each process is started with its account's environment, and the variables
  of the other kinds are removed from it (`child-env.ts`). Two chats can run on two accounts at the
  same time. A live chat stays on its account until it is launched again.

**Usage per account** comes from two sources, both within the one rule (events and files the CLI
writes):

- The `rate_limit_event` Claude emits on stream-json (`rate_limit_info`: `status`, `resetsAt`,
  `rateLimitType`, `utilization`) and a result with a 429. This is the live, authoritative reading,
  written as a turn runs.
- **The CLI's own `cachedUsageUtilization`**, the block the signed-in CLI caches in its config
  (`~/.claude.json` / the account dir's config): `fetchedAtMs`, and per window (`five_hour`,
  `seven_day`) `utilization` and `resets_at`. Since each account is its own `CLAUDE_CONFIG_DIR`,
  reading that dir's cache gives a **last-known reading for an account that has not run a turn in
  this session** — the gap the stream alone leaves. It is an undocumented cache, so it is best-effort
  and stamped with its `fetchedAtMs`: a fresher stream reading always wins, and a reading older than
  its window's reset reads `unknown`.

The latest reading per account and window is current state in `<data>/accounts/limits.json`, written
atomically, an older reading (by its stamp) never replacing a newer one; the history is rows in the
existing `usage_history` table, and switches in the existing `rotation_events` table (neither was
ever dropped; no migration is needed). An account with neither a stream reading nor a cache reads
`unknown`.

**Choosing an account**, at every launch of a chat that is not pinned:

- keep the current account while its binding window (the higher of 5 h and 7 d) is under the
  threshold (default 90 %);
- otherwise take the enabled account with the most headroom; a candidate must be at least 10 points
  under the threshold (hysteresis), and there are at least 300 s between two switches unless the
  current account is exhausted;
- an exhausted account (a `rejected` event or a 429) is skipped until its `resetsAt`; an `unknown`
  one is allowed;
- strategies `best` (the default), `next-available` and `consume-first` (the one whose weekly window
  resets soonest);
- per-project rotation policies (an ordered list of accounts and a threshold), as Agentry's
  `account-config.ts` had them, override the global order;
- a chat pinned to an account keeps it, and at a limit rotates only within its policy.

**At a limit** (`limit-hit`): the account is marked exhausted until its reset, the next account is
chosen, and `replayLastTurn` replays the turn in the same chat, resumed on the new account, with
CW-37's `limitRequested` and `limitReplays` counters. A person's chat does it when `rotateOnLimit`
is on (the default); automated work always does. When no account is left, the wait half of
`rotation.ts` (renamed `LimitWaits`) takes over until the earliest reset.

**The package** `packages/accounts` (`@claudio/accounts`) depends on `@claudio/shared` only. It is
built as `@agentry/accounts` in stage A and renamed with every other package in stage R:

- the account store (`accounts.json`, settings-shaped), the account dirs and their links;
- `envFor(account)`, the environment a process needs;
- `identify(account)`, through `claude auth status --json`;
- `login(account)`, which runs `claude auth login` in the account's dir and hands back what the
  person has to open or paste, the way the setup flow's device sign-ins do;
- `observe(account, reading)` and the readings store;
- `choose(accounts, readings, settings, policy)`, pure;
- a `claudio-accounts` binary: `list [--json]`, `add [--token -|--api-key -] [--alias]`, `login`,
  `remove`, `enable`, `disable`, `alias`, `status [--json]`, `pick [--json]`, and
  `run <account> -- <claude args>`, which starts `claude` with that account's environment.

The binary and Claudio share the data directory, so an account added in the terminal shows in the
app.

**What is lost against claude-swap**, by decision 8: no usage reading for an idle account, no spend
amounts of `extra_usage`, no per-model windows beyond Opus and Sonnet, and no switch of an account
under a running `claude`. Every one of them needs an undocumented endpoint or a credential swap.

**Agentry's code from `8c52aef25` that is reused:** `account-config.ts` (dirs, links, policies,
`pickAccount`), the Accounts page and `pages/accounts/**` without the claude-swap setup card, the
usage chart, `lib/usage-history.ts`, `usage-history.css`, the `accountsConfig` locales, the
`rotation_events` and `usage_history` methods of `db.ts`, and the `DesktopCuentas` and
`MobileCuentas` references. `accounts.ts`, `cswap-install.ts`, `cswap-pin.ts`, `lib/cswap.ts`, the
claude-swap install in Docker and `CSWAP_BIN` do not come back.

**Security:** every account write route (add, sign in, remove, enable, alias, settings, policies) is
forbidden to a chat's own token, and a token or key never leaves the server in a response, a log or
an event.

### 3. Claudio as a product of its own

Must change, because the two apps would collide at runtime:

| What | Agentry | Claudio |
|---|---|---|
| Desktop name and userData (data, logs, port, secret key, single-instance lock, keyring) | `Agentry`, `~/.config/Agentry` | `Claudio`, `~/.config/Claudio` |
| Desktop workspace | `~/Agentry/workspace` | `~/Claudio/workspace` |
| Updates and release watch | `yeyo11/agentry` | `yeyo11/claudio` |
| Linux package (`appId`, `executableName`, `.desktop`, metainfo, `StartupWMClass`, `.deb` name) | `io.github.yeyo11.agentry`, `agentry` | `io.github.yeyo11.claudio`, `claudio` |
| `scripts/install.sh` | `agentry` | `claudio` |
| Tailscale Serve port | 8443 | 8444 |
| API dev port, web dev port | 8787, 5173 | 8797, 5181 (`strictPort`) |
| e2e port | 8799 | 8809 |

Ports chosen on 2026-10-15 (owner) to collide with neither Agentry (8787, 5173, 8799, 8443) nor the AVG stack on the same machine (8788 for its Agentry container, 8443 for its Caddy).
| Docker image, compose host port, Helm chart, Caddy upstream | `agentry`, 8787 | `claudio`, 8797 |
| Worktrees and branches | `task/<key>`, `agentry/<name>-<id>` | `claudio-task/<key>`, `claudio/<name>-<id>` |

And, by decision 6, everything else: `@agentry/*` → `@claudio/*`, `AGENTRY_*` → `CLAUDIO_*`
(including the per-chat `CLAUDIO_API_URL`, `CLAUDIO_CHAT_ID`, `CLAUDIO_API_TOKEN` and the
`/proc/*/environ` scan in `processes.ts`), the MCP server `claudio` (`mcp__claudio__*`), the chat
origin value, the user agent, the VAPID subject, the auth realm, localStorage and service-worker
keys, the PWA manifest and `index.html`, icons, the brand art, every "Agentry" in the copy (about 212
per locale), README, CLAUDE.md, CONTRIBUTING.md and `docs/`, release-please (`package-name`,
extra files), the workflows, and a fresh `CHANGELOG.md` (the release-please manifest restarts at
`0.1.0`).

Stored values that change meaning (the chat origin, storage keys) need no migration: Claudio starts
with an empty data directory.

## Orchestrations

One feature branch, **`feat/claude-only`**, in the clone at `~/Escritorio/claudio`. Nothing is
pushed to GitHub: the owner creates Claudio's repository later. Every
orchestration starts from the head of that branch and merges back into it. Code-writing workers run
on `claude-sonnet-5-5` (the exact id); the audit between stages runs on `claude-opus-5-5`. Every task
runs `pnpm typecheck` and the tests of the packages it touches; no worker runs `pnpm e2e`. The full
`pnpm test`, `pnpm build` and `pnpm e2e` run once at the end.

The rename comes **last**: renaming the package scope touches every import, and running it beside
the other stages would make every merge conflict.

### S · `claudio-strip` (remove other vendors)

- `s1` shared types: remove the other vendors' and move/handoff types, narrow `DecisionPointId` and
  `SETUP_TOOLS`; add nothing yet. Owns `packages/shared/src/types.ts` and the schemas.
- `s2` core deletions: the vendor drivers, fixtures, recordings, their tests; `registry.ts`,
  `detector.ts`, `providers/settings.ts`, `setup/*`, `secret-vault.ts`, `paths.ts`. Depends on s1.
- `s3` core runtime: `rotation.ts` reduced to waits, `WorkProviders` replaced, chains gone in
  `orchestrator.ts`, `flow.ts`, `assistant.ts`, `chat-service.ts`, `chats.ts`, `live-chat.ts`,
  `chat-records.ts`; the three decision points; `project-settings.ts`; `index.ts`. Depends on s2.
- `s4` API: the removed routes, the renamed wait routes, `openapi/routes.ts`, `security.ts`,
  regenerated schemas, README rows, API tests. Depends on s3.
- `s5` web and UI packages: the removed components, Settings → Providers as a Claude card, the
  limit banner, New chat, the Decisions tab, the setup assistant, the marks, i18n en/es, web tests
  and fixtures. Depends on s4.
- `s6` e2e, Docker and docs: `e2e/fake-providers/` and the provider specs, `e2e/run.mjs`,
  `setup.spec.mjs` rewritten around Claude, the Dockerfile and Compose; `docs/providers.md` reduced to
  Claude, `plans/multi-provider.md` marked as Agentry history, the design references. Depends on s4.

### A · `claudio-accounts` (several accounts), depends on S

- `a0` facts, the owner with real accounts, before `a2` builds on them. **Done
  (2026-10-15):** `claude auth login` per dir, `auth status --json` for a `login` account, and
  `cachedUsageUtilization` captured and recorded, scrubbed, in
  [reports/accounts-a0.md](../reports/accounts-a0.md). Corrections it carries: a `login` account
  already has its email/org/plan, so an alias is only for `token`/`api-key` accounts; and
  `cachedUsageUtilization` is confirmed usable but can be stale (the sample's resets were in the
  past), so it is stamped and a window past its reset reads `unknown`. All captured except an `api-key` account (none available). Recorded as fixtures with the scrubbing of
  [plans/multi-provider.md](multi-provider.md) phase 3:
  - what `claude auth login` prints and asks for with `CLAUDE_CONFIG_DIR` set (a URL, a code to
    paste back), and how it ends;
  - `claude auth status --json` for a `login` dir, a `setup-token` and an API key;
  - a real `rate_limit_event` near and at a limit (its window keys: `five_hour` and `seven_day`, not
    the `"5h"` of today's fixtures);
  - `--resume` of a session started on one account, from another account's dir with the linked
    `projects/`.
  - the shape of `cachedUsageUtilization` in a real account dir's config (the window keys actually
    present, whether it is written without a turn, how `fetchedAtMs` moves), to confirm it is a
    usable idle-account reading before `a2` relies on it.
  A fact that contradicts this plan becomes a correction here before `a2` starts.
- `a1` shared types: `Account` (`id`, `kind`, `alias`, `email`, `organization`, `plan`, `enabled`,
  `signedIn`, `limits`), `AccountsSettings` (`rotateOnLimit`, `threshold`, `hysteresis`,
  `cooldownSeconds`, `strategy`), `RotationPolicy` and its request, `UsageHistoryPoint`,
  `AccountSwitchedEvent`, `RunAccountRotatedEvent`, `ChatStartOptions.account`,
  `Execution.account`, `Overview.accounts`; schemas regenerated.
- `a2` `packages/accounts`: the store, the dirs and links (from `account-config.ts`), `envFor`,
  `identify`, `login`, the readings (stream events, and `cachedUsageUtilization` read from each
  account dir's config as the idle-account fallback, stamped and best-effort), `choose`, the binary,
  and their tests against a fake `claude` that honours `CLAUDE_CONFIG_DIR`. Depends on a0, a1.
- `a3` core: `child-env.ts` and the Claude driver launch with the chat's account; `account` on
  chats, executions and records; choosing at launch; the limit path in `rotation.ts` (mark, choose,
  replay, then wait); readiness of Claude from the accounts; `usage_history` and `rotation_events`
  written again; `Overview.accounts`. Depends on a2. Tests: a limit with a second account replays in
  the same chat on it; with none, it waits; a pinned chat rotates within its policy; a person's chat
  follows `rotateOnLimit`; two chats run on two accounts at once; no process ever carries two
  accounts' variables.
- `a4` API: `GET /accounts`, `POST /accounts` (a `login` account, answering a sign-in session),
  `POST /accounts/token`, `PATCH /accounts/:id`, `DELETE /accounts/:id`, `GET`/`PUT
  /accounts/settings`, the policies, `GET /accounts/usage-history`, `GET /accounts/events`; the
  Accounts tag, a summary per route, README rows, the chat-token denials, API tests. Depends on a3.
- `a5` web: the Accounts page from `8c52aef25` on the new API, with the sign-in panel of the setup
  flow for `login` accounts; the status bar's `AccountCard`; New chat's account picker beside
  effort; Settings → Account; Home's limit widgets per account; the phone header; locales en/es
  and fixtures. Depends on a4.
- `a6` the rest: the MCP `list_accounts` tool (CW-33's compact fields), `e2e/specs/accounts.spec.mjs`
  with the fake CLI (`FAKE-LIMIT` on one account, the replay on another), `docs/accounts.md`, the
  Cuentas references, `docs/desktop.md` and `docs/deploy.md` (an `accounts/` dir inside the data
  volume, nothing else to mount). Depends on a4.

### R · `claudio-rename`, depends on A

- `r1` runtime identity: the "must change" table above.
- `r2` the scope and variables: `@claudio/*`, `CLAUDIO_*`, the MCP server name, branch prefixes,
  storage keys. Depends on r1.
- `r3` copy and brand: i18n en/es (with the glossary), `index.html`, the PWA manifest, icons and
  brand art, desktop dialogs. Depends on r2.
- `r4` docs and release: README, CLAUDE.md, CONTRIBUTING.md, `docs/`, the parity fixtures,
  release-please, the workflows, a fresh changelog, `docs/status.md`. Depends on r2.

### Final

The full `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm e2e` (with its own port), the Docker
image built once, then the owner creates `yeyo11/claudio` and the branch is pushed as Claudio's
`main`.

## Risks

| Risk | What holds it |
|---|---|
| A process gets the wrong account, or two accounts' variables | `envFor` builds the whole account environment and `child-env.ts` strips the other kinds; a test per launch path (driver, decision `cli`, detector, flow, assistant) |
| A resumed session does not find its transcript on another account | `projects/` is always linked; `a0` records `--resume` across account dirs before anything builds on it |
| `claude auth login` needs a terminal Claudio cannot drive | `a0` records it; if it does, a `login` account is added from the `claudio-accounts` binary and `token` accounts stay available in the app |
| Usage readings are per account but `provider_limits` is per provider | Claude's provider limit is derived from the chosen account's reading; `provider_limits` keeps the last one for the status bar |
| Automated work that used to wait now fails | Waiting stays the floor when no account has quota; `holds()` covers a switch in progress |
| A Claudio build updates itself into Agentry, or the tunnels remove each other's rule | Stage R's runtime table, checked by running both desktop apps side by side before release |
| Both apps work on one repository and fight over worktrees and agent files | Different branch and worktree prefixes; agent files under `.claude/agents/` are still shared, said in the README |
| An old Agentry data directory is pointed at Claudio | Not supported: Claudio starts empty. `providers.json` and project settings ignore unknown keys so a copied file does not break the start |
| The rename breaks e2e selectors or parity fixtures | The rename keeps the class names the e2e specs select; fixtures are regenerated, never edited by hand |

## Related

[[plans/multi-provider.md]] · [[accounts.md]] · [[plans/managed-claude-swap.md]] · [[pinned-chat-rotation.md]] · [[plans/limit-resume.md]] · [[providers.md]] · [[desktop.md]] · [[deploy.md]] · [[status.md]]
