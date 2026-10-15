---
created_at: 2026-10-15T18:00:00Z
updated_at: 2026-10-15T18:00:00Z
tags:
    - accounts
    - rotation
    - claude-code
    - convention
---
# Claude accounts

Claudio can run on several Claude accounts and move work from one to another at a usage limit. It
does so with `packages/accounts` (`@agentry/accounts`, renamed `@claudio/accounts` in the rename
stage), which reaches Claude Code only through what the CLI ships for programs: a `CLAUDE_CONFIG_DIR`
per account, `claude auth login`, `claude auth status --json`, the `rate_limit_event` of the
stream and the CLI's own `cachedUsageUtilization`. There is no claude-swap, no call to Anthropic's
HTTP endpoints and no OAuth flow of Claudio's own. The reasons are decisions 7 to 9 of
[plans/claude-only-fork.md](plans/claude-only-fork.md); the facts it rests on, recorded with a real
account, are in [reports/accounts-a0.md](reports/accounts-a0.md).

## An account

| Kind | Added with | A process gets | Identity |
|---|---|---|---|
| `login` | `claude auth login`, run in the account's own dir | `CLAUDE_CONFIG_DIR=<account dir>`; the CLI refreshes its tokens there | email, organisation and plan, from `claude auth status --json` |
| `token` | a `claude setup-token` token, pasted once | `CLAUDE_CODE_OAUTH_TOKEN` | the alias the person gives it |
| `api-key` | an API key, pasted once | `ANTHROPIC_API_KEY` | the alias; no usage limits to read |

- **The default account** is the CLI's own config dir (`CLAUDE_CONFIG_DIR`, else `~/.claude`), so a
  fresh install works with nothing to set up. It is listed first and cannot be removed.
- **An alias** is required for `token` and `api-key` accounts only: a `login` account already has
  its email.
- **Dirs** live in `<data>/accounts/<id>/`. `settings.json`, `CLAUDE.md`, `keybindings.json`,
  `agents`, `commands` and `skills` are symlinks to the default dir, and `projects/` is always linked,
  so every account writes its transcripts where Claudio reads them and a session started on one
  account resumes on another with `--resume`.
- **Secrets** of `token` and `api-key` accounts are a `0600` file in the account's own dir and are
  in no API answer. Claudio never reads, copies or writes a `login` account's credentials: only the
  CLI does.
- **Nothing is global.** The account is chosen per process, and the variables of the other kinds
  are removed from its environment, so two chats can run on two accounts at once. A live chat stays
  on its account until it is launched again.

## Usage

Per account and window (`five_hour`, `seven_day`), as a 0-1 utilization with its reset:

1. **The stream.** Every turn emits a `rate_limit_event`, near a limit or not, and a result that
   died on a limit carries a 429. This is the live reading and always wins.
2. **The CLI's cache.** `cachedUsageUtilization`, in each account dir's config, is the reading of an
   account that has not run a turn. It is stamped with its `fetchedAtMs`, and a window whose reset
   has passed reads `unknown`, because the cache can be days old.

The latest reading per account is `<data>/accounts/limits.json`; the history is the `usage_history`
rows and each switch or wait a `rotation_events` row. An account with neither reading is `unknown`,
and an unknown account is allowed.

## Choosing and switching

- A new chat that does not name an account takes the one the rotation chooses: with the `least-used`
  strategy (the default) the enabled account with the most room, with `order` the first in the
  list. Per-project policies (an ordered list of accounts and a threshold) override the global
  order, and a chat pinned to an account rotates only within its policy.
- An account whose binding window is at the threshold (90 % by default) is skipped until it falls
  `hysteresis` points under it, and one that hit a limit is left alone until its reset, or for
  `cooldownSeconds` when the reset is unknown.
- **At a limit**, the account is marked, another is chosen and the turn is replayed in the same
  chat, resumed on the new account. A person's chat does it when `rotateOnLimit` is on (the
  default); automated work always does. With no account left, the work waits for the earliest
  reset.

Settings are `<data>/accounts.json` (`GET`/`PUT /accounts/settings`).

## Where it shows

- **API:** `/accounts` and its sub-routes, in the README's Accounts table. A chat's token reads
  them and cannot change them.
- **Terminal:** the `claudio-accounts` binary of the package, on the same data dir.
- **MCP:** `list_accounts` ([agentry-mcp-server.md](agentry-mcp-server.md)) answers each account's
  kind, alias or email, plan, `enabled`, `signedIn` and its limit, compact.
- **Web:** the Accounts page, the status bar's account card, New chat's account picker and Home's
  limit widgets.

## Tests

The unit tests run against `packages/accounts/test/fake-claude.mjs`, which honours
`CLAUDE_CONFIG_DIR`. The end-to-end spec `e2e/specs/accounts.spec.mjs` uses the fake CLI of
`e2e/fake-cli`: a token account starting with `fake-limited` is out on the `FAKE-LIMIT-ACCOUNT`
line, and the chat is replayed on another account.

## Related

[[plans/claude-only-fork.md]] · [[reports/accounts-a0.md]] · [[providers.md]] · [[agentry-mcp-server.md]] · [[desktop.md]] · [[deploy.md]]
