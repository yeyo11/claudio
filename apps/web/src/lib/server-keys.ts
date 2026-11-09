import { hashKey, type QueryKey } from '@tanstack/react-query';

/*
 * Every cached read belongs to one server (docs/plans/claudio-servers.md §4.3, §9.3: "query keys
 * start with the serverId"). The keys themselves are written in 700-odd places and are matched by
 * prefix (`invalidateQueries({ queryKey: ['chat', id] })`), so the server is put in front where
 * the cache identifies a query: its hash. Two servers' `['chats']` are two entries, and an
 * invalidation, which matches within one client, still reaches exactly its own.
 *
 * The page's client is also made for one scope and dropped with the page, so this is the second
 * lock on a door that is already shut: a server's answer can never be read as another's.
 */
export function serverKeyHash(serverId: string): (key: QueryKey) => string {
  return (key) => hashKey([serverId, ...key]);
}
