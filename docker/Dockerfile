# syntax=docker/dockerfile:1

# The API is compiled here and only the result is shipped. esbuild turns each entrypoint into a
# self-contained ESM file (apps/api/scripts/bundle.mjs), so the image that runs it carries no
# source tree, no node_modules and no transpiler: the container used to start `tsx src/index.ts`
# and parse the whole of TypeScript on every boot.
# The Claude Code pin is read by two stages (image.json and the install), so it is declared once,
# before the first FROM, and each stage re-declares it without a default.
ARG CLAUDE_CODE_VERSION=2.1.302
FROM node:26-bookworm-slim AS build
# Node 25 stopped shipping corepack, so pnpm comes from npm, pinned to the root packageManager.
RUN npm install -g pnpm@10.17.1
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/accounts/package.json packages/accounts/
COPY apps/api/package.json apps/api/
COPY packages/ui/package.json packages/ui/
COPY packages/chat-ui/package.json packages/chat-ui/
COPY packages/mcp/package.json packages/mcp/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY packages packages
COPY apps apps
RUN pnpm --filter @claudio/web build \
 && pnpm --filter @claudio/api bundle

# What /app/image.json says about this image (version, imageInputs, node ABI, Claude Code pin): the
# launcher and the server read it to decide which signed bundles this image can run (minImage).
# imageInputs hashes the runtime stage below, the entrypoint, the healthcheck and docker/keys, so the
# script needs docker/ itself; it is copied after the build so an edit there keeps the build's cache.
COPY docker docker
ARG CLAUDE_CODE_VERSION
RUN node apps/api/scripts/server-bundle.mjs --image-json /image.json --claude-code "${CLAUDE_CODE_VERSION}"

# The release's server bundle (docs/plans/container-polish.md, D4): the tarball and its manifest, not
# yet signed. The key never enters a build: .github/workflows/server-bundle.yml signs the manifest
# outside, then verifies it against docker/keys. Built from `build`, so it is the very code the image
# ships. BUNDLE_PREVIOUS is the previous release's manifest (a URL or a file), which minImage inherits from.
# CLAUDIO_COMMIT is the commit being built (`--build-arg CLAUDIO_COMMIT=$(git rev-parse HEAD)`), recorded
# in the manifest: .dockerignore leaves .git out of the context, so the script cannot ask git for it.
FROM build AS server-bundle
ARG BUNDLE_PREVIOUS=
ARG CLAUDIO_COMMIT=
RUN mkdir /out \
 && node apps/api/scripts/server-bundle.mjs --out /out \
      ${BUNDLE_PREVIOUS:+--previous "$BUNDLE_PREVIOUS"} ${CLAUDIO_COMMIT:+--commit "$CLAUDIO_COMMIT"}

# Holds only /out, so `docker buildx build --target bundle-export --output type=local,dest=out` writes
# the bundle and nothing else.
FROM scratch AS bundle-export
COPY --from=server-bundle /out /

# The headless image (docs/plans/headless-image.md): one Claudio per project, an AI backend reached
# only through its token-guarded API, built with `--target headless` and published as
# `<version>-headless`. It runs the same api.mjs under CLAUDIO_PROFILE=headless, which registers only
# the API a project calls. It carries what that needs and nothing a person's Claudio adds: no web
# build, gh, glab, Tailscale, youtrack-app, pnpm, python3, node-pty and the terminal host, iroh and the
# collaborators host, nor docker/keys, so it never offers an in-app update (D6): the image is the
# version. It comes before `runtime` on purpose: a plain `docker build` builds the last stage, and the
# server bundle hashes the last stage as the image's inputs (apps/api/scripts/server-bundle.mjs).
FROM node:26-bookworm-slim AS headless

