/**
 * The built-in roles' names in Spanish, one copy for every package. Core writes them into the first
 * line of a chat it starts for a member (that line is the chat's listed title, so it is written in
 * the person's language when the chat is created); the web shows the same names through its own
 * i18n (`apps/web/src/i18n/locales/es/team.json`, `roles`), and a web test keeps the two equal.
 * They live here, not in the web's locale file, because core must not reach into an app
 * (docs/plans/ci-and-regression-open.md, R2). The words follow apps/web/src/i18n/GLOSSARY.md.
 */
export const ROLE_TITLES_ES: Readonly<Record<string, string>> = {
  'product-owner': 'Product Owner',
  architect: 'Arquitecto',
  developer: 'Desarrollador',
  qa: 'QA',
  researcher: 'Investigador',
  writer: 'Redactor técnico',
  reviewer: 'Revisor',
  'silent-failure-hunter': 'Cazador de fallos silenciosos',
  'type-design-analyst': 'Analista de diseño de tipos',
  'build-resolver': 'Resolutor de builds',
  'spec-miner': 'Minero de especificaciones',
};

/** A built-in role's Spanish name, or null for a role someone made up, which is shown as written. */
export function roleTitleEs(role: string): string | null {
  // `hasOwn`, so a role named `constructor` or `toString` is not read off the prototype
  return Object.hasOwn(ROLE_TITLES_ES, role) ? (ROLE_TITLES_ES[role] ?? null) : null;
}
