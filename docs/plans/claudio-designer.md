---
created_at: 2026-10-17T08:30:00Z
updated_at: 2026-10-18T12:00:00Z
tags:
    - plan
    - design-system
    - ui
    - typography
    - tooling
    - claude-code
---
# Plan: the Claudio designer, and the typographic voice it brings

Status: **built** (2026-10-17), in one pull request on `feat/claudio-designer`. What was found while
building it is in [§4](#4-as-built).

The owner brought a bundle called `claudio-designer` (a Claude Code plugin plus files for the
repository) that turns UI design in Claudio into a system instead of a prompt: a skill with a
manifesto whose rules each forbid something, anti-patterns drawn from Claudio's own screens, a review
rubric, machine-checked invariants, three subagents (information-architecture audit, radical
exploration, clean-context review), commands, and hooks that lint every edit and refuse to end a UI
task without a review. It was written in Spanish and without knowledge of this stack (it assumed
Tailwind, `src/ui`, Playwright and a settings schema). This plan records how it was adapted and
what it changes in Night Shift.

## Decisions (owner, 2026-10-17)

1. **Where it lives:** in the repository's `.claude/` (skill, agents, commands, hooks), so every
   session and every orchestration worker gets it without flags. It replaces the
   `night-shift-ui-check` skill.
2. **The manifesto wins on the mono voice.** Mono is for literals the machine reads (ids, paths,
   model ids, commands, hashes, branch names, variables, code) and nothing else: not section labels,
   not badges, not counts, times or money. Night Shift's "Geist Mono for ids, paths, commands, counts,
   times and section labels" is replaced.
3. **The manifesto's type scale replaces Night Shift's.** Four sizes, two weights (below). 34, 24,
   12 and 11 px are gone.
4. **Invariants are ported to the CDP e2e harness**, not to Playwright: the repo has its own driver
   (`e2e/driver.mjs`) and axe-core already, and no `?fixture=` mode goes into the app.
5. **Hooks as in the bundle:** a blocking design lint after every edit of a UI file, and a Stop hook
   that asks for `/ui-review` once when UI files changed and no review ran.
6. **Everything in this pull request**: the tooling, the restyle of every screen, and the debt the
   new invariants found in the app (446 findings on the first run), down to a green spec.
7. **Left out:** the bundle's CI job (`claude-code-action` with an API key) and its skill evals.
   Also left out, because they are already covered or do not apply: its `tokens.json`/`tokens.css`
   (Night Shift keeps its palette), Tailwind rules, `src/dev/fixtures.ts`, and the settings-schema
   renderer (`defineSettings`), which is a redesign of Settings that `/ui-audit` proposes first.

## 1. The voice

### 1.1 Type scale (tokens in `packages/ui/src/styles/tokens.css`)

| Token | Use | Size / line | Weight |
|---|---|---|---|
| `--fs-title` / `--lh-title` | screen title, the one big number of a tile | 20 / 28 | `--fw-strong` |
| `--fs-section` / `--lh-section` | section title, card title | 15 / 22 | `--fw-strong` |
| `--fs-body` / `--lh-body` | labels, values, body text, controls | 14 / 20 | `--fw-regular` |
| `--fs-small` / `--lh-small` | consequences, hints, metadata, badges, literals in mono | 13 / 18 | `--fw-regular` |
| `--fs-input` | every input, select and textarea on a phone (iOS zooms below 16) | 16 | |

`--fw-regular` is 450 and `--fw-strong` is 600 (Geist is variable). No other size, no 700.
`--tracking-title` (-0.01em) may go on titles; `--tracking-caps` (0.06em) goes with the caps level
only.

**Mapping of what exists** (1120 `font-size` declarations, 30 values):

| Today | Becomes |
|---|---|
| 17 px and above (17 … 34) | `--fs-title` |
| 15, 15.5, 16, 16.5 px | `--fs-section` (an input's 16 px on a phone is `--fs-input`) |
| 14, 14.5 px | `--fs-body` |
| 13.5 px and below (9 … 13.5) | `--fs-small` |
| `0.9em`, `0.86em`, `0.95em`, `inherit` | `inherit` (inline code takes the size of its line) |
| weight 400, 450, 500 | `--fw-regular` |
| weight 550, 600, 650, 700 | `--fw-strong` |

Buttons' labels are `--fw-strong`. A line height in px becomes the paired `--lh-*`; a unitless line
height may stay. The terminal's cell size is the person's own setting and stays out of the scale.

### 1.2 Mono only for literals

Mono (`var(--mono)`, `.mono`, `<code>`) says "this is literal, the machine reads it". Keep it on:
ids (chat, run, work item key, commit), paths and file names, model ids, commands and flags, hashes,
branch names, environment variables, code, diffs, logs, keyboard keys.

Take it off (sans, with `tabular-nums` where it is a number): section labels and group headings,
badges and status words, counts, times, dates, durations, money, percentages, column heads, kickers
and eyebrows, the status bar except its literal values. Money is sans: `347,21 US$`.

Ids add `slashed-zero` to `tabular-nums` (`.mono` does it).

### 1.3 Caps with tracking, one level only

Only the sidebar's group headings (`.nav-group-label`, `.live-section-head`) and their phone twin
on the More page (`.more-group-head`): `--fs-small`, `--fw-regular`, `--tracking-caps`, `--fg-3`,
uppercase, sans. Nowhere else: what was a mono uppercase section label becomes `--fs-small`,
`--fw-strong`, `--fg-2`, sentence case. Copy that relied on `text-transform` is rewritten in sentence
case in `en` and `es` (the glossary already asks for it).

### 1.4 Weight never changes on hover or selection

A rule for `:hover`, `.active`, `.selected`, `.on`, `.is-active`, `[aria-current]`,
`[aria-selected]` or `[aria-pressed]` never sets `font-weight`: the text widens and moves its
neighbours (AP12). Selection is said with fill and colour.

### 1.5 Numbers through Intl

Every percentage, amount and count shown is formatted by `packages/ui/src/lib/format.ts`
(`Intl.NumberFormat`). A locale string never carries the sign (`"{{pct}}%"`, `"{{value}} %"`):
it receives the formatted value (`"{{percent}}"`), so `27 %` in Spanish and `27%` in English come
from Intl and never disagree on one screen (AP8). `toFixed()` is not used to show a number.

## 2. The tooling

| Piece | Where | What it does |
|---|---|---|
| Skill `claudio-ui` | `.claude/skills/claudio-ui/` | When to use it, the loop, the most broken rules; `references/` holds the manifesto, settings patterns, typography and voice, anti-patterns, invariants and the rubric, adapted to Night Shift. Replaces `night-shift-ui-check`, whose checklist moves into it |
| Agent `ia-auditor` | `.claude/agents/` | Read-only map of Settings and navigation, with labels (remove, defer, demote to hint, fold, translate, keep) and the decisions for the owner |
| Agent `ui-explorer` | `.claude/agents/` | One radical variant of a screen under one extreme constraint, in its own worktree |
| Agent `ui-reviewer` | `.claude/agents/` | Clean context; runs the invariants and captures through `scripts/ui-check.mjs`, measures, scores R1–R12, verdict SHIPPABLE / NOT SHIPPABLE |
| Commands | `.claude/commands/ui-audit.md`, `ui-explore.md`, `ui-review.md` | Launch the three agents |
| Design lint | `scripts/design-lint.mjs` | The rules of §1 and Night Shift's (tokens only, controls, no `<details>`, no `title=` on interactive elements, no `100vh`) over CSS, TSX and locale files. One module used by the hook, by the web test and by hand |
| Hook `design-lint` | `.claude/hooks/design-lint.mjs` (PostToolUse on Edit/Write) | Lints the file just edited; exit 2 hands the problems back to Claude |
| Hook `ui-invariants-fast` | `.claude/hooks/ui-invariants-fast.mjs` (PostToolUse) | When a dev server answers, runs the fast invariants on the screen the file renders (`.claude/designer/route-map.json`) at 320 and 1280 |
| Hook `require-review` | `.claude/hooks/require-review.mjs` (Stop) | Once per set of edited UI files: asks for `/ui-review` if no `ui-reviewer` ran after the last edit |
| UI check | `scripts/ui-check.mjs` | Against the web dev server of the checkout under review (`pnpm dev`): screenshots of a route over widths × themes and the invariants I1–I13, through `e2e/driver.mjs` |
| Invariants | `e2e/ui/invariants.mjs`, `e2e/specs/ui-invariants.spec.mjs` | The same checks inside the e2e run, over the main routes with long content seeded |
| Guard | `apps/web/test/design-voice.test.ts` | `pnpm test` fails on any design-lint error in the tree |

### Invariants (ported)

| # | Invariant | Where |
|---|---|---|
| I1 | No page-level horizontal scroll at 320, 390, 768, 1280 | `e2e/ui/invariants.mjs` |
| I2 | No element overflowing with `overflow-x: visible` | same |
| I3 | Truncated text has its full text (Tooltip, `aria-describedby` or a non-interactive `title`) | same |
| I4 | Cumulative layout shift < 0.001 during a route's interactions | same, per route in `e2e/ui/routes.mjs` |
| I5 | A button with states (`data-states`) keeps its width | same |
| I6 | `scrollbar-gutter: stable` on vertical scrollers | same |
| I7 | Live numbers (`.tnum`, `[data-live-number]`) are tabular | same |
| I8 | axe: no violations | already `a11y-*.spec.mjs`; `ui-check` runs it too |
| I9 | Targets ≥ 44 px under 768, ≥ 24 px above | same |
| I10 | Inputs ≥ 16 px under 768 | same |
| I11 | Visible focus on everything focusable | same |
| I12 | Keyboard reach, Escape closes overlays | already `a11y-shell.spec.mjs` |
| I13 | Motion stops under reduced motion | already `motion.spec.mjs` |
| I14 | Token pairs meet contrast | already `a11y-shared.mjs` (theme tokens) |
| I15–I18 | Tokens only, shared controls, Intl formatting, the voice of §1 | `scripts/design-lint.mjs` + guard test |
| I19 | The open dialog, drawer or sheet fits its window (`overlayFit`, added by #40): inside the viewport and the overlay gutter (above the on-screen keyboard), a close button in its head that is on screen, uncovered and below the desktop app's window controls, a title that does not run under it, footer buttons not clipped, no sideways overflow, no control cut by an `overflow` ancestor, no scroller inside a scroller; on a phone, 44 px targets and 16 px inputs too | `e2e/ui/invariants.mjs`, `e2e/specs/ui-overlays.spec.mjs` (320, 390, desktop and the desktop app) |

## 3. The restyle (this pull request)

Every stylesheet of `apps/web/src`, `packages/ui/src` and `packages/chat-ui/src`, and the TSX that
picks mono or sets type inline, moves to §1. Done by developer agents in parallel, each owning a set
of stylesheets and the components that use their classes; then `docs/design-system.md`,
`docs/design-system/claudio-ds.css`, CLAUDE.md and CONTRIBUTING.md say the new rules.

What the restyle does **not** do: change the information architecture (how many settings groups,
which settings exist, what is shown when). The manifesto's rules on that (§1, §2, §6 of it) and the
anti-patterns AP1–AP5 and AP7 on the Decisions tab are for `/ui-audit`, whose report goes to the
owner before anything is removed or moved.

## 4. As built

- **The restyle** was done by six developer agents over disjoint sets of stylesheets and the
  components that use them, then integrated: the design lint is clean over every stylesheet,
  component and locale file (683), and `apps/web/test/design-voice.test.ts` holds it.
- **Copy that leaned on `text-transform`** was rewritten in sentence case, en and es: the common
  statuses, the branch states, review severities, the flow states. Effort levels are words now
  (Low / Medium / High / Extra high / Max; Bajo / Medio / Alto / Muy alto / Máximo), and
  `apps/web/src/i18n/GLOSSARY.md` no longer keeps them untranslated: a level is a human option, not
  the flag it maps to. Document kinds (SPEC, ADR) stay in capitals in the copy itself.
- **Percentages** go through `formatPercent()` everywhere; the one left is the daily spend push
  title, which core sends with the same words and a test pins (a follow-up changes both).
- **Phone fields** that were 16 px keep `--fs-input`, not `--fs-section`: 15 px is under iOS's zoom
  threshold (`guard-hooks.spec.mjs` caught it).
- **The first invariants run found 446 problems that predated this work**: 312 small targets
  (segmented groups, steppers, switches, chips, the status bar, the composer's buttons), 59
  truncated texts without their full text, 22 scrollers without `scrollbar-gutter`, 9 phone inputs
  under 16 px, and 44 focus findings that were the check's own bug (a ring drawn by a wrapper's
  `:focus-within` was not seen; the check now compares the wrapper before and after focus). The
  fixes are shared: touch rules under `(pointer: coarse)` with `--touch`, a status bar whose items
  are 24 px tall inside its 30 px, `FullText` / `useFullTextTitle` in `packages/ui` (a `title` only
  while the text is cut), `scrollbar-gutter: stable` on `.main` and the side panels, and a tab bar
  whose longest label is never cut.
- **The e2e driver** gained `emulateTouch()`: Claudio sizes targets by the pointer, not the window,
  so below 768 px the invariants read the page with a finger.
- **ui-check against the desktop app** does not render: its renderer holds the browser's
  connections with live streams and serves its own installed build. The check is meant for the web
  dev server of the checkout under review (`pnpm dev`), and says so when nothing renders instead
  of measuring a blank page.
- **The reference prototype** (`docs/design-system/reference/`) follows the new voice through
  `claudio-ds.css` (its type classes and tokens) and through its inline styles: every inline size
  and weight in the HTML and in the generators of `tools/` was mapped by the table of §1.1, so the
  two still agree, and every screenshot was shot again in both themes. The 3,184 mono elements of
  the HTML were sorted by `tools/voice.py` (all literal: mono stays; no literal: sans and tabular;
  mixed: sans with each literal in its own mono span), which `common.write()` now applies, so a
  regenerated screen keeps the voice. `DesktopCuentas` and `MobileCuentas` have screenshots and
  manifest entries but no HTML since #188, so they were not shot again.
- **e2e specs that failed on `main` too** on this machine (`detail`, `integrations`, `security`,
  `motion`, and `a11y-core` over its 300 s limit under load) are not this work; `flow-waiting` is
  flaky here and passes on a rerun.

## Related

- [[design-system]]
- [[plans/redesign-night-shift]]
- [[knowledge-base]]
- [[design-system/ecosystem-review]]
