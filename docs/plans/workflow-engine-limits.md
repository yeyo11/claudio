---
created_at: 2026-10-17T09:00:00Z
updated_at: 2026-10-17T09:00:00Z
tags:
    - plan
    - orchestration
    - accounts
    - decided
---
# Plan: the workflow engine follows its journal, holds or rotates at a limit, and never runs unwatched

Status: **decided** (2026-10-17). Answers R15 of [requests.md](../requests.md). Tasks b1, b2, b3, w1
and x1 of the orchestration that builds it carry it out; each section names the files its task owns.

The one rule holds: everything is read from what the Claude Code CLI ships: the files it writes beside
a session (the workflow journal, each subagent's transcript, the run's record), its stream-json
`result` and `rate_limit_event`, and the Workflow tool's own `resumeFromRunId`. A limit is recognised
from the CLI's structured fields (`api_error_status` / `apiErrorStatus` 429, `rate_limit_info`), never
from its wording, as [rotation-auth-fixes.md](rotation-auth-fixes.md) settled for sign-in failures.

## What happened (orchestration f33d7d0b, 2026-10-16 22:01–22:44 UTC)

Read from the session's files and Claudio's database:

1. The lead session (`fdbf0a97…`, account `acc-a6b913cd`) called the Workflow tool, which ran in the
   background. Seven tasks finished. Task `g8` (agent `aff5c2a8…`) started at 22:01; at 22:07:30 its
   last API call was refused. The last line of the agent's transcript is an assistant entry with
   `model: "<synthetic>"`, `error: "rate_limit"`, `apiError: "usage_limit_reached"`,
   `apiErrorStatus: 429`, `apiErrorParams.rate_limit_info = { status: "rejected", resetsAt: 1792197600,
   rateLimitType: "five_hour" }` and the text "You've hit your session limit · resets 2:40am".
2. The journal recorded `{type: "failed", key, agentId}` for g8. `agent()` returned null to the script,
   which went on: `z1` (behind g8) was skipped and the synthesis started at once, was refused the same
   way and failed too.
3. The workflow ended **completed** at 22:07:31. Its task notification carried the result (`g8: null`),
   a `<failures>` block (`[g8] failed: You've hit your session limit…`, `[synthesis] failed: …`) and a
   `<diagnostics>` line telling how to resume: `Workflow({scriptPath, resumeFromRunId:
   'wf_a5bd7f53-56d'})`, "agents whose (prompt, opts) are unchanged replay from cache".
4. The lead's own turn, answering that notification, was refused with the same 429. The rotation got a
   `limit-hit`, but `Orchestrator.workOf` returns null for a workflow's chat, so `onLimitHit` took the
   "orchestration chat with no work" branch: a notice ("this turn is not replayed"), no move, no wait.
   `rotation_events` has no row for it.
5. The process did not exit: while waiting for the workflow, the lead had started background shell
   loops over its own journal (`while true; … sleep 30; done`, and `until grep …; do sleep 30; done`,
   both with a 2 h timeout). The `DELEGATION` rule in its prompt asks it to "wait for each one to finish
   … before your turn ends", which is what it was doing.
