---
created_at: 2026-10-17T12:30:00Z
updated_at: 2026-10-17T12:30:00Z
tags:
    - report
    - settings
    - information-architecture
    - decisions
    - design-system
---
# Settings and navigation: information-architecture audit

The first `/ui-audit` of the `claudio-ui` skill ([plans/claudio-designer.md](../plans/claudio-designer.md)),
run read-only on `feat/claudio-designer` on 2026-10-17, and the owner's decisions on it. Nothing here
is built yet: the redesign gets its own plan, with the design settled before any code.

## Findings

- **23 settings tabs** in 4 groups; **3 levels of navigation** on a desktop (sidebar → settings nav →
  section chips, plus folds) and 4 on a phone. The manifesto asks for 2.
- About 44 scalar settings across the tabs, 72 per-point controls in Decisions (29 modes, 14
  thresholds, 29 consents), 13 resource or file tabs, and 12 sidebar entries of which 4 are
  configuration-like (Accounts, Connectors, Usage, Settings).
- **No setting is dead in code** (each has a reader in core), but two are dead in practice: with the
  default CLI provider the 14 thresholds have no effect (`packages/core/src/decisions/engine.ts`
  acts only on `active`, which CLI forbids), and the Jev rows show while CLI is selected (AP2, AP3).
- Decisions under CLI shows 12 scalar settings and 4 save models on one tab; ≈ 2,400 px of scroll
  with the groups folded (≈ 3.6 screens at 1280 × 800), ≈ 4,500 px with them open (estimated from
  the CSS row sizes, not measured).
- Duplicates: a "Settings" tab inside the Settings page; "Provider" meaning the agent in Providers
  and CLI-or-Jev in Decisions; the Claude Code sign-in panel in both Account and Providers; three
  model + cost pairs (Decisions, Supervisor, the flow's `maxCostUsd`); the Supervisor as a section
  and as the `supervisor.intervene` point; the Account tab against the Accounts page.
- Security holds five settings that are run behaviour and cost, not access: default permission mode,
  concurrent runs, daily spend cap, evals phase 2 (`AppSettingsCards`).
- Stale comments: "Twenty-two tabs" (there are 23) and "Twenty-two points in nine groups" (29 in
  10); the `points.areas.providers` key is unused.

## Diagnosis of the Decisions tab

| Setting | Label | Why |
|---|---|---|
| Provider | keep primary | the one real decision; its hint becomes a live consequence |
| Jev key | defer | asked inline when Jev is picked |
| Jev model, "Pinned" | demote to hint | attached to the Jev option |
| Privacy box | remove (AP7) | the consent dialog already shows the payload |
| Cost limit per request | translate (AP4) | it needs a consequence |
| CLI model, CLI effort, history kept | fold into Advanced | the defaults are right for 95 % |
| Thresholds ×14 | fold, shown only under Jev | no effect under CLI |
| Consent ×29 | demote to hint | only on points that are not off, in the evidence line |
| Point mode ×29 | keep primary, as evidence rows | manifesto §2 |
| Supervisor enabled, model, cost | remove, merged into `supervisor.intervene` | one behaviour behind two switches |
| Supervisor auto-send | keep, as the point's Active meaning | |
| Engine / Points / Supervisor / History chips | remove (AP5) | |

## Decisions (owner, 2026-10-17)

1. **Eight groups and settings search** replace the 23 tabs: General · Claude Code · Connections ·
   Instructions & memory · Extensions · Decisions · Runs & spend · Access & safety. Two levels of
   navigation; Security splits into Access & safety and Runs & spend; the Account tab goes (updates
   and the CLI version to General, the sign-in panel to Claude Code only); Memory becomes a line in
   Instructions & memory.
2. **The Supervisor folds into the `supervisor.intervene` point**, its model and cost inherited from
   the engine; `supervisor.json` stays on disk. This changes decision record D7, which kept it as a
   section.
3. **The Decisions chips go** (AP5): the engine heads the screen, History opens from each point's
   metrics and from one link. This changes decision record D3.
4. **Connectors moves into Settings → Connections** with the code hosts, trackers, webhooks and MCP
   servers; the sidebar goes from 12 entries to 11.
5. **The privacy box goes** (AP7): one consequence line under the provider and a "See an example
   payload" link.
6. **Thresholds show only under Jev**, where they act.
7. **The cost cap's consequence** is "≈ $X a day at today's volume", from the history; with a daily
   cap set it adds "≈ N decisions a day within your cap".
8. **Renames:** the Claude Code "Settings" tab becomes "Behaviour (`settings.json`)", and the
   Decisions "Provider" becomes "Who answers" / "Quién responde". The daily spend cap moves to Runs &
   spend, referenced from Decisions and Usage.

## Notes for design (not developed)

AP1: the Engine rows all weigh the same. AP11: every Security card has a border. The Beta tag shows
twice under CLI. The references to check are `docs/design-system/reference/DesktopAjustesDecisiones*.html`.

## Related

- [[plans/claudio-designer]]
- [[plans/decision-engine]]
- [[design-system]]
