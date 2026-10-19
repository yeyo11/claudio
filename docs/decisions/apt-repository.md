---
created_at: 2026-10-18T23:30:00Z
updated_at: 2026-10-19T12:00:00Z
tags:
    - decision
    - desktop
    - apt
    - releases
    - security
    - updates
---
# Decision: a signed apt repository for the desktop app's `.deb`

Taken by the owner on 2026-10-18 as part of [plans/unified-updates.md](../plans/unified-updates.md)
(D3, D4, D5 and decision 3). It reverses [plans/app-updates.md](../plans/app-updates.md), which had
accepted a password for every `.deb` update and rejected an apt repository.

## Decision

The `.deb` is updated by the system, never by the app. Claudio publishes a signed apt repository on
GitHub Pages, `https://yeyo11.github.io/claudio/apt/`, and the package registers it when it is
installed. The app never runs `pkexec`.

- **The key**: an OpenPGP Ed25519 signing key, `Claudio apt repository <yeyochico@gmail.com>`,
  fingerprint **`33DC4ECFD40612112D06475843E6487D3DF5098F`**, expiring in 2029. Its public half is
  `packaging/apt/claudio-archive-keyring.gpg` (binary) and `.asc`. The private half is the secret
  `CLAUDIO_APT_SIGNING_KEY` of the GitHub Environment `release` (branch `main` only, the owner
  approves every job). The revocation certificate is kept offline by the owner. `scripts/install.sh`
  pins the fingerprint.
- **The package registers the repository once**, as Chrome and VS Code do:
  - it ships the keyring as its own file, `/usr/share/keyrings/claudio-archive-keyring.gpg`, so a
    key rotation arrives in a package update and dpkg removes the key with the package;
  - its postinst (`configure`) writes `/etc/apt/sources.list.d/claudio.sources` (deb822, `Signed-By:`
    that keyring, so the key is trusted for this repository only) and records `repo_add_once=false`
    in `/etc/default/claudio`. A person who deletes the source does not get it back on the next
    upgrade. `CLAUDIO_APT_REPO=off` there, or in the install's environment, skips it;
  - its postrm deletes the source on `remove` (a source naming a missing keyring breaks
    `apt update`) and `/etc/default/claudio` on `purge`, and does nothing on `upgrade`;
  - both scripts are `apps/desktop/build/linux/after-{install,remove}.sh`: electron-builder's own
    templates (the `/usr/bin` alternative, `chrome-sandbox`'s mode, the AppArmor profile), unchanged,
    followed by the apt part. They are templates: a `${name}` in them must be one of
    electron-builder's macros.
- **The repository holds no state.** `packaging/apt/build-repo.sh` rebuilds it from release assets
  every time: suite `stable`, component `main`, `amd64`, `apt-ftparchive`, `InRelease`
  (clearsigned) and `Release.gpg` (detached), SHA256 and SHA512 only, `Valid-Until` 90 days ahead.
  Before uploading, CI checks both signatures with `gpgv` against the committed keyring, so a secret
  that is not the shipped key fails the release instead of breaking `apt update` for everyone.
- **When it is built** (`.github/workflows/apt-repo.yml`): in every release, from the draft's `.deb`
  and the newest three published ones, called by `desktop.yml` once the `.deb` exists; it is
  deployed by `release.yml`'s `pages` job only after `publish`, so apt never offers a version whose
  release is not public. `apt-resign.yml`, monthly and by hand, calls the same build from the
  newest four published releases and deploys it, re-signing it long before `Valid-Until`.
  `apt-repo.yml` itself only builds: a called workflow may not ask for more than its caller grants,
  and GitHub checks that before the run starts, skipped jobs included, so a deploy job inside it
  kept `release.yml` from starting at all (2026-10-19, the 0.7.0 merge).

## The pool: the `.deb` files live on Pages (decision 3's fallback)

The owner's decision 3 asked for Pages to hold only the signed indexes, with the pool pointing at the
release assets through a redirect, and for this task to record which redirect form works. Findings,
2026-10-18:

- **apt follows an HTTP redirect.** A test server answering `302` for
  `pool/main/c/claudio/claudio_0.6.0_amd64.deb` with a `Location` on another host: apt downloaded the
  asset, and the size and hash from `Packages` matched (`python:3.12-slim-trixie`, apt 3.0).
- **apt does not follow an HTML redirect.** The same path answering `200` with a
  `<meta http-equiv="refresh">` page, which is the only redirect a static host can serve (a
  `404.html`, or `jekyll-redirect-from`): apt stored the page and refused it, "File has unexpected
  size (112 != 118778272)".
- **GitHub Pages serves no HTTP redirects.** It has no server configuration (`_redirects`,
  `.htaccess`) and its redirect plugin writes meta-refresh pages.
- A `Filename:` in `Packages` is a path relative to the repository's URI, so it cannot name another
  host either.

So no redirect form works on Pages, and the fallback applies: the pool holds the four newest `.deb`
files themselves (about 120 MB each, about 480 MB together, under Pages' 1 GB site limit). The hash
in `Packages` is what apt verifies either way. Pages' soft bandwidth limit (100 GB a month, roughly
800 downloads of the `.deb`) is the cost; if it bites, the pool moves to a host that answers HTTP
redirects and the next postinst rewrites `URIs:`. **Unverified until the first deployment**: whether
a Pages artifact deployment takes a 120 MB file (the 100 MB limit is git's, which a deployment from
an artifact does not go through). The first release, or the first run of `apt-resign.yml` on `main`, answers
it.

## The AppImage's static runtime (D5's spike)

`electron-builder.yml` sets `toolsets.appimage: '1.0.3'` (beta, "Runtime 20251108"). Spike,
2026-10-18, on electron-builder 26.15.3: it **builds** (the runtime is a static-pie ELF, and the
blockmap is still embedded for differential updates); in `ubuntu:26.04` with fuse3 and no libfuse2 it
**mounts** through `fusermount3` and **starts** (the server came up and wrote its data under a
separate config dir). The update path, electron-updater's `AppImageUpdater` replacing the file, does
not depend on the runtime and is exercised by `desktop-smoke.yml`. So `install.sh` no longer checks
for libfuse2; it needs `/dev/fuse` and `fusermount3` (or `fusermount`).

## `install.sh`

- Default: the AppImage where Chromium's sandbox starts without root (`sandbox_rootless`: unprivileged
  user namespaces allowed) and FUSE is usable; else the `.deb` through the repository on a
  Debian-like host; an existing `.deb` install stays a `.deb`. `--appimage` and `--deb` force a
  format. Never `--no-sandbox`.
