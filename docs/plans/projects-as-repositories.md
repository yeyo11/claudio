---
created_at: 2026-10-19T15:00:00Z
updated_at: 2026-10-19T15:00:00Z
tags:
    - plan
    - projects
    - worktrees
    - git
    - decision
    - design-system
---
# Plan: projects as git repositories, worktrees as their children

Status: **planned** (2026-10-19). The owner set the model on 2026-10-19: **a project is a git
repository, its worktrees are its children, and suggestions are grouped by repository and never
include `$HOME` or a workspace root.** The work is one pull request on
`feat/projects-as-repositories`, built by the orchestration in [Tasks](#tasks). `repo-model` and
`review` run on `claude-opus-5-5`, every other task on `claude-sonnet-5-5`, never fable. Four
[open questions](#open-questions) have a default the plan builds unless the owner says otherwise.

This plan is the source of truth for that orchestration, together with CLAUDE.md and
CONTRIBUTING.md. Where a task prompt and this plan disagree, the plan wins. Workers never run the
e2e suite: CI runs it (`pnpm e2e:remote`, the `e2e-on-github` skill).

The approach is the end state, not a patch to the two leaks: the model is designed first, today's
behaviour is its degenerate case (a project that is not a git repository is a directory, attached
by path as now), and every fact comes from what git and the CLI already write.

## Context

Each fact below was re-read in the code at `671350a4d` and in the owner's data on 2026-10-19.

### 1. A project is a directory with a random id

- `ProjectRecord` is `{ id, name, path }` (`packages/core/src/projects.ts:12-16`), stored whole in
  `data/projects.json` by `ProjectStore` (`:117-146`). The id is a `randomUUID()` (`:181`); the path
  is `resolve()`d, not `realpath`ed, and says nothing about git. `idFor` gives a removed project its
  old id back by **path** (`:180`, through `ProjectSettingsStore.idForPath`,
  `packages/core/src/project-settings.ts:607`).
- `add()` refuses a path only when it **is** a worktree's top level (`projects.ts:174-175`); a
  subdirectory of a linked worktree is imported as if it were a project of its own.
- The contract: `Project`, `ProjectWorktree` (`path`, `name`, `branch`, `createdBy` of an
  orchestration task only) and `ProjectCandidate` (`path`, `name`, `chatCount`, `lastActivity`) in
  `packages/shared/src/types.ts:1690-1723`; `ChatWorktree` (`path`, `name`, `branch`) at `:1152`,
  carried by `Chat.worktree` (`:1322`) and `ChatRef.worktree` (`:1428`).
- Routes: `GET /projects`, `GET /projects/candidates`, `GET /projects/templates`,
  `POST /projects/import` (`apps/api/src/routes/projects.ts:10-20`).

### 2. Where a directory belongs is decided from three guesses

- `Locator.worktreeOf` (`packages/core/src/locations.ts:61-92`) answers `{ path, name, branch,
  parentPath }`, in this order: the CLI's `worktree-state` record learnt from a transcript
  (`sessions.ts:65-75`: `worktreePath`, `originalCwd` → `parentPath`, `worktreeName`,
  `worktreeBranch`); the path pattern `CLI_WORKTREE_RE = /^(.+)\/\.claude\/worktrees\/([^/]+)/`
  (`locations.ts:12`, greedy, so a nested path takes the last match); then the `.git` file
  (`fromDotGit`, `:31-52`), which accepts only `<repo>/.git/worktrees/<name>` (`:41`) and walks up at
  most 8 levels (`:15`). Answers are cached 30 s per directory (`:13`).
- `attachProject` (`projects.ts:53-66`) maps a worktree directory to `parentPath + rest` and looks
  for the deepest project there, else falls back to plain path containment.
- `placeOf` (`packages/core/src/index.ts:444`) places a chat at `worktree?.path ?? projectPath`.
  `Core.projects()` (`index.ts:2252-2310`) collects worktrees from chats, from orchestration tasks
  and from a `readdir` of `<project>/.claude/worktrees`, and drops those no longer on disk (`:2304-2305`).
  The collaborator readers use the same `worktreeOf` (`index.ts:1609`,
  `packages/core/src/collab/readers.ts`).

### 3. The leaks

- **`originalCwd` is trusted as the repository.** It is where the person started `claude
  --worktree`, which is often a worktree itself. In the owner's transcripts on 2026-10-19 the most
  frequent `originalCwd` values are `~/Escritorio/claudio-stage-a` (a sibling linked worktree of
  `claudio`, now deleted) and `~/Escritorio/claude-wrapper/.claude/worktrees/project-ecosystem`
  (a worktree nested in another repository's worktree folder). One record reads, verbatim:
  `originalCwd: …/claudio-stage-a`, `worktreePath: …/claudio/.claude/worktrees/cabc7d9a-s1`,
  `originalBranch: docs/chat-experience-plan`. So the CLI puts the worktree under the **main**
  checkout and records the sibling it was started from. `projectCandidates` (`projects.ts:82`)
  offers `parentPath` as a project while it exists, and `add()` then refuses it as a worktree: a
  suggestion that cannot be imported. A chat whose `parentPath` is under no project and whose
  worktree is outside every project is loose.
- **Layouts git supports are not recognised.** `fromDotGit` misses a bare repository with worktrees
  (`repo.git/worktrees/<n>`), a `--separate-git-dir` checkout, a submodule's worktree
  (`.git/modules/<m>/worktrees/<n>`) and relative `gitdir:` paths (`worktree.useRelativePaths`,
  git ≥ 2.48; this machine has 2.53.0).
- **Noise.** The live suggestions on the owner's desktop app on 2026-10-19 were `~/Agentry/workspace`,
  `~/Claudio/workspace`, `/home/yeyo`, `~/.local/share/claudio-preview/workspace` and
  `~/Escritorio`. **None of the five is a git repository** (checked with `git rev-parse`). They are
  `$HOME`, a folder holding repositories, the desktop app's `CLAUDIO_WORKSPACE_DIR` default
  (`apps/desktop/src/main.ts:69`), the legacy Agentry one and a preview's.
- **Deleted worktrees** lose their placement. `~/.claude/projects` holds 848 transcript folders, 813
  of them for `.claude/worktrees/…` directories, most already removed. When neither the record nor
  the path pattern helps (a sibling worktree, removed), nothing remembers which repository it was.

### 4. What git and the CLI already give

- git: `rev-parse --path-format=absolute --git-common-dir` (used by `mainTopLevel` and
  `mainCheckout`, `packages/core/src/git.ts:67-89`; `mainCheckout` already handles a submodule
  through `core.worktree`); `worktree list --porcelain` (parsed by `worktrees()`, `git.ts:101-112`,
  which reads `branch` and `locked` but not `bare`, `detached` or `prunable`). git's on-disk format
  is documented in `gitrepository-layout(5)`: a `.git` file's `gitdir:`, a linked worktree's
  `commondir`, and `<common>/worktrees/<id>/{gitdir,HEAD,locked}`.
- The CLI: `--worktree <name>` (`packages/core/src/providers/claude-code/args.ts:52`) creates or
  adopts `<main top level>/.claude/worktrees/<name>` on branch `worktree-<name>`, and writes the
  `worktree-state` record above into the transcript.

### 5. The worktrees Claudio creates

| Creator | Where | Branch | Code |
| --- | --- | --- | --- |
| Orchestration task | `<main top level>/.claude/worktrees/<orchId8>-<taskId>` | `worktree-<name>` | `orchestrator.ts:280-288`, `prepareWorktree` `:1313`, `pruneWorktrees` `:3312` |
| Work item ("Work on it", flow) | `<main checkout>/.claude/worktrees/task-<key>` | `claudio-task/<key>` | `work-links.ts:191,209-240`, removed by `pull-requests.ts:1374` |
| Chat with `--worktree` | `<main top level>/.claude/worktrees/<name>` | `worktree-<name>` | `live-chat.ts:727` |
| Eval lane | `<dataDir>/eval-lanes/<run>/lane<n>`, detached | none | `evals/lanes.ts:24,108-146` |

## Decisions

Set by the owner on 2026-10-19 (D1, D8) or taken by this plan from the evidence above. Each says
what was rejected.

### D1. A project is a repository and a subdirectory; a plain directory is the degenerate case

- A project's identity is **`(commonDir, subdir)`**: git's common directory, real path, and the
  project's directory relative to the checkout's top level (`''` at the root). Two projects of one
  monorepo differ by `subdir`; they share the repository's worktrees.
- `path` stays what the person sees and opens: the main checkout plus `subdir`.
- A directory that is not in a git repository is a project by `path` alone, attached by path
  containment exactly as today. Nothing in that case changes.
- Rejected: the remote URL as the identity. Two clones of one remote are two working copies with
  their own branches and worktrees, and a repository may have no remote. The remote is recorded and
  shown (D7), never used to merge.

### D2. Repository facts are read from git's own files, with git as the authority

- `repoOf(dir)` in a new `packages/core/src/repos.ts` answers `RepoFacts`:
  `{ commonDir, mainCheckout | null, worktree | null, topLevel, subdir, branch | null, detached, bare }`.
  It walks up from `dir` (to the filesystem root, not 8 levels) to the first `.git`:
  - a directory: the git dir and the common dir are it, `mainCheckout` is its parent unless the
    common dir's `config` sets `core.worktree` (a submodule) or `core.bare`;
  - a file: `gitdir:` (absolute or relative to the file) is the git dir; its `commondir` file
    (absolute or relative) gives the common dir, else the git dir is the common dir (a
    `--separate-git-dir` checkout or a submodule);
  - the linked worktree is the walk's stop directory when the git dir differs from the common dir.
- `commonDir` is `realpath`ed, so a symlinked checkout and its target are one repository.
- When the parse cannot decide (an unreadable file, a layout the spike finds it gets wrong), one
  `git rev-parse --path-format=absolute --git-common-dir --absolute-git-dir --show-toplevel
  --show-prefix --is-bare-repository` answers instead, and its answer is cached like any other.
  git refusing a repository it does not trust (`safe.directory`) is an unknown, not "no repository".
- **Spike first** (`repo-model` step 1): the parser is checked against git on fixture repositories
  before anything uses it.
- Rejected: one git spawn per directory. 848 transcript folders make that hundreds of processes
  per list; the files are git's documented format and reading them is what `fromDotGit` already
  does.

### D3. A directory is placed in this order, and `originalCwd` is never a parent

`place(dir, record?)` answers `{ repo: RepoFacts | null, exists, source }`:

1. `dir` exists → `repoOf(dir)` (D2). The answer is recorded (D4).
2. `dir` is gone → its recorded row (D4).
3. Gone, no row, and the chat has a CLI `worktree-state` record → `place(originalCwd)`
   recursively, taking its `commonDir`; `worktreeName`/`worktreeBranch` give the name and branch.
4. Gone and the path matches `<X>/.claude/worktrees/<name>` → `place(X)` recursively, non-greedy
   from the left so a nested worktree resolves to the repository that holds `X`.
5. Nothing → no repository: attached by path containment, as today.

Recursion stops after 4 steps. `originalCwd` only ever names a repository through its own
placement, so a sibling or nested worktree resolves to the main checkout it belongs to.

### D4. Placements are remembered in SQLite, so a deleted worktree stays history

- A new table `repo_places`, one row per directory a chat or a run has used: an accumulating record
  shared by two processes, so rows in SQLite, not JSON.
- Rows are upserted (`INSERT … ON CONFLICT(dir) DO UPDATE`), idempotent facts that need no claim. A
  row from the disk is never overwritten by a weaker source (record or layout) once the directory is
  gone; `gone_at` is set the first time it is found missing and cleared if it comes back.
- Rows are never deleted: they are how a chat in a removed worktree keeps its project.
- A removed worktree is **never offered as a place to work**: not in the Worktrees tab, not as a
  "New chat here" target. Its chats keep `Chat.worktree`, with `exists: false`.

### D5. `projects.json` gains the repository, once, and never moves a path

- `ProjectRecord` gains `repo: { commonDir, subdir, remote } | null`. The document gains
  `"version": 2`.
- **Migration.** On load, a record with no `repo` key is resolved with `repoOf(path)` (`null` when
  the path is not in a repository or is missing) and the document is written once, atomically.
  A missing directory is re-resolved on a later load. An older Claudio reads the file unchanged: it
  keeps records with `id`, `name` and `path` and ignores the rest.
- A project whose path lies inside a **linked worktree** keeps its path; its view says so and names
  the main checkout ([open question 1](#open-questions)). Nothing moves on its own.
- `idForPath` also matches a removed project by `(commonDir, subdir)`, so re-importing a repository
  from the main checkout gives its id back even if the old path was a worktree.

### D6. Worktrees are the repository's children, from git, with Claudio's facts on top

- `worktreesOf(commonDir)` reads `<commonDir>/worktrees/*/{gitdir,HEAD,locked}` (D2's parser) and
  answers the main checkout first, then every linked worktree: path, branch or detached, locked
  reason, and whether the directory exists. `git worktree list --porcelain` is the test oracle and
  the fallback; `worktrees()` in `git.ts` learns `bare`, `detached` and `prunable`.
- `Core.projects()` merges each worktree with who made it: an orchestration task (as now), a work
  item (`claudio-task/<key>` and `item.worktree`), or a chat (the transcript's `worktree-state`
  whose `worktreePath` it is). A worktree nobody in Claudio made has no creator ("git worktree add").
- Listed: the ones that exist and are not prunable. Hidden: removed ones (counted in
  `removedWorktrees`) and eval lanes (under `lanesRoot`, Claudio's own scratch).
- Each worktree counts the project's chats placed in it, with its last activity.
- For a project with a `subdir`, `ProjectWorktree.cwd` is `path + subdir`: where a chat for that
  project starts.
- The `readdir` of `<project>/.claude/worktrees` (`index.ts:2290-2294`) goes: git's list has them.

### D7. Import says what a path is before it is imported

- `POST /projects/import` refuses:
  - a path **inside** a linked worktree (any depth, not only its top level): 400, code
    `linked-worktree`, naming the main checkout plus the same subdirectory;
  - a `(commonDir, subdir)` that is already a project: 409, code `already-a-project`, naming it.
- A second clone (another `commonDir` with the same normalised `origin` URL) is imported, and the
  wizard says another clone is already a project. Rejected: refusing it (two clones are legitimate,
  D1).
- `GET /projects/inspect?path=` answers what the wizard needs before the person presses Import:
  whether it exists, the repository facts, the path to import, the conflict if any, the same-remote
  project and the worktree count.
- The remote is `remote.origin.url` read from `<commonDir>/config` (`git config --file … --get`,
  one spawn per repository, cached), with any `user:password@` stripped before it leaves core.

### D8. Suggestions are grouped by repository, and noise never appears

- `GET /projects/candidates` groups every chat that is not in a project by its placement's
  `commonDir`. One suggestion per repository: its main checkout, "N chats across M worktrees", the
  remote, the last activity. A repository that already has a project is not suggested, even if some
  of its chats are outside that project's `subdir` (they stay loose).
- Directories that are not in a repository form a **second, collapsed group** ("Other
  directories"), at most 5.
- Never suggested: the temp dirs (as now); a directory that no longer exists; `$HOME`, `/` and every
  ancestor of `$HOME`; the configured `workspaceDir` itself (its children are fine); `configDir`,
  `dataDir`, `lanesRoot` and what is under them; **a directory that holds a known repository** (a
  folder like `~/Escritorio`); and the workspace roots of Claudio installs that are not this one:
  `~/Claudio/workspace`, `~/Agentry/workspace`, `/workspace`, and `$XDG_DATA_HOME/*/workspace` when
  it is not a git repository.
- A person can hide a suggestion; that is the general answer to noise the rules miss. Hidden keys
  live in `data/project-suggestions.json`, a settings-shaped document. Undo is a toast.
- At most 8 repositories, ordered by chats, then last activity, then path.

### D9. Performance: no git process per chat

- Placements are cached in memory per directory (60 s for existing ones, no expiry for gone ones),
  backed by `repo_places`. A list resolves each **distinct** directory once, not each chat.
- Parsing is a handful of `stat` and small reads per directory: for the owner's 848 folders well
  under 100 ms cold.
- `worktreesOf` is cached per `commonDir` for 30 s and invalidated by every place Claudio adds or
  removes a worktree (orchestrator, work links, pull requests, chats with `--worktree`).
- Budget, enforced by a test: `projects()` and `projectCandidates()` over 1,000 synthetic
  directories in 50 repositories finish in < 300 ms and spawn **no** git process on a warm cache
  (the `git()` helper is spied), and at most one per repository (the remote) on a cold one.

### D10. The one rule holds

The sources are the CLI's transcript records (`worktree-state`), the CLI's `--worktree` layout, git's
files and the `git` CLI. Nothing new talks to Claude. `docs/cli-surfaces.md` gains a row for
`worktree-state` (`originalCwd`, `worktreePath`, `worktreeName`, `worktreeBranch`).

### D11. Bare repositories are recognised and importable

- A bare repository's worktrees group under it. Its import path is the directory holding the bare
  git dir when that is named `.bare` or `.git` (the common `<root>/.bare` layout), else the bare git
  dir itself; `mainCheckout` is `null`.
- Its project has no "New chat here" at the root: the header's New chat opens on the Worktrees tab
  to pick one. The spike confirms the layouts before this is built
  ([open question 4](#open-questions)).

## Design

Load the `claudio-ui` skill. The references are `DesktopProyectos`, `MobileProyectos`,
`DesktopProyecto` (the Worktrees tab), `DesktopNuevoProyecto` and `MobileNuevoProyectoOrigen`, built
by `docs/design-system/reference/tools/projects.py`. No new illustration, no new gradient surface:
the page's one primary stays the header's "Importar directorio".

### Suggestions on the Projects page

- **First start** (no projects): the existing `Card` `.project-candidates`, titled "Empieza por los
  repositorios en los que ya trabajas". Each row (`.candidate-row`):
  - name, `--fw-strong`, `--fs-body`;
  - the remote in mono small muted (`github.com/yeyo11/claudio`, scheme and `.git` dropped), or the
    path in mono when there is no remote; the path goes in the row's `title`;
  - a meta line, small muted, tabular: "312 chats en 14 worktrees · última vez hace 2 h"; with no
    worktree, "312 chats · …";
  - when another clone is already a project, a neutral line with the `Copy` icon: "Otro clon de
    «claudio»" (no status colour: it is neither a problem nor a limit);
  - actions: "Importar" (`.btn-small`, as today, to the wizard with `?path=`) and a ghost icon button
    `EyeOff` "Ocultar sugerencia".
- Under the repositories, a disclosure row "Otros directorios · 3", collapsed. Open, it says "No son
  repositorios git. Impórtalos solo si son proyectos." and lists rows of the same shape without
  worktrees or remote.
- **With projects**: the dashed `.project-callout` stays. Its title counts repositories ("4
  repositorios más tienen chats"), or directories when only those remain; "Revisar" opens the same
  grouped list.
- **Hiding** removes the row at once and shows a toast "Sugerencia oculta" with "Deshacer".
- **States.** Loading shows nothing (suggestions are optional, and a placeholder would move the
  page). An error shows nothing and logs. No suggestions: no card and no callout.
- **Phone.** Rows stack: name, remote, meta; "Importar" is full width at ≥ 44 px; "Ocultar" moves
  into a "⋯" `Sheet` with one action. The disclosure is a 44 px row.

### The wizard's Where step

With a path (typed or from `?path=`), it calls `GET /projects/inspect` (debounced 300 ms) and shows
under the field:

- a repository: a mono line "Repositorio git · origin github.com/yeyo11/claudio · 3 worktrees";
- inside a linked worktree: a field error "Es un worktree de claudio. Importa el checkout principal."
  with a button "Usar ~/Escritorio/claudio" that replaces the path (mono inside the button);
- already a project: a field error "Ya es el proyecto «claudio»" with "Abrir";
- another clone: a `.callout` "Ya tienes otro clon de este repositorio: «claudio». Sus chats y tareas
  van por separado.";
- not a repository: nothing extra (today's behaviour).

Create stays disabled while there is a field error.

### Worktrees under a project

The Worktrees tab (`apps/web/src/pages/home/ProjectWorktrees.tsx`) lists the main checkout first,
then the linked worktrees by last activity:

- the main checkout row: the branch (mono, `GitBranch`) and a neutral badge "principal"; no
  "Nuevo chat aquí" (the header has New chat);
- each worktree row: branch mono (or "HEAD separado" as a neutral badge with the short name), the
  path mono small muted, the creator line (orchestration · task as today; "Tarea AGN-12 · <title>"
  linking to the item; "Chat · <first prompt>" linking to the chat; nothing for one made by hand),
  a meta line "5 chats · hace 2 h" linking to `/chats?project=<id>&worktree=<path>`, a neutral
  `Lock` badge "bloqueado" with the reason as its title, and "Nuevo chat aquí" to `ProjectWorktree.cwd`;
- a footer line, small muted, when `removedWorktrees > 0`: "12 worktrees eliminados siguen en el
  historial de sus chats", linking to `/chats?project=<id>&worktree=removed`;
- empty (only the main checkout): the existing `Empty` with the projects illustration, below the
  main checkout row;
- a project that is not a repository: the tab says "Este proyecto no es un repositorio git" in the
  same `Empty`.

On a phone each row stacks and "Nuevo chat aquí" is full width at ≥ 44 px.

### Chats

The existing worktree tag (`apps/web/src/pages/Chats.tsx:247`) stays. When `chat.worktree.exists`
is false the tag reads the branch and the word "eliminado", muted, and the chat's own "New chat here"
paths never target it. The `worktree` query parameter filters the list on the client (`removed`
matches `exists === false`).

### Copy

New keys in `apps/web/src/i18n/locales/{en,es}/projects.json` (and `chats.json` for the tag):

| Key | en | es |
| --- | --- | --- |
| `candidates.firstTitle` | Start with the repositories you already work in | Empieza por los repositorios en los que ya trabajas |
| `candidates.firstBody` | Claude Code has run in these repositories the most. Import the ones that are projects: their chats and worktrees join them. | Claude Code se ha ejecutado sobre todo en estos repositorios. Importa los que sean proyectos: sus chats y worktrees se unen a ellos. |
| `candidates.across_one/_other` | {{chats}} across {{n}} worktree / worktrees | {{chats}} en {{n}} worktree / worktrees |
| `candidates.otherClone` | Another clone of “{{name}}” | Otro clon de «{{name}}» |
| `candidates.hide` / `hideNamed` | Hide suggestion / Hide {{name}} | Ocultar sugerencia / Ocultar {{name}} |
| `candidates.hidden` / `undo` | Suggestion hidden / Undo | Sugerencia oculta / Deshacer |
| `candidates.others` | Other directories · {{n}} | Otros directorios · {{n}} |
| `candidates.othersBody` | They are not git repositories. Import them only if they are projects. | No son repositorios git. Impórtalos solo si son proyectos. |
| `candidates.moreRepos_one/_other` | {{n}} more repository has chats / repositories have chats | {{n}} repositorio más tiene chats / repositorios más tienen chats |
| `inspect.repo` | Git repository · {{remote}} · {{n}} worktrees | Repositorio git · {{remote}} · {{n}} worktrees |
| `inspect.linkedWorktree` / `useMain` | It is a worktree of {{name}}. Import the main checkout. / Use {{path}} | Es un worktree de {{name}}. Importa el checkout principal. / Usar {{path}} |
| `inspect.alreadyProject` | Already the project “{{name}}” | Ya es el proyecto «{{name}}» |
| `inspect.otherClone` | You already have another clone of this repository: “{{name}}”. Their chats and tasks stay separate. | Ya tienes otro clon de este repositorio: «{{name}}». Sus chats y tareas van por separado. |
| `worktrees.main` / `detached` / `locked` | main / detached HEAD / locked | principal / HEAD separado / bloqueado |
| `worktrees.removed_one/_other` | {{n}} removed worktree is still in its chats' history / … | {{n}} worktree eliminado sigue en el historial de sus chats / {{n}} worktrees eliminados siguen en el historial de sus chats |
| `worktrees.notRepo` | This project is not a git repository | Este proyecto no es un repositorio git |
| `chats:list.worktreeRemoved` | removed | eliminado |

## Contracts

### Shared types (`packages/shared/src/types.ts`)

```ts
/** The git repository a project lives in. */
export interface ProjectRepo {
  /** git's common directory, real path: the repository's identity on this machine */
  commonDir: string;
  /** The main checkout's top level; null for a bare repository */
  mainCheckout: string | null;
  /** The project's directory relative to the checkout's top level, '' at the root */
  subdir: string;
  /** origin's URL with credentials stripped; null without an origin */
  remote: string | null;
  bare: boolean;
}

export type WorktreeCreator =
  | { kind: 'orchestration'; orchestrationId: string; orchestrationName: string; taskId: string; taskName: string }
  | { kind: 'work-item'; key: string; title: string | null }
  | { kind: 'chat'; chatId: string; title: string | null };

export interface ProjectWorktree {
  path: string;
  /** Where a chat for this project starts in it: `path` plus the project's subdir */
  cwd: string;
  name: string | null;
  branch: string | null;
  main: boolean;
  detached: boolean;
  /** The lock's reason, '' when locked with none; null when not locked */
  locked: string | null;
  chatCount: number;
  lastActivity: string | null;
  createdBy: WorktreeCreator | null;
}

// Project gains:
  repo: ProjectRepo | null;
  /** Worktrees git no longer has, still named by the chats that ran in them */
  removedWorktrees: number;
  /** The path lies inside a linked worktree: the main checkout plus subdir, else null */
  insideWorktreeOf: string | null;

// ChatWorktree gains:
  /** False once the worktree is removed: history, never a place to start a chat */
  exists: boolean;

export interface ProjectCandidate {
  /** What hiding it records: the common dir, or the path for a directory */
  key: string;
  kind: 'repository' | 'directory';
  path: string;
  name: string;
  remote: string | null;
  chatCount: number;
  worktreeCount: number;
  lastActivity: string | null;
  /** A project that is another clone of the same remote */
  sameRemoteAs: ChatProject | null;
}

export interface CandidateKeyRequest { key: string }

export type ProjectPathConflict =
  | { kind: 'linked-worktree'; importPath: string; repoName: string }
  | { kind: 'already-a-project'; project: ChatProject };

export interface ProjectPathInspection {
  path: string;
  exists: boolean;
  repo: ProjectRepo | null;
  /** What Import would record: the path itself, or the bare layout's root */
  importPath: string;
  conflict: ProjectPathConflict | null;
  sameRemoteAs: ChatProject | null;
  worktreeCount: number;
}
```

`createdBy` changes shape (a `kind` is added to the orchestration case). The web is the only
client; `docs/rest-api.md` notes it.

### Routes

| Route | Change |
| --- | --- |
| `GET /projects` | `repo`, `removedWorktrees`, `insideWorktreeOf`; worktrees per D6 |
| `GET /projects/candidates` | `ProjectCandidate[]` per D8, repositories first, then directories |
| `POST /projects/candidates/hide` | new, body `CandidateKeyRequest`, 204 |
| `POST /projects/candidates/unhide` | new, body `CandidateKeyRequest`, 204 |
| `GET /projects/inspect?path=` | new, `ProjectPathInspection`; 400 without `path` |
| `POST /projects/import` | 400 `linked-worktree`, 409 `already-a-project` |

The three new routes are registered **before** `/projects/:id` and need a summary and tag in
`apps/api/src/openapi/routes.ts` and a row in `docs/rest-api.md` (`add-rest-route` skill). A chat's
token may call them (they read, or touch only suggestions); no new denylist entry.

### Files on disk

- `data/projects.json`: `{ "version": 2, "projects": [{ "id", "name", "path", "repo": { "commonDir", "subdir", "remote" } | null }] }`.
- `data/project-suggestions.json` (new): `{ "hidden": [{ "key": "…", "at": "<ISO>" }] }`, written
  with `writeAtomic`.
- SQLite, a new migration in `packages/core/src/db.ts`:

```sql
CREATE TABLE repo_places (
  dir           TEXT PRIMARY KEY,
  common_dir    TEXT,             -- null: not in a repository
  main_checkout TEXT,
  worktree      TEXT,             -- linked worktree top level; null in the main checkout
  subdir        TEXT NOT NULL DEFAULT '',
  branch        TEXT,
  source        TEXT NOT NULL,    -- 'disk' | 'git' | 'cli-record' | 'layout'
  seen_at       TEXT NOT NULL,
  gone_at       TEXT
);
CREATE INDEX repo_places_common ON repo_places (common_dir);
```

## Tasks

The integrator launches this graph on `feat/projects-as-repositories`:
`repo-model → suggestions-core → web-projects → review · docs`.

| Id | Task | dependsOn | Owns | Checks |
| --- | --- | --- | --- | --- |
| `repo-model` (opus) | D1–D7, D9–D11: spike, `repos.ts`, `repo_places`, placement, migration, worktrees, import rules, inspect | – | `packages/core/src/repos.ts` (new), `packages/core/src/locations.ts` (removed or re-exported), `packages/core/src/projects.ts`, `packages/core/src/git.ts` (`worktrees()`), the `repo_places` migration in `db.ts`, the project and placement parts of `packages/core/src/index.ts`, `project-settings.ts` `idForPath`, `collab/readers.ts`, worktree-cache invalidation lines in `orchestrator.ts`, `work-links.ts`, `pull-requests.ts`, `live-chat.ts`, `Project`/`ProjectWorktree`/`ChatWorktree`/`ProjectRepo`/inspect types, `GET /projects/inspect`, the import errors in `apps/api/src/routes/projects.ts`, their `routes.ts` and `rest-api.md` rows, `packages/core/test/fixtures/repos/**` | `pnpm typecheck`, `pnpm test` (core, api), `openapi:schemas`, the D9 budget test |
| `suggestions-core` (sonnet) | D8: grouping, exclusions, hide store and routes | `repo-model` | `projectCandidates` in `projects.ts` (or `project-candidates.ts`, new), `packages/core/src/project-suggestions.ts` (new), `Core.projectCandidates`, `ProjectCandidate`/`CandidateKeyRequest` types, the two hide routes, their `routes.ts` and `rest-api.md` rows | `pnpm typecheck`, `pnpm test`, `openapi:schemas` |
| `web-projects` (sonnet) | the Design section | `suggestions-core` | `apps/web/src/pages/Projects.tsx`, `apps/web/src/pages/projects/**` (Where step), `apps/web/src/pages/home/ProjectWorktrees.tsx`, `ProjectHead.tsx` (New chat on a bare project), `apps/web/src/pages/Chats.tsx` (tag and filter), `apps/web/src/insights.css` candidate rules, the project functions in `apps/web/src/api.ts`, `locales/{en,es}/projects.json`, `chats.json` key, `docs/design-system/reference/tools/projects.py` and the regenerated Proyectos references, `docs/design-system.md` §Projects, `e2e/specs/projects-repositories.spec.mjs` (new), `a11y-projects`, `projects-wizard`, `home`, `chats` specs and their fake transcripts | `pnpm typecheck`, `pnpm test` (web), design lint, `/ui-review` of `/projects`, the wizard and the Worktrees tab in both themes at 1600×950, 1280×720 and 390×844 |
| `review` (opus) | design, conventions, one rule, migration safety | the three above | none (findings, or one-line fixes nobody owns) | reads; at most one test run |
| `docs` (sonnet) | `docs/projects.md` (identity, worktrees, suggestions, import), `docs/cli-surfaces.md` row, `docs/rest-api.md` check, `docs/work-items.md` note on two projects of one repository, `docs/status.md`, this plan's Outcome, `docs/decisions/project-identity-common-dir.md` (new, D1–D4) | the three above | those files | `pnpm test` (docs tests) |

`repo-model` and `suggestions-core` both edit `types.ts`, `routes.ts`, `rest-api.md` and
`projects.ts`; they run in series and append in separate places. The integrator regenerates the
schemas once after merging.

### Rules for every task

1. Work only in your worktree, on your branch; Conventional Commits in English with a body saying
   why. Never push.
2. Read CLAUDE.md and CONTRIBUTING.md first. TypeScript strict, no `any`, `noUncheckedIndexedAccess`.
3. Run `pnpm typecheck` and `pnpm test`. Write or update e2e specs, but **never run `pnpm e2e`**: CI
   runs them.
4. A new route needs its summary and tag in `apps/api/src/openapi/routes.ts` and a row in
   `docs/rest-api.md` (the `add-rest-route` skill). After `types.ts` changes, run
   `pnpm --filter @claudio/api openapi:schemas`.
5. Never run git commands that change the person's repositories from tests: fixtures are built in a
   `mktemp -d` and removed after.
6. UI tasks load the `claudio-ui` skill and pass `/ui-review` before finishing.

### `repo-model` (opus)

1. **Spike** (first commit, `test(core): record how git lays out worktrees`). Write
   `packages/core/test/fixtures/repos/make.sh`, which builds in a temp dir: a plain repository; a
   linked worktree beside it; one under `.claude/worktrees/`; a worktree added from inside another
   linked worktree; a removed worktree (prunable); a bare clone with two worktrees in the `<root>/.bare`
   layout; a `git init --separate-git-dir` checkout with a worktree; a submodule and a worktree of
   it; a repository with `worktree.useRelativePaths=true`. For each directory, save git's answers
   (`rev-parse` as in D2, `worktree list --porcelain`) to `expected.json`. Say in the commit body
   where `--separate-git-dir` and bare layouts put the main worktree, and whether D11's import path
   rule holds.
2. **`repos.ts`**: `repoOf`, `worktreesOf`, `remoteOf`, the D2 fallback. Test: the parser equals
   `expected.json` for every fixture directory (the oracle test), and spawns nothing where it
   decides.
3. **`repo_places`** migration and a `RepoPlaces` store (`upsert`, `get`, `markGone`), following the
   existing migration list in `db.ts:77`.
4. **`RepoIndex`** (`place(dir, record?)`, D3, D9 caches) replaces `Locator`. `TranscriptSummary.worktree`
   stays as the CLI wrote it; `originalCwd` is only an input to step 3.
5. **Attachment** by `(commonDir, subdir)`, longest `subdir` prefix wins, path containment for
   non-repositories. `projectOf`, `attach`, `place`, `chatPlaces` and the collaborator readers use
   it.
6. **`ProjectStore`**: the v2 document and its migration (D5), `add()` refusing per D7 with typed
   errors the route maps to 400 and 409, `idForPath` by `(commonDir, subdir)`.
7. **`Core.projects()`** per D6; drop the `.claude/worktrees` `readdir`; invalidate `worktreesOf`
   where Claudio adds or removes a worktree.
8. **`GET /projects/inspect`**.
- **Tests:** the oracle test; placement of the leaked cases (a `worktree-state` whose `originalCwd`
  is a sibling worktree, existing and removed; a nested `.claude/worktrees` path; a removed worktree
  with only a `repo_places` row); migration of a v1 document, including a missing path and a path
  inside a linked worktree; import refusals; `idForPath` by repository; the D9 budget.

### `suggestions-core` (sonnet)

1. Grouping by `commonDir` and the directory group (D8), on `RepoIndex` placements.
2. Every exclusion in D8, each with a test, using an injected `home`, `workspaceDir`, `configDir`,
   `dataDir`, `lanesRoot` and `XDG_DATA_HOME`.
3. `ProjectSuggestions` store over `data/project-suggestions.json`, and the hide and unhide routes.
- **Tests:** the five noise directories of [Context §3](#3-the-leaks) are never suggested; a
  repository with chats in 14 worktrees is one suggestion counting 14; a repository with a project
  is not suggested; a hidden key stays hidden across a restart; `sameRemoteAs` with credentials in
  the URL never shows them.

### `web-projects` (sonnet)

1. The suggestions list and callout, hide with undo, the collapsed other directories.
2. The wizard's Where step with `inspect`.
3. The Worktrees tab, the Chats tag and filter.
4. The references: `projects.py` draws the grouped suggestions (desktop and phone) and the
   Worktrees tab with a main checkout, a locked worktree, a work item's and the removed footer;
   regenerate, and update `docs/design-system.md` §Projects.
5. e2e (written, not run): `projects-repositories.spec.mjs` seeds fake transcripts with a
   `worktree-state` from a sibling worktree and checks one suggestion per repository, hiding and
   undo, the wizard's linked-worktree error and "Usar …", and the Worktrees tab; update
   `a11y-projects`, `projects-wizard`, `home` and `chats` where their copy or selectors changed.

### `review` (opus)

Review the merged design, not just the diff: the one rule (D10); no git spawn on the list path
(read the budget test); the migration never drops or moves a record and an older reader still loads
the file; `repo_places` upserts are safe with two processes; credentials never leave core in a
remote; D8's exclusions; the copy against the glossary; gradients, status colours (none is used for
"another clone", "locked" or "removed") and mono only on paths, branches and remotes. Findings go
to the integrator with file:line and the smallest fix.

### `docs` (sonnet)

The files in the table, with the `write-knowledge-doc` skill. The decision record states D1–D4 with
what was rejected.

## Tests

Unit and API tests are listed per task. Across the graph:

- **Verification** (the integrator, on the merged branch): `pnpm typecheck`, `pnpm test`,
  `pnpm build`, `openapi:schemas` with no drift; then the built server against a copy of the owner's
  `~/.claude/projects` (read only, `CLAUDE_CONFIG_DIR` pointing at the copy) and a copy of
  `projects.json`: the candidates list holds no non-repository in the first group and none of the
  five noise directories; `claudio` and `claude-wrapper` are two suggestions; the migrated
  `projects.json` keeps every id.
- **e2e** (CI): `pnpm e2e:remote projects-repositories a11y-projects projects-wizard home chats`.

## Risks

- **The parser disagrees with git on a layout nobody tried.** The oracle test covers the layouts
  git documents; anything else falls back to `rev-parse`.
- **Migration on a slow or missing disk** (an unmounted drive holding a project): the record gets
  `repo: null` and is re-resolved on a later load; nothing is dropped.
- **Monorepo projects now share worktrees.** Two projects of one repository both list them; their
  chats still count per project. `docs/work-items.md` already allows two projects of one repository.
- **`createdBy` changes shape.** A script reading it breaks; it is noted in `rest-api.md`.
- **Containers.** Transcripts written on the host name host paths the container cannot see: they
  resolve as gone, through records and layout; repositories under `/data` or `/workspace` children
  work as anywhere. `/workspace` itself is excluded (D8).
- **`safe.directory`.** The parser places a repository git would refuse; later git operations there
  still fail with git's own message, as today.

## Open questions

Each has a default the plan builds.

1. **A project imported inside a linked worktree** (possible before D7): only a notice naming the
   main checkout (default), or an action that re-points the project's path (needs `path` in
   `PATCH /projects/:id`)?
2. **Two clones of one remote**: kept as two projects with a notice (default), or offered to merge?
3. **"Other directories"**: keep the collapsed non-repository group (default), or suggest only
   repositories?
4. **Bare repositories**: build D11 now (default), or recognise them for grouping only and leave
   import for later if the spike shows layouts vary too much?

## Related

- [[projects]]
- [[work-items]]
- [[cli-surfaces]]
- [[rest-api]]
- [[orchestrations]]
- [[design-system]]
- [[status]]
- [[plans/project-ecosystem]]
- [[plans/work-item-pull-requests]]
- [[plans/instruction-evals]]
- [[plans/container-polish]]
- [[decisions/e2e-on-github]]
- [[decisions/project-identity-common-dir]]
