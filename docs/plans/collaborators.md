---
created_at: 2026-10-16T12:00:00Z
updated_at: 2026-10-17T15:30:00Z
tags:
    - plan
    - collaborators
    - peer-to-peer
    - iroh
    - sharing
    - security
    - proposed
---
# Plan: Collaborators — teammates' Claudios share their projects, peer to peer

Several people on a team each run their own Claudio, each with their own clone of the same repository.
Today none of them can see what the others' agents learnt, decided or wrote. This plan lets a
person **share a project with a group of collaborators**. Each collaborator's Claudio then holds a
**synchronised, read-only copy** of that project's chats, memory and journal, documents and
artifacts, and board. The copy updates **live** while both machines are on. There is **no server of
our own**: the Claudios connect directly over [iroh](https://iroh.computer).

Status: **settled** on 2026-10-16. Proposed by the owner that morning, revised the same day after an
adversarial review (§10), and **§5 validated by the owner as written** that evening, together with
the decisions listed at the top of §8. The agent table is in §7.1. **C0 is complete** (§7.2): proved on this machine,
in Electron and in the Docker image, between two machines on the LAN, and between this machine and
the owner's work PC on a phone hotspot. The orchestration can be launched. Branch `docs/collaborators-plan`
from `main` at `a13525b3c`.

Facts about the code were verified on 2026-10-16 against `a13525b3c`. Facts about iroh were checked
the same day against its official docs and the typings of its Node binding, and are listed with
sources in §9. What is still unchecked is what stage C0 (§7) is for, and is marked as such.

## Contents

1. [What the owner asked for](#1-what-the-owner-asked-for)
2. [Ground rules](#2-ground-rules)
3. [Architecture](#3-architecture)
4. [Data and protocol](#4-data-and-protocol)
5. [The design (validated 2026-10-16)](#5-the-design-validated-2026-10-16)
6. [API](#6-api)
7. [Stages](#7-stages)
8. [Decisions taken and rejected](#8-decisions-taken-and-rejected)
9. [Sources](#9-sources)
10. [Review of 2026-10-16](#10-review-of-2026-10-16)
11. [Outcome](#outcome)

---

## 1. What the owner asked for

These are the owner's own answers, given in Spanish on 2026-10-16:

- **Read only, never delegation.** "Yo no podré mandar tareas a mi compañero … pero yo no puedo
  gastar cuota de otro compañero." A collaborator sees; nobody starts work on another person's
  machine. Serving a copy never invokes Claude, so **no one's quota is spent**.
- **Peer to peer, not anonymity.** "Onion" in the first request meant P2P. Tor-style anonymity is
  out of scope.
- **Not on a shared LAN.** Teammates may share a Tailscale tailnet, but the feature must not need
  one.
- **iroh** is the transport, chosen over Tailscale (see §8).
- **Synchronised copy and live**, both.
- **Sharing is chosen per project.**
- **Group management, and the whole feature is optional**: it is off until the person turns it on.
- **Name:** *Collaborators* (`es`: *Colaboradores*). "Team" already means a project's team of agents
  ([team-and-flow.md](../team-and-flow.md), `packages/core/src/team.ts`, `/?view=team`).
- **Membership:** a group with someone in charge, who signs the member list (§3.3).
- **What is shared:** memory and journal, chats, documents and artifacts, the board. All four.
- **Secrets:** transcripts are shared **as they are**, tool outputs included. The group is trusted.
  The UI says plainly that what has been shared cannot be unshared.

## 2. Ground rules

- **The one rule holds.** Claude is still reached only through its CLI. iroh connects Claudio to
  Claudio and never touches an agent. The serving side reads what Claudio already stores (its SQLite,
  the transcripts and memory files the CLI writes). It has **no access** to anything that starts a
  chat, a run, a flow or an orchestration. That is enforced by construction, by a lint rule and by a
  test (§3.5).
- **Settings-shaped documents go in JSON** (identity, the signed roster chain, per-project sharing).
  **Synchronised and accumulating records go in SQLite** (`packages/core/src/db.ts`), as rows. The
  roster chain is the one judgment call: it grows by one small signed version per group change, which
  is rare, and it is a document peers exchange whole, so it stays JSON.
- **Optional, and soft.** With Collaborators off, no iroh endpoint is bound, no UDP socket is opened,
  nothing is published to discovery, and the native module is not even loaded. A machine where the
  module cannot load (§3.2) runs Claudio exactly as before, with Collaborators greyed out and the
  reason shown.
- **Night Shift** ([design-system.md](../design-system.md)) for every screen. Copy goes through
  i18n with `en`/`es` parity, and every new Spanish term enters `apps/web/src/i18n/GLOSSARY.md` in the
  same change. **English** for everything technical.
- The dependency direction `apps/web → @claudio/chat-ui → @claudio/ui → @claudio/shared` holds.
- **Nothing here is enforced on another person's machine.** Every peer runs its own copy of Claudio,
  so every rule about what a receiver deletes, stops showing or stops serving is **cooperative**: it
  describes what an unmodified Claudio does. The UI never claims more than that (§5.2).

## 3. Architecture

### 3.1 Identity: one key per install

Every Claudio install that turns Collaborators on generates an iroh `SecretKey` once. Its public key,
the **endpoint id**, is the install's address and identity. The secret key goes in the secret vault
(`packages/core/src/secret-vault.ts`, `<dataDir>/secrets.json`, 0600, sealed when a key exists). It
is the first secret in the vault that no CLI reads from its environment; `docs/security-model.md`'s
vault paragraph is updated to say so (C5).

A person running the desktop app and a dev server has **two installs with different data**, so they
are two members, each with its own label. That is the same reason CLAUDE.md gives for never guessing
the API port. Both installs read the same default `~/.claude`, so both would serve the same
transcripts: the receiving side groups what it shows **by person** (display name), with the install
label beside each copy, and a chat present from two installs of the same person is listed once, from
the install seen most recently.

The person sets a **display name** that travels with every roster entry.

### 3.2 Transport: iroh, through its official Node binding

- **Package:** `@number0/iroh` (napi-rs, prebuilt, Node ≥ 20.3), from iroh 1.x. Its wire protocol
  is stable across every 1.x release. Platforms with a prebuild: Linux x86_64 and aarch64 (glibc and
  musl), Linux armv7, Windows x86_64 and aarch64, macOS **arm64 only**, Android. There is **no macOS
  Intel build**: on such a machine the module fails to load and Collaborators stays off with the
  reason "Not available on this platform" (§2, soft).
- **Loading:** the module is a lazy `import()` behind the on/off switch, never a top-level import of
  `@claudio/core`. A load failure is caught, logged once, and reported in `GET /collaborators` as
  `unavailable: { reason }`. C0 proved the failure is catchable (§7.2).
- **Its own process.** The endpoint runs in a **child process**, `collab-host.mjs`, forked by the core
  the way `terminal-host.mjs` is for node-pty (`packages/core/src/terminals/host-client.ts`, `fork`
  with `serialization: 'advanced'`), with a small IPC protocol: the API process never loads the native
  module. The reason is a C0 fact: in `@number0/iroh` 1.1.0 every `watch*` method **aborts the whole
  process** with a Rust panic that no `try/catch` sees. A panic in the host loses the connections and
  nothing else; the core restarts it and reports it. The host **polls** (`addr()`, `paths()`,
  `rtt()`, `stats()`) and never calls a `watch*` method, and every promise from the binding is awaited
  inside a `try/catch`, because an unhandled rejection from it (`LocallyClosed`) also ends the process.
- **Bytes cross the binding as `Array<number>`**, never as `Buffer` (rejected with "Failed to get
  Array length"). Converting 4 MiB costs ~0.6 s and caps a loopback stream at 10–42 Mbps (C0). So the
  host writes blobs and transcripts in 1 MiB pieces, keeps frames small, fetches blobs only when
  opened and reports progress; a 50 MB upload takes on the order of ten seconds, which the UI shows.
  An upstream request for `Buffer` support is filed in C1.
- **Packaging** follows node-pty, the one native module Claudio ships today: `external` in the API's
  esbuild bundle (`apps/api/scripts/bundle.mjs:28`), staged beside the bundles by the same script
  (`bundle.mjs:40-45`), and carried into the Electron build through `extraResources`
  (`apps/desktop/electron-builder.yml`). The shell ships no `node_modules` and uses no asar unpacking,
  so that is **not** the mechanism. The Docker image is `node:26-bookworm-slim` (glibc), so the musl
  prebuild is only relevant to someone running Claudio from source on Alpine, which the staging covers
  by copying the prebuild for the build platform.
- **One endpoint per install**, bound when Collaborators is on. Claudio's own protocol is registered
  under the ALPN `claudio/collab/1`, through `EndpointOptions.alpns` (verified in the binding's
  typings, §9).
- **Relays:** n0's public relays by default (`aps1`, `euc1`, `use1`, `usw1`). They are rate-limited,
  and carry the traffic while the direct hole punch has not succeeded. C0 found that across a mobile
  carrier's NAT **it never did** in four runs: a teammate on a phone hotspot or a carrier-grade NAT
  works entirely through the relay, at about 115 ms of round trip and 7–20 Mbps (§7.2). The design
  holds, since nothing depends on a direct path, but the Collaborators page says "Connected through a
  relay" for that peer and the rate limit of the public relays is a reason a team may want its own. A **custom relay URL** setting points the endpoint
  at a self-hosted `iroh-relay` (binary or Docker image `n0computer/iroh-relay`), through
  `EndpointBuilder.relayMode(RelayMode.customFromUrls([...]))` on top of `presetN0`; C0 verified that
  the custom map replaces the default one (§7.2). `online()` never resolves with an unreachable relay
  or with relays disabled, so the host always races it against a timeout and shows "No relay
  reachable" instead of hanging.
- **Discovery:** iroh's default (signed records published to n0's pkarr server, resolved through
  DNS). C0 verified that dialling by **id alone** works through it (§7.2). The binding exposes **no
  discovery configuration**: no mDNS, no custom pkarr or DNS server, neither in the typings nor on
  `EndpointBuilder`. So for v1, **n0's discovery service is a fixed dependency** of the feature and the Settings
  copy says so. Self-hosted discovery and local-network discovery are **C0 questions**, not features
  of this plan; if C0 finds them reachable (through a preset or a newer binding), they become a setting
  in a later stage.
- **What n0 sees:** with the defaults, n0's discovery server learns each endpoint id and its
  addresses, and its relays carry encrypted traffic they cannot read. This goes in the Settings copy.
  A self-hosted relay removes the relay part today; the discovery part only if C0 finds a way.

### 3.3 Groups and the signed roster chain

There is no server to hold who belongs to a group, so the **roster is a chain of signed versions**,
replicated to every member. **One key signs**: the group's **owner**. A single signer is what makes
the chain unambiguous; the plan's own observation that group changes are rare is why it costs
nothing.

```ts
interface RosterVersion {
  groupId: string;          // sha256 of the canonical bytes of version 1 (self-certifying)
  version: number;          // 1 for the genesis version, +1 on every change
  prevHash: string | null;  // sha256 of the canonical bytes of the previous version; null for 1
  name: string;
  owner: string;            // endpoint id that signs this version and the next one
  members: RosterMember[];  // the owner is also listed here, with role 'owner'
  issuedAt: string;
  signature: string;        // Ed25519 by `owner` of the previous version (or by `owner` of this one for version 1)
}
interface RosterMember {
  endpointId: string;
  name: string;             // display name
  label?: string;           // "desktop", "laptop"…
  role: 'owner' | 'member';
  addedAt: string;
}
```

- **Canonical bytes** are RFC 8785 (JSON Canonicalization Scheme) over the version without its
  `signature` field. `groupId` and `prevHash` are sha256 of those bytes, hex.
- **Creating a group** makes its creator the owner, at version 1. The `groupId` is the hash of that
  signed genesis, so no other key can produce a roster for the same `groupId`: a peer verifies any
  chain from its genesis alone, without having to trust who handed it over.
- **Verifying a chain**: version 1 is signed by its own `owner` and hashes to `groupId`; every later
  version has `prevHash` equal to the hash of the version before it and is signed by the **owner of
  the version before it**. That last rule is what makes **ownership transfer** work: the current owner
  signs a version naming the new owner, and the new owner signs from the next one on.
- **Accepting a version**: a peer accepts a version only if it extends the chain the peer holds. A
  peer that is behind asks for the missing suffix (`roster {groupId, sinceVersion}`, §4.2) and
  verifies each link in order, so a peer offline across any number of versions converges as soon as it
  sees any member. A **joiner** holds nothing: its first chain must have version 1 signed by the owner
  endpoint id carried in the invite, and the chain's head must list the joiner.
- **Forks cannot arise from two writers**, since there is one. The one way two versions can share a
  number is the owner's own install signing twice (a bug, a restored backup): peers keep the version
  they verified first, the owner's install detects the disagreement at the next `hello` (same version,
  different hash) and resolves it by signing a higher version on top of the one the majority of its
  connected peers hold. It is reported as an error in the Collaborators page, never silently.
- **Losing the owner's key** (machine lost, data dir wiped) means nobody can sign again: the group is
  frozen with its last roster and the UI says so ("The owner's install is gone; create a new group").
  That is the price of a single signer, and the invite and group screens state it. Transferring
  ownership before changing machines is a one-click action (§5.1).
- **Spreading:** every connection starts with each side's head (`version`, hash) per shared group;
  the side that is behind pulls the suffix.
- **Inviting:** the owner creates an **invite**: a text and QR code holding the owner's endpoint
  ticket, the `groupId`, the owner's endpoint id, and a one-time 128-bit secret, valid 7 days. The
  invitee pastes it and their Claudio sends `join` with the secret, its name and its label. Two paths:
  - **The owner is online.** The owner's Claudio checks the secret, signs the next version with the
    member, and sends the chain back. Done in one round trip.
  - **The owner is offline.** The invitee's Claudio sends the same `join` to **any member it can
    reach** (the invite carries the owner's ticket only, so it also carries the tickets of up to three
    other members the owner's install knew to be online when the invite was made). That member stores
    the request as a **pending join** and forwards it to the owner on their next connection; the owner
    validates the secret and signs; the new chain reaches the invitee the usual way. Meanwhile the
    invitee sees "Waiting for {{owner}} to come online". The relaying member never sees the secret in
    the clear: `join` is sealed to the owner's key (X25519 derived from the Ed25519 endpoint key, the
    standard iroh conversion), so the relay carries an opaque blob.
  - The secret is **one-time**: the owner's install records it as used when it signs, and a second
    `join` with it is refused. It **expires** at the time in the invite.
- **Removing:** the owner signs a version without the member. Every unmodified Claudio that receives
  it stops serving the removed id, closes its connections and stops listing its shares. **Copies the
  removed member already holds stay on their machine**, and the UI says so before removing (§5.1).
- **Leaving:** the member deletes the group and every copy synced through it, and tells the peers it
  can reach (`leave {groupId}`), so the owner can sign the next version without them; a member that
  left silently is removed by the owner when noticed.
- **More than one group** per install is allowed (someone working with two teams). A project is shared
  with one or more of the person's groups.

### 3.4 Which project is "the same project"

A project's id is a random UUID made on each machine (`packages/core/src/projects.ts:181`), and the
CLI's memory folder name comes from the absolute path (`packages/core/src/workspace.ts:12`). Neither
matches between teammates. What can match is the **git remote plus the place inside the repository**,
and when it cannot, a person links the projects by hand. The **share key** is stored in the project's
sharing settings (§4.3): computed once as a default, **editable**, and shown in the Sharing section
(§5.2).

**The default share key** is `<host>/<path>[#<subpath>]`:

1. **Which remote:** `upstream` if it exists, else `origin`, else the only remote, else none. This is
   what makes a **fork workflow** match: teammates whose `origin` is their own fork share an
   `upstream`. The person can pick another remote in the Sharing section.
2. **Host:** `parseRemote` (`packages/core/src/hosts/remote.ts:55`) drops credentials and folds the
   documented SSH-over-443 names; an SSH alias (`git@work:acme/api`) is resolved to its real host with
   `resolveSshHost` (`remote.ts:88`, already used by `hosts/readiness.ts`). The host is lower-cased.
3. **Path:** without `.git`, without leading or trailing slashes. For hosts whose paths are
   case-insensitive (github.com, gitlab.com, bitbucket.org, codeberg.org, dev.azure.com) the path is
   lower-cased; for any other host it is kept as written, since a self-hosted Gitea or Gerrit may
   distinguish `Acme/API` from `acme/api`. `parseRemote` today lower-cases only the host
   (`remote.ts:17-30`), so this is a new helper, `shareKeyFor`, with that table.
4. **Subpath:** `git rev-parse --show-prefix` from the project's directory, when the project is a
   subdirectory of its repository (a monorepo project, which `attachProject` already supports,
   `projects.ts:48-53`). Two projects in one repository have two keys.

**Two local projects with the same key** (two clones of one repository on one machine): the second
cannot be shared under that key. The Sharing section says which project already uses it and offers
to edit the key (for example with a `#clone-2` suffix), so the serving side never has two projects
behind one key.

**No remote:** the key is `local/<random 16 bytes hex>`, and a collaborator sees the project as
"not cloned here" until they link it.

**Manual linking, on both sides:**

- the sharing side edits the key (any string `[a-z0-9._/#-]{3,200}`), or picks another remote;
- the receiving side, on a shared project the key did not match, has **Link to a local project**,
  which stores the pairing in the group document (`links: { [shareKey]: projectId }`). From then on
  that shared project shows inside the chosen project (§5.3). A pairing can be undone there.

**Matching on the receiving side:** a shared project shows inside every local project whose default
key or manual link equals its key. If that is several projects (two clones), it shows in each. Every
shared project also shows on the Collaborators page whether it is cloned locally or not.

### 3.5 The serving side cannot start anything

The protocol handler (`packages/core/src/collab/serve.ts`) is constructed with **read-only ports**:
`ChatReader`, `TranscriptReader`, `MemoryReader`, `JournalReader`, `DocumentReader`,
`WorkItemReader`, `UploadReader`. It is never handed the core's run, chat, flow or orchestration
services. Three things enforce it:

1. a `no-restricted-imports` ESLint rule for `packages/core/src/collab/**`, denying every module that
   can start work (`chat-service`, `orchestrator`, `flow`, `workflow-engine`, `processes`,
   `cli`, `terminals/**`, `assistant*`, `schedules`, `cron`) and the API's packages;
2. a unit test that fails if `collab/**` imports any of them, as a second line in case the lint
   configuration changes;
3. the ports' types: every reader exposes only `list`, `get`, `read` and `watch` methods.

Each request checks that:

1. the remote endpoint id is a member of a group, on the chain the serving side holds;
2. the requested project is shared with **that** group;
3. the kind requested is one the project shares;
4. for a `blob`, that the hash is **referenced by a shared record of that project** (an upload of a
   shared chat, a document of its documents folder, an artifact of one of its orchestrations). A blob
   is never served by hash alone: a hash is not a credential.

iroh authenticates the endpoint id in the QUIC handshake, so there is no token of ours to steal. A
`join` is the one frame accepted from a non-member, and a `leave` the one accepted from a member for
a group it is leaving.

## 4. Data and protocol

### 4.1 What is shared, from where

| Kind | Source on the sharing side | Change cursor |
| --- | --- | --- |
| Chats (list) | `chats` rows whose `cwd` attaches to the project (`attachProject`, `projects.ts:53`, worktrees included). `ChatRecord` (`packages/core/src/chat-records.ts:13`) has `cwd` and `updatedAt` and no project id, which is why the attachment is computed, not read | `updatedAt` + id |
| Transcripts | the CLI's JSONL, `<configDir>/projects/<slug>/<session>.jsonl`, its `subagents/*.jsonl` and `subagents/workflows/<runId>/*.jsonl` (`sessions.ts:541-563, 723-725`) | byte offset per file (append-only) |
| Memory | the CLI's memory files (`memory.ts`, `MEMORY.md` + `*.md`), approved `memory_proposals` (`db.ts:337`) | mtime + sha256 per file, `seq` for proposals |
| Journal | `journal_entries` (`db.ts:319`) | `seq` |
| Documents | the project's documents folder (`documents.ts:33`, `docs/` by default) and the project's `CLAUDE.md`, **as they are in the owner's working tree**. Teammates usually have the committed versions through git; what this shares is the owner's working copy, which may be ahead of or different from theirs, and the UI labels it "Working copy on {{name}}'s machine" (§5.3) | mtime + sha256 per file |
| Artifacts | orchestration `finalResult`s for orchestrations in the project; uploads referenced by shared chats; plan drafts | `updatedAt`; uploads by sha256, fetched when opened |
| Board | `work_items` and their milestones, labels, criteria, relations, comments, history, links (`db.ts:204-309`). Every change to a label, criterion, comment, relation or link bumps the item's `updated_at` (`work-items.ts`), so the item is the unit of sync; milestones have their own `updated_at` | `updated_at` + id; milestones the same |

**Terminal sessions are not shared.** `terminal_sessions` holds a shell's cwd, pid and times
(`db.ts:809-826`) and no output, so there is nothing to show; they are left out rather than listed
as empty rows.

Removed records are found by a **catalog reconcile**: on connect, and every 10 min while connected,
the receiver asks for the list of ids and versions per kind and drops what is gone. No durable change
feed exists today (the `EventBus` is in memory, `events.ts`), and this avoids adding one.

Every record keeps the ids it carries (`item_id`, `source_chat_id`, `document_path`…) unchanged: the
receiver resolves them inside the same owner's copy, and a reference to something not synced yet
renders as a plain id until it arrives.

### 4.2 Wire

These are length-prefixed JSON frames on bidirectional QUIC streams under `claudio/collab/1`, one
stream per request. Every frame carries `shareKey` where a project is involved, so the checks in §3.5
apply to every one of them:

- `hello {heads: {groupId: {version, hash}}}` → `hello`; the side that is behind then sends `roster`
- `roster {groupId, sinceVersion}` → the chain's versions after `sinceVersion`, in order
- `join {groupId, sealed}` → `roster` (the whole chain) when the owner answers directly, or
  `pending {owner}` when a member stores it to relay. `sealed` is `{secret, name, label,
  endpointId}` sealed to the owner's key
- `joinRelay {groupId, sealed, from}` member → owner, the stored request, forwarded once
- `roster {groupId, sinceVersion: 0, denial}` from a joiner not in the chain yet: `denied` when the
  install holds a denial for that joiner and tag, `forbidden` otherwise; `join` is answered `denied`
  too for an invite the owner denied (R14, below)
- `joinAnswers {groupId}` member → owner → `joinAnswers {groupId, denied: [{from, tag, deniedAt,
  expiresAt}]}`, the group's denials, which the member keeps to answer joiners while the owner is away
- `leave {groupId}` → ack
- `catalog {groupId}` → shared projects `{shareKey, name, remote?, subpath?, kinds, counts, versions}`
- `pull {shareKey, kind, since}` → batches of records, ending with the new cursor
- `transcript {shareKey, session, offset}` → the bytes appended since the offset
- `blob {shareKey, sha256}` → a `blob {bytes}` header, then the bytes in 1 MiB writes (§3.2), of an
  upload, document or artifact that a shared record of that project references; `404` otherwise, the
  same answer whether the hash exists or not
- `watch {shareKeys}` → a long-lived stream of `changed {shareKey, kind}` notices, fed by the existing
  events (`workitem.*`, `journal.changed`, `memory.proposal`, `document.changed`, `sessions.changed`,
  `orchestration.*`, `run.*`; all of them exist in `packages/shared/src/types.ts`)

**Live** means: while connected, a `changed` notice makes the receiver pull right away. A running
chat's transcript is pulled as it grows. That is the same file watcher that already debounces
`sessions.changed` (`event-sources.ts:599`), which also covers the memory files, since they live
under the same projects directory.

### 4.3 Storage on the receiving side

- **JSON:** `<dataDir>/collaborators/settings.json` (on/off, display name, label, relay URL),
  `<dataDir>/collaborators/groups/<groupId>.json` (the signed chain, the manual links, and the
  cursors per member and share key). Per-project sharing goes in the project's settings document
  (`project-settings/<projectId>.json`, `project-settings.ts:427-443`) as
  `sharing?: { groups: string[]; shareKey: string; remote?: string }`. `ProjectSettings` is a strict
  shared type (`packages/shared/src/types.ts:1418`), so the field is added there and the OpenAPI
  schemas are regenerated (`pnpm --filter @claudio/api openapi:schemas`).
- **SQLite**, new tables:
  - `collab_records(owner_id, share_key, kind, record_id, version, json, synced_at)`, primary key
    `(owner_id, share_key, kind, record_id)`;
  - `collab_transcript_lines(owner_id, share_key, session_id, seq, line)`;
  - `collab_peers(endpoint_id, last_seen_at, path)`, where `path` is `direct` or `relay`;
  - `collab_join_requests(group_id, from_endpoint_id, sealed, received_at, forwarded_at)`, the pending
    joins a member relays (§3.3), deleted once forwarded or after the invite's expiry;
  - `collab_used_invites(group_id, secret_hash, used_at)`, on the owner's install, what makes a
    secret one-time across restarts.
- **Blobs:** `<dataDir>/collaborators/blobs/<sha256>`, written on first open.
- When an owner **stops sharing** a project, the next catalog no longer lists it and an unmodified
  receiver deletes its copy (§2: cooperative). Leaving a group deletes everything synced through it.

## 5. The design (validated 2026-10-16)

The owner validated this section as written on 2026-10-16. C3 implements it without redrawing. It
follows Night Shift: one primary
gradient action per zone and at most two gradient surfaces per screen, status colour always with a
word, and `--live` only for an agent working now.

### 5.1 Collaborators page — `/collaborators`

- **Where it sits:** sidebar, `space` group, after Projects (`apps/web/src/App.tsx:253`). The icon is
  `Network` (lucide), because `UsersRound` is already Accounts (`App.tsx:241`). On a phone it goes
  under **More**.
- **Off:** `Empty` with a new illustration, `collaborators` (two machines joined by a line; its
  reference SVG goes into `docs/design-system/illustrations/` and its row into design-system.md §4 in
  the same PR). Title "Work with your team"; text saying the Claudios connect directly, read only,
  without spending anyone's quota. Primary action: **Turn on** (`--grad`). This is the screen's one
  gradient surface.
- **Unavailable** (module did not load, §3.2): the same `Empty` with the `il-warn` tone, the reason
  ("Not available on this platform", "The native module did not load"), and no action.
- **On**, top to bottom. The page has **one** `--grad` action, **Invite**, in the top bar's actions
  zone, enabled when the person owns at least one group; it asks which group when there are several.
  Everything else is a default or ghost button.
  1. **You** card: display name (editable), install label, endpoint id in Geist Mono (shortened, copy
     on click), and the connection in plain words with its icon: `ok` "Connected", neutral muted
     "Connected through a relay" (no status colour: a relayed path is slower, not wrong), `bad` "No
     network". A short line under it: "Discovery and relays are run by n0" with the relay URL if set.
  2. **Groups:** one card per group, with its name and member count. Members are rows showing the
     avatar initial, name and label, a role chip (Owner), and presence (`ok` dot + "Online · direct",
     `ok` dot + "Online · relay", or `idle` dot + "Last seen 2 h ago"). The owner gets a "⋯" menu (a
     `Sheet` on a phone) with **Remove** and **Make owner**; a member gets **Leave the group**.
     Removing goes through a confirm dialog with the "copies stay" warning. Making someone owner goes
     through a confirm that says the person loses the right to change the group. A frozen group
     (owner's key gone, §3.3) shows a `warn` line "The owner's install is gone: the group can no
     longer change" with a **Create a new group** ghost action.
  3. **Join requests** (owner only, when any): a row per pending join with the name, label, who
     relayed it and when; **Accept** and **Deny** as default buttons.
  4. Secondary actions row: **Join a group** opens a dialog to paste an invite; **Create a group**
     asks for a name.
  5. **Shared with you:** shared projects grouped by **person**, then install label. Each shows the
     project name, the share key in mono, counts per kind, and the sync state in plain text: `ok`
     "Up to date · syncing", "Synced 3 min ago", or `idle` "Owner offline · last synced 2 h ago". No
     live rail here: syncing is not an agent working. A project cloned here links into §5.3; one that
     is not shows "Not cloned here", a **Link to a local project** ghost action (a `Select` of local
     projects), and opens a read-only view of the same tabs.
- **Invite dialog:** the invite text, copy, a QR code (drawn in-house by a small encoder in
  `packages/ui`, no dependency, §8), the expiry, and the owner's presence requirement in one line:
  "If you are offline when they join, they wait until you are back." Below it, the standing warning:
  "Keep a copy of this group on another install, or transfer ownership before changing machines: if
  this install is lost, the group can no longer change."
- **Join dialog:** paste the invite; while waiting, "Connecting to {{owner}}…", then either the group
  card appears or "{{owner}} is offline. Your request has been left with {{member}} and will be
  accepted when {{owner}} is back." with a **Cancel request** ghost action.

### 5.2 Sharing a project — project Settings tab

There is a new **Sharing** section in the project's Settings view:

- a `Toggle` per group ("Share with *Backend team*");
- the four kinds listed as included, without toggles, as chosen per project;
- a `warn` note with the warning icon: "Everything in this project's chats is sent as it is, including
  command output. Each collaborator's Claudio deletes its copy when you stop sharing, but what a
  person has already received or copied elsewhere cannot be taken back.";
- the **share key**: shown in mono (`github.com/acme/api`, `github.com/acme/mono#apps/web`), with
  the remote it came from, a `Select` to pick another remote when the repository has several, and
  **Edit** for the key itself. "No git remote: shared by its own id" when there is none. If another
  local project already shares this key, a `warn` line names it and the toggle stays off until the key
  is edited;
- a line in Geist Mono with what a collaborator sees as the project's name and remote.

### 5.3 Inside a project — the **Shared** tab

- This is a new `PROJECT_VIEWS` entry, `shared`, at `/?project=<id>&view=shared`. Tabs today are
  gated by module (`VIEW_MODULE`, `apps/web/src/pages/dashboard/views.ts:12`); `shared` has its own
  gate: Collaborators is on and at least one member shares this project's key or is linked to it, so
  `projectViews` takes that as a second argument.
- **Header:** a member switcher (`Select`, grouped by person), plus the sync state for that member in
  the same words as §5.1.
- **Sub-tabs:** Chats · Memory · Documents · Board. They reuse the existing views in read-only mode:
  - the chat list and the `@claudio/chat-ui` transcript with **no composer** and a "Read only · from
    Ana" bar;
  - the memory view, read only;
  - the documents reader, with the bar "Working copy on Ana's machine · may differ from your checkout";
  - the board without drag, create or edit.
- **A chat running on the collaborator's machine** shows the live rail and the braille spinner next
  to its verb: that is an agent working now, which is what `--live` means. There is no energy border,
  because nothing here is the person's own work.
- Others' chats **never** mix into the person's own chat list, counts or badges.

### 5.4 Copy (key strings)

Spanish follows `GLOSSARY.md`: "en directo" for live (row 240, never "en vivo"), infinitive buttons,
sentence case. **New glossary rows in the same change:** *relay* (kept in English: "el relay, por
relay"; a developer in Spain says it that way and Tailscale's Spanish docs do too), *share key* →
"clave de compartición", *owner* (of a group) → "propietario", *working copy* → "copia de trabajo".

| Key | en | es |
| --- | --- | --- |
| nav | Collaborators | Colaboradores |
| turn on | Turn on | Activar |
| unavailable | Not available on this platform | No disponible en esta plataforma |
| invite | Invite | Invitar |
| join | Join a group | Unirse a un grupo |
| create | Create a group | Crear un grupo |
| leave | Leave the group | Salir del grupo |
| make owner | Make owner | Hacer propietario |
| owner chip | Owner | Propietario |
| link | Link to a local project | Vincular con un proyecto local |
| shared tab | Shared | Compartido |
| read only bar | Read only · from {{name}} | Solo lectura · de {{name}} |
| working copy | Working copy on {{name}}'s machine · may differ from your checkout | Copia de trabajo en la máquina de {{name}} · puede diferir de tu copia |
| live chat | Live | En directo |
| syncing | Up to date · syncing | Al día · sincronizando |
| synced | Synced {{ago}} | Sincronizado {{ago}} |
| owner offline | Owner offline · last synced {{ago}} | Propietario sin conexión · última sincronización {{ago}} |
| relay path | Connected through a relay | Conectado por relay |
| waiting | {{owner}} is offline. Your request has been left with {{member}} and will be accepted when {{owner}} is back. | {{owner}} no está conectado. Tu solicitud se ha dejado con {{member}} y se aceptará cuando {{owner}} vuelva. |
| remove warn | Copies {{name}} already has stay on their machine. | Las copias que ya tiene {{name}} se quedan en su máquina. |
| frozen | The owner's install is gone: the group can no longer change. | La instalación del propietario ya no existe: el grupo ya no puede cambiar. |
| key in use | {{project}} already shares this key. Edit the key to share this project too. | {{project}} ya comparte esta clave. Edita la clave para compartir también este proyecto. |

## 6. API

These local routes are for the owner's token only, reads included: a chat's token must never pull a
teammate's transcript into its own context. Routes are closed to chats the way the API already does
it, with an explicit set per feature in `apps/api/src/security.ts` (`CHAT_FORBIDDEN_*`): C2 adds
`CHAT_FORBIDDEN_COLLABORATORS` listing **every** route below, and the matching 403 message. Each
route gets a summary and the tag `collaborators` in `apps/api/src/openapi/routes.ts`, plus a README
row.

A share key holds slashes and `#`, so it never travels as a path segment: the catalog answers a
`shareId` per project, `sha256(shareKey)` as 32 hex characters, and the routes use that.

| Route | |
| --- | --- |
| `GET /collaborators` | on/off, identity, connection status, `unavailable` with its reason when the module did not load |
| `PUT /collaborators` | turn on/off, display name, label, relay URL |
| `GET /collaborators/groups` · `POST` | list (with each chain's head and whether it is frozen) · create |
| `DELETE /collaborators/groups/:id` | leave (deletes the copies, sends `leave`) |
| `POST /collaborators/groups/:id/invites` | owner: make an invite |
| `POST /collaborators/join` | `{invite}` |
| `DELETE /collaborators/join/:groupId` | cancel a pending request |
| `GET /collaborators/groups/:id/join-requests` | owner: pending joins relayed to this install |
| `POST /collaborators/groups/:id/join-requests/:from/accept` · `/deny` | owner |
| `DELETE /collaborators/groups/:id/members/:endpointId` | owner: remove |
| `PUT /collaborators/groups/:id/owner` | owner: transfer ownership `{endpointId}` |
| `GET /projects/:id/sharing` · `PUT` | the project's groups, remote choice and share key; `PUT` answers 409 with the other project's id when the key is in use |
| `GET /collaborators/shared` | catalog of what others share with me, with `shareId`, match state and links |
| `PUT /collaborators/shared/:owner/:shareId/link` · `DELETE` | link to / unlink from a local project |
| `GET /collaborators/shared/:owner/:shareId/{chats,memory,journal,documents,work-items,artifacts}` | the copies |
| `GET /collaborators/shared/:owner/:shareId/chats/:chatId/transcript` | a copied transcript |
| `GET /collaborators/shared/:owner/:shareId/blobs/:sha256` | a blob, fetched from the owner on first open |

There are new events: `collaborators.changed` (settings, roster, links), `collaborators.peer`
(online, offline, path), `collaborators.synced` (owner, share key, kind) and
`collaborators.join-request` (owner only).

## 7. Stages

| Stage | What | Checks |
| --- | --- | --- |
| **C0 — spike** | **Done 2026-10-16** (§7.2). Proved: bind with the custom ALPN, direct and relay paths, discovery by id, custom relay map, soft loading, the bundle and staging, loading in Electron 44 and in `node:26-bookworm-slim`, two machines on the LAN, and two machines across two NATs (home router and a phone hotspot), where every connection stayed on the relay. Found the `watch*` abort and the `Array<number>` ceiling, which changed §3.2. | §7.2 written; spike code and raw results in [reports/collaborators-c0/](../reports/collaborators-c0/README.md) |
| **C1 — core** | identity and lazy loading; roster chain (genesis, verify, suffix fetch, transfer, equivocation report); invites, direct and relayed joins, one-time secrets; `shareKeyFor` with the remote preference, alias resolution, host table and subpath; `serve.ts` with read-only ports, the lint rule and the four checks; pull/watch client; SQLite tables; catalog reconcile; manual links | unit tests: chain verification against every forged variant (wrong signer, broken `prevHash`, equal version, second genesis); a peer offline across five versions converges; joiner rejects a chain whose owner is not the invite's; transfer; invite expiry and one-time use across a restart; relayed join sealed end to end; removal; `shareKeyFor` for fork, alias, case, subpath, two clones and no remote; blob refused by hash alone; the "serve imports no run service" test and lint; cursors per kind; two in-process endpoints syncing a fixture project offline |
| **C2 — API** | routes, events, OpenAPI, README, `CHAT_FORBIDDEN_COLLABORATORS`, `ProjectSettings.sharing` and schema regeneration | `pnpm --filter @claudio/api openapi:schemas`, route tests, 403 for chat tokens on every route including reads |
| **C3 — web** | §5 after the owner validates it, the `collaborators` illustration with its reference SVG and its design-system row, the QR encoder, the glossary rows | Night Shift check skill, `en`/`es` parity, both themes, phone, motion levels, the tokens test, at most two gradient surfaces on the Collaborators page |
| **C4 — e2e** | a two-wrapper mode in the e2e harness (`e2e/run.mjs`), both on `presetMinimal` with loopback tickets and relays off so CI needs no network; sharing a project, seeing a live chat, linking an unmatched project, a relayed join | `pnpm e2e` |
| **C5 — docs** | `docs/collaborators.md` (the feature), `docs/security-model.md` (the new surface, the vault's new kind of secret, the n0 dependency), `docs/design-system.md` and `agentry-ds.css` (the new screen's variants), `docs/status.md` | knowledge-base format |

### 7.1 Orchestration

One orchestration, **`claudio-collaborators`**, `cwd` a worktree of `feat/collaborators`,
`worktree: true`, concurrency 3, `maxAttempts` 2, `synthesize` on. Code-writing workers run on
`claude-opus-5-5`; `x1` (prose only) on `claude-sonnet-5-5`; never fable. Verification on the merged
branch: `pnpm typecheck`, `pnpm -r test`, the OpenAPI drift check, the web tokens test, `pnpm build`,
with the fixer on `claude-opus-5-5`, and the `e2e-specs` task Claudio adds for the specs the work
touches. No worker runs `pnpm e2e` on the whole suite, `docker build` or `pnpm dist:linux`.

It is launched **after C0** has written its section here, because `k5` reads those facts (the pinned
version, the relay mode call, how the module is staged). The owner launches it; this plan only
defines it.

Stages: `k1 · k2 · k3` → `k4` → `k5` → `k6` → `a1` → `e1 · x1`, with `w1 · w2` starting after `k1`
and running beside the core chain. The route table in §6 and the types `k1` writes are the contract
between the web tasks and `a1`; `e1` is where the two meet.

| Id | Task | dependsOn | Owns | Checks |
|---|---|---|---|---|
| `k1` | **Shared types** (§4.3, §6): a `Collaborators` region in `types.ts` (`CollaboratorsStatus` with `unavailable`, `Group`, `RosterVersion`, `RosterMember`, `JoinRequest`, `SharedProject` with `shareId`, `SyncState`, `ProjectSharing`, the request and response bodies of every §6 route, the four `collaborators.*` events in `ClaudioEvent`), `ProjectSettings.sharing`, schemas regenerated | — | `packages/shared/src/types.ts` (the new region and `ProjectSettings` only), `apps/api/src/openapi/schemas*`, `packages/shared/test/**` | `pnpm typecheck`, shared tests, schema drift |
| `k2` | **Roster chain and invites** (§3.3), pure, no iroh: `canonical.ts` (RFC 8785), `roster.ts` (genesis, hash, sign, verify a chain and a suffix, transfer, equivocation detection, membership queries), `invite.ts` (encode/decode text, one-time secret, expiry, sealing of `join` to the owner's key with X25519 derived from the Ed25519 seed), with `node:crypto` over the 32-byte seed the endpoint shares | — | `packages/core/src/collab/canonical.ts`, `collab/roster.ts`, `collab/invite.ts`, `packages/core/test/collab-roster.test.ts`, `collab-invite.test.ts` | every forged variant rejected (wrong signer, broken `prevHash`, equal version, second genesis, joiner with another owner); offline-across-five-versions converges; transfer; expiry and one-time use |
| `k3` | **Share key** (§3.4): `share-key.ts` with `shareKeyFor` (remote preference `upstream` → `origin` → the only remote, `resolveSshHost`, the case-insensitive host table, `--show-prefix` subpath, `local/<hex>`), `isValidShareKey`, `shareIdOf` | — | `packages/core/src/collab/share-key.ts`, `packages/core/test/collab-share-key.test.ts` | fork, alias, case on both kinds of host, subpath, two clones, no remote, invalid keys |
| `k4` | **Storage** (§4.3): the migration with `collab_records`, `collab_transcript_lines`, `collab_peers`, `collab_join_requests`, `collab_used_invites` and a `CollabStore` beside the other stores in `db.ts`; `groups-store.ts` (the chain, links and cursors as JSON per group); `settings.ts` (`collaborators/settings.json`); `sharing` in `project-settings.ts` with the key-uniqueness check | `k1` | `packages/core/src/db.ts` (the new migration and `CollabStore` only), `collab/groups-store.ts`, `collab/settings.ts`, `project-settings.ts` (`sharing` only), `packages/core/test/collab-store.test.ts`, `project-settings.test.ts` (additions) | migration on an old database; cursors per kind; uniqueness 409 case; JSON documents atomic |
| `k5` | **Transport host and serving side** (§3.2, §3.5, §4.2): `collab/host/` as a child process after `terminals/host/` (`main.ts` entry, `protocol.ts` IPC messages, `host.ts` with the lazy `import()` of `@number0/iroh`, bind with the ALPN and relay mode, polling, `unavailable` reasons, every binding promise in `try/catch`), `host-client.ts` in the core (fork, restart, `unavailable`), `wire.ts` (frames, length prefix, 1 MiB pieces, limits), `readers.ts` (the seven read-only ports over the existing services), `serve.ts` (the four checks, `join` and `leave` from non-members as §3.5 allows), the `no-restricted-imports` block for `collab/**`, the import test, the dependency pinned at `1.1.0`, the `collab-host` entry and the staging of `@number0/iroh` plus `@number0/iroh-linux-x64-gnu` in `bundle.mjs`, the `extraResources` entry, the upstream issues for `watch*` and `Buffer` | `k2`, `k3`, `k4` | `packages/core/src/collab/host/**`, `collab/host-client.ts`, `collab/wire.ts`, `collab/readers.ts`, `collab/serve.ts`, `packages/core/package.json` (the dependency), `eslint.config.*` (one block), `apps/api/scripts/bundle.mjs` (entry and staging), `apps/desktop/electron-builder.yml` (one `extraResources` entry), `packages/core/test/collab-host.test.ts`, `collab-serve.test.ts`, `collab-isolation.test.ts` | blob refused by hash alone; every frame refused for a non-member and for an unshared project; lint and import test; Claudio starts with the module absent; a killed host is restarted and reported; no `watch*` call anywhere (a grep test) |
| `k6` | **Sync client and service** (§3.3, §4.1, §4.2): `client.ts` (hello and suffix, direct and relayed join, catalog, pull per kind with the cursors of §4.1, transcript offsets, blob on open, watch, reconcile every 10 min, chats attached with `attachProject`), `service.ts` (`CollaboratorsService`: on/off, groups, invites, joins and pending joins, removal, transfer, leave, links, the `collaborators.*` events), wiring in `index.ts` | `k5` | `packages/core/src/collab/client.ts`, `collab/service.ts`, `collab/index.ts`, `packages/core/src/index.ts` (wiring lines only), `packages/core/test/collab-sync.test.ts` | two in-process endpoints on `presetMinimal` syncing a fixture project offline, all four kinds, a removal, an unshare, a relayed join, a transfer |
| `a1` | **API** (§6): `routes/collaborators.ts`, the two `projects/:id/sharing` routes, `CHAT_FORBIDDEN_COLLABORATORS` with its message, every summary and the `collaborators` tag in `routes.ts`, the README REST rows, the events on `/events` | `k6` | `apps/api/src/routes/collaborators.ts` (new), `apps/api/src/security.ts` (the set and its check only), `apps/api/src/openapi/routes.ts` (the new entries), `README.md` (REST tables), `apps/api/test/collaborators.test.ts` | route tests; 403 for a chat token on every route including reads; schema drift |
| `w1` | **Collaborators page** (§5.1, §5.4): `pages/Collaborators.tsx` and its sub-components, the `NavItem` after Projects and the phone **More** entry, the API client `lib/api/collaborators.ts` written against §6, the `collaborators` illustration with its reference SVG, the QR encoder in `packages/ui` with tests, the design-system CSS variants, i18n en/es and the glossary rows | `k1` | `apps/web/src/pages/Collaborators.tsx`, `apps/web/src/pages/collaborators/**` (new), `apps/web/src/lib/api/collaborators.ts` (new), `apps/web/src/App.tsx` (the nav item only), `apps/web/src/components/shell/**` (the More entry only), `apps/web/src/styles/collaborators.css` (new), `packages/ui/src/components/illustrations/collaborators.tsx`, `illustrations/index.ts`, `packages/ui/src/lib/qr.ts` (new) and its test, `docs/design-system/illustrations/collaborators.svg`, `docs/design-system/agentry-ds.css` (the new variants), `apps/web/src/i18n/locales/*/collaborators.json` (new), `apps/web/src/i18n/GLOSSARY.md` (the four rows), `apps/web/test/collaborators-page.test.tsx`, `apps/web/test/fixtures/class-names.json` (regenerated) | `pnpm typecheck`, ui + web tests, the tokens test, `night-shift-ui-check`, at most two gradient surfaces |
| `w2` | **Sharing section and Shared tab** (§5.2, §5.3): the Sharing section in the project's Settings view, `shared` in `PROJECT_VIEWS` with its gate (`projectViews` takes the collaborators state), `SharedView.tsx` with the member switcher and the four read-only sub-tabs reusing the existing views, the read-only bar and the no-composer mode in `@claudio/chat-ui`, the live rail on a collaborator's running chat, i18n | `k1` | `apps/web/src/pages/dashboard/views.ts`, `apps/web/src/pages/project/SharedView.tsx` (new), `apps/web/src/pages/project/SharingSection.tsx` (new) and its mount in the Settings view (one block), `packages/chat-ui/src/components/ReadOnlyBar.tsx` (new), `packages/chat-ui/src/components/Transcript.tsx` (the read-only prop only), `packages/chat-ui/src/locales/**` (the new keys), `apps/web/src/i18n/locales/*/collaborators.json` (the `shared.*` and `sharing.*` keys, coordinated with `w1` by key prefix), `apps/web/test/shared-view.test.tsx`, `apps/web/test/fixtures/class-names.json` (regenerated) | `pnpm typecheck`, chat-ui + web tests, `night-shift-ui-check`; own chats never mixed with shared ones |
| `e1` | **e2e** (C4): the two-wrapper mode in the harness (`presetMinimal`, loopback tickets, relays off, no network), `collaborators.spec.mjs` (turn on, create, invite and join, share, see a live chat from the fake CLI, link an unmatched project, a relayed join, remove), the `motion` and `a11y-core` additions. Run each touched spec alone with `pnpm e2e <name>` on an `E2E_PORT` of its own | `a1`, `w1`, `w2` | `e2e/run.mjs`, `e2e/processes.mjs` (the two-wrapper mode), `e2e/specs/collaborators.spec.mjs` (new), `e2e/specs/motion.spec.mjs`, `e2e/specs/a11y-core.spec.mjs`, `e2e/fake-cli/**` (only if a fixture is missing) | the harness test; each touched spec green alone |
| `x1` | **Docs** (sonnet, C5): `docs/collaborators.md` (what a person can do, where it shows, the roster and share-key rules in plain words, what n0 sees, what is cooperative), the additions to `docs/security-model.md` (the new surface, the vault's new kind of secret, the n0 dependency), the §4 row and the "Landed" notes in `docs/design-system.md`, this plan's **Outcome** section, the `docs/status.md` row, the README feature line; stored with `kb_add_document` | `a1`, `w1`, `w2` | `docs/collaborators.md` (new), `docs/security-model.md` (additions), `docs/design-system.md` (the row and Landed only), `docs/plans/collaborators.md` (Outcome only), `docs/status.md`, `README.md` (one line) | links resolve; `kb_add_document` answers with no unresolved link this plan did not intend |

Two tasks regenerate the schemas (`k1` and `a1`) and two edit `collaborators.json` by key prefix
(`w1`, `w2`): the integrator resolves generated files by regenerating them and locale files by
merging keys, never by hand-picking a side.


### 7.2 C0 facts (2026-10-16)

Run by the owner's session on this machine (Linux x64, Node 22.21.1), with the spike now kept in [reports/collaborators-c0/](../reports/collaborators-c0/README.md). Everything below was
measured, not read.

**The binding.** `@number0/iroh` **1.1.0**, `engines.node >= 20.3.0`, 168 KiB of JS plus one
platform package per target as an optional dependency (eleven: Linux x64 and arm64 in glibc and musl,
Linux armv7 in both, macOS arm64, Windows x64 and arm64, Android arm64 and armv7). The Linux x64 glibc
file is **20 MiB**. The API is `Endpoint.builder()` with `presetN0`, `presetMinimal`,
`presetN0DisableRelay`, then `alpns`, `relayMode`, `secretKey`, `bindAddr`, `bind()`; `Endpoint.bind(options,
relayMode)` is the n0 shortcut. Connections: `acceptNext()` → `Incoming.accept()` → `Accepting.connect()`;
`Incoming.remoteAddr()` says `ip` or `relay`, which is what `collab_peers.path` records.

**Loading.** Plain Node: 70 ms. **Electron 44.5.1** (Node 24.21.0, ABI 149) through
`ELECTRON_RUN_AS_NODE`: loads. **`node:26-bookworm-slim`** (the Docker base): loads. With the
platform package removed, `import()` rejects with "Cannot find native binding…" and the process goes
on: the soft load the plan requires holds.

**Packaging.** esbuild with `external: ['@number0/iroh']` and the two packages copied, symlinks
dereferenced, into `dist/node_modules/@number0/` (exactly what `bundle.mjs` does for node-pty): the
bundle loads from another cwd in Node, in Electron and in the Docker image. Cost: 20 MiB more in the
AppImage, the `.deb` and the image.

**Custom ALPN.** `claudio/collab/1` set on both sides; the server reads it back from `Accepting.alpn()`.

**`watch*` aborts the process.** `Endpoint.watchAddr`, `watchHomeRelay`, `watchNetworkChange`,
`Connection.watchPaths` and `watchPathEvents` all panic in `iroh-js/src/watch.rs` ("there is no
reactor running, must be called from the context of a Tokio 1.x runtime"), exit code 134, not
catchable from JS. Polling works: `addr()`, `paths()`, `rtt()`, `stats()`. This is why the endpoint
lives in `collab-host.mjs` (§3.2) and why `k5` greps for `watch` in its tests. To be filed upstream.

**Bytes.** `Array<number>` only; `Buffer` and `Uint8Array` are rejected ("Failed to get Array
length"), for streams and for `SecretKey.sign`. `Array.from` of 4 MiB: 586 ms; `Uint8Array.from`
back: 32 ms. Loopback stream of 4 MiB, minimal preset:

| write × read | Mbps |
|---|---|
| 64 KiB × 64 KiB | 10 |
| 1 MiB × 1 MiB | 12 |
| 1 MiB × 64 KiB | 20 |
| 4 MiB × 4 MiB | 42 |
| `readToEnd` | 37 |
| TCP loopback, for scale | 3954 |

Hence 1 MiB writes, small frames, blobs on demand with progress (§3.2), and an upstream request for
`Buffer`. An unhandled rejection from the binding (`LocallyClosed` after a failed write) ended the
test process: the host wraps every binding call.

**Minimal preset, loopback.** Bind 68–115 ms; first handshake 386 ms; twenty pings on one stream each
(the plan's one-stream-per-request): median 7.9 ms, min 1.4 ms; `rtt()` 1 ms.

**n0 preset.** `online()` in 2.8–2.95 s, home relay `euc1-1.relay.n0.iroh.link` (Frankfurt).
- **Relay-only ticket** (id + relay URL, no direct addresses): handshake **81 ms** through the relay;
  a direct path was selected **~110 ms** later; afterwards relay rtt 77 ms against direct 3 ms. Blob
  of 1 MiB in 0.54 s once direct.
- **Id-only ticket** (dial by key, discovery through n0): handshake **94 ms**; the first path was the
  relay, direct followed. The plan's "dial by public key" works.
- Both runs were on one host and one LAN. **The two-NAT run is pending** (below).

**Relay configuration.** `RelayMode.customFromUrls(['https://use1-1.relay.n0.iroh.link./'])` on top
of `presetN0`: home relay became `use1-1`, so a custom map replaces the default. Unreachable relay:
`online()` never resolves (12 s timeout), direct addresses still present. `RelayMode.disabled()`:
`online()` never resolves. Default map: `aps1-1`, `euc1-1`, `use1-1`, `usw1-1`; a staging map exists.
Discovery has no configuration surface.

**What a ticket reveals.** `EndpointAddr.directAddresses()` lists every local interface: here nine,
the LAN address, a Tailscale `100.x` address and six Docker bridges. A roster member learns a
teammate's local topology through discovery anyway; the Collaborators page shows the endpoint id,
never the addresses, and the invite text carries the owner's ticket, which the plan already says.

**Signing.** `SecretKey.sign(Array)` and `EndpointId.verify(Array, Signature)` work; `k2` signs with
`node:crypto` over the same 32-byte seed and C1 checks both verify each other's signatures.

**Two machines on the LAN.** Client on the owner's work PC (Ubuntu 26.04, Node 24.13 through nvm,
`pc-work-jose-garrido.local`), server here, both with Tailscale up. Id-only ticket: `online()` 2.6 s,
handshake **173 ms** through the relay; a direct LAN path (`192.168.1.184`) selected at **~680 ms**;
iroh also found and sometimes preferred the Tailscale path (`100.92.252.87`), flipping between the
two. Ping median 40 ms during the migration, `rtt()` 8 ms once direct. Blob of 4 MiB: 12.2 s, 2.75 Mbps
(the `Array<number>` ceiling plus the migration).

**Two machines across two NATs.** The work PC moved to an iPhone hotspot (`172.20.10.2/28`, carrier
NAT), Tailscale stopped on it; this machine behind the home router, public address
`95.60.169.146`, port-preserving (`addr()` showed `95.60.169.146:51936` for the local `:51936`). Four
runs, two with the id-only ticket and two with the relay-only one, each watching paths for 10 s:

| Run | `online()` | handshake | path at connect | path after 10 s | ping median | blob 4 MiB |
|---|---|---|---|---|---|---|
| id-only 1 | 776 ms | 366 ms | relay | relay | 126 ms | 3.8 s, 8.8 Mbps |
| id-only 2 | 712 ms | 129 ms | relay | relay | 114 ms | 1.7 s, 19.6 Mbps |
| relay-only 1 | 741 ms | 171 ms | relay | relay | 121 ms | 2.8 s, 11.9 Mbps |
| relay-only 2 | 7.5 s | 120 ms | relay | relay | 114 ms | 5.1 s, 6.6 Mbps |

**No direct path was ever opened**, on either side (the server's path snapshots for the four
connections, 49 in all, show no `ip` path). Dialling by key through discovery worked every time, every
frame was answered, one packet was lost in 2,000. So: across a carrier's NAT the relay **is** the path,
with ~115 ms of round trip, and the hole punch the vendor advertises did not happen in this
topology. The design needs no direct path; the UI says "Connected through a relay" (§5.1), and a team
with several members on mobile networks has a reason to run its own `iroh-relay`, which is a setting
(§3.2). Home-to-home, office-to-home and the LAN case were not the problem: the LAN run went direct
in under a second.

**Spike artefacts.** The scripts (`serve.mjs`, `client.mjs`, `tput.mjs`, `relay-test.mjs`, `buf-test.mjs`,
`load-check.mjs`, `w-conn.mjs`, `w-test.mjs`) and the raw reports, with endpoint ids, tickets and IP
addresses replaced, are in [reports/collaborators-c0/](../reports/collaborators-c0/README.md). The work
PC's copy (`nat-run.sh`) stays there.

## 8. Decisions taken and rejected

Confirmed by the owner on 2026-10-16, after the review:

- **§5 as written.** No redraw before C3.
- **Single signer with manual transfer**, accepting a frozen group if the owner's install is lost.
- **n0's discovery as a v1 dependency**, and **n0's public relays by default**, with a custom relay
  URL as an optional setting and no relay of our own to run.
- **Scope of v1 includes** relayed joins, documents as the owner's working copy, manual linking of
  projects and ownership transfer.
- **Not pursued**, decided the same day: replacing the Tailscale tunnel with iroh (a phone browser can
  only reach iroh through a relay, in WASM, with no npm package yet; revisit when that changes), and a
  multi-writer SQLite VFS (Claudio writes from one process; nothing to gain, a native SQLite to ship).

Taken on 2026-10-16:

- **iroh** as the transport: it dials by public key, does QUIC hole punching with a relay fallback,
  has a stable 1.x wire protocol and an official Node binding, and its relay can be self-hosted.
- **n0's discovery is a declared dependency of v1.** The Node binding exposes no discovery
  configuration; rather than promise self-hosting we cannot deliver, the Settings copy says who runs
  discovery, and C0 records whether a later stage can change it.
- **Read only, no delegation**, so no peer can spend another's quota or run anything on their machine.
- **A single-signer roster chain**, over several admins (two writers can fork the roster, and a
  removed admin can keep signing for peers that were offline), over pairwise trust (n² invitations,
  nobody manages the set), and over a CRDT roster (members can expel each other, harder to reason
  about). The cost, a frozen group when the owner's key is lost, is stated in the UI and mitigated by
  one-click ownership transfer.
- **Self-certifying group id** (hash of the signed genesis), so a chain is verified from nothing.
- **Relayed joins**, so inviting does not need the owner online; the relay never sees the secret.
- **Share key from the remote and the subpath, editable, with manual links**, over a manual link only
  at invite time (nobody would do it) and over the remote alone (forks, aliases, monorepos and two
  clones all break it).
- **Documents are the owner's working copy**, labelled as such, over leaving documents out (the
  owner asked for them) and over syncing only committed files (that is what git is for).
- **Terminal sessions are not shared**: nothing of them is stored but their metadata.
- **Transcripts as they are**, over redaction (a false sense of safety) and over dropping tool output
  (loses most of the context). The owner's call: the group is trusted.
- **Its own protocol on the iroh endpoint, never the HTTP API over the network.** The API can start
  chats, which would spend quota.
- **Every rule on a receiver is cooperative**, and the copy says so, over wording that implies
  enforcement.
- **The iroh endpoint in a child process, polling, never watching** (C0): the binding's `watch*`
  methods abort the process and its promises can reject unhandled; a host process after
  `terminal-host.mjs` keeps that away from the API, and polling at 250–1000 ms is enough for presence
  and paths.
- **`@number0/iroh` pinned at 1.1.0** until the `watch*` and `Buffer` issues are answered upstream
  (tracked upstream as #276 and #277, see [reports/iroh-upstream-issues.md](../reports/iroh-upstream-issues.md));
  the wire stays 1.x-compatible either way.
- **A QR encoder of our own** in `packages/ui`, over a dependency: the encoder is small, has tests,
  and the design system already keeps third-party art out.

Rejected:

- **Tailscale.** It works and Claudio already uses it for remote access ([tunnel.md](../tunnel.md)),
  but every collaborator would need it installed and in one tailnet, and its coordination server is
  central (Headscale aside). The owner chose iroh.
- **libp2p.** It is heavier to assemble (transports, security, muxer, identify, relay, hole punch).
  Its hole-punch success rate is reported lower, though that figure comes from iroh's team.
- **Hyperswarm / HyperDHT.** This is the strongest alternative: pure JS, MIT, proven by Keet. It lost
  on iroh's QUIC stack, wire-stability promise and self-hostable relay. Revisit if the native module
  is a packaging problem in C0.
- **Tor / Arti onion services.** Anonymity is not needed, and Arti's onion services are still
  documented as testing only.
- **Veilid.** Its status in 2026 is unclear.
- **A2A.** No delegation means no task protocol is needed. It stays an option if delegation is ever
  wanted.
- **Several admins with version numbers** (the first draft of §3.3): see the roster decision above.
- **A separate `@claudio/collab` package** for the serving side: a package boundary would still let
  it import core's services; the lint rule and the test are what actually hold.

## 9. Sources

All checked on 2026-10-16:

- [Iroh 1.0 — Dial keys, not IPs](https://iroh.computer/blog/v1): 1.0 on 2026-06-15, wire stability
  across 1.x ("an iroh v1 endpoint will be able to communicate with another iroh v1 endpoint,
  regardless of minor version or language"), official Node/Python/Kotlin/Swift bindings, public relays
  rate-limited and run by iroh's team; footer "© 2025 n0, inc.".
- [iroh JavaScript binding](https://docs.iroh.computer/languages/javascript): `@number0/iroh`,
  napi-rs, Node ≥ 20.3, platforms (macOS arm64 only), `Endpoint.bind({ alpns })`, the `n0` preset
  by default.
- [`iroh-js/index.d.ts` in n0-computer/iroh-ffi](https://github.com/n0-computer/iroh-ffi/blob/main/iroh-js/index.d.ts):
  `EndpointOptions { bindAddr?, secretKey?, alpns? }`; `Endpoint.bind(options?, relayMode?)`;
  `RelayMode`, `RelayMap`, `RelayConfig { url }`; presets `presetN0`, `presetN0DisableRelay`,
  `presetMinimal`, `presetIrohServices`; **no** mDNS, pkarr or DNS configuration exported.
- [iroh discovery](https://docs.iroh.computer/concepts/discovery): pkarr/DNS by default, published to
  an `iroh-dns-server` run by n0.computer with the origin `dns.iroh.link`, mDNS as an additional crate
  (Rust), Mainline DHT opt-in.
- [Self-hosted relays](https://docs.iroh.computer/iroh-services/relays/self-hosted) ·
  [add a relay](https://docs.iroh.computer/add-a-relay).
- [RFC 8785, JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785).
- [Comparing iroh and libp2p](https://www.iroh.computer/blog/comparing-iroh-and-libp2p) (vendor
  source).
- [Hyperswarm](https://docs.pears.com/building-blocks/hyperswarm) ·
  [repo, MIT](https://github.com/holepunchto/hyperswarm).
- [Arti onion services](https://gitlab.torproject.org/tpo/core/arti/-/raw/main/doc/OnionService.md) ·
  [Arti 2.5.0](https://blog.torproject.org/arti_2_5_0_released/).
- [A2A specification](https://a2a-protocol.org/latest/specification/).
- [Tailscale Serve](https://tailscale.com/kb/1312/serve) ·
  [DERP servers](https://tailscale.com/docs/reference/derp-servers.md).

## 10. Review of 2026-10-16

The first draft was reviewed adversarially the same day. What changed, so the reasoning is not lost:

| Finding | Where it landed |
| --- | --- |
| Several admins with version numbers let a removed admin fork the roster, and stranded a peer offline across versions; the tie-break could never run; a joiner had no base case; "canonical JSON" was unnamed | §3.3: single signer, hash chain, self-certifying id, suffix fetch, RFC 8785 |
| The share key from `origin` failed for forks, SSH aliases, path case, monorepo projects and two clones | §3.4: remote preference, alias resolution, host case table, subpath, uniqueness, manual links |
| `blob {sha256}` was authorised by possession of a hash | §3.5 check 4, §4.2 |
| `asarUnpack` is not how this repo ships a native module; no macOS Intel build; a load failure had to be soft | §3.2 loading and packaging, §2 |
| A link to a plan that is not on `main` | §7 orchestration paragraph, written out |
| Self-hosted discovery was stated as available; the binding exposes none | §3.2 discovery, §8, §9 |
| Three gradient surfaces with two groups; `--live` on a sync state; `warn` on a relayed path | §5.1 |
| "En vivo" against the glossary; "relay" without a row | §5.4 |
| C4 needed network and two wrappers the harness lacks | §7 C0 and C4 |
| Chat-token 403 is a per-route set; reads matter too; share keys cannot be path segments | §6 |
| Terminal sessions have no content | §4.1 |
| Documents are the owner's working tree of a folder teammates have in git | §4.1, §5.3, §8 |
| Unshare was framed as enforced while removal was not | §2, §4.3, §5.2 |
| Invites needed the owner online | §3.3 relayed joins |
| Isolation: add a lint rule; a package boundary adds nothing | §3.5, §8 |
| `ProjectSettings` is strict; `PROJECT_VIEWS` is module-gated; workflow subagent transcripts; vault's new secret kind; QR dependency | §4.3, §5.3, §4.1, §3.1, §8 |

## Outcome

Built on `feat/collaborators` by the `claudio-collaborators` orchestration (2026-10-16), stages C1 to
C5 as §7.1 defines them. The feature is described in [collaborators.md](../collaborators.md); the
security additions are in [security-model.md](../security-model.md#collaborators) and the screens'
notes in the design system's [Landed](../design-system.md#collaborators-as-built) section.

**What shipped.** Everything in §3 to §6: the host process and the read-only serving side, the roster
chain and invites (direct and relayed joins), the share key, the storage and the sync client, every
§6 route (closed to chat tokens, reads included), the Collaborators page, the Sharing section and the
Shared tab, the `collaborators` illustration and the in-house QR encoder (versions 1 to 40).

**Where it differs from the plan.**

- The OpenAPI tag is `Collaborators`, capitalised like the other tags, not `collaborators`.
- The copy readers also take `?refresh=1`, which pulls from the owner first, and transcripts page by
  `limit` and `before` like a local chat. Neither is in §6.
- A share key already in use answers 409 with `{ error, code: 'share-key-in-use', projectId,
  projectName }`. With Collaborators off, the owner-only routes answer 409 `off` before they look at
  the group, so an unknown group gets 409 rather than 404.
- The You card has a **Turn off** button, which §5.1 does not specify.
- A shared project that is not cloned here first showed only "Not cloned here" and **Link to a local
  project**; the follow-ups below added the read-only view §5.1 asks for.
- The Shared tab's sub-tabs were first the four of §5.3; the follow-ups added Journal and Artifacts.
- The Sharing section and the Shared tab add no CSS. The page's variants are `.collab-*` in
  `claudio-ds.css`.
- The design-system stylesheet is `docs/design-system/claudio-ds.css`, not `agentry-ds.css`.

**Verified by the workers:** type checks, the core, API, ui, chat-ui and web tests of each task, the
schema drift check, and an API test that runs a real iroh endpoint on the minimal preset. **Not run
by any of them:** the browser specs (the `e1` and `e2e-specs` tasks own them) and a run between two
real machines after C0.

### Follow-ups (R12, 2026-10-17)

The gaps that orchestration left ([requests.md](../requests.md) R12) were closed on
`feat/collaborators-gaps`, one task each:

- **Frozen is real.** A group document records the endpoint id the install held the chain as
  (`heldAs`, backfilled for older chains). When that id is the owner's and the install now holds
  another key, `Group.frozen` is true and the card shows its warn line and **Create a new group**. A
  member's install never reports frozen: it cannot tell a lost owner from an offline one.
- **Members by name.** An invite names the members it lists as relays, so a joiner names the member
  holding its request before it has the roster; roster changes are announced by name; the web shows
  the short endpoint id in mono beside each member, join request and waiting join.
- **Quiet sync logs.** A `forbidden` answer is recorded once on the copies (translated reason) and once
  in the log, and the peer is asked again at a doubling wait from the reconcile pace up to a day, or
  on its hello. Other repeated failures are logged once per reason, and a recovery once.
- **Subagent transcripts.** A chat's record lists its subagents and workflow agents; their transcripts
  are pulled with the chat when their size changes and open from its delegations in the side panel.
  New route: `GET /collaborators/shared/:owner/:shareId/chats/:chatId/subagents/:agentId`.
- **Uploads per chat.** `chat_uploads` rows record which uploads a message attached (older chats are
  scanned once from their transcripts), so the owner serves a chat's uploads after a restart and a
  receiver pulls the artifacts after any chat changed.
- **Join requests notify.** The decision was yes: `collaborators.join-request` is a `high`
  notification of the new kind `collaborators`, in the bell and by push, and the new
  `collaborators.join-answered` event settles it ([notifications.md](../notifications.md#join-requests)).
- **Read-only view of an uncloned project.** `GET /collaborators/shared/:owner/:shareId` and the web
  route of the same path: the copy's name, owner, share key and sync state, the Shared tab's
  sub-tabs (now Chats, Memory, Journal, Documents, Artifacts, Board) and **Link to a local project**.
- **Browser specs and timings.** `collaborators.spec.mjs` covers names, the join notification, the
  read-only view and a revoked share; the new `collaborators-copies.spec.mjs` covers subagents,
  uploads and a frozen group (a peer restarted without its vault). Both have entries in
  `e2e/timings.json`.
- **iroh issues.** Both are rechecked against 1.1.0 and drafted in
  [reports/iroh-upstream-issues.md](../reports/iroh-upstream-issues.md). The pin of §8 stays until
  they are answered.

**Closed on 2026-10-17.** The owner ran Collaborators between real machines: three separate installs
for joins, denials and relayed joins, and two machines on different networks for invitations,
sharing, live sync, reconnection, revocation, agent reads and the read-only view of an uncloned
project. It works. Both iroh defects turned out to be filed upstream already (#276 open, #277 fixed
by #281 but not released); Claudio's reproduction was added to both, and the report says where they
stand. Nothing is open on our side.

### A denied join reaches the joiner (R14, 2026-10-17)

The owner's three-install LAN test found that a denial reached nobody: `denyJoin` deleted the
request on the owner and nothing told the joiner or the member that relayed it, and the joiner's
retry asked only for a chain, which a denied joiner never gets, so its page said pending for ever.
An invite that expired left the join pending for ever too. Fixed on `feat/collaborators-merge`:

- **The owner remembers.** `collab_join_denials` rows (group, joiner, `denialTag` of the invite
  secret's hash, the hash itself on the owner only, denied and expiry times), pruned once the invite
  would have expired. The tag, not the hash, travels: the hash is what spends an invite.
- **The wire says so.** `denied` answers a joiner's `roster` that names the tag, and a `join` with a
  denied invite. Members learn the group's denials with `joinAnswers` on each sync with the owner (the
  holding member is told to sync at once), keep them, drop the request copy they still held, and
  answer the joiner the same way. Every member hears every denial of the group, rather than only the
  one that held it: a joiner may ask any member its invite names.
- **Older peers.** A release before this drops `denial` and refuses `joinAnswers`; both read as "no
  answer yet", so the joiner waits as before and sync goes on.
- **The joiner.** A pending join now has a `state` (`waiting`, `denied`, `expired`) and `endedAt`;
  an ended one is never asked after again, emits `collaborators.join-ended`, and stays on the page
  until dismissed with `DELETE /collaborators/join/:groupId`. Pasting the denied invite again is
  refused with "Ana denied the request to join UDD with this invite".
- **Tests.** `packages/core/test/collab-join-answer.test.ts` runs the installs over an in-process
  network: a relayed deny learnt through the member with the owner gone, a direct one, an expiry, an
  owner from before this, and an answer from a newer peer. The web tests cover the two cards, and
  `collaborators.spec.mjs` a denial seen live on the joiner's open page.

## Related

[[collaborators.md]] · [[reports/iroh-upstream-issues.md]] · [[notifications.md]] · [[team-and-flow.md]] · [[tunnel.md]] · [[security-model.md]] · [[projects.md]] · [[layered-settings.md]] · [[design-system.md]] · [[accounts.md]]
