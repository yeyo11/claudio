#!/usr/bin/env bash
# Builds every git layout a project can live in under the directory given (a fresh `mktemp -d`),
# and records git's own answers for each directory in `<root>/expected.json`, with `<root>` in
# place of the directory so the file can be compared across runs and machines.
#
# The parser in `packages/core/src/repos.ts` is checked against this file (`repos.test.ts`): git is
# the oracle, and these are the layouts `gitrepository-layout(5)` documents.
#
# Usage: make.sh <empty dir>
set -euo pipefail

root=$(cd "${1:?usage: make.sh <empty dir>}" && pwd -P)
cd "$root"

# Settings a person's own git config could change are pinned here, per command
g() { git -c init.defaultBranch=main -c protocol.file.allow=always -c user.name=a -c user.email=a@b -c worktree.useRelativePaths=false "$@"; }

seed() { # a repository with one commit and a subdirectory
  mkdir -p "$1/sub/dir"
  echo x >"$1/sub/dir/f"
  g -C "$1" add -A
  g -C "$1" commit -q -m init
}

# A plain repository, and every way a linked worktree of it can be laid out
g init -q plain
seed plain
g -C plain worktree add -q -b beside ../plain-beside
g -C plain worktree add -q -b worktree-cli-wt .claude/worktrees/cli-wt
# Added from inside another linked worktree: git still puts it under the main repository
g -C plain-beside worktree add -q -b from-beside ../plain-from-beside
# Removed from disk without `git worktree remove`: git lists it as prunable
g -C plain worktree add -q -b removed ../plain-removed
rm -rf plain-removed
g -C plain worktree add -q --detach ../plain-detached
g -C plain worktree add -q -b locked ../plain-locked
g -C plain worktree lock --reason 'in use' ../plain-locked

# A bare repository in the `<root>/.bare` layout, with two worktrees
mkdir bare-layout
g clone -q --bare plain bare-layout/.bare
echo 'gitdir: ./.bare' >bare-layout/.git
g -C bare-layout worktree add -q main-wt main
g -C bare-layout worktree add -q -b feature feature-wt

# A bare repository named `<name>.git`, its worktree beside it
g clone -q --bare plain named.git
g -C named.git worktree add -q -b named ../named-wt

# `git init --separate-git-dir`: the checkout's `.git` is a file pointing at a directory elsewhere
g init -q --separate-git-dir "$root/sep.git" sep-work
seed sep-work
g -C sep-work worktree add -q -b sep ../sep-wt

# A submodule, and a worktree of the submodule
g init -q super
seed super
g -C super submodule add -q "$root/plain" mod
g -C super commit -q -m 'add mod'
g -C super/mod worktree add -q -b modwt ../../mod-wt

# Relative paths in the worktree's `.git` file and the repository's `gitdir` file (git >= 2.48)
g init -q rel
seed rel
help=$(git -C rel worktree add -h 2>&1 || true)
if [[ $help == *relative-paths* ]]; then
  git -C rel config worktree.useRelativePaths true
  git -C rel worktree add -q --relative-paths -b relwt ../rel-wt
fi

# Not a repository at all
mkdir -p loose/sub

dirs=(
  plain plain/sub/dir plain-beside plain-beside/sub plain/.claude/worktrees/cli-wt plain/.claude/worktrees/cli-wt/sub/dir
  plain-from-beside plain-detached plain-locked
  bare-layout bare-layout/.bare bare-layout/main-wt bare-layout/main-wt/sub bare-layout/feature-wt
  named.git named-wt
  sep-work sep-work/sub sep.git sep-wt
  super super/sub super/mod super/mod/sub/dir mod-wt mod-wt/sub
  rel rel/sub rel-wt rel-wt/sub/dir
  loose loose/sub
)

# One answer per question: a bare repository has no top level, and a query that fails says nothing
ask() { git -C "$1" rev-parse "${@:2}" 2>/dev/null || true; }

node_json() { # dir → one JSON object of git's answers, paths relative to <root>
  local d=$1
  local common gitdir top prefix bare list
  common=$(ask "$d" --path-format=absolute --git-common-dir)
  gitdir=$(ask "$d" --absolute-git-dir)
  top=$(ask "$d" --show-toplevel)
  prefix=$(ask "$d" --show-prefix)
  bare=$(ask "$d" --is-bare-repository)
  list=$(git -C "$d" worktree list --porcelain 2>/dev/null || true)
  ROOT="$root" D="$d" COMMON="$common" GITDIR="$gitdir" TOP="$top" PREFIX="$prefix" BARE="$bare" LIST="$list" node -e '
    const e = process.env, rel = (p) => (p ? p.split(e.ROOT).join("<root>") : null);
    const worktrees = [];
    for (const line of e.LIST.split("\n")) {
      if (line.startsWith("worktree ")) worktrees.push({ path: rel(line.slice(9)), branch: null, detached: false, bare: false, locked: null, prunable: false });
      const w = worktrees[worktrees.length - 1];
      if (!w) continue;
      if (line.startsWith("branch ")) w.branch = line.slice(7).replace(/^refs\/heads\//, "");
      else if (line === "detached") w.detached = true;
      else if (line === "bare") w.bare = true;
      else if (line === "locked") w.locked = "";
      else if (line.startsWith("locked ")) w.locked = line.slice(7);
      else if (line === "prunable" || line.startsWith("prunable ")) w.prunable = true;
    }
    process.stdout.write(JSON.stringify({
      dir: e.D, commonDir: rel(e.COMMON), gitDir: rel(e.GITDIR), topLevel: rel(e.TOP),
      prefix: e.PREFIX === "" ? (e.TOP ? "" : null) : e.PREFIX.replace(/\/$/, ""),
      bare: e.BARE === "" ? null : e.BARE === "true", worktrees: e.COMMON ? worktrees : [],
    }));'
}

{
  echo '{'
  echo "  \"git\": \"$(git --version | sed 's/^git version //')\","
  echo '  "dirs": ['
  first=1
  for d in "${dirs[@]}"; do
    [ -e "$d" ] || continue
    [ $first = 1 ] || echo ','
    first=0
    printf '    %s' "$(node_json "$d")"
  done
  echo
  echo '  ]'
  echo '}'
} >expected.json
