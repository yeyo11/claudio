---
created_at: 2026-10-19T09:00:00Z
updated_at: 2026-10-19T09:00:00Z
tags:
    - decision
    - desktop
    - docker
    - updates
    - security
    - launcher
---
# Decision: one update mechanism, a shell and a signed payload

Taken by the owner on 2026-10-18 as phase 2 of the container-polish pull request
([plans/unified-updates.md](../plans/unified-updates.md), D1 to D8). It extends
[container-in-app-updates.md](container-in-app-updates.md) to the desktop and supersedes
[plans/app-updates.md](../plans/app-updates.md)'s `pkexec` for the `.deb`. The feature is described in
[updates.md](../updates.md) and [desktop.md](../desktop.md#updating); the apt repository has its own
record, [apt-repository.md](apt-repository.md).

## Why

The owner ran 0.6.0 as a `.deb` in `/opt/Claudio`. Updating it meant `pkexec`: a system password
dialog while the window hung and the server was already stopped, to replace a 129 MB package for
what is almost always a change to server and web code. The container had just been given a better
mechanism (a signed bundle in `/data/app`, a launcher with a trial boot and a rollback). Two update
mechanisms with different trust models, one asking for root, was the wrong end state.

## Decision

**Split every release into a shell and a payload.**

- **The shell** is what only a package can change: Electron (or the image's OS layer and Node), the
  launcher state machine, `guard.mjs`, the public keys, the preload and its IPC contract, the native
  modules' versions. It is the trust anchor and it is read-only: the AppImage's mount, root-owned
  `/opt/Claudio`, or the image's `/app`.
- **The payload** is the signed server bundle of the container: `server.mjs`, `api.mjs`, `mcp.mjs`,
  the terminal and Collaborators hosts, `web/`, and the two N-API modules. **One tarball serves both
  hosts.** On the desktop it installs to `~/.config/Claudio/data/app/<version>/`.
- **One state machine, two drivers.** The launcher's logic moves into a pure module,
  `packages/core/src/launcher/machine.ts`; the container's `launcher.mjs` and the desktop's
  `apps/desktop/src/payload.ts` both drive it. The desktop's trial also waits for the web to send
  `claudio:page-ready`, so a payload whose page never renders is rolled back.
- **`minShell`**, the counterpart of `minImage`, says the oldest shell a payload runs on. CI computes
  `shellInputs` and inherits `minShell` while it is unchanged. A payload that needs a newer shell is
  never downloaded or booted, and the card says so. The desktop checks `minShell`, not `nodeAbi`.
- **No escalation from inside the app, ever.** `pkexec`, `DebUpdater.install()` and the
  `no-elevation` reason are removed.
  - AppImage: replaced in place by electron-updater, after the shell checked it against the signed
    desktop manifest.
  - `.deb` with the apt source: apt updates it (`apt-managed`); the app notices the replaced
    `<resources>/shell.json` and offers **Restart Claudio** (`shell-replaced`).
  - `.deb` without the source: the app downloads and verifies it and shows a command that copies it to
    a root-owned path, checks its sha256 and only then hands apt that copy. It is needed once.
- **A signed apt repository** carries the `.deb` ([apt-repository.md](apt-repository.md)).
- **`install.sh` picks the AppImage where it can sandbox without root**, and otherwise the `.deb`
  through the repository. An existing `.deb` install can switch to the AppImage in-app, where that
  holds.
- **Verification beyond sha512.** Ed25519 over the payload manifest and a new desktop manifest, with
  key ids so a rotation can overlap (a `.sig` may hold several `<keyId> <base64>` lines); GPG on the
  repository with a `Valid-Until`; GitHub provenance attestations on every artifact.
- **Who may update a payload on the desktop (D8).** The window holds no token, so it asks the shell
  over IPC and the shell calls the routes with its per-launch desktop credential. The server accepts
  that credential for the four update writes only, and only under `CLAUDIO_LAUNCHER=desktop`.
  Chat tokens, read-only and the anonymous local actor stay refused.
- **Live work.** Open terminals count as live work. A payload restart keeps the window, the tray and
  Electron; chats and orchestrations resume; terminals end.

## The owner's decisions on 2026-10-18

1. **The AppImage is the default only where Chromium's sandbox runs without root.** Ubuntu 24.04 and
   later restrict unprivileged user namespaces (this machine too), and an AppImage in a user folder
   cannot start the sandbox there. `install.sh` takes the `.deb` there. Never `--no-sandbox`.
2. **A required reviewer on the `release` environment.** The owner approves every job that signs, so
   no bundle or apt signature exists without their click.
3. **Pages serves the signed indexes only, if a redirect works.** It does not: apt follows an HTTP 302
   but not a meta-refresh page, and Pages sends no 3xx. The fallback applies and the pool holds the
   newest four `.deb` files ([apt-repository.md](apt-repository.md)).

## Rejected

- **Running `launcher.mjs` as a middle process under Electron.** The main process already owns the
  child's lifecycle, the `READY` line, the splash, the error pages and crash handling; a middle
  process would hide crashes from it and double the signal handling.
- **Payloads under `~/.cache/Claudio`** (a cache may be wiped and would silently downgrade; outside the
  guard's protection) **or `~/.local/share/claudio`** (the AppImage's install dir, removed by
  `--uninstall`; outside the guard). The data dir is inside `integrity.own-state` already and
  survives an AppImage swap, an apt upgrade and a switch between the two.
- **One hash for both hosts.** A Dockerfile change would force a desktop shell update and an Electron
  bump a new image, for nothing.
- **A polkit rule** (a standing root grant to a user-writable app's request), **a root helper** (a
  setuid surface to maintain) and **`DebUpdater` as it was** (the password, and a synchronous `dpkg -i`
  under the running app).
- **`apt install -- '<cache file>'`**, as Orca does: the cache file is user-writable and an agent
  running as the person could swap it between the check and the `sudo`.
- **A marker written by the postinst** to tell the app apt replaced it: root writing into homes, or a
  second file to keep in step with the one dpkg already replaces.
- **Orca's detached terminal daemon.** Not needed here, since a payload restart does not touch the
  AppImage mount; shells that outlive the server need an authenticated reattach channel and a host
  protocol stable across versions: a plan of its own, `[[plans/terminal-persistence]]`.
- **`--no-sandbox`**, or an AppArmor profile that matches the FUSE mount glob, which any user could
  satisfy with their own binary.

## Consequences

- Nearly every release installs with no password and no window restart, on both packages. Only a
  shell update on the `.deb` goes through apt.
- **Terminals are lost on every restart**, as before; the busy dialog now counts them.
- Same-user tampering with an installed payload after the boot check is accepted: under guards
  `integrity.own-state` refuses the write, and without them a same-user process can already edit
  `~/.claude/settings.json` or `~/.bashrc`. The signature and every file's hash are checked at every
  boot.
- Any change to the guard, the launcher, the keys, the preload or `payload.ts` needs a new shell
  (`shellInputs` is conservative on purpose).
- A web that never calls `pageReady()` rolls back every payload; the web calls it once after its first
  render.
- The page in the desktop window under auth `none` reads `GET /system/server-update` without a
  credential. Whether the web ignores `needs-auth` when the bridge has `payload`, or the server also
  accepts the shell's credential for that read, was left open by the build; see the plan's
  [Outcome](../plans/unified-updates.md#outcome).

## Related

[[plans/unified-updates.md]] · [[plans/container-polish.md]] · [[plans/app-updates.md]] ·
[[decisions/container-in-app-updates.md]] · [[decisions/apt-repository.md]] · [[updates.md]] ·
[[desktop.md]] · [[security-model.md]] · [[guards.md]] · [[known-limitations.md]]
