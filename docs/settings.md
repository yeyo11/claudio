---
created_at: 2026-10-17T20:00:00Z
updated_at: 2026-10-20T18:00:00Z
tags:
    - settings
    - information-architecture
    - decisions
    - ui
    - reference
---
# Settings

Where a person finds each setting, and how to get there. Settings has **eight groups and a search**.
Inside a group the settings are sections on one screen; what does not fit on a screen (an editor, a
long list) opens as a detail screen with a back link. The decision behind this layout is in the
[plan](plans/settings-ia.md) and the [audit](reports/settings-ia-audit.md) it came from.

## The eight groups

| Group | What is in it |
|---|---|
| **General** | Appearance (theme, language, motion), Notifications (kinds and devices), Updates (Claudio's updates and the Claude Code CLI version), Install (the app on this device) |
| **Claude Code** | Sign-in (the account in use, Verify, Remove, a row to Accounts), Provider (the binary, its version and path, the limits), Behaviour (the `settings.json` editor), Files (the `~/.claude` tree) |
| **Connections** | Connectors (the claude.ai connectors), Code hosts (`gh`, `glab`), Trackers (YouTrack), Webhooks, MCP servers |
| **Instructions & memory** | Instructions (`CLAUDE.md`), Memory (which projects keep it), Lessons, Rules, Output styles |
| **Extensions** | Plugins, Skills, Agents, Commands, Workflows, Tool presets, each a row with its count and where they come from |
| **Decisions** | Who answers, the cap per decision, the decision points (the Supervisor among them) and a link to every decision |
| **Runs & spend** | Default permission mode, concurrent runs, the daily spend cap, Evals, Machine (a detail: the machine's readings now, a week of their history and each chat's share; see [resource-control.md](resource-control.md)) |
| **Access & safety** | Access (mode, token, read-only), Allowed hosts, Remote access, Secrets, Guards, Terminal, the Audit log, Agent reads |

The sidebar has 11 entries: Connectors is no longer one, it is a section of Connections. The
sidebar and the settings nav are the only two levels of navigation; there are no chips or sub-tabs
inside a group.

## Addresses

- `/settings` opens General on a desktop and the list of groups on a phone.
- `/settings/<group>` is a group's screen. `#<section>` scrolls to a section and focuses its heading,
  for example `/settings/runs#spend-cap` or `/settings/claude-code#sign-in`.
- `/settings/<group>/<detail>` is a detail screen: `/settings/extensions/skills`,
  `/settings/access/audit`, `/settings/decisions/history`. A detail that edits one thing takes its
  own query where it did before (a file path, a resource name).
- An unknown group or detail goes to `/settings`.

The addresses of the old tabs keep working and are replaced on load: `?tab=account` lands on
`/settings/claude-code#sign-in`, `?tab=integrations` on `/settings/connections#code-hosts`,
`?tab=security` on `/settings/access`, `?tab=supervisor` on
`/settings/decisions#point-supervisor-intervene`, `/connectors` on
`/settings/connections#connectors`, and so on. The full map is in the
[plan](plans/settings-ia.md#43-redirects-old-addresses-keep-working) and lives in
`resolveSettingsAddress` (`apps/web/src/pages/config/settingsGroups.ts`); code builds an address with
`settingsHref`, never with a `?tab=` string.

## Search

The field is the first thing in the settings nav, and in the list of groups on a phone. Press `/`
while Settings is open to focus it.

- It matches without caring for case or accents, and every word you type has to start a word of the
  setting's label, its keywords or its consequence line. Label matches come first. It works in the
  language of the interface.
- While the field has text, the results replace the groups: each result names its group, and at most
  12 show. ↑ ↓ move, Enter opens, Escape clears the text.
- Opening a result goes to its group (or detail), scrolls the row into view, puts the focus in it and
  fills it briefly with a lighter background. The fill does not animate when motion is reduced.
- The command palette (Ctrl K) lists the same sections and settings.

## The Supervisor is a decision point

There is no Supervisor screen. When a worker's health turns bad, the Supervisor reads what it did and
proposes a hint; whether it does, and what it does with the hint, is the mode of the
`supervisor.intervene` point in **Decisions**:

| Mode | What happens |
|---|---|
| Off | The Supervisor does not watch, and no hint is asked for |
| Shadow | It proposes hints for you to send. Under Jev the engine also records what it would have decided |
| Active | It sends its hints on its own. Under the Claude Code CLI it sends every hint; under Jev only when the engine expects a hint to help |

Active works under the CLI for this point only: every other act point needs Jev's probabilities to
act, so it stays active in name only under the CLI. The Supervisor uses the engine's CLI model and the
cap per decision; it has no model or cost setting of its own.

`supervisor.json` stays on disk. The first time Claudio starts after the change it is read once to
set the point (disabled → Off, enabled → Shadow, enabled with auto-send → Active, unless you had
already set the point), and it is never written again. `GET` and `PUT /settings/supervisor` still
answer, deprecated, over the point ([REST API](rest-api.md)). The decision records are amended in
[decisions/decision-engine.md](decisions/decision-engine.md).

## The Decisions screen

From top to bottom: **Who answers** (Claude Code CLI or Jev, with the Jev key and, under the CLI,
"Uses your Claude Code quota. Nothing leaves this machine."), **Cap per decision** with what it comes
to a day at today's volume (and how many decisions a day fit in your daily spend cap, when you set
one), **Advanced** (the CLI model and effort, days of history), then the **decision points** by area.
Each point shows its mode and its evidence: how many decisions, how often it agrees with you, how
many disagreements (a link to History filtered by the point). The threshold shows only under Jev,
where it acts. **See every decision** opens History. One save bar saves it all together.

## Changed, Reset and Overridden

A row whose value is a preference with a default shows a small neutral dot and **Changed** when the
value differs from the default, and **Reset** beside it. Reset removes the stored value, so the
control shows the default and follows a later one; the slot hides, focus moves to the row's control
and a polite line says "Restored to the default" (there is no toast). Its tooltip names the default.
The slot keeps its room while nothing is changed, so a row never shifts when it appears.

- **Where it is.** Appearance, Notifications (the kinds), Provider (binary, limits), Lessons, the
  Decisions engine and each point, Runs & spend (permission mode, concurrent runs, daily spend cap,
  Evals), Remote access, Guards (mode, automated, each rule), the Terminal's limits, the account
  rotation on Accounts, and the relay and agent reads on Collaborators.
- **Where it is not.** A value the environment sets (it keeps "set by the environment"), identity,
  credentials, lists, who can reach the server or a shell, actions, status and logs.
- **A form that saves as a whole** (Decisions, the rotation form) takes the default into that field
  at once and keeps your other unsaved edits, so a later Save does not write the old value back.
- **A decision point's Reset keeps its consent.** Withdrawing consent is its own action.
- **Overridden in N projects.** On a global row that a project can override (who answers, a point's
  mode or threshold, the limits, a guard rule), the consequence line ends with "Overridden in N
  projects", a link to the first project's settings; the others are named in its tooltip. The
  projects are sorted by name. A setting that only exists per project (Lessons, Guards in chats) is
  not counted, because the global row of the same name would say something false.

The routes are `GET /settings/state`, `DELETE /settings/state/:setting` and `GET /settings/overrides`
([REST API](rest-api.md)); the contract is explained in [layered-settings.md](layered-settings.md#reset-back-to-the-default).

## A decision point without consent is off

A point that is not Off but has no consent yet runs as nothing: the engine keeps it off until the
person consents. Its row says so ("Off until it has consent.", with the warn icon and the word) and
offers **Review and consent**, which opens the same dialog as moving the point out of Off, in the
point's current mode. This holds for Shadow and Active alike; see [decision-engine.md](decision-engine.md).

## Where the rules for the screen live

How a row is drawn (label, consequence, and the Changed and Reset slot), the group screen, the detail and the search are in the design system: [Settings](design-system.md#settings-groups-rows-details-and-search).

## Related

[[plans/settings-ia.md]] · [[reports/settings-ia-audit.md]] · [[design-system.md]] · [[decisions/decision-engine.md]] · [[decision-engine.md]] · [[rest-api.md]] · [[configuration.md]]
