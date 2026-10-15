---
created_at: 2026-10-15T14:00:00Z
updated_at: 2026-10-15T14:00:00Z
tags:
    - accounts
    - fixtures
    - claude-code
---
# Stage A · a0 facts (recorded with a real account)

Ground truth for the accounts work of [plans/claude-only-fork.md](../plans/claude-only-fork.md),
captured on CLI 2.1.295 with a real Max account. Secrets are scrubbed (`<email>`, `<org-uuid>`,
`<account-uuid>`, the OAuth `code`/`state`/`challenge`); no credential file was read.

## 1. `claude auth login` per account directory

`CLAUDE_CONFIG_DIR=/tmp/cuenta-prueba claude auth login` works: it opens the browser and prints the
authorize URL as a fallback, waits for a pasted code if the browser cannot open, then prints
`Login successful.`. The flow is the **CLI's own OAuth** (its client id, scopes `user:inference`,
`user:sessions:claude_code`, `user:mcp_servers`, …): Claudio only runs the subcommand with the
account's `CLAUDE_CONFIG_DIR`, it does not drive the OAuth itself. So `login(account)` =
`spawn claude auth login` in the account dir and relay the URL/code the way the setup device
sign-ins do.

## 2. `claude auth status --json` (a `login` account)

```json
{ "loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty",
  "projectsDirectory": "/tmp/cuenta-prueba/projects", "configDirectory": "/tmp/cuenta-prueba",
  "email": "<email>", "orgId": "<org-uuid>", "orgName": "<org>", "subscriptionType": "max" }
```

A `login` account **carries its email, org and plan**. Correction to the plan: `identify()` fills
`email`/`organization`/`plan` for `login` accounts, so an alias is only needed for `token` and
`api-key` accounts (which have no `oauthAccount`).

## 3. `cachedUsageUtilization` (the idle-account reading)

Present and rich. Per window `{ utilization, resets_at }` for `five_hour` and `seven_day`, plus
`extra_usage` (`is_enabled`, `monthly_limit`, `used_credits`, `utilization`, `currency`), a `spend`
block, and a `limits[]` array (`kind`, `group`, `percent`, `severity`, `resets_at`, `is_active`, and
a `scope.model.display_name` for scoped windows). Model-scoped windows appear as
`seven_day_opus`/`seven_day_sonnet` (null when unused) and under `limits[]` with a `scope`.

**Freshness:** in the sample `fetchedAtMs` was two days old and the `resets_at` were already in the
past. So the cache can be stale — it is best-effort, exactly as the plan says: stamp each reading
with `fetchedAtMs`, treat a window whose `resets_at` has passed as `unknown`, and let a live
`rate_limit_event` always win. Worth surfacing beyond the binding window: `extra_usage`/`spend`
(overage credits used) for the accounts UI.

## 4. Connectors

The account had **no connectors enabled**, which is why Gmail and Calendar showed as `notListed`
and only `claude.ai Claude Docs` appeared. Confirmed: the panel reflects the account's enabled set;
enabling Gmail/Calendar is done on claude.ai, not in Claudio.

## 5. `claude auth status --json` (a `setup-token` account)

```json
{ "loggedIn": true, "authMethod": "oauth_token", "apiProvider": "firstParty",
  "projectsDirectory": "<dir>/projects", "configDirectory": "<dir>" }
```

A `setup-token` account (the 1-year `sk-ant-oat…` from `claude setup-token`, passed as
`CLAUDE_CODE_OAUTH_TOKEN`) reports **no email, org or plan** — only `authMethod: "oauth_token"`.
Confirms the plan: `token` (and `api-key`) accounts have no identity of their own, so `add` requires
an alias and `identify()` leaves email/org empty for them. The token is long-lived (one year) and
the CLI prints it once; Claudio stores it in the account's own `0600` file.

## Still to capture (not blocking a2; record when available)

- `auth status --json` for an `api-key` account — **not available** (the owner has no API key);
  assume the same no-identity shape as a `setup-token` account.
- A real `rate_limit_event` from `claude -p … --output-format stream-json` (window keys
  `five_hour`/`seven_day`) — pending.
- `--resume` of a session started on one account, from another account's dir with linked `projects/`
  — pending (the first attempt mis-substituted the session id).

## Related

[[plans/claude-only-fork.md]] · [[providers.md]]
