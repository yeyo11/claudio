---
name: claudio-ui
description: Use ALWAYS when a task creates, changes, reviews or critiques any screen, component, layout, setting or visual state of Claudio (apps/web, packages/ui, packages/chat-ui, the Electron shell's colours, any *.tsx or *.css there, the tokens). Also for "improve the design", "make it cleaner", "add a setting", "fix the responsive layout" and the like. Not for logic without UI (API, CLI, core, domain tests).
---

# Claudio UI: design judgement

This skill encodes how Claudio is designed. It is not a generic style guide: every rule **excludes**
something. A rule that forbids nothing is not a rule. It works on top of Night Shift
(`docs/design-system.md`, its reference screens in `docs/design-system/reference/`) and of the voice
the owner adopted in `docs/plans/claudio-designer.md`; where Night Shift's older text disagrees on
type, mono, caps or weights, the plan wins.

## Before you touch anything

1. Read `references/manifesto.md` (always; three minutes).
2. Run `node .claude/skills/claudio-ui/scripts/inventory.mjs` and read the `references/components.md`
   it writes: the components and controls that exist. **Reuse before you create.** A new component
   needs one line of justification in the pull request.
3. Settings or configuration → `references/settings-patterns.md`.
4. Anything visual or typographic → `references/typography-voice.md` and `references/anti-patterns.md`.
5. Open the screen's reference in `docs/design-system/reference/` (HTML and the dark and light
   screenshots in `screenshots/`).
6. Before you call anything done → `references/invariants.md` and `references/night-shift.md`. The
   hooks run those checks; read them before you fail them.

## The loop

```
see the current state      node scripts/ui-check.mjs --route <route> --tag before
→ decide what must NOT exist (manifesto §1)
→ build it, reusing components and the controls of packages/ui/src/components/controls
→ the hooks lint every edit and, with the dev server up, run the fast invariants on the screen
→ /ui-review <route> before you hand it over (an agent with a clean context)
```

Never hand over "I think it looks right". Hand over the screenshots (320 and 1280, dark and light)
and the invariants' result. The dev server of this checkout is `pnpm dev` (API on 8797, web on 5181).

## The rules broken most often (the manifesto in short)

- A setting whose consequence the person cannot see **does not ship**. Translate it ("≈ 140
  decisions a day with your quota") or remove it.
- If a control needs a two-line description, **its name is wrong**. Fix the name.
- Read-only information **is not a settings row**: it is secondary text attached to the control it
  belongs to.
- A control shows only when it **applies to the current state**. No Jev fields with the CLI selected.
- **At most two levels of navigation** visible at once.
- **Mono only for literals** the machine reads (ids, paths, model ids, commands, hashes). Never for
  labels, never decorative.
- Hierarchy through **text contrast and space**, not borders or cards. A card inside a card: forbidden.
- Four sizes (20 / 15 / 14 / 13) and two weights (450 / 600), from the `--fs-*` and `--fw-*` tokens.
- `tabular-nums` on every live number. A stable width on every button with states.
- `min-width: 0` on every flex or grid child that holds text.
- Container queries for components; media queries only for the shell.
- Numbers through `packages/ui/src/lib/format.ts` (Intl); copy never carries the `%` sign.
- Contrast is held by the tokens (`a11y-shared.mjs` checks the theme tokens), not judged by eye.

## When to ask the owner

Ask, do not decide, when the task means removing or merging navigation sections, changing the
information model (what is global and what is per project), or bringing in a new interaction
pattern. For everything else, decide and justify it in one line. For a UI feature, the owner wants
the options first, then the design settled in a plan under `docs/plans/`, then the build.

## Tools

| | |
|---|---|
| `/ui-audit [section]` | the `ia-auditor` agent: a read-only map of Settings and navigation, with the decisions for the owner |
| `/ui-explore <route> [n]` | `n` `ui-explorer` agents, each one radical variant in its own worktree |
| `/ui-review <route>` | the `ui-reviewer` agent: rubric R1–R12 and the invariants, SHIPPABLE or NOT SHIPPABLE |
| `node scripts/design-lint.mjs [files]` | the design lint (I15–I18); `apps/web/test/design-voice.test.ts` holds the tree to it |
| `node scripts/ui-check.mjs --route <r>` | screenshots and invariants of a running screen (`--fast` for what the hook runs) |
| `pnpm e2e:remote ui-invariants` | the invariants over the main screens with long content, in the e2e sandbox on GitHub (push first; the `e2e-on-github` skill) |