- `--deb` fetches the keyring from Pages and refuses it unless it holds exactly the pinned key, then
  writes the same source the postinst writes and runs `apt-get install -y claudio` (`-y`: the person
  ran the installer, and a piped script has no terminal for apt's question).
- The AppImage is checked before it is installed: against the Ed25519-signed desktop manifest with
  the pinned key (`openssl pkeyutl -verify -rawin`, OpenSSL 3), else, saying so, against
  `latest-linux.yml`'s sha512 (a release without a manifest, or an older OpenSSL). A manifest that
  is present and does not verify stops the install; it never falls back.

## Rejected

- `/etc/apt/trusted.gpg.d` (trusts the key for every repository) and a keyring in `/etc/apt/keyrings`
  written by the postinst (an admin's directory; the package could not remove it cleanly).
- A marker written by the postinst for the running app: the app compares `<resources>/shell.json`,
  which dpkg replaces, with its own version.
- A `gh-pages` branch (binaries in git history, the 100 MB file limit), a second repository, and a
  hosted service such as Cloudsmith (another account and another party in the trust path; the
  fallback if Pages' limits bite).
- Sourcing `/etc/default/claudio` from the postinst: it is parsed, since the script runs as root.

## Consequences

- One `sudo` command (or the old updater's last password) moves an install from before this decision
  onto the repository; from then on the system's updater handles the shell and the app handles the
  payload with no password.
- The apt key is the highest-impact secret: it signs a root install on every apt user. It is used
  only by `apt-repo.yml`'s `build` job, in the `release` environment, which the owner approves.
- A broken monthly run expires the repository after 90 days: `apt update` then warns for every user.
  The workflow fails loudly, and the window is long.
- `.github/workflows/desktop-smoke.yml` proves the round trip on every pull request that touches the
  packaging: install from the repository, upgrade through it, refuse another key and an expired
  `Release`, remove and purge, in `debian:trixie` and `ubuntu:26.04`.

## Related

[[plans/unified-updates.md]] · [[plans/app-updates.md]] · [[plans/container-polish.md]] ·
[[decisions/container-in-app-updates.md]] · [[desktop.md]] · [[updates.md]] · [[security-model.md]]
