// design-lint-ok-file: the brand kit's own colours and path data; the splash paints before any stylesheet or token has loaded
/*
 * Claudio's splash: "Eat the code" (docs/plans/splash-eat-the-code.md). It plays in two places:
 *
 * - the desktop shell's first page, while its server starts (`splashHtml()`, a whole document);
 * - the web app and the installed PWA, over the page while the bundle loads and the UI renders
 *   (`splashOverlay()`, which apps/web's build writes into index.html).
 *
 * A single four-second performance. The symbol arrives in the centre and opens its mouth wide in
 * anticipation. The cursor feeds it two bits of code, which it takes in two deliberate bites; a last
 * small bite settles it back into its exact silhouette, and the name is written out of the cursor as
 * the lockup finds its place. The intro then holds, still, until the app is ready.
 *
 * The mouth is a rig on the brand's own path, not a cut: every vertex of the C turns about the
 * spark's centre, weighted by its angle around it, so the arms close like jaws while the back stays
 * put and the outline bends in one piece, with no seam. Turning about the spark keeps the inner edges
 * at a constant 28 units from it, so the jaws never touch the spark. At rest the original path string
 * is drawn, so the final frame is the brand kit's lockup; a test compares the paths with
 * docs/design-system/claudio-brand-kit/logos/svg/claudio-horizontal-dark.svg.
 *
 * One clock drives everything (render(t) is a pure function of the time), so the intro is
 * deterministic. It runs once: past the end the clock is clamped, and nothing ever rewinds it. It
 * also stops while the page is hidden, and goes on from there when it shows again.
 */

export const BRAND_C =
  'M41.76 14.24Q46 10 52 10L71 10Q74 10 76.12 12.12L93.88 29.88Q96 32 93 32L57 32Q54 32 51.88 34.12L34.83 51.17Q32 54 32 58L32 62Q32 66 34.83 68.83L51.88 85.88Q54 88 57 88L93 88Q96 88 93.88 90.12L76.12 107.88Q74 110 71 110L52 110Q46 110 41.76 105.76L14.24 78.24Q10 74 10 68L10 52Q10 46 14.24 41.76Z';
