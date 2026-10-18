---
created_at: 2026-10-18T07:40:00Z
updated_at: 2026-10-18T08:40:00Z
tags:
    - plan
    - desktop
    - branding
    - motion
    - web
    - pwa
    - built
---
# Plan: the "Eat the code" splash

Every full load of Claudio opens on a four-second brand intro: the desktop window while its server
starts, and the web page and the installed PWA while the bundle loads and the first screen renders. The logo's C, whose
open side faces right, comes alive as a restrained Pac-Man. The cursor feeds it two bits of code; it
takes them in two deliberate bites, and a last small bite settles it back into its exact silhouette.
Then the name is written out of the cursor as the lockup finds the centre. The finished lockup
holds, still, for as long as the app needs.

The owner asked for it on 2026-10-18, with the brand identity board
(`docs/design-system/claudio-brand-kit/previews/claudio-identity-board.png`) as the reference. The
owner then sent it back twice the same day; this is the third version.

## Why the earlier versions were replaced

- **The bite was not legible.** Both earlier versions split the C into two clipped halves and
  turned them on a hinge at its back. Past about 6° that turns the silhouette into an arrowhead, so
  the bites had to stay too small to read.
- **The symbol travelled.** It ran across the screen, so the bites were small events on a moving
  object rather than the performance itself.
- **Too small.** The lockup was capped at 540 px; on the owner's 1893 px window it filled under a
  third of the width.
- **Too many effects.** The first version had particles, wake, glows, sparks and a sweep; the
  second still had a line of three bits and a mid-run light.
- **The intro "repeated".** The owner's screen recording (2026-10-18 09:51) shows the whole intro
  starting over twice and the lockup vanishing. The page has no path that restarts it, and the main
  process loads it only from `startServer()`: at launch, from the error page's Restart, and after a
  failed update install. The recording was made while the preview file was being regenerated
  several times a minute, which matches a preview that reloads on file change. The intro itself now
  also clamps its clock: past four seconds every frame is the finished lockup. A 12-second run in a
  browser confirmed it never changes after 3.93 s.

## The mouth: a rig on the brand's own path

Four techniques were compared on rendered frames of the real path:

| Technique                                                     | Result                                                                                                                                                                       |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two clipped halves, hinged at the back                        | Breaks the silhouette past ~6°, and needs a seam overlap. Rejected.                                                                                                          |
| Parallel clamp                                                | Keeps angles, but reads as a vise, not a mouth. Rejected.                                                                                                                    |
| Vertex rig hinged at each arm's root                          | Bends cleanly, but at 16° the inner edge grazes the spark's top. Rejected.                                                                                                    |
| Vertex rig turning about the spark's centre, weighted by angle | One continuous outline, no seam. The back stays put, and the arms close like jaws around the core. The inner edges keep a constant 28 units from the spark, so they never touch it. Chosen. |

Every vertex of the C turns about (62, 60) by the jaw angle times a weight:

- 1 along the arms, within 100° of the mouth's axis;
- 0 on the back, past 155°;
- smoothstep between.

The upper half closes clockwise and the lower half counter-clockwise. The weight comes from where
each vertex sits, so it is identical for every frame. At 0° the original path string is drawn, not
a recomputed one.

The gradient is set in user space to the C's own bounding box, measured in the page with
`getBBox()`. At rest this is exactly the lockup's `objectBoundingBox` gradient. While the jaws move,
the colour stays fixed in space rather than being refitted to the moving outline each frame.

## The choreography (4.0 s)

| Time (s)  | Beat                                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0–0.55    | Quiet arrival. The symbol (C, spark and cursor, as one) appears in the centre: opacity on an out-cubic (0.04–0.42), and scale 0.9 → 1 on an exponential settle (0.02–0.55). |
| 0.55–0.75 | Still.                                                                                                                                                                    |
| 0.75–1.19 | Anticipation. The mouth opens wider than the logo (−8°) on a sine ease, and holds a beat. Bit 1 slides out of the cursor's left face, drawn beneath it, from 0.98.         |
| 1.12–1.32 | Bit 1 is drawn into the mouth along the one clear line (y = 60), accelerating.                                                                                           |
| 1.32      | Bite 1 (13°). A snap from −8° in 0.13 s on an in-cubic, so it accelerates into the bite. Bit 1 slips under the spark's tip on that frame.                                  |
| 1.37–1.68 | Clench, then release on an out-cubic to −4°.                                                                                                                              |
| 1.84–1.98 | A wider wind-up (−9°), then bite 2, the largest (15°), on bit 2.                                                                                                          |
| 2.04–2.46 | A long out-quart release to exactly 0°, then a rest.                                                                                                                      |
| 2.62–3.12 | Bite 3: small (6°), a sine in, and a slow out-quart settle into the original silhouette.                                                                                  |
| 3.12–3.25 | Pause on the finished symbol.                                                                                                                                             |
| 3.25–4.0  | The reveal: see below.                                                                                                                                                    |

