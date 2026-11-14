---
created_at: 2026-09-29T00:00:00Z
updated_at: 2026-11-14T12:00:00Z
tags:
    - orchestration
    - planner
    - guide
    - performance
    - convention
---
# Writing an orchestration graph

How to shape the tasks of a graph orchestration so it finishes early. It applies to a graph written
by hand (a plan in `docs/plans/`, the launch form, "Edit and relaunch") and to the planner, whose
prompt carries the same rules (`PLANNER_GRAPH_GUIDANCE` in `packages/core/src/orchestrator.ts`).
The rules hold for any repository Claudio drives; names such as `pnpm` or `types.ts` below are only
examples.

The measurements behind it are in [plans/orchestration-speed.md](plans/orchestration-speed.md):
effective parallelism of 1.4–1.6 at a concurrency of 3–4, and every recent graph shaped
`types → core → web → web-review → docs`.

## The rules

### 1. Stages in series are the cost: at most four

The task phase lasts as long as the longest chain of dependencies, not the sum of the tasks: tasks
on different branches of the graph run side by side, tasks on one chain wait for each other. So the
number to watch is how many tasks run one after another. Aim for **four or fewer**.

The launch form and the graph editor show it under the task list: "3 stages in series · survey →
build → docs". Above four stages they add a neutral notice. It is a hint, never a block: a graph
that really needs five stages still launches.

### 2. No stand-alone `types` task

A task that only writes the shared types or the route shapes (8–15 min) holds back every other task,
because all of them depend on it. Instead:

- write the contract (the type names and fields, the route and its body) **in the plan or in the
  task prompts**, so the core and web tasks start in parallel against it; or
- **fold it into the first core task**, and let only the tasks that truly need the generated
  artefacts (an OpenAPI schema, say) depend on that task.

### 3. `docs` runs beside `review`, not after it

A documentation task describes what was built, so it depends on the **implementation tasks**, not on
the review task. That turns the `review → docs` tail, which added 25–50 min to every graph, into two
tasks that run at the same time. When the synthesis writes the Outcome anyway, drop the `docs` task.

### 4. `review` does not re-run the suite when verification is on

With verification on, the verification phase runs the full suite on the merged branch after the
tasks. A review task that runs it again spends its time on a result nobody reads. Its prompt says it
reviews the design, the conventions and what the checks cannot see (copy, naming, a missed case),
and runs at most the one test it wants to read.

With verification on, Claudio also adds one task to the end of the graph, `e2e-specs`: it depends
on every other task, so it starts from their combined work, and runs only the browser specs that
work touches, each alone on a port of its own, fixing a spec the work left stale before the merge.
Workers run none (CW-15). The planner does not write that task, and a graph that names one keeps its
own; `verification.e2eSpecs: false` leaves it out.

### 5. `sonnet` for prose-only tasks

A task that only writes prose (documentation, changelog-style notes) sets its `model` to `sonnet`:
it is faster and cheaper, and writing about finished code does not need the stronger model. Every
other task leaves `model` out and runs on the graph's. A task's `effort` works the same way: left out,
it runs on the graph's, then on the recommendation for the model (see [effort.md](effort.md)); on
the `workflow` engine only the graph's effort applies.

### 6. Name the files and routes in each task prompt

A worker starts in a fresh worktree with none of the planner's context. A prompt that names the
files, modules and routes it touches (`packages/core/src/orchestrator.ts`, `GET /orchestrations/:id`)
saves the turns the worker would spend finding them, and keeps two parallel tasks off the same file.

### 7. Cite one pattern per convention

A task that adds or changes code names, for each convention its worker must follow (naming, error
handling, data access, tests), one real example as `path:line` that the author read, or says that
the code has none. A worker that is shown a pattern copies it; one that is only told the convention
invents its own, and two parallel workers invent different ones. The line number is a pointer for
reading, not a contract: the worker opens the file and finds the pattern by name. Never cite a place
you have not opened.

## A worked example

The usual shape, five stages in series:

```
types → core → web → web-review → docs
```

Rewritten with the rules above, three stages:

```
core ── web ─┬─ web-review
             └─ docs (sonnet)
```

- `types` is gone: its contract is written in the prompts of `core` and `web`, and `core` owns the
  `types.ts` change and the generated schemas.
- `web` depends on `core` only because it needs the generated schema; if it can build against the
  contract in its prompt, it starts with `core` and the graph drops to two stages.
- `docs` depends on the implementation (`web`, and through it `core`), not on `web-review`, and
  runs on `sonnet`.
- `web-review` reviews the design and the copy; verification runs the suite on the merge.

