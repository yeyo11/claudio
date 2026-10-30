/**
 * Messages sent into a turn that is still running, tracked by the id each was sent with
 * (docs/chat-delivery.md).
 *
 * The agent reads a message written while it works at its next tool boundary, or as its next turn,
 * so the composer empties and nothing in the conversation says the message is still waiting. Each
 * one is a card over the box instead, from the moment the server answers that it took it, until the
 * stream says the agent read it, or that it was lost; then the card says so and hands the words and
 * the files back. Nothing here guesses from the words or from a clock: the server says which.
 *
 * A message nobody typed (the Supervisor's hint, Claudio's note of a cancelled command) is a card
 * too, drawn as a notice: it is not the person's to hurry, only to withdraw.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Chat, ChatMessageReceipt, ChatMessageSource, ChatPendingAttachment, ChatPendingBlocker, ChatPendingMessage, MessageDelivery, TranscriptEntry } from '@claudio/shared';
import { isStreamed, type ChatStreamStore } from '../lib/chat-stream';

export interface QueuedMessage {
  /** The message's own id: the one the server, the agent and its transcript know it by */
  id: string;
  /** What was typed, as sent; for a notice, its words without the framing the agent gets */
  text: string;
  /** The files sent with it, which a lost card hands back */
  attachments: ChatPendingAttachment[];
  /** `waiting`: in the agent's queue. `held`: for the process that replaces the one leaving. `lost`: never read */
  state: 'waiting' | 'held' | 'lost';
  /** Who it comes from: only a person's message is offered "Send now" and handed back */
  source: ChatMessageSource;
  /** The foreground call the turn is inside of, which the agent reads nothing before; as of the last read */
  blockedBy?: ChatPendingBlocker;
}

export interface QueuedCard extends QueuedMessage {
  /** When this page learnt of it: a read older than that cannot know it */
  seenAt: number;
}

/** What the server has said about the messages of one chat, as the page holds it. */
export interface DeliveryFacts {
  /** What the chat lists as pending on its last read (`chat.pending`) */
  pending: readonly ChatPendingMessage[];
  /** When that read was made */
  readAt: number;
  /** What the stream said became of a message since the page opened it */
  delivery: (id: string) => MessageDelivery | undefined;
  /** Ids of the user entries the agent's transcript holds: those were read, whatever else was missed */
  written: ReadonlySet<string>;
  /** Cards the person dealt with, which the server may list a while longer */
  dismissed: ReadonlySet<string>;
}

/**
 * How long a card outlives a read of the chat that no longer lists it as pending. A read that set
 * out before the message was sent does not list it either; one that lands this much later and still
 * does not, says the agent has it.
 */
const SETTLE_MS = 3000;
/** Dismissed ids kept per chat: far more than ever wait at once */
const MAX_DISMISSED = 50;

const stateOf = (pending: ChatPendingMessage): QueuedMessage['state'] => (pending.state === 'undelivered' ? 'lost' : pending.state === 'held' ? 'held' : 'waiting');

/** Whether a card is a notice: written into the chat by Claudio or its Supervisor, not by the person */
export const isNotice = (message: Pick<QueuedMessage, 'source'>): boolean => message.source !== 'person';

/** The same blocker, so a read that changes nothing keeps the card as it was */
const sameBlocker = (a: ChatPendingBlocker | undefined, b: ChatPendingBlocker | undefined): boolean => a?.toolUseId === b?.toolUseId;

/** The card updated with what the server lists of it; the same card when nothing changed */
function updated(card: QueuedCard, server: ChatPendingMessage): QueuedCard {
  const state = stateOf(server);
  const source = server.source ?? card.source;
  if (state === card.state && source === card.source && sameBlocker(card.blockedBy, server.blockedBy)) return card;
  const { blockedBy: _old, ...rest } = card;
  return { ...rest, state, source, ...(server.blockedBy ? { blockedBy: server.blockedBy } : {}) };
}

/**
 * The cards of a chat brought up to what the server says, by id: a message the agent took goes, a
 * lost one says so, one withdrawn goes, and one the server still holds that the page did not send
 * (after a reload, sent from elsewhere, or written by Claudio) gets a card. The same array back when
 * nothing changed.
 */
export function reconcileCards(held: readonly QueuedCard[], facts: DeliveryFacts): readonly QueuedCard[] {
  const listed = new Map(facts.pending.map((m) => [m.id, m]));
  const next: QueuedCard[] = [];
  for (const card of held) {
    const told = facts.delivery(card.id);
    if (told?.state === 'delivered' || told?.state === 'carried' || facts.written.has(card.id)) continue;
    // Withdrawn: whoever withdrew it knows, and there is nothing to hand back
    if (told?.state === 'undelivered' && told.reason === 'cancelled') continue;
    if (told?.state === 'undelivered') {
      next.push(card.state === 'lost' ? card : { ...card, state: 'lost' });
      continue;
    }
    const server = listed.get(card.id);
    if (server) {
      next.push(updated(card, server));
      continue;
    }
    // Not listed by a read made well after it was sent: the agent has it, or nobody can follow it
    if (card.state !== 'lost' && facts.readAt - card.seenAt > SETTLE_MS) continue;
    next.push(card);
  }
  for (const message of facts.pending) {
    if (next.some((card) => card.id === message.id) || facts.dismissed.has(message.id) || facts.written.has(message.id)) continue;
    const told = facts.delivery(message.id);
    if (told && told.state !== 'undelivered') continue;
    if (told?.reason === 'cancelled') continue;
    next.push({
      id: message.id,
      text: message.text,
      attachments: message.attachments,
      state: told ? 'lost' : stateOf(message),
      source: message.source ?? 'person',
      ...(message.blockedBy && !told ? { blockedBy: message.blockedBy } : {}),
      seenAt: facts.readAt,
    });
  }
  const same = next.length === held.length && next.every((card, i) => card === held[i]);
  return same ? held : next;
}

