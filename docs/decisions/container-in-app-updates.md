---
created_at: 2026-10-18T20:00:00Z
updated_at: 2026-10-18T20:00:00Z
tags:
    - decision
    - docker
    - updates
    - security
    - launcher
---
# Decision: Claudio updates itself inside the container

Taken by the owner on 2026-10-18. Updating a container was a host command (`docker pull`, replace the
container); [plans/app-updates.md](../plans/app-updates.md) had rejected updating the image from the
UI. The feature itself is in [updates.md](../updates.md).

## Decision

A verified **overlay** in `/data/app/<version>/` replaces the image's `/app` when it is newer, and a
root-owned **launcher** (`/app/launcher.mjs`, the container's `CMD`) starts the server from it,
restarts only the node process (exit code 75), marks a bundle good after `/api/health` answers, rolls
back after failed boots and falls back to `/app`.

- **Signing: Ed25519 with a key held by CI**, the private half in the GitHub Environment `release`
  (restricted to `main`), the public keys in the image under `/app/keys`. Rejected: sigstore
  attestations, since verifying them inside the container needs a sigstore client with a TUF trust
  root fetched over the network and an identity policy on the workflow path: a heavy dependency and a
  moving trust root inside the thing being verified. Ed25519 is checked with `node:crypto` alone, in
  about 30 lines. The cost is a long-lived secret; the tarball also gets a provenance attestation for
  people. Rotation ships a new key in an image before it signs.
- **The image is the trust anchor.** The launcher, keys, `image.json` and `guard.mjs` come only from
  the image, root-owned, and `/app` becomes root-owned (it was `node`'s, so an agent in
  `bypassPermissions` could rewrite `api.mjs`).
- **`minImage`** says the oldest image a bundle runs on, computed by CI from a hash of what only a new
  image can change; a release that changed the OS layer needs a new image and the card says so.
  Rejected: hand-kept compatibility notes.
- **The owner only** may update (token or OIDC), never a chat or the desktop credential, never under
  `none` or read-only. Live work asks first, as the desktop does.
- **Claude Code updates in-app too**, from the registry's native platform package into `/data/cli`,
  checked against `dist.integrity`, with no package script run. `current` is a symlink on `PATH`
  ahead of the image's CLI; a newer image's pin wins.
- **No restart policy needed**: the loop is inside the container. A server that exits on its own makes
  the launcher exit with the same code, as before.
- **Helm.** The overlay lives on the data volume; the 60 s trial boot must stay inside the liveness
  tolerance (30 s × 3).
- Rejected: replacing `/app` in place (a broken write would leave a container that cannot boot);
  swapping through a second container (needs the Docker socket, which Claudio never gets); the CLI's
  own autoupdater (it writes into the image's `~/.local` and moves the pin behind the driver's back).

## Consequences

- The launcher is the one part an update cannot fix, so it is small, imports only `node:*`, and is
  tested against a fake server.
- Only the newest release is offered; a `bad` version is never retried.
- Without a key in the image, the card falls back to host commands (`no-keys`); the release job
  refuses to publish an unsigned bundle.

## Related

[[updates.md]] · [[deploy.md]] · [[security-model.md]] · [[plans/container-polish.md]] · [[plans/app-updates.md]]
