---
created_at: 2026-10-16T12:00:00Z
updated_at: 2026-10-16T12:00:00Z
tags:
    - rename
    - migration
    - compatibility
    - decision
---
# Reading what the old name left behind

Decision 6 of [plans/claude-only-fork.md](plans/claude-only-fork.md) renames everything of Claudio's
own, not only what collides with an installed Agentry. Stage R renamed the packages, the variables,
the runtime identity and the copy; the leftovers (identifiers, the API contract's field names, file
names, browser storage keys, CSS classes, test fixtures) were renamed afterwards, on
`chore/rename-leftovers`. The plan said no migration was needed because Claudio starts with an empty
data directory. That stopped being true once builds from before the rename had been used: their
rows, settings files, browser storage, GitLab hooks and review bodies still carry the old name. So
the rename keeps them working.

## The rule

- **Stored rows are rewritten once.** A migration at the end of `MIGRATIONS` in
  `packages/core/src/db.ts` (`RENAME_SCHEMA_VERSION`) turns `agentry` into `claudio` where a build
  from before wrote it: a chat's `origin` and its assistant marker (`agentryAssistant` →
  `claudioAssistant`) in the chat row's JSON, the audit's `actor`, a merge's `requested_by`. A chat
  row whose JSON cannot be parsed is left alone, so it cannot stop the upgrade.
- **What cannot be rewritten is read under both names.** Settings files are rewritten on their next
  save, a request from an older client is accepted, and what lives outside Claudio (a host, git) is
  recognised.
- **New data is only ever written under the new name.**

## The shims, and when each can go

| Where | What is still read | Can go when |
|---|---|---|
| `tunnel.ts` | `startWithAgentry` in `tunnel-settings.json` and in `PUT /tunnel/settings` (the new name wins) | every install has saved its tunnel settings once, and no client from before the rename is left |
| `project-docs.ts` | `createdBy: 'agentry'` in a project's docs file | every project's docs file has been saved again |
| `work-links.ts` | a worktree locked as `agentry work item <key> of project <id>` | those item worktrees are removed (git keeps the lock reason until then) |
| `hosts/reviews-service.ts` | the `<!-- agentry:<uuid> -->` marker in review bodies posted before | never needed for new reviews; the old ones stay on the host |
| `hosts/gitlab/hooks.ts`, `webhook-receiver.ts` | GitLab's signing token derived under the old label (`signingTokensOf`) | every GitLab hook registered before the rename has been repointed (the tunnel moved) or registered again |
| `security/redact.ts` | the old secrets placeholder `__agentry_redacted__` sent back by a page loaded from the old server | no page loaded before the upgrade is still open: in practice, at once |
| `chat-service.ts` | drops `agentryAssistant` from a chat body, as it drops `claudioAssistant` | never worth removing: it is a guard |
| `apps/web/src/lib/legacy-storage.ts` | every `localStorage` key starting with `agentry-`, `agentry:` or `agentry.`, moved to its `claudio` name on start | no browser that ran a build from before the rename is still in use |
| `apps/web/public/sw.js` | the `agentry-push` push state, carried to `claudio-push`; old `agentry-*` caches are deleted | as the line above |

The chat token prefix needs nothing: chat tokens (`agc_…`) live only in the server's memory and die
with it, so no token from before an upgrade can be presented after it. The desktop bridge
(`window.claudioDesktop`) is renamed without a fallback because the desktop shell and the web UI
ship together.

## What keeps the old name on purpose

- The recorded outputs of `gh`, `glab` and `tailscale` under `packages/core/test/fixtures/recordings`,
  `fixtures/logins` and `fixtures/workflow-session`: they are what the real CLIs printed against the
  upstream repositories (`yeyo11/agentry`, `yeyo11/agentry-probe`), and the goldens and tests that
  replay them name the same repositories.
- The compatibility constants above, which name the old values so they can be read.
- History: the fork plan, the rebrand plan, the release this fork started from in
  [status.md](status.md), and notes about the upstream project.

## Related

[[plans/claude-only-fork.md]] · [[plans/claudio-rebrand.md]] · [[status.md]] · [[tunnel.md]] · [[code-hosts.md]] · [[desktop.md]]
