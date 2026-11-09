---
created_at: 2026-11-09T15:33:21.022692657Z
updated_at: 2026-11-09T15:33:21.022692657Z
tags:
    - plan
    - ci
    - tests
    - flaky
---
# Plan: the CI's flaky tests (2026-11-09)

Status: **planned and launched on 2026-11-09** on branch `feat/servers-complete` (PR #105), which the
owner will not merge until CI is green.

## Why

The `checks` job of CI failed on a different test at each run of PR #105, and on the PRs before it,
always in code the PR did not touch, and each passed on a rerun. Rerunning until green hides the
cause, so the owner asked for the causes to be fixed. Two such tests were real races in the
orchestrator, fixed by E6 of [the servers plan](claudio-servers.md) (`orchestrator-recovery.test.ts`
and `workflow-limits.test.ts`); the uutils `date` bug behind `update-unit.test.ts:243` was fixed in
#104. These remain:

| Test | Seen |
| --- | --- |
| `apps/api/test/security.test.ts` | the whole file passed its 240 s limit; the runner killed it before reporting which test hung |
| `packages/core/test/tunnel.test.ts:441` ("a tunnel the person stopped never restarts, even once Tailscale is ready") and `:400` | failed on CI and under local load |
| `packages/core/test/collab-sync.test.ts:291` ("three installs: sync of every kind…") | "timed out waiting for the appended line" |
| `apps/api/test/chat-account-switch.test.ts:87` | failed once under load |
| `apps/api/test/openai-slot-eviction.test.ts:390` | failed once under load |
| `packages/core/test/accounts-rotation.test.ts:410` | reads `Date.now()` the way E6's races did; not yet seen failing |

## Rules (D1)

- First make the failure say what it saw: the state, the events and the times it waited on.
- Then find the cause by reading the code the test drives under slow scheduling: what runs between
  the action and the assertion, what is read too early, what waits on wall-clock time.
- Fix the cause: wait on an event or a state with a bound, inject a clock instead of reading
  `Date.now()` twice, or fix the race in the product code when it is one (as E6 did). Never a longer
  timeout or a looser assertion as the fix.
- A test that hangs must name itself: a per-test timeout below the file's limit, so the runner
  reports which test hung instead of killing the file.
- Prove it under load: run the test file repeatedly while other gates run, through Sluice.

## Tasks

Graph `claudio-ci-flaky-tests`, worktrees on, concurrency 4, base `feat/servers-complete`. Opus for
every diagnosis (the cause is unknown); sonnet for the review's prose is not needed.

| id | Owns | Depends on | Model / effort |
| --- | --- | --- | --- |
| `flaky-security` | `apps/api/test/security.test.ts` (and the code a hang points to) | — | opus · high |
| `flaky-tunnel` | `packages/core/test/tunnel.test.ts` (:400, :441) and `packages/core/src/tunnel.ts` if the race is there | — | opus · medium |
| `flaky-collab-chat` | `packages/core/test/collab-sync.test.ts:291`, `apps/api/test/chat-account-switch.test.ts:87` | — | opus · medium |
| `flaky-openai-accounts` | `apps/api/test/openai-slot-eviction.test.ts:390`, `packages/core/test/accounts-rotation.test.ts:410` | — | opus · medium |
| `review` | Reads every fix against D1 (no weakened test, no longer timeout as a fix), runs the full gates through Sluice twice | all four | opus · medium |

## Related

[[plans/claudio-servers.md]] · [[plans/e2e-flakes-under-load.md]] · [[plans/agent-test-guards.md]]
