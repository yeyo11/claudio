import type { ClaudioReleaseInfo, ClaudioServer, DesktopUpdateStatus, ServerAddress, ServerAddressKind, ServerStatus } from '@claudio/shared';
import { monogramLetters, nameHue } from '@claudio/ui/components/icons';

/*
 * What the shell and the Servers page decide from a server's data (docs/plans/claudio-servers.md
 * §12.1): its mark, its status in words, the few the selector lists, and what the page's forms
 * check. Plain functions over plain data, apart from the components so a test reads them without
 * the app. The selector, the status bar and the page draw a server from these same rules, so its
 * mark and its word are the same wherever it shows.
 */

/** How many servers besides This server the selector lists (§1: "local pinned + 3 recents") */
export const RECENT_SERVERS = 3;

export type ServerTone = 'ok' | 'warn' | 'bad' | 'idle';

/**
 * Each status in its tone: ok connected; warn what the person can still fix by an action (the server
 * is coming back, needs an update, needs pairing again); bad what is broken or unsafe (offline, a
 * changed identity). A tone is always drawn beside its word and an icon.
 */
export const SERVER_TONE: Record<ServerStatus, ServerTone> = {
  connected: 'ok',
  reconnecting: 'warn',
  offline: 'bad',
  'needs-update': 'warn',
  'needs-pairing': 'warn',
  'identity-changed': 'bad',
};

/** A status in words: the key of its word, and the colour that goes with it (always beside the word) */
export const SERVER_STATUS = Object.fromEntries(
  (Object.keys(SERVER_TONE) as ServerStatus[]).map((key) => [key, { key, tone: SERVER_TONE[key] }]),
) as Readonly<Record<ServerStatus, { key: ServerStatus; tone: ServerTone }>>;

/**
 * A server's status; one nobody has read yet (the hub keeps health in memory only) has none, and
 * the shell then says nothing rather than guessing "Offline".
 */
export function serverStatus(server: Pick<ClaudioServer, 'health'>): { key: ServerStatus; tone: ServerTone } | null {
  const status = server.health?.status;
  return status ? (SERVER_STATUS[status] ?? null) : null;
}

/** A server with no reading yet has no tone, "Not checked": nothing is probed until it is used or tested */
export const serverTone = (server: Pick<ClaudioServer, 'health'>): ServerTone | null => (server.health ? SERVER_TONE[server.health.status] : null);

/** The two statuses that ask for a new pairing, and so offer **Pair again** instead of Open */
export const needsPairingAgain = (server: Pick<ClaudioServer, 'health'>): boolean =>
  server.health?.status === 'identity-changed' || server.health?.status === 'needs-pairing';

export const ADDRESS_KINDS: readonly ServerAddressKind[] = ['lan', 'tailscale', 'tunnel', 'other'];

/** At most as many addresses as the registry keeps per server (`packages/core/src/servers/registry.ts`) */
export const MAX_ADDRESSES = 8;
export const MAX_SERVER_NAME = 60;

/**
 * The kind an address most likely is, from its name: a Tailscale name ends in `.ts.net`, a private
 * address or a `.local` name is the LAN, anything else public is a tunnel's. A guess the person can
 * change; it only saves a click.
 */
