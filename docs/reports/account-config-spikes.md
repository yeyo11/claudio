---
created_at: 2026-11-15T20:00:00Z
updated_at: 2026-11-20T23:00:00Z
tags:
    - report
    - spike
    - accounts
    - mcp
    - claude-code
---
# Account configuration spikes: S4, S5 and S7 on signed-in accounts

T0 of [plans/account-configuration-and-project-rules.md](../plans/account-configuration-and-project-rules.md),
the part that needs a signed-in account. **CLI: `claude --version` = 2.1.322 (Claude Code)**, 2026-11-15.
S2b was run later the same day (below); S6 was run on 2026-11-16 and 2026-11-20 against a local fake
OAuth server instead of a sign-in (below). S3 of
[plans/survive-restarts.md](../plans/survive-restarts.md) ran in the same session and is written up in
[decisions/parked-cli-processes.md](../decisions/parked-cli-processes.md#s3-a-pending-prompt-across-the-gap).

**Setup.** Two scratch config directories the owner signed in to for this purpose (account A and
account B, both claude.ai, Max plan), always as `CLAUDE_CONFIG_DIR`, with `HOME` and every working
directory under a fresh `mktemp -d`. The owner's `~/.claude`, `~/.config/Claudio` and account dirs
were not touched. Credentials, tokens, emails and ids were never read or recorded; state files were
inspected key by key. Models: Haiku, `--max-budget-usd 0.05` per turn. Confidence marks as in the
plan: **verified** (measured here) or **inferred**.

## S4. Name collision and strict mode

**Question.** If `.mcp.json` and `--mcp-config` declare the same server name, which wins and is it
listed twice? Does `--strict-mcp-config` drop the claude.ai connectors?

**How run.** `claude -p --input-format stream-json` on account A, with `initialize` and an
`mcp_status` control request (no turn). A stdio server (a 20-line script whose `serverInfo.name` is
its label) named `dup` was declared as `FROM_MCPJSON` in the project's `.mcp.json` and as
`FROM_FLAG` in a file given with `--mcp-config`. The project had no trust entry in the state file.

| Variant | `mcp_status` |
|---|---|
| `.mcp.json` only | `dup` (`FROM_MCPJSON`, scope `project`, connected) and the account's claude.ai connector (scope `claudeai`) |
| `.mcp.json` + `--mcp-config` | **one** `dup`, `FROM_FLAG`, scope `dynamic`; the connector is still listed |
| `--strict-mcp-config` alone | **empty list**: the connector and the `.mcp.json` server are both gone |
| `--strict-mcp-config` + `--mcp-config` | only `dup` (`FROM_FLAG`) |

**Result (verified, one run each).** The flag's definition replaces the project's, with no duplicate
entry, so an overlay entry that shares a name with a project server shadows the project's definition.
Strict mode drops the claude.ai connectors **and** the project's `.mcp.json`. Also: a stdio server
from an untrusted project's `.mcp.json` connected in `-p` mode, so trust matters for the
`headersHelper` of remote servers (plan S3b/S3c), not for stdio ones.

**Cost.** 0 turns, 0 USD.

**Means for.**
- **T3.** Never use `--strict-mcp-config` in the overlay: it would remove the account's own
  connectors, which are the identity the plan says to keep. The overlay should leave a project
  server out of the file when the project's `.mcp.json` is going to be read anyway, or accept that
  the overlay's copy wins; it cannot produce two entries, so no de-duplication code is needed.
  Because the flag wins, an overlay that carries a stale copy of a project server would override a
  newer `.mcp.json`: carry project servers only when trusted, as section 6.4 says, and rebuild on
  every change.
- **T5.** The canary can check both facts in a temp dir: same-name flag wins, and strict yields an
  empty list with no flag servers.
- **T2.** None.

## S5. What a session resumed on another account loses

**Question.** With two accounts of the same person and only `projects/` linked, what does a session
resumed with `--resume` on the other account keep: the file edit's rewind, the task list, plans,
agent memory?

**How run.** Account B's `projects/` was a symlink to account A's. Turn 1 on A (stream-json,
`--session-id` fixed, `CLAUDE_CODE_ENABLE_TASKS=true`, `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1`,
`acceptEdits`): edit `notes.txt` with Edit, create two tasks with TaskCreate, then enter plan mode
and write a plan. Turn 2 on B: `--resume` the same session, TaskList, read the file, plus a
`rewind_files` control request (a dry run, then a real one in a process with no turn).

**Results.**
- **Transcript and conversation (verified).** B resumed the session from the shared `projects/` and
  answered about the file (`line two`).
- **Tasks (verified).** A wrote `tasks/<session>/1.json` and `2.json` in its own dir. B's TaskList
  said "No tasks found", though the resumed conversation showed the two TaskCreate results; B's
  `tasks/` stayed empty.
- **Rewind (verified).** A held `file-history/<session>/<hash>@v1`. The dry-run `rewind_files` on B
  said `canRewind: true` (the snapshot metadata lives in the transcript), but the real one failed:
  "No files were restored: 1 file failed (backup missing…)". The edited file was left unchanged.
- **Plans (not exercised).** Haiku could not use plan mode in `-p` (the turn reported it blocked), so
  `plans/` stayed empty on both. By the same keying (a slug stored in the transcript, a file in the
  account's `plans/`), a plan is **inferred** to be lost the same way.
- **Agent memory (not exercised).** No agent with memory ran. **Inferred** like plans.

**Confidence.** Verified for tasks and rewind; inferred for plans and agent memory.

**Cost.** Two Haiku turns: 0.00587433 and 0.00791322 USD.

**Means for.** This is B11 and B9 confirmed with a real CLI: linking `projects/` alone gives a
resumed session its words but not its task list or its rewind, and a dry-run rewind lies. Keep all
five history items linked (`HISTORY_ITEMS` in `packages/accounts/src/dirs.ts` already does, so T1
covers it); a conformance test could be added to the canary (T5): write a task and a checkpoint on
one account, resume on the other. A rewind check in the UI should use the real result, not the dry
run. T2 and T3 are not affected.

## S7. External `@imports` in CLAUDE.md

**Question.** Is a CLAUDE.md `@import` of a file outside the project followed in `-p`, with and
without `hasClaudeMdExternalIncludesApproved`?

**How run.** A project whose `CLAUDE.md` is `@<scratch>/outside/rule.md`, the imported file saying
"The marker word is PINEAPPLE-7."; `claude -p --model haiku --output-format json`, "Without using
any tools: what marker word do your instructions give you? Answer NONE if you have none." The
CLI's own code reads the key from the **current project's entry** (`projects[<path>]`), so the
variant with the key set that entry in account A's state file with `jq`.

| Variant | Answer |
|---|---|
| no key | NONE (the model saw the project CLAUDE.md and said the import was not read) |
| `projects[<project>].hasClaudeMdExternalIncludesApproved: true` | PINEAPPLE-7 |

**Result (verified).** Without the approval an external import is silently skipped in `-p`; with it
the file is read. It is stored per project, per state file, so account B would skip it until its
own file says so.

**Cost.** Three Haiku turns: 0.00247572 and 0.00182782 USD for the two valid variants, and
0.00225702 USD for a first run started from the wrong directory (no CLAUDE.md in reach, so it
proved nothing and was discarded): 0.00656056 USD in all, one turn over the "at most two" of the task.

**Means for.** One more per-project approval, like trust (plan section 2.3), that a shared-config
account does not inherit. External imports are rare and the CLI documents no flag for it. T2/T3:
list it among the items the reconciler reports as "differs, cannot be supplied", and never write
it into another process's state file. Nothing for T5.

## S2b. Concurrent plugin writers through a linked `plugins/` (run 2026-11-15, T2)

**Question.** Does a `plugins/` linked between accounts lose install records when several CLIs write
it at once?

**How run.** CLI 2.1.322, scratch dirs under `mktemp -d` with `HOME` there too, a local directory
marketplace with six plugins, no sign-in, no network. Two accounts whose `plugins/` and
`settings.json` were both links to one shared pair (as T1 links `settings.json`). Three rounds, each
on a fresh pair: `claude plugin marketplace add`, then **twelve `claude plugin install` at once**
(every plugin from both accounts), then ten concurrent `marketplace update`, `plugin list --json`
and `plugin update` calls. Not run: the `-p` starts of the plan's wording, which need a sign-in;
the plugin commands are the writers Claudio itself would add.

| Round | Installs failed | Records lost in `installed_plugins.json` | `enabledPlugins` lost in `settings.json` | Records after the updates |
|---|---|---|---|---|
| 1 | 0 of 12 | none | 4 of 6 | 6 of 6 |
| 2 | 0 of 12 | none | 3 of 6 | 6 of 6 |
| 3 | 0 of 12 | none | 4 of 6 | 6 of 6 |

**Result (verified, three rounds).** The install records through a linked `plugins/` survived all
three rounds, but the **linked `settings.json` lost `enabledPlugins` entries in every round**: the
CLI reads, modifies and writes it, so concurrent plugin writers lose each other's update. A plugin
installed but not enabled is a silent B6. Serial runs (the reconciler's) lost nothing.

**Means for.** D4 stands, and for a better reason than the records: reconcile per account with the
CLI's own commands, **one at a time** (T2 does). Do not link `plugins/` on the strength of the
records alone. The lost update is in `settings.json`, which T1 already links, so any two plugin
commands (or a person's `/plugin` and a reconcile) running at the same moment in two accounts of
the shared set can drop a setting. Against it, the reconciler starts no process when nothing differs,
and is serial. Also confirmed in the same scratch run, with the reconciler against the real CLI: an
install, a version bump of the marketplace (marketplace update then plugin update) and an uninstall by
the default all reached the account, its `installPath` is under its own dir, and its `settings.json`
stayed a link.

**Cost.** None: no turn, no account.

## S6. OAuth MCP servers across accounts (run 2026-11-16 and 2026-11-20)

**Question.** A shared account gets the default's MCP servers through the overlay, but a remote
server's OAuth token is kept per config dir. Does the CLI accept a token entry copied from another
config dir, and what happens to refresh tokens once two dirs hold the same one?

**Why it was run.** On the owner's machine (2026-11-16) the two shared accounts failed to connect to
several OAuth MCP servers that work on the default. Their `.credentials.json` files, read for server
names and expiry only, held different sets: `shipcast` was signed in on the default and one account
only, `cloudflare-api` on the default and the other, `umami` on one shared account only.

**How run.** CLI 2.1.325, scratch dirs under `mktemp -d` with `HOME` there too, `env -i`, no sign-in,
no network: a local HTTP MCP server that answers only with `Authorization: Bearer <token>`, and for
the refresh runs the same server as its own authorization server (protected-resource and
authorization-server metadata, a token endpoint, registration refused). Each account was given the
server with `claude mcp add --transport http --scope user`, and `claude mcp list` was the probe. The
owner's credentials were never copied or sent anywhere; only the names of their keys were read.

**Where the token lives.** `<config dir>/.credentials.json`, key `mcpOAuth`, beside the account's
own `claudeAiOauth`. Each entry is keyed `<server name>|<first 16 hex of sha256(JSON.stringify({type,
url, headers ?? {}}))>`, read in the 2.1.325 bundle and checked against all 14 entries of the owner's
default (all matched). It holds `accessToken`, `serverName`, `serverUrl`, `discoveryState`, and when
the server gave them `refreshToken`, `expiresAt`, `clientId`, `clientSecret`, `redirectUri`, `issuer`,
`scope`. So the key does not depend on the config dir: the same server definition gives the same key
in every account the overlay serves. The format is not documented.

**Results (verified).**

| Run | Setup | Result |
|---|---|---|
| copy | account B without the entry | `Failed to connect — Dynamic Client Registration rejected (HTTP 401)`, the owner's error |
| copy | the `mcpOAuth` entry of A copied into B's file, nothing else | `Connected`; the CLI keeps the entry |
| refresh, server does not rotate | A and B hold the same copy, access token expired | both refresh on their own and connect, each with its own access token, same refresh token |
| refresh, strict rotation (single use, reuse revokes the family) | A and B hold the same copy, A runs first | A connects with a new pair; B's refresh is a reuse, **the family is revoked**, B reads `Needs authentication`, and **A then fails too**. The CLI empties the entry (no access or refresh token) in every dir that tried |
| refresh, strict rotation, propagated | after each refresh the newest entry is copied to the other dir before it runs | A and B both connect through two rotations (RT0 → RT1 → RT2) |

**Means for.**
- Copying `mcpOAuth` entries is enough for a shared account to use a server signed in elsewhere, with
  no sign-in of Claudio's own and without touching `claudeAiOauth`.
- A copy taken once is safe only for entries with no refresh token, or servers that do not rotate.
  For a server that rotates refresh tokens with reuse detection (the MCP authorization spec asks
  authorization servers to rotate them for public clients), a stale copy does not just fail: it
  signs out **every** account holding that grant, the default included. That is worse than today.
- Propagating the newest entry after each refresh works when the runs are serial. Claudio cannot
  stop two CLIs in two accounts from refreshing the same token at the same moment, since the refresh
  happens inside the CLI; copies made together also expire together, which makes that moment likely.
- The CLI writes emptied entries on failure: a copy must never carry an entry without an access token.

**Prior art (2026-11-20, web and GitHub, English and Chinese; nothing specific found in Chinese, and
Russian, French and Spanish were not searched).** No multi-account switcher was found that copies
`mcpOAuth` entries. Most keep `.credentials.json` per profile and say OAuth servers need a sign-in per
dir. `ccsw` links the whole file, which shares the account login too. Claude Code's own issues show
the same risks inside one dir: rotated refresh tokens lost between concurrent sessions (#24317, #59460),
entries rewritten empty by concurrent `claude mcp list` (#93537), an auth-failure cache keyed by server
name alone that blocked other profiles for 15 minutes (#87702), and on macOS `mcpOAuth` sharing the
Keychain item with the login (#90647). Rotation with reuse detection is documented by Atlassian and
Auth0; for Linear, Notion, GitHub, Stripe, Cloudflare and Slack it was not confirmed.

**The auth-failure cache (measured 2026-11-20, CLI 2.1.325, verified).** Same setup, a fake server
that also serves protected-resource and authorization-server metadata and accepts registration, so
that a signed-out server reads `needs-auth` (with a registration refusal it reads `failed` and the
CLI writes no cache), probed with `initialize` and `mcp_status` control requests of one stream-json
process per run. `<config dir>/mcp-needs-auth-cache.json` is `{"<server name>": {"timestamp": <ms>}}`,
written when a server ends `needs-auth`, keyed by the server name (a line written for one name was read for that name only; whether the URL is also part of it was not tried).

| Target dir | Cache line of the server | Status after the copy |
|---|---|---|
| copy of the entry, dir that had just failed | written by the CLI a moment before | `needs-auth`, the entry is **not used**; the line stays |
| same copy, never failed (control) | none | `connected` |
| same copy | `timestamp` 5, 10 and 14 minutes old | `needs-auth` |
| same copy | `timestamp` 16 minutes old | `connected`; the CLI empties the line (`{}`) |
| same copy | line removed (`{}`) | `connected` |
| same copy | a line for another server name only | `connected`, the other line is kept |

So the cache **does** delay a copied entry, for its TTL of 15 minutes (between 14 and 16, read as the
15 of the CLI's issue #87702), and only the line of that server name matters. The reconciler must
remove the server's line from the target's `mcp-needs-auth-cache.json` when it copies an entry for it
(read the file, drop that key, keep every other, write it back atomically; no file means nothing to
do). Every run started a new CLI process after the file was written or edited; whether a process that is
already running re-reads the file was not measured (the reconciler defers a live CLI anyway).

**Not measured.** A real provider's rotation; two refreshes at the same instant; macOS (Claudio's desktop is Linux, and
the Keychain would make this a different design).

**Cost.** None: no turn, no account, no network.

## Cost of every turn

| Spike | Turn | `total_cost_usd` |
|---|---|---|
| S4 | none (control requests only) | 0 |
| S5 | turn 1 on A | 0.00587433 |
| S5 | turn 2 on B | 0.00791322 |
| S7 | first run, wrong directory (discarded) | 0.00225702 |
| S7 | without the key | 0.00247572 |
| S7 | with the key | 0.00182782 |
| S3 | the one turn | 0.00122627 |
| | **Total** | **0.02157438** |

## Related

[[plans/account-configuration-and-project-rules.md]] · [[plans/survive-restarts.md]] ·
[[decisions/parked-cli-processes.md]] · [[accounts.md]] · [[reports/accounts-a0.md]] ·
[[cli-surfaces.md]]
