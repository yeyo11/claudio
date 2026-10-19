---
created_at: 2026-10-17T11:40:00Z
updated_at: 2026-10-18T18:00:00Z
tags:
    - plan
    - e2e
    - flaky
    - terminal
    - harness
    - built
---
# Six flakes that only a loaded machine showed

Five browser specs and one web unit test failed at least once under load and passed alone. Each was
reproduced first (the spec run several times side by side, beside other suites, or with the tab's CPU
throttled) and then fixed at its cause, following [[plans/e2e-harness-waits.md]]: a wait on the
condition, never a longer sleep, and no assertion weakened.

## What each one was

| Failure | Cause | Fix |
| --- | --- | --- |
| `highlight.test.ts`, the first C++ block uncoloured | A TextMate grammar compiles a rule the first time a line reaches it, and that time counts against shiki's per-line limit. The C++ grammar took 18 to 27 s to compile at a load of 46. | `compileFor` in `packages/ui/src/components/highlight.ts` runs the grammar over the block's lines (up to 1000 characters each) with no limit before the timed tokenization. |
| `terminal.spec`, refused requests | The core's peer check answered `unknown` when a process of some chat's tree was caught exiting (its descriptors refuse EACCES while its state still reads running), and `unknown` under `mode: none` refuses the terminal. 1 to 3 requests in 100 on a machine whose agents start processes constantly. | `PeerCheck.check` stays one quick synchronous look and answers `exiting` when such a process is in the way; the async `PeerCheck.verdict` that every gate awaits looks again from the start, socket included, up to 25 times on 20 ms timers, so the API keeps serving while it waits and a slow first look on a loaded machine does not spend the whole wait. |
| `terminal.spec`, step 7 | "Click the item if the panel is not shown yet" raced the panel coming back on its own, and the click closed it. | The step reads `claudio-terminal-bar` first. |
| `detail.spec`, Escape | Closing the panel is a navigation, which React Router renders in a transition, after the key's 250 ms pause. | Wait for the dialog to be gone. |
| `integrations.spec`, sign-in methods | The panel's frame renders before `GET /setup` answers. | Wait for the method choice. |
| `merge.spec`, the warning state | The fake gh applied `state: closed` to every pull request, and the watcher stored the others closed when it polled in that window. | `stateOf` in the fake hosts names the one number. |
| `merge.spec`, reduced motion | The media change reaches the page as an event, after the 300 ms pause. | Wait for the still glyph. |
| `composer.spec`, a `SecurityError` on `sessionStorage` | Not reproduced: 150 navigations under a 4x throttle never left the tab off the app. The same error has been seen in other specs as a read of storage on `about:blank`. | `page.goto` now fails at once when the tab is not on the app after the navigation, and a `SecurityError` in `page.eval` says where the tab is. |

The peer check's retry on a process caught exiting is gone since 2026-10-18: the check now finds the
socket's holder itself instead of scanning the chats' trees, so a process exiting somewhere in a
chat's tree no longer stands between the person and the answer ([[plans/terminal.md]] §3.5).

## Tools this left

- `E2E_CPU_THROTTLE=N` slows every tab N times (`Emulation.setCPUThrottlingRate`).
- The terminal spec's waits report the panel, the feature's status, the shells the server holds and
  every `POST /api/terminals` the page sent, with its stack. One run held two shells after opening
  the panel once; this report is what will say who opened the second.
- The merge spec's visits report the block's HTML, the API's merge read and the fake's last calls.

## Related

[[plans/e2e-harness-waits.md]] · [[plans/e2e-blank-page.md]] · [[plans/ci-e2e-shards.md]] · [[plans/terminal.md]]
