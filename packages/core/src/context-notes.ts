import { randomUUID } from 'node:crypto';
import type { ChatCompaction, ChatSessionNote, CompactRefusal, SessionNoteSection, TranscriptEntry } from '@claudio/shared';
import { COMPACTION_LEASE_MS, type Db } from './db.ts';
import type { RunResult } from './live-chat.ts';

/*
 * Session notes: the summary Claude Code continues from, kept as a row so the person can read it
 * later, copy it, or put it in the project journal by a click (docs/plans/context-control.md, D9).
 * A note is model output that may carry what a web page or an MCP server said: it is never handed to
 * a run and never put in a prompt by Claudio.
 */

/**
 * Appended to `/compact` when the summary is asked for as a session note. Load-bearing: the headings
 * are what `parseSessionNote` looks for, and the text is English whatever language the chat is in
 * (what agents record is English). One paragraph, because it travels on the line of the command.
 */
export const SESSION_NOTE_INSTRUCTIONS =
  'Write the summary as a session note for whoever continues this work, in English, under exactly ' +
  'these Markdown headings and in this order: "## Goal", "## Done (with evidence)", "## Failed", ' +
  '"## Not tried yet", "## Files in flight", "## Next step". Under "Done", give the evidence for each ' +
  'item: a test that passed, a command and its result, a commit. Under "Files in flight", list every ' +
  'path changed and not committed yet. Keep every decision the person made and every constraint they ' +
  'stated. Never copy a secret, token, key or password.';

/**
 * The turn that asks for a note with no compaction. The plan fixes one text for both uses: asked on
 * its own, the same sentence reads as the request, and the note comes back as the turn's answer.
 */
export const NOTE_REQUEST_PROMPT = SESSION_NOTE_INSTRUCTIONS;

/**
 * What goes to the CLI for a compaction: `/compact`, then the person's focus as written and the note
 * instructions. Recorded (F9): a newline in the argument reaches the summariser whole, so the focus
 * is not rewritten; the instructions follow it on the same line.
 */
export function compactText(focus: string | null, structured: boolean): string {
  const parts = ['/compact'];
  if (focus) parts.push(`Keep in particular: ${focus}`);
  if (structured) parts.push(SESSION_NOTE_INSTRUCTIONS);
  return parts.join(' ');
}

/** What a person typing `/compact` into an idle chat starts (E4): the text is sent as typed */
export const TYPED_COMPACT = /^\/compact(\s|$)/;

