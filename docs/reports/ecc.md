---
created_at: 2026-10-15T19:30:00Z
updated_at: 2026-10-16T12:00:00Z
tags:
    - research
    - ecc
    - orchestration
    - verification
    - memory
    - hooks
    - security
    - claudio
---
# Research: ideas from ECC worth bringing into Claudio

Status: **every ranked idea is built** (2026-10-16). The research was written 2026-10-15; the table
below says where each idea landed. The page studies ECC and weighs each of its ideas against Claudio as it
was on `feat/claude-only` (stage-A checkout, `~/Escritorio/claudio-stage-a`).

| Idea | Built by | Outcome |
| --- | --- | --- |
| ★1 Review gate | [plans/review-gate.md](../plans/review-gate.md) | built; opt-in per graph |
| ★2 Lessons | [plans/lessons.md](../plans/lessons.md) | built; project scope, a person approves each |
| ★3 Guards | [plans/guards.md](../plans/guards.md) | built; on for automated runs, with known bypasses in [guards-audit.md](guards-audit.md) |
| ★4 Context control | [plans/context-control.md](../plans/context-control.md) | built |
| ★5 Instruction evals | [plans/instruction-evals.md](../plans/instruction-evals.md) | built, phases 1 and 2 |
| 6–10, 12–15 | [plans/agent-run-improvements.md](../plans/agent-run-improvements.md) | built |
| 11 Session note | covered by ★4's handoff | built there, no separate feature |

What was refused stays in section 4 ("Ideas rejected"), with its reasons.

ECC is by Affaan Mustafa and is MIT-licensed (`~/Escritorio/ECC`, v2.2.3, `b92f181b`). Ideas are
credited to it here. Claudio re-implements them in its own words and code; no ECC prompt, script or
hook is copied.

**How it was studied.** ECC was read directly: all agent front matter, about 20 agent bodies, about
35 of the 97 commands, the meta-skills, `hooks/hooks.json` and the hook scripts, `ecc2/`,
`ecc_dashboard.py`, the three guides, manifests, schemas and workflows. The pando index of ECC
(`project_id: ecc`) was started but had reached only 16 % of 3,820 files when this was written, so it
backed up a few searches and nothing more. Nothing from ECC was run. Claudio's side was read from its
docs and checked against the source with `git grep`.

## Decisions (2026-10-15)

