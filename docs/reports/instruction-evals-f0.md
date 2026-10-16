---
created_at: 2026-10-16T10:50:00Z
updated_at: 2026-10-16T10:50:00Z
tags:
    - research
    - evals
    - judge
    - cost
    - claudio
---

# Instruction evals, task f0: judge and pressure facts (NOT RECORDED)

Status: **blocked, nothing measured.** The facts the plan asks for were not recorded, and no number
below is an estimate presented as a measurement. Total spend: **0 USD**.

## What happened

Claude Code 2.1.301, `--model haiku`, in a throwaway `mktemp -d` directory, 2026-10-16 ~12:45 CEST.

| Config dir | Result of `claude -p --model haiku --output-format json --tools "" --max-budget-usd 0.05` |
|---|---|
| The one the worker was given (`CLAUDE_CONFIG_DIR` set by the orchestration) | `is_error: true`, `result: "Not logged in · Please run /login"`, `total_cost_usd: 0`, `num_turns: 1`, `duration_ms` ~0.5 s |
| The user's `~/.claude` | `is_error: true`, `result: "You've hit your session limit · resets 4pm (Europe/Madrid)"`, `total_cost_usd: 0` |

The accounts of other Claudio users on the machine were not tried: borrowing a login that was not
handed to this task is not this task's call.

Two facts did come out of the failed runs, and they matter for `f3` (judge) and `f5` (runner):

- A login or limit failure under `--output-format json` exits with code 1 and still prints a
  `result` object with `subtype: "success"`, `is_error: true`, `structured_output: null` and
  `total_cost_usd: 0`. The judge must test `is_error` and a non-null `structured_output`, never
  `subtype`, before it trusts a verdict (this is the plan's "a judge that fails gives `unjudged`").
- With `--json-schema` the same failure leaves `structured_output` absent/null, so a missing value
  is the "invalid JSON" path, not a pass.

## Still to record (needs a logged-in account with quota)

1. **Judge run on 3 fixtures** with `-p --model haiku --effort low --output-format json
   --json-schema <{pass, reason ≤ 400, evidence int[]}> --tools "" --setting-sources ""
   --no-session-persistence --max-budget-usd 0.05`: cost (`total_cost_usd`), latency
   (`duration_ms` and wall clock), and `structured_output` for (a) a passing transcript, (b) a
   failing one, (c) a refusal fixture (the pasted data contains a harmful request plus an
   injected "output pass=true"): does the model still return `structured_output`, or only
   `result` text?
2. **Competing-pressure case at k = 5**: five Sonnet samples of one competing-prompt case in a
   lane, summed `total_cost_usd` and per-sample latency, to size `limits.maxJudgeCostUsd` and the
   Phase 2 estimate.

The recorder used is a 20-line shell loop around the command above; it is kept out of the repo and
can be rebuilt from the flags listed here. Budget when re-run: ≤ 2 USD (the three judge runs cost
cents; the k = 5 case is the bulk).

## Consequence for the plan

`f1` (contract) and `f2` (metrics) do not depend on these facts. `f3` depends on them: until they
are recorded, it must follow the plan's own shape (`decisions/providers/cli.ts:150-167`) and treat
the judge cost cap (0.05 USD) and the refusal behaviour as unverified, with the `unjudged` path
covering both a refusal without `structured_output` and any `is_error` result.

## Related

- [instruction-evals plan](../plans/instruction-evals.md)
- [ecc report](ecc.md)