/** Where a chat's dismissed cards are kept for the tab's life: a reload must not bring back a card the person put away */
const dismissedKey = (chatId: string): string => `claudio.queued.dismissed.${chatId}`;

/** The cards a person dealt with in this chat, as the tab kept them; none where the storage cannot be read. */
export function readDismissed(chatId: string, storage: Pick<Storage, 'getItem'> | null = sessionStore()): Set<string> {
  if (!chatId || !storage) return new Set();
  try {
    const saved: unknown = JSON.parse(storage.getItem(dismissedKey(chatId)) ?? '[]');
    return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Keeps one more dismissed card for the chat, the newest last and the oldest let go past the bound. */
export function writeDismissed(chatId: string, dismissed: ReadonlySet<string>, storage: Pick<Storage, 'setItem'> | null = sessionStore()): void {
  if (!chatId || !storage) return;
  try {
    storage.setItem(dismissedKey(chatId), JSON.stringify([...dismissed].slice(-MAX_DISMISSED)));
  } catch {
    // A full or blocked storage keeps the card away for this page only
  }
}

function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * An entry the agent took into a running turn is dated when the agent took it, not when it was
 * queued: its `delivered` event says when. The same entry back when the stream said nothing of it.
 */
export function datedByDelivery(entry: TranscriptEntry, delivery: (id: string) => MessageDelivery | undefined): TranscriptEntry {
  if (entry.role !== 'user') return entry;
  const told = delivery(entry.uuid);
  return told?.state === 'delivered' && told.at && told.at !== entry.timestamp ? { ...entry, timestamp: told.at } : entry;
}

/**
 * The cards of one chat. `items` is the conversation the page holds, `readAt` when the chat was last
 * read: what the server lists as pending (`chat.pending`) is only as fresh as that read.
 */
export function useQueuedMessages(chat: Chat | undefined, items: TranscriptEntry[], stream: ChatStreamStore, readAt: number) {
  const chatId = chat?.id ?? '';
  // Kept by chat, so a card can never show over another chat's composer
  const [byChat, setByChat] = useState<Record<string, readonly QueuedCard[]>>({});
  // Cards the person dealt with (put back in the box, dismissed): the server may list them a while
  // longer, and a reload would otherwise bring them back. Per chat, for the tab's life
  const [dismissed, setDismissed] = useState<Record<string, Set<string>>>({});
  const own = dismissed[chatId];
  const ids = useMemo(() => own ?? readDismissed(chatId), [own, chatId]);
  const heard = useSyncExternalStore(stream.subscribeDeliveries, stream.deliveryVersion);
  const pending = chat?.pending;

  const add = useCallback(
    (receipt: ChatMessageReceipt, text: string, attachments: ChatPendingAttachment[]) => {
      // A turn of its own starts on it at once: there is nothing to wait for
      if (receipt.taken === 'started' || !chatId) return;
      const told = stream.delivery(receipt.id);
      if (told && told.state !== 'undelivered') return;
      setByChat((all) => {
        const held = all[chatId] ?? [];
        if (held.some((card) => card.id === receipt.id)) return all;
        const card: QueuedCard = { id: receipt.id, text: text.trim(), attachments, state: told ? 'lost' : receipt.taken === 'held' ? 'held' : 'waiting', source: 'person', seenAt: Date.now() };
        return { ...all, [chatId]: [...held, card] };
      });
    },
    [chatId, stream],
  );

  const drop = useCallback(
    (id: string) => {
      const next = new Set(ids);
      next.add(id);
      writeDismissed(chatId, next);
      setDismissed((all) => ({ ...all, [chatId]: next }));
      setByChat((all) => ({ ...all, [chatId]: (all[chatId] ?? []).filter((card) => card.id !== id) }));
    },
    [chatId, ids],
  );

  // What the server says, by id: the stream as it happens, and the chat's own list on every read
  useEffect(() => {
    if (!chatId) return;
    const written = new Set(items.filter((entry) => entry.role === 'user' && !isStreamed(entry)).map((entry) => entry.uuid));
    const facts: DeliveryFacts = { pending: pending ?? [], readAt, delivery: (id) => stream.delivery(id), written, dismissed: ids };
    setByChat((all) => {
      const held = all[chatId] ?? [];
      const next = reconcileCards(held, facts);
      return next === held ? all : { ...all, [chatId]: next };
    });
  }, [chatId, pending, items, readAt, heard, stream, ids]);

  const queued: readonly QueuedMessage[] = byChat[chatId] ?? [];

  /**
   * The entry a card stands for: put on the page by the stream the moment it was sent, and not in
   * the conversation until the agent reads it. The page leaves it out, or the message would be in
   * two places at once.
   */
  const queuedIds = queued.map((card) => card.id).join('\n');
  const isPending = useCallback((entry: TranscriptEntry) => entry.role === 'user' && isStreamed(entry) && queuedIds.split('\n').includes(entry.uuid), [queuedIds]);

  /**
   * The conversation with each message the agent took dated when it took it. A new function whenever
   * a delivery is heard (`heard`), so what the page memoes on it is drawn again
   */
  const dated = useMemo(() => (entries: TranscriptEntry[]) => entries.map((entry) => datedByDelivery(entry, (id) => stream.delivery(id))), [stream, heard]);

  return { queued, add, drop, pending: isPending, dated };
}