The reveal has three parts:

- the symbol glides 165 units to its place in the lockup, on a symmetric sine ease (0.72 s);
- the name is written out of the cursor in reading order, by a soft-edged alpha wipe (3.29–3.9);
- its letters ease the last 14 units into place (out-quart, until 4.0).

At 4.0 everything is still.

The mark leans with the jaw, by 0.15 units per degree: back on a wind-up, forward into a bite,
about two units at most. It reads as weight, not travel. The spark brightens slightly (Ice White at
30 %, 0.2 s) as each bit enters it, and that is its only change. The cursor never moves.

## Light and composition

- **The lockup is half the window:** `min(50vw, 860px, 137vh)`.
  - 1893 × 914: 853 px, with a 200 px symbol.
  - 1280 × 800: 635 px.
  - 720 × 480: 357 px.

  It is centred to within 3 px. The remainder is the glyphs' own side bearing.
- **One quiet light.** An Electric Blue pool behind the centre fades in during the arrival and stays.
  It has its own SVG layer with `will-change: opacity`, so the scene's repaints never redraw it.
- **Nothing else.** There are no particles, trails, flashes, sweeps or glows on the mark.

## Where it plays

The splash is one module, `packages/ui/src/splash/splash.ts`, with two outputs:

| Where | Output | What it covers | Who hands over |
| ----- | ------ | -------------- | -------------- |
| Desktop window | `splashHtml()`: a whole document, always dark, loaded as the window's first page by `apps/desktop/src/pages.ts` | The server starting | `main.ts`, once the server answers, before it loads the UI |
| Web page and installed PWA | `splashOverlay()`: an element, its style and its script, written into `index.html` after `#root` by `apps/web/scripts/splash.ts` (a Vite plugin, in `pnpm dev` too) | The bundle loading and the first screen rendering under it | `SplashHandOff` (`apps/web/src/lib/splash.ts`), after React's first commit |

The owner asked on 2026-10-18 for the splash on the web and on PWA start, not only in the desktop
app. A PWA start and a web page load are the same full load of `index.html`; returning to an
already open PWA or tab is not a load, so it does not replay.

In the web page the overlay:

- **Paints before the bundle,** on the background of the theme the page opens in. `index.html`
  stamps `data-theme` before the body is parsed. Dark is the dark lockup on Deep Space; light is
  `claudio-horizontal-light.svg` on the light `--bg`; `system` follows `prefers-color-scheme`.
- **Keeps the UI under it out of reach.** `#root` is `inert` until the overlay is gone, so a
  pointer, the keyboard and a screen reader cannot reach it. The overlay carries a `role="status"`
  line ("Starting Claudio…" / "Iniciando Claudio…") from `shell.json`, in the language the app
  will open in.
- **Follows the app's motion level** (`claudio-motion`). Under `subtle`, `off` or
  `prefers-reduced-motion` it is the still lockup, and it leaves the moment the app is ready. That
  is also how someone who reloads often skips the four seconds.
- **Skips itself where it would be wrong:**
  - inside the desktop window, whose preload exposes `window.claudioDesktop`: the shell already
    played it;
  - under a harness that sets `window.__claudioNoSplash`. The e2e driver sets it on every
    document, which the UI check and the media recorder inherit.
- **Gets out of the boot guard's way.** If the bundle never loads, the boot guard's fallback
  removes the overlay and lifts `inert`, so its Reload button is reachable.
