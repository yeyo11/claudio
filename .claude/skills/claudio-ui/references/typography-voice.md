# Typographic voice and hierarchy

The tokens live in `packages/ui/src/styles/tokens.css`; the decision is in
`docs/plans/claudio-designer.md` §1. `node scripts/design-lint.mjs` enforces what can be enforced.

## Scale (these and no others)

| Token | Use | Size / line | Weight |
|---|---|---|---|
| `--fs-title` / `--lh-title` | screen title, the one big number of a tile | 20 / 28 | `--fw-strong` (600) |
| `--fs-section` / `--lh-section` | section and card titles | 15 / 22 | `--fw-strong` |
| `--fs-body` / `--lh-body` | labels, values, body, controls | 14 / 20 | `--fw-regular` (450) |
| `--fs-small` / `--lh-small` | consequences, hints, metadata, badges, literals in mono | 13 / 18 | `--fw-regular` |
| `--fs-input` | inputs, selects and textareas on a phone | 16 | |

Never another size. Never 700. Titles may take `--tracking-title`.

```css
.panel-title { font: var(--fw-strong) var(--fs-section) / var(--lh-section) var(--sans); }
.row-hint    { font-size: var(--fs-small); line-height: var(--lh-small); color: var(--fg-2); }
```

## Three levels of contrast

- `--fg`: labels, values, titles.
- `--fg-2`: consequences, hints, help text, section labels.
- `--fg-3`: metadata (dates, versions). Still ≥ 4.5:1 on its surface.

If you need a fourth level, the problem is the hierarchy, not the palette.

## Mono: when yes and when no

Yes: `claude-sonnet-5`, `jev-1.13.0`, `apps/web/src/pages/config/DecisionsTab.tsx`,
`claude --model haiku`, a branch name, a commit hash, a chat id, `CW-30`, `CLAUDIO_API_URL`, code,
diffs, logs, keyboard keys.

No: `347,21 US$` (money is sans with `tabular-nums`), "CLAUDE CODE" as a group heading, "Provider,
model and privacy", BETA/PINNED badges, "low" in a select (a human option: it should read "Low"),
counts, times, durations, percentages, column heads.

In TSX, `className="mono"` on something that is not a literal is the same mistake as in CSS. A CSS
rule whose selector reads like a label but holds a literal says `/* literal */` in its block.

## Uppercase with tracking

One level in the whole app: the sidebar's group headings (`.nav-group-label`, `.live-section-head`)
and their phone twin on the More page (`.more-group-head`): `--fs-small`, `--fw-regular`,
`--tracking-caps`, `--fg-3`. Nowhere else. A section label elsewhere is `--fs-small`, `--fw-strong`,
`--fg-2`, in sentence case, and its copy is written in sentence case (no `text-transform`).

## Numbers

```css
.tnum { font-variant-numeric: tabular-nums; }
.mono { font-variant-numeric: tabular-nums slashed-zero; }   /* ids */
```

Always through `packages/ui/src/lib/format.ts`: `formatPercent(27)` → "27%" in English, "27 %" in
Spanish; `formatNumber`, `formatCost`, `formatDuration`, `timeAgo`. Never `` `${n}%` ``, never
`toFixed()` to show a number, never a `%` inside a locale string (pass `{{percent}}` formatted).

## Ellipsis

- At the end: names of things (projects, chats, decision points).
- **In the middle**: emails, paths, ids, model names — what matters is at the end
  (`shortPath()` in `format.ts` for paths).
- Never: figures, money, dates, button actions.
- Truncated text carries its full text: a `Tooltip` from `packages/ui/src/components/controls`, or
  `title` on a non-interactive element. Never `title=` on a button or a link.

## Badges

A badge exists only if it changes a decision of the person. "BETA" beside Jev, yes (it warns). "PINNED"
beside a model that cannot be changed, no: the missing control already says it. One badge per row at
most. A badge is sans, `--fs-small`, sentence case, with its status colour paired with a word.