export const BRAND_SPARK = 'M62 41Q68 54 81 60Q68 66 62 79Q56 66 43 60Q56 54 62 41Z';
/** Inter Bold outlines, drawn at translate(130 87.5) like the lockup */
export const BRAND_WORDMARK = 'M61.06201171874999 -40.94384765624999H47.58837890624999Q47.21923828124999 -43.55859374999999 46.08105468749999 -45.60424804687499Q44.94287109374999 -47.64990234374999 43.15869140624999 -49.09570312499999Q41.37451171874999 -50.54150390624999 39.05200195312499 -51.31054687499999Q36.72949218749999 -52.07958984374999 34.02246093749999 -52.07958984374999Q29.131347656249996 -52.07958984374999 25.501464843749996 -49.66479492187499Q21.871582031249996 -47.24999999999999 19.872070312499996 -42.65112304687499Q17.872558593749996 -38.05224609374999 17.872558593749996 -31.499999999999996Q17.872558593749996 -24.763183593749996 19.887451171874996 -20.179687499999996Q21.902343749999996 -15.596191406249998 25.532226562499996 -13.258300781249998Q29.162109374999996 -10.920410156249998 33.93017578124999 -10.920410156249998Q36.60644531249999 -10.920410156249998 38.89819335937499 -11.627929687499998Q41.18994140624999 -12.335449218749998 42.97412109374999 -13.704345703124998Q44.75830078124999 -15.073242187499998 45.94262695312499 -17.041992187499996Q47.12695312499999 -19.010742187499996 47.58837890624999 -21.533203124999996L61.06201171874999 -21.471679687499996Q60.53906249999999 -17.134277343749996 58.46264648437499 -13.119873046874996Q56.38623046874999 -9.105468749999998 52.89477539062499 -5.952392578124999Q49.40332031249999 -2.7993164062499996 44.58911132812499 -0.9689941406249998Q39.77490234374999 0.8613281249999999 33.71484374999999 0.8613281249999999Q25.286132812499996 0.8613281249999999 18.656982421874996 -2.9531249999999996Q12.027832031249998 -6.767578124999999 8.197998046874998 -13.996582031249998Q4.368164062499999 -21.225585937499996 4.368164062499999 -31.499999999999996Q4.368164062499999 -41.80517578124999 8.244140624999998 -49.03417968749999Q12.120117187499998 -56.26318359374999 18.764648437499996 -60.06225585937499Q25.409179687499996 -63.86132812499999 33.71484374999999 -63.86132812499999Q39.19042968749999 -63.86132812499999 43.88159179687499 -62.32324218749999Q48.57275390624999 -60.78515624999999 52.20263671874999 -57.84741210937499Q55.83251953124999 -54.90966796874999 58.12426757812499 -50.66455078124999Q60.41601562499999 -46.41943359374999 61.06201171874999 -40.94384765624999ZM80.88855468749998 -62.99999999999999V0.0H67.78406249999998V-62.99999999999999ZM102.22242187499998 0.8920898437499999Q97.70044921874998 0.8920898437499999 94.16285156249998 -0.6921386718749998Q90.62525390624998 -2.2763671874999996 88.57959960937498 -5.398681640624999Q86.53394531249998 -8.520996093749998 86.53394531249998 -13.196777343749998Q86.53394531249998 -17.134277343749996 87.97974609374998 -19.810546874999996Q89.42554687499998 -22.486816406249996 91.91724609374998 -24.117187499999996Q94.40894531249998 -25.747558593749996 97.59278320312498 -26.578124999999996Q100.77662109374998 -27.408691406249996 104.28345703124998 -27.747070312499996Q108.40552734374998 -28.177734374999996 110.92798828124998 -28.562255859374996Q113.45044921874998 -28.946777343749996 114.58863281249998 -29.715820312499996Q115.72681640624998 -30.484863281249996 115.72681640624998 -31.992187499999996V-32.17675781249999Q115.72681640624998 -35.09912109374999 113.89649414062498 -36.69873046874999Q112.06617187499998 -38.29833984374999 108.71314453124998 -38.29833984374999Q105.17554687499998 -38.29833984374999 103.08374999999998 -36.74487304687499Q100.99195312499998 -35.19140624999999 100.31519531249998 -32.85351562499999L88.19507812499998 -33.83789062499999Q89.11792968749998 -38.14453124999999 91.82496093749998 -41.29760742187499Q94.53199218749998 -44.45068359374999 98.82325195312498 -46.15795898437499Q103.11451171874998 -47.86523437499999 108.77466796874998 -47.86523437499999Q112.71216796874998 -47.86523437499999 116.32666992187498 -46.94238281249999Q119.94117187499998 -46.01953124999999 122.75586914062498 -44.08154296874999Q125.57056640624998 -42.14355468749999 127.20093749999998 -39.11352539062499Q128.83130859374998 -36.08349609374999 128.83130859374998 -31.869140624999996V0.0H116.40357421874998V-6.552246093749999H116.03443359374998Q114.89624999999998 -4.337402343749999 112.98902343749998 -2.6608886718749996Q111.08179687499998 -0.9843749999999999 108.40552734374998 -0.046142578125Q105.72925781249998 0.8920898437499999 102.22242187499998 0.8920898437499999ZM105.97535156249998 -8.151855468749998Q108.86695312499998 -8.151855468749998 111.08179687499998 -9.305419921874998Q113.29664062499998 -10.458984374999998 114.55787109374998 -12.427734374999998Q115.81910156249998 -14.396484374999998 115.81910156249998 -16.888183593749996V-21.902343749999996Q115.20386718749998 -21.502441406249996 114.14258789062498 -21.179443359374996Q113.08130859374998 -20.856445312499996 111.75855468749998 -20.594970703124996Q110.43580078124998 -20.333496093749996 109.11304687499998 -20.133544921874996Q107.79029296874998 -19.933593749999996 106.71363281249998 -19.779785156249996Q104.40650390624998 -19.441406249999996 102.68384765624998 -18.703124999999996Q100.96119140624998 -17.964843749999996 100.00757812499998 -16.718994140624996Q99.05396484374998 -15.473144531249998 99.05396484374998 -13.627441406249998Q99.05396484374998 -10.951171874999998 101.00733398437498 -9.551513671874998Q102.96070312499998 -8.151855468749998 105.97535156249998 -8.151855468749998ZM166.71498046874996 -20.118164062499996V-47.24999999999999H179.81947265624996V0.0H167.23792968749996V-8.582519531249998H166.74574218749996Q165.14613281249996 -4.429687499999999 161.43934570312496 -1.9072265624999996Q157.73255859374996 0.6152343749999999 152.41078124999996 0.6152343749999999Q147.67347656249996 0.6152343749999999 144.07435546874996 -1.5380859374999998Q140.47523437499996 -3.6914062499999996 138.46034179687496 -7.659667968749999Q136.44544921874996 -11.627929687499998 136.41468749999996 -17.165039062499996V-47.24999999999999H149.51917968749996V-19.502929687499996Q149.54994140624996 -15.319335937499998 151.76478515624996 -12.889160156249998Q153.97962890624996 -10.458984374999998 157.70179687499996 -10.458984374999998Q160.07044921874996 -10.458984374999998 162.13148437499996 -11.551025390624998Q164.19251953124996 -12.643066406249998 165.46913085937496 -14.796386718749996Q166.74574218749996 -16.949707031249996 166.71498046874996 -20.118164062499996ZM205.09083984374996 0.7690429687499999Q199.70753906249996 0.7690429687499999 195.35475585937496 -2.0148925781249996Q191.00197265624996 -4.798828124999999 188.46413085937496 -10.228271484374998Q185.92628906249996 -15.657714843749998 185.92628906249996 -23.563476562499996Q185.92628906249996 -31.684570312499996 188.54103515624996 -37.08325195312499Q191.15578124999996 -42.48193359374999 195.50856445312496 -45.17358398437499Q199.86134765624996 -47.86523437499999 205.06007812499996 -47.86523437499999Q209.02833984374996 -47.86523437499999 211.68922851562496 -46.52709960937499Q214.35011718749996 -45.18896484374999 215.99586914062496 -43.20483398437499Q217.64162109374996 -41.22070312499999 218.50294921874996 -39.31347656249999H218.90285156249996V-62.99999999999999H231.97658203124996V0.0H219.05666015624996V-7.567382812499999H218.50294921874996Q217.58009765624996 -5.598632812499999 215.90358398437496 -3.6760253906249996Q214.22707031249996 -1.7534179687499998 211.56618164062496 -0.49218749999999994Q208.90529296874996 0.7690429687499999 205.09083984374996 0.7690429687499999ZM209.24367187499996 -9.659179687499998Q212.41212890624996 -9.659179687499998 214.61159179687496 -11.397216796874998Q216.81105468749996 -13.135253906249998 217.99538085937496 -16.272949218749996Q219.17970703124996 -19.410644531249996 219.17970703124996 -23.624999999999996Q219.17970703124996 -27.839355468749996 218.01076171874996 -30.946289062499993Q216.84181640624996 -34.05322265624999 214.62697265624996 -35.74511718749999Q212.41212890624996 -37.43701171874999 209.24367187499996 -37.43701171874999Q206.01369140624996 -37.43701171874999 203.79884765624996 -35.68359374999999Q201.58400390624996 -33.93017578124999 200.44582031249996 -30.823242187499993Q199.30763671874996 -27.716308593749996 199.30763671874996 -23.624999999999996Q199.30763671874996 -19.502929687499996 200.46120117187496 -16.349853515624996Q201.61476562499996 -13.196777343749998 203.81422851562496 -11.427978515624998Q206.01369140624996 -9.659179687499998 209.24367187499996 -9.659179687499998ZM240.11367187499997 0.0V-47.24999999999999H253.21816406249997V0.0ZM246.69667968749997 -53.34082031249999Q243.77431640624997 -53.34082031249999 241.69790039062497 -55.29418945312499Q239.62148437499997 -57.24755859374999 239.62148437499997 -59.98535156249999Q239.62148437499997 -62.69238281249999 241.69790039062497 -64.64575195312499Q243.77431640624997 -66.59912109374999 246.69667968749997 -66.59912109374999Q249.61904296874997 -66.59912109374999 251.69545898437497 -64.64575195312499Q253.77187499999997 -62.69238281249999 253.77187499999997 -59.98535156249999Q253.77187499999997 -57.24755859374999 251.69545898437497 -55.29418945312499Q249.61904296874997 -53.34082031249999 246.69667968749997 -53.34082031249999ZM282.42703124999997 0.9228515624999999Q275.25955078124997 0.9228515624999999 270.04543945312497 -2.1379394531249996Q264.83132812499997 -5.198730468749999 262.00124999999997 -10.689697265624998Q259.17117187499997 -16.180664062499996 259.17117187499997 -23.440429687499996Q259.17117187499997 -30.761718749999996 262.00124999999997 -36.25268554687499Q264.83132812499997 -41.74365234374999 270.04543945312497 -44.80444335937499Q275.25955078124997 -47.86523437499999 282.42703124999997 -47.86523437499999Q289.59451171874997 -47.86523437499999 294.80862304687497 -44.80444335937499Q300.02273437499997 -41.74365234374999 302.85281249999997 -36.25268554687499Q305.68289062499997 -30.761718749999996 305.68289062499997 -23.440429687499996Q305.68289062499997 -16.180664062499996 302.85281249999997 -10.689697265624998Q300.02273437499997 -5.198730468749999 294.80862304687497 -2.1379394531249996Q289.59451171874997 0.9228515624999999 282.42703124999997 0.9228515624999999ZM282.48855468749997 -9.228515624999998Q285.74929687499997 -9.228515624999998 287.93337890624997 -11.089599609374998Q290.11746093749997 -12.950683593749998 291.24026367187497 -16.180664062499996Q292.36306640624997 -19.410644531249996 292.36306640624997 -23.532714843749996Q292.36306640624997 -27.654785156249996 291.24026367187497 -30.884765624999993Q290.11746093749997 -34.11474609374999 287.93337890624997 -35.99121093749999Q285.74929687499997 -37.86767578124999 282.48855468749997 -37.86767578124999Q279.19705078124997 -37.86767578124999 276.96682617187497 -35.99121093749999Q274.73660156249997 -34.11474609374999 273.61379882812497 -30.884765624999993Q272.49099609374997 -27.654785156249996 272.49099609374997 -23.532714843749996Q272.49099609374997 -19.410644531249996 273.61379882812497 -16.180664062499996Q274.73660156249997 -12.950683593749998 276.96682617187497 -11.089599609374998Q279.19705078124997 -9.228515624999998 282.48855468749997 -9.228515624999998Z';

