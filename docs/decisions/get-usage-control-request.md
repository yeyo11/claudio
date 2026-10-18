---
created_at: 2026-10-17T21:00:00Z
updated_at: 2026-10-17T21:00:00Z
tags:
    - decision
    - accounts
    - one-rule
    - claude-code
    - usage
---
# Decision: the real quota comes from the CLI's `get_usage` control request

The Accounts page's Refresh only refetched the list, and the usage it showed came from the stream of
running chats or the CLI's undocumented `cachedUsageUtilization`, days old for an idle account. The
card could not say the plan well, the quota of a model with its own limit (Fable) or whether credits
were left, though the CLI knows all of it.

## Decision

Ask the CLI. Claude Code 2.1.302's stream-json protocol answers a `get_usage` control request, the
sibling of `initialize` (models, already used for [accounts](../accounts.md)) and `get_context_usage`
([cli-surfaces.md](../cli-surfaces.md)): send
`{"type":"control_request","request_id":"…","request":{"subtype":"get_usage"}}` on stdin of
`claude -p --input-format stream-json --output-format stream-json --verbose` and read the
`control_response`. It needs no `initialize` first, takes about five seconds, and spends no prompt,
no turn and no tokens.

This is the one rule at work ([CLAUDE.md](../../CLAUDE.md)): a documented stream protocol of the
vendor's own CLI, run in the account's own environment. Claudio makes no HTTP call, reads no
credentials and keeps no second login. The answer is anything the CLI chooses to put in it, so the
parser keeps only the fields the card draws and tolerates every other key (the response carries
many codename keys, mostly `null`).

## What it answers

`subscription_type`, `rate_limits_available` (false for an API key), `rate_limits.five_hour` and
`seven_day` (`utilization` 0-100, `resets_at`), `rate_limits.limits[]` (`session`, `weekly_all` and
`weekly_scoped` with the model's display name), `spend` and `extra_usage` for the credits. A real
answer, with the personal parts removed, is the fixture of
`packages/accounts/test/fixtures/get-usage-max.json`.

## Consequences

- The reading is the newest truth when it is newer than the stream's; the plan, the scoped limits and
  the credits are kept beside the windows ([accounts.md](../accounts.md#usage)).
- A scoped limit does not bind the account, only a chat that runs that model.
- The protocol is the CLI's, not a contract: a missing or renamed key reads as no data, never as an
  error, and the cache stays as the fallback.

## Related

[[accounts.md]] · [[cli-surfaces.md]] · [[plans/models-per-account.md]] · [[rest-api.md]]
