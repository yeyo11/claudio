---
created_at: 2026-11-13T22:00:00Z
updated_at: 2026-11-13T22:00:00Z
tags:
    - report
    - accounts
    - testing
    - isolation
    - fixtures
---
# Report: how the unit tests' fake CLI wrote into the owner's real account dirs (B15)

Task T0b of [plans/account-configuration-and-project-rules.md](../plans/account-configuration-and-project-rules.md),
decision D14 (investigate before T1). Read-only on `~/.config/Claudio`: names, sizes and dates, never
contents of a credential.

## What happened

Two files of the test fixture `packages/accounts/test/fake-claude.mjs` sit in two real account dirs:

| Account dir | `fake-login.json` | `initialize-count` |
|---|---|---|
| `accounts/acc-0d90ca6f` (Pro) | 48 B, 2026-10-19 16:54 | 47 B (47 probes), 2026-10-19 16:55 |
| `accounts/acc-a6b913cd` (Team) | 48 B, 2026-11-07 10:53 | 54 B (54 probes), 2026-11-07 10:53 |

`fake-login.json` holds `{"email":"acc-0d90ca6f@example.com","org":"Org"}`: the fake derives the
email from the **last segment of the config dir**, so the sign-in ran with `CLAUDE_CONFIG_DIR` set to
the real account dir. `initialize-count` gets one `x` per `initialize` handshake. Neither file is read
by anything real, so they are inert; the road, though, is open to any fixture that writes into
`CLAUDE_CONFIG_DIR`.

## The cause

`envFor` (`packages/accounts/src/env.ts`) gave the default account **whatever `CLAUDE_CONFIG_DIR` the
base environment had**, without asking whether it named the account's own dir:

```ts
else if (base.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = base.CLAUDE_CONFIG_DIR;
```

That is right in production, where the server's variable and the default dir are the same thing.
It is wrong for a store whose `defaultDir` was given on purpose (a test's temp dir), because a
Claude Code chat that Claudio started on a **non-default account** exports that account's dir:
`CLAUDE_CONFIG_DIR=~/.config/Claudio/data/accounts/<id>`. A test run by an agent in such a chat (an
orchestration task, a verification) inherits it. `Core` builds its `AccountStore` with
`env` absent, so `process.env` is the base, and every process of the **default** account (models
probe, sign-in, usage, identify) started with the real account's dir, while `loadConfig` and the
store's own paths were temp dirs.

The test that reaches it: `apps/api/test/accounts.test.ts`, lines 98 and 104-118
(`POST /api/accounts/default/login`, then the code `good-code`): the fake's `auth login` writes
`fake-login.json` into `CLAUDE_CONFIG_DIR`. The same file's, and `model-fallbacks.test.ts`'s, probes of
the default account (`GET /api/accounts/default/models`, the boot warm-up of the model lists) append to
`initialize-count`. Both files use `Core` with the accounts package's fake; the core fake
(`packages/core/test/fixtures/fake-claude.mjs`) writes neither file, which is why only those two
suites could leave them.

## How it was confirmed

- **By the content.** The file's email is the real account's id: the sign-in ran in that dir. The
  dates are the evenings the owner's orchestrations were running tasks on Pro (2026-10-19) and Team
  (2026-11-07), and the probe counts (47 and 54 in a minute) are what one suite run reads of
  the `default` account (inferred: the counts were not tied to one run).
- **By ruling out the others.** Every `new AccountStore` and `new Core`/`loadConfig` in the tests was
  read: all give a temp `dataDir` and `defaultDir` (`tempConfig()` in `packages/core/test/helpers.ts`
  and the `mkdtempSync(join(tmpdir(), …))` roots); `claudio-accounts`' default data dir
  (`commands.ts`) is only reached by a test that does not pass `--data-dir`, and the one that
  calls `main` passes it. A real `accounts.json` is never read by a test, so no test could name
  `acc-0d90ca6f` itself: the id reaches the fake only through the inherited variable.
- **By reproduction on a decoy.** `envFor({ id: 'default', … dir: <temp> }, { CLAUDE_CONFIG_DIR:
  <decoy> })` returned the decoy (run before the fix, in a scratch dir); the new test does the same end
  to end (below). Nothing was run against a real dir.
- `scripts/test-tmp.mjs` isolates only `TMPDIR`: it does not touch `CLAUDE_CONFIG_DIR`,
  `CLAUDIO_DATA_DIR` or `HOME`, so it could not stop this.

## The fix

1. **The root**: `envFor` keeps the base's `CLAUDE_CONFIG_DIR` for the default account only when it
   names the account's own dir (same resolved path); otherwise the process gets `account.dir`. In
   production nothing changes: the variable and the dir are the same.
2. **The test process**: `scripts/test-tmp-preload.mjs`, loaded in every test process and in
   every process a test spawns, drops `CLAUDE_CONFIG_DIR`, `CLAUDIO_DATA_DIR` and
   `CLAUDIO_WORKSPACE_DIR` when they point outside the run's temp dir. A test that wants one sets it
   to a dir of its own, which stays.
3. **Guards** (`packages/accounts/test/test-isolation.test.ts`):
   - a test process inherits no directory selector from outside its temp dir (fails when a test is run
     without the wrapper from such a chat);
   - the default account gets its own dir when the base names another;
   - end to end, with a decoy dir standing in for the real account: a models probe and a sign-in of the
     default account write in the store's dir and leave the decoy empty;
   - a scan: every `new AccountStore({…})` in the suites of `accounts`, `core` and `api` passes a
     `dataDir` and a `defaultDir`, so none can fall back to `~/.claude` or the real data dir.

## What it does not cover

- `HOME` is left alone: a test that builds a store with no `defaultDir` and no variable would still resolve
  `~/.claude`. The scan above is what keeps one from being written; redirecting `HOME` for every test
  would change git, pnpm and tools' behaviour for no evidence of harm.
- The two files in the owner's dirs are **not removed** (nothing under `~/.config/Claudio` is
  written by this work). They are harmless and the owner may delete them.

## Related

[[plans/account-configuration-and-project-rules.md]] · [[accounts.md]] · [[reports/accounts-a0.md]]