Answers to the open questions of [§6](#6-open-questions-for-the-owner), given by the integrator on
the owner's behalf. Where they differ from the sections below, these decisions win.

1. **Review gate (★1): opt-in per orchestration graph, off by default.** It runs inside
   verification, after integration. Verification cannot pass until the review has passed, so a
   failed review or a reviewer that crashed blocks it. It is not a fourth flow stage, for now.
2. **Lessons (★2): project scope only.** A lesson becomes global only when the person explicitly
   promotes it. Lessons go into the journal. Writing a lesson into `CLAUDE.md` is a proposal that
   the person approves after seeing the diff; it never happens automatically.
3. **Guards (★3): on by default for orchestration workers and the flow.** Interactive chats opt in
   per project. These rules ship on:
   - `--no-verify`;
   - any push;
   - destructive commands: force push, `reset --hard`, and `rm -rf` outside the worktree;
   - secrets written to files.

   The lint-config rule (`protect-configs`) ships off, because editing a lint config is often
   legitimate.
4. **Compaction (★4): only offered to the person**, as a "Compact now" button and a
   `compact_boundary` divider in the transcript. Compacting automatically between flow stages is a
   decision point that ships `off`.
5. **Evals (★5): the minimal version first:** a few prompts, then a check of the tool calls. The
   full pass@k harness comes later, and only if the minimal version proves useful.
6. **Order: ★4 → ★3 → ★1 → ★2 → ★5**, as proposed.
7. **Credit:** one line in each plan that builds one of these ideas. Nothing in the README.

## 1. What ECC is

ECC ("Everything Claude Code") is a big catalogue of harness configuration for coding agents. It
began as one person's Claude Code setup and now calls itself an "agent harness operating system".
It contains:

- 71 subagent definitions;
- 311 skills;
- 97 slash commands, kept as a legacy surface;
- 122 rule files, path-scoped per language;
- 54 hook commands;
- 33 MCP server templates.

A manifest-driven installer (`ecc-universal` on npm) puts a chosen subset into Claude Code and about
a dozen other harnesses: Codex, Cursor, OpenCode, Gemini, Kiro, Pi and others. Beside the catalogue
sit three code projects: a Rust control plane (`ecc2/`, alpha), a Tkinter catalogue browser
(`ecc_dashboard.py`), and a large set of Node hook and library scripts (`scripts/`).

ECC's own roadmap (`docs/ROADMAP.md`) calls its size "a liability as much as an asset". Its newer
work is about evidence: measuring whether a gate or a skill actually helps.

| Path | What it holds |
| --- | --- |
| `agents/` | Subagent files: `name`, `description`, `tools`, `model`. Planners and architects are read-only, reviewers have no Write, resolvers have the full tool set, and each language has a reviewer and a build-resolver pair |
| `skills/` | `SKILL.md` per folder, some with `references/` and `scripts/`. This is the canonical unit. The meta-skills include `continuous-learning-v2`, `strategic-compact`, `verification-loop`, `eval-harness`, `santa-method`, `gateguard`, `skill-comply` and `orch-pipeline` |
| `commands/` | Thin slash-command entries over skills: `/plan`, `/orch-*`, `/review-pr`, `/santa-loop`, `/save-session`, `/learn`, `/hookify`, `/cost-report`… |
| `rules/` | `common/`, always loaded, plus 23 language folders loaded by `paths:` globs |
| `contexts/` | Three mode files (dev, research, review) |
| `hooks/` | `hooks.json` and `hooks.metadata.json`. The scripts live in `scripts/hooks/` |
| `scripts/` | Hook runtime, installer, cost tracker, session store, the tmux worktree orchestrator, CI scanners |
| `ecc2/` | Rust TUI and daemon: sessions in SQLite, worktrees, budgets, a risk score per tool call, a remote dispatch endpoint |
| `ecc_dashboard.py` | Tkinter browser over agents, skills, commands and rules. It shows no usage data |
| `manifests/`, `schemas/` | Install modules, components and profiles (`minimal` … `full`); JSON schemas for state, memory, provenance and eval capsules |
| `workflows/` | `orch-review.workflow.js`: a Claude Code Workflow script that runs a parallel review and then verifies the findings adversarially |
| `pi/`, `src/llm/` | A generated offline subset for the Pi agent, and a Python LLM-provider abstraction |
| `.claude/`, `.codex/`, `.cursor/`, `.opencode/`, … | Adapter surfaces, one per harness |
| `docker/` | Test harnesses: plugin setup, context-profile evals and a GateGuard effectiveness trial |
| `the-shortform-guide.md`, `the-longform-guide.md`, `the-security-guide.md` | The author's philosophy on tokens, memory, verification, parallelism and security |

## 2. Ranked ideas for Claudio

Value means value to Claudio's users: people running chats, orchestrations and team flows over
Claude Code. Effort is S (days), M (a week or two) or L (several weeks). ★ marks the top five.

| # | Idea | Where in ECC | What Claudio has today | Value | Effort | Build sketch |
| --- | --- | --- | --- | --- | --- | --- |
| ★1 | **Review gate that fails closed.** Parallel reviewers, one per dimension, each returning schema-validated findings. Findings are deduplicated, and every high-severity finding is checked by a separate verifier whose default is "refuted". Reviewers report only what they are confident of, and zero findings is a valid result | `workflows/orch-review.workflow.js`, `agents/code-reviewer.md` (confidence filter, pre-report gate, list of known false positives), `skills/santa-method/`, `commands/review-pr.md` | A planner may add a review *task* (`PLANNER_GRAPH_GUIDANCE`, `orchestrator.ts:302`). The verification phase runs commands (`verification.ts`). The flow's verify stage judges acceptance criteria (`flow.ts:388`). Nothing reviews the integration diff | High | M | A `review` step after integration and before verification: reviewer runs with `-p --json-schema`, then verifier runs, all on the existing graph engine |
| ★2 | **Lessons from corrections.** Detect when the person corrects or reverts an agent, and turn that into a small rule with a trigger, evidence, a confidence and a scope (project or global). Rules decay unless confirmed, and are promoted only after they hold in two projects | `skills/continuous-learning-v2/` (instincts, `instinct-cli.py` thresholds), `agents/conversation-analyzer.md`, `commands/hookify.md`, `commands/learn.md` | The journal (`journal.ts`). Memory proposals that a person approves (`memory-proposals.ts`, kinds `instructions`, `memory`, `journal`). The CLI's own auto-memory (`memory.ts`). No `lesson` concept, no confidence, no decay | High | M | A new proposal kind `lesson`, mined from the transcript by a Haiku `-p` run when a chat goes idle. Approved lessons are rendered into the journal handoff or `CLAUDE.md` |
| ★3 | **Guard hooks loaded through `--settings`.** Deterministic PreToolUse guards that hold even in `bypassPermissions`: no `--no-verify` or hooks-path override, no edits to existing lint or format configs, a gate on destructive commands, no secrets in written files. They are switched per chat and per stage | `scripts/hooks/block-no-verify.js`, `config-protection.js`, `gateguard-fact-force.js` (destructive part only), `governance-capture.js` | `ToolPolicy` → `--allowedTools`/`--disallowedTools` (`tool-policy.ts`). Tool presets. The `can_use_tool` broker, which only runs when the mode asks. A hooks *editor* for the person's own settings (`SettingsGuided.tsx`). Claudio installs no hook itself and ignores `hook_*` events (`stream.ts:7`) | High | M | A small `claudio-guard` binary shipped with the API, and a generated settings file passed as `--settings <file>` with only Claudio's hooks. Verdicts come back as `hook_response` events |
| ★4 | **Context control.** Compact at phase boundaries, not mid-task. Show the context breakdown, including what MCP tools cost. Warn when a chat loads too many MCP tools. Save a structured note before compaction | `skills/strategic-compact/`, `scripts/hooks/suggest-compact.js`, `ecc-context-monitor.js`, `skills/context-budget/`, `mcp-configs/` ("under 10 servers, under 80 tools"), `pre-compact.js` | `ContextMeter` and `ChatContext` (`ChatBadges.tsx`, `types.ts:552`). `contextUsage()` is implemented in `driver.ts:77` but **nothing calls it**. Nothing handles `compact_boundary` | Medium-high | S–M | Wire `get_context_usage` to a route and a panel, add a "Compact now" action, and add a compaction step between flow stages and before long orchestration tasks |
| ★5 | **Instruction-compliance evals.** Measure whether an agent file, a skill or `CLAUDE.md` is actually followed. Run scenario prompts at three levels of pressure, classify the tool-call sequence from stream-json, and report pass@k and pass^k. Promote a change only if it does not regress | `skills/skill-comply/`, `skills/eval-harness/`, `agents/harness-optimizer.md`, `ecc2` `harness-eval` (promotion gate) | Shadow accuracy for decision points (`decision-engine.md`), the provider conformance suite, one-off benches (`scripts/wire-format-bench.mjs`). No eval of agents or instructions | Medium-high | L | An "Evals" tab on a project's team. Each eval runs `claude -p --output-format stream-json` in a throwaway worktree on a pinned commit, scored by code checks plus an LLM judge |
| 6 | Grounding in existing patterns for the planner and the refine stage: cite one real `file:line` per convention (naming, errors, data access, tests), or say that none exists | `commands/plan.md` ("Pattern Grounding") | `PLANNER_GRAPH_GUIDANCE` asks each task prompt to name its files, but not to show an example | Medium | S | Add a clause to `PLANNER_GRAPH_GUIDANCE` and to `flowPrompt('refine')` |
| 7 | "Pass the objective, not just the query": a worker or subagent gets the goal of the whole graph and a cap of three retrieval cycles | `skills/iterative-retrieval/`, longform guide | `workerHead` passes dependency results; `prompts.md` has twelve points | Medium | S | Put the graph objective in `workerHead` and a short retrieval rule in `prompt-rules.ts` |
| 8 | Stop conditions for fixers: stop after the same error survives three attempts, when a fix adds more errors than it removes, or when the fix needs a design change. Fix one error at a time | `agents/*-build-resolver.md`, `commands/build-fix.md` | `fixerPrompt` with `maxAttempts` and `maxCostUsd` | Medium | S | Add explicit stop rules to `fixerPrompt` and to the `checks.fix` prompt. Report `[FIXED] file:line` rows into the verification card |
| 9 | Risk score per tool call (sensitive path, blast radius, irreversibility). It drives notification urgency and highlights the call in Step by step | `ecc2/src/observability/mod.rs` | Health signals (`health.ts`), the `notification.urgency` decision point, Step by step changes | Medium | S–M | A pure scorer in core over `tool_use` events. The score goes on the timeline and into the urgency input. It never blocks: blocking is ★3's job |
| 10 | Shipped role library: tested agent files for silent-failure hunter, type-design analyst, build resolver and spec miner, with read-only tools for review roles | `agents/` | Five project templates with role lines (`project-templates.ts`). Agent files are generated from a role (`agentFileContent`) | Medium | M | More roles in the templates, written by us. Review roles get `tools: Read, Grep, Glob, Bash`, with no Write |
| 11 | Structured session note: what worked (with evidence), what failed, what has not been tried, and the state of files. Written at a usage limit, before compaction, or on demand | `commands/save-session.md`, `resume-session.md` | Resume and fork, the same session moved to another account, journal handoff | Low-medium | S | Folds into ★4's pre-compaction note. Also offered when a task gives up after `maxAttempts` |
| 12 | Delegation contract: whoever delegates collects the results, and a final message never says "waiting for background agents" | `rules/common/agents.md` | Continuations (`open-items.ts`, `MAX_CONTINUATIONS`) cover the symptom | Low-medium | S | One line in `prompt-rules.ts` for workflow-engine leads |
| 13 | Global daily spend cap across all chats and orchestrations | `ecc2` `cost_budget_usd`, `enforce_budget_hard_limits` | Budgets per chat, task, graph, flow, fixer and supervisor. Limits per account | Low-medium | S | A runtime setting. Over the cap, new automated runs wait and chats ask first |
| 14 | Plateau detection in loops: stop when the score has not improved for two rounds after round three | `commands/gan-build.md` | `maxBounces` in flow, `maxAttempts` in tasks | Low | S | Track the verify result per bounce and stop early on repeats. This partly overlaps the `repeat-stall` health signal |
| 15 | Path-scoped rules (`paths:` globs) to keep `CLAUDE.md` small | `rules/` | The CLI already supports `.claude/rules/` with `paths:`; Claudio edits `rules` resources (`config/resources.ts`) | Low | S | Have the project assistant propose path-scoped rules instead of growing `CLAUDE.md` |

Ideas 6–10 and 12–15 are built by [plans/agent-run-improvements.md](../plans/agent-run-improvements.md).

## 3. Design notes for the top five

### ★1 The review gate that fails closed

**Status (2026-10-16): built.** See [plans/review-gate.md](../plans/review-gate.md#outcome).

**Goal.** After an orchestration integrates its branches, and in a flow before the verify stage, the
diff is reviewed by several independent reviewers. Only confirmed blocking findings stop the work.

**Where it goes.**
- A new optional phase `review` in `OrchestrationSpec`, between integration and `verification`.
- In flow, an optional `review` stage between `work` and `verify` (`flow.ts` stage rules).
- It is off by default per graph and per project, and switched on in the graph editor and the flow
  settings.

**How it runs, within the one rule.**
- Every reviewer is a `claude -p` process on the integration worktree with:
  - `--output-format stream-json`;
  - `--json-schema <findings schema>`;
  - `--permission-mode plan` or a read-only tool preset (`Read, Grep, Glob`, plus `Bash(git diff:*)`);
  - `--max-budget-usd`.
- The diff is built by Claudio (`changes.ts` already makes the unified text) and passed in the prompt
  as untrusted data, inside a `<pasted_content>`-style block (`prompt-rules.ts`).

**Dimensions.**
- `correctness`, always on.
- `tests`: whether the tests are weak or missing.
- `security`: triggered by a regex over the changed paths and the diff (auth, token, exec, SQL,
  crypto, fs).
- `conventions`: against the project's `CLAUDE.md` and rules.
- Each dimension is a role file under `.claude/agents/`, so a team can edit it. The defaults are
  written by Claudio.

**Findings schema.**
- `{ verdict, findings: [{ title, severity: critical|high|medium|low, file, line?, evidence, failure_scenario, confidence }] }`.
- The reviewer prompt carries ECC's anti-noise rules, in our words:
  - report only what you can cite and name a failure for;
  - read the context before reporting;
  - zero findings is a valid answer.

**Deduplication and verification.**
- Findings are deduplicated by `file` plus normalised evidence.
- Each critical or high finding goes to a verifier run with the finding and the diff. Its schema is
  `{ status: confirmed|refuted|uncertain, reason }`, and its default is `refuted`.
- Blocking findings are the confirmed ones plus the uncertain ones. Medium and low findings are
  advisory.

**Failing closed.**
- A reviewer that crashes, times out or returns invalid JSON makes the gate `incomplete`. An
  incomplete gate cannot pass.
- The person sees "Review incomplete" (status warn) with a Retry action.

**What happens with the result.**
- *Blocking findings:* in an orchestration they become a fixer run, reusing `fixerPrompt` with the
  findings as input, and the gate runs again, up to `maxRounds` (default 2). In flow they bounce
  the card to `work`, like a failed criterion.
- *Advisory findings:* listed on the verification card.
- *Every finding:* anchored in `DiffView` as a review thread on its line. Code-host reviews already
  render threads in the diff.

**Model and cost.**
- Reviewers default to `sonnet` and the verifier to `opus`, both overridable per role.
- The phase has its own `maxCostUsd`, and appears in `orchestration-timings`.

**Decision points.** A new `review.depth` point (skip, light, full by diff size and risk), shipped
`off` like the other 26.

**Open edges.**
- Pushing a "changes requested" verdict to the code host (`code-hosts.md` review tools) is a later,
  separate step.
- Large diffs are split by file group, with one reviewer per group.

### ★2 Lessons from corrections

**Status (2026-10-16): built.** See [plans/lessons.md](../plans/lessons.md#outcome) and [lessons.md](../lessons.md).

**Goal.** When a person corrects an agent ("no, use pnpm", "don't touch the changelog"), reverts its
change, or rejects a permission, Claudio proposes a *lesson*. The person approves or discards it.
Approved lessons reach later runs in that project.

**Data.**
- Table `lessons` in SQLite (`db.ts`), because lessons are accumulating records. Columns:
  - `id`, `project_id` (null for global), `trigger` (when it applies, one sentence);
  - `action` (what to do, one sentence), `evidence` (chat id and turn refs);
  - `confidence` (0.3–0.9), `status` (`proposed`, `active`, `retired`), `seen_count`;
  - `last_confirmed_at`, `created_at`.
- In English, per the records rule.

**Mining.**
- When a chat goes idle (the `result` event), or a flow card closes, a Haiku `claude -p` run reads
  the turns since the last mining, which Claudio already folds from the transcript (`usage.ts`).
- Its input: user messages, denied permissions, reverted edits (`edit-steps.ts`), and tool errors
  that repeated.
- Its output, through `--json-schema`: `[{ trigger, action, evidence, confidence }]`.
- It runs with no tools (`--tools=`), confined like assistant chats (`--setting-sources=`), and under
  `--max-budget-usd 0.05`.
- It is a decision point, `lesson.mine`, shipped `off`, so nothing is spent until the owner turns it
  on.

**Approval.**
- Lessons appear as memory proposals of a new kind `lesson` (`MemoryProposalTargetKind`), in the
  same UI as today's proposals.
- A proposal that matches an active lesson raises that lesson's `seen_count` and `confidence`
  instead of adding a new one.

**Delivery.**
- Active lessons with confidence ≥ 0.7 are added to the journal handoff (`JournalService.handoff`,
  already passed with `--append-system-prompt`) under a "Lessons" heading. The budget is 2 KiB,
  highest confidence first.
- A person can promote a lesson into `CLAUDE.md`, which uses the existing `instructions` proposal
  path.
- A lesson seen in two projects is offered for global scope.

**Decay.** A lesson not seen for 60 days drops 0.1 in confidence per month, and below 0.3 it is
retired. Thresholds live in a runtime setting.

**Bridge to ★3.** A lesson whose action is mechanical (a command or a path) can be turned into a
guard rule by the person: "never run `npm`" becomes a deny pattern.

**Safety.**
- Mined text is untrusted. The miner prompt says so.
- Lessons never carry commands to run, only behaviour. The UI shows the evidence turn next to each
  proposal.

### ★3 Guard hooks through `--settings`

**Status (2026-10-16): built.** Planned in [plans/guards.md](../plans/guards.md); the feature is described in [guards.md](../guards.md).

**Goal.** A small set of deterministic guards that hold whatever the permission mode is. Prompts are
forgotten some of the time; hooks run every time.

**One-rule check.**
- Hooks are a documented CLI feature, loaded from a settings file.
- `claude --settings <file-or-json>` is a documented flag (CLI 2.1.300 help: "Path to a settings
  JSON file or a JSON string to load additional settings from").
- Claudio writes the file and the CLI runs the hook. No control-protocol hook registration, which
  `sdk-driver-improvements.md` keeps out of scope, and no SDK.

**Pieces.**
1. `claudio-guard`, a small Node entry point bundled like `apps/api/dist/mcp.mjs`.
   - It reads the PreToolUse JSON on stdin and a rules file path from its argv.
   - It answers with exit 2 and a reason on stderr, or with the documented JSON decision.
   - Its input is bounded and it fails closed on oversize or unparseable input, as ECC's dispatcher
     does.
2. A settings file per run, written to `<data>/guards/<run>.json`, with only Claudio's
   `hooks.PreToolUse` entries, passed with `--settings`. The person's own settings still load
   through `--setting-sources`. Confined chats keep loading nothing.
3. Rules, each switchable:
   - **`no-verify`:** deny `git commit|push --no-verify` and `-c core.hooksPath=`.
   - **`protect-configs`:** deny Edit/Write on *existing* lint, format and CI config files; creating
     one is allowed. The list is editable.
   - **`destructive`:** deny `rm -rf` outside the worktree, `git reset --hard` on non-task branches,
     `git push --force`, and `DROP TABLE`, unless the run's stage allows it.
   - **`secrets`:** deny a Write whose content matches high-confidence secret patterns. This reuses
     the patterns of `security/redact.ts` and `decisions/redact.ts`.
   - **`push`:** flow's existing "agents never push" becomes a hook as well as a disallowed tool.

**Where it is set.** Settings → Security → Guards for the default. A switch per graph and per flow
stage. On by default for orchestration workers and flow runs, off by default for interactive chats.

**Visibility.**
- Stop ignoring `hook_response` in `stream.ts:7`.
- Parse it into a `RunEvent` of kind `guard`, shown in the transcript as a compact line ("Guard
  blocked: git push --no-verify", status warn) and counted in the run's health.

**Not taken from ECC.**
- The first-edit investigation gate (GateGuard): ECC's own trial measured about 45 % more turns and
  no shown benefit.
- Formatter and typecheck hooks on Stop: they run repository code on every turn, and Claudio's
  worker checks already do this once, deliberately.

### ★4 Context control

Built (2026-10-16): see [plans/context-control.md](../plans/context-control.md) and
[context-control.md](../context-control.md).

**Goal.** People see what fills a chat's context, compact it when it makes sense, and long automated
runs compact at a boundary instead of in the middle of a task.

**Steps.**
1. **Wire what exists.**
   - `GET /chats/:id/context` calls `driver.contextUsage()` (the `get_context_usage` control request
     is already implemented and tested).
   - It returns the CLI's breakdown: system prompt, tools, MCP tools, memory files, messages.
   - A panel opens from `ContextMeter`. It follows the new-route rules: OpenAPI summary and tag, a
     README row, regenerated schemas.
2. **MCP weight.**
   - The panel shows the tokens per MCP server, from the breakdown.
   - A warn badge appears when the chat loads more than about 80 MCP tools or the MCP share passes
     20 % of the window.
   - It links to the chat's MCP selection (`chat-tools.ts`) so servers can be dropped for this chat.
3. **Compact now.**
   - An action in the meter's menu sends `/compact` as a user turn. That is a slash command the CLI
     ships, sent through stream-json.
   - It takes an optional focus line ("keep the plan and the failing test").
4. **Compaction events.**
   - Parse `system` events of subtype `compact_boundary` (today unhandled) into a transcript divider:
     "Compacted · 142k → 18k".
   - The meter's drop then has a cause the person can see.
5. **At boundaries.**
   - In flow, a stage that resumes the same session (bounce back to `work`) sends `/compact` first
     when context use passes a threshold (default 60 %).
   - In the workflow engine, the lead is told to compact between phases.
   - A decision point, `context.compact`, shipped `off`.
6. **Note before compacting.**
   - Before a Claudio-initiated compaction, the run is asked for a structured note: goal, done with
     evidence, failed, not tried, files in flight.
   - The note is stored as a journal entry of kind `note`, so it survives the compaction and appears
     in the handoff. This covers idea 11.

### ★5 Instruction-compliance evals

**Status (2026-10-16): built**, phases 1 and 2. See [plans/instruction-evals.md](../plans/instruction-evals.md#outcome) and [evals.md](../evals.md).

**Goal.** Before changing a team's agent file, a skill or `CLAUDE.md`, know whether the change makes
agents follow it more often, and whether anything regressed.

**Model.**
- An *eval* belongs to a project and names a target: an agent file, a skill or `CLAUDE.md`.
- It holds a set of *cases*. Each case has:
  - a prompt;
  - a pressure level (`supportive`, `neutral`, `competing`);
  - a pinned commit;
  - expectations.
- Expectations come in three kinds:
  - **ordered tool calls**, checked deterministically (for example, Read of the test before Edit,
    or `pnpm test` before finishing);
  - **file assertions**, checked by a command;
  - **one judged sentence**, checked by an LLM judge returning `--json-schema` `{ pass, reason }`.

**Runs.**
- Each case runs k times (default 3) in a throwaway worktree on the pinned commit, with
  `claude -p --output-format stream-json`.
- Every run uses the target *as it is now* or *as proposed*: an unsaved edit is written into the
  worktree only.
- Claudio already folds tool calls out of stream-json, so checking order is plain code.

**Report.**
- pass@k per case, for capability.
- pass^k for cases marked `must-hold`, for regressions.
- Cost and time, compared between current and proposed.
- A proposed change "may be promoted" when no `must-hold` case regresses and the mean pass rate does
  not fall. This is ECC's promotion-gate idea, without its auto-apply.

**Case generation.** The project assistant can draft cases from the target file: "write five
scenarios that test whether this rule is followed". The person edits and accepts them, as with
other assistant proposals.

**Storage.** Eval definitions are settings-shaped (JSON under `.claude/claudio-evals/` in the
project, so they can be committed). Results are rows (`eval_runs`, `eval_case_results`).

**Cost guard.** Every eval run has `--max-budget-usd`, and the eval has a total cap shown before it
starts. Evals never start on their own.

## 4. Ideas rejected

| Idea | Where in ECC | Why not |
| --- | --- | --- |
| Cross-model second opinions (Codex, Gemini, Antigravity reviewers; Codex/Gemini "dirty prototypes") | `commands/santa-loop.md`, `astra-review.md`, `multi-*.md` | Claudio drives Claude Code only (`plans/claude-only-fork.md`). Two isolated *Claude* reviewers keep the idea, and ★1 does that |
| Driving CLIs through tmux panes and `send-keys` | `scripts/lib/tmux-worktree-orchestrator.js`, `skills/dmux-workflows/` | Breaks the one rule: it is terminal scraping. Claudio's stream-json driver is already better |
| ecc2's headless runner (`claude --print`, plain stdout lines) and its "resume" by respawning the task text | `ecc2/src/session/manager.rs`, `runtime.rs` | Already better in Claudio: stream-json, the control protocol, real `--resume`/`--fork-session`, and rewind |
| ecc2's remote dispatch HTTP endpoint and SQLite inbox between sessions | `ecc2/src/main.rs` (`remote serve`), `comms/mod.rs` | Already better: the REST API with auth modes, the MCP server with confirmed write tools, and the flow board |
| First-edit investigation gate (GateGuard) | `skills/gateguard/`, `scripts/hooks/gateguard-fact-force.js` | ECC's own Docker trial measured about 45 % more turns and no shown benefit. Only its destructive-command part survives, inside ★3 |
| Format and typecheck hooks on every edit or Stop | `quality-gate.js`, `stop-format-typecheck.js`, `post-edit-format.js` | They run repository code (`node_modules/.bin`, `npx`) on every turn. Claudio's worker checks and verification phase do it once, on purpose (`plans/worker-checks.md`) |
| Background observer that writes files with no person in the loop | `skills/continuous-learning-v2/agents/observer-loop.sh` | Spends tokens unseen and writes behaviour without approval. ★2 keeps the idea behind a decision point and a person's approval |
| Hooks on every tool call to log observations | `observe.sh` on PreToolUse and PostToolUse `*` | Claudio already has every tool call in the transcript and stream-json. A hook adds latency and a second, less-redacted copy |
| Hand-priced cost tracker from transcript usage | `scripts/hooks/cost-tracker.js` | Already better: Claudio shows only the cost the CLI reports, per model and per execution, and says "not reported" rather than estimating (ROADMAP, "Out of reach of the CLI") |
| Catalogue dashboard | `ecc_dashboard.py` | Already better: Settings → Extensions lists and edits agents, skills, commands, rules and workflows, and the plugins tab drives `claude plugin` |
| Install manifests, profiles and a multi-harness installer | `manifests/`, `install.sh`, `scripts/install-apply.js` | Claudio is not a config pack. Plugins go through `claude plugin` (`plugins.ts`), and "starter content" belongs in project templates (idea 10) |
| Importing behaviour from a URL (`/instinct-import <url>`, `--force`, global scope) | `commands/instinct-import.md`, `instinct-cli.py` | A ready-made channel for persistent prompt injection. Lessons in Claudio come only from the person's own chats |
| Mode files injected as the system prompt per alias | `contexts/` | The CLI's output styles and agent files already do this, and Claudio edits both |
| Generated project identity and guardrails from repository history ("ECC Tools") | `.claude/identity.json`, `.claude/rules/ecc-guardrails.md` | The project assistant already proposes a team, resources and tasks from the repository. Rules mined from git history are a small add to it, not a feature |
| Personas for marketing, investors, social posting, trading | many `skills/` | Out of Claudio's scope |

## 5. Security notes

No hidden prompt injection was found. There are no zero-width or bidi characters, and every
"ignore previous instructions" match is defensive text: reviewer prompts, tests, and the security
guide's quoted example tweet (`the-security-guide.md:91`). No file asked the reader to run, download
or send anything, beyond ordinary install instructions. `package.json` has no `postinstall`, and no
telemetry was found. ECC treats its own hooks with care: bounded stdin, failing closed on oversized
input, opt-in gates for risky probes, and fixes that cite GHSA advisories.

What is risky:

| Severity | Finding | Path |
| --- | --- | --- |
| Medium | Installing as a plugin turns every `standard` hook on by default (`hooks_enabled: true`). That skips the consent step the CLI installer shows: transcript sent to the LLM, formatters, persistent logs | `.claude-plugin/plugin.json` |
| Medium | Formatter and typecheck hooks run the project's own `node_modules/.bin/*`, its config files, and unpinned `npx` fallbacks on every Edit or Stop. In an untrusted repository, that is code execution | `scripts/hooks/quality-gate.js`, `stop-format-typecheck.js` |
| Medium | Memory-poisoning chain: tool output (web, MCP) → observations, session summaries, learned skills and instincts → re-injected at SessionStart (up to 8,000 characters). With the observer on, a headless `claude` with Write is told not to ask permission | `skills/continuous-learning-v2/`, `scripts/hooks/session-start.js` |
| Medium | Instincts can be imported from any HTTPS URL into `inherited/`, with `--force` and `--scope global` | `commands/instinct-import.md`, `instinct-cli.py:189-225` |
| Medium | Code sent to third-party models without a consent flag. `/astra-review` has one, `/santa-loop` does not. `/santa-loop` also runs `git push -u origin HEAD` on a pass | `commands/santa-loop.md` |
| Medium | Unpinned external runtimes run from commands: `npx ccg-workflow` (installs `~/.claude/bin/codeagent-wrapper`, one-hour timeout, "never kill"), `npx ecc-agentshield` | `commands/multi-*.md`, `skills/security-scan/` |
| Medium-low | Transcript summaries by `claude -p` (up to 7,000 characters) with no redaction, on every compaction | `scripts/lib/llm-summary.js`, `pre-compact.js` |
| Low-medium | Plaintext logs of every Bash command. Redaction misses `sk-ant-…`, a bare `Bearer`, `export VAR=…` and credentials in URLs | `scripts/hooks/post-bash-command-log.js` |
| Low | Commands run the first matching script, including one in the *reviewed* project's `./scripts/` | `commands/astra-review.md`, `harness-audit.md` |
| Low | The hook bootstrap `require()`s from the first ECC root it finds in a long search path under `~/.claude/plugins/cache/` | `hooks/hooks.json` |
| Low | ecc2's remote intake compares the bearer token in non-constant time, and worktrees go under world-readable `/tmp/ecc-worktrees` | `ecc2/src/main.rs`, `worktree/mod.rs` |
| Low | Opening the ECC repo itself as a trusted project starts `npx -y chrome-devtools-mcp@1.10.1` (pinned) | `.mcp.json` |
| Info | Opt-in YOLO profile for Codex: `approval_policy = "never"` | `.codex/yolo.config.toml` |
| Info | Sponsor and commercial promotion in skills, the MCP catalogue and `npm run welcome` | `src/llm/`, `mcp-configs/`, `package.json` |

Lessons for Claudio's own builds of these ideas:

- ★2 must keep mined text marked as untrusted, never import lessons from outside, and show the
  evidence next to each proposal.
- ★3's guard must fail closed and be bundled with the app. It must never resolve a script from the
  project or from a plugin cache.
- ★1 and ★5 put diffs and transcripts in prompts as data, never as instructions. Their runs are
  read-only and budget-capped.

Good practices worth keeping in mind:

- `agent-evaluator.md` runs git with `--no-pager` / `-c core.pager=cat`, so a pager set in the
  repository's `.git/config` cannot execute code.
- `/learn` checks slugs and paths and shows a diff before overwriting.
- Hookify ignores rule files tracked in git unless allowed, and wraps rule text as untrusted.
- `orch-review` turns a PR argument into an integer before it reaches a shell.

## 6. Open questions for the owner

1. **★1 review gate:** on by default for new orchestrations, or opt-in per graph? Should it run in
   flow as a fourth stage, or inside `verify`?
2. **★2 lessons:** may a lesson reach *global* scope, which touches every project, or stay per
   project only? Do lessons go only into the journal handoff, or may an approved lesson be written
   into `CLAUDE.md` with one click?
3. **★3 guards:** on by default for orchestration workers and flow runs only, or for interactive
   chats too? Which rules ship on (proposal: `no-verify`, `push`, `secrets` on; `protect-configs`
   and `destructive` on for automated runs only)?
4. **★4 compaction:** may Claudio send `/compact` on its own at a stage boundary, behind a decision
   point shipped `off`, or only offer it to the person?
5. **★5 evals:** is it worth an L-sized feature now, or first a small version, "run this agent file
   against three prompts and show the tool calls", that grows later?
6. **Order:** proposed order ★4 (smallest, wires existing code) → ★3 → ★1 → ★2 → ★5. Do you agree,
   or should ★1 come first because orchestration quality matters most?
7. **Credit:** a line in the plans that build these ideas ("idea credited to ECC, MIT, by Affaan
   Mustafa") — is that enough, or do you also want it in the README?

## Related

[[plans/context-control.md]] · [[context-control.md]] · [[plans/claude-only-fork.md]] · [[orchestrations.md]] · [[team-and-flow.md]] · [[prompts.md]] ·
[[decision-engine.md]] · [[security-model.md]] · [[plans/sdk-driver-improvements.md]] ·
[[plans/worker-checks.md]] · [[plans/verify-faster.md]] · [[plans/agent-observability.md]] ·
[[plans/changes-review.md]] · [[code-hosts.md]] · [[accounts.md]] · [[terminal.md]] ·
[[plans/chat-experience.md]] · [[lessons.md]] · [[guards.md]] ·
[[review-gate]] · [[instruction-evals]]
