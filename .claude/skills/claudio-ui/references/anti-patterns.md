# Anti-patterns (from Claudio's own screens)

A model learns more from "not this" than from principles. Each one was seen in the app; the
"before" screenshots of a screen are taken with
`node scripts/ui-check.mjs --route <route> --tag before` (they land in `.ui-captures/`, which is
not tracked). AP6, AP8 and AP12 were fixed across the app with the voice change of 2026-10-17
(`docs/plans/claudio-designer.md`); the others are open and go through `/ui-audit` first.

## AP1 · The repeated Bootstrap row
Label and paragraph on the left, control on the right, same height, same border, on every row.
Nothing dominates; everything weighs the same.
**Seen in:** Settings → Decisions → Engine, seven identical rows.
**Fix:** a tier per setting. One primary row; the rest compact or folded.

## AP2 · A setting that does not apply, shown
Jev's key, Jev's model and Jev's privacy shown with "Claude Code CLI" selected.
**Fix:** show it only when it applies; reveal it with a `grid-template-rows: 0fr → 1fr` transition.

## AP3 · Information dressed as a setting
"Jev model · jev-1.13.0 · PINNED" takes a whole row and cannot be changed.
**Fix:** a hint attached to the provider selector.

## AP4 · A number without a consequence
"0.02" with "Cost cap per request (USD)". The person cannot tell whether it is a lot or a little.
**Fix:** a live consequence: "≈ 140 decisions a day with your quota".

## AP5 · Three levels of navigation
Global sidebar → settings sidebar (30 entries, "Settings" repeated in two groups) → Engine /
Points / Supervisor / History chips.
**Fix:** ≤ 8 groups and search. The chips go: each group is a screen.

## AP6 · Decorative mono (fixed 2026-10-17)
"CLAUDIO", "CLAUDE CODE", "Provider, model and privacy", "low" in mono.
**Fix:** mono only for literals (see `typography-voice.md`).

## AP7 · The static explanatory box
A three-line blue privacy box repeating what the product already shows at the moment of consent.
**Fix:** one consequence line under "Provider" when Jev is selected, and a "See an example payload" link.

## AP8 · Inconsistent number format (fixed 2026-10-17)
"27%" and "36 %" in the same status bar.
**Fix:** `formatPercent()` (Intl) in one helper; the lint forbids `%` in copy and next to a number.

## AP9 · A stepper with a 16 px target
The `−` and `+` of the cost cap and of the history.
**Fix:** `NumberInput` from the controls, with 44 × 44 targets on a phone.

## AP10 · A button that changes width
"Save the key" → "Saving…" → "Saved".
**Fix:** reserve the width; stack the states in one grid cell (`data-states` lets I5 check it).

## AP11 · The border as the universal separator
Every row, section and panel with a 1 px border.
**Fix:** space (a section gap, a row gap) and alignment. Borders only on interactive controls.

## AP12 · Bold on selection (fixed 2026-10-17)
The sidebar's active entry at 600 while the rest is at 450: the text widens.
**Fix:** fill and colour. Constant weight.
