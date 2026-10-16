---
created_at: 2026-09-30T14:00:00Z
updated_at: 2026-10-15T12:00:00Z
tags:
    - providers
    - detection
    - architecture
    - convention
---
# Providers

A **provider** is a coding agent the app can drive. Claudio drives one: **Claude Code**, through its
CLI. The provider interface (`packages/core/src/providers/driver.ts`) stays, with the Claude Code
driver as its only implementation, so detection, readiness, the policy judge and the conformance
suite keep one shape. This document is the reference for what a provider is, how the app decides
whether one is ready and how it finds the binary. The fork's reasons are in
[plans/claude-only-fork.md](plans/claude-only-fork.md); the multi-vendor design this grew from is
Claudio's history, in [plans/multi-provider.md](plans/multi-provider.md).

| Provider | Driver | Transport | Declared at | Starts a chat |
|---|---|---|---|---|
| Claude Code | `providers/claude-code/` | `stream-json` | the manifest | yes |

The type names below are the ones in `packages/shared/src/types.ts`; if they differ from the code,
the code wins and this document is stale.

## The rule a provider lives under

The app reaches Claude Code **only through the interface its vendor ships for programs**: CLI flags
and subcommands, the `stream-json` protocol, the control protocol, the files the CLI writes and its
documented environment variables. No SDK, no HTTP call to Anthropic, no OAuth flow of its own, no
terminal scraping. The rule is stated in [CLAUDE.md](../CLAUDE.md) and
[CONTRIBUTING.md](../CONTRIBUTING.md); the decision engine's bounded exception for typed decision
services is unchanged ([decision-engine.md](decision-engine.md)).

The same rule covers the other programs the app drives that are not agents: the code hosts' `gh`
and `glab` ([code-hosts.md](code-hosts.md)), and the remote-access tunnel's `tailscale`
([tunnel.md](tunnel.md)), which it reaches only through their CLI flags and `--json` output, with
the person's own session. They are not providers: they run no chat, and nothing here (detection, the
handshake, the policy judge) applies to them.

## How a message reaches the agent

Every message the app sends has an id of its own, and the driver says when the agent took it (the
`delivered` driver event), so a page tracks messages by id ([chat-delivery.md](chat-delivery.md)).
The id goes as the stream-json `uuid` of the stdin line, and the CLI runs with
`--replay-user-messages`, a flag in `claude --help`, which reads each message back under that id the
moment the CLI takes it. The CLI keeps the id in its transcript (the `user` line, or the
`source_uuid` of a `queued_command` attachment for a message read mid-turn). Both were confirmed on
CLI 2.1.288 ([reports/chat-audit/server.md](reports/chat-audit/server.md)).

## What a provider is

One module in `packages/core/src/providers/<id>/`, made of:

- a **manifest**: data, declared once, read by the registry and the detector;
- a **driver**: code that implements detection probes, sessions, the model catalog and transcripts
  behind one interface.

`PROVIDER_MANIFESTS` holds the Claude Code manifest alone. The manifest declares:

| Field | What it holds |
|---|---|
| `id`, `label`, `vendor`, `homepage`, icon | Identity, and an icon from the illustration set |
| `commands` | The binary and its aliases, `requires`, `unsupportedPlatforms` |
| `configHomes` | Where the provider keeps state and the variable that moves it (`CLAUDE_CONFIG_DIR`); its presence also tells the provider was **used before** |
| `versions` | The range the driver is tested against and how to read the version |
| `install` | The vendor's install page; a command that verifies an install |
| `auth` | How to tell whether it is signed in (`claude auth status --json`) and where to sign in |
| `transport` | `stream-json` |
| `capabilities` | A **declared** set: `interactivePermissions`, `structuredOutput`, `resume`, `fork`, `interrupt`, `setModel`, `subagents`, `mcp`, `worktreeFlag`, `settingsFlag`, `hookEvents`, `budgetLimit`, `effort`, `costReport`, `rateLimitWindows`, `multiAccount`, `transcriptFiles`, `workflowTool` |

Capabilities are declared, then confirmed for the installed version, and never inferred from which
methods a driver happens to implement. Every fact in the manifest cites, in a comment, where it comes
from: the vendor's docs or `claude --help`.

## Readiness

Readiness is a state, not a boolean: "found on PATH" is not "ready". Detection produces one
`ProviderStatus` with the state, a reason code, the version, the compatible range, the binary path,
the config home, the account, the capabilities and when it was checked.

| State | Meaning | Remedy offered |
|---|---|---|
| `ready` | Installed, compatible version, signed in | — |
| `degraded` | Works, with a warning (version outside the tested range, a limit near) | Update, or keep going |
| `signed-out` | Installed and compatible, no credentials | Sign in |
| `incompatible` | Installed, version too old or too new for the driver | Update or pin |
| `used-before` | Its config home exists but the binary is not found | Install, or point to the binary |
| `not-installed` | No trace of it | Install |
| `unknown` | The check could not run | Retry, with the reason |

Every state but `ready` carries a **typed reason code**: `missing-credentials`, `stale-token`,
`version-below-range`, `probe-timeout`, `spawn-denied`, `no-probe` and the rest of
`ProviderReasonCode` in shared types. The UI shows the state and a sentence written for the reason,
never a raw error string.

