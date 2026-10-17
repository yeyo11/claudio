// Inlines the boot guard (`boot-guard.js`) into index.html, with its words read from the locales.
//
// It is inlined rather than loaded: a guard fetched as a file of its own could fail the same way as
// the module graph it watches. Its words come from `shell.json` so they keep the en/es parity the
// i18n tests hold every other string to, although no i18next exists when they are shown.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface BootCopy {
  title: string;
  hint: string;
  action: string;
}

export type BootStrings = Record<'en' | 'es', BootCopy>;

/** The marker in index.html the guard replaces. */
export const BOOT_GUARD_MARKER = '<!-- boot-guard -->';

interface ShellLocale {
  boot?: { title?: unknown; hint?: unknown };
  reload?: { action?: unknown };
}

function copyOf(locale: ShellLocale, language: string): BootCopy {
  const { title, hint } = locale.boot ?? {};
  const action = locale.reload?.action;
  if (typeof title !== 'string' || typeof hint !== 'string' || typeof action !== 'string') {
    throw new Error(`shell.json (${language}) is missing boot.title, boot.hint or reload.action`);
  }
  return { title, hint, action };
}

/** The guard's words in both languages, from `src/i18n/locales/<lang>/shell.json`. */
export function bootStrings(webDir: string): BootStrings {
  const read = (language: 'en' | 'es') => copyOf(JSON.parse(readFileSync(resolve(webDir, 'src/i18n/locales', language, 'shell.json'), 'utf8')) as ShellLocale, language);
  return { en: read('en'), es: read('es') };
}

/** The `<script>` element index.html carries: the guard's function, called with the strings. */
export function bootGuardScript(source: string, strings: BootStrings): string {
  // `<` escaped so no string can close the element early
  const args = JSON.stringify(strings).replace(/</g, '\\u003c');
  return `<script>\n${source.trim()}(window, ${args});\n</script>`;
}

/** index.html with its marker replaced by the guard; a page without the marker is an error, not a silent skip. */
export function injectBootGuard(html: string, script: string): string {
  if (!html.includes(BOOT_GUARD_MARKER)) throw new Error(`index.html has no ${BOOT_GUARD_MARKER} for the boot guard`);
  return html.replace(BOOT_GUARD_MARKER, () => script);
}
