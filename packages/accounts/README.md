# @agentry/accounts

Several Claude accounts for Claudio, reached only through what Claude Code ships for programs:
one `CLAUDE_CONFIG_DIR` per account, the account chosen per process, `claude auth login` and
`claude auth status --json` for identity, `rate_limit_event` and the CLI's own
`cachedUsageUtilization` for usage. It never reads, copies or writes a `login` account's
credentials; the `token` and `api-key` secrets sit in a `0600` file in the account's own dir.

Plan: [docs/plans/claude-only-fork.md](../../docs/plans/claude-only-fork.md) (section 2). Facts it
rests on: [docs/reports/accounts-a0.md](../../docs/reports/accounts-a0.md).

- `store.ts`: `accounts.json`, the account dirs, settings, per-project rotation policies
- `dirs.ts`: account dirs and their symlinks (`projects/` always linked)
- `env.ts`: `envFor(account)`, the environment one `claude` process gets
- `identify.ts`, `login.ts`: through the CLI
- `usage.ts`: stream and cache readings, stamped, and the latest per account (`limits.json`)
- `choose.ts`: pure choice of the account for new work
- `cli.ts`: the `claudio-accounts` binary (`--data-dir` or `AGENTRY_DATA_DIR`)

The ideas come from claude-swap by Onur Cetinkol (MIT, © 2026); no code is copied.
