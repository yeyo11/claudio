---
created_at: 2026-10-18T20:00:00Z
updated_at: 2026-10-18T20:00:00Z
tags:
    - updates
    - docker
    - launcher
    - security
    - claude-code
---
# Updating Claudio and Claude Code from the app

How a Claudio **in a container** updates itself, and how it installs a newer Claude Code, from
Settings → General → Updates. The desktop app has its own updater ([desktop.md](desktop.md)), and a
source checkout is updated with git. The decision and what was rejected:
[decisions/container-in-app-updates.md](decisions/container-in-app-updates.md); the plan is
[plans/container-polish.md](plans/container-polish.md). How the app learns of a release at all
(`release.json`, `system.release`) is in [deploy.md](deploy.md#updating-claudio).

## The shape

The image's `/app` is the base. A verified **overlay** in `/data/app/<version>/` replaces it when it
is newer. A **launcher** (`/app/launcher.mjs`, root-owned and read-only like the guard) is the
container's `CMD`: it starts the server from the overlay or from `/app`, restarts only the node
process onto a new bundle, marks a bundle good once `/api/health` answers, rolls back on its own
after failed boots and falls back to `/app`. It is called the launcher because *supervisor* already
names the chat supervisor. It only imports `node:*`, so it carries no dependency to break.

- **Exit code 75** (`RESTART_EXIT_CODE`) means "restart me onto the new bundle". Any other exit ends
  the launcher with the server's code, so the container stops exactly as it does today and a restart
  policy (or Kubernetes) brings it back on the same good bundle.
- **No restart policy needed.** A plain `docker run` with no `--restart` still restarts the server onto
  a new bundle, because the loop lives inside the container.
- **The plain image with no overlay behaves as before**, except that `launcher.mjs` is the parent of
  `api.mjs`.
- SIGTERM and SIGINT are passed to the server, so `docker stop` is as clean as before.

## Who may update

The owner only: a `token:*` or OIDC actor. It is refused to a chat's token (`CHAT_FORBIDDEN_SYSTEM`),
to the desktop credential, under `mode: none` (`update.needs-auth`) and in read-only mode (`405`).
Every request writes the audit log, and a rollback the launcher did is written as a row on the next
start. `CLAUDIO_SERVER_UPDATE=off` hides the feature (the card reports `no-launcher`).

If it cannot update itself, the Updates card says why (`unsupportedReason`: `needs-auth`, `read-only`,
`no-launcher`, `no-keys`, `not-docker`) and shows the host commands of
[deploy.md](deploy.md#updating-claudio) with one line above them.

## The flow

1. **Available.** The release check ([deploy.md](deploy.md#updating-claudio)) found a newer release.
   The card shows **Download Claudio {version}**. Only the newest release is offered, and only a
   version newer than both the image and the running one.
2. **Download** (`POST /system/server-update/download`). The server checks the manifest's signature,
   `minImage` and the Node ABI **before** downloading (`412 update.needs-image` if the image is too
   old), then downloads the tarball, checks its sha256 and then every file's. The card shows a
   progress bar, then *Checking the signature…*.
3. **Ready.** The bundle is unpacked into `/data/app/<version>/` and recorded as the *trial* in
   `/data/app/state.json`. The card offers **Restart to update to {version}**.
4. **Apply** (`POST /system/server-update/apply`). If chats are working or waiting, or orchestrations
   are running, it answers `409 update.live-work` with the counts and the card asks: **Restart now** or
   **Restart when nothing is running** (checked every 15 s; **Cancel** undoes it). The rule is the
   desktop's `installDecision`, counted as the desktop counts. Then the server exits 75.
5. **Trial boot.** The launcher verifies the bundle again and starts it. If `/api/health` answers within
   60 s the bundle is kept (it becomes `active`, the old one `previous`). After two failed boots it is
   marked `bad`, the rollback is recorded and the next candidate is tried: the previous update, then
   `/app`. A `bad` version is never offered again; the next release is.
6. **The page reloads on its own** when `stream.hello` reports the new version.

A download that fails comes back as `state: 'failed'` with `error` (`fetch-failed`, `bad-signature`,
`bad-manifest`, `disk`); only preconditions are HTTP errors. A downloaded update applies at the next
restart of any kind, since the trial is set at download time.

**Going back.** On an overlay, *Go back to the image's version* (`POST /system/server-update/revert`)
restarts onto `/app`, with the same live-work question.

## How it is trusted

- **Signing.** Each release carries `claudio-server-<v>-linux-x64.tar.gz`, its manifest `….json`
  (`schema`, `version`, `nodeAbi`, `minImage`, `imageInputs`, `commit`, the tarball's sha256 and
  size, every file's sha256) and `….json.sig`, an Ed25519 signature over the manifest's exact bytes.
  The private key is the secret `CLAUDIO_BUNDLE_SIGNING_KEY` of the GitHub Environment `release`,
  restricted to `main`; the release job refuses to publish an unsigned bundle. The tarball also gets a
  build-provenance attestation, for people.
- **The image is the trust anchor.** `launcher.mjs`, `/app/keys/*.pub`, `/app/image.json` and
  `guard.mjs` come only from the image, root-owned, never from an overlay. An overlay never carries a
  guard. Every accepted public key is in the image, so a rotation ships the new key in an image before
  it signs anything.
- **Verified twice.** By the server before unpacking, and by the launcher at **every** boot. The
  agents' user can write `/data`, but cannot forge a signature, and cannot point the launcher outside
  `/data/app/<v>`: paths are built from validated version strings and never read from `state.json`.
  The launcher refuses extra files and symlinks in a bundle.
- **`/app` is root-owned.** `api.mjs`, `mcp.mjs`, `guard.mjs`, `launcher.mjs`, the host files, `web`,
  `node_modules/*`, `entrypoint.sh` and `healthcheck.sh` can no longer be rewritten by an agent running
  as `node`.
- **`minImage`.** Each bundle declares the oldest image it runs on. CI computes `imageInputs`, a sha256
  over what only a new image can change (the runtime stage of the Dockerfile, the entrypoint and
  healthcheck, the launcher and guard, the keys, the Node ABI, and the `node-pty` and `@number0/iroh`
  versions); if it equals the previous release's, `minImage` is inherited. When the newest release
  needs a newer image the card says so and shows the host commands.
- **The image still wins.** A `docker pull` or `helm upgrade` to a newer image beats an older overlay
  by the version rule: only bundles newer than the image and the running version are booted.
- **Helm.** The overlay lives on the data volume and survives a pod restart. The 60 s trial fits inside
  the liveness tolerance (30 s × 3); keep the two so.

## Claude Code

The Claude Code CLI updates in-app too, into `/data/cli/<version>/`
(`POST /system/cli-version/install`, owner only, `DELETE` to go back).

- It installs the native platform package `@anthropic-ai/claude-code-linux-x64` from the npm registry
  (or `CLAUDIO_CLI_REGISTRY_URL`), checked against its `dist.integrity` (SHA-512). Only `package/claude`
  is extracted and no package script runs. The version must be inside the driver's range
  (`>=2.1 <3`) and newer than the image's pin, and `claude --version` must report it.
- **Precedence.** The image puts `/data/cli/current/bin` first on `PATH`, and `current` is a symlink
  swapped by rename: the next CLI process uses the new version and running chats keep theirs. At every
  start the launcher removes `current` when it is not newer than the image's pin (a newer image
  wins) and deletes versions nothing points at. A binary override in Settings → Claude Code still beats
  both.
- Errors: `integrity`, `out-of-range`, `not-newer`, `version-mismatch`, `fetch-failed`, `disk`; and
  `cli.no-version` (400) when no newer version is known. *Use the image's version* removes the link.

## Files and variables

| Path | What |
| --- | --- |
| `/app/launcher.mjs`, `/app/keys/*.pub`, `/app/image.json` | the trust anchor, root-owned |
| `/data/app/<version>/` | an unpacked bundle with its manifest and signature |
| `/data/app/state.json` | `{ active, previous, trial, attempts, bad, lastRollback, scheduled }` |
| `/data/cli/<version>/bin/claude`, `/data/cli/current` | an installed CLI and the link to the one in use |

`CLAUDIO_SERVER_UPDATE`, `CLAUDIO_BUNDLE_KEYS_DIR`, `CLAUDIO_LAUNCHER` and `CLAUDIO_APP_DIR` are in
[configuration.md](configuration.md#environment-variables). The routes are in
[rest-api.md](rest-api.md). The bundle is built by `apps/api/scripts/server-bundle.mjs` and released by
`.github/workflows/server-bundle.yml`.

## Limits

- Linux x64 containers only; the desktop app and a source checkout have their own ways.
- A release that changed the OS layer, Node or the native modules needs a new image.
- Without a public key in the image the card shows host commands (`no-keys`).
- Tests: `packages/core/test/launcher.test.ts`, `server-update.test.ts`, `cli-install.test.ts`,
  `apps/api/test/server-update.test.ts`, and `e2e/specs/updates.spec.mjs` for the card in a container.
  The full flow (download, restart, rollback) is checked by the integrator on a real container, not by a spec: it needs a launcher, a key and a signed bundle that the e2e runner does not have.

## Related

[[deploy.md]] · [[desktop.md]] · [[security-model.md]] · [[configuration.md]] · [[plans/container-polish.md]] · [[plans/app-updates.md]] · [[decisions/container-in-app-updates.md]]
