---
created_at: 2026-10-15T18:00:00Z
updated_at: 2026-10-30T12:00:00Z
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
- **Dirs** live in `<data>/accounts/<id>/`. `settings.json`, `CLAUDE.md`, `keybindings.json`,
  `agents`, `commands` and `skills` are symlinks to the default dir, and `projects/` is always linked,
  so every account writes its transcripts where Claudio reads them and a session started on one
  account resumes on another with `--resume`.
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
  nothing else.
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
- An account whose binding window is at the threshold (90 % by default) is skipped until it falls
  `hysteresis` points under it, and one that hit a limit is left alone until its reset. When a
  rejection gave no reset, `cooldownSeconds` leaves *that account* alone for the time: it is written
  on its reading as `outUntil`, so the account reads exhausted until then. There is no longer a
  global gap between switches, which held every other account back as well.
- **The model the chat asked for is what the choice filters on** (`chat.opts.model`), not the one the
  CLI resolved: a chat started on `default` runs on any account, instead of waiting for one that
  offers the Opus it resolved to. A pick that finds no account able to run a named model waits.
- **At a limit**, the account is marked, another is chosen and the turn is replayed in the same
  chat, resumed on the new account. A person's chat does it when `rotateOnLimit` is on (the
  default); automated work always does. With no account left, the work waits for a reset: the
  earliest among the accounts that can run the turn (`chooseNext(...).waitUntil`), else the reset
  the turn's own account or refusal gave. An account that cannot run the model the chat asked for
  does not shorten the wait.
- **The replay count** (`MAX_LIMIT_REPLAYS`, one per execution) counts replays that landed on no new
  account, between two turns that went through. A turn that completes without error resets it, and a
  move to another account is never counted nor held back by it: `chooseNext` passes over every
  account the turn died on, so a chain of moves ends by itself. Before this, a second limit after a
  wait-replay left the chat stuck. One slow recovery remains: after a wait-replay the rotation skips
  the accounts the turn died on before the wait until a turn goes through, so a chain of waits gets
  there slowly.
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
  closer moves the wait's timer to it. Graph tasks and workflow leads go through the same path.
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
    longer at that limit and its composer is usable again.
  - The Accounts page: **Use this account** sets the preferred account and the card shows a
    **Preferred** tag; holding out the preferred account, or the last usable one, asks first. A card
    says how old its reading is only when it is older than 10 minutes. The Rotation card lists the
    global order as a reorderable list (the same list as the policies') and makes threshold,
    hysteresis and cooldown read-only while switching at the limit is off; saving sends only the
    edited fields, so it cannot overwrite a preference set from a card.

## Tests

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

## Related

[[decisions/get-usage-control-request.md]] · [[plans/regression-fixes-2026-10-29.md]] · [[pinned-chat-rotation.md]] · [[plans/claude-only-fork.md]] · [[plans/rotation-auth-fixes.md]] · [[plans/workflow-engine-limits.md]] · [[orchestrations.md]] · [[reports/accounts-a0.md]] · [[providers.md]] · [[claudio-mcp-server.md]] · [[desktop.md]] · [[deploy.md]]
