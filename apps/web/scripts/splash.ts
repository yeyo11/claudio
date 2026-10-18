// Writes Claudio's splash (packages/ui/src/splash/splash.ts) into index.html, with its words read
// from the locales.
//
// It is written into the page rather than rendered by React: it has to paint before the bundle has
// loaded, which on a cold PWA start is the wait it covers. Its words come from `shell.json` so they
// keep the en/es parity the i18n tests hold every other string to, although no i18next exists yet.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { splashOverlay, type SplashCopy, type SplashStrings } from '@claudio/ui/splash';

/** The marker in index.html the splash replaces: after #root, before the bundle's script */
export const SPLASH_MARKER = '<!-- splash -->';

interface ShellLocale {
  splash?: { status?: unknown; starting?: unknown };
}

function copyOf(locale: ShellLocale, language: string): SplashCopy {
  const { status, starting } = locale.splash ?? {};
  if (typeof status !== 'string' || typeof starting !== 'string') {
    throw new Error(`shell.json (${language}) is missing splash.status or splash.starting`);
  }
  return { status, starting };
}

/** The splash's words in both languages, from `src/i18n/locales/<lang>/shell.json`. */
export function splashStrings(webDir: string): SplashStrings {
  const read = (language: 'en' | 'es') => copyOf(JSON.parse(readFileSync(resolve(webDir, 'src/i18n/locales', language, 'shell.json'), 'utf8')) as ShellLocale, language);
  return { en: read('en'), es: read('es') };
}

/** index.html with its marker replaced by the splash; a page without the marker is an error, not a silent skip. */
export function injectSplash(html: string, strings: SplashStrings): string {
  if (!html.includes(SPLASH_MARKER)) throw new Error(`index.html has no ${SPLASH_MARKER} for the splash`);
  return html.replace(SPLASH_MARKER, () => splashOverlay(strings));
}
