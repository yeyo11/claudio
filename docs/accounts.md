---
created_at: 2026-10-15T18:00:00Z
updated_at: 2026-11-16T21:00:00Z
tags:
    - accounts
    - rotation
    - claude-code
    - convention
---
# Claude accounts

Claudio can run on several Claude accounts and move work from one to another at a usage limit. It
does so with `packages/accounts` (`@claudio/accounts`), which reaches Claude Code only through what the CLI ships for programs: a `CLAUDE_CONFIG_DIR`
per account, `claude auth login`, `claude auth status --json`, the `get_usage` control request, the `rate_limit_event` of the
stream and the CLI's own `cachedUsageUtilization`. There is no claude-swap, no call to Anthropic's
HTTP endpoints and no OAuth flow of Claudio's own. The reasons are decisions 7 to 9 of
[plans/claude-only-fork.md](plans/claude-only-fork.md); the facts it rests on, recorded with a real
account, are in [reports/accounts-a0.md](reports/accounts-a0.md).

## In short: an account's configuration and a project's rules

What follows is written for a person deciding how to set Claudio up. The sections after it say how
each part is built. The plan that settled all of it is
[plans/account-configuration-and-project-rules.md](plans/account-configuration-and-project-rules.md).

### Shared or own configuration

Every account other than the default one is **Shared** or **Own**, chosen per account on its card
(the `⋯` menu, "Use its own configuration…" or "Use the shared configuration…"). New accounts start
the way the Rotation card of the Accounts page says under **New accounts start with**: Shared,
unless you changed it.

- **Shared** (the default). The account works with the default account's configuration: the same
  `settings.json`, `CLAUDE.md`, key bindings, agents, commands, skills, rules, output styles,
  workflows, themes and hooks. They are links to the default's files, so a change made on one
  account is a change on all of them. Claudio checks the links before every run and makes the ones
  that are missing.
  - **MCP servers.** The servers you added on the default account, the project's local servers and,
    when the default trusts the project, its `.mcp.json` servers reach a shared account's chats too,
    passed at launch with the CLI's own flags. A server you turned off for a project stays off. A
    server that signs in with OAuth may still ask each account to sign in to it once (spike S6, not
    run).
  - **Plugins.** The plugins you switched on for the default account are installed on every shared
    account with the CLI's own `claude plugin` commands, in the background, and updated when the
    default's version changes. An account with a live chat waits until it is free. When an account's
    plugins are not yet the default's, its card says so in one line ("Plugins differ from the
    default: code-review@official is missing, sluice@sluice is at another version"), in warn: Claudio
    is still bringing them in line, or the last command failed and the server log says why.
- **Own.** The account keeps a configuration of its own. Switching to it starts from a copy of the
  shared files (or from nothing, if you choose so in the dialog); the dialog lists what is copied
  before anything happens. Switching back to Shared moves the account's own files aside into
  `.claudio-own/<time>/` inside the account's folder and links the shared ones again. Nothing is
  deleted.
- **History is always shared**, whatever the mode: transcripts, agent memory, file history, tasks and
  plans live in one place, so a conversation started on one account can go on on another.
- **What the card says.** Only problems: **In sync** (ok), **Needs repair** (warn: a link is missing
  or a switch was cut half-way; **Repair** finishes it) or **Conflict** (bad: the account holds a
  real file or folder where the shared one should be). A conflict is said in words, what the account
  holds and what the shared side is, with **Use shared**, which keeps the account's copy aside and
  names the folder before it does. An empty folder, or a file identical to the default's, is settled
  without asking.
- **The CLI canary.** Sharing rests on how the Claude Code CLI treats linked files. Each time the
  CLI's version changes, Claudio runs three checks in a throwaway folder (no sign-in, no turn) and the
  Accounts page shows one line with the result. A failed check is reported, not acted on: what it
  should switch off is still the owner's call (R1, open).

### Project rules

A project can have a rule about which accounts work on it. All of it is optional: with no rule,
every account may work everywhere and the choice is the one Claudio always made. The rule is in the
project's settings (**Accounts** card, "Add a rule"); the Accounts page lists every rule.

- **Allowed accounts.** One switch per account: may it work on this project. An account that is off
  is never chosen for the project's work, not even on its usage credits.
- **Preferred account.** The account the project's work goes to first while it has room, in place of
  your own preferred account.
- **Reserve.** While the project has work in progress (a running chat, an orchestration, a schedule
  due within the hour), other projects leave its preferred account a few points earlier (1 to 30),
  so the project finds room when it needs it. The reserved account's card says "Keeps headroom for
  X while it has work". When every other account is out, the headroom is used rather than leave work
  waiting.
- **Strict configuration.** Rotate only between accounts with the same configuration (all shared
  accounts are one; each own account is its own), so a chat never changes its tools half-way.
  Without it, the same configuration is only preferred.
- **A new account and the rules.** Adding an account asks whether it joins the rules that list their
  accounts ("Allow it on the projects with a rule"). On, it is added to every such rule; off, the
  rules stay as they are and the new account does not work on those projects.
- **A pin outside the rule.** Starting or moving a chat onto an account its project's rule does not
  allow is refused. A chat pinned before the rule existed keeps its pin, which the rule ignores; the
  composer's account entry says so ("The chat is pinned to X, which the project's rule does not
  allow: the pin is ignored").
- **Why this account.** The composer's Account entry, and the chat's own row in the account list,
  say why the chat runs where it runs: the project's preferred account, the least used with room,
  the only one with room, and so on.
- **A rule set under a running chat** never interrupts it: the chat moves to an allowed account
  between turns, and the transcript says so.
- **When no allowed account has room**, it depends on who is waiting:
  - **Your chat** shows its limit banner and a transcript line naming the project ("No account
    allowed on Shipcast has room until 17:00. Wait for the reset, or use another account once").
    **Use another account once** (the banner's Switch account, where the accounts the rule leaves out
    read "Not allowed by the project's rule: for one turn only") runs one turn elsewhere; then the
    rule takes the chat back.
  - **Orchestration tasks and flow runs** wait for the earliest reset among the allowed accounts,
    and their wait line names the project ("No account allowed on Shipcast has room").
  - **A schedule** skips the slot and records why in its history; the next slot is judged afresh.
  - **An OpenAI-compatible request** gets its 429 with the reset, as without rules.

## An account

| Kind | Added with | A process gets | Identity |
|---|---|---|---|
| `login` | `claude auth login`, run in the account's own dir (paste-code: open a link, approve, paste the code) | `CLAUDE_CONFIG_DIR=<account dir>`; the CLI refreshes its tokens there | email, organisation and plan, from `claude auth status --json` |
| `token` | **deprecated**: a `claude setup-token` token, pasted once. No longer offered in the app; accounts already added stay listed and keep working | `CLAUDE_CODE_OAUTH_TOKEN` | the alias the person gives it |
| `api-key` | an API key, pasted once | `ANTHROPIC_API_KEY` | the alias; no usage limits to read |

- **The default account** is the CLI's own config dir (`CLAUDE_CONFIG_DIR`, else `~/.claude`;
  `/home/node/.claude` in the image). It is listed first and cannot be removed, but **it shows only
  when it exists**: `GET /accounts` and the overview's count leave it out while it has no credential
  at all (no `.credentials.json`, and no key or token for it in the environment or the vault). A
  desktop whose `~/.claude` is signed in keeps showing it, and an expired default stays listed with
  **Sign in again**. "Has a credential" means a credentials file, a key or token for it in the
  environment or the vault, or a sign-in that failed or was confirmed. The rule lives inside
  `AccountStore.list()`, so every caller (the choice, the view, the routes) sees the same list. On
  macOS the CLI keeps its login in the keychain and writes no file, so a default with no file and no
  key counts as having no credential until a check confirms it. `GET /accounts/default`, `PATCH` and its login route work either way. The setup
  assistant and Settings → Claude Code sign in **here**, through `POST /accounts/default/login`, so the
  CLI itself is signed in (the `claude` in the terminal works); Accounts → Add account makes a separate
  login account in its own dir, for rotation
  ([decisions/claude-sign-in-paste-code.md](decisions/claude-sign-in-paste-code.md)).