export function guessAddressKind(url: string): ServerAddressKind {
  const host = hostOf(url);
  if (!host) return 'other';
  // Tailscale's own range (100.64.0.0/10) and its names
  if (host.endsWith('.ts.net') || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return 'tailscale';
  if (host === 'localhost' || host.endsWith('.local') || !host.includes('.') || /^(10|127)\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return 'lan';
  return 'tunnel';
}

/** The host of an address typed with or without its scheme; null for what is not an address */
export function hostOf(url: string): string | null {
  const parsed = parseAddress(url);
  return parsed ? parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase() : null;
}

/**
 * An address as the person typed it, made into the bare `https://` origin the server accepts:
 * `192.168.0.29:8791` becomes `https://192.168.0.29:8791`. A typed `http://` is kept, because the
 * server accepts it for loopback and says why for anything else. Null when it is not an address.
 */
export function normalizeAddress(input: string): string | null {
  const parsed = parseAddress(input);
  return parsed ? parsed.origin : null;
}

function parseAddress(input: string): URL | null {
  const text = input.trim();
  if (!text) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.hostname ? url : null;
  } catch {
    return null;
  }
}

/**
 * An address as a row shows it: without the `https://` every server address has by default, as the
 * person types it (`192.168.0.29:8791`), so it fits a phone's row whole. Plain `http://` stays
 * written, since it says something; the title keeps the whole origin.
 */
export const shownAddress = (url: string): string => url.replace(/^https:\/\//i, '');

/** The kind a typed address is saved with, unless the person chose one */
export const addressOf = (input: string, kind?: ServerAddressKind): ServerAddress | null => {
  const url = normalizeAddress(input);
  return url ? { url, kind: kind ?? guessAddressKind(url) } : null;
};

/** The name offered for a new server: the host of its first address, without a trailing `.local` */
export function defaultServerName(address: string): string {
  const host = hostOf(address);
  if (!host) return '';
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host;
  return host.replace(/\.local$/, '').split('.')[0] ?? host;
}

/**
 * Up to two letters for the tile when none was chosen: the initials of the first two words, or the
 * first two letters of a lone word, the rule every project mark follows (`studio` ST, `Mac studio` MS)
 */
export const defaultMonogram = (name: string): string => {
  // A server named by its IPv4 address (the default for a LAN one) is told apart by its last
  // number: 192.168.0.28 and .29 would both be "19" by their initials
  const ipv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.(\d{1,3})$/.exec(name.trim());
  if (ipv4?.[1]) return ipv4[1].slice(-2);
  return monogramLetters(name, true);
};

/** The letters of a server's mark: the ones it was given, else the initials of its name */
export function serverLetters(server: Pick<ClaudioServer, 'name' | 'monogram'>): string {
  const own = server.monogram?.trim();
  return own ? Array.from(own).slice(0, 2).join('').toUpperCase() : defaultMonogram(server.name);
}

/**
 * The colour tokens a server can wear, as the hue each stands for. The tile is the project's
 * `.monogram`, tinted from `--hue`, so a colour is a number here and never a hex; none is a status
 * hue (ok green, warn amber, bad red, live cyan), which would read as a state.
 */
export const SERVER_COLORS = {
  blue: 225,
  violet: 265,
  magenta: 310,
  rose: 345,
  orange: 28,
  lime: 85,
  teal: 175,
  sky: 200,
} as const;
export type ServerColor = keyof typeof SERVER_COLORS;
export const SERVER_COLOR_NAMES = Object.keys(SERVER_COLORS) as ServerColor[];

export const isServerColor = (value: string | null | undefined): value is ServerColor => value !== null && value !== undefined && Object.hasOwn(SERVER_COLORS, value);

/**
 * The hue of a server's mark: its colour token's; a token this build does not know (another
 * client's) gets a stable hue from the token, and no colour at all one from the name, the way every
 * monogram is tinted, so a server is never blank.
 */
export function serverHue(server: Pick<ClaudioServer, 'color' | 'name'>): number {
  if (isServerColor(server.color)) return SERVER_COLORS[server.color];
  return nameHue(server.color ?? server.name);
}

/** The first colour no server wears yet, so two servers do not look alike by default; the first when all are taken */
export function freeColor(servers: readonly Pick<ClaudioServer, 'color'>[]): ServerColor {
  const used = new Set(servers.map((server) => server.color));
  return SERVER_COLOR_NAMES.find((name) => !used.has(name)) ?? SERVER_COLOR_NAMES[0] ?? 'blue';
}

/** The certificate's fingerprint in groups of four hex digits, so two can be compared by eye (`AB:CD:…` → `ABCD 1234 …`) */
export function groupFingerprint(fingerprint: string): string[] {
  const hex = fingerprint.replace(/[^0-9a-f]/gi, '').toUpperCase();
  return hex.match(/.{1,4}/g) ?? [];
}

/** Whether two fingerprints are the same certificate, whatever their separators or case */
export const sameFingerprint = (a: string, b: string): boolean => groupFingerprint(a).join('') === groupFingerprint(b).join('');

/**
 * A pairing code as it is shown, in two groups of four (`ABCD EFGH`); what is typed or pasted is
 * read back through `cleanCode`, which drops every space and dash and upper-cases.
 */
export const groupCode = (code: string): string => (code.length > 4 ? `${code.slice(0, 4)} ${code.slice(4)}` : code);
export const cleanCode = (typed: string): string => typed.replace(/[^0-9a-z]/gi, '').toUpperCase().slice(0, 8);
export const CODE_LENGTH = 8;

/**
 * Whether an address will show a certificate of the other Claudio's own (the LAN card's fingerprint)
 * or one a public authority signed for a name (a Tailscale or tunnel host), where the confirmation
 * must say that the numbers will not match the card's (D15).
 */
export function certificateIsFromAuthority(address: string): boolean {
  const host = hostOf(address);
  if (!host) return false;
  if (/^[\d.]+$/.test(host) || host.includes(':') || host.endsWith('.local') || !host.includes('.')) return false;
  return true;
}

/** Whole seconds until `expiresAt`, never below zero */
export const secondsLeft = (expiresAt: string, now: number): number => Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));