/** The whole performance: by this time the lockup is complete and still */
export const SPLASH_INTRO_SECONDS = 4;
/** A short pause on the finished lockup before the splash hands over, so it registers */
const HOLD_SECONDS = 0.35;
const FADE_SECONDS = 0.3;
/**
 * The longest a caller should wait for `handOff()`. The intro always plays to its end, so if the
 * app is ready at once this is the whole intro, its pause and its fade, plus a margin for a page
 * that never answers
 */
export const SPLASH_HANDOFF_MAX_MS = Math.ceil((SPLASH_INTRO_SECONDS + HOLD_SECONDS + FADE_SECONDS) * 1000) + 500;

/** The element the splash lives in, in both of its forms */
export const SPLASH_ID = 'claudio-splash';

// The brand palette (BRAND-GUIDE.md)
const DEEP_SPACE = '#0B1020';
const ELECTRIC_BLUE = '#246BFD';
const CYBER_CYAN = '#00E5FF';
const NEURAL_VIOLET = '#A78BFA';
const ICE_WHITE = '#F4F7FF';
const SLATE_NAVY = '#17233D';
/**
 * The light theme's page and hairline (tokens.css, [data-theme='light']): in the web app the splash
 * sits on the same background the UI paints next, so its fade never flashes. On light, the spark,
 * the cursor and the bits turn Electric Blue and the name Deep Space, as in claudio-horizontal-light.svg
 */
