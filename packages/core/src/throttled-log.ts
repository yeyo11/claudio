import { errorMessage } from '@claudio/shared';
/**
 * Reports a failure that can repeat on every turn (a save of every chat, of every graph) at most once
 * per interval, with how many were held back since the last report. A save that fails is not allowed
 * to take the work in flight down, but it must not fail in silence either: before, the database
 * could refuse every write for hours and nothing said so.
 */
export class ThrottledLog {
  private lastAt = Number.NEGATIVE_INFINITY;
  private held = 0;

  constructor(
    private readonly what: string,
    private readonly everyMs = 60_000,
    private readonly write: (line: string) => void = (line) => console.warn(line),
    private readonly now: () => number = Date.now,
  ) {}

  failed(err: unknown): void {
    const at = this.now();
    if (at - this.lastAt < this.everyMs) {
      this.held += 1;
      return;
    }
    const more = this.held ? ` (and ${String(this.held)} more time${this.held === 1 ? '' : 's'} since the last report)` : '';
    this.lastAt = at;
    this.held = 0;
    this.write(`${this.what} failed${more}: ${errorMessage(err)}`);
  }
}
