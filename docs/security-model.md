---
created_at: 2026-10-09T10:00:00Z
updated_at: 2026-10-15T20:00:00Z
tags:
    - security
    - secrets
    - setup
    - docker
---
# Security model: who may open Claudio, and how its secrets are kept

The project's security policy, what is and is not protected and how to report a vulnerability, is
[SECURITY.md](../SECURITY.md) at the root. This page is the knowledge base's map of the model,
pointing at the documents that own each part (several linked to it by name before it existed). The
part written in full is the newest one: how the keys and tokens a person enters during the in-app
setup are kept ([the plan](plans/in-app-setup.md), [setup.md](setup.md)), as built on 2026-10-08.

## Who may open it

- **The auth mode** is `none`, `token` or `oidc` (Settings → Security, `auth.json` in the data
  directory with the hash of the token, mode 0600; `CLAUDIO_AUTH_MODE` only seeds an install that has
  none yet). See the README's [Securing it](../README.md#securing-it). The setup assistant's Access
  step sets the same thing, and turning Token on makes a token first when the browser holds none, so
  it cannot lock the person out ([setup.md](setup.md#the-web)).
- **Read-only mode** (`CLAUDIO_READ_ONLY`) refuses every write, the setup's included (405).
- **A chat's own token.** A chat Claudio starts gets its own `CLAUDIO_API_TOKEN`
  ([chat-environment.md](chat-environment.md)); it may not change the security settings, open the
  tunnel or touch the setup routes but `GET /setup` (403), since reading a sign-in session would hand
  it the person's device code.
- **Remote access** is tailnet-only (`tailscale serve`, never Funnel), and refuses to open while the
  auth mode is `none` ([tunnel.md](tunnel.md)). The host allowlist is in
  [deploy.md](deploy.md#the-host-allowlist-and-why-a-proxy-has-to-be-told-about-it).

## The secret vault

`packages/core/src/secret-vault.ts`, one document: `<dataDir>/secrets.json`, mode 0600, written
through a temp file created at 0600. It holds only what a CLI reads from its **environment**: Claude
Code's OAuth token or API key, YouTrack's address and token. Values are sealed with AES-256-GCM (`SecretBox`) when
there is a key, as `enc:v1:…`.

**The key**, in this order (the plan's decision 3):

1. `CLAUDIO_SECRET_KEY`, 32 bytes as hex. The desktop app makes one and keeps it in a file only the
   operating system's keyring can open (Electron's `safeStorage`, `apps/desktop/src/secret-key.ts`),
   and hands it to its server at launch; an operator can pass one to a container. The server drops it
   from `process.env` once read, so no child inherits it.
2. `<dataDir>/secret.key`, when it already exists.
3. In the Docker image only (`CLAUDIO_DISTRIBUTION=docker`), a new `secret.key`, 32 random bytes as
   hex, mode 0600, made on the first write: `/data/secret.key`, on the same volume as the vault.
4. Otherwise none: a source install, or a desktop app with no keyring, keeps the values plain at
   0600, as before the vault.

A key beside the data protects a copy of the files (a backup, a file sent by mistake), not the
volume: whoever can read `/data` reads both. Settings → Security's Secrets card says which case an
install is in (`GET /setup`'s `secrets`: `sealed`, `keyBeside`), and recommends passing the key in the
environment; [deploy.md](deploy.md#what-the-image-contains) says how. The Helm chart takes it from a
Secret (`secretKey.existingSecret`, rendered as `valueFrom.secretKeyRef`), so it stays out of the
release. A value sealed with another
key reads as absent, so it is entered again rather than misread.

The older plain files, `credentials.json` (Claude Code) and `youtrack-credentials.json`, are moved
into the vault once at start and removed.

## Where a secret may go

The plan's decision 5: **a secret never goes in argv, a log, an event or an answer.**

- **Only to the child processes of the CLI that needs it.** `childEnv(tool)`
  (`packages/core/src/child-env.ts`) lays that tool's vault variables over the inherited environment
  for every spawn of that tool: Claude Code's runs and probes, the
  detector, gh, glab and youtrack-app. Nothing is written to `process.env`, so a project's checks,
  git, or another agent never inherit Claude Code's token. (Before the vault, the Claude store copied
  it into `process.env` and every child got it.)
- **On stdin for a CLI with a login command.** A key for gh or glab goes once to that CLI's
  own login command on stdin (`gh auth login --with-token`, `glab auth login --stdin`), and the CLI stores it (decision 4). The tests assert the spawned argv
  and what the fake CLI read on stdin.
- **Tailscale's auth key through a file.** `tailscale up` takes a key only in argv or as
  `--auth-key=file:<path>`, so the key is written to a file of mode 0600 inside a fresh 0700 folder
  under the system temp directory (`wx`, never over an existing file), the command gets the path,
  and the folder is removed when the command ends, whatever happened. tailscaled keeps the node key
  it gets in exchange, so the auth key is used once and stored nowhere
  ([setup.md](setup.md#tailscale)).
- **Write-only fields.** The key fields in the sign-in panel and YouTrack's token are never filled
  back: no route answers a secret, the field is cleared once sent, and an empty token field keeps
  the saved one.
- **Events carry the URL and the code, nothing else.** A device sign-in reads the CLI's output line
  by line for the verification URL and the one-time code only; `login.updated` carries those and an
  error *code*, never what the CLI printed. Success is decided by re-running the tool's readiness
  probe, not by reading the output.
- **Masked where text leaves the machine.** Every vault value joins Claudio's own secrets
  (`recognizeSecrets`, `packages/core/src/decisions/redact.ts`), masked in a decision's state whatever text surrounds them.

## What the vendors' CLIs keep in plain text

Some sign-ins are not Claudio's to keep. Where a vendor's CLI has a login command, it owns the
credential and stores it where it always does (decision 4); Claudio does not copy it, seal it or
read it. In the Docker image those homes are on the data volume so a replaced container keeps them,
and a container has no system keyring, so each CLI falls back to the plain-text store it documents
for that case:

| CLI | Where, in the image | What |
|---|---|---|
| gh | `/data/provider-homes/gh/hosts.yml` (`GH_CONFIG_DIR`) | the OAuth or personal token per host; gh's documented fallback when no keyring exists |
| glab | `/data/provider-homes/glab/config.yml` (`GLAB_CONFIG_DIR`), mode 0600 | the token per host; glab says so as it signs in |
| Tailscale | `/data/tailscale/tailscaled.state`, in a 0700 folder | the node's key, which is what keeps it on the tailnet |

Why this is accepted rather than wrapped: sealing another CLI's files would mean reading and
rewriting them behind its back, or handing it a credential it was not built to take, which the one
rule forbids ([CLAUDE.md](../CLAUDE.md)). The CLIs' own fallback is what their vendors document for
a machine with no keyring, and the files sit on the same volume, with the same exposure, as
Claudio's own `secret.key`. The protection for all of them is the volume's: who can read `/data`.
Signing out from Claudio runs each CLI's documented sign-out (`gh auth logout`, `glab auth logout`,
`tailscale logout`), which removes what it stored.

On a person's own machine (a source checkout, the desktop app) the CLIs use the system keyring when
there is one, as they always did; Claudio changes nothing there.

## What a repository can make Claudio run

A repository is not trusted: its `.git/config` and `.gitattributes` can name a `textconv` or external
`diff` driver, which is a program git runs when it builds a diff. Every `git diff` Claudio runs
itself (changes, the diff stat of a failing check, the health probe, the merge state) passes
`--no-textconv --no-ext-diff`, so opening a project never executes code a clone brought along.

## Agents never push

`git push` is denied, as `--disallowedTools`, to every run Claudio starts for an orchestration (workers,
integrator, verification and fixer, planner, workflow, synthesis), to the supervisor, and to every flow
stage. The push of a pull request branch is Claudio's own process, after the person approved.

## A chat cannot approve its own memory

What a memory proposal writes (`CLAUDE.md`, a memory file, the journal) is read as instructions by every
later run of the project. `POST /memory-proposals/:proposalId/approve` and `/reject` therefore answer
403 to a chat's token, with the same error shape as the other routes closed to it; proposing stays
open, and the person's token decides.

## The terminal

The terminal is a shell on the machine that runs Claudio, so it is the most privileged thing the
server offers. The full model is [plans/terminal.md §3](plans/terminal.md#3-security); the rules:

- off until the owner turns it on; with authentication off it opens only from loopback, and off this
  machine only through the tunnel with a token (or any device with a token, if the owner allows it);
- a chat's token, the desktop secret and any process a chat started are refused, the last by looking
  up the connection's owner in `/proc`; when that cannot be told, it fails closed under `none`;
- the socket opens with a one-use ticket (30 s, bound to the terminal and the `Origin`), and the
  `Origin` and `Host` are checked before the upgrade;
- the shell gets the vault's tool credentials but no `CLAUDIO_*` variable and none of Claude's own;
- sessions and attachments (including refusals) are audited, never their content.

See [terminal.md](terminal.md).

## Known limits

- A key beside the data does not protect the volume; only a key passed in the environment does.
- A kept token is not validated for free, so a revoked one reads `ready` until a run fails on it.

## Related

[[setup.md]] · [[plans/in-app-setup.md]] · [[deploy.md]] · [[tunnel.md]] · [[code-hosts.md]] ·
[[terminal.md]] · [[providers.md]] · [[trackers.md]] · [[chat-environment.md]] · [[desktop.md]] · [[layered-settings.md]]
