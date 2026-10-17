import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { uploadIdsIn } from './collab/index.ts';
import type { Db } from './db.ts';
import { ATTACHED_OPEN } from './uploads.ts';

export interface ChatUpload {
  uploadId: string;
  /** When a message first attached it to the chat; for a chat older than the rows, when its transcript was scanned */
  attachedAt: string;
}

/**
 * Which uploads belong to a chat, for every chat and after any restart (a shared chat's copy pulls
 * them with it, docs/collaborators.md). A message that attaches files writes the rows as it goes
 * out (`ChatManager`); a chat from before those rows is looked through once, from its transcript.
 */
export class ChatUploads {
  private readonly scans = new Map<string, Promise<void>>();

  constructor(
    private readonly db: Db,
    private readonly uploadsDir: string,
    private readonly transcriptFile: (chatId: string) => Promise<string | null>,
  ) {}

  async of(chatId: string): Promise<ChatUpload[]> {
    if (!this.db.chatUploadsScanned(chatId)) {
      let scan = this.scans.get(chatId);
      if (!scan) {
        scan = this.scan(chatId).finally(() => this.scans.delete(chatId));
        this.scans.set(chatId, scan);
      }
      await scan;
    }
    return this.db.chatUploads(chatId);
  }

  private async scan(chatId: string): Promise<void> {
    const file = await this.transcriptFile(chatId);
    const ids = new Set<string>();
    if (file) {
      try {
        const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
        for await (const line of lines) {
          // Only a turn that attached files lists them; a tool's output naming an upload path is not one
          if (!line.includes(ATTACHED_OPEN)) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          for (const id of uploadIdsIn([parsed], this.uploadsDir)) ids.add(id);
        }
      } catch {
        // A transcript that went, or cannot be read, names nothing; the mark keeps it from being read again
      }
    }
    this.db.markChatUploadsScanned(chatId, [...ids], new Date().toISOString());
  }
}