6. Claudio's watcher (`followWorkflow`) finishes on the stream's view of the workflow or on the process
   going away. Neither happened: the stream never reported g8 (its `startedAt` in the graph is the
   resume's, 22:32), and the process lived on. The graph stayed `running`, g8 `pending`, for 25 min.
7. A person stopped and resumed the graph at 22:32. `launchWorkflow(orch, 'wf_a5bd7f53-56d')` sent the
   resume prompt to the same session; the new process's account was chosen again (`chooseAccount`) and
   went to `acc-79ffec12`, since `acc-a6b913cd` was marked out until its reset. The CLI resumed **into
   the same run id and journal** (no second `launched` line), replayed the seven finished agents from
   cache, ran `g8` again under **the same key** with a new agent id, then g9, z1 and the synthesis. The
   run's record `workflows/wf_a5bd7f53-56d.json` was overwritten by the resumed run's.

Facts the design rests on, all observed there:

- `projects/` of every account's config dir links to the same directory (docs/accounts.md), so a
  session, its journal and its workflow cache are visible from any account. A resume on another
  account replays from cache.
- Journal lines carry no time. `started` carries `label` (the task id, or `synthesis`) and `phase`;
  `result` carries the agent's **full** result text; `failed` carries only `key` and `agentId`. The
  latest line of a key is its current state: a resume appends `started` again for a failed key.
- Each subagent's transcript is `agent-<agentId>.jsonl` beside the journal, with ISO `timestamp`s; its
  last assistant entry says how it ended.
- The Workflow tool takes `scriptPath` and `resumeFromRunId`; the script must be byte-identical for the
  cache to match, which `launchWorkflow` already ensures by never regenerating it on a resume.

## 1. Live task states from the journal (b1)

The journal on disk becomes the source of a workflow graph's task states while it runs; the stream's
`workflow_progress` stays a hint and the compiled result stays the last word for results.

- **Where.** `<transcript base>/subagents/workflows/<workflowRunId>/journal.jsonl`, the transcript
  located as `Sessions.workflows()` already does. The run id is learnt as soon as its directory exists:
  the newest `wf_*` directory under the session's `subagents/workflows/` that was not there at launch
  (the baseline is taken in `launchWorkflow`), or `orch.workflow.workflowRunId` on a resume. This
  replaces waiting for the stream's task id in `learnWorkflowRunId`.
- **Reading.** Each watcher tick stats the journal and rereads it only when its size or mtime changed.
  For each key, its latest line decides; a line's agent id maps it to the label of its `started` line.
- **Mapping**, per task label:
  - `started` → `running`; `startedAt` from the first `timestamp` of the agent's transcript (else now).
  - `result` → `completed`, `result` = the line's full text; `endedAt` from the agent's last entry.
  - `failed` → `failed`, `error` = the text of the agent's last assistant entry (else "the agent failed
    without a message"), unless that entry is a limit or a sign-in failure, which goes to section 2.
  - A `started` after a `failed` of the same key (a resume) → `running` again, `error` cleared.
  - Label `synthesis` sets `synthesisStartedAt` / `synthesisEndedAt` and, on `result`, `finalResult`.
- **At the end** `finishWorkflow` keeps the compiled result as the last word for results, and takes
  from the journal what the result leaves null: a task with `failed` gets the subagent's message as its
  error instead of "the agent returned nothing". A label the journal never started and the script
  listed as skipped stays `skipped`.
- `fromJournal` in `workflows.ts` also records `failed` (state `error`), so the chat's workflow panel
  agrees with the board. Today it ignores the line: read on the `at-limit` fixture,
  `readSessionWorkflows` reports `t3:progress synthesis:progress`, two agents that ended minutes ago,
  and `readWorkflowAgent` says the same of t3.

**Owns:** `packages/core/src/workflows.ts` (`readWorkflowJournal`, `readAgentEnd`, `failed` in
`fromJournal`), a new pure module `packages/core/src/workflow-journal.ts` (journal lines and agent ends
→ per-label states), `packages/core/src/sessions.ts` (locating a run's directory),
`packages/core/src/orchestrator.ts` (`syncWorkflow`, `learnWorkflowRunId`, `finishWorkflow`),
the wiring in `packages/core/src/index.ts`. Tests: `packages/core/test/workflow-journal.test.ts` on the
fixture below, cases added to `packages/core/test/workflow-engine.test.ts`, and the fake CLI
(`packages/core/test/fixtures/fake-claude-control.mjs`) writing a journal and agent transcripts as the
CLI does.

`readAgentEnd(transcript, runId, agentId)` returns `{ text, at, limit, authFailed }`, where `limit` is
`{ resetsAt, rateLimitType }` when the last assistant entry has `apiErrorStatus === 429` (resetsAt from
`apiErrorParams.rate_limit_info.resetsAt`, epoch seconds, else `quotaLimits.resetsAt`, else null), and
`authFailed` is `apiErrorStatus === 401`. Both are what b2 consumes.

## 2. A limit in a workflow is held or rotated like a graph task's (b2)

**Decision: Claudio stops the workflow at the first limit, hands the lead's chat to the rotation as
automated work, and goes on by resuming the workflow from its cache, never by replaying the lead's
turn.** Replaying the turn (what the rotation does for any other chat) would send the original "Run the
workflow" prompt and start a new run that caches nothing.

### Recognising it

From either source, whichever comes first; the second finds the limit already held and does nothing:

- **A subagent:** the journal shows `failed` for an agent whose `readAgentEnd` has `limit` (or
  `authFailed`). This is the one that matters: the lead's own turn is idle while the workflow runs, and
  the script goes on without the failed task (skipping its dependents and starting the synthesis on an
  exhausted account), so waiting for the lead to notice costs work.
- **The lead session:** its turn ends with the CLI's 429 `result` or a rejected `rate_limit_event`
  (`chat.rateLimited`, as today), and `limit-hit` reaches the rotation.

### Acting on it

1. `Orchestrator.workOf(leadChatId)` returns `{ subjectKind: 'task', subjectId: '<orch>:__workflow__' }`
   for the lead of a running workflow graph, so the rotation treats it as automated work, `holds()` is
   true, and a wait is a `provider_moves` row like any task's. No new subject kind.
2. On a subagent's limit the orchestrator first records the reading on the account
   (`ChatManager.limitReached(leadChatId, { resetsAt, rateLimitType } | { authFailed })`, which goes
   through the same `observeLimit` / `observeSignIn` the stream's events go through, and announces
   `limit-hit` through `maybeLimit`). It then stops the lead's process with the plain `runs.stop` —
   Claudio's own stop, which does not cancel a wait — so the script starts nothing more on the
   exhausted account and the lead's background loops end with it.
3. The task that hit the limit goes back to `running` (it is not failed and spends nothing); tasks that
   were running stay `running`. `view()` already puts the lead's `LimitWait` on every running task whose
   `runId` is the lead's chat, so the board shows the wait on them.
4. The rotation decides as for any automated work:
   - **Another account has room:** `moveToAccount` calls the new `RotationDeps.replay(chatId, account)`
     hook instead of `replayLastTurn`. Core routes it to `Orchestrator.replayWorkflow`, which sends the
     resume prompt (`scriptPath` + `resumeFromRunId`) through `ChatManager.replayWith(chatId, text,
     account)`: the same respawn as `replayLastTurn` (stop a live process, force the account, respawn
     with `--resume`), with the given text instead of the dead turn. The hook returns null for any chat
     that is not a workflow lead, and the rotation falls back to `replayLastTurn`.
   - **No account has room:** a wait with the reset time, as for a graph task. At the reset,
     `resume()` calls the same hook without an account. `replayWith` counts against the chat's
     `limitReplays` (`MAX_LIMIT_REPLAYS`, today 1) when no account is given, so a pool that keeps
     refusing ends. The count is reset only by a new execution (`start`), which a long workflow does
     not make, so the orchestrator resets it when the journal shows a `result` after the last replay:
     a workflow that made progress may wait again at a later limit; one refused at once may not.
5. **The graph's status stays `running`**, with the `LimitWait` (provider, `resetsAt`, `moveId`) on its
   running tasks. This is how a graph task's limit is held today. `waiting` keeps its one meaning, "a
   task failed for good and a person decides", and its Retry/Skip actions do not apply to a limit.
6. `waitEnded` gets a workflow branch (`taskOfChat` skips workflow graphs): `resumed` → follow the
   workflow again (`followWorkflow`, new baseline); `cancelled` → tasks not completed become `stopped`,
   the graph `stopped`; `failed` → they become `failed` with the wait's reason, the graph `failed`, and
   `orch.error` says why. A person can resume either from the cache later.
7. `stop()` of a workflow graph also calls `releaseWait(leadChatId)`.

Why the lead's chat and not one chat per task: the workflow is one session, one process and one
account; its cache lives in that session. Moving the session is moving every task.

**Owns:** `packages/core/src/rotation.ts` (the `replay` hook in `moveToAccount` and `resume`),
`packages/core/src/chats.ts` (`replayWith`, `limitReached`), `packages/core/src/orchestrator.ts`
(`workOf` and a `workflowOfChat` for the lead, the journal's limit path, `replayWorkflow`, the
`waitEnded` branch, `stop`), the wiring in `packages/core/src/index.ts`. Tests:
`packages/core/test/workflow-limits.test.ts` (subagent limit → move and resume from cache; no account →
wait, then resume at the reset; the lead's own 429; cancel; second source ignored), cases in
`packages/core/test/rotation.test.ts` for the hook, and a fake-CLI mode in
`fake-claude-control.mjs` where one agent of the workflow is refused with a 429 once.

## 3. A watchdog: a running workflow graph always has something live behind it (b3)

**Invariant:** a workflow graph that is `running` has a live lead process, or an open limit wait on
its lead, or a launch Claudio is about to make (the daily spend cap's hold, or a resume sent after the
previous process exits). The watcher in `followWorkflow` checks it every tick, and on startup for every
running workflow graph. When it does not hold, the graph is settled with a reason, never left running:

| Seen | Done |
| --- | --- |
| The run's record (`workflows/<runId>.json`, written by the CLI when the workflow ends, with a timestamp after the launch) or the stream says the workflow ended, and the process is still up after `WORKFLOW_END_GRACE_MS` (60 s) | Stop the lead and `finishWorkflow` from the record and the journal. This is the f33d7d0b case |
| The process is gone, no record and no wait, the journal's last failure a limit | Section 2's limit path, not a failure |
| The process is gone, no record, no wait | `finishWorkflow` as today; unfinished tasks `failed` with the journal's reason, `orch.error` "the workflow's session ended before it finished" |
| Process up, no record, and nothing of the run has grown for `WORKFLOW_STALL_MS` (30 min): not the journal, not any agent transcript of the run, not the lead's transcript; no wait open | Stop the lead and settle `failed`, `orch.error` "the workflow made no progress for 30 min"; it resumes from its cache |
| Startup, with an open wait on the lead | Stay `running`: `interrupt()` leaves it, the rotation's `recover()` re-arms the wait and the hook resumes the workflow |
| Startup, no wait | `stopped` as today, with `orch.error` saying the restart cut it off and that Resume continues from the cache |

30 min is above any foreground command a subagent may run (10 min) and above any silence seen in a
working agent's transcript; it is a constant in `orchestrator.ts`, not a setting.

**Owns:** `packages/core/src/orchestrator.ts` (`followWorkflow`'s checks, `interrupt` / `recover` for
workflow graphs, the two constants). Tests: `packages/core/test/workflow-watchdog.test.ts`, with the
clock passed in as `enforceLimits` does.

## 4. The lead's prompt forbids waiting loops (b3)

The lead prompt drops `DELEGATION`, which is right for a worker and wrong for the lead, and gets a rule
of its own, `WORKFLOW_LEAD_WAIT` in `packages/core/src/prompt-rules.ts`:

> The Workflow tool runs the workflow in the background and tells you when it ends with a task
> notification. Do not wait for it yourself: no sleep, no polling loop, no Monitor, no background
> command, and do not read its journal or output files. After the tool returns, end your turn with one
> line saying the workflow is running. When its notification arrives, reply with one line saying
> whether it completed, naming the agents it reports as failed.

The process stays up on its own until the notification (`followWorkflow`'s comment), so the lead has
nothing to keep alive. The tools are not taken away from the session: its deny list could reach the
subagents, which need Bash, and the watchdog is the guarantee if the prompt is ignored.

**Owns:** `packages/core/src/prompt-rules.ts` and `launchWorkflow`'s prompt in
`packages/core/src/orchestrator.ts`; a test in `packages/core/test/workflow-engine.test.ts` that pins
the rule in the lead's prompt and the absence of `DELEGATION`.

## 5. The web shows it (w1)

No shared type changes: everything is already in `Orchestration` (`status`, `error`, task `status`,
`error`, `startedAt`, `waiting`, `synthesisStartedAt`/`EndedAt`, `workflow`).

- The board's task states move live (they already render whatever the status is).
- A workflow graph held at a limit shows **one** wait line for the graph, the existing `WaitLine`
  (warn tone, icon, "resumes at HH:MM" in Geist Mono, "Stop waiting"), in the orchestration header,
  derived from its running tasks' shared `waiting.moveId`; the per-task lines stay.
- `orch.error` (the watchdog's reason) shows under the header with the `bad` tone and its word.
- A failed task's error is the subagent's message; it already renders.
- Night Shift: tokens only, both themes, no new animation (a wait is not live work), en/es parity.

**Owns:** `apps/web/src/components/OrchestrationBoard.tsx`, `apps/web/src/pages/OrchestrationDetail.tsx`,
`apps/web/src/components/WaitLine.tsx`, `apps/web/src/lib/orchestration-board.ts`,
`apps/web/src/i18n/resources.ts` and `apps/web/test/fixtures/strings.json`; a case in
`e2e/specs/orchestration-v2.spec.mjs` checked with `node --check` only.

## 6. Docs (x1)

`docs/orchestrations.md` (the workflow engine: live states, limits, watchdog), `docs/accounts.md`
("At a limit": a workflow lead resumes its workflow), `docs/prompts.md` (Workflow lead, item 3),
`docs/requests.md` (R15 closed with the commits), and this plan's Outcome.

## Test fixture

`packages/core/test/fixtures/workflow-journal/` is a trimmed, anonymised copy of the f33d7d0b files,
three tasks instead of ten, laid out as the CLI lays them out under `projects/<cwd-slug>/`:

- `at-limit/<session>.jsonl`: the lead's transcript: the launch, the Workflow call, the notification
  with `<result>`, `<diagnostics>` and `<failures>`, and its own 429 turn.
- `at-limit/<session>/subagents/workflows/wf_fixture-0001/`: `journal.jsonl` (t1 and t2 `result`, t3
  and the synthesis `failed`) and each agent's transcript and meta; t3's and the synthesis's last line
  is the CLI's 429 entry as written, with ids, paths and branch replaced.
- `resumed/…`: the same run after the resume, appended to the same journal: t3 and the synthesis
  `started` again under the same keys with new agent ids, then `result`.

Session id `00000000-0000-4000-8000-000000000001`, cwd `/work/project`. No run record is included: the
first one was overwritten by the resume.

## Related

[[orchestrations.md]] · [[accounts.md]] · [[prompts.md]] · [[plans/rotation-auth-fixes.md]] ·
[[plans/limit-resume.md]] · [[plans/multi-provider.md]] · [[requests.md]]
