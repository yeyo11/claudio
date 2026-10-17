# Night Shift rules that every UI change keeps

The checklist the `night-shift-ui-check` skill held, folded in here. The rules are in
`docs/design-system.md` and `CONTRIBUTING.md`; the reference for every screen is in
`docs/design-system/reference/` (a static prototype and dark and light screenshots). Type, mono,
caps and weights follow `typography-voice.md`, which replaced Night Shift's older type rules.

**Before you change a screen:** open its reference. **Before you finish:** compare the result to it.

- [ ] **Tokens only.** No hex, `rgb()`, px radius or ms value outside `packages/ui/src/styles/tokens.css` (the one exception is `#fff` on the brand gradient). `apps/web/test/design-tokens.test.ts` passes.
- [ ] **The voice.** Four sizes, two weights, mono for literals, the one caps level, no weight change on state, numbers through Intl. `node scripts/design-lint.mjs` prints nothing for your files; `apps/web/test/design-voice.test.ts` passes.
- [ ] **Both themes.** Dark is the default; the screen also works in `[data-theme='light']`. Text contrast ≥ 4.5:1, large numbers ≥ 3:1.
- [ ] **Controls** come from `packages/ui/src/components/controls` (Select, Toggle, Slider, NumberInput, Combobox, Menu, Sheet, Collapsible, Tooltip…). Never a native select, checkbox, range or number input, `<details>`, or `title=` on an interactive element. Modules loaded on first paint import the file they need, not the barrel.
- [ ] **The gradient, sparingly.** `--grad` only on the one primary action of a zone, the FAB, the logo and the active account's avatar; at most two gradient surfaces per screen; the energy border on one surface only.
- [ ] **Only live things move.** `--live` (cyan) and loops mean an agent is working now. Every animation stops under `[data-motion='subtle']`, `[data-motion='off']`, `prefers-reduced-motion` and in a hidden tab; `motion.spec.mjs` stays green.
- [ ] **Status colours** mean one thing each (ok, warn, bad, idle) and always come with a word or an icon (reuse `StatusBadge` and `Tag`). Usage bars: neutral below 60 %, warn from 60 %, bad from 75 %.
- [ ] **Phone.** Targets ≥ 44 px, inputs at 16 px, "⋯" menus as a `Sheet`, no always-visible checkboxes, the four-tab bar and the gradient FAB.
- [ ] **Copy.** Every string through i18n with `en`/`es` parity; `es` follows `apps/web/src/i18n/GLOSSARY.md` (Spanish from Spain, infinitive buttons, sentence case, no `text-transform: capitalize` on sentences).
- [ ] **Restyle, don't duplicate.** Reuse the classes the app has; a new variant goes into `docs/design-system.md` and `claudio-ds.css` in the same change. Keep the classes the e2e specs select.
- [ ] **Diffs** are drawn with `DiffView` from the API's unified text; no diff library, no link to an editor.
- [ ] **Illustrations**: `Empty` with an illustration from `components/illustrations`, at most one per screen, colours from `styles/illustrations.css`, ids from `useId()`, `aria-hidden`.
- [ ] **Accessibility.** Icon-only buttons have an `aria-label`; everything is reachable by keyboard with a visible ring; `e2e/specs/a11y-*.spec.mjs` passes in both themes and at phone width.
- [ ] **Lazy routes** use `lazyPage()`, never a bare `React.lazy`.

Run `pnpm --filter @claudio/web test`, then push and run the specs your change touches on GitHub with `pnpm e2e:remote <specs>` (the `e2e-on-github` skill). The e2e suite never runs on this machine.
