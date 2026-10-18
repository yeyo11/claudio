---
created_at: 2026-10-16T14:00:00Z
updated_at: 2026-10-18T12:00:00Z
tags:
    - lessons
    - memory
    - journal
    - decision-engine
    - security
    - claudio
---
# Lessons from corrections

A person corrects an agent in a project: "no, use pnpm", a denied permission, an undo, a hint to a
worker. When the chat goes quiet, Claudio may ask one cheap, confined `claude -p` run to turn that
stretch into at most five **lessons**. A lesson is a trigger ("When adding a dependency"), an action
("use `pnpm`, never `npm`"), its evidence and a confidence. Each one waits as a memory proposal of the
kind `lesson`. Nothing reaches a run until a person approves it. Approved lessons are handed to later
runs of the same project at the head of the journal handoff, lose confidence when nobody confirms them,
and retire on their own. A person can make one global, or propose it for `CLAUDE.md` after seeing the
diff. The plan that built it is [plans/lessons.md](plans/lessons.md); this page describes what was built.

The idea is credited to ECC by Affaan Mustafa (MIT). No ECC code, prompt, script or hook is used.

## The owner's rules

- **Project scope only.** Mining always produces lessons for the chat's project. A lesson is global
  only when a person promotes it.
- **A section of the journal handoff.** Not journal entries, which would be handed twice.
- **`CLAUDE.md` only through a proposal** the person approves after seeing the diff.
- **Mining is the decision point `lesson.mine`**, shipped `off` ([decision-engine.md](decision-engine.md#lessonmine)).
- **Nothing is imported.** Mined text is untrusted; lessons carry behaviour, never commands to run.
  Lessons can be exported as JSON, and no route, file or flag reads them in.
- **Every approval is the person's.** A chat's token can neither approve nor reject any memory
  proposal, nor touch a lesson ([security-model.md](security-model.md#lessons-and-a-chats-token)).

## Signals: what counts as a correction

`packages/core/src/lessons/signals.ts` holds a pure fold, `CORRECTION_FOLD`, over a chat's transcript
(read through `SessionStore.corrections`), plus rows in `lesson_signals` for what a transcript cannot
tell. It costs nothing and only decides whether there is anything to ask about.

In a chat Claudio started, every user text that is not a tool result is the person's, except what
Claudio wrote itself: hints and the cancel notice (the person's by proxy, counted as `hint` and
`cancelled`) and the restart nudges (ignored). The prefixes are exported by the code that writes them
and imported by the fold, so the two cannot drift. In flow and orchestration chats the first prompt
and every nudge are Claudio's; only hints, cancels, denials and lines after a hand-back are the
person's.

| Signal | Detected from | Starts a job alone |
| --- | --- | --- |
| correction | A person message after an assistant action that matches the lexicon, follows an interrupt or opens with a negation | Yes |
| hint | The hint prefix in a working chat or worker | Yes |
| denied | A `lesson_signals` row when the person denies a permission with a message that is not an automatic one; the message is the quote | Yes |
| cancelled | The cancel notice | Yes |
| reverted | An `Edit` undoing an earlier `Edit`, or `git restore`, `checkout --`, `revert`, `reset --hard`, `stash`, after a person message | Yes |
| rewound | A `lesson_signals` row when a resume carries `resumeSessionAt`; the next person message is the quote | Yes |
| interrupted | The interrupt marker; only weight for the next message | No |
| repeated error | The same tool failing the same way three times | Only with `signals.repeatedErrorsTrigger` (off) |
| rejected proposal | A memory or assistant proposal rejected with a reason | Yes |

CLI rule denials, QA bounces, budget stops, usage limits and a plain stop are not signals. The lexicon
is English and Spanish, whole words, and a message opening with "no" always counts; other languages
fall back to the signals that need no words. Signal rows are masked and cut to 1 KiB when they are
written, and are recorded only for projects where `lesson.mine` is `shadow` or `active`.

What the CLI leaves behind, as recorded for this feature ([recordings/l0-NOTES.md](../packages/core/test/fixtures/recordings/l0-NOTES.md)):

- A host deny's `tool_result` holds the person's message verbatim with `is_error: true`; the
  transcript's `toolUseResult` is `"Error: "` plus the message, so the fold reads `content`.
  `permission_denials` stays empty for a host-answered deny.
- An interrupt writes a user line whose content is a one-item `text` array,
  `[Request interrupted by user for tool use]` or `[Request interrupted by user]`.
- With `--system-prompt-snapshot on`, a different `--append-system-prompt` on `--resume` is ignored.
  A chat keeps the lessons it started with.

## Mining

A trigger turns a chat's corrections into a row of `lesson_jobs`. A tick every 30 s claims one job at a
time under `BEGIN IMMEDIATE` with the caps (the desktop app and a dev server can share one data
directory). A job has two steps, because the decision engine answers only typed questions and a lesson
is free text:

1. **The gate.** `lesson.mine` asks one `noul` question: is there a lesson here? In `shadow` it is
   asked and recorded, and the miner never runs. In `active` a yes starts the miner.
2. **The miner.** One internal one-shot chat built by `runOneShot` (the helper the decision provider
   also uses): `--json-schema`, `--max-budget-usd`, `--restricted --tools= --setting-sources=`,
   `--no-session-persistence`, `dontAsk`, no tools, no settings, no API token. It reads at most 24 KiB:
   the signals, the project's active lessons and its `CLAUDE.md`, each in a `pasted()` block. Its
   answer is up to five candidates with the signal ids they rest on, the person's quote, a confidence,
   `restates`, `contradicts` and `mechanical`. The prompt is in [prompts.md](prompts.md#lesson-miner-minerprompt).

A chat outside any project is never mined, nor is a confined, internal or assistant chat. Terminal
chats are not mined automatically. A job waits when the account is at its limit and retries once on a
bad answer.

**Manual mining.** "Look for lessons" in a project chat's "⋯" menu works while `lesson.mine` is `off`,
because a click is not something Claudio does on its own. It shows the cost cap before it starts,
skips the gate, is refused to chat tokens, and is limited to one run per chat per 10 minutes. The
setting `manualMining` ships `true`.

### Checks on each candidate

Everything the model returns is hostile text, since it was written after reading a chat that is handed
to later runs. `lessons/validate.ts` drops a candidate at the first failing rule and counts it
(`empty`, `too-long`, `no-signal`, `secret`, `url`, `command-like`, `suspicious`, `not-english`,
`restates-instructions`, `duplicate-rejected`). A lesson names tools and paths in inline code and never
contains a command line, a code block, a URL or a secret. A lesson resting only on repeated errors is
capped at 0.5 confidence. `lessons/match.ts` then compares what survives with the project's lessons
(similar at 0.45, the same at 0.75, never the same when code tokens differ or only one side is
negated): the same lesson raises the old one's seen count, a contradiction is flagged, and a rejected
one is not proposed again.

## Approval

A candidate becomes a `lessons` row with status `proposed` and a `memory_proposals` row of kind
`lesson`, so approving and rejecting use the routes that exist for memory proposals. The Memory tab
shows the sentence, two quotes of evidence and warn badges ("Contradicts", "Conflicts with
`CLAUDE.md`"). Approving a lesson that contradicts another asks first, and retires the contradicted one
with it. A person may edit the trigger and action before approving; an edited lesson keeps the person's
words in whatever language. Only the miner can create a `lesson` proposal: the flow and the memory
proposal service refuse it from anyone else.

Approval sets confidence to at least `approveFloor` (0.8), so the lesson is delivered at once. Rejecting
with a reason is itself a signal, and a rejected lesson's text is kept so it is not proposed again
(`duplicate-rejected`).

## Delivery

`LessonService.section(projectId)` builds the **Lessons** section (`lessons/render.ts`): the heading,
one lead sentence outside the block that authorises following the lessons, and the lessons inside one
`pasted()` block. Each line reads `- L-12 · project · 0.85 · trigger: action`. Lessons are ordered
pinned first, then by confidence, seen count, recency and key. The budget is 2 KiB (`delivery.handoffBytes`,
at most 4 KiB), counting the heading, the lead and the wrapper; whole lessons only, and one that does
not fit is skipped. The section is cached per project for 30 s and dropped on `lesson.changed`. Only
`active` lessons whose effective confidence is at least `deliverAt` (0.7) are handed, and a global
lesson a project lesson overrides is left out.

| Run | Gets lessons | How |
| --- | --- | --- |
| Flow runs, project assistant runs | Yes | The `## Lessons` section ahead of the entries in the journal handoff |
| Interactive chats in a project | If the project's `deliverToChats` | Appended to `--append-system-prompt` on every spawn, never stored in the chat's options |
| Chats outside a project | Global lessons, if `delivery.looseChats` | The same |
| Orchestration workers, integrator, fixer, planner | If `deliverToWorkers` | The same |
| The Claudio assistant, decision chats, the miner, titles and summaries | No | Confined or housekeeping |
| A project with the Memory module off | No | Lessons are part of Memory |

A project's `useGlobal` switch decides whether global lessons are included. The journal itself keeps
its 16 KiB cap; the Lessons section counts inside it ([team-and-flow.md](team-and-flow.md#the-journal)).

## Confidence and decay

Confidence is a number up to `max` (0.95). A repeat sighting adds `seenStep` (0.05); a person's
"still holds" adds `confirmStep` (0.1). After `graceDays` (60) without a confirmation the effective
value falls by `step` (0.1) every `periodDays` (30). An hourly sweep retires an unpinned active lesson
below `retireBelow` (0.3). A pinned lesson never decays. `lessons/decay.ts` is pure; the clock is
handed in. Retiring is reversible (Restore); deleting is not, and removes the evidence with it. A
lesson waiting for a decision cannot be deleted.

## Promotion and `CLAUDE.md`

- **Promote** makes an active project lesson global and answers the global one; **Demote** moves it back
  to a project.
- **Propose for `CLAUDE.md`** creates an `instructions` proposal from a lesson. Every `instructions`
  approval, from a lesson or not, opens a diff dialog first (`DiffView`, reading mode; a full-height
  `Sheet` on a phone). The preview comes from `POST /memory-proposals/:proposalId/preview`; Approve is
  enabled once it has loaded, and a 409 means the file changed and reloads it. A section field picks the
  heading; the preview and approve requests accept an optional `section` for it.

## Settings

Global settings are `lessons.json` (`GET` and `PUT /lessons/settings`, partial body, 400 names a field
out of range):

| Field | Default |
| --- | --- |
| `manualMining` | `true` |
| `miner` | `model: haiku`, `effort: null`, `maxCostUsd: 0.05`, `deadlineSeconds: 120` |
| `caps` | 0.25 USD a day per project, 1 USD a day in total, one job per chat per 30 minutes, 20 jobs a day per project |
| `confidence` | `approveFloor` 0.8, `deliverAt` 0.7, `seenStep` 0.05, `confirmStep` 0.1, `max` 0.95 |
| `decay` | `graceDays` 60, `periodDays` 30, `step` 0.1, `retireBelow` 0.3 |
| `delivery` | `handoffBytes` 2048, `looseChats` true |
| `signals` | `repeatedErrorsTrigger` false |

A project's own settings document has `lessons: { deliverToChats, deliverToWorkers, useGlobal }`, all
true. The worst case of mining is 1 USD a day in total; with `lesson.mine` off it costs nothing.

## Where it shows

- **Memory tab**: a Lessons card in the right column between CLI memory and Handed, and a fourth
  Lessons segment on a phone. Rows carry pinned, fading, delivered and the retired reason, an evidence
  toggle and a "⋯" menu (a `Sheet` on a phone). The footer shows the mining mode and recent jobs. The
  Handed card shows the lesson count.
- **Settings → Instructions & memory → Lessons**: the global lessons, the miner settings and the three switches. Project
  settings carry the three delivery switches under Memory.
- **Chat page**: "Look for lessons" in the "⋯" menu, with a cost confirm.
- **Settings → Decisions → Points**: `lesson.mine` in the Memory area.

## Routes

The REST rows are in [rest-api.md](rest-api.md). Lessons: list a project's (`status`, with what is `handed`), export,
mining jobs, global list, settings, one lesson, edit or pin, confirm, retire, restore, delete, promote,
demote, propose for `CLAUDE.md`, and `POST /chats/:id/lessons/mine`. Events: `lesson.changed` and
`lesson.job`. Every route that decides, edits, mines or configures a lesson answers 403 to a chat's
token.

## What differs from the plan

- The section field of the diff dialog needed a route change the plan did not list: the preview and
  approve requests of an `instructions` proposal accept an optional `section`.
- The badges "Similar to L-x" and "Brings back L-x" and the Merge into / Keep both choice are not
  built, because `Lesson` carries no data for them. "Contradicts" and "Conflicts with `CLAUDE.md`" are.
- Evidence links go to the chat, not to the entry, since the chat page cannot jump to an entry. "Chat
  deleted" shows when `chatId` is null; the API still returns `chatTitle: null` for it.
- The "Look for lessons" strings are in the `chats` namespace (`chats:lessons.*`), because `chat.json`
  belongs to `@claudio/chat-ui`.
- The recorded CLI is `2.1.301`; the plan was written against `2.1.300`, and no flag differs.
- The `result` line of a `--json-schema` run carries `structured_output` and also `result` as a string;
  the miner reads `structured_output`.

## Related

[[plans/lessons.md]] · [[team-and-flow.md]] · [[decision-engine.md]] · [[security-model.md]] ·
[[prompts.md]] · [[design-system.md]] · [[reports/ecc.md]] · [[knowledge-base.md]]
