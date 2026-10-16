import { findMember, membershipChanges, type RosterVersion } from './roster.ts';

/**
 * How a member is named wherever it is shown or announced: by the display name its roster gives it,
 * with the endpoint id only as a short secondary detail. Pure, so the naming is tested on its own.
 */

/** The start of an endpoint id: what a log line or a name nobody gave falls back to. */
export const shortEndpoint = (id: string): string => id.slice(0, 8);

/**
 * The display name of `id`, from the newest roster version that lists it, else from `hints` (what an
 * invite says about its owner and relays, before this install holds the roster); null when unknown.
 */
export function nameOf(
  chains: Iterable<readonly RosterVersion[]>,
  id: string,
  hints: Readonly<Record<string, string>> = {},
): string | null {
  let best: { name: string; issuedAt: string } | null = null;
  for (const chain of chains) {
    const head = chain.at(-1);
    const member = head && findMember(head, id);
    if (member && member.name.trim() !== '' && (!best || head.issuedAt > best.issuedAt)) best = { name: member.name, issuedAt: head.issuedAt };
  }
  if (best) return best.name;
  const hint = Object.hasOwn(hints, id) ? hints[id]?.trim() : undefined;
  return hint ? hint : null;
}

/** A member in a log line: `Ana (ff5a9c9b)`, or the short id alone when no roster names it. */
export function describeMember(name: string | null, id: string): string {
  return name ? `${name} (${shortEndpoint(id)})` : shortEndpoint(id);
}

/** Names in a sentence: `Ana`, `Ana and Bo`, `Ana, Bo and Cy`. */
function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) as string}`;
}

/**
 * The title of the `collaborators.changed` event a new roster version raises: who joined, left or
 * became the owner, by the names the versions give them. Null when no version came before.
 */
export function rosterChangeTitle(prev: RosterVersion | null, next: RosterVersion): string | null {
  if (!prev) return null;
  const { added, removed } = membershipChanges(prev, next);
  const parts: string[] = [];
  if (added.length) parts.push(`${listNames(added.map((m) => m.name))} joined ${next.name}`);
  if (removed.length) parts.push(`${listNames(removed.map((m) => m.name))} left ${next.name}`);
  if (prev.owner !== next.owner) {
    const owner = findMember(next, next.owner);
    parts.push(`${owner?.name ?? shortEndpoint(next.owner)} is now the owner of ${next.name}`);
  }
  return parts.length ? parts.join('; ') : `${next.name} changed`;
}
