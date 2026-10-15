---
created_at: 2026-10-15T09:00:00Z
updated_at: 2026-10-15T09:00:00Z
tags:
    - plan
    - fork
    - claude-swap
    - accounts
    - rotation
    - branding
---
# Claudio: the Claude-only fork

Status: **planned** (2026-10-15). Nothing is built yet; the owner reviews this plan before the
orchestrations start.

Claudio is a fork of Agentry at `d1ee00514` (release 0.37.1). Agentry grew from a wrapper around
Claude Code into an orchestrator that drives several vendors' agents
([plans/multi-provider.md](multi-provider.md)), and in its phase 4 (#188) it retired claude-swap in
favour of moving work between vendors. Claudio goes back to the original idea: **it drives Claude
Code only, and it rotates between several Claude accounts with claude-swap (`cswap`)**. Everything
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
4. **At a usage limit: switch account first, then wait.** claude-swap moves to another account with
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

**The one rule stays**, narrowed back to its first form: Claudio reaches Claude Code only through its
CLI (flags, subcommands, stream-json, the control protocol, the files it writes), and claude-swap
only through its CLI. No SDK, no HTTP call to Anthropic, no terminal scraping.

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

### 2. claude-swap back

- **Restored as they were at `8c52aef25`:** `accounts.ts`, `account-config.ts`, `cswap-install.ts`,
  `cswap-pin.ts`, `apps/api/src/routes/accounts.ts` (18 routes), the Accounts page and
  `pages/accounts/**`, `lib/cswap.ts`, `lib/usage-history.ts`, `usage-history.css`, the
  `accountsConfig` locales, their tests, `e2e/specs/accounts-config.spec.mjs`, and the
  `DesktopCuentas` and `MobileCuentas` references.
- **Re-applied by hand** onto files that changed after #188: the account types in `types.ts`;
  `AccountManager` wiring in `index.ts`; `account` on chats and executions (`chats.ts`,
  `chat-service.ts`, `live-chat.ts`, `chat-records.ts`); `AccountSupport` in `driver.ts` and
  `cswap run <account> --share-history -- claude …` in the Claude driver's args; `cswapBin` and
  `cswapManaged` in `paths.ts`; the `rotation_events` and `usage_history` methods in `db.ts` (the
  tables were never dropped, no migration is needed); `App.tsx`, `api.ts`, `StatusBar`'s
  `AccountCard`, `shell-live.ts`, `usage-now.ts`, `CommandPalette`, `events.ts`, the notification
  texts, `AccountTab`, the account picker in New chat (beside effort), `Side.tsx`, Home's
  `limitSummary` and pulse widget, the MCP `list_accounts` tool (through CW-33's compact fields), the
  Docker uv and claude-swap install, Compose, Helm, `.env.example`.
- **The limit path** (`rotation.ts`, reduced and renamed `LimitWaits`): at `limit-hit` on Claude,
  `accounts.rotateWithinPolicy` (or the pinned rotation) switches account and
  `runtime.replayLastTurn` replays it in the same chat, reusing CW-37's `limitRequested` and
  `limitReplays` counters. After a switch a fresh reading is written to `provider_limits` with a newer
  `observedAt`, so Claude is not left "exhausted". When no account has quota, the existing wait takes
  over. `holds()` covers a switch under way so flow runs and tasks wait instead of failing. A switch
  is logged to `rotation_events`; `provider_moves` only records waits.
- **Credentials** (the riskiest part): since #228 `childEnv('claude-code')` puts the vault's
  `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` into every `claude` process, which would override
  the account claude-swap switched to. While cswap manages accounts, `child-env.ts` drops both, and
  `tokenSource` reads `'cswap'` again so Settings → Account says so.
- **Security:** the account routes that install or run a binary or move credentials
  (`POST /accounts/cswap/install`, `DELETE /accounts/cswap`, `POST /accounts/token`,
  `POST /accounts/switch`, `PUT /accounts/autoswitch`, `PUT /accounts/:number/config`, the policy
  writes) are forbidden to a chat's own token.
- **Phone:** `/accounts` gets a phone header (`phone-header.ts`) as CW-8 asks.

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
| API dev port, web dev port | 8787, 5173 | 8788, 5174 (`strictPort`) |
| e2e port | 8799 | 8809 |
| Docker image, compose host port, Helm chart, Caddy upstream | `agentry`, 8787 | `claudio`, 8788 |
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

One feature branch, **`feat/claude-only`**, in the clone at `~/Escritorio/claudio`. Every
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

### A · `claudio-accounts` (claude-swap back), depends on S

- `a1` shared: the account types, events and fields back in `types.ts`; schemas.
- `a2` core restore: the four restored files, `db.ts` methods, `paths.ts`, `driver.ts`, the Claude
  driver's args and its golden fixture, `credentials.ts` and `child-env.ts`. Depends on a1.
- `a3` core wiring: `index.ts` (`AccountManager`, `Overview.accounts`), `chats.ts`,
  `chat-service.ts`, `live-chat.ts`, `chat-records.ts`, and the limit path in `rotation.ts` (switch,
  replay, fresh reading, then wait). Depends on a2. Tests: a limit with a second account switches and
  replays in the same chat; with none, it waits; a pinned chat rotates within its policy; a person's
  chat follows `rotateOnLimit`; two cores on one data directory switch once.
- `a4` API: `routes/accounts.ts`, `app.ts`, the Accounts tag and its 18 rows, the chat-token
  denials, README's Accounts table, API tests. Depends on a3.
- `a5` web: the Accounts page and its parts, `App.tsx`, `api.ts`, the status bar, the shell, New
  chat's account picker, Settings → Account, Home's limit widgets, the phone header, the locales and
  fixtures. Depends on a4.
- `a6` packaging, MCP and e2e: Docker (uv and claude-swap on Node 26), Compose, Helm,
  `.env.example`, `packaging.test.ts`, `list_accounts`, `accounts-config.spec.mjs`, `CSWAP_BIN` in
  `e2e/run.mjs`, the Cuentas references, `docs/desktop.md`, `docs/deploy.md`, and the two plans that
  were marked superseded. Depends on a4.

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
| A token saved in the vault overrides the account claude-swap switched to | `child-env.ts` drops the vault token while cswap manages; a test per launch path (driver, decision `cli`, detector) |
| A switch leaves Claude marked exhausted | A fresh `provider_limits` reading with a newer `observedAt` after every switch |
| Automated work that used to wait now fails | Waiting stays the floor when no account has quota; `holds()` covers a switch in progress |
| A Claudio build updates itself into Agentry, or the tunnels remove each other's rule | Stage R's runtime table, checked by running both desktop apps side by side before release |
| Both apps work on one repository and fight over worktrees and agent files | Different branch and worktree prefixes; agent files under `.claude/agents/` are still shared, said in the README |
| An old Agentry data directory is pointed at Claudio | Not supported: Claudio starts empty. `providers.json` and project settings ignore unknown keys so a copied file does not break the start |
| The rename breaks e2e selectors or parity fixtures | The rename keeps the class names the e2e specs select; fixtures are regenerated, never edited by hand |

## Related

[[plans/multi-provider.md]] · [[plans/managed-claude-swap.md]] · [[pinned-chat-rotation.md]] · [[plans/limit-resume.md]] · [[providers.md]] · [[desktop.md]] · [[deploy.md]] · [[status.md]]
