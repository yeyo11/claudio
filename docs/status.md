---
created_at: 2026-09-24T13:36:20.210175264Z
updated_at: 2026-10-19T09:00:00Z
tags:
    - status
    - project-state
    - docs
    - claudio
---
# Where the project stands

A snapshot of Claudio as it is today, for whoever — or whatever — picks it up next. The
[README](../README.md) says what it does and how to run it, the [ROADMAP](../ROADMAP.md) lists what
was built and what was refused; this page says where the work is, what is still open, and how a
change gets in. It names pull requests, never Claudio's version numbers: which release carried each
pull request is in [CHANGELOG.md](../CHANGELOG.md), so a release never leaves this page behind.

## Today

| | |
| --- | --- |
| Version | The root `package.json`'s; release-please keeps it the same across all ten `package.json` files, and [CHANGELOG.md](../CHANGELOG.md) says what each release carried |
| Released | On GitHub (`yeyo11/claudio`: `.deb`, AppImage, `ghcr.io/yeyo11/claudio`), from release-please's release pull requests. Claudio forks Agentry 0.37.1, drives Claude Code only, and is a product of its own (`@claudio/*`, `CLAUDIO_*`, `~/.config/Claudio`, ports 8797, 5181, 8809 and 8444); see [plans/claude-only-fork.md](plans/claude-only-fork.md) |
| Runtime | Node >= 22, pnpm workspace |
| Source | 1,578 tracked `.ts`/`.tsx` files (1,620 at Agentry 0.37.0, before the fork); the API contract is 9,606 lines of `packages/shared/src/types.ts` |
| REST | 39 route files, documented as OpenAPI 3.1 and served at `/docs` |
| Tests | 557 unit and integration test files, plus 90 browser specs under `e2e/specs/` |
| CI | `ci.yml` (a `checks` job: advisories, OpenAPI drift, typecheck, tests, build, the e2e runner's own tests; the e2e suite on four `e2e (k/4)` shards, called from `e2e.yml` and skipped on docs-only pull requests; the `test` gate; the image smoke test), `e2e.yml` (the shards, also dispatched by `pnpm e2e:remote`), `desktop.yml`, `image.yml`, `release.yml` |

The shape: `packages/shared` holds the types every other package imports,
`packages/core` drives the agent CLIs and owns the store, `packages/mcp` is Claudio's own MCP
server, `apps/api` serves Fastify over the core, `packages/ui` and `packages/chat-ui` hold the web's
primitives and the conversation, `apps/web` is the React UI, and `apps/desktop` wraps it in Electron
for Linux. See
[Monorepo layout](development.md#monorepo-layout).

The UI follows the **Night Shift** design system ([design-system.md](design-system.md)): near-black
neutrals and Geist, dark by default, a status bar on desktop, and four tabs and a FAB on a phone.
The tokens live in `packages/ui/src/styles/tokens.css`, and a web test fails on any colour, radius or
duration written anywhere else.

## What is built

The ROADMAP's [Done](../ROADMAP.md#done) section lists 33 areas and is the accurate inventory. The
spine of it: chats and projects modelled as Claudio's own objects over the CLI's stream-json;
orchestration with a task DAG, parallel workers and a verification phase on the integration branch;
observability that reconstructs what an agent did from git and the transcript; several accounts
rotated before they run out; schedules; configuration and MCP servers per scope; tool presets per
chat; authentication as none, bearer token or OIDC; a progressive web app with push for phones; a
Linux desktop app; a Docker image with a Kubernetes manifest; and remote access through
`tailscale serve` on the person's tailnet over settings that change at runtime ([tunnel.md](tunnel.md),
[layered-settings.md](layered-settings.md)).

Changes are reviewed inside Claudio: one screen for a chat, a task and the integration branch,
drawn by a diff comparator of its own in Reading, Unified and Side by side, with a Step by step lens
that replays every edit of the transcript with the sentence Claude wrote before it. The editor
integration (links, the copied diff command, Settings → Editor and `/settings/editor`) is gone. See
[the plan's Outcome](plans/changes-review.md#outcome) and design system
[§5](design-system.md#5-diff-comparator).

The newest piece is the **project ecosystem**, merged into `main` in #118 on 2026-09-28, server side and screens: its board,
its team and its assistant. Projects are created in a wizard from a template, and switch modules on
and off in their settings ([projects.md](projects.md)). The Board module gives them a Tasks board, a list,
milestones and work items that chats and orchestrations work on and move
([work-items.md](work-items.md)). The Team module gives them a team of agents, each a CLI agent
file, and a flow by column in which a card entering a column starts its role's run. Shared memory
adds a journal and memory proposals the person approves, and Documents the repository's documents
folder with documents tied to tasks ([team-and-flow.md](team-and-flow.md)). The **project
assistant** reads a project through a read-only CLI chat and proposes a team, resources and first
tasks. You accept or discard each proposal on its own, and only an accept writes anything. It runs
after the wizard, from the Team screen, from the project header's "Asistente" on every tab and the
palette, from the board ("Sugerir tareas") and from the Resources tab ("Sugerir", "Crear con IA")
([assistant.md](assistant.md)).

The **decision engine** was merged into `main` in #141 on 2026-09-30.
It gives the small judgments Claudio makes (refine or not, retry or not, which journal entries an
agent reads, a hint for a stuck worker) one home: three typed questions, two providers (the Claude
Code CLI by default, TypeSafe's Jev with the owner's own key), a mode per point (`off`, `shadow`,
`active`) and a Decisions tab in Settings. All 22 points ship `off`; nothing is sent anywhere until
the owner consents to a point. See [decision-engine.md](decision-engine.md).

**Collaborators** were merged into `main` in #7 on 2026-10-17: teammates' Claudios share projects
read only, peer to peer over iroh, with the follow-ups of R12 and the denied-join fix of R14
([collaborators.md](collaborators.md)). Agents can read what teammates share since #13: the global
assistant always, a project's chats when the project opts in, never in `bypassPermissions`, within
the sharer's flag and with an audit ([plans/collaborators-agent-access.md](plans/collaborators-agent-access.md)).
The workflow orchestration engine follows its journal live and waits or rotates at a usage limit
since #10 ([plans/workflow-engine-limits.md](plans/workflow-engine-limits.md)); a page whose service
worker is stopped mid-boot reloads once instead of staying blank since #12
([plans/e2e-blank-page.md](plans/e2e-blank-page.md)).

On 2026-10-17 the repository got its **front door** (#19): a short README, the long sections moved
into pages of their own ([features.md](features.md), [rest-api.md](rest-api.md),
[configuration.md](configuration.md), [securing.md](securing.md), [cli-surfaces.md](cli-surfaces.md),
[ui.md](ui.md), [pwa.md](pwa.md), [development.md](development.md),
[known-limitations.md](known-limitations.md)), the REST contract checked against
[rest-api.md](rest-api.md) by a test ([decisions/rest-api-contract.md](decisions/rest-api-contract.md)),
and media recorded from a seeded sandbox by `pnpm media`, the 1280×640 social preview included. The
same day a **limit wait** started going on with the first account that gets room, and a stopped task
got its way back (retry, start over, skip, resume a waiting graph, run now; #21, R10 and R11), and a
Core's shutdown came to end and await what it started: timers during boot (#18) and the `gh`/`glab`
probes (#20). The tests that failed only on a loaded machine were fixed at their causes in #16,
#18, #20, #22–#25 ([plans/e2e-flakes-under-load.md](plans/e2e-flakes-under-load.md) for the browser
ones; each pull request records what its flake was).

Since then, on 2026-10-17 and 18: the browser suite moved to GitHub and never runs on this machine
again (#29, `pnpm e2e:remote`; [decisions/e2e-on-github.md](decisions/e2e-on-github.md)), on shards
balanced by their timings (#30). The **Claudio designer** came in with #26
([plans/claudio-designer.md](plans/claudio-designer.md)). Refresh reads an account's real quota from
the CLI's `get_usage` (#31, [accounts.md](accounts.md)). The process isolation study was written up
and parked (#32, [plans/process-isolation.md](plans/process-isolation.md)). Settings were reorganised
into eight groups with search, Decisions became a screen of evidence and the Supervisor a decision
point (#34, [settings.md](settings.md)). An execution that died at a usage limit keeps its
cause when a replay stops it (#36). The **Machine widget** and its page, async `git` on
request paths, the figures history and priority for people's chats landed in #38
([resource-control.md](resource-control.md)), and dialogs, sheets and drawers hold up on a phone and in
the desktop app since #40. Every full load, on the desktop, the web and the PWA, opens on the
"Eat the code" splash since #42
([plans/splash-eat-the-code.md](plans/splash-eat-the-code.md)).

## What is open

- **Collaborators, waiting on iroh.** The owner ran it between real machines on 2026-10-17 (three
  installs, and two machines on different networks) and it works. Both binding defects were already
  reported upstream (#276, open; #277, fixed but not released); `@number0/iroh` stays pinned at 1.1.0
  until a release answers them ([reports/iroh-upstream-issues.md](reports/iroh-upstream-issues.md)).
- **Releases.** release-please keeps the next release pull request open for the
  owner. The open items of each built plan are in its Outcome section.
- **The owner's requests.** None is open: R6 (a full redesign with Stitch) and R8 (WebMCP) were
  dropped on 2026-10-17, and everything else is built and closed in [requests.md](requests.md).
- **The decision engine's shadow period.** Nothing has been measured yet. All 22 points have a
  resolver (CW-28 added `palette.intent`, `notification.urgency` and `orchestration.model`), and the `cli` provider
  no longer waits on anything: CW-25's effort control landed ([effort.md](effort.md)) and CW-4's quota hold was superseded by phase 4 of multiple providers; see the plan's
  [Outcome](plans/decision-engine.md#outcome).
- **The project ecosystem** was merged into `main` in #118 and is no longer open as a whole; see the
  plan's [Outcome](plans/project-ecosystem.md#the-ecosystem-as-a-whole) and the Known gaps of
  [work-items.md](work-items.md#known-gaps), [team-and-flow.md](team-and-flow.md#known-gaps) and
  [assistant.md](assistant.md#known-gaps) for what stays open per area.
- **The editable dashboard is closed** (CW-34, #224): Home is editable, kept per project, with Documents
  and Flows widgets, and checked against its reference screens in both themes, desktop and phone;
  see [dashboard.md](dashboard.md).
- **What Night Shift left for later** is closed (CW-35, #222): the cron sentence is said in the UI language
  ([schedule-words.md](schedule-words.md)), the look-alike bars are `ProgressBar` (each remaining bar
  class is mapped in the [design system](design-system.md)), and the unused meter style is gone. See
  the plan's [Outcome](plans/redesign-night-shift.md#outcome).
- **Known limitations** are catalogued in [known-limitations.md](known-limitations.md),
  and what was considered and refused is under [Decided against, for now](../ROADMAP.md#decided-against-for-now).
  Neither is a backlog: they are decisions, with the reasons attached.

## The plans, and where each stands

| Plan | Status |
| --- | --- |
| [`plans/agents-redesign.md`](plans/agents-redesign.md) | Landed — chats, projects and Claudio's own model (#60) |
| [`plans/agent-observability.md`](plans/agent-observability.md) | Landed, in full |
| [`plans/ui-redesign.md`](plans/ui-redesign.md) | Done, every task delivered |
| [`plans/mobile.md`](plans/mobile.md) | Shipped — all five tasks, see [Outcome](plans/mobile.md#outcome) |
| [`plans/roadmap-completion.md`](plans/roadmap-completion.md) | Verified — see [Verification](plans/roadmap-completion.md#verification-2026-10-07) (2026-10-07, 0.33.1, with the full `pnpm e2e` run; `paging.spec.mjs` open as CW-32) |
| [`plans/post-roadmap.md`](plans/post-roadmap.md) | Verified — see [Verification](plans/post-roadmap.md#verification-2026-10-07) (2026-10-07, 0.33.1, with the full `pnpm e2e` run; `paging.spec.mjs` open as CW-32) |
| [`plans/terminal.md`](plans/terminal.md) | Built and verified (2026-10-16): core, API, web, packaging, the t8 security audit (T8-1 accepted by the owner with a warning in Settings, T8-2 and T8-3 fixed), `docker build`, `pnpm desktop:dist` and the full `pnpm e2e` run. The terminal lives in the status bar only (owner, 2026-10-15), detaches into its own window and goes full screen. Feature: [terminal.md](terminal.md) |
| [`plans/collaborators.md`](plans/collaborators.md) | Merged in #7 (stages C1 to C5) and #13 (agents read what teammates share), 2026-10-17; run by the owner between real machines the same day. The iroh binding defects are upstream (#276, #277). See [Outcome](plans/collaborators.md#outcome). Feature: [collaborators.md](collaborators.md) |
| [`plans/resource-control.md`](plans/resource-control.md) | Merged in #38 (2026-10-18): the Machine widget on the overview and its page, less `/proc` per request, async `git` on request paths, figures history, and the fair queue; see its [Outcome](plans/resource-control.md#outcome). Feature: [resource-control.md](resource-control.md) |
| [`plans/spanish-copy.md`](plans/spanish-copy.md) | Landed (#94) — see [Outcome](plans/spanish-copy.md#outcome) |
| [`plans/app-updates.md`](plans/app-updates.md) | Landed (#95) — see [Outcome](plans/app-updates.md#outcome) |
| [`plans/redesign-night-shift.md`](plans/redesign-night-shift.md) | Landed (#101) — see [Outcome](plans/redesign-night-shift.md#outcome) |
| [`plans/tunnel.md`](plans/tunnel.md) | Landed (#110) through localhost.run; moved to Tailscale (`tailscale serve`, tailnet-only) on 2026-10-06 — see [The move to Tailscale](plans/tunnel.md#the-move-to-tailscale-2026-10-06) and [tunnel.md](tunnel.md) |
| [`plans/changes-review.md`](plans/changes-review.md) | Landed (#115) — see [Outcome](plans/changes-review.md#outcome) |
| [`plans/project-ecosystem.md`](plans/project-ecosystem.md) | Landed (#118) — see [Outcome](plans/project-ecosystem.md#outcome) |
| [`plans/decision-engine.md`](plans/decision-engine.md) | Landed (#141): the engine, both providers, 22 points (all ship off) and the Decisions tab. See [Outcome](plans/decision-engine.md#outcome) and [decision-engine.md](decision-engine.md). The owner's 18 decisions are in [`decisions/decision-engine.md`](decisions/decision-engine.md) |
| [`plans/orchestration-speed.md`](plans/orchestration-speed.md) | Built (epic CW-11): where a graph's time goes is recorded and shown (CW-13, #210); the shorter verification (CW-14); cheaper worker checks and the `e2e-specs` task (CW-15, #213); shorter chains with planner guidance and the longest-chain hint (CW-16, #205). Workstream B (CW-4) was superseded by phase 4 of multiple providers, see [`plans/limit-resume.md`](plans/limit-resume.md#what-replaced-it) |
| [`plans/agent-wire-format.md`](plans/agent-wire-format.md) | Landed (#221, CW-33, 2026-10-08): the MCP list tools answer only the fields a model needs, as compact JSON (`packages/mcp/src/fields.ts`). TOON was measured with a CLI bench (`scripts/wire-format-bench.mjs`), saved at most 4 % and cost more on three of four tools, and is not adopted; ZON rejected. The UI ↔ API side is built, see [api-wire.md](api-wire.md). See [Outcome](plans/agent-wire-format.md#outcome) and [claudio-mcp-server.md](claudio-mcp-server.md) |
| [`plans/claudio-assistant.md`](plans/claudio-assistant.md) | Landed (#216, 2026-10-07, umbrella CW-30): the global entry and confined chat (CW-18) and nine write tools, each confirmed by the person (CW-17), on the MCP server (CW-6) and the chat token (CW-10). See [`claudio-assistant.md`](claudio-assistant.md) and [Outcome](plans/claudio-assistant.md#outcome) |
| [`plans/flow-start-and-chat-token.md`](plans/flow-start-and-chat-token.md) | Built: part 1, starting the waiting cards when the flow is switched on (CW-9, `POST /projects/:id/flow/start-waiting`); part 2, a chat Claudio starts gets its own `CLAUDIO_API_TOKEN` (CW-10) |
| [`plans/multi-provider.md`](plans/multi-provider.md) | **Claudio history: Claudio drives Claude Code only, see [`plans/claude-only-fork.md`](plans/claude-only-fork.md).** Phase 1 landed (#150): five provider manifests (Claude Code, Codex, Gemini, Copilot, OpenCode), readiness detection, `/providers` routes, the first-run Providers step, Settings → Claude Code and the status bar dots; the one rule generalised. Phase 2 landed (#155): Claude Code behind the driver interface on its CLI (no Agent SDK, decision 2), `ToolPolicy`, the neutral `RunEvent`, the `provider` column and the conformance suite. Phase 3 landed (#167): the Codex driver on `codex app-server`, one ACP driver for Copilot, Gemini and OpenCode, OpenCode's SQLite transcripts and the provider on the chat page; recordings that need a signed-in account are the owner's. Phase 4 landed: a limit per provider shown in readiness, Settings and the status bar; handoff, restart or wait at a limit, each a new chat linked both ways; the `provider.on-limit`, `provider.pick` and `provider.model-map` decision points; automated work that picks its provider and carries its policy (with no policy it stays on Claude Code); claude-swap and the Accounts page retired. See [Outcome of phase 4](plans/multi-provider.md#outcome-of-phase-4), [Phase 4](plans/multi-provider.md#phase-4-rotation-between-providers), [Outcome of phase 3](plans/multi-provider.md#outcome-of-phase-3), [Outcome of phase 1](plans/multi-provider.md#outcome-of-phase-1) and [`providers.md`](providers.md) |
| [`plans/code-hosts.md`](plans/code-hosts.md) | Phases 1–4 built (2026-10-01/02): hosts and readiness, `gh` and `glab` adapters at parity, Settings → Connections, neutral PR/MR copy (#159); CI checks with logs, re-run, cancel, manual jobs, **Fix failing checks** and the `checks.fix` point; reviews: threads in the diff, a draft review sent as one, approvals, reviewers and **Address with an agent** with the `review.triage` point (see [Outcome of phase 3](plans/code-hosts.md#outcome-of-phase-3-2026-10-01)); merging: **Merge** with the methods the repository allows, a head guard, **Auto-merge**, the blocked states with their remedies, **Update from base**, the GitLab pipeline guard and an audit of every merge click (see [Outcome of phase 4](plans/code-hosts.md#outcome-of-phase-4-2026-10-02)); phase 5, first step (2026-10-02, see [Outcome of phase 5](plans/code-hosts.md#outcome-of-phase-5-step-1-2026-10-02)): GitHub Issues and GitLab Issues as trackers (import into work items, issue keys and closing words in change requests, status sync, the `issue.triage` point; reference in [`trackers.md`](trackers.md)); phase 5, second step (2026-10-07, see [Outcome](plans/code-hosts.md#outcome-of-phase-5-step-2-youtrack-2026-10-07)): YouTrack through `youtrack-app`, recorded on an instance of our own, with its address and token kept by Claudio ([`trackers.md`](trackers.md#youtrack)); phase 6, first step (2026-10-02, see [Outcome of phase 6](plans/code-hosts.md#outcome-of-phase-6-step-1-2026-10-02)): the pacer for both hosts, GitHub and GitLab webhook receivers (signature checked over the raw body, a delivery only brings a read forward) and hook registration, test, removal and re-pointing on a new tunnel address for GitHub and, with the signing token, GitLab (reference in [`code-hosts.md`](code-hosts.md#events-and-paced-polling)). GitHub (`gh` ≥ 2.92.0) and GitLab (`glab` ≥ 1.120.0) as code hosts, complete — PRs/MRs, CI checks and fixing them, reviews, merging from Claudio — and GitHub/GitLab issues and YouTrack (`youtrack-app`) as work items (Jira dropped on 2026-10-07); polling with optional webhooks. Six phases, each a task graph of orchestrations (prototypes, core, web); one execution layer for every CLI call; an action matrix of 138 GitHub/GitLab cells (110 recorded, 11 doc-only, 17 done outside the CLI) plus 12 YouTrack cells recorded before phase 5; the owner's four decisions settled |
| [`plans/claudio-mcp-server.md`](plans/claudio-mcp-server.md) | Built (2026-10-01): Claudio's own MCP server, `@claudio/mcp`, with 15 read-only tools over the REST API, handed to a chat through `--mcp-config` with the confinement, and packaged as `apps/api/dist/mcp.mjs` and in the desktop app. The write tools (CW-17) and the global assistant chat (CW-18) were built later, see [`claudio-assistant.md`](claudio-assistant.md). See [`claudio-mcp-server.md`](claudio-mcp-server.md) |
| [`plans/web-packages.md`](plans/web-packages.md) | Landed (#156): the web UI split into `@claudio/ui` (primitives, tokens, controls, renderers) and `@claudio/chat-ui` (the conversation, behind an injected client), with guard tests on the dependency direction and vendor names |
| [`plans/in-app-setup.md`](plans/in-app-setup.md) | Landed (#228, released in v0.37.0, 2026-10-09). A fresh Claudio, the Docker image above all, is set up from the browser: the setup assistant, a key or a device code for every agent, gh and glab, YouTrack, and the image's own Tailscale; secrets sealed in one vault and handed only to the CLI that reads them. Copilot signs in through its environment and gh (decision 7). See [Outcome](plans/in-app-setup.md#outcome), [setup.md](setup.md) and [security-model.md](security-model.md) |
| [`plans/chat-experience.md`](plans/chat-experience.md) | Built (2026-10-15); CHAT-19 (reading typography) closed by the owner on 2026-10-16, kept at 14px / 1.65 |
| [`plans/claude-only-fork.md`](plans/claude-only-fork.md) | Built (2026-10-15): stages S (strip), A (`@claudio/accounts`) and R (rename) |
| [`plans/models-per-account.md`](plans/models-per-account.md) | Built (2026-10-15): the model list per account from `initialize`, and the `account.model-fallback` point (ships off) |
| [`plans/container-polish.md`](plans/container-polish.md) | Built on its branches (2026-10-18), awaiting the integrator's container run and CI: in-app Claude sign-in (paste-code `auth login`, no OAuth token; `get_usage` only confirms, **Send a test message** checks), the `default` account only when it exists, a first-run owner token and the terminal default `any` in a container, the 421 page and claim, in-app updates inside the container (launcher, signed overlay, CLI install), the setup assistant's layout and the image's pins; its updates were extended to the desktop in [phase 2](plans/unified-updates.md). See [Outcome](plans/container-polish.md#outcome), [updates.md](updates.md) and the decisions [claude-sign-in-paste-code](decisions/claude-sign-in-paste-code.md), [container-owner-token](decisions/container-owner-token.md), [container-in-app-updates](decisions/container-in-app-updates.md) |
| [`plans/sdk-driver-improvements.md`](plans/sdk-driver-improvements.md) | Built (2026-10-15): D1–D3 and point 9, connectors parts A and B (`POST /connectors/:id/authorise`) |
| [`plans/project-docs.md`](plans/project-docs.md) | Built (2026-10-15) |
| [`plans/context-control.md`](plans/context-control.md) | Built (2026-10-16): the context breakdown panel, **Compact now**, compactions as dividers, session notes and the `context.compact` point (ships `off`). See [context-control.md](context-control.md) and the plan's [Outcome](plans/context-control.md#outcome) |
| [`plans/agent-run-improvements.md`](plans/agent-run-improvements.md) | Built (2026-10-16), ECC ideas 6–10 and 12–15: pattern grounding, the graph's objective and retrieval rounds, fixer stop rules and plateau detection, a risk score on tool calls, optional template roles, the delegation contract, the daily spend cap and path-scoped rules. Verified on the merged branch by the integrator; see its [Outcome](plans/agent-run-improvements.md#outcome) |
| [`plans/tool-rows-and-live-branches.md`](plans/tool-rows-and-live-branches.md) | Built (2026-10-16): opened tool calls read as what happened (lenses fed by the CLI's `tool_use_result`), a folded strip above the composer with every running subagent, background command and workflow and a line per subagent, and branch cards under the launching step. See [chat-tool-rows-and-branches.md](chat-tool-rows-and-branches.md) and the plan's [Outcome](plans/tool-rows-and-live-branches.md#outcome) |
| [`plans/review-gate.md`](plans/review-gate.md) | Built (2026-10-16): the opt-in review gate inside verification (`verification.review`): reviewers per dimension under `--restricted`, a verifier, a fixer loop, the deterministic scans, the person-only **Accept anyway**, five routes, the card, the findings in the integration diff and the `review.depth` point (ships `off`). See [orchestrations.md](orchestrations.md#the-review-gate) and the plan's [Outcome](plans/review-gate.md#outcome) |
| [`plans/guards.md`](plans/guards.md) | Built (2026-10-16): deterministic `PreToolUse` guards through `--settings` for orchestration workers, the flow and opted-in chats, the bundled read-only `guard.mjs`, the events store, health signals, Settings → Access & safety → Guards and the transcript notice. Known: 120 bypasses recorded as `todo` rows by the audit. See [guards.md](guards.md), [reports/guards-audit.md](reports/guards-audit.md) and the plan's [Outcome](plans/guards.md#outcome) |
| [`plans/settings-ia.md`](plans/settings-ia.md) | Merged in #34 (2026-10-18), verified on GitHub: Settings in eight groups with search at `/settings/<group>/<detail>` (the `?tab=` addresses redirect), Connectors folded into Connections, Decisions as evidence without chips, and the Supervisor folded into the `supervisor.intervene` point (`GET/PUT /settings/supervisor` deprecated). See [Outcome](plans/settings-ia.md#outcome) and [settings.md](settings.md) |
| [`plans/claudio-designer.md`](plans/claudio-designer.md) | Merged in #26 (2026-10-17): the `claudio-ui` skill, its review, audit and exploration agents, the machine-checked invariants and the hooks that lint every UI edit, and the typographic voice it brings to Night Shift. See [§4](plans/claudio-designer.md#4-as-built) |
| [`plans/workflow-engine-limits.md`](plans/workflow-engine-limits.md) | Merged in #10 (2026-10-17): the workflow engine follows its journal live, holds or rotates at a usage limit, and never stays running unwatched. See its [Outcome](plans/workflow-engine-limits.md#outcome) |
| [`plans/splash-eat-the-code.md`](plans/splash-eat-the-code.md) | Merged in #42 (2026-10-18): the four-second brand intro on every full load of the desktop window, the web page and the installed PWA. Design: [design-system.md](design-system.md) and [desktop.md](desktop.md) |
| [`plans/lessons.md`](plans/lessons.md) | Built (2026-10-16): lessons mined from corrections, approved by a person with their evidence, delivered to chats and workers, decayed and promoted to `CLAUDE.md` through the diff dialog; the `lesson.mine` decision point. See [lessons.md](lessons.md) and the plan's [Outcome](plans/lessons.md#outcome) |
| [`plans/instruction-evals.md`](plans/instruction-evals.md) | Built (2026-10-16), phases 1 and 2: eval files for agent files, skills, rules and `CLAUDE.md`, runs of `current` against `proposed`, pressure levels, pass@k and intervals, the judged expectation and the promotion gate behind `evalsPhase2`. See [evals.md](evals.md) and the plan's [Outcome](plans/instruction-evals.md#outcome) |
| [`plans/rotation-auth-fixes.md`](plans/rotation-auth-fixes.md) | Built (2026-10-16): an expired sign-in (`api_error_status: 401`) marks the account's `signInState` with `authFailedAt`, rotates the chat with reason `auth`, and a retry chooses the account again; the Accounts page and the status bar say Sign-in expired. See the plan's [Outcome](plans/rotation-auth-fixes.md#outcome) |
| [`plans/chat-account-switch.md`](plans/chat-account-switch.md) | Built (2026-10-16): a person switches a chat's account from the composer, queued or immediate, refused with 409 `sign-in-expired` for an account whose sign-in expired; the transcript shows "Switched to". See the plan's [Outcome](plans/chat-account-switch.md#outcome) |
| [`plans/unified-updates.md`](plans/unified-updates.md) | Built on its branches (2026-10-19), phase 2 of PR #46, awaiting the integrator's checks and CI: one update mechanism for the desktop, the container and Helm. A release is a **shell** (Electron, the launcher machine, the guard, the keys; changed only by a package) and a signed **payload** (the server bundle) that installs in-app on both hosts with no password and restarts only the server; `minShell` beside `minImage`, key ids in `.sig` files and a signed desktop manifest; the app never escalates (no `pkexec`): the `.deb` registers a signed apt repository on GitHub Pages and a `.deb` without it gets one checked command to copy; `install.sh` takes the AppImage only where Chromium's sandbox runs without root; the Updates card has two zones and offers only what can install; a free `models.list` check for API keys and **Not confirmed** for an environment OAuth token; the tunnel survives a slow Tailscale CLI; tests leave nothing in tmp. See [Outcome](plans/unified-updates.md#outcome), [updates.md](updates.md), [desktop.md](desktop.md#updating) and the decisions [shell-payload-updates](decisions/shell-payload-updates.md) and [apt-repository](decisions/apt-repository.md) |

A plan is the source of truth for the orchestration that executes it: where a task prompt and the
plan disagree, the plan wins.

## How it is checked

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm e2e:remote   # the browser suite, on GitHub Actions
```

Since 2026-10-17 the browser suite runs only on GitHub ([decisions/e2e-on-github.md](decisions/e2e-on-github.md)):
every pull request runs it on four shards, and `pnpm e2e:remote` runs it, or a few specs, on a pushed
branch. The local runs below are from before that.

Last run on 2026-10-07 by the final verification of the two roadmap plans
([the checks](plans/roadmap-completion.md#the-checks-2026-10-07)), on `main` at `a0d6f2967`
(0.33.1), on a machine shared with other orchestrations (load average 16 to 109 on 12 cores, and a
`/tmp` that went from 46 % to 80 % full):

- `pnpm typecheck`: passes.
- `pnpm test`: 4,074 tests pass across the eight packages (core 2,463, web 1,236 of 1,238, api 272,
  desktop 52, shared 32, mcp 12, chat-ui 4, ui 3). Two web timing tests (`highlight.test.ts`,
  `robustness.test.ts`) missed their budget at a load near 109 and pass alone at a load near 18.
- `pnpm build`: passes. The OpenAPI schemas regenerate with no drift (596 schemas).
- `node --test e2e/harness.test.mjs`: 14 of 14 pass, the whole file in one run.
- `pnpm e2e` (`E2E_PORT=8899`, four shards): of 71 spec files, 45 passed, `chat.spec.mjs` was
  skipped (it needs `E2E_LIVE=1`), 14 failed and 11 were not run after `merge.spec.mjs` passed its
  600 s limit. Run alone one at a time, 21 of those 25 pass. `security`, `shell` and `tasks-review`
  read the page a fixed pause after loading it; they now wait for what they check, and pass. Only
  `paging.spec.mjs` ("no long tasks while typing") still fails alone, at every load tried down to
  22: **CW-32**. CI ran all four shards green the same day.

The full suite's previous run on `main` was at `cc08204e` (0.23.0, the ecosystem of #118 plus its
release), on 2026-09-28, on a machine with a load average near 50. Kept as history:

- `pnpm typecheck`: passes.
- `pnpm test`: passes, 1,898 tests across the five packages (core 810, web 849, api 166, desktop 42,
  shared 31), none failing.
- `pnpm build && pnpm e2e`: the build passes; **the e2e run fails.** Of the 55 specs, 47 passed,
  `chat.spec.mjs` was skipped (it needs `E2E_LIVE=1`), 6 failed, and the run hit its 1,500 s limit
  before `tasks-links.spec.mjs` (`a11y.spec.mjs` alone took 540 s). Each failing spec re-run on its
  own with `node e2e/run.mjs <spec>`:
  - `orchestration-v2.spec.mjs` (searching finds the graph by name), `team.spec.mjs` (the
    template's four roles with their models) and `tasks-item.spec.mjs` (Cancel closes it) pass
    alone, and so does `tasks-links.spec.mjs`;
  - `home.spec.mjs` (the figures are a strip under the hero) fails alone too;
  - `paging.spec.mjs` (no long tasks while typing) fails alone too, with long tasks of 55–72 ms
    that the load on the machine may explain. Since CW-32 the check compares the 30 keystroke
    windows with 30 interleaved idle windows and fails when keystrokes add more than 5; it skips,
    saying so, when 10 idle windows stall. At a load near 6 (it never dropped below 2) it passed
    6 of 6 with no long task, but under synthetic load the idle windows stayed clean while typing
    still met long tasks, so a loaded run can still fail
    ([paging-long-tasks](plans/paging-long-tasks.md#measurements-2026-10-07));
  - `shell.spec.mjs` fails alone too, on "and on the project's tabs" (in the full run it failed
    earlier, on "Settings opens on Appearance"). Since CW-31 its phone checks wait for the layout
    they measure instead of reading it once after a pause, and it passed 10 runs in a row alone.
    The 500 on `POST /schedules` it once met did not come back in 20 runs or under 200 concurrent
    creates, and no fault was found in the code; the spec now prints the answer and deletes the
    schedule by name too, so one saved before a failure cannot reach `schedules.spec`.

The older run on `main` (`d6269c4`), with three specs that failed in the full suite and passed alone,
is in [Before launching](plans/redesign-night-shift.md#before-launching). The browser suite runs headless Chrome over CDP against an isolated
wrapper, with a time limit per spec and per run so it cannot hang, split into shards that run side by
side (`E2E_SHARDS`, [plans/verify-faster.md](plans/verify-faster.md#what-1-built)). CI runs all of it on
every pull request, the e2e suite as four parallel shards, which it skips when a pull request changes
only documentation ([plans/ci-e2e-shards.md](plans/ci-e2e-shards.md#what-was-built)), and additionally fails
on a high-severity advisory in the dependency tree or on OpenAPI schemas that have drifted from the
shared types — after changing `packages/shared/src/types.ts`, run
`pnpm --filter @claudio/api openapi:schemas`.

## How a change gets in

Branch off `main`, one pull request per piece of work, squash-merged. Commits follow Conventional
Commits because release-please builds `CHANGELOG.md` and the version bump from them, which is why
the changelog is never edited by hand. A new route needs a summary and a tag in
`apps/api/src/openapi/routes.ts` and a row in [rest-api.md](rest-api.md), which a test checks.
[CONTRIBUTING.md](../CONTRIBUTING.md) is the source of truth for all of it.

Locally the wrapper uses the real `~/.claude`; set `CLAUDE_CONFIG_DIR` to experiment safely. Git
work that changes the checkout belongs in a worktree, because the dev servers run from the main one
and a restart kills the runs in flight.

## Where the knowledge is kept

In this folder, and indexed for semantic search — see [the knowledge base](knowledge-base.md). Every
new feature and every decision is written down there as it happens, which is what makes this page
possible to keep honest.

## Related

[[guards.md]] · [[context-control.md]] · [[chat-tool-rows-and-branches.md]] · [[knowledge-base.md]] · [[deploy.md]] · [[desktop.md]] · [[plans/roadmap-completion.md]] ·
[[plans/post-roadmap.md]] · [[plans/ui-redesign.md]] · [[plans/agent-observability.md]] ·
[[plans/agents-redesign.md]] · [[plans/mobile.md]] · [[plans/spanish-copy.md]] ·
[[plans/app-updates.md]] · [[plans/verify-roadmap-plans.md]] · [[plans/redesign-night-shift.md]] · [[plans/changes-review.md]] ·
[[plans/tunnel.md]] · [[design-system.md]] · [[plans/project-ecosystem.md]] ·
[[plans/project-ecosystem-audit.md]] · [[projects.md]] · [[work-items.md]] · [[team-and-flow.md]] · [[assistant.md]] ·
[[decision-engine.md]] · [[plans/decision-engine.md]] · [[decisions/decision-engine.md]] · [[plans/orchestration-speed.md]] · [[plans/claudio-assistant.md]] · [[claudio-assistant.md]] ·
[[decisions/english-technical-language.md]] · [[plans/flow-start-and-chat-token.md]] · [[plans/web-packages.md]] · [[api-wire.md]] · [[plans/agent-wire-format.md]] · [[plans/multi-provider.md]] · [[providers.md]] · [[plans/in-app-setup.md]] · [[setup.md]] · [[security-model.md]] · [[terminal.md]] · [[collaborators.md]]
