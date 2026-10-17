# Settings patterns

Settings in Claudio are hand-written tabs today (`apps/web/src/pages/config/**`, the groups in
`settingsTabs.ts`). The fields below are the vocabulary every settings row is judged by, and the
shape a settings schema would take if `/ui-audit` and the owner decide to build one. Until then,
apply them as rules to each row you write.

## The fields of a setting

```ts
// A sketch of the schema, not code that exists: what each setting declares
provider: {
  type: enumOf(['cli', 'jev']),
  default: 'cli',
  scope: ['global', 'project'],
  tier: 'primary',
  label: 'Provider',
  keywords: ['engine', 'model', 'llm', 'jev', 'cli'],
  consequence: (s) => s.provider === 'cli'
    ? 'Uses your Claude Code quota. Nothing leaves this machine.'
    : 'Sends each point’s declared state to Jev.',
},
jevApiKey: { type: secret(), tier: 'primary', visibleWhen: (s) => s.provider === 'jev', label: 'Jev key',
             hint: 'Kept on this machine. The API never returns it.' },
jevModel:  { type: readonly('jev-1.13.0'), renderAs: 'hint', attachTo: 'provider', visibleWhen: (s) => s.provider === 'jev' },
costCapUsd: { type: money({ min: 0.001, max: 1, step: 0.005 }), default: 0.02, tier: 'secondary',
              label: 'Cap per decision',
              consequence: (s, ctx) => `≈ ${formatNumber(ctx.quota.dailyUsd / s.costCapUsd)} decisions a day with your quota` },
historyRetentionDays: { type: int({ min: 1, max: 365 }), default: 30, tier: 'advanced', label: 'Keep history', unit: 'days' },
```

| Field | What it does on screen |
|---|---|
| `tier: primary` | heads its section; a large control; always shown |
| `tier: secondary` | a compact row (≤ 56 px on a desktop) under the primary |
| `tier: advanced` | inside a folded "Advanced" (`Collapsible` from the controls; never `<details>`) |
| `visibleWhen` | mounted and unmounted with `grid-template-rows: 0fr → 1fr`, without a jump |
| `consequence` | a live secondary line under the control; **required** on numbers and enums |
| `renderAs: 'hint'` + `attachTo` | not a row: tertiary text attached to another control |
| `scope` | shows "Overridden in this project" and a reset when it applies |
| `keywords` | feed the palette (Ctrl K) and settings search |

## Anatomy of a row

```
[Label]                                         [Control]
[consequence (secondary, live, tabular)]        [● changed · Reset]
```

- Label and control on the **same baseline**.
- A container query stacks the label over the control below 480 px of its container.
- The "changed" dot and "Reset" take their room even when hidden (`visibility: hidden`), so nothing
  jumps when they appear.
- Every string through i18n, en and es, sentence case; the es copy follows the glossary.

## States every settings screen covers

`normal`, long content (labels +40 %, a 64-character email, a key with no spaces, 7-digit
figures), `empty` (no projects, no key), `loading` (a skeleton of the exact height), `error` (an
invalid key: the message in reserved space under the input, with what to do), `overridden` (the
project's value differs from the global one). The e2e spec `ui-invariants.spec.mjs` seeds the long
content.

## Secrets

- An input with `type=password`, a show/hide button of 44 px on a phone, pasting allowed.
- The button's states: "Save key" → "Saving…" → "Saved ✓", with the width of the longest reserved.
- After saving, the field shows `••••••••` and "Saved on 17 Oct" and a "Change" button. It never shows
  the key again. (Settings → Security's secrets line already works this way.)

## Searching settings

It indexes `label + keywords + consequence`. A result takes the person to the control and focuses it
with a fill that fades over `--dur-slow` (it stops under the reduced motion levels). With search
working, the settings groups can come down to ≤ 8.
