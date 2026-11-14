---
created_at: 2026-11-13T16:30:00Z
updated_at: 2026-11-14T00:00:00Z
tags:
    - plan
    - decisions
    - decision-engine
    - jev
    - metrics
    - orchestration
---
# Plan: a decision engine that earns its place

Status: **landed** in #122 on 2026-11-13. Was: **built** on `feat/decision-engine-v2`, not merged yet. See the
[Outcome](#outcome). Was: **proposed** (2026-11-13). Nothing here is built. The owner's choices are listed in
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
  **Run on 2026-11-13.** The set: 211 rows where Jev acted `owes-work` and the continuation it
  caused was found in the worker's transcript; the label is "that continuation edited or
  committed" (59 yes, 152 no, a base rate of 0.28). The CLI arm ran before the harness existed
  (one-shot `claude -p --json-schema`, 0.34 USD); the Jev arm ran through
  `scripts/decisions-replay.mjs` with `--no-store` (about one cent).

  | Who answers | Continuations asked for | Productive | Precision | Recall |
  | --- | --- | --- | --- | --- |
  | Jev as it ran (current question, threshold 0.85) | 211 | 59 | 0.28 | 1.00 |
  | Current question, CLI `haiku` | 131 | 35 | 0.27 | 0.59 |
  | Three answers, CLI `haiku` | 12 | 4 | 0.33 | 0.07 |
  | Three answers, Jev (any confidence) | 64 | 21 | 0.33 (lower bound 0.26) | 0.36 |
  | The phrase list | 0 | 0 | – | 0 |

  Every arm's precision sits at the base rate: the last paragraph of a report does not say whether
  a continuation would change anything, whoever reads it and however it is asked. Jev's confidence
  on the current question runs backwards (accuracy 0.55 between 0.80 and 0.90, 0.23 at exactly
  1.00). The three-answer question asks for far fewer continuations and chooses them no better. So
  the decision does not beat the phrase list: `run.continuation` ships with the three-answer
  question for whoever wants to measure it in shadow, the code rules of §6 hold regardless, and the
  gate of §5 keeps it from acting (its replay over this set is `failing`). Limits of the test: the
  set holds only rows Jev was confident about, and "edited or committed" overstates what was
  needed.
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

## Outcome

Built on 2026-11-13 on `feat/decision-engine-v2` by one Claude Code session that launched the tasks
of [§11](#11-tasks) as subagents, in the waves of [§14](#14-how-this-plan-is-run). The feature page
is [decision-engine.md](../decision-engine.md), which describes what the code does now.

### What was built

- **`cost-resume` (M1).** The CLI's totals are the session's: a spawn that resumes goes on from the
  session's last report, which the chat's record keeps (`reported`), a fork starts from its source's,
  and only a session that starts new starts from zero. An execution's `costUsd` is what its own
  turns cost. A migration recomputed the stored executions of chats whose costs only grow; the spend
  ledger was left alone and the `cost_corrections` table dates the fix. The fake CLI reports totals as
  S1 found them. See [cli-surfaces.md](../cli-surfaces.md#how-a-resumed-or-forked-session-is-billed).
- **`evidence` (M2, M3, M4, M6).** `decisions.baseline`, `run_effect` and `held_out`; every resolver
  says `direct` or `proxy`, and `run.continuation`, `health.semantic-loop` and `supervisor.intervene`
  were rewritten; stats answer runs saved, caused and their net; `pointEvidence` returns the
  precision with its 90 % lower bound, the baseline comparison, calibration buckets and the act
  rate; shared types and OpenAPI. A non-acting `run.continuation` row is resolved only when today's
  rule really sent a continuation.
- **`lifecycle` (§5).** Standing (`unproven`, `proven`, `failing`) from live outcomes and the latest
  replay, the write gate and the refusal of bulk activation, the holdout (10 % of the first 100 acts,
  then 5 %), demotion with its event and notification, the suggestion floor (0.7 by default) and the
  `limitedBy` reasons. The break-evens are 0.7 for `checks.fix`, `review.depth` and
  `orchestration.retry`, 0.6 for `flow.refine-needed`, `flow.restart`, `orchestration.fixer` and
  `run.continuation`, and 0.5 for the rest.
- **`replay` (M5).** `replayDecisions`, a runner behind `POST /decisions/replays` (consent, one per
  point, 30 minutes or 1 US$), the golden set's routes and `scripts/decisions-replay.mjs`, which drives
  the CLI directly and reads the database read-only.
- **`continuation` (§6).** The three-answer question at state version 2, the effect recorded per
  continuation (`continuationEffects`, `flow_runs.continuation_effects`) and the code rules:
  at most one decision-driven continuation per run, none after one that changed nothing, and none
  unless every earlier effect is on record.
- **`supervisor` (§6).** The draft is structured (`{ stuck, hint }`) and decides first; a draft that
  says "not stuck" is kept as the proposal status `not-stuck`; a hung command is timed on its own
  clock per call, against its kind's history; `supervisor.autoSignals` lists the kinds it may send on
  its own; `supervisor_proposals.sent_by` records who sent a hint.
- **`health-points` (§6).** `health.semantic-loop` is asked only when at least 3 of the last 12 calls
  are near-identical (8 finished calls at least), never twice on the same state, backs off after 3
  "no" in a row (40 calls), and sends tool name, digest and a target of at most 80 characters, at state
  version 2. `changes.unexplained-hunk` is not asked about a hunk with no sentence before it. The
  resolvers' sweep is fair per point, with a cursor. Labels are taken before the prune. A miner that
  proposes nothing is a `direct` "wrong" for `lesson.mine`. Hung-command durations use the per-call
  clock.
- **`silent-points` (§6).** An audit, no code changed: see the table below.
- **`web` (§7, as D8 left it).** A standing tag and an evidence line on each point's row, the
  sentence for why a point is limited, the demotion line, Active disabled with its reason, the floor
  slider for suggest points under Jev, the refusal alert in the save bar, the warning toast, the
  Usage line with the net, and the Supervisor's signal kinds as a folded list of checkboxes. `en` and
  `es` copy.
- **`e2e-gate` (added).** See below.
- **`docs`.** The feature page, what leaves the machine, the cost pages, the continuations,
  Settings, the REST table, the e2e helper, the decision record's amendments and this Outcome.
- **`review`** reads the merged branch against this plan after `docs`; its findings are not in this
  Outcome yet.

### What differs from the plan

- **The gate applies to act points and to the suggest points that start a run** (`lesson.mine`), as
  D1 recommended; the other suggest points are switched with a warning. §5 read as if every point
  needed standing.
- **The Supervisor is exempt from the write gate and has `autoSignals`.** `supervisor.intervene` is
  two things in one mode: whether the Supervisor may send on its own, and whether Jev's question may
  decline a hint. Under the CLI it asks the engine nothing and could never earn evidence, so refusing
  the write would leave no way to switch it on (`WRITE_EXEMPT` in `standing.ts`). §6 had it send on its
  own "only for signal kinds that are proven" and Jev's answer used "at the threshold M6 gives the
  point, per signal kind"; standing is per point, so what was built is an owner's list of kinds, empty
  by default, and the run-time gate on the Jev question as for any act point.
- **`run.continuation` is kept, and cannot be promoted after S2.** The three-answer question ships
  for whoever wants to measure it in shadow, the code rules hold whatever it answers, and its replay
  over the S2 set is `failing` ([§10](#10-spikes-before-building)).
- **An extra task, `e2e-gate`.** The gate makes `PUT /decisions/settings` refuse an act point without
  proof, which broke the specs that switched a point to `active`. The task wrote
  `e2e/specs/decision-proof.mjs` (consent, import labelled states, replay on the fake CLI, activate),
  made `lessons.spec` earn the gate (timeout 420 s), and taught the fake CLI to answer a replayed case
  and the Supervisor's draft. Nothing of it has run.
- **Calibration is reported, not used.** §4 M6 had an act point's threshold read from its table and a
  flat table block promotion; the threshold stays the owner's setting and the gate reads the lower
  bound of the precision.
- **Retirement (§5) is not built:** no listing of points with "no evidence possible" (D6 said to list
  them and leave them `off`; nothing is removed).
- **The tokens of the runs a decision caused (M4)** are not summed; the net counts runs.
- **The history keeps 30 days.** §3's 90 is the owner's setting and the code's default did not
  change; what the review needed from the old rows is the golden set, which outlives the history.

### The 19 points that never asked

The audit of `silent-points` read the owner's install. Sixteen of the 19 were silent because the
feature they hang on was never used there, not because a call site is dead:

| Why | Points |
| --- | --- |
| The Team flow was never used: `flow_runs` has no row and no project has a flow or team block | 13 |
| The planner and the assistant were never used: `plan_drafts` and `assistant_runs` are empty | 3 |

`journal.relevance` is reachable only from the flow and `orchestration.model` only from the planner.
`notification.urgency` is never asked either, because no push subscription was ever stored. What the
audit could not determine from the data: whether the palette was used, whether the import dialog was
opened or Suggest pressed, and whether review threads exist on orchestration pull requests. It found
`context.compact` documented as shipping `off` with nothing in the code to say so (every point is
off by default; the page now says that) and proposed that a point that is active without a valid
consent, which returns without a trace, leave one (a counter or a row), so that a silent point shows
in the stats: not built.

### The spikes

- **S1** is in [M1](#m1-cost-on-a-resumed-session): totals are cumulative over the session, across
  processes, and a fork starts from its parent's.
- **S2** is in [§10](#10-spikes-before-building): no arm beats the base rate of 0.28.
- **S3, the gate's numbers.** The one-sided 90 % Wilson lower bound, which is what the gate compares
  with the break-even, by observed precision and number of cases:

  | Cases | 0.60 | 0.70 | 0.75 | 0.80 | 0.90 |
  | --- | --- | --- | --- | --- | --- |
  | 20 | 0.46 | 0.56 | 0.61 | 0.66 | 0.78 |
  | 30 | 0.48 | 0.58 | 0.64 | 0.69 | 0.81 |
  | 50 | 0.51 | 0.61 | 0.66 | 0.72 | 0.83 |
  | 100 | 0.54 | 0.64 | 0.69 | 0.74 | 0.85 |

  At the default 30 cases a point with a break-even of 0.5 needs 19 right (0.63), one of 0.6 needs 22
  (0.73) and one of 0.7 needs 25 (0.83), so 30 is a real bar and not a formality; more cases lower
  it slowly, and below 20 almost nothing clears. `minCases` stays 30. On its 211 labels,
  `run.continuation` with the three answers on Jev got 21 of 64 right (0.33, lower bound 0.26), under
  its 0.6: `failing`.

### The review and its fixes

An independent review of the integrated branch found six defects to fix before merging and several
lesser ones. They were fixed in two branches, `de2/fix-core` (the engine and the Supervisor) and
`de2/fix-edges` (the API, the web and the replay script), and merged into the feature branch. Each in
one line:

- **A "not stuck" draft closed its occurrence for good.** It is now drafted again on the same row after
  a back-off (a running command's running time doubled since the answer, else an hour), at most four
  drafts per occurrence, and the monitor wakes the Supervisor again every five minutes while a chat
  stays `bad`; an occurrence the engine declined waits an hour too (`supervisor_proposals.asks`).
- **A replay could keep a point proven that was failing live.** Live evidence now decides once it has
  the gate's cases and a replay only bootstraps; `decidedBy` (`live` or `replay`) is served and shown on
  the row.
- **A failing point was demoted only if it carried a promotion mark.** `review()` now demotes any active
  point whose standing is `failing`, marked or not; the rate rule still needs the mark.
- **A replay counted for any provider.** It now counts only for the provider the point runs on and, for
  Jev, the pinned model.
- **Two resolvers graded what their own act caused.** `flow.bounce` and `notification.urgency` are
  `proxy` when the row acted, and `direct` only on a shadow or held-out row.
- **Any chat could rate a decision, which is a `direct` outcome for the gate.** `POST
  /decisions/:id/feedback` is a person's: a chat's token gets `403`.
- **A replay whose cases fell back to their labels' questions could still count.** Such a case is
  counted in `fallbackCases`, the run is stored under the hash of what was actually asked and never
  counts for the gate (`decision_replays.fallback_cases`).
- **The Supervisor's point could be demoted**, which would turn off its hints: it is exempt, as it is
  from the write gate.
- **The holdout counted acts of an earlier time in Active:** it counts since the promotion mark.
- **`health.semantic-loop` asked again on every call** while the same three calls sat in the window: it
  hashes the repeated group and its count bucket, and the chat remembers every repetition it has put.
- **The command clock hid a command for good** behind an earlier call whose result was lost or that
  ran for hours: a serial call that answered after it releases it, and a hold ends after two hours.
- **No point said that no outcome could prove it.** `evidencePossible` is served and the row says so
  (D6); and the replay script runs confined like the engine's chat, with no Claudio address or token.
- **The web.** The gate reads the saved mode (a point saved as Active keeps Active available), a bulk
  Active plans only proven points, a note says how many points run as Shadow for now, and a project's
  refusal says when a point would inherit a global Active.

What the review listed and was **not** fixed stays open:

- Forks billed before the upgrade stay overbilled, and the cost stored in an orchestration's and a
  task's own record is not recomputed.
- A session that starts anew but reports more than the old baseline.
- The first turn's tokens after the upgrade, for older chats.
- Standing is recomputed more often than needed.
- Thresholds and floors are not read from calibration, and a flat calibration does not block promotion.
- Labels that come from a person's feedback alone.
- No demotion case in the browser spec.
- Older unresolved rows of the Supervisor's point may find no proposal after a redraft.

### Open

- **The feedback surfaces of §7** (a tap on a continuation's row and on a task row, on the
  Supervisor's hint row and on every flag, and a "label ten" queue) are not built (D8). A person
  labels a row only through the API.
- **The floor has no slider on a project's row**, and a project write that activates a point drops
  the gate's warnings (only the refusal reaches the person); a project's activations are not watched
  by demotion.
- **Cost.** A session born outside Claudio has no cost baseline (the CLI writes a `cost-state` line
  into the transcript that nothing reads), so its first billed turn carries its history; the tokens of
  the first turn after restoring an old chat count from zero; a fork with `--resume-session-at` and a
  resume under another account were not checked on the real CLI; the migration could mis-recompute a
  chat of two executions whose costs grew by chance on an old CLI.
- **Labels carry no state version.** A label made under a point's earlier state shape is replayed
  against the current one.
- **`supervisor.autoSignals` has no row in the settings registry**, and the deprecated
  `PUT /settings/supervisor` is not gated. A `no-progress` stretch that never ends is asked about once
  and never again.
- **Resolvers.** `health.semantic-loop` has no direct "wrong" until the web posts a dismissal; the
  audit actor `local` counts as a person; `run.continuation` rows where no continuation followed stay
  unresolved by design. A decision-only continuation needs an earlier effect on record for every
  continuation, a phrase-only continuation keeps its 3 (nothing to cut it on), and the first turn's
  `turn.commits` is approximate.
- **Baselines.** Twelve points pass none ([decision-engine.md](../decision-engine.md#other-points-the-second-plan-changed)),
  so their rows have no comparison.
- **Calibration does not set a threshold**, and the tokens of caused runs are not summed.
- **The Decisions screen against an older remote server.** The draft tolerates settings without the
  Supervisor's options; the rows read `gate`, `standing` and `effective.limitedBy`, which a server
  from before this plan does not send.
- **A test file whose process dies is not a failure.** Across the verification runs the web suite
  reported 2,212 tests twice and 2,189 once, and core 4,460 once and 4,492 otherwise: a file's output
  was cut and the runner counted nothing against it. Not shown to be this branch's; it means a green
  run can have skipped tests.
- **`claudeRunsSaved`** is a deprecated alias of `runsSaved`, kept for one release.
- **A point active without a valid consent** leaves no trace and so no row in the stats.

### Verification

By the owner's choice no task ran the `test`, `ci-checks` or `e2e` gates from the second wave on; only
`lint` and `typecheck` ran on each merge. The whole verification was done once, on the integrated
branch, on 2026-11-13:

- **The first full run** stopped in core: 5 failing tests of 4,491, and the api suite, which runs
  after core, had never run. Of the five, three were tests left behind by a later task's deliberate
  change (the suggestion floor on `team.assign`, the wording of the Supervisor's prompt, a source
  check that did not survive the test loader's quoting) and two were defects in
  `health.semantic-loop` that only a run could show: digits were flattened in file paths, so nine
  different files read once each counted as one repetition, and the back-off after three "no" never
  counted answers in shadow or under the floor. The api suite then failed in four places, all seams
  between tasks: nine label and replay types missing from the OpenAPI components, five new write
  routes without their audit line, and one test that still listed the feedback route as open to a
  chat's token. One web test failed on settings without the Supervisor's options.
- **The final run**, on the tree with those fixes: `lint`, `typecheck`, `ci-checks` and `test` pass
  (shared 314, accounts 99, ui 53, chat-ui 156, web 2,189, core 4,492 with the 120 known guard
  bypasses recorded as todo, mcp 70, api 848, desktop 198), and the `e2e` gate with no prefix passes
  all 105 spec files in 24.6 minutes.
- **Not verified by a run:** the paths listed under Open as unchecked on the real CLI, and a
  migration of the owner's own database (the migrations are tested from a database written before
  them, on fixtures).

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