- **Probes spend nothing.** One that would cost tokens or quota is not run.
- **Sign in** happens from the app: Claude Code takes the token `claude setup-token` makes on the
  person's own machine, because its `auth login` needs a terminal; see
  [setup.md](setup.md#methods-per-tool).
- **Install is a link** to the vendor's page. The app does not run installers or show commands; the
  watchers below pick the binary up once it lands on PATH.

## How detection finds a binary

`ProviderDetector` in core is shared by the server, the desktop app and the Docker image. It resolves
the binary, in this order:

1. **The override** the person set in Settings → Providers.
2. **The person's PATH.** The login shell is run once (`$SHELL -ilc`) with sentinels around the
   output, a timeout, and a fast-path marker in the environment (`CLAUDIO_SHELL_PATH_PROBE=1`) that rc
   files can test to skip slow setup. Failure is typed: `no-shell`, `timeout`, `spawn-error` or
   `empty-path`. So a server started from a desktop session or a service finds what the terminal finds.
3. **Install directories**, when the PATH has nothing: nvm (ordered by its `default` alias), volta,
   asdf, mise, bun, pnpm, npm-global, `~/.local/bin`, `~/.claude/local`, Homebrew, nix and snap.

Commands are resolved against PATH with `fs`, honouring `X_OK`, and never by spawning `which`:
security software can gate every spawn. "Absent" is kept apart from "could not check".

With a binary, the detector reads the version and compares it with the range, and runs the auth probe
(`claude auth status --json`). Each probe has its own timeout. Without a binary, a config home that
exists gives `used-before`; otherwise `not-installed`.

**The CLI does not update itself under the app** (`DISABLE_AUTOUPDATER=1`). A version change that
happens anyway is read at the next detection.

**Nobody presses Refresh.** One cache with one TTL is invalidated by a refresh, by a settings change
and by debounced watchers on the PATH directories and the config home. A re-detect emits the
`providers.changed` event only when a status actually changed. The Refresh button stays for what the
watchers miss.

The status also carries `permissionModes`: the modes the driver honours, in the order to list them,
so a picker offers only those. The models the CLI offers are cached in `provider-catalogs.json` in
the data directory (rewritten whole) and served by `GET /providers/:id/models`; the next run starts
from that file, so the picker is not empty before the first read.

Claude Code's probes reuse `detectCli` and `getAuthStatus` in `packages/core/src/cli.ts`, and
`/health` keeps its shape (`cli`, `loggedIn`), read from the Claude provider's status.

## The API and the settings

`GET /providers`, `GET /providers/:id`, `POST /providers/refresh`, `GET /providers/settings` and
`PUT /providers/settings`; chat tokens get `403` on the writes. Settings live in `providers.json` in
the data directory: Claude's `enabled` and `binaryPath`. Unknown keys of an older file are ignored.

## Who may do what: the policy judge

A chat or a stage carries a `ToolPolicy` (what it may read, edit, run, fetch, delegate, and whether
it may push to a remote). The driver translates it into Claude Code's own rules (`translatePolicy`),
and a part Claude Code cannot enforce is listed as `unsupported`, never dropped.

A second layer, the **judge** (`packages/core/src/policy-judge.ts`), is pure: it takes the policy
and a neutral request (`command`, `edit`, `read`, `fetch`, `delegate`, `other`) and answers `allow`,
`deny` or `ask`. Claude Code's translation has no `host` part, so the judge is typed through
`driver.ts` and never reached by Claude today.

## At a usage limit

When Claude Code reaches its limit, the work first switches to another Claude account with headroom
(`@claudio/accounts`, [accounts.md](accounts.md); a person's chat does it when `rotateOnLimit` is on),
and **waits** for the reset (`LimitWaits`, the wait half of `rotation.ts`) when no account has any;
nothing moves to another agent. A wait is listed by `GET /limits/waits` and stopped with
`POST /limits/waits/:id/cancel`, and a chat is put on hold with `POST /chats/:id/wait`.

## Where transcripts live

Claude Code writes its transcripts as JSONL under its projects directory, and the `TranscriptStore`
reads them read-only. It never writes, locks or checkpoints another program's files.

## The conformance suite

The driver passes `packages/core/test/conformance/suite.ts` through
`packages/core/test/conformance-claude-code.test.ts`. The harness gives the driver, the environment
its fake needs, and how to script a turn. A case whose capability the manifest does not declare is
skipped with that reason, so the manifest's capabilities are what the suite holds the driver to. The
e2e suite never depends on the real CLI: `e2e/fake-cli/` is a fake `claude` (see its README).

## The first-run step

The setup assistant of [setup.md](setup.md) stands in for the app on a first start. Its Agents step
lists Claude Code with the same Sign in panel as Settings → Providers, or the install page when none
is found (`nothingFound` in `apps/web/src/lib/first-run.ts`). It is shown while `setupSeen` in the
app settings is off; finishing or skipping it records the setting (`POST /setup/seen`, or
`CLAUDIO_SETUP_SEEN=on` from the environment) and it never comes back. Home and the status bar say
nothing is ready and point at Settings, where a provider gets fixed. "Check again" calls
`POST /providers/refresh`, and an install or sign-in made in a terminal arrives through
`providers.changed`.

## Related

[[plans/claude-only-fork.md]] · [[plans/multi-provider.md]] · [[status.md]] · [[decision-engine.md]] · [[desktop.md]] · [[deploy.md]] · [[knowledge-base.md]] · [[tunnel.md]] · [[code-hosts.md]] · [[setup.md]]
