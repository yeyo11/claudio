import i18n from '../../i18n';

// A code arrives at run time (the server's, or a remote's through it), so it cannot be checked against the typed keys
const translate = i18n.t.bind(i18n) as unknown as (key: string, options: Record<string, string>) => string;
const exists = i18n.exists.bind(i18n) as unknown as (key: string, options?: Record<string, string>) => boolean;

/**
 * The words of a code a server answered (`servers.unreachable`, `terminal.needs-tunnel`): the
 * `serversPage` key under `group`, or null when this build has none, so the page says nothing
 * rather than showing a key or the server's English.
 */
export function codeWords(group: 'reason' | 'test.code', code: string | undefined): string | null {
  if (!code) return null;
  const key = `serversPage:${group}.${code}`;
  return exists(key) ? translate(key, {}) : null;
}
