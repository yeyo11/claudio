# Claudio Brand Kit

A handoff-ready starter pack for the CLAUDIO identity exploration.

## Folders
- `logos/svg/` — horizontal lockups and standalone symbol
- `logos/png/` — raster logo exports
- `icons/svg/` — app icon masters, including monochrome versions
- `icons/png/` — app icon sizes and favicon
- `palette/` — color reference and CSS tokens
- `web/` — website/app CSS variables
- `desktop/` — desktop packaging notes
- `docs/` — compact brand guide
- `previews/` — original identity board preview, if available

- `source/` — the scripts that build the vector masters and their PNG exports

## Notes
This is a practical starter kit, not a final trademark or legal clearance.

## Revision (2026-10-15)
The SVGs delivered first were a rough approximation of the identity board: a rounded stroke instead
of the chamfered C, a lopsided rhombus instead of the four-point spark, and the wordmark as live
`<text>` (it rendered in Arial wherever Inter was missing). Every vector and PNG here was rebuilt
from the board, without going back to design:

- The mark is geometry on a 100-unit grid: an open C with 45° chamfers and a 22-unit arm, the
  four-point spark, and the prompt block. Blue holds the top arm and the spine; violet arrives in
  the bottom arm.
- The wordmark is Inter Bold (SIL Open Font License), shaped with its kerning and converted to
  outlines. No SVG depends on an installed font.
- New: `claudio-horizontal-light` (colour on light: the spark and block turn brand blue, because cyan
  reads 1.3:1 on white), `claudio-micro.svg` (the 16–48 px icon: no margin and a larger mark, so the
  spark survives), and `claudio-1024.png`.
- `favicon.ico` holds 16, 32 and 48 px, from the micro icon.
- `claudio-app-icon-bleed.svg` and `claudio-app-icon-maskable.svg` are full-bleed tiles for the
  platforms that cut their own shape: the apple-touch icon (180 px; iOS allows no transparency) and
  the PWA's maskable icon, whose mark stays inside the central 80 % circle. Their PNGs are
  `claudio-apple-touch-180.png` and `claudio-maskable-512.png`.

To rebuild, from this folder (Inter's variable TTF is not committed):

```bash
uv run --no-project --with fonttools --with uharfbuzz python -I source/build.py Inter-Var.ttf .
python3 -I source/render.py logos/svg/claudio-symbol.svg logos/png/claudio-symbol.png 507 512
```
