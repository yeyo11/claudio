---
description: Explores 3–5 radical variants of a screen in parallel, each in its own worktree under a different extreme constraint.
argument-hint: "<route> [n=3]"
---

Screen: the first word of `$ARGUMENTS`. Number of variants: the second word, or 3.

1. Load the `claudio-ui` skill.
2. Pick N extreme constraints that are **different from each other** from this list (or invent equally extreme ones):
   - "no border and no card background at all: hierarchy only with text and space"
   - "one line per decision point; the screen is a table of evidence (shadow → active)"
   - "keyboard only: no visible button, everything from Ctrl K and shortcuts"
   - "everything fits at 320 px without folding anything; what does not fit is removed"
   - "master-detail: points on the left, one point on the right with its evidence"
   - "configuration by task: the screen asks what you want to achieve, not what you want to set"
3. For each constraint, create a worktree from the current HEAD (`git worktree add .claude/worktrees/explore-<slug> -b explore/<slug>`), give it its own dev server port (5191, 5192, …), and launch a `ui-explorer` agent **in parallel** with `ROUTE`, `CONSTRAINT`, `WORKTREE`, `BRANCH` and `PORT`.
4. When they have all finished, present a comparison table: variant · invariants ✅/❌ · what it gains · what it loses · 320/1280 screenshots. Do not recommend one: the owner is the art director. Ask what to combine.
5. Do not remove the worktrees; the owner decides.
