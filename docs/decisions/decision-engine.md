---
created_at: 2026-09-28T13:40:32.928075489Z
updated_at: 2026-11-13T18:00:00Z
tags:
    - decision
    - decisions
    - jev
    - typesafe
---
# Decision: a decision engine, with Jev as an optional provider

The eighteen decisions the owner took on 2026-09-28 about the decision engine. This record keeps
them as they were taken; the implementation plan that builds them, mapped on `main` after the
project ecosystem landed (#118), is [plans/decision-engine.md](../plans/decision-engine.md). Where
the plan and this record seem to disagree on a decision, this record wins and the plan is fixed.

This file lived at `docs/plans/decision-engine.md` until 2026-09-29 (CW-5), when the plan took that
path and the decisions moved here.

## What Jev is

TypeSafe's jev-1.13, a "System One" model: no text or code, only typed answers to questions over a state: Choice (up to 255 options, probability each), Score (2-10 levels), Noul (probability of yes), each with a confidence. `POST https://api.typesafe.ai/v1/systemone`, Bearer key, SDK `@typesafe-ai/sdk` (Node 20+). $0.042 per million input tokens, output free, 64k tokens per request, 0.1-0.3 s. Optimised for English; zero retention only on enterprise; steerable by injected content, weak at numbers, counting and dates.

## Why optional, with the owner's key

Separate provider and bill; content leaves the machine (no other outside service Claudio calls receives a person's content); the one rule requires Claudio to work in full with the CLI alone; quality must be measured on the owner's data.

## Decisions taken by the owner (2026-09-28)

1. **Engine**: one decision engine, primitives choice / score / noul; providers `cli` (default, a housekeeping CLI chat with `--json-schema`) and `jev` (optional, the owner's key).
2. **Modes** off / shadow / active per decision point, all shipped off. Suggest points vs act points; act points act only when confidence clears the threshold.
3. **Settings layout**: new Settings -> Claudio -> Decisions tab (Engine, Decision points, Supervisor, History) that absorbs the Supervisor tab; **per-project overrides from the start**.
4. **Language**: every technical text in English, Jev questions and rubrics included, and the records agents write. See [[decisions/english-technical-language.md]].
5. **Jev client**: the official SDK (`@typesafe-ai/sdk`) **behind an adapter** of our own.
6. **CLI confidence is `null`**: act points never act on their own with the CLI provider; suggest points work with both.
7. **Supervisor file**: `supervisor.json` stays; only its card moves into the Decisions tab (`?tab=supervisor` still lands there).
8. **Jev per project**: allowed with the one global key while the global provider is the CLI.
9. **History**: 30 days, editable.
10. **Jev unavailable**: fall back to today's behaviour without waiting, record "provider unavailable", the tab warns when it repeats.
11. **Jev version pinned** (jev-1.13.0), with a notice and a suggested shadow period when a new one ships.
12. **Privacy**: consent per decision point with a preview of the exact state of its last request, plus a general notice when saving the key.
13. **Shadow accuracy**: inferred from what happened plus the person's useful / not useful on a decision's mark.
14. **Metrics**: per point in the Decisions tab, plus a line in Usage with Jev's cost and the Claude runs saved.
15. **The "decided · 0.93" mark** only where a decision changed something visible.
16. **CONTRIBUTING.md**: a bounded exception to the one rule for typed decision services.
17. **Scope: one delivery, every point.** No v1 / v2 / later split: all the decision points below are built together. The order below only sequences the work inside that delivery. Every point still ships off.
18. **No voice point.** The voice-actions plan (a Siri shortcut dictating an objective) was discarded by the owner, so there is no `voice.intent`; natural-language intent routing lives only in the command palette.

### Amendments

- **D3, amended 2026-10-17.** The Decisions screen no longer has the chips (Engine, Decision points,
  Supervisor, History): the engine heads the screen, History opens from each point's disagreements and
  from one "See every decision" link, and the Supervisor section is gone (see D7). Decisions is now a
  group of Settings in its own right (`/settings/decisions`), no longer a tab under Claudio. Per-project
  overrides are unchanged. Original text above kept. See [the plan](../plans/settings-ia.md#7-decisions-and-the-supervisor-folded-into-its-point).
- **D7, amended 2026-10-17.** `supervisor.json` stays on disk, but the Supervisor no longer has a card
  or a switch of its own: it is the `supervisor.intervene` decision point. Off, Shadow and Active
  replace `enabled` and `autoSend`; its model and cost are the engine's; Active also works under the CLI
  for this point only; a one-time migration reads the file and the file is never written again.
  `?tab=supervisor` lands on `/settings/decisions#point-supervisor-intervene`. Original text above
  kept. See [the plan](../plans/settings-ia.md#72-the-supervisor-as-supervisorintervene).
- **Amendments of 2026-11-13: the second plan.** A review of the owner's install found that the
  engine had no way to tell whether a point helped and no brake on one that did not
  ([plans/decision-engine-v2.md](../plans/decision-engine-v2.md)). The owner took the recommended
  option of each decision of that plan (its section 9, here "plan D1" to "plan D8"), except plan D8,
  which has its own answer. Original text above kept.
  - **Plan D1, the promotion gate.** Moving an act point to `active`, or a suggest point whose answer
    starts a run (`lesson.mine`), is refused until its evidence clears a gate; other suggest points
    are switched with a warning. This amends decision 2 above (modes: act points act only when
    confidence clears the threshold): a point earns `active`, and a switch alone no longer does it.
    No bulk activation.
  - **Plan D2, demotion.** An active point whose evidence goes, or whose act or flag rate leaves its band,
    is moved back to shadow by the engine, which records why and tells the person. Nothing promotes
    by itself.
  - **Plan D3, the holdout.** An active act point withholds 10 % of the acts it would take for its first
    100, then 5 %, so it is judged on cases it did not shape.
  - **Plan D4, continuations.** At most one decision-driven continuation per run, and none after a
    continuation that changed nothing; the code holds this whatever the decision answers.
  - **Plan D5, provider per point.** Decided from the replay comparison's numbers: stay on Jev where
    it wins, on the CLI's `haiku` where it does not. The one comparison run, for `run.continuation`,
    put no arm above the base rate; the engine has no provider per point (the provider is global, or a
    project's override), and none was added.
  - **Plan D6, points with no possible evidence.** Listed as such, left `off` by default, none
    removed. The listing itself is not built.
  - **Plan D7, stored cost figures.** The executions of chats whose totals only grow are recomputed;
    the spend ledger is left as it is, and a row dates the fix. This amends decision 14 above
    (metrics): the Usage line shows the net of runs, not "Claude runs saved".
  - **Plan D8, no design round in this run.** Only the minimum UI, from existing components: a point's
    standing and evidence on its row, the gate's refusal, the demotion notice and the net effect. The
    feedback surfaces of the plan's section 7 are not built.
  - **Privacy wording (decisions 12 and 16 above).** The record said Jev takes "no text or code". What is true: Jev
    writes no text or code, and receives the declared state after consent, which for many points is
    text or code (a hunk, the before and after of a test edit, the end of a report, error text).
    [decision-engine.md](../decision-engine.md#what-leaves-the-machine) lists it per point.
  - **Verification.** By the owner's choice, from the second wave of the build no task ran the test,
    `ci-checks` or e2e gates; each merge ran only lint and typecheck. The whole verification and a QA
    pass are done by the owner and the orchestrating session before the pull request.

## Decision points (all in the one delivery, in build order)

Order criteria: Claude quota saved, quality, how cleanly shadow can measure it, effort, risk.

**First, with an outcome signal already stored:**

The table below is the record as it was written on 2026-09-28, against the ecosystem branch. Its
line numbers are stale on `main`; the plan's [decision points](../plans/decision-engine.md#decision-points-on-main)
re-map every point, with file and function on `main`.

| Point | Kind | Scope | Where (ecosystem branch) | Outcome signal |
| --- | --- | --- | --- | --- |
| `flow.refine-needed` | act | P | `flow.ts` refine stage, before launch | card later bounced or edited by the person |
| `flow.bounce` | act | P | `flow.ts:805` (fixed `maxBounces` today) | next QA verdict |
| `orchestration.retry` | act | P | `orchestrator.ts` `settle` | the retry's result |
| `supervisor.intervene` | act | G | `supervisor.ts` | hint sent or discarded |
| `memory.triage` | suggest | P | `memory-proposals.ts` | approve / reject rows |
| `assistant.rerank` | suggest | P | `assistant.ts` proposals | accept / discard rows |

**Then:** `journal.relevance` (today `journal.ts` hands the newest entries up to 16 KB, so old decisions fall off), `board.triage` (live suggestions while typing), scope-drift check per commit, acceptance-criteria pre-check before QA, semantic loop detection (health.ts only catches exact repeats), `health.test-weakening` (content written by the agent it judges: injection risk, suggest only until shadow data says otherwise), `orchestration.model` (suggest only, in the draft plan).

**Also in the same delivery:** unexplained hunks in changes review (DiffView), natural-language command palette intent routing, `team.assign`, notification urgency.

## After the ecosystem merged (#118)

The record said, at the time: write the English rule into CONTRIBUTING.md and CLAUDE.md and apply it
to the ecosystem prompts; map every decision point again on main and add any new ones; write the
plan from scratch as one delivery split into orchestrations landing on one feature branch; then
prototypes. As of 2026-09-30:

- the plan is written: [plans/decision-engine.md](../plans/decision-engine.md) (CW-5);
- the bounded exception of decision 16 is in CONTRIBUTING.md under "The one rule" (added on
  2026-09-30 with CW-5's pull request; text in the plan's
  [Amendment to CONTRIBUTING.md](../plans/decision-engine.md#amendment-to-contributingmd));
- the English rule of decision 4 is written into CONTRIBUTING.md and CLAUDE.md by its own work item
  (CW-2), not here.

## Related

[[plans/decision-engine.md]] · [[plans/decision-engine-v2.md]] · [[decision-engine.md]] · [[plans/project-ecosystem.md]] · [[plans/agent-observability.md]] · [[decisions/english-technical-language.md]]
