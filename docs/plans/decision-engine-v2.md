---
created_at: 2026-11-13T16:30:00Z
updated_at: 2026-11-13T16:30:00Z
tags:
    - plan
    - decisions
    - decision-engine
    - jev
    - metrics
    - orchestration
---
# Plan: a decision engine that earns its place

Status: **proposed** (2026-11-13). Nothing here is built. The owner's choices are listed in
[§9](#9-decisions-for-the-owner); the tasks in [§11](#11-tasks) are launched only after them.

The [decision engine](../decision-engine.md) works as built: 29 points, two providers, three modes, a
history. What it lacks is any way to tell whether a point helps, and any brake on a point that does
not. This plan fixes the defects a review found and, beyond them, changes what a point has to prove
before it may change what Claudio does.

## 1. What the review found

The owner's install has run all 29 points `active` on Jev (threshold 0.85) since 2026-10-18. The
review of 2026-11-13 read the 15,539 rows of `decisions`, the 25 orchestrations launched since
(176 tasks) and the CLI transcript of every worker, message by message.

| Finding | Measure |
| --- | --- |
| `run.continuation` sends finished workers back | 226 continuations; 223 carried only the decision's `OWES_WORK_ITEM`, the phrase list (`phraseItems`) matched none, 3 were structural (delegates) |
| What those turns cost | about 312 M tokens, 8.5 % of the workers' 3,674 M (almost all cache read), 20.7 h of wall time; up to 20 % of one orchestration |
| What they did | 52 used no tool, 112 read or checked without editing, 62 edited or committed: 164 of 226 changed nothing (about 106 M tokens) |
| Cost figures overcount on resume | a resumed session reports `total_cost_usd` over the whole session; `foldResult` assumes it restarts at every spawn. 63 multi-execution tasks show 1,473 USD where their last execution reports 476 |
| Suggest points flag at any confidence | `changes.unexplained-hunk` flags 973 of 1,019 (95 %); `health.semantic-loop` raised 1,131 warnings at confidences from 0.50 |
| One point is most of the traffic | `health.semantic-loop`: 13,447 rows (87 %), 24.4 M tokens of tool calls sent to TypeSafe |
| The Supervisor's gate does not gate | Jev cleared the threshold once in 311; 290 of 294 hints were sent; 187 are `hung-command` |
| The evidence misleads | "Claude runs saved" counts 221 acted `owes-work` rows, which add runs; `run.continuation` scores "the task completed" as a disagreement; `health.semantic-loop` scores a later Supervisor hint as agreement (525 of 525) |
| Nobody labels anything | 0 useful / not useful in 15,539 rows |
| Most points have no data | 19 of 29 never asked a question in 26 days |

Why `run.continuation` fails: Jev reads the last paragraph only. An honest report ("I did not run the
whole suite; `review` should") reads as owed work, often at confidence 1.00, and reads the same way
after each continuation because the worker writes the same report again.

None of this was unknown. The record of the first shadow day
([decisions/jev-shadow-review-first-day.md](../decisions/jev-shadow-review-first-day.md), 2026-09-30)
already said `run.continuation` agreed 6 of 23 with a confidence that did not help, that
`changes.unexplained-hunk` answered "unexplained" 49 of 52 times, and decided "no point moves to
`active`". Nothing in the product carried that decision: three weeks later one gesture moved every
point to `active`.

What works and stays: the typed questions, the two providers, consent per point, redaction, the
fallback on `unavailable`, Jev's latency (about 350 ms) and price (1.10 USD for the month).

## 2. What "useful" means here

A point is useful when, measured on this install's own history, acting on it leaves the person or
the run better off than today's behaviour would have, by more than it costs. Six rules follow, and
the rest of the plan builds them.

1. **A point earns `active`.** It is promoted from shadow on evidence and demoted when the evidence
   goes. A switch alone no longer does it.
2. **Every point is measured against its baseline.** The row records what today's behaviour did or
   would have done, so the question is always "better than the code rule?", never "plausible?".
3. **The truth is an effect, not the prose.** A resolver reads something the decision did not
   itself cause to look right: a commit, a check, a person's edit. Where the decision changes the
   outcome it is judged on, a random holdout keeps an unbiased sample.
4. **Acting has a price.** Each act point declares what a wrong act costs and what a right one
   saves, in tokens or runs. The threshold comes from that and from measured calibration, and the
   stats report net effect, never "runs saved" alone.
5. **A flag that always fires is not a flag.** Suggestions need a confidence floor and stay inside a
   rate band.
6. **Ask less.** A question is put only when the code rule cannot settle the case and the answer
   could change what happens.

## 3. Stop the bleeding

Settings only, the owner's (a chat's token gets `403` on `PUT /decisions/settings`):

- `run.continuation` to shadow: **done by the owner on 2026-11-13.**
- Recommended until §5 exists: `changes.unexplained-hunk`, `health.semantic-loop` and `lesson.mine`
  to shadow; the 19 points with no history to shadow; `supervisor.intervene` to shadow (it then
  proposes hints and a person sends them).
- **History days from 30 to 90, before 2026-11-17.** The rows of 2026-10-18 are pruned thirty days
  after they were written, and S2 ([§10](#10-spikes-before-building)) needs them as its test set.

## 4. Measure first

### M1. Cost on a resumed session

`chats.ts` resets `lastReportedCostUsd` to 0 at every spawn and `foldResult` (`chat-fold.ts`) bills
the first result of the new process in full. On `--resume` the CLI's total already includes the
session's earlier turns, so every resumed execution is billed its history again, into
`execution.costUsd`, `recordSpend` and the task's and the graph's cost.

- **Spike S1, run on 2026-11-13** on Claude Code 2.1.322 (`claude -p … --model haiku
  --output-format json`, one account's `CLAUDE_CONFIG_DIR`, an empty directory): the result of a
  first turn reported `total_cost_usd` 0.00354; the same session after `--resume`, 0.00386; after a
  second `--resume`, 0.00416; and `--resume --fork-session`, under a new session id, 0.00447.
  `modelUsage` grew the same way (cache read 11,873 → 40,675 → 69,605 → 98,600 tokens). So both
  figures are cumulative over the session, across processes, and a fork starts from its parent's
  totals. Not run: a resume under another account's directory (the review's data shows totals
  that only grow across three accounts).
- So: the baseline (`lastReportedCostUsd`, `lastReportedModelUsage`) survives a spawn that resumes
  a native session, starts from the parent's last totals for a fork, and is zero only for a session
  that starts new. A total that comes back lower than the baseline counts from zero, as today.
- The stored figures: recomputing them is the owner's choice (D7).

### M2. The baseline on every row

`decisions` gains `baseline` (JSON): what the code rule answered for the same input. For
`run.continuation` it is `phraseItems(finalText)`; for `orchestration.retry` "retry"; for a suggest
point "no flag". `stats` then reports, per point, how often the decision differed from the baseline
and how those cases resolved. A point that never differs is not worth its calls.

### M3. Resolvers that say how good they are

Each resolver declares a `quality`:

- `direct`: an effect the decision could not fake (the continuation produced a commit or an edit;
  the retry completed; a person accepted or rejected the proposal).
- `proxy`: correlated but contaminated (QA passed the card later).
- `none`: no signal.

Only `direct` outcomes count towards promotion (§5). Rewritten resolvers:

- `run.continuation`: `owes-work` acted is right when the continuation it caused changed something
  (a commit, an edit tool call, a new delegate) and wrong when it changed nothing. Core records that
  effect when the continuation's turn ends (`task.lastContinuationEffect`, the same for a flow run),
  so the resolver reads a fact instead of the task's final status.
- `health.semantic-loop`: no longer scored by a Supervisor hint. `direct` only from a person's
  action on the flag (dismissed, or the chat stopped or hinted by a person); otherwise unresolved.
- `supervisor.intervene`: per signal kind. For `hung-command`, whether the command was still running
  when the hint was acted on and how long it then took (`command_durations`).

### M4. Net effect instead of "runs saved"

`savesRun` becomes `effect: { right: number; wrong: number }` in runs, per point and per answer: a
`done` that skips a continuation saves one, an `owes-work` that causes one spends one. Stats and the
Usage line show the net, with the tokens of the runs a decision caused taken from the executions it
started. The "Claude runs saved" wording goes.

### M5. Replay: test a question before shipping it

Every row stores the exact state and questions. A replay harness (`replayDecisions` in core, a
script beside it) puts stored states to a provider again under a different question, model or
threshold and scores the answers against labels:

- **The golden set** is a new table, `decision_labels`: a row's state, questions, point and label,
  kept past `historyDays`. A label comes from a `direct` outcome or from a person.
- A changed question, a new Jev version (decision 11 of the
  [record](../decisions/decision-engine.md)) or a provider comparison (Jev against the CLI's
  `haiku`) is run over the golden set first; the report is precision and recall of the answer that
  acts, a confusion matrix, and the reliability table of M6.
- No call to Anthropic or TypeSafe from tests: the harness is run by a person or a task, on consent
  the point already has.

### M6. Calibration

Per point, from resolved rows: confidence in buckets against observed accuracy. Jev's raw confidence
saturates (123 `owes-work` answers at exactly 1.00, while 164 of the 226
continuations changed nothing), so a fixed 0.85 buys nothing. The threshold of an act point is read from its table (the lowest bucket whose accuracy
clears the point's break-even, rule 4), and a point whose table is flat cannot be promoted.

## 5. The lifecycle of a point

Modes stay `off`, `shadow`, `active`. What changes is how a point moves between them.

- **Standing**, computed by the engine and shown on the point's row: `unproven` (not enough `direct`
  outcomes), `proven` (clears its gate), `failing` (had the evidence and lost it).
- **Promotion gate.** Moving to `active` needs standing `proven`. Proposed defaults, tuned by S3:
  at least 30 `direct` outcomes in the window; for an act point, the precision of the answers that
  would have acted, at the chosen threshold, has a 90 % lower bound above the point's break-even and
  above the baseline's; for a suggest point, flag precision of at least 0.6 and a flag rate of at
  most 30 %. How hard the gate is, is D1.
- **Probation.** A newly active act point acts on all but a random share of the cases it would act
  on (the holdout, D3), recorded as `held_out`. Held-out rows resolve like shadow rows and are the
  unbiased comparison.
- **Demotion.** When an active point's rolling precision falls under its gate, or its act or flag
  rate leaves its band (twice the rate measured in shadow, by default), the engine moves it to
  shadow, records why in `decisions.json`, and tells the person (D2). Nothing promotes by itself.
- **Suggest floor.** A suggestion is shown only at or above a confidence floor per point, read from
  M6 like an act threshold. Below it the row is recorded and nothing is flagged.
- **No bulk activation.** Each point is promoted on its own row; a settings write that would move
  more than one unproven point to `active` is refused.
- **Retirement.** A point with no question in 60 days, or with no `direct` resolver and no person's
  label, is listed as "no evidence possible" (D6).

## 6. Point by point

### `run.continuation`

- **Code decides first.** A decision-driven continuation is never sent after a continuation that
  changed nothing, and at most one is sent per run (D4). Structural items keep `MAX_CONTINUATIONS`.
- **The question changes** to three answers: `done`; `owes-own-work` (the run itself announced a
  step it did not take); `hands-off` (something is left to another task, the reviewer or the
  person). Only `owes-own-work` continues. The state adds what the task was asked to deliver (the
  head of its prompt), whether the phrase list matched, and the facts of the turn (commits made,
  checks run). `stateVersion` rises, so consent is asked again.
- **The continuation names what is owed** only when the phrase list matched; otherwise it asks the
  worker to do the step it announced or answer "nothing is owed" in one line.
- Promotion only after S2 shows the new question beats the phrase list on the stored tails.

### `supervisor.intervene`

- A hint is not sent when the Supervisor's own draft says the worker is not stuck.
- `hung-command` compares the running time with the command's own history (`usualOf`,
  `command_durations`) before it is announced `bad`; a parallel batch of calls in flight is not a
  hang. Two thirds of the hints came from this signal.
- Jev's answer is used at the threshold M6 gives the point, per signal kind, or not asked at all
  (the hint is itself a CLI call that judges the case).
- Active sends on its own only for signal kinds that are `proven`; the rest are proposed.

### `health.semantic-loop`

- Asked only when a cheap rule finds repetition worth judging (the same tool on near-identical
  input), not every four calls; the same state is not asked twice (hash of the state); a chat that
  got "no" three times in a row backs off.
- The state shrinks to the calls' names and a digest of their input.
- Flags above its floor only.

### `changes.unexplained-hunk`, `health.test-weakening`, `lesson.mine`

- All three get the suggest floor. `changes.unexplained-hunk` stays in shadow until it is `proven`;
  at a 95 % flag rate the question itself is wrong, and S2 replays a reworded one.
- `lesson.mine` starts a miner (a paid run) on "yes": it is treated as an act point for its effect
  (rule 4), with the miner's result (a lesson proposed and approved) as its `direct` outcome.

### The 19 points that never asked

An audit task finds, per point, whether its feature was simply not used (the Team flow, the palette,
trackers) or its call site never fires, and fixes the second kind. Its report goes into this plan's
Outcome.

## 7. Feedback a person will give

Explicit feedback stays optional, but the one tap moves to where the person already looks:

- the system row a continuation draws in a transcript, and the task row of an orchestration;
- the Supervisor's hint row;
- every flag (loop, weakened test, unexplained hunk), where dismissing it is the label.

A point's row in Settings shows its standing, the baseline comparison, its calibration and its net
effect, and offers a short "label ten" queue of unresolved rows. These screens follow
[the design system](../design-system.md) and need a design round with the owner before the web task
(D8).

## 8. What leaves the machine

The record says Jev takes "no text or code", and [decision-engine.md](../decision-engine.md) says
titles, comments and error text go to TypeSafe; in fact `health.test-weakening` sends the before and
after of a test edit and `changes.unexplained-hunk` a hunk. The docs are corrected to say what each
point sends, per field. §6 cuts the volume (`health.semantic-loop` was 24.4 M of 26 M tokens). Which
provider answers each point after the comparison of M5 is D5.

## 9. Decisions for the owner

| | Decision | Recommended |
| --- | --- | --- |
| D1 | The promotion gate: refuse `active` without standing `proven`, or warn and allow | Refuse for act points and for suggest points that start a run (`lesson.mine`); warn for the other suggestions |
| D2 | Automatic demotion to shadow, with a notification | On |
| D3 | The holdout share while an act point is active | 10 % for its first 100 acts, then 5 % |
| D4 | Decision-driven continuations per run | One, and none after a continuation that changed nothing |
| D5 | Provider per point after the replay comparison | Decide from S2's numbers; stay on Jev where it wins, CLI `haiku` where it does not |
| D6 | Points with no possible evidence | List them as such and leave them `off` by default; remove none yet |
| D7 | The stored cost figures | Recompute executions of chats whose totals only grow; leave the spend ledger as it is and note the date of the fix |
| D8 | A design round for §7 before the web task | Yes, with references, as for Servers |

## 10. Spikes before building

- **S1, the CLI's totals.** One real session: a turn, `--resume`, a fork, an account switch; record
  `total_cost_usd` and `modelUsage` at each result. Settles M1.
- **S2, replay on real history.** The stored `run.continuation` tails whose answer caused a
  continuation, labelled by what that continuation did (62 edited or committed, 164 did not, from
  the review's transcript pass), plus the `done` rows as the other class: the phrase list, the
  current question and the three-answer question, on Jev and on CLI `haiku`. The plan goes on with
  `run.continuation` only if the new question clearly beats the phrase list; if none does, the
  point is retired and the phrase list stays. The same replay for a reworded
  `changes.unexplained-hunk`.
- **S3, the gate's numbers.** With the labels of S2, how many outcomes the promotion gate needs
  before it stops flipping, and where the break-even of each act point sits.

The spikes cost cents on Jev and a few CLI turns. They run before the orchestration, by hand.

## 11. Tasks

One feature branch, `feat/decision-engine-v2`, one pull request. Each task owns its files; a later
task reads what an earlier one decided here.

| Task | Model | Does | Depends on | Owns |
| --- | --- | --- | --- | --- |
| `cost-resume` | opus, high | M1, with the fake CLI reporting totals as S1 found them | – | `packages/core/src/chat-fold.ts`, `chats.ts` (spawn baseline), `usage.ts`, the fake CLI, their tests |
| `evidence` | opus, high | M2, M3 (the `quality` field and the three rewritten resolvers), M4, M6, the migration (`baseline`, `held_out`, `decision_labels`), shared types and OpenAPI | – | `packages/core/src/decisions/engine.ts`, `resolve.ts`, `db.ts` (decisions), `packages/shared/src/types.ts`, `apps/api/src/routes` for decisions |
| `lifecycle` | opus, high | §5: standing, gate, probation and holdout, demotion, suggest floor, the bulk refusal | `evidence` | `packages/core/src/decisions/settings.ts`, `engine.ts` (gate), `stance.ts` |
| `replay` | sonnet, high | M5: `replayDecisions`, the script, the golden set's routes | `evidence` | `packages/core/src/decisions/replay.ts`, `scripts/decisions-replay.mjs` |
| `continuation` | opus, high | §6 `run.continuation`, with the effect recorded per continuation | `evidence` | `packages/core/src/open-items.ts`, `orchestrator.ts` (settle and decide), `flow.ts` (`continues`, `phraseOwed`), `decisions/points.ts` (that point) |
| `health-points` | sonnet, high | §6 `health.semantic-loop`, `changes.unexplained-hunk`, `health.test-weakening`, `lesson.mine` | `lifecycle` | `packages/core/src/health.ts`, `health-service.ts`, `changes.ts`, `decisions/points.ts` (those points) |
| `supervisor` | opus, medium | §6 `supervisor.intervene` and the `hung-command` signal | `evidence` | `packages/core/src/supervisor.ts`, `chat-model.ts` (the signal) |
| `silent-points` | sonnet, medium | The audit of the 19 points, and the fix of any call site that never fires | – | a report in this plan's Outcome; the call sites it fixes |
| `web` | sonnet, high | §7, after D8's design round; `claudio-ui` skill and `/ui-review` | `lifecycle`, `replay` | `apps/web/src/pages/config/decisions/`, `components/DecisionMark.tsx`, `DecisionsLine.tsx`, i18n `en`/`es` |
| `docs` | sonnet, medium | `decision-engine.md`, `settings.md`, `rest-api.md`, `orchestrations.md`, §8's per-field table, an amendment to the decision record, this plan's Outcome | all | `docs/` |
| `review` | opus, high | The merged branch against this plan, and the full e2e suite | all | – |

### Contracts between tasks

Fixed here so tasks of different waves meet:

- **The baseline** travels with the question: `ask(point, subject, { projectId, baseline })`, where
  `baseline` is a small JSON value the call site computes from its code rule (`evidence` adds the
  option and the column; each call site's own task passes it).
- **A continuation's effect** is recorded by `continuation` on the task state as
  `continuationEffects: Array<{ n, cause: 'decision' | 'phrase' | 'structural', changed, commits,
  edits }>` (type added by `evidence`), and on a flow run in a `continuation_effects` JSON column
  (migration by `evidence`). The `run.continuation` resolver reads only these.
- **An outcome's quality** is `outcome.quality: 'direct' | 'proxy'`; a row without it is `proxy`.
- **Runs.** `decisions.run_effect` is +1 for a run saved, -1 for a run caused, 0 otherwise, written
  when the row is, and backfilled for stored rows. Stats answer `runsSaved`, `runsCaused` and their
  net; `claudeRunsSaved` stays one release as an alias of `runsSaved` so the web compiles until its
  own task.
- **Standing and the gate** read only `direct` outcomes, through one function of `evidence`
  (`pointEvidence(point, window)`: counts, precision of the acting answer with its lower bound, the
  baseline comparison, the calibration buckets, the act or flag rate).

Verification: `typecheck`, `test`, `build` and the OpenAPI schemas, then the `e2e` gate with no
prefix, through Sluice. `decisions.spec.mjs` gains the gate (an unproven act point cannot be made
active) and a demotion.

## 12. Prior art and risks

Looked up on 2026-11-13; none of it studies this exact case (a classifier reading a final report to
decide whether work is owed), so each item is a lead, not a proof.

- **Unbounded stop checks loop.** Claude Code's Stop hooks need `stop_hook_active` or they block for
  ever; reports describe runs of tens of minutes
  ([issue 55754](https://github.com/anthropics/claude-code/issues/55754), not read in full). Hence
  D4 and "no continuation after one that changed nothing".
- **Judge the evidence, not the claim.** Practitioner write-ups agree a deterministic check of state
  (tests ran, a commit exists) should decide and a model's reading of prose only advise
  ([premature completion](https://agentpatterns.ai/patterns/anti-patterns/premature-completion/)).
  One preprint, Evidence-Carrying Termination ([arXiv 2608.23623](https://arxiv.org/abs/2608.23623),
  abstract read, synthetic tasks), reports no unsupported terminations when "complete" must cite
  evidence in the trace. Hence rule 3 and the facts added to the question's state.
- **Stated confidence saturates.** Model confidence is known to be overconfident and to pile up near
  1.0 ([arXiv 2509.25532](https://arxiv.org/html/2509.25532v2)), which matches the rows at 1.00.
  Hence M6: thresholds from measured calibration, never from the raw number.
- **Selective labels.** Outcomes exist only where the decision was taken, so accuracy over them
  misleads (Lakkaraju et al., KDD 2017). That is the `run.continuation` resolver's fault. Random
  exploration is the standard cure; applying it as a holdout here is this plan's transfer, not
  something a source describes. Hence D3.
- **Cost-sensitive thresholds.** For a calibrated probability, act when it exceeds
  `cost of a wrong act / (cost of a wrong act + cost of a missed one)`. It holds only after
  calibration. Hence rule 4.
- **Flag precision.** Vendor write-ups on AI code review put fatigue below roughly half of flags
  being actionable; the numbers are theirs and unvalidated. The gate's 0.6 is a starting point S3
  may move.

Risks of this plan:

- **Too few outcomes.** Most points resolve a handful of rows a month; a gate of 30 `direct`
  outcomes may keep them `unproven` for good. That is the honest result, and D6 covers it.
- **The holdout costs something.** A held-out `done` causes a continuation the decision would have
  saved. It is the price of knowing; D3 keeps it small.
- **Demotion surprises.** A point that drops to shadow changes behaviour without the person. It
  drops to today's behaviour, which is the safe side, and it says so.
- **The effect label is not the truth.** A continuation that edited something may have done
  needless work. The label undercounts waste; it never overcounts it.
- **State changes ask for consent again** (`run.continuation`, `health.semantic-loop`): intended.

## 13. Not in this plan

- New decision points.
- A third provider.
- The review gate's runs that end without structured output (115 USD on 2026-10-29 and 30, all 184
  reviewer runs `invalid`): tracked with the open items of
  [ci-and-regression-open.md](ci-and-regression-open.md#what-stayed-open-and-why).

## 14. How this plan is run

The owner chose on 2026-11-13 to have one Claude Code session build this plan by launching its own
subagents, instead of a Claudio orchestration. That session is the orchestrator: it decides what
runs in parallel and on which model, reviews what comes back, integrates it, opens the pull request,
gets CI green and merges. The owner publishes the release.

### Done

Each of these is checked with a command, not assumed:

1. The feature pull request is squash-merged into `main` with every CI check green.
2. Docs PR #117 is merged (rebased if needed) or folded into the feature branch.
3. release-please's release pull request for the new version is merged, only after the Release run
   of the previous push to `main` has finished, and its own checks are green.
4. A Release workflow run for that version exists and is waiting on the `release` environment. The
   session never approves that environment.
5. This plan has an Outcome section saying what was built, what differs from the plan and what
   stays open; `docs/status.md` is current; the new documents are registered with
   `kb_add_document` after the merge.
6. The session's worktrees and merged branches are removed, local `main` is fast-forwarded, and a
   final report is written in Spanish.

### The owner's decisions for this run

- **D1 to D7:** the recommended option of [§9](#9-decisions-for-the-owner).
- **D8:** no design round in this run. Only the minimum UI is built, from existing components and
  classes: a point's standing and evidence on its row, the gate's refusal, the demotion notice, and
  the net effect in place of "runs saved". The feedback surfaces of §7 are left out and recorded as
  open in the Outcome. The `claudio-ui` skill is loaded and `/ui-review` run on what is built.
- **Consent for S2:** the owner consents to sending the stored `run.continuation` and
  `changes.unexplained-hunk` states of this install to Jev under the reworded questions, through
  the engine's own provider and stored key. The key is never printed, copied or logged.
- **Merging:** the session may merge the feature pull request, #117 and the release pull request
  with `gh pr merge --squash` once their checks are green. Nothing else is pushed to `main`.

### Order of work

0. Safeguard first: copy the `decisions` rows of `run.continuation` and `changes.unexplained-hunk`,
   and the continuation labels of the review, to a local file outside the repository (read-only
   access to the data directory's `wrapper.db`). They are pruned 30 days after 2026-10-18.
1. Commit this plan on `feat/decision-engine-v2` from `origin/main`, in a worktree. Nothing is done
   in the main checkout.
2. Spike S1 by the session itself, on the real CLI with `CLAUDE_CONFIG_DIR` pointed at one
   account's directory. Its result is written into M1 before `cost-resume` starts. If the CLI does
   not behave as the review inferred, that task stops and the owner is told.
3. Waves (each task owns its files; two agents never edit one file):
   - Wave 1 in parallel: `cost-resume`, `evidence`, `silent-points`.
   - Wave 2 in parallel, once `evidence` is integrated: `lifecycle`, `replay`, `continuation`,
     `supervisor`.
   - Then S2 and S3 with the replay harness. S2 decides: if the three-answer question does not
     clearly beat the phrase list on the labelled rows, `run.continuation`'s decision is retired
     (the phrase list stays) instead of shipped, and the numbers are recorded.
   - Wave 3: `health-points`, `web`.
   - Wave 4: `docs`, then `review` on the integrated branch.
4. The session integrates each wave itself: it merges the task branches, resolves conflicts by
   reading both sides, runs `verify` (lint, typecheck, test, ci-checks) and reads every diff before
   the next wave starts.
5. Before the pull request: the whole e2e suite once, `verify` with gates `["e2e"]` and no
   `extra_args`, run alone (never beside `test` or `ci-checks`).
6. The pull request (`feat:` title), CI watched with fail-fast, causes fixed.
7. The merge, then the release sequence of Done 3 and 4.

### Agents

- **Models.** Never Fable. Opus for `cost-resume`, `evidence`, `lifecycle`, `continuation`,
  `supervisor` and `review`; Sonnet for `replay`, `health-points`, `silent-points`, `web` and
  `docs`; Haiku only for mechanical chores. The `developer` agent type where it fits, each in its
  own worktree branched from the feature branch.
- At most three agents at once, all in the background; the session stays in contact with
  `SendMessage` and answers their questions from this plan.
- Each agent is briefed like a peer: this plan's path and its section, the files it owns, what the
  earlier waves decided, the checks it must pass, and that it commits and never pushes.
- An agent's report is not taken as fact: the session reads its diff and reruns its checks before
  integrating. A task that comes back wrong is sent back with the specific defect.

### Rules

- `CLAUDE.md` and `CONTRIBUTING.md` are read first; this plan is the source of truth for the build.
- Gates only through Sluice's `verify`, never the shell. Every wait is bounded. `E2E_ALLOW_LOCAL`
  and `SLUICE_JOB` are never set, and no merge train is approved.
- A red CI is diagnosed and fixed at its cause, starting with the first failed check. It is not
  rerun to get green; one rerun is allowed only for a failure shown to be the runner's.
- The owner's running app is read-only: its data directory is never written, its settings never
  changed, it is never restarted. The four terminal specs cannot run from an agent on this machine;
  they run in CI.
- The owner gets a short status in Spanish after each wave: what merged, what failed, what is next.

### Amended by the owner on 2026-11-13, during wave 1

From wave 2 on, agents do not run a verification phase: no `test`, `ci-checks` or `e2e` gate. They
run only what the commit hook demands (`lint` and `typecheck`, about half a minute). The session
integrates each wave the same way. Once everything is implemented, the owner and the session do the
whole verification together (every gate, the full e2e suite and a QA pass) before the pull request
is opened. Wave 1 (`cost-resume`, `evidence`) had already started under the earlier rule.

### When the session stops and asks

Only when a decision outside D1 to D8 would change what the product does for the person; when S1 or
S2 contradicts the plan in a way that removes more than one task; when a check fails for a reason
it cannot fix after diagnosing it; or when something needs the owner's hands (a setting, a
credential, the release environment).

## Related

[[decision-engine.md]] · [[decisions/decision-engine.md]] · [[decisions/jev-shadow-review-first-day.md]] · [[plans/decision-engine.md]] · [[orchestrations.md]] · [[team-and-flow.md]] · [[settings.md]] · [[plans/agent-observability.md]] · [[design-system.md]] · [[status.md]]
