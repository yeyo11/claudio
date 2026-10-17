# UI invariants (checked by machine)

Every invariant has its check. The hook `ui-invariants-fast` runs the ones marked ⚡ after every
edit when the web dev server is up; `/ui-review` runs all of them; `pnpm test` and `pnpm e2e` hold
the tree to them in CI. None of this is negotiable or a matter of taste.

| # | Invariant | Check | ⚡ |
|---|---|---|---|
| I1 | No page-level horizontal scroll at 320, 390, 768, 1280 | `e2e/ui/invariants.mjs` `horizontalScroll` | ⚡ |
| I2 | No element whose content overflows with `overflow-x: visible` and nothing clipping it | `overflowLeaks` | ⚡ |
| I3 | Truncated text has its full text (a Tooltip, `aria-describedby`, or `title` on a non-interactive element) | `truncatedWithoutFullText` | |
| I4 | Cumulative layout shift < 0.001 during a screen's interactions, the ones right after an input included | `startLayoutShift` / `readLayoutShift`, interactions in `e2e/ui/routes.mjs` | |
| I5 | A button with states (`data-states="idle\|loading\|done"`) keeps its width | `unstableButtons` | |
| I6 | `scrollbar-gutter: stable` on vertical scrollers | `scrollbarGutter` | |
| I7 | Live numbers (`.tnum`, `[data-live-number]`) are `tabular-nums` | `proportionalNumbers` | |
| I8 | No axe violations (wcag2a, wcag2aa, wcag21aa, wcag22aa, best-practice) | `a11y-*.spec.mjs`; `scripts/ui-check.mjs` at 1280 | |
| I9 | Targets ≥ 44 px under 768, ≥ 24 px above | `smallTargets` | ⚡ (phone) |
| I10 | Inputs ≥ 16 px under 768 | `smallInputs` | ⚡ |
| I11 | Visible focus on everything focusable (an outline or a ring) | `invisibleFocus` | |
| I12 | Keyboard reach; Escape closes overlays | `a11y-shell.spec.mjs` | |
| I13 | Every animation stops under `[data-motion='subtle']`, `[data-motion='off']`, reduced motion and a hidden tab | `motion.spec.mjs` | |
| I14 | Token pairs meet contrast (4.5:1 text, 3:1 large numbers and UI), both themes | `a11y-shared.mjs` `tokenContrast` | |
| I15 | No raw colour, px radius or ms duration outside `tokens.css` | `scripts/design-lint.mjs` (`tokens`), `apps/web/test/design-tokens.test.ts` | ⚡ |
| I16 | Native controls are not rebuilt: Select, Toggle, Slider, NumberInput, Collapsible, Tooltip from the controls | design-lint `controls`, `title-on-interactive` | ⚡ |
| I17 | Long content (labels +40 %, a long email, a key with no spaces, 7-digit figures) passes I1–I3 | `e2e/specs/ui-invariants.spec.mjs` (it seeds them) | |
| I18 | Numbers through Intl (`format.ts`); never `n + '%'`, `toFixed()` to show, or `%` in copy | design-lint `number-format` | ⚡ |
| I19 | The voice: four sizes, two weights, the one caps level, mono for literals, no weight on state | design-lint `type-scale`, `type-weight`, `caps`, `tracking`, `mono-voice`, `weight-on-state`; `apps/web/test/design-voice.test.ts` | ⚡ |

## How to run them

```bash
node scripts/design-lint.mjs [files…]                     # I15, I16, I18, I19
node scripts/ui-check.mjs --route '/settings?tab=decisions' # I1–I11 on a running dev server (pnpm dev)
node scripts/ui-check.mjs --route / --fast                 # what the hook runs
pnpm build && pnpm e2e ui-invariants                       # I1–I7, I9–I11, I17 over the main screens
pnpm build && pnpm e2e a11y-core a11y-shell motion         # I8, I12, I13, I14
```

## How to read a failure

- **I1/I2 with long content**: a flex or grid child that holds text lacks `min-width: 0`, or a
  literal with no spaces lacks `overflow-wrap: anywhere`.
- **I4 after a click**: the button's text changes width, or a validation message appears without
  reserved room.
- **I8 contrast**: do not fix it on the screen. Fix the token, or use the right text level.
- **I9 on steppers and icon buttons**: the clickable area is the glyph. Give it 44 × 44 with padding
  (`--touch`), do not change the icon.
- **design-lint `mono-voice`**: the rule puts mono on something that reads like a label, a count or
  a time. If it really is a literal (an id, a path), say `/* literal */` in its block.
- **design-lint `type-scale`**: a `font-size` that is not `--fs-title`, `--fs-section`, `--fs-body`,
  `--fs-small`, `--fs-input` or `inherit`. A fifth size is a hierarchy problem.
