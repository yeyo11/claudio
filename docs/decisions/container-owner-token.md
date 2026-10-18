---
created_at: 2026-10-18T20:00:00Z
updated_at: 2026-10-18T20:00:00Z
tags:
    - decision
    - docker
    - security
    - terminal
    - authentication
---
# Decision: a container makes an owner token on its first start, and the terminal follows

Taken by the owner on 2026-10-18. In the image every request reaches the server from the Docker
bridge, never from loopback, so the terminal could not be used: with auth `none` it answered
`needs-auth`, and with a token and the default `remote: 'tunnel'` it answered `needs-tunnel`. The
owner got past it only by saving `remote: 'any'` from inside the container, and then the terminal
worked end to end (`node-pty`, the socket, the tickets and the Origin check were all fine).

## Decision

- **The image makes an owner token on first start** when `CLAUDIO_DISTRIBUTION=docker` and none of
  `CLAUDIO_AUTH_MODE`, `CLAUDIO_AUTH_TOKEN`, `CLAUDIO_OIDC_ISSUER` is set. It is generated like
  `POST /security/token`, stored as a hash (`tokenId: 'first-run'`), printed once in a framed block in
  the container's log and kept in `/data/first-run-token` (0600) until the first request it
  authenticates; rotating it deletes the file too. The sign-in screen says where to find it while it is
  unused (`firstRunToken` on the `401`).
- **Existing 0.6.x containers saved as `none` are migrated once**, on the first start of the new
  image, and never again (`generatedAt`). Exceptions: a person who later chose **None** in Settings
  (`noneChosenAt`), and `CLAUDIO_AUTH_MODE=none` in the environment, which is respected and logs that
  the terminal and updates need a token. Rejected: leaving them open. Under `none` the terminal and
  in-app updates cannot work, and every LAN device already drives chats in `bypassPermissions` with
  no credential.
- **Helm.** `auth.mode: auto` is the new default and writes no `CLAUDIO_AUTH_MODE`; `NOTES.txt` points
  at `kubectl logs`.
- **In a container `remote` defaults to `any`.** `terminalDefaults(distribution)`; a value saved in
  `terminal.json` still wins, and the gate itself is unchanged. This is safe because in a container
  no request is ever "this machine" (so `'tunnel'` made the terminal unusable rather than safer);
  the owner token already starts chats in `bypassPermissions`, which run any command as `node`, so the
  terminal adds no capability to its holder; and everything else holds (a chat's token and the desktop
  credential are refused, Origin check and one-time tickets unchanged, read-only closes it, `none`
  still answers `needs-auth`, the card keeps its warning). Rejected: a `published-port` value (a
  knob for one case), and trusting the bridge gateway as local (it would let any container on the
  bridge in).
- **An unlisted host gets a page a person can act on.** The `421` carries `code: 'host-not-allowed'`,
  `host`, `mode`, `canClaim` and `firstRunToken`; a browser `GET` gets a plain HTML page; the app
  shows a Host refused screen. `POST /security/allowed-hosts/claim` is the one route the host check
  lets through: it adds the dialled host to the Settings layer of the allowlist, for an owner
  credential only, and a rebinding page cannot hold the bearer token. Rejected: answering every host
  when a token is presented without recording it (the allowlist would stop being a list).
- **Every refusal is shown translated, with its fix**, never the server's English text.

## Consequences

- A 0.6.x LAN user sees a sign-in screen once after upgrading; the release notes and the screen carry
  it. `CLAUDIO_AUTH_MODE=none` opts out, and `CLAUDIO_AUTH_TOKEN_RESET` stays the recovery path.
- The token is in the log once; shipping logs elsewhere is the operator's to weigh.
- The terminal card no longer offers a button to widen *Where it opens* from a refused device: the
  change would be judged by the same gate and refused again. It links to the tunnel instead.

## Related

[[deploy.md]] · [[terminal.md]] · [[security-model.md]] · [[configuration.md]] · [[plans/container-polish.md]] · [[plans/terminal.md]]