# git and ripgrep are what Claude Code reads a workspace with; procps gives the server `ps` for its
# children; curl is the installer's and the healthcheck's.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git procps ripgrep \
 && rm -rf /var/lib/apt/lists/*

# /workspace is the default working directory and /workspaces holds the ephemeral workspaces (D7);
# both live and die with the container, since a workspace is a copy and nothing in it is kept.
# /app is root's and read-only, as in `runtime`: the agents run as `node` and must not rewrite the
# server, its guard or its launcher.
RUN mkdir -p /app /workspace /workspaces /data /home/node/.claude \
 && chown -R node:node /workspace /workspaces /data /home/node
USER node
ENV HOME=/home/node \
    PATH=/home/node/.local/bin:$PATH

# Claude Code, pinned and its installer checksummed exactly as in `runtime` (see there for rotating
# the digest). There is no in-app CLI install in headless, so no /data/cli overlay on the PATH.
ARG CLAUDE_CODE_VERSION
ARG CLAUDE_CODE_INSTALLER_SHA256=3a68d3406cf674e17bed1733a4dcf37805e2e47d87417700007d7e1aa766a944
RUN curl -fsSL -o /tmp/claude-install.sh https://claude.ai/install.sh \
 && echo "${CLAUDE_CODE_INSTALLER_SHA256}  /tmp/claude-install.sh" | sha256sum -c - \
 && bash /tmp/claude-install.sh ${CLAUDE_CODE_VERSION} \
 && rm /tmp/claude-install.sh \
 && claude --version
ENV CLAUDIO_CLAUDE_CODE_PINNED=${CLAUDE_CODE_VERSION}

WORKDIR /app
# The server, the `/v1` client-tool stub (mcp.mjs), the guard, the launcher and what the image is,
# root-owned and read-only like in `runtime`
COPY --from=build --chown=root:root --chmod=0444 /app/apps/api/dist/api.mjs /app/api.mjs
COPY --from=build --chown=root:root --chmod=0444 /app/apps/api/dist/mcp.mjs /app/mcp.mjs
COPY --from=build --chown=root:root --chmod=0444 /app/apps/api/dist/guard.mjs /app/guard.mjs
COPY --from=build --chown=root:root --chmod=0444 /app/apps/api/dist/launcher.mjs /app/launcher.mjs
COPY --from=build --chown=root:root --chmod=0444 /image.json /app/image.json
# `claudio login` and `claudio status` (apps/api/src/cli): `docker compose exec claudio claudio login`
# signs the account in without a UI (D3). Executable, through its own `#!/usr/bin/env node`.
COPY --from=build --chown=root:root --chmod=0555 /app/apps/api/dist/cli.mjs /app/cli.mjs
USER root
RUN ln -s /app/cli.mjs /usr/local/bin/claudio
USER node

# As in `runtime`, plus the profile and what it implies: no tunnel (no tailscaled to run it), chats
# only in dontAsk (D14; the server refuses to start with another mode), no in-app server update (D6).
# No CLAUDIO_WEB_DIST: there is no UI to serve.
ENV NODE_ENV=production \
    CLAUDIO_PID_FILE=/tmp/claudio.pid \
    PORT=8797 \
    HOST=0.0.0.0 \
    CLAUDE_CONFIG_DIR=/home/node/.claude \
    CLAUDIO_WORKSPACE_DIR=/workspace \
    CLAUDIO_WORKSPACES_DIR=/workspaces \
    CLAUDIO_DATA_DIR=/data \
    CLAUDIO_PROFILE=headless \
    CLAUDIO_TUNNEL=off \
    CLAUDIO_DEFAULT_PERMISSION_MODE=dontAsk \
    CLAUDIO_SERVER_UPDATE=off \
    DISABLE_AUTOUPDATER=1 \
    CLAUDIO_GUARD_ENTRY=/app/guard.mjs \
    CLAUDIO_DISTRIBUTION=docker

EXPOSE 8797
# The sign-in and the server's state; the workspaces are not kept (D7)
VOLUME ["/home/node/.claude", "/data"]

# The same liveness probe as `runtime`: a signed-out Claudio is alive and must not be restarted (D11)
COPY --chown=root:root --chmod=755 docker/healthcheck.sh /app/healthcheck.sh
COPY --chown=root:root --chmod=755 docker/entrypoint.sh /app/entrypoint.sh
HEALTHCHECK --interval=30s --timeout=15s --start-period=20s --retries=3 \
  CMD ["/app/healthcheck.sh"]

# The same start as `runtime`; with CLAUDIO_TUNNEL=off the entrypoint starts nothing and execs the launcher
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "/app/launcher.mjs"]

# The image proper
FROM node:26-bookworm-slim AS runtime

# Tools Claude Code relies on when working inside projects (openssh-client is git's, over ssh).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client procps ripgrep jq python3 \
 && rm -rf /var/lib/apt/lists/*

# Nothing here needs pnpm any more: it is left for the projects Claude works on under /workspace,
# which is also why node and python3 stay.
RUN npm install -g pnpm@10.17.1

# The code hosts' own CLIs, which are the only way Claudio reaches GitHub and GitLab
# (docs/code-hosts.md), from the vendors' linux amd64 release tarballs (the image is built for amd64
# only, .github/workflows/image.yml). Pinned to the versions the recordings under
# packages/core/test/fixtures/recordings were made with, for the same reason as the agents below.
# Each tarball is checked twice: the pinned digest must be the vendor's published one for that file,
# and the file must hash to it, so neither a moved release nor a tampered download gets through.
# To bump one, set the version, then take the new digest from the vendor's checksums file:
#   curl -fsSL https://github.com/cli/cli/releases/download/v<v>/gh_<v>_checksums.txt | grep linux_amd64.tar.gz
#   curl -fsSL https://gitlab.com/gitlab-org/cli/-/releases/v<v>/downloads/checksums.txt | grep linux_amd64.tar.gz
# and re-record what the adapters read if the release notes touch it.
ARG GH_VERSION=2.102.0
ARG GH_SHA256=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386
ARG GLAB_VERSION=1.123.0
ARG GLAB_SHA256=9c9ac4c2b74ec8709dec4819a4041050f3680c6aaa18f0ed30434081f4fe9bef
RUN set -eu; cd /tmp \
 && gh_tar="gh_${GH_VERSION}_linux_amd64.tar.gz" \
 && curl -fsSL -o "$gh_tar" "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${gh_tar}" \
 && curl -fsSL -o gh-checksums.txt "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt" \
 && grep -qx "${GH_SHA256}  ${gh_tar}" gh-checksums.txt \
 && echo "${GH_SHA256}  ${gh_tar}" | sha256sum -c - \
 && tar -xzf "$gh_tar" -C /usr/local/bin --strip-components=2 "gh_${GH_VERSION}_linux_amd64/bin/gh" \
 && glab_tar="glab_${GLAB_VERSION}_linux_amd64.tar.gz" \
 && curl -fsSL -o "$glab_tar" "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/${glab_tar}" \
 && curl -fsSL -o glab-checksums.txt "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/checksums.txt" \
 && grep -qx "${GLAB_SHA256}  ${glab_tar}" glab-checksums.txt \
 && echo "${GLAB_SHA256}  ${glab_tar}" | sha256sum -c - \
 && tar -xzf "$glab_tar" -C /usr/local/bin --strip-components=1 bin/glab \
 && rm -f /tmp/gh* /tmp/glab* \
 && gh --version && glab --version

# Tailscale, for Settings > Remote access (docs/tunnel.md): the host's Tailscale is not visible from
# a container, so the image carries its own CLI and daemon, Tailscale's static linux amd64 build.
# The entrypoint starts tailscaled in userspace networking (no root, no NET_ADMIN, no /dev/net/tun),
# and the person signs it in from the app. Pinned to the version its sign-in was recorded with
# (packages/core/test/fixtures/logins/tailscale-up.*), and checked the same two ways as gh and glab:
# the pinned digest must be the one pkgs.tailscale.com publishes beside the file, and the file must
# hash to it. To bump it, set the version and take the digest from
#   curl -fsSL https://pkgs.tailscale.com/stable/tailscale_<v>_amd64.tgz.sha256
# /run/tailscale holds the daemon's socket where the CLI looks by default, so neither Claudio nor
# anyone else passes --socket; it belongs to the user tailscaled runs as (/var/run is /run here).
ARG TAILSCALE_VERSION=1.104.1
ARG TAILSCALE_SHA256=108d1d96ecf410d305571e173516f27038f870919a9b89c914a167c6d33a4528
RUN set -eu; cd /tmp \
 && ts_tar="tailscale_${TAILSCALE_VERSION}_amd64.tgz" \
 && curl -fsSL -o "$ts_tar" "https://pkgs.tailscale.com/stable/${ts_tar}" \
 && curl -fsSL -o ts-checksum.txt "https://pkgs.tailscale.com/stable/${ts_tar}.sha256" \
 && [ "$(tr -d '[:space:]' < ts-checksum.txt)" = "${TAILSCALE_SHA256}" ] \
 && echo "${TAILSCALE_SHA256}  ${ts_tar}" | sha256sum -c - \
 && tar -xzf "$ts_tar" -C /usr/local/bin --strip-components=1 "tailscale_${TAILSCALE_VERSION}_amd64/tailscale" "tailscale_${TAILSCALE_VERSION}_amd64/tailscaled" \
 && rm -f /tmp/tailscale_* /tmp/ts-checksum.txt \
 && tailscale version && tailscaled --version \
 && mkdir -p /run/tailscale && chown node:node /run/tailscale

# Volumes are owned by the non-root user (bypassPermissions refuses to run as root)
# /app is root's: the agents run as `node` in bypassPermissions, and they must not be able to rewrite the
# server, the launcher or the keys that decide which update to trust (D4). Nothing writes under /app at
# run time; the server's writable state is /data, and an update lands in /data/app, never here.
RUN mkdir -p /app /workspace /data /home/node/.claude \
 && chown -R node:node /workspace /data /home/node
# The terminal's login shell rebuilds PATH from /etc/profile and ~/.profile, which puts the image's own
# ~/.local/bin first and drops the ENV below: a CLI installed in-app would never be the terminal's
# `claude`. The last line of ~/.profile runs after both, so the overlay (when it holds a binary) leads.
# Claudio itself launches the CLI by absolute path (packages/core/src/claude-bin.ts)
RUN printf '%s\n' '# Claudio: a Claude Code installed in-app (Settings > General > Updates) wins over the image'"'"'s' \
      '[ -x /data/cli/current/bin/claude ] && PATH="/data/cli/current/bin:$PATH"' >> /home/node/.profile \
 && chown node:node /home/node/.profile
USER node
# /data/cli/current/bin is where an in-app Claude Code install lands (a symlink the server swaps); it
# comes first so a newer CLI wins over the image's pin, and the launcher removes it when the image's
# pin is the newer one (docs/plans/container-polish.md, D4)
ENV HOME=/home/node \
    PATH=/data/cli/current/bin:/home/node/.local/bin:$PATH

# Claude Code native build, pinned so that an image is the same tomorrow as today: the CLI moves
# faster than this project, and a rebuild must not change behaviour by accident. Bump it on purpose
# (the System page says when a newer one exists), or override it with
# --build-arg CLAUDE_CODE_VERSION=<version>. `latest` and `stable` still work and count as unpinned.
ARG CLAUDE_CODE_VERSION
# One URL always serves the newest installer, so the script is pinned by content instead of by
# version: a build that would otherwise pipe an unreviewed script into a shell stops at the
# checksum. To rotate, run `curl -fsSL https://claude.ai/install.sh | sha256sum`, read the diff
# against the script this digest covers, and land the new digest in a commit that says what moved.
# Override with --build-arg CLAUDE_CODE_INSTALLER_SHA256=<digest> to build ahead of that commit.
ARG CLAUDE_CODE_INSTALLER_SHA256=3a68d3406cf674e17bed1733a4dcf37805e2e47d87417700007d7e1aa766a944
RUN curl -fsSL -o /tmp/claude-install.sh https://claude.ai/install.sh \
 && echo "${CLAUDE_CODE_INSTALLER_SHA256}  /tmp/claude-install.sh" | sha256sum -c - \
 && bash /tmp/claude-install.sh ${CLAUDE_CODE_VERSION} \
 && rm /tmp/claude-install.sh \
 && claude --version
# Read by the update check, which compares it with the newest published version
ENV CLAUDIO_CLAUDE_CODE_PINNED=${CLAUDE_CODE_VERSION}

# JetBrains' `youtrack-app`, the only way Claudio reaches YouTrack (docs/trackers.md), is pinned like
# Claude Code, to the version its recordings were made with. It goes to an npm prefix of its own in
# the image, which is on the PATH; what a person installs later with `npm -g` goes to the same place
# and lives as long as the container. Override with --build-arg YOUTRACK_APP_VERSION=<version>.
ARG YOUTRACK_APP_VERSION=1.0.3
ENV NPM_CONFIG_PREFIX=/home/node/.npm-global
ENV PATH=/home/node/.npm-global/bin:$PATH
RUN npm install -g @jetbrains/youtrack-apps-tools@${YOUTRACK_APP_VERSION} \
 && npm cache clean --force \
 && youtrack-app --version

WORKDIR /app
# The whole of the wrapper: one JavaScript file, the assistant's MCP server beside it, and the built UI.
# Everything under /app is root-owned and read-only (files 0444, directories 0555; `a=rX` keeps the
# execute bit only where the source had it, which node-pty's spawn-helper needs), the guard and the
# launcher included, so the agents' user can rewrite none of it.
COPY --from=build --chown=root:root --chmod=0444 /app/apps/api/dist/api.mjs /app/api.mjs
COPY --from=build --chown=root:root --chmod=0444 /app/apps/api/dist/mcp.mjs /app/mcp.mjs
# The guard program: the agent's user cannot replace the hook that checks it
COPY --from=build --chown=root:root --chmod=0444 /app/apps/api/dist/guard.mjs /app/guard.mjs
# The launcher, the server's parent: it starts /app/api.mjs or a verified update from /data/app, and
# it is the one part an update cannot replace. It and the keys below come only from the image.
COPY --from=build --chown=root:root --chmod=0444 /app/apps/api/dist/launcher.mjs /app/launcher.mjs
# The public keys an update's signature is checked against. The whole folder is copied, README
# included, so a build without a key still works (a glob matching nothing fails the COPY): the image
# then offers no in-app update (docs/plans/container-polish.md, "Owner actions")
COPY --chown=root:root --chmod=a=rX docker/keys/ /app/keys/
# What this image is, for minImage and the Node ABI check
COPY --from=build --chown=root:root --chmod=0444 /image.json /app/image.json
# The person's terminals: the host process the server forks, and node-pty beside it, the one native
# module (a prebuilt binary: nothing is compiled in either stage). The folder is the only
# node_modules in the image, with @number0 below
COPY --from=build --chown=root:root --chmod=0444 /app/apps/api/dist/terminal-host.mjs /app/terminal-host.mjs
COPY --from=build --chown=root:root --chmod=a=rX /app/apps/api/dist/node_modules/node-pty /app/node_modules/node-pty
# Collaborators: the iroh host the server forks when the feature is on, and @number0/iroh with its
# Linux binding beside it (docs/plans/collaborators.md §3.2); without them the page says the host is unavailable
COPY --from=build --chown=root:root --chmod=0444 /app/apps/api/dist/collab-host.mjs /app/collab-host.mjs
COPY --from=build --chown=root:root --chmod=a=rX /app/apps/api/dist/node_modules/@number0 /app/node_modules/@number0
COPY --from=build --chown=root:root --chmod=a=rX /app/apps/web/dist /app/web

# Keeping .claude.json inside the config dir means one volume persists the whole account setup.
# CLAUDIO_DISTRIBUTION tells the UI this is a container, where updates, the terminal and the first-run
# owner token behave differently (docs/plans/container-polish.md).
# The tunnel is on by default because the entrypoint runs a tailscaled of Claudio's own; it reaches
# the server on 127.0.0.1, around the published port and the operator's proxy, which is why
# CLAUDIO_TUNNEL=off turns it, and that daemon, off (docs/deploy.md, "The tunnel in Docker").
ENV NODE_ENV=production \
    CLAUDIO_PID_FILE=/tmp/claudio.pid \
    PORT=8797 \
    HOST=0.0.0.0 \
    CLAUDE_CONFIG_DIR=/home/node/.claude \
    CLAUDIO_WORKSPACE_DIR=/workspace \
    CLAUDIO_DATA_DIR=/data \
    CLAUDIO_DEFAULT_PERMISSION_MODE=bypassPermissions \
    DISABLE_AUTOUPDATER=1 \
    CLAUDIO_WEB_DIST=/app/web \
    # The guard is the image's own, never an update's: the launcher keeps this value when it starts
    # an overlay, which carries its own mcp.mjs but neither the guard nor the launcher
    CLAUDIO_GUARD_ENTRY=/app/guard.mjs \
    CLAUDIO_DISTRIBUTION=docker \
    # gh and glab keep their sign-ins in their config folders, in plain text where there is no
    # keyring (no container has one): on the volume, and nowhere else
    GH_CONFIG_DIR=/data/provider-homes/gh \
    GLAB_CONFIG_DIR=/data/provider-homes/glab

EXPOSE 8797
VOLUME ["/home/node/.claude", "/workspace", "/data"]

# The script also ends the server after a few failed probes, which is what makes a restart policy
# act on an unhealthy container (see docs/deploy.md)
COPY --chown=root:root --chmod=755 docker/healthcheck.sh /app/healthcheck.sh
COPY --chown=root:root --chmod=755 docker/entrypoint.sh /app/entrypoint.sh
HEALTHCHECK --interval=30s --timeout=15s --start-period=20s --retries=3 \
  CMD ["/app/healthcheck.sh"]

# Exec form with no package manager in between: `docker stop` signals the launcher, which forwards it to
# the server and exits with the server's code, so the container's exit status is the server's (0) and
# not a package manager's report of a killed child (143). The launcher is the server's parent: it
# starts /app/api.mjs, or a verified update from /data/app, and restarts only the node process onto a
# new bundle, so a plain `docker run` with no restart policy updates the same way. The pid file the
# server writes is still how the healthcheck finds it, since `init: true` means neither is PID 1. The
# entrypoint starts tailscaled, then execs this command.
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "/app/launcher.mjs"]
