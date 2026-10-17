# Claudio's design manifesto

Every principle forbids something. If you are about to do the forbidden thing, stop: justify it, or
change course.

## 1. The best screen is the one that does not exist

- **A setting is a design decision nobody took.** Before you add a control, try to take the decision
  yourself. A setting exists only when two reasonable people want different things and both are valid.
- **Forbidden:** shipping a setting whose consequence the person cannot see. "Cap 0.02 USD" means
  nothing; "≈ 140 decisions a day with your quota" does.
- **Forbidden:** asking for data before it is needed. An API key is asked for when the provider that
  uses it is chosen, where it is chosen.
- **Forbidden:** explaining privacy in a static box when the product already shows the payload at the
  moment of consent. The moment is the explanation.
- Defaults nobody should touch (retention, timeouts) go into a folded "Advanced" (`Collapsible`), or
  disappear. Settings nobody has changed in 90 days are candidates for removal.

## 2. The product is the evidence, not the form

Claudio takes decisions for the person in shadow mode before it acts on them. So **every decision
point is a live row with data**, not a toggle:

> **Approve minor dependency updates?** · Shadow · 47 decisions · agrees with you 94 % · 3 disagreements [see] · [Turn on]

- **Forbidden:** a state (off / shadow / active) without the evidence that justifies the next step.
- **Forbidden:** provider, model and cost as a screen of their own when they are properties of each
  point (a global default and a per-project override).
- The person does not configure: they **promote with confidence built on data**.

## 3. Names before descriptions

- **Forbidden:** a two-line description under a label. It apologises for a bad name. Fix the name;
  if context is really needed, one secondary line of at most 60 characters.
- A label is a clear noun. An action is a verb and an object ("Save key", not "Save"); in Spanish the
  infinitive ("Guardar clave"), per `apps/web/src/i18n/GLOSSARY.md`.
- A button's state is named by its result: "Saved", not "Success".

## 4. Hierarchy through contrast and space, not boxes

- Three levels of text and only three: `--fg` (labels, values), `--fg-2` (context), `--fg-3`
  (metadata). All of them at least 4.5:1 on their surface, in both themes.
- **Forbidden:** borders as the main separator. Separate with space and alignment. A border only on
  an interactive container (an input, a segmented group), at least 3:1.
- **Forbidden:** a card inside a card. A decorative badge. An icon that repeats what its text says.
- One main decision per section dominates. The rest gives way.
- **Forbidden:** changing `font-weight` on hover or selection (the text widens and moves its
  neighbours). Use colour or fill.

## 5. Typographic voice

- Sans for everything human. Mono **only** for literals the machine reads: model ids, paths,
  commands, hashes, variables, keys. Then mono says "this is literal".
- **Forbidden:** mono on section headings, group labels, badges, or in the status bar except for
  literal values.
- `tabular-nums` on every number that can change; `tabular-nums slashed-zero` on ids.
- Uppercase with tracking on one level of the hierarchy only, never two (in Claudio: the sidebar's
  group headings).
- Four sizes and two weights. See `typography-voice.md`.

## 6. The density of a professional tool

- The person is an expert. Keyboard first. Whatever a settings screen does can also be done from
  the palette (Ctrl K): "turn point X on", "change the project's provider".
- **Forbidden:** a settings row taller than 56 px on a desktop when its control is a toggle, a select
  or a short input.
- **Forbidden:** three levels of navigation visible at once. Two at most. On a phone, a list → detail
  stack with a back button; never a sheet inside a sheet.
- Searching settings (name, keywords and consequence) replaces a long settings sidebar.

## 7. State that is visible and honest

- Default, changed and overridden by the project are told apart by shape or text, not by colour
  alone, and each field has its reset.
- "Saving…" never moves the layout: the width of the longest state is reserved.
- A change with a delayed effect says so: "applies from the next decision".
- Errors go next to the control, in reserved space, with what to do. Never a toast for a field's error.

## 8. Mobile first, no exceptions

- Design at 320 px first. What does not fit there is badly prioritised, not badly laid out.
- Container queries for components; media queries only for the shell (sidebar, tab bar).
- Targets ≥ 44 px on touch. Inputs at 16 px. `dvh`, `safe-area-inset`. Nothing that depends on hover.

## 9. What is deterministic is not discussed

The invariants in `invariants.md` run in hooks and in `pnpm test` / `pnpm e2e`. They are not
opinion. If a check fails, the work is not done, however good it looks.
