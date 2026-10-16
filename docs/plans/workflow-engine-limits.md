---
created_at: 2026-10-16T22:56:49.813601305Z
updated_at: 2026-10-16T22:57:30.850065206Z
tags:
    - plan
    - orchestration
    - accounts
    - decided
---
# Plan: the workflow engine follows its journal, holds or rotates at a limit, and never runs unwatched

Status: decided (2026-10-17). Answers R15 of [requests.md](../requests.md). Tasks b1, b2, b3, w1 and x1 carry it out; each section names the files its task owns. Full text: docs/plans/workflow-engine-limits.md.

The one rule holds: everything is read from what the Claude Code CLI ships (the workflow journal, each subagent's transcript, the run's record, stream-json `result` and `rate_limit_event`, the Workflow tool's `resumeFromRunId`). A limit is recognised from structured fields (`api_error_status` / `apiErrorStatus` 429, `rate_limit_info`), never from wording.

## What happened (orchestration f33d7d0b, 2026-10-16)

- Subagent g8 and then the synthesis were refused with a 429 (`error: "rate_limit"`, `apiErrorParams.rate_limit_info.resetsAt`, `rateLimitType: five_hour`) as the last assistant entry of their transcripts; the journal recorded `failed`. The script went on, skipped z1, and the workflow ended "completed" with `<failures>` and a `<diagnostics>` resume hint in its task notification.
- The lead's own turn hit the same 429; `Orchestrator.workOf` returns null for a workflow lead, so the rotation only posted "this turn is not replayed": no move, no wait.
- The lead had started background `sleep 30` loops over its own journal (pushed by `DELEGATION` in its prompt), so its process lived on; `followWorkflow` waits for the stream's end or the process to go, and neither happened. The graph stayed running, g8 pending, 25 min.
- A manual stop + resume sent `resumeFromRunId` to the same session; `chooseAccount` picked another account; the CLI resumed into the same run id and journal, replayed finished agents from cache, and re-ran g8 under the same key. Every account's `projects/` links to one directory, so the cache is visible from any account.

## 1. Live task states from the journal (b1)
The journal (`<transcript base>/subagents/workflows/<wfRunId>/journal.jsonl`) becomes the source of task states: started → running, result → completed with the full result, failed → failed with the subagent's last message (a limit or 401 goes to section 2); a key's latest line wins; label `synthesis` drives synthesis timestamps and finalResult. The run id is learnt from the new `wf_*` directory. `fromJournal` records `failed` too (today the fixture's failed agents read as `progress`). Owns workflows.ts (`readWorkflowJournal`, `readAgentEnd`), new workflow-journal.ts, sessions.ts, orchestrator.ts (`syncWorkflow`, `learnWorkflowRunId`, `finishWorkflow`), index.ts wiring; tests workflow-journal.test.ts, workflow-engine.test.ts, fake-claude-control.mjs.

## 2. Limits held or rotated like a graph task's (b2)
Decision: stop the workflow at the first limit (subagent via journal, or the lead's own 429), hand the lead's chat to the rotation as automated work (`workOf` → subjectKind 'task', subjectId '<orch>:__workflow__'), and go on by resuming the workflow from its cache, never by replaying the lead's turn. New `RotationDeps.replay(chatId, account)` hook → `Orchestrator.replayWorkflow` → `ChatManager.replayWith(chatId, resumePrompt, account)`; `ChatManager.limitReached` records a subagent's reading on the account. No room → a provider_moves wait with the reset time; the graph stays `running` with the LimitWait on its running tasks (`waiting` keeps meaning "a person decides"). `waitEnded` gets a workflow branch; `stop()` releases the lead's wait; `limitReplays` reset when the journal shows progress. Owns rotation.ts, chats.ts, orchestrator.ts, index.ts; tests workflow-limits.test.ts, rotation.test.ts.

## 3. Watchdog (b3)
A running workflow graph always has a live lead, an open wait, or a pending launch. Record/stream says ended but process up after 60 s → stop and finish; process gone with a limit → section 2; gone otherwise → finish with reason in `orch.error`; nothing grew for 30 min → stop, failed, resumable; startup keeps a graph with an open wait running. Owns orchestrator.ts; test workflow-watchdog.test.ts.

## 4. Lead prompt (b3)
Drop `DELEGATION` from the lead; add `WORKFLOW_LEAD_WAIT` in prompt-rules.ts: no sleep, polling, Monitor, background command or reading its files; end the turn after launching; on the notification, one line naming failed agents. Tools are not denied (the deny list could reach subagents); the watchdog is the guarantee.

## 5. Web (w1)
No shared type changes. One graph-level WaitLine for a workflow held at a limit, `orch.error` shown with the bad tone, live states. Owns OrchestrationBoard.tsx, OrchestrationDetail.tsx, WaitLine.tsx, lib/orchestration-board.ts, i18n resources + strings.json, orchestration-v2.spec.mjs.

## 6. Docs (x1)
orchestrations.md, accounts.md, prompts.md, requests.md (close R15), this plan's Outcome.

## Test fixture
packages/core/test/fixtures/workflow-journal/{at-limit,resumed}: trimmed, anonymised copy of the f33d7d0b files (3 tasks, session 00000000-0000-4000-8000-000000000001, cwd /work/project), with the CLI's real 429 entry.

## Related
[[orchestrations.md]] · [[accounts.md]] · [[prompts.md]] · [[plans/rotation-auth-fixes.md]] · [[plans/limit-resume.md]] · [[plans/multi-provider.md]] · [[requests.md]]