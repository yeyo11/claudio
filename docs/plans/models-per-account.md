---
created_at: 2026-10-15T16:00:00Z
updated_at: 2026-10-19T18:00:00Z
tags:
    - plan
    - accounts
    - models
    - decision-engine
    - claude-code
---
# Stage A2: models per account, and model fallback

Status: **built** (2026-10-15): the model list per account from `initialize`, and the
`account.model-fallback` decision point (ships `off`).

Stage A ([plans/claude-only-fork.md](claude-only-fork.md)) chooses a Claude account by usage
headroom, but not by whether the account can run the chat's model. Two gaps, both found with real
accounts on 2026-10-15:

1. **The model picker is thin.** Claudio builds it from four hard-coded aliases plus the CLI's
   `additionalModelOptionsCache` (one entry on the owner's machine), so it shows far fewer models
   than Claude Code's own `/model` list, with duplicates (alias `fable` and a cached "Fable") and no
   per-model descriptions or effort levels (`packages/core/src/providers/claude-code/models.ts`).
2. **A switch can land on an account that lacks the model.** If a chat on a model only a Max
   account offers moves to a Pro account at a limit, the replayed turn fails. Stage A's `choose`
   ranks by headroom alone.

Both are solved from what the CLI already ships — no new surface, no impersonation.

## The source: the `initialize` control request

The CLI's `initialize` control request (the handshake Claudio can send with no prompt and no token
cost; confirmed on 2.1.300, 2026-10-15) returns the **full, account-filtered model list** and the
account. Response fields used here:

- `models[]`: one per option, with `value` (the `--model` argument, an alias or an id),
  `resolvedModel` (the concrete id, e.g. `claude-opus-5-5`), `displayName`, `description`,
  `supportsEffort`, `supportedEffortLevels` (e.g. `["low","medium","high","xhigh","max"]`),
  `supportsThinkingOff`. The list is already filtered by the account's subscription and the CLI
  version, so it is exactly what that account can run.
- `account`: `email`, `organization`, `subscriptionType` (e.g. `"Claude Max"`), `apiProvider`.

A recorded sample is in [reports/accounts-a0.md](../reports/accounts-a0.md). The list changes with a
CLI update or a subscription change, so Claudio caches it per account and refreshes it when either
moves.

