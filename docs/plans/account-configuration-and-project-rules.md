---
created_at: 2026-11-13T18:00:00Z
updated_at: 2026-11-20T23:59:00Z
tags:
    - plan
    - study
    - accounts
    - rotation
    - claude-code
    - configuration
    - architecture
---
# Plan: account configuration (shared or independent) and project rules

Status: **T0b and T1 are built** (merged in #123, 2026-11-13) and **T4 is built** on branch
`feat/account-config-mode` (2026-11-14); **T5 is built** on `feat/cli-canary` (2026-11-15); **T3 is built** on `feat/mcp-overlay` (2026-11-15); **T2 is built** on `feat/account-plugins` (2026-11-15); **T6 is built** on branch `feat/account-rules-engine`
(2026-11-15); T7 (#149) and T8 (#147) merged; **T9 decided and T10 built** on `feat/account-config-screens` (2026-11-15); **T11 and T10's leftovers built** on `feat/accounts-finish` (2026-11-15): **the plan is built**, see [the closing summary](#closing-summary). Was: **proposed** (2026-11-13), a study with nothing built: it holds the evidence, the
options, a recommended end state and the decisions the owner took (the last section). See
[Outcome](#outcome).

Every claim below is marked **[V]** when it was verified on this machine (read-only on the owner's
dirs, or by a spike in a scratch `CLAUDE_CONFIG_DIR` under `/tmp`), **[D]** when it comes from the
CLI's own documentation, **[C]** when it was read in Claudio's code, and **[I]** when it is
inferred. CLI version for every spike: **2.1.322**. No credential was used, no turn was paid, and
nothing under `~/.claude`, `~/.claude.json` or `~/.config/Claudio` was written.

## 1. What the owner asked for (2026-11-13)

1. In the Accounts section a person chooses whether the configuration is **shared** by all accounts
   or **independent** per account.
2. The rules grow: **accounts per project** (account B need not work on project A, configurable),
   **project preferences** among accounts, and **quota balanced towards a project that has work in
   progress**.
3. All of it is optional. By default accounts share the configuration and no rule is active.
4. It is not a light decision: work out the implications before building.

Following the owner's way of working for studies: stop the bleeding (§9, T1), measure (§2, §5), an
end state where today's behaviour is the degenerate case (§6, §7), the vendor's own surfaces first
(§4), and spikes before building (§5).

## 2. Inventory: what a Claude Code config dir holds (A)

### 2.1 How Claudio lays out account dirs today [C]

- `prepareAccountDir` (`packages/accounts/src/dirs.ts:37`) links `projects` always and, with
  `shareSettings` (always true: `store.ts:409` passes nothing), `settings.json`, `CLAUDE.md`,
  `keybindings.json`, `agents`, `commands` and `skills` from the default dir. It runs **once**, in
  `AccountStore.add` (`store.ts:409`), and skips an item that does not exist in the default dir then
  (`dirs.ts:47`). Nothing calls it again. The links it made are stored in `accounts.json` (`links`)
  so `remove` can undo them (`store.ts:424`).
- `envFor` (`packages/accounts/src/env.ts:41`) gives a non-default account
  `CLAUDE_CONFIG_DIR=<data>/accounts/<id>`; the default account keeps no variable, so its CLI reads
  `~/.claude.json` and `~/.claude/` (the comment at `env.ts:35` records why: setting the variable to
  `~/.claude` moves the state file to `~/.claude/.claude.json`, a second file).
- Every run of every kind (a person's chat, an orchestration task, a flow run, a schedule, the
  OpenAI-compatible surface) gets its account in `ChatManager.chooseAccount`
  (`packages/core/src/chats.ts:2191`), which calls `store.pick` with the project's policy
  (`policyFor(projectOf(cwd))`). The rotation at a limit (`chooseNext`, `roomFor`) uses the same call.

### 2.2 What is on disk (2026-11-13) [V]

Default dir `~/.claude` (names, kinds, sizes; no contents of secrets):

| Entry | Kind | Size | Notes |
|---|---|---|---|
| `.credentials.json` | file | 15 KB | identity; never read by Claudio beyond `refreshToken` presence |
| `.claude.json` | file | 56 KB | a **second, stale state file**: read only by a CLI started with `CLAUDE_CONFIG_DIR=~/.claude` (0 user MCP servers, no projects) |
| `settings.json` (+ `settings.json.bak-2026-11-02`) | file | 4.6 KB | `permissions`, `model`, `hooks` (empty), `enabledPlugins` (13), `extraKnownMarketplaces` (3), `autoMode`, theme |
| `CLAUDE.md` | file | 0.9 KB | the person's instructions |
| `agents/` | dir | | holds `shipcast.md`, itself a symlink into the person's own repository |
| `skills/` | dir | | 2 skills, `.trash/`, `synced/` |
| `hooks/` | dir | | 2 scripts; **not** a CLI-defined dir (hooks are declared in settings) |
| `plugins/` | dir | | `installed_plugins.json` (13 plugins), `known_marketplaces.json` (4), `cache/`, `marketplaces/`, `data/`, `store/`, `synced/`, catalog caches (0.5 and 2.8 MB) |
| `projects/` | dir | | transcripts, subagent transcripts, auto memory; shared with every account |
| `agent-memory/` | dir | | user-scope subagent memory |
| `file-history/`, `paste-cache/`, `session-env/`, `sessions/`, `shell-snapshots/`, `state/`, `jobs/`, `daemon/`, `ide/`, `uploads/`, `downloads/`, `backups/`, `cache/` | dirs | | CLI history, session state, caches |
| `history.jsonl` | file | 171 KB | prompt history (interactive) |
| `stats-cache.json`, `gh-pr-status-cache.json`, `mcp-needs-auth-cache.json`, `.last-cleanup`, `.last-update-result.json` | files | small | caches |
| `.mcp.json` | file | 25 B | `{"mcpServers":{}}`; not a location the CLI documents, inert |
| `policy-limits.json.stamp.json.tmp.*` | files | 5 leftovers | the CLI's own interrupted atomic writes |
| absent | | | `commands/`, `keybindings.json`, `rules/`, `output-styles/`, `workflows/`, `themes/`, `plans/`, `tasks/` |

`~/.claude.json` (145 KB) is the default account's state file, with `.claude.json.backup` and
`.claude.json.rea.backup` beside it.

Account dirs under `~/.config/Claudio/data/accounts/`:

| Entry | `acc-a6b913cd` (Team) | `acc-0d90ca6f` (Pro) |
|---|---|---|
| `settings.json`, `skills`, `projects` | link (recorded in `links`) | link (recorded) |
| `CLAUDE.md`, `agents` | link, **added by hand 2026-11-13, not recorded** | same |
| `commands`, `keybindings.json` | absent (absent in default too) | absent |
| `.claude.json` | own, 87 KB, plus **5 `.claude.json.tmp.*` leftovers** (4 empty, one 71 KB) | own, 83 KB |
| `.credentials.json` | own | own |
| `policy-limits.json` (+ `.signature*.json`, `.stamp.json`), `remote-settings.json` (+ signature, `synced-at`) | own (Team plan: organisation policy) | absent |
| `plugins/` | **real dir**, 12 plugins | **real dir**, 12 plugins |
| `agent-memory/`, `backups/`, `cache/`, `session-env/`, `sessions/`, `shell-snapshots/`, `state/`, `mcp-needs-auth-cache.json`, `.last-cleanup` | own | own |
| `fake-login.json`, `initialize-count` | **written by the unit tests' fake CLI** (`packages/accounts/test/fake-claude.mjs`) on 2026-11-07 | same, on 2026-10-19 |

`acc-79ffec12` is an **orphan**: not in `accounts.json`, dated 2026-10-25, holding a 407 B
`.claude.json` and a **real** `projects/` dir (not a link). Claudio also left 9
`limits.json.*.tmp` files beside `limits.json` (2026-10-26 and 2026-10-31): its own `writeAtomic`
(`packages/accounts/src/fs.ts`) killed between write and rename.

### 2.3 The state file, key by key [V]

Top-level keys of the three state files, grouped (values never printed):

| Class | Keys | Default | Accounts |
|---|---|---|---|
| Identity and plan | `oauthAccount`, `userID`, `claudeAiMcpEverConnected`, `groveConfigCache`, `passesEligibilityCache`, `penguinModeOrgEnabled`, `orgModelDefaultCache`, `cachedExtraUsageDisabledReason`, `cachedUsageUtilization`, `additionalModelOptionsCache`, `modelAccessCache`, `metricsStatusCacheByPrincipal`, `cachedGrowthBookFeatures` | present | present, each its own |
| Configuration | `mcpServers` (user scope) | **5 servers** | **absent** |
| Configuration, per project | `projects.<path>`: `hasTrustDialogAccepted`, `enabledMcpjsonServers`, `disabledMcpjsonServers`, `disabledMcpServers`, `mcpServers` (local scope), `allowedTools`, `hasClaudeMdExternalIncludesApproved` | 22 projects, **14 trusted**, 7 with `disabledMcpServers`, 1 with local servers | 2 projects each, **none trusted**, one with local servers |
| Per project history | `projects.<path>.last*` (cost, duration, tokens, session id, metrics), `activeWorktreeSession`, `exampleFiles` | present | present |
| UI and onboarding | `tips*`, `hasSeen*`, `numStartups`, `hasCompletedOnboarding`, `announcementImpressions`, `autoUpdates`, `installMethod`, `githubRepoPaths`, `diffSidebarOpen`, … | many | few |
| Machine | `machineID`, `firstStartTime`, `migrationVersion` | present | present |

The decisive fact: **configuration (user MCP servers, project trust and approvals, local servers,
per-project disabled servers) sits in the same file as identity and plan caches**, written by the
CLI in one read-modify-write. It cannot be split by linking.

### 2.4 Item by item

Who writes: **P** the person, **CLI** Claude Code, **C** Claudio. Class: **id** identity, **cfg**
configuration, **hist** history, **cache**. Sharing: **link** (can be shared with a symlink),
**own** (must stay per account), **flag** (only through a spawn-time flag), **no** (cannot be
shared safely).

| Item | What it is | Writer, how often | Class | Sharing and why |
|---|---|---|---|---|
| `.credentials.json` | OAuth tokens | CLI, at every refresh | id | **no**: refresh-token rotation logs the other sharers out; the CLI's rename replaces a linked credentials file (#76561) |
| `policy-limits.json`, `remote-settings.json` (+ signatures, stamps) | organisation policy and server-managed settings, cached per signed-in account [D] | CLI, at start and hourly | id | **own**: deleted at logout, belongs to the account's organisation |
| `.claude.json` | state file: identity, plan caches, user MCP servers, project trust and approvals, UI state | CLI, many times a session | id + cfg + hist | **no** as a whole: linking it loses updates across accounts (spike S1b); its configuration keys can be carried only by flags (§4) |
| `settings.json` | user settings: permissions, hooks, env, `enabledPlugins`, `extraKnownMarketplaces`, model | P, CLI (`/config`, `/model`, plugin installs) | cfg | **link**: written through the link and kept a link (spike S2) |
| `CLAUDE.md`, `rules/` | user instructions | P | cfg | **link** |
| `agents/`, `commands/`, `skills/`, `output-styles/`, `workflows/`, `themes/` | user agents, commands, skills, styles, workflow scripts, themes | P (skills also by claude.ai sync) | cfg | **link** |
| `keybindings.json` | shortcuts (interactive only) | P | cfg | **link** |
| `hooks/` | not a CLI dir; scripts a person's settings point at | P | cfg | **link** (harmless, keeps `$CLAUDE_CONFIG_DIR/hooks/…` paths working) |
| `plugins/` | marketplaces, installed versions, `installed_plugins.json`, plugin data | CLI (install, update, start-up sync) | cfg | **link possible but concurrent writers are unproven** (spike S2b owed); alternative: reconcile per account with `claude plugin` commands |
| user MCP servers (`mcpServers` in `.claude.json`) | servers added with `claude mcp add -s user` | P via CLI | cfg | **flag**: `--mcp-config` |
| project trust (`hasTrustDialogAccepted`) | the trust decision for a folder | CLI, interactive dialog only; `-p` never writes it [V] | cfg | **no documented way to supply it** (issue #79707); its main effect for Claudio is carried by `--mcp-config` (spike S3e) |
| `.mcp.json` approvals (`enabledMcpjsonServers` …) | which project servers are approved | CLI or settings keys [D] | cfg | **settings** keys exist, but approval is not trust (S3a) |
| per-project `disabledMcpServers`, local-scope `mcpServers` | servers a person turned off, or added for one project | P via CLI | cfg | **flag**: Claudio can compute the set and pass it |
| `agent-memory/` | user-scope subagent memory [D] | the agents | hist | **link** (else an agent remembers different things per account) |
| `projects/` | transcripts, subagent transcripts, tool results, auto memory | CLI, every turn | hist | **link, always**: resume across accounts depends on it (report a0 §6) |
| `file-history/`, `tasks/`, `plans/` | checkpoints, task lists, plan files, keyed by session | CLI | hist | **link**: keyed by session id, so no two writers share a file [I]; a session resumed elsewhere keeps them (S5 owed) |
| `history.jsonl` | prompt history, interactive | CLI, append | hist | own (Claudio drives `-p`, which reads none of it) |
| `sessions/`, `session-env/`, `shell-snapshots/`, `jobs/`, `daemon/`, `ide/`, `state/` | per-process and background-session state | CLI | state | **own**: used to detect concurrent sessions per config dir |
| `backups/`, `cache/`, `paste-cache/`, `stats-cache.json`, `mcp-needs-auth-cache.json`, `.last-cleanup` | caches and backups | CLI | cache | own |
| `secret` (token and api-key accounts) | Claudio's 0600 file | C | id | own |

## 3. What breaks today (B)

| # | What a person sees | Item | Reported? | Evidence |
|---|---|---|---|---|
| B1 | A chat on an older account cannot find a user agent | `agents` link absent (created after the account) | yes, fixed by hand | [V] links list, [C] `dirs.ts:47` |
| B2 | A chat on an older account ignores the person's instructions | `CLAUDE.md` link absent | yes, fixed by hand | same |
| B3 | A project MCP server with a `headersHelper` answers 404 on a non-default account | trust absent from the account's state file | yes | mechanism reproduced (S3b, S3c); the owner's own chat was not re-run |
| B4 | The 5 user-scope MCP servers are missing on every non-default account | `mcpServers` in `.claude.json` | partly | [V] key absent |
| B5 | A server the person turned off for a project comes back on another account; a project's local server is missing there | `disabledMcpServers`, local `mcpServers` | no | [V] keys, [I] effect |
| B6 | A plugin missing on accounts: `code-review` (its commands and skills absent) | `plugins/` per account | no | [V] `installed_plugins.json` |
| B7 | Plugin versions differ by account: **Sluice 0.5.0 on both accounts vs 0.12.1 on the default** (the gate this repository's commits depend on), `warp` 2.4.0 vs 2.2.0, a different `playwright` | `plugins/` per account | no | [V] caches |
| B8 | A subagent with user-scope memory remembers different things per account | `agent-memory/` per account | no | [V] real dirs, [I] effect |
| B9 | A chat rotated at a limit gains or loses B1-B8 in the middle of a conversation | all of the above | in concept | [C] rotation path |
| B10 | Anything added to the default dir later (`commands/`, `keybindings.json`, `rules/`, `output-styles/`, `workflows/`, `themes/`) never reaches existing accounts | one-shot linking | latent | [C] |
| B11 | Rewind, the task list and plan files of a session resumed on another account are missing | `file-history/`, `tasks/`, `plans/` per account | latent | [D], S5 owed |
| B12 | Claudio's own Settings editors replace a symlinked `settings.json`, `CLAUDE.md` or agent file with a plain copy (the owner's `agents/shipcast.md` is such a link) | `writeAtomic` renames over the path (`packages/core/src/config/files.ts:27`, `resources.ts:107`) | latent | [C], not exercised |
| B13 | An orphan account dir with a real `projects/` (`acc-79ffec12`); transcripts written there would be invisible | interrupted sign-in or removal | latent | [V] |
| B14 | Leftover temp files: the CLI's (`.claude.json.tmp.*`, `policy-limits…tmp.*`) and Claudio's (`limits.json.*.tmp`, 9) | interrupted atomic writes | cosmetic | [V] |
| B15 | The unit tests' fake CLI wrote into the real account dirs twice | a test or dev run pointed at the real data dir | out of scope, to investigate | [V] |
| B16 | A chat pinned to an account that its project policy does not list silently runs on another account | `choose`: `ready()` requires the policy's order (`choose.ts:108`) | latent | [C] |
| B17 | A CLI started with `CLAUDE_CONFIG_DIR=~/.claude` reads a stale second state file with no MCP servers | `~/.claude/.claude.json` | latent | [V], [C] `env.ts:35` |

## 4. Mechanisms available for sharing (C)

All stay inside the one rule: documented flags, documented settings, files the CLI writes (read),
and the CLI's own commands.

| Mechanism | Carries | Cannot carry | Cost per spawn | Two accounts writing at once | On a CLI update |
|---|---|---|---|---|---|
| **Directory and file symlinks** (today) | settings, instructions, agents, commands, skills, rules, styles, workflows, themes, hooks, history dirs | the state file's configuration; identity | none (an `lstat` per item if checked before spawn) | `settings.json`: two CLIs writing it through a link race like any shared file [I]; a person rarely writes it twice at once | a new item appears that nothing links (B10); an atomic writer that renames over the path would replace the link (seen in #40857, #76561, #78162 for other files); on 2.1.322 `.claude.json`, `settings.json` and `plugins/` are written **through** the link (S1, S2) |
| **Linking `.claude.json`** | everything in it | — | none | **loses updates**: 8 concurrent `mcp add` from two dirs through one linked file kept 7, 6 and 6 (S1b); the CLI's lock is per config dir (8 of 8 kept in one dir) | identity and plan caches of one account overwrite the other's |
| **`--settings <file-or-json>`** | any user-settings key for one process, above user/project/local, below managed [D] | trust; `.claude.json` keys | one file, written once and reused | none (read-only) | keys renamed; a second `--settings` **replaces** the first (S3f): Claudio must merge with the guard's file (`args.ts:78`) |
| **`--setting-sources`** | which of user/project/local load | another dir's files | none | none | — |
| **`--mcp-config` (non-strict)** | user MCP servers, project servers re-declared, local servers; a project server's `headersHelper` runs without trust (S3e) | claude.ai connectors (identity) | one generated file | none | flag stable; collision rules with same-named project servers unproven (S4) |
| **`--strict-mcp-config`** | only the servers given | everything else, possibly claude.ai connectors (S4) | none | none | — |
| **`--plugin-dir`** | a plugin from a dir for one process (Claudio already loads `claudio-bridge` so, `args.ts:80`) | install records, marketplaces | one flag per plugin | none | duplicates with an installed copy unproven |
| **`--agents`**, **`--append-system-prompt`**, **`--add-dir`** | agents as JSON, instructions as text, extra dirs | skills, commands, hooks | per spawn | none | — |
| **Managed settings** (`/etc/claude-code/managed-settings.json`, `managed-settings.d/`, `managed-mcp.json`) [D] | settings and MCP servers for every process on the machine | per-account choice | none | none | — |
| **Copy with reconciliation** | anything file-shaped, per account | live sharing | none per spawn; work when the source changes | each account writes its own copy | drift between reconciliations |
| **`claude plugin` commands per account** | plugin installs and versions, through the vendor's own installer | — | a process per plugin, at reconciliation only | each dir's own lock | the vendor keeps it working |
| **A merged view built at spawn** (generated `--mcp-config` + `--settings` from the default's files) | the state-file configuration that links cannot carry | trust itself | one read of `~/.claude.json` (145 KB) per spawn, cacheable on mtime | read-only | depends on the state file's key names: a reader, not a contract |

Managed settings are rejected for this purpose: they need root, apply to the person's own terminal
`claude` as well, and sit above everything the person sets. Embedding-host "parent settings" are
reduced to their restrictive values by the CLI [D], so they cannot share configuration either.

## 5. Spikes (D)

Each is written to run in ten minutes in a scratch dir: `S=$(mktemp -d)`, `export HOME=$S/home
DISABLE_AUTOUPDATER=1`, and a fresh `CLAUDE_CONFIG_DIR=$S/<name>` per case. Never in the owner's dirs.

### 5.1 Run on 2026-11-13 (CLI 2.1.322, free, no credential)

| Spike | How | Result |
|---|---|---|
| **S1** Does the CLI's rewrite of `.claude.json` replace a symlink? | `$S/acc/.claude.json -> $S/shared/state.json`; `claude mcp add --scope user x -- echo` | **No**: still a link, the target holds the new key. Contradicts #40857/#76561 for this file on this version |
| **S1b** Two accounts writing one linked state file at once | 8 parallel `mcp add` from two dirs linked to one file, twice; control: 8 in one plain dir, twice | linked: **7, 6, 6 of 8 kept**; plain dir: **8 and 8**. The CLI serialises per config dir, not per file |
| **S2** Does a symlinked `plugins/` survive install and update? | `plugins` and `settings.json` linked; `plugin marketplace add <dir>`, `plugin install`, bump, `marketplace update`, `plugin update`; then a GitHub marketplace plugin | both stay links; `enabledPlugins` and `extraKnownMarketplaces` land in the linked `settings.json`; `installPath` is recorded **under the installing account's dir**; `plugin list --json` from the default **rebases** it to its own dir, and the plugin still lists enabled after the account dir is moved away; directory marketplaces are read in place |
| **S3a** Can `.mcp.json` approvals be given without the state file? | project with an `http` server and a `headersHelper` that logs; `--settings '{"enabledMcpjsonServers":["spk"]}'`, `'{"enableAllProjectMcpServers":true}'`, or the same in the dir's `settings.json` | approved (no longer "Pending approval") and contacted, but **the helper never runs**: 404 without the header, the owner's symptom |
| **S3b** Does the helper run with trust? | the scratch state file given `projects["<proj>"].hasTrustDialogAccepted: true` | **yes**: "Connected", helper ran |
| **S3c** In Claudio's own mode | `claude -p --input-format stream-json …`, `initialize` then `mcp_status` control requests (no turn) | no trust: `failed`, helper 0; trust: `connected`, helper 1. Trusted, a project server connects **without** any approval in `-p` |
| **S3d** Which path does trust match? | trust on the parent dir only; then cwd inside a git worktree of the trusted repo; then `--worktree` | parent only: no; a worktree of the trusted main checkout: yes; `--worktree`: yes |
| **S3e** A project server passed with `--mcp-config` | cwd untrusted, `--mcp-config=<proj>/.mcp.json` | **connected, helper ran**: trust is not checked for flag-given servers |
| **S3f** Two `--settings` flags | first enables approvals, second sets an unrelated key; then swapped | **the last one wins**; they do not merge |
| **S8** Does removing an account dir follow its links? | Node `fs.rm(dir, {recursive:true})` on a dir with linked `agents/` and `CLAUDE.md` | no: the default dir's files remain (Node 24.22) |

### 5.2 Owed, for the owner to authorise

| Spike | Why | How | Cost |
|---|---|---|---|
| **S2b** Concurrent plugin writers through one linked `plugins/` | each CLI start may sync marketplaces and rewrite `installed_plugins.json` (the account caches hold many `temp_subdir_*.clone` dirs) | two scratch accounts with linked `plugins/`, 8 parallel `-p` starts with `initialize` each plus a `plugin update` in a loop; diff `installed_plugins.json` against the expected set | **Run 2026-11-15** (plugin commands, no sign-in): install records survived 12 concurrent installs three times, but the linked `settings.json` lost `enabledPlugins` entries every round. D4 stands, serial. [Result](../reports/account-config-spikes.md#s2b-concurrent-plugin-writers-through-a-linked-plugins-run-2026-11-15-t2) |
| **S4** Name collision and strict mode | the overlay must not duplicate or shadow a project server; strict mode might drop claude.ai connectors | same-named server in `.mcp.json` and `--mcp-config`, `mcp_status`; then `--strict-mcp-config` on a signed-in scratch account | **Run 2026-11-15**: the flag wins, one entry; strict drops claude.ai connectors and `.mcp.json` servers. [Result](../reports/account-config-spikes.md#s4-name-collision-and-strict-mode) |
| **S5** What a session resumed on another account loses | B11 and B9 | two scratch accounts of the same person, `projects/` linked; a haiku turn that edits a file, writes a task list and a plan, then `--resume` on the other account; check rewind, tasks, plans, agent memory | **Run 2026-11-15** (two Haiku turns, 0.014 USD): with only `projects/` linked the conversation resumes, but tasks are empty and rewind fails (backup missing); plans not exercised. [Result](../reports/account-config-spikes.md#s5-what-a-session-resumed-on-another-account-loses) |
| **S6** OAuth MCP servers across accounts | a user-scope remote server with OAuth keeps its token per config dir [I] | add one in the default, pass it with `--mcp-config` on another account, `mcp_status` | free, needs one OAuth server sign-in |
| **S7** External `@imports` in CLAUDE.md | `hasClaudeMdExternalIncludesApproved` is per state file | a CLAUDE.md importing a file outside the project, `-p` with and without the key | **Run 2026-11-15**: without the key the import is skipped; with `projects[<path>]` set it is read. [Result](../reports/account-config-spikes.md#s7-external-imports-in-claudemd) |

## 6. End state for requirement 1: shared or independent configuration (E)

### 6.1 The model

Three fixed classes, never a free per-item choice:

- **Identity** (credentials, organisation policy, remote settings, the state file's identity keys,
  `secret`): always the account's own.
- **History** (`projects/`, `agent-memory/`, `file-history/`, `tasks/`, `plans/`): always shared,
  whatever the mode. Rotation and `--resume` depend on it; it is not configuration.
- **Configuration** (settings, instructions, agents, commands, skills, rules, output styles,
  workflows, themes, keybindings, hooks, plugins, and the state file's configuration: user and local
  MCP servers, per-project disabled servers, project trust as it matters for MCP): **shared** or
  **independent**, per account.

The choice is **per account**, with an install-wide default for new accounts (`shared`). Owner's
words: "shared by all accounts or independent per account"; a per-account switch is the smallest
thing that says both, and "all shared" is its degenerate case (today, once T1 lands).

- **Shared** means the default dir's configuration, live: links for the file items, the plugins
  reconciled to the default's set (§6.3), and a spawn-time overlay (§6.4) for what the state file
  holds.
- **Independent** means the account's own files: real files in its dir, its own plugins, its own
  state-file configuration, no overlay. The CLI treats it as a separate install.

What an account that becomes independent starts from: **a copy of the shared configuration at that
moment** (recommended), or empty, the person's choice in the dialog. Its own user MCP servers
start from the default's (written with `claude mcp add -s user` in its dir, the CLI's own command,
never by editing its state file).

Switching back and forth never loses what a person set:

- Shared → independent: each link is replaced by a copy of its target; plugins are installed into
  the account with `claude plugin install`.
- Independent → shared: the account's own files are moved to `<dir>/.claudio-own/<ISO time>/`
  (never deleted), then the links are made. The page says that a copy was kept and offers to
  restore it when the account becomes independent again.
- Default account: it is the source of "shared"; it has no mode.

### 6.2 Reconciliation

One idempotent, pure-planning function, `reconcileAccountDir(dir, defaultDir, mode)`, that
returns a plan (link, keep, conflict) and applies only links and moves, never a delete:

- **When**: at start-up for every account; when an account is created; **before every spawn** on
  that account (an `lstat` per item, well under a millisecond, the same self-healing cma does on
  every launch); after a mode change; and when the person asks (Repair).
- **Rules**: an absent item whose source exists is linked; a link already pointing at the source is
  adopted and recorded (today's hand-made links); a link elsewhere or a real file or dir is a
  **conflict**, reported and left alone, except when it is empty or byte-identical to the source,
  where it moves to `.claudio-own/` and is linked; a source that does not exist yet is skipped and
  linked the first time it appears (B10).
- **Migration of today's installs**: every existing account is `shared`. The first reconcile adds
  the missing links (B1, B2, B10, B11), adopts the hand-made ones, and reports `plugins/` and
  `agent-memory/` (real dirs today) for §6.3 and a one-click "use shared" (the account's own copy
  kept). Orphan dirs (B13) are listed, never removed automatically.
- Claudio's own writers must write through links (`realpath` before the temp file, the temp file
  beside the real target), so the Settings editors stop replacing them (B12). The same fix applies to
  `writeAtomic` in `packages/accounts/src/fs.ts`.

### 6.3 Plugins

`plugins/` is the one configuration item where a link is not yet proven safe (S2b). Recommended,
whatever S2b says about links: **reconcile plugins per account with the CLI's own commands**
(`claude plugin marketplace add`, `install`, `update`, `uninstall`, in the account's environment)
whenever the default's `installed_plugins.json` or `settings.json` `enabledPlugins` changes, and at
start-up. Each config dir keeps its own lock and its own install records; the vendor's installer
stays the only writer; versions follow the default's (B6, B7). If S2b shows that concurrent starts
through a linked `plugins/` never lose records, a link becomes an option the owner can take later.

### 6.4 The spawn-time overlay (shared accounts only)

For a shared, non-default account, Claudio builds once per change of `~/.claude.json` (cached on
mtime and size, as `cliLogin` already does) one generated MCP file that holds:

- the default's user-scope `mcpServers`;
- for the chat's project, the local-scope servers, and the `.mcp.json` servers **only when the
  default's state file trusts that project** (the person already decided), less
  `disabledMcpjsonServers` and `disabledMcpServers`.

It is passed with `--mcp-config` beside whatever Claudio already passes (non-strict when the chat
chose no servers; merged into the chosen set when it did). This fixes B3, B4 and B5 through a
documented flag, without writing the account's state file. Approvals that the CLI also reads from
settings travel in the linked `settings.json`. Because `--settings` does not merge (S3f), any
settings overlay is merged into the one file Claudio passes (today the guard's). Trust itself is not
supplied: nothing documented supplies it (issue #79707), and Claudio never writes another
process's state file.

The overlay reads a file the CLI writes (allowed) but depends on its key names, which are not a
contract: a reader that finds unknown shapes logs and passes nothing, and a test pins the shapes
read.

### 6.5 What the Accounts page shows (words and states only)

Per account: its configuration mode (**Shared** or **Own**), a health state (**In sync**, **Needs
repair** with the items, **Conflict** with the items and what each holds), and the plugins it runs
when they differ from the default's. Actions: switch mode (dialog: what is copied, what is kept
aside, what the CLI will do); **Repair** (run reconciliation); per conflict, **Use shared** (keep
this account's copy aside) or **Keep own** (only for an independent account). Install-wide: the
mode new accounts start in. A chat whose next account has a different configuration says so in the
transcript ("Continues on account X, which has its own configuration").

The design round must decide: where this lives (on each account card, or a Configuration card on
the Accounts page), how a conflict reads without a diff tool, how much of the item list a person
ever sees (probably only problems), the copy of the mode dialog, and the phone layout. It follows
`docs/design-system.md`; no new colour beyond the status set (ok in sync, warn needs repair, bad
conflict).

### 6.6 Contract in outline

- `packages/shared/src/types.ts`: `AccountConfigMode = 'shared' | 'independent'`;
  `AccountConfigItem { name; kind: 'file' | 'dir'; class: 'config' | 'history'; state: 'linked' |
  'own' | 'missing' | 'conflict' | 'not-in-default' }`; `Account.config: { mode; state: 'ok' |
  'repair' | 'conflict'; items: AccountConfigItem[]; plugins: { missing: string[]; differing:
  string[] } }`; `AccountsSettings.newAccountConfig: AccountConfigMode` (default `shared`).
- Routes: `GET /accounts/:id/config`; `PUT /accounts/:id/config` `{ mode, start?: 'copy' | 'empty'
  | 'restore' }`; `POST /accounts/:id/config/repair`; `POST /accounts/:id/config/items/:name`
  `{ use: 'shared' | 'own' }`. Each with a summary and tag in `routes.ts`, a row in
  `docs/rest-api.md`, `pnpm --filter @claudio/api openapi:schemas`. A chat's token reads, never
  writes.
- `accounts.json` keeps `links` and gains `config: { mode }` per account: settings-shaped, JSON.
  The kept-aside copies are files in the account's dir. No SQLite table is needed.

### 6.7 What the CLI's updates could break

A new configuration item (handled: unknown default-dir entries are listed, and the class table is
one constant to extend); an atomic writer that starts renaming over links (the before-spawn
reconcile reports the link as a conflict instead of silently diverging, and the canary below sees
it); a change of the state-file keys the overlay reads (the overlay passes nothing and logs); a
change of plugin install records (the vendor's own commands do the work). A **canary** re-runs S1,
S2 and S3c against the installed CLI when Claudio sees a new CLI version (it already detects it for
the model cache) in a temp dir, free, and records the result in the server log and on the page.

## 7. End state for requirement 2: project rules (F)

### 7.1 What exists today [C]

- **Rotation settings** (`accounts.json`): `rotateOnLimit`, `threshold` (90), `hysteresis` (10),
  `cooldownSeconds`, `strategy` (`least-used` or `order`), `preferred`, `order`.
- **Per-project policies** (`RotationPolicy`, `types.ts:6990`, Accounts → Policies card): a policy
  governs some projects (and optionally the chats with no project): `order` is the **allow list and
  its order**, `threshold` overrides the global one. The owner has one policy (8 projects, 3
  accounts, loose chats, threshold 95).
- **Choice** (`choose.ts`): pin, then the global preferred account if the policy lists it, then the
  strategy within the policy's list. A pin outside the list is ignored (B16).
- **At a limit**: the turn moves to another account and is replayed; with none left, automated work
  waits for the earliest reset (up to `maxWaitHours`, global or per project in
  `ProjectProvidersSettings.onLimit`), a person's chat gets the banner with Wait, Switch, Run now.
- **Who picks**: every origin goes through `chooseAccount` with `projectOf(cwd)`; orchestrations
  can pin an account ("waits at a limit rather than switching").
- **Signals**: per-account readings (`five_hour`, `seven_day`, scoped weekly limits, resets) from
  `get_usage`, the stream and the CLI's cache; `usage_history` rows; `rotation_events` rows;
  `spend_ledger` rows with `account` and `project_id` per execution.

So "accounts per project" and part of "preference" already exist. The requirement is met by
growing the policy, not by a second rule system.

### 7.2 The design

A **project rule** is today's policy with three additions, all optional:

1. **Allowed accounts** (exists: `order`). The page presents it as a switch per account ("may work
   on this project"). A new account is **not** added to existing rules (today's behaviour); the
   Add-account flow asks whether to add it to them.
2. **Preferred account** (`preferred` on the rule): within the project it replaces the global
   preferred account, with the same threshold and hysteresis. With strategy `order`, `order` keeps
   its meaning.
3. **Reserve** (`reserve: { percent }`): while the project has **work in progress**, the other
   projects' work treats the project's preferred account (or the first in its order) as if its
   threshold were `threshold − percent`, so it moves off that account earlier and leaves headroom.

**Work in progress** is a fact Claudio already holds, counted per project: live chats with a
running turn, queued or running orchestration tasks, queued or running flow runs, and schedules due
within the reserve's horizon (the next hour). No guess from history. When the project has none, the
reserve is inactive and behaviour is exactly the rule without it.

**The quota signal** is the account's binding window (the higher of `five_hour` and `seven_day`
utilization), the same reading the threshold uses. No new reading, no new HTTP call.

**No starvation**: a reserve only diverts work while another allowed account of that work is under
its own threshold. When every other account is out, the reserved headroom is used (the rotation
already prefers running over waiting, `choose.ts:148`), recorded as `reason: 'reserve-released'`.
A reserve is capped (30 %) and at most one per account.

**When no permitted account has room**:

| Work | Recommended | Told |
|---|---|---|
| A person's chat | today's banner: Wait, Switch (only among allowed accounts), Run now; plus **Use another account once** (a person-only override, recorded) | the banner names the rule |
| Orchestration task, flow run | wait for the earliest reset among allowed accounts, up to `maxWaitHours`, then fail | notification and the run's row say "waiting: no account allowed on project X has room" |
| Schedule | skip this run and record it (a schedule must not pile up waits) | the schedule's run history |
| OpenAI-compatible request | 429 with the reset, as today | the client |

Never silently cross a rule.

**A chat already running on an account a new rule forbids**: never interrupted. It is moved at the
end of its current turn through the existing pending-switch path (`chat.pendingAccount`), with a
notice in the transcript and `reason: 'rule'` on the rotation event. A pin on a forbidden account
is refused when set (409 `account-not-allowed`) and, for existing pins, shown as "pin ignored by
the project's rule" (B16 becomes visible).

**Composition with requirement 1**: rules are mode-agnostic. An independent account can be the only
one allowed on a project; its chats never rotate, they wait. To keep a conversation's capabilities
stable, the choice prefers, among accounts with room, those in the **same configuration group** as
the chat's current account (all shared accounts are one group; each independent account is its own),
as a tie-breaker after the rule and the threshold, never over room. A rule may ask for strict
grouping ("rotate only within the same configuration"), an owner decision.

**What a person sees** so it never feels arbitrary: every choice carries a short explanation
(`Choice.why`: pin, rule, preferred, reserve for project X, least used, only one with room) shown on
the chat's account chip and in the rotation events; the account card shows "Reserved for project X
while it has work" with the reserve marked on its usage bar; the bars' 60/75 thresholds do not
change.

**Default**: no rule, no reserve, no preferred per project: `choose` returns exactly what it
returns today. A test pins that.

### 7.3 Contract in outline

`RotationPolicy` gains `preferred?: string`, `reserve?: { percent: number }`, `strictConfig?:
boolean`; `AccountSwitchReason` gains `'rule'`, `'reserve'`, `'reserve-released'`; `Choice` gains
`why`; `ChooseOptions` gains `reserved?: { account: string; percent: number }[]` computed by core
from work in progress; `AccountSwitchRefusalCode` gains `'not-allowed'`. Routes stay
`/accounts/policies` (validated additions). The rules stay in `accounts.json` (settings-shaped);
work in progress is read from the existing rows and live state, not stored.

## 8. Prior art (H, first part)

- **claude-multi-account (`cma`)**, digiogithub, MIT, Go, Linux only, 6 commits 2026-10-01 to
  2026-10-14, no issues or pull requests yet. Read from a shallow clone, not run.
  - Identity vs configuration: one dir per profile as `CLAUDE_CONFIG_DIR`; a **neutral shared home**
    (`~/.claude-accounts/shared`, real files) linked into every profile for a fixed list:
    `projects`, `skills`, `agents`, `commands`, `plugins`, `todos`, `plans`, `file-history`,
    `settings.json`, `CLAUDE.md`, `history.jsonl`, `keybindings.json` (optional).
    `.credentials.json` and `.claude.json` are never linked or opened.
  - **Self-healing on every launch** (`EnsureProfileDir`): absent → link, correct link → kept,
    anything else → a reported conflict, never overwritten. An import copies `~/.claude` into the
    shared home only where empty, into a temp sibling renamed on success.
  - Per project (`.claude/accounts.local.json`): `profile`, `allowedProfiles`, `memory.mode`
    (`shared` or `per-profile`, the latter through a temporary `--settings` file with
    `autoMemoryDirectory`), `switching.confirmContextTransfer`.
  - Switching: a person-confirmed switch after the session exits, relaunching `--resume <id>` on the
    other profile; **no automatic rotation, no balancing** ("There is no automatic rotation when the
    quota is exhausted").
  - Not handled: the state file's configuration (user MCP servers, trust), so it has B3-B5 too; its
    own docs list as unverified whether linked `settings.json` survives rewrites and whether
    `plugins/` install paths survive purging the installing profile (S1 and S2 answer both for
    2.1.322).
  - **Adopt**: self-healing before every launch, conflicts reported not overwritten, history dirs
    (`file-history`, `plans`, tasks) linked, the copy-into-temp-then-rename import, per-project
    allow list. **Do not adopt**: a neutral shared home (Claudio's "shared" is the person's own
    `~/.claude`, which their terminal `claude` and the default account use; moving it would break
    both), linking `plugins/` before S2b, linking `history.jsonl` (Claudio does not read it).
    MIT allows reusing code, but it is Go and Claudio is TypeScript: ideas only.
- **Community recipes** (English, Chinese, Russian, French, Spanish, Japanese): almost all use one
  `CLAUDE_CONFIG_DIR` per account plus symlinks for `settings.json`, `CLAUDE.md`, `skills`,
  `agents`, `commands`, `plugins`, sometimes `projects`, `todos`, `session-env`; all keep
  `.claude.json` per account; Classmethod's write-up moved away from symlinking `~/.claude.json`
  after parallel sessions overwrote it; a French write-up warns that hooks hard-coded to
  `~/.claude` leak across accounts; cyolo notes one keychain entry per config dir on macOS.
- **Claude Code issues**: #29395 and duplicates (#28922, #28989, #29004, #29112): concurrent
  processes clobber `~/.claude.json`, read-modify-write without a lock (CLI 2.1.62); S1b shows a
  per-dir lock now, but not across dirs. #76561 (open): credential refresh renames over a linked
  `.credentials.json` and rotation logs the sharers out. #40857, #15786, #78162, #67208: atomic
  writes replacing or failing on symlinked settings files. #79707, #72430: no non-interactive way
  to trust a workspace; #90041: the `headersHelper` trust gate (Windows path variant). #33430:
  `CLAUDE_CONFIG_DIR` documentation (now documented on the env-vars and `.claude` pages).
- **Other tools**: `gh` 2.40 added several accounts per host with `gh auth switch` while
  `config.yml` stays one file (identity apart from configuration, and a schema migration for
  `hosts.yml`); the AWS CLI splits `config` from `credentials` and lets profiles reference
  each other; VS Code profiles let each category (settings, keybindings, MCP servers, snippets,
  tasks, extensions) be the profile's own or the Default profile's, a copy at creation for what is
  the profile's own. VS Code is the closest model to "shared or own per item" and, like this plan,
  keeps the choice coarse.

## 9. Options considered and rejected (G)

| Option | Why rejected |
|---|---|
| **One shared dir, switch only the credentials** (claude-swap's model) | one credential at a time, so two accounts cannot run at once; Claudio would write the CLI's credentials (decision 8 of `claude-only-fork`); refresh-token rotation clobbers the sharers (#76561) |
| **Link everything, the state file included** | S1b: lost updates across accounts; identity and plan caches of one account would be read by the other |
| **Copy on every spawn** | a copy of `plugins/` and settings per process is slow, and two processes would race on the copy; changes made inside a chat (a `/model`, an install) would be lost at the next spawn |
| **Per-item switches** | dozens of combinations a person cannot reason about, a rotation that changes items one by one, and a support matrix; the three fixed classes plus one mode cover the requirement, with conflicts as the only per-item interaction |
| **One config dir, the account given only by the environment** | the CLI has variables only for a token (`CLAUDE_CODE_OAUTH_TOKEN`, a `setup-token`: inference-only, no `get_usage`, deprecated in Claudio) and an API key; a `login` account's OAuth lives in the config dir's credentials, with no documented variable; and one state file would mix every account's identity |
| **A neutral shared home** (cma) | Claudio's default account is the person's own `~/.claude`; moving it breaks their terminal `claude` |
| **Managed settings as the shared layer** | root, machine-wide, above everything the person sets, also applies to the terminal |
| **Writing trust into each account's `.claude.json`** | writing another process's state file is no documented interface and races the CLI's lock (S1b) |

## 10. Risks (H, second part)

| # | Risk | Prior art | Mitigation | Stop if |
|---|---|---|---|---|
| R1 | A CLI release starts renaming over linked files | #40857, #76561, #78162 | before-spawn reconcile reports conflicts; the canary re-runs S1/S2 per CLI version | the canary shows links replaced for `settings.json`: then shared mode copies and reconciles instead of linking |
| R2 | Concurrent writers through linked files lose data | #29395 family, S1b | the state file is never linked; plugins go through the CLI per account | S2b shows lost records even with per-account plugins |
| R3 | The overlay reads state-file keys that change | none, inferred | shape check, log, pass nothing | the keys change twice in a quarter: then drop the overlay and document B3-B5 |
| R4 | The overlay re-declares project servers the account never trusted | #79707 discussion | only servers the default's state file trusts; only for shared accounts; a person can turn the overlay off | the vendor documents a trust flag: use it instead |
| R5 | A rotation changes a chat's capabilities | B9 | configuration groups as a tie-breaker; a transcript notice; optional strict grouping | |
| R6 | Reserves starve other projects | none | only while others have room; cap; released at the limit; visible | complaints that work waits while an account shows headroom |
| R7 | Mode switches lose a person's files | VS Code profile copies | moves to `.claudio-own/`, never deletes; restore offered | |
| R8 | Tests write into real dirs (B15) | observed | the fix plan's tests use temp dirs only; investigate B15 first | |

## 11. Decisions for the owner (I)

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | Granularity of requirement 1 | one switch for the install · per account · per item | **per account**, with an install default for new accounts (shared) |
| D2 | What an account that turns independent starts from | copy of the shared configuration · empty | **copy**, empty offered in the dialog |
| D3 | History is shared whatever the mode | yes · follows the mode | **yes** (`projects`, `agent-memory`, `file-history`, `tasks`, `plans`), or rotation and resume break |
| D4 | Plugins for shared accounts | link `plugins/` · reconcile with `claude plugin` per account | **reconcile with the CLI's commands**; revisit links after S2b |
| D5 | The MCP overlay for shared accounts (user, local and trusted project servers through `--mcp-config`) | yes · no (document B3-B5) | **yes**, behind a switch that is on for shared accounts |
| D6 | Reconcile before every spawn | yes · start-up and changes only | **yes** (cheap, self-healing) |
| D7 | A new account and existing project rules | added to them · not added · ask | **ask** in the Add-account flow; not added when nobody answers (today) |
| D8 | No allowed account has room | per origin as in §7.2 | **§7.2**, with the person-only "use another account once" |
| D9 | A running chat on a newly forbidden account | interrupt · move at turn end · leave until it ends | **move at turn end** |
| D10 | Pin outside a rule | refuse · allow and override the rule | **refuse** (409) and show existing ones |
| D11 | Rotation across configuration groups | tie-breaker · strict per rule · ignore | **tie-breaker**, strict as a rule option |
| D12 | Reserve semantics | headroom on the preferred account · a quota share per project | **headroom**, capped at 30 %, released when others are out |
| D13 | Authorise the owed spikes | S2b, S4, S5, S6, S7 | **all**; S5 and S7 cost a few haiku turns, S4 and S6 a scratch sign-in |
| D14 | B15 (tests in real dirs), B13 (orphan) | fix now · later | investigate B15 **before** T1; list B13 on the page, never auto-remove |

## 12. Tasks (J)

Order: spikes; T1 (stops today's bleeding, shippable alone); then the model; then the rules; then
the screens after their design round. Tasks that run in parallel never share a file; tasks that
touch the same file are sequential (stated in "Depends on").

| Task | What it does | Depends on | Files it owns | Model |
|---|---|---|---|---|
| T0 | Run S2b, S4, S5, S6, S7; record results and CLI version | owner's authorisation (D13) | `docs/reports/account-config-spikes.md` | Sonnet |
| T0b | Find how the fake CLI wrote into the real account dirs (B15) | — | `docs/reports/test-writes-real-dirs.md` (fix in its own task if a test is the cause) | Sonnet |
| T1 | **Stop the bleeding.** `reconcileAccountDir` (plan + apply, links and moves only), the full configuration and history item lists, adoption of hand-made links, conflicts reported; called at start-up, on create and before spawn; `writeAtomic` writes through links (accounts and core `config/files.ts`); orphan dirs listed in the log; `docs/accounts.md` corrected ("links made when the source exists, kept in sync before every run") | T0b | `packages/accounts/src/dirs.ts`, `packages/accounts/src/fs.ts`, `packages/accounts/src/store.ts` (call sites only), `packages/core/src/child-env.ts`, `packages/core/src/config/files.ts`, `packages/accounts/test/dirs.test.ts`, `docs/accounts.md` | Sonnet |
| T2 | Plugins reconciled per account with `claude plugin` commands, on start-up and on changes of the default's plugin set | T0 (S2b), T1 | `packages/accounts/src/plugins.ts`, `packages/accounts/test/plugins.test.ts` | Sonnet |
| T3 | The spawn-time MCP overlay (user, local, trusted project servers less disabled ones), one merged `--settings` file, cached on the state file's mtime | T0 (S4, S6), T1 | `packages/accounts/src/overlay.ts`, `packages/core/src/providers/claude-code/args.ts`, `packages/accounts/test/overlay.test.ts`, `packages/core/test/args-overlay.test.ts` | Opus |
| T4 | The mode: contract types, `accounts.json` `config.mode`, switch with copy and move-aside, routes, OpenAPI, `docs/rest-api.md` rows | T1 | `packages/shared/src/types.ts` (account config), `packages/accounts/src/config-mode.ts`, `apps/api/src/routes/accounts.ts`, `apps/api/src/openapi/routes.ts`, `docs/rest-api.md` | Opus |
| T5 | The canary per CLI version (S1, S2, S3c in a temp dir) and its result in the account view | T1 | `packages/accounts/src/canary.ts`, its test | Sonnet |
| T6 | Rules engine: `preferred` and `reserve` in `choose`, `Choice.why`, configuration groups as tie-breaker, the default-equals-today test | T4 (types) | `packages/accounts/src/choose.ts`, `packages/accounts/test/choose-rules.test.ts` | Opus |
| T7 | Work in progress per project and the reserves passed to `pick`; no-room behaviour per origin; forbidden-account moves at turn end; pin refusal | T6 | `packages/core/src/project-activity.ts`, `packages/core/src/chats.ts`, `packages/core/src/rotation.ts`, their tests | Opus |
| T8 | Rules contract: `RotationPolicy` additions, validation, reasons, refusal code, routes, OpenAPI, docs rows | T4, T6 | `packages/shared/src/types.ts` (policy), `packages/accounts/src/store.ts` (policies), `apps/api/src/routes/accounts.ts`, `docs/rest-api.md` | Sonnet |
| T9 | Design round with the owner for §6.5 and the rules' screens (the questions listed there) | T4, T8 contracts | this plan (a section with the decisions) | the owner, with `design-with-references` |
| T10 | Screens: account configuration, conflicts, rules (allowed, preferred, reserve), explanations on chips and events; `/ui-review` | T9 | `apps/web/src/pages/accounts/*`, i18n `en`/`es`, web tests, e2e spec | Sonnet |
| T11 | Documents: `docs/accounts.md` sections for modes and rules, `docs/status.md` | T10 | `docs/accounts.md`, `docs/status.md` | Sonnet |

Nothing is launched by this plan.

## Outcome

**T0 (partial, 2026-11-15)** ([reports/account-config-spikes.md](../reports/account-config-spikes.md)).
S4, S5 and S7 ran on CLI 2.1.322 with two scratch accounts (A and B, Max plan) the owner signed in
for the purpose, on Haiku, for about 0.02 USD in total. S2b and S6 are still owed (S6 needs an OAuth
server sign-in). What they change: the overlay can pass user servers with `--mcp-config` without
fear of duplicates (T3); strict mode must never be used for the overlay (T3); the five history items
must stay linked (T1, already so); `hasClaudeMdExternalIncludesApproved` is another per-project
approval the reconciler cannot supply (T2/T3 note); the canary can take S4's two checks (T5).

Built on `fix/account-links-reconcile`: T0b, then T1.

**T0b** ([reports/test-writes-real-dirs.md](../reports/test-writes-real-dirs.md)). The cause was
`envFor`: the default account kept the base environment's `CLAUDE_CONFIG_DIR` even when it named
another account's dir, which a test run from a chat on a non-default account inherits
(`apps/api/test/accounts.test.ts` signs the default account in with the accounts fake). Fixed in
`envFor` (the default keeps the variable only when it names its own dir), in the test preload
(`scripts/test-tmp-preload.mjs` drops `CLAUDE_CONFIG_DIR`, `CLAUDIO_DATA_DIR` and
`CLAUDIO_WORKSPACE_DIR` when they point outside the run's tmp) and guarded by
`packages/accounts/test/test-isolation.test.ts`.

**T1.**
- `reconcileAccountDir` (`packages/accounts/src/dirs.ts`): a plan from `lstat` calls, an apply that
  only makes links. Lists: configuration `settings.json`, `CLAUDE.md`, `keybindings.json`, `agents`,
  `commands`, `skills`, `rules`, `output-styles`, `workflows`, `themes`, `hooks`; history `projects`,
  `agent-memory`, `file-history`, `tasks`, `plans`. Hand-made links (absolute or relative) are
  adopted and recorded in `links`; a real file or dir or a link elsewhere is a conflict, logged once
  and left.
- Called from the store's constructor (every account), `add`, and `ref()` (the seam every launcher
  uses before a spawn, so `chats.ts` is untouched).
- `writeAtomic` writes through links in `packages/accounts/src/fs.ts` and
  `packages/core/src/config/files.ts` (shared helper `throughLinks`).
- Orphan dirs are logged at start-up and left; `AccountStore.orphans()` lists them.
- `docs/accounts.md` corrected.

**Differs from the plan.**
- No moves yet: the plan's "empty or byte-identical real item moves to `.claudio-own/`" belongs to
  the mode switch (T4); T1 reports every non-link as a conflict, as the task asked.
- The default dir gets no new empty directories: only `projects/` is created when missing (as
  before), so a history dir that the account's CLI creates before the default one has it is a
  conflict that stays reported (open below).
- `ref()` does the before-spawn pass, with no throttle, and records new links with a fire-and-forget
  save.

**Stays open.** The owner's two accounts have a real `agent-memory/` (and `plugins/`): `agent-memory`
is now a reported conflict until T4's "use shared" moves it aside. The race above for history dirs.
`HOME` is not redirected in tests. The two stray fixture files in the owner's dirs and the orphan
`acc-79ffec12` are left for the owner.

**T4** (`feat/account-config-mode`, 2026-11-14): the mode, server side only.
- Contract (`packages/shared/src/types.ts`): `AccountConfigMode = 'shared' | 'independent'`,
  `AccountConfigStart = 'copy' | 'empty'`, `AccountConfigItem { name; kind; class; state; reason? }`
  with `state` `linked | missing | own | absent | conflict | not-in-default`, `Account.config?:
  AccountConfig { mode; state: 'ok' | 'repair' | 'conflict'; items; switching; keptAside }` (absent
  for the default account), `AccountConfigPlan`, `AccountConfigStep`, `AccountConfigRequest`,
  `AccountConfigItemRequest`, `AccountConfigResult`, and `AccountsSettings.newAccountConfig`
  (`shared` by default).
- Stored: `accounts.json` gains `config: { mode, switching? }` per account (absent reads `shared`,
  so every existing account is shared). `switching` (`to`, `start`, and the stamp of its aside dir)
  is written before a switch's first step and dropped when it ends.
- `packages/accounts/src/config-mode.ts`: `planSwitch` and `planUseShared` (from `lstat` calls,
  nothing written), `applySteps` (one atomic step per item; a failure reads `conflict`,
  `reason: 'failed'`, and the next item goes on), `describeConfig` (the served state). To
  independent: links become copies, built under `<dir>/.claudio-switch/<item>.partial`, renamed to
  `<item>` when whole and then into place; `empty` only removes the links. To shared: own items go to
  `<dir>/.claudio-own/<ISO time with - for : and .>/` and the default's are linked. The store
  (`planConfig`, `setConfigMode`, `planItem`, `useShared`, `configOf`) finishes a recorded switch at
  start-up; the before-spawn reconcile skips configuration items for an independent account or one
  mid-switch, and keeps history linked in both modes.
- Routes: `GET /accounts/:id/config`, `GET /accounts/:id/config/plan?mode&start`,
  `PUT /accounts/:id/config` `{ mode, start? }`, `GET /accounts/:id/config/items/:name/plan`,
  `POST /accounts/:id/config/items/:name` `{ use: 'shared' }`; the install default through the
  existing `PUT /accounts/settings`. Writes are `person` (403 to a chat's token), reads are open to
  it.
- History items that are real dirs (the owners' `agent-memory/`): no merge-move, which the plan
  never named. A non-empty one stays a reported conflict until a person uses "use shared", which
  moves it aside whole and links the shared one. §6.2's automatic rule is built in the before-spawn
  reconcile (`dirs.ts`): an empty dir or file, or a regular file byte-identical to the default's (up
  to 1 MB), is moved aside and linked, logged once with what moved and where. A dir is removed with
  `rmdir` after an empty one is made in the aside dir, so a CLI that wrote into it since the plan
  keeps it (`rmdir` refuses, the item stays a conflict); a file moves only while the store knows of
  no live chat on the account (unknown, at start-up, counts as live). This also settles T1's open
  race of a history dir the CLI creates empty before the default has one.

**Differs from the plan.**
- No `POST /accounts/:id/config/repair`: `PUT /accounts/:id/config` with the current mode repairs
  and finishes, and the reconcile runs before every spawn anyway.
- `use: 'own'` and `start: 'restore'` are not built: an independent account has no configuration
  conflicts, and history is never the account's own (D3); restoring a kept copy waits for the design
  round.
- An account born independent (the install default set so) starts from a copy, as one that turns
  independent does.
- A switch to shared also moves aside an own item the default lacks (`move-aside`), so a shared
  account holds the default's configuration and nothing else; the reconcile alone would have left it
  (`own-item`).
- No `plugins` field on `Account.config` (T2; added there, see below).
- `Account.config` is served by the `/accounts` routes only, not by every
  listing: describing a dir costs about 2 ms per account, and `list()` is on the path of every
  account choice (computing it there made the R10 rotation test time out twice under the test
  gate's load).

**Stays open.** No settings-registry row for `newAccountConfig` (no reset button) and no screens:
both wait for T9 and T10. The new routes are not served by a headless Claudio (`headless.ts`); the
image has no page to switch from. A switch does not wait for the account's live chats: a running CLI
sees its configuration change under it. Removing an account deletes the copies kept aside in its
dir. Plugins (T2), the overlay (T3), the canary (T5) and the rules (T6 to T8) are untouched.

**T5** (`feat/cli-canary`, 2026-11-15): the canary per CLI version. Described in
[accounts.md](../accounts.md#the-cli-canary).
- `runCanary` (`packages/accounts/src/canary.ts`): S1, S2 and S3c as the spikes table defines them,
  each in its own dir of one fresh temp dir, with an environment built from nothing. S3c runs the
  project twice, untrusted and trusted, with a loopback MCP server whose `headersHelper` leaves a
  mark. Observed on 2.1.322: all three pass (S1 link kept and the target holds the server; S2 both
  links kept, the plugin enabled in the linked settings and recorded in the linked `plugins/`; S3c
  `failed` with 0 helper runs untrusted, `connected` with 1 trusted), 23 s, no sign-in and no turn.
- Stored in SQLite, `cli_canary`, one row per version and check (`Db.saveCliCanary`, `cliCanary`).
  A per-release record grows for as long as Claudio runs and two processes share the data dir, which
  is CONTRIBUTING's line between rows and a settings file.
- `CliCanaryWatch` (`packages/core/src/cli-canary.ts`) takes each CLI version the system read sees,
  runs the canary when the version has no complete result, one at a time, and logs a failed check once.
- Contract: `CliCanary`, `CliCanaryCheck`, `CliCanaryStatus` in `packages/shared`;
  `GET /accounts/canary` and `POST /accounts/canary/run` (person only; 409 while one runs).
- The Accounts page shows one line (`CliCanaryLine`), the first of T10's screens only in spirit: it
  says the state and lists the checks that did not pass.

**Differs from the plan.**
- A failure only reports. R1's "shared mode copies and reconciles instead of linking" is a change
  of behaviour whose trigger (which checks, how many versions) the plan does not settle, so it waits
  for the owner. S1 is about `.claude.json`, which Claudio never links, so a failing S1 alone does not
  threaten anything today; a failing S2 or S3c does (the links of T1, the overlay of T3).
- A re-run button and a route for it, which the plan did not name: a check that failed by a
  flake would otherwise stay failed until the next CLI version.
- `CLAUDIO_CLI_CANARY=off`, switched off for tests by their preload, so a test's Core does not start processes
  beside the ones it counts.

**Stays open.** What a failing S2 or S3c should switch off (owner). The canary runs once per version
per data dir. `needs-sign-in` was never seen: the three checks ran unsigned on 2.1.322. S2b (concurrent
writers through a linked `plugins/`) is not a canary check.

**T6** (`feat/account-rules-engine`, 2026-11-15): the rules engine in `choose`, with nothing that
sets a rule yet.
- Contract (`packages/shared/src/types.ts`): `AccountSwitchReason` gains `reserve`;
  `AccountChoiceWhy { basis; project?; passedOver? }` with `AccountChoiceBasis` (`pin`, `current`,
  `preferred`, `project-preferred`, `order`, `least-used`, `only-one`, `same-config`,
  `over-threshold`, `reserve-released`, `credits`, `none`) and `AccountChoicePass { account;
  because: 'not-allowed' | 'reserved' | 'other-config'; project? }`. Every `Choice` carries `why`.
- Engine (`packages/accounts/src/choose.ts`): `ChooseOptions.policy` is a `ChoosePolicy`, today's
  `threshold` and `order` plus `preferred?` and `strictConfig?`, so `RotationPolicy` passes as it is
  and T8 only adds the same names to it. `ChooseOptions` gains `project?` and `reserved?:
  AccountReserve[]` (`{ project, account, percent }`); `Candidate` gains `configGroup?`
  (`SHARED_CONFIG_GROUP` when absent). `RESERVE_CAP` is 30.
- Precedence, unchanged in its steps: pin; preferred account (the rule's, else the person's); the
  current account under its threshold; the accounts with room (the work's configuration group
  first, then the strategy); the current account over its threshold; any account not out (unreserved
  first); credits as a last resort; wait. An account the rule does not list is never a candidate in
  any step, credits included.
- Reserve (D12): for work of any project other than the reserving one, the reserved account's
  threshold and margin are `percent` points lower (largest reserve on the account, capped at 30).
  Off it under the work's own threshold, the reason is `reserve`. When nothing has room, work goes
  to any unreserved account that is not out, over its threshold too, before the reserved one; the
  reserved headroom is used only when every other account is out (`why.basis: 'reserve-released'`,
  with the reserving project). A pin beats a reserve.
- Configuration groups (D11): `AccountStore.configGroupOf` reads the stored mode (shared and the
  default are one group, each independent account its own; mid-switch keeps the mode it leaves), no
  dir read, and `pick` passes it. Among accounts with room, and among the spare ones, the current
  account's group ranks first; never over room; new work (no current account) is unaffected.
  `strictConfig` keeps rotation inside the group (a pin is exempt) and waits for the group's resets.
- Credits compose by exclusion: the rule's allow list filters every step, the last-resort step and
  the resets to wait for, so credits never let an excluded account run; an account on `allow`
  credits is "not out" and meets the reserve like any account over its threshold; the last-resort
  step ignores reserves (a spent plan has no headroom left to keep).
- The default-equals-today proof (`packages/accounts/test/choose-rules.test.ts`): the choice as it
  was before T6 (main after #141, the credits stop) is frozen in `test/fixtures/choose-before-rules.ts`, and 20 000 generated situations
  (sign-in states, readings, overage, scoped limits, both strategies, preferred, order, credits and
  caps, today's policies, pins, models, failed accounts) give the same account, reason, wait and
  credits; again with every account in the shared group and with reserves of the work's own project.
  The tests written before T6 pass unchanged but for `bare()`, which drops `why` from their
  `deepEqual`s.

**Differs from the plan.**
- `reserve-released` is a `why.basis`, not an `AccountSwitchReason`: a switch's reason says why the
  work left its account (`limit`), which the destination's reserve does not replace.
- `rule` is not produced by `choose`: a current account outside the rule still reads `threshold`
  (today's reason, so today's policies behave exactly as before); `why.passedOver` names it
  `not-allowed`, from which T7 records `rule` when it moves a chat at turn end.
- §7.2's "a reserve only diverts work while another allowed account is under its own threshold"
  yields to D12 ("released when the other accounts are out"): work goes to an account over its
  threshold before it uses reserved headroom.
- "Only one with room" is `only-one` when exactly one account had room; a configuration group
  changes ranking only, so with every account shared nothing changes, and an install with an
  independent account sees the tie-breaker without any rule (D11).

**For T7 and T8.** T7 computes `reserved` from work in progress (the reserve's account is the rule's
`preferred`, else the first of its `order`), passes `project` with the policy, records `rule` from
`passedOver`, and uses `why` for the no-room messages. T8 adds `preferred`, `reserve: { percent }`
and `strictConfig` to `RotationPolicy` with validation (preferred within `order`, percent 1 to 30, at
most one reserve per account), the `not-allowed` refusal, and labels for `reserve` and the bases
(today the web shows an unknown reason as its raw text).

**T8** (`feat/account-rules-contract`, 2026-11-15): the rules' contract, with no screen.
- `RotationPolicy` (and `RotationPolicyRequest`) gain `preferred?: string`, `reserve?: ProjectReserve`
  (`{ percent }`) and `strictConfig?: boolean`; the routes stay `/accounts/policies` (GET, POST, PUT,
  DELETE), so no new route, no new row, and their OpenAPI text and `docs/rest-api.md` rows say the
  new fields. Everything is optional: a policy with none of them is stored and chosen exactly as
  before.
- Validation (`AccountStore.validPolicy`, 400): `preferred` one of `order`, or a known account when
  there is no `order`; `reserve.percent` a number from 1 to 30 (`RESERVE_CAP`); a reserve needs a
  `preferred` or an `order` to know its account (`reserveAccountOf`, new in `choose.ts`: the
  preferred, else the first of the order); at most one rule reserves on an account; `strictConfig`
  a boolean, stored only when true. A file edited by hand is read defensively. Removing an account
  clears `preferred` and drops a reserve left with no account or on one another rule holds
  (`settleReserves`).
- Refusals (D10). `AccountSwitchRefusalCode` gains `not-allowed` (the person's switch, 409 with
  `reason`), and `ChatStartRefusalCode` gains `account-not-allowed` (start, resume and fork with an
  `account` outside the rule, 409 with `code`, raised in `ChatManager.admit` before anything is ended
  or created). `allowsAccount(policy, account)` in `@claudio/accounts` is the one test: no rule, or a
  rule with no `order`, allows every account.
- Reasons: `AccountSwitchReason` gains `rule` (T7 records it). The Accounts page says `reserve` and
  `rule` in words, and `accountsConfig.json` (`en`/`es`) has labels for every `why.basis` and every
  `passedOver.because`, for the chat chip and event rows T10 draws; nothing renders them yet.

**Differs from the plan.** The pin refusal is not only T7's: T8 raises it at the three places a pin is
set from a request (start, resume, fork) and at the composer's switch, because the codes are
contract. What T7 still owns is the rest of the pin story: orchestrations that pin (their start now
fails with the 409), and the existing pins, which `choose` keeps ignoring (B16) and nothing shows yet.
The plan wrote the start refusal as `account-not-allowed` and the switch's as `not-allowed`; both
exist, one per surface, as the plan's two sections ask. A rule's `preferred` without an `order` is
allowed (any known account), since without a list every account is allowed.

**For T7.** `reserved` is `policies().filter((p) => p.reserve)` mapped to `{ project, account:
reserveAccountOf(p), percent }` for each project of the rule, active only while that project has
work in progress; pass `project` and the rule's `preferred`/`strictConfig` through `policyFor`, which
already returns them (the policy is a `ChoosePolicy`). Record `rule` when `why.passedOver` names the
current account `not-allowed`. A rule's `looseChats` has no project id: its work in progress is the
chats of no project. Moving a chat whose pin a rule forbids is T7's too: its `chat.opts.account`
was set before the rule existed, and the refusal here never sees it.

**T7** (`feat/project-activity-reserves`, 2026-11-15): the rules at work. Described in
[accounts.md](../accounts.md) (rules at work).
- Work in progress (`packages/core/src/project-activity.ts`): `ProjectActivity` holds sources, each
  answering with the folders its work runs in, all from memory: the chats with a turn running,
  starting or held at a limit (`ChatManager`), the orchestrations `running` or `waiting`, and the
  schedules whose next slot is within `RESERVE_HORIZON_MS` (one hour), computed on the scheduler's
  tick (`Scheduler.dueSoon`). A folder's project is cached for 30 s on an injected clock.
  `reserves(policies)` asks no source while no rule has a `reserve`; `reservesOf` places each active
  project's reserve with `reserveAccountOf`. Chats of no project are the key `NO_PROJECT` (`''`), which
  `choose` compares like any project and never shows as a project in `why`.
- Every `pick` of `chats.ts` (launch, `chooseNext`, `roomFor`, the credits check) goes through
  `ruleOf`: the policy, the project and the reserves. `ruleReason` turns a move off an account the
  rule passed over as `not-allowed` into reason `rule`.
- D9: `enforceRules` runs on every `AccountStore.onChange` and returns after one comparison unless
  the rules' projects or orders changed; a chat with a live process on a forbidden account gets a
  pending switch (`settleRule`), applied with reason `rule` between turns, and at the end of each
  turn the chat's rule is looked at again. With no allowed account free, the chat goes to the rule's
  first usable account (`stayOrAllowed`), never stays on a forbidden one.
- D8: `SwitchChatAccountRequest.once`; the rotation names the rule in a person's notice and in an
  automated wait's reason (`noRoomWords`, from `why.passedOver`); `Scheduler.accountHold` skips a
  slot through `ChatManager.noRoomUnderRule`.
- The default-equals-today proof at the chats level (`packages/core/test/project-rules.test.ts`): with
  no rule, no source of work in progress is read, no reserve is passed, every choice equals the call
  as it was before T7, and nothing moves.

**Differs from the plan.**
- Queued flow runs are not a source: a flow run's work is its chat, counted while its turn runs, and
  the queued rows are in SQLite, which a choice must not read.
- No orchestration pins an account in today's contract (an eval run does, and its chats meet T8's
  refusal at start), so there was no orchestration pin to refuse.
- Existing pins outside a rule are not marked in the API: `why.passedOver` names the pinned account
  `not-allowed` on the chat's next choice, which is what T10's chip can read.
- The person's notice names the project by id: the core's `projectOf` gives ids, and the page has the names.

**For T10.** The banner's "use another account once" is `POST /chats/:id/account` with `once: true`
(the account list there shows the accounts the rule does not allow); the notice and the wait's
`reason` carry the words; rotation events have reason `rule` and `data.once`; "reserved for project
X while it has work" needs the reserves served (`ChatManager.activity.reserves`), which no route
does yet.

**T3** (`feat/mcp-overlay`, 2026-11-15): the spawn-time overlay of a shared account. Described in
[accounts.md](../accounts.md#an-account) and [cli-surfaces.md](../cli-surfaces.md#the-state-file-keys-the-overlay-reads).
- `packages/accounts/src/overlay.ts`: `readStateConfig` (the state file's configuration keys, a
  `ShapeError` on a changed shape), `projectKeyOf` (the main checkout, a worktree's included, S3d),
  `readProjectServers` (the `.mcp.json` files from the working folder up to the checkout),
  `buildOverlay` (user, then trusted project, then local servers, less `disabledMcpServers` and
  `disabledMcpjsonServers`; the `.mcp.json` approval keys as settings) and `McpOverlay`, cached per
  working folder on the mtime and size of the state file and of the `.mcp.json` files.
- `AccountRef.sharedConfig`, set by `AccountStore.ref` for a non-default account in `shared` mode
  with no switch under way (the same predicate as the before-spawn reconcile).
- `packages/core/src/account-overlay.ts` (`AccountOverlay`), hooked into `ClaudeCodeDriver.launch`
  as `accountOverlay` (set by `ChatManager` beside `modelSource`, one line in `chats.ts`'s
  constructor). It joins the overlay's servers with the chat's non-strict `--mcp-config` file (Claudio's
  own server and callers' additions win a name) and the overlay's settings under the guard's into one
  file; `SessionLaunch.settingsFile` makes `buildArgs` pass one `--settings`. Files are
  `<data>/mcp/overlay-<chat id>-<hash>(.settings).json`, 0600, cleaned with the extras files
  (`removeChatExtrasConfigs`). `CLAUDIO_ACCOUNT_OVERLAY=off` is the off switch.
- Proved on CLI 2.1.322 in a scratch, signed-out dir with `mcp_status` (no turn): with no flag a
  project's two stdio servers connect; `--settings` with `disabledMcpjsonServers` drops the one named
  (B5 for project servers); with the overlay's `--mcp-config` a user server is added and connected
  (B4), the project server re-declared by the flag connects from the flag's definition with no
  duplicate (S4), the disabled one stays off, and nothing is strict. B3 rests on S3e (a flag-given
  server's `headersHelper` runs without trust), which was not re-run.

**Differs from the plan.**
- `hasClaudeMdExternalIncludesApproved` is not carried: it is a state-file key only (no setting reads
  it, S7), so the overlay logs once per project that relies on it. The per-project `allowedTools` of
  the state file is not carried either; the plan did not ask for it.
- A chat that chose its servers gets no overlay: its strict file already holds definitions read from
  the default's files, and adding the overlay would break the choice. §6.4's "merged into the chosen
  set" is that.
- D5's "switch that is on for shared accounts" is a server-wide `CLAUDIO_ACCOUNT_OVERLAY=off` for
  now; a per-account switch waits for T9/T10's screens.
- A server the account has of its own under a name the overlay also carries is shadowed by the
  default's (the flag wins, S4): a shared account runs the default's configuration.

**Stays open.** S6 (OAuth MCP servers across accounts: the token is kept per config dir, so an
OAuth server passed by the overlay may need its own sign-in on each account). A canary check for S3e
(flag-given servers skip trust), which B3's fix depends on and the canary does not test today.

**T2** (`feat/account-plugins`, 2026-11-15): plugins reconciled per account with `claude plugin`
commands. Described in [accounts.md](../accounts.md#plugins-of-a-shared-account).
- `PluginReconciler` (`packages/accounts/src/plugins.ts`): for every shared account (not the default,
  not independent, no switch left half-way: `AccountStore.pluginTargets`), the user-scope plugins the
  default has switched on are installed, and updated when the version differs, with
  `CLAUDE_CONFIG_DIR=<account dir> claude plugin marketplace add|update`, `install`, `update` and
  `uninstall`, one account and one command at a time, 90 s each, closed stdin, no credential in the
  environment. The default's state is read from `installed_plugins.json`, `known_marketplaces.json`
  and `settings.json`, never written. `planPlugins` is pure (the plan as commands); `diffPlugins`
  is the read-only view.
- When: start-up, a watch on the default dir and its `plugins/` (the three files, 3 s debounce), and a
  change of the set of shared accounts (`Core` nudges on `accounts.onChange` only when the targets
  changed). A spawn never waits. An account with a live chat is deferred, said once, and retried on
  a 2 minute timer that exists only while one waits. `CLAUDIO_ACCOUNT_PLUGINS=off` and the test preload
  switch it off.
- Uninstall only what Claudio installed (`<account dir>/.claudio-plugins.json`) and the default has
  dropped; a plugin a person installed on the account is never removed.
- Served: `Account.config.plugins: AccountPlugins { missing, differing }` (new in `types.ts`, schemas
  regenerated; no route changed). Empty for an independent account.
- B6 and B7 are proved with the fake CLI (`test/fake-plugin-claude.mjs`): an account lacking
  `code-review@official` and running `sluice@sluice` 0.5.0 against the default's 0.12.1 ends with
  both at the default's, the commands run in the account's dir and the default's records are
  byte-identical afterwards. And against the real 2.1.322 in a scratch dir (directory marketplace,
  `HOME` there too): install, a version bump and an uninstall by the default all reached the account.
- **S2b** (run, plugin commands only): see [the report](../reports/account-config-spikes.md#s2b-concurrent-plugin-writers-through-a-linked-plugins-run-2026-11-15-t2).
  Install records through a linked `plugins/` survived 36 concurrent installs, but the linked
  `settings.json` lost `enabledPlugins` entries in all three rounds (a read-modify-write). So D4
  holds, and the reconciler is serial; a link for `plugins/` is not worth taking.

**Differs from the plan.**
- Not reconciled: a plugin the default has disabled (an install would enable it in the shared
  settings), project and local scopes, and a marketplace whose source the CLI cannot add again
  (`settings` or `hostPattern` kinds): logged once.
- A version cannot be pinned (`plugin install` takes the marketplace's latest), so an account whose
  marketplace is behind or ahead of the default stays `differing` and is not asked again until a
  version moves.
- No `-y`: a plugin whose marketplace declares an install command fails and is reported, never
  accepted for a person.
- The default's own writes: a command running while the default's CLI writes `settings.json` can lose
  that write (S2b). The pass is serial, and only runs when something differs.
- Deferral is per account on a live chat, not "only if a running CLI could be affected": an update
  or uninstall changes files a running CLI may read, and no distinction was worth the doubt.

**Stays open.** A shared to independent switch does not install anything (the account already holds
its own plugin set from reconciling). No Settings row or button for a manual repair (the page's
Repair is T10's, and `PluginReconciler.run` is what it would call; no route exposes it yet).

**For T10.** Render `config.plugins` of a shared account: nothing when both lists are empty (the
common case); otherwise one line under the configuration state, in words ("Plugins differ from the
default: code-review is missing, Sluice is at another version"), the ids as mono literals
(`plugin@marketplace`), status `warn` (needs repair), never `bad`. An independent account shows
nothing (it is meant to differ). `accounts.changed` already refreshes the page after a pass.

**T9** (the owner, 2026-11-15): the design round, decided by the owner in place of a separate
session.
- **Where.** Each account's configuration mode and state on that account's card; the mode new
  accounts start in on the existing accounts settings card.
- **What shows.** Only problems: a state with its word and status colour, **In sync** (ok),
  **Needs repair** (warn), **Conflict** (bad); the item list only when something needs action.
- **A conflict** reads in words, with no diff tool: which item, what the account holds, what the
  shared one holds, and **Use shared**, which keeps the account's copy aside (its plan route says
  where first).
- **The mode switch** dialog says before confirming what is copied, what is kept aside and where
  (the plan route), with copy as the start and empty offered.
- **Project rules** (allowed accounts, preferred account, reserve 1 to 30, strict configuration) live
  in each project's settings, on the `/accounts/policies` routes. All optional: with no rule only
  "Add a rule" shows.
- **Phone.** Actions in a `Sheet`, 44 px targets, inputs at 16 px. Night Shift only.

**T10** (`feat/account-config-screens`, 2026-11-15): the screens, as
[design-system.md](../design-system.md#an-accounts-configuration-and-a-projects-account-rule) describes them.
- Account card (`AccountConfigLine`): mode, state, conflicts in words with **Use shared** (a
  confirmation naming the aside dir), **Repair** for missing links or a half-way switch (`PUT` with
  the mode it is in, or the one it was switching to). The mode switch is in the card's `⋯`
  (`AccountConfigDialog`, from `GET /accounts/:id/config/plan`).
- Accounts settings card: **New accounts start with** (`newAccountConfig`), with its Changed · Reset
  slot: the setting id `accounts.new-account-config` joins the settings registry (T4's open item).
- A reserved account's card names the projects it keeps headroom for.
- Project settings (`ProjectRuleCard`): the rule that governs the project, written back whole at each
  change so no field is dropped; a rule that governs other projects too says so. The Accounts page's
  policy list names the preferred account, the reserve and strict configuration, and its form keeps
  them on save (before, saving a policy there would have dropped T8's fields).
- "Use another account once" (D8, on T7's `once`): the composer's account list, and the limit banner's
  Switch account that opens it, read the project's rule (`/accounts/policies`, through the chat-ui
  client's optional `accountPolicies`) and offer an account the rule leaves out as pressable, with
  "Not allowed by the project's rule: for one turn only"; choosing it sends `once: true`. The
  Accounts page's rotation log adds "for one turn, outside the project's rule" to a switch whose
  `data.once` is set, and says reason `rule` in words.
- Transcript: a person's switch across configuration groups reads "Switched to X, which has its own
  configuration" (or "uses the shared configuration"), judged in `@claudio/chat-ui` from the
  `/accounts` list the page already holds (`configCrossing`, the same grouping as `configGroupOf`).

**Differs from the plan.**
- `Choice.why` is not served by any route (it stays inside `pick`), so the chat chip shows no basis
  and no "pin ignored by the rule" yet; the events say `reserve` and `rule` in words. Serving `why`
  (on the chat summary and in the rotation events' `data`) is core work after T7.
- The rule's no-room notice and an automated wait's reason are English text from the core that name
  the project by id; the page shows them as they are. Giving the notice `data` (`reason: 'rule'`,
  the project id) would let the page name the project and offer the once path in place.
- "Keeps headroom for X while it has work" is read from the rules, not from whether the reserve is
  active now: no route serves `ChatManager.activity.reserves`, and none was added.
- The transcript line covers a person's switch only: the rotation's own notice at a limit
  (`rotation.ts`) carries no `data` with its accounts, so the page cannot tell which configuration it
  crossed into. Adding `{ account, from }` to that notice is core work.
- D7 (the Add-account flow asking whether a new account joins the existing rules) is not built.
- Plugins that differ from the default's (§6.5) are not shown: `Account.config` has no plugins field
  until T2.

**T11** (`feat/accounts-finish`, 2026-11-15): the leftovers T10 named, T2's plugins line, D7, the
restart-cut badge, and the documents.
- **No room under a rule, as data.** `noRoomRuleOf` (`project-activity.ts`) gives `NoRoomRule`
  (`packages/shared`): the project id (null for chats of no project), the earliest reset among the
  allowed accounts and the `choices` left (`wait`; `once` too for a person's chat). The rotation's
  notice to a person carries it as `data: { reason: 'no-room', rule }`; a wait stores it
  (`provider_moves.rule`, a JSON column, migration) and serves it as `ProviderMove.rule` and
  `LimitWait.rule`, which every work's wait reads through `openWaitOf`. A person's own "Wait for the
  reset" under a rule gets it too. The English `reason` and notice text stay for logs and older
  pages. The transcript (`@claudio/chat-ui`, `claudio-no-room` line) and every `WaitLine` say it in
  `en`/`es` with the project's **name**.
- **Why this account.** `ChatManager` keeps the `why` of the choice that put a chat on its account
  (`LiveChat.accountWhy`; a rotation move carries the `chooseNext` choice it acted on) and serves it as
  `Chat.accountWhy`; `choose` adds `why.pinIgnored` when the rule's list leaves out the chat's pin.
  The composer's Account entry shows the basis as its second line, and the chat's own row in the
  account list the same with the ignored pin by name (labels in `chat.json`, `composerMenu.account.why`).
- **The rotation's own move** at a limit says `data: { reason: 'rotation', account, from, cause }`,
  so the transcript draws "At the usage limit, moved to X" with the configuration clause T10 drew for
  a person's switch.
- **D7.** The Add-account dialog asks, while a rule lists its accounts, "Allow it on the projects
  with a rule" (a `Switch`, off by default). On, the new account is added to every such rule once
  it exists (an API key at once, a login when its sign-in succeeds), each rule written back whole
  through the existing `PUT /accounts/policies/:id`.
- **Plugins line** (T2's "For T10"): `.account-config-plugins` under the configuration state of a
  shared account whose `config.plugins` lists anything, in warn with its icon and words, ids in mono.
- **The restart-cut badge.** The header's health badge read the red "Stuck" for a chat a restart cut,
  beside #150's warn Resume notice: `chatHealth` made an `interrupted` last execution a `bad` signal,
  and the web named every `bad` "Stuck". It is now `warn`, and `healthWord` names a verdict about the
  last execution **Interrupted** (warn, `Zap`) or **Failed** (bad, `TriangleAlert`), the words, tones
  and icons of the side panel's outcome badge, whose `interrupted` is now warn too. The design
  system's status table moves *interrupted* from bad to warn; CLAUDE.md's list still says bad and
  is the owner's to edit.
- **Documents.** [accounts.md](../accounts.md#in-short-an-accounts-configuration-and-a-projects-rules)
  gains the person's guide to both halves; design-system.md and `claudio-ds.css` the new variants.

**Differs from the plan.**
- D7 is done by the page with the routes that exist, not by a field of the add routes: the rules are
  written after the account exists, so a failure leaves the account added and says so in a toast.
- `accountWhy` is memory only, like `atLimit`: absent after a restart until the chat's next choice,
  and absent after a person's switch, which explains itself.
- The schedule's skip reason stays English text in its run history (its other skip reasons are too).
- "Keeps headroom for X while it has work" is still read from the rules, not from the reserves active
  now: no route serves `ChatManager.activity.reserves`.

## Closing summary

The owner asked (2026-11-13) for a per-account choice between a shared and an own configuration,
and for optional project rules: which accounts may work on a project, which it prefers, and headroom
for a project with work in progress. Both are built, and with no rule and every account shared,
Claudio chooses exactly as before (frozen by `choose-rules.test.ts` and `project-rules.test.ts`).

**What was built.** T0b and T1 stopped the bleeding (links kept in sync before every run, writes
through links, the tests' writes into real dirs found and fenced). T4 the mode, with a plan before
every switch and nothing ever deleted. T5 the CLI canary per version. T3 the MCP overlay for shared
accounts. T2 plugins reconciled with `claude plugin`. T6 to T8 the rules: the engine with `why`, work
in progress and reserves, no-room by origin, the forbidden-account move at turn end, the pin refusal,
the contract. T9 the owner's design, T10 the screens, T11 the leftovers above and the documents.
Every part reaches Claude Code only through what it ships: `CLAUDE_CONFIG_DIR`, symlinks, documented
flags (`--mcp-config`, `--settings`), `claude plugin` commands and the files the CLI writes.

**What differs from the study.** No `POST …/config/repair` (applying the mode again repairs); a
`reserve-released` basis rather than a switch reason; a `rule` reason recorded by core, not by
`choose`; no orchestration pin to refuse; the overlay is a server-wide switch, not per account; D7 is
the page's; the plugin reconciler cannot pin a version and does not reconcile disabled plugins or
project and local scopes. Each task's "Differs from the plan" above has the detail.

**What stays open.**
- **S6**: OAuth MCP servers across accounts. Run on 2026-11-20; the design that follows from it
  waits for the owner in [MCP sign-ins of shared accounts](#s6-follow-up-mcp-sign-ins-of-shared-accounts-2026-11-20).
- **R1, the canary's fallback**: what a failing S2 or S3c should switch off (shared mode copying and
  reconciling instead of linking) and after how many versions is the owner's call; today a failure
  only reports.
- **The residual `settings.json` write race (S2b)**: a `claude plugin` command running while the
  default's CLI writes `settings.json` can lose that write (read-modify-write through the link).
  The reconciler is serial and runs only when something differs, which narrows it, not closes it.
- Smaller: a canary check for S3e (flag-given servers skip trust); serving the active reserves;
  `hasClaudeMdExternalIncludesApproved` not carried by the overlay; a removed account deletes the
  copies kept aside in its dir; the new routes are not served by a headless Claudio.

## S6 follow-up: MCP sign-ins of shared accounts (2026-11-20)

**Asked by the owner (2026-11-16).** Two shared accounts failed to authenticate to MCP servers that
work on the default, and their cards said plugins differ. The owner's position: when an account shares
the configuration, Claudio should also share the sign-ins of its MCP servers.

**Why it happens.** The overlay (T3) passes the default's server definitions to a shared account,
but the OAuth token of a remote server lives in the account's own `.credentials.json` (`mcpOAuth`),
beside its login (`claudeAiOauth`). The file cannot be linked, because the login must stay per
account. So a shared account gets the server and not the token, and the CLI answers 401 until
someone signs in to that server on that account. Nothing in the plan decided this; S6 was left open.

**What S6 measured** ([report](../reports/account-config-spikes.md#s6-oauth-mcp-servers-across-accounts-run-2026-11-16-and-2026-11-20)):
copying one `mcpOAuth` entry is enough, and its key (`name|sha256({type,url,headers})[:16]`) does
not depend on the config dir. Entries with no refresh token, or from a server that does not rotate,
can be copied safely. For a server that rotates refresh tokens with reuse detection, a stale copy
revokes the grant and signs out every account that holds it, the default included. Propagating the
newest entry after each refresh works when runs are serial. Claudio cannot serialise two CLIs that
refresh the same token at once, and copies made together expire together.

On the owner's machine, 11 of the 14 entries of the default carry no refresh token (static or
long-lived access tokens). Three do: `openseo`, `stripe` and `context7`.

### What Claudio would do

A **sign-in reconciler** in `@claudio/accounts`, beside the plugin reconciler and with its shape:

- **Targets**: shared accounts only (`AccountStore.pluginTargets`'s rule: not the default, not
  independent, not mid-switch). An independent account is meant to differ and is left alone.
- **Reads and writes only `mcpOAuth`**, through a read-modify-write of the account's
  `.credentials.json` with the file mode kept at 0600 and a write to a temporary file then a rename.
  It never reads anything out of `claudeAiOauth` beyond keeping it as it is, never logs a token, and
  never sends one anywhere: Claudio makes no OAuth request of its own (the one rule: no second login).
- **Copies** an entry from the source when the target lacks its key, or holds an entry with no access
  token (the CLI's emptied entry), or holds an older one (`expiresAt`, when both have it). It never
  copies an entry without an access token, and never removes an entry it did not write: like
  `.claudio-plugins.json`, it records what it copied, and removes those only when the source drops
  them.
- **When**: before every spawn on a shared account (D6, with the links), on a watch of the source's
  file, and after a CLI process of a shared account exits. An account with a live CLI is deferred, as
  the plugin reconciler does, so Claudio never writes the file under a running CLI.
- **Served**: `Account.config.signIns: { missing: string[]; ownOnly: string[] }` (server names). The
  card says, in warn with words, which servers need a sign-in on this account and why ("rotates its
  sign-in, sign in here once"). Nothing shows when both are empty.
- **Canary**: a check `s6` in `runCanary` with the spike's local fake server: the key formula and a
  copied entry accepted. A failing check stops the copies (unlike S1 to S3c, the failure mode here
  is a 401, so reporting alone would leave the owner where they are today).

### Decisions for the owner

| # | Question | Options | Recommended |
|---|---|---|---|
| S6-D1 | Which entries are copied | (a) only entries with no refresh token; (b) also entries with a refresh token, propagating the newest after each refresh; (c) (a) by default, (b) per server once Claudio has seen that its refresh token does not change on refresh | **(c)**: covers 11 of 14 servers at once with no risk, and the rest as soon as one refresh proves the server does not rotate. A rotating server is listed on the card as needing one sign-in per account, which is what its grant allows |
| S6-D2 | Direction | (a) default → shared accounts only, the default's file only read; (b) union across the shared group, the newest entry wins, written into the default too | **(a)**: the default is the person's own `~/.claude`, which a terminal `claude` outside Claudio may be writing at the same time, and every other reconciler only reads it. A server signed in only on a shared account (`umami` today) is named on the card: sign in on the default and it reaches the others |
| S6-D3 | A rotating server under (b) | allowed by a per-server switch after a warning, or never | **never** in this round: the failure signs out every account, and the CLI empties the entries |

**Decided by the owner (2026-11-20): the recommended option of all three.** S6-D1 (c), S6-D2 (a),
S6-D3 never.

### Risks

- The `mcpOAuth` key and fields are undocumented; the canary check above guards the format.
- A copy can reach a CLI whose auth-failure cache (`mcp-needs-auth-cache.json`, per dir) still marks
  the server as needing auth; whether that delays the copy by its TTL is not measured. Task 1 measures
  it and, if it does, removes that server's line from the target's cache file.
- A person running `claude` in a terminal on a shared account's dir is not seen as a live CLI.
  Writes are atomic renames, so the risk is a lost write of the CLI's, not a torn file.
- Linux only. On macOS the CLI keeps `mcpOAuth` in the Keychain item of the login (#90647); Claudio's
  desktop is Linux and the headless image is Linux, so that design is not needed now.

### Tasks (after the decisions)

| # | Task | Files | Model |
|---|---|---|---|
| S6-T1 | Measure the auth-failure cache on a copy; the canary check `s6` with the local fake server | `packages/accounts/src/canary.ts`, its test, the report | Sonnet |
| S6-T2 | The sign-in reconciler (copy rules, deferral, record of copies, rotation learned per server for S6-D1 (c)), served as `Account.config.signIns` | `packages/accounts/src/sign-ins.ts` (new), `packages/shared/src/types.ts`, OpenAPI schemas, tests with a fake CLI and fake server | Opus |
| S6-T3 | The card line, `en`/`es`, and accounts.md | `apps/web` account card, i18n, `docs/accounts.md`, `docs/cli-surfaces.md` | Sonnet |

**S6-T1 (2026-11-20): done.** The auth-failure cache **does** delay a copied entry: on CLI 2.1.325 a
dir whose `mcp-needs-auth-cache.json` holds a line for the server stays `needs-auth` with the copy in
place until the line is 15 minutes old (14 min: delayed, 16 min: connects), and drops at once when the
line is removed ([report](../reports/account-config-spikes.md#s6-oauth-mcp-servers-across-accounts-run-2026-11-16-and-2026-11-20),
verified). **The reconciler (S6-T2) must therefore, whenever it copies an entry for a server, remove
that server's key from the target's `mcp-needs-auth-cache.json`** (`{"<server name>": {"timestamp": ms}}`;
keep the other keys, write atomically, do nothing when the file is absent), under the same "no live CLI"
deferral as the copy. The check `s6` is in `runCanary` (`checkS6`): a local bearer-only HTTP server, a
dir without the entry (must not connect) and a dir with it under `mcpOAuthKey` (must be `connected`).
The key formula lives in `packages/accounts/src/mcp-oauth-key.ts` (`mcpOAuthKey({ name, type, url,
headers? })`, exported from the package); S6-T2 imports it. **The served state** is the existing one:
`CliCanaryWatch.status().result` (`GET /accounts/canary`) for the CLI version read; the reconciler
stops copying when that result has `s6` with `state: 'fail'`. `needs-sign-in` and `error` do not stop
it (they say nothing of the CLI), and neither does a result with no `s6` yet (an older stored one is
run again, since `s6` joined `CANARY_CHECKS`). Differs from the plan: the row's files grew by the
shared check id (`CliCanaryCheckId`, `CANARY_CHECKS`), the regenerated OpenAPI schemas, the two
`canary.checks.s6` / `canary.whenFailed.s6` i18n strings (the Accounts page lists a failed check by
id) with the strings snapshot, and `docs/accounts.md`, `docs/rest-api.md` and the route's description.

**S6-T2 (2026-11-20): done.** `SignInReconciler` (`packages/accounts/src/sign-ins.ts`) copies the
default's `mcpOAuth` entries into each shared account's `.credentials.json` (targets:
`AccountStore.pluginTargets`), the default's file only read. It copies an entry with an access token and
no refresh token, and one with a refresh token only for a server marked `stable`; a stub (no access
token) is never copied. It copies when the account lacks the key, holds the CLI's emptied entry, holds
an older one by `expiresAt`, or still holds Claudio's own copy of an older token. Rotation is learned
per `mcpOAuth` key from every dir it reads (the default and each shared account): the access token
changed with the same refresh token marks `stable`, a changed refresh token marks `rotating`, and
`rotating` is never undone (a fresh sign-in looks the same, and the safe error is a sign-in too many).
Only 16-hex sha256 prefixes of the tokens are kept, in `<data dir>/account-sign-ins.json`; Claudio's own
writes are remembered without being read as a refresh. The credentials file is edited as text: only the
value of `mcpOAuth` is replaced, so `claudeAiOauth` keeps every byte; the write is a temp file at 0600
renamed over it, and a file that is a link is left alone. What it copied is recorded with hashes in
`<account dir>/.claudio-sign-ins.json` and removed only when the default drops the key and the account
still holds that copy (same access token, or the same refresh token refreshed by the account's CLI).
Each copied server's line goes from the account's `mcp-needs-auth-cache.json` (the other lines and the
file's mode kept, no file made). An account with a live chat is deferred (a 2 minute retry timer that
exists only while one waits); a failed `s6` in `CliCanaryWatch.status().result` stops every write. It
runs in `AccountStore.ref` (`beforeRun`, so before every spawn on a shared account), on a watch of the
default's dir for `.credentials.json`, after a CLI process of any account closes (the runtime's new
`process-closed` event), when the set of shared accounts changes and when the canary's result changes.
Served as `Account.config.signIns: { missing, ownOnly, rotating }` (server names, `AccountSignIns`).
`CLAUDIO_ACCOUNT_SIGN_INS=off`, and the test preload's `claudio.accountSignInsOff` flag, keep it from
starting; the served lists are still read. Differs from the plan: the served shape adds `rotating` (the
plan's card copy "rotates its sign-in, sign in here once" needs it apart from `missing`); a server not
yet seen to refresh is listed under `rotating` too, since it needs a sign-in on the account until a
refresh proves otherwise. A copy of Claudio's still untouched on an account is removed when its server
turns out to rotate (the stale grant is what a reuse revokes for every account). The rows touched beyond
the plan's: `packages/accounts/src/store.ts` and `config-mode.ts` (the hooks), `packages/core/src/index.ts`
and `chats.ts` (wiring, the exit event), `scripts/test-tmp-preload.mjs`, the web test's config fixture,
the web module-graph fixture (the new type) and `docs/status.md`'s counts.

## The owner's decisions (2026-11-13)

Taken the day the study was written. Every decision of the table in section 11 is the recommended option:

- **D1** per account, with an install default (shared) for new accounts. **D2** an account that turns independent starts from a copy of the shared configuration, with empty offered in the dialog. **D3** history is shared whatever the mode. **D4** plugins are reconciled with the CLI's own commands, not linked. **D5** the MCP overlay for shared accounts. **D6** reconcile before every spawn. **D7** the Add-account flow asks whether the new account joins the existing rules. **D8** what happens when no allowed account has room follows section 7.2, by origin, with the person-only "use another account once". **D9** a running chat on a newly forbidden account moves at the end of its turn. **D10** a pin outside a rule is refused. **D11** the configuration group is a tie-breaker in rotation. **D12** the reserve is headroom on the preferred account, capped at 30 %, released when the other accounts are out. **D13** all five owed spikes are authorised; the two that need a scratch sign-in are done by the owner in a temporary directory when asked. **D14** how the tests wrote into real account directories is investigated before the first task, and the orphan directory is listed on the page, never removed automatically.
- **Order.** The first task of this plan and the first task of [limit-resume-and-credits.md](limit-resume-and-credits.md) are built at the same time, after the decision engine's pull request; the rest follows in each plan's order.
- The plan stays on its branch until it is built; it travels with the pull request that implements it.

## Related

[[accounts.md]] · [[providers.md]] · [[cli-surfaces.md]] · [[plans/claude-only-fork.md]] ·
[[reports/accounts-a0.md]] · [[pinned-chat-rotation.md]] · [[plans/chat-account-switch.md]] ·
[[plans/models-per-account.md]] · [[plans/process-isolation.md]] · [[rest-api.md]] ·
[[reports/test-writes-real-dirs.md]] · [[configuration.md]] · [[orchestrations.md]] · [[team-and-flow.md]] · [[guards.md]]
