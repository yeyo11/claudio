---
created_at: 2026-10-18T18:00:00Z
updated_at: 2026-10-18T21:00:00Z
tags:
    - plan
    - docker
    - sign-in
    - accounts
    - terminal
    - updates
    - security
    - setup
    - design-system
---
# Plan: Claudio in a container, polished

Status: **built, awaiting verification** (2026-10-18; see [Outcome](#outcome)). The owner's decisions are settled; the work is one pull request on
`fix/container-polish`, built by the orchestration in [Tasks](#tasks). Workers run code tasks on
`claude-opus-5-5` and the prose task on `claude-sonnet-5-5`, never fable. One owner action is needed
before the merge: [the bundle signing key](#owner-actions-before-the-merge).

This plan is the source of truth for that orchestration, together with CLAUDE.md and
CONTRIBUTING.md. Where a task prompt and this plan disagree, the plan wins. Every worker starts in a
fresh worktree with none of the context of the session that wrote this, so each section below says
what to build, where, and against which contract. Workers never run the e2e suite: CI runs it
(`pnpm e2e:remote`, the `e2e-on-github` skill).

## Context

On 2026-10-18 the owner ran a fresh `ghcr.io/yeyo11/claudio:0.6.0` container on the LAN, with token
authentication, and found seven rough edges. Each fact below was re-read in the code at `3c91a1042`.

### 1. Sign-in is reported but never checked

- `claude auth status --json` answers `loggedIn: true` whenever `CLAUDE_CODE_OAUTH_TOKEN`,
  `ANTHROPIC_API_KEY` or a `.credentials.json` exists, valid or not. Claudio believes it:
  `tokenSource` and `getAuthStatus` in `packages/core/src/cli.ts:50-75`; the readiness probe in
  `packages/core/src/providers/detector.ts:506-533` (auth `ok` → `ready`), the handshake that never
  changes the status (`:545-550`) and `probeClaude` mapping `loggedIn` to `ok` (`:607-612`);
  `GET /api/health` (`apps/api/src/routes/system.ts:23`) through `claudeHealth`
  (`packages/core/src/index.ts:1597`).
- The only real check is `POST /auth/verify` (`index.ts:2067`): a real `haiku` prompt, used only by
  the Verify button of `apps/web/src/pages/config/SignInSection.tsx:56`. An account is marked
  `signInState: 'expired'` (with `authFailedAt`) only after a run on it fails with a 401
  (`packages/accounts/src/store.ts:195-229`).
- `docs/providers.md:98` states the rule this plan keeps: **a probe spends nothing**. An automatic
  `POST /auth/verify` would break it.
- The CLI already has a free check: the `get_usage` control request of the stream-json protocol,
  no prompt and no turn (`docs/cli-surfaces.md:37`, `packages/accounts/src/cli-usage.ts:107`). Nobody
  has recorded what it answers for a bad token.

### 2. The paste-code login works in the image, but the assistant and Settings do not offer it

- `claude auth login`, relayed through pipes (`packages/accounts/src/login.ts:21-49`), works in the
  image with CLI 2.1.278: the owner signed in through Accounts → Add account → open the link → paste
  the code, and a chat ran. The API side is `apps/api/src/account-logins.ts` (`start`, `restart`,
  `submitCode`, `cancel`, a 15-minute expiry that ends as `cancelled`), the routes are
  `apps/api/src/routes/accounts.ts:109-130`, and the web panel is `SignInSession` in
  `apps/web/src/pages/accounts/AddAccountDialog.tsx:26-87`.
- `AccountLogins.restart(id)` already signs in **any** login account in its own dir, `default`
  included: `AccountStore.ref('default')` is the CLI's own `CLAUDE_CONFIG_DIR`
  (`packages/accounts/src/store.ts:186-187`, `env.ts:43`).
- The setup assistant's Claude step and Settings → Claude Code → "Iniciar sesión en Claude Code" offer
  only "Token de OAuth" (`claude setup-token`) and "Clave de API", with the copy "Claude Code has no
  sign-in Claudio can do for you": `packages/core/src/setup/methods.ts:37-43`,
  `apps/web/src/components/setup/SignInPanel.tsx:463-514`,
  `apps/web/src/i18n/locales/{en,es}/setup.json` (`panel.claude`). The Add account dialog offers a
  `token` kind too (`AddAccountDialog.tsx:14-15`).
- Stale claims of the same thing: `docs/plans/in-app-setup.md:266-269`, `docs/providers.md:99-100`,
  `docs/setup.md:86` and its Claude section, `.env.example:1-6`, `README.md:88-93`,
  `docs/deploy.md:22-29` (and the token in its compose and Helm sections), `deploy/helm/claudio/values.yaml:43-44`,
  the start-up warning `apps/api/src/server.ts:75`, `docs/design-system.md:1781,1821,1867`, and the
  reference screen `docs/design-system/reference/DesktopConfiguracionAgentesClave.html`.

### 3. The "default" account contradicts the rest of the page

The implicit `default` account (the main `CLAUDE_CONFIG_DIR`: `~/.claude` on a desktop,
`/home/node/.claude` in the image) shows on Accounts as "default · predeterminada · sin sesión" with
"El CLI no da el uso de un token…"; Settings → Claude Code says "Cuenta en uso: Sin sesión · Sin
cuenta" (it reads `GET /auth`, the default dir only), and the status bar says "Sin sesión iniciada"
(`apps/web/src/components/shell/StatusBar.tsx:52`, `auth.loggedIn`). On the same page the Provider
block says "Listo, yeyochico@gmail.com", and chats run on the login account the owner added.
Readiness already falls back to another signed-in account (`detector.ts:529-531` through
`readyAccountLabel`, `index.ts:3290`); those three surfaces do not.

### 4. The terminal cannot be used in a container

- Every request reaches the container from the Docker bridge's gateway, never from loopback, so
  `fromLocalMachineStrict` (`apps/api/src/security.ts:184`) is always false.
- With auth `none` (the image's default, `HOST=0.0.0.0` at `docker/Dockerfile:152`) every terminal
  route, turning it on included, is refused `needs-auth` (`apps/api/src/terminal-gate.ts:68-69`,
  `apps/api/src/routes/terminals.ts:58-59`).
- With a token and the default `remote: 'tunnel'` (`packages/core/src/terminals/settings.ts:14`),
  it is refused `needs-tunnel` (`terminal-gate.ts:73-80`).
- The UI showed "La petición ha fallado" with the server's raw English sentence ("the terminal opens
  from another device only through the tunnel: …") on Settings → Access & safety → Terminal: the
  toggle's error goes to `toast.error(t('settings.saveFailed'), error)`
  (`apps/web/src/pages/config/security/TerminalCard.tsx:34-46`). With the feature off the status
  bar's item is hidden (`StatusBar.tsx:289-296`).
- `node-pty` loads in the image. Behind Caddy, `X-Forwarded-For` makes a request untrusted
  (`security.ts:158-159`). `docs/deploy.md:244-250` says that with a token the terminal works, which
  in a container it never does.

### 5. Updating a container is a host command

- The Updates card (`apps/web/src/pages/config/UpdatesCard.tsx`, `apps/web/src/lib/updates.ts:110-124`)
  gives a container person host commands only; `docs/plans/app-updates.md:81-86` rejected updating
  the image from the UI. Releases attach no server bundle (`.github/workflows/release.yml`,
  `desktop.yml:62-80` attaches the desktop packages only; `image.yml:66-77` pushes the image and its
  attestation).
- The CLI is pinned (`Dockerfile:101`) and its autoupdater is off (`DISABLE_AUTOUPDATER=1`,
  `Dockerfile:157`).
- State lives in three volumes: `/data`, `/home/node/.claude`, `/workspace` (`Dockerfile:166`). The
  image layers hold `/app/*.mjs`, `/app/web`, the native `node-pty` and `@number0` under
  `/app/node_modules`, and the CLI under `/home/node/.local`.
- **`/app` is owned by `node`**, the agents' user (`Dockerfile:129-142`, `COPY --chown=node:node`),
  except the guard, which is root-owned and read-only (`Dockerfile:131-132`). An agent running in
  `bypassPermissions` can rewrite `/app/api.mjs` today.
- The server resolves the guard and the MCP server as its siblings (`apps/api/src/server.ts:101-107`,
  `packages/core/src/guards/launch.ts:55-58`), unless `CLAUDIO_GUARD_ENTRY` is already set.
- Helm sets no `readOnlyRootFilesystem` (`deploy/helm/claudio/values.yaml:126-131`), probes
  `/api/health` with liveness 30 s × 3 (`values.yaml:104-114`), and always writes
  `CLAUDIO_AUTH_MODE` (`deploy/helm/claudio/templates/deployment.yaml:57-58`, default `none`).
- A chat's token is held off routes by a denylist: `CHAT_FORBIDDEN*` sets in
  `apps/api/src/security.ts:202-330`. Every new route below must be weighed against it.

### 6. An unlisted host gets JSON

With token auth and no `CLAUDIO_ALLOWED_HOSTS`, the LAN address is not an allowed host. The page
shell and its assets load (`apps/api/src/app.ts:262-273` serves them for any host), but every call
under `/api/`, `/docs` and `/openapi.json` answers `421` with
`{ error: 'this wrapper does not answer to that host…' }` (`security.ts:732-737`), and the app shows
nothing a person can act on. Documented in `docs/deploy.md:154-190` and `docs/configuration.md:47`.

### 7. The setup assistant does not use the screen

At 1600 × 950 (desktop browser, step 2 "Agentes") the assistant is a 760 px column pinned to the top
(`.prov-first { width: min(760px, 100%) }`, `apps/web/src/styles/providers.css:166-172`), leaving
the side thirds and the bottom fifth empty. Inside it the Claude Code row is cramped: the compact row
is `36px minmax(0, 250px) minmax(0, 1fr) auto` (`providers.css:19-21`), so the binary path is cut
("/home/node/.local/bi…"), the status chip and its sentence are squeezed into the middle column,
and the sign-in form under it runs at the full card width. The reference itself draws it so
(`docs/design-system/reference/screenshots/DesktopConfiguracionAgentesClave-dark.webp`;
`docs/design-system.md:1786-1790` fixes "760 px").

### Pinned versions (checked 2026-10-18)

| Pin (`docker/Dockerfile`) | Now | Newest | Target | sha256 of the linux amd64 artefact |
| --- | --- | --- | --- | --- |
| `CLAUDE_CODE_VERSION` (`:101`) | 2.1.278 | 2.1.302 (`latest`; `stable` is 2.1.292) | **2.1.302** | the installer pins itself; `CLAUDE_CODE_INSTALLER_SHA256` (`:107`) is unchanged, `3a68d340…a944` still matches `https://claude.ai/install.sh` |
| `GH_VERSION` (`:47`) | 2.102.0 | 2.102.0 | **no change** | – |
| `GLAB_VERSION` (`:49`) | 1.120.0 | 1.123.0 | **1.123.0** | `9c9ac4c2b74ec8709dec4819a4041050f3680c6aaa18f0ed30434081f4fe9bef` (`glab_1.123.0_linux_amd64.tar.gz`, from `https://gitlab.com/gitlab-org/cli/-/releases/v1.123.0/downloads/checksums.txt`) |
| `TAILSCALE_VERSION` (`:77`) | 1.102.4 | 1.104.1 | **1.104.1** | `108d1d96ecf410d305571e173516f27038f870919a9b89c914a167c6d33a4528` (`https://pkgs.tailscale.com/stable/tailscale_1.104.1_amd64.tgz.sha256`) |

How they were read, so the worker can repeat it on the day: `npm view @anthropic-ai/claude-code
dist-tags`; `gh api repos/cli/cli/releases/latest --jq .tag_name`;
`curl -fsSL https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases/permalink/latest`;
`curl -fsSL 'https://pkgs.tailscale.com/stable/?mode=json'` (`TarballsVersion`). If a newer version
appeared, take it and its digest the same way, and say so in the commit body.

## Decisions

The owner settled six on 2026-10-18 and the seventh came with the design request. Each says what
was rejected.

### D1. The paste-code `claude auth login` is the way to sign in; the OAuth token leaves the UI

- **Everywhere one signs in to Claude Code** (the assistant's Claude step, Settings → Claude Code,
  Accounts → Add account, Sign in again), the first and default method is **Claude account**: the
  CLI's own `claude auth login`, relayed as Accounts already does (open a link, approve, paste the
  code if the page shows one). The alternative is **API key**. The OAuth token
  (`claude setup-token`, `CLAUDE_CODE_OAUTH_TOKEN`) is no longer offered anywhere in the UI, and the
  docs stop recommending it.
- **Where the assistant and Settings sign in.** Into the `default` account: the CLI's own
  `CLAUDE_CONFIG_DIR` (`/home/node/.claude` in the image, a volume), through
  `POST /accounts/default/login`. That makes the CLI itself signed in, so the `claude` a person runs
  in the terminal works too, and it is the account Settings calls "in use" when no other is chosen.
  Accounts → Add account keeps creating a separate login account in its own dir, for rotation.
  Rejected: a new login account from the assistant (the CLI in the terminal would stay signed out,
  and "default" would stay an empty ghost).
- **A token already in the environment.** `CLAUDE_CODE_OAUTH_TOKEN` set on the container (compose,
  `docker run -e`, Helm's `claude.existingSecret`) **keeps working**: the CLI reads its own
  environment, and stripping it would break headless deployments that cannot sign in through a
  browser. It is documented once, in `docs/configuration.md`, as a headless option, not as the way to
  start. Settings → Claude Code names it as the source ("From the environment ·
  CLAUDE_CODE_OAUTH_TOKEN"), it is validated like any credential (D1, validation), and the sign-in
  panel warns that it takes precedence over an account signed in here.
- **A token Claudio already keeps** (`wrapper-oauth-token`, saved by the old panel in the vault)
  keeps working until it fails or is replaced; Remove stays. A successful Claude-account sign-in on
  `default` clears it, because the CLI would otherwise keep using the token
  (`CLAUDE_CODE_OAUTH_TOKEN` beats the credentials file). Token accounts (`kind: 'token'`) already
  added stay listed and keep working.
- **The API keeps its shapes.** `PUT /auth/credentials { oauthToken }` and
  `POST /accounts/token { kind: 'token' }` still answer, documented as deprecated in
  `docs/rest-api.md`, so a script that used them does not break in a patch release. Rejected:
  refusing them now.
- **Validation: never "signed in" on `auth status` alone.**
  - The check is the CLI's own `get_usage` control request (no prompt, no turn, no tokens), run on the
    account in the account's environment: `usageOf(ref)` (`packages/accounts/src/cli-usage.ts:107`).
  - It runs right after a credential changes (a sign-in that succeeded, a key saved, the first
    detection after start for a credential from the environment), on **Check** in Settings, and
    otherwise at most once every 30 minutes per account during the provider refresh. The time is
    recorded on the account (`checkedAt`).
  - A check that says the credential was **refused** marks the account as a failed run does today
    (`authFailedAt`, `signInState: 'expired'`). Readiness, `/health`, the status bar and rotation then
    treat it as signed out, and every surface offers **Sign in again**.
  - A check that **could not run** (network, timeout, CLI failure) changes nothing: the last answer
    stays.
  - **Spike first** (task `signin-core`, step 1): nobody has recorded what `get_usage` answers for a
    bad credential. The worker runs the real CLI 2.1.302 with an empty `CLAUDE_CONFIG_DIR` (a
    `mktemp -d`) and `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-invalid`, then again with
    `ANTHROPIC_API_KEY=sk-ant-api03-invalid`, and once with a revoked or expired `.credentials.json` if
    one is at hand. It uses the existing `controlRequest(ref, 'get_usage')` from a small
    `tsx` script and saves each raw answer (or error line) under
    `packages/accounts/test/fixtures/get-usage-*.json`. This spends nothing: there is no turn.
    - **If** the answers tell "refused" apart from "could not reach" (an `authentication_error`, a
      401, `invalid x-api-key`…), the classifier is built on them as above.
    - **If not** (it answers the same for a bad and a good token, or cannot run for API keys), the
      automatic check is dropped for that kind. Then the state is learned from the first failing run,
      as today, and **Check** in Settings becomes "Send a test message", which runs the existing paid
      `POST /auth/verify` only on that click, with the copy saying it sends one short message.
      Rejected: running `/auth/verify` on a timer. It costs a turn, and probes spend nothing.

### D2. The `default` account shows only when it exists

- `GET /accounts` and the overview's account count leave out `default` **while it has no credential
  at all**: no `.credentials.json` in its dir, and no token or key for it in the environment or the
  vault. A desktop whose `~/.claude` is signed in keeps showing it. An expired default (it had a
  credential that failed) stays visible with **Sign in again**: that is a real account with a
  problem. `GET /accounts/default`, `PATCH` and the login route keep working on it. `pick()` and
  rotation are unchanged; they already skip an account that is not signed in.
- **The account in use** is the one new work would start on: `accounts.pick({ current: null })`,
  the value `accountsSnapshot` already reads (`index.ts:3279-3284`). `GET /auth` gains it as `inUse`.
  Settings → Claude Code's "Account in use" row, the status bar and the phone's More sheet read
  `inUse` and the provider's readiness, not the default dir's `loggedIn`. Rejected: hiding `default`
  inside `AccountStore.list()`, which every rotation path reads.

### D3. In a container the terminal needs the owner's token, and the image makes one

- **The image makes an owner token on first start** when nothing configures authentication. The
  condition: `CLAUDIO_DISTRIBUTION=docker`, and none of `CLAUDIO_AUTH_MODE`, `CLAUDIO_AUTH_TOKEN`,
  `CLAUDIO_OIDC_ISSUER` is set. The token is generated like `POST /security/token` does
  (`packages/core/src/security/auth.ts:208`, 32 random bytes, base64url) and stored as its hash in
  `auth.json` with `tokenId: 'first-run'` and mode `token`.
  - It is printed **once** to the container's standard output, in a framed block that names it the
    owner token (Jupyter-style).
  - It is also kept in `/data/first-run-token` (mode 0600, the server's user) **until it is first
    used**: the first request it authenticates deletes the file. Rotating the token deletes it too.
    The file exists because `docker logs` is easy to lose (`--rm`, a log driver); anyone who can read
    `/data` already owns the install.
- **The first-run screen.** While that token was never used, the `401` carries
  `firstRunToken: true`, and the sign-in screen says where to find it (see
  [Design](#the-first-run-token-screen)).
- **Existing containers.** A container upgraded from 0.6.x whose `auth.json` says `mode: 'none'` is
  migrated **once**, on the first start of the new image, under the same condition (docker, no auth
  variable): it gets a first-run token exactly like a new install, recorded with `generatedAt` so it
  never happens again. Two exceptions:
  - A person who chooses **None** later in Settings is not overridden: `PUT /security/auth` with
    `mode: 'none'` records `noneChosenAt`, and no later start generates again.
  - `CLAUDIO_AUTH_MODE=none` in the environment is always respected; the server then logs one line
    saying that the terminal and in-app updates need a token.

  Rejected: leaving existing containers open. Under `none` the terminal and in-app updates cannot
  work, and every LAN device already drives chats in `bypassPermissions` with no credential. The
  release notes and the first-run screen carry the change.
- **Helm.** The chart's `auth.mode` gains `auto`, the new default, which writes no `CLAUDIO_AUTH_MODE`
  so the image generates the token (shown by `kubectl logs`; `NOTES.txt` says so). `none`, `token`
  and `oidc` keep their meaning.
- **The terminal over the published port.** When `CLAUDIO_DISTRIBUTION=docker`, the default of
  `remote` is `'any'` instead of `'tunnel'`: `TERMINAL_DEFAULTS` becomes a function of the
  distribution, and a value the person saved in `terminal.json` still wins (the store keeps only
  what was set, `settings.ts:101-125`). The gate itself does not change: under `'any'` a request from
  another device passes when the mode is `token` or `oidc` and the actor is the owner. Why this is
  safe:
  1. In a container no request is ever "this machine", so `'tunnel'` made the terminal unusable
     rather than safer.
  2. The owner token already grants a shell in effect: it starts chats in `bypassPermissions` (the
     image's `CLAUDIO_DEFAULT_PERMISSION_MODE`), which run any command as `node`. The terminal adds
     no capability to a holder of that token.
  3. Everything else holds: a chat's token and the desktop credential are refused
     (`terminal-gate.ts:58-61`), the Origin check and the one-time socket tickets are unchanged,
     read-only closes it, `mode: 'none'` still answers `needs-auth`, and the card keeps its
     `limits.any` warning.

  Rejected: a new remote value such as `published-port`, or trusting the bridge gateway as local.
  The first is a new knob for one case; the second would let any container on the same bridge in.
- **Every refusal is shown translated, with its fix.** The terminal routes already answer
  `code: 'terminal.<reason>'` (`routes/terminals.ts:9-10`), and `ApiRequestError.code` carries it
  (`apps/web/src/api.ts:326-346`). The card maps each reason to a sentence and an action, never the
  server's text; the toggle shows its refusal inline and goes back to its state.

### D4. Claudio updates itself inside the container

**Target architecture.** The image's `/app` is the base. A verified **overlay** in `/data/app/<version>/`
replaces it when it is newer. An in-container **launcher** (`/app/launcher.mjs`, root-owned and
read-only like the guard) starts the server from the overlay or from `/app`, restarts only the node
process onto a new bundle, marks the bundle good after `/api/health` answers, rolls back on its own
after failed boots, and falls back to `/app`. The name is *launcher* because `supervisor` already
names the chat supervisor (`apps/api/src/routes/supervisor.ts`).

- **Signing: Ed25519 with a key held by CI.** Rejected: sigstore attestations.
  - Ed25519 is verified with `node:crypto` alone, offline, in about 30 lines, by a root-owned file.
  - Verifying sigstore inside the container needs a sigstore client with a TUF trust root it must
    fetch and refresh over the network, and an identity policy on the workflow path: a heavy
    dependency and a moving trust root inside the thing being verified.
  - The cost of Ed25519 is a long-lived secret. It is held as `CLAUDIO_BUNDLE_SIGNING_KEY` in a
    GitHub Environment `release`, restricted to `main`.
  - The image carries every accepted public key in `/app/keys/*.pub`, so a rotation ships the new key
    in an image before it signs anything.
  - The tarball also gets a GitHub build-provenance attestation, for people, which nothing in the
    container reads.
- **The image is the trust anchor.** The launcher, `/app/keys`, `/app/image.json` and `guard.mjs`
  come only from the image, root-owned, never from an overlay. The guard stays the image's
  (`CLAUDIO_GUARD_ENTRY=/app/guard.mjs`, set in the Dockerfile and by the launcher). An overlay never
  carries a guard, and none is copied to `/data`.
- **Each bundle declares the oldest image it runs on (`minImage`).** CI computes `imageInputs`, a
  sha256 over what only a new image can change:
  - the runtime stage of `docker/Dockerfile`, `docker/entrypoint.sh` and `docker/healthcheck.sh`;
  - the bundled `launcher.mjs` and `guard.mjs`, and `docker/keys/`;
  - the Node major version and ABI;
  - the versions of `node-pty` and `@number0/iroh`.

  If it equals the previous release's, `minImage` is inherited; otherwise it is this version. A
  release that changed the OS layer therefore needs a new image, and the card says so. Rejected:
  hand-maintained compatibility notes.
- **Who may update.** The owner only: a `token:*` or OIDC actor. Refused to a chat's token
  (denylist), to the desktop credential, under `mode: 'none'` (`update.needs-auth`) and under
  read-only (the existing `405`). Every request writes the existing audit row. A rollback that the
  launcher performed is written as an audit row on the next start.
- **Live work.** Restarting asks first, like the desktop: if chats are working or waiting, or
  orchestrations are running, `apply` answers `409` with the counts, and the person chooses
  **Restart now** or **Restart when nothing is running**. The rule is the desktop's `installDecision`
  (`apps/desktop/src/updater.ts:350-358`), counted as `liveSnapshot` counts
  (`apps/desktop/src/live.ts:66`).
- **The Claude Code CLI updates in-app too,** into `/data/cli/<version>/`:
  - It installs the native platform package `@anthropic-ai/claude-code-linux-x64` from the npm
    registry (or `CLAUDIO_CLI_REGISTRY_URL`), checked against its `dist.integrity` (SHA-512 SRI).
    Its lifecycle scripts are never run.
  - The version must be inside the driver's range (`>=2.1 <3`,
    `packages/core/src/providers/claude-code/manifest.ts:22`) and newer than the image's pin.
  - **Precedence:** the image puts `/data/cli/current/bin` first on `PATH`, and `current` is a
    symlink swapped atomically, so the next CLI process uses the new version and running chats keep
    theirs.
  - At every start the launcher removes `current` when its version is not newer than the image's
    pin (a newer image wins), and deletes versions that are no longer `current`.
  - A binary override saved in Settings → Claude Code still beats both.
  - **Use the image's version** removes the link.
- **Without a restart policy.** The loop lives in the launcher, inside the container, so a plain
  `docker run` with no `--restart` restarts the server onto a new bundle the same way.
  - When the server exits on its own and nothing asked for a restart, the launcher exits with the
    server's code: the container stops exactly as today, and a restart policy (or Kubernetes) brings
    it back on the same good bundle.
  - **The plain image with no overlay behaves as today**, except that `launcher.mjs` is the parent
    of `api.mjs`.
- **Helm.** The overlay lives on the data PVC, so it survives a pod restart. A `helm upgrade` to a
  newer image wins over an older overlay by the version rule. The trial boot (60 s) fits inside the
  liveness tolerance (30 s × 3); `values.yaml` documents that the two must stay so.
- Rejected: replacing `/app` in place (the layer is the image's; a broken write would leave a
  container that cannot boot); running a second container to swap the first (needs the Docker
  socket, which Claudio never gets); the CLI's own autoupdater (it writes into the image's
  `~/.local` and moves the pin behind the driver's back).

### D5. An unlisted host gets a page a person can act on

- The `421` JSON gains `code: 'host-not-allowed'`, `host` (the name, port stripped), `mode` and
  `canClaim` (true when the mode is `token` or `oidc` and read-only is off). A `GET` whose `Accept`
  prefers `text/html` (a person typing `/api/...` or `/docs`) gets a small static HTML page with the
  same message.
- The web app, on that `421`, replaces itself with a **Host refused** screen, the way a `401`
  shows `SignIn` (`apps/web/src/App.tsx:109-111`).
- **Adding the host with the owner token.** One route is exempt from the host check:
  `POST /api/security/allowed-hosts/claim`. It adds the request's own `Host` name to the allowlist's
  file layer, the one Settings → Access & safety → Allowed hosts edits.
  - It requires an owner credential. It is refused under `none`, under read-only and to chat tokens,
    and its failures count in the same back-off.
  - It is safe against DNS rebinding, which is what the allowlist is for: a rebinding page cannot hold
    the owner's bearer token (it lives in the real origin's storage, and a bearer header is never
    sent by the browser on its own), so a request that carries it comes from the person.

  Rejected: answering every host when a token is presented, without recording it. The allowlist
  would stop being a list.

### D6. The image's pins move

To the targets in [the table above](#pinned-versions-checked-2026-10-18): Claude Code 2.1.302,
glab 1.123.0, Tailscale 1.104.1; gh is already the newest. The glab adapter was recorded on 1.120.0.
The worker reads the release notes of 1.121–1.123 for changes to what the adapters parse
(`auth status`, `api`, `mr view --output json`) and re-records only if they touch it.

### D7. The setup assistant fills the screen

- The assistant becomes a full-height frame: header, a body that scrolls, and a foot pinned to the
  bottom of the viewport.
- On a wide screen it uses two columns: the step's title and explanation on the left, the step's
  cards on the right.
- Provider rows are laid out by container queries so that the path, the state and the actions never
  cut each other.
- The reference screens and `docs/design-system.md` change with it (design in
  [the assistant's layout](#the-setup-assistants-layout)). Rejected: only widening the column. That
  leaves the bottom empty, and line lengths above 90 characters.

## Design

Every screen follows Night Shift and the `claudio-ui` skill. Load the skill before touching any
`*.tsx` or `*.css`. No new gradient surface is added anywhere: each screen keeps its existing primary.
Status colours keep their single meaning:

| Status colour | Means |
| --- | --- |
| `ok` | signed in, up to date, verified |
| `warn` | signed out, expired, a rollback happened, needs a new image, needs a token |
| `bad` | a failed sign-in, a bad signature, a failed download |
| `idle` | waiting for the person |

Spanish copy follows `apps/web/src/i18n/GLOSSARY.md`: Spain, "tú", infinitive buttons, sentence case,
"No se ha podido …", "el token", "el host", "la terminal", "sesión iniciada".

### The Claude sign-in panel (assistant, Settings, Accounts)

One component, `ClaudeSignIn`, in `apps/web/src/components/setup/ClaudeSignIn.tsx`. It is made from
`SignInSession` (moved out of `AddAccountDialog.tsx:26-87` and reused by it) and the API-key form of
`SignInPanel`.

- **Head**: `Segmented` (`packages/ui/src/components/ui.tsx`) with **Claude account** | **API key**
  (es: **Cuenta de Claude** | **Clave de API**), account first. No other method.
- **Claude account, idle**: one sentence, then the neutral **Sign in** button (`.btn`; the screen's
  two gradient surfaces are already the logo and Continue).
  - en: "Sign in with the Claude account you use for Claude Code. Claudio opens the sign-in and
    relays it; Claude Code keeps the credentials, and Claudio never reads them."
  - es: "Inicia sesión con la cuenta de Claude que usas en Claude Code. Claudio abre el inicio de
    sesión y lo transmite; Claude Code guarda las credenciales y Claudio nunca las lee."
  - Button: en "Sign in" · es "Iniciar sesión".
- **Starting**: braille spinner + the existing `signIn.starting` ("Pidiendo a Claude Code la página de
  inicio de sesión…"). No energy yet.
- **Waiting** (`waiting-for-person`): the existing `.signin-device.is-link.live-energy` box (the
  screen's one live surface), as `SignInSession` draws it today:
  - the two numbered lines;
  - the link cut with an ellipsis, with **Copy link**;
  - the code field and **Send code**;
  - the braille spinner beside "Esperando a que apruebes";
  - the time left from `startedAt` plus 15 minutes, as `formatDuration` gives it: en "expires in
    {{left}}" · es "caduca en {{left}}".
- **Succeeded**: the panel closes. In the assistant the row turns `ok` "Listo" with the reason en
  "Signed in as {{email}}" · es "Sesión iniciada como {{email}}". In Settings a success toast, en
  "Signed in to Claude Code" · es "Sesión iniciada en Claude Code".
- **Expired** (new `AccountLoginState` `'expired'`): `warn` with the clock icon. en "The sign-in link
  expired." · es "El enlace para iniciar sesión ha caducado." Action en "Get a new link" · es "Pedir
  otro enlace".
- **Failed**: `.signin-result` `role="alert"`, `bad`. en "The sign-in did not finish." · es "No se ha
  podido iniciar sesión." Action en "Try again" · es "Reintentar". Cancelled closes silently.
- **API key**: the existing key form with `ANTHROPIC_API_KEY` only (no variable choice left, so no
  second `Segmented`), the placeholder `sk-ant-api03-…`, the existing hint and `panel.claudeApiKey`,
  and **Save and check** (en) · **Guardar y comprobar** (es).
- **Notes above the method**, `warn` callouts, only when they apply:
  - `tokenSource === 'env-oauth-token' | 'env-api-key'`:
    - en: "This deployment sets {{variable}} in its environment, and Claude Code uses it before any
      sign-in made here. Remove it from the deployment to use the account you sign in with."
    - es: "Este despliegue define {{variable}} en su entorno, y Claude Code lo usa antes que
      cualquier sesión iniciada aquí. Quítalo del despliegue para usar la cuenta con la que inicies
      sesión."
  - `tokenSource === 'wrapper-oauth-token'`:
    - en: "Signing in replaces the token saved earlier." · es: "Al iniciar sesión se sustituye el
      token guardado antes."
- The keys `panel.claude`, `panel.link.claude-code`, `panel.variables.oauthToken` and the
  `sk-ant-oat01-…` placeholder are deleted in `en` and `es`.
- Phone: inside the existing `Sheet`, with buttons full width at 44 px.

### The setup assistant's layout

The files are `apps/web/src/components/setup/SetupAssistant.tsx` and `apps/web/src/styles/setup.css`.
Classes stay in `setup.css` under `.setup-page`, so the first-run Providers page that shares
`.prov-first` (`providers.css:166`) is untouched.

- **Frame** (every size): `.setup-page` is `display: grid; grid-template-rows: auto minmax(0, 1fr)
  auto; height: 100dvh`.
  - Row 1 is the brand line and the step bar (`.setup-steps`), as today.
  - Row 2 is `.setup-body`, the only scrolling part (`overflow: auto`, `min-height: 0`).
  - Row 3 is `.setup-foot` (or `.setup-m-foot` on a phone), pinned to the bottom, on `--bg` with the
    hairline `--line` above it.
  - Continue is never below the fold, and the bottom of the screen is no longer empty space.
  - The `--glow-top` halo stays on the page.
- **Wide** (`@media (min-width: 1180px)`, the shell's level):
  - The header, body and foot share one centred track `width: min(1180px, 100% - 64px)`.
  - The body is two columns: `minmax(260px, 320px) minmax(0, 1fr)`, with a 48 px gap.
  - The left column (`.setup-aside`) holds the step's `h1` (`--fs-title`) and its paragraph (max 44
    characters per line), `position: sticky; top: 0`.
  - The right column holds the step's cards, `max-inline-size: 820px`.
  - The step bar spans both columns.
  - At 1280 × 720 that gives 320 + 48 + 820 = 1188 px; at 1600 × 950 the track is 1180 px with 210 px
    margins.
- **Medium** (720–1179 px: tablets, narrow windows): one column, `width: min(880px, 100% - 48px)`.
  The intro sits above the cards as today.
- **Short** (`@media (max-height: 760px)`): the header's padding drops to 16 px, and the intro
  paragraph clamps to three lines with "More" (es "Más") to expand it. The foot stays pinned.
- **Phone** (< 720 px): the current phone layout (`.prov-cell`, `.setup-steps-bare`, "2 de 4 ·
  Agentes"). The assistant never shows the shell, so there is no tab bar.
  - The foot `.setup-m-foot` is pinned to the bottom with
    `padding-bottom: max(12px, env(safe-area-inset-bottom))`.
  - Continue is full width, with Back and Skip under it, 44 px each.
- **Provider row** (`.setup-page .prov-list`, with `container: setup-list / inline-size`; the pattern
  is `apps/web/src/styles/integrations.css:286-300`):
  - ≥ 640 px of card: `grid-template-columns: 36px minmax(0, 1fr) auto`.
    - Column 2 has three lines: the name with the state `Tag` right after it (no middle column any
      more); the reason sentence (`--fs-small`, `--fg-2`, wraps); and the meta line, the version and
      the binary path. The path is mono, wraps with `overflow-wrap: anywhere` and is **never
      ellipsised**: it is a literal the person may need to read.
    - Column 3 holds the actions, top-aligned, with a stable width (`ReservedLabel` where the label
      changes).
  - < 640 px of card: `36px minmax(0, 1fr)`, the actions on their own line under column 2 (`grid-column: 2`).
- **Sign-in panel under a row**: `.prov-bin.signin-panel` spans `grid-column: 2 / -1` of the row
  grid (indented to the name, not the card's edge). Its content is `max-inline-size: 640px`, and the
  waiting box keeps `.signin-device.is-link` (one column).
- **Step 1, Access, in a container with a first-run token**: the access card shows `Tag ok`
  ("Protected · token") and the sentence en "Claudio made this token the first time it started.
  Rotate it to choose one of your own." · es "Claudio creó este token la primera vez que arrancó.
  Rótalo para elegir uno propio." Actions: the existing token actions (`useTokenActions`).
- **Reference**: `docs/design-system/reference/tools/setup.py` draws the new frame. Regenerate
  `DesktopConfiguracion*`, `MobileConfiguracion*` and their dark and light screenshots, and replace
  "760 px" and the `claude setup-token` text and decision in `docs/design-system.md` §Setup
  (lines 1769-1890) and in the Setup block of `docs/design-system/claudio-ds.css`.

### Settings → Claude Code → Sign-in

File: `apps/web/src/pages/config/SignInSection.tsx`.

- **Account in use** (`PrefRow` `sign-in.account`), from `auth.inUse` and the provider status:
  - Line 1: the account's name (alias, else email) with its state `Tag`: `ok` "Signed in" ·
    "Sesión iniciada"; `warn` "Sign-in expired" · "Sesión caducada"; `warn` "Not signed in" · "Sin
    sesión".
  - Line 2: plan · kind word (Claude account / API key / Token) · source when it is the environment
    (en "from the environment" · es "del entorno").
  - Line 3: en "Checked {{ago}}" · es "Comprobada {{ago}}", from `timeAgo(inUse.checkedAt)`, or en
    "Not checked yet" · es "Sin comprobar".
  - When `inUse.id !== 'default'`, a small line: en "Claude Code's own sign-in has none; Claudio runs
    on {{name}} from Accounts." · es "Claude Code no tiene sesión propia; Claudio usa {{name}}, de
    Cuentas." The name is a link to `/accounts`.
- **Actions**:
  - **Check** (es **Comprobar**) runs `POST /accounts/{inUse.id}/refresh`, which is free.
  - **Sign in again** (es **Volver a iniciar sesión**) when expired opens the panel on Claude account.
  - **Sign out** and **Remove** as today.
  - If the spike lands in its "if not" branch, Check becomes **Send a test message** (es **Enviar un
    mensaje de prueba**) with the hint en "Sends one short message, which counts against the plan." ·
    es "Envía un mensaje corto, que cuenta en tu plan."
- **No account at all**: the panel is open by default, with no Empty illustration (it sits beside
  other content).

### Accounts page

Files: `apps/web/src/pages/accounts/**`.

- `default` is absent while it has no credential (the API filters it out; the web does not filter
  again).
- With no account at all: `Empty` with the `signed-out` illustration, en "No account yet" · es "Aún no
  hay ninguna cuenta", the text en "Sign in with a Claude account to run chats." · es "Inicia sesión
  con una cuenta de Claude para ejecutar chats.", and **Add an account** (es **Añadir una cuenta**),
  the zone's primary.
- **Add an account** dialog: the kinds are `login` | `api-key` (`Segmented` "Claude account | API
  key" · "Cuenta de Claude | Clave de API"). The `token` kind, `hint.token` and its strings are
  removed. Existing token accounts keep their card as today.
- The copy "El CLI no da el uso de un token…" is unchanged for the token accounts that remain.

### Status bar and the phone's More sheet

File: `apps/web/src/components/shell/StatusBar.tsx`.

- "Healthy" means the provider's state is `ready` **and** `auth.inUse` is not null with a state other
  than `expired`. The short label is `inUse` alias, else email.
- Problems: no account → `warn` "Not signed in" · "Sin sesión iniciada", which leads to Settings →
  Claude Code; `expired` → `warn` with the `LogIn` icon, "Sign-in expired" · "Sesión caducada", which
  leads to the same place.
- The More sheet's card (lines 110-160) uses the same reading.

### The Terminal card and its refusals

Files: `apps/web/src/pages/config/security/TerminalCard.tsx` and
`apps/web/src/components/terminal/terminal-model.ts`.

- A helper `terminalRefusal(reasonOrError)` returns `{ sentence, action }` from
  `TerminalUnavailableReason` or from `ApiRequestError.code === 'terminal.<reason>'`. The raw
  `error.message` is never shown.

| Reason | Colour | Sentence (en / es) | Action |
| --- | --- | --- | --- |
| `needs-auth` | warn | "The terminal needs access protected by a token." / "La terminal necesita que el acceso esté protegido con un token." | link **Protect with a token** · **Proteger con un token** → `/settings/access#token` |
| `needs-tunnel` | warn | "From another device the terminal opens only through the tunnel." / "Desde otro dispositivo, la terminal solo se abre por el túnel." | link **Open the tunnel** · **Abrir el túnel** → `/settings/access#remote`. *(The plan also had a button "Allow from any device with the token"; it was dropped while building, see [Outcome](#outcome): a change made from the refused device goes through the same gate and is refused again.)* |
| `remote-off` | warn | "The terminal is set to open on this machine only." / "La terminal está configurada para abrirse solo en esta máquina." | none. *(The plan had "focus the Where it opens `Select`"; the gate only ever answers `remote-off` to another device, and a change of `remote` made from there is refused the same way, so the action is left out for the reason the needs-tunnel button was.)* |
| `read-only` | warn | the existing `unavailable.read-only` | link → `/settings/access` |
| `chat-token`, `from-agent` | warn | the existing sentences | none |
| `disabled-by-env`, `pty-missing`, `host-failed` | bad for the last two, warn for the first | the existing `unavailable.*` | none |

- The **toggle**: on a refusal the `Switch` returns to its value, and under it an inline `.alert`
  shows the sentence and the action (`role="alert"`). There is no toast for a refusal; a toast stays
  only for success and for a failure that is not a refusal (network), and that toast uses the same
  sentence mapping, falling back to `settings.saveFailed`.
- In a container the default is now `any`, so a fresh install with the first-run token shows the
  existing `limits.any` note and works.
- The status-bar item still appears only when the feature is on. When the feature is off and the
  reason is `off`, the card's switch is the way in; nothing else changes.

### The Updates card in a container

Files: `apps/web/src/pages/config/UpdatesCard.tsx` and `apps/web/src/lib/updates.ts`.

When `release.distribution === 'docker'` the card reads `GET /system/server-update` and shows
**Claudio** first, then **Claude Code**. Each zone has at most one `btn-primary`. Phone: the card
stacks, and buttons are full width at 44 px.

**Claudio**

- **Facts line**: en "In use {{running}} · image {{image}}" · es "En uso {{running}} · imagen
  {{image}}". The second part shows only when they differ, with the existing Newest release and
  Release notes.
- **Unsupported** (`unsupportedReason` set): the existing host commands (`UpdateSteps`) with one line
  above them:

| `unsupportedReason` | en | es |
| --- | --- | --- |
| `needs-auth` | "To update from here, protect access with a token." | "Para actualizar desde aquí, protege el acceso con un token." |
| `read-only` | "Read-only mode is on: updates are installed from the host." | "El modo de solo lectura está activado: se actualiza desde el host." |
| `no-launcher`, `no-keys` | "This container was started without Claudio's launcher; update it from the host." | "Este contenedor se arrancó sin el lanzador de Claudio; actualízalo desde el host." |

- **Up to date**: `Tag ok` "Up to date" (existing `upToDateTag`).
- **Available**: **Download Claudio {{version}}** (existing `updates.download`, `btn-primary`).
- **Needs a new image** (`needsImage`): `warn` alert, the existing host commands under it.
  - en: "Claudio {{version}} needs a newer image ({{minImage}} or later): the container's system
    changed. Update the image from the host."
  - es: "Claudio {{version}} necesita una imagen más reciente ({{minImage}} o posterior): ha cambiado
    el sistema del contenedor. Actualiza la imagen desde el host."
- **Downloading**: the existing `.progress` / `.progress-seg.is-running` bar
  (`UpdatesCard.tsx:259-274`) and `updates.downloading`.
- **Verifying**: braille spinner, en "Checking the signature…" · es "Comprobando la firma…".
- **Ready**: **Restart to update to {{version}}** (existing `updates.restart`, `btn-primary`). If
  `409 update.live-work`, the existing busy `Dialog` (`UpdatesCard.tsx:290-306`) with
  `updates.busyBody` and the buttons Cancel, **Restart when nothing is running** (es **Reiniciar
  cuando no haya nada en marcha**) and **Restart now** (`btn-danger-solid`).
- **Scheduled**: en "Claudio {{version}} will restart onto the update when nothing is running." · es
  "Claudio {{version}} se reiniciará con la actualización cuando no haya nada en marcha." Plus
  **Cancel** (es **Cancelar**), quiet.
- **Restarting**: braille spinner, en "Restarting… this page reloads on its own." · es
  "Reiniciando… esta página se recarga sola." The page polls `GET /api/health` every 2 s and
  reloads when `stream.hello` reports the new version (app-updates' mechanism).
- **Failed** (`bad` alert, sentence by `error` code, then **Try again** · **Reintentar**):

| `error` | en | es |
| --- | --- | --- |
| `bad-signature` | "The download has no valid signature and was discarded." | "La descarga no tiene una firma válida y se ha descartado." |
| `fetch-failed` | "Could not download the update." | "No se ha podido descargar la actualización." |
| `disk` | "There is not enough space in /data for the update." | "No hay espacio suficiente en /data para la actualización." |

- **Rolled back** (`lastRollback`, `warn`, dismissible after reading):
  - en: "Claudio {{from}} did not start, so the container went back to {{to}}."
  - es: "Claudio {{from}} no arrancó, así que el contenedor ha vuelto a {{to}}."
  - A bad version is not offered again; the next release is.
- **Running an overlay**: a quiet action, en "Go back to the image's version ({{image}})" · es "Volver
  a la versión de la imagen ({{image}})". It uses the same live-work dialog.

**Claude Code** (extends `CliCard`'s reading)

- **Facts line**: en "In use {{current}} · image {{pinned}}" · es "En uso {{current}} · imagen
  {{pinned}}".
- **Install**: when `updateAvailable` and `installable`, **Install {{version}}** (es **Instalar
  {{version}}**), neutral `.btn`, since the card's primary is Claudio's.
- **Installing**: braille spinner, en "Installing Claude Code {{version}}…" · es "Instalando Claude
  Code {{version}}…".
- **Failed** (`bad`):

| `error` | en | es |
| --- | --- | --- |
| `integrity` | "The download did not match the registry's checksum and was discarded." | "La descarga no coincide con la suma de comprobación del registro y se ha descartado." |
| `out-of-range` | "Claudio does not support Claude Code {{version}} yet." | "Claudio aún no admite Claude Code {{version}}." |
| `fetch-failed` | "Could not download Claude Code." | "No se ha podido descargar Claude Code." |

- **Installed from /data**: a quiet action, en "Use the image's version ({{pinned}})" · es "Usar la
  versión de la imagen ({{pinned}})".
- New chats use the new version at once. en "New chats use {{version}}; running ones keep theirs." ·
  es "Los chats nuevos usan la {{version}}; los que están en marcha siguen con la suya."

### The first-run token screen

File: `apps/web/src/components/SignIn.tsx`, copy in `packages/ui/src/locales/{en,es}/common.json`
`signIn.*`.

- When the challenge carries `firstRunToken: true`, the body replaces `tokenBody` and the hint
  replaces `hint`. Everything else is the screen as it is: `.signin`, the `signed-out` illustration,
  and `btn-primary` **Sign in**.
- title: en "Sign in with the owner token" · es "Inicia sesión con el token de propietario".
- body:
  - en: "This Claudio made an owner token the first time it started and printed it once in the
    container's log. On the machine that runs the container, read it with <code>docker logs</code>
    and the container's name, then paste it here."
  - es: "Este Claudio creó un token de propietario la primera vez que arrancó y lo escribió una vez
    en el registro del contenedor. En la máquina donde se ejecuta, léelo con <code>docker logs</code>
    y el nombre del contenedor, y pégalo aquí."
- hint:
  - en: "Until you first sign in, it is also in /data/first-run-token inside the container. On
    Kubernetes, kubectl logs shows it."
  - es: "Hasta que entres por primera vez, también está en /data/first-run-token dentro del
    contenedor. En Kubernetes lo muestra kubectl logs."
- The command is named inline, with no copy button or code block: the same rule the design system
  applied to `claude setup-token`. Paths stay mono.
- Phone: as today.

### The Host refused screen (and the 421 page)

New `apps/web/src/components/HostRefused.tsx`, shown by `App.tsx` before `SignIn` when the store in
`lib/auth.ts` holds a host refusal. It reuses `.signin`, `.signin-card`, the `signed-out`
illustration (`tone="warn"`), `.signin-input` and `btn-primary`.

- **title**: en "This Claudio does not answer to {{host}} yet" · es "Este Claudio aún no responde a
  {{host}}". The host is in mono.
- **body**:
  - en: "It answers only to the addresses it was told about, so that no other site can drive it from
    your browser."
  - es: "Solo responde a las direcciones que conoce, para que ninguna otra web pueda manejarlo desde
    tu navegador."
- **`canClaim`**: the token field (label en "Owner token" · es "Token de propietario") and **Add
  {{host}} and sign in** (es **Añadir {{host}} y entrar**). On success the token is stored like
  `signIn` does, and the app reloads.
  - `401`: the existing `signIn.rejected`.
  - `429`: en "Too many attempts. Wait {{wait}} and try again." · es "Demasiados intentos. Espera
    {{wait}} y vuelve a intentarlo." (`formatDuration`).
  - When `firstRunToken`, the first-run hint above shows under the field.
- **Not `canClaim`** (mode `none` or read-only): no field. The text:
  - en: "Add it where Claudio runs: name it in CLAUDIO_ALLOWED_HOSTS when you start the container, or
    open Claudio on localhost and add it in Settings → Access & safety → Allowed hosts."
  - es: "Añádelo donde se ejecuta Claudio: nómbralo en CLAUDIO_ALLOWED_HOSTS al arrancar el
    contenedor, o abre Claudio en localhost y añádelo en Ajustes → Acceso y seguridad → Hosts
    permitidos."
- **The server's HTML page** (`GET` with `Accept: text/html` on `/api/*`, `/docs`, `/openapi.json`):
  - It is served by `security.ts` and holds the same title and the not-`canClaim` text in English
    only (it has no locale), with a link to `/`, where the app's screen offers the token form.
  - It is plain HTML with `<meta name="color-scheme" content="dark light">`, no script and no
    stylesheet (no colour literal to break the token rule). The host is HTML-escaped.

## Contracts

### Shared types (`packages/shared/src/types.ts`)

Owned by the task named in brackets. After a change, run `pnpm --filter @claudio/api openapi:schemas`.
The integration regenerates once more after merging, since three tasks touch the schema output.

```ts
// [signin-core]
export interface SetupToolMethods {
  // … existing fields …
  /** The CLI's own `claude auth login`, relayed (open a link, paste a code): offered first. Only Claude Code */
  accountLogin: boolean;
}
export type AccountLoginState = 'starting' | 'waiting-for-person' | 'succeeded' | 'failed' | 'expired' | 'cancelled';
export interface Account {
  // … existing fields …
  /** When the credential was last checked with `get_usage` (no turn); null when never */
  checkedAt: string | null;
}
/** The account new work would start on, as Settings and the status bar name it */
export interface AccountInUse {
  id: string;
  label: string; // alias, else email, else id
  kind: AccountKind;
  signInState: AccountSignInState;
  checkedAt: string | null;
}
export interface AuthStatus {
  // … existing fields …
  /** Null when no account can take work */
  inUse: AccountInUse | null;
}

// [access-core]
export interface AuthConfig {            // the public shape of GET /security/auth (existing name; add the field)
  // … existing fields …
  /** The token was generated on first start and has not been used yet */
  firstRunPending: boolean;
}
export interface HostRefusal {           // the 421 body
  error: string;
  code: 'host-not-allowed';
  host: string;
  mode: AuthMode;
  canClaim: boolean;
  firstRunToken: boolean;
}
export interface ClaimHostResult { host: string; allowedHosts: string[] }
// The 401 body gains `firstRunToken?: true` beside `mode` (typed where the web reads it, lib/auth.ts)

// [update-core]
export interface LiveWork { working: number; waiting: number; running: number }
export type ServerUpdateState = 'idle' | 'downloading' | 'verifying' | 'ready' | 'scheduled' | 'restarting' | 'failed';
export type ServerUpdateError = 'fetch-failed' | 'bad-signature' | 'bad-manifest' | 'disk' | 'needs-image';
export type ServerUpdateUnsupported = 'not-docker' | 'no-launcher' | 'no-keys' | 'needs-auth' | 'read-only';
export interface ServerUpdateStatus {
  /** Null when this container can update itself */
  unsupportedReason: ServerUpdateUnsupported | null;
  /** The version baked in the image (`/app/image.json`) */
  image: string;
  /** The version running now */
  running: string;
  source: 'image' | 'overlay';
  state: ServerUpdateState;
  /** The version being downloaded, ready or scheduled */
  target: string | null;
  /** 0..1 while downloading */
  progress: number | null;
  error: ServerUpdateError | null;
  /** The newest release needs a newer image than this one */
  needsImage: { version: string; minImage: string } | null;
  lastRollback: { from: string; to: string; at: string } | null;
}
export interface ServerUpdateApplyRequest { force?: boolean; whenIdle?: boolean }
export type CliInstallError = 'fetch-failed' | 'integrity' | 'out-of-range' | 'not-newer' | 'version-mismatch' | 'disk';
export interface CliVersionInfo {
  // … existing fields …
  /** Where the CLI in use comes from */
  source: 'image' | 'data' | 'path';
  /** Whether `POST /system/cli-version/install` may run here */
  installable: boolean;
  install: { state: 'idle' | 'installing' | 'failed'; version: string | null; error: CliInstallError | null } | null;
}
export interface SystemServerUpdateEvent extends ClaudioEventBase { type: 'system.server-update'; status: ServerUpdateStatus }
```

### Routes

Each new route gets a summary and tag in `apps/api/src/openapi/routes.ts` and a row in
`docs/rest-api.md` (a test checks both). Errors are `{ error, code }`, the shape
`ApiRequestError` reads.

| Route | Task | Body → answer | Errors |
| --- | --- | --- | --- |
| `GET /accounts` | signin-core | → `Account[]` without `default` when it has no credential (D2) | – |
| `POST /accounts/default/login` | signin-core | existing route, now used by the assistant and Settings; on `succeeded` clears a vault `CLAUDE_CODE_OAUTH_TOKEN` | existing |
| `POST /accounts/:id/refresh` | signin-core | existing; now classifies a refused credential: marks `authFailedAt` and answers the account (`200`) with `signInState: 'expired'` instead of throwing | `502 accounts.check-failed` when it could not run |
| `GET /auth` | signin-core | → `AuthStatus` with `inUse` | – |
| `GET /security/auth` | access-core | → `AuthConfig` with `firstRunPending` | – |
| `POST /security/allowed-hosts/claim` | access-core | no body → `ClaimHostResult` | `401` (counted), `403 host.needs-auth` under `none`, `403 host.not-owner` for a desktop or chat actor, `405` read-only, `400 host.invalid` |
| `GET /system/server-update` | update-core | → `ServerUpdateStatus` | – |
| `POST /system/server-update/download` | update-core | `{ version?: string }` → `202 ServerUpdateStatus` | `400 update.unsupported`, `403 update.needs-auth`, `409 update.busy`, `412 update.needs-image`, `404 update.no-release` |
| `POST /system/server-update/apply` | update-core | `ServerUpdateApplyRequest` → `202 ServerUpdateStatus` (then the process exits 75) | `409 update.live-work` with `live: LiveWork`, `409 update.not-ready`, `403`, `400` as above |
| `DELETE /system/server-update/scheduled` | update-core | → `ServerUpdateStatus` | – |
| `POST /system/server-update/revert` | update-core | `ServerUpdateApplyRequest` → `202` (restarts onto the image's `/app`) | `409 update.live-work`, `409 update.not-overlay` |
| `POST /system/cli-version/install` | update-core | `{ version?: string }` → `202 CliVersionInfo` | `400 cli.unsupported`, `403 cli.needs-auth`, `422 cli.out-of-range`, `422 cli.not-newer`, `409 cli.busy` |
| `DELETE /system/cli-version/install` | update-core | → `CliVersionInfo` (removes `/data/cli/current`) | `409 cli.not-installed` |

**Chat-token denylist** (`apps/api/src/security.ts`, owned by access-core, which adds every entry
below even for routes another task builds). New set `CHAT_FORBIDDEN_SYSTEM`:

- `POST /security/allowed-hosts/claim`
- `POST /system/server-update/download`, `POST /system/server-update/apply`,
  `DELETE /system/server-update/scheduled`, `POST /system/server-update/revert`
- `POST /system/cli-version/install`, `DELETE /system/cli-version/install`

The accounts routes are already in `CHAT_FORBIDDEN_ACCOUNTS`. The read-only gate refuses every new
`POST`/`DELETE` already (`security.ts:904`); no entry goes into `READ_ONLY_ALLOWED`.

### Environment variables

| Variable | Set by | Meaning |
| --- | --- | --- |
| `CLAUDIO_GUARD_ENTRY=/app/guard.mjs` | Dockerfile `ENV`, and the launcher | the guard is always the image's (existing variable, `server.ts:106-107`) |
| `CLAUDIO_LAUNCHER=1` | the launcher, for the server it starts | the server is supervised and may exit 75 to be restarted |
| `CLAUDIO_APP_DIR` | the launcher | the directory the running bundle came from (`/app` or `/data/app/<v>`) |
| `CLAUDIO_WEB_DIST` | Dockerfile (`/app/web`), overridden by the launcher for an overlay (`/data/app/<v>/web`) | existing |
| `CLAUDIO_BUNDLE_KEYS_DIR` | default `/app/keys`; tests and e2e point it at a fixture | the public keys the **server** checks a download against. The launcher ignores it and always uses `/app/keys` |
| `CLAUDIO_SERVER_UPDATE` | the person | `off` hides in-app updates (the card shows host commands) |
| `PATH` | Dockerfile: `/data/cli/current/bin:/home/node/.local/bin:…` | D4 precedence |

The restart exit code is `75`, exported once as `RESTART_EXIT_CODE` from
`packages/core/src/launcher/protocol.ts` and imported by the server and the launcher.

### Files on disk

| Path | Owner, mode | Written by | Content |
| --- | --- | --- | --- |
| `/app/launcher.mjs` | root, 0444 | image | the launcher |
| `/app/keys/*.pub` | root, 0444 | image | Ed25519 public keys, PEM (SPKI) |
| `/app/image.json` | root, 0444 | image | `{ version, imageInputs, nodeAbi, claudeCode }` |
| `/app/*.mjs`, `/app/web`, `/app/node_modules` | **root**, 0444/0555 (was `node`) | image | the base server; the agents' user can no longer rewrite it |
| `/data/auth.json` | node, 0600 | server | gains `firstRun: { generatedAt, pending }` and `noneChosenAt` |
| `/data/first-run-token` | node, 0600 | server | the token, until first used |
| `/data/app/<version>/` | node, 0755 | server (download), launcher (GC) | the unpacked bundle plus its `manifest.json` and `manifest.json.sig` |
| `/data/app/state.json` | node, 0600 | launcher and server, atomic writes | `{ active, previous, trial, attempts, bad: string[], lastRollback, scheduled }` |
| `/data/cli/<version>/bin/claude` | node, 0755 | server | an installed CLI |
| `/data/cli/current` | symlink | server (swap by rename), launcher (GC) | the CLI in use from `/data` |

**The agents' user can write `/data`.** That gives it nothing new:

- An overlay is verified by the root-owned launcher, against the root-owned keys, at **every** boot,
  so a tampered overlay is refused and marked bad.
- `/data/cli` is no weaker than today's `/home/node/.local/bin/claude`, which the agents' user owns
  already.

### Release assets

Attached to the draft release by the new `server-bundle` job, beside the desktop packages, before
`publish`:

- `claudio-server-<v>-linux-x64.tar.gz`: the contents of `apps/api/dist` without `guard.mjs` and
  `launcher.mjs`, plus `web/`, plus `node_modules/node-pty` and `node_modules/@number0`.
- `claudio-server-<v>-linux-x64.json`, the manifest:
  `{ schema: 1, version, platform: 'linux-x64', nodeAbi, minImage, imageInputs, commit, builtAt,
  tarball: { name, sha256, size }, files: { "<path>": "<sha256>" } }`.
- `claudio-server-<v>-linux-x64.json.sig`: base64 Ed25519 over the manifest's exact bytes.

The server finds them through the release JSON it already reads (`release-watch.ts`). It adds the
`assets[]` names and `browser_download_url`, and a mirror behind `CLAUDIO_RELEASES_URL` must serve
the same shape.

## Security

| Threat | Held by |
| --- | --- |
| A tampered or substituted bundle (compromised download path, a mirror) | Ed25519 signature over the manifest. The tarball's sha256 and every file's sha256 are in the manifest. Verified by the server before unpacking, and by the launcher (root-owned, root-owned keys) before every boot |
| An agent (user `node`, `bypassPermissions`) rewrites the overlay or `state.json` | The launcher re-verifies at every boot and refuses anything unsigned. It cannot forge a signature, and it cannot point the launcher outside `/data/app/<v>` (paths are built from validated version strings, never read from `state.json` as paths) |
| An agent rewrites `/app` | `/app` becomes root-owned (D4). Today it is `node`-owned |
| A downgrade to an old, vulnerable signed bundle | Only versions newer than both the image and the running version are offered or booted. `bad` versions are never retried |
| A bundle that needs a newer OS layer | `minImage` and `nodeAbi`, checked by the server and the launcher |
| A bundle that boots but is broken | Trial boot: two attempts of 60 s each to answer `/api/health`, then rollback to the previous good one or `/app`, and an audit row |
| The signing key leaks | It lives in a protected GitHub Environment. Rotation ships a new public key in an image first. An attacker would also need to serve the release JSON (GitHub, or the person's own mirror) |
| A chat triggers an update, a CLI install or a host claim | `CHAT_FORBIDDEN_SYSTEM`; owner-only checks in the routes; read-only `405` |
| A malicious CLI tarball | `dist.integrity` (SHA-512) from the registry's metadata, fetched over HTTPS. No lifecycle scripts run. The version must be in the driver's range and `--version` must report it after install |
| The owner token is sniffed on plain HTTP over the LAN | Unchanged exposure for every owner route. `docs/deploy.md` keeps recommending the `tls` profile or the tunnel. The terminal under `any` adds no capability the token lacks (D3) |
| The first-run token leaks through logs | It is printed once. The file is deleted at first use. Rotating replaces it. Log shippers are the operator's responsibility, and the docs say so |
| DNS rebinding through the claim route | It requires the owner's bearer token, which a rebinding page cannot hold. Its failures count in the back-off |
| Upgrading locks people out | The first-run screen says where the token is. `CLAUDIO_AUTH_TOKEN_RESET` stays the recovery path. `CLAUDIO_AUTH_MODE=none` opts out |
| The terminal through a proxy | Unchanged: under `any` locality does not matter, and the owner token, Origin and tickets do |

## Tasks

The integrator launches this graph on `fix/container-polish`. Code tasks run on `claude-opus-5-5`;
`docs` runs on `claude-sonnet-5-5`. **Three stages in series**:
`signin-core · access-core · update-core · image-release → web-signin · web-access-updates → review · docs`.

| Id | Task | dependsOn | Owns | Checks |
| --- | --- | --- | --- | --- |
| `signin-core` | D1, D2: spike `get_usage`, validation, default visibility, `inUse`, setup methods, the default login, start-up warning, fake CLI `auth login` | – | `packages/core/src/cli.ts`, `packages/core/src/setup/methods.ts`, `packages/core/src/providers/detector.ts`, the auth/account parts of `packages/core/src/index.ts`, `packages/accounts/src/**`, `apps/api/src/account-logins.ts`, `apps/api/src/routes/accounts.ts`, the `/auth` part of `apps/api/src/routes/system.ts`, `apps/api/src/server.ts:75`, its types, `e2e/fake-cli/**` | `pnpm typecheck`, `pnpm test` (accounts, core, api), `openapi:schemas` |
| `access-core` | D3, D5: first-run token and migration, the terminal's container default, the 421 JSON and HTML, the claim route, the denylist for every new route, Helm `auth.mode: auto` | – | `packages/core/src/security/auth.ts`, `packages/core/src/terminals/settings.ts`, `apps/api/src/security.ts`, `apps/api/src/routes/security.ts`, `apps/api/src/terminal-gate.ts` (only if needed), `deploy/helm/claudio/values.yaml` `auth` and `templates/deployment.yaml`, `templates/NOTES.txt`, its types | `pnpm typecheck`, `pnpm test`, `openapi:schemas`, `helm template deploy/helm/claudio` with `auth.mode=auto` and `none` |
| `update-core` | D4 in code: the launcher, the overlay manager, the CLI installer, routes, the bundle and manifest script | – | `packages/core/src/launcher/**` (new), `packages/core/src/updates/**` (new), wiring lines in `packages/core/src/index.ts`, `packages/core/src/release-watch.ts`, `packages/core/src/cli-version.ts`, `apps/api/src/routes/server-update.ts` (new) and its registration, `apps/api/scripts/bundle.mjs`, `apps/api/scripts/server-bundle.mjs` (new), its types | `pnpm typecheck`, `pnpm test`, `openapi:schemas`, `pnpm --filter @claudio/api bundle` then `node apps/api/scripts/server-bundle.mjs --sign-with <test key>` and a verify round trip |
| `image-release` | D4 in the image and CI, D6 pins | – | `docker/Dockerfile`, `docker/entrypoint.sh`, `docker/healthcheck.sh`, `docker/keys/` (README only until the owner adds the key), `.github/workflows/release.yml`, `.github/workflows/server-bundle.yml` (new), `deploy/helm/claudio/values.yaml` probes and `claude` comment | `docker build -f docker/Dockerfile .` locally, then `docker run` the image with no auth variables and check the first-run block (after merge with access-core; before it, check the launcher boots `/app`); `actionlint` if installed |
| `web-signin` | the Claude sign-in panel, the assistant's layout, Settings → Claude Code, Accounts, status bar, reference screens | `signin-core`, `access-core` | `apps/web/src/components/setup/**`, `apps/web/src/styles/setup.css`, `apps/web/src/styles/providers.css` (only `.setup-page`-scoped rules if any), `apps/web/src/pages/config/SignInSection.tsx`, `apps/web/src/pages/accounts/**`, `apps/web/src/components/shell/StatusBar.tsx`, the `api.ts` functions for accounts/auth, `locales/{en,es}/setup.json`, `accountsConfig.json`, `shell.json`, `config.json` keys under `account`, `docs/design-system.md` §Setup, `docs/design-system/claudio-ds.css` Setup block, `docs/design-system/reference/tools/setup.py` and the regenerated Setup references | `pnpm typecheck`, `pnpm test` (web), `node scripts/design-lint.mjs` on edited files, `/ui-review` of `/setup`-assistant, `/settings/claude-code`, `/accounts`; screenshots in both themes at 1600×950, 1280×720 and 390×844 compared with the regenerated references |
| `web-access-updates` | the terminal refusals, the Updates card in a container, the first-run screen, Host refused | `access-core`, `update-core` | `apps/web/src/pages/config/security/TerminalCard.tsx`, `apps/web/src/components/terminal/terminal-model.ts`, `apps/web/src/pages/config/UpdatesCard.tsx`, `apps/web/src/pages/config/CliCard.tsx`, `apps/web/src/lib/updates.ts`, `apps/web/src/components/SignIn.tsx`, `apps/web/src/components/HostRefused.tsx` (new), `apps/web/src/App.tsx`, `apps/web/src/lib/auth.ts`, the `request()` 421 branch and the update functions in `apps/web/src/api.ts`, `locales/{en,es}/terminal.json`, `config.json` keys under `updates`, `packages/ui/src/locales/{en,es}/common.json` `signIn.*` and `hostRefused.*` | `pnpm typecheck`, `pnpm test` (web), design lint, `/ui-review` of `/settings/access` (Terminal), `/settings/updates`, the sign-in and host screens in both themes at 1280×720 and 390×844 |
| `review` | design, conventions, security, copy; at most one test run | all six above | none (findings only, or one-line fixes in owned-by-nobody places) | reads; runs at most one test |
| `docs` | every stale doc, the feature docs, three decision records, status | all six implementation tasks | `README.md`, `.env.example`, `docs/deploy.md`, `docs/setup.md`, `docs/providers.md`, `docs/configuration.md`, `docs/terminal.md`, `docs/accounts.md`, `docs/cli-surfaces.md`, `docs/security-model.md`, `docs/updates.md` (new), `docs/decisions/claude-sign-in-paste-code.md`, `docs/decisions/container-owner-token.md`, `docs/decisions/container-in-app-updates.md` (new), `docs/plans/in-app-setup.md` and `docs/plans/app-updates.md` (a dated note each), `docs/status.md`, this plan's Outcome | `pnpm test` (the docs tests: rest-api rows, links) |

`web-signin` and `web-access-updates` both touch `apps/web/src/api.ts` and `locales/*/config.json`.
Each adds only inside its own keys and functions, listed above, and appends rather than reorders.
`routes.ts`, `docs/rest-api.md` and the generated OpenAPI schemas are touched by the three core tasks;
the integrator regenerates the schemas after merging.

### Rules for every task

1. Work only in your worktree, on your branch; Conventional Commits in English with a body saying
   why. Never push.
2. Read CLAUDE.md and CONTRIBUTING.md first. TypeScript strict, no `any`, `noUncheckedIndexedAccess`.
3. Run `pnpm typecheck` and `pnpm test`. Write or update e2e specs, but **never run `pnpm e2e`**: CI
   runs them.
4. A new route needs its summary and tag in `apps/api/src/openapi/routes.ts` and a row in
   `docs/rest-api.md` (the `add-rest-route` skill).
5. UI tasks load the `claudio-ui` skill and pass `/ui-review` before finishing.

### `signin-core` (opus)

1. **Spike** (first commit, `test(accounts): record get_usage on refused credentials`).
   - Run the real `claude` 2.1.302 (`claude --version`; if the machine has another version, say so
     in the commit body) through `controlRequest(ref, 'get_usage')` from
     `packages/accounts/src/control.ts:17`, with `ref = { id: 'spike', kind: 'login', dir: <mktemp -d> }`
     and these environments:
     - `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-invalid`;
     - `ANTHROPIC_API_KEY=sk-ant-api03-invalid`;
     - none (signed out).
   - Save each answer or rejection under `packages/accounts/test/fixtures/get-usage-refused-*.json`,
     with a one-line `README` of how each was made.
   - Decide the branch of D1 from what you see. Write it in the commit body.
2. **Classifier.** `checkCredential(ref)` in `packages/accounts/src/cli-usage.ts` returns
   `'valid' | 'refused' | 'unknown'`. Build it on the fixtures, never on prose matching beyond what
   they show. In `AccountStore`, record `checkedAt`, and on `refused` call the existing
   `markAuthFailed` path that a 401 run uses (`store.ts` around `:312-340`).
3. **When it runs.** In `Core.refreshAccountUsage` (`index.ts:3302`), classify instead of only
   reporting `failed`. Run it after `AccountLogins.finish` succeeds (`account-logins.ts:79`), after
   `setCredentials`, and from the provider refresh for the in-use account when `checkedAt` is older
   than 30 minutes. Hook this beside `readClaude` in `index.ts:636-639`, never inside `/health`.
4. **Readiness.** In `detector.ts` `probeClaude` (`:600-614`), `ok` needs `loggedIn` **and** the
   default account not `expired`. Otherwise use the existing `otherAccount` fallback (`:529-531`).
   `claudeHealth` follows automatically.
5. **Default visibility and `inUse`.**
   - `GET /accounts` (`routes/accounts.ts`) filters `default` per D2. Add `hasCredential(id)` to
     `AccountStore`: the credentials file exists, or `tokenSource` for the default is not `none`.
   - `accountsSnapshot` counts the visible list.
   - `system().auth.inUse` comes from `accounts.pick({ current: null })`.
6. **Login on `default`.**
   - `AccountLogins` already handles it.
   - On `succeeded` for `default`, clear the vault's Claude Code credential (`core.clearCredentials()`
     path behind `DELETE /auth/credentials`) when `tokenSource` was `wrapper-oauth-token`.
   - Change the 15-minute expiry to end as `'expired'` (`account-logins.ts:62`).
7. **Setup methods.** In `methods.ts:37-43`, `claude-code`: `variables: ['ANTHROPIC_API_KEY']`,
   `exclusive: false`, `accountLogin: true`; every other tool `accountLogin: false`. Update the
   comment, which claims there is no sign-in.
8. **Start-up warning** (`server.ts:75`): "Claude Code is installed but no account is signed in: open
   Claudio and sign in under Settings → Claude Code, or set ANTHROPIC_API_KEY."
9. **Fake CLI** (`e2e/fake-cli/claude`, README table):
   - `auth login`: print `https://claude.ai/oauth/authorize?fake=1`, read one line from stdin, write
     `.credentials.json` with a refresh token into `CLAUDE_CONFIG_DIR`, exit 0. A code `bad` exits 1.
   - `get_usage`: answer the refusal you recorded when `CLAUDE_CODE_OAUTH_TOKEN` or
     `ANTHROPIC_API_KEY` is `invalid`.
   - Tests in `e2e/fake-cli/claude.test.mjs`.
- **Patterns:**
  - a store write that a refusal triggers: `packages/accounts/src/store.ts:312-340`;
  - a route answering `201` with a session: `apps/api/src/routes/accounts.ts:109-113`;
  - a typed failure with a status: `apps/api/src/account-logins.ts:20`;
  - tests: `packages/accounts/test/cli-usage.test.ts:29-41` (fixtures parsed) and
    `apps/api/test/accounts.test.ts`.
- **Tests:**
  - classifier per fixture;
  - `GET /accounts` with and without a default credential;
  - `inUse` when only a login account is signed in;
  - readiness `signed-out` when the default is expired and nothing else is ready;
  - login on `default` clears the vault token;
  - expiry → `'expired'`.

### `access-core` (opus)

1. **First-run token** in `AuthStore` (`packages/core/src/security/auth.ts`).
   - Constructor option `firstRun: { distribution, env }`. Add `generateFirstRun()`, used both when
     `auth.json` is absent (`fromEnvironment`, `:274`) and for the one-time migration (D3), reusing the
     generator at `:208`.
   - Persist with `persist()` (`:132`, `writeAtomic` 0600). Write `/data/first-run-token` 0600.
   - Expose `firstRunPending`. On the first `actorFor` (`:239`) that matches the `first-run` token,
     clear `pending`, delete the file, and write the audit row the store's owner writes for
     `environmentReset`.
   - Rotating the token clears it too. `update({ mode: 'none' })` records `noneChosenAt`.
   - The printed block goes through a callback the server sets (`process.stdout.write`), so tests
     capture it.
2. **401 body** in `security.ts` `refuse()` (`:756-765`): add `firstRunToken: true` while pending.
3. **421**:
   - Body per `HostRefusal`.
   - HTML for `GET` with `Accept` preferring `text/html`: a function `hostRefusalPage(host)` beside
     the hook, HTML-escaped, no script or style.
   - Exempt exactly `POST /api/security/allowed-hosts/claim` from the host check (`:732`), then let
     the normal credential path run.
4. **Claim route** in `apps/api/src/routes/security.ts`:
   - Owner actor only: not `local`, `desktop`, `anonymous`, `webhook` or `chat:*`. Add a small
     `isOwnerActor(actor)` in `security.ts` for every task to import.
   - Add `hostNameOf(req.headers.host)` to the file layer through the same store
     `PUT /settings/app` uses (`apps/api/src/routes/app-settings.ts:9`). Answer `ClaimHostResult`.
5. **Denylist**: add `CHAT_FORBIDDEN_SYSTEM` (see [Routes](#routes)) and check it where the others
   are checked (`security.ts:780-800`).
6. **Terminal default.** `TERMINAL_DEFAULTS.remote` becomes `terminalDefaults(distribution).remote`:
   `'any'` for `docker`, else `'tunnel'`. `TerminalSettingsStore` takes the distribution from
   `CoreConfig.distribution`. `sources()` keeps reporting `default`.
7. **Helm**:
   - `auth.mode: auto` is the default, and the template writes no `CLAUDIO_AUTH_MODE` for it (the
     fail rule at `deployment.yaml:5-6` stays for `token`).
   - `NOTES.txt` tells how to read the token with `kubectl logs`.
- **Patterns:**
  - env seeding: `auth.ts:274-300`;
  - a settings store with defaults and sources: `packages/core/src/terminals/settings.ts:101-125`;
  - a denylist set: `security.ts:246-264`;
  - tests:
    - `apps/api/test/security.test.ts:331` (host refused), `:385` (host before credential);
    - `apps/api/test/terminal-security.test.ts:182` (LAN listener and the tunnel).
- **Tests:**
  - **First-run token**: generated on a fresh docker install; not generated with any auth variable or
    outside docker; the migration happens once and respects `noneChosenAt` and an explicit
    `CLAUDIO_AUTH_MODE=none`; the file is deleted on first use and on rotate; the `401` flag; the
    printed block.
  - **Host refusal**: the `421` JSON fields; the HTML only for `text/html`, with an escaped host.
  - **Claim route**: works with the owner token on an unlisted host; refused under `none`, read-only,
    the desktop actor and a wrong token (counted).
  - **Denylist**: membership of every `CHAT_FORBIDDEN_SYSTEM` key.
  - **Terminal**: in docker the default is `any`, and a saved `tunnel` wins; through the gate, an
    owner token from a non-loopback peer opens it under docker defaults, and a chat token is still
    refused.

### `update-core` (opus)

1. **Protocol** (`packages/core/src/launcher/protocol.ts`): `RESTART_EXIT_CODE = 75`, the `state.json`
   type and atomic read and write, the manifest type, `verifyManifest(bytes, sig, keys)` with
   `crypto.verify(null, …)`, `verifyFiles(dir, manifest)`, and version comparison
   (`compareVersions` from `packages/core/src/version-check.ts`). Use only `node:*` imports: the
   launcher bundles it alone.
2. **Launcher** (`packages/core/src/launcher/main.ts`, bundled as `launcher.mjs` by
   `apps/api/scripts/bundle.mjs`, a new entry beside `guard`). It implements D4's state machine:
   1. Read `/app/image.json` and `state.json`. GC overlays other than `active`, `previous` and
      `trial`. GC the `/data/cli` versions and the `current` link per D4.
   2. Pick the candidate: `trial ?? active`. Verify it: signature with `/app/keys`, the version newer
      than the image, `minImage ≤ image`, `nodeAbi` equal, the file hashes. If it fails, mark it `bad`
      and fall back to `previous`, then `/app`.
   3. Spawn `node <dir>/api.mjs` with the env of [Environment](#environment-variables), stdio
      inherited.
   4. On a trial, poll `http://127.0.0.1:$PORT/api/health` every second for up to 60 s. A `200`
      promotes it: `previous = active`, `active = trial`. An exit or a timeout counts an attempt;
      after two, it is `bad`, `lastRollback` is recorded, and the launcher boots the fallback.
   5. If the child exits 75, loop. On any other exit while not on a trial, exit with that code.
   6. Forward `SIGTERM` and `SIGINT` to the child, wait for it, and exit with its code.
   - Keep it under about 300 lines; it is the one thing that cannot be updated in place.
3. **Overlay manager** (`packages/core/src/updates/server-update.ts`).
   - **Supported**: `distribution === 'docker'`, `CLAUDIO_LAUNCHER === '1'`, at least one key in
     `CLAUDIO_BUNDLE_KEYS_DIR`, not `CLAUDIO_SERVER_UPDATE=off`. Owner-only and read-only checks
     happen in the routes.
   - **Download**: read the release's assets (extend `release-watch.ts`, `:80-90`), fetch and verify
     the manifest's signature first, then stream the tarball to `/data/app/.staging-<v>` with its
     sha256, extract (`tar` through `node:zlib` and a minimal tar reader, or the image's `tar`
     binary through `execFile`; no new dependency), `verifyFiles`, rename to `/data/app/<v>`, and
     set `state.trial`.
   - **Events**: emit `system.server-update` on every state change.
   - **Apply**: the live-work decision of `apps/desktop/src/updater.ts:350-358` over
     `core.liveWork()` (new, counted as `apps/desktop/src/live.ts:66` counts). Then close the core
     like a `SIGTERM` does and `process.exit(RESTART_EXIT_CODE)`.
   - `whenIdle` checks every 15 s.
   - **Revert**: set `trial = null` and `active = null`, then restart.
   - **On start**: if `state.lastRollback` is new, write its audit row.
4. **CLI installer** (`packages/core/src/updates/cli-install.ts`):
   - Fetch the packument of `@anthropic-ai/claude-code-linux-x64` (base from
     `CLAUDIO_CLI_REGISTRY_URL`, as `cli-version.ts:7` does).
   - Check the version against the manifest range and the pin, download, verify `dist.integrity`,
     and extract only the binary. Find its path inside the tarball with
     `npm pack @anthropic-ai/claude-code-linux-x64@2.1.302 --dry-run` first, and write it in a comment.
   - `chmod 0755`; `--version` must equal the requested version. Then swap `current` with
     `symlink` + `rename`, and refresh providers.
   - Extend `CliVersionInfo` (`source`, `installable`, `install`).
5. **Routes**: `apps/api/src/routes/server-update.ts`, plus the two CLI routes in
   `apps/api/src/routes/system.ts` (append only, after line 34). Owner-only via `isOwnerActor` from
   access-core; until that merges, inline the same check and leave a `// TODO(integration)`.
6. **Bundle script** (`apps/api/scripts/server-bundle.mjs`): it builds the tarball and manifest
   from `apps/api/dist` and `apps/web/dist` (excluding `guard.mjs` and `launcher.mjs`), computes
   `imageInputs` as D4 lists, and takes `--previous <manifest-url-or-file>` for `minImage`. It
   writes `/app/image.json` content with `--image-json`. `--sign-with <pem>` and `--verify-with <pem>`
   exist for CI and tests.
- **Patterns:**
  - a version-check document read without a network call: `packages/core/src/release-watch.ts:58-90`
    and `cli-version.ts:21-67`;
  - JSON written atomically: `packages/core/src/config/files.ts` `writeAtomic` (as used at
    `auth.ts:132`);
  - live work: `apps/desktop/src/updater.ts:350-358`;
  - tests: `packages/core/test/release-watch.test.ts:73` (fixture URL), `packages/core/test/cli-version.test.ts`.
- **Tests:**
  - **Launcher** (with a fake `api.mjs` child that exits 0, 75 or 1, or answers health): boot of
    `/app` with no overlay behaves as today; trial promoted; trial rolled back after two failures;
    an unsigned or tampered overlay refused; GC; signal forwarding.
  - **Manager**: a download with a test key pair; a bad signature; `needsImage`; `409 live-work`;
    `whenIdle`.
  - **CLI installer**: an integrity mismatch; out of range; not newer.
  - **Routes**: owner-only.

### `image-release` (opus)

1. **Dockerfile** (`docker/Dockerfile`):
   - the D6 pins and digests;
   - `COPY --chown=root:root` with `--chmod=0444` (files) and `0555` (dirs) for `/app/*.mjs`,
     `/app/web` and `/app/node_modules`, after checking with `grep -rn "'/app" packages apps` that
     nothing writes under `/app` at run time;
   - `COPY` `launcher.mjs` (root, 0444) and `docker/keys/*.pub` to `/app/keys` (root, 0444; the
     `COPY` must tolerate an empty dir, so keep a `README` in it and copy `*.pub` with a glob that may
     match nothing);
   - build `/app/image.json` in the build stage with `server-bundle.mjs --image-json` and copy it
     root-owned;
   - `ENV PATH=/data/cli/current/bin:/home/node/.local/bin:$PATH` and
     `CLAUDIO_GUARD_ENTRY=/app/guard.mjs`;
   - `CMD ["node", "/app/launcher.mjs"]`;
   - a stage `server-bundle` (from `build`) that runs `server-bundle.mjs` into `/out`, and a
     `FROM scratch AS bundle-export` stage that holds only `/out`.
2. **Entrypoint**: unchanged except the comment; it still `exec`s the CMD, now the launcher.
3. **Healthcheck**: unchanged logic. Its comment says the launcher is the server's parent, and that
   ending the server makes the container exit unless an update asked for the restart.
4. **CI** (`.github/workflows/server-bundle.yml`, called from `release.yml`'s release path like
   `desktop.yml`, with `publish` depending on it):
   - `docker buildx build --target bundle-export --output type=local,dest=out`;
   - download the previous release's manifest for `minImage`;
   - sign in a step with `environment: release` and `CLAUDIO_BUNDLE_SIGNING_KEY`, verify with
     `docker/keys/*.pub`, attest with `actions/attest-build-provenance`;
   - `gh release upload --clobber` while the release is a draft (the guard at `desktop.yml:66-71`).
   - Without the secret the job **fails** on a release tag: never publish unsigned.
5. **Helm**: `values.yaml` comments on probes (the 60 s trial fits 30 × 3) and on `claude.existingSecret`
   (ANTHROPIC_API_KEY; CLAUDE_CODE_OAUTH_TOKEN still read, for headless use).
- **Patterns:**
  - attaching to a draft: `.github/workflows/desktop.yml:62-80`;
  - a reusable workflow call with permissions: `release.yml:66-75`;
  - a pinned tarball checked twice: `Dockerfile:47-62`.
- **Checks**:
  - `docker build` locally;
  - `docker run --rm -p 127.0.0.1:18797:8797 <image>`: it boots `/app`, prints the first-run block
    once access-core is merged, and `/api/health` answers;
  - `docker run … --entrypoint id <image>`, and `stat /app/api.mjs` shows root;
  - `claude --version` reports 2.1.302, `glab --version` 1.123.0, `tailscale version` 1.104.1.

### `web-signin` (opus)

Build [The Claude sign-in panel](#the-claude-sign-in-panel-assistant-settings-accounts),
[The setup assistant's layout](#the-setup-assistants-layout),
[Settings → Claude Code](#settings--claude-code--sign-in), [Accounts](#accounts-page) and
[Status bar](#status-bar-and-the-phones-more-sheet).

- **Patterns:**
  - the waiting box: `apps/web/src/pages/accounts/AddAccountDialog.tsx:26-87`;
  - a mutation with toasts: `apps/web/src/pages/config/SignInSection.tsx:46-62`;
  - a container query on provider rows: `apps/web/src/styles/integrations.css:286-300`;
  - the assistant's steps and foot: `apps/web/src/components/setup/SetupAssistant.tsx:75-205`;
  - tests: `apps/web/test/setup.test.tsx:126-142`, `apps/web/test/account-list.test.tsx`.
- **Tests:**
  - the panel offers Claude account first and API key second, and never a token;
  - the env-token note;
  - the expired state;
  - the default absent from Accounts when the API leaves it out;
  - the status bar reading `inUse`;
  - `en`/`es` parity (the existing i18n test).
- **e2e specs (CI runs them)**:
  - `e2e/specs/setup.spec.mjs`: the Claude step signs in with the fake `auth login` and pastes a code;
    the foot is visible at 1280×720 without scrolling.
  - `e2e/specs/accounts.spec.mjs`: no `default` on a fresh data dir; adding a login account.

### `web-access-updates` (opus)

Build [The Terminal card](#the-terminal-card-and-its-refusals),
[The Updates card](#the-updates-card-in-a-container),
[The first-run token screen](#the-first-run-token-screen) and
[Host refused](#the-host-refused-screen-and-the-421-page).

- **Patterns:**
  - the busy dialog and progress bar: `apps/web/src/pages/config/UpdatesCard.tsx:259-306`;
  - the auth challenge store: `apps/web/src/lib/auth.ts:64-80`;
  - the sign-in screen: `apps/web/src/components/SignIn.tsx:14-75`;
  - reason keys: `apps/web/src/components/terminal/terminal-model.ts:54`;
  - `ApiRequestError.code`: `apps/web/src/api.ts:326-346`;
  - tests: `apps/web/test/terminal-model.test.ts`.
- **Tests:**
  - `terminalRefusal` for every reason and for an `ApiRequestError`;
  - the toggle reverting;
  - each Updates state rendered from a `ServerUpdateStatus` fixture;
  - the `421` branch of `request()` sets the store;
  - `HostRefused` with and without `canClaim`;
  - the first-run copy.
- **e2e specs (CI runs them)**:
  - `e2e/specs/security.spec.mjs`: an unlisted host shows Host refused and the claim adds it.
  - `e2e/specs/terminal.spec.mjs`: a `needs-auth` refusal shows the sentence and the link, not the
    server's text.
  - `e2e/specs/updates.spec.mjs`, with `CLAUDIO_DISTRIBUTION=docker`, `CLAUDIO_LAUNCHER=1`,
    `CLAUDIO_BUNDLE_KEYS_DIR` and `CLAUDIO_RELEASES_URL` pointed at fixtures: available → download →
    verifying → ready, and the busy dialog on live work (never apply: it would end the e2e server).

### `review` (opus)

Review the merged design, not just the diff:

- the one rule: only `claude auth login`, `get_usage` and the registry's documented package; no
  scraping;
- D1–D7 as written;
- the denylist covers every new route;
- the launcher never trusts `state.json` paths;
- `/app` ownership;
- the copy against the glossary;
- gradient count, status colours and mono use on every changed screen.

It reads the screenshots the web tasks attached. It runs at most one test. Findings go to the
integrator, with file:line and the smallest fix.

### `docs` (sonnet)

- **Remove the OAuth token** as the recommended path everywhere the [Context](#context) lists it.
  `docker run` and compose examples start with no Claude variable and say "open Claudio, sign in
  with the token from the log, then sign in to Claude in the setup assistant".
- **`docs/configuration.md`**: `CLAUDE_CODE_OAUTH_TOKEN` is documented once there as headless and
  legacy, along with the new variables and `auth.mode: auto`.
- **`docs/deploy.md`**: the first-run token, the migration, the 421 screen and claim, the terminal
  in a container (replace `:244-250`), and in-app updates with their limits and rollback.
- **`docs/updates.md`** (new): the feature.
- **Three decision records**, one per D1, D3 and D4, in the knowledge base's format.
- **`docs/cli-surfaces.md`**: rows for `auth login` on the default dir and the npm platform package.
- **`docs/status.md`**: the plan row.
- **This plan's Outcome**.
- Use the `write-knowledge-doc` skill.

### Owner actions before the merge

Done on 2026-10-18, at the owner's request, by the session that wrote this plan:

1. The signing key was generated with `openssl genpkey -algorithm ed25519`; its public half is
   committed as `docker/keys/claudio-bundle-2026.pub`, and the private half left with the owner to
   keep in their password manager.
2. The private key is the secret `CLAUDIO_BUNDLE_SIGNING_KEY` of the GitHub Environment `release`,
   whose deployment branch policy allows `main` only. The bundle job must run in that environment.

The owner also confirmed D3's one-time migration of 0.6.x containers running with auth `none`.

Without a key the image would have none, so `unsupportedReason: 'no-keys'` and the card shows host
commands. The release job refuses to publish an unsigned bundle.

## Tests

Unit and API tests are listed per task above. Across the graph:

- **Verification** (the integrator, on the merged branch):
  - `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm --filter @claudio/api openapi:schemas` (no
    drift);
  - `docker build`, then a container run through: first-run block → sign in with the token from the
    LAN address → Host refused → claim → the setup assistant → Claude account sign-in with the real
    CLI → a chat → the terminal opens → the Updates card says `no-keys`, or with a test key and a
    local bundle served through `CLAUDIO_RELEASES_URL`: download → restart → rollback by serving a
    bundle whose `api.mjs` exits 1.
- **e2e** (CI, `pnpm e2e:remote setup accounts security terminal updates`): the specs listed under
  the web tasks. The `e2e-specs` task Claudio adds at the end of the graph fixes any spec the work
  left stale.

## Facts from the owner's test

The owner tested the 0.6.0 image on 2026-10-18 over the LAN (`http://192.168.0.30:18797`,
`CLAUDIO_AUTH_MODE=token`, `CLAUDIO_ALLOWED_HOSTS` set). They confirm D3.

- **The only way past the gate** was a `PUT /terminal/settings` with `remote: 'any'` made from
  inside the container. The browser's own `PUT` was refused `needs-tunnel`, because the gate judges
  a change of `remote` under the current `remote`.
- **With `remote: 'any'` the terminal works end to end**:
  - the bottom dock opened "Conectado node@<container>:/workspace";
  - `ls -l` and `pwd` ran with correct output;
  - the history row recorded `token:env`, `/workspace`, "En marcha";
  - the card showed "Desde otros dispositivos: También por la red local" with the warning "Cualquier
    dispositivo que llegue a esta dirección con un token puede abrir un shell en este equipo".

  So `node-pty`, the WebSocket, the tickets and the Origin check all work in the image.
- **What is wrong is the gate's policy and the UI around it**:
  - the refusal showed as raw English server text under "La petición ha fallado";
  - the toggle failed;
  - there is no way in the UI to choose "Where it opens" before turning the terminal on: the `Select`
    sits inside `SettingsReveal open={settings.enabled}` (`TerminalCard.tsx:176-185`).

  D3's docker default (`any`) removes the chicken-and-egg in a container. The card change below
  covers the rest.
- **The status bar still said "Sin sesión iniciada"** while a terminal and a chat worked: the
  default-account issue of D2.

**Consequence for the Terminal card** (task `web-access-updates`):

- The "Where it opens" `Select` moves **above** the `SettingsReveal`, so it can be chosen before the
  switch is turned on.
- A refused change of it shows the translated reason inline, like the toggle does.
- Outside a container, raising `remote` from another device stays refused by design: the gate must
  not let a remote caller widen its own access. The sentence for `needs-tunnel` says to change it on
  this machine or through the tunnel.

## Risks

- **The spike's answer.** If `get_usage` cannot tell a refused credential, validation is limited to
  runs and the paid on-demand message (D1's "if not" branch). The plan holds either way.
- **A launcher bug strands containers.** It is the one part an update cannot fix. Mitigations: small
  size, the plain-image path tested first, unit tests with a fake child, and the container-level
  rollback run before merge.
- **The one-time migration surprises LAN users** of 0.6.x with a token screen. Mitigations: the
  first-run screen, the release note, and `CLAUDIO_AUTH_MODE=none` to opt out.
- **Root-owned `/app` breaks something that wrote there.** The image task greps first, and the
  container run checks a chat, the terminal and Collaborators.
- **`imageInputs` is conservative**: a CLI pin bump forces a new image for in-app updates. Accepted
  for now; refine to the runtime stage minus `ARG CLAUDE_CODE_VERSION` later.
- **Three tasks touch `types.ts`, `routes.ts`, `rest-api.md` and the generated schemas.** They append
  in separate places, and the integrator regenerates the schemas once after merging.
- **glab 1.123** may change output the adapters parse; D6 has the worker read the notes.

## Open questions

None for the owner: the signing key is in place and the migration confirmed
([owner actions](#owner-actions-before-the-merge)). The spike in `signin-core` settles D1's branch.

## Outcome

Written by the `docs` task on 2026-10-18, from the results of the eight tasks before it. The seven
rough edges are built on their branches and merged into one; **the container run that proves them is
the integrator's** and had not happened when this was written. Nothing is pushed.

### What was built

- **D1, D2 (`signin-core`, `web-signin`).** The paste-code `claude auth login` is the first method
  everywhere one signs in, with an API key second and no OAuth token (`ClaudeSignIn`, one panel for
  the assistant, Settings and Add account). The assistant and Settings sign in to `default`
  (`POST /accounts/default/login`); a success clears a vault token. `default` is hidden while it has
  no credential; `GET /auth` carries `inUse`, which Settings, the status bar and the More sheet read.
  An unfinished login ends as `expired` after 15 minutes. The old token routes still answer, deprecated.
- **D3, D5 (`access-core`, `web-access-updates`).** A docker start with no auth variable makes an owner
  token, prints it once and keeps `/data/first-run-token` until first use; a 0.6.x `none` install is
  migrated once. The terminal's `remote` defaults to `any` in a container. The `421` carries a code, the
  host and `canClaim`, a browser gets an HTML page, the app shows Host refused, and
  `POST /security/allowed-hosts/claim` adds the host for an owner. Helm's `auth.mode: auto` is the
  default. `CHAT_FORBIDDEN_SYSTEM` lists every new owner-only route.
- **D4 (`update-core`, `image-release`, `web-access-updates`).** The launcher
  (`packages/core/src/launcher`), the overlay manager and the CLI installer, the server-update and
  CLI-install routes, `server-bundle.mjs`, a root-owned `/app`, the `server-bundle` release job that
  signs with the `release` environment's key, and the Updates card in a container. Feature:
  [updates.md](../updates.md); decision: [container-in-app-updates.md](../decisions/container-in-app-updates.md).
- **D6.** Claude Code 2.1.302, glab 1.123.0, Tailscale 1.104.1; gh stays 2.102.0. The image built with
  those checksums.
- **D7 (`web-signin`).** The assistant is a full-height frame with a pinned foot, two columns from
  1180 px and rows laid out by container queries; `design-system.md` §Setup, `claudio-ds.css` and the
  seven reference screens were regenerated.
- **Docs.** The stale claims listed in Context are corrected in `README.md`, `.env.example`,
  `deploy.md`, `setup.md`, `providers.md`, `configuration.md`, `terminal.md`, `accounts.md`,
  `cli-surfaces.md` and `security-model.md`; `updates.md` and three decisions are new
  ([claude-sign-in-paste-code](../decisions/claude-sign-in-paste-code.md),
  [container-owner-token](../decisions/container-owner-token.md),
  [container-in-app-updates](../decisions/container-in-app-updates.md)); `in-app-setup.md` and
  `app-updates.md` carry a dated note. The start-up warning in `apps/api/src/server.ts` and the
  comments in `deploy/helm/claudio/values.yaml` were changed by the code tasks.

### Where it differs from the plan

- **The spike answered "if not".** On CLI 2.1.302 `get_usage` answers the same for a bad OAuth token, a
  bad API key, no credential and a down network, so it only **confirms** a credential (`checkedAt`,
  clears `expired`) and never refuses one. `checkCredential` returns `valid` or `unknown`. **Check** in
  Settings is **Send a test message** and calls the paid `POST /auth/verify`; the free
  `POST /accounts/:id/refresh` is the confirm-only check and answers `502 accounts.check-failed` when
  the CLI could not run. Fixtures: `packages/accounts/test/fixtures/get-usage-refused-*.json`.
- **The terminal refusal has no "Allow from any device" button.** A change of `remote` made from the
  refused device is judged by the same gate and refused again, so the button could never work. Only the
  **Open the tunnel** link remains for `needs-tunnel`. The plan's table above is corrected.
- **`CLAUDIO_SERVER_UPDATE=off` reports `unsupportedReason: 'no-launcher'`**, as the contract's list has
  no `off` value.
- **A downloaded update applies at the next restart of any kind**, because the plan sets the trial at
  download time. Only the newest release can be downloaded. An update with extra files or symlinks is
  refused.
- **`/app`'s root-owned list also covers `entrypoint.sh` and `healthcheck.sh`**, which an agent could
  otherwise rewrite to change what runs at start.
- **`exclusiveVariables('claude-code')` is hard-coded** to the OAuth/API-key pair, so a token Claudio
  keeps in the vault still hides the container's key and the reverse.
- **New error code `cli.no-version`** (400) when no newer CLI version is known.
- **The assistant's breakpoint stays at the app's 900 px**, not 720, so the medium layout runs from
  900 to 1179 px.
- **Outside the owners' file lists:** `e2e/run.mjs` and `apps/api/test/setup.test.ts` set
  `CLAUDIO_AUTH_MODE=none` (the docker distribution would otherwise hit the first-run token);
  `packages/core/src/index.ts` got the two first-run audit wirings; four web and chat-ui test fixtures
  got `checkedAt: null` / `accountLogin: false`; `shell.css` and `editors.css` got phone rules for the
  Updates card, selected by `data-testid` so the class-inventory test stays green.

### Not done, or not checked

- **Not run anywhere yet:** `helm template` (`helm` was not installed on the workers' machine, so the
  `auto` and `none` renderings and `NOTES.txt` were never rendered), `actionlint`, the `server-bundle`
  workflow, a launcher rollback in a real container, and the e2e suite (CI runs it). The first-run block
  was seen in a real container on 2026-10-18 (see Review fixes).
- **glab 1.121–1.123 release notes** were not read, so whether they change what the adapters parse is
  unknown; nothing was re-recorded. gh was not re-checked for a newer version on the day.
- **Flows with no e2e:** the Claude step signing in through the assistant (the fake CLI already reads as
  signed in, so the row has no Sign in button), the Host refused screen (a browser cannot dial another
  name), and the whole update flow (download, verifying, ready, busy dialog, rollback), which needs a
  launcher, a key and a signed bundle in `e2e/run.mjs`. `updates.spec` only checks the card says the
  container has no launcher.
- **Review leftovers, not blocking:** the Copy link button widens to "Copied"; the row's Sign in stays
  visible beside the panel's own and has no `aria-expanded`; the reviewer saw only the signed-out Settings state (no screenshots of account in use,
  expired or sign-in success); axe reports `region` on the Radix tooltip wrappers app-wide; the setup
  screen overflows by 16 px on a fresh data dir; the inline terminal refusal shifts layout (CLS 0.02).
- **Flaky under load:** `orchestrator.test.ts`, a device sign-in expiry test and "a chat process that
  stays caught exiting…" failed once in full runs and pass alone.
- **Integrator:** regenerate the OpenAPI schemas once after merging (three tasks touch them), and the
  web fixtures (`strings.json`, `module-graph.json`, `class-names.json`) if later merges change them.

### Review fixes (2026-10-18)

The orchestration's review, applied on `fix/container-polish-review`:

- **The image did not build.** `server-bundle.mjs` rejected `--claude-code` and `--commit`, and the build
  stage had no `docker/` for `imageInputs`. Both are fixed; the commit reaches a Docker build as
  `--build-arg CLAUDIO_COMMIT=…` (the context has no `.git`). The image was then built and run: healthy,
  the first-run block in `docker logs`, `/api/health` answering, the token accepted and its file gone.
- **The free check** (`get_usage`) of the account in use ran on every provider refresh for a credential
  it cannot confirm (an API key, a variable), because the 30 minutes were measured from `checkedAt`. The
  last attempt is now kept in memory per account; a credential change resets it.
- **A Claude-account sign-in on `default` also removes a saved API key** (owner decision), which would
  otherwise keep precedence over the new login; the panel warns before it starts.
- **`AuthConfig.firstRunToken`** says the token set is still the first-run one, so the assistant's Access
  step shows "Claudio made this token the first time it started…".
- **The launcher refuses a trial that is not newer than the active overlay.**
- The `remote-off` refusal has no action, for the reason the table above gives.

### Known limits

- **The agents' user can edit `/data/app/state.json`.** It can point `trial`, `active` or `previous` at
  any overlay already in `/data/app`, or clear them. What boots is still an overlay whose manifest is
  signed by a key in `/app/keys`, whose files match it, and which is newer than the image (and a trial
  newer than the active one), so the worst it can do is pick between signed releases newer than the
  image, or fall back to the image.
- **Between the check and the boot.** The launcher verifies an overlay's files, then starts `node` on
  them. The agents' user owns `/data`, so it could replace a file in that window; the check is not a
  lock. Closing it needs the overlay copied somewhere the agents cannot write, which `/data` is not.

## Related

- [[plans/in-app-setup]]
- [[plans/app-updates]]
- [[plans/terminal]]
- [[plans/rotation-auth-fixes]]
- [[plans/settings-ia]]
- [[plans/claudio-designer]]
- [[orchestrations]]
- [[deploy]]
- [[setup]]
- [[providers]]
- [[cli-surfaces]]
- [[terminal]]
- [[accounts]]
- [[security-model]]
- [[design-system]]
- [[updates]]
- [[decisions/get-usage-control-request]]
- [[decisions/claude-sign-in-paste-code]]
- [[decisions/container-owner-token]]
- [[decisions/container-in-app-updates]]
- [[decisions/e2e-on-github]]
