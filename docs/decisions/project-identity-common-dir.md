---
created_at: 2026-10-19T17:00:00Z
updated_at: 2026-10-19T17:00:00Z
tags:
    - decision
    - projects
    - git
    - worktrees
---
# Decision: a project is a repository's common directory and a subdirectory

Taken on 2026-10-19 (D1 by the owner, D2–D4 by [the plan](../plans/projects-as-repositories.md) from
the evidence in its Context). How it works is in [projects.md](../projects.md#a-project-is-a-repository).

## Why

A project was a directory with a random id, and where a chat belonged was guessed three ways: the
CLI's `worktree-state`, a path pattern and a `.git` file walked up eight levels. `originalCwd` (where
the person started `claude --worktree`) was trusted as the repository although it is often a sibling
or nested worktree, so Claudio suggested projects it then refused to import. It also missed bare,
`--separate-git-dir` and submodule layouts, and suggested `$HOME` and workspace roots because they
held chats.

## D1. Identity is `(commonDir, subdir)`

A project is a git repository (git's common directory, real path) and its directory relative to the
checkout's top level. Two projects of a monorepo differ by `subdir` and share the worktrees. A
directory in no repository is a project by path, as before.

Rejected: the remote URL as the identity. Two clones of one remote are two working copies with their
own branches and worktrees, and a repository may have no remote. The remote is recorded and shown,
never used to merge, and a second clone is imported with a notice (the owner chose two projects, not
a merge).

## D2. Facts come from git's own files, with git as the authority

`repoOf` reads the documented layout (`.git` file or directory, `gitdir:`, `commondir`,
`core.worktree`, `core.bare`) and asks `git rev-parse` only where the files do not decide. An
oracle test compares the parser with git on fixture repositories of every layout.

Rejected: one git process per directory. The owner's 848 transcript folders would make hundreds of
spawns per list, and reading git's documented files is what the old code already did.

## D3. A directory is placed in a fixed order, and `originalCwd` is never a parent

On disk, then its remembered row, then the CLI's record (placing `originalCwd`, taking its
repository), then the `<X>/.claude/worktrees/<name>` layout (placing `X`), else no repository.
`originalCwd` only names a repository through its own placement, so a sibling or nested worktree
resolves to the main checkout it belongs to.

Rejected: trusting `originalCwd` as the parent, which is what produced suggestions that could not be
imported.

## D4. Placements are remembered in SQLite

`repo_places` has one row per directory a chat or run used, upserted and never deleted: an
accumulating record two processes share, so rows and not JSON. A removed worktree stays history
(its chats keep their project and `exists: false`) and is never offered as a place to work.

Rejected: forgetting a worktree when its directory goes. 813 of the owner's 848 transcript folders
are removed worktrees, and nothing else remembers which repository they were.

## Related

[[projects.md]] · [[plans/projects-as-repositories.md]] · [[cli-surfaces.md]] · [[work-items.md]]
