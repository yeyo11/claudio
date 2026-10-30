import { errorMessage } from '@claudio/shared';
/** What the sweeper needs to know of a chat */
export interface RetainedChat {
  id: string;
  /** The newest moment anything happened on it: its record's update or an execution's start or end */
  lastActivityAt: string;
  /** A chat with a process is never deleted under it */
  alive: boolean;
}

export interface ChatRetentionOptions {
  /** Days a chat is kept after its last activity */
  days: number;
  chats(): RetainedChat[];
  /** Deletes the chat the way `DELETE /api/chats/:id` does: its rows and the CLI's session files */
  remove(id: string): Promise<void>;
  now?: () => number;
  /** How often it sweeps after the first sweep at start; an hour by default */
  intervalMs?: number;
  log?: (line: string) => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes a headless Claudio's chats once they have been idle for the retention period (D15). A
 * headless chat's transcript and rows hold what it read of a repository, and no person ever comes
 * back to tidy them: without this they would grow for as long as the volume lasts.
 */
export class ChatRetention {
  private timer: NodeJS.Timeout | null = null;
  private sweeping: Promise<string[]> | null = null;
  private readonly now: () => number;

  constructor(private readonly o: ChatRetentionOptions) {
    this.now = o.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), this.o.intervalMs ?? 60 * 60 * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass; resolves to the ids it deleted. Passes never overlap: a second call joins the first */
  sweep(): Promise<string[]> {
    this.sweeping ??= this.pass().finally(() => {
      this.sweeping = null;
    });
    return this.sweeping;
  }

  private async pass(): Promise<string[]> {
    const cutoff = this.now() - this.o.days * DAY_MS;
    const removed: string[] = [];
    let chats: RetainedChat[];
    try {
      chats = this.o.chats();
    } catch {
      // The store closed under it (a shutdown): there is nothing to sweep any more
      return removed;
    }
    for (const chat of chats) {
      const last = Date.parse(chat.lastActivityAt);
      if (chat.alive || !Number.isFinite(last) || last > cutoff) continue;
      try {
        await this.o.remove(chat.id);
        removed.push(chat.id);
      } catch (error) {
        // A chat that started again since the list was read is kept; the next pass judges it anew
        this.o.log?.(`retention: chat ${chat.id} was not deleted: ${errorMessage(error)}`);
      }
    }
    return removed;
  }
}
