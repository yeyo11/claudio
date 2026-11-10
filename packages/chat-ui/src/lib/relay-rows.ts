/**
 * The record the lead's transcript keeps of what the person wrote straight to a subagent. The CLI
 * writes that line into the subagent's file only, so the lead's own would never say it happened:
 * the server lists the delivered messages (`ChatDetail.toAgents`) and each becomes a system row
 * ("You → E2: …") at the time the subagent took it.
 */
import type { SentToAgent } from '@claudio/shared';
import type { TranscriptRow } from './chat-steps';

export interface RelayItem {
  kind: 'relay';
  key: string;
  agentId: string;
  text: string;
  at: string;
}

export type ListedRow = TranscriptRow | RelayItem;

const timeOf = (row: TranscriptRow): number => {
  const at = row.kind === 'entry' ? row.entry.timestamp : row.kind === 'step' ? row.startedAt : (row.boundary?.timestamp ?? row.summary?.timestamp ?? null);
  return at ? Date.parse(at) : Number.NaN;
};

/**
 * The rows with each relay placed before the first row that began after it. A relay older than the
 * rows held (a transcript read from its newest page) is left out: its place is in a page not loaded yet.
 * The same array back when there is nothing to place.
 */
export function withRelays(rows: TranscriptRow[], sent: readonly SentToAgent[] | undefined): ListedRow[] {
  if (!sent?.length || rows.length === 0) return rows;
  const firstAt = rows.map(timeOf).find((ms) => !Number.isNaN(ms));
  const items = sent
    .map((message) => ({ ms: Date.parse(message.at), item: { kind: 'relay', key: `relay-${message.id}`, agentId: message.agentId, text: message.text, at: message.at } satisfies RelayItem }))
    .filter(({ ms }) => Number.isFinite(ms) && (firstAt === undefined || ms >= firstAt))
    .sort((a, b) => a.ms - b.ms);
  if (items.length === 0) return rows;
  const out: ListedRow[] = [];
  let next = 0;
  for (const row of rows) {
    const ms = timeOf(row);
    while (next < items.length && !Number.isNaN(ms) && (items[next]?.ms ?? Infinity) < ms) {
      out.push((items[next] as (typeof items)[number]).item);
      next++;
    }
    out.push(row);
  }
  for (; next < items.length; next++) out.push((items[next] as (typeof items)[number]).item);
  return out;
}