/** The headings the note was asked for, in the order they were asked for */
const HEADINGS: ReadonlyArray<{ key: SessionNoteSection; heading: RegExp }> = [
  { key: 'goal', heading: /^#{1,6}[ \t]+Goal[ \t]*:?[ \t]*$/im },
  // Claude may drop the parenthesis, which the heading only asked the evidence in
  { key: 'done', heading: /^#{1,6}[ \t]+Done(?:[ \t]*\(with evidence\))?[ \t]*:?[ \t]*$/im },
  { key: 'failed', heading: /^#{1,6}[ \t]+Failed[ \t]*:?[ \t]*$/im },
  { key: 'not-tried', heading: /^#{1,6}[ \t]+Not tried yet[ \t]*:?[ \t]*$/im },
  { key: 'files', heading: /^#{1,6}[ \t]+Files in flight[ \t]*:?[ \t]*$/im },
  { key: 'next', heading: /^#{1,6}[ \t]+Next step[ \t]*:?[ \t]*$/im },
];

/**
 * The six sections of a note, only when every heading is there and in order; otherwise null, and the
 * text stays whole (E35). Nothing is guessed from a note that does not keep the shape.
 */
export function parseSessionNote(text: string): Partial<Record<SessionNoteSection, string>> | null {
  const found: Array<{ key: SessionNoteSection; start: number; end: number }> = [];
  let from = 0;
  for (const { key, heading } of HEADINGS) {
    const match = heading.exec(text.slice(from));
    if (!match) return null;
    const start = from + match.index;
    const end = start + match[0].length;
    found.push({ key, start, end });
    from = end;
  }
  const sections: Partial<Record<SessionNoteSection, string>> = {};
  found.forEach((h, i) => {
    sections[h.key] = text.slice(h.end, found[i + 1]?.start ?? text.length).trim();
  });
  return sections;
}

const REFUSAL_TEXT: Record<CompactRefusal | 'saved', string> = {
  housekeeping: 'This chat is housekeeping and keeps no conversation to compact.',
  'read-only': 'Something else holds this conversation, so it cannot be compacted from here.',
  'no-history': 'This chat has no conversation to compact yet.',
  unsupported: 'This version of Claude Code does not offer /compact in this chat.',
  'at-limit': 'This chat is waiting on a usage limit.',
  run: 'A run of the flow or the assistant is working on this chat.',
  open: 'A compaction or a note is already being written for this chat.',
  waiting: 'This chat is waiting for an answer to a permission prompt.',
  busy: 'This chat is working: interrupt it or wait for it to finish.',
  saved: 'That summary is already saved as a note.',
};

/** What the person's click cannot do now; the API sends it as a 409 with `reason` as its `code` */
export class ContextRefusal extends Error {
  readonly statusCode = 409;
  constructor(readonly reason: CompactRefusal | 'saved') {
    super(REFUSAL_TEXT[reason]);
  }
}

export interface ChatNotesDeps {
  db: Db;
  /** Throws a `ContextRefusal` when a housekeeping turn cannot start on the chat now: the same refusals as a compaction */
  check(chatId: string): Promise<void>;
  /** Writes the note turn to the chat, live or by resuming it */
  turn(chatId: string, text: string): Promise<void>;
  /** The chat's compaction entries (boundaries and summaries) read from its transcript, oldest first */
  compactionEntries(chatId: string): Promise<TranscriptEntry[]>;
}

const textOf = (entry: TranscriptEntry): string =>
  entry.blocks
    .flatMap((b) => (b.type === 'text' ? [b.text] : []))
    .join('\n\n')
    .trim();

/** Session notes of a chat, and the three ways one comes to be (docs/plans/context-control.md) */
export class ChatNotes {
  constructor(private readonly deps: ChatNotesDeps) {}

  list(chatId: string): ChatSessionNote[] {
    return this.deps.db.notes(chatId);
  }

  /** Asks the agent for a note with no compaction: a paid housekeeping turn the person chose to spend */
  async requestFromAgent(chatId: string, actor: string | null = null): Promise<ChatSessionNote> {
    void actor;
    await this.deps.check(chatId);
    const now = new Date();
    const claimed = this.deps.db.claimHousekeeping(
      chatId,
      { kind: 'note', leaseUntil: new Date(now.getTime() + COMPACTION_LEASE_MS).toISOString(), row: { id: randomUUID(), source: 'agent', entryUuid: null, createdAt: now.toISOString() } },
      now.toISOString(),
    );
    if (!claimed) throw new ContextRefusal('open');
    const note = claimed as ChatSessionNote;
    try {
      await this.deps.turn(chatId, NOTE_REQUEST_PROMPT);
    } catch (err) {
      this.deps.db.updateNote(note.id, { state: 'failed', error: err instanceof Error ? err.message : String(err), leaseUntil: null }, { from: ['pending'] });
      throw err;
    }
    return this.deps.db.noteById(note.id) ?? note;
  }

  /** Keeps a summary the person chose from the transcript. 400 for an entry that is not one; 409 when it already is a note. */
  async fromSummary(chatId: string, entryUuid: string): Promise<ChatSessionNote> {
    if (typeof entryUuid !== 'string' || !entryUuid) throw new Error('entryUuid is required');
    const entries = await this.deps.compactionEntries(chatId);
    const at = entries.findIndex((e) => e.uuid === entryUuid && e.compaction?.part === 'summary');
    const entry = entries[at];
    if (!entry) throw new Error('entryUuid is not a summary of this chat');
    const text = textOf(entry);
    if (!text) throw new Error('entryUuid is not a summary of this chat');
    const before = entries[at - 1];
    const boundary = before?.compaction?.part === 'boundary' ? this.deps.db.compactionByBoundary(before.uuid) : null;
    const now = new Date().toISOString();
    const note: ChatSessionNote = {
      id: randomUUID(),
      chatId,
      source: 'summary',
      state: 'ready',
      text,
      sections: parseSessionNote(text),
      compactionId: boundary?.chatId === chatId ? boundary.id : null,
      entryUuid: entry.uuid,
      error: null,
      createdAt: now,
      readyAt: now,
    };
    if (!this.deps.db.insertNote(note)) throw new ContextRefusal('saved');
    return note;
  }

  /** A note that a compaction made, kept when its summary entry is seen; the entry is the note's anchor, so seeing it twice keeps one */
  fromCompaction(row: ChatCompaction, entry: TranscriptEntry): ChatSessionNote | null {
    if (!row.structuredNote || row.noteId) return null;
    const text = textOf(entry);
    if (!text) return null;
    const now = new Date().toISOString();
    const note: ChatSessionNote = {
      id: randomUUID(),
      chatId: row.chatId,
      source: 'compaction',
      state: 'ready',
      text,
      sections: parseSessionNote(text),
      compactionId: row.id,
      entryUuid: entry.uuid,
      error: null,
      createdAt: now,
      readyAt: now,
    };
    const kept = this.deps.db.insertNote(note) ? note : (this.deps.db.notes(row.chatId).find((n) => n.entryUuid === entry.uuid) ?? null);
    if (kept) this.deps.db.updateCompaction(row.id, { noteId: kept.id }, { from: ['requested', 'running', 'done', 'failed', 'cancelled'] });
    return kept;
  }

  /** The note turn's result: its final text is the note */
  onResult(chatId: string, result: RunResult): void {
    const pending = this.pendingOf(chatId);
    if (!pending) return;
    const text = result.result.trim();
    if (result.isError || !text) {
      this.deps.db.updateNote(pending.id, { state: 'failed', error: result.isError ? text || 'the turn failed' : 'Claude wrote no note', leaseUntil: null }, { from: ['pending'] });
      return;
    }
    this.deps.db.updateNote(pending.id, { state: 'ready', text, sections: parseSessionNote(text), readyAt: new Date().toISOString(), leaseUntil: null }, { from: ['pending'] });
  }

  /** The process ended with a note still being written */
  onEnded(chatId: string, error: string | null): void {
    const pending = this.pendingOf(chatId);
    if (pending) this.deps.db.updateNote(pending.id, { state: 'failed', error: error ?? 'the process ended before the note was written', leaseUntil: null }, { from: ['pending'] });
  }

  /** Deletes one note of this chat; false for an unknown note or one of another chat */
  remove(chatId: string, id: string): boolean {
    return this.deps.db.deleteNote(chatId, id);
  }

  pendingOf(chatId: string): ChatSessionNote | null {
    return this.deps.db.notes(chatId, 10).find((n) => n.state === 'pending') ?? null;
  }
}
