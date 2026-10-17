---
created_at: 2026-10-16T22:00:00Z
updated_at: 2026-10-16T23:00:00Z
tags:
    - plan
    - spec
    - guards
    - orchestration
    - verification
    - performance
    - proposed
---
# Plan: agent test-scope and retry-loop guards, with an opt-in failure baseline

Status: **proposed** (2026-10-16). Nothing here is built. The scope was decided on 2026-10-16: the
rules apply to **every agent run Claudio starts**, not only to the workers of an orchestration. The
owner decides the remaining open questions at the end before the first task starts.

## Why

Agents spend a large share of an orchestration's critical path running tests, and most of that time
is not spent finding something their change broke. Two patterns repeat across graphs, and neither
depends on the project, the task, the model, or the kind of agent:

1. **Broad test runs where a scoped one is enough.** The agent runs the whole repository's test
   suite, or the whole suite again, when its change touches one package or a few files. The
   instruction against it already exists for workers (`workerChecks` in
   `packages/core/src/verification.ts`: "not the whole repository's … The whole suite runs once,
   later"), but nothing enforces it. Measured on 144 worker chats in CW-15: 85 whole-repository test
   runs, about 2 hours of them. Measured again on a graph of 2026-10-16: one worker ran the whole
   suite twice (about 15 minutes), and then re-ran the failing files against the previous code to
   prove the failures were already there.
2. **The same failing test run again and again.** An agent reruns one test file, changing code
   between runs, without a cap. On the same graph one worker ran a single test file eight times at
   1 to 1.7 minutes each, while the failure lay in code it did not own. Nothing tells it to stop and
   report. The same happened outside orchestrations: an interactive subagent, started by Claudio to
   fix one e2e spec, ran a batch of 21 spec targets three times (about 10 minutes each) to debug a
   single failure. That is the first reason the scope is every agent, not only workers.

A third pattern is the cost of proving a failure is old. When a suite already fails at the base
commit, every agent that sees the failures has to find out, by running the suite again on the
previous code. That work repeats for each agent and each graph.

These are behaviours of the agents, so the fix sits where their tool calls are checked: the guards
(see [guards.md](../guards.md)). The guards already run on every tool call of an automated run,
already have switches and an `observe` mode, and already record what they block.

## Goals

- Stop an agent's broad test run when a scoped one is available, without the project's commands
  being written into Claudio's code.
- Stop an agent that keeps re-running the same failing test, and make it report instead.
- Let a project opt in to a baseline of the failures that already exist at the base commit, so an
  agent does not need to prove them again.
- Keep every rule generic: it works for any repository whose test commands the project declares.

## Non-goals

- **Not a sandbox.** Guards are defence in depth against mistakes and prompt pressure
  ([what is not guaranteed](../guards.md#what-is-not-guaranteed)). A command that is rephrased
  until it no longer matches a pattern is not stopped by a pattern.
- **Not the verification phase.** The whole suite still runs once, on the merged branch, in the
  verification phase (and the `e2e-specs` task keeps browser specs to a scoped set). This plan
  changes what agents run while they work, not what the graph checks.
- **Not the planner.** Shaping a graph so that tasks start in parallel (for example fixing the
  shared contract in the first task) is a separate plan, in [orchestrations.md](../orchestrations.md).
- **Not a product bug.** A test that hangs because the product hangs is fixed in the product. The
  guards only limit how many times an agent can rerun it.
- **Not the wait loops or the health signal.** An agent that polls a log with `sleep` in a loop, and
  a health signal that calls a long wait "hung", are real problems, but they are separate from the
  rules here. They have no document yet; each one gets its own plan when it is picked up.

## Design

### 1. The project declares its test commands

A project says how its tests run, in its own settings, not in Claudio's code. This is a
settings-shaped document, so it is JSON (CLAUDE.md, Conventions). It lives in the same place as the
other per-project settings:

```json
{
  "tests": {
    "broad": ["^npm test$", "^pnpm test$", "^pytest$", "^cargo test$"],
    "scoped": ["npm test -- ", "pytest ", "cargo test "],
    "failure": "^not ok \\d+ - (?<target>\\S+)"
  }
}
```

- `broad`: regular expressions matched against the first program of each shell segment (see
  rule 2). A match means the command runs the whole suite.
- `scoped`: prefixes of commands that run a part of the suite. Used only to phrase the message.
- `failure`: optional. A regular expression with a named group `target` that finds the failing tests
  in the output. Used by the baseline (rule 4). Without it, the baseline is off.

A project that declares nothing gets no test rule. Claudio ships no default commands for any
ecosystem; the examples above are illustrative.

### 2. Rule: broad test run (`test-scope`)

- **What it checks.** The first program of each shell segment of a `Bash` call, after the same
  normalisation the guards already apply to `git` commands (`timeout`, environment assignments,
  `cd … &&`). A segment that matches `tests.broad` is a broad run. A run that matches `tests.scoped`
  is not.
- **What it does.** In `enforce`, it blocks the call and returns a message that names the project's
  scoped form and says that the whole suite runs in the verification phase. In `observe`, it records
  "would block" and passes.
- **Who it applies to.** Every agent run Claudio starts: workers, the flow, subagents, and
  interactive chats that Claudio launched. The verification phase is exempt, because it is the one
  place where the whole suite is meant to run.
- **Switch and default.** A switchable rule, in the existing rules table. `observe` for the first
  release (see rollout). Interactive chats are the one case that is new: today the guards cover
  automated runs (workers and the flow), so their coverage needs its own switch (open question 5).

### 3. Rule: the same failing test, again (`retry-loop`)

- **What it counts.** Per agent run and task, the number of consecutive runs of the same normalised
  command whose result is a failure. The normalisation is the one of rule 2, plus removal of
  arguments that only name a port, a timeout or a log file. Two runs with different test files are
  different commands.
- **What it does.** When the count reaches the threshold (default 2), the next run of that command is
  blocked, in `enforce`, with a message to stop and report what fails and what was tried. Other
  commands are never blocked by this rule, so the agent can still read, edit and run other tests.
- **Who it applies to.** The same set as rule 2.
- **Where the failure comes from.** The count needs the exit status of the previous run, which a
  `PreToolUse` hook does not see. This rule therefore needs a `PostToolUse` record of the result of
  each `Bash` call, written next to the rules file in the guard's run folder and read by the next
  `PreToolUse`. This is the one design element that is new to the guards, and it is the first open
  question below.

### 4. Opt-in baseline of failures at the base commit (`baseline`)

- **What it is.** A project that declares `tests.failure` can ask for a baseline. When a graph starts
  with the baseline on, Claudio runs the project's broad test command once on the graph's base
  commit, in a throwaway worktree, with a time limit. It parses the failing targets with
  `tests.failure` and stores them with the graph.
- **How it reaches the agents.** Each agent of that graph gets a short block in its prompt: "These
  targets already fail at the base commit and are not yours to fix; report them, and report only
  failures that appear in addition." The list is in the prompt as data (the same `<pasted_content>`
  treatment the orchestration already uses for untrusted text). Agents outside a graph do not get the
  list in this version (open question 6).
- **What it does not do.** It does not stop an agent from running a test. It does not suppress a
  failure from the verification phase; the verification phase still reports everything, and it marks
  the baseline failures as known.
- **Cost.** One broad run per graph, on the base commit, before the first task starts. This is not
  free: it adds that run's time to the graph's start. That is why it is opt-in.
- **If it cannot finish.** A time limit or a parsing error leaves the baseline "unknown": the agents
  get no list, and nothing is claimed about the failures. The graph still runs.

### 5. Settings and interfaces

- Rules: the existing `guards.json` rules table (one switch per rule, `observe` mode, the locked
  `integrity` row). `test-scope` and `retry-loop` are new rows, and the interactive-chat coverage is
  one more switch beside them. The baseline is a project setting under the orchestration's
  verification fields, off by default.
- Per-project declarations: the project's settings file, validated by its schema, read through the
  existing project settings route. No new route is needed for the declaration.
- API: `GET`/`PUT /settings/guards` gain the rules and the switch (OpenAPI summaries and tags in
  `apps/api/src/openapi/routes.ts`, regenerated schemas). A baseline result is read through the
  existing orchestration route as a field, so it needs no new route.
- Web: the new rows and the interactive-chat switch in **Settings → Security → Guards**, and the
  baseline switch in the launch form under verification. Controls come from
  `packages/ui/src/components/controls`, copy goes through i18n with `en`/`es` parity.

### 6. Observability

- Every block and every "would block" is a row in `guard_events`, a line in the transcript, and a
  signal in the run's health, as for the existing rules.
- The timings endpoint and `scripts/orchestration-timings.mjs` count runs by category. The script's
  classifier must read a shell segment by its first program, not by the words in it, so that a
  `grep` that mentions "test" is not counted as a test run. That fix is part of this work.

## Tests

No test uses Claudio's own repository as its fixture. The fixtures are small projects of two other
ecosystems, created under `scripts/test-tmp.mjs`, each with a declared `tests` section:

- **Classification.** A table of commands, including a segment with `timeout` and environment
  assignments, a `grep` that mentions `test`, a `sed -i` followed by a test run, and a heredoc body.
  Each must be classified as the program that actually runs.
- **`test-scope`.** A broad command is blocked in `enforce` and passed in `observe`, with the message;
  a scoped command is never blocked; the verification phase is never blocked. The same holds for a
  worker, a subagent and an interactive chat.
- **`retry-loop`.** The same failing command twice, then blocked; a different target not blocked; a
  passing run resets the count; the count is per agent run and task.
- **Baseline.** Parsing of three output formats (a TAP-style list, a runner that prints one line per
  failure, and a runner with no list), a baseline that times out ("unknown"), and an agent prompt that
  carries the list only when the baseline is on.
- **Web.** The new rows and the switches, both themes, `en`/`es` parity (the existing strings check).

## Rollout

1. **`observe` first.** Both rules ship in `observe` by default, for every agent kind. For the first
   three graphs with the rules on, the `guard_events` "would block" rows are read against the
   transcripts: each one is either a true positive or a false positive, recorded in the plan's Outcome.
2. **Enforce `test-scope`** once there are no false positives on a scoped command. `retry-loop`
   follows, with the threshold the owner chooses.
3. **Baseline** stays opt-in per project. A project turns it on after its failure output parses
   correctly in the test above.

Rollback: switch the rules to off, or the mode back to `observe`. The `PostToolUse` record is inert
when no rule reads it. No schema migration is needed beyond the run's guard folder.

## Success criteria

Measured with `scripts/orchestration-timings.mjs` and the guard rows on the next graphs after
enforcement, compared with the graphs before it:

- Broad test runs by agents in an enforced graph: zero, except runs the project declares as scoped.
- Identical failing runs per task: at most the threshold.
- Time between the last task and the end of the graph does not grow (the verification phase is
  unchanged).
- A decrease in the share of test time on the critical path. The size of that decrease is not
  promised here; it is what the first measured graphs will show.

## Risks

- **False positives.** A scoped command that a `broad` pattern also matches (or the other way round)
  blocks legitimate work. Mitigation: `observe` first, and a message that names the scoped form.
- **Interactive chats.** A person's own chat is a new place for the guards. Mitigation: its own
  switch, `observe` first, and the rules never stop a command that is not a test run.
- **Bypass by rephrasing.** Stated above; the guards are not a sandbox.
- **The baseline costs a run.** Mitigation: opt-in, a time limit, and "unknown" when it cannot finish.
- **Flaky tests in the baseline.** A test that fails at base for a reason that does not repeat becomes
  a known failure that no agent looks at. Mitigation: the verification phase still reports every
  failure, and the baseline list is shown in the run, so a person can see it.
- **New state in the guards.** The `PostToolUse` record adds state that the guards did not have.
  Mitigation: it lives in the run's own folder, is removed with it, and fails closed like the rest of
  the guard.

## Open questions for the owner

1. **`PostToolUse` record.** Is it acceptable that the guards gain a result record of each `Bash`
   call, for `retry-loop`? The alternative is to drop `retry-loop` and rely on the prompt and the
   threshold of the existing turn limits.
2. **Default of `test-scope`.** `observe` for the first release, as written here, or `enforce` once a
   project declares `tests.broad`?
3. **Threshold of `retry-loop`.** Two identical failing runs (as written) or three?
4. **Baseline default.** Off for every project (as written), or on wherever `tests.failure` is
   declared?
5. **Interactive chats.** Covered by default, as the scope says, or covered only when the person
   switches it on? The recommendation is covered in `observe` first, with its own switch.
6. **Baseline outside graphs.** Should an agent run that is not part of a graph also get the baseline
   list, which means running the baseline for it as well? The recommendation is no for this version.

## Outcome

Not started. The Outcome is written when the first rule ships, with the observe rows of the first
three graphs.

## Related

[[guards.md]] · [[plans/guards.md]] · [[plans/worker-checks.md]] · [[plans/orchestration-speed.md]] ·
[[orchestration-timings.md]] · [[orchestrations.md]] · [[security-model.md]] · [[status.md]]