The hint reads "3 stages in series · core → web → web-review", with no notice.

## Guards

Workers, the integration, the synthesis, the verification fixer and the workflow engine run with
[guards](guards.md) when `automated` is on (the default). The planner does not. A graph can carry
`guards: { enabled?, rules? }`, set in the launch form's *Rules* sheet, which stores only what
differs from the global settings; `integrity` cannot be switched. A worker's guard root is its task
worktree. If a guard cannot run, the task fails before any CLI starts with
`guard-unavailable (<problem>): could not start the worker: …`. A task that was blocked shows an
"N blocked" chip that opens its chat at the first notice.

## The review gate

A graph can opt in to a review that fails closed. It is off by default and costs nothing for a graph
that leaves it out. The full design is in [plans/review-gate.md](plans/review-gate.md).

- **The spec.** `verification.review` (`ReviewGateSpec`) in the graph's spec. Present means on.
  `commands` may then be empty. `/verify` validates every bound and answers `400` for one out of
  range:
  - `dimensions`: `correctness` always runs; `tests` (default on), `security` (`auto`, `always` or
    `off`; `auto` runs when a changed path or an added line matches a trigger) and `conventions`
    (default on when the base commit has `CLAUDE.md`, `CONTRIBUTING.md` or `.claude/rules`);
  - `depth`: `light` or `full` (`full` unless the `review.depth` point chooses;
    `light` runs correctness, plus security when triggered, with chunks twice as large; see
    [decision-engine.md](decision-engine.md#reviewdepth));
  - `fixer` (default on), `maxFixRounds` (default 2, 0–5), `maxCostUsd` (default 5, over the whole
    gate), `maxRunCostUsd` (default 1), `timeoutMinutes` (default 15, 1–60), `concurrency` (default
    3, 1–6), `models` (reviewer `sonnet`, verifier `opus`, fixer the verification's or the graph's)
    and `exclude` (globs added to the built-in exclusions).
- **Where it runs.** Inside verification, after integration and only after the checks pass, on the
  integration branch's diff against the graph's base commit. A review taken before the checks would
  miss the check fixer's commits.
- **A round.** Claudio collects the diff and runs its own scans (conflict markers, committed
  secrets, text addressed to an agent). The secret scan matches credential-shaped values (known key
  and token prefixes, private key blocks, JWTs, generated-looking literals assigned to a
  secret-named key), never a bare name or a type annotation; a hit in a test or a fixture is
  advisory. Each chunk is sized so its reviewer run's estimate fits under `maxRunCostUsd`: a larger
  one is split at hunk boundaries, and a single change that alone would cost more is not
  reviewable, with that reason, and is never sent. One reviewer per dimension then reads the diff as untrusted
  data, read-only and under a budget, and returns findings that match a schema. Claudio
  deduplicates them and anchors each to a line, the file, or "outside" the diff. Every critical or
  high finding goes to a separate verifier whose default answer is `refuted`.
- **What blocks.** A finding of high severity or more that is `confirmed` or `uncertain`, and the
  deterministic ones. The rest is advisory.
- **Checks after a fix.** The check fixer's fix is tested by running the check that failed first, on
  its own (with the install step ahead of it if the fix touched a lockfile or a `package.json`). A
  fix that did not mend it goes back to the fixer at once; one that did sends every check through
  again from the first. Those quick re-checks show in the timings ([[orchestration-timings.md]]).
- **The fixer loop.** A blocking review goes to a fixer, every check runs again from the first, and
  the review runs again, up to `maxFixRounds` fixer rounds (so at most `maxFixRounds + 1` reviews).
  The loop stops early when a fix makes the review worse, when the gate's budget is spent, or when
  `fixer` is false.
- **Statuses.** `ReviewGateState.status` is `pending`, `running`, `passed`, `blocked`,
  `incomplete`, `accepted` or `skipped`. A reviewer that crashes, times out, overspends or answers
  outside the schema, or a file that could not be reviewed, makes the round `incomplete`; a run
  that ends well without structured output counts as failed, never as "no findings", and its
  failure names the CLI's stop reason. A round where reviewers ran and none gave a usable answer
  ends `incomplete` with that reason even when a scan blocks: no verifier is asked and the fixer is
  not called, since a fix of the scans' findings alone would pay for a round that fails the same way.
  `VerificationStatus` has no new member: a gate that is blocked or incomplete makes the
  verification `failed` with `gate: 'review'` (`'checks'` otherwise).
- **It holds the pull request.** When the gate is on and is neither passed nor accepted, the
  pull request is held, whatever `failGraph` says. `failGraph` still decides only the graph's own
  status.
- **Skipping.** A re-run skips the gate only when the checks passed on the head and the review
  passed or was accepted on that same head. A restart or a stop ends a running review as
  `incomplete`.
- **Retry and accept.** `POST /orchestrations/:id/review/retry` runs the gate again. A person may
  accept a blocked or incomplete gate with `POST /orchestrations/:id/review/accept` and a written
  reason. An `incomplete` gate is accepted only after a retry also ended `incomplete`. The
  acceptance is bound to the head it was given on: a new commit voids it. A chat's token gets
  `403` on accept ([security-model.md](security-model.md#the-review-gate)).
- **Reviewer roles.** Each dimension's reviewer (and the verifier) has a role file in the project,
  `.claude/agents/claudio-review-<role>.md`, read from the project checkout and never from the
  integration branch. It says what to look for; Claudio supplies the rules, the tools and the
  model. `GET /projects/:id/review-roles` lists them and `POST /projects/:id/review-roles/:role`
  writes the built-in text for a person to edit, never over an existing file.
- **Where it shows.** The graph form, the verification card (the head, the reason, the runs, the
  findings grouped with the blocking ones open, **Retry** and **Accept anyway**), the findings as
  cards under their lines in the integration diff, and the verification step of the pipeline.
- **Cost.** The estimate of a round is checked before anything starts; one over `maxCostUsd` stops
  the gate as `incomplete` before spending. Measured costs are in the plan's
  [Outcome](plans/review-gate.md#outcome); the review's time is in
  [orchestration-timings.md](orchestration-timings.md#what-is-recorded).

## A task that ends on a report with work still owed

A worker is sent back to its own chat, up to `MAX_CONTINUATIONS` (3) times, when its turn ended with
something owed. A continuation has one of three **causes**, and the task records each one with its
effect (`continuationEffects`: `cause`, whether the turn that followed `changed` anything, its
`commits` and `edits`):

| Cause | What sends it | Held to |
| --- | --- | --- |
| `structural` | A fact the code reads: no structured result, uncommitted paths in the worktree, delegated work still running | `MAX_CONTINUATIONS` only; no decision can waive it |
| `phrase` | The phrase list matched the last paragraph: an offer to continue, a question nobody will answer, a next step announced, "waiting for" delegated work | `MAX_CONTINUATIONS` |
| `decision` | The `run.continuation` point read a step of the worker's own task as owed (`owes-own-work`) and no phrase caught it | **One per run, and none after a continuation that changed nothing** |

The rules for a continuation owed only to the decision are code, whatever the decision answers
(`decisionMayContinue` in `packages/core/src/open-items.ts`): at most one per run; none once any
earlier continuation changed nothing; and none unless every earlier continuation has its effect on
record, since one whose effect is unknown could be either. What such a continuation says is one
sentence, to take the step if one is owed and otherwise to answer "nothing is owed" in one line, and
when it changes nothing the report before it stays the task's result. A `done` or `hands-off`
answer that acted waives the phrase list for that turn. Why: on one install, 223 of 226 continuations
were sent on the decision's word alone and 164 changed nothing
([plans/decision-engine-v2.md](plans/decision-engine-v2.md)). The decision and its evidence are in
[decision-engine.md](decision-engine.md#runcontinuation).

## A task held at a usage limit

A graph task whose turn dies at a usage limit is not failed: the rotation moves its chat to an
account with room, or holds it in a wait for the reset, and the task stays `running` with the
wait (`LimitWait`) on it ([accounts.md](accounts.md#choosing-and-switching)).

- **A wait goes on with the first account that has room**, not only at the reset it began with
  (R10): every change of an account's reading or state, every reset and every poll makes it look
  again.
- **The ways out are two**, at the task's foot: "Stop waiting" ends the task `stopped`, and "Run
  now" sends the turn on at once on an account with room (`POST /limits/waits/:id/run-now`).
- **A stopped task has its way back** (R11). Retry, Retry clean and Skip branch take a `stopped`
  task as they take a `failed` one (`retryTask`, `retryTaskClean`, `skipTask`), and the blocked
  tasks behind it name it. Before, the only way out was to stop the whole graph and resume it,
  which interrupts its running tasks.
- **A graph that waits for a decision can be resumed whole** (`resume`, the page's menu): every
  task it waits on goes on, in its chat, as for a stopped graph. It is refused while one of those
  tasks' chats is still working (a person went on in it by hand).
- **The graph's other steps take the same path** (D7 of
  [plans/limit-resume-and-credits.md](plans/limit-resume-and-credits.md)). The integrator, the
  synthesis, the verification's fixer, the checks fix of a pull request, and the review gate's
  reviewers, verifier and fixer are the graph's work too (`workOf` answers `<graph>:__integration__`,
  `__synthesis__`, `__verification__`, `__checks-fix__` or `__review__` while the step awaits its
  chat). At a limit the chat moves to an account with room, or waits for the reset, with the bounds
  of a task's wait, and its turn is replayed in the same chat: each of these chats keeps its session,
  and a step's turn is as safe to replay as a task's. While one waits, the graph says so:
  `stepWaits` on `GET /orchestrations/:id` (role, chat and the `LimitWait`, worked out when it is
  read), and the review gate's `waiting` as before.
  - **A wait that ends with no replay ends the step's hold** (a person stopped waiting, the wait ran
    out, or the rotation let go of the limit without a wait): the step takes the limited result, with
    why, instead of waiting for a turn that is not coming. The review round ends `incomplete` and can
    be retried, a verification or review fixer stops the checks there (another attempt would meet
    the same limit), the integrator's error is the integration's, and the synthesis reports it failed.
  - **A stop ends the waits of its steps**, and a restart closes them (`cancelled`): a step does not
    survive a restart, and its replay would be for nobody.
  - **The planner is no step of a graph.** It runs before the graph exists, with no session to resume
    (`internal`), and ends at a limit with the CLI's text, which names the reset (D6); a plan started
    after it goes to an account with room.
- **Tests.** `packages/core/test/orchestration-limit-way-back.test.ts` (the R11 cases, and a turn
  replayed while the limited process was still exiting),
  `orchestration-limit-steps.test.ts` (each kind of step moved, waited for and resumed, a wait that
  ends for good, a stop, a graph with no limit, and the planner),
  `orchestration-limit-account-switch.test.ts` (a task moved to another account at its limit goes on
  in one attempt, and the execution that hit the limit keeps its cause, which a replay writes before
  it stops the process so `limitedTail` still knows the account after a restart),
  `accounts-rotation.test.ts`, and
  `apps/web/test/orchestration-board.test.ts`.

## The workflow engine

A graph with `engine: 'workflow'` runs as one Claude Code session, the *lead*, which calls the CLI's
Workflow tool with a script Claudio generates from the graph (`compileWorkflow` in
`packages/core/src/workflow-engine.ts`). One agent per task, labelled with the task id, and a
synthesis agent labelled `synthesis` in phase `Synthesis`. Launch, following and settling are in
`packages/core/src/orchestrator.ts` (`launchWorkflow`, `followWorkflow`, `finishWorkflow`). Since
R15 ([plans/workflow-engine-limits.md](plans/workflow-engine-limits.md)) it follows its journal,
holds or rotates at a usage limit, and is never left running unwatched.

- **Task states come from the journal, live.** The CLI writes
  `<CLAUDE_CONFIG_DIR>/projects/<cwd-slug>/<sessionId>/subagents/workflows/<wf run id>/journal.jsonl`
  as each agent starts and ends (`launched`, `started`, `result`, `failed`, with `key`, `agentId`,
  `label`, `phase`). Claudio learns the run id from the new `wf_*` directory and reads the journal
  every second (`readJournalTasks` in `packages/core/src/workflow-journal.ts`): `started` → running,
  `result` → completed with the agent's whole answer, `failed` → failed with the last thing the
  agent said (read from its transcript, `readAgentEnd`). A key's latest line wins, so a call
  resumed from the cache under the same key replaces its failed attempt. The synthesis agent's
  entry drives the graph's synthesis times and final report. The script's final result
  (`readCompiledResult`) still settles what the journal never mentioned (skipped tasks, an agent
  that returned nothing). The stream's own progress was seen to miss an agent the API refused;
  the journal does not.
- **A usage limit is held or rotated, for the whole graph.** An agent refused with a 429 (or a 401)
  is recognised from its transcript's structured fields (`apiErrorStatus`,
  `rate_limit_info.resetsAt`, `rateLimitType`), never from its wording (`journalRefusal`); the
  lead's own limit is read from its stream as for any chat. Either way the lead is handed to the
  [rotation](accounts.md#choosing-and-switching) as automated work (`workOf` answers
  `<orchestration>:__workflow__`): the account is marked, the lead stopped, and the rotation moves
  the session to an account with room, or opens a wait with the reset time. The run then goes on
  by resuming the workflow from its cache in the same session (`resumeFromRunId`, through
  `Orchestrator.replayWorkflow` → `ChatManager.replayWith`), never by replaying the lead's turn,
  which would start it over. Every account's `projects/` points at one directory, so the cache is
  there whichever account resumes it. The refused agent stays `running` meanwhile, not failed.
- **While it waits** the graph stays `running` and the wait (`LimitWait`) sits on its running
  tasks; `waiting` keeps meaning "a person decides". A wait that runs out or that a person stops
  ends the graph `failed` or `stopped`, with the reason in `orch.error`, and stopping the graph
  releases the wait. One replay is allowed per limit; a completed task resets the count, so a later
  limit is a new one.
- **A watchdog.** A running workflow graph always has a live lead, an open limit wait, or a launch
  under way:
  - the run's record or stream says the workflow ended but the lead is still up: it is given 60 s
    to say its one line, then stopped (`reapLead`);
  - the lead is gone before the workflow ended: the graph settles, and what was left undone fails
    with "the workflow did not finish: …" in `orch.error`;
  - nothing grew for 30 minutes (the run directory's bytes, the stream's agents, the task states;
    the lead's own activity does not count): the lead is stopped and the graph fails, resumable
    from its cache (`abandonWorkflow`);
  - after a restart a graph whose lead waits for a reset stays `running` and is watched again.
- **The lead never polls.** Its prompt carries `WORKFLOW_LEAD_WAIT` instead of `DELEGATION`
  ([prompts.md](prompts.md#workflow-lead-launchworkflow)): the f33d7d0b lead, told to wait for its
  delegated work, sat in a `sleep 30` loop over its own journal. No tools are denied to it, since
  the deny list could reach its subagents; the watchdog is the guarantee.
- **Where it shows.** The orchestration page lists every task of a workflow step as a row with its
  journal state, says a limit wait once above the steps (a warn `WaitLine` with the reset hour and
  one "Stop waiting" beside "Run now"), and shows why a workflow did not finish or was stopped at the top, with the
  note that resuming goes on from the cache.
- **Tests.** `packages/core/test/workflow-journal.test.ts`, `workflow-engine.test.ts`,
  `workflow-limits.test.ts`, `workflow-watchdog.test.ts` and `rotation.test.ts` against the fixture
  `packages/core/test/fixtures/workflow-journal/{at-limit,resumed}` (a trimmed copy of f33d7d0b's
  files with the CLI's real 429 entry); `apps/web/test/workflow-limits-board.test.tsx`; and
  `e2e/specs/orchestration-v2.spec.mjs` (a two-task workflow graph's rows and its end notice).

## Recovery and shutdown

What the orchestrator does when something it asked for is refused or interrupted (the audit's §9):

- **A refused workflow resume does not end the server.** The resume runs detached, and a refusal
  there used to be an unhandled rejection that ended the API process. A place that frees up by itself
  (a transient refusal, [resource-control.md](resource-control.md)) is waited for and the launch tried
  again; anything else fails the graph with the reason.
- **A failure before the checks start does not strand the graph.** `checkBranch` takes `verifying`
  inside its `try`, so a git failure no longer leaves the graph refusing verify, resume and remove
  with "checks are running".
- **A worker refused a place is still told about its merge.** The worktree a launch prepared is read
  again at the next launch: a merge left in progress is handed to the worker instead of starting it
  among conflict markers.
- **A Stop and a quick Resume** do not fail the resumed task: each attempt carries a stamp, and the
  stopped process's last result is ignored by the next attempt.
- **Merges and the integration use async git.** The dependency merges and the integration (worktree,
  merges, commits) no longer block the server, and the integrator, the synthesis and the fixer wait
  for a place like the review gate's runs; a fixer that never started is not an attempt.
- **A task stopped at its time limit keeps that reason**, and what a verification command leaves
  running in its process group is ended after a normal exit too, not only on a timeout or a cancel.
- **Leaks.** `remove()` forgets the graph's in-memory state, `close()` takes the chat-result listener
  off, warnings are pruned, a graph has one timer for retries, the event publisher forgets a subagent
  that went quiet, and the workflow journal is read on from the byte the last read stopped at.
- **Failures are logged.** A save that fails is logged (at most once a minute, with the count held
  back, `ThrottledLog`), a corrupt legacy file is renamed `.corrupt`, and the scheduler's ticks log
  what they could not do. A flow run whose start throws between the claim and its chat no longer
  keeps a slot, and a scheduled chat with no free place waits for one as an orchestration target's
  tasks do.
- **Shutdown** waits for the chats, evals, terminals, collaborators and tunnel before the database
  closes ([resource-control.md](resource-control.md)).

## Related

[[plans/workflow-engine-limits.md]] · [[accounts.md]] · [[prompts.md]] · [[guards.md]] · [[plans/review-gate.md]] · [[plans/orchestration-speed.md]] · [[plans/graph-shape.md]] · [[plans/worker-checks.md]] · [[design-system.md]]
