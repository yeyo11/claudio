---
created_at: 2026-10-15T12:23:01Z
updated_at: 2026-10-15T12:40:00Z
tags:
    - plan
    - design-system
    - branding
    - fork
    - proposed
---
# Plan: Night Shift in Claudio's colours

Status: **proposed** (2026-10-15). The owner reviews the three decisions below before anything in
`packages/ui` or `apps/web` changes.

Claudio is a fork of Agentry ([plans/claude-only-fork.md](claude-only-fork.md)), so it still wears
Agentry's identity: the terracotta → rose gradient, warm neutrals, and the node-graph logo. The
design team has delivered Claudio's brand kit, in
[`design-system/claudio-brand-kit/`](../design-system/claudio-brand-kit/README.md). This plan
decides how that kit maps onto Night Shift's tokens ([design-system.md](../design-system.md) §1).
Only the colours change. The rules of Night Shift stay as they are: tokens only, dark first, both
themes, motion, and one meaning per status colour.

## The kit

| Name | Hex | Role in the kit |
|---|---|---|
| Electric Blue | `#246BFD` | primary brand |
| Cyber Cyan | `#00E5FF` | the spark in the mark |
| Neural Violet | `#A78BFA` | secondary accent, the end of the gradient |
| Ice White | `#F4F7FF` | text on dark |
| Slate Navy | `#17233D` | elevated surfaces |
| Deep Space | `#0B1020` | background |

