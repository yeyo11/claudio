import type { ClaudioServer, ServerStatus } from '@claudio/shared';
import { monogramLetters, nameHue } from '@claudio/ui/components/icons';

/*
 * What the shell draws of a server (docs/plans/claudio-servers.md §12.1): its mark, its status in
 * words and the few it lists in the selector. Plain data and functions, so a test reads them
 * without the app.
 */

/** How many servers besides This server the selector lists (§1: "local pinned + 3 recents") */
export const RECENT_SERVERS = 3;

/**
 * The hue each colour token a server can carry stands for. A server stores the token's name, never
 * a value (the engine refuses a hex), and the mark is tinted from `--hue` like every monogram. A name
 * this table does not know still gets a stable hue of its own, so a newer colour is never blank.
 */
const COLOR_HUES: Readonly<Record<string, number>> = {
  red: 5,
  orange: 28,
  amber: 42,
  green: 145,
  teal: 175,
  cyan: 190,
  blue: 220,
  indigo: 245,
  violet: 270,
  purple: 285,
  pink: 330,
};

/** The colour tokens the table above knows, in the order a picker would offer them */
export const SERVER_COLORS: readonly string[] = Object.keys(COLOR_HUES);

/** The hue of a server's mark: its colour token's, else one worked out from its name */
export function serverHue(server: Pick<ClaudioServer, 'name' | 'color'>): number {
  if (server.color === null) return nameHue(server.name);
  return COLOR_HUES[server.color] ?? nameHue(server.color);
}

/** The letters of a server's mark: the ones it was given, else the initials of its name */
export function serverLetters(server: Pick<ClaudioServer, 'name' | 'monogram'>): string {
  const own = server.monogram?.trim();
  return own ? Array.from(own).slice(0, 2).join('').toUpperCase() : monogramLetters(server.name);
}

/**
 * The servers the selector lists after This server: the most recently used first, and one never
 * used (just paired) after them by when it was added, so a new server is in the menu before its
 * first visit instead of being reachable only from the page.
 */
export function recentServers(servers: readonly ClaudioServer[], limit: number = RECENT_SERVERS): ClaudioServer[] {
  const stamp = (value: string | null) => (value === null ? 0 : Date.parse(value) || 0);
  return [...servers]
    .sort((a, b) => stamp(b.lastUsedAt) - stamp(a.lastUsedAt) || stamp(b.createdAt) - stamp(a.createdAt) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

export type ServerTone = 'ok' | 'warn' | 'bad' | 'idle';

/** A status in words: the key under `shell:servers.status`, and the colour that goes with it (always beside the word) */
export const SERVER_STATUS: Readonly<Record<ServerStatus, { key: ServerStatus; tone: ServerTone }>> = {
  connected: { key: 'connected', tone: 'ok' },
  reconnecting: { key: 'reconnecting', tone: 'warn' },
  offline: { key: 'offline', tone: 'bad' },
  'needs-update': { key: 'needs-update', tone: 'warn' },
  'needs-pairing': { key: 'needs-pairing', tone: 'warn' },
  'identity-changed': { key: 'identity-changed', tone: 'bad' },
};

/**
 * A server's status; one nobody has read yet (the hub keeps health in memory only) has none, and
 * the menu then says nothing rather than guessing "Offline".
 */
export function serverStatus(server: Pick<ClaudioServer, 'health'>): { key: ServerStatus; tone: ServerTone } | null {
  const status = server.health?.status;
  return status ? (SERVER_STATUS[status] ?? null) : null;
}