> **Update, 2026-10-19.** The fallback described below was removed: the `initialize` list is now the
> only source, read at boot and when the CLI version changes, per chat account, with no invented
> entries ([owner-report-fixes.md](owner-report-fixes.md), [accounts.md](../accounts.md#models)).

## What A2 builds

### Models from `initialize`, per account

- `packages/accounts` (or the Claude driver) gains `models(account)`: runs `initialize` with the
  account's `CLAUDE_CONFIG_DIR` (or env for a token/api-key account) and parses `models[]` into the
  existing `ModelOption` shape, now carrying `resolvedModel`, `description`, `supportsEffort` and
  `supportedEffortLevels`. The result is cached per account (a file Claudio writes under the
  account's data), keyed and stamped, refreshed when the CLI version or `subscriptionType` changes.
- `packages/core/src/providers/claude-code/models.ts` stops building the list from four aliases plus
  `additionalModelOptionsCache`; it reads the `initialize` list for the default account, and
  per-account lists for the picker when several accounts exist. The alias-id learning
  (`ModelAliasIds`) is no longer needed — `resolvedModel` gives the id directly — but stays readable
  for old data.
- The web model picker shows the full list with descriptions, no duplicate Fable, and the effort
  picker offers only each model's `supportedEffortLevels`. The New chat and chat pages read it.

### Account choice respects the model

- Stage A's `choose` (`packages/accounts/src/choose.ts`) gains the chat's model as an input and a
  per-account "can run this model" predicate built from the cached `models[]` (match on the alias
  `value` or the `resolvedModel` id). An account that cannot run the model is not a candidate —
  unless a model fallback (below) maps it.
- At a limit, the switch only moves to an account that can run the chat's model, or one with an
  accepted fallback; otherwise it waits for the reset of an account that can, and says why.

### `account.model-fallback` decision point

A new decision point in the engine (`packages/core/src/decisions/points.ts`), shipping `off` with
consent and a state preview like every other point:

- **`account.model-fallback`** (suggest, global): when no account with headroom can run the chat's
  model, it proposes the nearest model the candidate account does offer (by tier: the same line, then
  the tier below). A person accepts the mapping; nothing changes model silently. The mapping is a
  settings document (`model-fallbacks.json`), one entry per `{ from, to }`, with `origin` and `at`.
- With the point `off` or no mapping accepted, the chat **waits** for an account that can run the
  model rather than downgrading. The chat shows which model each segment ran on.

This reuses the engine's existing machinery (consent, shadow accuracy, the four-mode test); it does
not bring back `provider.model-map`, which was between vendors.

## Persistence and API

- **JSON:** the per-account model cache (under the account's data), and `model-fallbacks.json`
  (global settings, a chat's token refused on write).
- **Shared types:** `ModelOption` gains `resolvedModel`, `description?`, `supportsEffort?`,
  `supportedEffortLevels?`; `ModelFallback` and its request; the decision point id. Regenerate the
  OpenAPI schemas.
- **Routes:** `GET /accounts/:id/models` (the account's list), `GET`/`PUT /accounts/model-fallbacks`
  (settings, chat token refused on `PUT`), and the fallback suggestion routes mirroring the other
  decision points. Each with a summary, a tag and a row in `docs/rest-api.md`.

## Orchestration

One feature branch off `feat/claude-only` (which already has stages S and A). Workers on
`claude-sonnet-5-5`; the usual verification (typecheck, `pnpm -r test`, OpenAPI no-drift, build),
fixer on sonnet.

- `m1` shared types and the `initialize` model read in `packages/accounts` + the per-account cache,
  with tests against the fake `claude` (extend its `initialize` to return `models[]`).
- `m2` core: `claude-code/models.ts` reads the list; `choose` takes the model and its predicate; the
  limit path waits when no account can run the model. Depends on m1.
- `m3` decision point `account.model-fallback`, resolver and settings. Depends on m1.
- `m4` API: the model and fallback routes, schemas, README, tests. Depends on m2, m3.
- `m5` web: the fuller model picker, effort levels per model, the fallback editor and the
  per-segment model on the chat; locales en/es, fixtures. Depends on m4.

## Web (m5, built)

- The picker reads the overview's model list once per model (`dedupeModels`: an alias and its id
  collapse; the `[1m]` variant stays) and shows each description, on the phone sheet too.
- `EffortPicker` offers only the model's `supportedEffortLevels`; `supportsEffort: false` disables
  it. A model the list does not cover keeps every level.
- Settings live on the Accounts page: `ModelFallbacksCard` edits `model-fallbacks.json` and accepts
  the `account.model-fallback` suggestion (`origin: 'suggestion'`); nothing is saved before that.
- The chat's Executions card shows each segment's model and effort, and "switched from X" when it
  differs from the segment before.
- Not wired: pickers use the default account's list; `GET /accounts/:id/models` has a client
  method but no screen.

## Risks

| Risk | What holds it |
|---|---|
| `initialize` is slow or costs tokens | It is the handshake Claudio already sends; no prompt, no turn. Cached per account, refreshed only on a CLI/subscription change |
| A model silently downgrades on a switch | Fallback is `off` by default and a person accepts each mapping; without one, the chat waits |
| The cached list goes stale after a plan change | Keyed by `subscriptionType` and CLI version; a mismatch triggers a refresh |
| A fallback maps to a model the account also lacks | The candidate predicate is applied to the fallback's target too |

## Related

[[plans/claude-only-fork.md]] · [[reports/accounts-a0.md]] · [[plans/sdk-driver-improvements.md]] · [[decision-engine.md]] · [[providers.md]]
