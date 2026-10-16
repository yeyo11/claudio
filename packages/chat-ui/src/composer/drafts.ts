/**
 * What was typed in a chat's box and not sent, kept in the browser so a reload, a switch to another
 * chat or a send that failed never loses it. Text only: an attachment's upload id is the server's,
 * and one kept for days would point at nothing.
 */

/** A draft not touched for this long is let go: whatever it was for is over. */
export const DRAFT_TTL_MS = 7 * 24 * 3_600_000;

const PREFIX = 'claudio-composer-draft:';

/** The part of `Storage` a draft needs, so tests hand in a map. */
export type DraftStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const draftKey = (chatId: string, kind: string): string => `${PREFIX}${chatId}:${kind}`;

function store(): DraftStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // storage blocked: drafts are a nicety
    return null;
  }
}

export function readDraft(key: string, now = Date.now(), from: DraftStore | null = store()): string {
  if (!from) return '';
  try {
    const raw = from.getItem(key);
    if (!raw) return '';
    const draft = JSON.parse(raw) as { text?: unknown; at?: unknown };
    if (typeof draft.text !== 'string' || typeof draft.at !== 'number' || now - draft.at > DRAFT_TTL_MS) {
      from.removeItem(key);
      return '';
    }
    return draft.text;
  } catch {
    return '';
  }
}

/** Keeps `text` under `key`; an empty or blank text removes the draft. */
export function writeDraft(key: string, text: string, now = Date.now(), to: DraftStore | null = store()): void {
  if (!to) return;
  try {
    if (!text.trim()) to.removeItem(key);
    else to.setItem(key, JSON.stringify({ text, at: now }));
  } catch {
    // full or blocked: the box still holds the text
  }
}
