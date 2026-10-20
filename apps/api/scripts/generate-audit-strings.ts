// Writes the web's `auditRoutes` namespace from the route docs, so the audit log can word every write
// route in the reader's language (docs/plans/settings-reset-and-polish.md, D5). English is the
// route's OpenAPI summary, byte for byte; Spanish is written by a person, and this script only adds
// the keys it lacks (in English) and fails until they are translated. Run:
// pnpm --filter @claudio/api audit:strings
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROUTE_DOCS } from '../src/openapi/routes.ts';

const here = dirname(fileURLToPath(import.meta.url));
const locales = resolve(here, '../../web/src/i18n/locales');
export const EN_FILE = resolve(locales, 'en/auditRoutes.json');
export const ES_FILE = resolve(locales, 'es/auditRoutes.json');

/** What the audit records: every request that is not a read (`MUTATING` in src/security.ts) */
const WRITES = /^(POST|PUT|PATCH|DELETE) /;

/**
 * Summaries that read the same in Spanish: a literal or a product name with nothing to translate.
 * Keyed by route, so a summary that changes is checked again.
 */
export const SAME_IN_BOTH: ReadonlySet<string> = new Set<string>([]);

/** Every write route's summary, keyed by its `ROUTE_DOCS` key and sorted by it */
export function auditRouteStrings(docs: Record<string, { summary: string }> = ROUTE_DOCS): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(docs).filter((k) => WRITES.test(k)).sort()) out[key] = docs[key]?.summary ?? '';
  return out;
}

/** A Spanish string still waiting for its translation: equal to the English one, with letters in it */
export function untranslated(key: string, en: string, es: string): boolean {
  return es === en && /\p{L}/u.test(es) && !SAME_IN_BOTH.has(key);
}

function readMap(file: string): Record<string, string> {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>) : {};
}

const json = (map: Record<string, string>): string => `${JSON.stringify(map, null, 2)}\n`;

/**
 * Rewrites English from the docs, drops the keys of routes that are gone from both files, adds the
 * missing Spanish keys in English, and never touches a Spanish value that is there. Answers the keys
 * Spanish still has to translate.
 */
export function syncAuditStrings(): string[] {
  const en = auditRouteStrings();
  const stored = readMap(ES_FILE);
  const es: Record<string, string> = {};
  for (const key of Object.keys(en)) es[key] = stored[key] ?? en[key] ?? '';
  writeFileSync(EN_FILE, json(en));
  writeFileSync(ES_FILE, json(es));
  return Object.keys(en).filter((key) => untranslated(key, en[key] ?? '', es[key] ?? ''));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const missing = syncAuditStrings();
  if (missing.length) {
    console.error(`${String(missing.length)} audit strings wait for their Spanish in ${ES_FILE}:\n${missing.map((k) => `  ${k}`).join('\n')}`);
    process.exit(1);
  }
  console.log('auditRoutes: English and Spanish are complete');
}