export const LIGHT_SURFACE = { bg: '#F7F8FC', line: '#DAE0EE' };

/*
 * Lockup units: the mark's own coordinates, with the wordmark beside it as in the brand kit
 * (x 10–439, y 10–110). The view is centred on the finished lockup.
 */
const VIEW = { x: -75.5, y: -40, width: 600, height: 200 };
/** The lockup's width on screen: half the window, never past 860px or what the height allows */
const LOCKUP_WIDTH = 'min(50vw, 860px, 137vh)';

/** A bit is the cursor block at 42 %: the same proportions and corner */
const BIT = { width: 4.6, height: 7.1, rx: 1.26 };

/** The words the splash carries for screen readers, and for a long wait without motion */
export interface SplashCopy {
  /** Announced while the splash shows ("Starting Claudio…") */
  status: string;
  /** Shown under the still lockup when motion is off and the wait is long ("Starting…") */
  starting: string;
}
export type SplashStrings = Record<'en' | 'es', SplashCopy>;

/** The desktop shell's pages are English, like its error page */
const SHELL_COPY: SplashStrings = {
  en: { status: 'Starting Claudio…', starting: 'Starting…' },
  es: { status: 'Starting Claudio…', starting: 'Starting…' },
};

const LIGHT_VARIABLES = `--splash-bg: ${LIGHT_SURFACE.bg}; --splash-accent: ${ELECTRIC_BLUE}; --splash-name: ${DEEP_SPACE}; --splash-track: ${LIGHT_SURFACE.line}; --splash-light: 0.5; color-scheme: light;`;

/** Everything is scoped to the splash's own element: in the web app it shares the page with the UI */
const STYLE = `
  #${SPLASH_ID} { --splash-bg: ${DEEP_SPACE}; --splash-accent: ${CYBER_CYAN}; --splash-name: ${ICE_WHITE}; --splash-track: ${SLATE_NAVY}; --splash-light: 1;
    color-scheme: dark; position: fixed; inset: 0; z-index: 2147483647; overflow: hidden; background: var(--splash-bg);
    /* The desktop window has no system title bar: the splash is dragged by its body */
    -webkit-app-region: drag; user-select: none; -webkit-user-select: none; }
  :root[data-theme='light'] #${SPLASH_ID} { ${LIGHT_VARIABLES} }
  @media (prefers-color-scheme: light) { :root[data-theme='system'] #${SPLASH_ID} { ${LIGHT_VARIABLES} } }
  #${SPLASH_ID} svg { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
    width: calc(${LOCKUP_WIDTH} * ${VIEW.width} / 429); height: auto; overflow: visible; }
  #${SPLASH_ID} .splash-accent { fill: var(--splash-accent); }
  #${SPLASH_ID} .splash-name { fill: var(--splash-name); }
  #${SPLASH_ID} .splash-track { fill: var(--splash-track); }
  /* The light has its own layer: its opacity changes on the compositor, and the scene's repaints
     never have to redraw a gradient the size of the window */
  #${SPLASH_ID} .splash-light { position: absolute; inset: 0; opacity: var(--splash-light); }
  #splash-pool { will-change: opacity; opacity: 0; }
  #${SPLASH_ID} .splash-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  /* With motion off: the finished lockup and, if the wait is long, this word instead of a moving bar */
  #splash-still { position: absolute; left: 0; right: 0; top: calc(50% + ${LOCKUP_WIDTH} * 0.2); margin: 0;
    text-align: center; color: var(--splash-name); opacity: 0.6; font: 13px/1.5 ui-sans-serif, system-ui, sans-serif; visibility: hidden; }
`;