- **Stays out of the bundle.** The app imports only its types; the splash lives in `index.html`,
  which grows to 42.5 KB (14 KB gzipped, most of it the wordmark's outline).
- **Has its own ids,** all `claudio-splash` or `splash-*`, because it shares the document with the
  UI.

The clock also pauses while the page is hidden: a frame gap longer than 100 ms counts as 100 ms.
A tab opened in the background plays its intro when it is first seen, and a long task under the
splash costs a moment of stillness instead of a skip.

## Lifecycle and handoff

- **The intro always plays to the end.** `handOff()` resolves once the clock has passed 4.0 s plus a
  0.35 s pause, followed by a 0.3 s fade to the background. The window's background is the same
  colour, so the UI then loads without a jump.
- **The main process waits on that.** `main.ts` waits for the handoff at most
  `SPLASH_HANDOFF_MAX_MS`, which is the intro, its pause and its fade plus 0.5 s: 5150 ms.
- **If the server is still starting,** the lockup stays. A Slate Navy hairline loader appears under
  it 0.8 s after the intro. Nothing replays.
- **Under `prefers-reduced-motion`,** the finished lockup shows at once and `handOff()` resolves
  immediately. A static "Starting…" appears if the wait is long.
- **The clock never rewinds.** Only the attributes that changed are written each frame. Writing
  unchanged ones still invalidated the scene, and cost an occasional dropped frame.

## Verified in a browser (Chromium via Playwright)

- **The final frame is the brand lockup.** At 4 px per unit it matches
  `claudio-horizontal-dark.svg` pixel for pixel: the largest channel difference is 0 over 686,400
  pixels. The same holds for the live page 10 s after load.
- **Inspected frames:** 0, 0.2, 0.55, 1.0, 1.12, 1.15, 1.24, 1.3, 1.32, 1.45, 1.84, 1.94, 1.98, 2.2,
  2.55, 2.78, 3.12, 3.25, 3.4–4.0, and 10 s.
  - Each bit disappears on its bite's frame: 1.317 and 1.967 s measured live.
  - No seams; the spark is never touched.
- **12-second live run:**
  - the name is complete at 3.88 s and nothing changes after 3.93 s;
  - the wipe never retreats, and the symbol's opacity never drops.
- **Smooth:** eight consecutive runs with no frame over 20 ms.
- **Handoff measured:**
  - called at 0.5 s: resolved after 4.16 s, at the end of the intro, its pause and its fade;
  - called at 6 s: resolved after 0.31 s, the fade alone.

## Rejected

- **CSS keyframes or an animation library.** The jaw is a rig on path data, which neither animates
  well, and one deterministic clock keeps every frame reproducible.
- **Canvas or WebGL.** Inline SVG keeps the brand paths crisp at any device pixel ratio.

## Verified on the web (Chromium via Playwright, `vite preview` of the build, no API)

- **Each theme's finished lockup is the brand kit's,** pixel for pixel:
  - dark against `claudio-horizontal-dark.svg`;
  - light against `claudio-horizontal-light.svg`.

  The overlay's background is the theme's `--bg`: `rgb(11, 16, 32)` and `rgb(247, 248, 252)`.
- **One load:**
  - the overlay is there from the first frame, with `#root` inert;
  - React renders the shell under it;
  - the overlay leaves at 4.8–4.9 s after navigation, and `#root` is reachable again.
- **Under motion `off`,** the still lockup leaves as soon as the app commits, in under 0.4 s.
- **Known limit: the app's own work under the splash can drop frames.** With no API, React Query's
  retry fires about a second after load and re-renders the shell in one long task, measured at
  67–133 ms (275 ms under tracing). That lands near the first bite. The shared clock keeps the bits
  and the jaws in sync through it.

  With a reachable API the data arrives earlier, during the near-still arrival. This was not
  measured, because the check ran without the API so as not to touch the owner's data.
- **e2e not run here.** The suite runs only on GitHub, so it has not run against this change. It
  touches the driver and `index.html`, so it needs a remote run.

## Preview

`pnpm --filter @claudio/desktop splash:preview` writes
[docs/design-system/splash/eat-the-code.html](../design-system/splash/eat-the-code.html). Open it in
any browser:

- `?t=1.98` freezes a frame;
- `?ready=1` simulates the server answering at that second.
- `?theme=light` shows the light theme's colours.

A preview that reloads on file change restarts it each time the file is written; that reload is the
preview's doing, not the splash's.

## Related

[[desktop.md]] · [[plans/claudio-rebrand.md]] · [[design-system.md]]
