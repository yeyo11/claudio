---
created_at: 2026-10-15T21:00:00Z
updated_at: 2026-10-15T21:00:00Z
tags:
    - plan
    - evals
    - team
    - agents
    - skills
    - instructions
    - worktrees
    - verification
    - claudio
---
# Plan: instruction-compliance evals

Status: **planned** (2026-10-15). Nothing is built. Phase 1 can be launched as written. Phase 2 is
designed here too, but it starts only after the owner has checked Phase 1's
[success criterion](#phase-1-success-criterion-the-gate-to-phase-2).

**Summary.** You edit a team's agent file, a skill, a rule or `CLAUDE.md`, and you want to know
whether agents now follow it. An *eval* answers that. It is a small JSON file in the project, with a
few *cases*. Each case is a prompt plus deterministic *expectations* about what the agent does:
which tools it calls, in what order, with which commands or paths, and what the repository looks
like afterwards. Claudio runs each case on a pinned commit, in a throwaway worktree, through the
same headless Claude Code chats it already uses for the flow and the decision engine. It folds the
tool calls out of the stream and checks them in plain code. You can run the target *as committed*,
*as it is now* and *as you propose it*. A proposed edit is written only into the eval worktree,
never into your checkout. Results are SQLite rows, so you can compare and export them.

Phase 1 is the owner's "a few prompts, then a check of the tool calls". Phase 2 adds pressure
levels, pass@k and pass^k, `must-hold` cases, an LLM judge, a promotion gate that never applies
anything by itself, and cases drafted by the project assistant.

**Credit.** The idea is from ECC ("Everything Claude Code") by Affaan Mustafa, MIT-licensed
(`skills/skill-comply/`, `skills/eval-harness/`, `ecc2` `harness-eval`), as studied in
[reports/ecc.md](../reports/ecc.md) §3 ★5. No ECC code, prompt, schema or script is copied.

## Decisions

The first three come from the owner (via [reports/ecc.md](../reports/ecc.md), "Decisions
(2026-10-15)", item 5, and the task that ordered this plan). The rest are the architect's
(2026-10-15). Each one says what it rejects. The owner may overturn any of them before `e1` starts.

1. **Minimal first (owner).** Phase 1 means prompts plus deterministic checks of the tool calls and
   of the resulting worktree. No LLM judge, no pass@k statistics and no promotion gate in Phase 1.
2. **Phase 2 is gated (owner).** It starts only when the owner confirms the Phase 1 success
   criterion below.
3. **Nothing starts on its own (owner).** Only a person's click starts an eval run: no schedule,
   no flow hook, no decision point and no MCP write tool. The start dialog shows the cost ceiling,
   and the start request must repeat it (`confirmMaxCostUsd`), so a client cannot start a run
   whose ceiling the person never saw.
4. **Definitions are a JSON file per eval, in the project.** They go under
   `<project>/.claude/claudio-evals/<name>.json`, so they can be committed (CONTRIBUTING: settings
   go in JSON, stream data in SQLite). Rejected: storing them in `<dataDir>/project-settings/`,
   because they could not then be shared with the repository.
5. **Results are rows.** Runs, samples, calls and checks are SQLite tables, appended at the end of
   `MIGRATIONS` in `packages/core/src/db.ts:60-807`. Rejected: one JSON blob per run, which breaks
   "rows, not blobs" because two processes share one data dir.
6. **A sample is a housekeeping chat of `ChatManager`.** That means
   `claude -p --input-format stream-json --output-format stream-json` with `keepAlive: false` and
   `internal: true`, started with `runtime.start` (`packages/core/src/chats.ts:572`) and awaited
   with `waitForResult` (`chats.ts:1031`), as `CliDecisionProvider.ask` does
   (`packages/core/src/decisions/providers/cli.ts:128-209`). There is no new CLI surface and no
   one-shot runner of our own. This way account choice, the concurrency limit, budgets, stopping
   and process-tree cleanup all come for free. Rejected: a separate `spawn('claude', ['-p', prompt])`.
7. **Each sample runs in a detached worktree on a pinned commit, outside the repository.** Worktree
   *lanes* are reused between samples (reset and clean), and every lane is removed when the run
   ends. Rejected: putting them under `<repo>/.claude/worktrees/`, where orchestration puts its
   own (`packages/core/src/orchestrator.ts:207`). Claude Code reads `CLAUDE.md` files from parent
   directories, so the checkout's own `CLAUDE.md` would leak into every variant (fact F1).
8. **Three variants of the target.**
   - `pinned` is the file as committed at the pin.
   - `current` is the file in the checkout now, saved or not yet committed.
   - `proposed` is text that the person sends with the start request.
   `current` and `proposed` are overlaid onto the worktree only. For an agent target, the same
   text also becomes the `--agents` definition, as the flow does in `flowAgentsFile`
   (`packages/core/src/index.ts:2126-2154`).
9. **Phase 1 checks are deterministic only:**
   - tool-call expectations;
   - the final text;
   - file reads, done by Claudio itself;
   - "touched" checks over `git status`;
   - commands, which require consent.
10. **At a usage limit, a sample is not scored. It is run again from scratch.** It is never
    replayed. Replay (`chats.ts:1438`) resumes a session, and a housekeeping chat keeps no
    transcript to resume. A replayed sample would also mix two accounts' behaviour.
11. **Placement: a fourth section of the Team screen, `?view=team&section=evals`.** This extends
    `TeamSection` (`apps/web/src/pages/team/model.ts:265`) and the segmented control
    (`apps/web/src/pages/team/Team.tsx:114-131`), as [reports/ecc.md](../reports/ecc.md) sketches.
    It follows that a project needs the Team module to use evals. Rejected for Phase 1: a new
    project tab or module (`apps/web/src/pages/dashboard/views.ts:7,12`), which widens the project
    strip for a feature that is not yet proven.
12. **Phase 1 targets: project-scope agent files, skills, rules, and `CLAUDE.md` / `CLAUDE.local.md`.**
    - User-scope files can be evaluated only as they are (`pinned` is meaningless and `proposed`
      is refused), because a proposal must never be written to the person's config dir.
    - Output styles, slash commands and workflows wait until fact F9/F11 is recorded. They are
      Phase 2 candidates.
13. **Tool policy.**
    - An agent target that is a team member runs under the flow's `stagePolicy`
      (`packages/core/src/flow.ts:456-496`), for the stage the eval names (`work` by default), and
      gets the same permission mode. The eval then measures the member as the flow really runs it.
    - Any other target runs under the eval's own `ToolPolicy` (`packages/shared/src/types.ts:1030`).
      The default is: read anything, edit anything, any command, `network: 'omit'`,
      `gitPush: 'deny'`, in `dontAsk`.
    - Every sample runs with `api: false` (no `CLAUDIO_API_TOKEN`) and `uploads: false`
      (`packages/core/src/live-chat.ts:103,112`).
14. **The journal is not appended.** A flow run gets `JournalService.handoff` through
    `--append-system-prompt` (`flow.ts:1452`). An eval leaves it out, so that the target is the
    only thing that differs between variants and between runs.
15. **Git hooks are off for every git command an eval runs.** Every eval git call gets
    `-c core.hooksPath=/dev/null -c core.fsmonitor=false`. `git worktree add` and `checkout` run
    `post-checkout`, and an fsmonitor setting runs a command, both from configuration that the
    repository may carry. The person consents to the commands an eval runs, and to nothing else.
16. **Consent is given per eval file content.** Before the first run of a file, and again after the
    file changes, the person sees and accepts every prompt, the setup command and every assertion
    command. Consent is keyed by the file's SHA-256 and kept in `<dataDir>/eval-consents.json`, as
    the decision engine keeps consent per state version ([decision-engine.md](../decision-engine.md),
    "Consent per point"). The reason: a committed eval file is repository content, and someone
    else may have written it.

## Goals and non-goals

**Goals (Phase 1)**
- Write an eval for a target in the Team screen, with cases and expectations. A JSON view is
  always available for anything the form cannot express.
- Run it on `pinned`, `current` and/or `proposed`, with k samples per case (1 to 5), within a cost
  ceiling the person accepted.
- See each sample's tool calls, each check with its evidence, the cost, the time, the account and
  the model.
- Compare variants case by case. Keep a history and export it (JSON and Markdown).
- Recover from cancellation, restart, usage limits, a missing pin, a deleted target and invalid
  files, and say what happened in words.

**Non-goals (Phase 1)**
- Judged ("LLM") expectations, pressure levels, pass@k / pass^k, and the promotion gate (all
  Phase 2).
- Running evals from the flow, from schedules, from CI or automatically after an edit.
- Applying an edit because an eval passed. Saving stays the person's existing Save.
- Evals of projects without git, or without a commit.
- Evaluating other vendors' agents. Claudio drives Claude Code only
  ([plans/claude-only-fork.md](claude-only-fork.md)).
- Sparse checkouts, and installing dependencies on Claudio's initiative. A `setup` command is the
  person's own, with consent.

## CLI facts

Claude Code 2.1.300 (`claude --version`, 2026-10-15). The one rule (CONTRIBUTING, "The one rule")
holds: every surface used below is already in the README table, "How it talks to Claude"
(`README.md:195-212`), or is a documented flag in `claude --help`.

### Recorded (read from `--help` or from Claudio's own code and recordings)

| Fact | Source |
|---|---|
| Every automated run is `-p --input-format stream-json --output-format stream-json --verbose`, and the prompt goes in on stdin | `packages/core/src/providers/claude-code/args.ts:6-13`; `driver.ts:53-60` |
| `--max-budget-usd <amount>` works only with `--print`. The result subtype `error_max_budget_usd` means the budget ran out | `--help`; `args.ts:54-55`; `stream.ts:15,246` |
| `--no-session-persistence` (with `--print`) writes no transcript. Claudio passes it for `internal` chats | `--help`; `args.ts:68` |
| `--agent <name>` and `--agents <json-or-file>`, the file form with `--print` | `--help`; `args.ts:29-30`; flow uses both (`index.ts:2088`) |
| `--setting-sources <user,project,local>`; `--restricted` ignores the settings files and removes the code-running tools unless `--tools` names them | `--help`; `args.ts:46` |
| `--bare` skips `CLAUDE.md` auto-discovery and accepts only `ANTHROPIC_API_KEY` auth, so it cannot be used with OAuth accounts | `--help` |
| `--permission-mode` choices: `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan` | `--help` |
| `--json-schema <schema>` gives `structured_output` on the result (Phase 2 judge) | `--help`; `stream.ts:233-262` |
| `result` carries `is_error`, `num_turns`, `total_cost_usd`, `duration_ms`, `permission_denials`, `stop_reason`, and `api_error_status` 429 on a limit | `stream.ts:233-262`; `RunOutcome` at `packages/shared/src/types.ts:457-471` |
| `tool_use` / `tool_result` blocks reach `TranscriptEntry` with `isSidechain` and `parentToolUseId` | `packages/shared/src/types.ts:213-246`; `normalize.ts:68` |
| `rate_limit_event` per turn; a 429 result when the turn dies on a limit | `README.md:206`; `stream.ts:210-231` |
| `--max-turns`, `--thinking`, `--resume-session-at` are passed by `args.ts` but not shown in `--help` | `args.ts:57`; `--help` |

### To record before building (task `e0`, never guessed)

| Id | Question | Why it matters | If the answer is "no" |
|---|---|---|---|
| F1 | Does `-p` load `CLAUDE.md` / `CLAUDE.local.md` from the cwd's ancestors, above a worktree's own root? Does `--setting-sources` change which memory files load, including the user's `CLAUDE.md`? | Where lanes may live (decision 7), and whether a run can exclude the person's user memory | Lanes stay outside the repo, and the root check below stays |
| F2 | When `--agent X` and `--agents <file>` both define X, does the file win over `<cwd>/.claude/agents/X.md` and `~/.claude/agents/X.md`? | The `proposed` variant of an agent target | The proposal is written only to the worktree file, without `--agents` |
| F3 | Are skills under `<cwd>/.claude/skills/` discovered in `-p`? What does a skill invocation look like in the stream (tool name, input field)? | Skill targets and `Skill` call matchers | Skill targets wait |
| F4 | Are `.claude/rules/*.md` files, with and without `paths:`, loaded in `-p` from a worktree? | Rule targets | Rule targets wait |
| F5 | In `dontAsk`, what does a denied call look like: a `tool_result` with `is_error` and what text, plus `permission_denials` on the result? | The `denied` outcome of a call | Denials come only from `permission_denials` |
| F6 | Does the hidden `--max-turns` work on 2.1.300? | A turn cap per sample as a second guard | The budget and Claudio's clock are the only caps |
| F7 | The input field names of each built-in tool (`Read`, `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `Glob`, `Grep`, `Bash`, `Skill`, `Task`/`Agent`), and whether paths are absolute | Path matchers and their normalisation | The extractor table in `e3` follows the recording |
| F8 | Do subagent calls arrive with `parent_tool_use_id` set in `-p`? | Scope `main` vs `sub` | Every call counts as `main`, and the scope option is hidden |
| F9 | Is a stream-json user message `/name args` run as a slash command or skill in `-p`? | Command targets (Phase 2) | Command targets stay out |
| F10 | How far can `total_cost_usd` exceed `--max-budget-usd` in one sample? | The cap reservation margin | The margin stays at 25 % |
| F11 | Does an `outputStyle` in project settings apply in `-p`? | Output-style targets (Phase 2) | They stay out |
| F12 | Does `rotation.ts`'s replay of an `internal` chat (`rotation.ts:147-185`, `chats.ts:1438`) send its turn into a process that cannot resume? (code reading plus one fake-CLI run) | Decision 10 | The `e6` guard is needed either way; this fact only sets its test |

The recording follows the scrubbing of [plans/multi-provider.md](multi-provider.md) phase 3. It goes
to `docs/reports/instruction-evals-e0.md`, with fixtures under
`packages/core/test/fixtures/recordings/evals/`. A fact that contradicts this plan becomes a
correction here before the task that depends on it starts.

## Phase 1 design

### The eval file

- **Path:** `<project>/.claude/claudio-evals/<name>.json`.
- **Name:** `<name>` matches `^[a-z0-9][a-z0-9-]{0,63}$` and is the eval's id within the project.
  Any other file in the folder is listed as `invalid` with the reason, and never run.
- **Encoding and size:** UTF-8, at most 256 KiB.
- **Parser:** a hand-written `parseEvalDefinition(value: unknown)` that throws. The codebase has no
  schema library (`project-settings.ts:333,361`), and this follows it. The parse is strict on
  write. On read it is lenient per case: one bad case marks the eval `invalid` with every problem
  listed, and the other evals still load.
- **Language:** prompts, titles and expectation notes are English (the records rule,
  `packages/core/src/team.ts:52`). A person's own words stay as written, and the editor says so.

```json
{
  "version": 1,
  "title": "Developer runs the tests after its last edit",
  "target": { "kind": "agent", "scope": "project", "name": "developer" },
  "runAs": { "agent": "developer", "stage": "work", "model": "claude-sonnet-5-5", "effort": null },
  "pin": "a56d826e1c0b0d4c7f1e4f5a8b2d9e3c6f7a1b2c",
  "samples": 2,
  "limits": { "maxCostUsdPerSample": 0.6, "timeoutMinutes": 10, "maxCostUsd": 6 },
  "policy": null,
  "setup": null,
  "cases": [
    {
      "id": "fix-off-by-one",
      "title": "Fixes a failing test and runs the suite after the edit",
      "prompt": "The test `packages/core/test/range.test.ts` fails. Fix `packages/core/src/range.ts`.",
      "expect": [
        { "kind": "before", "call": { "tool": "Read", "path": "packages/core/test/range.test.ts" }, "anchor": { "tool": ["Edit", "MultiEdit", "Write"] } },
        { "kind": "after", "call": { "tool": "Bash", "command": "pnpm*test*" }, "anchor": { "tool": ["Edit", "MultiEdit", "Write"] }, "ifAnchor": true },
        { "kind": "not-called", "call": { "tool": "Bash", "command": "git push*" } },
        { "kind": "called", "call": { "tool": "Edit", "path": "packages/core/src/**" }, "min": 1, "max": 6 },
        { "kind": "touched", "path": "CHANGELOG.md", "expect": false },
        { "kind": "file", "path": "packages/core/src/range.ts", "contains": { "regex": "<=\\s*end" } }
      ]
    }
  ]
}
```

**Fields** (`?` means optional; defaults in brackets):

| Field | Type | Rule |
|---|---|---|
| `version` | `1` | Any other value is refused with `unsupported-version` |
| `title` | string, 1–120 characters | |
| `target.kind` | `agent` \| `skill` \| `rule` \| `instructions` | Phase 1 set (decision 12) |
| `target.scope` | `project` \| `user` | `user` allows only `current` |
| `target.name` | string | `agent`: `.claude/agents/<name>.md`. `skill`: `.claude/skills/<name>/SKILL.md`. `rule`: `.claude/rules/<name>.md`. `instructions`: `CLAUDE.md` or `CLAUDE.local.md`. Paths come from `config/scope.ts:6-33` and `config/resources.ts:18-25`, and never from the file |
| `runAs.agent?` | string | Runs the session as that agent (`--agent`). It must equal `target.name` when the target is an agent, and may name a member for other targets |
| `runAs.stage?` | `refine` \| `work` \| `verify` [`work`] | Only when `runAs.agent` is a team member. Picks `stagePolicy` |
| `runAs.model?` | string [the member's model, else `sonnet`] | Exact ids are recommended. The model the CLI reports in `init` is recorded per sample |
| `runAs.effort?` | effort level \| null | As `effortOption` in the flow |
| `pin` | 40-hex SHA | A full SHA only: a branch name moves. The editor's "Pin to HEAD" fills it |
| `samples` | 1–5 [2] | k per case and variant |
| `limits.maxCostUsdPerSample` | 0.05–5 [0.5] | Passed as `--max-budget-usd` |
| `limits.timeoutMinutes` | 1–60 [10] | Claudio's own clock, as in `task-limits.ts:4-6` |
| `limits.maxCostUsd` | 0.05–200 [samples × cases × 2 × per sample] | The run's ceiling. The start dialog may lower it, never raise it |
| `policy?` | `ToolPolicy` \| null | Ignored when `runAs.stage` applies |
| `setup?` | shell command \| null | Runs once per lane, before its first sample, under consent. Its limit is `limits.timeoutMinutes` |
| `cases[]` | 1–20 entries | |
| `cases[].id` | `^[a-z0-9][a-z0-9-]{0,47}$` | Unique within the file |
| `cases[].prompt` | string, 1–8,000 characters | Sent as the sample's first and only message |
| `cases[].pin?` | 40-hex SHA | Overrides `pin` for this case |
| `cases[].expect[]` | 1–30 expectations | |

### The expectation grammar

**A call** is one `tool_use` block, folded with its `tool_result`, and numbered by `seq` in stream
order. A call has:
- `name`;
- `input`;
- `message`: the index of the assistant message that carried it;
- `scope`: `main`, or `sub` when `parentToolUseId` is set;
- `outcome`: `ok`, `error`, `denied` (its id is in `permission_denials`) or `open` (no result
  before the end).

**String matcher** (`S`):

| Form | Meaning |
|---|---|
| `"text"` | A glob over the whole value. For `command`, `*` matches any characters, spaces and `/` included. For `path`, `*` stops at `/`, `**` crosses it, `?` is one character, and `{a,b}` is alternation |
| `{ "equals": "text" }` | Exact |
| `{ "contains": "text" }` | Substring, case-sensitive |
| `{ "regex": "src", "flags": "i" }` | A JS `RegExp`. `src` is at most 512 characters, the flags are only `i`, `m`, `s` and `u`, and the value is cut to 16 KiB before matching |

**Call matcher** (`M`). Every field given must match:

| Field | Matches |
|---|---|
| `tool` | A name glob (`"mcp__*"`) or a list of them, against `name` |
| `command` | `S` against each *segment* of a `Bash` command (below). It matches when the whole command or any segment matches |
| `path` | `S` against the call's path (F7 table), normalised: relative to the lane root, `/` separators, no `./`. A path outside the lane stays absolute and never matches a relative glob |
| `input` | An object `{ field: S }` against top-level string fields of the input, for tools the other fields do not cover (`Skill`, MCP tools) |
| `outcome` | `ok` \| `error` \| `denied` \| `any` [`any`] |
| `scope` | `main` \| `sub` \| `any` [`main`] |

**Command segments.** A quote-aware tokenizer splits on `&&`, `||`, `;`, `|` and newlines. From
each segment it strips leading `VAR=value` assignments, `cd <dir> &&` chains, and the wrappers
`timeout <n>`, `env`, `nice` and `command`. So `cd pkg && timeout 300 pnpm test` has the segment
`pnpm test`. Claudio's own prompts ask agents for `timeout` (`verification.ts:359,399`), which is
why it is stripped. Heredocs and `$(…)` stay inside their segment as text.

**Expectations.** All of a case's expectations must pass for the sample to pass.

| `kind` | Fields | Passes when |
|---|---|---|
| `called` | `call: M`, `min?` [1], `max?` | The number of matching calls is within `[min, max]`. `min: 0` with a `max` is a count cap |
| `not-called` | `call: M` | No call matches |
| `before` | `call: M`, `anchor: M`, `ifAnchor?` [false] | A matching `call` sits in a *strictly earlier assistant message* than the first `anchor` call. Calls in the same message are simultaneous, because the model wrote them before it saw either result. With no anchor call: pass if `ifAnchor`, else fail with "the anchor never happened" |
| `after` | `call: M`, `anchor: M`, `ifAnchor?` [false] | A matching `call` sits in a strictly later message than the last `anchor` call. With no anchor call, the same rule as `before` |
| `sequence` | `calls: M[]` (2–10), `strict?` [false] | Not strict: the calls appear as a subsequence, in increasing messages. Strict: they are consecutive among `main` calls |
| `text` | `match: S` | The final `result` text matches |
| `file` | `path` (relative, no glob), one of `exists: bool`, `contains: S` | Read by Claudio after the sample. Its realpath must stay in the lane, and at most 1 MiB is read |
| `touched` | `path: S`, `expect: bool` | Whether any path in `git status --porcelain=v1 -z` (against the pin plus the overlay) matches |
| `command` | `run`, `exitCode?` [0], `timeoutSeconds?` [120, max 1800] | Runs in the lane with `runCommand` (`verification.ts:229`). Needs consent (decision 16) |

The sample itself must also end well. `isError`, the budget and the timeout fail it, with that as
the first failed check. A check that cannot be evaluated is a failure, with the reason in `detail`.
The parser rejects unknown keys and unknown kinds with a path to the field (`cases[0].expect[2].anchor.tool`).

### The runner

`packages/core/src/evals/` holds:
- `definition.ts` (file, parse, consent);
- `matchers.ts` and `score.ts` (pure);
- `lanes.ts` (worktrees);
- `store.ts` (SQL);
- `runner.ts` (queue);
- `export.ts`.

**Start (`EvalService.start`)**
1. The project must be imported (`projects.ts:152`), its Team module on, `isGitRepo`
   (`git.ts:34`) true and a commit present (`baseOf`, `orchestrator.ts:252`). Otherwise the start
   is refused with a reason code.
2. Parse the file. Compute `sha256` of its bytes. Check consent when it has `setup` or `command`
   checks, and also on first use of a file not written through Claudio (`definition.ts` records
   the hashes Claudio wrote).
3. For each pin, run `git cat-file -e <sha>^{commit}`. If it fails, refuse with `pin-missing`
   (shallow clone, garbage-collected, rewritten history) and name the case.
4. Build the variants:
   - `pinned` is read with `git show <pin>:<path>`.
   - `current` is read from the checkout.
   - `proposed` comes from the request.
   A target absent from a variant is allowed for `instructions`, `rule` and `skill`; that is a
   baseline of "no file". It is refused for an `agent` that `runAs.agent` names: `target-missing`.
   Each variant is stored with its SHA-256, and its text when it is at most 256 KiB.
5. Check the cost ceiling: `samples × cases × variants × maxCostUsdPerSample × 1.25` (the F10
   margin) against `limits.maxCostUsd` and `confirmMaxCostUsd`. The start must carry
   `confirmMaxCostUsd` equal to the ceiling the estimate showed, otherwise `409 cost-not-confirmed`.
6. Insert the run and its samples in one `BEGIN IMMEDIATE` transaction. A partial unique index
   allows one live run per project (decision: no two runs in one repository fight over lanes and
   accounts). A second start gets `409 eval-running`.

**Queue.**
- The samples are ordered case by case, then attempt by attempt, then variant by variant
  (`c1·a1·current`, `c1·a1·proposed`, `c1·a2·current`, …), so that time-varying effects (load,
  model updates, an account switch) hit every variant alike.
- **Concurrency** is `min(2, runs.defaults.maxConcurrentRuns)`. If `admit` refuses with
  "Concurrent run limit reached" (`chats.ts:685-688`), the sample is retried after 3 s, as the
  orchestrator's `refuse()` does (`orchestrator.ts:1189-1191`).
- A **claim** is a guarded update: `UPDATE eval_samples SET state='running', owner=? WHERE id=? AND state='queued'`,
  inside `BEGIN IMMEDIATE`, with the count of running samples, as `flow.ts:1402-1412` does.

**A sample.**
1. **Lane.** Take a free lane of the run, or create one. Reset it to the case's pin
   (`checkout --detach --force <pin>`, then `clean -ffdx`), write the variant's overlay, and run
   `setup` if this lane has not run it for this pin.
2. **Agent file.** For an agent target, write the `--agents` file from the variant's text with the
   same builder as `flowAgentsFile`. That builder is extracted into `agentsDefinitionFile(content,
   agent, model)`. The file goes to `<dataDir>/eval-agents/` (0700 dir, 0600 file, named by
   content hash).
3. **Start the chat.**
   ```
   runtime.start({ prompt, cwd: lane, model, effort, keepAlive: false, internal: true,
                   api: false, uploads: false, permissionMode, permissionPrompts: 'none',
                   allowedTools, disallowedTools, maxBudgetUsd, agent?, agentsFile?,
                   systemPromptSnapshot: 'off', name: `eval ${name}/${case}` },
                   { evalSampleId })
   ```
   The rules come from `rulesFor('claude-code', policy)` (`tool-policy.ts:22`).
4. **Wait.** Race `waitForResult` against the sample's clock and the run's abort signal. At the
   time limit, `stop`, and the outcome is `failed` with reason `timeout`.
5. **Fold.**
   - Messages come from `runtime.messages(id)` (`chats.ts:544`), which is the in-memory stream of
     a chat with no transcript.
   - Calls come from a new `allToolCalls(entries)` in `tool-calls.ts`. It is `toolCallsOf`
     (`tool-calls.ts:23`) for every name, plus `message`, `scope` and `seq`.
   - `permissionDenials`, `turns` and `durationMs` come from the `result` `RunEvent`'s `outcome`
     (`runtime.events(id)`, `chats.ts:524`).
   - The account comes from `accountOf`, and the model and CLI version from the `init` event.
6. **Score.** Run `score(definition.case, calls, final, lane)`. Commands run last and in order.
7. **Persist.** Store the calls (input cut to 4 KiB with `cutToBytes` and masked with
   `maskSecrets`, `packages/core/src/decisions/redact.ts:71,83`), the checks and the sample
   outcome. Then add the cost to the run. Then emit `eval.sample`.
8. **Dispose.** `stop`, then `exited` (5 s grace), then `remove`, as in `cli.ts:199-209`.

**Usage limit.**
- Rotation is told to leave eval samples alone: a `deps.evalSample(chatId)` check before
  `moveToAccount` in `onLimitHit` (`rotation.ts:147`).
- The sample whose result has `cause: 'rate-limit'` ends `limit`, is not scored, and a new try of
  the same attempt is queued (`try + 1`, at most 3).
- The next spawn chooses again (`chooseAccount`, `chats.ts:1118-1148`), so another account with
  quota takes it.
- When `choose` returns no account and a `waitUntil`, the run goes to `waiting` with `resetsAt`.
  It resumes at the reset, or the person stops it. While it waits it spends nothing.
- A run pinned to an account (`EvalRunRequest.account`) waits rather than switching. That is the
  low-variance choice, which the dialog offers.

**Cost ceiling during the run.** Before each claim, check `cost_so_far + reserved(in flight) +
next sample's cap × 1.25 ≤ maxCostUsd`. When it no longer fits:
- the remaining samples become `skipped` (`reason: 'cap'`);
- the run ends `capped`;
- the results show what was scored.
Only reported costs are added (`RunResult.costUsd`). The README already says that Claudio
estimates nothing.

**Cancel.** `POST /eval-runs/:id/cancel` aborts the signal and stops the running chats. Running
samples end `cancelled`, queued ones `skipped`. The lanes are removed, and the run ends `cancelled`.
Cancelling twice is a no-op.

**Restart.** `EvalService.load()` runs after `runtime.restore`, beside `orchestrator.recover()`
(`index.ts:1052-1053`). For rows owned by this process's earlier life (the owner pid is dead, or it
is our pid with an older `owner_started_at`):
- running samples become `interrupted`, not scored;
- the run becomes `interrupted`;
- the lane sweep runs.
Rows owned by a live other process are left alone. `POST /eval-runs/:id/resume` re-queues the
unfinished samples after a new cost check, with a new confirmation.

### Lanes (throwaway worktrees)

- **Root.** `CLAUDIO_EVALS_DIR`, else `<dataDir>/eval-lanes/`, mode 0700. At start, every ancestor
  of the root is checked for `CLAUDE.md` / `CLAUDE.local.md` / `.claude/` (F1). If any is found,
  the start is refused with `lanes-root-contaminated` and the path, and the error says to set
  `CLAUDIO_EVALS_DIR`.
  - The dev data dir is `<repo>/data` (`paths.ts:246`), so a dev server needs the variable. The
    desktop and Docker data dirs do not.
- **A lane** is `<root>/<runId8>/<laneN>`, created with
  `git -c core.hooksPath=/dev/null -c core.fsmonitor=false -C <repo> worktree add --detach <lane> <pin>`.
  - It is detached, so no branch is created and nothing is left in `git branch`.
  - It is locked (`git.ts:110`) with the reason `claudio eval <runId8>`, so a person's
    `git worktree prune` skips it while it runs.
- **Serialisation.** A per-repository promise queue in `lanes.ts` runs one `git worktree` command at
  a time. Git's own `.git/worktrees` lock fails two concurrent adds rather than waiting.
- **Between samples:** `checkout --detach --force <pin>`, then `clean -ffdx` (the overlay and
  untracked files included), then the overlay is written.
- **Removal.** When the run ends (any outcome): unlock, `worktree remove --force` (`git.ts:241`),
  then `rmSync` of the run's lane dir as the fallback, and never a `git worktree prune` of the
  person's repository (the same reason as `work-links.ts:249-250`).
- **Sweep.** At start and every hour, any `<root>/<runId8>` whose run is not live is removed, and so
  is its worktree registration (`worktree remove --force --force` by path). This is the lesson of
  `scripts/test-tmp.mjs` and CONTRIBUTING:90-95: a scratch dir that relies on a happy path to be
  removed fills the disk. The sweep is the floor, not the exception.
- **Disk check.** Before the first lane, the size is estimated as `git ls-files | wc -l` plus
  `git count-objects -vH` for the pin. More than 50,000 files or 2 GiB is a warning in the
  estimate ("each lane checks out N files"), never a refusal.

### Scoring and reports (Phase 1)

- **Sample outcomes:**
  - `passed` and `failed` are scored.
  - `limit`, `interrupted`, `cancelled`, `skipped` and `infra` are not scored. `infra` covers a
    lane that failed, a CLI that is missing, or `setup` that failed.
- **A case and variant:** "n of k passed" over the scored samples, and `flaky` when 0 < n < k.
- **A run:** per variant, the cases with every scored sample passing, out of the cases with at least
  one scored sample.
- **Comparison** (same run, two variants), per case:
  - `regressed` when the base passed k of k and the other passed fewer;
  - `improved` when the reverse holds;
  - `same` otherwise.
  It also shows the mean cost and mean duration per variant. Phase 1 states only these facts and
  gives no verdict on whether to promote.
- **Across runs:** history rows carry the definition SHA, the variant SHAs, the model and the CLI
  version. Comparing two runs warns when any of these differ.

### Data model and migration

These are appended at the end of `MIGRATIONS` (after `db.ts:806`), as one string entry. The
schema-version constant is found by `includes('CREATE TABLE eval_runs')`, as `db.ts:814-857` do.
`foreign_keys` is on (`db.ts:1070-1072`).

```sql
-- docs/plans/instruction-evals.md: eval runs, their samples, calls and checks
CREATE TABLE eval_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  eval_name TEXT NOT NULL,
  definition_sha TEXT NOT NULL,
  definition TEXT NOT NULL,            -- the file as run: the record of what was measured
  variants TEXT NOT NULL,              -- 'current,proposed' in queue order
  samples_per_case INTEGER NOT NULL,
  account TEXT,                        -- set when the person pinned one
  state TEXT NOT NULL CHECK (state IN ('queued','running','waiting','ended')),
  outcome TEXT CHECK (outcome IN ('completed','capped','cancelled','interrupted','failed')),
  reason TEXT,
  resets_at TEXT,
  max_cost_usd REAL NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  started_by TEXT NOT NULL,            -- 'person' or 'desktop'; a chat token cannot start one
  owner_pid INTEGER, owner_started_at TEXT,
  created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT
);
CREATE INDEX eval_runs_history ON eval_runs (project_id, eval_name, created_at);
CREATE UNIQUE INDEX eval_runs_live ON eval_runs (project_id) WHERE state IN ('queued','running','waiting');
CREATE TABLE eval_variants (
  run_id TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  variant TEXT NOT NULL CHECK (variant IN ('pinned','current','proposed')),
  target_path TEXT NOT NULL,
  present INTEGER NOT NULL,
  content_sha TEXT,
  content TEXT,                        -- NULL above 256 KiB; the SHA stays
  PRIMARY KEY (run_id, variant)
);
CREATE TABLE eval_samples (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL, variant TEXT NOT NULL, attempt INTEGER NOT NULL, try INTEGER NOT NULL DEFAULT 1,
  seq INTEGER NOT NULL,                -- queue order
  state TEXT NOT NULL CHECK (state IN ('queued','running','ended')),
  outcome TEXT CHECK (outcome IN ('passed','failed','limit','interrupted','cancelled','skipped','infra')),
  reason TEXT,
  chat_id TEXT, account TEXT, model TEXT, cli_version TEXT, pin TEXT NOT NULL,
  cost_usd REAL, duration_ms INTEGER, turns INTEGER, calls_truncated INTEGER NOT NULL DEFAULT 0,
  result_text TEXT,                    -- cut to 8 KiB, masked
  owner_pid INTEGER, started_at TEXT, ended_at TEXT,
  UNIQUE (run_id, case_id, variant, attempt, try)
);
CREATE INDEX eval_samples_run ON eval_samples (run_id, seq);
CREATE TABLE eval_calls (
  sample_id TEXT NOT NULL REFERENCES eval_samples(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, message INTEGER NOT NULL, tool_use_id TEXT, name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('main','sub')),
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','error','denied','open')),
  input TEXT NOT NULL,                 -- JSON, cut to 4 KiB, masked
  result TEXT,                         -- cut to 1 KiB, masked
  at TEXT,
  PRIMARY KEY (sample_id, seq)
);
CREATE TABLE eval_checks (
  sample_id TEXT NOT NULL REFERENCES eval_samples(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL, kind TEXT NOT NULL, passed INTEGER NOT NULL,
  detail TEXT NOT NULL,                -- English: why, e.g. "Bash `pnpm test` (#14) is after the last Edit (#11)"
  evidence_seq INTEGER,
  output TEXT,                         -- a command check's tail, 4 KiB, masked
  PRIMARY KEY (sample_id, idx)
);
```

- **Caps:** at most 500 calls per sample. Beyond that `calls_truncated = 1`, and the checks run on
  the full in-memory list before truncation.
- **Retention:** the 100 newest ended runs are kept per eval. Older ones are deleted in the same
  transaction that inserts a new run, and the settings say so.
- **Consent:** `<dataDir>/eval-consents.json`, written atomically (`config/files.ts:16`), mode
  0600. The shape is `{ "<projectId>/<name>": { sha, at, commands: string[] } }`. It is a settings
  document, so it is a file.

### Shared types (`packages/shared/src/types.ts`)

New types:
- `EvalTargetKind`, `EvalTarget`, `EvalRunAs`, `EvalLimits`;
- `EvalStringMatcher`, `EvalCallMatcher`, `EvalExpectation` (a union by `kind`);
- `EvalCase`, `EvalDefinition`, `EvalFile` (`{ name, path, sha, definition | null, problems: string[] }`);
- `EvalVariant`, `EvalRunRequest` (`{ variants, proposed?: string, cases?: string[], samples?, maxCostUsd?, confirmMaxCostUsd, account? }`);
- `EvalEstimate` (`{ samples, ceilingUsd, typicalUsd: number | null, commands: string[], prompts, consentNeeded, warnings: EvalWarning[] }`);
- `EvalWarning` (`dirty-checkout`, `large-checkout`, `target-absent`, `models-differ`, `user-scope`, `pin-behind-head`);
- `EvalRun`, `EvalRunSummary`, `EvalSample`, `EvalCall`, `EvalCheck`, `EvalComparison`;
- `EvalRunEvent` and `EvalSampleEvent`, added to `AgentryEvent` (`types.ts:6818`).
The OpenAPI schemas are regenerated (`pnpm --filter @claudio/api openapi:schemas`) and the types
are added to `ROOT_TYPES` (`apps/api/scripts/generate-schemas.ts:13`).

### API

The new tag is **Evals** in `TAGS` (`apps/api/src/openapi/routes.ts:67`). Every route has a summary
(`d(...)`, `routes.ts:141`) and a README row in a new `### Evals` table under `## REST API`
(`README.md:579`). Routes live in `apps/api/src/routes/evals.ts`, registered beside the others
(`apps/api/src/app.ts:170-210`).

| Method | Route | Does | Errors |
|---|---|---|---|
| GET | `/projects/:id/evals` | The eval files, each with parse problems and its latest run summary | 404 project; 409 `team-off` |
| GET | `/projects/:id/evals/:name` | One file: definition, problems, SHA, consent state | 400 name; 404 |
| PUT | `/projects/:id/evals/:name` | Writes the file (strict parse). `ifMatch` = the SHA read, so a file changed on disk (git pull, another editor) is not overwritten | 400 with field paths; 409 `changed-on-disk`; 413 over 256 KiB |
| DELETE | `/projects/:id/evals/:name` | Removes the file; history stays | 404; 409 while it runs |
| POST | `/projects/:id/evals/:name/estimate` | `EvalRunRequest` → `EvalEstimate`. Starts nothing | 422 `pin-missing`, `target-missing`, `not-git`, `no-commit`, `lanes-root-contaminated`, `user-scope-proposal` |
| POST | `/projects/:id/evals/:name/consent` | `{ sha }`: records consent for that content | 409 when the SHA is not the file's now |
| POST | `/projects/:id/evals/:name/runs` | Starts a run (decision 3) | 409 `eval-running`, `cost-not-confirmed`; 412 `consent-needed`; 422 as in estimate |
| GET | `/projects/:id/eval-runs` | History, `?eval=&before=&limit=` (≤ 50), newest first | 404 |
| GET | `/eval-runs/:runId` | A run with variants, samples and checks (calls omitted) | 404 |
| GET | `/eval-runs/:runId/samples/:sampleId` | A sample's calls, checks and final text | 404 |
| GET | `/eval-runs/:runId/compare?base=current&other=proposed` | `EvalComparison` | 400 when a variant is not in the run |
| POST | `/eval-runs/:runId/cancel` | Cancels; idempotent | 404 |
| POST | `/eval-runs/:runId/resume` | Re-queues the unfinished samples of an `interrupted` or `capped` run, with `confirmMaxCostUsd` | 409 not resumable, `cost-not-confirmed`, `eval-running`; 412 consent changed |
| DELETE | `/eval-runs/:runId` | Removes an ended run's rows | 409 while live |
| GET | `/eval-runs/:runId/export?format=json\|markdown` | `content-disposition: attachment`, like `chats.ts:107-115` | 400 format |

**Auth.**
- With a guard on, every route needs the owner's credential, or the desktop's for reads
  (`security.ts:334,527`).
- Read-only mode refuses writes (405).
- A chat token (`agc_…`) may read and cancel, but it is refused with 403 on PUT and DELETE of eval
  files, consent, starting, resuming and deleting runs, through a new `CHAT_FORBIDDEN_EVALS` set
  beside the others (`security.ts:162-320`, enforced at :531-578). An injection in a chat must not
  spend money or consent on the person's behalf.
- The export route joins `QUERY_TOKEN` (`security.ts:37`) for download links.

**Events.**
- `eval.run`: state, counts per outcome, `costUsd`, `resetsAt`.
- `eval.sample`: id, case, variant, attempt, outcome.
Both are emitted with `core.events.emit` (`packages/core/src/events.ts:42`). They are added to
`EVENT_TYPES` and `targetsFor` in `apps/web/src/lib/events.ts:80,239`.

### Web (`apps/web/src/pages/team/evals/`)

Before any screen is built, the design reference gets the screens below (`docs/design-system/`,
`agentry-ds.css`), and each screen is compared against them. Follow the Night Shift rules in
`CLAUDE.md` and the `night-shift-ui-check` list.

**Routing.**
- `TeamSection` gains `'evals'`, and `teamSection()` accepts it (`model.ts:265-268`). The
  segmented control gets a fourth option (`Team.tsx:128-129`), and `&eval=<name>&run=<id>` deepen
  it.
- Switching views goes through `useLeaveGuard` (`apps/web/src/lib/dirty.tsx:99`), as the other
  sections do, so an unsaved case editor asks before leaving.

**Screens and states.**

| Screen | Content | States |
|---|---|---|
| Evals list | A row per eval: title, target (Geist Mono path), cases, latest run (`StatusBadge` with word: Passed / Failed / Capped / Interrupted / Running), "n/m cases", when, cost (tabular). Primary: "New eval" (`--grad`, the zone's one primary) | **Loading:** `Skeleton`. **Empty:** `Empty` with the new `evals` illustration (§4 of the design system: the title "No evals yet", one sentence on what an eval checks, the action "New eval"). **Not git / no commit:** `Empty` with `projects` illustration, tone warn, the reason, no action. **Error:** `ErrorBox`. **Invalid file:** the row shows `bad` + "Invalid file" and opens the problems list and raw JSON (read-only) |
| Eval editor | Title; target (`Select` kind and scope, `Combobox` of names from `GET /config/resources/:kind?project=`); "Run as" (member `Select`, stage `Select`, model, effort); pin (mono short SHA + subject; "Pin to HEAD"); samples (`NumberInput` 1–5); limits (`NumberInput`); setup (textarea, a warn line: "Runs this repository's code on this machine"); cases as `Collapsible`, each with prompt (textarea) and an expectation list. Each row is a `Select` kind plus fields per kind; matchers have tool (`Combobox` of known tools), command / path / input and outcome / scope (`Select`). "JSON" toggle for the whole file. Save writes the file | **Saving**, **saved**, **409 changed on disk** (offers reload or overwrite, showing both SHAs), field errors under the field from the 400 paths, **unsaved** (leave guard) |
| Start dialog (`Dialog`; `Sheet` on a phone) | Variants as `Checkbox` (Committed at pin / Current / Proposed). Proposed opens a code textarea prefilled with the current file, or with the text handed over from the member page. Case subset (`Checkbox` list); samples; optional account (`Select`). Estimate: "N samples · up to $X" (tabular, mono), "typically $Y" when history exists, warnings each with an icon and word. Consent block when needed: the prompts, the setup and the commands in mono, plus the `Checkbox` "I understand these run on this machine". Primary: "Run eval · up to $X" | **Estimating**, **refused** (422 reason in words with the fix: "Pin missing — pin to HEAD"), **consent needed**, **ready** |
| Run view | Header: eval title, state badge, `ProgressBar variant="segments"` (`packages/ui/src/components/ProgressBar.tsx:25`) over passed / failed / running / queued / not scored; cost "spent / ceiling"; Cancel. Matrix: a row per case, a column per variant, a cell per attempt, each with an icon and a word for screen readers, and `flaky` as a warn tag. Comparison column: Regressed (bad, word), Improved (ok, word), Same. Clicking a cell opens the sample | **Queued**, **running** (the run card carries the screen's one energy border, running sample rows the ring spinner, "Running" the braille spinner), **waiting for reset** (warn, the reset time, "Stop"), **capped** (warn: "Stopped at the ceiling; N samples not run", Resume), **interrupted** (warn, Resume), **cancelled**, **completed**, **failed** (bad, reason) |
| Sample | Numbered call list (mono): tool, then a one-line summary (command, path or skill), outcome icon and word, subagent calls indented under their `Task`. Checks list: pass/fail with icon and word and the English `detail`; clicking a check scrolls to its evidence call. Final text (Markdown, from `@claudio/ui`). Footer: cost, duration, turns, account, model, CLI version, pin | **Not scored** explains why (limit / interrupted / infra) |
| History | Runs of an eval, newest first, paged with `.list-more`, a filter by variant; "Compare with…" picks two runs and warns on model / CLI / definition differences | **Empty:** a compact line, with no illustration because the page has content |

**Entry from a member.** On `Member.tsx` the agent file editor (`Member.tsx:126,216`) gains
"Evaluate this change", enabled when the editor is dirty. It opens the eval list filtered to that
agent, with the unsaved text in a session-scoped store (`sessionStorage`, key
`claudio.evals.proposed.<projectId>.<agent>`, at most 256 KiB, cleared after the dialog uses it).
With no eval for that agent, the action is "New eval".

**Phone.**
- The segmented control fits four options; the count badge already hides on a phone (`Team.tsx:122`).
- Rows are cards, and the matrix becomes one card per case with a variant per line.
- "⋯" menus are a `Sheet`, touch targets are at least 44 px, inputs are 16 px, and there are no
  always-visible checkboxes outside dialogs.
- The start dialog is a `Sheet`.

**Motion.** Only a running eval moves: the energy border on the run card, ring spinners on
running rows, and the braille spinner by the verb. Everything stops under `data-motion='subtle'`,
`data-motion='off'`, `prefers-reduced-motion` and in a hidden tab (`packages/ui/src/lib/motion.ts`).
`motion.spec.mjs` covers the run view.

**Accessibility.**
- Status is always a word plus an icon.
- The progress count is announced with `aria-live="polite"` at most every 5 s.
- Every control is reachable by keyboard.
- The matrix is a real `<table>` with headers.
- `a11y-*.spec.mjs` covers the list, the editor, the dialog and the run view in both themes and at
  phone width.

**i18n.**
- A new namespace `evals.json` in `apps/web/src/i18n/locales/{en,es}/`, registered in
  `resources.ts`, with parity enforced by `apps/web/test/i18n.test.ts:12-20`.
- `GLOSSARY.md` gains: eval → *la evaluación*; case → *el caso*; sample/attempt → *el intento*;
  expectation → *la comprobación*; pin → *fijar* / *el commit fijado*; ceiling → *el tope*.
  pass@k / pass^k stay as written. Run is *ejecución* (`GLOSSARY.md:86-103`). Buttons use the
  infinitive ("Ejecutar evaluación"), and the copy is sentence case.
- Check `detail` text, prompts and file contents are English records and are not translated.

**Illustration.** A new `evals` illustration joins the set in the same pull request:
- the component `packages/ui/src/components/illustrations/evals.tsx`;
- its entry in `Illustration.tsx:27-47`;
- its colours from `styles/illustrations.css`, with ids from `useId()`;
- its reference `docs/design-system/illustrations/evals.svg`;
- its row in `docs/design-system.md` §4.
Its motif is a prompt card with three tool-call ticks, one of them failed, in the set's hairline
language, with the gradient on one element.

### Phase 1 edge cases

| Case | Behaviour |
|---|---|
| Project not a git repository | List shows `Empty` (warn); estimate and start answer 422 `not-git` |
| Repository with no commit | 422 `no-commit`, as `baseOf` (`orchestrator.ts:256`) |
| Pin missing (GC, shallow clone, rewritten history) | 422 `pin-missing` naming the case; the editor offers "Pin to HEAD", which changes the file, so consent may be asked again |
| Pin is behind HEAD | Warning `pin-behind-head` with the commit count; it still runs |
| Dirty checkout | Warning `dirty-checkout` with the number of changed files: "Only the target's current text is used; other uncommitted changes are not in the eval" |
| Target deleted | `current` and `proposed` run with no file for instructions, rule and skill (warning `target-absent`); refused for the agent that `runAs` names |
| Target renamed | Treated as deleted; the editor's target `Combobox` shows the new names |
| Target at user scope | Only `current`; `proposed` is refused with `user-scope-proposal`; the warning `user-scope` says the run reads the person's config dir |
| Proposed text identical to current | The dialog says so and keeps one variant |
| Proposed text over 256 KiB | 413 |
| Eval file invalid JSON or schema | Listed `invalid` with field paths; cannot run |
| Eval file changed on disk while editing | PUT 409 `changed-on-disk` |
| Eval file changed between estimate and start | Start recomputes the SHA; consent and the ceiling are checked again (412/409) |
| Eval file deleted while it runs | The run carries its own `definition` and finishes |
| A committed eval file from someone else | Never runs without consent for its SHA; the dialog shows everything it runs |
| Two starts at once (two tabs, two processes) | The partial unique index allows one; the other gets 409 `eval-running` |
| Global run limit reached | The sample waits and retries every 3 s; the run stays `running` |
| Usage limit, another account free | That sample is `limit` (not scored); a new try runs on the account `choose` picks |
| Usage limit, no account free | The run is `waiting` until the earliest reset; nothing spends meanwhile; "Stop" ends it `cancelled` |
| Pinned account limited | The run waits for that account's reset |
| Account switched mid-run | Recorded per sample; the comparison warns when variants ran on different accounts and models |
| Sample hits `--max-budget-usd` | `failed`, reason `budget` (the agent's behaviour spent it) |
| Sample hits the time limit | `stop`; `failed`, reason `timeout` |
| CLI error, CLI missing, login expired | `infra`, not scored, with the reason; three `infra` outcomes in a row end the run `failed` |
| Run ceiling reached | Remaining samples are `skipped`; the run is `capped`; Resume needs a new confirmation |
| Cost overshoot of one sample | Accounted as reported; the 25 % reservation margin (F10) prevents the next sample from passing the ceiling |
| Cancel during setup or a command check | `runCommand`'s handle cancels the process tree (`verification.ts:229-285`) |
| Server restart mid-run | Samples `interrupted`, run `interrupted`, lanes swept; Resume re-queues |
| Two Claudio processes on one data dir | Owner pid and start time on rows; recovery touches only its own dead rows |
| Lane creation fails (disk full, lock) | `infra` for that sample; the next sample tries a new lane; three in a row end the run `failed` |
| Lanes root has a `CLAUDE.md` above it | 422 `lanes-root-contaminated` with the path |
| Large repository | Warning with the file count and size; lanes are reused between samples |
| A `setup` that fails | Every sample of that lane is `infra`, with the output tail |
| A repo hook or fsmonitor in config | Not run: hooks are off for eval git commands (decision 15) |
| Agent writes outside the lane | The policy's edit rules bound the edit tools; a shell command can still write. The person consented to running the agent with that policy, as for the flow's work stage |
| Agent tries `git push` | Denied by policy (`gitPush: 'deny'`); visible as a `denied` call |
| Agent runs a background process | `stop` ends the process tree (`chats.ts:859-888`); the lane removal follows |
| Parallel tool calls in one message | Same message counts as simultaneous for `before`/`after`/`sequence` |
| Calls by subagents | `scope: 'sub'`; matchers default to `main` |
| A denied call | `outcome: 'denied'`; `called` counts it unless `outcome` says otherwise |
| An open call at the end | `outcome: 'open'` |
| More than 500 calls | Checks run on all; storage is cut and flagged |
| Regex that is slow | 512-character source limit, input cut to 16 KiB, flags restricted |
| Paths with `..` or symlinks in a `file` check | Realpath must stay inside the lane, else the check fails with "outside the worktree" |
| Secrets in tool inputs or output | Masked before storage (`maskSecrets`); `api: false` keeps Claudio's token out of the env |
| Model id unknown to an account | `choose` already filters with `canRun(model)` (`choose.ts:57-114`); none → `waiting` or `infra` with the reason |
| Team module switched off | The section is hidden; the API answers 409 `team-off`; history stays |
| Project removed from Claudio | History rows stay until the run is deleted; the list is unreachable |
| CLI updated between runs | Recorded per sample; history comparison warns |
| Export of a large run | Streamed (`Readable.from`, as `projects.ts:81-88`) |
| Phone, narrow width | As in the Phone section |
| Spanish UI | Copy from `evals.json`; records stay English |

### Phase 1 tests

- **core, pure** (`packages/core/test/evals-*.test.ts`):
  - parser: every field, every refusal with its path, unknown keys, version;
  - matchers: glob semantics per field, regex limits, command segmenting (quotes, `&&`, `|`,
    `timeout`, `env`, `cd`), path normalisation (absolute, outside, `./`);
  - each expectation kind, including same-message ties, `ifAnchor`, strict and loose `sequence`,
    `denied` and `open`, and subagent scope;
  - scoring and comparison;
  - cost reservation arithmetic.
- **core, git** (temp repos with `mkdtempSync(join(tmpdir(), …))`, under `scripts/test-tmp.mjs`):
  - lanes: add detached, reset and clean between samples, overlay;
  - a `post-checkout` hook that writes a marker file is *not* run;
  - the root contamination check;
  - the sweep removes the lanes of a run that is not live;
  - pin missing; target absent at the pin.
- **core, runner** (a fake runtime implementing `start` / `waitForResult` / `messages` / `events` /
  `stop` / `remove`, like `CliRuntime`, `cli.ts:15-21`):
  - queue order and interleaving;
  - the concurrency cap;
  - a limit gives a not-scored sample and a new try;
  - no account gives `waiting`, then the reset gives `running`;
  - budget and timeout give `failed`;
  - the ceiling gives `capped` and `skipped`;
  - cancel;
  - restart recovery with owner pids;
  - rotation leaves eval samples alone (`rotation.ts` test).
- **db:** the migration applies on a database at the previous version; the partial unique index
  refuses a second live run; cascade deletes; retention prunes.
- **API** (Fastify inject): every route's success and error codes; chat-token 403s; read-only 405;
  consent and `confirmMaxCostUsd`; every route documented (`apps/api/test/api.test.ts:44-55`).
- **Web** (`apps/web/test/`):
  - the matrix and comparison models;
  - the editor's form ↔ JSON round trip;
  - `teamSection('evals')`;
  - i18n parity;
  - tokens-only stylesheets (`design-tokens.test.ts:75`).
- **Fake CLI:** new directives `edit: <path>` (an `Edit` call that rewrites the file),
  `write: <path> <text>` and `skill: <name>` in `e2e/fake-cli/claude`, with its own test
  (`claude.test.mjs`) and README rows.
- **e2e** (written by `e12`, run once at the end by the integrator, never by workers):
  - `e2e/specs/evals.spec.mjs` (`fakeCli = true`): create an eval in the UI, run current vs
    proposed, see a regression, open a sample and its evidence, cancel, export;
  - `FAKE-LIMIT-ACCOUNT` gives a not-scored sample and a second try on another account;
  - `a11y-*` and `motion.spec.mjs` additions.

### Phase 1 task graph

This is one orchestration, **`instruction-evals-1`**, on `feat/claude-only` (or Claudio's `main`
once it exists).
- Code-writing workers use **`claude-sonnet-5-5`**. Fact and security tasks use
  **`claude-opus-5-5`**.
- Every task runs `pnpm typecheck` and the tests of the packages it touches, through
  `scripts/test-tmp.mjs`. No worker runs `pnpm e2e`, a Docker build or `desktop:dist`.
- **Ownership** avoids merge conflicts:
  - `packages/shared/src/types.ts` and `schemas.json` belong to `e1`;
  - `db.ts` to `e4`;
  - `rotation.ts`, `chats.ts` and `index.ts` to `e6` (then `e7`);
  - `security.ts`, `openapi/routes.ts` and `README.md` to `e8`;
  - `Team.tsx` and `model.ts` to `e10`.

- **`e0` — Record the CLI facts F1–F12.** dependsOn none. Model opus. Run by the owner's assistant
  with a real account, scrubbed.
  - Files: `docs/reports/instruction-evals-e0.md`, `packages/core/test/fixtures/recordings/evals/*.jsonl`.
  - Prompt: "For each fact F1–F12 in docs/plans/instruction-evals.md, run the smallest `claude -p
    --input-format stream-json --output-format stream-json --verbose` session that answers it in a
    throwaway git repo under `mktemp -d`, with `--max-budget-usd 0.10`. Record the command, the
    relevant stream lines (scrubbed of emails, org ids, tokens and session ids) and a one-sentence
    answer. Where the answer contradicts the plan, write the correction into the plan's CLI facts
    table. Spend at most 2 USD in total. Remove every scratch dir."
  - Acceptance:
    - every fact has an answer, a command and a fixture or a quoted line;
    - the report states the total spent;
    - no dir is left under `/tmp`;
    - the plan table is updated where an answer differs.
- **`e1` — Contract.** dependsOn none. Model sonnet.
  - Files: `packages/shared/src/types.ts`, `packages/shared/src/evals.ts` (constants: limits,
    patterns, `EVAL_KINDS`), `apps/api/scripts/generate-schemas.ts`, `apps/api/src/openapi/schemas.json`.
  - Prompt: "Add the Phase 1 eval types exactly as the plan's 'Shared types' and 'The eval file'
    sections list them, with doc comments that say why. Add `EvalRunEvent` and `EvalSampleEvent`
    to `AgentryEvent`. Regenerate the schemas."
  - Acceptance:
    - typecheck passes in every package;
    - `openapi:schemas` leaves no diff after regeneration;
    - the constants match the plan's limits table.
- **`e2` — Eval files and consent.** dependsOn e1. Model sonnet.
  - Files: `packages/core/src/evals/definition.ts`, its test.
  - Prompt: "List, read, parse (strict and per-case lenient), write (atomic, `ifMatch` SHA,
    256 KiB) and delete `.claude/claudio-evals/<name>.json` in a project. Resolve target paths
    from `config/scope.ts` and `config/resources.ts`. Keep `<dataDir>/eval-consents.json`. Record
    the SHAs Claudio wrote."
  - Acceptance:
    - every refusal in the field table has a test with its field path;
    - a name with `/` or `..` is refused;
    - a file over 256 KiB is refused;
    - consent survives a restart and is invalidated by a content change.
- **`e3` — Matchers and scoring.** dependsOn e0, e1. Model sonnet.
  - Files: `packages/core/src/evals/matchers.ts`, `score.ts`, `packages/core/src/tool-calls.ts`
    (adds `allToolCalls`), tests.
  - Prompt: "Implement the expectation grammar of the plan exactly, with the F7 input-field table
    from the e0 report. `before`/`after`/`sequence` compare assistant messages, not seq. Command
    segmenting is quote-aware. `file` checks use realpath containment. `command` checks call
    `runCommand`. Each check returns an English `detail` naming the evidence call by seq."
  - Acceptance:
    - a test per row of the grammar tables, plus same-message ties, `ifAnchor`, denied, open and
      subagent calls;
    - no regex runs on more than 16 KiB.
- **`e4` — Tables and store.** dependsOn e1. Model sonnet.
  - Files: `packages/core/src/db.ts` (one entry appended at the end of `MIGRATIONS` and its version
    constant), `packages/core/src/evals/store.ts`, tests.
  - Prompt: "Append the plan's SQL as one migration. Write the store: insert a run with its samples
    in `BEGIN IMMEDIATE`, the guarded claims, outcome updates, cost accumulation, history paging,
    retention of 100 per eval, deletion, and owner pid recovery queries."
  - Acceptance:
    - migrating from the previous version works;
    - a second live run fails on the unique index;
    - two claims of one sample give one winner;
    - cascades work.
- **`e5` — Lanes.** dependsOn e0, e1. Model sonnet.
  - Files: `packages/core/src/evals/lanes.ts`, `packages/core/src/git.ts` (an `evalGit` helper
    passing `-c core.hooksPath=/dev/null -c core.fsmonitor=false`), tests.
  - Prompt: "Implement the lanes section: the root and the contamination check (per F1), detached
    add, lock, a per-repository queue, reset/clean/overlay between samples, removal, the sweep at
    start and hourly, and the disk estimate."
  - Acceptance:
    - a repo's `post-checkout` hook does not run;
    - a killed test process leaves lanes that the next sweep removes;
    - `git worktree list` of the repo shows no eval lane after a run;
    - nothing is written under a hard-coded `/tmp`.
- **`e6` — Runner.** dependsOn e2, e3, e4, e5. Model sonnet.
  - Files: `packages/core/src/evals/runner.ts`, `packages/core/src/rotation.ts` (the
    `evalSample` guard), `packages/core/src/index.ts` (extract `agentsDefinitionFile` from
    `flowAgentsFile`), tests with a fake runtime.
  - Prompt: "Implement start, queue, sample, usage limit, ceiling, cancel and restart exactly as
    the plan's runner section says. Samples are housekeeping chats with `api: false`,
    `uploads: false`, `internal: true`, and the policy from `stagePolicy` or the eval's own. Emit
    `eval.run` and `eval.sample`."
  - Acceptance:
    - every runner bullet in the Phase 1 tests list passes;
    - rotation never replays an eval sample;
    - the flow's `flowAgentsFile` behaviour is unchanged (its tests pass).
- **`e7` — Core facade and export.** dependsOn e6. Model sonnet.
  - Files: `packages/core/src/index.ts` (the `EvalService` wiring, `load()` after `restore`),
    `packages/core/src/evals/export.ts`, tests.
  - Acceptance:
    - the JSON export round-trips the run's rows;
    - the Markdown export lists cases, variants, outcomes and failing checks' details, and carries
      no secret (it is masked at storage);
    - a startup with an interrupted run recovers it.
- **`e8` — API.** dependsOn e7. Model sonnet.
  - Files: `apps/api/src/routes/evals.ts`, `apps/api/src/app.ts`, `apps/api/src/openapi/routes.ts`
    (the Evals tag and every route), `apps/api/src/security.ts` (`CHAT_FORBIDDEN_EVALS`,
    `QUERY_TOKEN`), `README.md` (an Evals table and a row in "How it talks to Claude"), API tests.
  - Acceptance:
    - every route and error code in the API table has an inject test;
    - the documentation test passes;
    - chat-token 403s and read-only 405s are tested.
- **`e9` — Fake CLI directives.** dependsOn e0. Model sonnet.
  - Files: `e2e/fake-cli/claude`, `e2e/fake-cli/claude.test.mjs`, `e2e/fake-cli/README.md`.
  - Acceptance: `node --test e2e/fake-cli/claude.test.mjs` passes, with `edit:`, `write:` and
    `skill:` emitting the F7 shapes.
- **`e10` — Web: list, editor, illustration.** dependsOn e8. Model sonnet.
  - Files: `apps/web/src/pages/team/model.ts`, `Team.tsx`, `apps/web/src/pages/team/evals/{List,Editor,model}.tsx|ts`,
    `apps/web/src/api.ts`, `apps/web/src/lib/events.ts`, `apps/web/src/i18n/locales/{en,es}/evals.json`,
    `resources.ts`, `GLOSSARY.md`, `packages/ui/src/components/illustrations/evals.tsx` and
    `Illustration.tsx`, `docs/design-system/illustrations/evals.svg`, `docs/design-system.md` §4,
    web tests.
  - Acceptance:
    - i18n parity and tokens tests pass;
    - the empty, not-git, invalid and loading states render;
    - the form ↔ JSON round trip test passes;
    - both themes are compared with the reference.
- **`e11` — Web: start dialog, run view, sample, history, compare, member entry.** dependsOn e10.
  Model sonnet.
  - Files: `apps/web/src/pages/team/evals/{Start,Run,Sample,History}.tsx`,
    `apps/web/src/pages/team/Member.tsx`, styles in the area's stylesheet, locales, web tests.
  - Acceptance:
    - every state in the screens table renders in a test;
    - only the running run moves, and it stops under the motion levels;
    - phone layout uses `Sheet` and 44 px targets;
    - "Evaluate this change" carries the unsaved text.
- **`e12` — e2e specs, written not run.** dependsOn e9, e11. Model sonnet.
  - Files: `e2e/specs/evals.spec.mjs`, additions to `a11y-*.spec.mjs` and `motion.spec.mjs`.
  - Acceptance: `node --check` on each spec; selectors use existing class conventions; the
    integrator runs them once at the end.
- **`e13` — Docs.** dependsOn e8, e11. Model sonnet.
  - Files: `docs/evals.md` (feature doc), `docs/prompts.md` (a row: eval sample, `runner.ts`,
    housekeeping chat, flags), `docs/status.md`, `docs/team-and-flow.md` (a link), this plan's
    status.
  - Acceptance: front matter and `## Related` present; every route and table named in the docs exists.
- **`e14` — Security review.** dependsOn e8, e11. Model opus.
  - Prompt: "Review the whole diff against this plan's 'Security and privacy' section, item by
    item, citing `path:line`. Write the findings into the integration report. A confirmed finding
    blocks the merge."
  - Acceptance: every item answered; no confirmed high finding left open.
- **Final (integrator).** The full `pnpm typecheck`, `pnpm test`, `pnpm build`, then `pnpm e2e`
  once on its own `E2E_PORT`. Then a real run by the owner on one project (two cases, k = 2,
  ceiling 2 USD).

```
e0 ─┬─ e3 ─┐
    ├─ e5 ─┤
    └─ e9 ─┼──────────────────────────── e12
e1 ─┬─ e2 ─┤                               │
    ├─ e3  ├─ e6 ─ e7 ─ e8 ─ e10 ─ e11 ────┼─ e13
    ├─ e4 ─┘                         └─────┴─ e14
    └─ e5
```

### Phase 1 success criterion (the gate to Phase 2)

The owner checks it after Phase 1 has been in daily use for **four weeks**. The integrator writes a
short report, `docs/reports/instruction-evals-phase1-review.md`, drawn from the `eval_runs` rows.
Phase 2 starts only when the owner answers "yes" to the first point and at least one of the others:

1. **Used:** at least 3 evals on at least 2 projects, with at least 10 ended runs in total.
2. **Changed a decision:** at least once, a person kept, changed or reverted an agent file, skill,
   rule or `CLAUDE.md` edit because of an eval result. This is recorded by the owner in the review.
3. **Needs statistics:** at least 20 % of case/variant cells came out `flaky`, so one or two samples
   cannot tell a change from noise.
4. **Needs judgment:** at least 3 expectations the owner wanted could not be written
   deterministically ("explains the trade-off", "asks before deleting").

If none of points 2–4 holds, Phase 2 is dropped, and Phase 1 stays as it is.

## Phase 2 design (gated)

### Pressure levels

- A case may carry up to three prompts: `prompts: { supportive?, neutral, competing? }`. Phase 1's
  single `prompt` reads as `neutral`. File `version: 2` accepts both forms. Version 1 files keep
  working unchanged.
  - **supportive:** the prompt reminds the agent of the rule.
  - **neutral:** the task alone.
  - **competing:** the task plus a plausible reason to skip the rule ("this is urgent, keep it
    quick").
- Claudio never writes pressure text itself. The person writes it, or accepts the assistant's
  draft.
- Each level is its own cell. The report shows the drop from supportive to competing per case:
  "how much pressure it takes to break the rule".

### Metrics

- With `n` scored samples and `c` passes in a cell:
  - **pass@k** = `1 − C(n−c, k) / C(n, k)` (the unbiased estimator; at least one of k passes);
  - **pass^k** = `C(c, k) / C(n, k)` (all k pass).
  Here `k ≤ n`, k defaults to 3 and n to 5, and n is at most 10.
- Shown with n, never as a bare percentage. A Wilson 95 % interval goes beside the pass rate.
- `mustHold: true` on a case marks it as a regression guard: its pass^k is what the gate reads.

### Judged expectations

- `{ "kind": "judged", "statement": "Explains why it chose X over Y before editing", "model"?: "haiku" }`.
- **The judge** is one housekeeping chat per judged expectation and sample:
  - `--json-schema` `{ "pass": boolean, "reason": string (≤ 400 chars), "evidence": integer[] (call seqs) }`;
  - `confine: { tools: [], settingSources: [] }`, `api: false`, `internal: true`;
  - `--max-budget-usd` from `limits.maxJudgeCostUsd` [0.05];
  - model default `haiku`, effort `low`.
  This is the shape of `decisions/providers/cli.ts:150-167`.
- **Its input** is the statement, the folded calls (summaries, seq numbered) and the final text,
  inside a `pasted()` block with `PASTED_NOTE` (`prompt-rules.ts`). They are data, never
  instructions (reports/ecc.md §5).
- **A judge that fails** (error, limit, invalid JSON, timeout) gives `unjudged`. That is not scored
  for the cell, and it *fails closed* for the gate: a gate with unjudged `mustHold` samples is
  `incomplete`.
- **Calibration.** Each judged expectation may carry `examples: [{ calls, final, pass }]`. Before a
  run, the judge is run on them once, and a disagreeing judge is shown as "judge unreliable" (warn).
  This follows the decision engine's habit of measuring before trusting
  ([decision-engine.md](../decision-engine.md), "Shadow accuracy").

### Promotion gate (no auto-apply)

For a run with `current` and `proposed`, the gate's verdict is one of:
- **may be promoted:** no `mustHold` case's pass^k falls, and the mean pass rate across cells does
  not fall by more than its interval;
- **regressed:** with the cases that fell;
- **incomplete:** unjudged or not-scored `mustHold` samples.
The verdict is a card on the run view. "Save proposed" on that card opens the existing editor's
Save with the proposed text: the person still presses Save, which goes through `putResource` /
`PUT /config/instructions`. Nothing is written by the gate. ECC's harness applies the change
itself; this gate does not.

### Case drafting by the project assistant

- A new `AssistantProposalKind` `'eval-case'` (`types.ts:2884`) and a run kind `evals` for the
  assistant (`assistant-answer.ts:195` schema, `assistant.ts:1168` insert).
- Asked from the editor ("Draft cases"), the assistant reads the target file and proposes up to
  five cases with prompts at each pressure level and deterministic expectations first.
- **Accept** appends a case to the eval file through e2's write (`ifMatch`). **Discard** does
  nothing.
- The draft is English. The confined assistant run cannot write files
  ([assistant.md](../assistant.md)).

### Phase 2 data and API

- **Migration**, appended at the end:
  - `eval_samples` gains `pressure TEXT`;
  - a table `eval_judgements (sample_id, idx, pass, reason, evidence, cost_usd, model, status)`;
  - `eval_runs` gains `gate TEXT` and `gate_detail TEXT`.
- **Routes:** `GET /eval-runs/:runId/gate`; `POST /projects/:id/evals/:name/draft-cases` (starts
  an assistant run; chat token refused).
- **Types:** `EvalPressure`, `EvalJudgedExpectation`, `EvalCellMetrics`, `EvalGate`, and the
  `eval-case` proposal.

### Phase 2 edge cases

| Case | Behaviour |
|---|---|
| Judge disagrees with its calibration examples | "Judge unreliable" (warn); the gate is `incomplete` until the person accepts it or edits the statement |
| Judge at a usage limit | `unjudged`; re-judged after the reset without re-running the sample (the sample's calls are stored) |
| Judge prompt injection from the transcript | Data in `pasted()`; no tools; the worst case is a wrong verdict, shown with its reason and evidence |
| `k > n` | Refused by the parser |
| Small n | The interval is shown; the gate needs n ≥ 3 per `mustHold` cell, else `incomplete` |
| Version 1 file opened in a version 2 editor | Read as neutral-only; saved as version 2 only when the person adds a v2 field |
| Drafted case with a command check | The draft is shown with its commands; accepting it changes the SHA, so consent is asked again |
| Gate on a run with a pinned account vs rotation | Shown in the gate card; no effect on the verdict |
| Cost of k × levels × variants | The estimate multiplies everything out; the dialog shows the per-level breakdown |

### Phase 2 tests

- Metrics: exact values for small `n, c, k`, edge cases `c = 0`, `c = n`, `k = n`.
- Judge: schema handling, invalid JSON, limit, calibration disagreement (fake runtime).
- Gate: every verdict path.
- Assistant drafting: proposal round trip.
- Web: the gate card, pressure tabs, and the metrics with n and the interval.
- e2e: a judged expectation with a scripted `json:` judge answer through the fake CLI.

### Phase 2 task graph

This is the orchestration **`instruction-evals-2`**. It starts only after the gate above has been
confirmed. The same models and rules apply as in Phase 1.

- **`f0` — Facts.** dependsOn none. Model opus.
  - Record a judge run (`--json-schema`, no tools, `haiku`) on 3 fixtures: its cost, its latency,
    and `structured_output` on a refusal.
  - Record the cost of a competing-pressure case at k = 5.
  - Acceptance: report `docs/reports/instruction-evals-f0.md`, total spend ≤ 2 USD.
- **`f1` — Contract v2.** dependsOn f0. Model sonnet. `types.ts`, schemas.
  - Acceptance: v1 files still parse; schemas regenerated.
- **`f2` — Pressure and metrics.** dependsOn f1. Model sonnet. `evals/definition.ts`,
  `evals/metrics.ts`.
  - Acceptance: metric tests.
- **`f3` — Judge.** dependsOn f0, f1. Model sonnet. `evals/judge.ts`.
  - Acceptance: judge tests, confinement asserted on the spawned argv (`--tools=`,
    `--setting-sources=`).
- **`f4` — Migration and store v2.** dependsOn f1. Model sonnet. `db.ts`, `evals/store.ts`.
- **`f5` — Runner v2 and gate.** dependsOn f2, f3, f4. Model sonnet. `evals/runner.ts`,
  `evals/gate.ts`.
  - Acceptance: every verdict path; re-judging without re-running.
- **`f6` — Assistant drafting.** dependsOn f1. Model sonnet. `assistant-answer.ts`, `assistant.ts`,
  the proposal kind.
  - Acceptance: a proposal round trip; English records.
- **`f7` — API v2.** dependsOn f5, f6. Model sonnet. Routes, OpenAPI, README, chat-token denials.
- **`f8` — Web v2.** dependsOn f7. Model sonnet. Pressure editor, judged expectation, metrics with
  intervals (following the `dataviz` guidance for the pass-rate trend), gate card, "Draft cases",
  locales.
- **`f9` — e2e and docs.** dependsOn f8. Model sonnet. Specs written but not run, plus
  `docs/evals.md`.
- **`f10` — Security review.** dependsOn f7, f8. Model opus.

## Security and privacy

Each item is checked by `e14` (and by `f10` for Phase 2).

1. **The one rule.** Samples and judges are chats of `ChatManager`, launched with flags already in
   `args.ts`. No SDK, no HTTP call to Anthropic, no terminal scraping. The README row added by `e8`
   names the surfaces.
2. **Nothing starts on its own.** No code path starts a run except the two routes behind the
   person's credential. A chat token gets 403. No MCP write tool exists for evals.
3. **Spending.** There is a per-sample `--max-budget-usd`, a run ceiling with a reservation margin,
   and `confirmMaxCostUsd` on start and resume. Waits at limits spend nothing.
4. **Untrusted eval files.** Consent is per SHA, and it covers prompts, `setup` and commands. The
   dialog shows them verbatim (mono).
5. **Untrusted repository code.** It runs only in `setup` and `command` checks, through
   `runCommand` with a time limit and its own process group (`verification.ts:229-285`), in the
   lane, never in the checkout. Git hooks and fsmonitor are off for eval git commands. The agent
   itself runs as the flow's work stage would, under its policy.
6. **Secrets.**
   - Samples get no `CLAUDIO_API_TOKEN` (`api: false`). The vault's variables reach only Claude
     Code (`child-env.ts:37-46`).
   - Stored inputs, results and outputs are masked (`maskSecrets`) and cut.
   - The consent file and the agents files are 0600 in 0700 dirs.
7. **Isolation of variants.** A proposal is never written to the checkout or to the person's
   config dir. The lanes root is checked for ancestor memory files.
8. **No pushes.** `gitPush: 'deny'` in every policy. Lanes are detached, with no branch.
9. **Prompt injection.**
   - Tool output never flows into anything that acts. Results are only displayed and compared.
   - The Phase 2 judge reads transcripts as pasted data with no tools.
   - A drafted case is a proposal that the person accepts.
10. **Cleanup.** Lanes are removed at the end of every run and swept at start and hourly. Tests use
    `mkdtempSync(join(tmpdir(), …))` under `scripts/test-tmp.mjs`.
11. **Exports** contain masked data only. The download route uses the existing `?token=` allowance.

## Performance and cost

- **Typical Phase 1 run:** 3 cases × 2 samples × 2 variants is 12 samples. At ~0.10–0.40 USD per
  Sonnet sample, that is ~1–5 USD, with a ceiling of 12 × cap × 1.25. The estimate shows the median
  of the last five runs' sample costs once history exists.
- **Time:** 12 samples at a concurrency of 2, ~2–5 min each, take ~12–30 min.
- **Disk:** one lane per concurrent sample (2), reused. Each one costs a checkout of the pinned
  tree. Lanes are removed at the end.
- **Git work:** one `worktree add` per lane, and a `checkout`/`clean` per sample, serialised per
  repository.
- **SQLite:** at most ~500 call rows per sample, and 100 runs kept per eval. History pages by
  `(project_id, eval_name, created_at)`.
- **Live updates:** two event types. The UI patches the run from them, without polling.

## Docs to update

- `docs/evals.md` (new feature doc).
- `README.md`: the Evals REST table, and a row in "How it talks to Claude".
- `docs/prompts.md`: the eval sample row, and in Phase 2 the judge row.
- `docs/status.md`.
- `docs/team-and-flow.md`: link to evals.
- `docs/design-system.md`: §4 `evals` illustration and the Evals section screens.
- `apps/web/src/i18n/GLOSSARY.md`.
- `e2e/fake-cli/README.md`.
- `docs/reports/instruction-evals-e0.md` (by `e0`) and the Phase 1 review report.
- This plan's status line.

## Rollout and rollback

- **Rollout.**
  - The feature appears in the Team screen of projects with the Team module on. There is no
    setting to switch it on, because nothing runs until a person starts it.
  - Projects without eval files see the empty state only.
  - After merge, the owner runs one eval on Claudio itself (the final step of the task graph).
- **Rollback.**
  - Revert the merge. The tables stay; migrations are append-only, and unused tables are harmless.
  - Eval files in repositories stay as inert JSON.
  - Lanes are removed by the last sweep before the revert. If a lane remains,
    `git worktree remove --force` by its path removes it, and the lanes root can be deleted.
- **Phase 2** ships behind its gate. Rolling it back leaves version 2 files, which Phase 1 refuses
  with `unsupported-version` rather than misreading them.

## Resolved questions (2026-10-15)

Answered by the integrator on the owner's behalf. Where an answer differs from a section above,
the answer wins, and the task that builds the affected part follows it.

1. **Defaults kept: k = 2, 0.50 USD per sample, concurrency 2.** k = 1 cannot detect flaky cases,
   and the Phase 2 gate measures exactly that. The total cap is shown before every start, and the
   person can lower k per eval.
2. **Claudio never touches the repository's git config.** Eval files stay untracked until the
   person commits them; the Evals tab shows "Not committed" next to such a file. Nothing is written
   to `.git/info/exclude`.
3. **Gate accepted as written** (four weeks; 3 evals, 2 projects, 10 runs; plus one of the three
   signals). The owner checks it; nothing starts Phase 2 automatically.
4. **Judge: `sonnet` by default**, editable per eval (`haiku` allowed). A judge must be at least as
   capable as what it grades; the cost is bounded by the eval's cap.

## Related

[[reports/ecc.md]] · [[plans/claude-only-fork.md]] · [[team-and-flow.md]] · [[decision-engine.md]] ·
[[accounts.md]] · [[security-model.md]] · [[prompts.md]] · [[orchestrations.md]] ·
[[plans/worker-checks.md]] · [[assistant.md]] · [[design-system.md]] · [[agentry-mcp-server.md]] ·
[[plans/multi-provider.md]]