function markup(copy: SplashCopy): string {
  const view = `viewBox="${VIEW.x} ${VIEW.y} ${VIEW.width} ${VIEW.height}"`;
  const bits = [0, 1]
    .map((i) => `<rect id="splash-bit-${i}" class="splash-accent" x="${-BIT.width / 2}" y="${-BIT.height / 2}" width="${BIT.width}" height="${BIT.height}" rx="${BIT.rx}" opacity="0"/>`)
    .join('');
  return `<div id="${SPLASH_ID}">
<div class="splash-light"><svg id="splash-pool" xmlns="http://www.w3.org/2000/svg" ${view} aria-hidden="true">
  <defs><radialGradient id="splash-pool-light"><stop offset="0" stop-color="${ELECTRIC_BLUE}" stop-opacity="0.14"/><stop offset="0.45" stop-color="${ELECTRIC_BLUE}" stop-opacity="0.05"/><stop offset="1" stop-color="${ELECTRIC_BLUE}" stop-opacity="0"/></radialGradient></defs>
  <ellipse cx="224.5" cy="60" rx="340" ry="200" fill="url(#splash-pool-light)"/>
</svg></div>
<svg id="splash-scene" xmlns="http://www.w3.org/2000/svg" ${view} aria-hidden="true">
  <defs>
    <!-- The brand gradient, fixed in space rather than refitted to the moving outline every frame.
         The page sets gradientTransform to the C's own bounding box, which makes it exactly the
         lockup's objectBoundingBox gradient at rest -->
    <linearGradient id="splash-brand" gradientUnits="userSpaceOnUse" x1="0.35" y1="0" x2="0.6" y2="1"><stop offset="0" stop-color="${ELECTRIC_BLUE}"/><stop offset="0.5" stop-color="${ELECTRIC_BLUE}"/><stop offset="1" stop-color="${NEURAL_VIOLET}"/></linearGradient>
    <path id="splash-spark" d="${BRAND_SPARK}"/>
    <path id="splash-wordmark" d="${BRAND_WORDMARK}"/>
    <!-- The name is written out of the cursor in reading order: a soft-edged wipe that starts at the
         block's right edge. Alpha, so the mask's colour never tints the name -->
    <linearGradient id="splash-wipe-edge" x1="0" y1="0" x2="1" y2="0"><stop offset="0.93" stop-color="${ICE_WHITE}"/><stop offset="1" stop-color="${ICE_WHITE}" stop-opacity="0"/></linearGradient>
    <mask id="splash-from-cursor" maskUnits="userSpaceOnUse" x="111" y="-20" width="420" height="160" style="mask-type: alpha"><rect id="splash-wipe" x="-349" y="-20" width="460" height="160" fill="url(#splash-wipe-edge)"/></mask>
    <clipPath id="splash-track"><rect x="196.5" y="133" width="56" height="6" rx="3"/></clipPath>
    <linearGradient id="splash-seg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${ELECTRIC_BLUE}" stop-opacity="0"/><stop offset="0.4" stop-color="${ELECTRIC_BLUE}"/><stop offset="0.6" stop-color="${NEURAL_VIOLET}"/><stop offset="1" stop-color="${NEURAL_VIOLET}" stop-opacity="0"/></linearGradient>
  </defs>
  <g id="splash-stage">
    <g id="splash-symbol" opacity="0">
      <g>${bits}</g>
      <g id="splash-mark">
        <path id="splash-c" d="${BRAND_C}" fill="url(#splash-brand)"/>
        <use href="#splash-spark" class="splash-accent"/>
        <use id="splash-spark-lit" href="#splash-spark" fill="${ICE_WHITE}" opacity="0"/>
      </g>
      <rect id="splash-block" x="98" y="51.5" width="11" height="17" rx="3" class="splash-accent"/>
    </g>
    <g mask="url(#splash-from-cursor)"><use id="splash-word" href="#splash-wordmark" class="splash-name" transform="translate(130 87.5)"/></g>
  </g>
  <g id="splash-loader" opacity="0">
    <rect x="196.5" y="134.75" width="56" height="2.5" rx="1.25" class="splash-track"/>
    <g clip-path="url(#splash-track)"><rect id="splash-loader-seg" x="0" y="134.75" width="22" height="2.5" rx="1.25" fill="url(#splash-seg)"/></g>
  </g>
</svg>
<p class="splash-sr" id="splash-status" role="status">${copy.status}</p>
<p id="splash-still">${copy.starting}</p>
</div>`;
}

/** What callers use once the app is ready; it settles when the UI may take the screen */
export type SplashHandle = { handOff(): Promise<void> };

declare global {
  interface Window {
    /** Set by the splash's script; absent where no splash was written into the page */
    claudioSplash?: SplashHandle;
    /** Set before the page's scripts by a harness that must not wait four seconds (the e2e driver) */
    __claudioNoSplash?: boolean;
  }
}

// The little of the page the intro touches, typed here so the desktop's build needs no DOM lib
type Box = { x: number; y: number; width: number; height: number };
type PageNode = {
  setAttribute(name: string, value: string): void;
  style: { opacity: string; visibility: string };
  getBBox?(): Box;
  remove?(): void;
  textContent: string | null;
  inert?: boolean;
};
type PageWindow = {
  document: { getElementById(id: string): PageNode | null };
  location: { search: string };
  matchMedia(query: string): { matches: boolean };
  requestAnimationFrame(callback: (now: number) => void): number;
  setTimeout(callback: () => void, ms: number): unknown;
  localStorage?: { getItem(key: string): string | null };
  navigator?: { languages?: readonly string[]; language?: string };
  claudioDesktop?: unknown;
  __claudioNoSplash?: boolean;
  claudioSplash?: SplashHandle;
};

