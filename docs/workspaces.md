---
created_at: 2026-10-29T12:00:00Z
updated_at: 2026-10-29T12:00:00Z
tags:
    - workspaces
    - api
    - security
    - headless
---
# Workspaces: a read-only copy of a source tree, for one program's chats

A workspace is a copy of a source tree that a program hands Claudio as a `tar.gz`, so its chats can
read the code without sharing a filesystem with that program. It is reached only by its id, it is
read only, and it is gone two hours after its last use. It is what lets one headless Claudio serve
one project ([deploy.md](deploy.md#headless-next-to-a-project)); it works the same in the full
profile. Decided as D7 of [the headless plan](plans/headless-image.md) (2026-10-28), for shipcast,
whose design reaches Claudio over `/api/v1` and `/api/workspaces` only.

## Creating one

`POST /api/workspaces` takes the archive in one of two ways:

```bash
# Claudio downloads it: an https URL on an allowed host
curl -X POST "$CLAUDIO/api/workspaces" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://codeload.github.com/owner/repo/legacy.tar.gz/refs/heads/main?token=…"}'

# Or the archive is the body
git archive --format=tar.gz HEAD | curl -X POST "$CLAUDIO/api/workspaces" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/gzip' --data-binary @-
```

The answer is `201` with the `Workspace`: `id` (`ws_` and 16 random characters), `source` (`url` or
`upload`), `host` (the URL's host, never the URL), `bytes`, `files`, `createdAt`, `lastUsedAt`,
`expiresAt` and `state` (`creating`, `ready`, `removing`). Its folder is never returned.
`GET /api/workspaces/:id` reads it; `DELETE /api/workspaces/:id` stops the chats running in it, waits
up to 10 s for them to exit, removes it and answers `204`. The routes are in
[rest-api.md](rest-api.md); the code is `packages/core/src/workspaces/` and
`apps/api/src/routes/workspaces.ts`.

### A URL

- `https` only, on a host of `CLAUDIO_WORKSPACE_HOSTS` (`codeload.github.com` by default). A program
  that reads a private GitHub repository resolves GitHub's `/repos/{o}/{r}/tarball/{ref}` redirect on
  its own side and passes the `codeload` URL, so no GitHub token ever reaches Claudio.
- At most three redirects, each to an allowed host.
- Every address the name resolves to must be public. The check is the image fetcher's
  (`guardedLookup` in `packages/core/src/openai/fetch-image.ts`) applied at DNS lookup, so a name
  that rebinds to a private address between two lookups is still refused.
- The URL carries the code host's short-lived token, so it is never logged, stored, put in an error
  or in an event: the row keeps the host alone, and errors name the host at most.

### A body

`Content-Type: application/gzip`, read as a stream by a parser of the route's own (no other route
takes gzip), never held whole in memory. A `Content-Length` over the compressed cap is refused before
reading; otherwise the bytes are counted as they come.

## Extraction

Claudio reads the tar itself, over `node:zlib` (`packages/core/src/workspaces/tar.ts`), rather than
the `tar` package or GNU `tar`, whose safety depends on filters, flags and version. It reads ustar,
PAX and GNU headers, which is what GitHub and `git archive` produce. Each entry is judged by its final
name, after PAX and GNU long names are resolved, before a byte of it is written. The archive is
refused whole (`400 workspace-bad-archive`) for:

- a symlink, a hard link, a device or a FIFO: only regular files and directories;
- an absolute path, a `..`, or a name that leaves the folder once normalised;
- a path component named `.git`, in any letter case: no history is needed, and a hostile
  `.git/config` would make git run its programs;
- a name that repeats, a damaged header, a truncated archive or a body that is not gzip.

When the archive holds one top-level directory (GitHub's `owner-repo-sha/`), chats run in that
directory. Files are written `0444` and directories `0555`. That is a hint only, since the agent's
user owns them: read-only comes from the confined chat, which cannot declare a write tool in a
workspace, and from the guard.

## Caps

Set from the environment ([configuration.md](configuration.md#workspaces)); over any of them nothing
is left on disk.

| Cap | Default | Refusal |
| --- | --- | --- |
| Compressed | 100 MB | `413 workspace-too-large` |
| Extracted, counted as bytes are written | 500 MB | `413 workspace-too-large` |
| Entries | 50 000 | `413 workspace-too-large` |
| Every workspace together under the root | 2 GB | `413 workspace-too-large` |
| Download and extraction | 60 s | `408 workspace-timeout` |
| Workspaces at once, the ones being created included, reserved before the download starts | 20 | `429 workspace-limit` |

Other refusals: `400 workspace-host-not-allowed`, `400 workspace-address-blocked`,
`502 workspace-download-failed`, `404 workspace-not-found`, `410 workspace-expired`, and `409` for a
`DELETE` while the workspace is still being created. A `DELETE` of one already removed answers `204`.

## Using one

A chat names a workspace by its id, and only so:

- `POST /api/chats` with `workspaceId` (and no `cwd`);
- on `/v1`, the header `X-Claudio-Workspace` ([openai-compatible-api.md](openai-compatible-api.md)).

A chat in a workspace is a **confined API chat**, in every profile
([security-model.md](security-model.md#the-confined-api-chat)): it runs the tools it declared, read
only, with no settings of the repository applied, no MCP server and no way back into Claudio, behind
the `declared-tools` guard ([guards.md](guards.md#declared-tools-the-confined-api-chat)). No `cwd`,
`X-Claudio-Cwd` or project path may be, or hold, a folder under the workspaces root (`400`), so
nothing reaches a workspace as an ordinary chat would.

An unknown id is `404 workspace-not-found`; an expired or removed one, or a chat continued after its
workspace went, is `410 workspace-expired` (`workspace_not_found` and `workspace_expired` on `/v1`).

## Lifetime and storage

- Each workspace is a row of the `workspaces` table (`packages/core/src/db.ts`), since workspaces are
  records that come and go. A removed one keeps its row 30 days with `removed_at`, so its id answers
  `410` rather than `404`.
- The TTL (2 h) counts from the last use: each chat started in it moves `lastUsedAt` and `expiresAt`.
- A sweeper runs at start and every 5 minutes. It removes expired workspaces whose chats have ended,
  creations a stopped process left half done, and, at start only, `ws_*` folders under the root that
  no row knows. It never touches anything outside the root.
- The root is `CLAUDIO_WORKSPACES_DIR`: `/workspaces` in the image, a `workspaces` folder beside the
  data directory elsewhere, so the desktop app and a dev server never sweep each other's. The start
  refuses a root that overlaps the default working directory, the data directory or the CLI's config.
  The image does not keep it on a volume: a workspace is a copy.

## Not done

- No test runs against a real GitHub tarball, and the caps were not measured against a large real
  repository: tests have no network. The plan leaves that check to the owner, by hand.
- No test captures Fastify's logs looking for the URL; it holds by construction (no error carries it,
  the audit does not store the body).

## Related

[[plans/headless-image.md]] · [[decisions/confined-api-chat.md]] · [[security-model.md]] · [[guards.md]] · [[openai-compatible-api.md]] · [[rest-api.md]] · [[configuration.md]] · [[deploy.md]]
