---
description: Full review of a screen (rubric, invariants, screenshots) with a clean context. Required before a UI task is called done.
argument-hint: "<route> [commit|branch]"
---

Launch the `ui-reviewer` agent with `ROUTE` = the first word of `$ARGUMENTS` and `COMMIT`/`BRANCH` = the second word if there is one. Present its report in full. If the verdict is NOT SHIPPABLE, list the blocking findings as tasks and fix them in the main session; then run `/ui-review` again until it is SHIPPABLE. Do not call the task done without a SHIPPABLE.
