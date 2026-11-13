---
created_at: 2026-09-30T18:00:00Z
updated_at: 2026-11-13T21:00:00Z
tags:
    - decisions
    - decision-engine
    - jev
    - typesafe
    - settings
    - privacy
    - shadow
    - checks
    - evidence
    - lifecycle
    - replay
---
# The decision engine

Claudio makes many small judgments: whether a card needs refining, whether a failed task is worth a
retry, whether a run that ended on a report owes more work, which journal entries an agent reads.
Each used to be a fixed rule, a paid Claude run or a person. The **decision engine** gives them one
home in `packages/core/src/decisions/`: a decision point puts typed questions to a provider and
runs today's behaviour whenever the answer is missing, late or not sure enough.

Everything ships **off**. A fresh install behaves exactly as before and sends nothing anywhere. The
owner's eighteen decisions, with their amendments, are in
[decisions/decision-engine.md](decisions/decision-engine.md), the plan that built it is
[plans/decision-engine.md](plans/decision-engine.md), the second plan, which made a point prove
itself before it may act, is [plans/decision-engine-v2.md](plans/decision-engine-v2.md), and this page
describes what the code does now.

The rule that runs through the page: **a point earns `active`**. Every row records what today's code
rule did for the same input (its [baseline](#evidence)), a resolver reads an effect the decision
could not fake, and only a point whose evidence clears its [gate](#standing-and-the-promotion-gate)
may act. A switch alone no longer moves a point to `active`.

## Questions and answers

There are three question types, named as TypeSafe names them:

- **choice**: pick one of 2 to 255 options;
- **score**: pick a level of a rubric of 2 to 10 levels, lowest first;
- **noul**: yes or no.

Every answer is a value plus a confidence in [0, 1] (`null` when the provider has none). Every
question and rubric is English ([decisions/english-technical-language.md](decisions/english-technical-language.md)).
A point batches all its questions into one provider call.

## Providers

| | `cli` (default) | `jev` (optional) |
| --- | --- | --- |
| What it is | Claude Code through its CLI | TypeSafe's Jev, an outside service that only answers typed questions |
| How | One housekeeping chat per batch, one turn, `--json-schema` (an enum per choice or score, a boolean per noul) | `@typesafe-ai/sdk`, behind one adapter file (`providers/jev.ts`) |
| Model | `haiku` at effort `low` by default, `--max-budget-usd` 0.02 | pinned to `jev-1.13.0`; it never upgrades by itself |
| Confidence | always `null`, so it never clears a threshold | calibrated, per answer |
| Deadline | 30 s | 1.5 s, one retry with backoff on 429 or 529 |
| Leaves the machine | nothing beyond what Claude Code already sends | the point's declared state, to TypeSafe: see [What leaves the machine](#what-leaves-the-machine) |
| Key | none | the owner's, in `decision-credentials.json` (mode 0600), never returned by the API |

The `cli` provider is inside the [one rule](../CONTRIBUTING.md): it is the Claude Code CLI and
nothing else. Its chat is `internal` (no transcript, hidden, never supervised), has no tool and no
settings file (`confine`), and gets no `CLAUDIO_API_URL` or `CLAUDIO_API_TOKEN` (`NewChat.api:
false`), so it can never call back. Its prompt follows the shared rules of [prompts.md](prompts.md):
the state sits in one `pasted()` block followed by `PASTED_NOTE`, there is no reason field, and a
Sonnet model is told to think the problem through. A result without a readable structured answer is
`invalid-answer`; a stop on `max_tokens` is `max-tokens` even when the JSON parses; a rate-limited
turn is `rate-limited` at once, with no rotation and no resume.

Jev is the one bounded exception to the one rule ("typed decision services" in CONTRIBUTING.md):
off by default, the owner's key, it writes no text or code and makes no call to Anthropic, it
receives only the state a point declares, after consent, and Claudio works in full with `cli` alone.
That state can hold text and code (a hunk, the before and after of a test edit, the end of a
report, error text); [What leaves the machine](#what-leaves-the-machine) lists it per point. Nothing
falls back from `jev` to `cli`: a paid, slow run in place of a 0.2 s call would be a silent change
of cost.

**Provider unavailable.** A provider that cannot answer (`no-key`, `timeout`, `rate-limited`,
`no-quota`, `max-tokens`, `server-error`, `network`, `invalid-answer`) makes `ask` return `act:
false`, so the caller runs today's behaviour at once. The row is written as `unavailable` with the
reason. A decision never waits for quota and never blocks a run. The tab warns ("Provider
unavailable") when three or more requests of one provider failed in the last hour.

## Modes

Each point has a mode, set globally and overridable per project for the points of project scope:

- **off**: nothing is asked.
- **shadow**: the engine asks and records; today's behaviour decides and nothing visible changes.
- **active**: a **suggest** point prepares something a person then decides (a sort, a prefill, a
  flag) and works with either provider; it shows a suggestion only at or above its
  [floor](#the-suggestion-floor) when the provider gives a confidence. An **act** point changes what
  happens only when `confidence >= threshold` (default 0.85, 0.5 to 0.99). A `null` confidence never
  clears it, so the UI does not offer `active` on an act point whose provider is `cli`; if the
  provider turns to `cli` later, the point behaves as shadow. The one exception is
  `supervisor.intervene`: under `cli` it may be `active`, and then the Supervisor sends hints on its
  own for the signal kinds the owner listed ([Settings](settings.md#the-supervisor-is-a-decision-point),
  [below](#the-supervisor)).

Being `active` in the settings is not the same as acting. The engine reports why a point that is not
`off` does not do what its mode says (`limitedBy`): `no-consent`, `cli` (an act point on the CLI, or
the palette off Jev), `unproven` or `failing` (a gated point whose [standing](#standing-and-the-promotion-gate)
is not `proven`) or `demoted` (the engine moved the point back to shadow and a project override still
sets it active). Such a point asks and records as shadow, and its rows are evidence like any shadow
row. An act point that does act also holds back a random share of its acts
([the holdout](#probation-the-holdout)).

Effective settings resolve as project override, then global, then the point's default. Consent is
always global.

## The points

Twenty-nine points: 14 act and 15 suggest. **Suggest** points never change what happens by
themselves. `PUT /decisions/settings` refuses to switch a point to `active` while its standing is
not `proven` for every act point and for `lesson.mine`, which starts a paid miner run; the other
suggest points are switched with a warning ([below](#standing-and-the-promotion-gate)).

| Area | Point | Kind | Scope | What it decides |
| --- | --- | --- | --- | --- |
| Project flow | `flow.refine-needed` | act | P | Skip the refine run when the card is ready as written |
| | `flow.bounce` | act | P | After QA rejects: fixable (bounce back) or needs a person |
| | `flow.criteria-precheck` | act | P | Send a card back before QA when a criterion is clearly unmet; it never passes a card |
| | `flow.criteria-merge` | suggest | P | Flag proposed criteria that duplicate existing ones |
| | `flow.restart` | act | P | Requeue a run cut by a restart, or not |
| | `context.compact` | act | P | Compact the Developer's own conversation before it takes a card back after a bounce, when it is already full ([plans/context-control.md](plans/context-control.md)). Off like every point: nothing in the code or the defaults turns it on |
| | `flow.scope-drift` | suggest | P | Flag a commit that drifts from the card |
| | `team.assign` | suggest | P | Propose the member for a card |
| Board | `board.triage` | suggest | P | Prefill type, priority and a duplicate warning while typing a task |
| Memory | `memory.triage` | suggest | P | Score memory proposals so the best come first |
| | `lesson.mine` | suggest | P | Whether a stretch of chat holds a lesson worth asking a miner for ([lessons.md](lessons.md)) |
| | `journal.relevance` | act | P | Reorder the journal entries an agent reads; code still applies the byte budget |
| Assistant | `assistant.rerank` | suggest | P | Order the project assistant's proposals |
| | `assistant.sources` | act | P | Which files the assistant reads first |
| Orchestrations | `orchestration.retry` | act | P | Retry a failed task in the same chat, or not |
| | `orchestration.model` | suggest | P | A model per task in the draft plan |
| | `orchestration.fixer` | act | P | Stop asking the fixer when more attempts will not help |
| | `review.depth` | act | P | How deep the review gate goes on a branch: `light` or `full` (never skip) |
| | `run.continuation` | act | P | Whether a run that ended on a report owes work of its own: `done`, `hands-off` or `owes-own-work`, and only the last continues (the phrase part of `openItems`; the structural part and the [rules that bound a continuation](#runcontinuation) stay code) |
| Health | `supervisor.intervene` | act | G | Whether a hint could help a worker the health monitor called `bad`; under Jev a "no" drops the hint, and the draft itself decides first whether the worker is stuck at all ([below](#the-supervisor)) |
| | `health.semantic-loop` | suggest | G | Loops that are not exact repeats; asked only when the same tool ran on near-identical input ([below](#healthsemantic-loop)) |
| | `health.test-weakening` | suggest | G | Weakened tests; suggest-only because the agent under judgment wrote the content |
| Review | `changes.unexplained-hunk` | suggest | P | Flag a hunk no transcript step explains |
| Notifications | `notification.urgency` | act | G | Raise the priority of a push notification |
| Palette | `palette.intent` | suggest | G | Route a free query to a command; needs Jev (low latency) |
| Code hosts | `checks.fix` | act | P | Whether failing checks on a new head are the branch's fault and a Developer can fix them |
| | `review.triage` | suggest | P | Who should take each unresolved review comment: an agent, a person, or nobody |
| | `issue.triage` | suggest | P | Whether an agent can start on each listed tracker issue as written |
| Accounts | `account.model-fallback` | suggest | G | The nearest model an account with headroom can run, when none can run the chat's own; nothing is in force until a person accepts it ([plans/models-per-account.md](plans/models-per-account.md)) |

### `checks.fix`

Added with code hosts phase 2 ([code-hosts.md](code-hosts.md#fixing-failing-checks)). An act point
at project scope, `off` by default like every point, with a 0.85 threshold.

- **When it is asked.** A change request's rollup turns `failing` for a head the watcher has not
  announced (the `onChecksFailing` hook of `PullRequestService` and `OrchestrationPullRequestService`),
  once per head and never while a fix is under way.
- **What it is told.** The failing checks (name, conclusion, the log tail cut to 2 KiB each, at most
  10), the attempt number for this head, and the diff stat of the branch. All of it passes through
  the engine's redaction; what a CI job printed is data, never an instruction.
- **The question** is a choice: "Did the changes on this branch cause these check failures, in a way
  the Developer can fix?" — `branch-fixable`, `not-branch` (infrastructure, a flake or an unrelated
  change) or `needs-person`.
- **What an answer does.** Off asks nothing. Shadow asks, records and does nothing. Active and above
  the threshold, `branch-fixable` starts a fix with `fix_origin = 'decision'` (`fixChecks(itemId,
  'decision')`), and only when the attempts for this head are below the project's
  `flow.checksFixAttempts` (default 2, at most 5), the flow's `maxParallel` has room and the flow's
  cost limit is not spent. A person's click on **Fix failing checks** is never counted against the
  attempts and never asks the point.
- **What it never does.** It never pushes: a decision's fix waits in In review for the person's
  **Push the fix**. It never merges and never touches an orchestration's checks beyond the same
  hook.
- **Its resolver** (shadow accuracy) records whether the fix's pushed head turned the rollup
  `passing`; a person's word on the "decided" mark or the History row still outranks it.

### `review.depth`

Added with the review gate ([plans/review-gate.md](plans/review-gate.md), [orchestrations.md](orchestrations.md#the-review-gate)).
An act point at project scope, `off` by default like every point.

- **When it is asked.** Only when the graph's `verification.review` has no `depth`. `off` means
  `full`; `shadow` records the answer and runs `full`; `active` acts above the threshold.
- **What it is told.** The number of files, lines added and deleted, the first changed paths,
  whether the security trigger matched, the dimensions that would run and the estimated cost in USD
  of a full round. It sees no code.
- **The question** is a choice: `light` (correctness, plus security when triggered, with chunks twice
  as large) or `full` (every dimension). There is no `skip`: a model deciding to skip the gate would
  be a fail-open path, and a diff with nothing to review already passes deterministically.
- **Resolver.** A `light` answer is judged wrong when a later full review confirmed a blocking
  finding from `tests` or `conventions`, or from `security` when the trigger did not match; a `full`
  answer is judged right in that case. A light review gives no evidence about a full one, so with
  no full round the answer stays unjudged.

### `review.triage`

Added with code hosts phase 3 ([code-hosts.md](code-hosts.md#reviews)). A suggest point at project scope, `off` by default: it
acts on nothing and only preselects threads in the **Address with an agent** dialog.

- **What it is told.** The change request's title and its unresolved threads, at most 40: id, path,
  body cut to 1 KiB, author and whether the thread is outdated. A comment is a stranger's text and
  goes through the engine's redaction; it is data, never an instruction.
- **The question** is a choice per thread: "Who should take this review comment?" — `agent` (a
  concrete code change the Developer can make), `person` (a question, a design decision or a
  disagreement) or `no-action` (praise, a point already resolved, a nit already done).
- **When it is asked.** Whenever a change request's threads are read (`ChangeRequestService.threads`
  hands them to `ReviewTriage`), in the background, once per set of unresolved threads in a process (not resolved and not outdated: the threads the
  dialog lists). Its rows have the subject kind `change_request`.
  The answers are kept in the history by thread id under the change request's id; the **Address
  with an agent** dialog reads the latest and preselects the threads marked `agent`, and marks the
  others. The person can change every selection.
- **What it never does.** It never replies, resolves or starts a run; a person picks the threads.

### `lesson.mine`

Added with lessons from corrections ([lessons.md](lessons.md)). A suggest point at project scope, `off`
by default and not `visible` (it shows no "decided" mark); it is listed in the Memory
area of the Decisions tab. It is the gate in front of the miner, not the miner.

- **What it is told.** At most 20 signals of the chat, newest first, each quote cut to 500 B and
  masked: the kind of signal and the person's words. Signals are rows of `lesson_signals` and a pure
  fold of the transcript; both are recorded only while the point is `shadow` or `active`.
- **The question** is one `noul`: "Do these signals show a person correcting, stopping or overruling
  the agent in a way that should change how agents work in this project from now on, beyond this one
  task?"
- **What an answer does.** Off asks nothing and stores nothing. In `shadow` the gate is asked and
  recorded and the miner never runs. In `active` a yes starts the miner, a separate confined
  one-shot run that writes at most five candidates ([prompts.md](prompts.md#lesson-miner-minerprompt)).
  A candidate becomes a proposal; nothing is delivered before a person approves it.
- **What it never does.** The decision engine answers only typed questions, so it never writes a
  lesson. A person's "Look for lessons" click skips the gate and works while the point is `off`.
- **Cost.** One question per job, under the provider's own cap; the miner has its own 0.05 USD cap
  per run, 0.25 USD a day per project and 1 USD a day in total.

### `issue.triage`

Added with code hosts phase 5 ([code-hosts.md](code-hosts.md), [trackers.md](trackers.md#issuetriage)). A suggest point at project scope,
`off` by default: it imports, moves and writes nothing, and only marks issues.

- **What it is told.** The tracker and one page of the import list, at most 40 issues that are not
  yet imported: key, title, body cut to 2 KiB and labels. An issue is a stranger's text and goes
  through the engine's redaction; it is data, never an instruction.
- **The question** is a choice per issue: "Can an agent start on this issue as written?" — `ready`,
  `needs-refining` (the goal or the acceptance is unclear) or `not-for-agents` (it needs a person:
  access, a decision, work outside the repository).
- **When it is asked.** Whenever `TrackerImportService.list` serves a page, in the background and
  once per page in a process; the page does not wait. Its rows have the subject kind
  `tracker_issue` and the subject id `<project id>:<tracker id>`, with the answers keyed by the
  issue's key.
- **Where it shows.** The list reads the newest answer per key back into `TrackerIssue.triage`, so
  the import dialog marks the issues on the next read. Marks on the imported cards read the same
  rows through `GET /decisions`.

### `run.continuation`

A run that ends on a report may be sent back to its chat once more. Three causes send it, recorded
per continuation as `cause` (`ContinuationEffect`, in the task's `continuationEffects` and on a flow
run's `continuation_effects` column): `structural` (a fact the code reads: no structured result, uncommitted
paths, delegated work still running), `phrase` (the phrase list of `open-items.ts` matched the last paragraph) and
`decision` (this point read a step of the run's own task as owed and no phrase caught it). When the
turn that continuation started ends, core records its effect: whether it committed, edited or
delegated anything (`changed`, `commits`, `edits`). When a decision-driven continuation changes
nothing, the report before it stays the task's result, with its one-line answer after it.

- **Three answers**, state version 2 (consent is asked again): `done` (finished work; caveats and
  checks it says it did not run count as done), `hands-off` (something is left to another task, a
  reviewer or the person) and `owes-own-work` (it announces a step of its own task and has not taken
  it). Only `owes-own-work` continues; the id `owes-work` of state version 1 is still read in old
  rows. The state is the task's name, the head of what it was asked to deliver, the end of its last
  message, how many continuations it has had, whether the phrase list matched and what its turn
  committed and edited.
- **Code rules that hold whatever it answers** (`decisionMayContinue`, `continuationPlan` in
  `packages/core/src/open-items.ts`): at most one decision-driven continuation per run, none after a
  continuation that changed nothing, and every continuation sent so far must be on record; a
  continuation whose effect is unknown is never followed by a decision's. A `done` or `hands-off`
  that acted waives the phrase list; an `owes-own-work` adds a continuation only when the phrase list
  matched nothing, and what it sends is one sentence ("if nothing of your task is owed, say so in
  one line and stop"), not an order. Structural and phrase continuations keep `MAX_CONTINUATIONS`
  (3), and a structural one is never held back. The point is not asked where its answer could change
  nothing.
- **Baseline and resolver.** The baseline is the phrase list's items. The resolver reads only the
  recorded effect of the continuation that followed the row: `owes-own-work` is right when that
  continuation changed something, `done` or `hands-off` when it changed nothing. With no
  continuation after the row there is nothing to read and the row stays unresolved, `done` included.
- **Where it stands.** On the owner's labelled rows no arm, the phrase list's own, the old question
  or the three answers, on Jev or on the CLI's `haiku`, chose better than the base rate (the table is
  in [the plan](plans/decision-engine-v2.md#10-spikes-before-building)). The point ships for whoever
  wants to measure it in shadow; the gate decides whether it ever acts.

### `health.semantic-loop`

Asked only when a cheap rule finds repetition worth judging, state version 2 (consent asked again):
at least 8 finished calls in the chat's last 12 (bookkeeping tools aside), the same tool on
near-identical input at least 3 times among them, and the exact loop rule of `health.ts` has not
already fired. The same repetition is never asked twice. What identifies it is the repeated group
(agent, tool and normalised input) with a count bucket (3 to 5 repeats, 6 to 11, 12 and more), not the
window around it, which changes with every new call; the chat keeps every repetition it has put, so
one that leaves the window and comes back is still the one that was asked, while a repetition that
grows into the next bucket is asked about again. A chat that got "no" three times in a row is asked
again only after 40 more calls, or at once after a "yes". The state is each call's
tool name, a digest of its input and its target (a path, pattern, URL or query, or a command's first
word, at most 80 characters): never an input or a result. The baseline is "no flag". Its resolver
is `direct` only from a person's action on the chat after the flag (a stop, an interrupt, a hint, a
cancelled command, or a Supervisor hint they sent); a Supervisor hint that went out on its own no
longer counts.

### Other points the second plan changed

- **`changes.unexplained-hunk`** is not asked about a hunk that has no sentence before it: that case is
  unexplained by construction and is the code's answer. It has the suggestion floor and a baseline
  of "no flag".
- **`lesson.mine`** is gated like an act point because a "yes" starts a paid run. A miner that
  proposes nothing is a `direct` "wrong" for it.
- **The baseline** comes from the call site. The flow, the orchestrator, the health and changes
  points, `lesson.mine` and the Supervisor pass what their code rule did; `checks.fix`,
  `notification.urgency`, `memory.triage`, `board.triage`, `assistant.rerank`, `assistant.sources`,
  `journal.relevance`, `palette.intent`, `account.model-fallback`, `review.triage`, `issue.triage`
  and `flow.scope-drift` do not yet, so their rows have a `null` baseline and no comparison.

Not decided by the engine, by design: anything that grants (tool permissions, the move to `done`,
QA's final verdict, `verifyAuth`, a security mode) and plain arithmetic (usage bars, cost caps, a
provider's headroom and reset, the candidate filters). The provider points only choose among the
feasible options the person allowed: the arithmetic stays code. Jev never generates text, code or prompts.

Each point lives in the catalogue (`decisions/points.ts`): its kind, scope, threshold, break-even,
state fields, byte limit, state version, `visible`, questions and its **effect**: which answer acts
or flags, how to read the code rule's baseline, and whether acting saves or causes a run
(`savesRun`, `causesRun`). Call sites take a `stanceOf` (`off`, `watch` for shadow or a limited
active, `wait` for an active point that can act), so a point that is off costs nothing.

## Evidence

A point proves itself on what its rows say about outcomes it did not cause. Four pieces make that
readable, all in `packages/core/src/decisions/`.

- **The baseline.** `decisions.baseline` (JSON) is what today's code rule answered for the same
  input, passed by the call site as `ask(point, subject, { projectId, baseline })`: the phrase
  list's items for `run.continuation`, `"retry"` for `orchestration.retry`, `false` ("no flag") for
  most suggest points. Stats then say, per point, how often the decision differed from the baseline
  and who was right when it did. A point that never differs is not worth its calls. Rows from
  before the column, and points whose call site passes none, have a `null` baseline.
- **Outcome quality.** Every resolver says how far its outcome can be trusted. `direct`: an effect the
  decision could not have caused to look right (a person's action, a retry's result, what a
  continuation changed, a rollup that turned green). `proxy`: correlated but contaminated (a later QA
  verdict, or the result of something the decision itself set in motion). A row with no quality is
  `proxy`. Only `direct` outcomes, and a person's own word (useful or not useful), count as
  evidence. The resolvers that are `direct`: `flow.restart`, `orchestration.retry`,
  `orchestration.fixer`, `run.continuation`, `lesson.mine`, `palette.intent`,
  `memory.triage`, `assistant.rerank`, `account.model-fallback`, `health.semantic-loop` (only from a
  person's action on the chat). The ones that are `proxy`: `flow.criteria-precheck`,
  `review.depth`, `orchestration.model`, `journal.relevance`, `flow.scope-drift`,
  `health.test-weakening` and `changes.unexplained-hunk` (QA's verdict on the card). Ten are
  either, row by row: a person's own edit, a shadow row or a held-out one is `direct`, and a QA
  verdict after the point acted is `proxy` (`flow.refine-needed`, `flow.bounce`,
  `flow.criteria-merge`, `team.assign`, `context.compact`, `assistant.sources`, `board.triage`,
  `checks.fix`, `supervisor.intervene`, `notification.urgency`). Two of them grade what their own act
  caused, so a row that acted never counts as `direct`: `flow.bounce` (an acted "needs a person" parked
  the card itself, and a person then moving it is what parking asks for) and `notification.urgency`
  (an acted answer set the push's priority, and a raised push is the one that gets opened). A shadow
  or held-out row of either reads as today's behaviour did, and stays `direct`.
  `review.triage` and `issue.triage` have no resolver.
- **Which points can ever be proven by what the app sees.** `DIRECT_OUTCOMES` (`resolve.ts`) says, per
  resolver, whether it can ever return `direct`, and `GET /decisions/points` serves it as
  `evidencePossible`. It is `false` for the nine points that cannot: the seven whose resolver is only
  ever `proxy` (`flow.criteria-precheck`, `review.depth`, `orchestration.model`, `journal.relevance`,
  `flow.scope-drift`, `health.test-weakening`, `changes.unexplained-hunk`) and the two with no
  resolver (`review.triage`, `issue.triage`). For them nothing but a person's own useful or not useful
  (always `direct`) is evidence, so Settings says that instead of asking for cases that cannot arrive.
  A test reads each resolver's source against the table, so the two move together.
- **Run effect and net runs.** Acting changes how many agent runs happen against today's behaviour.
  `decisions.run_effect` is `+1` for a run the decision saved, `-1` for one it caused and `0`
  otherwise, written with the row. A point's definition reads it against the baseline when the row
  has one: a `done` saves a continuation only where the phrase list would have sent one, and an
  `owes-own-work` costs a run only where it is not one the phrase list would have sent anyway.
  `GET /decisions/stats` answers `runsSaved`, `runsCaused` and their net per point and in total, and
  the Usage line shows the net with what it is made of. The "Claude runs saved" counter is gone:
  `claudeRunsSaved` stays in the answer as a deprecated alias of `runsSaved` and nothing reads it.
  The cost in tokens of the runs a decision caused is not summed.
- **The evidence function.** `pointEvidence(point, rows)` and `scoreEvidence(cases)`
  (`evidence.ts`) turn the answered rows of a window into: how many rows resolved `direct`, `proxy`
  or not at all; the **precision** of the answer that acts (act points) or flags (suggest points)
  with its one-sided 90 % Wilson lower bound; the same for the code rule's baseline; the baseline
  comparison (rows, where the decision differed, who was right, how many are still unresolved);
  **calibration** buckets of confidence against observed accuracy (edges 0, 0.5, 0.6, 0.7, 0.8, 0.9,
  0.95 and 1, with exactly 1.00 a bucket of its own because Jev's confidence piles up there); and
  the act or flag rate. A row's answer is a case only if the point's definition can say whether it
  acts (a ranking cannot). The calibration table is reported, not used: a point's threshold is the
  owner's setting.

## Standing and the promotion gate

`standingOf` (`standing.ts`) puts every point in one of three standings, shown on its row and served
by `GET /decisions/points`. Standing is computed, never stored: from the window's `direct` outcomes
(the last `historyDays`) and from the latest [replay](#labels-and-replays) of the point that counts.
The engine caches it for a minute and drops the cache when an outcome or a settings write lands.

**Live evidence decides, a replay only bootstraps.** Once the live history has the gate's `minCases`
scored cases it alone settles the standing, so a point that proved itself on stored states and then
goes wrong live is `failing`, and can be demoted. Below that count a replay that has the cases may
decide, to prove the point or to fail it. `decidedBy` (`live`, `replay`, or `null` while unproven)
says which reading settled it, and the row says it too.

**A replay counts only for what the point runs on.** It must have run under the questions in force,
on the provider the point runs on install-wide (a project's own provider does not change its
standing) and, for Jev, on the pinned model: a replay on the CLI's model says nothing about how Jev
answers. A replay with `fallbackCases` above zero never counts ([below](#labels-and-replays)).

| Standing | Meaning |
| --- | --- |
| `unproven` | Neither reading has enough cases with a known outcome yet |
| `proven` | The deciding reading clears the gate |
| `failing` | The deciding reading has the cases and does not clear the gate |

The gate, with its numbers in force (`gate` in `decisions.json`, defaults in `DEFAULT_GATE`):

- **Cases:** at least `minCases` (30) outcomes with a known result.
- **An act point:** the 90 % lower bound of the precision of its acting answers must be above its
  **break-even**, and, where its rows carry a baseline, above the baseline's own precision. The
  break-even is 0.5 where a wrong act and a missed one cost about the same, 0.6 for
  `flow.refine-needed`, `flow.restart`, `orchestration.fixer` and `run.continuation`, and 0.7 for
  `checks.fix`, `review.depth` and `orchestration.retry`, where a wrong act costs more than a right
  one saves. With 30 cases, a break-even of 0.5 needs 19 right (0.63), 0.6 needs 22 (0.73) and 0.7
  needs 25 (0.83); more cases lower that bar (the lower-bound table is in
  [the plan's Outcome](plans/decision-engine-v2.md#outcome)).
- **A suggest point:** a flag precision of at least `suggestMinPrecision` (0.6) and a flag rate of at
  most `suggestMaxFlagRate` (0.3).

**The write gate.** `PUT /decisions/settings` judges only what a write newly switches to `active`
(`judgeActivation`, `DecisionEngine.saveSettings`), against the gate already in force, so a write
cannot loosen the gate and use it at once:

- an act point, or a suggest point whose answer starts a run (`lesson.mine`), without standing
  `proven` is refused with `409` `decision-unproven`, and nothing is written;
- **no bulk activation**: more than one point of any kind without standing `proven` at once is
  refused with `409` `decision-bulk-activation`;
- any other suggest point is switched, and the answer carries a warning for it;
- a document that already holds active unproven points loads and saves as it is; such a point
  behaves as shadow until it proves itself (`limitedBy` `unproven` or `failing`);
- a project's override goes through the same check when the project's settings are written
  (`checkProjectActivation`); the warnings have no answer to travel in there and are dropped, so the
  point's row shows its standing instead.

The refusal's body is a `DecisionActivationRefusal`: the points, and for each its standing, its
live and replay readings and the gate in force, so the screen can say what is missing.

**The Supervisor is exempt from the write gate.** `supervisor.intervene` is two things in one mode:
whether the Supervisor may send hints on its own, which the owner bounds by listing signal kinds, and
whether a question to the engine may decline a hint, which only happens under Jev and which the
run-time gate holds to standing like any act point. Under the CLI the point asks the engine nothing,
so it could never earn evidence, and refusing the write would leave the Supervisor no way to be
switched on. The exemption covers the write, and the engine's demotion too ([below](#demotion)): its
Active is the owner's switch for sending hints, which a demotion would turn off, while the part that
needs evidence, Jev declining a hint, is already held to standing at run time.

### Probation: the holdout

An active act point acts on all but a random share of the cases it would act on. The share is 10 %
while the point has acted (or held back) fewer than 100 times in the window and 5 % after
(`holdoutShare`), counted since the point's promotion mark when it has one, so the first hundred acts
are those of its current time in Active, and over the window otherwise. A held-out row is recorded with `held_out = 1` and `acted = 0`, today's behaviour
runs, and the row resolves like a shadow row: it is the comparison that does not depend on what the
point itself caused. The price is that a held-out `done` causes a continuation the decision would
have saved.

### Demotion

`DecisionEngine.review()` runs hourly and after each sweep of the resolvers. An active point goes
back to shadow when:

- its standing is `failing`: the reading that decides it has the cases and no longer clears the gate
  (reason `failing`). This holds **with or without a promotion mark**: an install whose points were
  switched on before the gate existed has none, and a failing point there must not keep acting or
  flagging; or
- it was promoted (its promotion mark records when and its act rate then) and, over the last 7 days,
  with at least 20 answered rows, it acted or flagged more than twice as often as on the evidence it
  was promoted on (reason `rate`). Without a mark there is no promoted rate to compare with.

A point that is active and proven without a mark gets the mark at the next review. The Supervisor's
`supervisor.intervene` is never demoted ([above](#standing-and-the-promotion-gate)).

The engine writes `demoted` (when, why and the figures) into the point's entry in `decisions.json`,
sets its mode to shadow and emits the `decision.demoted` event, which becomes a notification of kind
`health`, normal priority, that links to Decisions and says why and that today's behaviour runs
again until the person sets the point to Active. Nothing is ever promoted by itself; switching the
point to `active` again clears `demoted`.

### The suggestion floor

A suggest point shows a suggestion only at or above its **floor**: `floor` in the point's entry of
`decisions.json`, 0.7 by default, between 0.5 and 0.99. Below it the row is recorded and nothing is
flagged. The CLI gives no confidence, so under the CLI a suggestion is never held to a floor, and
Settings offers the slider only under Jev.

### Why a point is limited

`effective.limitedBy` in `GET /decisions/points`, in the order the engine checks it: `no-consent`;
`cli` (an act point on the CLI, or `palette.intent` off Jev); `demoted`; then `unproven` or
`failing` for a gated point whose standing is not `proven`. The Supervisor under the CLI is never
limited.

## Labels and replays

A replay tests a question, a new Jev version or a provider before the point ships with it.

- **The golden set** is the `decision_labels` table: a row's redacted state, the questions asked,
  the point and whether the answer that acts was right. A label comes from a `direct` outcome
  (`source: outcome`) or from a person (`source: person`, which an outcome never overwrites). Labels
  are kept past `historyDays`: the engine turns every answered row whose outcome is `direct` into a
  label just before it prunes the history. A set built outside Claudio can be imported
  (`POST /decisions/labels/import`, up to 500, redacted to the point's limits on the way in).
- **A replay** (`replayDecisions`, `replay.ts`) puts the newest labelled states, 100 by default, to a
  provider again, under the point's current questions or reworded ones, and scores the answers with
  the same evidence function: precision of the acting answer with its lower bound, calibration, a
  confusion table. It writes no `decisions` row, never retries, counts an unavailable answer and
  leaves it out of the score, and a provider that reports it cannot answer at all (no key, no quota,
  rate limit, spend cap) ends the run. The result is stored in `decision_replays` with the hash of
  what was actually asked, and the gate reads the newest one that counts ([standing](#standing-and-the-promotion-gate)):
  under the questions in force and on what the point runs on. A replay rebuilds each case's questions
  from its stored state; a case whose state cannot rebuild them is asked the label's own questions and
  counted in `fallbackCases`. The run is then stored under the hash of what was asked (the set's own
  hash, or a hash of the mix that no point's questions equal) and never counts for the gate, so a
  replay of stale states cannot prove a point under wording it was not asked with.
- **From the API** a replay needs the point's own consent for that provider at the current state
  version (`409` otherwise), runs in the background, one per point at a time, and ends by itself
  after 30 minutes or 1 US$.
- **The script** `scripts/decisions-replay.mjs` is the way to try a reworded question
  (`--questions`), a labelled set from a file (`--labels`) or a provider before touching the
  install: `pnpm exec tsx scripts/decisions-replay.mjs --point <id> --provider jev`. It says which
  data directory it reads and never picks one silently, opens the database read-only (and read-write
  only to append the result, which `--no-store` skips), drives the CLI directly as a one-shot in an empty directory, confined like the engine's own
  chat (`--restricted`, no tools, no setting sources, `--strict-mcp-config`, no slash commands,
  `dontAsk`, and no Claudio API url, token or chat id in its environment), since the stored states are
  untrusted text, and reads the Jev key through the credential store without ever
  printing it. `--dry-run` prints what would be sent, to whom and how big, and sends nothing.
  **Its consent rule:** states leave the machine only when the point already has consent for that
  provider at its current state version in `decisions.json`, or when the owner passes
  `--consented-by-owner`, which says consent was given out of band for this one run and is recorded
  with the stored result. Without either, nothing is sent. Run by a person or a task, never by a
  test: no test reaches Anthropic or TypeSafe.

## Risk in `notification.urgency`, and the daily cap

Plan: [plans/agent-run-improvements.md](plans/agent-run-improvements.md).

- **`risk` field, `stateVersion` 2.** The point lists `risk` among its fields
  (`packages/core/src/decisions/points.ts`) and is at `stateVersion: 2`: a consent given for version 1
  no longer counts, so the person is asked again, with the risk line in the preview.
- **`spend-cap` as an unavailable reason.** Over the daily cap the CLI provider answers `unavailable`
  with `spend-cap` (`providers/cli.ts`, `spendOpen`), and the point runs today's behaviour. Points
  never block. `checks.fix` also starts no fix by itself over the cap (`ChecksFix.hasRoom`).

## The Supervisor

`supervisor.intervene` wakes the Supervisor (`packages/core/src/supervisor.ts`) when the health
monitor announces a worker `bad`. It decides first whether the worker is stuck at all and, if it is,
drafts a hint of a line or two with a housekeeping chat of the CLI; D5 and C3 of
[the regression fixes](plans/regression-fixes-2026-10-29.md) set how it is asked about each
occurrence:

- **A structured draft decides first.** The chat answers under `--json-schema` with `{ stuck, hint }`
  (`SUPERVISOR_SCHEMA`), no reasoning field. Its prompt says the health check measures time and
  repetition, not intent, so a worker waiting on a command or a batch of calls that is doing work, on
  CI or on agents it delegated to, is not stuck. A draft that says so sends nothing and proposes
  nothing: the occurrence is kept with the proposal status `not-stuck` (statuses are `proposed`,
  `sent`, `dismissed` and `not-stuck`) and the cost of the draft is charged all the same. A person
  cannot send a `not-stuck` proposal (`409`).
- **A "not stuck" draft is asked again.** Honest work at minute twenty can hang for hours after, so
  the answer does not close the occurrence. It is drafted again on the same row (the unique key keeps
  one answer per occurrence; the new answer replaces the old one, `at` moves to it and the cost adds
  up) after a back-off (`notStuckDue`): for a running command, once its running time has doubled since
  the answer (asked at twenty minutes, again at forty, then at eighty), and for anything else after an
  hour (`NOT_STUCK_RETRY_MS`). The back-off reads the row's `at`, so a restart keeps it. It is bounded:
  at most four drafts per occurrence, the first included (`NOT_STUCK_MAX_DRAFTS`), after which the
  worker is left to the person. A later draft that finds the worker stuck is an ordinary proposal. The
  monitor wakes the Supervisor again every five minutes (`REWAKE_MS`) while a chat stays `bad` with the
  same signals, because nothing else would give a back-off a later look. An occurrence whose engine
  question answered "no hint would help" waits an hour as well, in memory, before it is asked again.
- **A hung command is timed on its own clock, per call.** The CLI runs only the calls that change
  nothing side by side, so the fourth shell command of a batch waits while the third runs, and timed
  from the message it arrived in it looked hung after a minute of honest work by its siblings. A
  call's clock starts at the latest of its own time and the end of every earlier call by the same
  agent that was still running when it was made, and a call with such a sibling still running is
  not timed (`commandClock`). Two rules keep that wait from hiding a command for good: an earlier call
  still open holds nothing when a call that Claude Code runs only one at a time (an edit or a write)
  has answered after it, which shows its own answer was lost on the way (an interrupt, a stream cut
  short); and an earlier call open longer than two hours (`SERIES_HOLD_MAX_MS`) holds the later one no
  longer, which is then timed from that limit. A kind of command with history is slow after the largest of 30 s, 3
  times its median and 1.5 times its 90th percentile, and `bad`, which is what wakes the Supervisor,
  after twice that (3 minutes at least); a kind with no history warns at 3 minutes and is `bad` at 10.
  The durations on that same clock are what `command_durations` keeps and the resolver reads: a
  hung-command row is judged by whether the command ended on its own, or by whom it was cancelled.
- **Active sends on its own only for the signal kinds the owner lists.** `supervisor.autoSignals` in
  `decisions.json` (empty by default; `PUT /decisions/settings` validates each entry against the
  health signal kinds) names them, and under Active the Supervisor sends hints, and cancels a hung
  command, only for those kinds; it proposes the rest for a person to send. The engine's standing is
  per point, not per signal kind, so the list is the owner's call.
- **Under Jev**, the point's question ("is this worker stuck in a way a short hint could get it out
  of?") is asked before the hint is drafted and only a "no" at the point's threshold drops the hint,
  which saves the draft and the interruption. Under the CLI the draft is itself the judgement and the
  engine is not asked. A Jev point that is active without standing `proven` behaves as shadow here.
- **Who sent a hint is recorded** (`supervisor_proposals.sent_by`: `person` from the health panel,
  `supervisor` on its own). The resolver reads a person's Send or Dismiss as `direct` and the
  Supervisor's own send as `proxy`, whatever the mode, since that is the decision's own doing.

- **One proposal per occurrence.** A signal's occurrence is the call it is about (`toolUseId`), else
  when it started (`since`), else what it measures. `supervisor_proposals` is unique on
  `(chat_id, signal, occurrence)`; a migration rebuilt the index, and rows from before keep `''`, so a
  long chat's second hang is asked about again. A hung command that is also the last of a stall run
  is one thing to act on: `hung-command` and `repeat-stall` about the same call share one proposal.
- **Failures expire.** An answer that is an error or empty, or a Jev "no hint would help", is not
  asked again for 15 minutes (`FAILED_RETRY_MS`), then it is. A start refused for room (a full run
  slot, short memory: `RunSlotRefusal`, `MemoryRefusal`) is not a failure: the question is tried again
  every 15 s for up to 5 minutes, and with no room by then nothing is recorded, so the next
  announcement asks again.
- **It names the agent.** The runtime's trace keeps each call's `parentToolUseId`, so a signal about
  a subagent's call carries `agent: { parentToolUseId, agentId?, description, subagentType }`
  (`agentId` is the CLI's id, filled from the live branch once the subagent has started). The
  Supervisor then reads that agent's steps (its branch of the live stream), not the lead's.
- **A hint about a subagent goes straight to it.** With an `agentId`, the proposal keeps the raw hint
  and sending it (Active on its own for a listed kind, or a person's Send from the health panel) calls
  `ChatService.messageAgent` with `source: 'supervisor'` (`'person'` for the panel), which writes it
  through the `claudio-bridge` mod ([agent messages](agent-messages.md)), framed with
  `AGENT_MESSAGE_SUPERVISOR_PREFIX` so the subagent's row says "Supervisor" (a person's Send is
  framed as theirs). Core waits up to 25 s for the row to turn `delivered`. When the write is refused
  (chat not live, subagent stopped or unknown) or the row ends `undelivered` (`bridge-unavailable`,
  `agent-stopped`, `not-read`, or no answer in time), it falls back **once** to a relay through the
  lead (`ChatService.relay`, `Orchestrator.relayTask` for a worker): the lead reads the hint framed by
  `relayToSubagent` ("An automatic message from Claudio's Supervisor for your subagent `<description>`
  (agent id `…`), which looks stuck; pass it on verbatim with SendMessage, or stop it…"), and its
  transcript draws a system row "Supervisor → <subagent> · through the lead" (a person's Send: "You →
  …"). A signal with no `agentId` yet keeps the raw hint and goes the same relay way; a proposal stored
  before as the old sentence ("Your background agent `<description>` is stuck…") goes to the lead as
  it was written.
- **Active cancels a hung command.** A hint is a message the agent reads only once the call it is
  blocked in returns. For `hung-command` and `repeat-stall` with a running call, Active (for a kind
  the owner listed) cancels the
  command (`ChatService.cancelCommand`) with the hint as the reason: the failed result reaches the
  agent that ran it, a subagent included (its commands are children of the CLI like the lead's). The
  hint is sent as a message only when the cancel is refused (the command ended, or its process cannot
  be told from a background command's). Shadow cancels nothing.
- **Confined, with its own cap.** Its chat runs like a decision's one-shot: `--restricted`, the
  `read-only` preset's tools only (`--tools`), no settings sources, `--strict-mcp-config` with no
  server, no API url or token, `dontAsk`, no transcript and no guard. Its cap is
  `cli.supervisorMaxCostUsd` (default 0.25 USD, at most 5), not the decision cap: it reads the
  worker's files before it writes, which a one-shot question never does. The cap is in Settings →
  Decisions → Advanced ("Cap per Supervisor hint", `engine.supervisor-cap`).

## Consent and privacy

- **The state is declared.** A point sends only the fields its catalogue entry lists, every string
  cut to the point's byte limit, with anything that looks like a secret masked
  (`decisions/redact.ts`). Claudio's own secrets are masked too, whatever text surrounds them,
  since no pattern tells `T="<token>"` from any long word (the owner's token reached Jev that way
  on 2026-10-02): the Jev key, YouTrack's token and the webhook secrets as they are, and the owner's, the desktop
  app's and every live chat's API token by hashing each word long enough to be one, since those
  are kept only as hashes. A chat token (`agc_…`) is masked by its prefix as well. The builder is
  the single source of what leaves.
- **Consent per point.** Moving a point out of `off` the first time opens a dialog with the exact
  state (`GET /decisions/points/:point/preview`: the last request, or what it would send now, built
  locally and not sent), its size and the provider it goes to. Consent records the state version and
  the providers it covers: a state that changes shape asks again, and consent given on `cli` does not
  cover `jev`. A point without consent stays off whatever an override says.
  The point's row in Settings says so, for Shadow and Active alike: "Off until it has consent." with
  the warn icon, and a **Review and consent** button that opens this dialog in the point's current
  mode, so a person never has to move the point to Off and back to be asked
  ([settings.md](settings.md#a-decision-point-without-consent-is-off)). The engine itself did not
  change: it was right, and the row used to say the point ran.
- **With `cli` nothing leaves the machine** beyond what Claude Code already sends, and the dialog
  says so.
- **With `jev`** the declared state goes to TypeSafe, and for many points that is text or code: the
  next section lists it field by field. Zero retention exists only on enterprise accounts. Saving the
  key shows a general notice.
- **Only the owner widens it.** A chat's own token is refused with `403` on
  `PUT /decisions/settings`, `PUT` and `DELETE /decisions/credentials` and `PUT
  /decisions/points/:point/consent`, so an injection in a chat cannot consent to a point or switch
  to Jev. A project override can set a mode or provider, never consent.
- **Only a person rates.** `POST /decisions/:id/feedback` is a person's too (`403` to a chat's token):
  useful or not useful is always a `direct` outcome for the gate, so a worker able to rate rows could
  prove a point or demote it.
- **Untrusted text is marked.** Every state goes into the question inside a `pasted()` block with
  `PASTED_NOTE`, for both providers.

## What leaves the machine

Under `cli` nothing leaves beyond what Claude Code already sends. Under `jev` a point sends its
**declared state** and its questions, and nothing else: Jev writes no text or code and runs no agent,
but it does receive whatever the state carries, and the state of many points is text a person or an
agent wrote, or code. The fields below are the `fields` of each entry of the catalogue
(`packages/core/src/decisions/points.ts`); a point never sends a field it does not list. Every
string is cut to the point's byte limit and masked by `decisions/redact.ts` first, and the consent
dialog shows the exact state before the point may leave `off`.

| Point | Fields the state may carry | Text or code? |
| --- | --- | --- |
| `flow.refine-needed` | `title`, `description`, `type`, `criteria`, `labels`, `sizeEstimate` | Text: the card's title, description and criteria |
| `flow.bounce` | `rejection`, `criteria`, `bounces` | Text: QA's rejection comment and the unmet criteria |
| `flow.criteria-precheck` | `criteria`, `summary`, `commits`, `paths` | Text: criteria, the work run's summary, commit subjects and changed paths; no diff |
| `flow.criteria-merge` | `existing`, `proposed` | Text: criteria |
| `flow.restart` | `stage`, `cause`, `restarts`, `error` | Text: the run's error |
| `context.compact` | `stage`, `share`, `usedTokens`, `window`, `bounces`, `rejectionChars` | No: the stage and numbers |
| `flow.scope-drift` | `title`, `criteria`, `commits` | Text: the card and commit subjects with changed paths; no diff |
| `team.assign` | `title`, `type`, `criteria`, `members` | Text: the card and each member's role and responsibilities |
| `board.triage` | `title`, `description`, `openItems`, `epics` | Text: the draft being typed and the titles of open items |
| `memory.triage` | `proposal`, `target`, `memoryTitles`, `journalTitles` | Text: the proposed entry and existing titles |
| `lesson.mine` | `signals` | Text: a person's own words, quotes of at most 500 bytes |
| `journal.relevance` | `title`, `criteria`, `entries` | Text: the card and the journal entries |
| `assistant.rerank` | `proposals`, `agents`, `skills`, `commands`, `members` | Text: proposal titles and reasons, and the names of the project's resources |
| `assistant.sources` | `brief`, `files` | Text: the brief; file names and sizes, not contents |
| `orchestration.retry` | `error`, `task`, `attempt` | Text: the failed task's error text |
| `orchestration.model` | `tasks`, `models` | Text: task names and the first three lines of each task's prompt |
| `orchestration.fixer` | `checks`, `failedSpecs`, `notes`, `attempt` | Text: each failing check's command and **the tail of its output**, failing spec names, the fixer's earlier notes |
| `review.depth` | `files`, `added`, `deleted`, `paths`, `securityHit`, `dimensions`, `estimateUsd` | No code: counts, changed paths and flags |
| `run.continuation` | `title`, `deliverable`, `tail`, `continuations`, `phraseListMatched`, `turn` | Text: the task's name, the head of its prompt, and **the tail of the worker's last report** |
| `supervisor.intervene` | `signal`, `detail`, `calls` | Text: the signal's detail, which for a hung command is the command line, and the tool names of recent calls with the head of an error |
| `health.semantic-loop` | `calls` | Short: each call's tool name, a digest of its input and a target of at most 80 characters (a path, pattern, URL, query or a command's first word); never an input or a result |
| `health.test-weakening` | `path`, `before`, `after` | **Code:** the before and after of a test edit |
| `changes.unexplained-hunk` | `hunk`, `step`, `title` | **Code:** the hunk; text: the sentence the agent wrote before it and the chat's first prompt |
| `notification.urgency` | `kind`, `title`, `body`, `risk` | Text: the notification's title and body and one line on the riskiest tool call |
| `palette.intent` | `query`, `commands` | Text: what the person typed and the titles of the commands |
| `checks.fix` | `checks`, `attempt`, `diffStat`, `headSha` | Text: check names and **the tail of each failing log**, at most 2 KiB each; the diff stat's paths |
| `review.triage` | `title`, `threads` | Text: the **review comments**, a stranger's words, with their paths |
| `issue.triage` | `tracker`, `issues`, `notTriaged` | Text: the tracker's **issue titles, bodies and labels** |
| `account.model-fallback` | `model`, `candidates` | No: model ids, display names and tiers |

What carries a hunk, the before and after of a test edit, the tail of a report, a log tail or error
text, in short, is `changes.unexplained-hunk`, `health.test-weakening`, `run.continuation`,
`checks.fix`, `orchestration.retry`, `orchestration.fixer`, `flow.restart` and `supervisor.intervene`.
The second plan cut the volume: `health.semantic-loop`, which was 24.4 M of the 26 M tokens the
engine had sent, now sends a digest instead of the tool calls, and is asked only when a cheap rule
finds repetition.

## Shadow accuracy

Each row records what the engine answered. A resolver per point (`decisions/resolve.ts`) later reads
the signal the app already produces (a flow run ending, a work item edited, a proposal accepted or
rejected, a task's status) and writes `outcome`, `agreed` and `resolved_at`. A sweep runs shortly
after the relevant events and every five minutes. The person's word outranks the inference: useful /
not useful on the "decided" mark (active) or on a History row (shadow) sets `agreed`.

Twenty-seven of the 29 points have a resolver (`review.triage` and `issue.triage` have none), and
each says how far its outcome can be trusted ([Evidence](#evidence)). The sweep gives every point an
equal share of the rows one pass reads, its oldest unresolved ones first and from where its last read
stopped, so a point with thousands of rows that cannot resolve neither crowds out the others nor
starves its own newer rows. Three resolvers read a signal the app stores for them (CW-28):

- **`palette.intent`**: the palette asks in shadow as well as active (Jev only), shows nothing in
  shadow, and reports what the person did through `POST /decisions/:id/palette-action`
  (`{ commandId }`, or null when the palette closed without one). The row keeps it in
  `palette_action` as `proposed`, `other` or `dismissed`; the first report wins. A proposed id is
  agreed only when that command ran; "none" is agreed when the palette was dismissed or the command
  that ran was not among the listed ones. The palette no longer sends `useful` by itself: useful /
  not useful is the person's explicit word.
- **`notification.urgency`**: the service worker adds `notification=<key>` to what a click opens; the
  app reports it once with `POST /decisions/notification-opened` (`{ key }`) and removes the parameter.
  That sets `opened_at` on the newest row of that key. The window is the push TTL, one hour: `high`
  is agreed when opened within it and `normal` is not. A push nobody opened, or opened after the
  hour, is not scored and the row stays unresolved: most pushes are ignored, a push the worker did
  not show because a focused window was open can never be opened, and none may have reached a
  device, so "not opened" had made the score mostly the share of `normal` answers. The first
  review is in [decisions/jev-shadow-review-first-day.md](decisions/jev-shadow-review-first-day.md).
- **`orchestration.model`**: an orchestration launched from a planner's draft carries
  `plannerRunId`. The resolver finds the first one created after the row with that planner run and,
  for each task the row answered, compares the launched model (`task.model ?? orchestration.model`)
  with the suggested one. A kept model is right if the task completed and wrong if it failed; a
  stronger suggestion (haiku < sonnet < opus, by family name in the id) is right if the task failed
  and wrong if it completed; a weaker suggestion is wrong if it failed and not judged if it
  completed; unranked ids that changed, and `skipped` or `stopped` tasks, are not judged. The row
  waits while any answered task is `pending`, `running`, `blocked` or `interrupted`; the verdict is
  a majority (`right * 2 >= judged`) and the detail lists per task the suggested and launched model,
  whether it was kept, and the final status. A draft that is never launched stays unresolved until
  retention prunes it.

The signals are two columns of the history row (`opened_at`, `palette_action`), not part of any
point's state, so no `stateVersion` changes and consent is not asked again. Recording either signal
schedules the same debounced sweep as the events do. Both routes are refused to a chat's token.

`GET /decisions/stats` returns, per point: count, acted, mean confidence (null for `cli`), resolved
(split into `direct` and `proxy`) and agreed, useful and not useful, unavailable, cost, runs saved,
runs caused and their net, the answers against the code rule (`baseline`) and the `evidence` of
[above](#evidence); in total, Jev's cost and the same three run figures. Settings shows each point
as one row of evidence ([Where it shows](#where-it-shows)). Nothing switches a point to `active` by
itself.

## Where it shows

- **Settings → Decisions** (`apps/web/src/pages/config/groups/Decisions.tsx`, with
  `pages/config/decisions/Engine.tsx`, `Points.tsx` and `DecisionHistory.tsx`): two sections,
  `engine` (who answers, the Jev key with a connection test, the cap per decision, and under Advanced
  the CLI model, effort, the Supervisor's cap and history days) and `points` (grouped by area; the
  Supervisor is the `supervisor.intervene` row). A point's row shows its mode, its **standing** as a
  tag (Unproven, Proven, Failing), its evidence line (decisions, those with a known outcome, how often
  it is right when it acts or flags, how often it differs from today's rule, disagreements), consent,
  the threshold of an act point or the floor of a suggest point under Jev, and, when the point is not
  doing what its mode says, one sentence saying why and what it still needs ("Runs as Shadow: it still
  needs 12 more cases with a known outcome and a precision above 60 %"). A proven or failing point's
  line says which reading decided ("from its history", "from a replay"), and a point whose
  `evidencePossible` is false says "No outcome Claudio can observe proves this point; only your own
  useful or not useful does." where that sentence would be. Above the points, a note counts the points
  that are Active in the settings and run as Shadow for now. **Active is disabled** on a gated point
  that is not proven, with what it needs as its reason, unless the point is saved as Active (the gate
  judges a step up from what is saved, so the form keeps Active available to it), and a bulk "Active"
  plans only proven points and leaves the others as they are, each to be switched on its own row. A point the engine demoted says "Back to Shadow on <date>: <why>".
  A save the gate refuses shows an alert naming each point and what it lacks, and keeps the person's
  unsaved changes (in a project, a point that is Active globally and would inherit it by dropping its
  Shadow override says so, since the server counts that as an activation); a save with a suggest point going Active without proof says so in its toast. The
  Supervisor's row lists, folded, the nine signal kinds it may send on its own under Active. History
  (filter, open a row, useful / not useful, delete, clear) is a screen of its own at
  `/settings/decisions/history`. The first-tap feedback surfaces and the "label ten" queue of the plan
  are not built.
  The old `?tab=supervisor` lands on `/settings/decisions#point-supervisor-intervene`
  ([Settings](settings.md#the-decisions-screen)).
- **Project settings → Decisions**: the provider (inherit, CLI, Jev when a global key exists) and
  mode and threshold per project point, with a "Use global" reset.
- **The "decided · 0.93" mark** (`components/DecisionMark.tsx`): only on a row where an act point
  changed something a person sees (`visible`), or "suggested" for a suggestion. It opens the answer in
  a popover (a sheet on a phone) with useful / not useful. Surfaces: board and item, new task,
  memory and assistant proposals, orchestration task rows and the plan draft, the supervisor hint in
  a chat, and unexplained hunks in the diff.
- **Usage**: a line "Decisions · Jev $0.004 · Net: 12 agent runs saved (20 saved, 8 caused)", hidden
  when the window has no decision; it says "added" when the net is negative.
- **Command palette**: with `palette.intent` active or in shadow on Jev, a query that ranks nothing locally asks
  `POST /decisions/palette` (in shadow nothing is proposed); the local score always answers first and nothing blocks typing.

## Settings and storage

- **`decisions.json`** in the data directory: the provider, the `cli` model, effort, cost cap and
  the Supervisor's cap (`supervisorMaxCostUsd`; a `PUT` without it keeps the stored one),
  the mode, threshold and consent per point, and `historyDays` (30, from 1 to 365). Validated whole on
  `PUT`, written atomically. Since the second plan it also carries: **`gate`**
  (`minCases` 30, `suggestMinPrecision` 0.6, `suggestMaxFlagRate` 0.3; absent until set, so an older
  document keeps its shape and reads the defaults), per point the suggestion **`floor`** (0.7 by
  default) and the engine's own marks **`demoted`** and **`promotion`** (written by the engine and
  only read back: a `PUT` keeps them as they are, and a mark that went bad by hand is dropped without
  refusing the point), and **`supervisor.autoSignals`**, the signal kinds the Supervisor may send on
  its own under Active (empty by default; it has no row in the settings registry). It also carries `supervisorMigrated: true` once `supervisor.json` has been
  folded into `supervisor.intervene`, so the fold runs only once; the API does not serve the mark.
- **`decision-credentials.json`**, mode 0600: the Jev key. The API returns only `keySet` and
  `keyHint` (its last four characters).
- **Per-project override**: `ProjectSettings.decisions` in the project's settings, points of project
  scope only.
- **`decisions` table** in SQLite (one row per question batch): the exact state sent, questions,
  answers, confidence, threshold, `acted`, `visible`, `saved_run`, latency, tokens, cost, outcome (with
  its `quality`), `agreed`, feedback, and three columns of the second plan: **`baseline`** (what the
  code rule answered, JSON), **`run_effect`** (+1 a run saved, -1 a run caused, 0 otherwise; a
  migration backfilled the acted rows by each point's acting answer, and `saved_run` follows it) and
  **`held_out`** (1 for an act the [holdout](#probation-the-holdout) withheld). Rows older than
  `historyDays` are pruned at start-up and once a day, after the `direct` ones have become labels.
  Consent is a setting, not a row.
- **`decision_labels`**: the golden set, one row per labelled state (point, the row it came from, the
  redacted state, the questions, whether acting was right, `source`, a note). Not pruned with the
  history.
- **`decision_replays`**: one row per replay (point, provider, model, the questions and the hash of
  what was asked, cases, **`fallback_cases`** (the cases asked the label's own questions; a run with
  any never counts for the gate), how many got no answer, the score, the confusion table, cost, where
  the consent came from).
- **`flow_runs.continuation_effects`** (JSON) and the task's `continuationEffects` in the
  orchestration's state: the [effect of each continuation](#runcontinuation).
- **`supervisor_proposals.sent_by`**: `person` or `supervisor`, null while unsent and on rows from
  before it. Its `status` has a fourth value, `not-stuck`, and **`asks`** counts the drafts of the
  occurrence (1 on rows from before it).
- **`cost_corrections`**: one row dating the migration that recomputed the stored costs of resumed
  sessions ([cli-surfaces.md](cli-surfaces.md#how-a-resumed-or-forked-session-is-billed)).
- **Jev's cost is derived, not reported.** TypeSafe answers with input tokens only. `JevProvider`
  records `tokens × JEV_PRICE_USD_PER_INPUT_TOKEN` (0.042 US$ per million input tokens, output free;
  `decisions/settings.ts`), and `null` when the answer carried no tokens. A migration priced the
  rows stored before this with the same literal price. `decisionStats` only sums `cost_usd`.

## Routes

All under tag `decisions`; the full table is in the [REST API](rest-api.md#decisions). Writes to
labels, replays, settings, credentials, consent and feedback are refused to a chat's token.

| Method | Route | What |
| --- | --- | --- |
| `GET` `PUT` | `/decisions/settings` | The global settings (key masked); replace them whole. The promotion gate refuses a write with `409` (`decision-unproven`, `decision-bulk-activation`); the answer to a `PUT` carries `warnings` |
| `PUT` `DELETE` | `/decisions/credentials` | Save or remove the Jev key |
| `POST` | `/decisions/test` | One small fixed request to a provider |
| `GET` | `/decisions/points` | The catalogue with the settings in force (`?projectId=`): standing and `decidedBy`, `evidencePossible`, the gate, the live and replay readings, `demoted`, and `limitedBy` and `floor` in `effective` |
| `GET` | `/decisions/points/:point/preview` | The exact state a point sends |
| `PUT` | `/decisions/points/:point/consent` | Grant or withdraw consent |
| `GET` `DELETE` | `/decisions` | History, filtered and paged; clear a filtered set |
| `GET` | `/decisions/stats` | Per-point metrics, direct and proxy outcomes, the baseline comparison and the evidence; Jev cost and runs saved, caused and net |
| `GET` `DELETE` | `/decisions/:id` | One decision; delete it |
| `POST` | `/decisions/:id/feedback` | Useful or not useful; a chat's token gets `403` |
| `GET` `POST` | `/decisions/labels` | The golden set; label a history row (a person's) |
| `DELETE` | `/decisions/labels/:id` | Delete a label |
| `POST` | `/decisions/labels/import` | Import a labelled set built outside, up to 500, redacted on the way in |
| `POST` | `/decisions/labels/outcomes` | Label a point's rows whose outcome is `direct` |
| `POST` `GET` | `/decisions/replays` | Start a replay of a point over its labels (background; needs consent); the stored results with `running` and `failed` |
| `POST` | `/decisions/palette` | Route a palette query (`palette.intent`) |
| `POST` | `/decisions/:id/palette-action` | What the palette did with the proposal; a chat's token gets `403` |
| `POST` | `/decisions/notification-opened` | The app was opened from a push; a chat's token gets `403` |
| `POST` | `/projects/:id/work-items/triage` | `board.triage` for a draft being typed |

## How it is tested

- **Core unit tests**: settings validation and the project, global, default resolution; consent
  gating; redaction; the threshold rule (a `null` confidence never clears it); the deadline and
  fallback on every `unavailable` reason; the migration, pruning, stats and resolvers. Each point has
  the four-mode test: `off` changes nothing and calls no provider, `shadow` records but today's
  behaviour decides, `active` acts only above the threshold, `unavailable` falls back at once. The
  evidence has its own tests (`decision-evidence.test.ts`: the Wilson bound, the baseline
  comparison, calibration buckets, `direct` against `proxy`), and so has the lifecycle
  (`decision-lifecycle.test.ts`: standing, the write gate and the bulk refusal, the holdout share,
  demotion by failing and by rate, the floor, with the engine's clock and coin fixed) and the
  replay (`decision-replay.test.ts`, `apps/api/test/decision-replay.test.ts`: consent, the bounds, a
  stubbed provider). The continuation rules are pinned in `continuation-effects.test.ts` and
  `flow.test.ts`, the Supervisor's draft, `not-stuck` and `sent_by` in `supervisor.test.ts`, the
  per-call clock in `command-duration-clock.test.ts`.
- **Providers**: `cli` over the fake CLI (a schema answer, an invalid one, a `max_tokens` stop, a
  rate limit, the `pasted()` block, `THINK_THROUGH` only on Sonnet, no API url or token in the
  chat's environment); `jev` with the SDK stubbed. No test reaches TypeSafe or Anthropic.
  `prompt-rules.test.ts` scans `decisions/` for banned phrasing.
- **API tests** (Fastify inject): every route and validation error, the key never returned, a chat
  token refused with `403`, the summary-and-tag test, no OpenAPI drift.
- **Web tests**: the tab sections and the `?tab=supervisor` alias, `active` disabled for an act
  point on the CLI and for a gated point without proof, the refusal alert and the warning toast
  (`decisions-gate.test.tsx`), the consent dialog, the mark only when `visible`, the Usage line
  with the net (hidden when empty), i18n parity and the tokens guard.
- **e2e**: `e2e/specs/decisions.spec.mjs` (the tab from `?tab=supervisor`, consent to shadow, a
  History row from a faked CLI provider, the row saying Unproven, a refused save shown in the save bar
  with the person's change kept, phone layout and axe), with `shell.spec.mjs`, `a11y.spec.mjs` and `motion.spec.mjs`. A spec that needs a point to
  really act earns its standing the way a person would, through `e2e/specs/decision-proof.mjs`: it
  imports labelled states (`POST /decisions/labels/import`), replays them on the CLI provider (the
  fake CLI reads each case's answer from a marker in the state), waits for the stored result the gate
  reads, and only then sets the point `active`; `forgetProof` deletes the labels again. It is for
  fake-CLI specs only, since a replay asks the CLI once per case ([development.md](development.md#local-development)).
- **After merge**, the owner runs chosen points in shadow on their own projects and moves them to
  `active` one at a time from the metrics.

## Related

- [[plans/decision-engine.md]]: the plan, its task graph and its Outcome.
- [[plans/decision-engine-v2.md]]: the second plan: evidence, the promotion gate, replay, the continuation and the Supervisor, and its Outcome.
- [[decisions/decision-engine.md]]: the owner's eighteen decisions and their amendments.
- [[decisions/jev-shadow-review-first-day.md]]: the first review of the shadow rows.
- [[cli-surfaces.md]]: what Claudio reads from the CLI, the cost of a resumed session included.
- [[code-hosts.md]]: the checks and the fix that `checks.fix` starts, and the review threads that `review.triage` sorts.
- [[lessons.md]]: the miner that `lesson.mine` gates, and what a lesson is.
- [[trackers.md]]: the issues that `issue.triage` marks before they are imported.
- [[decisions/english-technical-language.md]]: English questions and rubrics.
- [[plans/review-gate.md]] · [[orchestrations.md]]: the review gate that `review.depth` sizes.
- [[prompts.md]]: the `cli` provider's prompt and the twelve-point check.
- [[team-and-flow.md]] · [[assistant.md]] · [[work-items.md]]: where most points act.
- [[plans/agent-observability.md]]: the health signals and the supervisor.
- [[layered-settings.md]] · [[design-system.md]]
