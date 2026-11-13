---
created_at: 2026-11-09T15:33:21.022692657Z
updated_at: 2026-11-13T15:00:00Z
tags:
    - plan
    - ci
    - tests
    - flaky
---
# Plan: the CI's flaky tests (2026-11-09)

Status: **landed** with #105 (planned and launched on 2026-11-09 on branch `feat/servers-complete`,
merged 2026-11-09 once CI was green). Was: "planned and launched on 2026-11-09".

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

## Review against D1

Every fix names its cause, no assertion was dropped or loosened and no timeout was lengthened as
the fix:

- `security.test.ts`: no test hung. The first `GET /openapi.json` ran the swagger plugin's resolver
  over ~1,000 components (10–35 s of blocked event loop), and the 60,000-row refusal flood
  committed each row alone. The components are now served as generated (`apps/api/src/openapi/plugin.ts`,
  checked component by component in `api.test.ts`, decision in
  [[decisions/openapi-components-verbatim.md]]), the flood commits in batches of 1,000 and yields,
  and every test has a 60 s limit so a hang names itself.
- `tunnel.test.ts:441`: a race in `TunnelManager.refresh(true)`, which joined a reading already in
  flight and answered with the node as it was before the caller's change; it now waits for that
  reading and reads again. A new test holds a recovery reading across the stop. The fake CLI and
  the tests write its state file atomically.
- `tunnel.test.ts:400`: the 400 ms command timeout meant for the slow phase was applied to the
  open too. The open and the recovery use the product's own timeout; the slow phase keeps 400 ms
  against a 1,500 ms node, so what the test asserts is unchanged.
- `collab-sync.test.ts:291`: a race in the client, which read a copy as `live` before the owner had
  subscribed. The owner now sends an `ack` once it listens (`collab/serve.ts`), the client is live
  only after it and pulls once to catch up (`collab/client.ts`); an owner without the ack counts
  its first notice as one.
- `chat-account-switch.test.ts:87`: a 1.5 s nap raced the switch's own awaits; the turn now waits
  on a file the test writes, and the test also checks the cancelled switch stays cancelled.
- `openai-slot-eviction.test.ts:390`: the hold was taken after polling for idle, racing the idle
  timer; it is taken in the tick the chat goes idle, and the test now proves the timer fired and
  re-armed while held (the idle timeout went down, 1,000 to 200 ms).
- `accounts-rotation.test.ts:410`: the reading could share the wait's millisecond, which `roomFor`
  does not count; it is stamped after the wait began.

Proof through Sluice: lint, typecheck and the full test gate passed on the merged tree (job
`1794243622638-20935-124e05`) and again after the review (`1794244213957-20935-1052ee`), and the
e2e gate passed `servers-*` and `collaborators*`, all six specs in two shards
(`1794244734525-20935-54fa69`). A third run of lint, typecheck and test passed alongside the whole
e2e suite (`1794244915481-20935-ac578b`), so the plan's tests also held with the browser suite
loading the machine, and a fourth on the final tree (`1794246478464-20935-af30f7`).

That whole e2e run failed, on two things outside this plan:

- `a11y-core.spec.mjs` passed the e2e runner's 300 s per-spec limit while the test gate ran beside
  it, and its shard stopped, leaving 46 specs not run. Alone it passes in 117 s
  (`1794246288965-20935-87e49f`): a spec slowed 2.5× by load, a candidate for the next round.
- `terminal.spec.mjs`, `terminal-paste.spec.mjs`, `terminal-autoclose.spec.mjs` and `motion.spec.mjs`
  could not turn the terminal on (`PUT /terminal/settings` 403, then `terminal.off`). The terminal
  gate refuses a request from a process whose ancestry carries `CLAUDIO_CHAT_ID`, and the Sluice
  daemon that runs every job on this machine was started from a Claudio chat and carries it in its
  environment (checked in `/proc`), so no terminal spec can pass through it until it is restarted
  outside a chat; no file this plan changed touches the terminal. CI, which has no such variable, is where they are judged.

## Related

[[plans/claudio-servers.md]] · [[plans/e2e-flakes-under-load.md]] · [[plans/agent-test-guards.md]]