type Mode = 'document' | 'overlay';
type IntroOptions = { mode: Mode; intro: number; hold: number; fade: number; brandC: string; strings: SplashStrings; id: string };

/*
 * The choreography, in seconds. It runs in the page, so it is a function serialised into the splash
 * rather than code of this module: keep it free of anything outside its own body.
 */
function intro(options: IntroOptions, page: PageWindow): void {
  const el = (id: string) => page.document.getElementById(id) as PageNode;
  const splash = el(options.id);
  const overlay = options.mode === 'overlay';
  const handle: SplashHandle = { handOff: () => Promise.resolve() };
  page.claudioSplash = handle;

  // The app's UI under an overlay stays out of reach (pointer, keyboard, screen reader) until the splash is gone
  const root = overlay ? page.document.getElementById('root') : null;
  const finish = () => {
    if (!overlay) return;
    splash.remove?.();
    if (root) root.inert = false;
  };
  // The desktop shell already played the intro in its own first page, and a test harness opts out
  if (overlay && (page.claudioDesktop || page.__claudioNoSplash)) {
    finish();
    return;
  }
  if (root) root.inert = true;

  const stored = (key: string) => {
    try {
      return page.localStorage?.getItem(key) ?? null;
    } catch {
      // blocked storage: the defaults
      return null;
    }
  };
  // The app's own words for the two lines it carries, in the language the app will open in
  const language = (() => {
    const chosen = stored('claudio-language');
    if (chosen === 'en' || chosen === 'es') return chosen;
    const tags = page.navigator?.languages ?? [page.navigator?.language ?? ''];
    for (const tag of tags) {
      const code = String(tag || '').toLowerCase().split(/[-_.@]/)[0];
      if (code === 'en' || code === 'es') return code;
    }
    return 'en';
  })();
  const copy = options.strings[language];
  el('splash-status').textContent = copy.status;
  el('splash-still').textContent = copy.starting;

  const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
  const span = (t: number, from: number, to: number) => clamp((t - from) / (to - from));
  const inQuad = (p: number) => p * p;
  const inCubic = (p: number) => p ** 3;
  const outCubic = (p: number) => 1 - (1 - p) ** 3;
  const outQuart = (p: number) => 1 - (1 - p) ** 4;
  const inOutSine = (p: number) => (1 - Math.cos(Math.PI * p)) / 2;
  // CSS's cubic-bezier(), solved for x by bisection
  const bezier = (x1: number, y1: number, x2: number, y2: number) => {
    const at = (a: number, b: number, s: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
    return (x: number) => {
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2;
        if (at(x1, x2, mid) < x) lo = mid;
        else hi = mid;
      }
      return at(y1, y2, (lo + hi) / 2);
    };
  };
  const outExpo = bezier(0.16, 1, 0.3, 1);
  const writeEase = bezier(0.33, 0.33, 0.4, 1);
  // Only what changed is written: an unchanged attribute would still invalidate the scene's paint
  const written = new Map<PageNode, Record<string, string>>();
  const set = (node: PageNode, attrs: Record<string, string | number>) => {
    const seen = written.get(node) ?? {};
    written.set(node, seen);
    for (const [k, v] of Object.entries(attrs)) {
      const value = typeof v === 'number' ? v.toFixed(3) : v;
      if (seen[k] === value) continue;
      seen[k] = value;
      node.setAttribute(k, value);
    }
  };

  /** Keyframes with an easing per segment: each move gets the curve its intent calls for */
  type Ease = (p: number) => number;
  const track = (keys: [number, number, Ease?][]) => (t: number) => {
    const first = keys[0] as [number, number];
    if (t <= first[0]) return first[1];
    for (let i = 1; i < keys.length; i++) {
      const [t1, v1, ease] = keys[i] as [number, number, Ease?];
      const [t0, v0] = keys[i - 1] as [number, number];
      if (t <= t1) return v0 + (v1 - v0) * (ease ?? inOutSine)((t - t0) / (t1 - t0));
    }
    return (keys[keys.length - 1] as [number, number])[1];
  };

  /*
   * The mouth, in degrees: negative opens wider than the logo, positive closes. A wide wind-up
   * before each bite, a snap that accelerates into the bite, a short clench, and a release that
   * decelerates. The second bite is the largest; the third is small and settles to exactly zero.
   */
  const BITES = [1.32, 1.98];
  const jaw = track([
    [0, 0],
    [0.75, 0],
    [1.12, -8],
    [1.19, -8],
    [BITES[0] as number, 13, inCubic],
    [1.37, 13],
    [1.68, -4, outCubic],
    [1.84, -9],
    [BITES[1] as number, 15, inCubic],
    [2.04, 15],
    [2.46, 0, outQuart],
    [2.62, 0],
    [2.78, 6],
    [3.12, 0, outQuart],
  ]);

  /*
   * The rig. The C's vertices turn about the spark's centre by the jaw angle, weighted by their own
   * angle around it: fully along the arms (within 100° of the mouth's axis), not at all on the back
   * (past 155°), easing between. The upper half closes clockwise, the lower one counter-clockwise.
   */
  const PIVOT = { x: 62, y: 60 };
  const tokens = options.brandC.match(/[MLQZ]|-?\d+(?:\.\d+)?/g) ?? [];
  const smooth = (p: number) => p * p * (3 - 2 * p);
  const points: { x: number; y: number; w: number; side: number }[] = [];
  const shape: (string | number)[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] as string;
    if (/[MLQZ]/.test(tok)) shape.push(tok);
    else {
      const x = Number(tok);
      const y = Number(tokens[++i]);
      const angle = Math.abs((Math.atan2(y - PIVOT.y, x - PIVOT.x) * 180) / Math.PI);
      shape.push(points.length);
      points.push({ x, y, w: 1 - smooth(span(angle, 100, 155)), side: y < PIVOT.y ? 1 : -1 });
    }
  }
  const mouth = (degrees: number) => {
    // At rest the brand's own string, so the logo is never a re-serialised approximation of itself
    if (Math.abs(degrees) < 0.001) return options.brandC;
    return shape
      .map((part) => {
        if (typeof part === 'string') return part;
        const p = points[part] as (typeof points)[number];
        const a = (degrees * p.w * p.side * Math.PI) / 180;
        const dx = p.x - PIVOT.x;
        const dy = p.y - PIVOT.y;
        return `${(PIVOT.x + dx * Math.cos(a) - dy * Math.sin(a)).toFixed(3)} ${(PIVOT.y + dx * Math.sin(a) + dy * Math.cos(a)).toFixed(3)} `;
      })
      .join('');
  };

  /*
   * The bits. Each slides out of the cursor's left face (drawn beneath it, so it seems to come from
   * inside), waits a beat, then is drawn into the mouth along the one clear line, accelerating, and
   * slips under the spark's tip at the instant the jaws close.
   */
  const FACE = 95.6; // a bit's centre when it has just left the cursor
  const TIP = 82.6; // its centre when it meets the spark's right tip
  const bits = BITES.map((bite, i) => ({ node: el(`splash-bit-${i}`), bite, out: bite - 0.34, pull: bite - 0.2 }));
  const sparkLit = (t: number) => Math.max(...BITES.map((b) => (t < b - 0.02 || t > b + 0.2 ? 0 : t < b ? 0.3 * inQuad((t - b + 0.02) / 0.02) : 0.3 * outCubic(1 - (t - b) / 0.2))));

  /** Where the symbol waits, alone, before the name joins it: centred on screen */
  const ALONE = 165;
  const ARRIVE = [0.02, 0.55] as const;
  const GLIDE = [3.25, 3.97] as const;
  const WIPE = [3.29, 3.9] as const;
  const NAME = [3.29, 4.0] as const;

  const nodes = {
    pool: el('splash-pool'), stage: el('splash-stage'), symbol: el('splash-symbol'), mark: el('splash-mark'), c: el('splash-c'),
    sparkLit: el('splash-spark-lit'), word: el('splash-word'), wipe: el('splash-wipe'), loader: el('splash-loader'), loaderSeg: el('splash-loader-seg'),
  };
  // The gradient in the C's own box, as objectBoundingBox would place it on the untouched path
  const box = nodes.c.getBBox?.() ?? { x: 10, y: 10, width: 84.7578125, height: 100 };
  set(el('splash-brand'), { gradientTransform: `matrix(${box.width} 0 0 ${box.height} ${box.x} ${box.y})` });

  function render(t: number): void {
    const pool = (0.6 * outCubic(span(t, 0.1, 0.9))).toFixed(3);
    if (nodes.pool.style.opacity !== pool) nodes.pool.style.opacity = pool;

    // Arrival: a controlled scale and opacity, the scale on a long exponential settle
    const arrive = outExpo(span(t, ARRIVE[0], ARRIVE[1]));
    const stageX = ALONE * (1 - inOutSine(span(t, GLIDE[0], GLIDE[1])));
    set(nodes.stage, { transform: `translate(${stageX.toFixed(3)} 0)` });
    set(nodes.symbol, {
      opacity: outCubic(span(t, 0.04, 0.42)),
      transform: `translate(59.5 60) scale(${(0.9 + 0.1 * arrive).toFixed(4)}) translate(-59.5 -60)`,
    });

    // The mark leans into each bite and back from each wind-up, two units at most: weight, not travel
    const angle = jaw(t);
    set(nodes.mark, { transform: `translate(${(0.15 * angle).toFixed(3)} 0)` });
    set(nodes.c, { d: mouth(angle) });
    set(nodes.sparkLit, { opacity: sparkLit(t) });

    for (const bit of bits) {
      const out = outCubic(span(t, bit.out, bit.out + 0.14));
      const pulled = inQuad(span(t, bit.pull, bit.bite));
      const x = 100.5 + (FACE - 100.5) * out + (TIP - FACE) * pulled;
      set(bit.node, {
        opacity: t >= bit.bite || t < bit.out ? 0 : 1,
        transform: `translate(${x.toFixed(3)} 60) scale(${(1 - 0.35 * pulled ** 3).toFixed(4)})`,
      });
    }

    // The reveal: the symbol glides to its place in the lockup while the name is written out of
    // the cursor, its letters easing the last units into place; the name, the lighter part, ends last
    set(nodes.wipe, { x: 111 + 364 * writeEase(span(t, WIPE[0], WIPE[1])) - 460 });
    set(nodes.word, { transform: `translate(${(130 - 14 * (1 - outQuart(span(t, NAME[0], NAME[1])))).toFixed(3)} 87.5)` });
  }

  // Only if the app is still starting well after the intro: a hairline, nothing louder
  function renderLoader(t: number): void {
    const from = options.intro + 0.8;
    const shown = span(t, from, from + 0.6);
    set(nodes.loader, { opacity: shown });
    if (shown === 0) return;
    const phase = ((t - from) % 1.6) / 1.6;
    set(nodes.loaderSeg, { x: 174.5 + 78 * inOutSine(phase) });
  }

  // The preview's controls (docs/design-system/splash/eat-the-code.html); never read in the app,
  // whose own query strings mean something else
  const params = overlay ? new URLSearchParams() : new URLSearchParams(page.location.search);
  const frozen = params.get('t');
  // The app's motion level (packages/ui/src/lib/motion.ts): 'subtle' and 'off' stop every animation
  const motion = overlay ? stored('claudio-motion') : null;
  const still = page.matchMedia('(prefers-reduced-motion: reduce)').matches || motion === 'subtle' || motion === 'off';
  let release: (() => void) | undefined;

  if (frozen !== null) {
    render(Math.min(Number(frozen), options.intro));
    renderLoader(Number(frozen));
    return;
  }
  if (still) {
    // Nothing moves: the finished lockup until the app is ready, then it simply goes
    render(options.intro);
    page.setTimeout(() => (el('splash-still').style.visibility = 'visible'), (options.intro + 0.8) * 1000);
    handle.handOff = () => {
      finish();
      return Promise.resolve();
    };
    return;
  }

  let clock = 0;
  let last: number | undefined;
  let fadeFrom: number | undefined;

  // The intro always plays to its end: a ready app waits for it, then for a short pause. Asked
  // twice (React's strict mode runs effects twice), it answers with the same wait
  let handedOff: Promise<void> | undefined;
  handle.handOff = () => (handedOff ??= new Promise<void>((resolve) => (release = resolve)));

  const frame = (now: number) => {
    // A hidden page gets no frames; a gap longer than a few frames is a pause, not time that passed,
    // so the intro goes on where it stopped instead of skipping to its end
    clock += Math.min(now - (last ?? now), 100) / 1000;
    last = now;
    if (release && fadeFrom === undefined && clock >= options.intro + options.hold) fadeFrom = clock;
    // Clamped, never rewound: past the end every frame is the finished lockup
    render(Math.min(clock, options.intro));
    if (fadeFrom === undefined) renderLoader(clock);
    else {
      const out = span(clock, fadeFrom, fadeFrom + options.fade);
      splash.style.opacity = String(1 - inOutSine(out));
      if (out >= 1) {
        finish();
        release?.();
        return;
      }
    }
    page.requestAnimationFrame(frame);
  };
  page.requestAnimationFrame(frame);

  const readyAt = params.get('ready');
  if (readyAt !== null) page.setTimeout(() => void handle.handOff(), Number(readyAt) * 1000);
  const theme = params.get('theme');
  if (theme === 'light' || theme === 'dark') el('preview-root').setAttribute('data-theme', theme);
}

