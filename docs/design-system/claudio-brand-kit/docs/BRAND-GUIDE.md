# CLAUDIO — Brand kit

## Brand idea
A geometric open **C** paired with a central cyan spark and a small terminal-like block. The open form suggests a workspace and continuity; the spark suggests assisted intelligence; the small block hints at a command prompt. The mark is designed to remain flat and recognizable without glow.

## Wordmark
Spell the product name exactly **Claudio** (capital C, remaining letters lowercase). The wordmark is Inter Bold at −3 % tracking, already converted to outlines; its cap height is 63 % of the symbol's height.

## Color palette
| Name | Hex | Role |
|---|---|---|
| Electric Blue | `#246BFD` | Primary brand |
| Cyber Cyan | `#00E5FF` | Spark / accent |
| Neural Violet | `#A78BFA` | Secondary accent |
| Ice White | `#F4F7FF` | Text on dark surfaces |
| Slate Navy | `#17233D` | Elevated surfaces |
| Deep Space | `#0B1020` | Main background |

## Usage
- Prefer the horizontal lockup for product headers, landing pages, and presentations.
- Use the app icon for desktop launchers and compact spaces.
- Use single-color versions where color printing, low contrast environments, or strict UI constraints require them.
- Keep clear space around the mark approximately equal to the width of the cyan spark.
- Do not stretch, rotate, add outlines, or rely on glow/3D effects for legibility.
- On dark backgrounds, use `claudio-horizontal-dark`; on light backgrounds, use `claudio-horizontal-light` (the spark and block turn brand blue, since cyan is unreadable on white) or the dark monochrome version.
- From 16 to 48 px, use the micro icon (`icons/svg/claudio-micro.svg`), which drops the margin and enlarges the mark.

## Developer handoff
SVG files are the editable vector masters. PNGs are convenient raster exports. CSS tokens are in `palette/tokens.css` and `web/brand.css`.
