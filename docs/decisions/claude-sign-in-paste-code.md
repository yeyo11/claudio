---
created_at: 2026-10-18T20:00:00Z
updated_at: 2026-10-19T12:00:00Z
tags:
    - decision
    - sign-in
    - accounts
    - claude-code
    - one-rule
---
# Decision: Claude signs in with the paste-code `claude auth login`; the OAuth token leaves the UI

Taken by the owner on 2026-10-18, after running the 0.6.0 image on the LAN. The paste-code
`claude auth login`, relayed through pipes, already worked in the image (Accounts → Add account),
yet the setup assistant and Settings offered only an OAuth token made with `claude setup-token` and an
API key, and said Claude Code had no sign-in Claudio could do. Meanwhile the app believed
`claude auth status` — which says `loggedIn: true` for any token or key present, valid or not — and
showed a ghost `default` account next to an account that worked.

## Decision

- **Claude account first, API key second**, everywhere one signs in (the assistant, Settings → Claude
  Code, Accounts → Add account, Sign in again): the CLI's own `claude auth login`, relayed. The OAuth
  token is no longer offered in the UI and the docs stop recommending it.
- **The assistant and Settings sign in to the `default` account**: the CLI's own `CLAUDE_CONFIG_DIR`
  (`/home/node/.claude` in the image), through `POST /accounts/default/login`. That signs the CLI
  itself in, so the `claude` a person runs in the terminal works, and it is the account Settings calls
  in use. Accounts → Add account still creates a separate login account for rotation.
- **`default` shows only when it exists** (a credential file, or a key or token in the environment or
  the vault). `GET /auth` carries the account in use (`inUse`), and Settings, the status bar and the
  More sheet read it instead of the default dir's `loggedIn`.
- **A token already in the environment keeps working** (headless deployments cannot open a browser).
  It is documented once, in [configuration.md](../configuration.md#claude-code-credentials), as a
  headless option; the sign-in panel warns that it takes precedence. A token Claudio already keeps in
  the vault keeps working until it fails or is replaced, and a successful sign-in on `default` clears it.
  `PUT /auth/credentials { oauthToken }` and `POST /accounts/token` still answer, deprecated.

This is the one rule at work ([CLAUDE.md](../../CLAUDE.md)): the flow is a vendor CLI command run in
the account's own environment; Claudio holds no second login and scrapes nothing.

## What was found: `get_usage` cannot refuse a credential

The plan wanted the free `get_usage` control request ([get-usage-control-request.md](get-usage-control-request.md))
to validate credentials, and made the answer a spike. On CLI 2.1.302 an invalid OAuth token, an invalid
API key, no credential and a down network all answer success with `rate_limits_available: false`;
only a good subscription login returns limits (fixtures:
`packages/accounts/test/fixtures/get-usage-refused-*.json`). So the plan's second branch applies:

- `get_usage` only **confirms** a credential (it records `checkedAt` and clears an `expired` mark). It
  never marks one expired; a failed run still does.
- **Check** in Settings is **Send a test message** and runs the paid `POST /auth/verify`, only on that
  click, with the copy saying it sends one short message.
- Phase 2 narrowed this: an API key is now checked for free with the SDK's `models.list`, and **Check**
  is shown for a key; **Send a test message** remains the paid check for a login or an OAuth token
  ([accounts.md](../accounts.md#checking-a-credential)).
- Rejected: running `/auth/verify` on a timer (it costs a turn, and probes spend nothing,
  [providers.md](../providers.md)); and trusting `auth status` (it was the bug).

## Consequences

- A default found refused by a run counts as signed out and readiness falls back to another signed-in
  account.
- A sign-in left unfinished for 15 minutes ends as `expired`.
- Rejected: signing in through a new login account from the assistant (the terminal's `claude` would
  stay signed out and `default` an empty ghost); refusing the old token routes now (a patch release
  must not break a script).

## Related

[[accounts.md]] · [[setup.md]] · [[providers.md]] · [[configuration.md]] · [[cli-surfaces.md]] · [[plans/container-polish.md]] · [[decisions/get-usage-control-request.md]]