const script = (mode: Mode, strings: SplashStrings) => {
  const options: IntroOptions = { mode, intro: SPLASH_INTRO_SECONDS, hold: HOLD_SECONDS, fade: FADE_SECONDS, brandC: BRAND_C, strings, id: SPLASH_ID };
  // `<` escaped so no string can close the element early. The bundle serialises `intro` as written,
  // but tsx (tests, the preview) keeps names by wrapping functions in its own __name() helper, which
  // the page has to provide
  return `<script>var __name = (fn) => fn; (${intro.toString()})(${JSON.stringify(options).replace(/</g, '\\u003c')}, window);</script>`;
};

/** The desktop shell's first page: the splash as a whole document, always on the dark theme */
export function splashHtml(): string {
  return `<!doctype html><html lang="en" id="preview-root"><meta charset="utf-8"><title>Claudio</title><style>html, body { margin: 0; height: 100%; background: ${DEEP_SPACE}; }${STYLE}</style><body>
${markup(SHELL_COPY.en)}
${script('document', SHELL_COPY)}</body></html>`;
}

/**
 * The splash as the web app writes it into index.html, after #root and before the bundle: its
 * style, its element and its script, in the language and the theme the app will open in. The app
 * calls `window.claudioSplash.handOff()` once its first screen is on the page.
 */
export function splashOverlay(strings: SplashStrings): string {
  const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const safe: SplashStrings = {
    en: { status: escape(strings.en.status), starting: escape(strings.en.starting) },
    es: { status: escape(strings.es.status), starting: escape(strings.es.starting) },
  };
  return `<style>${STYLE}</style>
${markup(safe.en)}
${script('overlay', strings)}`;
}
