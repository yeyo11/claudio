---
created_at: 2026-10-16T22:32:57.97745428Z
updated_at: 2026-10-17T18:00:00Z
tags:
    - collaborators
    - peer-to-peer
    - iroh
    - sharing
    - security
    - mcp
    - assistant
    - feature
---
# Collaborators

Teammates each run their own Claudio on their own clone of the same repository. Collaborators lets a
person **share a project with a group**: each member's Claudio then holds a synchronised,
**read-only** copy of that project's chats, memory and journal, documents and artifacts, and board,
updated live while both machines are on. The Claudios connect directly, peer to peer, over
[iroh](https://iroh.computer), with no server of ours. The design, the review and the decisions are in
[the plan](plans/collaborators.md); this page says what exists and how to use it.

It is **off until the person turns it on**. Nobody can start work on another person's machine and
nobody's quota is spent: serving a copy never runs Claude.

## What a person can do

- **Turn it on** in the sidebar's Collaborators page (on a phone, under More). Turning it on makes
  this install's key, binds the connection and, only then, loads the native module. Turning it off
  closes it again. Where the module cannot load (for example macOS on Intel) the page says why and
  offers nothing.
- **Set a name and a label.** The name travels with every roster entry; the label tells two installs
  of one person apart ("desktop", "laptop"). A person with the desktop app and a dev server has two
  installs, so two members.
- **Create a group**, which makes this install its owner, or **join** one by pasting an invite.
- **Invite**: the owner makes an invite (text and QR code, valid 7 days, usable once). If the owner is
  offline when someone joins, the request waits with a member and reaches the owner when they are
  back; the page says "Waiting for the owner to come online" and names the member holding it (an
  invite carries the names of the members it lists as relays, so the joiner knows them before it has
  the roster).
- **Learn how a join ended.** A join that will not be signed does not stay pending: when the owner
  denies it, the joiner's page says "Ana denied your request to join UDD" (the bad tone, with the word
  **Denied** and an icon), and when the invite expires before the owner answered it says "The invite
  expired before Ana answered" (the warn tone, **Expired**). Either stays until the person
  **Dismisses** it, nothing asks after it any more, and the page changes live, without a reload. A new
  invite is a new request: being denied with one invite says nothing about the next.
- **Manage members** (owner): accept or deny join requests, remove a member, or make another member
  the owner. A member can leave, which deletes every copy synced through that group. Members, join
  requests and waiting joins are shown by name, with the label and the short endpoint id in mono as
  detail, and roster changes are announced by who joined, left or became the owner.