- **The account in use** is the one new work would start on: what a chat's launch would choose,
  with no pin (`accounts.pick({ current: null })`), so it honours the preferred account. It is a
  field of the one account view ([below](#one-account-view)); `GET /auth` carries it as `inUse`;
  Settings → Claude Code, the status bar and the phone's More sheet read it and the provider's
  readiness, not the default dir's `loggedIn`. A default with no credential is never chosen, on any
  path.
- **An alias** is required for `token` and `api-key` accounts only: a `login` account already has
  its email.
- **Dirs** live in `<data>/accounts/<id>/`. Items of the default dir are symlinked into them, and the
  links are made **when the source exists and kept in sync before every run**, not once at creation
  (`reconcileAccountDir`, `packages/accounts/src/dirs.ts`):
  - configuration: `settings.json`, `CLAUDE.md`, `keybindings.json`, `agents`, `commands`, `skills`,
    `rules`, `output-styles`, `workflows`, `themes` and `hooks`;
  - history, always shared: `projects`, `agent-memory`, `file-history`, `tasks` and `plans`, so every
    account writes its transcripts where Claudio reads them and a session started on one account
    resumes on another with `--resume`.

  A pass runs at start-up for every account, when one is created and every time a launcher asks the
  store for the account's `ref` (before each spawn). It costs a few `lstat` calls and writes nothing
  when nothing is missing. An item whose source appears later (a `commands/` made last week) is linked
  on the next pass; a link made by hand that points where Claudio would point it is adopted, and
  recorded so removing the account undoes it. Anything else already there (a real file or dir, a link
  elsewhere) is a **conflict**: logged once, never overwritten, never deleted. Identity (credentials,
  the state file, organisation policy) and `plugins/` are not linked (a shared account's plugins are
  [reconciled with the CLI's commands](#plugins-of-a-shared-account) instead). A directory under `accounts/`
  that no account names is listed in the log and left in place.

  Two kinds of conflict are settled before a run with no question (plan §6.2): an **empty** dir or
  file, and a regular file **byte for byte the default's** (up to 1 MB), are moved to
  `<account dir>/.claudio-own/<time>/` and the default's linked, and the log says what moved where,
  once. A dir goes only if it is still empty when it goes (`rmdir` refuses one that is not, and the
  item stays a conflict); a file goes only while no live chat runs on the account, since its process
  may hold it open.
- **Configuration mode** (plan [account-configuration-and-project-rules.md](plans/account-configuration-and-project-rules.md)
  §6, `packages/accounts/src/config-mode.ts`). Each account is `shared` or `independent`, stored as
  `config.mode` in `accounts.json` (an account made before the mode existed has none and is
  `shared`). A new account starts in `newAccountConfig` of the rotation settings, `shared` unless a
  person set it through `PUT /accounts/settings`; one born `independent` starts from a copy.
  Identity is always the account's own and history always shared; the configuration items follow
  the mode: links kept by the pass above for `shared`, the account's own files, which the pass
  leaves alone, for `independent`. The default account is the source of "shared" and has no mode.
  - **To independent**: each configuration link is replaced by a copy of what it points to (an item
    missing in the account is copied too), or only removed with `start: 'empty'`. A copy is built
    under `<account dir>/.claudio-switch/` (`<item>.partial` while it is written, renamed when whole)
    and then renamed into place; links inside an item stay links. Nothing of the default dir is
    written.
  - **To shared**: each configuration item of the account's own is moved to
    `<account dir>/.claudio-own/<time>/` and the default's linked; one the default lacks is only
    moved aside. Nothing is deleted.
  - **Plan, then apply.** `GET /accounts/:id/config/plan` answers the steps (`copy`, `unlink`,
    `link`, `replace`, `move-aside`, `keep`, `skip`, `conflict`) with nothing written;
    `PUT /accounts/:id/config` carries them out one item at a time. Each step is atomic for its item;
    a step that fails reads `conflict` (`reason: 'failed'`) and the rest go on. The switch is
    recorded (`config.switching`, with its start and its aside dir) before its first step, so a
    second call, or the next start of the server, finishes one cut short; a run with nothing left to
    do plans only `keep` and `skip`.
  - **Use shared.** `POST /accounts/:id/config/items/:name` `{ use: 'shared' }` (planned by
    `GET …/items/:name/plan`) settles one conflict: the account's item, such as the real
    `agent-memory/` older accounts have, goes aside and the default's is linked. The two are never
    merged.
  - **What is served.** `Account.config` in the `/accounts` routes' answers (not in the overview's account view,
    which every choice path would pay for: it reads every item of every dir) and
    `GET /accounts/:id/config`: the mode, each item's
    state (`linked`, `missing`, `own`, `absent`, `conflict` with its reason, `not-in-default`), a
    sum-up `state` (`ok`, `repair`, `conflict`), a switch cut short, and the dirs kept aside. Every
    write is refused to a chat's token; reads are not.
  - Removing an account deletes its dir, the copies kept aside in it included.
- **The MCP overlay of a shared account** (plan §6.4, D5; `packages/accounts/src/overlay.ts`,
  `packages/core/src/account-overlay.ts`). What the default's state file holds as configuration
  cannot be linked (the file also holds the account's identity), so a process of a `shared`,
  non-default account is handed it at spawn through documented flags:
  - **`--mcp-config`, never `--strict-mcp-config`**: the default's user-scope servers, the project's
    local servers, and, only when the default's state file trusts the project, the project's
    `.mcp.json` servers (the files from the working folder up to the checkout, the nearer winning),
    less those the person turned off for the project (`disabledMcpServers`, `disabledMcpjsonServers`).
    A repeated name ranks local over project over user, as the CLI does. A server given by the flag
    connects without the account's trust (spike S3e), so a project server's `headersHelper` runs on
    the shared account as on the default (B3); the flag's definition replaces a same-named one with
    no duplicate (S4), so a server the account has of its own under the same name is shadowed: a
    shared account runs the default's configuration. Strict mode would drop the account's claude.ai
    connectors and the project's `.mcp.json` (S4), so it is never used.
  - **The one `--settings` file**: `enabledMcpjsonServers`, `disabledMcpjsonServers` (with the
    project servers turned off by `disabledMcpServers`) and `enableAllProjectMcpServers` from the
    project's entry, so a project server the person turned off stays off when the account's CLI reads
    `.mcp.json` itself (B5). A guarded process gets one file holding the guard's settings with these
    keys under them: two `--settings` flags do not merge, the last wins (S3f). If the guard's file
    cannot be read, the guard's file is passed alone.
  - **When**: every process of a shared account that loads the servers the CLI finds on its own (a
    chat that chose no servers, Claudio's own server and callers' additions joined into the same file,
    theirs winning a name). Not for the default account, an independent one, an account mid-switch, a
    chat that chose its servers (strict, and its definitions come from the default's files already),
    or a confined chat. `CLAUDIO_ACCOUNT_OVERLAY=off` turns it off for the server.
  - **Cached** on the state file's mtime and size, and on those of the project's `.mcp.json` files, per
    working folder: a spawn with nothing changed reads no file. The state file is only read.
  - **Not carried**: project trust itself (no documented way; issue #79707) and
    `hasClaudeMdExternalIncludesApproved` (S7: per project in the state file, no setting or flag), so
    an external `@import` in a project's `CLAUDE.md` is still skipped on a shared account; the log
    says so once per project.
  - **Undocumented keys.** The overlay depends on key names of the state file (listed in
    [cli-surfaces.md](cli-surfaces.md#the-state-file-keys-the-overlay-reads)). A shape it does not know gives
    no overlay and one log line, and `packages/accounts/test/overlay.test.ts` pins the shapes.
  - **Files**: `<data>/mcp/overlay-<chat id>-<hash>.json` and `….settings.json`, mode 0600 (server
    definitions carry headers and tokens), replaced at the chat's next spawn and removed with the chat
    and, at start-up, for every chat with no live process. No route serves them and nothing logs their
    content.
- **Writes keep the links.** Claudio's own writers (`writeAtomic` in `packages/accounts` and in
  `packages/core/src/config`) write the file a link ends at, so saving `settings.json`, `CLAUDE.md` or
  an agent file from Settings does not replace the link with a plain copy.
- **Secrets** of `token` and `api-key` accounts are a `0600` file in the account's own dir and are
  in no API answer. Claudio never reads, copies or writes a `login` account's credentials: only the
  CLI does.
- **Nothing is global.** The account is chosen per process, and the variables of the other kinds
  are removed from its environment, so two chats can run on two accounts at once. A live chat stays
  on its account until it is launched again.

## One account view

Until 2026-10-29 the account in use and its limits were computed on several paths that disagreed
(the audit's §2): the status bar said an account was near its limit because the last
`rate_limit_event` of *any* chat, on any account, had reached 60 %, while the account's own card drew
a fine bar. D2 of [plans/regression-fixes-2026-10-29.md](plans/regression-fixes-2026-10-29.md) cut
that to one fact, the account's own reading, and one place that derives everything from it.

- **`Core.accountView()`** answers an `AccountView`: `inUse` (the account new work starts on, with
  its own `limit` and `plan`), `inUseReason` (why `inUse` is null: `limit` when an enabled
  account has a credential, `signed-out` otherwise), `accounts`, `atLimit` (every enabled,
  signed-in account is out), `nextReset` (the earliest reset among those) and the `settings`.
  `overview.accounts` is that view, and `GET /auth` names its `inUse`; the status bar, the account
  chip, the provider dot, the phone cards, the chat's limit banner and the Accounts page read it and
  nothing else. It lists the accounts once and picks among that same list (`pick({ accounts })`,
  whose model check reads it too); the login a config dir is signed in as is read from its
  `.claude.json` again only when that file's mtime or size moves (`cliLogin`). Before 2026-11-07 a
  view listed twice and a pick once more per candidate, each listing parsing every account's files
  (R12 of [ci-and-regression-open](plans/ci-and-regression-open.md)).
- **Claude's provider limit is derived from it.** The limit the dashboard shows for Claude is the
  in-use account's reading, or the reading of the account back first when every one is out. The
  provider-wide reading is gone (`ProviderLimits`, the probe that fed it, the handshake reading, the
  detector's TTL re-read and `accounts-at-limit.ts`): a `rate_limit_event` feeds only the account
  its chat ran on. The provider detector reports `degraded` for Claude when `atLimit`, and the
  decision route waits when the view says so, both reading the same view.
- **One set of thresholds** (`packages/accounts/src/thresholds.ts`): an account is `near` from 60 % of
  its binding window and `exhausted` at 100 %; usage bars are neutral under 60 %, warn from 60 % and
  bad from 75 % or when exhausted. `isOut` is the single definition of "out" (exhausted, with the
  reset ahead or unknown) that the choice, the view and the decision route share. The rotation
  threshold is not in that file: it is the person's setting, or a policy's.
- **`accounts.changed`** is emitted when an account, a reading, a sign-in or the rotation settings
  change (`AccountStore.onChange`), at most once every 250 ms. The web refreshes the accounts, the
  overview, `/auth` and the providers on it, so no page polls for it any more; Claude's provider
  status is looked at again on the same signal. A reload that finds another process wrote the
  account files tells the listeners too.

## Usage

Per account and window (`five_hour`, `seven_day`), as a 0-1 utilization with its reset. Three
sources, the newest reading winning:

1. **`get_usage`, the CLI's own answer.** Refresh asks the CLI itself, with the `get_usage` control
   request of its stream-json protocol, in the account's own environment (a login account's
   `CLAUDE_CONFIG_DIR`, a token account's `CLAUDE_CODE_OAUTH_TOKEN`). No prompt, no turn, no tokens,
   and never an HTTP call of ours ([decisions/get-usage-control-request.md](decisions/get-usage-control-request.md)).
   `usageOf` in `packages/accounts` runs it with a 30 s timeout and ends the process.
2. **The stream.** Every turn emits a `rate_limit_event`, near a limit or not, and a result that
   died on a limit carries a 429. This is the live reading while a chat runs.
3. **The CLI's cache.** `cachedUsageUtilization`, in each account dir's config, is the reading of an
   account that has not run a turn and was never refreshed. It is stamped with its `fetchedAtMs`, and
   a window whose reset has passed reads `unknown`, because the cache can be days old. It stays as
   the fallback; Claudio never writes it.

A `get_usage` reading is the freshest truth while it is newer than the stream's, and a newer stream
reading takes the windows back. What only `get_usage` states is kept apart (`limits.cli` on the
account) so a stream reading does not erase it: an answer of `rate_limits_available: false` updates
`cli` alone and never clears an exhausted state the stream recorded: the plan (`subscription_type`), the weekly limits
scoped to one model, and the credits. An API-key account answers `rate_limits_available: false`: it
has no subscription limits, and its reading says so (`cli.available: false`). So does a
`claude setup-token` token on a real account (checked 2026-10-17): its scope reaches inference only,
and the CLI answers `rate_limits_available: false` with no plan. Its card says the CLI gives no
usage for a token, and its limits appear once a chat runs on it (the stream's `rate_limit_event`).

### Refresh

`POST /accounts/refresh` reads every enabled account, one after the other, each with its own
timeout, and answers `{ accounts, failed }`; `POST /accounts/:id/refresh` reads one. A login
account's sign-in is read again too (`claude auth status`). An account the CLI could not read keeps
its last reading and is named in `failed`, which the Accounts page shows as a toast. The page's
Refresh button calls the first, and opening Accounts calls it once when an enabled, signed-in
account has no `get_usage` answer or one older than 10 minutes. Both are refused to a chat's token:
each starts a CLI process.

### Per-model limits and credits

- **Scoped limits.** A plan can carry a weekly limit that counts one model only (`Fable` at 5 % of
  its own allowance, say). The CLI lists them in `rate_limits.limits[]` as `weekly_scoped` with the
  model's display name; they are kept as `limits.cli.scoped[]`, never as an entry of `windows`.
  The account's own state and binding window come from the session and weekly windows alone, so a
  spent Fable limit does not mark the account exhausted for Sonnet. The stream follows the same
  rule: a `rejected` event with a `seven_day_<model>` type goes to `scoped`, never to `windows`. A
  rejection that came from extra usage (overage) blocks every model, but no window is spent, so it
  leaves the account out for the time its event gives, as the account's own `outUntil`, without
  naming a window. Rotation applies a scoped limit
  only to a chat that runs that model: `choose` skips an account whose limit for the chat's model is
  at 100 % until its reset, and waits for that reset when every account is out of it. The model is
  matched by its display name inside the chat's model id.
- **The `overage` state and the overage window.** A spent plan whose credits are on (`extra_usage.is_enabled`,
  the typed answer, which wins over the observed `spend.enabled`) and under their cap, with no
  refusal since that reading, is `creditsCover: true` on the limit and reads `overage` through
  `accountState` (`thresholds.ts`). The folded `state` stays `exhausted`, so whatever does not read
  `creditsCover` treats the account as out, which is what the default wants. The stream's
  `isUsingOverage`, `overageStatus`, `overageDisabledReason`, `overageEnabled` and `errorCode` are kept
  as `overageHints`, carried over events that have none, and never make the state alone.
  `seven_day_overage_included` is a window of the plan, kept apart as `overageHints.included`: it is
  neither a scoped model (it showed as `Overage_included` before) nor a window the state folds from.
- **Credits.** `rate_limits.spend` (amounts with their currency and exponent) and `extra_usage`
  (`credits_ever_enabled`, `spend_limit_reached`) become `limits.cli.credits`: enabled, used and
  monthly limit in minor units, currency, decimal places, whether the cap is reached and why they
  are off. The card shows nothing for credits never set up, "No extra credits" once they were and
  are off, "Credits · 12.30 of 50.00 € this month" when on, and a warn tag "Limit reached" at the
  cap.

The card names the plan as a tag beside the name (`Max`, `Pro`, `Team`, `Enterprise`, `API key`),
draws a bar for the session, the week and each scoped limit ("7 days · Fable") with the usual tones
(neutral under 60 %, warn from 60 %, bad from 75 %), then the credits line and how old the reading is.

The latest reading per account is `<data>/accounts/limits.json`; the history is the `usage_history`
rows and each switch or wait a `rotation_events` row. An account with neither reading is `unknown`,
and an unknown account is allowed.

## Sign-in state

An account's `signInState` says whether its sign-in can be relied on, beside `signedIn`:

| State | Meaning | Chosen? |
|---|---|---|
| `ok` | signed in, nothing against it | yes |
| `unknown` | nothing read yet | yes |
| `expired` | a run on it failed to authenticate (`authFailedAt` in `accounts.json`) | no |
| `incomplete` | its credentials file has no non-empty `refreshToken` key (a broken copy) | no |

`claude auth status` keeps answering `loggedIn: true` for a dead session, so the state is not read
from it. Nor is the free `get_usage` check a judge of a refused credential: it can **confirm** one
but not refuse it (below). Claudio only looks at whether the credentials file exists, its modification time and
whether the `refreshToken` key is non-empty, never its value. `expired` clears when the file
changes after `authFailedAt` (a new sign-in) or when a later run on the account succeeds; the
Accounts page and the status bar card show "Sign-in expired" with a "Sign in again" action
(`POST /accounts/:id/login`) that reopens the sign-in panel. A default account found refused by a run
counts as signed out, and readiness falls back to another signed-in account.

### Checking a credential

Checked 2026-10-18 on CLI 2.1.302, the `get_usage` control request answers **success with
`rate_limits_available: false`** for an invalid OAuth token, an invalid API key, no credential at all
and a network that is down. Only a good subscription login returns the plan's limits, so it cannot
tell a refused credential from an unreachable network. The four raw answers are fixtures in
`packages/accounts/test/fixtures/get-usage-refused-*.json`. Therefore:

- For a **login or an OAuth token**, `get_usage` **only confirms**: a good answer records `checkedAt`
  on the account and clears an `expired` mark. It never marks one expired; that comes from a failed
  run.
- An **API key** (an `api-key` account, or the default account when `ANTHROPIC_API_KEY` is in its
  environment) is asked of Anthropic with the vendor's official SDK, `models.list({ limit: 1 })`:
  documented, free, and `401` for a bad key. This is the SDK used for this check only, never to
  drive the agent. `200` confirms the account; `401` is `refused` and marks it `expired`, as a run
  that failed at authentication does; a network error or any other status is `unknown` and changes
  nothing. It is skipped (`unknown`) when `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK` or
  `CLAUDE_CODE_USE_VERTEX` is set: the key is then not Anthropic's to judge.
- A key is checked **again when it changes**: the store keeps `checkedFingerprint`, a sha256 of the
  key (never the key), beside `checkedAt` in `accounts.json`, and an account whose key no longer
  matches lists `checkedAt: null`.
- An **OAuth token from the environment** (`CLAUDE_CODE_OAUTH_TOKEN`) has no free documented check,
  and claude.ai's internal endpoints are out of bounds. Until it is confirmed Settings tags it
  **Not confirmed** (neutral, never "Signed in") and says Claudio confirms it with the first chat.
  An invalid token is refused before any token is generated, so that first run costs nothing and
  marks the account expired; a turn that succeeds on an account never confirmed confirms it.
- The account in use is checked at most every 30 minutes, beside the provider refresh and never
  inside `/health` (a probe spends nothing, [providers.md](providers.md)). `POST /accounts/:id/refresh`
  is the same free check on demand (for a key it also asks Anthropic, and a refused key answers the
  account as `expired`), and answers `502 accounts.check-failed` when the CLI could not run.
- **Check** in Settings → Claude Code → Sign-in is shown for a key and calls that route. For the
  rest the button is **Send a test message**: it runs the paid `POST /auth/verify` (a real `haiku`
  prompt), only on that click, and records `checkedAt` on the account in use.
- A sign-in that succeeded or a key that was saved also records a check.

## Choosing and switching

- A new chat that does not name an account takes the one `choose` returns, in this order of
  precedence:
  1. **A pin.** A chat pinned to an account keeps it while it can run; otherwise it rotates only
     within its policy.
  2. **The preferred account** (`preferred` in `accounts.json`, set from an account's **Use this
     account** on the Accounts page) while it has room and the chat's policy lists it: under the
     threshold to stay on it, `hysteresis` points under it to come back to it. A pin wins over it,
     and a project policy that does not list it wins too.
  3. **The strategy.** With `least-used` (the default) the enabled account with the most room; with
     `order` the first in the order, which is the policy's, else the global `order` setting (every
     enabled account once, reorderable on the Rotation card; an account added later follows the
     listed ones). Staying put wins over the order: the current account is kept while its binding
     window is under the threshold.
- `PUT /accounts/settings` validates `preferred` (an enabled account's id, or null for none) and
  `order`. Removing an account takes it out of both, and out of every policy.
- **Project rules (`RotationPolicy`, `accounts.json` `policies`).** A rule governs some projects
  (and optionally the chats of no project) through `projects` and `looseChats`, and every field
  beyond them is optional, so no rule is active until a person writes one and a policy with none of
  the new fields chooses exactly as it did before (a test freezes that, `choose-rules.test.ts`).
  - `order`: the accounts that may work on the projects, and their order. Absent, every account may.
  - `threshold`: the global one replaced for the projects.
  - `preferred`: the account the projects prefer, in place of the person's own preferred account.
    It must be one of `order`, or any known account when there is no `order`.
  - `reserve: { percent }`: headroom kept on the rule's account (`preferred`, else the first of
    `order`; `reserveAccountOf`) while the projects have work in progress: the work of other projects
    leaves that account `percent` points of utilization earlier. `percent` is 1 to 30
    (`RESERVE_CAP`); the rule needs a `preferred` or an `order` to know the account; at most one rule
    reserves on an account. The headroom is released when every other account is out
    (`why.basis: 'reserve-released'`).
  - `strictConfig`: rotate only among accounts that share the configuration of the account the work
    is on; stored only when true.
  - `PUT` replaces the whole rule and checks it again, so a field left out is removed. Removing an
    account takes it out of `order`, clears it from `preferred`, and drops a reserve left with no
    account (or on one another rule reserves) rather than keep one that protects nothing. A hand-edited
    file is read defensively: a `preferred` that is not a string, a `reserve` out of range or a
    `strictConfig` that is not `true` is read as absent.
  - **A pin never overrides a rule (D10).** A chat started, resumed or forked with an `account` the
    rule of its project does not allow is refused `409` with `code: account-not-allowed`, before a
    process or a chat exists; so is a person's switch from the composer, `409` with
    `code: not-allowed` (`POST /chats/:id/account`). A project with no rule, or a rule with no
    `order`, allows any account. Pins that already exist are not touched: `choose` ignores one the
    rule does not allow, as before.
  - **Reasons.** `AccountSwitchReason` gains `reserve` (the account is under the work's threshold
    but another project holds headroom on it) and `rule` (the work's account is not one the rule
    allows: recorded when a chat moves at the end of its turn). Every `Choice` carries `why.basis`;
    the Accounts page says the reasons in words and `accountsConfig.json` has a label for each
    `basis` and `passedOver.because`.
- **Rules at work** (`packages/core/src/project-activity.ts`, `ChatManager`, `ProviderRotation`,
  `Scheduler`). Every account choice of a chat passes its project and its rule to `pick`.
  - **Work in progress** per project is read from memory only, never from a file or a row: a chat
    whose turn is running, starting or held at its limit; an orchestration `running` or `waiting`;
    a schedule whose next slot is within the hour (as of the scheduler's last tick). A folder's
    project is remembered for 30 s. While no rule has a `reserve`, nothing of this is read.
  - **Reserves.** A rule with a `reserve` holds it on its account (`preferred`, else the first of
    `order`) while one of its projects has work in progress; chats of no project are the key `''`
    for a `looseChats` rule. Other work leaves that account `percent` points earlier (reason
    `reserve`), and uses it when every other account is out.
  - **A rule set or changed under a chat (D9).** Never an interruption: on every change of the
    accounts' state the rules are compared with the last ones seen, and a chat with a live process
    on an account its rule no longer allows gets a pending switch to an allowed one, applied between
    turns (at once when idle, at the end of the turn when working). A chat with no process starts its
    next turn on an allowed one. Both are recorded with reason `rule` and a notice in the transcript.
    With no allowed account free, the chat goes to the rule's first usable account and meets its
    limit there, rather than stay on an account the rule forbids.
  - **No allowed account has room (D8)**, by origin. A person's chat gets a notice naming the rule
    ("no account allowed on project X has room"), with the reset and "use another account once"
    (`POST /chats/:id/account` with `once: true`: one turn on an account outside the rule, recorded
    with `data.once`, then the rule takes the chat back with reason `rule`). Automated work
    (orchestration tasks, flow runs) waits as before, and the wait's reason says
    `waiting: no account allowed on project X has room`. A schedule's slot is skipped and recorded in
    its history (a person's "run now" still goes). An OpenAI-compatible request gets its 429 as
    today. When the rule kept the work off no account, the lack of room is told as before.
- An account whose binding window is at the threshold (90 % by default) is skipped until it falls
  `hysteresis` points under it, and one that hit a limit is left alone until its reset. When a
  rejection gave no reset, `cooldownSeconds` leaves *that account* alone for the time: it is written
  on its reading as `outUntil`, so the account reads exhausted until then. There is no longer a
  global gap between switches, which held every other account back as well.
- **Credits setting.** `credits` in `accounts.json`'s settings maps an account id to
  `{ use: never | last-resort | allow, capMinor }`; an account it does not name is `never` (D3:
  credits are spent only where a person switched that on). Under `never` an account in `overage` is
  out like any spent one, a pin included. Under `allow` it is taken as an account over the threshold
  is, after those with room, and kept while the work runs there. Under `last-resort` it is taken only
  when no account has plan quota left. Both stop at `capMinor` (Claudio's cap, against
  `cli.credits.usedMinor`), and `choose` marks such a choice `credits: true`. The wait is for the plan's reset.
  A cap is in minor units of the account's currency; with a cap set and no `get_usage` spend known,
  the cap counts as reached (`creditsCapReached`): money is never spent on a guess.
- **A turn that crosses into credits (D4, t7).** `ChatManager.checkCredits` looks at a chat whose CLI
  is spending (the lead's turn is open, or background work it started still runs after the turn
  answered) when its account's reading changes (`noteAccountReading`, so the stream, a refresh, a
  probe and the idle cache all count), when a turn opens in a live process (`deliver`, and a turn the
  agent opens itself on a task notification: a kept process does not choose its account again), and
  on every change of the accounts (Core's `accounts.changed`, so a setting saved under a running turn
  applies at once). It acts when credits may pay (`creditsMayPay`): the account reads `overage`, or a
  plan window reads at or past 1 from any source while the latest word on its credits (`get_usage`'s
  `extra_usage`, or the stream's overage fields, whichever came last) says they are on; or when the
  stream hints it (`overageHint`: `isUsingOverage`, or a covering `overageStatus` beside a spent plan
  window; an `overageStatus` of `rejected` is never a hint). `isUsingOverage: false` decides nothing:
  the CLI sent it on a turn that ran on credits (docs/reports/credits-never-leak-2026-11-16.md). A
  plan read spent under running work whose last `get_usage` answer is older than five minutes asks
  `get_usage` once (no turn, no token; once per account in five minutes; not for a chat the CLI refused, nor
  for an account whose credits `get_usage` says were never set up). With only background work
  running, a refused account stops the process with a notice and a `stopped` rotation row (reason
  `credits`): there is no turn to move or replay, and the next message chooses again.
  A rejected event the CLI goes past is no limit: a successful result clears the chat's limit mark, a
  plan rejection whose `overageStatus` says credits cover it neither marks the chat nor leaves the
  account out (its windows decide), and the hint reads a rejection as credits paying only when the
  window it names reports a use at or past 1. The account's credits setting decides: `never`, Claudio's cap reached,
  or `last-resort` while another account has plan quota stop the turn at once (`stop`, the same as
  a person's Stop and a workflow subagent's limit): the chat is marked at its limit
  (`creditsStop`), the account goes on the turn's failed list, and the rotation takes it as a limit,
  recorded with `reason: 'credits'` and `data.credits` (`never`, `cap`, `quota-elsewhere`). It moves
  the turn, or waits for the plan's reset. What ran between the plan's last token and the signal is
  the cost of the check. Otherwise the turn goes on and is marked paid. No field of the CLI says a
  turn was paid from credits (docs/decisions/credits-in-the-stream.md), so Claudio marks it from its
  own state.
- **The paid-turn mark.** `spend_ledger.credits` (a migration) is 1 for a result whose turn was let
  through on credits, was stopped after crossing, or ran while credits may pay (`creditsMayPay`); the
  day's spend serves the part as `SpendState.creditsUsd`. A move onto credits (a `last-resort` or
  `allow` account chosen with `Choice.credits`) is a rotation event with `reason: 'credits'`,
  `data.credits: 'paid'`.
- **Saying it.** Each turn that goes on paying pushes a chat notice with `data.reason: 'credits'`
  (and the month's amounts), and a stopped one a notice with `data.stopped`; the transcript draws
  them as a warn line ("Paid from the credits of …", "Stopped before spending the credits of …").
  The first turn of the day on an account's credits emits `account.credits` (once per account and
  local day across the processes of the data dir, through `spend_alerts`), which the web and push
  turn into a warn notification that leads to Accounts.
- **The model the chat asked for is what the choice filters on** (`chat.opts.model`), not the one the
  CLI resolved: a chat started on `default` runs on any account, instead of waiting for one that
  offers the Opus it resolved to. A pick that finds no account able to run a named model waits.
- **At a limit**, the account is marked, another is chosen and the turn is replayed in the same
  chat, resumed on the new account. A person's chat does it when `rotateOnLimit` is on (the
  default); automated work always does. With no account left, the work waits for a reset: the
  earliest among the accounts that can run the turn (`chooseNext(...).waitUntil`), else the reset
  the turn's own account or refusal gave. An account that cannot run the model the chat asked for
  does not shorten the wait. A person's chat and a schedule's chat wait like automated work when
  `rotateOnLimit` is on, and go on by themselves; with it off they keep the banner. A person's
  wait ends the moment they write to the chat (`ChatManager` announces `person-message`, the
  rotation cancels the wait; what the rotation itself sends is no person's). A wait for a known reset holds however far away it is;
  `maxWaitHours` bounds only a wait with no reset. A housekeeping (`internal`) chat is never moved,
  replayed or waited: it runs with no persisted session, so it ends at a limit and its owner runs
  it again. A resume the runtime refuses for run slots or memory keeps the wait and tries again
  when the claim lapses (2 min), and the chat stays as it was: the banner stays, and the retry
  sends the turn that died, not the nudge, because a refused replay is no replay (`replayLastTurn`
  puts the flags, the count and the account it chose back). A wait whose chat no process has any
  more is closed `failed`.
- **The wait row is the hold** (t8 of [limit-resume-and-credits](plans/limit-resume-and-credits.md)).
  A wait is its `provider_moves` row and nothing in memory: the row keeps when it looks again
  (`next_look_at`), the turn it replays (`turn`: the text and upload ids of each message of the
  turn that died) and how many times it probed (`probe_count`). One sweeper per process
  (`ProviderRotation.sweep`) looks at the open rows whose chat it has: at the earliest
  `next_look_at`, every 30 s at the latest, and over every row when an account's reading changes.
  A known reset is looked at by then, a poll (5 min) away at the latest. A wait that knows no reset
  asks `get_usage` (no turn, no tokens) for the accounts the chat could go on with whose reading is
  older than its last look (`probeTargets`: its pinned account, else every enabled, signed-in
  subscription account), at 5, 15, 30 and then every 60 min, one probe per account at a time and
  bounded by 30 s; what they answer reaches the waits as any reading does. `maxWaitHours` gives such
  a wait up only once a probe taken past it answered nothing. A wait that knows its reset probes
  too, more sparsely: 15 min after it began, 30 min after that, then every 60 min, and never when
  the reset comes before the next probe. A person can reset an account's quota early from Claude's
  settings, and the window then starts again before the reset the refusal announced; only a
  reading says so, and before 2026-11-15 nothing asked for one, so a chat waited for the old reset
  (cause 12 of [limit-resume-and-credits](plans/limit-resume-and-credits.md)). The probe's answer is
  the account's stored reading, so the Accounts page shows the reset too. When the last probe was
  is kept in memory; after a restart the next one is counted from when the wait began, which costs
  one probe at most. A sign-in failure is not probed: only a person signs in again. A restarted process takes its rows over at its first pass: a claim a
  restart cut short is taken again once it lapses, and a row an older Claudio opened (no
  `next_look_at`) is due at once.
- **A limit survives a restart.** An execution that died on a limit records the reset it knew
  (`Execution.limitResetsAt`) beside its `cause` and account. A restored chat whose last execution
  died that way, on the account the chat is still on, is at its limit again (`LiveChat.restore`):
  the banner shows, `POST /chats/:id/wait` opens the wait, and the reset it waits for is the recorded
  one. It is not retired from memory while it is. A wait opened before the restart replays the
  turn its row kept, word for word (`ChatManager.replayLastTurn` with the stored turn); only a wait
  that kept none (opened by an older Claudio, or after the restart, when the chat no longer knows
  its turn) sends the nudge (`LIMIT_CONTINUE_TEXT`): the CLI's session has the person's last
  message.
- **The replay count** (`MAX_LIMIT_REPLAYS`, one per execution) counts replays that landed on no new
  account, between two turns that went through. A turn that completes without error resets it, and a
  move to another account is never counted nor held back by it: `chooseNext` passes over every
  account the turn died on, so a chain of moves ends by itself. Before this, a second limit after a
  wait-replay left the chat stuck.
- **A failure ends at its reset.** Each failure keeps when it happened and the reset it was
  refused with (the chat's `limitedAccounts`, and the end and `limitResetsAt` of each failed
  execution in `limitedTailAt`). It stops counting once that reset has passed, or once the
  account's reading said it was out then and says it is not now, or once a reading taken after the
  failure does not call the account exhausted (an early reset; `resetSince` in `chats.ts`);
  `chooseNext`, `roomFor` and a person's switch read the same set (`stillFailed`). The recorded
  reset decides first because the reading is the latest one: a reading taken after the reset says
  "not out" about a time the account was out, and the failure then counted until a turn went
  through. A failure with no reset recorded (a bare 429, or a reset not after the failure) counts
  until the reading says otherwise, as before. A reading taken at or before the failure (the
  refusal's own, or one kept from before the turn) is never evidence that the account is back. Until 2026-11-07 every failure counted until then, so once a wait replayed a
  turn that died again the rotation still skipped accounts whose reset had passed, and waited
  instead of moving (R11 of [ci-and-regression-open](plans/ci-and-regression-open.md)).
- **A fork keeps its account** and its pin; a fork of a chat that ran on account B does not start
  on whichever the strategy prefers.
- **A wait looks again whenever an account changes** (R10). On 2026-10-16 every account was out at
  12:44 UTC, the waits took the earliest reset they knew (13:10), and the CLI's own login restarted
  its window around 12:50 with 0 % used while twelve tasks kept waiting. Now every kept reading
  and every stored change of an account (a sign-in marked or cleared, an account enabled, added or
  removed, the settings) is announced (`AccountStore.onChange`), and so is every reset that passes
  and every poll: each open wait then asks the accounts again (`ChatManager.roomFor`) and goes on
  with the first one that has room, recorded as a `switch`. An account the turn already died on
  is a candidate again once a reading taken after the wait began says it is not out; without such
  a reading it stays passed over. Which accounts those are is read from the chat's executions
  (`limitedTail`), so a replay writes the cause (`rate-limit` or `auth`) on the execution before it
  stops the limited process (`keepLimitCause` in `chats.ts`): stopped without it, the execution
  ended with no cause and a restart forgot the account it died on
  (`orchestration-limit-account-switch.test.ts`). A reading that leaves every account out but brings a reset
  closer moves the wait's next look to it, and the row keeps that reset. Graph tasks and workflow leads go through the same path.
- **Run now.** Beside "Stop waiting", a person can end a wait by sending its turn on at once
  (`POST /limits/waits/:id/run-now`, `ProviderRotation.runNow`): on an account a newer reading
  gives room if there is one, else on the first the readings allow, passing over the accounts the
  turn died on (the person decided to try). An account whose reading says it is out is never
  chosen; with every account out the answer is a 409 `no-room` that says until when. It is
  recorded as a `switch` with `reason: 'person'`, and a chat's token gets 403.
- **At a sign-in failure** the CLI ends the turn with an error `result` whose `api_error_status` is
  401 (never read from its wording). The account is marked `expired` and the turn moves exactly as
  at a limit, replayed in the same chat on another account, with `reason: 'auth'` on the rotation
  event and a notice in the chat. With no usable account, automated work waits with the move reason
  "sign-in expired" and resumes as soon as an account can take it; a person's chat follows
  `rotateOnLimit`.
- **A workflow graph** ([orchestrations.md](orchestrations.md#the-workflow-engine)) rotates as a
  whole: its one lead session runs every task. A subagent refused at a limit or a sign-in is read
  from the workflow's journal and the agent's transcript (structured fields only) and recorded on
  the account as the stream's reading would be (`ChatManager.limitReached`); the lead's own limit
  comes from its stream. The rotation then moves the session to an account with room, or waits for
  the reset, and goes on by resuming the workflow from its cache in the same session
  (`RotationDeps.replay` → `Orchestrator.replayWorkflow`), not by replaying the lead's turn. The
  cache is visible from every account because their `projects/` directories are one.
- **A retry** of an orchestration task resumes the same chat, but the account is chosen again at
  that launch: an exhausted or expired one is skipped, and the chat's own account is kept only if it
  is usable. A limit hit on the retry moves the turn like any other.
- **On demand**, the person moves a chat from the Account section of the composer's "+" menu
  (`POST /chats/:id/account`, [chat-composer.md](chat-composer.md)). It is a new execution of the
  same session with `--resume` under the chosen account's config directory or token, as at a limit.
  An idle chat moves at once (a live process is ended between turns); a working chat queues the
  choice (`chat.pendingAccount`) and takes it when the turn ends, never interrupting it. Naming the
  chat's own account cancels a pending switch. A disabled, signed-out or exhausted account, one that
  does not offer the chat's model, or the chat's own account is refused with a 409 and a `code`; an
  account whose sign-in is `expired` or `incomplete` is refused as `sign-in-expired`, and the menu
  shows it disabled as "Sign-in expired".
  The choice is not a pin: the rotation can still move the chat at a limit. It is recorded as a
  rotation event with `reason: 'person'`. Only the person may do it; a chat's own token gets 403.
- **Removing an account** that a live chat's process runs on answers `409 account-in-use` with the
  ids of those chats in `chats` (`AccountInUseResponse`): stop them or move them first. Before this
  a removed account made the next result of that chat throw inside the fold and take the server
  down.

Settings are `<data>/accounts.json` (`GET`/`PUT /accounts/settings`): `rotateOnLimit`, `threshold`,
`hysteresis`, `cooldownSeconds`, `strategy`, `preferred` and `order`.

### A crash is a log line

A bad line from the agent no longer ends the server. The fold paths that touch an account
(`observeSignIn`, the result and the limit events) look it up with the nullable `find`, so a result
folded onto a removed account is dropped instead of throwing; the stream's line handler records a
protocol failure on that chat and fails it, not the process; and `apps/api/src/server.ts` and the
launcher (`packages/core/src/launcher/process-guards.ts`) install `unhandledRejection` and
`uncaughtException` handlers that log and keep the process up. An orchestration's refused resume used
to be one such rejection ([orchestrations.md](orchestrations.md#recovery-and-shutdown)).

## Models

The CLI's own list is the only model list. It is the `models[]` of the `initialize` control response,
which starts no turn and spends no tokens, cached per account under `<data>/accounts/models/<id>.json`
with the CLI version it was read with.

- **When it is read.** In the background at boot, for every enabled, signed-in account, with no
  account action needed; and again when an entry's CLI version differs from the running CLI's
  (`cachedModels` checks the stamp, as `entry()` does). A plan or account change refreshes it too, and
  `GET /accounts/:id/models?refresh=true` forces a read.
- **No fallback.** The hard-coded aliases, the `additionalModelOptionsCache` read in `~/.claude.json`
  and the labels guessed from `model-aliases.json` are gone. While no list exists `system.models` is
  `[]`: the picker shows a disabled "Loading models…" row and still accepts a free-text id. If the
  read fails it says the list could not be read and offers Retry, which calls the refresh route.
- **Per chat account.** A chat's popover and the resume and fork pickers read the list of the chat's
  own account (`GET /accounts/:id/models`). The overview's `system.models` is the default account's
  list, for the New chat form when no account is chosen.
- **Dedup on `value` only.** The CLI's order, `displayName` and `description` are kept as given, so
  `default` and `haiku` both show, as in `/model`.

The status bar tells signed out from the limit with `SystemInfo.auth.inUseReason` (`signed-out`,
`limit` or null), which the server sets when no account is in use: `limit` when an enabled account
has a credential, `signed-out` otherwise. "Not signed in" is shown only for the second case.

## Plugins of a shared account

`settings.json` is linked into a shared account, so `enabledPlugins` and `extraKnownMarketplaces`
already are the default's. What is per account is `plugins/`: the install records, the marketplace
clones and the cached versions, and a record's `installPath` lies under the dir of the account that
installed it, so the dir is not linked (plan decision D4). Before this, an account ran only the
plugins it was signed in with: `code-review` was missing on both of the owner's accounts and Sluice
was 0.5.0 where the default had 0.12.1 (B6, B7).

`PluginReconciler` (`packages/accounts/src/plugins.ts`) brings each shared account's plugins to the
default's with the CLI's own commands, `CLAUDE_CONFIG_DIR=<account dir> claude plugin ...`, so the
vendor's installer stays the only writer of an install record and Claudio only reads the default's
(`installed_plugins.json`, `known_marketplaces.json`, `settings.json`):

| The account | The commands |
|---|---|
| lacks a plugin the default has | `marketplace add <source>` when the account does not have the marketplace (the source is the one the default's records give: a GitHub repo, a git or https URL, or a path), `marketplace update <name>` when it does, then `install <id> --scope user` |
| runs it at another version | `marketplace update <name>` (or the update sees the old catalog), then `update <id> --scope user`. Claudio cannot pin a version: an account whose marketplace has nothing newer stays behind, is listed as `differing`, and is not asked again until a version moves |
| has a plugin Claudio installed that the default has dropped | `uninstall <id> --scope user` |
| has a plugin a person installed there, that the default lacks | nothing: it is never removed. What Claudio installed is recorded in `<account dir>/.claudio-plugins.json`, and only that is ever uninstalled |

Only the user-scope plugins of the default that its settings do not switch off are held to
(`enabledPlugins[id] !== false`): a project or local plugin belongs to a folder, and an install would
switch a disabled plugin on in the settings the two share. No command passes `-y`, so a plugin whose
marketplace declares an install command is reported as failed, never accepted for a person.

**When.** At start-up, when the default's `installed_plugins.json`, `known_marketplaces.json` or
`settings.json` changes (a watch on the default dir and its `plugins/`, a 3 s debounce, no polling),
and when the set of shared accounts changes (an account added, a switch to shared or back). One
account at a time, in the background: a spawn never waits for it, and a pass that finds nothing to do
starts no process. An account with a **live chat waits**: a CLI that is running is never given
plugins moving under it, so the log says so once and the account is looked at again on a 2 minute timer
that exists only while one waits. An independent account is never touched (it runs its own set).

**Bounded.** Each command has a 90 s timeout and closed stdin, runs with the environment of the server
minus its own variables and with no account credential (plugins are configuration), and is ended with
the server. A failed command is logged once (the same failure is not logged again) and tried again at
the next pass; a marketplace that could not be added skips its plugins' installs. `CLAUDIO_ACCOUNT_PLUGINS=off`
stops the passes (the unit tests switch them off through the preload).

**Served.** `Account.config.plugins` is `{ missing, differing }` (plugin ids), read from both dirs'
records with no process: empty for an independent account, and for a shared one a non-empty list means
a pass is waiting (a live chat), failed (the log says why) or cannot reach the default's version.

**Concurrent writers (S2b).** The plan asked whether a linked `plugins/` survives concurrent CLIs.
Twelve concurrent `claude plugin install` from two accounts with `plugins/` and `settings.json` both
linked kept every install record (three rounds), but **lost `enabledPlugins` entries of `settings.json`
in every round** (3 or 4 of 6): the CLI's read, modify and write of the settings file is a lost update.
So two plugin writers in one config dir must never run together, and the reconciler runs one command
at a time and only when something is missing. It also means a command that runs while the default's own
CLI writes its settings could lose that write; the window is milliseconds and a pass that finds nothing
to do writes nothing. [Detail](plans/account-configuration-and-project-rules.md#outcome).

## The CLI canary

What a shared account stands on is behaviour no vendor documents: a rewrite of `.claude.json` that
keeps a link, a `plugins/` that survives an install, project trust read from the account's state
file. A CLI release can change any of it, so the first time Claudio reads a CLI version it has not
checked, it runs three checks again (`runCanary`, `packages/accounts/src/canary.ts`; the spikes S1,
S2 and S3c of [the plan](plans/account-configuration-and-project-rules.md)):

| Check | What it does in a temp dir | Passes when |
|---|---|---|
| `s1` | links `acc/.claude.json` to a file of `shared/`, then `claude mcp add --scope user` | the state file is still a link and the target holds the new server |
| `s2` | links `plugins/` and `settings.json`; adds a directory marketplace (no network), installs its plugin, raises its version, updates the marketplace and the plugin | both are still links, the plugin is enabled in the linked settings and recorded in the linked `plugins/` |
| `s3c` | a project with one HTTP server whose `headersHelper` leaves a mark; `initialize` then `mcp_status` control requests, with no turn, with and without `projects[<dir>].hasTrustDialogAccepted` | untrusted: the server fails and the helper never runs; trusted: it connects and the helper runs |

It costs nothing and touches nothing of a person's: every process gets an environment built from
nothing (a `PATH`, and a `HOME`, `XDG_*`, `TMPDIR` and `CLAUDE_CONFIG_DIR` under one fresh temp dir,
which is removed afterwards), so no token, key or real config dir can reach it. No check starts a
turn or needs an account; one the CLI refuses for a missing sign-in reads `needs-sign-in` and is not
retried, and one that could not run (no binary, a timeout, a server that never settled) reads
`error`, which says nothing of the CLI. The local server it talks to listens on loopback only. On
2.1.322 all three pass in about 25 seconds.

- **Stored** per version and check in SQLite (`cli_canary`: `version`, `check_id`, `state`,
  `observed`, `checked_at`), because there is one more per release for as long as Claudio runs and
  the binary and the app share the data dir. A version with a complete result is never run again
  by itself, so a restart costs nothing; a re-run replaces the rows of its version.
- **When.** `CliCanaryWatch` (`packages/core/src/cli-canary.ts`) is told each CLI version the
  system read sees, one run at a time, in the background. `CLAUDIO_CLI_CANARY=off` stops the
  automatic runs (the unit tests switch it off through the preload).
- **Where it shows.** `GET /accounts/canary` answers the version, whether a run is going and the
  result; `POST /accounts/canary/run` runs it again. The Accounts page has one line for it ("Checks
  for shared accounts": the CLI version, passed, failed, needs a signed-in account or could not run,
  and its age, with **Check again**; under it only the checks that did not pass, each a neutral name
  and a sentence in the person's language. What the server observed stays in the API and the log.
  Under "needs a signed-in account" the button is hidden: only signing in changes that), and
  `accounts.changed` refreshes it.
- **What a failure changes: nothing.** It is said once in the server log and on that line. The plan
  (R1) says that a canary showing links replaced for `settings.json` should make shared mode copy
  and reconcile instead of linking; that is the owner's decision, so Claudio only reports.

## Where it shows

- **API:** `/accounts` and its sub-routes, in the [Accounts](rest-api.md#accounts) table of the REST API. A chat's token reads
  them and cannot change them.
- **Terminal:** the `claudio-accounts` binary of the package, on the same data dir.
- **MCP:** `list_accounts` ([claudio-mcp-server.md](claudio-mcp-server.md)) answers each account's
  kind, alias or email, plan, `enabled`, `signedIn` and its limit, compact.
- **Web:** the Accounts page, the status bar's account card, New chat's account picker and Home's
  limit widgets.
  - The status bar's connection item, the account chip, the provider dot and the phone cards read
    `overview.accounts`; "near" and "limit reached" come from the in-use account's own reading, and a
    provider's own limit reasons speak only for a provider with no accounts. An unknown cost for the
    day reads "today, cost not reported".
  - The chat's limit banner looks only at `chat.atLimit` and the chat's open wait, and shows the
    reset and window of the account the turn died on. At a limit it offers **Wait for the reset**
    (primary) and **Switch account** (the composer's own picker, shown once two or more accounts are
    loaded); while waiting, **Stop waiting** and **Run now**. A chat moved to another account is no
    longer at that limit and its composer is usable again: the move clears the chat's limit flags on
    the server (`moveTo`), and the banner compares no accounts of its own. The box under the banner
    takes the height of its sentence, at least a touch target on a phone.
  - **One wait line** (t9 of [limit-resume-and-credits](plans/limit-resume-and-credits.md)).
    Wherever work waits for a usage limit to reset, the page draws the same `WaitLine`
    (`apps/web/src/components/WaitLine.tsx`): the chat's banner, a task's row, a workflow's or a
    graph step's notice, the review gate's card, a flow run on its item, an eval run. Same words
    everywhere: "Waiting for Claude Code", then **"resumes at 17:00 (in 2 h)"** when the reset is
    known, **"going on now"** while the turn is being sent (`LimitWait.state`, `resuming`), or **"the
    reset time is not known · looking again at 17:15"** (`LimitWait.nextLookAt`, the next
    `get_usage` probe) when nobody has said when it resets. The account is named where the page knows
    it (the chat's). It is warn and still: the clock, no spinner, since the server does not say when
    a probe is in flight. The person's actions are the two that already exist, **Stop waiting** and
    **Run now** (`WaitActions`: `POST /limits/waits/:id/cancel` and `/run-now`); on a phone they
    drop under the words as touch targets. A wait that has ended is not drawn: the chat goes on, or
    the task or run says how it ended.
  - **Home lists the open waits** inside "In progress", beside what needs a person: every
    `waiting` or `resuming` row of `GET /limits/waits`, oldest first, narrowed to the project a Home
    is about, each with what waits (a chat's title, or the orchestration), since when, when it goes on
    or looks again, the account for a chat, and a link to it. With none open the list is not drawn,
    and it does not stop the welcome from showing for nothing else.
  - The Accounts page: **Use this account** sets the preferred account and the card shows a
    **Preferred** tag; holding out the preferred account, or the last usable one, asks first. A card
    says how old its reading is only when it is older than 10 minutes. The Rotation card lists the
    global order as a reorderable list (the same list as the policies') and makes threshold,
    hysteresis and cooldown read-only while switching at the limit is off; saving sends only the
    edited fields, so it cannot overwrite a preference set from a card.
  - **Usage credits** (the Rotation card): one row per account whose credits were ever set up (or
    that already has a setting), with a select (Never, As a last resort, Allowed) and, unless Never,
    Claudio's monthly cap in the account's currency, and a line that says what the choice does.
    Part of the card's draft: nothing applies until Save. An account whose credits were never set up
    has no row, since the setting would change nothing for it.
  - **The finishing touches of the account plan (T11).**
    - **Why this account.** `Chat.accountWhy` is the explanation of the choice that put the chat on
      its account (`Choice.why`, kept in memory: absent after a restart, before the first choice and
      after a person's switch), with `pinIgnored` naming a pin the project's rule does not allow. The
      composer's Account entry shows the basis as its second line, and the chat's own row in the list
      the same, plus the ignored pin by name.
    - **No room under a rule, as data.** The rotation's notice to a person's chat carries
      `data: { reason: 'no-room', rule: NoRoomRule }` and a wait's row its `rule` (`provider_moves.rule`,
      JSON; `ProviderMove.rule`, `LimitWait.rule`): the project id (null for chats of no project),
      the reset and the `choices` left (`wait`, and `once` for a person). The transcript line and every
      `WaitLine` say it in the page's language with the project's name; `reason` keeps the English
      for logs and older pages.
    - **The rotation's own move** at a limit carries `data: { reason: 'rotation', account, from, cause }`,
      so the transcript draws it as "At the usage limit, moved to X", with "which has its own
      configuration" (or "uses the shared configuration") when it crossed configurations, as a
      person's switch does.
    - **A chat a restart cut** reads **Interrupted** (warn) in the chat header, not Stuck: a last
      execution that was `interrupted` is a `warn` health signal (it waits for a person to resume
      it), and the side panel's outcome badge is warn too; a failed one reads **Failed** (bad).
  - **States.** An account in `overage` reads **Using credits** in warn on its card (never the bad of
    a stop), with the month's amount and what Claudio may do with them ("Claudio never spends
    them"); the status bar's connection item says "<account> · Using credits" in warn, the account
    chip "on credits", and the phone's card the same. The rotation log names the reason "usage
    credits".

## Tests

The MCP overlay is guarded by `packages/accounts/test/overlay.test.ts` (the state-file shapes read and refused, trust, disabled servers, worktree keys, the cache on the stamp) and `packages/core/test/args-overlay.test.ts` (one `--settings`, no strict mode, 0600 files, the merge with Claudio's own servers and the guard's settings, cleanup, and a chat on a shared account against one on the default through the fake CLI).

The canary is guarded by `packages/accounts/test/canary.test.ts` (a fake CLI that breaks each check in turn, the environment it is given, and the installed CLI when there is one), `packages/core/test/cli-canary.test.ts` and the accounts route tests.

The unit tests run against `packages/accounts/test/fake-claude.mjs`, which honours
`CLAUDE_CONFIG_DIR`. The end-to-end spec `e2e/specs/accounts.spec.mjs` uses the fake CLI of
`e2e/fake-cli`: a token account starting with `fake-limited` is out on the `FAKE-LIMIT-ACCOUNT`
line, and the chat is replayed on another account; one starting with `fake-expired` fails to sign in on
the `FAKE-AUTH-EXPIRED-ACCOUNT` line, and the chat moves with the account marked "Sign-in expired".
The retry is guarded in core by `packages/core/test/orchestration-retry-account.test.ts`, and a
workflow's limit by `workflow-limits.test.ts` and `rotation.test.ts`.
The R10 waits and run now are guarded by `accounts-rotation.test.ts` (a new reading, a sign-in
restored, an earlier reset, run now and its refusal; the fake's `FAKE_CLAUDE_LIMIT_RESETS_IN` sends
the rejected `rate_limit_event` before the 429), `workflow-limits.test.ts` for a workflow lead, and
`apps/api/test/provider-rotation.test.ts` for the route.
`e2e/specs/chat-account-switch.spec.mjs` covers the on-demand switch from the "+" menu: idle, while
working, and an exhausted account shown disabled.

The regression fixes of 2026-10-29 are guarded by `packages/accounts/test/choice-and-readings.test.ts`
(preferred, order, pin precedence, the per-account cooldown, scoped and overage rejections, a
`get_usage` without limits), `packages/core/test/accounts-rotation.test.ts` (a second limit after a
wait-replay, the resolved model, a fork), `process-guards.test.ts`, `apps/api/test/accounts.test.ts`
(the 409 on removal) and, on the web, `status-bar-accounts.test.tsx` (the dot against another
account's reading), `rotation-card.test.tsx` and `chat-limit.test.tsx`; the e2e specs
`accounts.spec.mjs` and `status-bar-accounts.spec.mjs` cover the page and the bar.

`packages/accounts/test/cli-usage.test.ts` guards the parser (against a recorded real answer), the
fold precedence and the per-model choice; `apps/api/test/accounts.test.ts` the refresh routes; and
`apps/web/test/account-card.test.tsx` the card.

Credits: `packages/accounts/test/credits.test.ts` (the state and `choose`) and `credits-turn.test.ts`
(the hint, the cap and `creditsMayPay` over the 2026-11-16 readings),
`packages/core/test/credits-leak.test.ts` (background work, a probe, a turn the agent opens),
`packages/core/test/credits-turns.test.ts` (a turn that crosses under each
setting, over the fake's `FAKE_CLAUDE_OVERAGE_DIRS`, which reports the crossing as the SDK's typings
describe it), `apps/web/test/account-card.test.tsx`, `rotation-card.test.tsx`, `accounts.test.ts`,
`chat-notice.test.ts` and `notifications-text.test.ts`, and the e2e `accounts.spec.mjs` (a
`fake-credits` token: the card's state and the setting saved from the page). No test claims the
stream of a real paid turn: spike S2 was not run.

Plugins of shared accounts are guarded by `packages/accounts/test/plugins.test.ts`, which runs the
reconciler against `fake-plugin-claude.mjs` (a `claude` that answers only `plugin` commands, keeps its
records and a marketplace clone per account dir, and writes `enabledPlugins` through the settings
link): the commands and the dir they run in, a refresh before an update, what is never uninstalled,
what the default switched off, no process when nothing differs, a live chat, a failure said once and
retried, a hang ended at its timeout, no credential, one account at a time, the watch and the first
pass, and the served `plugins`.

The configuration mode is guarded by `packages/accounts/test/config-mode.test.ts` (the install
default, the reconciliation per mode, history in both modes, each switch, the plan writing nothing,
an interrupted switch finished, a conflict blocking only its item, "use shared", the automatic
moves and their live-chat guard) and by `apps/api/test/accounts.test.ts` (the served state, the
routes, a chat's token refused).

## Related

[[decisions/get-usage-control-request.md]] · [[plans/regression-fixes-2026-10-29.md]] · [[pinned-chat-rotation.md]] · [[plans/claude-only-fork.md]] · [[plans/rotation-auth-fixes.md]] · [[plans/workflow-engine-limits.md]] · [[orchestrations.md]] · [[reports/accounts-a0.md]] · [[providers.md]] · [[claudio-mcp-server.md]] · [[desktop.md]] · [[deploy.md]]
