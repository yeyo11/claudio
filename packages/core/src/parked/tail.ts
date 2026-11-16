import { closeSync, openSync, read, watch, type FSWatcher } from 'node:fs';

const CHUNK = 64 * 1024;
const NEWLINE = 0x0a;

/**
 * Follows a file that another process appends lines to, from a byte offset: the stdout and stderr
 * of a parked CLI. Lines are split on bytes, so a character cut across two reads is never decoded
 * in halves, and each comes with the offset of the byte after its newline, which is what a reader
 * commits. A line still being written (no newline yet) waits for its end.
 *
 * inotify (`fs.watch`) says when there is more; a slow poll stands in for it where it cannot be
 * had, and covers a change it missed.
 */
export class FileTail {
  private fd: number | null = null;
  private next: number;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private watcher: FSWatcher | null = null;
  private poll: NodeJS.Timeout | null = null;
  private reading: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(
    private readonly path: string,
    from: number,
    private readonly onLine: (line: string, end: number) => void,
    private readonly pollMs = 1000,
  ) {
    this.next = from;
  }

  /** The offset of the byte after the last complete line handed over. */
  get offset(): number {
    return this.next - this.pendingBytes;
  }

  start(): void {
    this.fd = openSync(this.path, 'r');
    try {
      this.watcher = watch(this.path, () => this.wake());
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      this.watcher = null;
    }
    this.poll = setInterval(() => this.wake(), this.pollMs);
    this.poll.unref();
    this.wake();
  }

  /** Reads what the file holds now; resolves once every complete line in it was handed over. */
  drain(): Promise<void> {
    this.again = true;
    if (!this.reading) this.reading = this.readAll().finally(() => (this.reading = null));
    return this.reading;
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    if (this.fd !== null && !this.reading) {
      closeSync(this.fd);
      this.fd = null;
    }
  }

  private wake(): void {
    if (this.stopped) return;
    void this.drain().catch(() => {
      // A read error is the file going away under it: the process's end reads what is left
    });
  }

  private async readAll(): Promise<void> {
    const buffer = Buffer.allocUnsafe(CHUNK);
    while (this.again && this.fd !== null) {
      this.again = false;
      for (;;) {
        const fd = this.fd;
        if (fd === null) return;
        const bytes = await new Promise<number>((resolve, reject) => read(fd, buffer, 0, CHUNK, this.next, (err, n) => (err ? reject(err) : resolve(n))));
        if (bytes === 0) break;
        this.next += bytes;
        this.split(buffer.subarray(0, bytes));
        this.again = true;
      }
    }
    if (this.stopped && this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }

  private split(chunk: Buffer): void {
    let start = 0;
    for (let at = chunk.indexOf(NEWLINE); at !== -1; at = chunk.indexOf(NEWLINE, start)) {
      const piece = chunk.subarray(start, at);
      const line = this.pendingBytes ? Buffer.concat([...this.pending, piece]) : piece;
      this.pending = [];
      this.pendingBytes = 0;
      start = at + 1;
      // The offset after this newline: what has been read, less what is still after it in the chunk
      this.onLine(line.toString('utf8'), this.next - (chunk.length - start));
    }
    if (start < chunk.length) {
      // Copied: the read buffer is reused by the next read
      const rest = Buffer.from(chunk.subarray(start));
      this.pending.push(rest);
      this.pendingBytes += rest.length;
    }
  }
}