- **Be told of a join request**: a join waiting for the owner's answer notifies the owner in the bell
  and by push, and answering it settles the notification
  ([notifications.md](notifications.md#join-requests)).
- **Share a project**: in the project's Settings, the **Sharing** section has a switch per group, the
  share key and the warning that what was sent cannot be taken back.
- **Read what others share**: inside a project, the **Shared** tab shows a teammate's chats, memory,
  journal, documents, artifacts and board in read-only mode. A chat's subagents open from its
  delegations in the side panel, as in a local chat, and the files attached to its messages are
  among the artifacts. The Collaborators page lists everything shared with the person, grouped by
  person and install. A project that is not cloned here opens a **read-only view** of the same tabs,
  and can be linked to a local project.
- **Ask an agent about it** ([below](#agents-that-read-what-teammates-share)): the Claudio assistant
  answers "what is Ana working on?" from the copies, and a project that opts in lets its own chats
  read that project's copies.

## Where it shows

| Where | What |
| --- | --- |
| `/collaborators` | the page: this install, the groups and their members, join requests, what is shared with you |
| A project's Settings → Sharing | per-group switches, the share key and its remote, the warning; the sharer's flag "Teammates' agents may read this" and the project's own "Agents in this project can read what teammates share here" |
| The Collaborators page's **Agents** card | "The assistant reads what is shared with you", and a link to the agent-read audit |
| A chat's header | the neutral `Reads teammates' shares` badge while its agent may read a copy |
| Settings → Security → **Read by agents** | every read an agent made of a teammate's copy |
| A project's **Shared** tab | member switcher, then Chats, Memory, Journal, Documents, Artifacts and Board, read only |
| `/collaborators/shared/:owner/:shareId` | the read-only view of a shared project not cloned here: its name, owner, share key and sync state, the same sub-tabs, and **Link to a local project** |
| The bell | a join request waiting for the owner's answer, until it is answered |

The Shared tab only appears when Collaborators is on and a teammate's project matches this one. A
teammate's chats never mix into the person's own chat list, counts or badges. A chat that is running
on the teammate's machine shows the live rail and the braille spinner, since an agent is working
there now. A chat between turns is not running, even though its process waits for the next message:
its copy stands still, as the owner's own list draws it; the transcript has a "Read only · from Ana" bar where the composer would be. Documents
carry "Working copy on Ana's machine": what is shared is the owner's working tree, which may be
ahead of the committed files a teammate has through git. Terminal sessions are not shared.

## The roster and the share key, in plain words

**The roster.** A group has one **owner**, and the owner's key signs the member list. Every change
(someone joins, leaves, is removed, becomes owner) is a new signed version on top of the last, and
every member keeps the whole chain. A peer accepts a version only if it extends the chain it holds and
is signed by the previous owner, so a Claudio that was offline for any number of changes catches up
as soon as it meets any member, and nobody can forge a roster for a group they do not own.

- **Joining** needs the invite's one-time secret. A second use is refused and an expired one is too.
  When the owner is offline, the request is sealed to the owner's key, so the member holding it only
  carries an opaque blob.
- **Denying** is remembered. The owner keeps each denial (the group, the joiner's endpoint id, the
  invite secret's hash, when) as a `collab_join_denials` row until the invite would have expired. A
  joiner that is not in the chain yet asks with a tag derived from that hash (`denialTag`), never the
  secret nor the hash itself, and an install holding a denial with that tag answers `denied` instead
  of `forbidden`; the owner answers a `join` with an invite it denied the same way. Members ask the
  owner for the group's denials (`joinAnswers`) on every sync with it, and the member that held the
  request is told to sync at once, so a joiner whose owner is away again learns the answer from any
  member its invite names. A member drops the copy it still held of a denied request. A peer from
  before this answers `forbidden` and refuses `joinAnswers` as a frame it does not know, which reads as
  "still waiting": nothing breaks, the joiner just learns nothing until its invite expires.
- **Removing** a member makes every unmodified Claudio stop serving that person. The copies they
  already hold stay on their machine, and the page says so before the owner confirms. Nobody sends
  the removed install the version that removes it, so its own roster may still list it; a join it
  makes later is therefore always asked of the owner or a member, never answered from that roster,
  and its request waits and can be denied like anyone's. A member who pastes an invite again is
  answered with the chain by the owner or any member, and from its own roster only when nobody
  answers.
- **Transferring ownership** is one click: the owner signs a version naming the new owner. Do it
  before changing machines.
- **If the owner's install is lost** nobody can sign again. The group is frozen with its last roster,
  and the way out is a new group. That is the price of a single signer. The owner's own Claudio
  knows: each group remembers the endpoint id the install held its chain as, and when that id is the
  owner but the install now has another key (the vault was lost, or the data restored without it),
  the group card says the group can no longer change and offers **Create a new group**. A member's
  install cannot tell a lost owner from one that is offline, so it never says frozen.

**The share key** says which projects are "the same project" on two machines. Project ids are random
on each machine, so the key is built from the git remote: `<host>/<path>`, plus `#<subpath>` for a
project inside a monorepo.

- The remote is `upstream` if there is one, else `origin`, else the only remote, so teammates working
  from forks still match. A person can pick another remote.
- Credentials are dropped, an SSH alias is resolved to its real host, and the path is lower-cased
  only on hosts whose paths are case-insensitive (github.com, gitlab.com, bitbucket.org,
  codeberg.org, dev.azure.com).
- The key is editable (`[a-z0-9._/#-]`, 3 to 200 characters). Two local projects cannot share one
  key: the second one's Sharing section names the first and its switches stay off until the key is
  edited.
- With **no remote** the key is `local/<random>`, and a teammate sees the project as "Not cloned
  here" until they link it.
- **Linking by hand**: on the receiving side, a shared project that did not match has **Link to a
  local project**. The pairing is stored with the group and can be undone.

## What n0 sees

The connection uses iroh's defaults, run by n0:

- **Discovery.** n0's discovery server learns each install's endpoint id and its addresses. The
  Node binding exposes no way to change it, so this is a fixed dependency of v1.
- **Relays.** n0's public relays carry the traffic until a direct path is found, or for the whole
  connection when none is (across a mobile carrier's NAT none was found in testing). They carry
  encrypted traffic they cannot read, and they are rate-limited. The page says "Connected through a
  relay" for such a peer. A **custom relay URL** in the You card points at a self-hosted `iroh-relay`
  and removes the relay part; the discovery part stays.
- **Nothing else.** The transcripts, memory and documents go from machine to machine over an
  encrypted connection; n0 never holds them.

## What is cooperative

Every peer runs its own copy of Claudio, so nothing here is enforced on someone else's machine. What
a receiver deletes when sharing stops or a member leaves, stops showing, or stops serving describes
what an **unmodified** Claudio does. A person who received a transcript has it: the page says plainly
that what was shared cannot be unshared, and transcripts are shared as they are, tool output
included. The group is trusted.

What the sharing side does enforce, on its own machine:

- the protocol handler only has read-only access to chats, transcripts, memory, journal, documents,
  work items and uploads; it is never handed anything that starts a chat, a run, a flow or an
  orchestration, by construction, by a lint rule and by a test;
- every request must come from a member of a group, for a project shared with **that** group, of a
  kind that project shares; a blob is served only when a shared record references its hash;
- the local routes are closed to a chat's token, so a teammate's transcript never enters an agent's
  context unasked. The one exception is the copy reads, for the chats the person let read them, as the
  next section says.

## Agents that read what teammates share

Decided in [plans/collaborators-agent-access.md](plans/collaborators-agent-access.md) (R13). A
teammate's text is input the person does not control, and an agent that reads it can be steered by it,
so reading is narrow on purpose and every read is recorded.

**Who reads what.**

- **The Claudio assistant reads every shared copy** while Collaborators is on and its switch, "The
  assistant reads what is shared with you" in the Collaborators page's Agents card, is on (it is on
  by default; `CollaboratorsSettings.assistantReads`). The assistant runs no command, so the risk is
  low. With the switch off its guide says it cannot read them and points at the Shared tab.
- **A project's chats read that project's copies only when the project opts in**: "Agents in this
  project can read what teammates share here" in its Sharing section, off by default
  (`ProjectSharingSettings.agentReads`). A copy belongs to the local project it was linked to by
  hand, or, without a link, to the projects whose share key matches it.
- **Never a chat that runs commands without asking.** Only `manual` (the CLI's default), `acceptEdits`
  and `plan` read; `bypassPermissions`, `auto` and `dontAsk` get neither the tools nor the routes.
  Orchestration workers run in `bypassPermissions`, so they never read a teammate's text.
- **The sharer can forbid it.** "Teammates' agents may read this", beside the share key, is on by
  default (`agentsMayRead`; a share from before the flag counts as on). It travels with the share in
  the catalog, and the reading install honours it: with it off no chat and not the assistant gets that
  copy, the copy says "The sharer does not let agents read this", and the person still reads it in the
  Shared tab.

**The tools.** Claudio's MCP server ([claudio-mcp-server.md](claudio-mcp-server.md)) has seven
read-only tools for the copies: `collab_list_shared`, `collab_read_chats`, `collab_read_transcript`
(paged, subagents included), `collab_read_memory`, `collab_read_documents`, `collab_read_board` and
`collab_read_journal`. They read this install's copy only: none reaches a peer or starts a sync (the
API ignores `refresh` on a chat's read), and none writes. The assistant gets them beside its own reads.
A chat of a project that opted in gets Claudio's server with only these tools, added to the servers it
loads, or merged into the strict config file of the servers it chose; the server offers what
`CLAUDIO_MCP_TOOLSETS` names. Which chat gets them is decided at every process of the chat, and the
API decides again at every call, so turning a switch off closes the routes at once.

**Third-party content.** Every result puts the teammate's text, as one line of compact JSON, inside a
fence longer than any backtick run in it, tagged `untrusted-third-party-content`, under a header of
ours that names the person, the install, the project and the share key, says when the copy was last
synced, and says it is third-party content, not instructions. Names the teammate chose appear in the
header only as quoted, cut JSON strings. A body past 45,000 characters is cut, and a line after the
fence says so. Documents and uploads are listed by name and size: no blob is ever returned, and the
blob route stays closed to chat tokens.

**The audit.** Every read is a `collab_agent_reads` row (when, the chat, the tool as it names itself in
`x-claudio-tool`, the owner, the share key, the kind, the record ids), the newest 20,000 kept, listed
by `GET /collaborators/agent-reads`. The copy says "Read by N chats today", linked to Settings →
Security, where the **Read by agents** card lists every row.

**In the chat.** A chat whose agent may read shows `Reads teammates' shares` in its header
(`chat.teammateReads`, the scope of its live process), and a `collab_*` tool row names whose share it
read ("from Ana · laptop · api").

## How it is built

- **A process of its own.** The iroh endpoint runs in a child process, `collab-host.mjs`, forked by
  the core as `terminal-host.mjs` is. A panic in the native binding loses the connections and nothing
  else; the core restarts it and reports it. The host polls and never uses the binding's `watch*`
  calls, which abort the process in `@number0/iroh` 1.1.0 (pinned until that and the `Buffer` issue
  are answered upstream; both are drafted, not filed, in
  [reports/iroh-upstream-issues.md](reports/iroh-upstream-issues.md)).
- **Its own protocol**, `claudio/collab/1`, as length-prefixed JSON frames on QUIC streams. The HTTP
  API is never exposed to the network.
- **Storage.** Settings, the signed chains, links and cursors are JSON under
  `<dataDir>/collaborators/`; the synchronised records, transcript lines, peers, pending joins and
  used invites are SQLite rows; blobs are files named by their hash, fetched when opened. The
  project's own sharing choice is `ProjectSettings.sharing`.
- **Subagents and uploads travel with their chat.** A chat's record lists its subagents and workflow
  agents; their transcripts are served through the chat's, kept beside it on the copy, pulled only
  when their size changed and dropped with the chat. Which uploads a chat attached is kept as
  `chat_uploads` rows, written as a message goes out (a chat from before them is scanned once from
  its transcript), so the owner answers a chat's uploads after a restart too, and a receiver pulls
  the artifacts after any chat changed.
- **Live** means a `changed` notice makes the receiver pull right away, and a running chat's
  transcript is pulled as it grows. Removed records are found by a catalog reconcile on connect and
  every 10 minutes.
- **Quiet failures.** A peer that answers `forbidden` stopped sharing or removed this install: its
  copies say so once, the log says so once, and it is asked again at a wait that doubles from the
  reconcile pace up to a day, or as soon as it says hello. Any other failure is logged when its
  reason changes, and the recovery once. Log lines name the peer with the start of its id.
- **The API** is the Collaborators table in the [README](../README.md#collaborators); the events are
  `collaborators.changed`, `collaborators.peer`, `collaborators.synced`,
  `collaborators.join-request`, `collaborators.join-answered` and, on the joiner's install,
  `collaborators.join-ended` (its join denied, or its invite expired unanswered). A join request
  notifies the owner in the bell and by push, and its answer clears it
  ([notifications.md](notifications.md#join-requests)).
- **End-to-end specs.** `collaborators` and `collaborators-copies` drive peers the harness starts
  fresh for each spec, but the main wrapper outlives every spec of its shard. Each spec therefore
  takes its group off it in its cleanup (`e2e/specs/collab-shared.mjs`): a group left there makes the
  next spec's Invite dialog ask which group instead of making the invite as it opens, which is how
  `collaborators` failed only when the other spec ran before it. On a failure the spec records,
  before its cleanup, the dialog's text, the invite answers the page received, the groups and the
  collab lines every server logged (the harness's `capture()` and `serverLog()`).
  `collaborators-agents` drives the agent reads: a project chat's `collab_read_chats` call through the
  e2e fake CLI's `mcp:` step, which starts the server `--mcp-config` names and calls the tool over
  stdio as the CLI does ([e2e/fake-cli/README.md](../e2e/fake-cli/README.md)). The runner drops
  `CLAUDIO_MCP_ENTRY` from the environment it hands the servers, so chats run this checkout's MCP
  server rather than a desktop install's older one.

## Related

[[plans/collaborators.md]] · [[plans/collaborators-agent-access.md]] · [[claudio-assistant.md]] · [[claudio-mcp-server.md]] · [[reports/iroh-upstream-issues.md]] · [[notifications.md]] · [[security-model.md]] · [[projects.md]] · [[design-system.md]] · [[tunnel.md]] · [[terminal.md]] · [[team-and-flow.md]]