/**
 * Whether the row offers **Update**: the server says a newer release is out and its desktop update
 * unit can start one (it is idle, or says up to date but a release is out). A unit that is missing,
 * running, needs a login or only waits for a restart offers nothing from here.
 */
export function canUpdateServer(release: Pick<ClaudioReleaseInfo, 'updateAvailable'> | undefined, unit: Pick<DesktopUpdateStatus, 'state'> | undefined): boolean {
  if (!release?.updateAvailable || !unit) return false;
  return unit.state === 'idle' || unit.state === 'up-to-date';
}

/** The three most recent first, then the rest by name: what the list shows, so the last used is on top */
export function sortServers(servers: readonly ClaudioServer[]): ClaudioServer[] {
  return [...servers].sort((a, b) => {
    const au = a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0;
    const bu = b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0;
    return bu - au || a.name.localeCompare(b.name);
  });
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

/** Moves the item at `from` to `to`, for the addresses' order: a copy, and the same array when nothing moves */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  if (from === to || from < 0 || to < 0 || from >= next.length || to >= next.length) return next;
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

/** One address being edited: `kind` null means "the guess from what is typed", until the person picks one */
export interface AddressDraft {
  key: number;
  url: string;
  kind: ServerAddressKind | null;
}

let draftKey = 0;
export const newDraft = (url = '', kind: ServerAddressKind | null = null): AddressDraft => ({ key: ++draftKey, url, kind });
export const draftsOf = (addresses: readonly ServerAddress[]): AddressDraft[] => addresses.map((address) => newDraft(address.url, address.kind));

/**
 * The addresses to send from the drafts, blank rows dropped. `invalid` holds the keys of the rows
 * that are typed but are no address, so each can say so; nothing is sent while any is.
 */
export function addressesOf(drafts: readonly AddressDraft[]): { addresses: ServerAddress[]; invalid: number[] } {
  const addresses: ServerAddress[] = [];
  const invalid: number[] = [];
  for (const draft of drafts) {
    if (!draft.url.trim()) continue;
    const address = addressOf(draft.url, draft.kind ?? undefined);
    if (address) addresses.push(address);
    else invalid.push(draft.key);
  }
  return { addresses, invalid };
}

/** Whether the edit changes the addresses (a new or moved one), which the server then has to prove */
export const sameAddresses = (a: readonly ServerAddress[], b: readonly ServerAddress[]): boolean =>
  a.length === b.length && a.every((address, i) => address.url === b[i]?.url && address.kind === b[i]?.kind);