The first SVGs in the kit did not match the identity board. They were rebuilt from the board in the
same branch, with no further work from design (the kit's README, "Revision"). The kit is dark only,
and three of its colours collide with meanings Night Shift has already given them:

- **Cyan** is the spark, but in Night Shift `--live` (cyan) means "an agent is working now".
- **Violet `#A78BFA`** is exactly the dark `--idle` ("waiting for the user") and `--accent-2`.
- **Blue** is close to `--info` (`#6cb6ff`): they read 1.25:1 against each other.

The blue itself is borderline as text: `#246BFD` reads 4.57:1 on white and 4.14:1 on Deep Space,
which fails.

## Decisions

### 1. Cyan stays "live", and the logo's spark is the same cyan

`--live` in dark becomes the brand's `#00E5FF` (it was `#22d3ee`). The only static cyan in the app
is the spark inside the logo, a mark of a few pixels in the sidebar and the top bar. Every other
cyan surface still means an agent is working now. The brand's own story says it: the spark is "the
assisted intelligence". Light `--live` stays `#0b6680`, and on light the logo's spark turns brand
blue, because cyan reads 1.3:1 on white (`claudio-horizontal-light`).

Rejected:
- **A new colour for live**, so that cyan becomes brand only. Every spinner, rail, energy border and
  e2e colour check would move, and the brand would claim the colour the app uses to say "alive".
- **Cyan as an accent** (links, focus): this breaks "never an action colour".

### 2. The violet stays `--idle`; in the brand it only appears inside the gradient

The gradient is blue → violet, as in the kit. Solid violet keeps meaning "waiting for the user"
(`--idle`) and the tag tone (`--accent-2`), as it already did in Agentry, where the tag violet and
`--idle` were the same colour. `--accent-rose`, the gradient's second stop, becomes a violet. It is
only ever drawn inside a gradient, or as the second colour of the energy border and the sliders,
never as a status fill on its own. The token is renamed `--accent-2nd`, so the old name does not
lie about its hue. It has 15 uses outside `tokens.css`.

Rejected:
- **Moving `--idle` to another hue.** Pink is the only free one, and a status should not change
  meaning because the brand changed.
- **A blue-only gradient.** It would lose the second hue that makes the kit recognisable.

### 3. The blue is `--accent`, and `--info` folds into it

`--accent` (links, focus ring, active indicators, `--sel-mark`) is the brand blue, lightened in dark
and darkened in light so it reads as text. `--info` is not one of the four status colours in
CLAUDE.md ("neutral notices"), and next to a blue accent a second blue only adds noise. It becomes
an alias of `--accent`. It has 13 uses.

## Proposed tokens

Contrast ratios are computed (WCAG 2.x) with the script in
`design-system/claudio-brand-kit/source/`. "≥" means the ratio on `--bg`, `--bg-2` and `--bg-3`.
Every row passes 4.5:1.

### Surfaces and text

| Token | Dark | Light | Contrast |
|---|---|---|---|
| `--bg` | `#0B1020` Deep Space | `#F7F8FC` | |
| `--bg-1` / `--bg-sunken` | `#0E1427` | `#EEF1F8` | |
| `--bg-2` / `--bg-elev` | `#121A30` | `#FFFFFF` | |
| `--bg-3` / `--bg-hover` | `#17233D` Slate Navy | `#E8ECF5` | |
| `--bg-4` | `#1F2D4D` | `#DAE0EE` | |
| `--fg` / `--text` | `#F4F7FF` Ice White | `#0B1020` | ≥ 14.6 · ≥ 16.0 |
| `--fg-2` / `--text-muted` | `#A7B1C9` | `#4A5470` | ≥ 7.3 · ≥ 6.4 |
| `--fg-3` / `--text-faint` | `#8B96B1` | `#5D6783` | ≥ 5.3 · ≥ 4.75 |

The kit gives Slate Navy to "elevated surfaces". As `--bg-2`, it would be too bright a step from
Deep Space for cards on every screen, so it becomes `--bg-3` (hover, secondary buttons, code). The
lines (`--line*`) keep their white or ink alphas. Light trades its warm neutrals for cool ones, to
match the navy.

### Brand

| Token | Dark | Light | Contrast |
|---|---|---|---|
| `--accent` | `#6E9BFF` | `#1D58DB` | ≥ 5.8 · ≥ 5.1 |
| `--accent-2nd` (was `--accent-rose`) | `#A78BFA` | `#6D28D9` | ≥ 5.7 · ≥ 6.0 |
| `--grad` | `linear-gradient(135deg, #1F5FE8, #3D57E0 55%, #6A4BD6)` | same | white on each stop: 5.44 / 5.77 / 5.85 |
| `--grad-text` | `#7DA4FF → #B9A4FF` | `#1D58DB → #6D28D9` | ≥ 6.4 · ≥ 5.1 |
| `--grad-border` | accent 75 % → violet 35 % → line | same in the light hues | |
| `--glow-top`, `--glow`, `--ring` | blue `#246BFD` at 16 / 13 / 30 % | at 10 / 10 / 24 % | |
| `--shadow-primary*`, `--shadow-fab` | glow tinted `#3D57E0` | same | |

As in Night Shift, the gradient is darker than the brand blue so that white text on it passes. The
brand's `#246BFD` itself stays in the logo files.

### Status

| Token | Dark | Light | Change |
|---|---|---|---|
| `--live` | `#00E5FF` | `#0b6680` | dark becomes the brand cyan |
| `--info` | `var(--accent)` | `var(--accent)` | an alias (decision 3) |
| `--ok`, `--warn`, `--bad`, `--idle` | unchanged | unchanged | pass ≥ 6.0 on the new surfaces |

## Work

This is stage R's slot r3 (copy and brand) in [plans/claude-only-fork.md](claude-only-fork.md),
plus the token change, which can land before the rename:

1. **Tokens.** Change `packages/ui/src/styles/tokens.css`: the dark `:root` block and the two light
   blocks, which must stay identical. Also the swatches of Settings → Appearance, and the
   `--accent-rose` → `--accent-2nd` rename in its 15 uses. Update the tables of
   `docs/design-system.md` §1 and `docs/design-system/agentry-ds.css` in the same PR.
2. **The logo in the app.** Replace the node-graph mark in `packages/ui/src/components/icons.tsx`
   (`brand-mark`) with the Claudio symbol, built as a component, with gradient ids from `useId()`.
   Add it to the `.brand` lockup in `App.tsx` and `TopBar.tsx`.
3. **Icons and metas.**
   - `apps/web/public/favicon.svg` comes from `claudio-micro.svg`.
   - `apps/web/public/icons/*`: 192, 512, maskable and apple-touch.
   - `apps/desktop/build/icon.{png,svg}` and `build/icons/*` come from the kit's hicolor sizes.
   - The two `theme-color` metas in `apps/web/index.html` and the manifest's colours become
     `#0B1020` and `#F7F8FC`.
   - The Electron splash, error page and title bar (`apps/desktop/src/pages.ts`, `main.ts`,
     `title-bar.ts`), which hard-code their colours.
4. **Illustrations.** In the app they need no redrawing: `packages/ui/src/styles/illustrations.css`
   colours every one of the 15 by class, from tokens (`--il-tone` is `--accent`, the gradient runs
   `--accent` → `--accent-rose`, and the surfaces, lines and ink are `--bg-*`, `--line-*` and
   `--fg-*`). The new tokens recolour them, and the only edit is `.stop-b` following the rename to
   `--accent-2nd`. The warn, bad and ok tones do not change. What does need changing is the
   reference: each of the 15 SVGs in `docs/design-system/illustrations/` carries its own `<style>`
   with dark `var(--x, #hex)` fallbacks, so that it previews on its own. Ten fallback colours map one
   to one onto the new dark tokens (`#ec8a66` → `#6E9BFF`, `#e0668f` → `#A78BFA`, `#22d3ee` →
   `#00E5FF`, and the seven surfaces and inks). Their `.stop-b` also still falls back to
   `--accent-2`, a stale name that should become `--accent-2nd`. A before and after of six of them
   is in `design-system/claudio-brand-kit/previews/illustrations-before-after.png` (above, Agentry;
   below, Claudio). Check them in the light theme in the app, where they read the light tokens.
5. **Reference.** Regenerate the screenshots in `docs/design-system/reference/` (dark and light),
   and update the "Idea" section of `design-system.md`, which describes the terracotta gradient.

## Verification

- The web token test (`test/design-tokens.test.ts`): no hex outside `tokens.css`, and the two light
  blocks identical.
- `motion.spec.mjs` and `a11y.spec.mjs` (axe contrast), in both themes.
- Every screen of `docs/design-system/reference/` compared side by side, dark and light, with
  `night-shift-ui-check`.
- Icons checked at 16, 32 and 48 px in the desktop launcher and the browser tab.

## Open

- **The name.** "Claudio" is fine for a private tool (claude-only-fork, "A note on the name"); check
  it again before a public release.
- **The board's tagline**, "AI-powered development", is not used anywhere. Add it only if a screen
  asks for it (About, the install page).

## Related

[[plans/claude-only-fork.md]] · [[design-system.md]] · [[plans/redesign-night-shift.md]] · [[desktop.md]] · [[status.md]]
