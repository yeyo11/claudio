import type { ChatRuntime, LiveChat } from './live-chat.ts';

/**
 * The chats a `ChatManager` knows. A chat that is working, or ended a short while ago, is resident:
 * its `LiveChat`, with its event buffer, its executions and its branches. One that ended long enough
 * ago is retired to the summary it had, and its row in the store is the chat: the first call that
 * needs more than the summary wakes it from that row, as a restart would restore it. Before, every
 * chat a process had touched stayed in memory until a restart, each with up to 5 000 events.
 *
 * `get` wakes a retired chat, so the manager's code reads one as it always did; iterating goes over
 * the resident ones only, which is what every loop over the live chats wants. `summaries` and
 * `summaryOf` answer for both without waking anything.
 */
export class ChatTable {
  private readonly resident = new Map<string, LiveChat>();
  private readonly retired = new Map<string, ChatRuntime>();

  /** `wake` loads a retired chat from the store; null when its row is gone (trimmed by another process). */
  constructor(private readonly wake: (id: string) => LiveChat | null) {}

  get(id: string): LiveChat | undefined {
    const chat = this.resident.get(id);
    if (chat || !this.retired.has(id)) return chat;
    this.retired.delete(id);
    const woken = this.wake(id);
    if (!woken) return undefined;
    this.resident.set(id, woken);
    return woken;
  }

  /** The resident chat, never waking one: for a question a retired chat answers by having no process */
  peek(id: string): LiveChat | undefined {
    return this.resident.get(id);
  }

  has(id: string): boolean {
    return this.resident.has(id) || this.retired.has(id);
  }

  set(id: string, chat: LiveChat): this {
    this.retired.delete(id);
    this.resident.set(id, chat);
    return this;
  }

  delete(id: string): boolean {
    const resident = this.resident.delete(id);
    return this.retired.delete(id) || resident;
  }

  /** The resident chats: every one with a process, and the ones that ended lately */
  values(): IterableIterator<LiveChat> {
    return this.resident.values();
  }

  /** Every chat's summary, retired ones as they were retired */
  summaries(): ChatRuntime[] {
    return [...[...this.resident.values()].map((chat) => chat.summary()), ...this.retired.values()];
  }

  summaryOf(id: string): ChatRuntime | null {
    return this.resident.get(id)?.summary() ?? this.retired.get(id) ?? null;
  }

  /** Keeps only the summary of a resident chat; `summary` is what waking it would read back. */
  retire(id: string, summary: ChatRuntime): void {
    if (!this.resident.delete(id)) return;
    this.retired.set(id, summary);
  }

  /** Forgets retired chats whose rows are gone, without waking them. */
  forgetRetired(ids: Iterable<string>): void {
    for (const id of ids) this.retired.delete(id);
  }

  get residentCount(): number {
    return this.resident.size;
  }

  get retiredCount(): number {
    return this.retired.size;
  }
}
