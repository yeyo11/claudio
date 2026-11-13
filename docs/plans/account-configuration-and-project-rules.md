---
created_at: 2026-11-13T18:00:00Z
updated_at: 2026-11-13T21:00:00Z
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

Status: **proposed** (2026-11-13). A study: nothing here is built. It holds the evidence, the
options, a recommended end state and the decisions the owner must take before anything is built.

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
| **S2b** Concurrent plugin writers through one linked `plugins/` | each CLI start may sync marketplaces and rewrite `installed_plugins.json` (the account caches hold many `temp_subdir_*.clone` dirs) | two scratch accounts with linked `plugins/`, 8 parallel `-p` starts with `initialize` each plus a `plugin update` in a loop; diff `installed_plugins.json` against the expected set | free, network to GitHub |
| **S4** Name collision and strict mode | the overlay must not duplicate or shadow a project server; strict mode might drop claude.ai connectors | same-named server in `.mcp.json` and `--mcp-config`, `mcp_status`; then `--strict-mcp-config` on a signed-in scratch account | free, but needs a signed-in scratch account (a new `claude auth login`) |
| **S5** What a session resumed on another account loses | B11 and B9 | two scratch accounts of the same person, `projects/` linked; a haiku turn that edits a file, writes a task list and a plan, then `--resume` on the other account; check rewind, tasks, plans, agent memory | two haiku turns, cents |
| **S6** OAuth MCP servers across accounts | a user-scope remote server with OAuth keeps its token per config dir [I] | add one in the default, pass it with `--mcp-config` on another account, `mcp_status` | free, needs one OAuth server sign-in |
| **S7** External `@imports` in CLAUDE.md | `hasClaudeMdExternalIncludesApproved` is per state file | a CLAUDE.md importing a file outside the project, `-p` with and without the key | one haiku turn |

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

## The owner's decisions (2026-11-13)

Taken the day the study was written. Every decision of the table in section 11 is the recommended option:

- **D1** per account, with an install default (shared) for new accounts. **D2** an account that turns independent starts from a copy of the shared configuration, with empty offered in the dialog. **D3** history is shared whatever the mode. **D4** plugins are reconciled with the CLI's own commands, not linked. **D5** the MCP overlay for shared accounts. **D6** reconcile before every spawn. **D7** the Add-account flow asks whether the new account joins the existing rules. **D8** what happens when no allowed account has room follows section 7.2, by origin, with the person-only "use another account once". **D9** a running chat on a newly forbidden account moves at the end of its turn. **D10** a pin outside a rule is refused. **D11** the configuration group is a tie-breaker in rotation. **D12** the reserve is headroom on the preferred account, capped at 30 %, released when the other accounts are out. **D13** all five owed spikes are authorised; the two that need a scratch sign-in are done by the owner in a temporary directory when asked. **D14** how the tests wrote into real account directories is investigated before the first task, and the orphan directory is listed on the page, never removed automatically.
- **Order.** The first task of this plan and the first task of [limit-resume-and-credits.md](limit-resume-and-credits.md) are built at the same time, after the decision engine's pull request; the rest follows in each plan's order.
- The plan stays on its branch until it is built; it travels with the pull request that implements it.

## Related

[[accounts.md]] · [[providers.md]] · [[cli-surfaces.md]] · [[plans/claude-only-fork.md]] ·
[[reports/accounts-a0.md]] · [[pinned-chat-rotation.md]] · [[plans/chat-account-switch.md]] ·
[[plans/models-per-account.md]] · [[plans/process-isolation.md]] · [[rest-api.md]] ·
[[configuration.md]] · [[orchestrations.md]] · [[team-and-flow.md]] · [[guards.md]]
