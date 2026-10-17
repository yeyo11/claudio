# Review rubric (0–3 per criterion, each justified with a screenshot)

Score every criterion. 3 = exemplary, 2 = right, 1 = poor, 0 = breaks it. The bar to ship: **no 0,
an average ≥ 2.3**, and every ⚡ invariant green.

| # | Criterion | What to measure | 3 | 0 |
|---|---|---|---|---|
| R1 | Hierarchy | Does the main decision dominate without borders? Count the contrast levels in use | one dominant decision, ≤ 3 levels | everything weighs the same |
| R2 | Relevance | Is any control shown that does not apply to the state? List them | 0 | ≥ 2 |
| R3 | Navigation | Levels visible at once | ≤ 2 | ≥ 3 |
| R4 | Density | Height in px per relevant setting at 1280 | ≤ 56 | > 96 |
| R5 | Consequence | Share of numeric and enum controls with a consequence line | 100 % | < 50 % |
| R6 | State | Default / changed / overridden told apart without colour? | yes, with reset | no |
| R7 | Names | Controls with a description longer than one line | 0 | ≥ 3 |
| R8 | Type | Mono outside literals; sizes off the four; weights other than 450/600 | 0 | ≥ 2 |
| R9 | Stability | Layout shift in interactions (I4) and button widths (I5) | 0 / stable | it jumps |
| R10 | Phone at 320 | Stacks right, 44 px targets, no sideways scroll, 16 px inputs | all | something broken |
| R11 | Accessibility | axe clean, visible focus, full keyboard, right roles (radiogroup, spinbutton, aria-live) | all | an axe error |
| R12 | Consistency | Unjustified new components; design-lint problems; Night Shift rules (`night-shift.md`) | 0 | ≥ 1 |

## The report

```
## Review · <screen> · <commit>
Score: R1 2 · R2 3 · … · average 2.4 · ⚡ invariants ✅ (all)

### Blocking (1)
- R2: "Jev key" shown with provider=cli. Screenshot: .ui-captures/settings_tab_decisions/1280-dark.png, upper third

### Improvements (1)
- R4: the "History" row takes 88 px for a stepper with one value. Fold it into Advanced.

### Done well
- R5: a live consequence on the cost cap.

Screenshots: .ui-captures/<screen>/
Verdict: NOT SHIPPABLE (1 blocking)
```

Attach screenshots only of what fails or is exemplary. Do not describe what the screenshot shows:
point at the region.
