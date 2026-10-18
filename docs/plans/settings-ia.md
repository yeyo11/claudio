---
created_at: 2026-10-17T17:30:00Z
updated_at: 2026-10-17T17:30:00Z
tags:
    - plan
    - settings
    - information-architecture
    - decisions
    - design-system
    - ui
---
# Plan: Settings in eight groups, with search

The redesign of Settings that the owner decided on 2026-10-17, from the
[information-architecture audit](../reports/settings-ia-audit.md) (its eight decisions win wherever
this plan seems to say otherwise). Today Settings has 23 tabs in four groups, three levels of
navigation on a desktop (sidebar, settings nav, section chips) and four on a phone. After this plan
it has **eight groups and a search**, two levels of navigation, a Decisions screen that shows
evidence instead of a form, and a Supervisor that is the decision point it already half was.

Status: **settled** on 2026-10-17. The owner took every recommendation of the audit; the choices the
audit left open are taken here from the manifesto (`.claude/skills/claudio-ui/references/`) and
listed in §11. Built by the orchestration in §10.

## Contents

1. [What the owner decided](#1-what-the-owner-decided)
2. [Ground rules](#2-ground-rules)
3. [The eight groups](#3-the-eight-groups)
4. [Navigation and addresses](#4-navigation-and-addresses)
5. [Settings search](#5-settings-search)
6. [The screens](#6-the-screens)
7. [Decisions, and the Supervisor folded into its point](#7-decisions-and-the-supervisor-folded-into-its-point)
8. [Copy](#8-copy)
9. [Tests that change](#9-tests-that-change)
10. [Orchestration](#10-orchestration)
11. [Choices taken in this plan](#11-choices-taken-in-this-plan)
12. [Outcome](#outcome)

## 1. What the owner decided

From the audit, 2026-10-17:

1. **Eight groups and settings search** replace the 23 tabs: General · Claude Code · Connections ·
   Instructions & memory · Extensions · Decisions · Runs & spend · Access & safety. Two levels of
   navigation. Security splits into Access & safety and Runs & spend. The Account tab goes: updates
   and the CLI version to General, the sign-in panel to Claude Code only. Memory becomes a line in
   Instructions & memory.
2. **The Supervisor folds into the `supervisor.intervene` point**, its model and cost inherited from
   the engine; `supervisor.json` stays on disk. This changes decision record D7.
3. **The Decisions chips go** (AP5): the engine heads the screen; History opens from each point's
   metrics and from one link. This changes decision record D3.
4. **Connectors moves into Settings → Connections**, with the code hosts, trackers, webhooks and MCP
   servers. The sidebar goes from 12 entries to 11.
5. **The privacy box goes** (AP7): one consequence line under the provider and a "See an example
   payload" link.
6. **Thresholds show only under Jev**, where they act.
7. **The cost cap's consequence** is "≈ $X a day at today's volume", from the history; with a daily
   spend cap set it adds "≈ N decisions a day within your cap".
8. **Renames:** the Claude Code "Settings" tab becomes "Behaviour (`settings.json`)"; the Decisions
   "Provider" becomes "Who answers" / "Quién responde". The daily spend cap moves to Runs & spend,
   referenced from Decisions and Usage.

## 2. Ground rules

- **Nothing is lost.** Every control of the 23 tabs has a place in §3, and every address that works
  today keeps working through the redirects of §4.3.
- **Existing components move; they are not rewritten.** A tab's component becomes a section or a
  detail screen of its group. A component is restyled only where §6 or §7 says so, and only with the
  classes and controls the app already has (`packages/ui/src/components/controls`).
- **Two levels of navigation, at most, at any time:** the app's sidebar and the settings nav. Inside a
  group there are sections on one screen, never chips or sub-tabs. What does not fit on a screen
  (an editor, a long list) is a **detail** screen reached from a row: list → detail, with a back link,
  the settings nav still visible beside it on a desktop.
- **The manifesto applies to every row:** a tier per setting, a consequence on every number and
  enum, nothing shown that does not apply, no description over 60 characters, no border as a
  separator (AP11), constant weight, states that do not move the layout.
- **Project-scoped settings are out of scope.** The project's own Settings view (overrides of
  decisions and the rest) keeps its layout; a global row whose value some project overrides says so
  in its consequence line (§6.0).
- **Core changes only where §7.2 needs them.** Every other setting keeps its file, its route and its
  reader.

## 3. The eight groups

Ids are the address (`/settings/<id>`). Sections are on the group's screen, in this order; a
**detail** is its own screen at `/settings/<id>/<detail>`.

| Group (id) | Sections, in order | Details | From today's tabs |
|---|---|---|---|
| **General** (`general`) | Appearance (`#appearance`): theme, language, motion · Notifications (`#notifications`): kinds and devices · Updates (`#updates`): Claudio's updates and the Claude Code CLI version · Install (`#install`): the app on this device | — | appearance, notifications, account (`UpdatesCard`, `CliCard`), install |
| **Claude Code** (`claude-code`) | Sign-in (`#sign-in`): the account in use, Verify, Remove, the sign-in panel, a row to Accounts · Provider (`#provider`): the binary, its version and path, the limits · Behaviour (`#behaviour`): one row opening the editor · Files (`#files`): one row opening the tree | `behaviour` (the `settings.json` editor), `files` (the `~/.claude` tree) | account (in use, sign-in), providers, settings, files |
| **Connections** (`connections`) | Connectors (`#connectors`): the claude.ai connectors · Code hosts (`#code-hosts`): gh, glab · Trackers (`#trackers`): YouTrack · Webhooks (`#webhooks`) · MCP servers (`#mcp`): one row per server and a row opening the editor | `mcp` (the server list and editor) | the Connectors page, integrations, mcp |
| **Instructions & memory** (`instructions`) | Instructions (`#instructions`): a row opening `CLAUDE.md` · Memory (`#memory`): one line, "N projects keep memory", opening the table · Lessons (`#lessons`): the lessons settings, a row opening the global lessons · Rules (`#rules`) and Output styles (`#output-styles`): one row each, with the count | `claude-md`, `memory`, `lessons`, `rules`, `output-styles` | instructions, memory, lessons, rules, output-styles |
| **Extensions** (`extensions`) | Plugins (`#plugins`), Skills (`#skills`), Agents (`#agents`), Commands (`#commands`), Workflows (`#workflows`), Tool presets (`#tool-presets`): one row each, with the count and where they come from | one per kind: `plugins`, `skills`, `agents`, `commands`, `workflows`, `tool-presets` | plugins, skills, agents, commands, workflows, tools |
| **Decisions** (`decisions`) | Who answers (`#engine`) · Decision points (`#points`), by area, the Supervisor among them (`#point-supervisor-intervene`) | `history` (every decision, filterable by point) | decisions, supervisor |
| **Runs & spend** (`runs`) | Runs (`#runs`): default permission mode, concurrent runs · Daily spend cap (`#spend-cap`) · Evals (`#evals`): phase 2 | — | security (`RunsCard`, `SpendCard`, `EvalsCard`) |
| **Access & safety** (`access`) | Access (`#access`): mode, token, read-only · Allowed hosts (`#hosts`) · Remote access (`#remote`): the tunnel · Secrets (`#secrets`) · Guards (`#guards`) · Terminal (`#terminal`) · Audit log (`#audit`): the latest rows and a row opening the log · Agent reads (`#agent-reads`): the latest and a row opening them | `audit`, `agent-reads` | security (the rest), remote |

The sidebar loses **Connectors** (12 entries → 11). The phone's More sheet loses its Connectors entry,
and its connection link points to `/settings/claude-code#sign-in`.

## 4. Navigation and addresses

### 4.1 Addresses

- `/settings` opens **General** on a desktop and the group list on a phone.
- `/settings/<group>` is a group's screen; `#<section>` scrolls to a section and focuses its heading.
- `/settings/<group>/<detail>` is a detail screen. A detail that edits one thing takes its own query
  where it already does today (a file path, a resource name).
- An unknown group or detail redirects to `/settings` (replace, not push).

### 4.2 The shell

- **Desktop:** the settings nav (`nav.settings-nav`, kept) holds the search field (§5) and the eight
  groups as one `role=tablist` (`.settings-nav-item`, kept), with the dirty dot (`.tab-dirty`, kept).
  The group headings (`.settings-nav-label`) go: eight entries need none. The body
  (`.settings-body[role=tabpanel]`, kept) holds the group's screen or a detail. A detail starts with a
  back link to its group (`← Extensions`), sans, `--fg-2`, and its title.
- **Phone:** list → group → detail, each a screen with `PhoneHeader` and its back button
  (`.settings-cells`, `.settings-cell`, kept). The list starts with the search field, then the theme
  `Segmented` (kept), then one card of eight cells. Never a sheet inside a sheet.
- The leave guard (`useLeaveGuard`) covers group and detail changes, as it covers tab changes today.
- Keyboard: ↑ ↓ Home End move across the eight groups; `/` focuses the search while Settings is open.

### 4.3 Redirects (old addresses keep working)

`resolveSettingsAddress(search, hash)` in `settingsGroups.ts` maps every `?tab=` id and every hash
used today, and `Settings.tsx` replaces the URL on load. The map is the contract the link
migration (§10, `w1`) and the e2e specs rely on.

| Old | New |
|---|---|
| `?tab=appearance`, `notifications`, `install` | `/settings/general#appearance`, `#notifications`, `#install` |
| `?tab=account` | `/settings/claude-code#sign-in` (the update dot links to `/settings/general#updates`) |
| `?tab=providers` | `/settings/claude-code#provider` |
| `?tab=settings`, `files` | `/settings/claude-code/behaviour`, `/settings/claude-code/files` |
| `?tab=integrations` | `/settings/connections#code-hosts` |
| `?tab=mcp` | `/settings/connections/mcp` |
| `/connectors` | `/settings/connections#connectors` |
| `?tab=instructions`, `memory`, `lessons`, `rules`, `output-styles` | `/settings/instructions/claude-md`, `/memory`, `/lessons`, `/rules`, `/output-styles` |
| `?tab=plugins`, `skills`, `agents`, `commands`, `workflows`, `tools` | `/settings/extensions/<kind>` (`tools` → `tool-presets`) |
| `?tab=decisions` | `/settings/decisions` |
| `?tab=supervisor` | `/settings/decisions#point-supervisor-intervene` |
| `?tab=security` | `/settings/access` |
| `?tab=security#guards`, `#agent-reads` | `/settings/access#guards`, `/settings/access/agent-reads` |
| `?tab=remote` | `/settings/access#remote` |

The links that build these addresses in the app (listed in the audit's code map: `App.tsx`,
`StatusBar.tsx`, `CommandPalette.tsx`, `SetupAssistant.tsx`, `provider-state.ts`,
`provider-status.ts`, `ChangeRequestFreshness.tsx`, `PullRequest.tsx`, `ProjectGeneral.tsx`,
`Terminals.tsx`, `SpendCapDialog.tsx`, `RemoteAccessTab.tsx`, `GuardTag.tsx`, `SharedView.tsx`,
`AgentsCard.tsx`, `DecisionMark.tsx`, `DecisionsLine.tsx`, `McpTab.tsx`, `InstallTab.tsx`,
`SettingsGuided.tsx`, `lib/chat-ui.tsx`, `ClaudeDocs.tsx`, `phone-header.ts`, `shell-live.ts`) move to
the new addresses through one helper, `settingsHref(group, { section?, detail? })`, so no string
`?tab=` is left outside the redirect map. `packages/shared/src/notifications.ts` builds a link to
`?tab=security` for the spend notification: it moves to `/settings/runs#spend-cap`.

## 5. Settings search

- **Where:** the first thing in the settings nav on a desktop and in the group list on a phone. A
  `type=search` input at 16 px on a phone, `aria-label` "Search settings", placeholder "Search
  settings".
- **What it indexes:** a registry, `apps/web/src/pages/config/settingsIndex.ts`, one entry per
  setting and per section: `{ id, group, section, detail?, label, keywords, consequence? }`, each text
  an i18n key, so a Spanish person searches in Spanish. The registry is written once, for every row of
  §6 (about 90 entries), and every screen gives its row the `id` the entry names (`data-setting`).
- **Matching:** case- and accent-insensitive, every word of the query a prefix of some word of the
  label, the keywords or the consequence. Order: label matches, then keywords, then consequence; ties
  by group order.
- **Results:** while the field is not empty, the nav lists results in place of the groups (the group
  in `--fg-3` above each label, at most 12, "No setting matches “{{query}}”" when none). ↑ ↓ move, Enter
  opens, Escape clears. On a phone the results replace the cells.
- **Opening a result** goes to its group (or detail), scrolls the row into view, focuses its control
  and fills the row with `--bg-2` that fades over `--dur-slow`; the fill does not animate under the
  reduced motion levels or `prefers-reduced-motion`.
- **The palette** (Ctrl K) reads the same registry: its `settings` group lists every section and
  setting, not today's 14 tabs, with the group as the hint.

## 6. The screens

### 6.0 What every screen shares

- **A group's screen:** the group title (`--fs-title`), then sections. A section heading is
  `--fs-section`, `--fw-strong`, sans, with the section's anchor. Sections are separated by space
  (a 32 px gap between sections, 12 px between rows), not by cards with borders (AP11). A row is the anatomy of
  `settings-patterns.md`: label and control on one baseline, a consequence line under the label,
  the changed dot and Reset reserved.
- **A detail row:** a row whose control is a chevron and a count ("Skills · 12 · 3 from plugins"),
  44 px tall on a phone, opening the detail.
- **States** every screen covers: normal; long content (labels +40 %, a 64-character email, a key
  without spaces, seven-digit figures); empty (no projects, no key, no server); loading (a skeleton of
  the exact height of what it waits for); error (next to the control, in reserved space, with what to
  do; never a toast for a field); overridden (a global row some project overrides: "Overridden in 2
  projects", linking to the first).
- **Saving:** each section saves on its own, as each card does today. The save button reserves the
  width of its longest state (AP10).

### 6.1 General

- **Appearance:** theme (the three cards, kept), language (`Select`), motion (`Segmented`, with its
  preview). Primary: theme.
- **Notifications:** the kinds and the devices (`NotificationsTab`, `DevicesCard` as sections, their
  cards' borders removed).
- **Updates:** Claudio's updates (`UpdatesCard`) and, below it, the Claude Code CLI line (version,
  path in mono, Check now) from `CliCard`.
- **Install:** `InstallTab` as a section. Its link to notifications becomes `#notifications` on the
  same screen.

### 6.2 Claude Code

- **Sign-in:** the account in use (status, account, subscription, credential, Verify, Remove) and the
  Claude Code sign-in panel, from `AccountTab`. One row, "Accounts · 3 · rotation on", opens
  `/accounts`. The panel is no longer also in Providers.
- **Provider:** `ProviderRow` with `LimitBars`, and the binary (`BinaryEditor`, inline on a desktop,
  a `Sheet` on a phone, as today). The re-check toolbar becomes the row's own "Check again".
- **Behaviour:** one detail row, "Behaviour (`settings.json`)", opening `SettingsTab` at
  `/settings/claude-code/behaviour`.
- **Files:** one detail row opening `FilesTab` at `/settings/claude-code/files`.

### 6.3 Connections

- **Connectors:** the Connectors page's cards and its authorisation steps, as a section. The page
  header goes; its intro becomes the section's one consequence line.
- **Code hosts**, **Trackers**, **Webhooks:** `IntegrationsTab`'s three cards as three sections.
- **MCP servers:** one row per server (name in mono, transport, scope) and a detail row opening
  `McpTab` at `/settings/connections/mcp`.

### 6.4 Instructions & memory

- **Instructions:** a detail row opening the `CLAUDE.md` editor (`InstructionsTab`).
- **Memory:** one line, "N projects keep memory", opening `MemoryOverview` (moved out of
  `Settings.tsx` into its own file) at `/settings/instructions/memory`. With none: "No project keeps
  memory yet".
- **Lessons:** the lessons settings card as rows, and a detail row opening the global lessons.
- **Rules**, **Output styles:** a detail row each, opening `ResourcesTab kind=…`.

### 6.5 Extensions

Six detail rows, each with the count and its sources ("12 · 3 from plugins"), opening `PluginsTab`,
`ResourcesTab kind=skills|agents|commands|workflows` and `ToolPresetsTab`. Plugins keeps its own
Installed / Browse / Marketplaces switch inside its detail: it is the detail's content, not a third
level of navigation.

### 6.6 Decisions

See §7.

### 6.7 Runs & spend

- **Runs:** default permission mode (`Select`, primary) and concurrent runs (`NumberInput`), each
  with its consequence ("Up to 8 chats work at once; the next ones wait").
- **Daily spend cap:** `SpendCard`, with its consequence (today's spend against it, formatted with
  `formatCost`/`formatPercent`). Usage and Decisions link here.
- **Evals:** phase 2 (`EvalsCard`).

### 6.8 Access & safety

- **Access:** the mode (`Segmented` None / Token / OIDC, primary), the token (`TokenCard`, the
  secrets pattern), read-only (`Switch`) with its consequence.
- **Allowed hosts:** `HostsCard`. **Remote access:** `RemoteAccessTab`'s tunnel states as a section.
  **Secrets:** `SecretsCard`. **Guards:** `GuardsCard`. **Terminal:** `TerminalCard`.
- **Audit log:** the five latest rows and a detail row opening `AuditCard` at
  `/settings/access/audit`. **Agent reads:** the latest and a detail row opening `AgentReadsCard` at
  `/settings/access/agent-reads`. A detail owns its filters; the group screen has none.

## 7. Decisions, and the Supervisor folded into its point

### 7.1 The screen

No chips, no Supervisor section, no History section on the screen. From top to bottom:

1. **Who answers** (`#engine`), primary: the `Segmented` Claude Code CLI / Jev, with **Beta** once,
   on the Jev option. Its consequence line:
   - CLI: "Uses your Claude Code quota. Nothing leaves this machine."
   - Jev: "Sends each point's declared state to Jev. See an example payload" — the link opens the
     consent preview of the first consented point (or of `supervisor.intervene` when none is), the
     dialog that already exists.
   - Under Jev, revealed with `grid-template-rows: 0fr → 1fr`: the Jev key (the secrets pattern,
     `JevKey`), with the model as a hint attached to the option ("jev-1.13.0, pinned"), never a row
     (AP3). The privacy box goes (AP7). `JevUnavailable` stays, above the selector, only when Jev
     failed.
2. **Cap per decision**, secondary, `NumberInput` in dollars. Its consequence, from
   `GET /decisions/stats` over the history window:
   - "≈ $X a day at today's volume", X = the cap × the average decisions a day;
   - with a daily spend cap set: "· ≈ N decisions a day within your cap", N = ⌊daily cap / cap⌋;
   - with no decisions yet: "At most $cap per decision".
3. **Advanced** (`Collapsible`, folded): the CLI model, the CLI effort, and how many days of
   history are kept. Shown under CLI only, except the history days, which apply to both.
4. **Decision points** (`#points`): the ten areas, folded as today, each point an **evidence row**:
   - the name; the mode `Segmented` Off / Shadow / Active;
   - the evidence line: "47 decisions · agrees with you 94 % · 3 disagreements", the last linking to
     History filtered by the point; with no decisions, "No decisions yet";
   - consent, only on a point that is not Off, in the evidence line ("Consented on 17 Oct ·
     Withdraw");
   - the threshold (`Slider` 0.5–0.99), only under Jev, on act points, as a secondary line.
   - The bulk mode controls (`BulkMode`) stay at the head of each area.
5. **One link to History**, after the points: "See every decision", to `/settings/decisions/history`
   (`DecisionHistory`, unchanged, with a point filter it takes from `?point=`).

The sticky save bar (`.dp-foot`) stays: Who answers, the cap, Advanced and the point modes save
together, as `PUT /decisions/settings` does today.

### 7.2 The Supervisor as `supervisor.intervene`

Today the Supervisor has its own switch, model, cost cap and auto-send in `supervisor.json`, and the
`supervisor.intervene` point only decides, when Active under Jev, whether a hint is asked for. Two
switches for one behaviour. After this plan the point is the only control:

| Point mode | The Supervisor |
|---|---|
| Off | does not watch; no hint is asked for |
| Shadow | proposes hints for a person to send, as `enabled: true, autoSend: false` does today; under Jev the engine records what it would have decided |
| Active | sends its hints on its own, as `autoSend: true` does today; **under Jev**, only when the engine expects a hint to help (today's `declined`) |

- **Active works under CLI for this point.** Every other act point stays "active in name only" under
  CLI (`engine.ts`, `limited`), because their threshold needs Jev's probabilities. For
  `supervisor.intervene`, Active means "send on its own", which needs no probability; under CLI it
  sends every hint, under Jev it keeps today's gate. The row's consequence says which.
- **Model and cost** are the engine's: the CLI model and the cap per decision of §7.1 (the defaults
  are close: haiku with $0.05 for the Supervisor, haiku with $0.02 for the engine).
- **`supervisor.json` stays on disk** and is read once, by a migration in core, when `decisions.json`
  has no `supervisorMigrated` mark: `enabled: false` → Off; `enabled` without `autoSend` → Shadow;
  `enabled` with `autoSend` → Active. A point already set by the person to something other than Off
  keeps its mode unless the Supervisor was disabled (then Off). The mark is written with the result;
  the file is never written again.
- **The routes:** `GET /settings/supervisor` answers the view derived from the point
  (`enabled: mode ≠ off`, `autoSend: mode = active`, the engine's model and cap);
  `PUT /settings/supervisor` maps `enabled` / `autoSend` onto the point's mode and ignores the model
  and the cap. Both are marked deprecated in `docs/rest-api.md` and the OpenAPI summary. Any MCP tool
  that wrote the Supervisor writes the point.
- **Decision records:** D3 and D7 in `docs/decisions/decision-engine.md` get a dated amendment
  pointing here; their original text stays.

## 8. Copy

New strings, en and es, sentence case, per `apps/web/src/i18n/GLOSSARY.md`. Existing section and
row strings keep their keys where the component moves unchanged.

| Key (sketch) | en | es |
|---|---|---|
| `settings.groups.general` | General | General |
| `settings.groups.claude-code` | Claude Code | Claude Code |
| `settings.groups.connections` | Connections | Conexiones |
| `settings.groups.instructions` | Instructions & memory | Instrucciones y memoria |
| `settings.groups.extensions` | Extensions | Extensiones |
| `settings.groups.decisions` | Decisions | Decisiones |
| `settings.groups.runs` | Runs & spend | Ejecuciones y gasto |
| `settings.groups.access` | Access & safety | Acceso y seguridad |
| `settings.search.label` / `.placeholder` | Search settings | Buscar ajustes |
| `settings.search.none` | No setting matches “{{query}}” | Ningún ajuste coincide con «{{query}}» |
| `settings.back` | ← {{group}} | ← {{group}} |
| `settings.behaviour` | Behaviour (`settings.json`) | Comportamiento (`settings.json`) |
| `settings.memory.line` | {{count}} projects keep memory | {{count}} proyectos guardan memoria |
| `settings.memory.none` | No project keeps memory yet | Ningún proyecto guarda memoria todavía |
| `settings.overridden` | Overridden in {{count}} projects | Cambiado en {{count}} proyectos |
| `decisions.whoAnswers` | Who answers | Quién responde |
| `decisions.consequence.cli` | Uses your Claude Code quota. Nothing leaves this machine. | Usa tu cuota de Claude Code. Nada sale de esta máquina. |
| `decisions.consequence.jev` | Sends each point's declared state to Jev. | Envía a Jev el estado declarado de cada punto. |
| `decisions.examplePayload` | See an example payload | Ver un ejemplo de lo que se envía |
| `decisions.cap.label` | Cap per decision | Tope por decisión |
| `decisions.cap.perDay` | ≈ {{cost}} a day at today's volume | ≈ {{cost}} al día con el volumen de hoy |
| `decisions.cap.withinDaily` | ≈ {{count}} decisions a day within your cap | ≈ {{count}} decisiones al día dentro de tu tope |
| `decisions.cap.none` | At most {{cost}} per decision | Como mucho {{cost}} por decisión |
| `decisions.advanced` | Advanced | Avanzado |
| `decisions.allHistory` | See every decision | Ver todas las decisiones |
| `decisions.evidence.none` | No decisions yet | Aún no hay decisiones |
| `decisions.supervisor.activeCli` | Sends each hint on its own | Envía cada pista por su cuenta |
| `decisions.supervisor.activeJev` | Sends a hint when Jev expects it to help | Envía una pista cuando Jev espera que ayude |
| `decisions.supervisor.shadow` | Proposes hints for you to send | Propone pistas para que las envíes tú |

Plurals go through i18next's `_one` / `_other`. Percentages and money go through `formatPercent`
and `formatCost`, never a `%` or `$` in a string.

## 9. Tests that change

- **Unit (web):** `decisions-tab.test.tsx` (groups and the redirect map instead of `TAB_ORDER` and
  the alias), `providers-settings.test.tsx`, `integrations-settings.test.tsx`,
  `lessons-settings.test.tsx` (labels and placement in their groups), `pwa.test.ts`
  (`/settings/general#install`); new `settings-groups.test.ts` (every old address maps, unknown ones
  go to `/settings`, no `?tab=` string left outside the map, by a grep test) and
  `settings-search.test.ts` (accents, prefixes, order, Spanish); the strings, class-names and
  module-graph fixtures regenerated once, at the end.
- **Unit (core):** `supervisor.test.ts` and the decisions tests: the three modes of §7.2, Active
  under CLI for this point only, the migration (each case, idempotent, the file never written), the
  deprecated routes in `apps/api/test`.
- **e2e:** `decisions.spec.mjs` (no chips; History through its link; the phone checks kept),
  `supervisor.spec.mjs` (the point's modes instead of the form), `a11y-shared.mjs` (`SETTINGS_TABS`
  becomes the eight groups and the details), `a11y-shell.spec.mjs` (no `/connectors` in the More
  sheet), `shell.spec.mjs` (back from a group and from a detail), `palette.spec.mjs`,
  `pages.spec.mjs`, `e2e/ui/routes.mjs`, and every spec that opens `?tab=` (the redirects keep them
  working; a spec that asserts the URL moves to the new one). New `settings-search.spec.mjs`: search,
  open, focus, the fill, Escape, on a desktop and a phone.

## 10. Orchestration

One orchestration, **`claudio-settings-ia`**, `cwd` the worktree of `feat/settings-ia`,
`worktree: true`, concurrency 3, `maxAttempts` 2, `synthesize` on, engine `graph`. Code tasks on
`claude-opus-5-5`, `x1` (prose) on `claude-sonnet-5-5`; never fable. No worker runs the e2e suite:
it never runs on this machine (`docs/decisions/e2e-on-github.md`); verification runs it on GitHub.

**Verification** on the merged branch, fixer on `claude-opus-5-5`, 3 attempts, 40 minutes:
`pnpm install --frozen-lockfile`; `pnpm typecheck` with the OpenAPI drift check; `node
scripts/design-lint.mjs`; `pnpm -r --workspace-concurrency=1 test`; `pnpm build`; then
`git push -f -u origin HEAD && E2E_REMOTE_WAIT=1800 pnpm e2e:remote` (the whole suite on GitHub,
for the integration branch).

Stages: `c1 · w1` → `w2 · w3 · w4` → `w5` (needs `c1`) → `e1` → `x1`.

| Id | Task | dependsOn | Owns | Checks |
|---|---|---|---|---|
| `c1` | **The Supervisor as its point** (§7.2): the three modes in `supervisor.ts` (`wake` reads the point, not `config.enabled` / `autoSend`; model and cap from the engine's CLI settings), Active allowed under CLI for `supervisor.intervene` only (`engine.ts`), the one-time migration and its mark (`decisions/settings.ts`), the deprecated `GET/PUT /settings/supervisor` mapping, their OpenAPI summaries and `docs/rest-api.md` rows, any MCP tool that wrote the Supervisor | — | `packages/core/src/supervisor.ts`, `packages/core/src/decisions/{engine,settings,points}.ts` (the parts named), `packages/shared/src/types.ts` (the Supervisor and decision-settings types only), `apps/api/src/routes/*supervisor*`/the route file that holds them, `apps/api/src/openapi/routes.ts` (those entries), `apps/api/src/openapi/schemas.json` (regenerated), `docs/rest-api.md` (those rows), `packages/mcp/src/**` (only a tool that wrote the Supervisor), their tests | core and api tests, schema drift, `pnpm typecheck` |
| `w1` | **The shell, the addresses and search** (§4, §5): `settingsGroups.ts` (the groups, sections, details, `resolveSettingsAddress`, `settingsHref`) replacing `settingsTabs.ts`; routing `/settings/:group/:detail?` in `App.tsx`; `Settings.tsx` as the shell (desktop nav with search, phone list → group → detail, leave guard, keys); `settingsIndex.ts` with every entry of §6 and §7 (ids as named there); the search UI; the palette reading the registry; the link migration of §4.3 across the app and `packages/shared/src/notifications.ts`; the sidebar and More sheet without Connectors; `/connectors` redirecting; one placeholder screen per group that renders today's components in §3's order, which `w2`–`w5` replace; the new variants in `docs/design-system/claudio-ds.css` and `styles/editors.css`; `settings-groups.test.ts`, `settings-search.test.ts` | — | `apps/web/src/pages/Settings.tsx`, `apps/web/src/pages/config/settingsGroups.ts` (new), `settingsIndex.ts` (new), `settingsTabs.ts` (removed), `apps/web/src/pages/config/search/**` (new), `apps/web/src/pages/config/groups/*.tsx` (the placeholders), `apps/web/src/App.tsx`, `apps/web/src/components/CommandPalette.tsx`, `palette-model.ts`, `components/shell/**` (the More sheet and phone header only), every link site of §4.3 (the href only), `packages/shared/src/notifications.ts` (the link only), `apps/web/src/styles/editors.css` (the settings shell block), `docs/design-system/claudio-ds.css` (the new variants), `apps/web/src/i18n/locales/*/config.json` (`settings.*` keys), the two new tests | `pnpm typecheck`, web tests, `node scripts/design-lint.mjs` on the files changed, no `?tab=` string outside the map |
| `w2` | **General and Claude Code** (§6.1, §6.2): the two group screens, the Account tab split, `ProvidersTab` without its own sign-in panel, the detail screens `behaviour` and `files` | `w1` | `apps/web/src/pages/config/groups/{General,ClaudeCode}.tsx`, `AccountTab.tsx` (removed or split), `ProvidersTab.tsx`, `AppearanceTab.tsx`, `NotificationsTab.tsx`, `InstallTab.tsx`, `SettingsTab.tsx`, `FilesTab.tsx` (layout only), their locale keys, `providers-settings.test.tsx`, `pwa.test.ts` | `pnpm typecheck`, web tests, design lint on the files changed |
| `w3` | **Connections, Instructions & memory, Extensions** (§6.3–§6.5): the three group screens, the Connectors page as a section (`Connectors.tsx` removed as a page), `MemoryOverview` in its own file, the detail rows with their counts | `w1` | `apps/web/src/pages/config/groups/{Connections,Instructions,Extensions}.tsx`, `apps/web/src/pages/Connectors.tsx` (moved), `IntegrationsTab.tsx`, `McpTab.tsx`, `LessonsTab.tsx`, `ResourcesTab.tsx`, `PluginsTab.tsx`, `ToolPresetsTab.tsx`, `InstructionsTab.tsx` (layout only), `MemoryOverview.tsx` (new), their locale keys, `integrations-settings.test.tsx`, `lessons-settings.test.tsx` | `pnpm typecheck`, web tests, design lint on the files changed |
| `w4` | **Runs & spend, Access & safety** (§6.7, §6.8): the two group screens from `SecurityTab` and `AppSettingsCards`, `RemoteAccessTab` as a section, the `audit` and `agent-reads` details, the spend cap's links from Usage and Decisions | `w1` | `apps/web/src/pages/config/groups/{Runs,Access}.tsx`, `SecurityTab.tsx` (removed or split), `security/**`, `RemoteAccessTab.tsx`, the spend cap link in `pages/usage/**` (the href only), their locale keys and tests | `pnpm typecheck`, web tests, design lint on the files changed |
| `w5` | **Decisions** (§7.1, and §7.2's row): the screen without chips, Who answers with the Jev reveal and the example-payload link, the cap and its consequence, Advanced, evidence rows, thresholds only under Jev, the Supervisor row with its three meanings, the `history` detail with `?point=`, `SupervisorTab.tsx` removed | `w1`, `c1` | `apps/web/src/pages/config/DecisionsTab.tsx` → `groups/Decisions.tsx`, `apps/web/src/pages/config/decisions/**`, `SupervisorTab.tsx` (removed), `apps/web/src/styles/decisions.css`, `decisions.json` and `observe.json` locale keys, `decisions-tab.test.tsx` and the decisions unit tests | `pnpm typecheck`, web tests, design lint on the files changed |
| `e1` | **The e2e specs and the fixtures** (§9): every spec listed there, `settings-search.spec.mjs`, `a11y-shared.mjs`, `e2e/ui/routes.mjs`, `e2e/timings.json` (the new spec, at the median); the strings, class-names and module-graph fixtures regenerated (`tsx scripts/class-inventory.ts --write`, `tsx scripts/module-graph.ts --write`, the strings fixture rebuilt from `src/i18n/resources`). It does not run the specs: verification does, on GitHub | `w2`, `w3`, `w4`, `w5` | `e2e/specs/**` (the specs named), `e2e/ui/routes.mjs`, `e2e/timings.json`, `apps/web/test/fixtures/{strings,class-names,module-graph}.json` | `node --test e2e/shards.test.mjs e2e/remote.test.mjs`, web tests with the fixtures regenerated |
| `x1` | **Docs** (sonnet): `docs/settings.md` (new: the eight groups, the addresses, search, the Supervisor as a point, in plain words), `docs/design-system.md` (the Settings section: groups, rows, details, search; the stale "20 tabs" line), the amendments to D3 and D7 in `docs/decisions/decision-engine.md`, `docs/reports/settings-ia-audit.md` (a "Built" line), this plan's Outcome, `docs/status.md` (one row) | `e1` | `docs/settings.md` (new), `docs/design-system.md` (the Settings parts), `docs/decisions/decision-engine.md` (amendments only), `docs/reports/settings-ia-audit.md` (one line), `docs/plans/settings-ia.md` (Outcome only), `docs/status.md` (one row) | links resolve; front matter as `docs/knowledge-base.md` asks |

Locale files are shared by key prefix: `w1` owns `settings.*`, each screen task the keys of the
components it owns. Generated files (the OpenAPI schemas, the three web fixtures) are regenerated,
never merged by hand.

After the orchestration, the `ui-reviewer` agent reviews every group screen and every detail, on a
desktop and a phone, in both themes, against a dev server of the integration branch, until each is
SHIPPABLE; its findings are fixed on the branch before the pull request.

## 11. Choices taken in this plan

Where the audit left a choice open, the manifesto decided:

- **Addresses are paths, not `?tab=`** (`/settings/<group>/<detail>`): a detail is a screen of its
  own (list → detail), and the browser's back goes where the person expects. Every old address
  redirects (§4.3).
- **Group headings in the settings nav go:** eight entries need no grouping, and the uppercase level
  belongs to the sidebar only (manifesto §5).
- **Editors and long lists are details**, not sections: a resource editor on a group screen would
  make the screen a third level of navigation.
- **Files and Behaviour live under Claude Code**, being the files Claude Code reads; **MCP servers**
  under Connections, as the audit's decision 4 lists them; **Remote access** under Access & safety,
  being access; **Install** under General.
- **Each section saves on its own**, as each card does today, except Decisions, whose one save bar
  stays: changing that would change what `PUT /decisions/settings` validates together.
- **The Supervisor's Active works under CLI** (§7.2): the owner's decision gives auto-send to the
  point's Active, and auto-send never needed Jev's probabilities. Without this, a person who sends
  hints automatically today would lose it.
- **Search indexes i18n keys**, so it works in both languages, and the palette reads the same
  registry, so every setting is one Ctrl K away (manifesto §6).

## Outcome

Built on 2026-10-17 by the orchestration of §10 (`c1`, `w1`–`w5`, `e1`, `x1`), as the plan settles
it; the person's guide is [settings.md](../settings.md) and the design rules are in
[design-system.md](../design-system.md#settings-groups-rows-details-and-search). Verification ran on GitHub for the
integration branch (orchestration 07984737) and passed after five fixer attempts: typecheck, OpenAPI
drift, design lint, every test, the build and the whole e2e suite.

**Built**

- **Core and API (`c1`):** the Supervisor reads the `supervisor.intervene` point's mode; Active works
  under the CLI for that point only; a one-time migration of `supervisor.json` with its mark; the
  deprecated `GET/PUT /settings/supervisor` over the point.
- **Shell and search (`w1`):** `settingsGroups.ts` (groups, sections, details, `resolveSettingsAddress`,
  `settingsHref`), `settingsIndex.ts` and `search/`, the palette reading the registry, the links
  migrated, `/connectors` redirecting, the sidebar at 11 entries.
- **Screens (`w2`–`w5`):** the eight group screens under `pages/config/groups/`, `MemoryOverview` and
  the Connectors section in their own files, the `audit`, `agent-reads` and `history` details, and
  Decisions without chips or a Supervisor screen.
- **Tests (`e1`):** the specs of §9, a new `settings-search.spec.mjs`, the three web fixtures
  regenerated.

**Where it differs from the plan**

- The shared row and section pieces (`PrefRow`, `groups/Section.tsx`, `groups/Block.tsx`) were added
  to build the screens; their classes are in the design system's
  [setting row](../design-system.md#the-setting-row-settings) and a section's parts, not in §6.
- `e2e/ui/routes.mjs` has no interaction for the Jev reveal or Advanced on `/settings/decisions`: a
  reveal moves what follows it by design, and the layout-shift check (I4) counts every shift, the
  ones right after an input included. Both reveals now share `SettingsReveal` and collapse to nothing
  when closed; the check stays out of those two on purpose.

**Fixed after the reviews**

- A search result focuses the row's own control (the number field of "Concurrent runs"), never a
  `tabindex="-1"` helper such as its Decrease button (`search/reveal.ts`; unit test
  `test/reveal-focus.test.ts`, and the `settings-search` spec asserts the focused element).
- Stale copy: "Settings → Security", "Providers", "Integrations", "Account", "Remote access" and the
  rest now name the group and section they moved to (Access & safety, Claude Code, Connections,
  General, Runs & spend; `es` per the glossary), in the locales, the code, the specs and the docs.
- The Jev reveal on Decisions no longer has a copy of its own: it uses `SettingsReveal`, which gives
  back its gap when closed, so a closed reveal leaves no empty space.
- A Decisions area's summary wraps under its name on a phone instead of being cut.
- "Ask the CLI again" and a provider's "Check again" stay focusable while they work (`aria-busy`,
  not `disabled`).
- The permission-mode lists show the chat's words (`modeLabel`) instead of `acceptEdits`.
- The audit table wraps words normally; actors and paths are literals that end in an ellipsis and
  carry their full text.
- Four lessons settings gained a consequence line, and the descriptions over 60 characters are
  shorter, in both languages.

**Open, for the owner** (reviewers asked; not built here)

- A per-row "changed" dot and Reset.
- "Overridden in N projects" on a global row.
- Granting consent from a Shadow row.

## Related

[[reports/settings-ia-audit.md]] · [[plans/claudio-designer.md]] · [[plans/decision-engine.md]] · [[decisions/decision-engine.md]] · [[design-system.md]] · [[decisions/e2e-on-github.md]]
